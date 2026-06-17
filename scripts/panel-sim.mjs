#!/usr/bin/env node
// Headless panel simulator — stands in for the comfyui-mcp-panel browser pack so
// we can prove the WHOLE orchestrator loop without ComfyUI/Chrome:
//   connect to the bridge → hello → user_message → expect the agent's reply back
//   as a `say` frame. PASS = a say frame contains our sentinel.
//
//   1) start the orchestrator:  node dist/index.js --panel-orchestrator
//   2) node scripts/panel-sim.mjs
//
// `ws` resolves from the repo's node_modules (node walks up the dir tree).

import WebSocket from "ws";

const URL = process.env.BRIDGE_URL || "ws://127.0.0.1:9101";
const TAB = "sim-tab-1";
const SENTINEL = "panel-loop-ok-5512";

let done = false;
const ws = new WebSocket(URL);

function finish(ok, why) {
  if (done) return;
  done = true;
  console.log(`\n[panel-sim] ${ok ? "PASS ✅" : "FAIL ❌"} — ${why}`);
  try { ws.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(ok ? 0 : 1), 200);
}

ws.on("open", () => {
  console.log("[panel-sim] connected to bridge");
  ws.send(JSON.stringify({ type: "hello", tab_id: TAB, title: "Sim Workflow" }));
  setTimeout(() => {
    console.log("[panel-sim] → user_message");
    ws.send(JSON.stringify({
      type: "user_message",
      text: `Reply with exactly this token and nothing else, no preamble: ${SENTINEL}`,
    }));
  }, 400);
});

ws.on("message", (buf) => {
  let m;
  try { m = JSON.parse(buf.toString()); } catch { return; }
  if (m.type === "echo") { console.log(`[panel-sim] echo: ${String(m.text).slice(0, 60)}`); return; }
  if (m.type === "say") {
    console.log(`[panel-sim] say: ${String(m.text).slice(0, 160)}`);
    if (String(m.text).includes(SENTINEL)) finish(true, "agent reply reached the panel via say — full loop works");
    return;
  }
  console.log(`[panel-sim] frame: ${m.type}`);
});

ws.on("error", (e) => finish(false, `ws error: ${e.message}`));
ws.on("close", () => finish(false, "bridge closed the connection before a sentinel reply"));

setTimeout(() => finish(false, "timeout (150s) — no say frame with the sentinel"), 150_000);
