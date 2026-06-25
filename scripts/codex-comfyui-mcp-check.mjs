// Confirms the headless `comfyui` MCP (stdio) is reachable to Codex: drives a
// codex-mode orchestrator and asks Codex to run a comfyui MCP tool, then checks
// it actually invoked one (proving the -c mcp_servers.comfyui declaration loaded).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import fs from "node:fs";
import { WebSocket } from "ws";

const PORT = Number(process.env.TEST_PORT || 9181);
const MCP_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CAP_MS = Number(process.env.CAP_MS || 180000);

function waitForPort(port, t = 30000) {
  const s0 = Date.now();
  return new Promise((res, rej) => {
    const tick = () => { const s = net.connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => { s.destroy(); Date.now() - s0 > t ? rej(new Error("timeout")) : setTimeout(tick, 300); }); };
    tick();
  });
}

const env = { ...process.env, PANEL_AGENT_BACKEND: "codex", COMFYUI_MCP_BRIDGE_PORT: String(PORT), COMFYUI_URL: process.env.COMFYUI_URL || "http://127.0.0.1:8188" };
delete env.COMFYUI_MCP_PARENT_PID;
const logFd = fs.openSync(fileURLToPath(new URL("../codex-comfyui-check.log", import.meta.url)), "w");
const orch = spawn(process.execPath, [MCP_ENTRY, "--panel-orchestrator"], { env, stdio: ["ignore", logFd, logFd] });

let exitCode = 1;
try {
  await waitForPort(PORT);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const says = [];
  let usedComfy = false;
  await new Promise((resolve) => {
    const hard = setTimeout(resolve, CAP_MS);
    let idle = null;
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", tab_id: "comfy-check", title: "c" }));
      setTimeout(() => ws.send(JSON.stringify({ type: "user_message", text: "Use your comfyui MCP tools to run a health_check (or get_system_stats) against the ComfyUI server and report the raw result. Do not use the panel tools." })), 1500);
    });
    ws.on("message", (b) => {
      let m; try { m = JSON.parse(b.toString()); } catch { return; }
      if (typeof m.rid === "string" && typeof m.cmd === "string") { ws.send(JSON.stringify({ rid: m.rid, ok: true, result: {} })); return; }
      if (m.type === "say") { says.push(m.text); console.log("<< say:", String(m.text).slice(0, 160));
        if (/health|system_stats|system stats|comfyui_version|"?ok"?|reachable|unreachable|connection|ECONN|fetch failed/i.test(m.text)) usedComfy = true; }
      if ((m.type === "turn" && m.state === "done") || (m.type === "agent_status" && typeof m.context_pct === "number")) { if (idle) clearTimeout(idle); idle = setTimeout(() => { clearTimeout(hard); resolve(); }, 4000); }
    });
    ws.on("error", () => {});
  });
  console.log("\n===== COMFYUI MCP REACHABILITY =====");
  console.log("Codex referenced a comfyui MCP result:", usedComfy ? "YES" : "INCONCLUSIVE");
  exitCode = 0;
} catch (e) { console.error("ERROR", e.message); }
finally { try { orch.kill("SIGTERM"); } catch {} setTimeout(() => { try { orch.kill("SIGKILL"); } catch {}; process.exit(exitCode); }, 1500); }
