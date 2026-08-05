import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRAPH_CMD_EFFECT,
  isMutatingGraphCommand,
  requiresWorkflowStampEnforcement,
  BRIDGE_READONLY_CMDS,
} from "../../services/ui-bridge.js";

/**
 * #778 — a READ blocked by a WRITE gate, and the reason it could happen at all.
 *
 * The #570 workflow fence asks "can this command apply to the wrong workflow's
 * content?" and used to answer it with `!BRIDGE_READONLY_CMDS.has(cmd)` — a set
 * that exists to answer a DIFFERENT question ("is this safe to re-dispatch after
 * a reconnect?"). Every graph command that is a genuine read but not idempotently
 * re-dispatchable, and every view/selection/scope change, fell through the crack:
 * `graph_find_nodes` was the one a user reported, and it was not alone.
 *
 * These tests hold two properties:
 *
 *  1. COMPLETENESS — every `graph_*` command the orchestrator actually dispatches
 *     has an explicit entry in GRAPH_CMD_EFFECT. Without this the fail-closed
 *     default silently classifies a new read as a write, which is exactly how
 *     #778 shipped: nothing failed, the command just stopped working on older
 *     panels.
 *  2. CORRECTNESS — the classification each command has is the intended one, and
 *     the gate agrees with it.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..");

/** Every `cmd: "graph_…"` literal in the orchestrator's non-test sources. */
function dispatchedGraphCommands(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts")) continue;
      const src = readFileSync(full, "utf8");
      for (const m of src.matchAll(/cmd:\s*"(graph_[a-z0-9_]+)"/g)) found.add(m[1]);
    }
  };
  walk(SRC);
  return found;
}

describe("GRAPH_CMD_EFFECT — the ledger is complete", () => {
  it("finds the graph commands at all (guards the scanner itself)", () => {
    const dispatched = dispatchedGraphCommands();
    // A scanner that silently matched nothing would make the completeness test
    // below vacuously green — the failure mode this whole file exists to prevent.
    expect(dispatched.size).toBeGreaterThan(30);
    expect(dispatched.has("graph_set_widget")).toBe(true);
    expect(dispatched.has("graph_find_nodes")).toBe(true);
  });

  it("classifies EVERY graph_* command the orchestrator dispatches", () => {
    const unclassified = [...dispatchedGraphCommands()]
      .filter((cmd) => GRAPH_CMD_EFFECT[cmd] === undefined)
      .sort();
    // If this fails you added a graph_* command without deciding what it does to
    // the user's workflow. It is currently being treated as a WRITE by omission,
    // which blocks it on every panel below the fence version — add it to
    // GRAPH_CMD_EFFECT in src/services/ui-bridge.ts.
    expect(unclassified).toEqual([]);
  });

  it("classifies nothing it does not dispatch (no stale ledger entries)", () => {
    const dispatched = dispatchedGraphCommands();
    const stale = Object.keys(GRAPH_CMD_EFFECT)
      .filter((cmd) => !dispatched.has(cmd))
      .sort();
    expect(stale).toEqual([]);
  });
});

describe("GRAPH_CMD_EFFECT — the classification is the intended one", () => {
  // The commands #778 and its unreported siblings are about. Each is a read, or
  // changes only what the user is LOOKING AT / has selected / has on the
  // clipboard. None can alter workflow content, so fencing them to a workflow
  // buys nothing and refusing them on an old panel only removes read access.
  const INERT = [
    "graph_find_nodes", // #778, the reported instance
    "graph_list_subgraphs",
    "graph_screenshot",
    "graph_canvas",
    "graph_select_nodes",
    "graph_enter_subgraph", // #823 hit this one
    "graph_exit_subgraph",
    "graph_copy_nodes",
    "graph_outline",
    "graph_query",
    "graph_get_state",
    "graph_serialize",
  ] as const;

  it.each(INERT)("%s is inert and is NOT gated by the workflow fence", (cmd) => {
    expect(GRAPH_CMD_EFFECT[cmd]).toBe("inert");
    expect(isMutatingGraphCommand(cmd)).toBe(false);
    expect(requiresWorkflowStampEnforcement({ cmd })).toBe(false);
  });

  // The gate must not have been loosened into uselessness while fixing #778.
  const TARGETED = [
    "graph_set_widget", // #812
    "graph_add_node", // #812
    "graph_remove_node",
    "graph_clear",
    "graph_load",
    "graph_paste_nodes",
    "graph_save_subgraph",
    "graph_run",
  ] as const;

  it.each(TARGETED)("%s is targeted and IS gated by the workflow fence", (cmd) => {
    expect(GRAPH_CMD_EFFECT[cmd]).toBe("targeted");
    expect(isMutatingGraphCommand(cmd)).toBe(true);
    expect(requiresWorkflowStampEnforcement({ cmd })).toBe(true);
  });

  it("an UNKNOWN graph command still fails closed", () => {
    // The ledger removes the SILENT default; it must not remove the default.
    expect(GRAPH_CMD_EFFECT.graph_not_a_real_command).toBeUndefined();
    expect(isMutatingGraphCommand("graph_not_a_real_command")).toBe(true);
    expect(requiresWorkflowStampEnforcement({ cmd: "graph_not_a_real_command" })).toBe(true);
  });

  it("a non-graph command is not swept into the graph gate", () => {
    expect(isMutatingGraphCommand("workflow_save")).toBe(false);
    expect(isMutatingGraphCommand("ui_toast")).toBe(false);
  });
});

describe("GRAPH_CMD_EFFECT vs BRIDGE_READONLY_CMDS — two questions, two answers", () => {
  it("every graph command in the re-dispatch-safe set is also inert", () => {
    // One direction only. A command safe to RE-DISPATCH must be harmless, so it
    // must be inert. The converse is deliberately false — see graph_canvas.
    for (const cmd of BRIDGE_READONLY_CMDS) {
      if (!cmd.startsWith("graph_")) continue;
      expect(GRAPH_CMD_EFFECT[cmd]).toBe("inert");
    }
  });

  it("graph_canvas is inert for the fence but NOT re-dispatch-safe", () => {
    // The concrete case that proves the two sets answer different questions, and
    // the reason collapsing them was wrong in both directions: `pan` is a dx/dy
    // DELTA, so parking it across a reconnect and replaying it pans twice — yet
    // it cannot touch workflow content, so gating it as a canvas mutation was
    // just as wrong.
    expect(GRAPH_CMD_EFFECT.graph_canvas).toBe("inert");
    expect(BRIDGE_READONLY_CMDS.has("graph_canvas")).toBe(false);
  });
});
