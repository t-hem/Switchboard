/**
 * The single-client lock (spec §6).
 *
 * The multi-client problem is defined out of existence rather than solved: exactly
 * one browser at a time may hold open session streams against a host. Claiming is
 * how a device says "I'm driving now"; the previous holder's sockets are severed.
 *
 * Eviction only severs the *view*. Sessions keep running throughout — nothing here
 * ever touches a pty.
 */

export type Claimant = {
  clientId: string;
  clientLabel: string;
  claimedAt: number;
};

export type ClaimResult = {
  claimant: Claimant;
  /** The client that just lost the claim, if it changed hands. */
  evicted: Claimant | null;
};

/** Whatever the transport layer needs to sever a view. Kept abstract so the state
 *  machine can be tested without a real WebSocket. */
export type EvictableSocket = {
  evict: (reason: string) => void;
};

export class ClaimRegistry {
  #current: Claimant | null = null;
  #sockets = new Map<string, Set<EvictableSocket>>();

  get current(): Claimant | null {
    return this.#current;
  }

  /**
   * Take the claim. If it changes hands, every stream held by the previous claimant
   * is evicted first, then the new claimant is recorded.
   *
   * Re-claiming as the current holder is a no-op beyond refreshing the label and
   * timestamp — a client re-claims on every window focus, and that must not
   * disconnect the client doing it.
   */
  claim(clientId: string, clientLabel: string, now: number = Date.now()): ClaimResult {
    const previous = this.#current;
    const claimant: Claimant = { clientId, clientLabel, claimedAt: now };
    this.#current = claimant;

    if (previous === null || previous.clientId === clientId) {
      return { claimant, evicted: null };
    }

    const reason = `claimed by ${clientLabel}`;
    for (const socket of this.#sockets.get(previous.clientId) ?? []) {
      try {
        socket.evict(reason);
      } catch {
        /* a socket that fails to close must not block the rest of the eviction */
      }
    }
    this.#sockets.delete(previous.clientId);
    return { claimant, evicted: previous };
  }

  /**
   * May this client open a stream?
   *
   * With no claimant yet — a freshly started daemon — the first caller is allowed
   * in and takes the claim implicitly. Rejecting until an explicit claim arrives
   * would make a daemon unusable in the window between page load and the claim
   * request landing, and it weakens nothing: a later explicit claim still evicts.
   */
  mayAttach(clientId: string): boolean {
    if (!clientId) return false;
    return this.#current === null || this.#current.clientId === clientId;
  }

  /** Track a stream so it can be severed when the claim moves. */
  register(clientId: string, clientLabel: string, socket: EvictableSocket): void {
    if (this.#current === null) this.claim(clientId, clientLabel);
    let sockets = this.#sockets.get(clientId);
    if (!sockets) {
      sockets = new Set();
      this.#sockets.set(clientId, sockets);
    }
    sockets.add(socket);
  }

  unregister(clientId: string, socket: EvictableSocket): void {
    const sockets = this.#sockets.get(clientId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.#sockets.delete(clientId);
  }

  /** Open streams held by a client — used by tests and /health-style reporting. */
  socketCount(clientId?: string): number {
    if (clientId !== undefined) return this.#sockets.get(clientId)?.size ?? 0;
    let total = 0;
    for (const set of this.#sockets.values()) total += set.size;
    return total;
  }
}
