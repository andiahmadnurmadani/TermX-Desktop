//! Workflow engine: saved command sequences run on one or more hosts.
//!
//! - Steps run in order on each host; hosts run concurrently (bounded by `parallel`).
//! - Every step has a timeout and a success condition (exit codes + optional expected output).
//! - Output is kept per host and per step, capped, and secrets (secret parameters, saved host
//!   passwords) are masked before they are emitted or stored.
//! - Risky commands and production hosts require an explicit confirmation, enforced here and not
//!   only in the UI.
use crate::model::*;
use crate::ssh::{exec_stream, Manager, StreamEnd};
use crate::store::Store;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const MAX_OUTPUT: usize = 256 * 1024;
const MASK: &str = "••••";

/// Streamed progress for the UI.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WfEvent {
    pub run_id: String,
    /// "step" (status change) | "output" | "run" (run finished)
    pub kind: String,
    pub host_id: String,
    pub idx: u32,
    pub status: String,
    pub stream: String,
    pub chunk: String,
    pub exit_code: Option<u32>,
}

pub trait WorkflowSink: Send + Sync + 'static {
    fn event(&self, ev: WfEvent);
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewHost {
    pub id: String,
    pub label: String,
    pub environment: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStep {
    pub name: String,
    pub command: String,
    pub risks: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub hosts: Vec<PreviewHost>,
    pub steps: Vec<PreviewStep>,
    pub production_hosts: Vec<String>,
    pub needs_confirm: bool,
}

pub struct Engine {
    mgr: Arc<Manager>,
    store: Arc<Store>,
    running: Mutex<HashMap<String, CancellationToken>>,
}

impl Engine {
    pub fn new(mgr: Arc<Manager>, store: Arc<Store>) -> Arc<Self> {
        let _ = store.runs_mark_interrupted();
        Arc::new(Engine { mgr, store, running: Default::default() })
    }

    /// What would run, where, and whether it needs confirmation.
    pub fn preview(&self, def: &WorkflowDef, host_ids: &[String], params: &HashMap<String, String>) -> Result<Preview> {
        if host_ids.is_empty() {
            bail!("Choose at least one host");
        }
        if def.steps.is_empty() {
            bail!("This workflow has no steps");
        }
        let v = self.store.snapshot();
        let mut hosts = vec![];
        for id in host_ids {
            let h = v.hosts.iter().find(|h| &h.id == id).ok_or_else(|| anyhow!("Host not found: {id}"))?;
            hosts.push(PreviewHost { id: h.id.clone(), label: h.label.clone(), environment: h.environment.clone() });
        }
        let secrets = secret_values(def, params);
        let mut steps = vec![];
        for s in &def.steps {
            let cmd = render(&s.command, def, params)?;
            steps.push(PreviewStep { name: s.name.clone(), risks: risks(&cmd), command: mask(&cmd, &secrets) });
        }
        let production_hosts: Vec<String> = hosts.iter().filter(|h| h.environment == "production").map(|h| h.label.clone()).collect();
        let needs_confirm = !production_hosts.is_empty() || steps.iter().any(|s| !s.risks.is_empty());
        Ok(Preview { hosts, steps, production_hosts, needs_confirm })
    }

    /// Start a run in the background. Returns the run id.
    pub fn start(
        self: &Arc<Self>,
        def: WorkflowDef,
        host_ids: Vec<String>,
        params: HashMap<String, String>,
        confirmed: bool,
        sink: Arc<dyn WorkflowSink>,
    ) -> Result<String> {
        // Must be called from inside the async runtime (a sync Tauri command runs on the
        // main thread, where tokio::spawn would panic and abort the app).
        let rt = tokio::runtime::Handle::try_current().map_err(|_| anyhow::anyhow!("Workflow engine is not running inside the async runtime"))?;
        let preview = self.preview(&def, &host_ids, &params)?;
        if preview.needs_confirm && !confirmed {
            bail!("This run needs confirmation (risky commands or production hosts)");
        }
        let v = self.store.snapshot();
        let mut secrets = secret_values(&def, &params);
        for id in &host_ids {
            if let Some(pw) = v.hosts.iter().find(|h| &h.id == id).and_then(|h| self.mgr.sb.decrypt_opt(&h.password_enc)) {
                secrets.push(pw);
            }
        }
        let rendered: Vec<String> = def.steps.iter().map(|s| render(&s.command, &def, &params)).collect::<Result<_>>()?;

        let run_id = new_id();
        let mut run = WorkflowRun {
            id: run_id.clone(),
            workflow_id: def.id.clone(),
            workflow_name: def.name.clone(),
            host_ids: host_ids.clone(),
            params: def
                .params
                .iter()
                .map(|p| {
                    let val = params.get(&p.name).cloned().unwrap_or_else(|| p.default.clone());
                    (p.name.clone(), if p.secret { MASK.to_string() } else { val })
                })
                .collect(),
            started_at: now_ms(),
            finished_at: 0,
            status: "running".into(),
            steps: vec![],
        };
        for h in &preview.hosts {
            for (i, s) in def.steps.iter().enumerate() {
                run.steps.push(StepRun {
                    host_id: h.id.clone(),
                    host_label: h.label.clone(),
                    idx: i as u32,
                    name: s.name.clone(),
                    command: mask(&rendered[i], &secrets),
                    started_at: 0,
                    finished_at: 0,
                    exit_code: None,
                    status: "pending".into(),
                    stdout: String::new(),
                    stderr: String::new(),
                    error: String::new(),
                });
            }
        }
        self.store.run_insert(&run)?;

        let cancel = CancellationToken::new();
        self.running.lock().unwrap().insert(run_id.clone(), cancel.clone());
        let this = self.clone();
        let rid = run_id.clone();
        rt.spawn(async move {
            let limit = Arc::new(tokio::sync::Semaphore::new(def.parallel.clamp(1, 16) as usize));
            let secrets = Arc::new(secrets);
            let rendered = Arc::new(rendered);
            let def = Arc::new(def);
            let mut tasks = vec![];
            for h in preview.hosts {
                let (this, sink, cancel, limit, secrets, rendered, def, rid) =
                    (this.clone(), sink.clone(), cancel.clone(), limit.clone(), secrets.clone(), rendered.clone(), def.clone(), rid.clone());
                tasks.push(tokio::spawn(async move {
                    let _permit = limit.acquire().await;
                    this.run_host(&rid, &def, &h, &rendered, &secrets, &cancel, &*sink).await
                }));
            }
            let mut all_ok = true;
            for t in tasks {
                all_ok &= t.await.unwrap_or(false);
            }
            let status = if cancel.is_cancelled() { "cancelled" } else if all_ok { "ok" } else { "failed" };
            let _ = this.store.run_finish(&rid, status);
            this.running.lock().unwrap().remove(&rid);
            sink.event(WfEvent {
                run_id: rid,
                kind: "run".into(),
                host_id: String::new(),
                idx: 0,
                status: status.into(),
                stream: String::new(),
                chunk: String::new(),
                exit_code: None,
            });
        });
        Ok(run_id)
    }

    pub fn cancel(&self, run_id: &str) {
        if let Some(c) = self.running.lock().unwrap().get(run_id) {
            c.cancel();
        }
    }

    pub fn is_running(&self, run_id: &str) -> bool {
        self.running.lock().unwrap().contains_key(run_id)
    }

    /// All steps on one host. Returns true when every step succeeded.
    async fn run_host(
        &self,
        run_id: &str,
        def: &WorkflowDef,
        host: &PreviewHost,
        rendered: &[String],
        secrets: &[String],
        cancel: &CancellationToken,
        sink: &dyn WorkflowSink,
    ) -> bool {
        let emit = |idx: u32, kind: &str, status: &str, stream: &str, chunk: String, exit_code: Option<u32>| {
            sink.event(WfEvent {
                run_id: run_id.into(),
                kind: kind.into(),
                host_id: host.id.clone(),
                idx,
                status: status.into(),
                stream: stream.into(),
                chunk,
                exit_code,
            })
        };
        let mut rec = |idx: usize| StepRun {
            host_id: host.id.clone(),
            host_label: host.label.clone(),
            idx: idx as u32,
            name: def.steps[idx].name.clone(),
            command: mask(&rendered[idx], secrets),
            started_at: 0,
            finished_at: 0,
            exit_code: None,
            status: "pending".into(),
            stdout: String::new(),
            stderr: String::new(),
            error: String::new(),
        };
        let finish_rest = |from: usize, status: &str, error: &str, rec: &mut dyn FnMut(usize) -> StepRun| {
            for j in from..def.steps.len() {
                let mut r = rec(j);
                r.status = status.into();
                r.error = error.into();
                r.finished_at = now_ms();
                let _ = self.store.step_update(run_id, &r);
                emit(j as u32, "step", status, "", error.into(), None);
            }
        };

        if cancel.is_cancelled() {
            finish_rest(0, "cancelled", "", &mut rec);
            return false;
        }
        let conn = tokio::select! {
            c = self.mgr.connection_for(host.id.clone(), 0) => c,
            _ = cancel.cancelled() => { finish_rest(0, "cancelled", "", &mut rec); return false; }
        };
        let conn = match conn {
            Ok(c) => c,
            Err(e) => {
                finish_rest(0, "failed", &format!("Could not connect: {e}"), &mut rec);
                return false;
            }
        };

        let mut all_ok = true;
        for (i, step) in def.steps.iter().enumerate() {
            if cancel.is_cancelled() {
                finish_rest(i, "cancelled", "", &mut rec);
                return false;
            }
            let mut r = rec(i);
            r.status = "running".into();
            r.started_at = now_ms();
            let _ = self.store.step_update(run_id, &r);
            emit(i as u32, "step", "running", "", String::new(), None);

            let (mut out, mut err) = (Vec::<u8>::new(), Vec::<u8>::new());
            let timeout = Duration::from_secs(step.timeout_sec.clamp(1, 24 * 3600) as u64);
            let res = exec_stream(&conn, &rendered[i], timeout, cancel.clone(), |is_err, b| {
                let buf = if is_err { &mut err } else { &mut out };
                if buf.len() < MAX_OUTPUT {
                    let take = b.len().min(MAX_OUTPUT - buf.len());
                    buf.extend_from_slice(&b[..take]);
                    let chunk = mask(&String::from_utf8_lossy(&b[..take]), secrets);
                    emit(i as u32, "output", "running", if is_err { "err" } else { "out" }, chunk, None);
                }
            })
            .await;
            r.stdout = mask(&String::from_utf8_lossy(&out), secrets);
            r.stderr = mask(&String::from_utf8_lossy(&err), secrets);
            if out.len() >= MAX_OUTPUT {
                r.stdout.push_str("\n… output truncated");
            }
            r.finished_at = now_ms();
            r.status = match res {
                Ok(StreamEnd::Exited(code)) => {
                    r.exit_code = code;
                    let ok_codes: &[u32] = if step.ok_exit.is_empty() { &[0] } else { &step.ok_exit };
                    let exit_ok = code.map(|c| ok_codes.contains(&c)).unwrap_or(false);
                    let text_ok = step.expect_output.is_empty() || r.stdout.contains(&step.expect_output);
                    if !exit_ok {
                        r.error = match code {
                            Some(c) => format!("Exit code {c}"),
                            None => "No exit code (connection closed?)".into(),
                        };
                    } else if !text_ok {
                        r.error = format!("Output does not contain “{}”", step.expect_output);
                    }
                    if exit_ok && text_ok { "ok" } else { "failed" }
                }
                Ok(StreamEnd::TimedOut) => {
                    r.error = format!("Timed out after {}s", timeout.as_secs());
                    "timeout"
                }
                Ok(StreamEnd::Cancelled) => "cancelled",
                Err(e) => {
                    r.error = e.to_string();
                    "failed"
                }
            }
            .into();
            let _ = self.store.step_update(run_id, &r);
            emit(i as u32, "step", &r.status, "", r.error.clone(), r.exit_code);

            match r.status.as_str() {
                "ok" => {}
                "cancelled" => {
                    finish_rest(i + 1, "cancelled", "", &mut rec);
                    return false;
                }
                _ => {
                    all_ok = false;
                    if !step.continue_on_error {
                        finish_rest(i + 1, "skipped", "", &mut rec);
                        return false;
                    }
                }
            }
        }
        all_ok
    }
}

fn secret_values(def: &WorkflowDef, params: &HashMap<String, String>) -> Vec<String> {
    def.params
        .iter()
        .filter(|p| p.secret)
        .filter_map(|p| params.get(&p.name).cloned().or_else(|| Some(p.default.clone())))
        .filter(|v| v.len() >= 3)
        .collect()
}

pub fn mask(text: &str, secrets: &[String]) -> String {
    let mut s = text.to_string();
    for sec in secrets {
        if sec.len() >= 3 {
            s = s.replace(sec.as_str(), MASK);
        }
    }
    s
}

/// POSIX single-quote a value so parameters can never inject shell syntax.
pub fn shell_quote(v: &str) -> String {
    if !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:@%+=,".contains(c)) {
        return v.to_string();
    }
    format!("'{}'", v.replace('\'', r"'\''"))
}

