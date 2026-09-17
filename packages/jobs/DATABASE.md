# Jobs database design and schema reference

Last updated: 2026-09-16. **Implemented schema: version 2.** This file documents actual SQL and storage APIs.
Workflow-specific adapters and execution are still later stages.
Update it in the same stage as every schema/column/constraint change.

## Ownership and files

Only the jobs app opens `JOBS_DIR/jobs.sqlite` (default:
`~/.local/share/switchboard-jobs/jobs.sqlite`). Switchboard and the future review loop
must not open it. SQLite WAL and shared-memory sidecars are normal. The private jobs
service token, bind port and allowed UI origins live in `service.json`, not this DB.
Tokens, cookies and passwords do not belong in settings JSON or historical snapshots.

The driver is Node 22.23.2's built-in `node:sqlite` (`DatabaseSync`), verified with
SQLite 3.51.3. It uses prepared statements, synchronous short transactions, foreign
keys enabled, WAL journaling and `busy_timeout=5000`. Source: `src/database.ts`; settings access: `src/store.ts`.
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
| `enabled` | boolean, `false` | Master workflow preference. Disabled by default; enabling it lets discovery and gated submission run. |
| `paused` | boolean, `true` | Operator pause preference, read directly from committed settings. |
| `mode` | `draft`, `review`, or `automatic`; default `draft` | Automation policy. `draft` never sends; `review` requires a matching approval; `automatic` additionally needs an explicit per-site opt-in. |
| `reviewGates.discovery` | boolean, `true` | Human gate for discovered/selected opportunities. |
| `reviewGates.resumeBuild` | boolean, `true` | Human gate for constructed resume. |
| `reviewGates.resumeEdit` | boolean, `true` | Human gate for the separately saved editing pass. |
| `reviewGates.preparation` | boolean, `true` | Human gate for application preparation. |
| `reviewGates.submission` | boolean, `true` | Final human submission gate. Never supersedes adapter/site capabilities. |
| `spawner.provider` | string, exactly `switchboard` | Configured built-in adapter ID. The factory supports injected alternatives; no arbitrary plugin loading. |
| `spawner.baseUrl` | HTTP(S) URI, default `http://127.0.0.1:7777` | Connection base URL. Credentials, query and fragment are rejected. No startup request is sent. |
| `spawner.agent` | nonempty string, max 100; default `claude` | Local CLI selection used by the invocation adapter when the tailoring runner spawns. |
| `personaDirectory` | absolute Linux path, max 4096 | Shared live persona definitions; defaults to `~/.switchboard/personas`. Read and validated by the jobs service at run time; never read by the host daemon. |

All these fields can be edited/imported/exported through the standalone structured
settings editor. Runtime status truthfully returns `disabled`, `paused`, `idle`
or `running`, with `dispatchAvailable=false` whenever jobs are disabled or paused.
Decisions record their actor, and screening/review decisions store the settings revision
they were committed against.

## Migrations and recovery boundaries

Version 0 is accepted only for an empty database. Schema creation plus initial settings
are one transaction. An unversioned database with existing tables is refused; unknown
nonzero versions are refused before any journal/schema changes. Startup never drops
unrecognized tables or invents an upgrade path. Tests compare the entire DB file before
and after a refused future-version open.

Version 1 is the shipped settings-only schema. Version 2 adds the tables and triggers
listed below in one `BEGIN IMMEDIATE` transaction. The migration rechecks the version
under the write lock; failure rolls back both DDL and `user_version`. Future migrations
must preserve historical values and add a tested upgrade from each shipped version.
Never modify a shipped migration to reinterpret existing rows.

## Relationships and data conventions

- `jobs` is a mutable deduplicated projection; `job_aliases` maps each source identity.
  `job_snapshots` preserves each observation. A resume references an exact snapshot,
  profile and template revision. Every edit/render is another `resume_versions` row.
- One `applications` row represents a canonical job. Multiple `application_attempts`
  may exist, each pinned to a resume, preflight snapshot, settings and site policy.
  Site delivery is not exactly-once simply because the local idempotency key is unique.
- `tasks` records durable work intent, with one `agent_runs` record per actual attempt.
  Runs contain the full persona text, skills, prompt, model, tool definitions and
  permissions used then. Shared persona files may change without changing old runs.
  `tool_events` and `run_messages` are append-only; unavailable output is a capture gap.
- UTC ISO strings describe observed/history times. Scheduling/deadline/lease values
  are integer UTC epoch milliseconds. Text IDs are non-null stable opaque identifiers.
  JSON columns require valid JSON; their richer domain shape belongs to each future
  adapter/workflow validator. Empty placeholder objects are not production evidence.
- SQL foreign keys enforce concrete references; generic event/review subject IDs are
  polymorphic and require caller validation. Snapshot hashes, selected bullet revision
  IDs/order and capture metadata need caller validation too. Do not claim arbitrary
  SQL inserts enforce the entire application state machine.
