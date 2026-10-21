//! SSH layer: shared connections per host (with jump hosts), interactive shell sessions that
//! reconnect on their own, one-shot exec, host-key verification and credential prompts.
use crate::keys;
use crate::model::*;
use crate::secrets::SecretBox;
use crate::store::Store;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

// ------------------------------------------------------------------ UI callbacks

#[derive(Clone, Debug)]
pub struct HostKeyReq {
    pub host_port: String,
    pub key_type: String,
    pub fingerprint: String,
    pub changed: bool,
    pub old_fingerprint: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PasswordReq {
    pub title: String,
    pub message: String,
    pub allow_save: bool,
}

pub struct PasswordAnswer {
    pub password: String,
    pub save: bool,
}

/// Implemented by the app shell to ask the user (dialogs).
#[async_trait]
pub trait Ui: Send + Sync + 'static {
    async fn confirm_host_key(&self, req: HostKeyReq) -> bool;
    async fn ask_password(&self, req: PasswordReq) -> Option<PasswordAnswer>;
}

/// Receives terminal output and state changes for one shell session.
pub trait SessionSink: Send + Sync + 'static {
    fn output(&self, bytes: Vec<u8>);
    /// state: connecting | connected | reconnecting | ended | failed
    fn state(&self, state: &str, message: Option<String>);
    /// One human-readable step of connection setup ("Resolving host…", "Authenticated", …).
    fn progress(&self, _line: &str) {}
}

/// Optional receiver for connection-setup steps.
pub type Prog = Option<Arc<dyn Fn(String) + Send + Sync>>;

fn say(p: &Prog, line: impl Into<String>) {
    if let Some(f) = p {
        f(line.into());
    }
}

// ------------------------------------------------------------------ errors

#[derive(Debug)]
pub enum SshError {
    /// Retrying will not help (bad credentials, rejected host key, missing host).
    Fatal(String),
    /// Network trouble; reconnecting may work.
    Transient(String),
}
impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshError::Fatal(m) | SshError::Transient(m) => f.write_str(m),
        }
    }
}
impl std::error::Error for SshError {}

fn transient<E: std::fmt::Display>(e: E) -> SshError {
    SshError::Transient(e.to_string())
}
fn fatal<S: Into<String>>(m: S) -> SshError {
    SshError::Fatal(m.into())
}

// ------------------------------------------------------------------ handler

pub struct ClientHandler {
    store: Arc<Store>,
    ui: Arc<dyn Ui>,
    host_port: String,
    prog: Prog,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let pk = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(c) => c.public_key().clone().into(),
        };
        let key_type = pk.algorithm().as_str().to_string();
        let fingerprint = pk.fingerprint(HashAlg::Sha256).to_string();
        say(&self.prog, format!("Server host key: {key_type} {fingerprint}"));
        let hp = self.host_port.clone();
        let known = self.store.read(|v| v.known_hosts.iter().find(|k| k.host_port == hp && k.key_type == key_type).cloned());
        if let Some(k) = &known {
            if k.fingerprint == fingerprint {
                say(&self.prog, "Host key matches known_hosts");
                return Ok(true);
            }
        }
        let req = HostKeyReq {
            host_port: hp.clone(),
            key_type: key_type.clone(),
            fingerprint: fingerprint.clone(),
            changed: known.is_some(),
            old_fingerprint: known.map(|k| k.fingerprint),
        };
        say(&self.prog, if req.changed { "Host key CHANGED — waiting for confirmation" } else { "Unknown host key — waiting for confirmation" });
        if !self.ui.confirm_host_key(req).await {
            say(&self.prog, "Host key rejected");
            return Ok(false);
        }
        say(&self.prog, "Host key accepted and saved");
        let _ = self.store.update(|v| {
            v.known_hosts.retain(|k| !(k.host_port == hp && k.key_type == key_type));
            v.known_hosts.push(KnownHost { host_port: hp, key_type, fingerprint, added_at: now_ms() });
        });
        Ok(true)
    }
}

