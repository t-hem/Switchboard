# Installed Pi extensions — what each one actually does

This is a description of the **pi coding agent extensions installed on this machine**
(`~/.pi/agent/settings.json`), not of Switchboard. Switchboard never imports them; per
`switchboard-spec.md` §2 the daemon and web client stay out of that business, and the
jobs/review apps talk to Switchboard over HTTP. Nothing here is a Switchboard dependency.

24 packages as of 2026-09-21, pi `0.85.1`. Every claim below was read out of the
installed package — its `pi` manifest and its `registerCommand` / `registerTool` /
`registerShortcut` / `.on(...)` calls — not from a store listing. Where a package
contributes files rather than code (themes), the directory is counted.

**The `pi` manifest is the authority on what loads.** A package can ship commands that
never appear if its manifest points elsewhere, which is why this file lists the manifest
entry points it was read from.

## Managing them without uninstalling

```bash
pi list                      # what is installed, and where it resolves from
pi config                    # TUI to enable/disable individual resources
                             # (Tab switches between user and project scope)
pi remove <source>           # uninstall
pi install <source>          # install (adds to settings)
pi update --extensions       # update; note git sources pinned with @<sha> stay put
```

Disabling through `pi config` is the reversible option and is what to reach for when
diagnosing a rendering or startup problem — it leaves settings and caches in place.

---

## Quick reference

| Package | Version | Adds | Notes |
|---|---|---|---|
| `pi-subagents` | 0.70.1 | `subagent`, `bg_wait`, `subagent_supervisor` tools; ~19 `/subagents*` commands; 2 skills | The delegation engine. Biggest surface by far. |
| `pi-web-access` | 0.30.0 | `web_search`, `fetch_content`, `get_search_content`, `source_check` tools; `/websearch`, `/curator`, `/search`, `/google-account` | Needs a search-provider API key; optional browser curator. |
| `pi-mcp-adapter` | 2.35.0 | `mcp`, `mcpScript` tools; `/mcp-auth` | MCP gateway: installs servers by URL, OAuth, keyring. |
| `pi-memory-md` | 0.1.38 | `tape_*` (8) and `memory_*` (7) tools; 6 `/memory-*` commands; 4 skills | Persistent memory in a git repo; `memory_sync` can pull/push. |
| `pi-interactive-shell` | 0.16.0 | `interactive_shell` tool; `/spawn`, `/attach`, `/dismiss`; 1 skill | Drives TUI CLIs (pi, claude, codex, cursor) in overlays. |
| `pi-ask-user` | 0.15.0 | `ask_user` tool; 1 skill | The multiple-choice prompt you get asked questions with. |
| `pi-prompt-template-model` | 0.12.2 | `/chain-prompts`, `prompt-tool`; 1 skill | Per-template model/thinking selection. |
| `plannotator` | 0.27.17 | `/plannotator-plan-mode`, `-review`, `-annotate`, `-last`; 1 skill | Local review UI for plans, diffs, messages. |
| `@devkade/pi-plan` | 0.2.2 | `/plan`, `/todos`; widgets | Read-only plan mode + approval gate (`/plan` is what switches this agent out of YOLO). |
| `pi-manage-todo-list` | 0.4.0 | `manage_todo_list` tool; `/todos` | Task list widget. **Was pinned to v0.2.0, which crashed narrow terminals; unpinned 2026-09-21.** |
| `pi-ralph-wiggum` | 0.2.3 | `ralph_start`, `ralph_done` tools; `/ralph`, `/ralph-stop`; 1 skill | Bounded multi-iteration loops. |
| `pi-autoresearch` | 1.8.1 | `/autoresearch`; 3 skills | Experiment loop scaffolding. |
| `pi-btw` | 0.5.0 | 8 `/btw*` commands; 1 skill | Side conversations that can be injected back. |
| `pi-add-dir` | 1.3.1 | `add_directory`, `search_external_files` tools; `/add-dir`, `/dirs`, `/remove-dir`, `/suggest-dirs` | Pulls another project's context in. |
| `pi-slopchop` | 0.10.1 | `/slopchop`, `/diff` | Terminal code-review/annotation app with its own highlighter. |
| `pi-simplify` | 0.2.3 | `/simplify` | Reviews uncommitted/staged changes for clarity. |
| `pi-usage` | 0.9.4 | `/usage` | Token/cost dashboard. Also loaded inside powerbar. |
| `pi-raw-paste` | 0.1.3 | `/paste` | One-shot raw paste. |
| `pi-claude-cli` | 0.3.1 | A provider | Routes model calls through the Claude Code CLI. |
| `pi-powerbar` | 0.16.0 | Status-bar widget + footer | Loads `@juanibiapina/pi-usage` internally. |
| `pi-extension-settings` | 0.10.0 | `/extension-settings`, `/extension-settings-local` | Central settings store other extensions read. |
| `@victor-software-house/pi-curated-themes` | 0.2.1 | 65 themes + 1 skill | Also ships a theme-adaptation skill. |
| `@javiportillo/pi-hackerman` | 0.3.0 | 2 themes | Pinned by commit. Themes only. |
| `pi-terminal-theme` | 0.2.0 | 2 themes | ANSI 0–15 based; tinted variant. |

