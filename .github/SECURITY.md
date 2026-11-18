# Security policy

Blockland is played by kids, so we take reports seriously and thank the people who send them.

## Reporting a vulnerability

Report privately, never in a public issue or pull request:

- through GitHub's **Report a vulnerability** button on the [Security tab](https://github.com/dhyegocalota/blockland/security/advisories/new) of this repository, or
- by email to legal@logicbit.com.br with "Blockland security" in the subject.

Include what you found, how to reproduce it and what an attacker could do with it. We answer within three business days, keep you informed while we fix it, and credit you when the fix ships, unless you prefer otherwise.

## Scope

In scope: the code in this repository — the web client, the `/admin` panel and its API routes, and the Rust multiplayer server. Do not access other people's accounts, worlds or chats, do not degrade a running server, and do not use social engineering or physical attacks. Test against a local stack.

## Supported versions

Only the latest commit on `main` receives fixes.