- All evidence/history tables reject updates/deletes. Mutable projection/state columns
  have narrowly pinned immutable inputs. Run session identity can be assigned once;
  replacement execution requires a new attempt/run. No retention deletion or automatic
  artifact garbage collector is implemented. Backups retain historical rows.
- No credentials in these columns. Redact tokens, cookies, headers and passwords at
  ingestion/tool boundaries before persisting otherwise detailed context. Audit is
  local single-user history, not a tamper-proof record against the machine owner.

## Artifact publication and crash boundaries

`src/artifacts.ts` stores exact bytes under `JOBS_DIR/artifacts/<sha256>` and unfinished
writes under `JOBS_DIR/staging/<uuid>`. The manifest stores MIME type, size, relative
path, creation time and original purpose. Identical bytes share a manifest row: first
metadata wins, while referencing domain rows explain each subsequent use.

Publication writes a new private staging file, flushes it, hard-links it atomically to
the digest filename without replacing existing bytes, verifies the target and flushes
the artifact directory, then inserts the DB row. Only afterward may a workflow commit
a foreign-key reference. If the caller owns a DB transaction, the manifest insert is
part of it. Failure before commit can leave staging or unreferenced final files; it
cannot commit a reference before the bytes have been published. Inspection lists those
files; it never deletes them or assumes they are safe to collect while a writer runs.

Reads verify registered path, regular file type, size and hash. Missing/corrupt bytes
raise a blocking error; callers must not present that evidence as finalized. SQL
integrity checks cannot detect missing files, so backup/restore checks both. These are
Linux local-filesystem durability rules, not a guarantee against disk failure or a
privileged external process modifying files.

## Queue ownership, recovery and submission uncertainty

`src/queue.ts` holds these primitives and `src/worker.ts` drives them. The worker's order on
each start is: acquire the scheduler lease (a new generation), recover — block every task a
previous owner was running, fencing its lease — then reconcile those tasks' recorded spawner
children, and only then dispatch eligible queued work. Nothing a dead worker was running is
dispatched again before its child has been checked.

1. Acquire the `main` scheduler lease transactionally. Each replacement increments its
   generation. Even the same owner must explicitly renew rather than reacquire a live
   lease. Owner IDs identify process instances, not a reusable host name.
2. Claim checks current master enable/pause settings inside the same transaction,
   increments attempt and fence, and records owner/generation/expiry. All heartbeat,
   result and failure writes require both a live scheduler and the exact task fence.
3. Expired or replaced running work becomes `blocked` for preparation or `unknown` for
   submission. Expiration does not prove the child stopped. Stale outputs cannot finish
   the task. Retry is explicit, bounded by `max_attempts` (including the first attempt),
   preparation-only, and refuses any child not confirmed exited/cancelled.
4. Cancellation invalidates the fence but retains run history. It is an intent, not
   proof of child termination; the future spawner worker must reconcile cleanup.
5. `markSubmitting` records the send intent before external effects. An interrupted
   send becomes unknown, never an automatic resend. It is a necessary storage boundary,
   not approval: evidence, human review, adapter/site capability and caps still need
   checks in the submission workflow. This stage exposes no submission endpoint.

Queue state changes and their audit events commit together. Enqueuing the same ID with
changed immutable inputs is a conflict. The current live settings may stop work even
though the task retains the earlier settings revision that defined its original intent.
Lease clocks use this machine's wall clock; a clock change can delay expiry or trigger
conservative reconciliation. Fences remain necessary even on one machine.

## Backup, restore and inspection

`src/backup.ts` uses SQLite's online backup API for a consistent snapshot, then copies
only that snapshot's immutable artifact set. A manifest records schema version, exact
DB SHA-256 and every referenced artifact hash/size. Files/directories are flushed before
publication into a new archive directory. Concurrent future artifacts are excluded;
none of the snapshot's artifacts may be deleted during the operation.

Restore requires a **new directory**, verifies DB integrity/FKs and the exact manifest
and file bytes, then appends disabled/paused settings with actor `restore`. It fences
pending work and marks preparation blocked/submission unknown, clears the scheduler
lock, and appends an audit event. Completed history and run identities remain available
for reconciliation. It does not kill, recreate or assume the death of real child agents.
Never run original and restored copies against the same spawner as active schedulers.

`service.json` and credentials are intentionally excluded. Partial directories remain
for diagnosis after failures; only a completed, verified archive should be restored.
A failed archive does not modify the live source. Commands are in README.md. Inspection
and backup open an existing matching-schema DB read-only; they do not bootstrap tokens,
create a database, or migrate it. SQLite may manage its ordinary WAL read sidecars.

## Verified storage behavior

