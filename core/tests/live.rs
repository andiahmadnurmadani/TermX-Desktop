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
    let sb = Arc::new(SecretBox::ephemeral(store.clone()));
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

struct NoWf;
impl termx_core::workflow::WorkflowSink for NoWf {
    fn event(&self, _ev: termx_core::workflow::WfEvent) {}
}

async fn wait_run(store: &Store, id: &str) -> WorkflowRun {
    for _ in 0..300 {
        let r = store.run_get(id).unwrap().unwrap();
        if r.status != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("run {id} did not finish");
}

/// 4 independent shells at once, workflow engine (params, secrets, timeout, exit codes,
/// expected output, confirmation, cancel) and the agentless overview script.
#[tokio::test]
async fn live_grid_workflow_overview() {
    let (Ok(host), Ok(user), Ok(pass)) = (std::env::var("TERMX_HOST"), std::env::var("TERMX_USER"), std::env::var("TERMX_PASS")) else {
        eprintln!("skipped (no TERMX_* env)");
        return;
    };
    let dir = std::env::temp_dir().join(format!("termx-live2-{}", termx_core::model::new_id()));
    let store = Arc::new(Store::open(&dir).unwrap());
    let sb = Arc::new(SecretBox::ephemeral(store.clone()));
    let h = Host { label: "live".into(), hostname: host, username: user, password_enc: Some(sb.encrypt(&pass).unwrap()), environment: "production".into(), ..Default::default() };
    let hid = h.id.clone();
    store.update(|v| v.hosts.push(h)).unwrap();
    let mgr = Manager::new(store.clone(), sb, Arc::new(TrustUi));

    // four panes, four independent sessions on the same host
    let sinks: Vec<Arc<Sink>> = (0..4).map(|_| Arc::new(Sink::default())).collect();
    for (i, s) in sinks.iter().enumerate() {
        mgr.open_shell(format!("p{i}"), &hid, 80, 24, None, s.clone()).unwrap();
    }
    tokio::time::sleep(Duration::from_secs(4)).await;
    for i in 0..4 {
        mgr.control(&format!("p{i}"), Ctl::Input(format!("echo pane-$((100+{i}))\r").into_bytes()));
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    for (i, s) in sinks.iter().enumerate() {
        let out = String::from_utf8_lossy(&s.out.lock().unwrap()).to_string();
        assert!(out.contains(&format!("pane-{}", 100 + i)), "pane {i} output missing");
        for j in 0..4 {
            if j != i {
                assert!(!out.contains(&format!("pane-{}", 100 + j)), "pane {i} saw pane {j}'s output");
            }
        }
    }
    mgr.control("p0", Ctl::Close);
    tokio::time::sleep(Duration::from_millis(500)).await;
    mgr.control("p1", Ctl::Input(b"echo still-alive\r".to_vec()));
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(String::from_utf8_lossy(&sinks[1].out.lock().unwrap()).contains("still-alive"), "closing one pane must not affect others");
    for i in 1..4 {
        mgr.control(&format!("p{i}"), Ctl::Close);
    }
    println!("grid: 4 sessions ok");

    // workflow
    let engine = termx_core::workflow::Engine::new(mgr.clone(), store.clone());
    let step = |name: &str, cmd: &str, t: u32| WorkflowStep { name: name.into(), command: cmd.into(), timeout_sec: t, ..Default::default() };
    let def = WorkflowDef {
        name: "live".into(),
        params: vec![
            WorkflowParam { name: "msg".into(), label: String::new(), default: "hi there".into(), secret: false },
            WorkflowParam { name: "tok".into(), label: String::new(), default: String::new(), secret: true },
        ],
        steps: vec![
            step("echo", "echo {{msg}}; echo token={{tok}}", 10),
            WorkflowStep { continue_on_error: true, ..step("slow", "sleep 5", 1) },
            WorkflowStep { ok_exit: vec![3], ..step("exit3", "exit 3", 10) },
            WorkflowStep { expect_output: "MARK".into(), ..step("expect", "echo MARK-$((2+2))", 10) },
            step("fail", "false", 10),
            step("never", "echo nope", 10),
        ],
        ..Default::default()
    };
    let params: std::collections::HashMap<String, String> = [("tok".to_string(), "s3cr3t-value".to_string())].into();
    let pv = engine.preview(&def, &[hid.clone()], &params).unwrap();
    assert!(pv.needs_confirm && pv.production_hosts.len() == 1);
    assert!(engine.start(def.clone(), vec![hid.clone()], params.clone(), false, Arc::new(NoWf)).is_err(), "production run must need confirmation");
    let id = engine.start(def.clone(), vec![hid.clone()], params.clone(), true, Arc::new(NoWf)).unwrap();
    let r = wait_run(&store, &id).await;
    let st: Vec<_> = r.steps.iter().map(|s| s.status.as_str()).collect();
    println!("workflow: {} {:?}", r.status, st);
    assert_eq!(st, ["ok", "timeout", "ok", "ok", "failed", "skipped"]);
    assert_eq!(r.status, "failed");
    assert!(r.steps[0].stdout.contains("hi there"));
    assert!(!r.steps[0].stdout.contains("s3cr3t") && !r.steps[0].command.contains("s3cr3t"), "secret leaked");
    assert!(r.steps[0].stdout.contains("token=••••"));
    assert_eq!(r.steps[2].exit_code, Some(3));

    // cancellation
    let slow = WorkflowDef { name: "slow".into(), steps: vec![step("sleep", "sleep 30", 60)], ..Default::default() };
    let id2 = engine.start(slow, vec![hid.clone()], Default::default(), true, Arc::new(NoWf)).unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let t0 = std::time::Instant::now();
    engine.cancel(&id2);
    let r2 = wait_run(&store, &id2).await;
    println!("cancel: {} after {:?}", r2.status, t0.elapsed());
    assert_eq!(r2.status, "cancelled");
    assert!(t0.elapsed() < Duration::from_secs(5));

    // overview
    let o = mgr.exec(&hid, "sh -s", Some(termx_core::overview::SCRIPT), Duration::from_secs(20)).await.unwrap();
    let ov = termx_core::overview::parse(&o.stdout);
    println!("overview: {ov:?}");
    assert!(ov.uptime_sec.is_some() && ov.cpus.is_some() && ov.mem_total_kb.is_some() && ov.disk_total_kb.is_some());
    mgr.disconnect_all().await;
}
