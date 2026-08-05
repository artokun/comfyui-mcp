import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRAPH_CMD_EFFECT,
  isMutatingGraphCommand,
  requiresWorkflowStampEnforcement,
  requiredPanelVersion,
  requiredPanelVersionForWorkflowFence,
  BRIDGE_CAPABILITY_MIN_PANEL_VERSION,
  BRIDGE_CMD_MIN_PANEL_VERSION,
  MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS,
  SEMVER_RE,
  BRIDGE_READONLY_CMDS,
  unclassifiedGraphCommandsSeen,
  __resetUnclassifiedGraphCommands,
} from "../../services/ui-bridge.js";
import { compareSemver } from "../../services/self-update.js";
import { buildPanelToolDefs } from "../../orchestrator/panel-tools.js";

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

/**
 * Every `"graph_…"` string LITERAL in the orchestrator's non-test sources, with
 * comments stripped first.
 *
 * Deliberately widened from the original `cmd: "graph_…"` property match. That
 * pattern only recognised one spelling, so a command routed through a helper, an
 * alias table, or `ctx.call({ cmd })` walked around the completeness check AND
 * the stale-entry check with the suite still green — a guard a rename can step
 * over, which is the thing this codebase keeps relearning. Matching any literal
 * means evading it now requires never writing the name down at all — assembling
 * it from fragments at runtime — and the runtime probe below closes that.
 * (The tool-vocabulary gate rejects an assembled name for the same reason, and
 * it reads comments too: writing the illustrative fragment out here tripped it.)
 *
 * Comments are stripped because prose legitimately names commands while
 * discussing them, and a scanner that cannot tell code from commentary would
 * either miss real entries or invent fake ones.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function graphCommandLiteralsInSource(): Set<string> {
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
      const src = stripComments(readFileSync(full, "utf8"));
      for (const m of src.matchAll(/"(graph_[a-z0-9_]+)"/g)) found.add(m[1]);
    }
  };
  walk(SRC);
  return found;
}

/**
 * Every `graph_*` command the real tool surface actually DISPATCHES, observed by
 * driving each panel tool handler and recording what reaches `ctx.call`.
 *
 * This is the half a source scan cannot do. It sees the command as ROUTED, so a
 * helper, an alias, or a computed name is caught regardless of how it is
 * spelled. It is also necessarily partial — a handler that throws on synthetic
 * args before dispatching contributes nothing — which is why it stands ALONGSIDE
 * the literal scan rather than replacing it: between them, evading both means
 * neither writing the name down nor dispatching it.
 */
function dispatchedGraphCommandsAtRuntime(): { cmds: Set<string>; toolsThatDispatched: number } {
  const cmds = new Set<string>();
  let toolsThatDispatched = 0;
  // Plausible values for the common required params, so more handlers get past
  // their own guards and reach a dispatch. Anything still unhappy just throws
  // and is skipped.
  const ARGS: Record<string, unknown> = {
    node_id: 1,
    node_ids: [1, 2],
    id: 1,
    node: "PreviewImage",
    type: "PreviewImage",
    widget: "steps",
    value: 1,
    name: "x",
    title: "x",
    text: "x",
    query: "x",
    group: 1,
    from_node: 1,
    to_node: 1,
    from_slot: 0,
    to_slot: 0,
    input: "image",
    output: "IMAGE",
    action: "fit",
    mode: "active",
    pos: [0, 0],
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    scale: 1,
    color: "#fff",
    preset: "red",
    path: "workflows/x.json",
    collapsed: true,
    force: true,
  };
  for (const def of buildPanelToolDefs()) {
    let dispatched = false;
    const ctx = {
      call: async (cmd: Record<string, unknown>) => {
        if (typeof cmd.cmd === "string") {
          if (cmd.cmd.startsWith("graph_")) cmds.add(cmd.cmd);
          dispatched = true;
        }
        return { content: [{ type: "text", text: "{}" }] };
      },
      confirm: async () => "yes" as const,
      bridge: {
        send: async () => ({}),
        push: () => 1,
        canReach: () => true,
        isHeadless: () => false,
        tabs: () => [{ tab_id: "tab-1", title: "t", connected_at: 0 }],
        resolveActiveTabId: () => "tab-1",
      },
      tabId: "tab-1",
      ensureReachable: () => {},
    } as unknown as Parameters<ReturnType<typeof buildPanelToolDefs>[number]["handler"]>[1];
    try {
      // Handlers are async; a rejection is as uninteresting as a throw here.
      const r = def.handler({ ...ARGS }, ctx) as unknown as Promise<unknown>;
      if (r && typeof (r as Promise<unknown>).catch === "function") void r.catch(() => {});
    } catch {
      /* this handler needs more than synthetic args — the literal scan covers it */
    }
    if (dispatched) toolsThatDispatched += 1;
  }
  return { cmds, toolsThatDispatched };
}

