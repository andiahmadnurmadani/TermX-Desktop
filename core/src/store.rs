//! Local storage: SQLite (WAL, transactions, versioned schema).
//!
//! The small, frequently read collections (hosts, keys, workspaces, ...) are kept in memory as a
//! [`Vault`] and written back in one transaction on every change. Ciphertext never sits next to
//! the records it belongs to: it lives in `vault_secrets`. Workflow history is append-heavy and is
//! only touched through SQL.
use crate::model::*;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const SCHEMA_VERSION: i32 = 2;
const KEEP_LOGS: i64 = 1000;
const KEEP_RUNS: i64 = 300;

pub struct Store {
    dir: PathBuf,
    conn: Mutex<Connection>,
    data: Mutex<Vault>,
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("termx.db");
        let conn = match open_db(&path) {
            Ok(c) => c,
            Err(e) => {
                // Never lose data silently: keep the unreadable file and start a fresh one.
                if path.exists() {
                    let bad = dir.join(format!("termx.db.bad-{}", now_ms()));
                    std::fs::rename(&path, &bad).with_context(|| format!("database unreadable ({e:#}) and could not be moved aside"))?;
                }
                open_db(&path)?
            }
        };
        let fresh = conn.query_row("SELECT COUNT(*) FROM meta WHERE key = 'initialized'", [], |r| r.get::<_, i64>(0))? == 0;
        let store = Store { dir: dir.to_path_buf(), conn: Mutex::new(conn), data: Mutex::new(Vault::default()) };
        if fresh {
            let v = migrate_json(dir).unwrap_or_default();
            *store.data.lock().unwrap() = v;
            store.update(|_| ())?;
            store.meta_set("initialized", &now_ms().to_string())?;
        } else {
            let v = store.load()?;
            *store.data.lock().unwrap() = v;
        }
        Ok(store)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn read<R>(&self, f: impl FnOnce(&Vault) -> R) -> R {
        f(&self.data.lock().unwrap())
    }

    /// Mutate and persist (one transaction).
    pub fn update<R>(&self, f: impl FnOnce(&mut Vault) -> R) -> Result<R> {
        let mut g = self.data.lock().unwrap();
        let mut next = g.clone();
        let r = f(&mut next);
        {
            let mut conn = self.conn.lock().unwrap();
            write_all(&mut conn, &next)?;
        }
        // Only adopt the change once it is on disk.
        *g = next;
        Ok(r)
    }

    pub fn snapshot(&self) -> Vault {
        self.data.lock().unwrap().clone()
    }

    pub fn host(&self, id: &str) -> Option<Host> {
        self.read(|v| v.hosts.iter().find(|h| h.id == id).cloned())
    }