// ------------------------------------------------------------------ connections

pub struct Conn {
    pub handle: client::Handle<ClientHandler>,
    pub host_id: String,
    /// Keeps the jump host connection alive as long as this one lives.
    _jump: Option<Arc<Conn>>,
}

impl Conn {
    pub fn is_alive(&self) -> bool {
        !self.handle.is_closed()
    }
}

pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit: Option<u32>,
}

pub enum Ctl {
    Input(Vec<u8>),
    Resize(u32, u32),
    Reconnect,
    Close,
}

pub struct Manager {
    pub store: Arc<Store>,
    pub sb: Arc<SecretBox>,
    ui: Arc<dyn Ui>,
    conns: tokio::sync::Mutex<HashMap<String, Arc<Conn>>>,
    host_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// session id -> (control channel, host id)
    sessions: Mutex<HashMap<String, (mpsc::UnboundedSender<Ctl>, String)>>,
    /// Passwords typed this run (not saved) so reconnects and sudo don't ask twice.
    typed_pw: Mutex<HashMap<String, String>>,
}

type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

impl Manager {
    pub fn new(store: Arc<Store>, sb: Arc<SecretBox>, ui: Arc<dyn Ui>) -> Arc<Self> {
        Arc::new(Manager {
            store,
            sb,
            ui,
            conns: Default::default(),
            host_locks: Default::default(),
            sessions: Default::default(),
            typed_pw: Default::default(),
        })
    }

    fn lock_for(&self, host_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.host_locks.lock().unwrap().entry(host_id.to_string()).or_default().clone()
    }

    /// A live connection for the host, creating it (and its jump chain) if needed.
    pub fn connection_for(self: &Arc<Self>, host_id: String, depth: u32) -> BoxFut<Result<Arc<Conn>, SshError>> {
        self.connection_for_p(host_id, depth, None)
    }

    /// Like [`connection_for`], reporting each setup step to `prog`.
    pub fn connection_for_p(self: &Arc<Self>, host_id: String, depth: u32, prog: Prog) -> BoxFut<Result<Arc<Conn>, SshError>> {
        let this = self.clone();
        Box::pin(async move {
            if depth > 3 {
                return Err(fatal("Jump host chain is too long"));
            }
            let lock = this.lock_for(&host_id);
            let _g = lock.lock().await;
            if let Some(c) = this.conns.lock().await.get(&host_id) {
                if c.is_alive() {
                    say(&prog, "Reusing the open connection to this host");
                    return Ok(c.clone());
                }
            }
            if this.sb.is_locked() {
                return Err(fatal("The vault is locked. Unlock TermX to connect."));
            }
            let host = this.store.host(&host_id).ok_or_else(|| fatal("Host does not exist"))?;
            let jump = match host.jump_host_id.as_ref().filter(|j| **j != host_id) {
                Some(j) => {
                    let jl = this.store.host(j).map(|h| h.label).unwrap_or_else(|| j.clone());
                    say(&prog, format!("Connecting through jump host \"{jl}\""));
                    Some(this.connection_for_p(j.clone(), depth + 1, prog.clone()).await?)
                }
                None => None,
            };
            let conn = this.connect(&host, jump, &prog).await?;
            let conn = Arc::new(conn);
            this.conns.lock().await.insert(host_id.clone(), conn.clone());
            let _ = this.store.update(|v| {
                if let Some(h) = v.hosts.iter_mut().find(|h| h.id == host_id) {
                    h.last_connected_at = now_ms();
                }
            });
            if host.os_id.is_none() {
                let t = this.clone();
                let c = conn.clone();
                tokio::spawn(async move { t.detect_os(&c).await });
            }
            Ok(conn)
        })
    }

