# TermX

Free, modern SSH client for macOS, Windows and Linux. Tauri 2 (Rust) + React + xterm.js.

- SSH terminal tabs (WebGL renderer), search, links, snippets, tmux persistence, auto-reconnect, jump hosts
- SFTP browser with drag & drop upload/download, inline text editor
- Keys: generate Ed25519/RSA, import, install on server
- Passwords and private keys are encrypted (AES-GCM) with a key kept in Keychain / Credential Manager / Secret Service
- English + Indonesian, dark/light, accent color, terminal themes

## Develop
    npm install
    npx tauri dev

## Build
    npx tauri build            # current OS
GitHub Actions (`.github/workflows/release.yml`) builds macOS (arm64/x64), Linux (deb/AppImage) and Windows (msi/exe).
Builds are unsigned: on macOS right-click → Open the first time.

## Layout
- `core/` — GUI-free Rust crate (vault, crypto, SSH, SFTP). `cargo test -p termx-core` (live test needs TERMX_HOST/USER/PASS)
- `src-tauri/` — Tauri commands
- `src/` — React UI
