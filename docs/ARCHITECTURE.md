# TermX architecture

```
┌──────────────── React UI (src/) ────────────────┐
│ Hosts · Workspaces (2×2 grid) · Workflows · Run │
│ Overview · Keys · Snippets · Settings · SFTP    │
└───────────── invoke() / events ─────────────────┘
┌──────────── src-tauri (thin commands) ──────────┐
└─────────────────────────────────────────────────┘
┌──────────────── termx-core (core/) ─────────────┐
│ store     SQLite, migrations, in-memory snapshot│
│ secrets   DEK, keychain / master password       │
│ backup    sealed export / merge restore         │
│ ssh       russh sessions, exec, exec_stream     │
│ sftp      transfers, editor                     │
│ workflow  engine, preview, masking              │
│ overview  agentless POSIX probe + parser        │
│ logs      session history + transcripts         │
└─────────────────────────────────────────────────┘
```

## Storage

`termx.db` lives in the app data directory (macOS: `~/Library/Application Support/com.kroombox.termx`).

- WAL journal, `synchronous=NORMAL`, foreign keys on, and a `quick_check` at start. A corrupt database is moved aside as `termx.db.bad-<ts>` and a fresh one is created.
- Migrations are numbered and tracked with `PRAGMA user_version`. A pre-SQLite `vault.json` is imported once and renamed to `vault.json.migrated`.
- The store keeps an in-memory snapshot. `update()` clones it, applies the change, writes all affected tables in **one transaction**, and only then adopts the new state, so a failed write never leaves the UI and the disk out of sync.
- Tables:
  - Configuration: `ssh_hosts`, `host_groups`, `ssh_keys`, `snippets`, `settings`, `meta`.
  - Secrets: `vault_secrets` (owner, field, ciphertext).
  - Host keys: `host_key_pins`.
  - Workspaces: `workspaces`, `workspace_panes`.
  - Workflows: `workflow_definitions`, `workflow_steps`, `workflow_runs`, `workflow_step_runs` (the last 300 runs are kept).
  - Session history: `session_logs` (the last 1000 sessions are kept); transcripts are raw files in `logs/<id>.log` (0600, capped at 20 MB each).
  - `sync_objects` is reserved for future peer-to-peer sync.

## Vault

- All secrets are encrypted with AES-256-GCM using a random 32-byte DEK.
- **Keychain mode** (default): the DEK is held in the OS keychain (service `termx`).
- **Master mode**: the DEK is wrapped with Argon2id(master password, 64 MiB, t=3, p=1) and stored in `meta.vault.wrapped`. On start the vault is locked; unlocking keeps the DEK in zeroizing memory, and locking (manual or auto-lock) wipes it. Switching modes or changing the password only rewraps the DEK, so the data itself is not re-encrypted.
- While locked, connections that need stored credentials fail with a clear error, and agent auth still works.
- Backups use the same sealing (`termx-backup` v1: Argon2id + AES-GCM) under a separate password. Restore merges by id.

## Sessions and workspaces

- Every terminal, whether it is a tab or a grid pane, is an independent `open_shell` session keyed by its own id. One SSH connection per host is shared and reused across sessions, so four panes on one host open four channels over one TCP connection.
- A grid tab keeps all four panes mounted. Changing the layout or maximizing only hides panes, so their sessions stay alive. Closing a pane closes only that session.
- Saved workspaces store the layout, split ratios and the host per pane. Opening one starts fresh sessions; commands are never replayed.

## Workflows

- **Definition**: a name, parameters (with secret flags), steps (command, timeout, accepted exit codes, expected output, continue-on-error), default hosts, and a parallelism setting.
- **Rendering**: `{{param}}` is replaced by its value, shell-quoted. Unknown parameters are an error.
- **Preview**:
  - lists target hosts with their environment and flags risky commands with a heuristic list (`rm -rf`, `mkfs`, `dd of=`, shutdown, `DROP`, …);
  - `needs_confirm` is set when any target is production or any step is risky;
  - the engine enforces the confirmation server-side as well.
- **Execution**:
  - hosts run under a semaphore (`parallel`), and steps on a host run sequentially;
  - each step is an `exec_stream` with a timeout and a `CancellationToken`; on timeout or cancel the remote process gets SIGTERM and the channel is closed;
  - a failed step stops the host unless continue-on-error is set, and the remaining steps are marked `skipped`.
- **Output**: capped at 256 KB per step, and secret values are masked before they are emitted or stored. Runs left `running` after a crash are marked `interrupted` on the next start.

## Overview

A single read-only POSIX script runs via `sh -s`. It reads procfs on Linux and sysctl/vm_stat on macOS/BSD, prints `key=value` lines, and `overview::parse` turns them into numbers. CPU % comes from two `/proc/stat` samples 0.5 s apart (or `ps` on macOS). Nothing is installed on the server. Live mode re-runs the probe on an interval over the already-open connection and skips hosts whose last probe failed, so it never re-prompts for passwords.

## Logs

`logs::LoggingSink` wraps the UI sink of every shell session. It writes one `session_logs` row per session (status, connect/end time, reconnects, bytes) on each state change, and, when *Record terminal output* is on, appends the raw server output to `logs/<id>.log`. Transcripts are not encrypted; turning recording off only stops new recordings.

## Updates

Releases are built by CI (`tauri-action`) with `createUpdaterArtifacts`, signed with the updater key (`TAURI_SIGNING_PRIVATE_KEY` secret) and published with a `latest.json`. The app checks `releases/latest/download/latest.json`, verifies the signature with the public key in `tauri.conf.json`, installs and relaunches.