    async fn connect(self: &Arc<Self>, host: &Host, jump: Option<Arc<Conn>>, prog: &Prog) -> Result<Conn, SshError> {
        let host_port = if host.port == 22 { host.hostname.clone() } else { format!("{}:{}", host.hostname, host.port) };
        let handler = ClientHandler { store: self.store.clone(), ui: self.ui.clone(), host_port, prog: prog.clone() };
        let config = Arc::new(client::Config {
            keepalive_interval: if host.keepalive_sec > 0 { Some(Duration::from_secs(host.keepalive_sec as u64)) } else { None },
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });
        let connect_timeout = Duration::from_secs(15);
        say(prog, format!("Starting a new connection to {}:{}", host.hostname, host.port));
        let mut handle = if let Some(j) = &jump {
            let ch = j
                .handle
                .channel_open_direct_tcpip(host.hostname.clone(), host.port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| transient(format!("Jump host could not reach {}: {e}", host.hostname)))?;
            say(prog, "Tunnel through jump host opened");
            say(prog, "Starting SSH handshake");
            client::connect_stream(config, ch.into_stream(), handler).await.map_err(map_connect_err)?
        } else {
            let tcp = tokio::time::timeout(connect_timeout, tcp_connect(&host.hostname, host.port, prog))
                .await
                .map_err(|_| transient(format!("Connection to {}:{} timed out", host.hostname, host.port)))??;
            say(prog, "Starting SSH handshake");
            // Generous: the handshake includes the host-key confirmation dialog.
            tokio::time::timeout(Duration::from_secs(180), client::connect_stream(config, tcp, handler))
                .await
                .map_err(|_| transient("SSH handshake timed out"))?
                .map_err(map_connect_err)?
        };
        say(prog, "Handshake complete, session encrypted");
        self.authenticate(host, &mut handle, prog).await?;
        say(prog, "Authentication succeeded");
        Ok(Conn { handle, host_id: host.id.clone(), _jump: jump })
    }

    async fn authenticate(self: &Arc<Self>, host: &Host, handle: &mut client::Handle<ClientHandler>, prog: &Prog) -> Result<(), SshError> {
        match host.auth {
            AuthType::Agent => {
                say(prog, format!("Authenticating as \"{}\" with the SSH agent", host.username));
                agent_auth(handle, &host.username).await
            }
            AuthType::Key => {
                let kid = host.key_id.clone().ok_or_else(|| fatal("No SSH key selected for this host"))?;
                let rec = self.store.read(|v| v.keys.iter().find(|k| k.id == kid).cloned()).ok_or_else(|| fatal("SSH key for this host was not found"))?;
                let key = keys::load_private(&self.sb, &rec).map_err(|e| fatal(format!("Could not load key: {e}")))?;
                say(prog, format!("Authenticating as \"{}\" with key \"{}\" ({})", host.username, rec.name, rec.kind));
                let hash = handle.best_supported_rsa_hash().await.map_err(transient)?.flatten();
                let res = handle
                    .authenticate_publickey(host.username.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                    .await
                    .map_err(transient)?;
                if !res.success() {
                    return Err(fatal("Authentication failed (key rejected)"));
                }
                let (hid, kid) = (host.id.clone(), rec.id.clone());
                let _ = self.store.update(|v| {
                    if let Some(k) = v.keys.iter_mut().find(|k| k.id == kid) {
                        if !k.installed_on.contains(&hid) {
                            k.installed_on.push(hid);
                        }
                    }
                });
                Ok(())
            }
            AuthType::Password => {
                let saved = self.sb.decrypt_opt(&host.password_enc);
                let typed = self.typed_pw.lock().unwrap().get(&host.id).cloned();
                let mut password = saved.clone().or(typed);
                let mut save = false;
                if password.is_none() {
                    let ans = self
                        .ui
                        .ask_password(PasswordReq {
                            title: format!("Password for {}", host.label),
                            message: format!("{}@{}", host.username, host.hostname),
                            allow_save: true,
                        })
                        .await
                        .ok_or_else(|| fatal("Password entry cancelled"))?;
                    password = Some(ans.password);
                    save = ans.save;
                }
                let pw = password.unwrap();
                say(prog, format!("Authenticating as \"{}\" with password", host.username));
                let mut ok = handle.authenticate_password(host.username.clone(), pw.clone()).await.map_err(transient)?.success();
                if !ok {
                    // Some servers only offer keyboard-interactive for passwords.
                    say(prog, "Password method refused, trying keyboard-interactive");
                    ok = self.keyboard_interactive(handle, &host.username, &pw).await?;
                }
                if !ok {
                    return Err(fatal("Authentication failed (wrong password?)"));
                }
                self.typed_pw.lock().unwrap().insert(host.id.clone(), pw.clone());
                if save {
                    if let Ok(enc) = self.sb.encrypt(&pw) {
                        let hid = host.id.clone();
                        let _ = self.store.update(|v| {
                            if let Some(h) = v.hosts.iter_mut().find(|h| h.id == hid) {
                                h.password_enc = Some(enc);
                            }
                        });
                    }
                }
                Ok(())
            }
        }
    }

    async fn keyboard_interactive(&self, handle: &mut client::Handle<ClientHandler>, user: &str, pw: &str) -> Result<bool, SshError> {
        let mut r = handle.authenticate_keyboard_interactive_start(user.to_string(), None::<String>).await.map_err(transient)?;
        for _ in 0..4 {
            match r {
                KeyboardInteractiveAuthResponse::Success => return Ok(true),
                KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
                KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                    let answers = prompts.iter().map(|_| pw.to_string()).collect();
                    r = handle.authenticate_keyboard_interactive_respond(answers).await.map_err(transient)?;
                }
            }
        }
        Ok(false)
    }