`test/storage.test.ts` covers fresh and shipped-v1 migrations, transactional migration
failure, FK/dedup/immutable/preflight constraints, exact-byte artifacts, corrupt/missing
files, real SIGKILL before publication/after publication and before/after DB commit,
three independent competing scheduler processes, pause checks, stale fencing, bounded
retry, unresolved children, cancellation, interrupted sends, audit rollback and backup/
restore. `test/scaffold.test.ts` covers unchanged refusal of future schema versions.
The subprocess fixture uses disposable data and starts no model or external service.

<!-- generated-schema -->

## Schema 4: generated column and constraint reference

Generated by `node packages/jobs/scripts/document-schema.mjs` after building jobs.
Review source `src/schema.ts` and migrations in `src/database.ts` alongside this reference.
Mutable JSON payloads are not a substitute for adapter/workflow validation in later stages.

### agent_runs

One child attempt per task/attempt number. Persist intent before spawning. Full persona/skills/prompt/model/tools/permissions/hash snapshots remain in SQLite. Spawner identity is separate from process identity; unavailable is not dead. Session identity is assignable once. State/outcome are mutable, inputs immutable.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `task_id` | TEXT | no | — | tasks.id |
| `attempt` | INTEGER | no | — | — |
| `state` | TEXT | no | — | — |
| `spawner_provider` | TEXT | no | — | — |
| `spawner_instance` | TEXT | no | — | — |
| `spawner_session_id` | TEXT | yes | — | — |
| `process_identity` | TEXT | yes | — | — |
| `parent_run_id` | TEXT | yes | — | agent_runs.id |
| `run_directory` | TEXT | no | — | — |
| `deadline_at` | INTEGER | no | — | — |
| `created_at` | TEXT | no | — | — |
| `finished_at` | TEXT | yes | — | — |
| `persona_text` | TEXT | no | — | — |
| `skills_json` | TEXT | no | — | — |
| `prompt_text` | TEXT | no | — | — |
| `agent` | TEXT | no | — | — |
| `model` | TEXT | no | — | — |
| `tools_json` | TEXT | no | — | — |
| `permissions_json` | TEXT | no | — | — |
| `revision_hashes_json` | TEXT | no | — | — |
| `settings_revision` | INTEGER | no | — | settings_revisions.revision |
| `outcome_json` | TEXT | yes | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE agent_runs (
 id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), attempt INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN('prepared','starting','running','exited','lost','cancelled','unknown')),
 spawner_provider TEXT NOT NULL, spawner_instance TEXT NOT NULL, spawner_session_id TEXT,
 process_identity TEXT, parent_run_id TEXT REFERENCES agent_runs(id), run_directory TEXT NOT NULL,
 deadline_at INTEGER NOT NULL, created_at TEXT NOT NULL, finished_at TEXT,
 persona_text TEXT NOT NULL, skills_json TEXT NOT NULL CHECK(json_valid(skills_json)), prompt_text TEXT NOT NULL,
 agent TEXT NOT NULL, model TEXT NOT NULL, tools_json TEXT NOT NULL CHECK(json_valid(tools_json)),
 permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)), revision_hashes_json TEXT NOT NULL CHECK(json_valid(revision_hashes_json)),
 settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision),
 outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
 UNIQUE(task_id,attempt), UNIQUE(spawner_provider,spawner_instance,spawner_session_id)
);
```

</details>

### application_attempts

Durable external send intent and outcome. idempotency_key protects local duplicate attempts; it does not guarantee exactly-once website delivery. Manifest, evidence, resume and policy/settings references cannot change after insertion. Receipt/outcome fields retain observed or operator-confirmed evidence.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `application_id` | TEXT | no | — | applications.id |
| `idempotency_key` | TEXT | no | — | — |
| `adapter_id` | TEXT | no | — | — |
| `state` | TEXT | no | — | — |
| `snapshot_id` | TEXT | no | — | job_snapshots.id |
| `resume_id` | TEXT | no | — | resume_versions.id |
| `settings_revision` | INTEGER | no | — | settings_revisions.revision |
| `policy_id` | TEXT | no | — | source_policies.id |
| `manifest_json` | TEXT | no | — | — |
| `preflight_at` | TEXT | no | — | — |
| `send_started_at` | TEXT | yes | — | — |
| `finished_at` | TEXT | yes | — | — |
| `outcome_json` | TEXT | yes | — | — |
| `receipt_hash` | TEXT | yes | — | artifacts.hash |
| `created_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE application_attempts (
 id TEXT PRIMARY KEY NOT NULL, application_id TEXT NOT NULL REFERENCES applications(id),
 idempotency_key TEXT NOT NULL UNIQUE, adapter_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('draft','approved','submitting','submitted','rejected','unknown','cancelled')),
 snapshot_id TEXT NOT NULL REFERENCES job_snapshots(id), resume_id TEXT NOT NULL REFERENCES resume_versions(id),
 settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision), policy_id TEXT NOT NULL REFERENCES source_policies(id),
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 preflight_at TEXT NOT NULL, send_started_at TEXT, finished_at TEXT,
 outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
 receipt_hash TEXT REFERENCES artifacts(hash), created_at TEXT NOT NULL
);
```

</details>

### applications

Current per-job application projection; one application record per canonical job, with multiple explicit attempts when appropriate. Transition/policy guards land with workflow callers, not arbitrary SQL updates.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `job_id` | TEXT | no | — | jobs.id |
| `state` | TEXT | no | — | — |
| `selected_resume_id` | TEXT | yes | — | resume_versions.id |
| `policy_id` | TEXT | yes | — | source_policies.id |
| `settings_revision` | INTEGER | no | — | settings_revisions.revision |
| `block_reason` | TEXT | yes | — | — |
| `created_at` | TEXT | no | — | — |
| `updated_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE applications (
 id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
 state TEXT NOT NULL CHECK(state IN('discovered','captured','screened','tailoring','preparing','review_required','approved','submitting','submitted','rejected','skipped','needs_input','retryable_failure','terminal_failure','cancelled','submission_unknown')),
 selected_resume_id TEXT REFERENCES resume_versions(id), policy_id TEXT REFERENCES source_policies(id),
 settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision),
 block_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

