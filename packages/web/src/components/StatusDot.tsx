import { POLL_INTERVAL_MS } from "../state/polling.ts";
import type { Session } from "../types.ts";

/**
 * Amber — running but silent for a while — is the state the whole app exists to
 * surface: it almost always means the agent is sitting on a permission prompt.
 */
export type Activity = "working" | "quiet" | "waiting" | "exited" | "unknown";

/**
 * Every threshold here must clear the poll interval with room to spare. A session
 * that is genuinely producing output still carries a `lastOutputAt` up to one poll
 * old, so a boundary at exactly the interval is crossed and uncrossed on alternate
 * polls — the row flickers between two labels while nothing has actually changed.
 * Doubling the interval means one late or dropped poll cannot move a live session
 * out of "working", and only a real silence does.
 */
const WORKING_MS = POLL_INTERVAL_MS * 2;
const WAITING_MS = 20_000;
const JUST_NOW_MS = POLL_INTERVAL_MS * 2;

export function activityOf(session: Session, now: number): Activity {
  if (session.status === "exited") return "exited";
  const idle = now - session.lastOutputAt;
  if (idle < WORKING_MS) return "working";
  if (idle > WAITING_MS) return "waiting";
  return "quiet";
}

const STYLES: Record<Activity, { dot: string; label: string }> = {
  working: { dot: "bg-emerald-400", label: "working" },
  quiet: { dot: "bg-emerald-400/40", label: "idle" },
  waiting: { dot: "bg-amber-400", label: "probably waiting for input" },
  exited: { dot: "bg-neutral-600", label: "exited" },
  // Host unreachable: the last known timestamp says nothing about what the session
  // is doing now, and this dot is the app's most important signal — it must not
  // claim "working" for something it cannot see.
  unknown: { dot: "bg-transparent ring-1 ring-neutral-600", label: "unknown — host unreachable" },
};

export function StatusDot({ activity }: { activity: Activity }) {
  const style = STYLES[activity];
  return (
    <span
      className={`inline-block size-2.5 shrink-0 rounded-full ${style.dot} ${
        activity === "waiting" ? "animate-pulse ring-2 ring-amber-400/30" : ""
      }`}
      title={style.label}
      aria-label={style.label}
    />
  );
}

export function relativeTime(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds * 1000 < JUST_NOW_MS) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
