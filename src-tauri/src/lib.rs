//! TermX desktop shell: thin Tauri commands over `termx-core`.
use anyhow::anyhow;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager as _, State};
use termx_core::keys::{self, GenKind};
use termx_core::model::*;
use termx_core::overview::{self, Overview};
use termx_core::secrets::{SecretBox, VaultMode};
use termx_core::workflow::{Engine, Preview, WfEvent, WorkflowSink};
use termx_core::sftp::{FileEntry, Progress, Sftp};
use termx_core::ssh::{Ctl, HostKeyReq, Manager, PasswordAnswer, PasswordReq, SessionSink, Ui};
use termx_core::store::Store;
use tokio::sync::oneshot;

type CmdResult<T> = Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

// ------------------------------------------------------------------ state

struct AppState {
    store: Arc<Store>,
    sb: Arc<SecretBox>,
    mgr: Arc<Manager>,
    sftp: Arc<Sftp>,
    engine: Arc<Engine>,
    prompts: Arc<Prompts>,
    data_dir: PathBuf,
}

/// Pending dialogs (host key / password): the backend waits on a oneshot until the UI answers.
#[derive(Default)]
struct Prompts {
    next: Mutex<u64>,
    waiting: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
}

struct TauriUi {
    app: AppHandle,
    prompts: Arc<Prompts>,
}

impl TauriUi {
    async fn ask(&self, event: &str, payload: serde_json::Value) -> Option<serde_json::Value> {
        let id = {
            let mut n = self.prompts.next.lock().unwrap();
            *n += 1;
            format!("p{}", *n)
        };
        let (tx, rx) = oneshot::channel();
        self.prompts.waiting.lock().unwrap().insert(id.clone(), tx);
        let mut payload = payload;
        payload["id"] = serde_json::Value::String(id.clone());
        if self.app.emit(event, payload).is_err() {
            self.prompts.waiting.lock().unwrap().remove(&id);
            return None;
        }
        // Do not hang forever if the user walks away.
        match tokio::time::timeout(Duration::from_secs(300), rx).await {
            Ok(Ok(v)) => Some(v),
            _ => {
                self.prompts.waiting.lock().unwrap().remove(&id);
                None
            }
        }
    }
}

#[async_trait]
impl Ui for TauriUi {
    async fn confirm_host_key(&self, req: HostKeyReq) -> bool {
        let p = serde_json::json!({
            "hostPort": req.host_port, "keyType": req.key_type, "fingerprint": req.fingerprint,
            "changed": req.changed, "oldFingerprint": req.old_fingerprint,
        });
        self.ask("prompt:hostkey", p).await.and_then(|v| v.as_bool()).unwrap_or(false)
    }
    async fn ask_password(&self, req: PasswordReq) -> Option<PasswordAnswer> {
        let p = serde_json::json!({ "title": req.title, "message": req.message, "allowSave": req.allow_save });
        let v = self.ask("prompt:password", p).await?;
        if v.is_null() {
            return None;
        }
        Some(PasswordAnswer {
            password: v.get("password")?.as_str()?.to_string(),
            save: v.get("save").and_then(|s| s.as_bool()).unwrap_or(false),
        })
    }
}

#[tauri::command]
fn answer_prompt(state: State<'_, AppState>, id: String, value: serde_json::Value) {
    if let Some(tx) = state.prompts.waiting.lock().unwrap().remove(&id) {
        let _ = tx.send(value);
    }
}