</details>

### artifacts

Immutable content-addressed file manifest. The digest is also the filename; metadata is committed only after file publication and directory flush.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `hash` | TEXT | no | — | primary key |
| `mime_type` | TEXT | no | — | — |
| `size_bytes` | INTEGER | no | — | — |
| `relative_path` | TEXT | no | — | — |
| `created_at` | TEXT | no | — | — |
| `purpose` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE artifacts (
 hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
 mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
 relative_path TEXT NOT NULL UNIQUE CHECK(relative_path='artifacts/'||hash),
 created_at TEXT NOT NULL, purpose TEXT NOT NULL
);
```

</details>

### attention_items

Durable review inbox. Immutable subject/version/context, task/run/artifact and settings references bind the decision to exact saved inputs. Mutable state/version records resolution or supersession; deleting history is forbidden. Reviews validate current settings and waiting-review task state; approval records a decision but does not dispatch a worker.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `task_id` | TEXT | no | — | tasks.id |
| `run_id` | TEXT | yes | — | agent_runs.id |
| `artifact_hash` | TEXT | yes | — | artifacts.hash |
| `subject_type` | TEXT | no | — | — |
| `subject_id` | TEXT | no | — | — |
| `subject_version` | TEXT | no | — | — |
| `title` | TEXT | no | — | — |
| `detail` | TEXT | no | — | — |
| `context_json` | TEXT | no | — | — |
| `settings_revision` | INTEGER | no | — | settings_revisions.revision |
| `state` | TEXT | no | 'open' | — |
| `version` | INTEGER | no | 1 | — |
| `decision_id` | TEXT | yes | — | review_decisions.id |
| `created_at` | TEXT | no | — | — |
| `updated_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE attention_items (
          id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
          run_id TEXT REFERENCES agent_runs(id), artifact_hash TEXT REFERENCES artifacts(hash),
          subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, subject_version TEXT NOT NULL,
          title TEXT NOT NULL, detail TEXT NOT NULL, context_json TEXT NOT NULL CHECK(json_valid(context_json)),
          settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision),
          state TEXT NOT NULL DEFAULT 'open' CHECK(state IN('open','resolved','superseded')),
          version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
          decision_id TEXT REFERENCES review_decisions(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(task_id,subject_type,subject_id,subject_version,settings_revision)
        );
```

</details>

### bullet_revisions

Immutable prose plus tags, selection filters and evidence, tied to a specific applicant profile revision. Rewording produces a new revision.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `bullet_id` | TEXT | no | — | — |
| `revision` | INTEGER | no | — | — |
| `profile_revision_id` | TEXT | no | — | profile_revisions.id |
| `prose` | TEXT | no | — | — |
| `tags_json` | TEXT | no | — | — |
| `filters_json` | TEXT | no | — | — |
| `evidence_json` | TEXT | no | — | — |
| `created_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE bullet_revisions (
 id TEXT PRIMARY KEY NOT NULL, bullet_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 profile_revision_id TEXT NOT NULL REFERENCES profile_revisions(id), prose TEXT NOT NULL,
 tags_json TEXT NOT NULL CHECK(json_valid(tags_json)), filters_json TEXT NOT NULL CHECK(json_valid(filters_json)),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at TEXT NOT NULL, UNIQUE(bullet_id,revision)
);
```

</details>

### events

Append-only ordered audit. Subject type/ID are a generic cross-entity reference; callers must supply sanitized payloads without credentials.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | INTEGER | no | — | primary key |
| `occurred_at` | TEXT | no | — | — |
| `kind` | TEXT | no | — | — |
| `subject_type` | TEXT | no | — | — |
| `subject_id` | TEXT | no | — | — |
| `payload_json` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL,
 kind TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);
```

</details>

### job_aliases

