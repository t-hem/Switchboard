import { useCallback, useEffect, useRef } from "react";

import { api } from "../api/client.ts";
import type { HostEntry } from "../types.ts";

/**
 * Claims every configured host for this browser (spec §6).
 *
 * Claiming happens on load and on window focus — never on a background reconnect.
 * A phone waking up in a pocket and silently stealing the session from the desktop
 * you are actually using would be worse than the problem the lock solves; taking
 * over is meant to be something a person does by looking at a device.
 */
export function useClaim(
  hosts: HostEntry[],
  clientId: string,
  clientLabel: string,
): { claimAll: () => Promise<void> } {
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const labelRef = useRef(clientLabel);
  labelRef.current = clientLabel;

  const claimAll = useCallback(async () => {
    await Promise.allSettled(
      hostsRef.current.map((entry) => api.claim(entry, clientId, labelRef.current)),
    );
  }, [clientId]);

  useEffect(() => {
    void claimAll();
    const onFocus = (): void => void claimAll();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [claimAll]);

  return { claimAll };
}
