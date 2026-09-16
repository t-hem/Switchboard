# TODO

Implementation status (2026-09-16): Linux recovery steps 1a–1c are implemented and
verified in isolation; production migration/self-hosted acceptance (1d) is next.
See JOB-APPLICATION-PLAN.md for the staged log. Jobs/review-loop work has not started.

Ordered. #1 subsumes the model setting, so do it before #3.

---

## Architectural rule that governs all of this

Three components: the **host daemon**, the **jobs add-on**, the **review-loop add-on**.
Each must start and serve settings/history with the other two stopped; agent work
waits visibly if its spawner is unavailable. None imports another's source or opens
another's database. Switchboard has no dependency on either add-on.

They are not fully opaque to each other — some things (personas, the spawner contract)
are genuinely shared. Shared things live in a **shared location with no owner**, as
files or as a documented HTTP contract, never as a library one component exports and
another imports.

External integrations use small TypeScript interfaces and factories/registries, with
provider implementations injected into callers. Retain old adapters when adding a new
one; avoid provider branches in workflow code. This applies to sources, applications,
notifications, spawners and agent invocation.

The test to apply when adding anything cross-cutting: *if a different agent-spawning
service replaced the host daemon tomorrow, how much of the add-on would change?* The
answer should be one adapter file. If it's more, the coupling is in the wrong place.

---

## 1. Personas and skills (shared, machine-local)

Replaces "model as a setting" — the persona *is* the setting. Both add-ons need this,
neither should own it.

```
~/.switchboard/personas/<id>/
  manifest.md              frontmatter + system prompt body
  skills/<name>/SKILL.md   frontmatter + procedure body
```

Markdown, not JSON — prompts inside JSON strings are miserable to edit by hand.

Frontmatter on `manifest.md`:

| Field | Purpose |
|---|---|
| `id` | Matches directory name |
| `name` | Display name |
| `agent` | Which CLI to spawn (key from `agents.json`) |
| `model` | Model string passed at spawn |
| `tools` | Registered tool IDs/capabilities made available to this persona |
| `skills` | Skill names to compose into the task file |
| Permission defaults | Hints bounded by operator stage approvals and site policy; never elevate either |
| `description` | One line, for the picker |

How it reaches the agent: the add-on composes persona body + selected skill bodies +
the actual task into **one task file**, and passes that path through the agent's
jobs-owned invocation adapter. That adapter implements actual CLI model/task/tool
arguments or a scoped runner; the existing host has literal argv, not a template engine.
The host daemon never interprets personas. Snapshot full persona, skills, tool schemas/
versions and composed prompt in the add-on DB at run time.

Rules:
- **The host daemon never reads this directory** and doesn't know it exists.
- Each add-on reads it independently. Neither needs the other running.
- Machine-local. Does NOT go through `agents.json` fleet sync. When the review loop
  eventually needs the same personas on another box, that's a file-copy problem to
  solve then.
- A malformed persona fails that persona only — never the add-on, never a session.

Personas needed to start: `resume-assembler`, `resume-editor`; optional advisory
`resume-checker`. Two required resume passes are saved separately. Assembly uses
validated template/bullet/layout tools, editing may rewrite prose. Review gates start
enabled and approvals/denials/edits are logged; only the operator relaxes them.
Later, reusing the identical mechanism: `pr-reviewer`, `fix-worker`.

## 2. Scrape the current model from scrollback (display)

What the UI shows. Survives switching models inside the CLI, which spawn-time tracking
does not. Independent of #1 and #3 — those are launch-side, this is display-side.

- Take the last ~8 KB of the session's ring buffer, strip ANSI escapes.
- Run a list of regexes against it, first match wins.
- Cache per session, re-scrape at most once a minute. Manual refresh button optional.
- Expose as `Session.detected: { model?: string; summary?: string } | null`.
- Render next to the agent name in the session list row; show nothing if no match.

Regexes live in `agents.json` per agent, so a new harness is a config line:

```json
"pi": {
  "cmd": "pi",
  "detect": {
    "model": "(?:model|using)[:\\s]+([\\w./-]+)",
    "summary": "^\\s*Task:\\s*(.+)$"
  }
}
```

Notes:
- A miss shows nothing. Never let a bad regex break the row or the session.
- Cap the regex runtime / input size; this runs on every poll interval.
- Check what each CLI actually prints before writing the patterns — pi, claude,
  codex, gemini all differ.

## 3. `model` on POST /sessions (launch)

Spawn-time selection. Normally supplied by the persona (#1); this is the plumbing
underneath it plus a manual override in the modal.

- `AgentDef` gains `modelArgs?: string[]` as a template, e.g. `["--model","{model}"]`,
  and `models?: string[]` as a suggestion list for the dropdown.
- `POST /sessions` accepts `model?: string`; substitute into `modelArgs`, append to
  base args.
- Modal gets a model input backed by a `datalist` from `models`, free text allowed.

## 4. Modal gaps (small)

`POST /sessions` already accepts and validates these; the UI just never sends them.

- Expose `label` — six sessions in one repo currently render as identical rows.
- Expose `extraArgs`.

## 5. Optional alerting

The Jobs page/inbox is the primary place to see child agents, results and needed actions.
Phone alerts are helpful but not a release prerequisite. Selected initial transport: ntfy HTTP
publish plus phone subscription, behind a `NotificationTransport` interface/factory.
Destination is not configured yet; changing transports must leave workflow code intact.

- Needs-input, ready-for-review and terminal failures can form a periodic digest.
- Keep records/resumes in the Jobs inbox; alerts contain a count/category and token-free link.
- Sender belongs to the add-on, never the host. Delivery failure is non-fatal.
- Test locally: disabled transport, batching, retry and restart without a message flood.
- Mandatory priority: crash either/both services, reconnect surviving children, record
  deaths and safely retry preparation with linked history. Submission ambiguity never
  triggers a blind retry. Repeat this at final acceptance.

Details and current operator decisions: [JOB-APPLICATION-PLAN.md](./JOB-APPLICATION-PLAN.md).
Source research: [JOB-SOURCES-RESEARCH.md](./JOB-SOURCES-RESEARCH.md).

---

## Deferred / don't do yet

- Per-agent `env` on `AgentDef`. Only needed if a CLI takes its model or provider via
  environment variable rather than a flag. Check pi's help output first. If added:
  model names in `agents.json` is fine, API keys stay in `host.json` (agents.json
  syncs to every machine).
- Don't auto-reap exited sessions. Both add-ons poll `GET /sessions` for
  `status: "exited"` to know a run finished.
- Keep `POST /sessions` claim-free on purpose — add-ons spawn sessions without a
  browser, and claim-gating it would evict whatever you're sitting in front of.
  Worth a comment in the code so it doesn't get "fixed" later.
- Persona sync across machines. Machine-local until the review loop actually needs it.