    pub async fn disconnect_host(&self, host_id: &str) {
        if let Some(c) = self.conns.lock().await.remove(host_id) {
            let _ = c.handle.disconnect(Disconnect::ByApplication, "", "en").await;
        }
    }

    pub async fn disconnect_all(&self) {
        let all: Vec<_> = self.conns.lock().await.drain().map(|(_, c)| c).collect();
        for c in all {
            let _ = c.handle.disconnect(Disconnect::ByApplication, "", "en").await;
        }
    }

    // -------------------------------------------------------------- exec

    pub async fn exec(self: &Arc<Self>, host_id: &str, command: &str, stdin: Option<&str>, timeout: Duration) -> Result<ExecResult> {
        let conn = self.connection_for(host_id.to_string(), 0).await.map_err(|e| anyhow!("{e}"))?;
        exec_on(&conn, command, stdin, timeout).await
    }

    async fn detect_os(&self, conn: &Conn) {
        let script = "uname -s 2>/dev/null; . /etc/os-release 2>/dev/null && echo \"$ID|$PRETTY_NAME\"; (sw_vers -productVersion 2>/dev/null)";
        let Ok(r) = exec_on(conn, "sh -s", Some(script), Duration::from_secs(8)).await else { return };
        let (id, name) = parse_os(&r.stdout);
        let hid = conn.host_id.clone();
        if let Some(id) = id {
            let _ = self.store.update(|v| {
                if let Some(h) = v.hosts.iter_mut().find(|h| h.id == hid) {
                    h.os_id = Some(id);
                    h.os_name = name;
                }
            });
        }
    }

    // -------------------------------------------------------------- shell sessions

    /// Start an interactive shell under the caller-chosen `session_id`; output/state go to `sink`.
    pub fn open_shell(self: &Arc<Self>, session_id: String, host_id: &str, cols: u32, rows: u32, tmux: Option<String>, sink: Arc<dyn SessionSink>) -> Result<()> {
        let host = self.store.host(host_id).ok_or_else(|| anyhow!("Host does not exist"))?;
        let id = session_id;
        let (tx, rx) = mpsc::unbounded_channel();
        self.sessions.lock().unwrap().insert(id.clone(), (tx, host.id.clone()));
        let this = self.clone();
        let sid = id.clone();
        tokio::spawn(async move {
            this.run_session(host, cols, rows, tmux, sink, rx).await;
            this.sessions.lock().unwrap().remove(&sid);
        });
        Ok(())
    }

