// Agent-behavior test runner — spins up a TEST orchestrator (separate port,
// COMFYUI_URL pointed at a dead port so the agent can't touch real ComfyUI),
// drives it with a headless mock panel per scenario, and asserts what graph/
// workflow commands the agent issued. Prints a PASS/FAIL table and exits with
// the number of failures.
//
//   npm run test:agent        (builds first)
//   node scripts/test-agent.mjs
//
// Each scenario: fresh tab, seed an in-memory graph, send a task, record every
// panel_* command, then check expectations. This is how we verify agent
// behavior (e.g. "new workflow" must NOT wipe the graph) without a browser.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import net from "node:net";
import { WebSocket } from "ws";

const FILTER = process.env.SCENARIO_FILTER || ""; // substring to run one scenario
const LOG_ORCH = process.env.LOG_ORCH === "1";

const PORT = Number(process.env.TEST_PORT || 9112);
const MCP_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const DEAD_COMFY = "http://127.0.0.1:9";
const SCENARIO_CAP_MS = Number(process.env.SCENARIO_CAP_MS || 70000);

// ---- in-memory mock graph + executors (shared per scenario) ----
function makeGraph(seed) {
  let seq = 0;
  const nodes = new Map();        // root graph
  const subgraphs = new Map();    // subgraph node id -> inner nodes Map
  const blueprints = new Map();   // saved subgraph blueprints: name -> { name, type }
  let clipboard = [];             // copied node descriptors (persists across switches)
  let selection = [];             // currently-selected node ids
  let viewing = "root";           // "root" or a subgraph node id (number)
  const mk = (map, type, title, widgets) => {
    const id = ++seq;
    map.set(id, {
      id, type, title: title || type, is_subgraph: false,
      widgets: widgets || { value: 0, text: "" },
      inputs: [{ name: "in0", type: "*", link: null }, { name: "model", type: "MODEL", link: null }],
      outputs: [{ name: "out0", type: "*", links: [] }, { name: "MODEL", type: "MODEL", links: [] }],
    });
    return map.get(id);
  };
  const add = (type, title) => mk(nodes, type, title);
  if (seed === "subgraph") {
    // a subgraph node on root, containing a KSampler (with noise_seed) + a decode,
    // so we can test entering it and editing an INNER node.
    const sgId = ++seq;
    const inner = new Map();
    nodes.set(sgId, { id: sgId, type: "Subgraph", title: "My Subgraph", is_subgraph: true, widgets: {}, inputs: [], outputs: [] });
    subgraphs.set(sgId, inner);
    mk(inner, "KSampler", "Sampler", { noise_seed: 0, steps: 20 });
    mk(inner, "VAEDecode", "Decode", {});
  } else {
    for (let i = 0; i < (Number(seed) || 0); i++) add(`SeedNode${i}`, `Existing ${i}`);
  }
  const cur = () => (viewing === "root" ? nodes : subgraphs.get(viewing) ?? nodes);
  const scope = () => (viewing === "root" ? { scope: "root" } : { scope: "subgraph", node_id: viewing, title: nodes.get(viewing)?.title });
  const brief = (n) => ({ id: n.id, type: n.type, title: n.title, is_subgraph: !!n.is_subgraph, widgets: n.widgets, inputs: n.inputs, outputs: n.outputs });
  // Edits target the CURRENTLY VIEWED graph — an inner node id only resolves
  // after graph_enter_subgraph (mirrors the real scope-bound behavior).
  const need = (id) => { const n = cur().get(Number(id)); if (!n) throw new Error(`No node with id ${id} in the current graph`); return n; };
  const EXEC = {
    graph_get_state: () => ({ viewing: scope(), node_count: cur().size, truncated: false, nodes: [...cur().values()].map(brief) }),
    graph_get_subgraph: ({ node_id }) => { const inner = subgraphs.get(Number(node_id)); if (!inner) throw new Error("not a subgraph"); return { subgraph_of: { node_id }, node_count: inner.size, nodes: [...inner.values()].map(brief) }; },
    graph_add_node: ({ class_type, title }) => { if (!class_type) throw new Error("class_type required"); return { added: brief(mk(cur(), class_type, title)) }; },
    graph_remove_node: ({ node_id }) => { const m = cur(); const n = need(node_id); m.delete(Number(node_id)); return { removed: brief(n) }; },
    graph_clear: () => { const m = cur(); const c = m.size; m.clear(); return { cleared: c }; },
    graph_connect: ({ from_node_id, to_node_id }) => ({ connected: { from: { node_id: from_node_id }, to: { node_id: to_node_id } } }),
    graph_disconnect: ({ node_id }) => ({ disconnected: { node_id } }),
    graph_set_widget: ({ node_id, widget, value }) => { const n = need(node_id); const p = n.widgets[widget]; n.widgets[widget] = value; return { set: { node_id, widget, previous: p, value } }; },
    graph_set_title: ({ node_id, title }) => { const n = need(node_id); const p = n.title; n.title = title; return { node_id, previous: p, title }; },
    graph_enter_subgraph: ({ node_id }) => { if (!subgraphs.has(Number(node_id))) throw new Error(`Node ${node_id} is not a subgraph`); viewing = Number(node_id); return { entered: node_id, viewing: scope() }; },
    graph_exit_subgraph: () => { viewing = "root"; return { viewing: scope() }; },
    graph_move_node: ({ node_id, pos }) => ({ moved: { node_id, to: pos } }),
    graph_canvas: ({ action }) => ({ canvas: { action } }),
    graph_run: ({ batch_count }) => ({ queued: true, batch_count: batch_count ?? 1 }),
    graph_get_errors: () => ({ last_execution_error: null, node_errors: null, note: "no errors" }),
    workflow_save: () => ({ saved: true, workflow: "mock" }),
    workflow_save_as: ({ name }) => ({ saved_as: `workflows/${name}.json` }),
    workflow_new: () => ({ created: true, active: "Untitled (new tab)" }),
    workflow_list: () => ({ active: { path: "workflows/current.json", filename: "current.json", key: "cur" }, open: [{ path: "workflows/current.json", filename: "current.json", key: "cur", active: true, modified: true, persisted: true }] }),
    workflow_open: ({ path }) => ({ opened: { path, filename: path } }),
    workflow_rename: ({ name }) => ({ renamed: { to: `${name}.json` } }),
    workflow_close: ({ path }) => ({ closed: { path } }),
    graph_select_nodes: ({ node_ids }) => { selection = (node_ids || []).map(Number); return { selected: node_ids }; },
    graph_create_subgraph: ({ node_ids }) => { const id = ++seq; subgraphs.set(id, new Map()); nodes.set(id, { id, type: "Subgraph", title: "Subgraph", is_subgraph: true, widgets: {}, inputs: [], outputs: [] }); selection = [id]; return { subgraph: { node_id: id, name: "Subgraph", from_nodes: node_ids } }; },
    // Copy/paste — clipboard PERSISTS across workflow switches (cross-workflow merge).
    graph_copy_nodes: ({ node_ids }) => {
      const ids = (Array.isArray(node_ids) && node_ids.length ? node_ids.map(Number) : selection);
      const src = ids.map((id) => cur().get(Number(id))).filter(Boolean);
      if (!src.length) throw new Error("nothing selected to copy — pass node_ids or select nodes first");
      clipboard = src.map((n) => ({ type: n.type, title: n.title, widgets: { ...n.widgets } }));
      return { copied: clipboard.length };
    },
    graph_paste_nodes: () => {
      if (!clipboard.length) throw new Error("clipboard is empty — graph_copy_nodes first");
      const pasted = clipboard.map((c) => mk(cur(), c.type, c.title, { ...c.widgets }));
      return { pasted_count: pasted.length, pasted_node_ids: pasted.map((n) => n.id), pasted: pasted.map(brief) };
    },
    // Subgraph blueprints — save/list/add reusable subgraphs.
    graph_save_subgraph: ({ node_id, name }) => {
      const id = node_id != null ? Number(node_id) : selection[0];
      const n = id != null ? nodes.get(id) : null;
      if (!n || !n.is_subgraph) throw new Error("select a single subgraph node (or pass node_id) before saving");
      const finalName = (typeof name === "string" && name.trim()) ? name.trim() : (n.title || "Subgraph");
      blueprints.set(finalName, { name: finalName, type: `SubgraphBlueprint.${finalName}` });
      return { saved: { name: finalName, from_node_id: id, type: `SubgraphBlueprint.${finalName}` } };
    },
    graph_list_subgraphs: () => ({ count: blueprints.size, blueprints: [...blueprints.values()].map((b) => ({ ...b, display_name: b.name, description: null, is_global: false })) }),
    graph_add_subgraph: ({ name, pos }) => {
      const key = String(name).replace(/^SubgraphBlueprint\./, "");
      if (!blueprints.has(key)) throw new Error(`No saved subgraph blueprint "${name}"`);
      const id = ++seq;
      const inner = new Map();
      nodes.set(id, { id, type: `SubgraphBlueprint.${key}`, title: key, is_subgraph: true, widgets: {}, inputs: [], outputs: [] });
      subgraphs.set(id, inner);
      return { added: brief(nodes.get(id)), from_blueprint: `SubgraphBlueprint.${key}` };
    },
    // Built-in Manager (v2) mock
    nodes_search: ({ query }) => ({
      count: 1,
      results: [{ id: "comfyui-kjnodes", title: "ComfyUI-KJNodes", description: `matches ${query}` }],
    }),
    nodes_list: () => ({ installed: { node_packs: {} } }),
    nodes_install: ({ id, repository }) => ({ queued: true, ui_id: "test-ui", id: id ?? repository }),
    graph_update_node: ({ id }) => ({ queued: true, ui_id: "test-ui", id, version: "latest" }),
    nodes_queue_status: () => ({ status: { done_count: 1, total_count: 1, in_progress_count: 0 } }),
    comfy_reboot: () => ({ rebooting: true }),
    // Destructive-op confirmation card → always answer with the affirmative
    // (first) option so the gated tool proceeds in tests. isAffirmative() keys on
    // the leading "Yes".
    ask_user: (m) => (m.options && m.options[0] && m.options[0].label) || "yes",
  };
  return { nodes, EXEC };
}

