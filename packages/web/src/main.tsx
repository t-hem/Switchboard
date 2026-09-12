import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registered only for the built app: in dev it would cache modules Vite is busy
// hot-reloading. `tailscale serve` supplies the HTTPS origin installability needs.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      /* installability is a nicety; the app works without it */
    });
  });
}