    pub fn control(&self, session_id: &str, ctl: Ctl) {
        if let Some((tx, _)) = self.sessions.lock().unwrap().get(session_id) {
            let _ = tx.send(ctl);
        }
    }

    /// Type the host's password (saved, or entered earlier this run) into a shell session, e.g.
    /// to answer a sudo prompt. The password never leaves the backend.
    pub fn fill_password(&self, session_id: &str) -> Result<()> {
        let host_id = self.sessions.lock().unwrap().get(session_id).map(|(_, h)| h.clone()).ok_or_else(|| anyhow!("Session is not open"))?;
        let host = self.store.host(&host_id).ok_or_else(|| anyhow!("Host does not exist"))?;
        let pw = self
            .sb
            .decrypt_opt(&host.password_enc)
            .or_else(|| self.typed_pw.lock().unwrap().get(&host_id).cloned())
            .ok_or_else(|| anyhow!("No password is saved for this host"))?;
        self.control(session_id, Ctl::Input(format!("{pw}\r").into_bytes()));
        Ok(())
    }

    async fn run_session(
        self: &Arc<Self>,
        host: Host,
        mut cols: u32,
        mut rows: u32,
        tmux: Option<String>,
        sink: Arc<dyn SessionSink>,
        mut rx: mpsc::UnboundedReceiver<Ctl>,
    ) {
        let mut ever_connected = false;
        let mut attempt: u32 = 0;
        let mut startup_sent = false;
        let ps = sink.clone();
        let prog: Prog = Some(Arc::new(move |l: String| ps.progress(&l)));
        loop {
            sink.state(if ever_connected { "reconnecting" } else { "connecting" }, None);
            // Re-read the host so edits (password, key) apply to reconnects.
            let host = self.store.host(&host.id).unwrap_or_else(|| host.clone());
            let opened = tokio::select! {
                r = self.open_channel(&host, cols, rows, tmux.as_deref(), &prog) => r,
                _ = wait_close(&mut rx, &mut cols, &mut rows) => return,
            };
            match opened {
                Ok((mut ch, conn)) => {
                    attempt = 0;
                    say(&prog, "Connected");
                    sink.state("connected", None);
                    if ever_connected {
                        sink.output(b"\r\n\x1b[32m-- reconnected --\x1b[0m\r\n".to_vec());
                    }
                    ever_connected = true;
                    if tmux.is_none() && !startup_sent && !host.startup_command.trim().is_empty() {
                        startup_sent = true;
                        let _ = ch.data(format!("{}\r", host.startup_command.trim_end()).as_bytes()).await;
                    }
                    let mut exit: Option<u32> = None;
                    let outcome = loop {
                        tokio::select! {
                            msg = ch.wait() => match msg {
                                Some(ChannelMsg::Data { data }) => sink.output(data.to_vec()),
                                Some(ChannelMsg::ExtendedData { data, .. }) => sink.output(data.to_vec()),
                                Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
                                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break Outcome::Gone,
                                _ => {}
                            },
                            ctl = rx.recv() => match ctl {
                                Some(Ctl::Input(b)) => { if ch.data(&b[..]).await.is_err() { break Outcome::Gone; } }
                                Some(Ctl::Resize(c, r)) => { cols = c; rows = r; let _ = ch.window_change(c, r, 0, 0).await; }
                                Some(Ctl::Reconnect) => { let _ = ch.close().await; self.disconnect_host(&host.id).await; break Outcome::Gone; }
                                Some(Ctl::Close) | None => { let _ = ch.close().await; break Outcome::Closed; }
                            },
                        }
                    };
                    match outcome {
                        Outcome::Closed => {
                            sink.state("ended", None);
                            self.maybe_release(&host.id);
                            return;
                        }
                        Outcome::Gone => {
                            if conn.is_alive() {
                                let msg = match exit {
                                    Some(c) => format!("Session ended (exit {c})."),
                                    None => "Session ended.".to_string(),
                                };
                                sink.output(format!("\r\n\x1b[2m{msg}\x1b[0m\r\n").into_bytes());
                                sink.state("ended", Some(msg));
                                self.maybe_release(&host.id);
                                return;
                            }
                            // connection dropped -> fall through to reconnect handling
                            sink.output(b"\r\n\x1b[33m-- connection lost --\x1b[0m\r\n".to_vec());
                        }
                    }
                }
                Err(e) => {
                    let msg = e.to_string();
                    say(&prog, format!("Error: {msg}"));
                    let is_fatal = matches!(e, SshError::Fatal(_));
                    if !ever_connected || is_fatal || !host.auto_reconnect {
                        sink.output(format!("\r\n\x1b[31m{msg}\x1b[0m\r\n").into_bytes());
                        sink.state("failed", Some(msg));
                        // Wait for a manual retry or close.
                        loop {
                            match rx.recv().await {
                                Some(Ctl::Reconnect) => break,
                                Some(Ctl::Resize(c, r)) => { cols = c; rows = r; }
                                Some(Ctl::Input(_)) => {}
                                Some(Ctl::Close) | None => return,
                            }
                        }
                        continue;
                    }
                    sink.output(format!("\r\n\x1b[33m{msg}\x1b[0m\r\n").into_bytes());
                }
            }
            // Backoff before the next automatic attempt.
            attempt += 1;
            let wait = Duration::from_secs([2, 4, 8, 15, 30][(attempt as usize - 1).min(4)]);
            sink.state("reconnecting", Some(format!("Retrying in {}s…", wait.as_secs())));
            let sleep = tokio::time::sleep(wait);
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    ctl = rx.recv() => match ctl {
                        Some(Ctl::Reconnect) => break,
                        Some(Ctl::Resize(c, r)) => { cols = c; rows = r; }
                        Some(Ctl::Input(_)) => {}
                        Some(Ctl::Close) | None => return,
                    },
                }
            }
        }
    }

    fn maybe_release(self: &Arc<Self>, host_id: &str) {
        // Close the connection when nothing else uses it. (Sessions are tracked by host id only
        // loosely: we keep the connection if any other session of that host is registered.)
        let _ = host_id;
    }

    async fn open_channel(
        self: &Arc<Self>,
        host: &Host,
        cols: u32,
        rows: u32,
        tmux: Option<&str>,
        prog: &Prog,
    ) -> Result<(russh::Channel<client::Msg>, Arc<Conn>), SshError> {
        let conn = self.connection_for_p(host.id.clone(), 0, prog.clone()).await?;
        say(prog, "Opening session channel");
        let ch = conn.handle.channel_open_session().await.map_err(transient)?;
        say(prog, format!("Requesting PTY xterm-256color ({}x{})", cols.max(2), rows.max(2)));
        ch.request_pty(false, "xterm-256color", cols.max(2), rows.max(2), 0, 0, &[]).await.map_err(transient)?;
        match tmux {
            Some(name) => {
                let n = sanitize_tmux(name);
                say(prog, format!("Attaching tmux session \"{n}\""));
                let mouse = "\\; set-option mouse on";
                let cmd = format!(
                    "if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s '{n}' {mouse}; else exec \"${{SHELL:-/bin/sh}}\" -l; fi"
                );
                ch.exec(true, cmd).await.map_err(transient)?;
            }
            None => {
                say(prog, "Starting shell");
                ch.request_shell(true).await.map_err(transient)?
            }
        }
        Ok((ch, conn))
    }
}

