# Browser acceptance

These drive the **built client in a real Chromium** against **real daemons** — no
mocks, no stubs. They cover the parts of the spec that otherwise need a human.

- `ui.mjs` (phase 2): setup screen, session list, new-session modal, attaching to a
  terminal, typing into the pty, reflow on resize, killing a session.
- `multi-host.mjs` (phase 3): three daemons on three ports, a live session on each,
  driving all three from one browser, then `SIGKILL`ing the middle one and checking
  the other two stay fully usable while the third is marked offline. Also covers
  reorder persistence and remove-with-confirmation. It starts nothing itself — see
  the runner below.
- `agent-sync.mjs` (phase 3.5): the `/config/agents` contract (409 on a stale write,
  `?force=1`, malformed maps refused), drift detection, the diff view, sync-all, the
  copyable install hint, and availability flipping on one host only. Give exactly one
  host a `pathPrepend` pointing at `INSTALL_DIR`; the harness drops a fake executable
  there to stand in for installing the CLI on that machine.

Puppeteer is deliberately **not** a declared dependency: it downloads its own
Chromium (~150 MB), which is a steep price on every `npm install` for a tool that is
only needed when running this one script. Install it on demand:

```bash
npm install --no-save --no-package-lock puppeteer
```

## Running it

It needs a daemon and a served client already running, plus that daemon's token:

```bash
export SWITCHBOARD_DIR=/tmp/switchboard-accept     # a throwaway config with a `bash` agent
npm run dev -w @switchboard/host &
npm run build -w @switchboard/web
npx vite preview --port 4173 --host 127.0.0.1 &    # from packages/web

HOST_TOKEN=$(python3 -c "import json;print(json.load(open('$SWITCHBOARD_DIR/host.json'))['token'])") \
HOST_URL=http://127.0.0.1:7788 \
APP_URL=http://127.0.0.1:4173 \
TEST_REPO=$PWD \
OUT_DIR=/tmp \
node packages/web/acceptance/ui.mjs
```

`multi-host.mjs` additionally wants a `HOSTS` env var describing the fleet:

```bash
HOSTS='[{"label":"alpha","url":"http://127.0.0.1:7791","token":"...","pid":1234}, ...]'
```

`pid` is the daemon's process id — the harness kills it to simulate a machine going
down, so resolve it from the listening port (`ss -lptn "sport = :7791"`) rather than
from a shell job id, which would only be the `npx` wrapper.

Screenshots are written to `OUT_DIR`.

## Notes for anyone extending it

- `innerText` reflects CSS `text-transform`, so labels styled `uppercase` come back
  uppercase. Match case-insensitively.
- `click({ clickCount: 3 })` does not reliably clear a controlled React input in
  headless Chrome. Use the `setInput` helper (select-all, delete, type).
- A run deliberately tests a wrong token first, so one `401` in the network log is
  expected. So is the `404` for `/favicon.ico` until the PWA assets land.
- `innerText` does not include the *values* of form inputs. Assert on `el.value`
  through `$$eval` rather than on page text when checking what a field holds.