Original source identity and URL mapped to a canonical job; source/external ID pairs cannot be duplicated.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `job_id` | TEXT | no | — | jobs.id |
| `source_id` | TEXT | no | — | sources.id |
| `external_id` | TEXT | no | — | — |
| `original_url` | TEXT | no | — | — |
| `discovered_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE job_aliases (
 id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id), source_id TEXT NOT NULL REFERENCES sources(id),
 external_id TEXT NOT NULL, original_url TEXT NOT NULL, discovered_at TEXT NOT NULL,
 UNIQUE(source_id,external_id)
);
```

</details>

### job_snapshots

Immutable observed description/capture metadata. Complete application-preflight evidence requires nonempty text and a screenshot reference. capture_json holds viewport, ordered additional images, capture diagnostics and other source-specific evidence; the capture adapter validates that structure.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `job_id` | TEXT | no | — | jobs.id |
| `purpose` | TEXT | no | — | — |
| `captured_at` | TEXT | no | — | — |
| `fetched_url` | TEXT | no | — | — |
| `final_url` | TEXT | no | — | — |
| `description_text` | TEXT | no | — | — |
| `screenshot_hash` | TEXT | yes | — | artifacts.hash |
| `content_hash` | TEXT | no | — | — |
| `capture_version` | TEXT | no | — | — |
| `capture_json` | TEXT | no | — | — |
| `completeness` | TEXT | no | — | — |
| `failure_detail` | TEXT | yes | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE job_snapshots (
 id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id),
 purpose TEXT NOT NULL CHECK(purpose IN('discovery','tailoring','application_preflight')),
 captured_at TEXT NOT NULL, fetched_url TEXT NOT NULL, final_url TEXT NOT NULL,
 description_text TEXT NOT NULL, screenshot_hash TEXT REFERENCES artifacts(hash),
 content_hash TEXT NOT NULL, capture_version TEXT NOT NULL,
 capture_json TEXT NOT NULL CHECK(json_valid(capture_json)),
 completeness TEXT NOT NULL CHECK(completeness IN('complete','partial','failed')),
 failure_detail TEXT,
 CHECK(purpose!='application_preflight' OR completeness!='complete' OR
       (length(trim(description_text))>0 AND screenshot_hash IS NOT NULL))
);
```

</details>

### jobs

Current normalized opportunity projection. dedup_key is canonical identity; historical description/evidence lives in snapshots, not mutable columns here.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `canonical_url` | TEXT | no | — | — |
| `dedup_key` | TEXT | no | — | — |
| `company` | TEXT | no | — | — |
| `title` | TEXT | no | — | — |
| `location` | TEXT | yes | — | — |
| `normalized_json` | TEXT | no | — | — |
| `discovered_at` | TEXT | no | — | — |
| `last_seen_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE jobs (
 id TEXT PRIMARY KEY NOT NULL, canonical_url TEXT NOT NULL, dedup_key TEXT NOT NULL UNIQUE,
 company TEXT NOT NULL, title TEXT NOT NULL, location TEXT,
 normalized_json TEXT NOT NULL CHECK(json_valid(normalized_json)),
 discovered_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
```

</details>

### profile_revisions

Immutable applicant facts and supporting provenance. profile_id identifies the logical profile; revision identifies an exact historical version.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `profile_id` | TEXT | no | — | — |
| `revision` | INTEGER | no | — | — |
| `data_json` | TEXT | no | — | — |
| `evidence_json` | TEXT | no | — | — |
| `created_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE profile_revisions (
 id TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 data_json TEXT NOT NULL CHECK(json_valid(data_json)), evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 created_at TEXT NOT NULL, UNIQUE(profile_id,revision)
);
```

</details>

### resume_versions

Immutable build/edit/render outputs. Parent links preserve both model passes. Exact text is required; a later PDF render creates a new version instead of mutating earlier output. selected_bullets_json retains IDs, revisions and ordering; edits_json records prose changes.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `job_snapshot_id` | TEXT | no | — | job_snapshots.id |
| `profile_revision_id` | TEXT | no | — | profile_revisions.id |
| `template_revision_id` | TEXT | no | — | template_revisions.id |
| `parent_resume_id` | TEXT | yes | — | resume_versions.id |
| `agent_run_id` | TEXT | yes | — | agent_runs.id |
| `phase` | TEXT | no | — | — |
| `source_json` | TEXT | no | — | — |
| `selected_bullets_json` | TEXT | no | — | — |
| `edits_json` | TEXT | no | — | — |
| `text_artifact_hash` | TEXT | no | — | artifacts.hash |
| `pdf_artifact_hash` | TEXT | yes | — | artifacts.hash |
| `created_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE resume_versions (
 id TEXT PRIMARY KEY NOT NULL, job_snapshot_id TEXT NOT NULL REFERENCES job_snapshots(id),
 profile_revision_id TEXT NOT NULL REFERENCES profile_revisions(id), template_revision_id TEXT NOT NULL REFERENCES template_revisions(id),
 parent_resume_id TEXT REFERENCES resume_versions(id), agent_run_id TEXT REFERENCES agent_runs(id),
 phase TEXT NOT NULL CHECK(phase IN('build','edit','render')),
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 selected_bullets_json TEXT NOT NULL CHECK(json_valid(selected_bullets_json)),
 edits_json TEXT NOT NULL CHECK(json_valid(edits_json)),
 text_artifact_hash TEXT NOT NULL REFERENCES artifacts(hash), pdf_artifact_hash TEXT REFERENCES artifacts(hash), created_at TEXT NOT NULL
);
```

</details>

### review_decisions

Immutable approve/deny/request-changes decision against an exact subject version, before/after data and settings policy. A polymorphic subject is validated by its workflow caller.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `subject_type` | TEXT | no | — | — |
| `subject_id` | TEXT | no | — | — |
| `subject_version` | TEXT | no | — | — |
| `decision` | TEXT | no | — | — |
| `reason` | TEXT | yes | — | — |
| `before_json` | TEXT | no | — | — |
| `after_json` | TEXT | no | — | — |
| `settings_revision` | INTEGER | no | — | settings_revisions.revision |
| `created_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE review_decisions (
 id TEXT PRIMARY KEY NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, subject_version TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN('approve','deny','request_changes')), reason TEXT,
 before_json TEXT NOT NULL CHECK(json_valid(before_json)), after_json TEXT NOT NULL CHECK(json_valid(after_json)),
 settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision), created_at TEXT NOT NULL
);
```

</details>

### run_messages

Append-only messages actually exposed by the runner, ordered per run. capture_gap explicitly records unavailable/lost output; never claim unavailable model internals were captured.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | INTEGER | no | — | primary key |
| `run_id` | TEXT | no | — | agent_runs.id |
| `sequence` | INTEGER | no | — | — |
| `role` | TEXT | no | — | — |
| `content_json` | TEXT | no | — | — |
| `occurred_at` | TEXT | no | — | — |
| `capture_gap` | TEXT | yes | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE run_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id), sequence INTEGER NOT NULL,
 role TEXT NOT NULL, content_json TEXT NOT NULL CHECK(json_valid(content_json)),
 occurred_at TEXT NOT NULL, capture_gap TEXT, UNIQUE(run_id,sequence)
);
```

