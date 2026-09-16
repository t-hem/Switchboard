# Jobs database design and schema reference

Last updated: 2026-09-16. **Implemented schema: version 1.** This file documents actual
shipped SQL first; planned tables below are not a claim that workflow persistence exists.
Update it in the same stage as every schema/column/constraint change.

## Ownership and files

Only the jobs app opens `JOBS_DIR/jobs.sqlite` (default:
`~/.local/share/switchboard-jobs/jobs.sqlite`). Switchboard and the future review loop
must not open it. SQLite WAL and shared-memory sidecars are normal. The private jobs
service token, bind port and allowed UI origins live in `service.json`, not this DB.
Tokens, cookies and passwords do not belong in settings JSON or historical snapshots.

The driver is Node 22.23.2's built-in `node:sqlite` (`DatabaseSync`), verified with
SQLite 3.51.3. It uses prepared statements, synchronous short transactions, foreign
keys enabled, WAL journaling and `busy_timeout=5000`. Source: `src/store.ts`.
No ORM. `PRAGMA user_version` is the schema version. The Node minor line is constrained
until tested against a new runtime; the built-in SQLite API is experimental there.

## Version 1: `settings_revisions`

Every successful settings update appends a row. The highest revision is current.
Old rows are audit history and must not be rewritten or deleted by application code.

| Column | SQLite type / constraints | Meaning |
|---|---|---|
| `revision` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Monotonic settings revision; also the optimistic-concurrency token exposed to clients. IDs need not be contiguous. |
| `created_at` | `TEXT NOT NULL` | UTC ISO-8601 timestamp from `new Date().toISOString()` when the revision was written. The API calls it `updatedAt`. |
| `actor` | `TEXT NOT NULL` | `bootstrap` for initial defaults, `operator` for authenticated API saves. Single-user app; this is an action origin, not a user/account model. |
| `value_json` | `TEXT NOT NULL CHECK(json_valid(value_json))` | Complete versioned settings snapshot. Validated by the API schema before storage; contains no credentials. |

Initial defaults are inserted transactionally with schema creation. Updating uses
`BEGIN IMMEDIATE`, reads the current revision inside the transaction, compares it to
`expectedRevision`, appends a new row, and commits. A stale client gets HTTP 409; an
invalid API payload gets HTTP 400 with field errors and no database mutation. A SQL
failure rolls the transaction back. No in-memory settings cache can hide another
connection's successful save.

### `value_json` schemaVersion 1

The TypeScript type and strict JSON Schema are in `src/settings.ts`. All keys are
required; unknown keys, coercion and silent field removal are prohibited at the API.

| JSON field | Type / default | Purpose and current behavior |
|---|---|---|
| `schemaVersion` | integer, exactly `1` | Settings document contract, separate from SQLite schema version. |
| `enabled` | boolean, `false` | Master workflow preference. Current scaffold never dispatches any work. |
| `paused` | boolean, `true` | Operator pause preference, read directly from committed settings. |
| `mode` | `draft`, `review`, or `automatic`; default `draft` | Intended automation policy. It does not enable an unimplemented capability. |
| `reviewGates.discovery` | boolean, `true` | Human gate for discovered/selected opportunities. |
| `reviewGates.resumeBuild` | boolean, `true` | Human gate for constructed resume. |
| `reviewGates.resumeEdit` | boolean, `true` | Human gate for the separately saved editing pass. |
| `reviewGates.preparation` | boolean, `true` | Human gate for application preparation. |
| `reviewGates.submission` | boolean, `true` | Final human submission gate. Never supersedes adapter/site capabilities. |
| `spawner.provider` | string, exactly `switchboard` | Configured built-in adapter ID. The factory supports injected alternatives; no arbitrary plugin loading. |
| `spawner.baseUrl` | HTTP(S) URI, default `http://127.0.0.1:7777` | Connection base URL. Credentials, query and fragment are rejected. No startup request is sent. |
| `spawner.agent` | nonempty string, max 100; default `claude` | Intended local CLI selection, acted on only when invocation workers are implemented. |
| `personaDirectory` | absolute Linux path, max 4096 | Shared live persona definitions; defaults to `~/.switchboard/personas`. The scaffold does not read/execute them yet. |

All these fields can be edited/imported/exported through the standalone structured
settings editor. Runtime status truthfully returns `disabled`, `paused`, or
`unavailable` (workers not implemented), with `dispatchAvailable=false` in every case.
The actor and committed revision will become foreign-key references on future runs.

## Migrations and recovery boundaries

Version 0 is accepted only for an empty database. Schema creation plus initial settings
are one transaction. An unversioned database with existing tables is refused; unknown
nonzero versions are refused before any journal/schema changes. Startup never drops
unrecognized tables or invents an upgrade path. Tests compare the entire DB file before
and after a refused future-version open.

Version 1 does **not** yet provide artifact storage, task leases, workflow events,
submission state, integrity inspection or backup/restore. Do not copy a live WAL-mode
DB and assume that is a backup. These are step 3 work, and must be tested before records
other than settings are accepted. Preserve DB plus sidecars for offline diagnosis.

## Next migration: design requirements, not implemented tables

The root JOB-APPLICATION-PLAN.md defines the full entity inventory. Step 3 will add
explicit migrations and document each actual SQL column here. Required design rules:

- Stable text IDs for jobs/applications/tasks/runs; UTC timestamps; historical settings,
  persona/tool/skill/prompt/profile/bullet/template snapshots are immutable inputs.
- Job description text and screenshot artifacts at application time are separate from
  discovery captures. Every resume pass is retained, including exact final PDF bytes.
- Artifacts are content-addressed immutable files, with hash/MIME/size/path/time/purpose
  in SQLite. Flush/rename the file before committing a reference. Record failures; never
  present a missing artifact as a finalized application package.
- Queue claims use transactions plus a lease generation/fencing token. Old or duplicate
  worker results cannot overwrite a newer attempt. A jobs restart inventories existing
  spawner children before deciding whether a preparation task can retry.
- `submitting` and `unknown` outcomes never automatically become retryable submissions.
  A send may have reached the employer even if the local response was lost.
- Decisions record approve/deny/request-changes, edits, subject version and policy revision.
  Relaxing review gates is a versioned explicit operator decision, not model judgment.
- A single active scheduler owner is separate from HTTP service availability. UI/settings
  remain readable while a spawner is unavailable or work is paused.
- Backup uses a SQLite-consistent snapshot plus the referenced artifact set and verifies
  hashes on restore. Restore must not accidentally dispatch archived pending tasks.
