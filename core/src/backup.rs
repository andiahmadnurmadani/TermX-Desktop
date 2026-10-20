//! Encrypted, portable backups. Secrets are decrypted with the current vault key and the whole
//! payload is sealed with a separate backup password (Argon2id + AES-256-GCM), so a backup can be
//! restored on another device or after switching vault modes.
use crate::model::*;
use crate::secrets::{open_sealed, seal, SecretBox, Sealed};
use crate::store::Store;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const FORMAT: &str = "termx-backup";

#[derive(Serialize, Deserialize)]
struct File {
    format: String,
    version: u32,
    created_at: i64,
    sealed: Sealed,
}

#[derive(Serialize, Deserialize)]
struct Payload {
    vault: Vault,
    /// "host:<id>:password", "key:<id>:private", "key:<id>:passphrase" -> plaintext
    secrets: HashMap<String, String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub hosts: usize,
    pub keys: usize,
    pub workspaces: usize,
    pub workflows: usize,
}

pub fn export(store: &Store, sb: &SecretBox, password: &str) -> Result<String> {
    if password.chars().count() < 8 {
        bail!("Use at least 8 characters for the backup password");
    }
    let mut v = store.snapshot();
    let mut secrets = HashMap::new();
    for h in v.hosts.iter_mut() {
        if let Some(ct) = h.password_enc.take() {
            secrets.insert(format!("host:{}:password", h.id), sb.decrypt(&ct)?);
        }
    }
    for k in v.keys.iter_mut() {
        if !k.private_enc.is_empty() {
            secrets.insert(format!("key:{}:private", k.id), sb.decrypt(&k.private_enc)?);
        }
        if let Some(ct) = k.passphrase_enc.take() {
            secrets.insert(format!("key:{}:passphrase", k.id), sb.decrypt(&ct)?);
        }
        k.private_enc.clear();
    }
    let plain = zeroize::Zeroizing::new(serde_json::to_vec(&Payload { vault: v, secrets })?);
    let file = File { format: FORMAT.into(), version: 1, created_at: now_ms(), sealed: seal(&plain, password)? };
    Ok(serde_json::to_string_pretty(&file)?)
}

/// Merge a backup into the vault: records with the same id are replaced, others are added.
pub fn restore(store: &Store, sb: &SecretBox, text: &str, password: &str) -> Result<RestoreReport> {
    let file: File = serde_json::from_str(text).map_err(|_| anyhow::anyhow!("Not a TermX backup file"))?;
    if file.format != FORMAT || file.version != 1 {
        bail!("Unsupported backup version");
    }
    let plain = open_sealed(&file.sealed, password)?;
    let p: Payload = serde_json::from_slice(&plain)?;
    let sec = |k: String| p.secrets.get(&k).cloned();
    let mut incoming = p.vault.clone();
    for h in incoming.hosts.iter_mut() {
        h.password_enc = match sec(format!("host:{}:password", h.id)) {
            Some(pw) => Some(sb.encrypt(&pw)?),
            None => None,
        };
    }
    for k in incoming.keys.iter_mut() {
        k.private_enc = match sec(format!("key:{}:private", k.id)) {
            Some(x) => sb.encrypt(&x)?,
            None => String::new(),
        };
        k.passphrase_enc = match sec(format!("key:{}:passphrase", k.id)) {
            Some(x) => Some(sb.encrypt(&x)?),
            None => None,
        };
    }
    incoming.keys.retain(|k| !k.private_enc.is_empty());
    let report = RestoreReport {
        hosts: incoming.hosts.len(),
        keys: incoming.keys.len(),
        workspaces: incoming.workspaces.len(),
        workflows: incoming.workflows.len(),
    };
    store.update(|v| {
        merge(&mut v.hosts, incoming.hosts, |x| x.id.clone());
        merge(&mut v.groups, incoming.groups, |x| x.id.clone());
        merge(&mut v.keys, incoming.keys, |x| x.id.clone());
        merge(&mut v.snippets, incoming.snippets, |x| x.id.clone());
        merge(&mut v.known_hosts, incoming.known_hosts, |x| format!("{}|{}", x.host_port, x.key_type));
        merge(&mut v.workspaces, incoming.workspaces, |x| x.id.clone());
        merge(&mut v.workflows, incoming.workflows, |x| x.id.clone());
    })?;
    Ok(report)
}

fn merge<T>(into: &mut Vec<T>, from: Vec<T>, key: impl Fn(&T) -> String) {
    for item in from {
        let k = key(&item);
        match into.iter_mut().find(|x| key(x) == k) {
            Some(slot) => *slot = item,
            None => into.push(item),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn tmp(n: &str) -> Arc<Store> {
        let d = std::env::temp_dir().join(format!("termx-bk-{n}-{}-{}", std::process::id(), new_id()));
        Arc::new(Store::open(&d).unwrap())
    }

    #[test]
    fn export_restore_across_vaults() {
        let (a, b) = (tmp("a"), tmp("b"));
        let (sa, sbx) = (SecretBox::ephemeral(a.clone()), SecretBox::ephemeral(b.clone()));
        let pw = sa.encrypt("hunter22").unwrap();
        a.update(|v| v.hosts.push(Host { id: "h1".into(), label: "web".into(), password_enc: Some(pw), ..Default::default() })).unwrap();
        let file = export(&a, &sa, "backup-password").unwrap();
        assert!(!file.contains("hunter22"));
        assert!(restore(&b, &sbx, &file, "wrong-password").is_err());
        let r = restore(&b, &sbx, &file, "backup-password").unwrap();
        assert_eq!(r.hosts, 1);
        let h = b.host("h1").unwrap();
        assert_eq!(sbx.decrypt(h.password_enc.as_ref().unwrap()).unwrap(), "hunter22");
    }
}
