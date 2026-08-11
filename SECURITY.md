# Security policy

This tool holds database credentials and opens connections to production systems, so
security issues here matter more than the project's size suggests.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability reporting:

> Repository → **Security** tab → **Report a vulnerability**

That opens a private thread visible only to the maintainer. Include what you did, what
happened, and what an attacker gains. A proof of concept helps but is not required.

Expect an acknowledgement within a few days. This is a personal project with no paid
support, so please be patient — and if a fix is slow, you are still welcome to disclose
publicly after a reasonable period.

## What is in scope

The parts most worth attacking:

- **The browser-facing surface.** Any website you visit can issue requests to
  `127.0.0.1:3456`. Defence is a session cookie that is `HttpOnly` and `SameSite=Strict`,
  plus a Host and Origin allow-list. A bypass of either is a real finding.
- **Cross-account isolation.** Connections are private to the account that created them.
  Knowing another account's connection id must not grant access to anything — including
  through indirect paths like the schema cache. `tests/e2e/user-isolation.mjs` sweeps every
  connection-taking endpoint for this.
- **Credential handling.** Connection passwords are encrypted with AES-256-GCM under a key
  derived from the account password, held in process memory only and never written to disk.
  No password is ever sent back to the browser. Anything that causes a plaintext credential
  to reach disk, a log, or an HTTP response is a vulnerability.
- **SQL injection in generated statements.** The app writes DDL and data-modifying SQL from
  user input. Identifier quoting and value escaping are the boundary.
- **Path traversal** in the SQLite file browser and export picker, which are rooted at
  configured directories and must not escape them.

## What is not in scope

- Anything requiring an attacker to already have your account password.
- Exposing the app to a network on purpose. Both compose files publish on `127.0.0.1` for
  a reason; if you rebind to `0.0.0.0` and put it on the internet, that is a configuration
  choice, not a bug.
- Denial of service through deliberately expensive queries. The tool runs the queries you
  give it.
- Vulnerabilities in the database servers themselves.

## Supported versions

Only the latest commit on `main` is supported. There are no maintained release branches yet.
