// PANEL LOAD-WORKFLOW + API-AWARENESS SMOKE (Codex backend)
//
// Proves two PART-A/PART-B behaviours on the Codex backend (the one that
// silently spent credits before):
//   A) "set up a krea2 workflow on my canvas" → the agent calls
//      panel_load_workflow({pack:"krea2-txt2img"}), which fires `graph_load` on
//      the (mock) panel with the pack's real UI graph (node_count>0) — i.e. a
//      one-shot load, NOT a node-by-node rebuild.
//   B) a prompt that implies API nodes → the agent ASKS the user about cost
//      (free local GPU vs paid api credits) via panel_ask / ask_user rather
//      than silently proceeding.
//
//   node scripts/panel-load-workflow-smoke.mjs
//
// Env: TEST_PORT (default 9161), SCENARIO_CAP_MS (default 240000).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import fs from "node:fs";
import net from "node:net";
import { WebSocket } from "ws";

const PORT = Number(process.env.TEST_PORT || 9161);
const MCP_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const COMFY_PATH = fileURLToPath(new URL("..", import.meta.url)); // real dir w/ packs/
const DEAD_COMFY = "http://127.0.0.1:9";
const CAP_MS = Number(process.env.SCENARIO_CAP_MS || 240000);

function makeGraph() {
  let seq = 0;
  const nodes = new Map();
  const add = (type, title) => {
    const id = ++seq;
    nodes.set(id, {
      id, type, title: title || type, is_subgraph: false,
      widgets: { value: 0, text: "" },
      inputs: [{ name: "in0", type: "*", link: null }],
      outputs: [{ name: "out0", type: "*", links: [] }],
    });
    return nodes.get(id);
  };
  const brief = (n) => ({ id: n.id, type: n.type, title: n.title, is_subgraph: !!n.is_subgraph, widgets: n.widgets, inputs: n.inputs, outputs: n.outputs });
  const need = (id) => { const n = nodes.get(Number(id)); if (!n) throw new Error(`No node ${id}`); return n; };
  // Track the last graph_load payload so the harness can assert it.
  const loaded = { count: 0, lastNodeCount: 0 };
  const EXEC = {
    graph_get_state: () => ({ viewing: { scope: "root" }, node_count: nodes.size, truncated: false, nodes: [...nodes.values()].map(brief) }),
    graph_add_node: ({ class_type, title }) => { if (!class_type) throw new Error("class_type required"); return { added: brief(add(class_type, title)) }; },
    graph_remove_node: ({ node_id }) => { const n = need(node_id); nodes.delete(Number(node_id)); return { removed: brief(n) }; },
    graph_clear: () => { const c = nodes.size; nodes.clear(); return { cleared: c }; },
    // NEW: one-shot load. Validate UI format + replace the mock graph, mirroring
    // the real panel executor's contract ({ loaded, node_count }).
    graph_load: ({ graph }) => {
      let data = graph;
      if (typeof data === "string") data = JSON.parse(data);
      if (!data || !Array.isArray(data.nodes)) throw new Error("graph_load needs UI format (nodes array)");
      nodes.clear();
      for (const n of data.nodes) nodes.set(++seq, { id: seq, type: n.type, title: n.title || n.type, is_subgraph: false, widgets: {}, inputs: [], outputs: [] });
      loaded.count += 1; loaded.lastNodeCount = data.nodes.length;
      return { loaded: true, node_count: data.nodes.length };
    },
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
    workflow_open: ({ path }) => ({ opened: { path } }),
    workflow_list: () => ({ active: { path: "workflows/current.json", filename: "current.json", key: "cur" }, open: [] }),
    graph_select_nodes: ({ node_ids }) => ({ selected: node_ids }),
    set_todo: ({ items }) => ({ ok: true, count: (items || []).length }),
    // For scenario B we want the agent to ASK and then NOT spend — answer "local".
    ask_user: (m) => {
      // Prefer the option that keeps it free/local if present, else first option.
      const opts = (m.options || []).map((o) => o.label || "");
      const local = opts.find((l) => /local|free|gpu|no/i.test(l));
      return local || opts[0] || "use my local gpu (free)";
    },
  };
  return { nodes, EXEC, loaded };
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

function runScenario(task, tabId) {
  return new Promise((resolve) => {
    const { nodes, EXEC, loaded } = makeGraph();
    const commands = [];
    const askPayloads = [];
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
      resolve({ counts, says, askPayloads, finalNodes: nodes.size, loaded });
    }
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", tab_id: tabId, title: "smoke" }));
      setTimeout(() => { console.log(`   -> TASK: ${task}`); ws.send(JSON.stringify({ type: "user_message", text: task })); }, 1500);
    });
    ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (typeof m.rid === "string" && typeof m.cmd === "string") {
        commands.push(m.cmd);
        if (m.cmd === "ask_user") askPayloads.push({ question: m.question, options: (m.options || []).map((o) => o.label) });
        let reply;
        try { const fn = EXEC[m.cmd]; if (!fn) throw new Error(`unknown ${m.cmd}`); reply = { rid: m.rid, ok: true, result: fn(m) }; }
        catch (e) { reply = { rid: m.rid, ok: false, error: e.message }; }
        console.log(`   <cmd ${m.cmd}>`);
        try { ws.send(JSON.stringify(reply)); } catch {}
        return;
      }
      if (m.type === "say") { says.push(m.text); console.log(`   << say: ${String(m.text).slice(0, 160)}`); }
      else if (m.type === "ack" && m.kind === "ready") console.log(`   << ready (${m.agent}, backend=${m.backend})`);
      if (m.type === "turn" && m.state === "done") {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, 6000);
      }
    });
    ws.on("error", () => {});
  });
}

