# Security policy

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private reporting: **Security → Report a vulnerability** on the repository page. Include steps to reproduce and the affected version. We aim to acknowledge reports within a few days and to ship a fix quickly.

## Threat model

Plainnote is a single-user, local app:

- The server listens on `127.0.0.1` only and rejects requests whose `Host` is not localhost (DNS rebinding) or whose `Origin` is another site (CSRF).
- Note paths are confined to the notes folder; only image files are served from it, with SVG sandboxed.
- Git sync remotes are limited to `https://`, `ssh://` and `git@host:path` URLs.
- There is no authentication: anyone with access to your machine's loopback port can read your notes. Don't expose the port.
- Notes are not encrypted at rest.

Reports that break any of the guarantees above are in scope.
