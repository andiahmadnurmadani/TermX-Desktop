//! Persistent data model. Serialised as camelCase JSON, shared with the frontend.
use serde::{Deserialize, Serialize};

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    #[default]
    Password,
    Key,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Host {
    pub id: String,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthType,
    /// Encrypted password (never sent to the UI).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_enc: Option<String>,
    pub key_id: Option<String>,
    pub group_id: Option<String>,
    pub tags: Vec<String>,
    pub color: u8,
    /// Run the shell inside tmux so it survives disconnects.
    pub tmux: bool,
    pub tmux_name: String,
    pub jump_host_id: Option<String>,
    pub startup_command: String,
    pub keepalive_sec: u32,
    pub auto_reconnect: bool,
    pub notes: String,
    pub os_id: Option<String>,
    pub os_name: Option<String>,
    pub created_at: i64,
    pub last_connected_at: i64,
}

impl Default for Host {
    fn default() -> Self {
        Host {
            id: new_id(),
            label: String::new(),
            hostname: String::new(),
            port: 22,
            username: String::new(),
            auth: AuthType::Password,
            password_enc: None,
            key_id: None,
            group_id: None,
            tags: vec![],
            color: 0,
            tmux: false,
            tmux_name: "termx".into(),
            jump_host_id: None,
            startup_command: String::new(),
            keepalive_sec: 20,
            auto_reconnect: true,
            notes: String::new(),
            os_id: None,
            os_name: None,
            created_at: now_ms(),
            last_connected_at: 0,
        }
    }
}

/// What the UI sees: the host plus a flag instead of the secret.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    #[serde(flatten)]
    pub host: Host,
    pub has_password: bool,
}

impl From<&Host> for HostView {
    fn from(h: &Host) -> Self {
        let mut host = h.clone();
        let has_password = host.password_enc.take().is_some();
        HostView { host, has_password }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: u8,
}
impl Default for Group {
    fn default() -> Self {
        Group { id: new_id(), name: String::new(), color: 1 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyRec {
    pub id: String,
    pub name: String,
    /// "ed25519", "rsa", ...
    pub kind: String,
    pub public_key: String,
    #[serde(skip_serializing, default)]
    pub private_enc: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub passphrase_enc: Option<String>,
    pub fingerprint: String,
    pub created_at: i64,
    /// Host ids where this public key is known to be installed.
    #[serde(default)]
    pub installed_on: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: String,
    pub auto_run: bool,
}
impl Default for Snippet {
    fn default() -> Self {
        Snippet { id: new_id(), name: String::new(), command: String::new(), description: String::new(), auto_run: true }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    /// "host:port"
    pub host_port: String,
    pub key_type: String,
    pub fingerprint: String,
    pub added_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "system" | "dark" | "light"
    pub appearance: String,
    pub terminal_theme: String,
    pub font_family: String,
    pub font_size: u32,
    pub line_height: f32,
    pub scrollback: u32,
    /// "block" | "bar" | "underline"
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub copy_on_select: bool,
    /// "en" | "id"
    pub language: String,
    pub accent: String,
}
impl Default for Settings {
    fn default() -> Self {
        Settings {
            appearance: "system".into(),
            terminal_theme: "termx".into(),
            font_family: "JetBrains Mono".into(),
            font_size: 13,
            line_height: 1.2,
            scrollback: 10000,
            cursor_style: "bar".into(),
            cursor_blink: true,
            copy_on_select: true,
            language: "en".into(),
            accent: "#3ddc97".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Vault {
    pub version: u32,
    pub hosts: Vec<Host>,
    pub groups: Vec<Group>,
    pub keys: Vec<SshKeyRec>,
    pub snippets: Vec<Snippet>,
    pub known_hosts: Vec<KnownHost>,
    pub settings: Settings,
}
impl Default for Vault {
    fn default() -> Self {
        Vault {
            version: 1,
            hosts: vec![],
            groups: vec![],
            keys: vec![],
            snippets: default_snippets(),
            known_hosts: vec![],
            settings: Settings::default(),
        }
    }
}

pub fn default_snippets() -> Vec<Snippet> {
    let s = |name: &str, command: &str, description: &str, auto_run: bool| Snippet {
        id: new_id(),
        name: name.into(),
        command: command.into(),
        description: description.into(),
        auto_run,
    };
    vec![
        s("System info", "uname -a && uptime && free -h && df -h /", "Host summary", true),
        s("Docker containers", "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'", "Running containers", true),
        s("Docker logs", "docker logs --tail 100 -f ", "Type the container name, then Enter", false),
        s("tmux sessions", "tmux ls", "List tmux sessions on the server", true),
        s("Top processes", "ps aux --sort=-%cpu | head -15", "15 processes with the highest CPU", true),
        s("System log", "journalctl -n 100 --no-pager", "Last 100 log lines", true),
    ]
}