enum Outcome {
    Gone,
    Closed,
}

/// Resolves when the session is closed while we are busy connecting (and tracks resizes).
async fn wait_close(rx: &mut mpsc::UnboundedReceiver<Ctl>, cols: &mut u32, rows: &mut u32) {
    loop {
        match rx.recv().await {
            Some(Ctl::Close) | None => return,
            Some(Ctl::Resize(c, r)) => {
                *cols = c;
                *rows = r;
            }
            _ => {}
        }
    }
}

/// Resolve and connect, trying each address in turn and reporting progress.
async fn tcp_connect(hostname: &str, port: u16, prog: &Prog) -> Result<tokio::net::TcpStream, SshError> {
    say(prog, format!("Resolving \"{hostname}\""));
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((hostname, port))
        .await
        .map_err(|e| transient(format!("Could not resolve {hostname}: {e}")))?
        .collect();
    if addrs.is_empty() {
        return Err(transient(format!("Could not resolve {hostname}")));
    }
    if addrs.len() == 1 && addrs[0].ip().to_string() == hostname {
        say(prog, "Address is an IP, no lookup needed");
    } else {
        let list: Vec<String> = addrs.iter().map(|a| a.ip().to_string()).collect();
        say(prog, format!("Resolved to {}", list.join(", ")));
    }
    let mut last = String::new();
    for a in &addrs {
        say(prog, format!("Connecting to {a}"));
        match tokio::net::TcpStream::connect(a).await {
            Ok(s) => {
                let _ = s.set_nodelay(true);
                say(prog, format!("TCP connection to {a} established"));
                return Ok(s);
            }
            Err(e) => {
                say(prog, format!("Connection to {a} failed: {e}"));
                last = e.to_string();
            }
        }
    }
    Err(transient(format!("Could not connect to {hostname}:{port}: {last}")))
}

