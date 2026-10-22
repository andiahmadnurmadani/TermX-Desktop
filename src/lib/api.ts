import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface Host {
  id: string; label: string; hostname: string; port: number; username: string;
  auth: "password" | "key" | "agent"; hasPassword?: boolean; keyId: string | null; groupId: string | null;
  tags: string[]; environment: Env; color: number; tmux: boolean; tmuxName: string; jumpHostId: string | null;
  startupCommand: string; keepaliveSec: number; autoReconnect: boolean; notes: string;
  osId: string | null; osName: string | null; createdAt: number; lastConnectedAt: number;
}
export type Env = "" | "development" | "staging" | "production";
export interface Group { id: string; name: string; color: number }
export interface SshKey { id: string; name: string; kind: string; publicKey: string; fingerprint: string; createdAt: number; installedOn: string[] }
export interface Snippet { id: string; name: string; command: string; description: string; autoRun: boolean }
export interface KnownHost { hostPort: string; keyType: string; fingerprint: string; addedAt: number }
export interface Settings {
  appearance: "system" | "dark" | "light"; terminalTheme: string; fontFamily: string; fontSize: number;
  lineHeight: number; scrollback: number; cursorStyle: "block" | "bar" | "underline"; cursorBlink: boolean;
  copyOnSelect: boolean; language: "en" | "id"; accent: string; autoLockMin: number;
  uiFont: string; uiScale: number; fontWeight: number; fontWeightBold: number; letterSpacing: number;
  sessionLogs: boolean; overviewLive: boolean; overviewInterval: number; checkUpdates: boolean;
  sudoAutofill: boolean;
  autocomplete: boolean;
  ai: AiSettings;
}
export interface AiSettings {
  provider: string; models: Record<string, string>; baseUrls: Record<string, string>;
  approval: "ask" | "safe" | "auto" | "always"; shareScreen: boolean;
  /** where the AI's commands run: typed into the visible terminal, or a hidden SSH exec shown only in the chat */
  runMode: "terminal" | "background";
  /** context budget in tokens (0 = automatic) and what to do when the chat nears it */
  contextLimit: number; contextMode: "compact" | "trim" | "off";
  instructions: string; templates: AiTemplate[];
}
export interface AiTemplate { id: string; name: string; prompt: string }
export type AiPart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };
export interface AiMsg { role: "user" | "assistant"; content: AiPart[] }
export interface AiTool { name: string; description: string; parameters: Record<string, unknown> }
export interface AiChatReq { api: "anthropic" | "openai"; baseUrl: string; model: string; system: string; messages: AiMsg[]; tools: AiTool[]; maxTokens?: number }
export interface AiChatResp { content: AiPart[]; stopReason: string; inputTokens: number; outputTokens: number }
export interface SessionLog {
  id: string; hostId: string; hostLabel: string; username: string; hostname: string; port: number;
  startedAt: number; connectedAt: number; endedAt: number; status: SessionState; message: string;
  reconnects: number; bytes: number; transcript: boolean; events: LogEvent[];
}
export interface LogEvent { at: number; text: string }
export type Layout = "1" | "2v" | "2h" | "4";
export interface Workspace { id: string; name: string; layout: Layout; colSplit: number; rowSplit: number; panes: (string | null)[]; createdAt: number }
export interface WorkflowParam { name: string; label: string; default: string; secret: boolean }
export interface WorkflowStep { id: string; name: string; command: string; timeoutSec: number; okExit: number[]; expectOutput: string; continueOnError: boolean }
export interface WorkflowDef { id: string; name: string; description: string; hostIds: string[]; params: WorkflowParam[]; steps: WorkflowStep[]; parallel: number; createdAt: number }
export type StepStatus = "pending" | "running" | "ok" | "failed" | "skipped" | "cancelled" | "timeout";
export interface StepRun {
  hostId: string; hostLabel: string; idx: number; name: string; command: string; startedAt: number; finishedAt: number;
  exitCode: number | null; status: StepStatus; stdout: string; stderr: string; error: string;
}
export interface WorkflowRun {
  id: string; workflowId: string; workflowName: string; hostIds: string[]; params: [string, string][];
  startedAt: number; finishedAt: number; status: "running" | "ok" | "failed" | "cancelled"; steps: StepRun[];
}
export interface Preview {
  hosts: { id: string; label: string; environment: Env }[]; steps: { name: string; command: string; risks: string[] }[];
  productionHosts: string[]; needsConfirm: boolean;
}
export interface WfEvent { runId: string; kind: "step" | "output" | "run"; hostId: string; idx: number; status: string; stream: "out" | "err" | ""; chunk: string; exitCode: number | null }
export interface Overview {
  os: string | null; kernel: string | null; uptimeSec: number | null; load: [number, number, number] | null; cpus: number | null; cpuPct: number | null;
  memTotalKb: number | null; memAvailKb: number | null; diskTotalKb: number | null; diskUsedKb: number | null; failedUnits: number | null;
}
export interface VaultStatus { mode: "keychain" | "master"; locked: boolean }
export interface Vault {
  hosts: Host[]; groups: Group[]; keys: SshKey[]; snippets: Snippet[]; knownHosts: KnownHost[]; settings: Settings;
  workspaces: Workspace[]; workflows: WorkflowDef[]; status: VaultStatus;
}
export interface FileEntry { name: string; path: string; isDir: boolean; isLink: boolean; size: number; mtime: number; mode: number }
export interface ShellInfo { id: string; name: string; kind: "default" | "powershell" | "cmd" | "wsl" }
export interface AppInfo { version: string; os: string; dataDir: string }
export interface ExecOut { stdout: string; stderr: string; exit: number | null }

