//! Live check against a real SSH server. Runs only with TERMX_HOST / TERMX_USER / TERMX_PASS set.
use async_trait::async_trait;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use termx_core::model::*;
use termx_core::secrets::SecretBox;
use termx_core::sftp::Sftp;
use termx_core::ssh::*;
use termx_core::store::Store;

struct TrustUi;
#[async_trait]
impl Ui for TrustUi {
    async fn confirm_host_key(&self, req: HostKeyReq) -> bool {
        println!("host key {} {} {}", req.host_port, req.key_type, req.fingerprint);
        true
    }
    async fn ask_password(&self, _r: PasswordReq) -> Option<PasswordAnswer> {
        None
    }
}

#[derive(Default)]
struct Sink {
    out: Mutex<Vec<u8>>,
    states: Mutex<Vec<String>>,
}
impl SessionSink for Sink {
    fn output(&self, b: Vec<u8>) {
        self.out.lock().unwrap().extend(b);
    }
    fn state(&self, s: &str, _m: Option<String>) {
        self.states.lock().unwrap().push(s.to_string());
    }
}

#[tokio::test]
async fn live_shell_exec_sftp() {
    let (Ok(host), Ok(user), Ok(pass)) = (std::env::var("TERMX_HOST"), std::env::var("TERMX_USER"), std::env::var("TERMX_PASS")) else {
        eprintln!("skipped (no TERMX_* env)");
        return;
    };
    let dir = std::env::temp_dir().join(format!("termx-live-{}", std::process::id()));
    let store = Arc::new(Store::open(&dir).unwrap());
    let sb = Arc::new(SecretBox::open(&dir).unwrap());
    let h = Host { label: "live".into(), hostname: host, username: user, password_enc: Some(sb.encrypt(&pass).unwrap()), ..Default::default() };
    let hid = h.id.clone();
    store.update(|v| v.hosts.push(h)).unwrap();
    let mgr = Manager::new(store.clone(), sb, Arc::new(TrustUi));

    // exec
    let r = mgr.exec(&hid, "uname -sm", None, Duration::from_secs(10)).await.unwrap();
    println!("exec: {:?} exit={:?}", r.stdout.trim(), r.exit);
    assert!(r.stdout.len() > 2 && r.exit == Some(0));
    assert_eq!(store.read(|v| v.known_hosts.len()), 1, "host key should be remembered");

    // shell
    let sink = Arc::new(Sink::default());
    let sid = "s1".to_string();
    mgr.open_shell(sid.clone(), &hid, 100, 30, None, sink.clone()).unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    mgr.control(&sid, Ctl::Input(b"echo hello-$((6*7))\r".to_vec()));
    mgr.control(&sid, Ctl::Resize(120, 40));
    tokio::time::sleep(Duration::from_secs(2)).await;
    let screen = String::from_utf8_lossy(&sink.out.lock().unwrap()).to_string();
    println!("---- shell output ----\n{screen}\n----");
    assert!(screen.contains("hello-42"));
    assert!(sink.states.lock().unwrap().contains(&"connected".to_string()));
    mgr.control(&sid, Ctl::Close);

    // OS detection ran in the background
    tokio::time::sleep(Duration::from_secs(1)).await;
    println!("os: {:?} / {:?}", store.host(&hid).unwrap().os_id, store.host(&hid).unwrap().os_name);

    // sftp roundtrip
    let sftp = Sftp::new(mgr.clone());
    let home = sftp.home(&hid).await.unwrap();
    println!("home: {home}");
    let entries = sftp.list(&hid, &home).await.unwrap();
    println!("{} entries, first: {:?}", entries.len(), entries.first().map(|e| &e.name));
    let tmp = std::env::temp_dir().join("termx-up.txt");
    std::fs::write(&tmp, "hello sftp\n".repeat(50_000)).unwrap();
    let remote = format!("{home}/termx-live-test.txt");
    let prog: termx_core::sftp::ProgressFn = Arc::new(|_p| {});
    sftp.upload(&hid, &tmp, &remote, sftp.new_cancel("t1"), prog.clone()).await.unwrap();
    let back = std::env::temp_dir().join("termx-down.txt");
    sftp.download(&hid, &remote, false, &back, sftp.new_cancel("t2"), prog).await.unwrap();
    assert_eq!(std::fs::read(&tmp).unwrap(), std::fs::read(&back).unwrap());
    let txt = sftp.read_text(&hid, &remote, 1 << 20).await;
    assert!(txt.is_err() || txt.unwrap().starts_with("hello sftp")); // 550 KB < 1 MB -> ok
    sftp.remove(&hid, &remote, false).await.unwrap();
    mgr.disconnect_all().await;
}
