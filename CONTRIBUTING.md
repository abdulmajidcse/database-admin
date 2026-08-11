# Contributing

Thanks for taking an interest. This is a small project, so the process is light — but the
notes below cover the things that are genuinely easy to get wrong here.

## Getting a working copy

You need Docker and nothing else. Node is not required on your machine.

```bash
git clone git@github.com:abdulmajidcse/database-admin.git
cd database-admin
docker compose -f compose.dev.yml --profile dbs up
```

That starts the app with HMR **and** all five database engines to develop against, on one
network. Open <http://127.0.0.1:3456/> and create an account.

If you would rather run it directly on your machine, see
[Running without Docker](README.md#running-without-docker) in the README. You will need
Node 22+, and the native dump tools stop working until you install them separately.

## The two compose files

This trips people up, so it is worth stating plainly:

| File | Service | Purpose |
| --- | --- | --- |
| `compose.yml` | `app` | Production image, `restart: unless-stopped`, no source mount |
| `compose.dev.yml` | `devapp` | Bind-mounted source, HMR, plus the `dbs` engine profile |

**The service names must stay different.** Both files use the project name `database-admin`,
so two services called `app` would resolve to the same container — and starting the engines
from `compose.dev.yml` would then stop a running production app mid-request. If you find
yourself "tidying" `devapp` back to `app`, don't.

Both publish `127.0.0.1:3456`, so run one stack or the other. To run both, override the port:

```bash
DBADMIN_PORT=3457 docker compose -f compose.dev.yml up -d devapp
```

## Checks before you open a pull request

```bash
docker compose -f compose.dev.yml exec devapp npm run typecheck
docker compose -f compose.dev.yml exec devapp npm run lint
npm test    # from the host, with the dbs profile running
```

`npm test` runs on the **host**, not inside the app container — running it inside would
require mounting the Docker socket. It talks to the engines on their published ports, which
`tests/helpers/engines.ts` already defaults to. Engine-backed suites skip loudly when an
engine is unreachable; a skipped suite is not a passing one, so start the `dbs` profile first.

Introspection SQL cannot be meaningfully unit tested — it has to run against a real server.
If you touch a connector, add a case that exercises it against the real engine.

## Never hardcode your own environment

The end-to-end scripts in `tests/e2e/` drive a real browser against a real instance, which
means they need an account and some saved connections. Those values are read from environment
variables with placeholder defaults:

```bash
DBADMIN_USER, DBADMIN_PASSWORD, DBADMIN_CONNECTIONS, DBADMIN_CONNECTION,
DBADMIN_DATABASE, DBADMIN_SCHEMA, DBADMIN_TABLE, APP_URL
```

Put your real values in `.env`, which is gitignored. `.env.example` documents every variable
the project reads and is the file that gets committed. **Never commit a connection name,
database name, table name, hostname or credential from your own setup** — it has happened
before and it is tedious to remove from history afterwards.

## Things that will break the build

- **Never copy a host-built `node_modules` into the image.** macOS-built native modules do
  not run on Linux. `node_modules` is the first entry in `.dockerignore` for this reason;
  in dev it lives in a named volume so a host directory can never shadow it.
- **Never widen the port publish.** Both compose files bind `127.0.0.1` deliberately. Docker
  writes firewall rules that bypass the host firewall, so `3456:3456` would expose a
  credentialed database admin tool to the whole network.
- **Do not weaken the Host/Origin allow-list** in `src/server/security.ts` without saying why.
  It is what stops DNS rebinding, and any website you visit can issue requests to localhost.

## Style

Match the surrounding code. The codebase leans on comments that explain *why* a thing is the
way it is — particularly where the reason is non-obvious, like a wire-format quirk or a
platform difference. Comments that restate the code are not wanted; comments that would have
saved you an hour are.

Commit messages: a short imperative subject line, and a body explaining the reasoning when the
change is not self-evident.

## Reporting bugs

Include the engine and version, whether you are running the Docker or host setup, and what you
expected instead. For anything involving credentials or network access, please read
[SECURITY.md](SECURITY.md) first — do not open a public issue for a vulnerability.