fn map_connect_err(e: russh::Error) -> SshError {
    match e {
        russh::Error::UnknownKey => fatal("Host key rejected"),
        other => transient(format!("{other}")),
    }
}

pub fn sanitize_tmux(name: &str) -> String {
    let s: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')).collect();
    if s.is_empty() { "termx".into() } else { s }
}

pub async fn exec_on(conn: &Conn, command: &str, stdin: Option<&str>, timeout: Duration) -> Result<ExecResult> {
    let work = async {
        let mut ch = conn.handle.channel_open_session().await?;
        ch.exec(true, command).await?;
        if let Some(s) = stdin {
            ch.data(s.as_bytes()).await?;
            ch.eof().await?;
        }
        let (mut out, mut err, mut exit) = (Vec::new(), Vec::new(), None);
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                _ => {}
            }
        }
        Ok::<_, russh::Error>(ExecResult {
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            exit,
        })
    };
    tokio::time::timeout(timeout, work).await.map_err(|_| anyhow!("Command timed out"))?.map_err(|e| anyhow!("{e}"))
}

/// How a streamed command ended.
pub enum StreamEnd {
    Exited(Option<u32>),
    TimedOut,
    Cancelled,
}

/// Run `command` on a fresh channel, handing stdout/stderr chunks to `on_out(is_stderr, bytes)`.
/// Cancellation sends SIGTERM and closes the channel; whether the remote process actually stops
/// depends on the server (OpenSSH >= 7.9 honours signal requests).
pub async fn exec_stream(
    conn: &Conn,
    command: &str,
    timeout: Duration,
    cancel: tokio_util::sync::CancellationToken,
    mut on_out: impl FnMut(bool, &[u8]) + Send,
) -> Result<StreamEnd> {
    let mut ch = conn.handle.channel_open_session().await?;
    ch.exec(true, command).await?;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut exit = None;
    loop {
        tokio::select! {
            msg = ch.wait() => match msg {
                Some(ChannelMsg::Data { data }) => on_out(false, &data),
                Some(ChannelMsg::ExtendedData { data, .. }) => on_out(true, &data),
                Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
                Some(_) => {}
                None => return Ok(StreamEnd::Exited(exit)),
            },
            _ = &mut deadline => {
                let _ = ch.signal(russh::Sig::TERM).await;
                let _ = ch.close().await;
                return Ok(StreamEnd::TimedOut);
            }
            _ = cancel.cancelled() => {
                let _ = ch.signal(russh::Sig::TERM).await;
                let _ = ch.close().await;
                return Ok(StreamEnd::Cancelled);
            }
        }
    }
}