function waitForPort(port, timeoutMs = 15000) {
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

function runScenario(sc, idx) {
  return new Promise((resolve) => {
    const { nodes, EXEC } = makeGraph(sc.seed || 0);
    const commands = [];
    const says = [];
    let done = false;
    let graceTimer = null;
    let phase = 0;
    let saysBeforeEvent = -1;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const hard = setTimeout(finish, SCENARIO_CAP_MS);
    function onIdle() {
      // After the first turn settles, optionally fire a follow-up event (e.g. a
      // run-finished) and wait for the agent's reaction before finishing.
      if (sc.followEvent && phase === 0) {
        phase = 1;
        saysBeforeEvent = says.length;
        try { ws.send(JSON.stringify(sc.followEvent)); } catch {}
        return;
      }
      finish();
    }
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(hard); if (graceTimer) clearTimeout(graceTimer);
      try { ws.close(); } catch {}
      const counts = {};
      for (const c of commands) counts[c] = (counts[c] || 0) + 1;
      resolve({ counts, says, finalNodes: nodes.size, saysBeforeEvent });
    }
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", tab_id: `test-${idx}-${sc.seed}`, title: "test" }));
      setTimeout(() => ws.send(JSON.stringify({ type: "user_message", text: sc.task })), 1200);
    });
    ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (typeof m.rid === "string" && typeof m.cmd === "string") {
        commands.push(m.cmd);
        let reply;
        try { const fn = EXEC[m.cmd]; if (!fn) throw new Error(`unknown ${m.cmd}`); reply = { rid: m.rid, ok: true, result: fn(m) }; }
        catch (e) { reply = { rid: m.rid, ok: false, error: e.message }; }
        try { ws.send(JSON.stringify(reply)); } catch {}
        return;
      }
      if (m.type === "say") says.push(m.text);
      // The result push carries a numeric context_pct → turn finished; grace then advance.
      if (m.type === "agent_status" && typeof m.context_pct === "number") {
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = setTimeout(onIdle, 3500);
      }
    });
    ws.on("error", () => {});
  });
}

