//! Secret encryption: AES-256-GCM with one random data key (DEK).
//!
//! Two ways to protect the DEK:
//! - **keychain** (default): stored in the OS keychain (macOS Keychain, Windows Credential Manager,
//!   Linux Secret Service), falling back to a 0600 file when no keychain is available. The vault
//!   opens without typing anything.
//! - **master password**: the DEK is wrapped with a key derived from the master password
//!   (Argon2id) and the keychain copy is removed. The vault starts locked; locking drops the DEK
//!   from memory. The master password itself is never stored.
//!
//! Changing modes or passwords only re-wraps the DEK; stored ciphertext stays valid.
use crate::store::Store;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{anyhow, bail, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use zeroize::Zeroizing;

const PREFIX: &str = "v1:";
const SERVICE: &str = "termx";
const USER: &str = "vault-key";
const META_MODE: &str = "vault.mode";
const META_WRAPPED: &str = "vault.wrapped";

type Dek = Zeroizing<[u8; 32]>;

pub struct SecretBox {
    store: Arc<Store>,
    dek: RwLock<Option<Dek>>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VaultMode {
    Keychain,
    Master,
}

/// Password-derived key parameters + sealed bytes (used for the wrapped DEK and for backups).
#[derive(Serialize, Deserialize)]
pub struct Sealed {
    pub kdf: String,
    pub salt: String,
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
    pub nonce: String,
    pub ct: String,
}

impl SecretBox {
    pub fn open(store: Arc<Store>) -> Result<Self> {
        let sb = SecretBox { store, dek: RwLock::new(None) };
        if sb.mode() == VaultMode::Keychain {
            let k = load_or_create_key(sb.store.dir())?;
            *sb.dek.write().unwrap() = Some(k);
        }
        Ok(sb)
    }

    /// A box with a random in-memory key (tests, throwaway stores). Never touches the keychain.
    pub fn ephemeral(store: Arc<Store>) -> Self {
        let mut k = Zeroizing::new([0u8; 32]);
        rand::thread_rng().fill_bytes(&mut k[..]);
        SecretBox { store, dek: RwLock::new(Some(k)) }
    }

    pub fn mode(&self) -> VaultMode {
        match self.store.meta_get(META_MODE).ok().flatten().as_deref() {
            Some("master") => VaultMode::Master,
            _ => VaultMode::Keychain,
        }
    }

    pub fn is_locked(&self) -> bool {
        self.dek.read().unwrap().is_none()
    }

    pub fn lock(&self) {
        if self.mode() == VaultMode::Master {
            *self.dek.write().unwrap() = None;
        }
    }

    pub fn unlock(&self, password: &str) -> Result<()> {
        let wrapped = self.store.meta_get(META_WRAPPED)?.ok_or_else(|| anyhow!("No master password is set"))?;
        let sealed: Sealed = serde_json::from_str(&wrapped)?;
        let plain = open_sealed(&sealed, password)?;
        *self.dek.write().unwrap() = Some(to_dek(&plain)?);
        Ok(())
    }

    /// Switch from keychain to master-password mode.
    pub fn enable_master(&self, password: &str) -> Result<()> {
        check_strength(password)?;
        let dek = self.current()?;
        let sealed = seal(&dek[..], password)?;
        self.store.meta_set(META_WRAPPED, &serde_json::to_string(&sealed)?)?;
        self.store.meta_set(META_MODE, "master")?;
        forget_stored_key(self.store.dir());
        Ok(())
    }

    pub fn change_master(&self, old: &str, new: &str) -> Result<()> {
        check_strength(new)?;
        self.verify_master(old)?;
        let dek = self.current()?;
        let sealed = seal(&dek[..], new)?;
        self.store.meta_set(META_WRAPPED, &serde_json::to_string(&sealed)?)?;
        Ok(())
    }

    /// Back to keychain mode (the DEK goes back into the OS keychain).
    pub fn disable_master(&self, password: &str) -> Result<()> {
        self.verify_master(password)?;
        let dek = self.current()?;
        store_key(self.store.dir(), &dek)?;
        self.store.meta_set(META_MODE, "keychain")?;
        self.store.meta_delete(META_WRAPPED)?;
        Ok(())
    }

    fn verify_master(&self, password: &str) -> Result<()> {
        let wrapped = self.store.meta_get(META_WRAPPED)?.ok_or_else(|| anyhow!("No master password is set"))?;
        let sealed: Sealed = serde_json::from_str(&wrapped)?;
        open_sealed(&sealed, password).map(|_| ())
    }

    fn current(&self) -> Result<Dek> {
        self.dek.read().unwrap().clone().ok_or_else(|| anyhow!("Vault is locked"))
    }

    fn cipher(&self) -> Result<Aes256Gcm> {
        let k = self.current()?;
        Ok(Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&k[..])))
    }

    pub fn encrypt(&self, plain: &str) -> Result<String> {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = self.cipher()?.encrypt(Nonce::from_slice(&nonce), plain.as_bytes()).map_err(|e| anyhow!("encrypt: {e}"))?;
        let mut all = nonce.to_vec();
        all.extend(ct);
        Ok(format!("{PREFIX}{}", B64.encode(all)))
    }

    pub fn decrypt(&self, enc: &str) -> Result<String> {
        let raw = enc.strip_prefix(PREFIX).ok_or_else(|| anyhow!("unknown secret format"))?;
        let all = B64.decode(raw)?;
        if all.len() < 13 {
            bail!("secret too short");
        }
        let (nonce, ct) = all.split_at(12);
        let pt = self.cipher()?.decrypt(Nonce::from_slice(nonce), ct).map_err(|_| anyhow!("decrypt failed (wrong key?)"))?;
        Ok(String::from_utf8(pt)?)
    }

    pub fn decrypt_opt(&self, enc: &Option<String>) -> Option<String> {
        enc.as_ref().and_then(|e| self.decrypt(e).ok())
    }
}

