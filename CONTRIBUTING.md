# Contributing to TermX

Thanks for helping! Bug reports, docs, translations and code are all welcome.

## Getting started

1. Install Rust (stable), Node 20+ and the Tauri 2 prerequisites for your OS.
2. `npm install`, then `npx tauri dev`.
3. Make your change on a branch and open a pull request against `main`.

## Before opening a PR

- `cargo test -p termx-core` passes.
- `npm run typecheck` passes.
- If you touched SSH, SFTP or workflows, also run the live test against a throwaway sshd:
  `TERMX_HOST=127.0.0.1 TERMX_USER=me TERMX_PASS=… cargo test -p termx-core --test live`
- New UI strings go in `src/lib/i18n.ts` for **both** English and Indonesian.
- Schema changes are new numbered migrations in `core/src/store.rs`. Never edit an old one.

## Code layout

- `core/` holds everything that does not need a window, and should stay testable without Tauri.
- `src-tauri/src/lib.rs` contains thin command wrappers only.
- `src/components/` has one file per view.

## Style

- Rust: `cargo fmt`, no `unwrap()` on user data paths.
- TypeScript: match the surrounding code. Keep components small and keep state in `src/lib/store.ts`.
- Commits: present tense, short subject line, with the details in the body.

## Reporting bugs

Use the bug report template. Include the OS, the TermX version, steps to reproduce, and what you expected. **Remove hostnames, usernames and any secrets from logs.**

For security issues, follow [SECURITY.md](SECURITY.md) instead.