// ------------------------------------------------------------------ vault

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultView {
    hosts: Vec<HostView>,
    groups: Vec<Group>,
    keys: Vec<SshKeyRec>,
    snippets: Vec<Snippet>,
    known_hosts: Vec<KnownHost>,
    settings: Settings,
    workspaces: Vec<Workspace>,
    workflows: Vec<WorkflowDef>,
    status: VaultStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStatus {
    mode: VaultMode,
    locked: bool,
}

fn status_of(sb: &SecretBox) -> VaultStatus {
    VaultStatus { mode: sb.mode(), locked: sb.is_locked() }
}

#[tauri::command]
fn vault_get(state: State<'_, AppState>) -> VaultView {
    let status = status_of(&state.sb);
    state.store.read(|v| VaultView {
        hosts: v.hosts.iter().map(HostView::from).collect(),
        groups: v.groups.clone(),
        keys: v.keys.clone(),
        snippets: v.snippets.clone(),
        known_hosts: v.known_hosts.clone(),
        settings: v.settings.clone(),
        workspaces: v.workspaces.clone(),
        workflows: v.workflows.clone(),
        status,
    })
}

// ------------------------------------------------------------------ vault lock / master password / backup

#[tauri::command]
async fn vault_unlock(state: State<'_, AppState>, password: String) -> CmdResult<()> {
    let sb = state.sb.clone();
    // Argon2id is deliberately slow: keep it off the async runtime.
    tokio::task::spawn_blocking(move || sb.unlock(&password)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
fn vault_lock(state: State<'_, AppState>) {
    state.sb.lock();
}

#[tauri::command]
async fn vault_set_master(state: State<'_, AppState>, current: Option<String>, password: Option<String>) -> CmdResult<()> {
    let sb = state.sb.clone();
    tokio::task::spawn_blocking(move || match (sb.mode(), current, password) {
        (VaultMode::Keychain, _, Some(new)) => sb.enable_master(&new),
        (VaultMode::Master, Some(old), Some(new)) => sb.change_master(&old, &new),
        (VaultMode::Master, Some(old), None) => sb.disable_master(&old),
        _ => Err(anyhow!("Invalid request")),
    })
    .await
    .map_err(err)?
    .map_err(err)
}

#[tauri::command]
async fn backup_export(state: State<'_, AppState>, path: String, password: String) -> CmdResult<()> {
    let (store, sb) = (state.store.clone(), state.sb.clone());
    let text = tokio::task::spawn_blocking(move || termx_core::backup::export(&store, &sb, &password)).await.map_err(err)?.map_err(err)?;
    write_private(&path, text.as_bytes()).map_err(err)
}

#[tauri::command]
async fn backup_import(state: State<'_, AppState>, path: String, password: String) -> CmdResult<termx_core::backup::RestoreReport> {
    let text = std::fs::read_to_string(&path).map_err(err)?;
    let (store, sb) = (state.store.clone(), state.sb.clone());
    tokio::task::spawn_blocking(move || termx_core::backup::restore(&store, &sb, &text, &password)).await.map_err(err)?.map_err(err)
}

fn write_private(path: &str, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ------------------------------------------------------------------ workspaces

#[tauri::command]
fn workspace_save(state: State<'_, AppState>, workspace: Workspace) -> CmdResult<()> {
    let mut w = workspace;
    w.panes.resize(4, None);
    w.panes.truncate(4);
    w.col_split = w.col_split.clamp(0.15, 0.85);
    w.row_split = w.row_split.clamp(0.15, 0.85);
    if !["1", "2v", "2h", "4"].contains(&w.layout.as_str()) {
        w.layout = "4".into();
    }
    state
        .store
        .update(|v| match v.workspaces.iter_mut().find(|x| x.id == w.id) {
            Some(x) => *x = w,
            None => v.workspaces.push(w),
        })
        .map_err(err)
}

#[tauri::command]
fn workspace_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.update(|v| v.workspaces.retain(|w| w.id != id)).map_err(err)
}

// ------------------------------------------------------------------ workflows

struct EventSink(AppHandle);
impl WorkflowSink for EventSink {
    fn event(&self, ev: WfEvent) {
        let _ = self.0.emit("workflow:event", ev);
    }
}

#[tauri::command]
fn workflow_save(state: State<'_, AppState>, workflow: WorkflowDef) -> CmdResult<()> {
    let w = workflow;
    if w.name.trim().is_empty() {
        return Err("Give the workflow a name".into());
    }
    for p in &w.params {
        if p.name.is_empty() || !p.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("Parameter names may only use letters, digits and _ (\"{}\")", p.name));
        }
    }
    state
        .store
        .update(|v| match v.workflows.iter_mut().find(|x| x.id == w.id) {
            Some(x) => *x = w,
            None => v.workflows.push(w),
        })
        .map_err(err)
}

#[tauri::command]
fn workflow_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.update(|v| v.workflows.retain(|w| w.id != id)).map_err(err)?;
    state.store.runs_clear(Some(&id)).map_err(err)
}

