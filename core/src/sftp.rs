//! SFTP over the shared SSH connection: browse, transfer (files and folders, with progress), edit.
use crate::ssh::Manager;
use anyhow::{anyhow, Result};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    /// Seconds since epoch.
    pub mtime: i64,
    pub mode: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u64,
    pub total: u64,
    pub name: String,
}

pub type ProgressFn = Arc<dyn Fn(Progress) + Send + Sync>;

pub struct Sftp {
    mgr: Arc<Manager>,
    open: tokio::sync::Mutex<HashMap<String, Arc<SftpSession>>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

const CHUNK: usize = 256 * 1024;

/// Used when the server refuses the "sftp" subsystem: start an sftp-server binary directly.
/// NAS systems often ship one even with the SFTP service switched off.
const SFTP_SERVER_FALLBACK: &str = "for p in /usr/libexec/sftp-server /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server \
/usr/libexec/openssh/sftp-server /usr/lib/sftp-server /usr/bin/sftp-server /usr/sbin/sftp-server /bin/sftp-server; \
do [ -x \"$p\" ] && exec \"$p\"; done; exit 127";

const NO_SFTP: &str = "SFTP is not available on this server. On a NAS it is usually switched off: \
Synology: Control Panel > File Services > FTP > Enable SFTP service. \
QNAP: Control Panel > Network & File Services > Telnet/SSH > Enable SFTP.";

/// Wait for the answer to a `want_reply` channel request. `None`: no answer in time.
async fn channel_reply(ch: &mut russh::Channel<russh::client::Msg>, secs: u64) -> Option<bool> {
    tokio::time::timeout(std::time::Duration::from_secs(secs), async {
        loop {
            match ch.wait().await {
                Some(russh::ChannelMsg::Success) => return true,
                Some(russh::ChannelMsg::Failure) | Some(russh::ChannelMsg::Close) | Some(russh::ChannelMsg::Eof) | None => return false,
                Some(russh::ChannelMsg::ExitStatus { .. }) => return false,
                Some(_) => continue,
            }
        }
    })
    .await
    .ok()
}

async fn start_session(ch: russh::Channel<russh::client::Msg>) -> Result<SftpSession> {
    let cfg = russh_sftp::client::Config { request_timeout_secs: 30, ..Default::default() };
    match tokio::time::timeout(std::time::Duration::from_secs(15), SftpSession::new_with_config(ch.into_stream(), cfg)).await {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(e)) => Err(anyhow!("{e}")),
        Err(_) => Err(anyhow!("no answer from the SFTP server")),
    }
}

/// Open an SFTP session: the "sftp" subsystem first, then an sftp-server binary as a fallback.
async fn open_sftp(handle: &russh::client::Handle<crate::ssh::ClientHandler>) -> Result<SftpSession> {
    let mut ch = handle.channel_open_session().await?;
    // tests: TERMX_SFTP_FORCE_EXEC=1 exercises the fallback path
    let force_exec = std::env::var("TERMX_SFTP_FORCE_EXEC").is_ok_and(|v| !v.is_empty());
    if !force_exec {
        ch.request_subsystem(true, "sftp").await?;
    }
    let subsystem_err = match if force_exec { Some(false) } else { channel_reply(&mut ch, 10).await } {
        // refused outright: don't wait for an SFTP handshake that will never come
        Some(false) => anyhow!("the server refused the sftp subsystem"),
        _ => match start_session(ch).await {
            Ok(s) => return Ok(s),
            Err(e) => e,
        },
    };
    let mut ch = handle.channel_open_session().await?;
    ch.exec(true, SFTP_SERVER_FALLBACK).await?;
    if channel_reply(&mut ch, 10).await == Some(false) {
        return Err(anyhow!("{NO_SFTP}"));
    }
    match start_session(ch).await {
        Ok(s) => Ok(s),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("message") || msg.contains("length") || msg.contains("packet") {
                Err(anyhow!("SFTP: {subsystem_err}. The server's shell prints text on login (check ~/.bashrc), which breaks SFTP."))
            } else {
                Err(anyhow!("{NO_SFTP} ({subsystem_err})"))
            }
        }
    }
}

impl Sftp {
    pub fn new(mgr: Arc<Manager>) -> Arc<Self> {
        Arc::new(Sftp { mgr, open: Default::default(), cancels: Default::default() })
    }

    async fn session(&self, host_id: &str) -> Result<Arc<SftpSession>> {
        let mut g = self.open.lock().await;
        if let Some(s) = g.get(host_id) {
            return Ok(s.clone());
        }
        let conn = self.mgr.connection_for(host_id.to_string(), 0).await.map_err(|e| anyhow!("{e}"))?;
        let s = Arc::new(open_sftp(&conn.handle).await?);
        g.insert(host_id.to_string(), s.clone());
        Ok(s)
    }

