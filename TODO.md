# TODO

Implementation status (2026-09-16): Linux recovery steps 1a–1d are implemented,
verified and deployed, including a real coding-agent self-restart. Jobs steps 2–6 are
complete and verified on Linux: isolated scaffold, persistence, dashboard/review UI,
posting import/capture with archived evidence, and the versioned career library with
bullet-based structured resume rendering (PDF deferred by operator decision). Step 7a
(persona loading/validation, scoped tools and invocation contract) and 7b (the two-pass
runner with tracked runs, result validation, resume versions and review items) are
complete with **placeholder** personas/tools at model
`openrouter/deepseek/deepseek-v4.1-flash`; 7c added the generic host `idempotencyKey`
(`POST /sessions`) plus jobs-side rediscovery and superseded-result refusal; step 8 added
discovery scheduling with paginated checkpoints and explainable, non-converting screening
(schema 4). Step 9 (application preparation and review package) is next.
See JOB-APPLICATION-PLAN.md for the staged log. Review-loop implementation has not started.
See IMPLEMENTATION-HANDOFF.md, packages/jobs/PERSONAS.md (what the real personas/tools
still need) and packages/jobs/DATABASE.md for current code/schema details.

Stage work happens on branches (a second agent joined; master previously held all
commits directly): `step4-jobs-dashboard`, `step5-posting-capture`,
`step6-resume-library`, `step7a-personas-tools`, `step7b-tailoring-runner`,
`step7c-provider-registry`, `step7c-spawner-recovery`, `step8-search-filtering`, each
stacked on the previous. Do not work directly on master; merge a verified stage branch
when it is reviewable.

Connectors stay swappable: implement the interface, register the implementation, change
the setting. No provider branches in workflow code, and Switchboard and the add-ons
remain black boxes to each other (no cross-imports). Recipe:
packages/jobs/README.md.

Ordered. #1 subsumes the model setting, so do it before #3.

## Low-priority display defects

- **Desktop resize/zoom reformatting delay (2026-09-16):** Desktop formatting
  settles correctly, but initially looks narrow/mobile-like and visibly lags after
  resizing or desktop browser zoom. User clarified that the resize delay is not
  present on the phone. Potential contributors in the shared display path: the
  client's 150 ms resize debounce, up to 100 ms of host snapshot batching, and the
  application's resize/redraw plus capture/render time; these do not yet explain
  the desktop/phone difference. Initial attachment also waits for a capture matching
  the new geometry. User prefers preserving working
  typing, scrolling, and wrapping over aggressive timing changes. Revisit with
  measured resize-to-paint latency and regression checks before optimizing.

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

**This is the actual feature.** The requirement was a model label on the tab so you can
tell a pi/deepseek session from a pi/local-qwen one without tabbing in. The scrape
delivers that with nothing to maintain, and stays correct when the model is switched
mid-session — which launch-time tracking never is. #3 exists for programmatic spawning,
not for this.

- Take the last ~8 KB of the session's ring buffer, strip ANSI escapes.
- Run a list of regexes against it, first match wins.
- Re-scrape at most once a minute. Manual refresh button optional.
- Expose as `Session.detected: { model?: string; summary?: string } | null`.
- Render next to the agent name in the session list row; show nothing if no match.

**Cache stickily.** Most CLIs print the model once at startup, so an 8 KB tail loses it
as soon as the session scrolls. Keep the last known value when a later pass finds no
match, rather than clearing it. A mid-session switch still updates the label when it is
announced, and a long scrollback does not blank it. Without this the feature silently
stops working on exactly the long-running sessions it is most useful for.

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

Deliberately minimal. This exists so a persona can declare `model: deepseek-v3` and an
add-on can spawn with it programmatically — it is NOT how the UI label works (#2 is).

- `AgentDef` gains `modelArgs?: string[]` as a template, e.g. `["--model","{model}"]`.
- `POST /sessions` accepts `model?: string`; substitute into `modelArgs`, append to
  base args.
- Modal: free-text field or nothing at all. No dropdown.

**Explicitly rejected: a `models?: string[]` suggestion list.** It buys a saved
keystroke and costs a hand-maintained list that goes stale every time a provider ships
a model — `agy models` alone changed substantially in a week. For the two or three
models actually used interactively, extra `agents.json` entries sharing one binary
(`antigravity-opus`, `antigravity-flash`) are less machinery than a dropdown and give
distinguishable session rows for free.

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

## 6. Low priority — hand-edited `agents.json` is not picked up

`loadAgentsConfig()` runs once when the registry is constructed at startup; the only
reload is inside the `PUT /config/agents` handler. Nothing watches the file, so editing
it by hand does nothing visible until a daemon restart or a save through Settings.

- Workaround today: restart the daemon, or bump `updatedAt` and save via Settings.
- Fix: watch the file (debounced), validate with `parseAgentsPayload`, reload in place
  on success, log and keep the previous map on failure. A bad hand-edit must never take
  the daemon's agent list down.
- Related hazard worth a note in the README either way: a hand-edit that does not bump
  `updatedAt` looks *older* than other hosts' copies, so the next client sync can push
  another machine's version over it. Drift detection compares only that timestamp.

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
