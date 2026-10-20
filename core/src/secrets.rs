//! Secret encryption: AES-256-GCM. The key lives in the OS keychain (macOS Keychain, Windows
//! Credential Manager, Linux Secret Service); if that is unavailable it falls back to a 0600 file.
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use std::path::PathBuf;

const PREFIX: &str = "v1:";
const SERVICE: &str = "termx";
const USER: &str = "vault-key";

pub struct SecretBox {
    cipher: Aes256Gcm,
}

impl SecretBox {
    /// `dir` is the app data dir (used for the file fallback).
    pub fn open(dir: &std::path::Path) -> Result<Self> {
        let key = load_or_create_key(dir)?;
        Ok(SecretBox { cipher: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key)) })
    }

    pub fn encrypt(&self, plain: &str) -> Result<String> {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
            .map_err(|e| anyhow!("encrypt: {e}"))?;
        let mut all = nonce.to_vec();
        all.extend(ct);
        Ok(format!("{PREFIX}{}", B64.encode(all)))
    }

    pub fn decrypt(&self, enc: &str) -> Result<String> {
        let raw = enc.strip_prefix(PREFIX).ok_or_else(|| anyhow!("unknown secret format"))?;
        let all = B64.decode(raw)?;
        if all.len() < 13 {
            return Err(anyhow!("secret too short"));
        }
        let (nonce, ct) = all.split_at(12);
        let pt = self.cipher.decrypt(Nonce::from_slice(nonce), ct).map_err(|_| anyhow!("decrypt failed (wrong key?)"))?;
        Ok(String::from_utf8(pt)?)
    }

    pub fn decrypt_opt(&self, enc: &Option<String>) -> Option<String> {
        enc.as_ref().and_then(|e| self.decrypt(e).ok())
    }
}

fn key_file(dir: &std::path::Path) -> PathBuf {
    dir.join("vault.key")
}

fn load_or_create_key(dir: &std::path::Path) -> Result<Vec<u8>> {
    // 1. OS keychain
    if let Ok(entry) = keyring::Entry::new(SERVICE, USER) {
        if let Ok(s) = entry.get_password() {
            if let Ok(k) = B64.decode(s.trim()) {
                if k.len() == 32 {
                    return Ok(k);
                }
            }
        }
    }
    // 2. file fallback
    let f = key_file(dir);
    if let Ok(s) = std::fs::read_to_string(&f) {
        if let Ok(k) = B64.decode(s.trim()) {
            if k.len() == 32 {
                return Ok(k);
            }
        }
    }
    // 3. create
    let mut k = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut k);
    let enc = B64.encode(&k);
    let stored = keyring::Entry::new(SERVICE, USER).and_then(|e| e.set_password(&enc)).is_ok();
    // Verify the keychain really returns it (some backends accept writes but cannot read back).
    let readable = stored
        && keyring::Entry::new(SERVICE, USER).and_then(|e| e.get_password()).map(|s| s.trim() == enc).unwrap_or(false);
    if !readable {
        std::fs::create_dir_all(dir)?;
        std::fs::write(&f, &enc)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600));
        }
    }
    Ok(k)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip() {
        let dir = std::env::temp_dir().join(format!("termx-test-{}", std::process::id()));
        let b = SecretBox::open(&dir).unwrap();
        let e = b.encrypt("hunter2").unwrap();
        assert!(e.starts_with("v1:"));
        assert_eq!(b.decrypt(&e).unwrap(), "hunter2");
        assert!(b.decrypt("v1:AAAA").is_err());
    }
}
