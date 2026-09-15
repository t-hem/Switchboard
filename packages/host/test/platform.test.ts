import assert from "node:assert/strict";
import test from "node:test";

import { posixOps, win32Ops } from "../src/platform/index.ts";
import { ptyChunkToBytes } from "../src/ptybytes.ts";

// The reason this file exists: the Windows pty path cannot run on the machine that
// reviews it, so every Windows bug so far was found by reading node-pty's source
// rather than by a failing test. Both implementations are plain objects, so both are
// driven here regardless of which OS the suite is running on.

type KillCall = { signal?: string };

function stubPty(): { calls: KillCall[]; kill: (signal?: string) => void } {
  const calls: KillCall[] = [];
  return {
    calls,
    kill(signal?: string) {
      calls.push(signal === undefined ? {} : { signal });
    },
  };
}

test("windows sends a .cmd shim through the command interpreter", () => {
  const { file, args } = win32Ops.spawnCommand("C:\\npm\\claude.cmd", ["--help"]);
  assert.match(file, /cmd\.exe$/i);
  assert.deepEqual(args, ["/c", "C:\\npm\\claude.cmd", "--help"]);
});

test("windows shims .bat too, and is case-insensitive about the extension", () => {
  assert.deepEqual(win32Ops.spawnCommand("x.BAT", []).args, ["/c", "x.BAT"]);
  assert.deepEqual(win32Ops.spawnCommand("x.Cmd", []).args, ["/c", "x.Cmd"]);
});

test("windows runs a real executable directly, with no interpreter", () => {
  const { file, args } = win32Ops.spawnCommand("C:\\Program Files\\claude.exe", ["-v"]);
  assert.equal(file, "C:\\Program Files\\claude.exe");
  assert.deepEqual(args, ["-v"]);
});

test("posix never rewrites the command, even for a file named .cmd", () => {
  // A POSIX file may legitimately be called anything; there is no interpreter to add.
  const { file, args } = posixOps.spawnCommand("/usr/local/bin/weird.cmd", ["-x"]);
  assert.equal(file, "/usr/local/bin/weird.cmd");
  assert.deepEqual(args, ["-x"]);
});

test("posix names the signal explicitly rather than defaulting to SIGHUP", () => {
  // node-pty's kill() defaults to SIGHUP, which agent CLIs may legitimately ignore.
  const pty = stubPty();
  posixOps.killPty(pty, 1234, false);
  posixOps.killPty(pty, 1234, true);
  assert.deepEqual(pty.calls, [{ signal: "SIGTERM" }, { signal: "SIGKILL" }]);
});

test("windows never passes a signal to node-pty", () => {
  // node-pty throws "Signals not supported on windows" if given one, which would mean
  // neither the terminate nor the escalation ever reached the process.
  const pty = stubPty();
  // pid 0 is never a real process, and taskkill does not exist off Windows: both
  // failure modes are swallowed, which is what keeps the escalation running.
  win32Ops.killPty(pty, 0, false);
  assert.deepEqual(pty.calls, [{}], "expected a bare kill() with no signal");
});

test("windows kill survives taskkill being unavailable or refusing", () => {
  const pty = stubPty();
  assert.doesNotThrow(() => win32Ops.killPty(pty, 0, true));
  assert.equal(pty.calls.length, 1, "the pty handle is still released");
});

test("windows kill still releases the pty handle when pty.kill throws", () => {
  const exploding = {
    kill() {
      throw new Error("already torn down");
    },
  };
  assert.doesNotThrow(() => win32Ops.killPty(exploding, 0, false));
});

test("a string chunk is decoded to the bytes ConPTY produced", () => {
  // The Windows failure this guards: a string reached RingBuffer.append and threw
  // "chunk.copy is not a function" on the first chunk, so nothing was ever streamed.
  const bytes = ptyChunkToBytes("hi");
  assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual([...bytes], [0x68, 0x69]);
});

test("a Buffer chunk is passed through untouched", () => {
  const buf = Buffer.from([0x00, 0x1b, 0xff]);
  assert.equal(ptyChunkToBytes(buf), buf, "POSIX bytes must not be copied or recoded");
});

test("multi-byte and control bytes survive the string path", () => {
  const text = "é→\u001b[31m\u0000";
  assert.deepEqual(ptyChunkToBytes(text), Buffer.from(text, "utf8"));
  assert.equal(ptyChunkToBytes(text).toString("utf8"), text);
});
