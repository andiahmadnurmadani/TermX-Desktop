# Security

TermX holds credentials for your servers, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting (repository → *Security* → *Report a vulnerability*) and include:
- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible),
- the TermX version and operating system.

You will get an acknowledgement within 72 hours. Once the issue is confirmed we will agree on a disclosure date with you, and you will be credited in the release notes unless you prefer otherwise.

## Threat model (summary)

| Asset | Protection |
|---|---|
| Saved passwords, private keys, key passphrases | AES-256-GCM with a random 256-bit data key (DEK). Stored in SQLite as ciphertext only. |
| The DEK | **Keychain mode** (default): the DEK is held in the OS keychain. **Master mode**: the DEK is wrapped with a key derived from your master password (Argon2id, 64 MiB, t=3) and kept only in memory while unlocked. |
| Backups | The whole vault is sealed with Argon2id + AES-256-GCM under a separate backup password. |
| Host identity | Host keys are pinned on first use (TOFU), and a changed key blocks the connection until you accept it explicitly. |
| Workflow output | Secret parameters and saved host passwords are replaced with `••••` before output is shown or stored. |

Out of scope: a compromised local OS account, malware running as your user, and physical access to an unlocked machine. In keychain mode, anyone who can read your keychain can decrypt the vault, so use master mode if that matters to you.

Never commit real credentials in issues, logs or test fixtures.
