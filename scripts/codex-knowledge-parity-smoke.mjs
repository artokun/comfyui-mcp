// CODEX KNOWLEDGE-PARITY SMOKE — proves the Codex backend has the SAME bundled
// family expertise Claude gets natively. Claude loads all plugin skills; Codex
// loads none, but now reaches the identical knowledge through the comfyui MCP's
// list_packs tool (actions "skill_list" / "skill_read" / "list" / "read_workflow").
//
// Starts a codex-mode orchestrator + a headless mock panel (graph executors),
// points the headless comfyui MCP's COMFYUI_MCP_TOOL_TRACE at a temp JSONL file
// so we can observe the skill/pack tool calls (they ride the stdio MCP, not the
// panel bridge), then prompts "set up a krea2 workflow on my canvas" and asserts:
//   1) Codex DISCOVERED the krea2 family via action:"skill_list"/"skill_read" (or
//      the pack equivalents action:"list"/"read_workflow") — NOT from-scratch guessing.
//   2) Codex APPLIED the pack / loaded the pack's ready workflow (action:"read_workflow"
//      and/or apply_manifest, then built nodes on the canvas) — NOT a generic graph.
//
//   node scripts/codex-knowledge-parity-smoke.mjs
//
// Env: TEST_PORT (default 9151), SCENARIO_CAP_MS (default 240000 — Codex + reading
//      a full SKILL.md is slow).

import { spawn } from "node:child_process";
import { makeGraph, parityVerdict, MOCK_WORKFLOW_UUID } from "./knowledge-parity-mock-graph.mjs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import net from "node:net";
import { WebSocket } from "ws";

/** Panel version the mock advertises (#1384). Kept in step with the product's own derived
 *  fence minimum by src/__tests__/scripts/knowledge-parity-mock-version.test.ts — a raised
 *  floor fails that test instead of silently refusing every graph write in the smoke. */
const MOCK_PANEL_VERSION = "0.15.101";
/** A well-formed workflow uuid, so the per-command stamp fence has something to fence on. */
// MOCK_WORKFLOW_UUID is imported above — it belongs with the executors that answer with it.

const PORT = Number(process.env.TEST_PORT || 9151);
const MCP_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const COMFY_PATH = fileURLToPath(new URL("..", import.meta.url)); // a real dir w/ packs/ + plugin/
const DEAD_COMFY = "http://127.0.0.1:9";
const CAP_MS = Number(process.env.SCENARIO_CAP_MS || 240000);
const TRACE = join(tmpdir(), `comfyui-mcp-tooltrace-${PORT}-${Date.now()}.jsonl`);


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

