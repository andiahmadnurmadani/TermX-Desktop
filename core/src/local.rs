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

/// A shell the user can pick for a local terminal tab. The first one listed is the default.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ShellInfo {
    pub id: String,
    pub name: String,
    /// "default" | "powershell" | "cmd" | "wsl"
    pub kind: String,
}

/// Distro names from `wsl.exe -l -q`. That output is UTF-16LE (with a BOM); Docker's internal distros are hidden,
/// and anything with spaces is a message ("no installed distributions"), not a name.
pub fn parse_wsl_list(raw: &[u8]) -> Vec<String> {
    let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    let text = String::from_utf16_lossy(&units);
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let name = line.trim().trim_start_matches('\u{feff}').trim();
        if name.is_empty() || name.contains(char::is_whitespace) || name.starts_with('-') || name.starts_with("docker-desktop") {
            continue;
        }
        if !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// Shells available on this computer. On Windows: PowerShell, Command Prompt and every installed WSL distro.
pub fn list_shells() -> Vec<ShellInfo> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let in_path = |exe: &str| {
            std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file()))
        };
        let mut out = Vec::new();
        let mk = |id: &str, name: &str, kind: &str| ShellInfo { id: id.into(), name: name.into(), kind: kind.into() };
        if in_path("pwsh.exe") {
            out.push(mk("pwsh", "PowerShell 7", "powershell"));
        }
        if in_path("powershell.exe") {
            out.push(mk("powershell", "Windows PowerShell", "powershell"));
        }
        out.push(mk("cmd", "Command Prompt", "cmd"));
        if let Ok(o) = std::process::Command::new("wsl.exe").args(["-l", "-q"]).creation_flags(0x0800_0000).output() {
            if o.status.success() {
                for d in parse_wsl_list(&o.stdout) {
                    out.push(ShellInfo { id: format!("wsl:{d}"), name: format!("{d} (WSL)"), kind: "wsl".into() });
                }
            }
        }
        out
    }
    #[cfg(not(windows))]
    {
        let (shell, _) = default_shell();
        let name = std::path::Path::new(&shell).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(shell);
        vec![ShellInfo { id: "default".into(), name, kind: "default".into() }]
    }
}

/// Program and arguments for a shell id from [`list_shells`]; unknown ids fall back to the default shell.
pub fn shell_command(id: Option<&str>) -> (String, Vec<String>) {
    match id {
        #[cfg(windows)]
        Some("pwsh") => ("pwsh.exe".into(), vec!["-NoLogo".into()]),
        #[cfg(windows)]
        Some("powershell") => ("powershell.exe".into(), vec!["-NoLogo".into()]),
        #[cfg(windows)]
        Some("cmd") => (std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()), vec![]),
        Some(w) if w.starts_with("wsl:") && w.len() > 4 && !w[4..].starts_with('-') => {
            ("wsl.exe".into(), vec!["-d".into(), w[4..].to_string(), "--cd".into(), "~".into()])
        }
        _ => default_shell(),
    }
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
        shell_id: Option<&str>,
        on_data: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(Option<u32>) + Send + 'static,
    ) -> Result<String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| anyhow!("could not create a terminal: {e}"))?;
        let (shell, args) = shell_command(shell_id);
        let is_wsl = shell_id.is_some_and(|s| s.starts_with("wsl:"));
        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(&args);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "TermX");
        // WSL starts in the distro's own home (`--cd ~`); a Windows cwd would be mapped to /mnt/c/...
        if !is_wsl {
            if let Some(home) = dirs::home_dir() {
                cmd.cwd(home);
            }
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
    fn parses_wsl_list_output() {
        let text = "\u{feff}Ubuntu-22.04\r\nDebian\r\ndocker-desktop\r\ndocker-desktop-data\r\n\r\nDebian\r\n";
        let raw: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_wsl_list(&raw), vec!["Ubuntu-22.04", "Debian"]);
        let none: Vec<u8> = "Windows Subsystem for Linux has no installed distributions.\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert!(parse_wsl_list(&none).is_empty());
    }

    #[test]
    fn wsl_shell_ids_become_wsl_exe() {
        let (p, a) = shell_command(Some("wsl:Ubuntu"));
        assert_eq!((p.as_str(), a), ("wsl.exe", vec!["-d".to_string(), "Ubuntu".into(), "--cd".into(), "~".into()]));
        assert_eq!(shell_command(Some("wsl:-x")).0, default_shell().0);
        assert_eq!(shell_command(None).0, default_shell().0);
    }

    #[test]
    fn runs_a_command_in_the_local_shell() {
        let pty = LocalPty::new();
        let out = Arc::new(Mutex::new(Vec::<u8>::new()));
        let exited = Arc::new(Mutex::new(None::<Option<u32>>));
        let (o, e) = (out.clone(), exited.clone());
        pty.open("t", 80, 24, None, move |b| o.lock().unwrap().extend(b), move |c| *e.lock().unwrap() = Some(c)).unwrap();
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
