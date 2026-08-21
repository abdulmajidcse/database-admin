# Contributing

Thanks for taking an interest. This is a small project, so the process is light — but the
notes below cover the things that are genuinely easy to get wrong here.

## Getting a working copy

You need Docker and nothing else. Node is not required on your machine.

```bash
git clone git@github.com:abdulmajidcse/database-admin.git
cd database-admin
docker compose up --build
```

That builds and runs the production image. Open <http://127.0.0.1:3456/> and create an account.

To actually work on the code, run it on the host instead — Node 22+, and the native dump tools
need installing separately (see [Running without Docker](README.md#running-without-docker)):

```bash
npm install
npm run dev        # http://127.0.0.1:3456
```

## The two compose files

| File | Contains | Purpose |
| --- | --- | --- |
| `compose.yml` | `app` | The production image, `restart: unless-stopped` |
| `compose.test.yml` | five engines, no app | Databases for `npm test`, up only while testing |

`compose.test.yml` deliberately has **no app service**, so it can never collide with
`compose.yml`'s published port and you can run both at once. Same directory means the same
compose project, which is what puts the engines on the network the app container reaches them by
service name on.

Take the engines down with `-v` when you are finished — they are test fixtures, not data you
want surviving:

```bash
docker compose -f compose.test.yml up -d
docker compose -f compose.test.yml down -v
```

## Checks before you open a pull request

```bash
npm run typecheck
npm test
```

### No Node on your machine?

Run both checks in a throwaway container. This is the whole command — copy it as-is:

```bash
docker run --rm -v "$PWD":/app -w /app \
  -v database-admin-check-modules:/app/node_modules \
  node:22 sh -c "npm install && npm run typecheck && npm test"
```

The named volume is not optional. Your working copy's `node_modules` holds native modules built
for your OS, and they will not run on Linux — the separate volume is what stops the container's
copy and yours overwriting each other. Everything else is bind-mounted, so it checks the code you
actually have.

A green run ends with `216 passed`. The same command appears in the
[README](README.md#running-the-checks-without-node), so quote whichever one your reviewer will
have open.

`npm test` is vitest. Today that means 216 unit tests over the SQL lexer, the changeset
builder and the schema differ — they need no database and finish in well under a second.

**The engine-backed suite is not wired up yet, and this is the single most useful thing to
contribute.** `tests/helpers/engines.ts` and `tests/smoke/*.ts` exist and are written, but
nothing imports them and vitest only collects `**/*.test.ts`, so none of it runs. Introspection
SQL cannot be meaningfully unit tested — it has to execute against a real server — so every
connector change is currently unverified by CI.

If you pick this up: the helper reads `TEST_MYSQL_HOST`, `TEST_PG_PORT` and friends, defaulting
to the ports `compose.test.yml` publishes on `127.0.0.1`, so `npm test` on the host needs no
configuration at all:

```bash
docker compose -f compose.test.yml up -d
npm test
```

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
