import * as pty from "node-pty";
import type { ProcessOps } from "../platform/types.js";
import { ptyChunkToBytes } from "../ptybytes.js";
import type { SessionBackend } from "./types.js";

/** All direct-platform quirks remain delegated to ProcessOps. */
export function directBackend(ops: ProcessOps): SessionBackend {
  return {
    name: "direct",
    persistent: false,
    create({ session, executable, args, env }) {
      const command = ops.spawnCommand(executable, args);
      const child = pty.spawn(command.file, command.args, {
        name: "xterm-256color", cols: session.cols, rows: session.rows,
        cwd: session.cwd, env, encoding: null,
      });
      return {
        pid: child.pid,
        onData(callback) {
          // POSIX delivers Buffer despite node-pty's string declaration; Windows strings.
          child.onData(data => callback(ptyChunkToBytes(data as unknown as string | Buffer)));
        },
        onExit(callback) { child.onExit(({ exitCode }) => callback(exitCode)); },
        write(data) { child.write(data); },
        resize(cols, rows) { child.resize(cols, rows); },
        signal(force) { ops.killPty(child, child.pid, force); },
        disconnect() { /* Direct sessions must be terminated/awaited by their owner. */ },
      };
    },
  };
}