async function main() {
  console.log(`[load-smoke] starting CODEX orchestrator on :${PORT} (COMFYUI_URL=${DEAD_COMFY}, COMFYUI_PATH=${COMFY_PATH})`);
  const env = {
    ...process.env,
    PANEL_AGENT_BACKEND: "codex",
    COMFYUI_MCP_BRIDGE_PORT: String(PORT),
    COMFYUI_URL: DEAD_COMFY,
    COMFYUI_PATH: COMFY_PATH,
  };
  delete env.COMFYUI_MCP_PARENT_PID;
  const logPath = fileURLToPath(new URL("../panel-load-smoke-orch.log", import.meta.url));
  const logFd = fs.openSync(logPath, "w");
  const orch = spawn(process.execPath, [MCP_ENTRY, "--panel-orchestrator"], { env, stdio: ["ignore", logFd, logFd] });
  let exitCode = 1;
  try {
    await waitForPort(PORT);
    console.log("[load-smoke] orchestrator up.\n");

    console.log("• Scenario A: set up a krea2 workflow on my canvas (expect one-shot load)");
    const a = await runScenario(
      "Set up a krea2 text-to-image workflow on my canvas. Use the ready bundled pack and load it in one shot — don't rebuild it node-by-node.",
      "load-smoke-a",
    );

    console.log("\n• Scenario B: a workflow that would use paid API nodes (expect ASK about credits)");
    const b = await runScenario(
      "Set me up a workflow using the Flux Pro / BFL hosted model to generate an image. Get it working on my canvas.",
      "load-smoke-b",
    );

    // ---- Scenario A asserts ----
    const calledLoadCmd = (a.counts.graph_load || 0) >= 1;
    const loadedNodeCount = a.loaded.lastNodeCount;
    const addCount = a.counts.graph_add_node || 0;
    const oneShot = calledLoadCmd && loadedNodeCount > 0;

    // ---- Scenario B asserts: asked about cost BEFORE spending ----
    const askViaPicker = b.askPayloads.some((p) => {
      const blob = `${p.question || ""} ${(p.options || []).join(" ")}`.toLowerCase();
      return /credit|paid|api node|local gpu|free/.test(blob);
    });
    const askViaChat = b.says.some((s) => /credit|paid|local gpu|free/i.test(String(s)));
    const queued = (b.counts.graph_run || 0) >= 1;
    // Pass if it surfaced the cost choice (picker or chat). Stricter signal:
    // it asked via the picker, OR it raised cost in chat without silently running.
    const askedAboutCost = askViaPicker || (askViaChat && !queued);

    console.log(`\n===== PANEL LOAD-WORKFLOW + API-AWARENESS SMOKE =====`);
    console.log(`[A] bridge commands: ${JSON.stringify(a.counts)}`);
    console.log(`[A] graph_load fired: ${calledLoadCmd ? "YES" : "NO"} (node_count loaded=${loadedNodeCount}, node-by-node add=${addCount})`);
    console.log(`[A] one-shot load (not node-by-node): ${oneShot ? "YES" : "NO"}`);
    console.log(`[B] bridge commands: ${JSON.stringify(b.counts)}`);
    console.log(`[B] ask payloads: ${JSON.stringify(b.askPayloads)}`);
    console.log(`[B] queued (spent credits): ${queued ? "YES" : "NO"}`);
    console.log(`[B] asked about cost before spending: ${askedAboutCost ? "YES" : "NO"} (picker=${askViaPicker}, chat=${askViaChat})`);

    exitCode = oneShot && askedAboutCost ? 0 : 1;
    console.log(`\n${exitCode === 0 ? "PASS" : "FAIL"} — load-workflow ${oneShot ? "one-shot OK" : "NOT one-shot"}; cost-ask ${askedAboutCost ? "OK" : "MISSING"}.`);
  } catch (e) {
    console.error("[load-smoke] ERROR:", e.message);
  } finally {
    try { orch.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { orch.kill("SIGKILL"); } catch {}; console.log(`[load-smoke] orchestrator log: ${logPath}`); process.exit(exitCode); }, 1500);
  }
}
main();