</details>

### scheduler_lock

Single active scheduler lease. owner identifies an execution instance; generation increases on replacement. Expiration is not proof that a child or external action stopped.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `name` | TEXT | no | — | primary key |
| `owner` | TEXT | no | — | — |
| `generation` | INTEGER | no | — | — |
| `lease_expires_at` | INTEGER | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE scheduler_lock (
 name TEXT PRIMARY KEY NOT NULL CHECK(name='main'), owner TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0), lease_expires_at INTEGER NOT NULL
);
```

</details>

### screening_decisions

Append-only screening history and operator skip/requeue audit. decision distinguishes eligible, excluded, needs_review and skipped; reasons_json records why (matched, mismatch, or unknown/unstated). Only a definite mismatch excludes; an unstated field is needs_review, never a mismatch. Salary is normalized in place and currency is never converted.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `job_id` | TEXT | no | — | jobs.id |
| `source_id` | TEXT | yes | — | sources.id |
| `settings_revision` | INTEGER | no | — | settings_revisions.revision |
| `decision` | TEXT | no | — | — |
| `score` | REAL | no | — | — |
| `reasons_json` | TEXT | no | — | — |
| `actor` | TEXT | no | — | — |
| `created_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE screening_decisions (
          id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id),
          source_id TEXT REFERENCES sources(id), settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision),
          decision TEXT NOT NULL CHECK(decision IN('eligible','excluded','needs_review','skipped')),
          score REAL NOT NULL, reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json)),
          actor TEXT NOT NULL, created_at TEXT NOT NULL
        );
```

</details>

### search_runs

One discovery execution with pinned settings and a resumable pagination checkpoint; failed runs retain error details.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `source_id` | TEXT | no | — | sources.id |
| `settings_revision` | INTEGER | no | — | settings_revisions.revision |
| `state` | TEXT | no | — | — |
| `checkpoint_json` | TEXT | yes | — | — |
| `created_at` | TEXT | no | — | — |
| `finished_at` | TEXT | yes | — | — |
| `error_json` | TEXT | yes | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE search_runs (
 id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id),
 settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision),
 state TEXT NOT NULL CHECK(state IN('queued','running','completed','failed','blocked')),
 checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
 created_at TEXT NOT NULL, finished_at TEXT, error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json))
);
```

</details>

### settings_revisions

Immutable full settings snapshots and concurrency revisions. See the detailed version-1 description above.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `revision` | INTEGER | no | — | primary key |
| `created_at` | TEXT | no | — | — |
| `actor` | TEXT | no | — | — |
| `value_json` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE settings_revisions (
          revision INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
          actor TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json))
        );