/** Wait for a line to appear in a log file the child is writing. */
function waitForLine(path, needle, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let text = "";
      try {
        text = fs.readFileSync(path, "utf8");
      } catch {
        // Not created yet.
      }
      if (text.includes(needle)) return resolve(true);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for "${needle}" in ${path}`));
      }
      setTimeout(tick, 250);
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
    // SEND AN ORIGIN, because a real panel does (#1384). A browser sets this header on the
    // upgrade and forbids page JS from overriding it, so the bridge treats it as trusted
    // provenance of the page the socket runs in — and refuses every graph EDIT without one.
    // The `ws` library sends no Origin by default, so the mock read as a relay connection
    // of unknown provenance and the smoke reported a knowledge failure that was really its
    // own handshake. The refusal is correct product behaviour; the mock was the thing
    // pretending to be a browser without doing what a browser does.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Origin: DEAD_COMFY },
    });
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
      // #1384 — ADVERTISE A PANEL VERSION AND THE FENCE CAPABILITIES.
      //
      // The hello carried only tab_id and title, so the graph-write fence refused
      // `graph_clear` before the mock executor ever saw it: "this tab advertised NO panel
      // version". The smoke exercises graph writes, so a mock that cannot pass the write
      // fence tests nothing it claims to.
      //
      // MOCK_PANEL_VERSION is asserted against the product's own derived minimum by
      // src/__tests__/scripts/knowledge-parity-mock-version.test.ts. A literal here is a
      // second copy of a number the code already computes — it went stale once (the fence
      // floor moved to 0.11.35) and would have again, since #1359 raised
      // requiredPanelVersion() to 0.13.0. The ratchet makes a raised floor fail a test
      // that names this file, instead of surfacing months later as a fence bug.
      ws.send(
        JSON.stringify({
          type: "hello",
          tab_id: `codex-kp-smoke`,
          title: "smoke",
          panel_version: MOCK_PANEL_VERSION,
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
          enforces_expected_node_type_at_write: true,
          enforces_expected_scope_at_write: true,
          enforces_expected_scope_graph_identity_at_write: true,
          enforces_promoted_parent_rail_at_write: true,
          workflow_uuid: MOCK_WORKFLOW_UUID,
        }),
      );
      setTimeout(() => { console.log(`   -> TASK: ${task}`); ws.send(JSON.stringify({ type: "user_message", text: task })); }, 1500);
    });
    ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (typeof m.rid === "string" && typeof m.cmd === "string") {
        commands.push(m.cmd);
        let reply;
        // ENFORCE THE STAMP WE ADVERTISE (#1384, codex). The hello claims
        // `enforces_workflow_stamp` and `enforces_workflow_stamp_at_write`; a mock that
        // claims them and then executes whatever arrives is certifying behaviour it does
        // not have, so the smoke would pass against a stale-stamp bug that a real panel
        // refuses. A command carrying no stamp is left alone — reads are not fenced.
        const stamp = m.workflow_uuid ?? m.expected_workflow_uuid;
        if (typeof stamp === "string" && stamp !== MOCK_WORKFLOW_UUID) {
          ws.send(
            JSON.stringify({
              rid: m.rid,
              ok: false,
              error: `workflow stamp mismatch: command carried ${stamp}, this tab holds ${MOCK_WORKFLOW_UUID}`,
            }),
          );
          return;
        }
        try {
          const fn = EXEC[m.cmd];
          // SAY WHAT THIS IS. `unknown graph_outline` from a tab advertising a current
          // panel version reads as a product defect, and an agent with a bug-report tool
          // will file it as one. Naming the harness in the error costs nothing and stops
          // the next run from opening an issue about a stub.
          if (!fn)
            throw new Error(
              `unknown ${m.cmd} — this tab is the knowledge-parity SMOKE MOCK ` +
                `(scripts/codex-knowledge-parity-smoke.mjs), not a real panel. It implements a ` +
                `subset of the bridge. Do not file this as a panel defect; work with what is ` +
                `available or say the command is unavailable here.`,
            );
          reply = { rid: m.rid, ok: true, result: fn(m) };
        }
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
    // WAIT FOR THE ORCHESTRATOR TO SAY IT IS READY (#1384).
    //
    // The bridge binds FIRST and the per-tab message handler is installed much later —
    // ~4 seconds apart on this machine. Probing the bridge port declared the orchestrator
    // "up" while it was still booting, so the scenario's user_message arrived before
    // `onPanelMessage` existed and was dropped: the run reported "Codex consulted bundled
    // skills: NO" with an EMPTY tool trace, a harness race indistinguishable in the output
    // from the knowledge failure this smoke exists to detect.
    //
    // Waiting for a LATER PORT is not a fix either (codex): the console binds before the
    // handler is installed, and COMFYUI_MCP_CONSOLE_PORT can move it, so a hard-coded
    // PORT+3 can wait for something that never binds. The "ready" line is printed after
    // the handler is in place, and it is the orchestrator's own statement rather than an
    // inference from one of its side effects.
    await waitForPort(PORT);
    await waitForLine(logPath, "[panel-orchestrator] ready —");
    console.log("[kp-smoke] orchestrator up.\n");

    console.log("• Scenario: set up a krea2 workflow on my canvas");
    const r = await runScenario("Clear my workflow and set up a krea2 text-to-image workflow on my canvas. Use whatever ready expertise comfyui-mcp already ships if there is any — don't reinvent the graph.");

    const trace = readTrace();
    // Since 0.50.0 slice 9 every knowledge call is `list_packs` and the action
    // rides in args, so the trace is keyed by action rather than by tool name.
    const actions = trace.map((t) => t.args?.action);
    const byAction = (action) => trace.filter((t) => t.args?.action === action);
    const readSkillArgs = byAction("skill_read").map((t) => t.args?.name);
    const readPackArgs = byAction("read_workflow").map((t) => t.args?.name);

    const calledListSkills = actions.includes("skill_list");
    const calledReadSkill = actions.includes("skill_read");
    const calledListPacks = actions.includes("list");
    const calledReadPack = actions.includes("read_workflow");
    const discoveredKrea2 =
      readSkillArgs.some((n) => String(n || "").includes("krea2")) ||
      readPackArgs.some((n) => String(n || "").includes("krea2"));

    // Discovery = consulted the bundled knowledge (skills and/or packs) for the family.
    const discovery = calledListSkills || calledReadSkill || calledListPacks || calledReadPack;
    // Applied ready expertise = read the pack workflow (the expert graph) and/or
    // built nodes on the canvas from it.
    // THE CANVAS, not one command that changes it (codex). The PREFERRED path is a single
    // `graph_load` of the pack's ready workflow, which populates the canvas without a single
    // `graph_add_node` — so counting adds alone failed the very route this smoke is meant to
    // reward.
    const builtOnCanvas = r.finalNodes > 0 || (r.counts.graph_add_node || 0) >= 1;
    const appliedPack = calledReadPack || discoveredKrea2;

    console.log(`\n===== CODEX KNOWLEDGE-PARITY SMOKE =====`);
    console.log(`tool trace (list_packs actions): ${JSON.stringify(actions)}`);
    console.log(`action:"skill_read" names: ${JSON.stringify(readSkillArgs)}`);
    console.log(`action:"read_workflow" names: ${JSON.stringify(readPackArgs)}`);
    console.log(`all bridge commands: ${JSON.stringify(r.counts)}`);
    console.log(`---`);
    console.log(`Codex consulted bundled skills/packs (list_packs actions skill_list/skill_read/list/read_workflow): ${discovery ? "YES" : "NO"}`);
    console.log(`Codex discovered the krea2 family (krea2-* skill or pack): ${discoveredKrea2 ? "YES" : "NO"}`);
    console.log(`Codex applied the pack / read its ready workflow: ${appliedPack ? "YES" : "NO"}`);
    console.log(`Codex built nodes on the live canvas: ${builtOnCanvas ? "YES" : "NO"}`);

    // PASS = it discovered the family knowledge, used the ready pack expertise, AND the
    // canvas actually changed. `builtOnCanvas` was printed as a criterion and then left out
    // of the verdict (codex), so a run that read the pack and applied NOTHING — the
    // zero-node load this file also fixes — passed while reporting "built nodes: NO".
    exitCode = parityVerdict({ discovery, discoveredKrea2, appliedPack, builtOnCanvas }) ? 0 : 1;
    console.log(`\n${exitCode === 0 ? "PASS" : "FAIL"} — knowledge parity ${exitCode === 0 ? "achieved" : "NOT achieved"}.`);
  } catch (e) {
    console.error("[kp-smoke] ERROR:", e.message);
  } finally {
    try { orch.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { orch.kill("SIGKILL"); } catch {}; console.log(`[kp-smoke] orchestrator log: ${logPath}`); process.exit(exitCode); }, 1500);
  }
}
main();
