import { nanoid } from "nanoid";

import type { HostEntry } from "../types.ts";

const HOSTS_KEY = "switchboard.hosts";
const CLIENT_ID_KEY = "switchboard.clientId";
const CLIENT_LABEL_KEY = "switchboard.clientLabel";

/** localStorage throws in some privacy modes; never let that take the app down. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable; the app still works for this session */
  }
}

function isHostEntry(v: unknown): v is HostEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e["id"] === "string" &&
    typeof e["label"] === "string" &&
    typeof e["baseUrl"] === "string" &&
    typeof e["token"] === "string"
  );
}

export function loadHosts(): HostEntry[] {
  const raw = read(HOSTS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isHostEntry) : [];
  } catch {
    return [];
  }
}

export function saveHosts(hosts: HostEntry[]): void {
  write(HOSTS_KEY, JSON.stringify(hosts));
}

export function newHostEntry(partial: Omit<HostEntry, "id">): HostEntry {
  return { id: nanoid(), ...partial };
}

/** Stable per-browser identity, used by the claim protocol in phase 4. */
export function clientId(): string {
  const existing = read(CLIENT_ID_KEY);
  if (existing) return existing;
  const fresh = nanoid();
  write(CLIENT_ID_KEY, fresh);
  return fresh;
}

export function clientLabel(): string {
  return read(CLIENT_LABEL_KEY) ?? defaultClientLabel();
}

export function setClientLabel(label: string): void {
  write(CLIENT_LABEL_KEY, label);
}

function defaultClientLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone|Android.*Mobile/i.test(ua)) return "phone";
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  return "desktop";
}