    fn load(&self) -> Result<Vault> {
        let conn = self.conn.lock().unwrap();
        let secret = |owner: &str, field: &str| -> Result<Option<String>> {
            Ok(conn
                .query_row("SELECT ciphertext FROM vault_secrets WHERE owner = ?1 AND field = ?2", params![owner, field], |r| r.get(0))
                .optional()?)
        };
        let mut v = Vault { snippets: vec![], workflows: vec![], ..Vault::default() };

        for (id, json) in rows(&conn, "SELECT id, data FROM ssh_hosts ORDER BY pos")? {
            let mut h: Host = serde_json::from_str(&json).with_context(|| format!("host {id}"))?;
            h.password_enc = secret(&format!("host:{id}"), "password")?;
            v.hosts.push(h);
        }
        for (_, json) in rows(&conn, "SELECT id, data FROM host_groups ORDER BY pos")? {
            v.groups.push(serde_json::from_str(&json)?);
        }
        for (id, json) in rows(&conn, "SELECT id, data FROM ssh_keys ORDER BY pos")? {
            let mut k: SshKeyRec = serde_json::from_str(&json)?;
            k.private_enc = secret(&format!("key:{id}"), "private")?.unwrap_or_default();
            k.passphrase_enc = secret(&format!("key:{id}"), "passphrase")?;
            v.keys.push(k);
        }
        for (_, json) in rows(&conn, "SELECT id, data FROM snippets ORDER BY pos")? {
            v.snippets.push(serde_json::from_str(&json)?);
        }
        {
            let mut st = conn.prepare("SELECT host_port, key_type, fingerprint, added_at FROM host_key_pins ORDER BY added_at")?;
            let it = st.query_map([], |r| Ok(KnownHost { host_port: r.get(0)?, key_type: r.get(1)?, fingerprint: r.get(2)?, added_at: r.get(3)? }))?;
            for k in it {
                v.known_hosts.push(k?);
            }
        }
        if let Some(json) = conn.query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| r.get::<_, String>(0)).optional()? {
            v.settings = serde_json::from_str(&json).unwrap_or_default();
        }
        for (id, json) in rows(&conn, "SELECT id, data FROM workspaces ORDER BY pos")? {
            let mut w: Workspace = serde_json::from_str(&json)?;
            w.panes = vec![None, None, None, None];
            let mut st = conn.prepare("SELECT idx, host_id FROM workspace_panes WHERE workspace_id = ?1")?;
            let it = st.query_map(params![id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)))?;
            for p in it {
                let (i, h) = p?;
                if (0..4).contains(&i) {
                    w.panes[i as usize] = h;
                }
            }
            v.workspaces.push(w);
        }
        for (id, json) in rows(&conn, "SELECT id, data FROM workflow_definitions ORDER BY pos")? {
            let mut d: WorkflowDef = serde_json::from_str(&json)?;
            d.steps = vec![];
            let mut st = conn.prepare("SELECT data FROM workflow_steps WHERE workflow_id = ?1 ORDER BY idx")?;
            let it = st.query_map(params![id], |r| r.get::<_, String>(0))?;
            for s in it {
                d.steps.push(serde_json::from_str(&s?)?);
            }
            v.workflows.push(d);
        }
        Ok(v)
    }

    // -------------------------------------------------------------- key/value meta

    pub fn meta_get(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0)).optional()?)
    }

    pub fn meta_set(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])?;
        Ok(())
    }

    pub fn meta_delete(&self, key: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM meta WHERE key = ?1", params![key])?;
        Ok(())
    }

    // -------------------------------------------------------------- workflow history

    pub fn run_insert(&self, run: &WorkflowRun) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO workflow_runs(id, workflow_id, workflow_name, host_ids, params, started_at, finished_at, status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                run.id,
                run.workflow_id,
                run.workflow_name,
                serde_json::to_string(&run.host_ids)?,
                serde_json::to_string(&run.params)?,
                run.started_at,
                run.finished_at,
                run.status
            ],
        )?;
        for s in &run.steps {
            upsert_step(&tx, &run.id, s)?;
        }
        // Bounded history.
        tx.execute(
            "DELETE FROM workflow_runs WHERE id IN (SELECT id FROM workflow_runs ORDER BY started_at DESC LIMIT -1 OFFSET ?1)",
            params![KEEP_RUNS],
        )?;
        tx.execute("DELETE FROM workflow_step_runs WHERE run_id NOT IN (SELECT id FROM workflow_runs)", [])?;
        tx.commit()?;
        Ok(())
    }

    pub fn step_update(&self, run_id: &str, s: &StepRun) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        upsert_step(&conn, run_id, s)
    }

    pub fn run_finish(&self, run_id: &str, status: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE workflow_runs SET status = ?2, finished_at = ?3 WHERE id = ?1", params![run_id, status, now_ms()])?;
        Ok(())
    }

    /// Runs without step output (newest first).
    pub fn runs_list(&self, workflow_id: Option<&str>, limit: u32) -> Result<Vec<WorkflowRun>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare(
            "SELECT id, workflow_id, workflow_name, host_ids, params, started_at, finished_at, status FROM workflow_runs
             WHERE (?1 IS NULL OR workflow_id = ?1) ORDER BY started_at DESC LIMIT ?2",
        )?;
        let it = st.query_map(params![workflow_id, limit], run_from_row)?;
        let mut out = vec![];
        for r in it {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn run_get(&self, id: &str) -> Result<Option<WorkflowRun>> {
        let conn = self.conn.lock().unwrap();
        let run = conn
            .query_row(
                "SELECT id, workflow_id, workflow_name, host_ids, params, started_at, finished_at, status FROM workflow_runs WHERE id = ?1",
                params![id],
                run_from_row,
            )
            .optional()?;
        let Some(mut run) = run else { return Ok(None) };
        let mut st = conn.prepare(
            "SELECT host_id, host_label, idx, name, command, started_at, finished_at, exit_code, status, stdout, stderr, error
             FROM workflow_step_runs WHERE run_id = ?1 ORDER BY host_label, host_id, idx",
        )?;
        let it = st.query_map(params![id], |r| {
            Ok(StepRun {
                host_id: r.get(0)?,
                host_label: r.get(1)?,
                idx: r.get(2)?,
                name: r.get(3)?,
                command: r.get(4)?,
                started_at: r.get(5)?,
                finished_at: r.get(6)?,
                exit_code: r.get(7)?,
                status: r.get(8)?,
                stdout: r.get(9)?,
                stderr: r.get(10)?,
                error: r.get(11)?,
            })
        })?;
        for s in it {
            run.steps.push(s?);
        }
        Ok(Some(run))
    }

    /// Runs left in "running" by a crash or a forced quit.
    pub fn runs_mark_interrupted(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE workflow_runs SET status = 'cancelled', finished_at = ?1 WHERE status = 'running'", params![now_ms()])?;
        conn.execute("UPDATE workflow_step_runs SET status = 'cancelled' WHERE status IN ('running', 'pending')", [])?;
        Ok(())
    }

    pub fn runs_clear(&self, workflow_id: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM workflow_runs WHERE (?1 IS NULL OR workflow_id = ?1)", params![workflow_id])?;
        conn.execute("DELETE FROM workflow_step_runs WHERE run_id NOT IN (SELECT id FROM workflow_runs)", [])?;
        Ok(())
    }
}

