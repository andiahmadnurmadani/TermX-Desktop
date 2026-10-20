//! Single-file JSON vault with atomic writes.
use crate::model::*;
use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Store {
    path: PathBuf,
    data: Mutex<Vault>,
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("vault.json");
        let data = match std::fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str::<Vault>(&s) {
                Ok(v) => v,
                Err(_) => {
                    // Never lose data: keep a copy of an unreadable file before it is overwritten.
                    let _ = std::fs::copy(&path, dir.join(format!("vault.json.bad-{}", now_ms())));
                    Vault::default()
                }
            },
            Err(_) => Vault::default(),
        };
        Ok(Store { path, data: Mutex::new(data) })
    }

    pub fn read<R>(&self, f: impl FnOnce(&Vault) -> R) -> R {
        f(&self.data.lock().unwrap())
    }

    /// Mutate and persist.
    pub fn update<R>(&self, f: impl FnOnce(&mut Vault) -> R) -> Result<R> {
        let mut g = self.data.lock().unwrap();
        let r = f(&mut g);
        let json = serde_json::to_vec_pretty(&*g)?;
        drop(g);
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(r)
    }

    pub fn snapshot(&self) -> Vault {
        self.data.lock().unwrap().clone()
    }

    pub fn host(&self, id: &str) -> Option<Host> {
        self.read(|v| v.hosts.iter().find(|h| h.id == id).cloned())
    }
}