export type SessionState = "connecting" | "connected" | "reconnecting" | "ended" | "failed";

export const api = {
  vault: () => invoke<Vault>("vault_get"),
  hostSave: (host: Partial<Host>, password?: string | null) => invoke<string>("host_save", { host, password: password ?? null }),
  hostDelete: (id: string) => invoke<void>("host_delete", { id }),
  groupSave: (group: Group) => invoke<void>("group_save", { group }),
  groupDelete: (id: string) => invoke<void>("group_delete", { id }),
  snippetSave: (snippet: Snippet) => invoke<void>("snippet_save", { snippet }),
  snippetDelete: (id: string) => invoke<void>("snippet_delete", { id }),
  settingsSave: (settings: Settings) => invoke<void>("settings_save", { settings }),
  knownHostDelete: (hostPort: string) => invoke<void>("known_host_delete", { hostPort }),
  keyGenerate: (name: string, kind: string, comment: string) => invoke<SshKey>("key_generate", { name, kind, comment }),
  keyImport: (name: string, text: string, passphrase?: string) => invoke<SshKey>("key_import", { name, text, passphrase: passphrase ?? null }),
  keyDelete: (id: string) => invoke<void>("key_delete", { id }),
  keyInstall: (keyId: string, hostId: string) => invoke<void>("key_install", { keyId, hostId }),
  sshOpen: (sessionId: string, hostId: string, cols: number, rows: number, data: Channel<ArrayBuffer>) =>
    invoke<void>("ssh_open", { sessionId, hostId, cols, rows, data }),
  localOpen: (sessionId: string, cols: number, rows: number, shell: string | null, data: Channel<ArrayBuffer>) => invoke<string>("local_open", { sessionId, cols, rows, shell, data }),
  localShells: () => invoke<ShellInfo[]>("local_shells"),
  sshWrite: (sessionId: string, data: string) => invoke<void>("ssh_write", { sessionId, data }),
  sshFillPassword: (sessionId: string) => invoke<void>("ssh_fill_password", { sessionId }),
  sshResize: (sessionId: string, cols: number, rows: number) => invoke<void>("ssh_resize", { sessionId, cols, rows }),
  sshReconnect: (sessionId: string) => invoke<void>("ssh_reconnect", { sessionId }),
  sshClose: (sessionId: string) => invoke<void>("ssh_close", { sessionId }),
  sshExec: (hostId: string, command: string) => invoke<ExecOut>("ssh_exec", { hostId, command }),
  sftpHome: (hostId: string) => invoke<string>("sftp_home", { hostId }),
  sftpList: (hostId: string, path: string) => invoke<FileEntry[]>("sftp_list", { hostId, path }),
  sftpMkdir: (hostId: string, path: string) => invoke<void>("sftp_mkdir", { hostId, path }),
  sftpRename: (hostId: string, from: string, to: string) => invoke<void>("sftp_rename", { hostId, from, to }),
  sftpRemove: (hostId: string, path: string, isDir: boolean) => invoke<void>("sftp_remove", { hostId, path, isDir }),
  sftpReadText: (hostId: string, path: string) => invoke<string>("sftp_read_text", { hostId, path }),
  sftpWriteText: (hostId: string, path: string, text: string) => invoke<void>("sftp_write_text", { hostId, path, text }),
  sftpCancel: (transferId: string) => invoke<void>("sftp_cancel", { transferId }),
  sftpDownload: (hostId: string, remote: string, isDir: boolean, local: string, transferId: string) =>
    invoke<void>("sftp_download", { hostId, remote, isDir, local, transferId }),
  sftpUpload: (hostId: string, local: string, remote: string, transferId: string) =>
    invoke<void>("sftp_upload", { hostId, local, remote, transferId }),
  appInfo: () => invoke<AppInfo>("app_info"),
  fileReadText: (path: string) => invoke<string>("file_read_text", { path }),
  configExport: (path: string) => invoke<void>("config_export", { path }),
  configImport: (path: string) => invoke<number>("config_import", { path }),
  answerPrompt: (id: string, value: unknown) => invoke<void>("answer_prompt", { id, value }),
  vaultUnlock: (password: string) => invoke<void>("vault_unlock", { password }),
  vaultLock: () => invoke<void>("vault_lock"),
  /** keychain->master: (null, new); change: (old, new); master->keychain: (old, null) */
  vaultSetMaster: (current: string | null, password: string | null) => invoke<void>("vault_set_master", { current, password }),
  backupExport: (path: string, password: string) => invoke<void>("backup_export", { path, password }),
  backupImport: (path: string, password: string) => invoke<{ hosts: number; keys: number; workspaces: number; workflows: number }>("backup_import", { path, password }),
  workspaceSave: (workspace: Workspace) => invoke<void>("workspace_save", { workspace }),
  workspaceDelete: (id: string) => invoke<void>("workspace_delete", { id }),
  workflowSave: (workflow: WorkflowDef) => invoke<void>("workflow_save", { workflow }),
  workflowDelete: (id: string) => invoke<void>("workflow_delete", { id }),
  workflowPreview: (workflow: WorkflowDef, hostIds: string[], params: Record<string, string>) => invoke<Preview>("workflow_preview", { workflow, hostIds, params }),
  workflowRun: (workflow: WorkflowDef, hostIds: string[], params: Record<string, string>, confirmed: boolean) =>
    invoke<string>("workflow_run", { workflow, hostIds, params, confirmed }),
  workflowCancel: (runId: string) => invoke<void>("workflow_cancel", { runId }),
  workflowRuns: (workflowId: string | null) => invoke<WorkflowRun[]>("workflow_runs", { workflowId }),
  workflowRunGet: (id: string) => invoke<WorkflowRun | null>("workflow_run_get", { id }),
  workflowRunsClear: (workflowId: string | null) => invoke<void>("workflow_runs_clear", { workflowId }),
  hostOverview: (hostId: string) => invoke<Overview>("host_overview", { hostId }),
  aiKeySet: (provider: string, key: string | null) => invoke<void>("ai_key_set", { provider, key }),
  aiKeyList: (providers: string[]) => invoke<string[]>("ai_key_list", { providers }),
  historyLoad: () => invoke<string>("history_load"),
  historySave: (data: string) => invoke<void>("history_save", { data }),
  aiSessionsLoad: () => invoke<string>("ai_sessions_load"),
  aiSessionsSave: (data: string) => invoke<void>("ai_sessions_save", { data }),
  aiChat: (reqId: string, provider: string, req: AiChatReq) => invoke<AiChatResp>("ai_chat", { reqId, provider, req }),
  aiCancel: (reqId: string) => invoke<void>("ai_cancel", { reqId }),
  aiModels: (provider: string, api: string, baseUrl: string) => invoke<string[]>("ai_models", { provider, api, baseUrl }),
  logsList: () => invoke<SessionLog[]>("logs_list"),
  logsDelete: (id: string | null) => invoke<void>("logs_delete", { id }),
  logTranscript: (id: string) => invoke<ArrayBuffer>("log_transcript", { id }),
  logExport: (id: string, path: string, plain: boolean) => invoke<void>("log_export", { id, path, plain }),
};

export const events = {
  on: <T>(name: string, cb: (payload: T) => void): Promise<UnlistenFn> => listen<T>(name, (e) => cb(e.payload)),
};

export { Channel };
export const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