impl Store {
    // -------------------------------------------------------------- session logs

    pub fn log_upsert(&self, l: &SessionLog) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO session_logs(id, host_id, host_label, username, hostname, port, started_at, connected_at, ended_at, status, message, reconnects, bytes, transcript)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(id) DO UPDATE SET connected_at = excluded.connected_at, ended_at = excluded.ended_at, status = excluded.status,
               message = excluded.message, reconnects = excluded.reconnects, bytes = excluded.bytes, transcript = excluded.transcript",
            params![l.id, l.host_id, l.host_label, l.username, l.hostname, l.port, l.started_at, l.connected_at, l.ended_at, l.status, l.message, l.reconnects, l.bytes as i64, l.transcript],
        )?;
        Ok(())
    }

    /// Newest first. Returns the ids that fell off the end of the bounded history (their transcripts go too).
    pub fn logs_trim(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT id FROM session_logs ORDER BY started_at DESC LIMIT -1 OFFSET ?1")?;
        let old: Vec<String> = st.query_map(params![KEEP_LOGS], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        for id in &old {
            conn.execute("DELETE FROM session_logs WHERE id = ?1", params![id])?;
        }
        Ok(old)
    }

    pub fn logs_list(&self, limit: u32) -> Result<Vec<SessionLog>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare(
            "SELECT id, host_id, host_label, username, hostname, port, started_at, connected_at, ended_at, status, message, reconnects, bytes, transcript
             FROM session_logs ORDER BY started_at DESC LIMIT ?1",
        )?;
        let it = st.query_map(params![limit], |r| {
            Ok(SessionLog {
                id: r.get(0)?,
                host_id: r.get(1)?,
                host_label: r.get(2)?,
                username: r.get(3)?,
                hostname: r.get(4)?,
                port: r.get(5)?,
                started_at: r.get(6)?,
                connected_at: r.get(7)?,
                ended_at: r.get(8)?,
                status: r.get(9)?,
                message: r.get(10)?,
                reconnects: r.get(11)?,
                bytes: r.get::<_, i64>(12)? as u64,
                transcript: r.get(13)?,
            })
        })?;
        Ok(it.collect::<rusqlite::Result<_>>()?)
    }

    /// Delete one log (`Some`) or all of them; returns the deleted ids.
    pub fn logs_delete(&self, id: Option<&str>) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT id FROM session_logs WHERE (?1 IS NULL OR id = ?1)")?;
        let ids: Vec<String> = st.query_map(params![id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        conn.execute("DELETE FROM session_logs WHERE (?1 IS NULL OR id = ?1)", params![id])?;
        Ok(ids)
    }

    /// Sessions left open by a crash or a forced quit.
    pub fn logs_mark_interrupted(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE session_logs SET status = 'ended', ended_at = MAX(connected_at, started_at) WHERE status IN ('connecting', 'connected', 'reconnecting')",
            [],
        )?;
        Ok(())
    }
}