#[tauri::command]
fn workflow_preview(state: State<'_, AppState>, workflow: WorkflowDef, host_ids: Vec<String>, params: HashMap<String, String>) -> CmdResult<Preview> {
    state.engine.preview(&workflow, &host_ids, &params).map_err(err)
}

#[tauri::command]
fn workflow_run(
    app: AppHandle,
    state: State<'_, AppState>,
    workflow: WorkflowDef,
    host_ids: Vec<String>,
    params: HashMap<String, String>,
    confirmed: bool,
) -> CmdResult<String> {
    state.engine.start(workflow, host_ids, params, confirmed, Arc::new(EventSink(app))).map_err(err)
}

#[tauri::command]
fn workflow_cancel(state: State<'_, AppState>, run_id: String) {
    state.engine.cancel(&run_id);
}

#[tauri::command]
fn workflow_runs(state: State<'_, AppState>, workflow_id: Option<String>) -> CmdResult<Vec<WorkflowRun>> {
    state.store.runs_list(workflow_id.as_deref(), 100).map_err(err)
}

#[tauri::command]
fn workflow_run_get(state: State<'_, AppState>, id: String) -> CmdResult<Option<WorkflowRun>> {
    state.store.run_get(&id).map_err(err)
}

#[tauri::command]
fn workflow_runs_clear(state: State<'_, AppState>, workflow_id: Option<String>) -> CmdResult<()> {
    state.store.runs_clear(workflow_id.as_deref()).map_err(err)
}

// ------------------------------------------------------------------ overview

#[tauri::command]
async fn host_overview(state: State<'_, AppState>, host_id: String) -> CmdResult<Overview> {
    let r = state.mgr.exec(&host_id, "sh -s", Some(overview::SCRIPT), Duration::from_secs(20)).await.map_err(err)?;
    Ok(overview::parse(&r.stdout))
}

/// `password`: `None` keeps the stored one, `Some("")` clears it, otherwise it is encrypted and stored.
#[tauri::command]
fn host_save(state: State<'_, AppState>, host: Host, password: Option<String>) -> CmdResult<String> {
    let enc = match &password {
        Some(p) if !p.is_empty() => Some(Some(state.sb.encrypt(p).map_err(err)?)),
        Some(_) => Some(None),
        None => None,
    };
    let mut h = host;
    if h.label.trim().is_empty() {
        h.label = h.hostname.clone();
    }
    let id = h.id.clone();
    state
        .store
        .update(|v| {
            if let Some(old) = v.hosts.iter_mut().find(|x| x.id == id) {
                h.created_at = old.created_at;
                h.last_connected_at = old.last_connected_at;
                h.os_id = old.os_id.clone();
                h.os_name = old.os_name.clone();
                h.password_enc = match enc {
                    Some(e) => e,
                    None => old.password_enc.clone(),
                };
                *old = h;
            } else {
                h.password_enc = enc.flatten();
                v.hosts.push(h);
            }
        })
        .map_err(err)?;
    Ok(id)
}

#[tauri::command]
async fn host_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state
        .store
        .update(|v| {
            v.hosts.retain(|h| h.id != id);
            for h in v.hosts.iter_mut() {
                if h.jump_host_id.as_deref() == Some(&id) {
                    h.jump_host_id = None;
                }
            }
            for k in v.keys.iter_mut() {
                k.installed_on.retain(|x| x != &id);
            }
        })
        .map_err(err)?;
    state.mgr.disconnect_host(&id).await;
    state.sftp.close(&id).await;
    Ok(())
}

#[tauri::command]
fn group_save(state: State<'_, AppState>, group: Group) -> CmdResult<()> {
    state
        .store
        .update(|v| match v.groups.iter_mut().find(|g| g.id == group.id) {
            Some(g) => *g = group,
            None => v.groups.push(group),
        })
        .map_err(err)
}

#[tauri::command]
fn group_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state
        .store
        .update(|v| {
            v.groups.retain(|g| g.id != id);
            for h in v.hosts.iter_mut() {
                if h.group_id.as_deref() == Some(&id) {
                    h.group_id = None;
                }
            }
        })
        .map_err(err)
}

#[tauri::command]
fn snippet_save(state: State<'_, AppState>, snippet: Snippet) -> CmdResult<()> {
    state
        .store
        .update(|v| match v.snippets.iter_mut().find(|s| s.id == snippet.id) {
            Some(s) => *s = snippet,
            None => v.snippets.push(snippet),
        })
        .map_err(err)
}

