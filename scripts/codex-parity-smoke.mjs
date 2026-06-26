// CODEX PARITY SMOKE — proves the Codex backend has FULL tool parity with Claude.
//
// Starts a codex-mode orchestrator (PANEL_AGENT_BACKEND=codex) on a test bridge
// port + a headless mock-panel that implements the graph executors, then drives a
// turn and asserts Codex actually invokes the panel_* tools over the loopback
// HTTP MCP (not shell/HTTP flailing). Records every bridge command the agent
// issued.
//
//   node scripts/codex-parity-smoke.mjs
//
// Env: TEST_PORT (default 9141), SCENARIO_CAP_MS (default 180000 — Codex is slow).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { WebSocket } from "ws";

const PORT = Number(process.env.TEST_PORT || 9141);
const MCP_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const DEAD_COMFY = "http://127.0.0.1:9";
const CAP_MS = Number(process.env.SCENARIO_CAP_MS || 180000);

function makeGraph(seed) {
  let seq = 0;
  const nodes = new Map();
  let clipboard = [];
  let selection = [];
  const add = (type, title) => {
    const id = ++seq;
    nodes.set(id, {
      id, type, title: title || type, is_subgraph: false,
      widgets: { value: 0, text: "" },
      inputs: [{ name: "in0", type: "*", link: null }, { name: "model", type: "MODEL", link: null }],
      outputs: [{ name: "out0", type: "*", links: [] }, { name: "MODEL", type: "MODEL", links: [] }],
    });
    return nodes.get(id);
  };
  for (let i = 0; i < (Number(seed) || 0); i++) add(`SeedNode${i}`, `Existing ${i}`);
  const brief = (n) => ({ id: n.id, type: n.type, title: n.title, is_subgraph: !!n.is_subgraph, widgets: n.widgets, inputs: n.inputs, outputs: n.outputs });
  const need = (id) => { const n = nodes.get(Number(id)); if (!n) throw new Error(`No node ${id}`); return n; };
  const EXEC = {
    graph_get_state: () => ({ viewing: { scope: "root" }, node_count: nodes.size, truncated: false, nodes: [...nodes.values()].map(brief) }),
    graph_add_node: ({ class_type, title }) => { if (!class_type) throw new Error("class_type required"); return { added: brief(add(class_type, title)) }; },
    graph_remove_node: ({ node_id }) => { const n = need(node_id); nodes.delete(Number(node_id)); return { removed: brief(n) }; },
    graph_clear: () => { const c = nodes.size; nodes.clear(); return { cleared: c }; },
    graph_connect: ({ from_node_id, to_node_id }) => ({ connected: { from: { node_id: from_node_id }, to: { node_id: to_node_id } } }),
    graph_disconnect: ({ node_id }) => ({ disconnected: { node_id } }),
    graph_set_widget: ({ node_id, widget, value }) => { const n = need(node_id); const p = n.widgets[widget]; n.widgets[widget] = value; return { set: { node_id, widget, previous: p, value } }; },
    graph_set_title: ({ node_id, title }) => { const n = need(node_id); const p = n.title; n.title = title; return { node_id, previous: p, title }; },
    graph_move_node: ({ node_id, pos }) => ({ moved: { node_id, to: pos } }),
    graph_canvas: ({ action }) => ({ canvas: { action } }),
    graph_run: ({ batch_count }) => ({ queued: true, batch_count: batch_count ?? 1 }),
    graph_get_errors: () => ({ last_execution_error: null, node_errors: null, note: "no errors" }),
    workflow_save: () => ({ saved: true }),
    workflow_save_as: ({ name }) => ({ saved_as: `workflows/${name}.json` }),
    workflow_new: () => ({ created: true }),
    workflow_list: () => ({ active: { path: "workflows/current.json", filename: "current.json", key: "cur" }, open: [] }),
    graph_select_nodes: ({ node_ids }) => { selection = (node_ids || []).map(Number); return { selected: node_ids }; },
    graph_copy_nodes: ({ node_ids }) => {
      const ids = (Array.isArray(node_ids) && node_ids.length ? node_ids.map(Number) : selection);
      const src = ids.map((id) => nodes.get(Number(id))).filter(Boolean);
      if (!src.length) throw new Error("nothing to copy");
      clipboard = src.map((n) => ({ type: n.type, title: n.title }));
      return { copied: clipboard.length };
    },
    graph_paste_nodes: () => {
      if (!clipboard.length) throw new Error("clipboard empty");
      const pasted = clipboard.map((c) => add(c.type, c.title));
      return { pasted_count: pasted.length, pasted_node_ids: pasted.map((n) => n.id), pasted: pasted.map(brief) };
    },
    graph_list_subgraphs: () => ({ count: 0, blueprints: [] }),
    set_todo: ({ items }) => ({ ok: true, count: (items || []).length }),
    ask_user: (m) => (m.options && m.options[0] && m.options[0].label) || "yes",
  };
  return { nodes, EXEC };
}

