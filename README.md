# TermX

Free, open-source, local-first infrastructure operations client for macOS, Windows and Linux.
Tauri 2 (Rust) + React + xterm.js. MIT licensed. No account, no cloud, no telemetry.

## Features

- **SSH terminal**: WebGL-rendered tabs, search, clickable links, snippets, tmux persistence, auto-reconnect, jump hosts, password / key / SSH-agent auth.
- **4-pane workspaces**: up to four independent live SSH sessions in a 2×2 grid (or side-by-side / stacked). You can drag the splitters, maximize a pane, and save the layout to reopen later.
- **Workflows**: repeatable multi-step operations across many hosts.
  - Parameters, with secret values masked in output and history.
  - Per-step timeout, accepted exit codes, expected output and continue-on-error.
  - Hosts run in parallel, with a live host × step matrix, cancellation and full run history.
  - Risky commands and production hosts require an explicit confirmation.
- **Overview**: an agentless health snapshot over SSH covering uptime, load, memory, disk and failed systemd units. Nothing is installed on the servers.
- **SFTP**: a file browser with drag & drop, folder upload/download and an inline text editor.
- **Credential vault**: passwords and private keys are encrypted with AES-256-GCM.
  - By default the data key lives in the OS keychain (Keychain / Credential Manager / Secret Service).
  - Optionally, set a **master password** (Argon2id) with auto-lock.
  - **Encrypted backups** export everything, including credentials, under a password you choose.
- **Local storage**: SQLite (WAL, transactional writes, versioned migrations, integrity check on start).
- English and Indonesian UI, dark/light themes, accent colours and terminal themes.

## Develop

Requirements: Rust (stable), Node 20+, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (on Linux: `libwebkit2gtk-4.1-dev`, `libssl-dev`, `librsvg2-dev`).

    npm install
    npx tauri dev

Tests:

    cargo test -p termx-core                     # unit tests (vault, store, crypto, workflows, overview)
    TERMX_HOST=… TERMX_USER=… TERMX_PASS=… \
      cargo test -p termx-core --test live       # against a real sshd: shells, 4 panes, workflows, SFTP
    npm run typecheck

## Build

    npx tauri build            # current OS

GitHub Actions (`.github/workflows/release.yml`) builds macOS (arm64/x64), Linux (deb/AppImage) and Windows (msi/exe).
Builds are unsigned, so on macOS right-click → Open the first time.

## Layout

- `core/`: a GUI-free Rust crate holding the store, vault/crypto, SSH, SFTP, workflow engine and overview.
- `src-tauri/`: Tauri commands and events.
- `src/`: React UI.
- `site/`: the landing page (static generator).
- `docs/ARCHITECTURE.md`: the data model, storage and security design.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