const SCENARIOS = [
  {
    name: "build graph on canvas (#6)",
    seed: 0,
    task: "Add a CheckpointLoaderSimple node and a KSampler node to my canvas, then connect the checkpoint MODEL output to the KSampler model input. Don't generate, just build.",
    check: (r) => ({
      pass: (r.counts.graph_add_node || 0) >= 2 && (r.counts.graph_connect || 0) >= 1 && !r.counts.graph_clear,
      detail: `add=${r.counts.graph_add_node || 0} connect=${r.counts.graph_connect || 0} clear=${r.counts.graph_clear || 0}`,
    }),
  },
  {
    name: "new workflow is NON-destructive",
    seed: 6,
    task: "This fruit-stand workflow is done. Start a brand-new workflow for a short video — a fresh canvas for the new project.",
    check: (r) => ({
      pass: (r.counts.workflow_new || 0) >= 1 && !r.counts.graph_clear && r.finalNodes === 6,
      detail: `workflow_new=${r.counts.workflow_new || 0} clear=${r.counts.graph_clear || 0} nodesLeft=${r.finalNodes}/6`,
    }),
  },
  {
    name: "explicit clear STILL works (and confirms first)",
    seed: 4,
    task: "Wipe this canvas completely — delete every node on the current workflow so it's empty.",
    check: (r) => {
      const cleared = (r.counts.graph_clear || 0) >= 1;
      const removed = (r.counts.graph_remove_node || 0) >= 4;
      // The destructive gate: if it used panel_clear, the confirm card must have fired first.
      const gated = !cleared || (r.counts.ask_user || 0) >= 1;
      return {
        pass: (cleared || removed) && gated,
        detail: `clear=${r.counts.graph_clear || 0} remove=${r.counts.graph_remove_node || 0} ask_user=${r.counts.ask_user || 0}`,
      };
    },
  },
  {
    name: "create subgraph from nodes",
    seed: 3,
    task: "Group nodes 1, 2 and 3 on my canvas into a single subgraph.",
    check: (r) => ({
      pass: (r.counts.graph_create_subgraph || 0) >= 1,
      detail: `create_subgraph=${r.counts.graph_create_subgraph || 0} select=${r.counts.graph_select_nodes || 0}`,
    }),
  },
  {
    name: "merges nodes via copy → paste",
    seed: 3,
    task: "Copy all the nodes on my current canvas and paste a second copy of them onto the canvas, so I have two sets. Just copy and paste — don't rebuild them by hand.",
    check: (r) => ({
      pass: (r.counts.graph_copy_nodes || 0) >= 1 && (r.counts.graph_paste_nodes || 0) >= 1 && !r.counts.graph_clear,
      detail: `copy=${r.counts.graph_copy_nodes || 0} paste=${r.counts.graph_paste_nodes || 0} add=${r.counts.graph_add_node || 0} nodesLeft=${r.finalNodes}`,
    }),
  },
  {
    name: "saves a subgraph to the library",
    seed: "subgraph",
    task: "There's a subgraph node on my canvas. Save it to my reusable subgraph library under the name 'MyBlock' so I can drop it into other workflows later.",
    check: (r) => ({
      pass: (r.counts.graph_save_subgraph || 0) >= 1,
      detail: `save_subgraph=${r.counts.graph_save_subgraph || 0} list=${r.counts.graph_list_subgraphs || 0} add=${r.counts.graph_add_subgraph || 0}`,
    }),
  },
  {
    name: "renames a node's title",
    seed: 3,
    task: "Rename the node with id 1 on my canvas: set its title to 'Main Loader'. Just change that one node's title now — don't ask me to confirm.",
    check: (r) => ({
      pass: (r.counts.graph_set_title || 0) >= 1,
      detail: `set_title=${r.counts.graph_set_title || 0}`,
    }),
  },
  {
    name: "edits inside a subgraph",
    seed: "subgraph",
    task: "There's a subgraph node on my canvas. Set the noise_seed on the KSampler INSIDE that subgraph to 42.",
    check: (r) => ({
      pass: (r.counts.graph_enter_subgraph || 0) >= 1 && (r.counts.graph_set_widget || 0) >= 1,
      detail: `enter=${r.counts.graph_enter_subgraph || 0} set_widget=${r.counts.graph_set_widget || 0} exit=${r.counts.graph_exit_subgraph || 0}`,
    }),
  },
  {
    name: "asks the user to choose first (chat or picker)",
    seed: 0,
    task: "I want to turn my current image into a short video, using either WAN or Kling. Do NOT build or add any nodes yet — first ask me which of the two I want, and wait for my answer.",
    check: (r) => {
      // Modern behavior: the agent may present the choice via the panel_ask card
      // (ask_user) OR in plain chat text — either is a valid "ask first". What it
      // must NOT do is barrel ahead building before asking. Accept a plain-chat ask
      // that poses a question naming at least one option (it needn't echo both back).
      const txt = r.says.join(" ").toLowerCase();
      const asksInChat = txt.includes("?") && (txt.includes("wan") || txt.includes("kling"));
      const viaPicker = (r.counts.ask_user || 0) >= 1;
      const builtAnyway = (r.counts.graph_add_node || 0) >= 1;
      return {
        pass: (asksInChat || viaPicker) && !builtAnyway,
        detail: `asksInChat=${asksInChat} viaPicker=${viaPicker} builtAnyway=${builtAnyway}`,
      };
    },
  },
  {
    name: "installs missing node via built-in Manager",
    seed: 0,
    task: "I don't have the KJNodes (ComfyUI-KJNodes) custom-node pack installed and I need it. Install it for me now using the node manager — go ahead and do the install, don't just tell me how.",
    check: (r) => ({
      pass: (r.counts.nodes_install || 0) >= 1,
      detail: `search=${r.counts.nodes_search || 0} install=${r.counts.nodes_install || 0} reboot=${r.counts.comfy_reboot || 0}`,
    }),
  },
  {
    name: "run-finished event reaches agent (#7)",
    seed: 2,
    task: "I'm about to render my fruit-stand image — just stand by, you'll get an event when it finishes.",
    followEvent: {
      type: "agent_event",
      kind: "executed",
      images: [{ filename: "IDEOGRAM_00007.png", subfolder: "", type: "output" }],
    },
    check: (r) => ({
      pass: r.saysBeforeEvent >= 0 && r.says.length > r.saysBeforeEvent,
      detail: `reactedToEvent=${r.says.length > r.saysBeforeEvent} (says ${r.saysBeforeEvent}→${r.says.length})`,
    }),
  },
  {
    // VIDEO-VISION: the panel can't show the agent a raw video, so on a video
    // output it builds a frame-storyboard PNG (browser-side), uploads it to
    // input/, and delivers THAT as an inline image with a `note`. This simulates
    // the agent_event the panel emits for a storyboard and asserts (a) the agent
    // reacts and (b) it understood it was looking at a video storyboard (mentions
    // the video / motion / frames), proving the note+image reached it.
    name: "video storyboard reaches agent (VIDEO-VISION)",
    seed: 0,
    task: "I'm about to render a short video — just stand by, you'll get a storyboard event when it finishes.",
    followEvent: {
      type: "agent_event",
      kind: "executed",
      images: [{ filename: "storyboard_AnimateDiff_00007.png", subfolder: "", type: "input" }],
      note:
        "📽️ 20-frame storyboard (contact sheet) of the video you just generated " +
        "(file AnimateDiff_00007.mp4) — frames run top-left→bottom-right = start→end. " +
        "Review motion, sharpness, and temporal consistency.",
    },
    check: (r) => {
      const reacted = r.saysBeforeEvent >= 0 && r.says.length > r.saysBeforeEvent;
      const after = r.says.slice(r.saysBeforeEvent < 0 ? 0 : r.saysBeforeEvent).join(" ").toLowerCase();
      const understood = /video|storyboard|motion|frame|clip|animation/.test(after);
      return {
        pass: reacted && understood,
        detail: `reacted=${reacted} understoodVideo=${understood} (says ${r.saysBeforeEvent}→${r.says.length})`,
      };
    },
  },
];

