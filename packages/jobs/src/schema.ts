/** Version 2 domain schema. Every historical input/output is retained, not overwritten. */
export const workflowSchema = `
CREATE TABLE artifacts (
 hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
 mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
 relative_path TEXT NOT NULL UNIQUE CHECK(relative_path='artifacts/'||hash),
 created_at TEXT NOT NULL, purpose TEXT NOT NULL
);
CREATE TABLE events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL,
 kind TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);
CREATE INDEX events_subject ON events(subject_type,subject_id,id);
CREATE TABLE source_policies (
 id TEXT PRIMARY KEY NOT NULL, scope_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 adapter_id TEXT NOT NULL, site_url TEXT NOT NULL, terms_url TEXT, reviewed_at TEXT,
 capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
 restrictions_json TEXT NOT NULL CHECK(json_valid(restrictions_json)), created_at TEXT NOT NULL,
 UNIQUE(scope_key,revision)
);
CREATE TABLE sources (
 id TEXT PRIMARY KEY NOT NULL, adapter_id TEXT NOT NULL, source_key TEXT NOT NULL,
 config_json TEXT NOT NULL CHECK(json_valid(config_json)), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 policy_id TEXT REFERENCES source_policies(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(adapter_id,source_key)
);
CREATE TABLE search_runs (
 id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id),
 settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision),
 state TEXT NOT NULL CHECK(state IN('queued','running','completed','failed','blocked')),
 checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
 created_at TEXT NOT NULL, finished_at TEXT, error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json))
);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY NOT NULL, canonical_url TEXT NOT NULL, dedup_key TEXT NOT NULL UNIQUE,
 company TEXT NOT NULL, title TEXT NOT NULL, location TEXT,
 normalized_json TEXT NOT NULL CHECK(json_valid(normalized_json)),
 discovered_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE INDEX jobs_company ON jobs(company);
CREATE TABLE job_aliases (
 id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id), source_id TEXT NOT NULL REFERENCES sources(id),
 external_id TEXT NOT NULL, original_url TEXT NOT NULL, discovered_at TEXT NOT NULL,
 UNIQUE(source_id,external_id)
);
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
CREATE TABLE profile_revisions (
 id TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 data_json TEXT NOT NULL CHECK(json_valid(data_json)), evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 created_at TEXT NOT NULL, UNIQUE(profile_id,revision)
);
CREATE TABLE bullet_revisions (
 id TEXT PRIMARY KEY NOT NULL, bullet_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 profile_revision_id TEXT NOT NULL REFERENCES profile_revisions(id), prose TEXT NOT NULL,
 tags_json TEXT NOT NULL CHECK(json_valid(tags_json)), filters_json TEXT NOT NULL CHECK(json_valid(filters_json)),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at TEXT NOT NULL, UNIQUE(bullet_id,revision)
);
CREATE TABLE template_revisions (
 id TEXT PRIMARY KEY NOT NULL, template_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 data_json TEXT NOT NULL CHECK(json_valid(data_json)), created_at TEXT NOT NULL, UNIQUE(template_id,revision)
);
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
CREATE INDEX tasks_ready ON tasks(state,available_at,created_at);
CREATE TABLE scheduler_lock (
 name TEXT PRIMARY KEY NOT NULL CHECK(name='main'), owner TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0), lease_expires_at INTEGER NOT NULL
);
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
CREATE TABLE applications (
 id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
 state TEXT NOT NULL CHECK(state IN('discovered','captured','screened','tailoring','preparing','review_required','approved','submitting','submitted','rejected','skipped','needs_input','retryable_failure','terminal_failure','cancelled','submission_unknown')),
 selected_resume_id TEXT REFERENCES resume_versions(id), policy_id TEXT REFERENCES source_policies(id),
 settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision),
 block_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
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
CREATE TABLE review_decisions (
 id TEXT PRIMARY KEY NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, subject_version TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN('approve','deny','request_changes')), reason TEXT,
 before_json TEXT NOT NULL CHECK(json_valid(before_json)), after_json TEXT NOT NULL CHECK(json_valid(after_json)),
 settings_revision INTEGER NOT NULL REFERENCES settings_revisions(revision), created_at TEXT NOT NULL
);
CREATE TABLE tool_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id),
 sequence INTEGER NOT NULL, call_id TEXT NOT NULL, tool_id TEXT NOT NULL, tool_version TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 state TEXT NOT NULL CHECK(state IN('requested','succeeded','rejected','failed','unknown')),
 occurred_at TEXT NOT NULL, artifact_hash TEXT REFERENCES artifacts(hash), UNIQUE(run_id,sequence)
);
CREATE TABLE run_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id), sequence INTEGER NOT NULL,
 role TEXT NOT NULL, content_json TEXT NOT NULL CHECK(json_valid(content_json)),
 occurred_at TEXT NOT NULL, capture_gap TEXT, UNIQUE(run_id,sequence)
);
CREATE TRIGGER task_no_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'retain task history'); END;
CREATE TRIGGER task_input_immutable BEFORE UPDATE OF id,kind,effect_class,parent_task_id,settings_revision,input_json,max_attempts,created_at ON tasks
 BEGIN SELECT RAISE(ABORT,'immutable task input'); END;
CREATE TRIGGER run_no_delete BEFORE DELETE ON agent_runs BEGIN SELECT RAISE(ABORT,'retain run history'); END;
CREATE TRIGGER attempt_no_delete BEFORE DELETE ON application_attempts BEGIN SELECT RAISE(ABORT,'retain application history'); END;
CREATE TRIGGER attempt_input_immutable BEFORE UPDATE OF id,application_id,idempotency_key,adapter_id,snapshot_id,resume_id,settings_revision,policy_id,manifest_json,preflight_at,created_at ON application_attempts
 BEGIN SELECT RAISE(ABORT,'immutable attempt input'); END;
CREATE TRIGGER run_input_immutable BEFORE UPDATE OF id,task_id,attempt,spawner_provider,spawner_instance,run_directory,persona_text,skills_json,prompt_text,agent,model,tools_json,permissions_json,revision_hashes_json,settings_revision,created_at ON agent_runs
 BEGIN SELECT RAISE(ABORT,'immutable run input'); END;
CREATE TRIGGER run_session_once BEFORE UPDATE OF spawner_session_id ON agent_runs
 WHEN OLD.spawner_session_id IS NOT NULL AND NEW.spawner_session_id IS NOT OLD.spawner_session_id
 BEGIN SELECT RAISE(ABORT,'session identity already assigned'); END;
`;
export const immutableTables = ["settings_revisions","artifacts","events","source_policies","job_snapshots",
  "profile_revisions","bullet_revisions","template_revisions","resume_versions","review_decisions","tool_events","run_messages"];