#[tauri::command]
fn snippet_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.update(|v| v.snippets.retain(|s| s.id != id)).map_err(err)
}

#[tauri::command]
fn settings_save(state: State<'_, AppState>, settings: Settings) -> CmdResult<()> {
    state.store.update(|v| v.settings = settings).map_err(err)
}

#[tauri::command]
fn known_host_delete(state: State<'_, AppState>, host_port: String) -> CmdResult<()> {
    state.store.update(|v| v.known_hosts.retain(|k| k.host_port != host_port)).map_err(err)
}

// ------------------------------------------------------------------ keys

fn gen_kind(s: &str) -> GenKind {
    match s {
        "rsa4096" => GenKind::Rsa4096,
        "rsa2048" => GenKind::Rsa2048,
        _ => GenKind::Ed25519,
    }
}

#[tauri::command]
async fn key_generate(state: State<'_, AppState>, name: String, kind: String, comment: String) -> CmdResult<SshKeyRec> {
    let sb = state.sb.clone();
    let rec = tokio::task::spawn_blocking(move || keys::generate(&sb, &name, gen_kind(&kind), &comment))
        .await
        .map_err(err)?
        .map_err(err)?;
    state.store.update(|v| v.keys.push(rec.clone())).map_err(err)?;
    Ok(rec)
}

#[tauri::command]
fn key_import(state: State<'_, AppState>, name: String, text: String, passphrase: Option<String>) -> CmdResult<SshKeyRec> {
    let pass = passphrase.filter(|p| !p.is_empty());
    let rec = keys::import(&state.sb, &name, &text, pass.as_deref()).map_err(err)?;
    state.store.update(|v| v.keys.push(rec.clone())).map_err(err)?;
    Ok(rec)
}

#[tauri::command]
fn key_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state
        .store
        .update(|v| {
            v.keys.retain(|k| k.id != id);
            for h in v.hosts.iter_mut() {
                if h.key_id.as_deref() == Some(&id) {
                    h.key_id = None;
                    h.auth = AuthType::Password;
                }
            }
        })
        .map_err(err)
}

/// Append the public key to the server's `~/.ssh/authorized_keys` (idempotent).
#[tauri::command]
async fn key_install(state: State<'_, AppState>, key_id: String, host_id: String) -> CmdResult<()> {
    let key = state.store.read(|v| v.keys.iter().find(|k| k.id == key_id).cloned()).ok_or("Key not found")?;
    let line = key.public_key.trim().to_string();
    if line.contains('\n') || line.contains('\'') {
        return Err("Unexpected public key format".into());
    }
    let script = "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; IFS= read -r K; grep -qxF \"$K\" ~/.ssh/authorized_keys || printf '%s\\n' \"$K\" >> ~/.ssh/authorized_keys";
    let r = state.mgr.exec(&host_id, script, Some(&format!("{line}\n")), Duration::from_secs(20)).await.map_err(err)?;
    if r.exit.unwrap_or(1) != 0 {
        return Err(format!("Server refused: {}", r.stderr.trim()));
    }
    state
        .store
        .update(|v| {
            if let Some(k) = v.keys.iter_mut().find(|k| k.id == key_id) {
                if !k.installed_on.contains(&host_id) {
                    k.installed_on.push(host_id.clone());
                }
            }
        })
        .map_err(err)
}

// ------------------------------------------------------------------ shell sessions

struct ChannelSink {
    app: AppHandle,
    id: String,
    data: Channel<InvokeResponseBody>,
}

impl SessionSink for ChannelSink {
    fn output(&self, bytes: Vec<u8>) {
        let _ = self.data.send(InvokeResponseBody::Raw(bytes));
    }
    fn state(&self, state: &str, message: Option<String>) {
        let _ = self.app.emit("session:state", serde_json::json!({ "id": self.id, "state": state, "message": message }));
    }
}

#[tauri::command]
async fn ssh_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    host_id: String,
    cols: u32,
    rows: u32,
    data: Channel<InvokeResponseBody>,
) -> CmdResult<()> {
    let tmux = state.store.host(&host_id).and_then(|h| if h.tmux { Some(h.tmux_name.clone()) } else { None });
    let sink = Arc::new(ChannelSink { app, id: session_id.clone(), data });
    state.mgr.open_shell(session_id, &host_id, cols, rows, tmux, sink).map_err(err)
}