/// Public-key auth through the local SSH agent: try each identity it offers.
async fn agent_auth(handle: &mut client::Handle<ClientHandler>, user: &str) -> Result<(), SshError> {
    #[cfg(unix)]
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| fatal(format!("SSH agent not available ({e}). Is ssh-agent running and SSH_AUTH_SOCK set?")))?;
    #[cfg(windows)]
    let mut agent = match russh::keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        Ok(a) => a.dynamic(),
        Err(_) => russh::keys::agent::client::AgentClient::connect_pageant()
            .await
            .map_err(|e| fatal(format!("No SSH agent found (OpenSSH agent or Pageant): {e}")))?
            .dynamic(),
    };
    let ids = agent.request_identities().await.map_err(|e| fatal(format!("SSH agent: {e}")))?;
    if ids.is_empty() {
        return Err(fatal("The SSH agent has no keys loaded (ssh-add)"));
    }
    let hash = handle.best_supported_rsa_hash().await.map_err(transient)?.flatten();
    for id in ids {
        let key = match &id {
            russh::keys::agent::AgentIdentity::PublicKey { key, .. } => key.clone(),
            russh::keys::agent::AgentIdentity::Certificate { .. } => continue,
        };
        match handle.authenticate_publickey_with(user.to_string(), key, hash, &mut agent).await {
            Ok(r) if r.success() => return Ok(()),
            Ok(_) => continue,
            Err(e) => return Err(transient(format!("SSH agent: {e}"))),
        }
    }
    Err(fatal("Authentication failed (no agent key was accepted)"))
}

/// Parse `uname -s` / os-release output into (icon id, pretty name).
pub fn parse_os(out: &str) -> (Option<String>, Option<String>) {
    let lines: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let uname = lines.first().copied().unwrap_or("").to_lowercase();
    if let Some(l) = lines.iter().find(|l| l.contains('|')) {
        let mut it = l.splitn(2, '|');
        let id = it.next().unwrap_or("").trim_matches('"').to_lowercase();
        let name = it.next().unwrap_or("").trim_matches('"').to_string();
        if !id.is_empty() {
            return (Some(id), Some(name).filter(|n| !n.is_empty()));
        }
    }
    match uname.as_str() {
        "darwin" => {
            let ver = lines.get(1).copied().unwrap_or("");
            (Some("macos".into()), Some(format!("macOS {ver}").trim().to_string()))
        }
        "freebsd" => (Some("freebsd".into()), Some("FreeBSD".into())),
        "linux" => (Some("linux".into()), Some("Linux".into())),
        u if u.contains("mingw") || u.contains("cygwin") || u.contains("msys") => (Some("windows".into()), Some("Windows".into())),
        _ => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn os_parsing() {
        assert_eq!(parse_os("Linux\nubuntu|Ubuntu 24.04 LTS\n").0.as_deref(), Some("ubuntu"));
        assert_eq!(parse_os("Darwin\n26.5\n").1.as_deref(), Some("macOS 26.5"));
        assert_eq!(parse_os("").0, None);
    }
    #[test]
    fn tmux_names() {
        assert_eq!(sanitize_tmux("my sess;rm"), "mysessrm");
        assert_eq!(sanitize_tmux("!!"), "termx");
    }
}
