import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface Host {
  id: string; label: string; hostname: string; port: number; username: string;
  auth: "password" | "key"; hasPassword?: boolean; keyId: string | null; groupId: string | null;
  tags: string[]; color: number; tmux: boolean; tmuxName: string; jumpHostId: string | null;
  startupCommand: string; keepaliveSec: number; autoReconnect: boolean; notes: string;
  osId: string | null; osName: string | null; createdAt: number; lastConnectedAt: number;
}
export interface Group { id: string; name: string; color: number }
export interface SshKey { id: string; name: string; kind: string; publicKey: string; fingerprint: string; createdAt: number; installedOn: string[] }
export interface Snippet { id: string; name: string; command: string; description: string; autoRun: boolean }
export interface KnownHost { hostPort: string; keyType: string; fingerprint: string; addedAt: number }
export interface Settings {
  appearance: "system" | "dark" | "light"; terminalTheme: string; fontFamily: string; fontSize: number;
  lineHeight: number; scrollback: number; cursorStyle: "block" | "bar" | "underline"; cursorBlink: boolean;
  copyOnSelect: boolean; language: "en" | "id"; accent: string;
}
export interface Vault { hosts: Host[]; groups: Group[]; keys: SshKey[]; snippets: Snippet[]; knownHosts: KnownHost[]; settings: Settings }
export interface FileEntry { name: string; path: string; isDir: boolean; isLink: boolean; size: number; mtime: number; mode: number }
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
  sshWrite: (sessionId: string, data: string) => invoke<void>("ssh_write", { sessionId, data }),
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
};

export const events = {
  on: <T>(name: string, cb: (payload: T) => void): Promise<UnlistenFn> => listen<T>(name, (e) => cb(e.payload)),
};

export { Channel };
export const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
