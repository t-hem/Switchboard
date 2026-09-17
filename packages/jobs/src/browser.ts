import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer, { type Browser } from "puppeteer-core";
import { AppError } from "./errors.js";

/**
 * The jobs service owns at most one Chromium, launched with its own profile directory
 * under the jobs data directory — never the operator's daily browser. Ownership is
 * written to a machine-local file so a crashed service can clean up its own orphan on the
 * next start, and it is proven by the profile directory rather than the PID, because PIDs
 * are recycled. A record that cannot be proven is dropped, never killed.
 */
export type BrowserOwnership = { pid: number; startedAt: string; profileDir: string; executablePath: string };
export type ProcessOps = { isAlive(pid: number): boolean; commandLine(pid: number): string | null; signal(pid: number, signal: NodeJS.Signals): void };

export const defaultProcessOps: ProcessOps = {
  isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  },
  commandLine(pid) {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "); }
    catch { return null; }
  },
  signal(pid, signal) { process.kill(pid, signal); },
};

/** True only when the live process still carries our exact profile directory. */
export function ownsProcess(entry: BrowserOwnership, ops: ProcessOps): boolean {
  if (!ops.isAlive(entry.pid)) return false;
  const commandLine = ops.commandLine(entry.pid);
  return commandLine !== null && commandLine.includes(`--user-data-dir=${entry.profileDir}`);
}

export type ReapOutcome = "no_record" | "already_gone" | "unverified" | "killed" | "failed";

/**
 * SIGTERM, then SIGKILL after the grace period, and only report `killed` after observing
 * the death. A survivor is reported `failed` so the record stays for the operator.
 */
export async function reapOwned(entry: BrowserOwnership | null, ops: ProcessOps = defaultProcessOps,
  options: { graceMs?: number; pollMs?: number; wait?: (ms: number) => Promise<unknown> } = {}): Promise<ReapOutcome> {
  if (!entry) return "no_record";
  if (!ops.isAlive(entry.pid)) return "already_gone";
  if (!ownsProcess(entry, ops)) return "unverified"; // recycled PID or a foreign process: drop, never kill
  const graceMs = options.graceMs ?? 5000, pollMs = options.pollMs ?? 250;
  const wait = options.wait ?? delay;
  ops.signal(entry.pid, "SIGTERM");
  for (let waited = 0; waited < graceMs && ops.isAlive(entry.pid); waited += pollMs) await wait(Math.min(pollMs, graceMs - waited));
  if (!ops.isAlive(entry.pid)) return "killed";
  ops.signal(entry.pid, "SIGKILL");
  await wait(pollMs);
  return ops.isAlive(entry.pid) ? "failed" : "killed";
}

export function readOwnership(file: string): BrowserOwnership | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BrowserOwnership>;
    if (typeof value.pid !== "number" || typeof value.profileDir !== "string" || typeof value.startedAt !== "string") return null;
    return { pid: value.pid, startedAt: value.startedAt, profileDir: value.profileDir, executablePath: typeof value.executablePath === "string" ? value.executablePath : "" };
  } catch { return null; }
}

export class SupervisedBrowser {
  private browser: Browser | null = null;
  private readonly ops: ProcessOps;
  private readonly graceMs: number;
  constructor(private readonly options: { executablePath: string; profileDir: string; ownershipFile: string; now?: () => number; ops?: ProcessOps; graceMs?: number }) {
    this.ops = options.ops ?? defaultProcessOps;
    this.graceMs = options.graceMs ?? 5000;
  }
  /** Clean up our own leftovers from a previous crash before starting another browser. */
  async reapStale(): Promise<ReapOutcome> {
    const entry = readOwnership(this.options.ownershipFile);
    if (!entry) { fs.rmSync(this.options.ownershipFile, { force: true }); return "no_record"; }
    const outcome = await reapOwned(entry, this.ops, { graceMs: this.graceMs });
    // Keep the record only when a proven process survived, so the operator can still see it.
    if (outcome !== "failed") fs.rmSync(this.options.ownershipFile, { force: true });
    return outcome;
  }
  async ensure(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    await this.reapStale();
    if (!fs.existsSync(this.options.executablePath)) throw new AppError("browser_unavailable", "The configured browser executable is not installed", 409);
    fs.mkdirSync(this.options.profileDir, { recursive: true, mode: 0o700 });
    this.browser = await puppeteer.launch({
      executablePath: this.options.executablePath, headless: true, userDataDir: this.options.profileDir,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const pid = this.browser.process()?.pid;
    if (pid) {
      const entry: BrowserOwnership = { pid, startedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
        profileDir: this.options.profileDir, executablePath: this.options.executablePath };
      fs.writeFileSync(this.options.ownershipFile, JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
    }
    return this.browser;
  }
  async close(): Promise<void> {
    if (this.browser) { await this.browser.close().catch(() => undefined); this.browser = null; }
    fs.rmSync(this.options.ownershipFile, { force: true });
  }
}

/** Default locations for the supervised browser inside the jobs data directory. */
export function browserPaths(dir: string): { profileDir: string; ownershipFile: string } {
  return { profileDir: path.join(dir, "browser-profile"), ownershipFile: path.join(dir, "browser-ownership.json") };
}
