# Personas, tools and agent invocation (step 7a)

This documents the shared persona convention and the jobs-owned invocation/tool
contract. **Everything here currently ships as placeholders.** The machinery, the
validation and the isolation rules are real and tested; the persona prose, the tool
bridge and the real-agent smoke are not.

Status 2026-09-17: an agent child now receives `OPENROUTER_API_KEY` from
`~/.switchboard/host.json` → `env` (verified after a host restart; see
[JOBS-OPERATIONS.md](../../JOBS-OPERATIONS.md) for where secrets belong). The **tool bridge is
the only remaining blocker** for a real tailoring pass; the real `--mode json` envelope also
still needs verifying against a live CLI.

## What is committed vs machine-local

- **Committed placeholders:** `packages/jobs/personas/<id>/manifest.md` and
  `.../skills/<name>/SKILL.md`. These are examples, not live configuration.
- **Live, machine-local:** `~/.switchboard/personas/` (the `personaDirectory` setting;
  default `~/.switchboard/personas`). The placeholders were copied there on this
  machine; they are **not** fleet-synced and the host daemon never reads them. Only
  jobs snapshots them into a run.
- Personas are read by jobs only. Neither Switchboard nor the future review-loop add-on
  owns this directory.

## Manifest subset

`manifest.md` is YAML frontmatter plus a system-prompt body. The parser is a deliberately
small YAML subset: scalars, inline arrays (`[a, b]`) and one level of nesting.

| Field | Required | Notes |
|---|---|---|
| `schemaVersion` | yes | must be `1` |
| `id` | yes | must equal the directory name; `^[a-z0-9][a-z0-9-]{0,63}$` |
| `name` | yes | display name |
| `description` | yes | one line |
| `agent` | yes | key from the host's `agents.json` (e.g. `pi`) |
| `model` | yes | `provider/model` id passed to the CLI (e.g. `openrouter/deepseek/deepseek-v4.1-flash`) |
| `tools` | no | list of jobs-owned tool ids this persona may call |
| `skills` | no | list of `skills/<name>/SKILL.md` directories to compose |
| `permissions` | no | mapping of booleans (hints only; jobs tools enforce real limits) |
| body | yes | the system prompt |

`SKILL.md` frontmatter: `id` (must equal its directory), `name`, optional
`description`, plus a procedure body.

Rules enforced in code (`src/personas.ts`):

- Ids are path-contained; a persona can never reference a file outside its directory.
- A malformed persona or a missing skill fails **that persona only**; the list and the
  service stay up, and the error is reported per id.
- A missing persona directory is an empty state, not an error.
- The DB snapshot (`persona_text`, `skills_json`, `prompt_text`, `agent`, `model`,
  `tools_json`, `permissions_json`, `revision_hashes_json`) is the historical evidence;
  editing or deleting the files never changes an old run.

## Scoped tools (implemented, not yet model-wired)

`src/tools.ts` implements the assembly tool set against validated library revisions:
`list_templates`, `find_bullets`, `select_bullet`, `order_sections`, `render_preview`,
`finalize_resume`. They reject unknown templates/sections/bullets, duplicate bullets,
slot-limit overflow, invalid section orders and unrenderable drafts. The model can only
choose among existing bullet revisions and bounded layout options; it cannot invent
prose, bullets or markup.

**Not yet done:** these tools are not exposed to a real agent process. To do that, jobs
must provide a **tool bridge** (a pi extension, or a scoped jobs runner) that registers
the tools, executes them against the run's `DraftState`, and records each call in
`tool_events`. Until that exists, the real run cannot call them, and a prompt-only
allowlist must not be presented as an enforced restriction.

## Invocation contract (implemented, unverified against a live CLI)

`src/invocation.ts` defines `AgentInvocationAdapter`. The `pi` adapter builds:

```
pi --model <provider/model> --mode json --no-session --print [--thinking <level>]
   [--extension <bridge>] [--tools <id,id>] @<absolute task file path>
```

The task file carries persona body + skill bodies + task, and states the jobs-owned
result path the model must write its JSON result to. `parse()` is a last-resort stdout
reader; a valid result file always takes precedence. A successful exit with no valid
result artifact is a **failed** stage, never a silent success.

## What must be done for the real ones

1. **Author the real personas.** Replace the placeholder bodies and permissions in
   `~/.switchboard/personas/resume-assembler` and `.../resume-editor` (or add new ids).
   Keep the two-pass split: assembly selects bullets; editing only rewrites prose.
2. **Verify the model id on this machine.** `pi --list-models <search>` and set the
   persona's `model` to a real `provider/model` value. The current placeholder uses
   `openrouter/deepseek/deepseek-v4.1-flash`, which exists in the catalog here.
3. **Confirm the agent is available.** The persona's `agent` must be a key in the host's
   `agents.json` and probe as available on the machine that will spawn it (`pi` is).
   Availability is per machine and never synced.
4. **Build the tool bridge.** Implement the jobs-owned bridge (pi extension or scoped
   runner) that exposes `src/tools.ts` over the run's draft and writes `tool_events`.
   Pass its path as `--extension <bridgePath>` from the invocation adapter. This is the
   single largest remaining piece for a real assembly run.
5. **Confirm the `--mode json` envelope.** Run a real one-shot `pi` invocation and record
   the exact JSON shape; tighten `PiInvocationAdapter.parse()` to it and document it.
   The current parser is permissive and unverified.
6. **Real resume material.** The ledger/library must contain the operator's real facts
   and bullet revisions (and 1–3 real base templates). The placeholders are dummies;
   approved bullets are the only source of resume content.
7. **Run the real two-pass smoke** (step 7b) once 1–5 exist: one application, both passes
   saved, structured output validated, and the actual limitations recorded.

## Verification available now

```sh
npm --prefix packages/jobs run build
node --test --import tsx packages/jobs/test/personas.test.ts packages/jobs/test/tools.test.ts
node packages/jobs/acceptance/personas.mjs
```
## Runner status (step 7b)

`src/runner.ts` now creates tracked agent runs, passes the invocation argv through the
host's literal `extraArgs`, polls retained exit state, validates the result against the
run's exact revisions and persists the build/edit resume versions plus tool events,
messages and a review item. `POST /api/tailoring` triggers the two passes in the
background; `GET /api/runs/:id` shows one run. Both require a private `spawnerToken` in
`service.json` (the host token); without it the route reports `spawner_unconfigured`.

**The remaining blocker for a real run is still item 4 above — the tool bridge.** The
runner sends `--tools <ids>` and an optional `--extension <bridge>`, but no bridge file
exists yet, so a real `pi` process has nothing to execute the tools against. Until that
exists:
- the assembly pass cannot call `list_templates`/`select_bullet`/…, and
- a prompt-only tool list must not be described as an enforced restriction.

Also still unverified: the exact `--mode json` envelope, and any real end-to-end run.
Fake agents (tests) prove the workflow, validation and failure handling; they do not
prove real model behaviour.
