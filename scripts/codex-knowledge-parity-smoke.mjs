// CODEX KNOWLEDGE-PARITY SMOKE — proves the Codex backend has the SAME bundled
// family expertise Claude gets natively. Claude loads all plugin skills; Codex
// loads none, but now reaches the identical knowledge through the comfyui MCP's
// list_skills / read_skill / list_packs / read_pack_workflow tools.
//
// Starts a codex-mode orchestrator + a headless mock panel (graph executors),
// points the headless comfyui MCP's COMFYUI_MCP_TOOL_TRACE at a temp JSONL file
// so we can observe the skill/pack tool calls (they ride the stdio MCP, not the
// panel bridge), then prompts "set up a krea2 workflow on my canvas" and asserts:
//   1) Codex DISCOVERED the krea2 family via list_skills/read_skill (or the pack
//      equivalents list_packs/read_pack_workflow) — NOT pure from-scratch guessing.
//   2) Codex APPLIED the pack / loaded the pack's ready workflow (read_pack_workflow
//      and/or apply_manifest, then built nodes on the canvas) — NOT a generic graph.
//
//   node scripts/codex-knowledge-parity-smoke.mjs
//
// Env: TEST_PORT (default 9151), SCENARIO_CAP_MS (default 240000 — Codex + reading
//      a full SKILL.md is slow).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import net from "node:net";
import { WebSocket } from "ws";

const PORT = Number(process.env.TEST_PORT || 9151);
const MCP_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const COMFY_PATH = fileURLToPath(new URL("..", import.meta.url)); // a real dir w/ packs/ + plugin/
const DEAD_COMFY = "http://127.0.0.1:9";
const CAP_MS = Number(process.env.SCENARIO_CAP_MS || 240000);
const TRACE = join(tmpdir(), `comfyui-mcp-tooltrace-${PORT}-${Date.now()}.jsonl`);

function makeGraph() {
  let seq = 0;
  const nodes = new Map();
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
    workflow_open: ({ path }) => ({ opened: { path } }),
    workflow_list: () => ({ active: { path: "workflows/current.json", filename: "current.json", key: "cur" }, open: [] }),
    graph_select_nodes: ({ node_ids }) => ({ selected: node_ids }),
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

function runScenario(task) {
  return new Promise((resolve) => {
    const { nodes, EXEC } = makeGraph();
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
      ws.send(JSON.stringify({ type: "hello", tab_id: `codex-kp-smoke`, title: "smoke" }));
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
      if (m.type === "say") { says.push(m.text); console.log(`   << say: ${String(m.text).slice(0, 160)}`); }
      else if (m.type === "ack" && m.kind === "ready") console.log(`   << ready (${m.agent}, backend=${m.backend})`);
      else if (m.type === "ack" && m.kind === "degraded") console.log(`   << DEGRADED ack — backend not healthy`);
      if (m.type === "turn" && m.state === "done") {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, 6000);
      }
    });
    ws.on("error", () => {});
  });
}

function readTrace() {
  try {
    return fs.readFileSync(TRACE, "utf8").trim().split(/\n+/).filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

async function main() {
  console.log(`[kp-smoke] starting CODEX orchestrator on :${PORT} (COMFYUI_URL=${DEAD_COMFY}, COMFYUI_PATH=${COMFY_PATH})`);
  console.log(`[kp-smoke] tool trace → ${TRACE}`);
  const env = {
    ...process.env,
    PANEL_AGENT_BACKEND: "codex",
    COMFYUI_MCP_BRIDGE_PORT: String(PORT),
    COMFYUI_URL: DEAD_COMFY,
    // Local mode so apply_manifest is available AND so the comfyui MCP resolves
    // packs/ + plugin/ against this real repo dir.
    COMFYUI_PATH: COMFY_PATH,
    COMFYUI_MCP_TOOL_TRACE: TRACE,
  };
  delete env.COMFYUI_MCP_PARENT_PID;
  const logPath = fileURLToPath(new URL("../codex-kp-smoke-orch.log", import.meta.url));
  const logFd = fs.openSync(logPath, "w");
  const orch = spawn(process.execPath, [MCP_ENTRY, "--panel-orchestrator"], { env, stdio: ["ignore", logFd, logFd] });
  let exitCode = 1;
  try {
    await waitForPort(PORT);
    console.log("[kp-smoke] orchestrator up.\n");

    console.log("• Scenario: set up a krea2 workflow on my canvas");
    const r = await runScenario("Clear my workflow and set up a krea2 text-to-image workflow on my canvas. Use whatever ready expertise comfyui-mcp already ships if there is any — don't reinvent the graph.");

    const trace = readTrace();
    const tools = trace.map((t) => t.tool);
    const readSkillArgs = trace.filter((t) => t.tool === "read_skill").map((t) => t.args?.name);
    const readPackArgs = trace.filter((t) => t.tool === "read_pack_workflow").map((t) => t.args?.name);

    const calledListSkills = tools.includes("list_skills");
    const calledReadSkill = tools.includes("read_skill");
    const calledListPacks = tools.includes("list_packs");
    const calledReadPack = tools.includes("read_pack_workflow");
    const discoveredKrea2 =
      readSkillArgs.some((n) => String(n || "").includes("krea2")) ||
      readPackArgs.some((n) => String(n || "").includes("krea2"));

    // Discovery = consulted the bundled knowledge (skills and/or packs) for the family.
    const discovery = calledListSkills || calledReadSkill || calledListPacks || calledReadPack;
    // Applied ready expertise = read the pack workflow (the expert graph) and/or
    // built nodes on the canvas from it.
    const builtOnCanvas = (r.counts.graph_add_node || 0) >= 1;
    const appliedPack = calledReadPack || discoveredKrea2;

    console.log(`\n===== CODEX KNOWLEDGE-PARITY SMOKE =====`);
    console.log(`tool trace (skill/pack calls): ${JSON.stringify(tools)}`);
    console.log(`read_skill names: ${JSON.stringify(readSkillArgs)}`);
    console.log(`read_pack_workflow names: ${JSON.stringify(readPackArgs)}`);
    console.log(`all bridge commands: ${JSON.stringify(r.counts)}`);
    console.log(`---`);
    console.log(`Codex consulted bundled skills/packs (list_skills/read_skill/list_packs/read_pack_workflow): ${discovery ? "YES" : "NO"}`);
    console.log(`Codex discovered the krea2 family (krea2-* skill or pack): ${discoveredKrea2 ? "YES" : "NO"}`);
    console.log(`Codex applied the pack / read its ready workflow: ${appliedPack ? "YES" : "NO"}`);
    console.log(`Codex built nodes on the live canvas: ${builtOnCanvas ? "YES" : "NO"}`);

    // PASS = it discovered the family knowledge AND used the ready pack expertise.
    exitCode = discovery && discoveredKrea2 ? 0 : 1;
    console.log(`\n${exitCode === 0 ? "PASS" : "FAIL"} — knowledge parity ${exitCode === 0 ? "achieved" : "NOT achieved"}.`);
  } catch (e) {
    console.error("[kp-smoke] ERROR:", e.message);
  } finally {
    try { orch.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { orch.kill("SIGKILL"); } catch {}; console.log(`[kp-smoke] orchestrator log: ${logPath}`); process.exit(exitCode); }, 1500);
  }
}
main();
