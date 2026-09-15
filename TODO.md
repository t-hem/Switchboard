# TODO — model selection + display

Two separate pieces. They're independent; the scrape is the one that matters for
"what am I tabbing to."

## 1. Scrape the current model from scrollback (display)

The source of truth for what's shown in the UI. Survives switching models inside the
CLI, which spawn-time tracking does not.

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

## 2. `model` on POST /sessions (launch)

Spawn-time selection so you don't have to set it inside the CLI every time. This is
a launch argument, NOT the display source — #1 is what the UI shows.

- `AgentDef` gains `modelArgs?: string[]` as a template, e.g. `["--model","{model}"]`,
  and `models?: string[]` as a suggestion list for the dropdown.
- `POST /sessions` accepts `model?: string`; substitute into `modelArgs`, append to
  base args.
- Modal gets a model input backed by a `datalist` from `models`, free text allowed.

## 3. Modal gaps (small, blocks the above)

`POST /sessions` already accepts and validates these; the UI just never sends them.

- Expose `label` — six sessions in one repo currently render as identical rows.
- Expose `extraArgs`.

## Deferred / don't do yet

- Per-agent `env` on `AgentDef`. Only needed if a CLI takes its model or provider via
  environment variable rather than a flag. Check pi's help output first. If added:
  model names in `agents.json` is fine, API keys stay in `host.json` (agents.json
  syncs to every machine).
- Don't auto-reap exited sessions. The later PR pipeline needs to poll
  `GET /sessions` for `status: "exited"` to know a fix session finished.
- Keep `POST /sessions` claim-free on purpose — the pipeline spawns sessions without
  a browser, and claim-gating it would evict whatever you're sitting in front of.
  Worth a comment in the code so it doesn't get "fixed" later.