---

## Session and orchestration

### `pi-subagents` 0.70.1 — the delegation engine

The largest thing installed. Tools: `subagent` (one child, a scripted workflow, or a
named workflow), `bg_wait`, `subagent_supervisor`. Around nineteen commands including
`/subagents`, `/subagents-fleet`, `/subagents-detach`, `/subagents-steer`,
`/subagents-models`, `/subagents-doctor`, `/subagents-profiles`, `/subagents-watchdog`.
Skills: `pi-subagents` and `council-mode`.

It also carries the policy text you see in its tool description: parent execution is the
default, delegation needs operator authorisation, workflow failure is a lane blocker
rather than a reason to fall back to `interactive_shell`. Async is the default; a
finished async run wakes the session natively.

### `pi-interactive-shell` 0.16.0

Tool `interactive_shell` with modes `interactive`, `hands-free`, `dispatch`, `monitor`;
commands `/spawn`, `/attach`, `/dismiss`. Runs external coding-agent CLIs in an overlay,
with structured monitoring (stream / poll-diff / file-watch triggers). Reads
`TYPESAFE_API_KEY`.

### `@devkade/pi-plan` 0.2.2

`/plan` toggles read-only plan mode with an approval gate; `/todos` shows a widget. This
is the extension behind the "DEFAULT MODE: YOLO" and `/plan` behaviour in this agent's
own instructions.

### `pi-manage-todo-list` 0.4.0

`manage_todo_list` plus `/todos`. Renders the todo list above the editor. Version 0.2.0
returned widget lines without truncating them, so pi aborted (`Rendered line N exceeds
terminal width`) on any terminal narrower than the longest task title — reproduced at 46
columns on a phone. 0.4.0 truncates with `truncateToWidth`. Upstream now recommends
`pi-tasks` as the successor.

### `@tmustier/pi-ralph-wiggum` 0.2.3 / `pi-autoresearch` 1.8.1

Both drive repeated passes. Ralph gives `ralph_start` / `ralph_done` and `/ralph`;
autoresearch gives `/autoresearch` plus three skills for setting up, hooking and
finalising an experiment loop.

### `pi-btw` 0.5.0

Side conversations: `/btw` and seven related commands, a widget for the side thread, and
skill guidance on injecting a tangent back into the main thread.

---

## Input, UI and rendering

### `pi-ask-user` 0.15.0

The `ask_user` tool and its skill. Renders a boxed, searchable selection overlay. That
overlay's background is xterm colour 17 (`#00005f`) — the blue in the resize-flash
investigation (see `TESTING.md`).

### `@juanibiapina/pi-powerbar` 0.16.0

Persistent powerline status bar (`setWidget` plus `setFooter`), rebuilt from events:
`session_start`, `model_select`, `turn_end`. Its manifest loads
`node_modules/@juanibiapina/pi-usage/index.ts` as a second extension, so the usage
dashboard ships inside powerbar as well as standalone. The coloured context bars in the
footer are its doing.

### `@tmustier/pi-usage-extension` 0.9.4 (`pi-usage`)

`/usage`: token, cost and context dashboard with graphs.

### `@tmustier/pi-raw-paste` 0.1.3

`/paste` — paste once without triggering the usual input handling.

### `pi-claude-cli` 0.3.1

Registers a provider so model calls go through the Claude Code CLI instead of an HTTP
API. It reads no API-key env vars of its own; it inherits whatever `claude` is
authenticated with. Useful when a Claude subscription should pay for the tokens.

### `@juanibiapina/pi-extension-settings` 0.10.0

Not a feature so much as plumbing: `/extension-settings` and
`/extension-settings-local` provide the settings UI other extensions read from
(`~/.pi/agent/settings-extensions.json`, `.pi/settings-extensions.json`).

---

## Research, memory and review

### `pi-web-access` 0.30.0

Tools `web_search`, `fetch_content`, `get_search_content`, `source_check`; commands
`/websearch`, `/curator`, `/search`, `/google-account`; a widget for the interactive
curator. Providers are chosen by env: `BRAVE_API_KEY`, `ANYSEARCH_API_KEY`,
`BOCHA_API_KEY`, `BRIGHTDATA_API_KEY` (+ zones), `DATALAB_API_KEY`, `CRAWL4AI_BASE_URL`
/`CRAWL4AI_API_TOKEN`. With none set it falls back to a local/private provider. The
`.nvmrc`/Node question matters here: it also honours `PI_WEB_ACCESS_DISABLE_NODE_SQLITE`.