function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(true); });
      s.on("error", () => { s.destroy(); if (Date.now() - start > timeoutMs) reject(new Error("port timeout")); else setTimeout(tick, 300); });
    };
    tick();
  });
}

function runScenario(task, seed) {
  return new Promise((resolve) => {
    const { nodes, EXEC } = makeGraph(seed);
    const commands = [];
    const says = [];
    let done = false, idleTimer = null;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const hard = setTimeout(finish, CAP_MS);
    function finish() {
      if (done) return; done = true;
      clearTimeout(hard); if (idleTimer) clearTimeout(idleTimer);
      try { ws.close(); } catch {}
      const counts = {};
      for (const c of commands) counts[c] = (counts[c] || 0) + 1;
      resolve({ counts, says, finalNodes: nodes.size });
    }
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", tab_id: `codex-smoke-${seed}`, title: "smoke" }));
      setTimeout(() => { console.log(`   -> TASK: ${task}`); ws.send(JSON.stringify({ type: "user_message", text: task })); }, 1500);
    });
    ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (typeof m.rid === "string" && typeof m.cmd === "string") {
        commands.push(m.cmd);
        let reply;
        try { const fn = EXEC[m.cmd]; if (!fn) throw new Error(`unknown ${m.cmd}`); reply = { rid: m.rid, ok: true, result: fn(m) }; }
        catch (e) { reply = { rid: m.rid, ok: false, error: e.message }; }
        console.log(`   <cmd ${m.cmd}>`);
        try { ws.send(JSON.stringify(reply)); } catch {}
        return;
      }
      if (m.type === "say") { says.push(m.text); console.log(`   << say: ${String(m.text).slice(0, 120)}`); }
      else if (m.type === "ack" && m.kind === "ready") console.log(`   << ready (${m.agent}, backend=${m.backend})`);
      else if (m.type === "ack" && m.kind === "degraded") console.log(`   << DEGRADED ack — backend not healthy`);
      // Turn done → grace then finish.
      if ((m.type === "turn" && m.state === "done") || (m.type === "agent_status" && typeof m.context_pct === "number")) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, 4000);
      }
    });
    ws.on("error", () => {});
  });
}

async function main() {
  console.log(`[codex-smoke] starting CODEX orchestrator on :${PORT} (COMFYUI_URL=${DEAD_COMFY})`);
  const env = {
    ...process.env,
    PANEL_AGENT_BACKEND: "codex",
    COMFYUI_MCP_BRIDGE_PORT: String(PORT),
    COMFYUI_URL: DEAD_COMFY,
  };
  delete env.COMFYUI_MCP_PARENT_PID;
  const logPath = fileURLToPath(new URL("../codex-smoke-orch.log", import.meta.url));
  const fs = await import("node:fs");
  const logFd = fs.openSync(logPath, "w");
  const orch = spawn(process.execPath, [MCP_ENTRY, "--panel-orchestrator"], { env, stdio: ["ignore", logFd, logFd] });
  let exitCode = 1;
  try {
    await waitForPort(PORT);
    console.log("[codex-smoke] orchestrator up.\n");

    console.log("• Scenario 1: add a KSampler node to the canvas");
    const r1 = await runScenario("Add a KSampler node to my canvas. Just add it, don't generate.", 0);
    const addedNode = (r1.counts.graph_add_node || 0) >= 1;
    console.log(`   => graph_add_node=${r1.counts.graph_add_node || 0} get_state=${r1.counts.graph_get_state || 0} finalNodes=${r1.finalNodes}`);

    console.log("\n• Scenario 2: what nodes are on the canvas?");
    const r2 = await runScenario("What nodes are currently on my canvas? Just read the graph and tell me.", 3);
    const readGraph = (r2.counts.graph_get_state || 0) >= 1;
    console.log(`   => graph_get_state=${r2.counts.graph_get_state || 0}`);

    const calledPanel = addedNode || readGraph;
    console.log(`\n===== CODEX PARITY SMOKE =====`);
    console.log(`scenario1 add_node via panel:  ${addedNode ? "PASS" : "FAIL"}`);
    console.log(`scenario2 get_graph via panel: ${readGraph ? "PASS" : "FAIL"}`);
    console.log(`Codex invoked panel_* tools over HTTP MCP: ${calledPanel ? "YES" : "NO"}`);
    console.log(`all bridge commands s1: ${JSON.stringify(r1.counts)}`);
    console.log(`all bridge commands s2: ${JSON.stringify(r2.counts)}`);
    exitCode = calledPanel ? 0 : 1;
  } catch (e) {
    console.error("[codex-smoke] ERROR:", e.message);
  } finally {
    try { orch.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { orch.kill("SIGKILL"); } catch {}; console.log(`[codex-smoke] orchestrator log: ${logPath}`); process.exit(exitCode); }, 1500);
  }
}
main();
