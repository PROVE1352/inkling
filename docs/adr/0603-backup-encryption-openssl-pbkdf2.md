# 0603. Optional encryption with openssl enc AES-256-CBC + PBKDF2 (200k iterations)

- Status: Accepted
- Date: 2026-11-07

## Context
Sets contain every note and the password hashes; they may be copied to third-party storage. Encryption must work with tools already in the image and be decryptable by hand years later.

## Decision
- When `BACKUP_PASSPHRASE` is set, both payload files are encrypted as they are written (`pg_dump | openssl enc …`, `tar | openssl enc …`), so plaintext never touches the backup disk: `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt -pass env:BACKUP_PASSPHRASE`. The passphrase is passed via the environment, never argv.
- Verification decrypts the stored file into `pg_restore --list` / `tar -t`, which also proves the passphrase works.
- `manifest.json` and `SHA256SUMS` stay in clear text (no note content) so sets can be listed and checksummed without the key; the manifest records the exact cipher parameters.
- Downloads from the admin UI are the stored (encrypted) files.
- Docs warn prominently: a lost passphrase means unrecoverable backups; keep it outside the server.

## Alternatives considered
- GnuPG symmetric (`gpg -c`, AES256 + MDC/AEAD): authenticated, also in the image, but its agent/homedir handling is awkward in a non-interactive container and options vary by version.
- age: modern and authenticated, but not in the image (new binary to ship and pin).
- rclone `crypt` remote: only protects the remote copy, not the local volume or downloads.

## Trade-offs
- CBC without a MAC is not tamper-evident by itself; the sha256 in the manifest catches corruption but not an attacker who rewrites the manifest too.
- 200k PBKDF2 iterations add well under a second per file.

## How others solve it
- Discourse / GitLab: no built-in encryption, rely on storage-side encryption.
- Duplicati / restic: AES-256 with authenticated modes and a repository key derived from a password.

## Consequences
- Anyone with openssl can decrypt a set with the passphrase (command in docs/BACKUP.md).

## References
- deploy/backup/lib.sh:52 (`enc_filter`), :53 (`dec_filter`)
- deploy/backup/backup-run.sh:141 (encrypted pg_dump)