fn check_strength(pw: &str) -> Result<()> {
    if pw.chars().count() < 8 {
        bail!("Use at least 8 characters for the master password");
    }
    Ok(())
}

fn to_dek(b: &[u8]) -> Result<Dek> {
    let arr: [u8; 32] = b.try_into().map_err(|_| anyhow!("bad key length"))?;
    Ok(Zeroizing::new(arr))
}

fn derive(password: &str, salt: &[u8], m_kib: u32, t: u32, p: u32) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(m_kib, t, p, Some(32)).map_err(|e| anyhow!("argon2 params: {e}"))?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut out[..])
        .map_err(|e| anyhow!("argon2: {e}"))?;
    Ok(out)
}

/// Encrypt `plain` under a key derived from `password` (Argon2id, 64 MiB, t=3).
pub fn seal(plain: &[u8], password: &str) -> Result<Sealed> {
    let (m_kib, t, p) = (64 * 1024, 3, 1);
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let k = derive(password, &salt, m_kib, t, p)?;
    let ct = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&k[..])).encrypt(Nonce::from_slice(&nonce), plain).map_err(|e| anyhow!("encrypt: {e}"))?;
    Ok(Sealed { kdf: "argon2id".into(), salt: B64.encode(salt), m_kib, t, p, nonce: B64.encode(nonce), ct: B64.encode(ct) })
}

pub fn open_sealed(s: &Sealed, password: &str) -> Result<Zeroizing<Vec<u8>>> {
    if s.kdf != "argon2id" || s.m_kib > 1024 * 1024 || s.t > 20 {
        bail!("Unsupported key format");
    }
    let k = derive(password, &B64.decode(&s.salt)?, s.m_kib, s.t, s.p)?;
    let nonce = B64.decode(&s.nonce)?;
    if nonce.len() != 12 {
        bail!("Unsupported key format");
    }
    let pt = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&k[..]))
        .decrypt(Nonce::from_slice(&nonce), B64.decode(&s.ct)?.as_slice())
        .map_err(|_| anyhow!("Wrong password"))?;
    Ok(Zeroizing::new(pt))
}