describe("GRAPH_CMD_EFFECT — the ledger is complete", () => {
  it("finds the graph commands at all (guards the scanner itself)", () => {
    const dispatched = graphCommandLiteralsInSource();
    // A scanner that silently matched nothing would make the completeness test
    // below vacuously green — the failure mode this whole file exists to prevent.
    expect(dispatched.size).toBeGreaterThan(30);
    expect(dispatched.has("graph_set_widget")).toBe(true);
    expect(dispatched.has("graph_find_nodes")).toBe(true);
  });

  it("classifies EVERY graph_* command named anywhere in the orchestrator's source", () => {
    const unclassified = [...graphCommandLiteralsInSource()]
      .filter((cmd) => GRAPH_CMD_EFFECT[cmd] === undefined)
      .sort();
    // If this fails you added a graph_* command without deciding what it does to
    // the user's workflow. It is currently being treated as a WRITE by omission,
    // which blocks it on every panel below the fence version — add it to
    // GRAPH_CMD_EFFECT in src/services/ui-bridge.ts.
    expect(unclassified).toEqual([]);
  });

  it("classifies every graph_* command the REAL tool surface dispatches (spelling-independent)", () => {
    // The source scan is evadable by construction — it reads text. This one
    // watches the commands actually routed by `buildPanelToolDefs()`'s handlers,
    // so a helper, an alias table, or a computed name cannot slip past it.
    const { cmds, toolsThatDispatched } = dispatchedGraphCommandsAtRuntime();
    // Guard the guard: a probe that drove nothing would pass vacuously.
    expect(toolsThatDispatched).toBeGreaterThan(20);
    expect(cmds.size).toBeGreaterThan(20);
    expect(cmds.has("graph_set_widget")).toBe(true);
    expect([...cmds].filter((c) => GRAPH_CMD_EFFECT[c] === undefined).sort()).toEqual([]);
  });

  it("driving the real tool surface classifies nothing by FALLBACK", () => {
    // The assertion that needs no scanner at all. `isMutatingGraphCommand`
    // records every command it had to classify by default, at the point of use —
    // an observation taken from the command being ROUTED, which no spelling can
    // dodge. After exercising the surface, that record must be empty.
    __resetUnclassifiedGraphCommands();
    const { cmds } = dispatchedGraphCommandsAtRuntime();
    for (const cmd of cmds) requiresWorkflowStampEnforcement({ cmd });
    expect([...unclassifiedGraphCommandsSeen()].sort()).toEqual([]);
  });

  it("an unclassified command IS recorded, so the fallback is never silent", () => {
    // The negative control for the test above: without this, "the record is
    // empty" would also be true of a recorder that never records.
    __resetUnclassifiedGraphCommands();
    expect(requiresWorkflowStampEnforcement({ cmd: "graph_some_new_command" })).toBe(true);
    expect([...unclassifiedGraphCommandsSeen()]).toEqual(["graph_some_new_command"]);
    // Recorded once, not once per dispatch.
    requiresWorkflowStampEnforcement({ cmd: "graph_some_new_command" });
    expect([...unclassifiedGraphCommandsSeen()]).toEqual(["graph_some_new_command"]);
    // A CLASSIFIED command never lands in the record.
    requiresWorkflowStampEnforcement({ cmd: "graph_set_widget" });
    requiresWorkflowStampEnforcement({ cmd: "graph_find_nodes" });
    expect([...unclassifiedGraphCommandsSeen()]).toEqual(["graph_some_new_command"]);
    __resetUnclassifiedGraphCommands();
  });

  it("classifies nothing it does not dispatch (no stale ledger entries)", () => {
    const dispatched = graphCommandLiteralsInSource();
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

describe("the version tables are source, so a broken one is a BUILD failure", () => {
  // codex gate. The two consumers of these tables degrade DIFFERENTLY on a
  // malformed entry, and must: `requiredPanelVersion()` skips it (a sync floor
  // that fabricates a requirement from a typo would be worse than one that is a
  // little low), while `requiredPanelVersionForWorkflowFence()` refuses to
  // answer at all (a write refusal must not quote a number it cannot justify).
  // Those are the right individual behaviours, and together they can disagree —
  // the sync could call a panel `meets-floor` while the write gate says its
  // requirement is unknowable.
  //
  // The resolution is NOT to make one degrade like the other: these tables are
  // hand-written CONSTANTS in this repo, not runtime input, so the state that
  // produces the disagreement is a developer typo, and the place to stop a typo
  // is the build. These assertions turn it into a failing test; the defensive
  // handling in both functions stays as the belt to this braces.
  it.each([
    ["BRIDGE_CMD_MIN_PANEL_VERSION", BRIDGE_CMD_MIN_PANEL_VERSION],
    ["BRIDGE_CAPABILITY_MIN_PANEL_VERSION", BRIDGE_CAPABILITY_MIN_PANEL_VERSION],
  ])("every %s entry is a parseable version", (_name, table) => {
    const bad = Object.entries(table).filter(([, v]) => typeof v !== "string" || !SEMVER_RE.test(v.trim()));
    expect(bad).toEqual([]);
  });

  it("the baseline itself parses", () => {
    expect(SEMVER_RE.test(MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS.trim())).toBe(true);
  });

  it("BOTH workflow-fence capabilities are present — the write gate needs both", () => {
    // Deleting either would leave requiredPanelVersionForWorkflowFence() unable
    // to answer while requiredPanelVersion() still produced a number, which is
    // exactly the "nothing needed" / "writes refused" contradiction.
    expect(BRIDGE_CAPABILITY_MIN_PANEL_VERSION.enforces_workflow_stamp).toBeTypeOf("string");
    expect(BRIDGE_CAPABILITY_MIN_PANEL_VERSION.enforces_workflow_stamp_at_write).toBeTypeOf("string");
    expect(requiredPanelVersionForWorkflowFence()).toBeTypeOf("string");
  });

  it("the sync floor is never BELOW the fence floor", () => {
    // The sync's aggregate is a max that includes both fence capabilities, so it
    // can only ever be >= the fence's own maximum. If that ever inverted, a
    // `meets-floor` verdict could stand while graph writes were refused.
    const fence = requiredPanelVersionForWorkflowFence();
    expect(fence).toBeDefined();
    expect(compareSemver(requiredPanelVersion(), fence as string)).toBeGreaterThanOrEqual(0);
  });
});

describe("requiredPanelVersionForWorkflowFence — the fence's own minimum", () => {
  // `Readonly<Record<…>>` is a compile-time claim; the runtime object is a plain
  // mutable one, and this is the only way to exercise a broken table.
  const table = BRIDGE_CAPABILITY_MIN_PANEL_VERSION as Record<string, string | undefined>;
  const original = { ...table };
  afterEach(() => {
    for (const k of Object.keys(table)) delete table[k];
    Object.assign(table, original);
  });

  it("is the MAXIMUM of the two fence capabilities, not the global aggregate", () => {
    expect(requiredPanelVersionForWorkflowFence()).toBe("0.11.35");
    // Today the two coincide. Prove the SEPARATION rather than the coincidence:
    // raise an unrelated command's minimum and only the aggregate must move.
    table.some_unrelated_future_capability = "9.9.9";
    expect(requiredPanelVersion()).toBe("9.9.9");
    expect(requiredPanelVersionForWorkflowFence()).toBe("0.11.35");
  });

  it.each([
    ["a MISSING entry", () => delete table.enforces_workflow_stamp_at_write],
    ["a MALFORMED entry", () => (table.enforces_workflow_stamp_at_write = "nightly")],
    ["BOTH entries gone", () => {
      delete table.enforces_workflow_stamp;
      delete table.enforces_workflow_stamp_at_write;
    }],
  ])("quotes NO version on %s, and does not throw", (_label, breakIt) => {
    breakIt();
    // Not the bridge baseline (0.11.4) — that would assert "the first build that
    // fences every command" about a build that does no such thing. Not the
    // surviving entry either — that would UNDERSTATE the requirement and send a
    // user to an update that still leaves them refused (#812's loop).
    expect(requiredPanelVersionForWorkflowFence()).toBeUndefined();
  });

  it("a whitespace-padded but valid entry resolves, TRIMMED (it is rendered to a user)", () => {
    table.enforces_workflow_stamp_at_write = " 0.11.40 ";
    expect(requiredPanelVersionForWorkflowFence()).toBe("0.11.40");
  });
});
