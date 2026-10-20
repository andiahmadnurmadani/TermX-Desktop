//! SSH key generation / import (OpenSSH, PEM, PKCS#8 via russh's decoder).
use crate::model::*;
use crate::secrets::SecretBox;
use anyhow::{anyhow, Result};
use russh::keys::ssh_key::{self, Algorithm, HashAlg, LineEnding, PrivateKey};

pub enum GenKind {
    Ed25519,
    Rsa4096,
    Rsa2048,
}

pub fn generate(sb: &SecretBox, name: &str, kind: GenKind, comment: &str) -> Result<SshKeyRec> {
    let mut rng = ssh_key::rand_core::UnwrapErr(ssh_key::getrandom::SysRng);
    let mut key = match kind {
        GenKind::Ed25519 => PrivateKey::random(&mut rng, Algorithm::Ed25519)?,
        GenKind::Rsa4096 => PrivateKey::from(ssh_key::private::RsaKeypair::random(&mut rng, 4096)?),
        GenKind::Rsa2048 => PrivateKey::from(ssh_key::private::RsaKeypair::random(&mut rng, 2048)?),
    };
    key.set_comment(comment);
    record(sb, name, &key, None)
}

pub fn import(sb: &SecretBox, name: &str, text: &str, passphrase: Option<&str>) -> Result<SshKeyRec> {
    let key = russh::keys::decode_secret_key(text.trim(), passphrase).map_err(|e| anyhow!("could not read key: {e}"))?;
    record(sb, name, &key, passphrase)
}

fn record(sb: &SecretBox, name: &str, key: &PrivateKey, passphrase: Option<&str>) -> Result<SshKeyRec> {
    let pem = key.to_openssh(LineEnding::LF)?;
    let public = key.public_key();
    Ok(SshKeyRec {
        id: new_id(),
        name: name.to_string(),
        kind: key.algorithm().as_str().to_string(),
        public_key: public.to_openssh()?,
        private_enc: sb.encrypt(&pem)?,
        passphrase_enc: match passphrase.filter(|p| !p.is_empty()) {
            Some(p) => Some(sb.encrypt(p)?),
            None => None,
        },
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        created_at: now_ms(),
        installed_on: vec![],
    })
}

/// Decode the stored private key (for authentication).
pub fn load_private(sb: &SecretBox, rec: &SshKeyRec) -> Result<PrivateKey> {
    let pem = sb.decrypt(&rec.private_enc)?;
    let pass = sb.decrypt_opt(&rec.passphrase_enc);
    russh::keys::decode_secret_key(&pem, pass.as_deref()).map_err(|e| anyhow!("{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generate_and_reload() {
        let dir = std::env::temp_dir().join(format!("termx-keys-{}-{}", std::process::id(), new_id()));
        let sb = SecretBox::ephemeral(std::sync::Arc::new(crate::store::Store::open(&dir).unwrap()));
        let rec = generate(&sb, "t", GenKind::Ed25519, "me@test").unwrap();
        assert!(rec.public_key.starts_with("ssh-ed25519 "));
        assert!(rec.fingerprint.starts_with("SHA256:"));
        let k = load_private(&sb, &rec).unwrap();
        assert_eq!(k.public_key().to_openssh().unwrap(), rec.public_key);
        // import roundtrip
        let pem = sb.decrypt(&rec.private_enc).unwrap();
        let again = import(&sb, "i", &pem, None).unwrap();
        assert_eq!(again.fingerprint, rec.fingerprint);
    }
}
