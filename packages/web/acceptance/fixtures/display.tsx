import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "../../src/index.css";
import { TerminalView } from "../../src/components/TerminalView.tsx";

const host = new URLSearchParams(location.search).get("host")!;
createRoot(document.getElementById("root")!).render(<TerminalView
  entry={{id:"test", label:"test", baseUrl:host, token:"display-test"}}
  session={{id:"display", agent:"test", label:"Display regression", cwd:"/tmp", pid:1,
    status:"running", exitCode:null, cols:80, rows:24, createdAt:0, lastOutputAt:0}}
  clientId="display-test" clientLabel="test" sidebarCollapsed={false}
  onBack={() => {}} onExpandSidebar={() => {}} onEvicted={() => {}} onTakeOver={() => {}}
/>);