fn run_from_row(r: &rusqlite::Row) -> rusqlite::Result<WorkflowRun> {
    let hosts: String = r.get(3)?;
    let params: String = r.get(4)?;
    Ok(WorkflowRun {
        id: r.get(0)?,
        workflow_id: r.get(1)?,
        workflow_name: r.get(2)?,
        host_ids: serde_json::from_str(&hosts).unwrap_or_default(),
        params: serde_json::from_str(&params).unwrap_or_default(),
        started_at: r.get(5)?,
        finished_at: r.get(6)?,
        status: r.get(7)?,
        steps: vec![],
    })
}

fn upsert_step(conn: &Connection, run_id: &str, s: &StepRun) -> Result<()> {
    conn.execute(
        "INSERT INTO workflow_step_runs(run_id, host_id, host_label, idx, name, command, started_at, finished_at, exit_code, status, stdout, stderr, error)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(run_id, host_id, idx) DO UPDATE SET started_at = excluded.started_at, finished_at = excluded.finished_at,
           exit_code = excluded.exit_code, status = excluded.status, stdout = excluded.stdout, stderr = excluded.stderr, error = excluded.error",
        params![run_id, s.host_id, s.host_label, s.idx, s.name, s.command, s.started_at, s.finished_at, s.exit_code, s.status, s.stdout, s.stderr, s.error],
    )?;
    Ok(())
}

fn rows(conn: &Connection, sql: &str) -> Result<Vec<(String, String)>> {
    let mut st = conn.prepare(sql)?;
    let it = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = vec![];
    for r in it {
        out.push(r?);
    }
    Ok(out)
}

fn open_db(path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let ok: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if ok != "ok" {
        anyhow::bail!("integrity check failed: {ok}");
    }
    migrate(&mut conn)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(conn)
}

