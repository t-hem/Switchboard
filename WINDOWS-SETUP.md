# Windows setup — for an agent session running on the Windows machine

You are on a **Windows machine** joining a Switchboard fleet. Your job is to get this
machine's **host daemon** built, running and served over the tailnet, then work the
Windows verification checklist and report what breaks.

Read [`switchboard-spec.md`](./switchboard-spec.md) before changing any code. Its §2
"Non-goals" list is binding. Most of this task is setup and verification, not code —
if you find yourself writing a feature, stop and report instead.

## The fleet

| Machine | OS | Role |
|---|---|---|
| `thomas-ai-machine` | Linux | Daemon **and** serves the web client (always-on) |
| Laptop | Windows 11 | Daemon only |
| `desktop-icu1edp` | Windows 10 | Daemon only |
| Phone | — | Client only, no daemon |

Tailnet is `tail0f855c.ts.net`. The web client lives at
`https://thomas-ai-machine.tail0f855c.ts.net` — you do **not** build or serve the
client on this machine, only the daemon.

**This machine has never run this code.** Every Windows path in the daemon was written
by reading node-pty's source, not by executing it. Assume you are the first to find
the bugs, and read "When it breaks" below before you start guessing.

## Rules you must not break

- **Never put an absolute path in `agents.json`.** It is synced verbatim to every
  machine in the fleet, so a path that is right here is wrong everywhere else. If the
  daemon can't find an agent binary, the fix is `pathPrepend` in *this machine's*
  `host.json`. Bare commands only in `agents.json` (`"cmd": "claude"`).
- **Never transmit the token in `host.json`** anywhere except to Thomas, who enters it
  in his browser. It is per-machine and never part of any sync payload.
- **Never execute an agent's `install` string.** It is display-only.
- An agent that is configured but not installed is a **normal state**, not a bug.

## 1. Prerequisites

```powershell
winget install OpenJS.NodeJS.LTS       # Node 22+ required
winget install Git.Git
```

**No C++ toolchain is needed.** `node-pty` 1.1.0 ships prebuilt Windows binaries
(`prebuilds/win32-x64`) and its install script tries those before falling back to
node-gyp, so VS Build Tools and Python are not prerequisites — verified on a bare
Windows 10 box, where `npm install` never invoked node-gyp. Only install the ~6GB of
Build Tools if `npm install` actually falls through to a compile.

Neither Node nor Git needs elevation: if this shell is not elevated, portable extracts
under something like `C:\Apps\tools` added to the user PATH work fine.

Verify in a **new** terminal (PATH changes need one):

```powershell
node -v      # must be v22+
git --version
```

Confirm Tailscale is installed, signed in as `hemming.thomas@`, and that this machine
shows up in `tailscale status`.

**Windows 10 only:** check `winver`. node-pty uses ConPTY, which needs build 1809 or
newer. If this machine has been powered off a long time, install pending Windows
updates first.

## 2. Clone and install

```powershell
git clone git@github.com:t-hem/Switchboard.git
cd Switchboard
npm install
```

`npm install` compiling `node-pty` is the first real test. If it fails, the C++
workload is missing or Node is too old. Fix that before going further.

## 3. Start the daemon and check what it found

```powershell
npm run dev:host
```

First run creates `%USERPROFILE%\.switchboard\` with `host.json` and `agents.json`,
and **prints the token once**. Save it — Thomas needs it to add this host.

In a second terminal:

```powershell
curl http://localhost:7777/health
```

Expect JSON with `hostLabel`, `platform: "win32"` and an `agents` array:

- `claude` and `codex` should be `available: true` **if** installed here. If they
  aren't, install them — they are what the fleet is being tested with.
- `pi` and `gemini` showing `available: false` is **expected and correct**. Thomas
  hasn't set up pi/OpenRouter yet. Don't install them, don't "fix" this.

If `claude` or `codex` reports unavailable but you know it's installed, it's a PATH
problem — npm global installs live under the *active* Node version's bin directory.
Add that directory to `pathPrepend` in `host.json`:

```json
{ "pathPrepend": ["C:\\Users\\<you>\\AppData\\Roaming\\npm"] }
```

Not to `agents.json`. See the rules above.

## 4. Set `host.json`

Edit `%USERPROFILE%\.switchboard\host.json`. Give `hostLabel` something that
identifies this machine in a merged list (`laptop`, `desktop-win10`), and point
`workspaceRoots` at where repos actually live here. **Backslashes must be doubled** —
it's JSON:

```json
{
  "port": 7777,
  "hostLabel": "laptop",
  "workspaceRoots": ["C:\\dev", "C:\\projects"],
  "pathPrepend": [],
  "env": {}
}
```

Leave `token` alone. Restart the daemon, then confirm the directory picker's source:

```powershell
curl -H "Authorization: Bearer <token>" http://localhost:7777/workspaces
```

An empty list means `workspaceRoots` points somewhere that doesn't exist, or holds no
directories containing a `.git`.

## 5. Serve the daemon over HTTPS

The client is served over `https://`, and a page loaded over HTTPS **cannot** reach a
plain `http://` daemon — browsers block it as mixed content with no useful error, and
the symptom is this host silently showing as offline forever.