    /// Run `f` with a session; on failure drop the cached session and retry once (stale channel).
    async fn with<T, F, Fut>(&self, host_id: &str, f: F) -> Result<T>
    where
        F: Fn(Arc<SftpSession>) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let s = self.session(host_id).await?;
        match f(s).await {
            Ok(v) => Ok(v),
            Err(first) => {
                self.open.lock().await.remove(host_id);
                match self.session(host_id).await {
                    Ok(s2) => f(s2).await.map_err(|_| first),
                    Err(_) => Err(first),
                }
            }
        }
    }

    pub async fn close(&self, host_id: &str) {
        if let Some(s) = self.open.lock().await.remove(host_id) {
            let _ = s.close().await;
        }
    }

    /// The login directory; "/" when the account has none (e.g. a NAS user without a home folder).
    pub async fn home(&self, host_id: &str) -> Result<String> {
        self.with(host_id, |s| async move {
            match s.canonicalize(".").await {
                Ok(p) if !p.is_empty() => Ok(p),
                _ => Ok("/".to_string()),
            }
        })
        .await
    }

    pub async fn list(&self, host_id: &str, path: &str) -> Result<Vec<FileEntry>> {
        let p = path.to_string();
        self.with(host_id, move |s| {
            let p = p.clone();
            async move {
                let mut out = vec![];
                for e in s.read_dir(p.clone()).await.map_err(|er| anyhow!("{er}"))? {
                    let name = e.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let md = e.metadata();
                    let ft = e.file_type();
                    let full = e.path();
                    let mut is_dir = ft.is_dir();
                    let is_link = ft.is_symlink();
                    if is_link {
                        if let Ok(t) = s.metadata(full.clone()).await {
                            is_dir = t.is_dir();
                        }
                    }
                    out.push(FileEntry {
                        name,
                        path: full,
                        is_dir,
                        is_link,
                        size: md.size.unwrap_or(0),
                        mtime: md.mtime.map(|t| t as i64).unwrap_or(0),
                        mode: md.permissions.unwrap_or(0) & 0o7777,
                    });
                }
                out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
                Ok(out)
            }
        })
        .await
    }

    pub async fn mkdir(&self, host_id: &str, path: &str) -> Result<()> {
        let p = path.to_string();
        self.with(host_id, move |s| { let p = p.clone(); async move { s.create_dir(p).await.map_err(|e| anyhow!("{e}")) } }).await
    }

    pub async fn rename(&self, host_id: &str, from: &str, to: &str) -> Result<()> {
        let (a, b) = (from.to_string(), to.to_string());
        self.with(host_id, move |s| { let (a, b) = (a.clone(), b.clone()); async move { s.rename(a, b).await.map_err(|e| anyhow!("{e}")) } }).await
    }

    pub async fn remove(&self, host_id: &str, path: &str, is_dir: bool) -> Result<()> {
        let s = self.session(host_id).await?;
        remove_rec(&s, path, is_dir).await
    }

    pub async fn read_text(&self, host_id: &str, path: &str, max: usize) -> Result<String> {
        let s = self.session(host_id).await?;
        let md = s.metadata(path.to_string()).await.map_err(|e| anyhow!("{e}"))?;
        if md.len() as usize > max {
            return Err(anyhow!("File too large to edit (> {} MB). Download it instead.", max / 1_048_576));
        }
        let bytes = s.read(path.to_string()).await.map_err(|e| anyhow!("{e}"))?;
        String::from_utf8(bytes).map_err(|_| anyhow!("Not a UTF-8 text file"))
    }

    pub async fn write_text(&self, host_id: &str, path: &str, text: &str) -> Result<()> {
        let s = self.session(host_id).await?;
        s.write(path.to_string(), text.as_bytes()).await.map_err(|e| anyhow!("{e}"))
    }

    // ------------------------------------------------------------ transfers

    pub fn new_cancel(&self, transfer_id: &str) -> Arc<AtomicBool> {
        let t = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(transfer_id.to_string(), t.clone());
        t
    }
    pub fn cancel(&self, transfer_id: &str) {
        if let Some(t) = self.cancels.lock().unwrap().get(transfer_id) {
            t.store(true, Ordering::Relaxed);
        }
    }
    pub fn finish(&self, transfer_id: &str) {
        self.cancels.lock().unwrap().remove(transfer_id);
    }

    pub async fn download(&self, host_id: &str, remote: &str, is_dir: bool, local: &Path, cancel: Arc<AtomicBool>, prog: ProgressFn) -> Result<()> {
        let s = self.session(host_id).await?;
        let total = if is_dir { remote_size(&s, remote).await } else { s.metadata(remote.to_string()).await.map(|m| m.len()).unwrap_or(0) };
        let mut done = 0u64;
        if is_dir {
            download_dir(&s, remote, local, total, &mut done, &cancel, &prog).await
        } else {
            download_file(&s, remote, local, total, &mut done, &cancel, &prog).await
        }
    }

    pub async fn upload(&self, host_id: &str, local: &Path, remote: &str, cancel: Arc<AtomicBool>, prog: ProgressFn) -> Result<()> {
        let s = self.session(host_id).await?;
        let total = local_size(local);
        let mut done = 0u64;
        upload_any(&s, local, remote, total, &mut done, &cancel, &prog).await
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

fn remove_rec<'a>(s: &'a SftpSession, path: &'a str, is_dir: bool) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        if !is_dir {
            return s.remove_file(path.to_string()).await.map_err(|e| anyhow!("{e}"));
        }
        for e in s.read_dir(path.to_string()).await.map_err(|e| anyhow!("{e}"))? {
            let n = e.file_name();
            if n == "." || n == ".." {
                continue;
            }
            remove_rec(s, &e.path(), e.file_type().is_dir()).await?;
        }
        s.remove_dir(path.to_string()).await.map_err(|e| anyhow!("{e}"))
    })
}