#[tauri::command]
fn ssh_write(state: State<'_, AppState>, session_id: String, data: String) {
    state.mgr.control(&session_id, Ctl::Input(data.into_bytes()));
}

#[tauri::command]
fn ssh_resize(state: State<'_, AppState>, session_id: String, cols: u32, rows: u32) {
    state.mgr.control(&session_id, Ctl::Resize(cols, rows));
}

#[tauri::command]
fn ssh_reconnect(state: State<'_, AppState>, session_id: String) {
    state.mgr.control(&session_id, Ctl::Reconnect);
}

#[tauri::command]
fn ssh_close(state: State<'_, AppState>, session_id: String) {
    state.mgr.control(&session_id, Ctl::Close);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecOut {
    stdout: String,
    stderr: String,
    exit: Option<u32>,
}

#[tauri::command]
async fn ssh_exec(state: State<'_, AppState>, host_id: String, command: String) -> CmdResult<ExecOut> {
    let r = state.mgr.exec(&host_id, &command, None, Duration::from_secs(30)).await.map_err(err)?;
    Ok(ExecOut { stdout: r.stdout, stderr: r.stderr, exit: r.exit })
}

// ------------------------------------------------------------------ SFTP

#[tauri::command]
async fn sftp_home(state: State<'_, AppState>, host_id: String) -> CmdResult<String> {
    state.sftp.home(&host_id).await.map_err(err)
}
#[tauri::command]
async fn sftp_list(state: State<'_, AppState>, host_id: String, path: String) -> CmdResult<Vec<FileEntry>> {
    state.sftp.list(&host_id, &path).await.map_err(err)
}
#[tauri::command]
async fn sftp_mkdir(state: State<'_, AppState>, host_id: String, path: String) -> CmdResult<()> {
    state.sftp.mkdir(&host_id, &path).await.map_err(err)
}
#[tauri::command]
async fn sftp_rename(state: State<'_, AppState>, host_id: String, from: String, to: String) -> CmdResult<()> {
    state.sftp.rename(&host_id, &from, &to).await.map_err(err)
}
#[tauri::command]
async fn sftp_remove(state: State<'_, AppState>, host_id: String, path: String, is_dir: bool) -> CmdResult<()> {
    state.sftp.remove(&host_id, &path, is_dir).await.map_err(err)
}
#[tauri::command]
async fn sftp_read_text(state: State<'_, AppState>, host_id: String, path: String) -> CmdResult<String> {
    state.sftp.read_text(&host_id, &path, 2 * 1024 * 1024).await.map_err(err)
}
#[tauri::command]
async fn sftp_write_text(state: State<'_, AppState>, host_id: String, path: String, text: String) -> CmdResult<()> {
    state.sftp.write_text(&host_id, &path, &text).await.map_err(err)
}
#[tauri::command]
fn sftp_cancel(state: State<'_, AppState>, transfer_id: String) {
    state.sftp.cancel(&transfer_id);
}

fn progress_fn(app: AppHandle, id: String) -> termx_core::sftp::ProgressFn {
    let last = Mutex::new(std::time::Instant::now() - Duration::from_secs(1));
    Arc::new(move |p: Progress| {
        // ~15 events/s is plenty for a progress bar.
        let mut l = last.lock().unwrap();
        if l.elapsed() < Duration::from_millis(66) && p.done < p.total {
            return;
        }
        *l = std::time::Instant::now();
        let _ = app.emit("sftp:progress", serde_json::json!({ "id": id, "done": p.done, "total": p.total, "name": p.name }));
    })
}

#[tauri::command]
async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    remote: String,
    is_dir: bool,
    local: String,
    transfer_id: String,
) -> CmdResult<()> {
    let cancel: Arc<AtomicBool> = state.sftp.new_cancel(&transfer_id);
    let r = state.sftp.download(&host_id, &remote, is_dir, &PathBuf::from(local), cancel, progress_fn(app, transfer_id.clone())).await;
    state.sftp.finish(&transfer_id);
    r.map_err(err)
}