async function main() {
  console.log(`[test-agent] starting test orchestrator on :${PORT} (COMFYUI_URL=${DEAD_COMFY})`);
  const env = { ...process.env, COMFYUI_MCP_BRIDGE_PORT: String(PORT), COMFYUI_URL: DEAD_COMFY, COMFYUI_MCP_PARENT_PID: "" };
  delete env.COMFYUI_MCP_PARENT_PID;
  let stdio = ["ignore", "ignore", "ignore"];
  let logFd = null;
  if (LOG_ORCH) {
    logFd = fs.openSync(fileURLToPath(new URL("../test-orch-debug.log", import.meta.url)), "w");
    stdio = ["ignore", logFd, logFd];
  }
  const orch = spawn(process.execPath, [MCP_ENTRY, "--panel-orchestrator"], { env, stdio });
  let exitCode = 1;
  try {
    await waitForPort(PORT);
    console.log("[test-agent] orchestrator up. running scenarios...\n");
    // These scenarios drive a REAL Claude session, so a pass is probabilistic:
    // the agent can do each task but doesn't choose the expected action 100% of
    // the time. Retry ONLY on failure (a passing scenario costs one run) up to
    // MAX_ATTEMPTS — a genuinely broken feature still fails every attempt, while
    // an LLM-judgment flake gets the retries it needs to be reliably green.
    const MAX_ATTEMPTS = Number(process.env.COMFYUI_MCP_TEST_ATTEMPTS) || 3;
    const results = [];
    for (let i = 0; i < SCENARIOS.length; i++) {
      if (FILTER && !SCENARIOS[i].name.includes(FILTER)) continue;
      process.stdout.write(`  • ${SCENARIOS[i].name} ... `);
      let v, r, attempt = 0;
      do {
        attempt += 1;
        r = await runScenario(SCENARIOS[i], i);
        v = SCENARIOS[i].check(r);
      } while (!v.pass && attempt < MAX_ATTEMPTS);
      const tries = attempt > 1 ? ` [${attempt} attempts]` : "";
      results.push({ name: SCENARIOS[i].name, ...v, cmds: JSON.stringify(r.counts), attempts: attempt });
      console.log((v.pass ? `PASS (${v.detail})` : `FAIL (${v.detail})`) + tries);
    }
    const fails = results.filter((r) => !r.pass);
    console.log(`\n===== ${results.length - fails.length}/${results.length} PASSED =====`);
    for (const r of results) console.log(`${r.pass ? "✓" : "✗"} ${r.name}  [${r.cmds}]`);
    exitCode = fails.length;
  } catch (e) {
    console.error("[test-agent] ERROR:", e.message);
    exitCode = 1;
  } finally {
    try { orch.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { orch.kill("SIGKILL"); } catch {}; process.exit(exitCode); }, 1000);
  }
}
main();