```

</details>

### source_policies

Immutable per-scope adapter/site restrictions and capabilities. A terms URL or accessible endpoint is not permission to automate. Effective policy must also be bounded by adapter support.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `scope_key` | TEXT | no | — | — |
| `revision` | INTEGER | no | — | — |
| `adapter_id` | TEXT | no | — | — |
| `site_url` | TEXT | no | — | — |
| `terms_url` | TEXT | yes | — | — |
| `reviewed_at` | TEXT | yes | — | — |
| `capabilities_json` | TEXT | no | — | — |
| `restrictions_json` | TEXT | no | — | — |
| `created_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE source_policies (
 id TEXT PRIMARY KEY NOT NULL, scope_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 adapter_id TEXT NOT NULL, site_url TEXT NOT NULL, terms_url TEXT, reviewed_at TEXT,
 capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
 restrictions_json TEXT NOT NULL CHECK(json_valid(restrictions_json)), created_at TEXT NOT NULL,
 UNIQUE(scope_key,revision)
);
```

</details>

### sources

Editable source registry. Disabled by default. adapter_id plus source_key deduplicates a board/company configuration; policy_id selects the current reviewed policy.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `adapter_id` | TEXT | no | — | — |
| `source_key` | TEXT | no | — | — |
| `config_json` | TEXT | no | — | — |
| `enabled` | INTEGER | no | 0 | — |
| `policy_id` | TEXT | yes | — | source_policies.id |
| `created_at` | TEXT | no | — | — |
| `updated_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE sources (
 id TEXT PRIMARY KEY NOT NULL, adapter_id TEXT NOT NULL, source_key TEXT NOT NULL,
 config_json TEXT NOT NULL CHECK(json_valid(config_json)), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 policy_id TEXT REFERENCES source_policies(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(adapter_id,source_key)
);
```

</details>

### tasks

Durable work intent. effect_class distinguishes preparation from submission risk. attempt counts claims; max_attempts includes the initial attempt. fence invalidates stale/cancelled worker results. Lease and available_at values are UTC epoch milliseconds; other timestamps are ISO UTC strings. Input and settings references are immutable.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `kind` | TEXT | no | — | — |
| `effect_class` | TEXT | no | — | — |
| `state` | TEXT | no | — | — |
| `parent_task_id` | TEXT | yes | — | tasks.id |
| `settings_revision` | INTEGER | no | — | settings_revisions.revision |
| `input_json` | TEXT | no | — | — |
| `result_json` | TEXT | yes | — | — |
| `error_json` | TEXT | yes | — | — |
| `attempt` | INTEGER | no | 0 | — |
| `max_attempts` | INTEGER | no | — | — |
| `available_at` | INTEGER | no | — | — |
| `lease_owner` | TEXT | yes | — | — |
| `scheduler_generation` | INTEGER | yes | — | — |
| `lease_expires_at` | INTEGER | yes | — | — |
| `fence` | INTEGER | no | 0 | — |
| `created_at` | TEXT | no | — | — |
| `updated_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE tasks (
 id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL,
 effect_class TEXT NOT NULL CHECK(effect_class IN('preparation','submission')),
 state TEXT NOT NULL CHECK(state IN('queued','running','waiting_review','blocked','succeeded','failed','cancelled','submitting','unknown')),
 parent_task_id TEXT REFERENCES tasks(id), settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision),
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
 attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0), max_attempts INTEGER NOT NULL CHECK(max_attempts>0),
 available_at INTEGER NOT NULL, lease_owner TEXT, scheduler_generation INTEGER,
 lease_expires_at INTEGER, fence INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

</details>

### template_revisions

Immutable versioned resume layout/configuration. data_json retains exact source and rendering options; future rendering validates the structure.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | TEXT | no | — | primary key |
| `template_id` | TEXT | no | — | — |
| `revision` | INTEGER | no | — | — |
| `data_json` | TEXT | no | — | — |
| `created_at` | TEXT | no | — | — |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE template_revisions (
 id TEXT PRIMARY KEY NOT NULL, template_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 data_json TEXT NOT NULL CHECK(json_valid(data_json)), created_at TEXT NOT NULL, UNIQUE(template_id,revision)
);
```

</details>

### tool_events

Append-only tool execution observations. call_id groups request and result events; sequence is unique within the run. A new event records each state change. Tool inputs/results must be validated/redacted at the tool boundary.

| Column | Type | Nullable | Default | Key/reference |
|---|---|---|---|---|
| `id` | INTEGER | no | — | primary key |
| `run_id` | TEXT | no | — | agent_runs.id |
| `sequence` | INTEGER | no | — | — |
| `call_id` | TEXT | no | — | — |
| `tool_id` | TEXT | no | — | — |
| `tool_version` | TEXT | no | — | — |
| `request_json` | TEXT | no | — | — |
| `result_json` | TEXT | yes | — | — |
| `state` | TEXT | no | — | — |
| `occurred_at` | TEXT | no | — | — |
| `artifact_hash` | TEXT | yes | — | artifacts.hash |

<details><summary>Exact SQL, including checks and unique constraints</summary>

```sql
CREATE TABLE tool_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id),
 sequence INTEGER NOT NULL, call_id TEXT NOT NULL, tool_id TEXT NOT NULL, tool_version TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 state TEXT NOT NULL CHECK(state IN('requested','succeeded','rejected','failed','unknown')),
 occurred_at TEXT NOT NULL, artifact_hash TEXT REFERENCES artifacts(hash), UNIQUE(run_id,sequence)
);
```

</details>

### Database-enforced immutable inputs

```sql
CREATE TRIGGER artifacts_immutable_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER artifacts_immutable_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER attempt_input_immutable BEFORE UPDATE OF id,application_id,idempotency_key,adapter_id,snapshot_id,resume_id,settings_revision,policy_id,manifest_json,preflight_at,created_at ON application_attempts
 BEGIN SELECT RAISE(ABORT,'immutable attempt input'); END;
