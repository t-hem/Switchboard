import type { Session } from "../types.js";
import type { TerminalSnapshot } from "../platform/tmux-display.js";

export type SpawnRequest = {
  session: Session;
  executable: string;
  args: string[];
  env: Record<string, string>;
};

/** PTY ownership differs from attachment ownership on persistent backends. */
export interface SessionHandle {
  readonly pid: number;
  onData(callback: (bytes: Buffer) => void): void;
  onExit(callback: (exitCode: number | null) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  snapshot?(): Promise<TerminalSnapshot>;
  signal(force: boolean): void;
  /** Release only the daemon's transport, never the persistent workload. */
  disconnect(): void;
}

export interface SessionBackend {
  readonly name: "direct" | "tmux";
  readonly persistent: boolean;
  create(request: SpawnRequest): SessionHandle;
  recover?(): { session: Session; handle: SessionHandle }[];
  save?(session: Session): void;
  forget?(id: string): void;
  close?(): void;
}
