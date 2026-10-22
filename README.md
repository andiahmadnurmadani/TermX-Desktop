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
- **Overview**: an agentless health snapshot over SSH covering uptime, CPU, load, memory, disk and failed systemd units. Nothing is installed on the servers. Switch to **Live** to refresh every 5 s – 1 min with CPU sparklines.
- **Logs**: every terminal session is listed with host, start time, duration, data transferred, reconnects and errors. Optionally, the terminal output is recorded so you can replay, search and export it (`.txt` / `.log`).
- **Connection log**: while connecting, every step is shown live (DNS, TCP, host key, authentication method, PTY, shell), like Termius. Failed connects keep the log so you can see where it stopped; it is also saved with the session in Logs.
- **sudo password fill**: when a terminal shows `[sudo] password for …`, one click types the password saved for that host (it never passes through the web UI). Optionally fill it automatically, once per prompt.
- **Hosts with OS icons**: the remote OS is detected on first connect (Ubuntu, Debian, macOS, Windows, Fedora, Alpine, Raspberry Pi OS, …) including NAS, hypervisor and router platforms: Synology DSM, QNAP, TrueNAS, Unraid, openmediavault, Proxmox VE, VMware ESXi, pfSense, OPNsense, Ubiquiti.
- **Personalisation**: app font, interface size (90–150 %), terminal font, weight, letter spacing, line height, cursor, themes and accent colour.
- **Auto-update**: TermX checks GitHub Releases on start and installs signed updates in place with one click.
- **AI assistant** (`Ctrl/⌘+J`): describe what you want and the assistant types and runs the commands in your terminal while you watch.
  - It knows your hosts, groups, open sessions, the visible screen, snippets and workflows, so you can say "check disk on the NAS".
  - Providers: Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, any OpenAI-compatible endpoint, and local models via Ollama or LM Studio.
  - Every command is typed into a visible terminal, marked "TermX AI is typing", with a Stop button.
  - Approval modes: ask for every command, auto-run read-only commands, run everything (production still asks), or **always allow** (no confirmations; only disk- or system-wiping commands still ask).
  - Extra care on production hosts: read-only first, impact and rollback stated before changes, heavy scans need approval.
  - Prompt templates (health check, slow server, disk cleanup, security audit, containers, web server, …), your own saved templates, and custom instructions.
  - The panel is resizable (drag its edge).
  - API keys are encrypted in the local vault and never leave the app except to the provider you chose.
- **Command autocomplete**: suggestions from that host's history, your snippets and common commands while you type (↑↓, Tab/Enter, Esc), like Termius. History is stored encrypted.
- **Custom title bar** on Windows and Linux that follows the app theme.
- **Local terminal** (`Ctrl/⌘+L`): your own shell (zsh / bash / PowerShell) in a tab, next to your SSH sessions. On Windows the button offers PowerShell, Command Prompt and every installed **WSL** distribution (Ubuntu, Debian, …), each opening in its own home directory.
- **SFTP**: a file browser with drag & drop, folder upload/download and an inline text editor.
  - Works on NAS boxes too. If the SFTP subsystem is off, TermX falls back to `sftp-server` when available; otherwise it says how to turn SFTP on (Synology: Control Panel → File Services → FTP → SFTP; QNAP: Network & File Services → Telnet/SSH → Enable SFTP) instead of hanging until a timeout.
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
Builds are not notarized (no paid Apple Developer ID). On macOS the app is ad-hoc signed; the first time:

1. Drag **TermX** to Applications and open it. If macOS says it "can't be opened" or "is damaged",
2. open **System Settings → Privacy & Security** and click **Open Anyway**, or run once in Terminal:
   `xattr -dr com.apple.quarantine /Applications/TermX.app`

After that it opens normally and updates itself in place.

## Layout

- `core/`: a GUI-free Rust crate holding the store, vault/crypto, SSH, SFTP, workflow engine and overview.
- `src-tauri/`: Tauri commands and events.
- `src/`: React UI.
- `site/`: the landing page (static generator).
- `docs/ARCHITECTURE.md`: the data model, storage and security design.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
