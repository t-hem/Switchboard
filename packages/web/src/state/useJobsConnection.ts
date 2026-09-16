import { useEffect, useState } from "react";

const key = "switchboard.jobsUrl";
export function jobsUrl(value: string): string {
  if (!value.trim()) return "";
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use the Jobs service's HTTP(S) origin without credentials, path, query or fragment.");
  }
  return url.origin;
}

/** Optional service discovery only. Its own client owns authentication and records. */
export function useJobsConnection() {
  const [url, setUrl] = useState(() => {
    try { return jobsUrl(localStorage.getItem(key) ?? ""); } catch { return ""; }
  });
  const [status, setStatus] = useState<"checking" | "online" | "offline">("checking");
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        try { setUrl(jobsUrl(localStorage.getItem(key) ?? "")); } catch { setUrl(""); }
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  useEffect(() => {
    if (!url) return;
    let active = true;
    let controller: AbortController | undefined;
    const check = async () => {
      controller?.abort();
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 3000);
      try {
        const response = await fetch(`${url}/health`, {signal:controller.signal, redirect:"error"});
        const health: unknown = await response.json();
        const online = response.ok && typeof health === "object" && health !== null &&
          "service" in health && health.service === "switchboard-jobs";
        if (active) setStatus(online ? "online" : "offline");
      } catch { if (active) setStatus("offline"); }
      finally { clearTimeout(timeout); }
    };
    setStatus("checking");
    void check();
    const timer = setInterval(() => void check(), 15_000);
    return () => { active = false; controller?.abort(); clearInterval(timer); };
  }, [url]);
  return {url, status, save(value: string) {
    const next = jobsUrl(value);
    if (next) localStorage.setItem(key, next); else localStorage.removeItem(key);
    setUrl(next);
  }};
}