fn key_file(dir: &Path) -> PathBuf {
    dir.join("vault.key")
}

fn load_or_create_key(dir: &Path) -> Result<Dek> {
    // 1. OS keychain
    if let Ok(entry) = keyring::Entry::new(SERVICE, USER) {
        if let Ok(s) = entry.get_password() {
            if let Ok(k) = B64.decode(s.trim()) {
                if k.len() == 32 {
                    return to_dek(&k);
                }
            }
        }
    }
    // 2. file fallback
    if let Ok(s) = std::fs::read_to_string(key_file(dir)) {
        if let Ok(k) = B64.decode(s.trim()) {
            if k.len() == 32 {
                return to_dek(&k);
            }
        }
    }
    // 3. create
    let mut k = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(&mut k[..]);
    store_key(dir, &k)?;
    Ok(k)
}

fn store_key(dir: &Path, k: &Dek) -> Result<()> {
    let enc = Zeroizing::new(B64.encode(&k[..]));
    let stored = keyring::Entry::new(SERVICE, USER).and_then(|e| e.set_password(&enc)).is_ok();
    // Verify the keychain really returns it (some backends accept writes but cannot read back).
    let readable = stored && keyring::Entry::new(SERVICE, USER).and_then(|e| e.get_password()).map(|s| s.trim() == enc.as_str()).unwrap_or(false);
    if !readable {
        std::fs::create_dir_all(dir)?;
        let f = key_file(dir);
        std::fs::write(&f, enc.as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600));
        }
    }
    Ok(())
}

fn forget_stored_key(dir: &Path) {
    if let Ok(e) = keyring::Entry::new(SERVICE, USER) {
        let _ = e.delete_credential();
    }
    let f = key_file(dir);
    if let Ok(md) = std::fs::metadata(&f) {
        let _ = std::fs::write(&f, vec![0u8; md.len() as usize]);
        let _ = std::fs::remove_file(&f);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> Arc<Store> {
        let dir = std::env::temp_dir().join(format!("termx-sb-{}-{}", std::process::id(), crate::model::new_id()));
        Arc::new(Store::open(&dir).unwrap())
    }

    #[test]
    fn roundtrip() {
        let b = SecretBox::ephemeral(tmp_store());
        let e = b.encrypt("hunter2").unwrap();
        assert!(e.starts_with("v1:"));
        assert_eq!(b.decrypt(&e).unwrap(), "hunter2");
        assert!(b.decrypt("v1:AAAA").is_err());
    }

    #[test]
    fn sealed_roundtrip() {
        let s = seal(b"payload", "correct horse").unwrap();
        assert_eq!(&open_sealed(&s, "correct horse").unwrap()[..], b"payload");
        assert!(open_sealed(&s, "wrong").is_err());
    }

    /// Master mode wraps the existing key: data encrypted before stays readable after unlock.
    /// (Uses the in-memory key only; the keychain may be unavailable on CI.)
    #[test]
    fn master_lock_unlock() {
        let store = tmp_store();
        let b = SecretBox { store: store.clone(), dek: RwLock::new(Some(Zeroizing::new([7u8; 32]))) };
        let ct = b.encrypt("s3cret").unwrap();
        assert!(b.enable_master("short").is_err());
        let sealed = seal(&[7u8; 32], "a long master pw").unwrap();
        store.meta_set(META_WRAPPED, &serde_json::to_string(&sealed).unwrap()).unwrap();
        store.meta_set(META_MODE, "master").unwrap();
        b.lock();
        assert!(b.is_locked());
        assert!(b.decrypt(&ct).is_err());
        assert!(b.unlock("nope nope nope").is_err());
        b.unlock("a long master pw").unwrap();
        assert_eq!(b.decrypt(&ct).unwrap(), "s3cret");
        b.change_master("a long master pw", "another long pw").unwrap();
        b.lock();
        b.unlock("another long pw").unwrap();
        assert_eq!(b.decrypt(&ct).unwrap(), "s3cret");
    }
}
