//! Local terminal: the user's own shell in a pseudo-terminal (ConPTY on Windows).
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct LocalPty {
    sessions: Mutex<HashMap<String, Session>>,
}

/// The shell to start: $SHELL on Unix, PowerShell (7 if installed) on Windows.
pub fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let in_path = |exe: &str| {
            std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file()))
        };
        if in_path("pwsh.exe") {
            return ("pwsh.exe".into(), vec!["-NoLogo".into()]);
        }
        if in_path("powershell.exe") {
            return ("powershell.exe".into(), vec!["-NoLogo".into()]);
        }
        (std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()), vec![])
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty() && std::path::Path::new(s).exists()).unwrap_or_else(|| {
            if cfg!(target_os = "macos") { "/bin/zsh".into() } else if std::path::Path::new("/bin/bash").exists() { "/bin/bash".into() } else { "/bin/sh".into() }
        });
        // a login shell, like Terminal.app, so PATH from the profile is set up
        (shell, vec!["-l".into()])
    }
}

impl LocalPty {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn has(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(id)
    }

    /// Start a shell. `on_data` gets output, `on_exit` the exit code once the shell ends.
    pub fn open(
        self: &Arc<Self>,
        id: &str,
        cols: u16,
        rows: u16,
        on_data: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(Option<u32>) + Send + 'static,
    ) -> Result<String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| anyhow!("could not create a terminal: {e}"))?;
        let (shell, args) = default_shell();
        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(&args);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "TermX");
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| anyhow!("could not start {shell}: {e}"))?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(|e| anyhow!("{e}"))?;
        let writer = pair.master.take_writer().map_err(|e| anyhow!("{e}"))?;
        self.sessions.lock().unwrap().insert(id.to_string(), Session { writer, master: pair.master, killer });

        std::thread::spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_data(buf[..n].to_vec()),
                }
            }
        });
        // Wait for the shell in its own thread: on Windows the reader only ends once the PTY is dropped.
        let this = Arc::downgrade(self);
        let sid = id.to_string();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            if let Some(this) = this.upgrade() {
                this.sessions.lock().unwrap().remove(&sid);
            }
            on_exit(code);
        });
        Ok(shell)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let mut g = self.sessions.lock().unwrap();
        let s = g.get_mut(id).ok_or_else(|| anyhow!("terminal closed"))?;
        s.writer.write_all(data)?;
        s.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(s) = self.sessions.lock().unwrap().get(id) {
            let _ = s.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 });
        }
    }

    pub fn close(&self, id: &str) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(id) {
            let _ = s.killer.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn runs_a_command_in_the_local_shell() {
        let pty = LocalPty::new();
        let out = Arc::new(Mutex::new(Vec::<u8>::new()));
        let exited = Arc::new(Mutex::new(None::<Option<u32>>));
        let (o, e) = (out.clone(), exited.clone());
        pty.open("t", 80, 24, move |b| o.lock().unwrap().extend(b), move |c| *e.lock().unwrap() = Some(c)).unwrap();
        assert!(pty.has("t"));
        std::thread::sleep(Duration::from_millis(500));
        pty.write("t", b"echo termx-$((40+2))\r").unwrap();
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end && !String::from_utf8_lossy(&out.lock().unwrap()).contains("termx-42") {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(String::from_utf8_lossy(&out.lock().unwrap()).contains("termx-42"));
        pty.write("t", b"exit 3\r").unwrap();
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end && exited.lock().unwrap().is_none() {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(*exited.lock().unwrap(), Some(Some(3)));
        assert!(!pty.has("t"));
    }
}