### `pi-memory-md` 0.1.38

Two families of tools — `tape_*` (`tape_read`, `tape_search`, `tape_info`,
`tape_handoff`, `tape_delete`, `tape_reset`, `tape_thread`, `tape_list`) and `memory_*`
(`memory_search`, `memory_check`, `memory_read`, `memory_write`, `memory_list`,
`memory_init`, `memory_sync`) — plus six `/memory-*` commands and four skills
(`memory-import`, `memory-init`, `memory-write`, `memory-digest`). Backed by a git
repository; `memory_sync` can pull or push, so it touches the network.

### `pi-mcp-adapter` 2.35.0

The MCP gateway: tools `mcp` (status/search/describe/install/auth/call) and `mcpScript`
(batched calls in one JavaScript request), plus `/mcp-auth`. Owns OAuth flows, an OS
keyring (`MCP_OAUTH_DIR`, `MCP_OAUTH_CALLBACK_PORT`), and can load MCP servers declared
by npm packages.

### `plannotator` 0.27.17

`/plannotator-plan-mode`, `/plannotator-review`, `/plannotator-annotate`,
`/plannotator-last` and a skill. Opens a local web app for reviewing plans, diffs and
the last assistant message, with the decision written back into the session.

### `pi-slopchop` 0.10.1 / `pi-simplify` 0.2.3

`/slopchop` and `/diff` give a terminal-native review app with its own JSON/markdown
highlighter; `/simplify` reviews uncommitted or staged changes for clarity and
maintainability. Both only read a diff and comment — neither writes code.

---

## Adding context

### `pi-add-dir` 1.3.1

Tools `add_directory` and `search_external_files`; commands `/add-dir`, `/dirs`,
`/remove-dir`, `/suggest-dirs`. Loading an external directory injects its `AGENTS.md`,
`CLAUDE.md` and skills into the session.

### `pi-prompt-template-model` 0.12.2

`/chain-prompts` and a `prompt-tool`, plus a skill. Lets a prompt template pick its own
model and thinking level, and run deterministic pre-steps before the model sees the
prompt.

---

## Themes

| Package | Themes | Contents |
|---|---|---|
| `@victor-software-house/pi-curated-themes` 0.2.1 | 65 | Ports of iTerm2-Color-Schemes, plus the `adapt-ghostty-theme-to-pi` skill |
| `@javiportillo/pi-hackerman` 0.3.0 | 2 | `hackerman`, `hackerman-ultra` |
| `pi-terminal-theme` 0.2.0 | 2 | `terminal`, `terminal-tinted` — built on ANSI 0–15 |

Theme packages register nothing; they are file trees. The active theme lives in
`~/.pi/agent/settings.json` — currently a local file, `dark-plain`, under
`~/.pi/agent/themes/`: Pi's built-in `dark` palette with all message/card
backgrounds blanked out (see README.md for why).

---

## Configuration and secrets

- **Search**: `pi-web-access` is the only package here that needs a provider key to be
  useful. Put it in your shell environment (or Switchboard's `host.json` → `env` for
  agent sessions launched from Switchboard — never in `agents.json`, which is synced
  fleet-wide).
- **MCP**: `pi-mcp-adapter` stores OAuth tokens in the OS keyring, not in settings.
- **Memory**: `pi-memory-md` writes to a git repository and can push it.
- **Claude CLI**: `pi-claude-cli` uses the `claude` binary's own auth.
- Nothing else in this list reads an API key from the environment.

## What is actually load-bearing

- `pi-subagents`, `pi-ask-user`, `pi-web-access`, `pi-mcp-adapter`, `pi-add-dir`,
  `pi-prompt-template-model` and `pi-interactive-shell` are the ones whose tools appear
  in this agent's own tool list; removing them removes capabilities, not just chrome.
- `@juanibiapina/pi-extension-settings` is a soft dependency of other extensions'
  settings UIs.
- `pi-powerbar` + `pi-usage` are display only. Powerbar re-registers its widget or
  calls `requestRender()` on every refresh, which happens on segment updates including
  each `turn_end` and `model_select` — worth remembering the next time the TUI is
  suspected of flickering.
- The three theme packages are inert.

## Known issue: the resize flash

A card's background briefly paints across the full terminal width when pi repaints after
a resize, then settles — a flash. It is in the pane content that tmux holds (measured:
four rows at 100% background width for ~9–24 ms after a resize, both for pi's own green
tool cards and for the `pi-ask-user` blue overlay), so it is pi's rendering, not
Switchboard's paint path, and it is shared by every client. Switchboard shows it for
longer than a plain terminal would because its frames are snapshots taken on a cadence
rather than the pane's own 10 ms repaint. Not fixed as of pi 0.86.1, and no changelog
entry mentions it. `packages/web/acceptance/resize-flash.mjs` reproduces it on demand;
`TESTING.md` § *Resize flashes* has the detail.