/// Replace `{{name}}` with the quoted parameter value. Unknown names are an error.
pub fn render(command: &str, def: &WorkflowDef, params: &HashMap<String, String>) -> Result<String> {
    let mut out = String::with_capacity(command.len());
    let mut rest = command;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find("}}").ok_or_else(|| anyhow!("Unclosed {{{{ in command"))?;
        let name = after[..end].trim();
        let p = def.params.iter().find(|p| p.name == name).ok_or_else(|| anyhow!("Unknown parameter {{{{{name}}}}}"))?;
        let val = params.get(name).cloned().unwrap_or_else(|| p.default.clone());
        out.push_str(&shell_quote(&val));
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Heuristic list of reasons a command deserves a second look. Not a sandbox.
pub fn risks(cmd: &str) -> Vec<String> {
    let c = format!(" {} ", cmd.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" "));
    let rules: &[(&[&str], &str)] = &[
        (&[" rm -rf", " rm -fr", " rm -r ", " rm -f ", " rm --recursive"], "deletes files (rm)"),
        (&[" mkfs", " wipefs", " fdisk ", " parted ", " sgdisk "], "formats or partitions disks"),
        (&[" dd "], "raw disk write (dd)"),
        (&["> /dev/sd", "> /dev/nvme", "> /dev/vd"], "writes to a block device"),
        (&[" shutdown", " reboot", " poweroff", " halt", " init 0", " init 6"], "reboots or powers off"),
        (&[" systemctl stop", " systemctl restart", " systemctl disable", " systemctl mask", " service "], "stops or restarts services"),
        (&[" kill ", " killall ", " pkill "], "kills processes"),
        (&[" drop database", " drop table", " truncate table", " delete from"], "destructive SQL"),
        (&[" chmod -r", " chown -r", " chmod 777"], "recursive permission change"),
        (&[" docker rm", " docker rmi", " docker system prune", " docker volume rm", " docker compose down", " docker-compose down"], "removes containers or data"),
        (&[" kubectl delete"], "deletes Kubernetes resources"),
        (&[" iptables -f", " ufw disable", " ufw reset", " nft flush"], "changes the firewall"),
        (&[" userdel", " passwd ", " deluser"], "changes user accounts"),
        (&[" apt remove", " apt purge", " apt-get remove", " apt-get purge", " yum remove", " dnf remove", " apk del", " pacman -r"], "removes packages"),
        (&[" git reset --hard", " git clean -f", " git push --force", " git push -f"], "discards git history or changes"),
        (&[":(){"], "fork bomb"),
        (&[" sudo "], "runs as root (sudo)"),
    ];
    let mut out = vec![];
    for (pats, why) in rules {
        if pats.iter().any(|p| c.contains(p)) {
            out.push(why.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def() -> WorkflowDef {
        WorkflowDef {
            params: vec![
                WorkflowParam { name: "svc".into(), label: "".into(), default: "nginx".into(), secret: false },
                WorkflowParam { name: "token".into(), label: "".into(), default: "".into(), secret: true },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn renders_and_quotes() {
        let d = def();
        let mut p = HashMap::new();
        assert_eq!(render("systemctl status {{svc}}", &d, &p).unwrap(), "systemctl status nginx");
        p.insert("svc".into(), "x; rm -rf /".into());
        assert_eq!(render("systemctl status {{ svc }}", &d, &p).unwrap(), "systemctl status 'x; rm -rf /'");
        p.insert("svc".into(), "it's".into());
        assert_eq!(render("echo {{svc}}", &d, &p).unwrap(), r"echo 'it'\''s'");
        assert!(render("echo {{nope}}", &d, &p).is_err());
        assert!(render("echo {{svc", &d, &p).is_err());
    }

    #[test]
    fn masks_secrets() {
        let d = def();
        let mut p = HashMap::new();
        p.insert("token".into(), "abc123".into());
        let s = secret_values(&d, &p);
        assert_eq!(mask("curl -H 'X: abc123' and abc123", &s), "curl -H 'X: ••••' and ••••");
    }

    #[test]
    fn flags_risky_commands() {
        assert!(risks("uptime").is_empty());
        assert!(risks("df -h").is_empty());
        assert!(!risks("sudo rm -rf /var/www/old").is_empty());
        assert!(!risks("systemctl restart nginx").is_empty());
        assert!(!risks("docker system prune -af").is_empty());
        assert!(risks("systemctl status nginx").is_empty());
    }
}