/// Schema migrations, applied in order inside one transaction each.
fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version > SCHEMA_VERSION {
        anyhow::bail!("database was created by a newer TermX (schema {version})");
    }
    if version < 1 {
        let tx = conn.transaction()?;
        tx.execute_batch(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE ssh_hosts (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE host_groups (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE ssh_keys (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE snippets (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE vault_secrets (owner TEXT NOT NULL, field TEXT NOT NULL, ciphertext TEXT NOT NULL, PRIMARY KEY (owner, field));
            CREATE TABLE host_key_pins (host_port TEXT NOT NULL, key_type TEXT NOT NULL, fingerprint TEXT NOT NULL, added_at INTEGER NOT NULL,
                PRIMARY KEY (host_port, key_type));
            CREATE TABLE workspaces (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE workspace_panes (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
                host_id TEXT, PRIMARY KEY (workspace_id, idx));
            CREATE TABLE workflow_definitions (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE workflow_steps (workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
                data TEXT NOT NULL, PRIMARY KEY (workflow_id, idx));
            CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, host_ids TEXT NOT NULL,
                params TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, status TEXT NOT NULL);
            CREATE INDEX workflow_runs_by_def ON workflow_runs(workflow_id, started_at);
            CREATE TABLE workflow_step_runs (run_id TEXT NOT NULL, host_id TEXT NOT NULL, host_label TEXT NOT NULL, idx INTEGER NOT NULL,
                name TEXT NOT NULL, command TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, exit_code INTEGER,
                status TEXT NOT NULL, stdout TEXT NOT NULL, stderr TEXT NOT NULL, error TEXT NOT NULL, PRIMARY KEY (run_id, host_id, idx));
            CREATE TABLE sync_objects (id TEXT PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                ciphertext BLOB NOT NULL);
            PRAGMA user_version = 1;
            ",
        )?;
        tx.commit()?;
    }
    if version < 2 {
        let tx = conn.transaction()?;
        tx.execute_batch(
            "
            CREATE TABLE session_logs (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, host_label TEXT NOT NULL, username TEXT NOT NULL,
                hostname TEXT NOT NULL, port INTEGER NOT NULL, started_at INTEGER NOT NULL, connected_at INTEGER NOT NULL,
                ended_at INTEGER NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, reconnects INTEGER NOT NULL,
                bytes INTEGER NOT NULL, transcript INTEGER NOT NULL);
            CREATE INDEX session_logs_started ON session_logs(started_at DESC);
            PRAGMA user_version = 2;
            ",
        )?;
        tx.commit()?;
    }
    Ok(())
}

fn write_all(conn: &mut Connection, v: &Vault) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "DELETE FROM ssh_hosts; DELETE FROM host_groups; DELETE FROM ssh_keys; DELETE FROM snippets; DELETE FROM vault_secrets;
         DELETE FROM host_key_pins; DELETE FROM workspace_panes; DELETE FROM workspaces; DELETE FROM workflow_steps; DELETE FROM workflow_definitions;",
    )?;
    let put_secret = |owner: String, field: &str, ct: &Option<String>| -> Result<()> {
        if let Some(ct) = ct.as_ref().filter(|c| !c.is_empty()) {
            tx.execute("INSERT INTO vault_secrets(owner, field, ciphertext) VALUES(?1, ?2, ?3)", params![owner, field, ct])?;
        }
        Ok(())
    };
    for (i, h) in v.hosts.iter().enumerate() {
        let mut c = h.clone();
        let pw = c.password_enc.take();
        tx.execute("INSERT INTO ssh_hosts(id, pos, data) VALUES(?1, ?2, ?3)", params![h.id, i as i64, serde_json::to_string(&c)?])?;
        put_secret(format!("host:{}", h.id), "password", &pw)?;
    }
    for (i, g) in v.groups.iter().enumerate() {
        tx.execute("INSERT INTO host_groups(id, pos, data) VALUES(?1, ?2, ?3)", params![g.id, i as i64, serde_json::to_string(g)?])?;
    }
    for (i, k) in v.keys.iter().enumerate() {
        // SshKeyRec never serialises its private parts.
        tx.execute("INSERT INTO ssh_keys(id, pos, data) VALUES(?1, ?2, ?3)", params![k.id, i as i64, serde_json::to_string(k)?])?;
        put_secret(format!("key:{}", k.id), "private", &Some(k.private_enc.clone()))?;
        put_secret(format!("key:{}", k.id), "passphrase", &k.passphrase_enc)?;
    }
    for (i, s) in v.snippets.iter().enumerate() {
        tx.execute("INSERT INTO snippets(id, pos, data) VALUES(?1, ?2, ?3)", params![s.id, i as i64, serde_json::to_string(s)?])?;
    }
    for k in &v.known_hosts {
        tx.execute(
            "INSERT OR REPLACE INTO host_key_pins(host_port, key_type, fingerprint, added_at) VALUES(?1, ?2, ?3, ?4)",
            params![k.host_port, k.key_type, k.fingerprint, k.added_at],
        )?;
    }
    tx.execute(
        "INSERT INTO settings(key, value) VALUES('app', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![serde_json::to_string(&v.settings)?],
    )?;
    for (i, w) in v.workspaces.iter().enumerate() {
        let mut c = w.clone();
        let panes = std::mem::take(&mut c.panes);
        tx.execute("INSERT INTO workspaces(id, pos, data) VALUES(?1, ?2, ?3)", params![w.id, i as i64, serde_json::to_string(&c)?])?;
        for (idx, p) in panes.iter().take(4).enumerate() {
            tx.execute("INSERT INTO workspace_panes(workspace_id, idx, host_id) VALUES(?1, ?2, ?3)", params![w.id, idx as i64, p])?;
        }
    }
    for (i, d) in v.workflows.iter().enumerate() {
        let mut c = d.clone();
        let steps = std::mem::take(&mut c.steps);
        tx.execute("INSERT INTO workflow_definitions(id, pos, data) VALUES(?1, ?2, ?3)", params![d.id, i as i64, serde_json::to_string(&c)?])?;
        for (idx, s) in steps.iter().enumerate() {
            tx.execute("INSERT INTO workflow_steps(workflow_id, idx, data) VALUES(?1, ?2, ?3)", params![d.id, idx as i64, serde_json::to_string(s)?])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// One-time import of the pre-SQLite `vault.json` (kept as `vault.json.migrated`).
fn migrate_json(dir: &Path) -> Option<Vault> {
    let path = dir.join("vault.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let v: Vault = serde_json::from_str(&text).ok()?;
    let _ = std::fs::rename(&path, dir.join("vault.json.migrated"));
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("termx-store-{name}-{}-{}", std::process::id(), new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn roundtrip_and_secrets_split() {
        let dir = tmp("rt");
        {
            let s = Store::open(&dir).unwrap();
            s.update(|v| {
                let mut h = Host { label: "web".into(), hostname: "10.0.0.1".into(), username: "root".into(), ..Default::default() };
                h.password_enc = Some("v1:CIPHER".into());
                v.hosts.push(h);
                v.keys.push(SshKeyRec {
                    id: "k1".into(),
                    name: "k".into(),
                    kind: "ed25519".into(),
                    public_key: "ssh-ed25519 AAA".into(),
                    private_enc: "v1:PRIV".into(),
                    passphrase_enc: None,
                    fingerprint: "SHA256:x".into(),
                    created_at: 1,
                    installed_on: vec![],
                });
                let mut w = Workspace { name: "ops".into(), ..Default::default() };
                w.panes[2] = Some("h".into());
                v.workspaces.push(w);
            })
            .unwrap();
        }
        let s = Store::open(&dir).unwrap();
        let v = s.snapshot();
        assert_eq!(v.hosts[0].password_enc.as_deref(), Some("v1:CIPHER"));
        assert_eq!(v.keys[0].private_enc, "v1:PRIV");
        assert_eq!(v.workspaces[0].panes[2].as_deref(), Some("h"));
        assert_eq!(v.workflows.len(), default_workflows().len());
        // ciphertext is not inside the host row
        let conn = s.conn.lock().unwrap();
        let data: String = conn.query_row("SELECT data FROM ssh_hosts", [], |r| r.get(0)).unwrap();
        assert!(!data.contains("CIPHER"));
    }

    #[test]
    fn migrates_json_vault() {
        let dir = tmp("mig");
        std::fs::write(
            dir.join("vault.json"),
            r#"{"version":1,"hosts":[{"id":"h1","label":"a","hostname":"x","username":"u","passwordEnc":"v1:P"}],
               "keys":[{"id":"k1","name":"k","kind":"ed25519","publicKey":"p","privateEnc":"v1:K","fingerprint":"f","createdAt":1}]}"#,
        )
        .unwrap();
        let s = Store::open(&dir).unwrap();
        let v = s.snapshot();
        assert_eq!(v.hosts[0].password_enc.as_deref(), Some("v1:P"));
        assert_eq!(v.keys[0].private_enc, "v1:K");
        assert!(dir.join("vault.json.migrated").exists());
    }

    #[test]
    fn run_history() {
        let dir = tmp("runs");
        let s = Store::open(&dir).unwrap();
        let run = WorkflowRun {
            id: "r1".into(),
            workflow_id: "w".into(),
            workflow_name: "W".into(),
            host_ids: vec!["h".into()],
            params: vec![],
            started_at: 1,
            finished_at: 0,
            status: "running".into(),
            steps: vec![StepRun {
                host_id: "h".into(),
                host_label: "H".into(),
                idx: 0,
                name: "s".into(),
                command: "uptime".into(),
                started_at: 0,
                finished_at: 0,
                exit_code: None,
                status: "pending".into(),
                stdout: String::new(),
                stderr: String::new(),
                error: String::new(),
            }],
        };
        s.run_insert(&run).unwrap();
        let mut st = run.steps[0].clone();
        st.status = "ok".into();
        st.exit_code = Some(0);
        st.stdout = "up 3 days".into();
        s.step_update("r1", &st).unwrap();
        s.run_finish("r1", "ok").unwrap();
        let got = s.run_get("r1").unwrap().unwrap();
        assert_eq!(got.status, "ok");
        assert_eq!(got.steps[0].stdout, "up 3 days");
        assert_eq!(s.runs_list(Some("w"), 10).unwrap().len(), 1);
    }
}
