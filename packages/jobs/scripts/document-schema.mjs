// Run after jobs:build. Generated section is the actual SQLite schema, not a second definition.
import fs from 'node:fs';
import {openDatabase,SCHEMA_VERSION} from '../dist/database.js';
const file=new URL('../DATABASE.md',import.meta.url), marker='<!-- generated-schema -->';
const notes={
 settings_revisions:'Immutable full settings snapshots and concurrency revisions. See the detailed version-1 description above.',
 artifacts:'Immutable content-addressed file manifest. The digest is also the filename; metadata is committed only after file publication and directory flush.',
 events:'Append-only ordered audit. Subject type/ID are a generic cross-entity reference; callers must supply sanitized payloads without credentials.',
 source_policies:'Immutable per-scope adapter/site restrictions and capabilities. A terms URL or accessible endpoint is not permission to automate. Effective policy must also be bounded by adapter support.',
 sources:'Editable source registry. Disabled by default. adapter_id plus source_key deduplicates a board/company configuration; policy_id selects the current reviewed policy.',
 search_runs:'One discovery execution with pinned settings and a resumable pagination checkpoint; failed runs retain error details.',
 jobs:'Current normalized opportunity projection. dedup_key is canonical identity; historical description/evidence lives in snapshots, not mutable columns here.',
 job_aliases:'Original source identity and URL mapped to a canonical job; source/external ID pairs cannot be duplicated.',
 job_snapshots:'Immutable observed description/capture metadata. Complete application-preflight evidence requires nonempty text and a screenshot reference. capture_json holds viewport, ordered additional images, capture diagnostics and other source-specific evidence; the capture adapter validates that structure.',
 profile_revisions:'Immutable applicant facts and supporting provenance. profile_id identifies the logical profile; revision identifies an exact historical version.',
 bullet_revisions:'Immutable prose plus tags, selection filters and evidence, tied to a specific applicant profile revision. Rewording produces a new revision.',
 template_revisions:'Immutable versioned resume layout/configuration. data_json retains exact source and rendering options; future rendering validates the structure.',
 tasks:'Durable work intent. effect_class distinguishes preparation from submission risk. attempt counts claims; max_attempts includes the initial attempt. fence invalidates stale/cancelled worker results. Lease and available_at values are UTC epoch milliseconds; other timestamps are ISO UTC strings. Input and settings references are immutable.',
 scheduler_lock:'Single active scheduler lease. owner identifies an execution instance; generation increases on replacement. Expiration is not proof that a child or external action stopped.',
 agent_runs:'One child attempt per task/attempt number. Persist intent before spawning. Full persona/skills/prompt/model/tools/permissions/hash snapshots remain in SQLite. Spawner identity is separate from process identity; unavailable is not dead. Session identity is assignable once. State/outcome are mutable, inputs immutable.',
 resume_versions:'Immutable build/edit/render outputs. Parent links preserve both model passes. Exact text is required; a later PDF render creates a new version instead of mutating earlier output. selected_bullets_json retains IDs, revisions and ordering; edits_json records prose changes.',
 applications:'Current per-job application projection; one application record per canonical job, with multiple explicit attempts when appropriate. Transition/policy guards land with workflow callers, not arbitrary SQL updates.',
 application_attempts:'Durable external send intent and outcome. idempotency_key protects local duplicate attempts; it does not guarantee exactly-once website delivery. Manifest, evidence, resume and policy/settings references cannot change after insertion. Receipt/outcome fields retain observed or operator-confirmed evidence.',
 review_decisions:'Immutable approve/deny/request-changes decision against an exact subject version, before/after data and settings policy. A polymorphic subject is validated by its workflow caller.',
 tool_events:'Append-only tool execution observations. call_id groups request and result events; sequence is unique within the run. A new event records each state change. Tool inputs/results must be validated/redacted at the tool boundary.',
 run_messages:'Append-only messages actually exposed by the runner, ordered per run. capture_gap explicitly records unavailable/lost output; never claim unavailable model internals were captured.'
};
notes.attention_items='Durable review inbox. Immutable subject/version/context, task/run/artifact and settings references bind the decision to exact saved inputs. Mutable state/version records resolution or supersession; deleting history is forbidden. Reviews validate current settings and waiting-review task state; approval records a decision but does not dispatch a worker.';
const db=openDatabase(':memory:');
let text=`${marker}\n\n## Schema ${SCHEMA_VERSION}: generated column and constraint reference\n\nGenerated by \`node packages/jobs/scripts/document-schema.mjs\` after building jobs.\nReview source \`src/schema.ts\` and migrations in \`src/database.ts\` alongside this reference.\nMutable JSON payloads are not a substitute for adapter/workflow validation in later stages.\n\n`;
for(const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
 const table=row.name;
 text+=`### ${table}\n\n${notes[table]??''}\n\n| Column | Type | Nullable | Default | Key/reference |\n|---|---|---|---|---|\n`;
 const keys=db.prepare(`PRAGMA foreign_key_list(${table})`).all();
 for(const col of db.prepare(`PRAGMA table_info(${table})`).all()){
  const fk=keys.find(k=>k.from===col.name);
  text+=`| \`${col.name}\` | ${col.type} | ${col.notnull||col.pk?'no':'yes'} | ${col.dflt_value??'—'} | ${col.pk?'primary key':fk?`${fk.table}.${fk.to}`:'—'} |\n`;
 }
 text+=`\n<details><summary>Exact SQL, including checks and unique constraints</summary>\n\n\`\`\`sql\n${row.sql};\n\`\`\`\n\n</details>\n\n`;
}
text+='### Database-enforced immutable inputs\n\n```sql\n';
for(const r of db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all())text+=r.sql+';\n';
text+='```\n';db.close();
const existing=fs.readFileSync(file,'utf8').split(marker)[0];fs.writeFileSync(file,existing+text);