fn remote_size<'a>(s: &'a SftpSession, path: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = u64> + Send + 'a>> {
    Box::pin(async move {
        let mut t = 0;
        if let Ok(rd) = s.read_dir(path.to_string()).await {
            for e in rd {
                let n = e.file_name();
                if n == "." || n == ".." {
                    continue;
                }
                if e.file_type().is_dir() { t += remote_size(s, &e.path()).await } else { t += e.metadata().len() }
            }
        }
        t
    })
}

fn local_size(p: &Path) -> u64 {
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| local_size(&e.path())).sum()).unwrap_or(0),
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

async fn download_file(s: &SftpSession, remote: &str, local: &Path, total: u64, done: &mut u64, cancel: &AtomicBool, prog: &ProgressFn) -> Result<()> {
    let mut src = s.open(remote.to_string()).await.map_err(|e| anyhow!("{e}"))?;
    if let Some(parent) = local.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut dst = tokio::fs::File::create(local).await?;
    let name = remote.rsplit('/').next().unwrap_or(remote).to_string();
    let mut buf = vec![0u8; CHUNK];
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(dst);
            let _ = tokio::fs::remove_file(local).await;
            return Err(anyhow!("Cancelled"));
        }
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        *done += n as u64;
        prog(Progress { done: *done, total, name: name.clone() });
    }
    dst.flush().await?;
    Ok(())
}

fn download_dir<'a>(
    s: &'a SftpSession, remote: &'a str, local: &'a Path, total: u64, done: &'a mut u64, cancel: &'a AtomicBool, prog: &'a ProgressFn,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        tokio::fs::create_dir_all(local).await?;
        for e in s.read_dir(remote.to_string()).await.map_err(|e| anyhow!("{e}"))? {
            let n = e.file_name();
            if n == "." || n == ".." {
                continue;
            }
            let target: PathBuf = local.join(&n);
            if e.file_type().is_dir() {
                download_dir(s, &e.path(), &target, total, done, cancel, prog).await?;
            } else if !e.file_type().is_symlink() {
                download_file(s, &e.path(), &target, total, done, cancel, prog).await?;
            }
        }
        Ok(())
    })
}

fn upload_any<'a>(
    s: &'a SftpSession, local: &'a Path, remote: &'a str, total: u64, done: &'a mut u64, cancel: &'a AtomicBool, prog: &'a ProgressFn,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("Cancelled"));
        }
        let md = tokio::fs::metadata(local).await?;
        if md.is_dir() {
            let _ = s.create_dir(remote.to_string()).await; // may already exist
            let mut rd = tokio::fs::read_dir(local).await?;
            while let Some(e) = rd.next_entry().await? {
                let name = e.file_name().to_string_lossy().into_owned();
                upload_any(s, &e.path(), &join(remote, &name), total, done, cancel, prog).await?;
            }
            return Ok(());
        }
        let mut src = tokio::fs::File::open(local).await?;
        let mut dst = s
            .open_with_flags(remote.to_string(), OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
            .await
            .map_err(|e| anyhow!("{e}"))?;
        let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut buf = vec![0u8; CHUNK];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(anyhow!("Cancelled"));
            }
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await?;
            *done += n as u64;
            prog(Progress { done: *done, total, name: name.clone() });
        }
        dst.flush().await?;
        dst.shutdown().await.ok();
        Ok(())
    })
}
