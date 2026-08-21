# Roadmap

[PLAN.md](../PLAN.md) took the app through M0–M9. This picks up from there.

Everything below was checked against the code rather than imagined: a feature is listed only
after searching for it and not finding it. Where something exists in part, the partial state is
named, because "add X" and "finish X" are different jobs.

---

## 1. Where the app actually is

Parity with TablePlus, DataGrip/PhpStorm and the VS Code Database Client is essentially reached
for the four things people do most: **browse, query, edit, transfer**.

That is not a claim about polish — it is a claim about the load-bearing pieces existing:
a virtualized grid with changeset editing and transactional apply, schema-aware autocomplete,
pinned transaction sessions, real cancellation, ER diagram, EXPLAIN visualizer, process monitor,
schema compare with generated migration DDL, streaming import/export with background jobs, and
Redis and MongoDB workspaces.

So the remaining work is not catching up. It is the long tail, plus the things none of those
three tools do.

---

## 2. M10 — Everyday data work

The features you reach for hourly and notice the absence of immediately.

| Feature | State today |
| --- | --- |
| Foreign-key navigation | Absent. The schema cache already carries `foreignKeys`; nothing consumes them for navigation |
| Copy as INSERT / JSON / CSV / Markdown | `data-grid.tsx` copies TSV only |
| SQL formatter | Absent |
| Generate SELECT/INSERT/UPDATE from a tree object | Absent; the context menu offers "Open DDL" and stops there |
| Snippets / live templates | Absent |
| Bind parameters | Absent end to end — but `RunOpts.params` exists and all three SQL connectors already honor it, so this is lexer + API + UI only |
| Keyboard map | Absent. Bindings are scattered across five files with no registry |

**Three shared modules carry it.** `sql/dml.ts` renders DML from a `TableModel` plus rows, which
is the same operation behind both copy-as-INSERT and generate-SQL — one renderer, two entry
points. `sql/format.ts` wraps a formatter and re-tokenizes its output with the existing
`splitStatements`, refusing any format that changes the statement count or kinds, so a formatter
bug can never corrupt a buffer. A shortcut registry declares every binding as data and drives
both the handlers and a generated cheat sheet, because a hand-maintained sheet is wrong the first
time someone adds a key.

**Done when** you can click a foreign key and land on the referenced row, copy a selection as an
`INSERT`, and press `?` to see every shortcut.

---

## 3. M11 — Object management

The DDL layer stops at tables. Everything else in the tree is read-only.

- **View, routine and trigger editors.** DDL is displayed but cannot be edited and submitted.
  `CREATE OR REPLACE` round-tripping is the gap.
- **`CREATE`/`DROP DATABASE` and `SCHEMA`.** `sql/ddl-common.ts` renders tables, columns,
  indexes, foreign keys and checks. Databases and schemas are absent.
- **Users, roles and privileges.** Absent entirely. DataGrip's version of this is a real
  differentiator against TablePlus.

**Done when** the object tree has no node kind you have to drop to a SQL tab to change.

---

## 4. M12 — Data movement

The transfer engine is built; three routes through it are missing.

- **Cross-engine table-to-table copy.** Already typed as `CopyJobParams` in `jobs/types.ts`,
  citing PLAN §7.6 as the stretch goal. The pipeline and the canonical model that does
  the type mapping both exist. What is missing is a UI and the wiring.
- **JSON and XLSX import.** Export writes eight formats (`csv`, `tsv`, `json`, `ndjson`, `xlsx`, `markdown`, `html`, `sql`);
  import reads CSV and SQL scripts.
- **Data compare and sync.** Schema compare exists. Row-level diff between two tables, with a
  generated reconciliation script, does not.

**Done when** you can move a table from Postgres to MySQL without exporting to a file first.

---

## 5. M13 — More engines

MSSQL is the single largest gap against all three competitors. ClickHouse and DuckDB follow.

This milestone is also the honest test of PLAN §14's claim that adding an engine is "implement
`Connector`, register it, done". `registry.ts` is the only file that maps an `EngineKind` to an
implementation, and the `Capability` union already expresses what an engine can and cannot do.
If MSSQL needs changes outside a new connector directory plus those two files, the abstraction
leaked and this milestone should fix that before adding a fourth engine.

**Done when** a new engine is a directory and two lines.

---

## 6. M14 — Operations

New territory. None of this exists, and most of it is close to data the app already has.

- **Index advisor.** The EXPLAIN output is already parsed and rendered. Turning sequential scans
  over filtered columns into a suggested index is a short step from there.
- **Table size and bloat analysis.**
- **`VACUUM` / `ANALYZE` UI** for Postgres.
- **Partition management.** Both the MySQL and Postgres introspectors already read partitions;
  nothing surfaces them.
- **Health dashboard** — connection counts, cache-hit ratio, replication lag.
- **Slow-query-log integration.**

This is where the app can stop being a client and start being useful during an incident. It is
also the cluster most likely to be someone's reason for keeping DataGrip open.

---

## 7. M15 — Beyond parity

- **Code generation from the schema.** The differ already produces a structured diff; emitting
  ORM models or framework migration files from it is a new backend for machinery that exists.
  Highest leverage item on this document for anyone working in a framework with migrations.
- **Result charts.**
- **Multi-connection query** — one statement across several servers, results stacked.
- **Notebooks** — interleaved SQL and prose.
- **Data masking** on connections tagged `prod`.
- **Scheduled queries.**
- **Natural language to SQL**, deferred in PLAN §14 and a natural fit once the schema cache exists.

---

## 8. Loose ends

Small, independent, and none of them belong to a milestone.

| Item | Note |
| --- | --- |
| Connection folders / groups | `ConnectionConfig` has `sortOrder` but no group |
| App database backup and restore | PLAN §12 M9 listed it; it never landed |
| Settings screen | `/api/settings` is a working key-value store with no UI in front of it |
| Test-data generator | |
| Cross-table data search | "find this value anywhere in the database" |

---

## 9. Ordering

M10 → M11 → M12 → M13 is the parity path, in descending order of how often you would notice the
absence.

Two deviations are worth considering:

**M14 before M13.** An index advisor and a bloat view are reasons to leave DataGrip, whereas
MSSQL support is a reason to consider this app at all. Which matters more depends on whether the
goal is more users or better ones.

**M15's code generation, early.** It is the only item here that turns something already built
(the schema differ) into a new product surface, rather than adding a surface from scratch.

Nothing in M11–M15 depends on M10. The clusters are independent by construction, so the order is
a preference, not a constraint.