#[tauri::command]
async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    local: String,
    remote: String,
    transfer_id: String,
) -> CmdResult<()> {
    let cancel: Arc<AtomicBool> = state.sftp.new_cancel(&transfer_id);
    let r = state.sftp.upload(&host_id, &PathBuf::from(local), &remote, cancel, progress_fn(app, transfer_id.clone())).await;
    state.sftp.finish(&transfer_id);
    r.map_err(err)
}

// ------------------------------------------------------------------ misc

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    os: &'static str,
    data_dir: String,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo { version: env!("CARGO_PKG_VERSION").into(), os: std::env::consts::OS, data_dir: state.data_dir.display().to_string() }
}

#[derive(Deserialize)]
struct ImportPayload {
    hosts: Vec<Host>,
    #[serde(default)]
    groups: Vec<Group>,
    #[serde(default)]
    snippets: Vec<Snippet>,
}

/// Read a small local text file (used to import private keys picked via the file dialog).
#[tauri::command]
fn file_read_text(path: String) -> CmdResult<String> {
    let md = std::fs::metadata(&path).map_err(err)?;
    if md.len() > 256 * 1024 {
        return Err("File is too large".into());
    }
    std::fs::read_to_string(path).map_err(err)
}

/// Export hosts/groups/snippets (no passwords, no private keys) to a JSON file.
#[tauri::command]
fn config_export(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let v = state.store.snapshot();
    let hosts: Vec<Host> = v
        .hosts
        .into_iter()
        .map(|mut h| {
            h.password_enc = None;
            h
        })
        .collect();
    let json = serde_json::json!({ "hosts": hosts, "groups": v.groups, "snippets": v.snippets });
    std::fs::write(path, serde_json::to_string_pretty(&json).map_err(err)?).map_err(err)
}

#[tauri::command]
fn config_import(state: State<'_, AppState>, path: String) -> CmdResult<usize> {
    let text = std::fs::read_to_string(path).map_err(err)?;
    let p: ImportPayload = serde_json::from_str(&text).map_err(|e| err(anyhow!("Not a TermX export: {e}")))?;
    let mut n = 0;
    state
        .store
        .update(|v| {
            for g in p.groups {
                if !v.groups.iter().any(|x| x.id == g.id) {
                    v.groups.push(g);
                }
            }
            for s in p.snippets {
                if !v.snippets.iter().any(|x| x.id == s.id) {
                    v.snippets.push(s);
                }
            }
            for mut h in p.hosts {
                if !v.hosts.iter().any(|x| x.id == h.id) {
                    h.password_enc = None;
                    h.key_id = None;
                    if h.auth == AuthType::Key {
                        h.auth = AuthType::Password;
                    }
                    v.hosts.push(h);
                    n += 1;
                }
            }
        })
        .map_err(err)?;
    Ok(n)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let store = Arc::new(Store::open(&data_dir)?);
            let sb = Arc::new(SecretBox::open(store.clone())?);
            let prompts = Arc::new(Prompts::default());
            let ui = Arc::new(TauriUi { app: app.handle().clone(), prompts: prompts.clone() });
            let mgr = Manager::new(store.clone(), sb.clone(), ui);
            let sftp = Sftp::new(mgr.clone());
            let engine = Engine::new(mgr.clone(), store.clone());
            app.manage(AppState { store, sb, mgr, sftp, engine, prompts, data_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            answer_prompt,
            vault_get,
            host_save,
            host_delete,
            group_save,
            group_delete,
            snippet_save,
            snippet_delete,
            settings_save,
            known_host_delete,
            key_generate,
            key_import,
            key_delete,
            key_install,
            ssh_open,
            ssh_write,
            ssh_resize,
            ssh_reconnect,
            ssh_close,
            ssh_exec,
            sftp_home,
            sftp_list,
            sftp_mkdir,
            sftp_rename,
            sftp_remove,
            sftp_read_text,
            sftp_write_text,
            sftp_cancel,
            sftp_download,
            sftp_upload,
            app_info,
            file_read_text,
            config_export,
            config_import,
            vault_unlock,
            vault_lock,
            vault_set_master,
            backup_export,
            backup_import,
            workspace_save,
            workspace_delete,
            workflow_save,
            workflow_delete,
            workflow_preview,
            workflow_run,
            workflow_cancel,
            workflow_runs,
            workflow_run_get,
            workflow_runs_clear,
            host_overview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TermX");
}
