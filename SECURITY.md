# Security

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately through GitHub's [private vulnerability reporting](https://github.com/nikhil-kunapareddy/gavia/security/advisories/new). Only the maintainers can see it.

Say what you found, how to reproduce it, and what an attacker could do with it. We'll acknowledge the report within a week, keep you updated as we fix it, and credit you in the release notes if you'd like.

## Supported versions

Only the latest release gets security fixes.

## What Gavia does to stay safe

Gavia works entirely offline, but it still opens files that come from other people, so:

- **Formats are checked from the file's own bytes,** not its name or type.
- **Images are size-checked before any pixels are decoded.** Anything over 120 megapixels or 20 MB is refused, so a small file claiming to be enormous can't exhaust memory.
- **Nothing a user supplies ever becomes a file path.** Saved files are named by an id Gavia generates, and ids are restricted to letters, digits, `-` and `_`.
- **There's no network surface.** The interface talks to the core through Tauri's in-process IPC. There's no local server or open port for another program to reach, and Gavia makes no network connections.
- **Rust code forbids `unsafe`,** and CI runs `cargo audit` and `npm audit` on every change.