```powershell
tailscale serve --bg --https=8443 7777
tailscale serve status
```

That yields `https://<machine>.tail0f855c.ts.net:8443`. Report that URL and the token
to Thomas so he can add the host.

Nothing goes on `tailscale funnel` — this is tailnet-only.

## 6. Work the Windows checklist

[`TESTING.md`](./TESTING.md) §1 is authoritative and explains *why* each item is
risky. Work it top to bottom and report results item by item:

- [ ] `npm install` installs `node-pty` (prebuilt binary, no compile)
- [ ] Daemon starts; `/health` lists agents and doesn't crash on the missing ones
- [ ] Availability probe finds `.cmd` shims (resolved via `PATHEXT`)
- [ ] **Spawning a `.cmd` agent** — the likely blocker, see below
- [ ] `DELETE /sessions/:id` actually kills it — confirm in Task Manager
- [ ] Ctrl-C reaches the agent through the `cmd.exe` layer rather than being swallowed
- [ ] Orphan recovery: end the daemon from **Task Manager** (not Ctrl-C), restart,
      confirm it reports survivors, then *Kill all* and confirm they are really gone
- [ ] `%USERPROFILE%\.switchboard\sessions.json` holds `win32:<ticks>` per entry
- [ ] Drive-letter paths work — start a session in `C:\...` and confirm the picker

**Test the `.cmd` path deliberately.** If `claude` came from the native Windows
installer it's a real `claude.exe` and skips the risky branch entirely. An
npm-installed `codex` is a `codex.cmd` shim — exactly the untested path. Use it, don't
dodge it.

## When it breaks

Four Windows bugs are known, all the same shape: an API correct on POSIX and wrong on
Windows. Two were found by reading node-pty's source, two by the first real Windows
run. `node_modules/node-pty/` is readable and worth reading before you theorise.

The platform-divergent pty behaviour now lives in `packages/host/src/ptyplatform.ts`,
one object per platform, so a Windows change cannot alter the POSIX path.
`packages/host/test/ptyplatform.test.ts` drives **both** objects and runs on any OS —
add a case there for anything new you find, so the Linux box can catch a Windows
regression it cannot otherwise reach.

- **"Unable to start terminal process: CreateProcess failed"** on spawn —
  `CreateProcess` cannot execute `.cmd`/`.bat` and node-pty passes the path straight
  to it. `windowsPty.spawnCommand` runs those through `cmd.exe /c`.
- **No output reaches any client, while the daemon looks healthy** — the ConPTY agent
  calls `setEncoding("utf8")` on the conout socket unconditionally, so `encoding: null`
  is ignored and `onData` delivers **strings**, not Buffers. Every chunk then threw
  `chunk.copy is not a function` inside the ring buffer before any subscriber ran.
  `ptyChunkToBytes` normalises it. If you see an attached WebSocket receive zero frames
  while `/health` is fine, this is the shape.
- **Kills answer 204 but nothing dies** — node-pty *throws* on Windows if given a
  signal, and its bare `kill()` only kills the pids ConPTY reports attached to the
  console, in a promise it never awaits. The `cmd.exe -> node.exe -> agent.exe` tree
  outlives it: three killed sessions left nine live processes. `windowsPty.kill` takes
  the tree down with `taskkill /T` first, then releases the pty handle.
- **`sessions.json` missing `processStartTime`** — the PowerShell
  `(Get-Process -Id X).StartTime.Ticks` probe failed. Orphan killing then refuses to
  act, which is safe but means cleanup never works. Don't "fix" it by removing the
  identity check — that check exists because PIDs get recycled and a stale entry would
  kill something unrelated.

## Report back

Give Thomas, in one message:

1. This machine's `hostLabel` and its `https://...:8443` URL.
2. The token (he needs it to add the host).
3. The checklist above, each item pass/fail, with exact error text for any failure.
4. Anything you changed in `host.json` and why.

Do not commit fixes to `master` without saying what you changed and why — Windows
behaviour is the whole point of this exercise, and a silent workaround hides the
finding.