CREATE TRIGGER attempt_no_delete BEFORE DELETE ON application_attempts BEGIN SELECT RAISE(ABORT,'retain application history'); END;
CREATE TRIGGER attention_input_immutable BEFORE UPDATE OF id,task_id,run_id,artifact_hash,subject_type,subject_id,subject_version,title,detail,context_json,settings_revision,created_at ON attention_items
          BEGIN SELECT RAISE(ABORT,'immutable review input'); END;
CREATE TRIGGER attention_no_delete BEFORE DELETE ON attention_items BEGIN SELECT RAISE(ABORT,'retain review history'); END;
CREATE TRIGGER bullet_revisions_immutable_delete BEFORE DELETE ON bullet_revisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER bullet_revisions_immutable_update BEFORE UPDATE ON bullet_revisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER events_immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER events_immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER job_snapshots_immutable_delete BEFORE DELETE ON job_snapshots BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER job_snapshots_immutable_update BEFORE UPDATE ON job_snapshots BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER profile_revisions_immutable_delete BEFORE DELETE ON profile_revisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER profile_revisions_immutable_update BEFORE UPDATE ON profile_revisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER resume_versions_immutable_delete BEFORE DELETE ON resume_versions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER resume_versions_immutable_update BEFORE UPDATE ON resume_versions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER review_decisions_immutable_delete BEFORE DELETE ON review_decisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER review_decisions_immutable_update BEFORE UPDATE ON review_decisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER run_input_immutable BEFORE UPDATE OF id,task_id,attempt,spawner_provider,spawner_instance,run_directory,persona_text,skills_json,prompt_text,agent,model,tools_json,permissions_json,revision_hashes_json,settings_revision,created_at ON agent_runs
 BEGIN SELECT RAISE(ABORT,'immutable run input'); END;
CREATE TRIGGER run_messages_immutable_delete BEFORE DELETE ON run_messages BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER run_messages_immutable_update BEFORE UPDATE ON run_messages BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER run_no_delete BEFORE DELETE ON agent_runs BEGIN SELECT RAISE(ABORT,'retain run history'); END;
CREATE TRIGGER run_session_once BEFORE UPDATE OF spawner_session_id ON agent_runs
 WHEN OLD.spawner_session_id IS NOT NULL AND NEW.spawner_session_id IS NOT OLD.spawner_session_id
 BEGIN SELECT RAISE(ABORT,'session identity already assigned'); END;
CREATE TRIGGER screening_immutable BEFORE UPDATE ON screening_decisions BEGIN SELECT RAISE(ABORT,'immutable screening decision'); END;
CREATE TRIGGER screening_no_delete BEFORE DELETE ON screening_decisions BEGIN SELECT RAISE(ABORT,'retain screening history'); END;
CREATE TRIGGER settings_revisions_immutable_delete BEFORE DELETE ON settings_revisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER settings_revisions_immutable_update BEFORE UPDATE ON settings_revisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER source_policies_immutable_delete BEFORE DELETE ON source_policies BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER source_policies_immutable_update BEFORE UPDATE ON source_policies BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER task_input_immutable BEFORE UPDATE OF id,kind,effect_class,parent_task_id,settings_revision,input_json,max_attempts,created_at ON tasks
 BEGIN SELECT RAISE(ABORT,'immutable task input'); END;
CREATE TRIGGER task_no_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'retain task history'); END;
CREATE TRIGGER template_revisions_immutable_delete BEFORE DELETE ON template_revisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER template_revisions_immutable_update BEFORE UPDATE ON template_revisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER tool_events_immutable_delete BEFORE DELETE ON tool_events BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER tool_events_immutable_update BEFORE UPDATE ON tool_events BEGIN SELECT RAISE(ABORT,'immutable record'); END;
```
