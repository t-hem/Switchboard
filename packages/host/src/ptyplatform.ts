import type { IPty } from "node-pty";

import { killProcessTreeWindows } from "./proc.js";

/**
 * Everything about driving a pty that genuinely differs between Windows and POSIX,
 * behind one interface with one implementation per platform.
 *
 * These paths cannot be exercised on the same machine: a change to the Windows branch
 * is invisible to the Linux test run that reviews it, and vice versa. Keeping them as
 * separate objects rather than `if (process.platform === ...)` inside the session code
 * means each one is self-contained, and — the point — that both are importable and
 * testable from either OS. `ptyplatform.test.ts` drives `windowsPty` on Linux.
 *
 * Anything here must be decided by the *platform*, never by the machine.
 */
export interface PtyPlatform {
  readonly name: "posix" | "win32";

  /**
   * The file and argv to hand node-pty for a given agent executable.
   */
  spawnCommand(executable: string, args: readonly string[]): { file: string; args: string[] };

  /**
   * Ask a running pty to die. `force` is the escalation step, reached after the
   * grace period when the first attempt did not take.
   */
  kill(pty: Pick<IPty, "kill">, pid: number, force: boolean): void;
}

const posixPty: PtyPlatform = {
  name: "posix",

  // Nothing to shape: the kernel executes the file directly, shebang and all.
  spawnCommand(executable, args) {
    return { file: executable, args: [...args] };
  },

  // Name the signal. node-pty defaults to SIGHUP, which a process may legitimately
  // ignore — and agent CLIs that detach from a closing terminal do exactly that.
  kill(pty, _pid, force) {
    pty.kill(force ? "SIGKILL" : "SIGTERM");
  },
};

const windowsPty: PtyPlatform = {
  name: "win32",

  // node-pty hands `file` straight to CreateProcess, which cannot execute batch
  // files. npm installs CLIs on Windows as .cmd shims (claude.cmd, codex.cmd), so the
  // availability probe finds them and marks the agent available, and the spawn would
  // then fail with "CreateProcess failed". Run those through the command interpreter.
  spawnCommand(executable, args) {
    if (/\.(cmd|bat)$/i.test(executable)) {
      return { file: process.env["ComSpec"] ?? "cmd.exe", args: ["/c", executable, ...args] };
    }
    return { file: executable, args: [...args] };
  },

  /**
   * node-pty *throws* if given a signal here ("Signals not supported on windows"), so
   * one must never be passed. Its bare kill() is also not enough on its own: it kills
   * the pids ConPTY reports attached to the console, in a promise it never awaits, and
   * the cmd.exe -> node.exe -> agent.exe tree the shim above creates outlives it.
   * Measured on Windows 10: three killed sessions left nine live processes, with
   * DELETE having already answered 204.
   *
   * So the tree is taken down by pid with taskkill /T — the same call the orphan
   * sweeper uses — which also restores the terminate-then-force escalation. pty.kill()
   * still runs afterwards to release the ConPTY handles and the conout socket worker;
   * by then it is usually a no-op, hence the catch.
   */
  kill(pty, pid, force) {
    try {
      killProcessTreeWindows(pid, force);
    } catch {
      /* gone already, or taskkill refused; the force escalation still follows */
    }
    try {
      pty.kill();
    } catch {
      /* the pty may already have torn itself down along with the process */
    }
  },
};

export { posixPty, windowsPty };

export const ptyPlatform: PtyPlatform = process.platform === "win32" ? windowsPty : posixPty;

/**
 * Normalise an `onData` payload to bytes.
 *
 * Shared deliberately rather than split per platform: what differs is what node-pty
 * *delivers*, not what we do about it. On POSIX `encoding: null` is honoured and the
 * payload is already a Buffer. On Windows it is not — the ConPTY agent calls
 * setEncoding("utf8") on the conout socket unconditionally
 * (node-pty/lib/windowsPtyAgent.js), so the option is silently ignored and every chunk
 * really is a string. Assuming otherwise threw "chunk.copy is not a function" in the
 * ring buffer on the first chunk, before any subscriber ran: the daemon looked healthy
 * and streamed nothing at all.
 *
 * Re-encoding a string chunk is lossless. That socket's StringDecoder has already
 * reassembled any multi-byte sequence split across a chunk boundary, so this recovers
 * the bytes ConPTY produced rather than mangling them.
 */
export function ptyChunkToBytes(data: string | Buffer): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : data;
}
