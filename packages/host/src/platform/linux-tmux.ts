import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as pty from "node-pty";
import type { HostConfig, Session } from "../types.js";
import type { SessionBackend, SessionHandle, SpawnRequest } from "../backends/types.js";
import { RecoveryRegistry, isRecoveryEntry, type RecoveryEntry } from "../backends/registry.js";
import { posixOps } from "./posix.js";
import { ptyChunkToBytes } from "../ptybytes.js";
import { TmuxQueryFilter } from "./tmux-queries.js";

type Pane = { target: string; pid: number; dead: boolean; exitCode: number | null; metadata: string };
const command = (file: string, args: string[]): string => {
  try {
    return execFileSync(file, args, {
      encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    // execFileSync's default message includes argv, which may contain the agent env.
    const failure = err as { status?: number; code?: string };
    throw new Error(`${file} operation failed (${failure.code ?? failure.status ?? "unknown"}); inspect owner/service status`);
  }
};
const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

/** Linux only. The independently supervised tmux server owns PTYs; we own attachments. */
export class LinuxTmuxBackend implements SessionBackend {
  readonly name = "tmux";
  readonly persistent = true;
  readonly #registry: RecoveryRegistry;
  readonly #config: NonNullable<HostConfig["tmux"]>;
  readonly #entries = new Map<string, RecoveryEntry>();
  readonly #handles = new Map<string, TmuxHandle>();
  readonly #timer: NodeJS.Timeout | undefined;
  readonly #gateDir: string;

  constructor(config: HostConfig, dir: string, private readonly options: {
    reconcile?: boolean; attach?: boolean; sessionId?: string;
  } = {}) {
    if (!config.tmux) throw new Error("Missing tmux configuration");
    const version = command("/usr/bin/tmux", ["-V"]);
    const match = /^tmux (\d+)\.(\d+)/.exec(version);
    if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 2)) {
      throw new Error("Persistent sessions require tmux 3.2 or newer");
    }
    this.#config = config.tmux;
    this.#gateDir = path.join(dir, "session-start-gates");
    fs.mkdirSync(this.#gateDir, {recursive:true, mode:0o700});
    this.#registry = new RecoveryRegistry(dir, posixOps);
    for (const entry of this.#registry.list()) this.#entries.set(entry.session.id, entry);
    if (options.reconcile !== false) {
      this.#timer = setInterval(() => this.#poll(), 1000);
      this.#timer.unref();
    }
  }

  #tmux(...args: string[]): string { return command("/usr/bin/tmux", ["-S", this.#config.socketPath, "-N", ...args]); }
  #owner(): void {
    const stat = fs.statSync(this.#config.socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
      throw new Error("tmux socket must be private and owned by this user");
    }
    if (this.#tmux("show-options", "-gqv", "@switchboard-owner") !== this.#config.ownerId) {
      throw new Error("tmux owner identity mismatch; no resources touched");
    }
  }
  #panes(): Pane[] {
    this.#owner();
    // list-panes requires a current target even with -a; a fresh replacement
    // owner has none. Empty inventory is different from an unreachable owner.
    if (!this.#tmux("list-sessions", "-F", "#{session_name}")) return [];
    const output = this.#tmux("list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}\t#{@switchboard-metadata}");
    return output ? output.split("\n").map(line => {
      const [target, pid, dead, status, metadata] = line.split("\t");
      return { target: target!, pid: Number(pid), dead: dead === "1", exitCode: status ? Number(status) : null, metadata: metadata ?? "" };
    }) : [];
  }
  #tag(entry: RecoveryEntry): void {
    this.#tmux("set-option", "-t", entry.target, "@switchboard-metadata", Buffer.from(JSON.stringify(entry)).toString("base64"));
  }
  #persist(entry: RecoveryEntry): void { this.#registry.put(entry); this.#entries.set(entry.session.id, entry); }
  #discover(): void {
    try {
      for (const pane of this.#panes()) {
        let raw: unknown;
        try { raw = JSON.parse(Buffer.from(pane.metadata, "base64").toString()); } catch { raw = null; }
        if (!isRecoveryEntry(raw) || raw.ownerId !== this.#config.ownerId || raw.target !== pane.target) {
          const prefix = `sw-${this.#config.ownerId}-`;
          if (!pane.target.startsWith(prefix)) continue;
          const id = pane.target.slice(prefix.length);
          if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue;
          // A resource in our private namespace without valid metadata is visible but
          // never auto-attached/launched. Its missing details must not become invented facts.
          raw = {backend:"tmux", ownerId:this.#config.ownerId, target:pane.target,
            scope:`${pane.target}.scope`, phase:"starting", processIdentity:posixOps.processIdentity(pane.pid),
            session:{id,agent:"unknown",cwd:"",label:"Recovered resource — metadata missing",status:"running",
              exitCode:null,pid:pane.pid,cols:80,rows:24,createdAt:0,lastOutputAt:0,backend:"tmux"}} satisfies RecoveryEntry;
        }
        if (!isRecoveryEntry(raw)) continue;
        if (!this.#entries.has(raw.session.id)) this.#persist(raw);
      }
    } catch (err) { console.log(`[tmux] recovery pending: ${errorText(err)}`); }
  }

  create({ session, executable, args, env }: SpawnRequest): SessionHandle {
    this.#owner();
    session.backend = "tmux";
    const target = `sw-${this.#config.ownerId}-${session.id}`;
    const entry: RecoveryEntry = { session, backend: "tmux", ownerId: this.#config.ownerId,
      target, scope: `${target}.scope`, phase: "starting", processIdentity: null };
    this.#persist(entry); // no resource can precede its durable intent
    try {
      // Start the final pane once, held at a file gate until its scope identity is
      // durable. No temporary holder/replacement is needed.
      this.#tmux("new-session", "-d", "-s", target, "-x", String(session.cols), "-y", String(session.rows),
        "-c", session.cwd,
        "/usr/bin/systemd-run", "--user", "--scope", "--quiet", `--unit=${entry.scope}`,
        `--description=switchboard:${entry.ownerId}:${session.id}`,
        "--property=KillMode=control-group", "--property=TimeoutStopSec=3", "--",
        "/usr/bin/env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
        "TERM=xterm-256color", "/bin/sh", "-c",
        'while [ ! -e "$1" ]; do sleep 0.05; done; shift; exec "$@"',
        "switchboard-start", path.join(this.#gateDir, session.id), executable, ...args);
      const pane = this.#panes().find(p => p.target === target);
      if (!pane) throw new Error("Created pane disappeared");
      session.pid = pane.pid; // stable scope launcher; workload descendants live in its named scope
      entry.processIdentity = posixOps.processIdentity(pane.pid);
      if (!entry.processIdentity && !pane.dead) throw new Error("Cannot verify new pane identity");
      // The workload is still held at the file gate. Record the scope incarnation
      // before it can fork, detach or exit; recovery never has to guess its identity.
      this.#persist(entry);
      const deadline = Date.now() + 3000;
      while (!this.#scope(entry).active) {
        if (Date.now() >= deadline) throw new Error("Workload scope did not become ready");
      }
      this.#tag(entry);
      fs.writeFileSync(path.join(this.#gateDir, session.id), "", {flag:"wx",mode:0o600});
      entry.phase = "running";
      this.#persist(entry);
      this.#tag(entry);
    } catch (err) {
      // Never forget a possibly-created child. It appears in recovery inventory even
      // if HTTP create fails; reconciliation determines whether anything started.
      entry.error = `Spawn incomplete: ${errorText(err)}`;
      entry.session.recovery = entry.error;
      try { this.#persist(entry); } catch { /* original intent is already durable */ }
      throw err;
    }
    return this.#handle(entry);
  }

  recover(): { session: Session; handle: SessionHandle }[] {
    // Retry alternate inventory when an owner becomes reachable after startup.
    // The caller registers callbacks synchronously before reconciliation can emit exits.
    this.#discover();
    return [...this.#entries.values()].map(entry => ({ session: entry.session, handle: this.#handle(entry) }));
  }
  #handle(entry: RecoveryEntry): TmuxHandle {
    let handle = this.#handles.get(entry.session.id);
    if (!handle) {
      handle = new TmuxHandle(entry, this.#config.socketPath, force => this.#signal(entry, force));
      this.#handles.set(entry.session.id, handle);
    }
    return handle;
  }
  save(session: Session): void {
    const entry = this.#entries.get(session.id);
    if (!entry) return;
    entry.session = session;
    this.#persist(entry);
    try { this.#owner(); this.#tag(entry); }
    catch { /* durable registry remains authoritative while owner is unavailable */ }
  }
  #scope(entry: RecoveryEntry): { active: boolean; exists: boolean } {
    const output = command("/usr/bin/systemctl", ["--user", "show", entry.scope, "-p", "LoadState", "-p", "ActiveState", "-p", "Description", "-p", "InvocationID"]);
    const props = Object.fromEntries(output.split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (props["LoadState"] === "not-found") return { active: false, exists: false };
    if (props["Description"] !== `switchboard:${entry.ownerId}:${entry.session.id}`) throw new Error("Session scope identity mismatch");
    const identity = props["InvocationID"];
    if (entry.scopeIdentity && identity !== entry.scopeIdentity) throw new Error("Workload scope generation changed; refusing control");
    if (!entry.scopeIdentity && identity && !["inactive", "failed"].includes(props["ActiveState"] ?? "")) {
      const current = posixOps.processIdentity(entry.session.pid);
      if (current !== entry.processIdentity || !current) throw new Error("Cannot verify initial workload scope owner");
      entry.scopeIdentity = identity;
      this.#persist(entry);
      // Persist the scope generation in the alternate metadata source too.
      try { this.#tag(entry); } catch { /* registry remains authoritative while socket unavailable */ }
    }
    return { active: !["inactive", "failed"].includes(props["ActiveState"] ?? ""), exists: true };
  }
  #signal(entry: RecoveryEntry, force: boolean): void {
    if (entry.ownerId !== this.#config.ownerId) throw new Error("Configured owner changed; restore previous tmux settings");
    const scope = this.#scope(entry);
    if (scope.active) {
      command("/usr/bin/systemctl", ["--user", "kill", "--kill-who=all", `--signal=${force ? "SIGKILL" : "SIGTERM"}`, entry.scope]);
    } else {
      // A pre-spawn holder or incomplete launcher may have no scope yet. Verify both
      // ownership namespace and the actual process creation identity before signalling.
      const pane = this.#panes().find(p => p.target === entry.target);
      if (pane && !pane.dead) {
        if (!entry.processIdentity || posixOps.processIdentity(pane.pid) !== entry.processIdentity) {
          throw new Error("Cannot verify incomplete pane; inspect recovery inventory");
        }
        posixOps.killByPid(pane.pid, force);
      }
    }
    entry.phase = "terminating";
    this.#persist(entry);
  }
  #poll(): void {
    let panes: Pane[];
    try { panes = this.#panes(); }
    catch (err) {
      for (const entry of this.#entries.values()) {
        entry.session.recovery = `Owner unavailable: ${errorText(err)}`;
        this.#handles.get(entry.session.id)?.detach();
      }
      return;
    }
    for (const entry of this.#entries.values()) {
      if (this.options.sessionId && entry.session.id !== this.options.sessionId) continue;
      try {
        if (entry.ownerId !== this.#config.ownerId) throw new Error("Configured owner differs from recorded owner");
        const pane = panes.find(p => p.target === entry.target);
        if (pane && entry.phase === "starting" && !entry.processIdentity) {
          // A crash can occur after tmux creates the gated pane but before we save
          // its PID. Recover the owned pane identity before checking its scope.
          entry.session.pid = pane.pid;
          entry.processIdentity = posixOps.processIdentity(pane.pid);
          this.#persist(entry);
        }
        const scope = this.#scope(entry);
        const handle = this.#handle(entry);
        if (!pane) {
          if (scope.active) throw new Error("Pane lost but workload scope is alive; terminate or inspect locally");
          entry.session.recovery = "Pane lost; exit status unknown";
          handle.exited(null);
          continue;
        }
        if (entry.phase === "starting") {
          // Never auto-launch an incomplete intent: starting again could duplicate work.
          entry.session.pid = pane.pid;
          entry.processIdentity ??= posixOps.processIdentity(pane.pid);
          if (!pane.dead) throw new Error("Interrupted spawn; inspect and terminate before retrying");
        }
        if (!pane.dead && entry.processIdentity !== posixOps.processIdentity(pane.pid)) {
          throw new Error("Pane process identity changed; refusing attachment");
        }
        if (pane.dead && !scope.active) {
          // tmux marks the PTY dead before waitpid supplies the exit status.
          // Wait for its child to be reaped, then obtain a fresh snapshot: the
          // initial snapshot may predate SIGCHLD even if /proc is now gone.
          if (entry.processIdentity && posixOps.processIdentity(pane.pid) === entry.processIdentity) {
            // tmux 3.2a occasionally leaves a zombie until the next SIGCHLD.
            // Nudge only its verified parent; SIGCHLD asks tmux to reap, never
            // signals the workload or synthesizes an application exit code.
            const stat = fs.readFileSync(`/proc/${pane.pid}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            if (fields[0] === "Z") {
              const ownerPid = Number(this.#tmux("display-message", "-p", "#{pid}"));
              if (Number(fields[1]) === ownerPid && Number.isSafeInteger(ownerPid) && ownerPid > 0) {
                process.kill(ownerPid, "SIGCHLD");
              }
            }
            throw new Error("Waiting for owner to reap workload exit status");
          }
          const settled = this.#panes().find(p => p.target === entry.target);
          if (!settled?.dead) throw new Error("Pane changed while reconciling exit");
          entry.phase = "exited";
          delete entry.session.recovery;
          if (this.options.attach !== false) handle.connect(); // retain final screen for exited sessions too
          handle.exited(settled.exitCode);
        } else {
          if (pane.dead) throw new Error("Main process exited; descendants remain in the workload scope");
          delete entry.session.recovery;
          if (this.options.attach !== false) handle.connect();
        }
      } catch (err) {
        entry.session.recovery = errorText(err);
        this.#handles.get(entry.session.id)?.detach();
      }
    }
  }
  forget(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    if (this.#scope(entry).active) throw new Error("Workload still alive; registry retained");
    const pane = this.#panes().find(p => p.target === entry.target);
    if (pane && !pane.dead) throw new Error("Pane still alive; registry retained");
    if (pane) this.#tmux("kill-session", "-t", entry.target);
    this.#registry.remove(id);
    fs.rmSync(path.join(this.#gateDir, id), {force:true});
    this.#handles.get(id)?.disconnect();
    this.#handles.delete(id); this.#entries.delete(id);
  }
  close(): void {
    clearInterval(this.#timer);
    for (const handle of this.#handles.values()) handle.disconnect();
    this.#registry.close();
  }
}

class TmuxHandle implements SessionHandle {
  #child: pty.IPty | null = null;
  #data = new Set<(data: Buffer) => void>();
  #exit = new Set<(code: number | null) => void>();
  #exitSent = false;
  constructor(readonly entry: RecoveryEntry, readonly socket: string, readonly signal: (force: boolean) => void) {}
  get pid(): number { return this.entry.session.pid; }
  onData(callback: (bytes: Buffer) => void): void { this.#data.add(callback); }
  onExit(callback: (code: number | null) => void): void { this.#exit.add(callback); }
  connect(): void {
    if (this.#child) return;
    const s = this.entry.session;
    const child = pty.spawn("/usr/bin/tmux", ["-S", this.socket, "-N", "attach-session", "-t", this.entry.target], {
      name: "xterm-256color", cols: s.cols, rows: s.rows, encoding: null,
      env: {PATH:"/usr/bin:/bin", LANG:"C.UTF-8", TERM:"xterm-256color"},
    });
    this.#child = child;
    const queries = new TmuxQueryFilter();
    child.onData(raw => {
      const bytes = queries.push(ptyChunkToBytes(raw as unknown as string | Buffer));
      if (bytes.length === 0) return;
      for (const cb of this.#data) cb(bytes);
    });
    child.onExit(() => { if (this.#child === child) this.#child = null; });
  }
  exited(code: number | null): void {
    if (this.#exitSent) return;
    for (const cb of this.#exit) cb(code);
    // A failed durable save must be retried by the next reconciliation poll.
    this.#exitSent = true;
  }
  write(data: string): void {
    if (!this.#child || this.entry.session.recovery) throw new Error("Session attachment unavailable");
    this.#child.write(data);
  }
  resize(cols: number, rows: number): void { this.#child?.resize(cols, rows); }
  detach(): void { const child = this.#child; this.#child = null; child?.kill("SIGTERM"); }
  disconnect(): void { this.detach(); this.#data.clear(); this.#exit.clear(); }
}
