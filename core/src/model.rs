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
    /// Keys held by the local SSH agent (ssh-agent, Pageant, Windows OpenSSH agent).
    Agent,
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
    /// "" | "development" | "staging" | "production"
    pub environment: String,
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
            environment: String::new(),
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
    #[serde(skip_serializing, default)]
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

/// One interactive terminal session (Logs view): one row per tab/pane, across reconnects.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionLog {
    pub id: String,
    pub host_id: String,
    pub host_label: String,
    pub username: String,
    pub hostname: String,
    pub port: u16,
    pub started_at: i64,
    /// 0 until the first successful connect.
    pub connected_at: i64,
    /// 0 while the session is open.
    pub ended_at: i64,
    /// "connecting" | "connected" | "reconnecting" | "ended" | "failed"
    pub status: String,
    pub message: String,
    pub reconnects: u32,
    pub bytes: u64,
    /// A terminal transcript was recorded for this session.
    pub transcript: bool,
    /// Connection setup steps (connects and reconnects, capped).
    pub events: Vec<LogEvent>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub at: i64,
    pub text: String,
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
    /// Minutes of inactivity before the vault locks (master-password mode only). 0 = never.
    pub auto_lock_min: u32,
    /// App (interface) font: "inter" | "system" | any installed family name.
    pub ui_font: String,
    /// Interface zoom in percent (the whole window, terminals included).
    pub ui_scale: u32,
    pub font_weight: u32,
    pub font_weight_bold: u32,
    pub letter_spacing: f32,
    /// Record terminal transcripts in Logs (connection history is always kept).
    pub session_logs: bool,
    pub overview_live: bool,
    /// Seconds between live Overview refreshes.
    pub overview_interval: u32,
    pub check_updates: bool,
    /// Answer `[sudo] password for …` prompts with the host's password without asking.
    pub sudo_autofill: bool,
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
            auto_lock_min: 15,
            ui_font: "inter".into(),
            ui_scale: 100,
            font_weight: 400,
            font_weight_bold: 700,
            letter_spacing: 0.0,
            session_logs: true,
            overview_live: false,
            overview_interval: 10,
            check_updates: true,
            sudo_autofill: false,
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
    pub workspaces: Vec<Workspace>,
    pub workflows: Vec<WorkflowDef>,
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
            workspaces: vec![],
            workflows: default_workflows(),
        }
    }
}

// ------------------------------------------------------------------ workspaces

/// A saved multi-terminal layout. Only the pane -> host mapping is stored: live sessions are
/// never restored from disk, they are opened fresh when the workspace is opened.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// "1" | "2v" (side by side) | "2h" (stacked) | "4" (2x2)
    pub layout: String,
    /// Split positions as fractions (0.15..0.85): vertical divider, horizontal divider.
    pub col_split: f32,
    pub row_split: f32,
    /// Exactly four slots; `None` = empty pane.
    pub panes: Vec<Option<String>>,
    pub created_at: i64,
}
impl Default for Workspace {
    fn default() -> Self {
        Workspace {
            id: new_id(),
            name: String::new(),
            layout: "4".into(),
            col_split: 0.5,
            row_split: 0.5,
            panes: vec![None, None, None, None],
            created_at: now_ms(),
        }
    }
}

// ------------------------------------------------------------------ workflows

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkflowParam {
    /// Referenced in commands as {{name}}.
    pub name: String,
    pub label: String,
    pub default: String,
    /// Masked in history and output.
    pub secret: bool,
}
impl Default for WorkflowParam {
    fn default() -> Self {
        WorkflowParam { name: String::new(), label: String::new(), default: String::new(), secret: false }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkflowStep {
    pub id: String,
    pub name: String,
    pub command: String,
    pub timeout_sec: u32,
    /// Exit codes that count as success. Empty = only 0.
    pub ok_exit: Vec<u32>,
    /// Optional extra success condition: stdout must contain this text.
    pub expect_output: String,
    /// Keep running the next steps on this host when this one fails.
    pub continue_on_error: bool,
}
impl Default for WorkflowStep {
    fn default() -> Self {
        WorkflowStep {
            id: new_id(),
            name: String::new(),
            command: String::new(),
            timeout_sec: 60,
            ok_exit: vec![],
            expect_output: String::new(),
            continue_on_error: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkflowDef {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Default targets; can be changed per run.
    pub host_ids: Vec<String>,
    pub params: Vec<WorkflowParam>,
    pub steps: Vec<WorkflowStep>,
    /// How many hosts run at the same time.
    pub parallel: u32,
    pub created_at: i64,
}
impl Default for WorkflowDef {
    fn default() -> Self {
        WorkflowDef {
            id: new_id(),
            name: String::new(),
            description: String::new(),
            host_ids: vec![],
            params: vec![],
            steps: vec![],
            parallel: 4,
            created_at: now_ms(),
        }
    }
}

/// One execution of a workflow (history row).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub host_ids: Vec<String>,
    /// Parameter values with secrets masked.
    pub params: Vec<(String, String)>,
    pub started_at: i64,
    pub finished_at: i64,
    /// running | ok | failed | cancelled
    pub status: String,
    pub steps: Vec<StepRun>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StepRun {
    pub host_id: String,
    pub host_label: String,
    pub idx: u32,
    pub name: String,
    /// Rendered command with secrets masked.
    pub command: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub exit_code: Option<u32>,
    /// pending | running | ok | failed | skipped | cancelled | timeout
    pub status: String,
    pub stdout: String,
    pub stderr: String,
    pub error: String,
}

pub fn default_workflows() -> Vec<WorkflowDef> {
    let step = |name: &str, command: &str, timeout_sec: u32| WorkflowStep {
        name: name.into(),
        command: command.into(),
        timeout_sec,
        continue_on_error: true,
        ..Default::default()
    };
    vec![
        WorkflowDef {
            name: "Health check".into(),
            description: "Uptime, memory, disk and failed services".into(),
            steps: vec![
                step("Uptime", "uptime", 20),
                step("Memory", "free -h 2>/dev/null || vm_stat", 20),
                step("Disk", "df -hP -x tmpfs -x devtmpfs 2>/dev/null || df -h", 30),
                step("Failed services", "systemctl --failed --no-legend --no-pager 2>/dev/null || echo 'systemd not available'", 30),
            ],
            ..Default::default()
        },
        WorkflowDef {
            name: "Service status".into(),
            description: "Status and recent log lines of one systemd service".into(),
            params: vec![WorkflowParam { name: "service".into(), label: "Service".into(), default: "nginx".into(), secret: false }],
            steps: vec![
                WorkflowStep { name: "Status".into(), command: "systemctl is-active {{service}}".into(), timeout_sec: 20, ..Default::default() },
                step("Recent logs", "journalctl -u {{service}} -n 50 --no-pager", 30),
            ],
            ..Default::default()
        },
    ]
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
