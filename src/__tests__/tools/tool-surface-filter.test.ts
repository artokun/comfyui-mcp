// #873 — an operator needs to guarantee the model cannot reach install/delete/restart
// tools, whatever a user types.
//
// Reported from a Docker Compose + Open WebUI deployment behind llama-swap, where the
// operator is NOT the person prompting. That is a different trust model from the local
// one this codebase otherwise assumes, and it is why the request is worth building: with
// one machine and one person a tool filter is theatre; with a shared frontend it is the
// difference between shipping and not.
//
// THE BYPASS IS THE POINT. Compact mode narrows discovery but is explicitly not a
// boundary — `call_tool` dispatches by name. A filter applied only to the registered list
// would leave the facade wide open, and the report says so directly. Both paths run the
// same registrar decorator, and the tests below check BOTH, because "I filtered the
// registration" is exactly the fix that looks complete and is not.

import { describe, expect, it } from "vitest";

import {
  resolveToolSurfacePolicy,
  toolActionAllowed,
  toolAllowed,
  toolMatches,
  TOOL_PRESETS,
  MUTATING_ACTION_NAMES,
  EXECUTION_ACTION_NAMES,
  MUTATING_TOOLS,
  EXECUTION_TOOLS,
  READONLY_TOOLS,
  declaredActions,
  withToolSurfaceFilter,
} from "../../tools/tool-surface-filter.js";

/**
 * Source with comments removed.
 *
 * Every source-grepping test below needs this, and finding out why was worth more than the
 * tests. Two of them asserted `src.includes("COMFYUI_MCP_TOOL_PRESET")` and
 * `src.indexOf("resolveToolSurfacePolicy();")` — and I had written a PARAGRAPH of comment
 * above each fix explaining what it does, naming those exact strings. Deleting the code
 * outright left both tests green, because the comment satisfied them. A wiring test that a
 * comment can satisfy is not a wiring test; it is a spell-check on my own prose.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

/** A minimal stand-in for the SDK registrar: records what actually got registered. */
function recordingRegistrar() {
  const registered: string[] = [];
  return {
    registrar: { tool: (name: string) => registered.push(name) },
    registered,
  };
}

describe("the operator's policy is read from the environment (#873)", () => {
  it("is INACTIVE by default — a local install is unchanged", () => {
    const p = resolveToolSurfacePolicy({});
    expect(p.active).toBe(false);
    // And an inactive policy must not wrap: every tool registers.
    const { registrar, registered } = recordingRegistrar();
    const wrapped = withToolSurfaceFilter(registrar, p);
    wrapped.tool("restart_comfyui");
    expect(registered).toEqual(["restart_comfyui"]);
  });

  it("reads deny, allow and a preset", () => {
    expect(resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_DENY: "a, b ,c" }).deny).toEqual(["a", "b", "c"]);
    expect(resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_ALLOW: "x" }).allow).toEqual(["x"]);
    expect(
      resolveToolSurfacePolicy({
        COMFYUI_MCP_TOOL_ACTION_ALLOW: "queue:list, queue:status,queue:list",
      }).actionAllow,
    ).toEqual([
      { tool: "queue", action: "list" },
      { tool: "queue", action: "status" },
    ]);
    const preset = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });
    expect(preset.preset).toBe("safe");
    // The preset's patterns live in presetDeny, kept apart from an explicit DENY because
    // an allow list is entitled to refine a preset but not to overrule an explicit deny.
    expect(preset.presetDeny).toContain("restart_comfyui");
    expect(preset.deny).toEqual([]);
  });

  it("an UNKNOWN preset REFUSES TO START rather than failing open (codex P0)", () => {
    // I got this wrong first time and wrote a test asserting the broken behaviour.
    // `saef` resolved to no rules → `active` false → the decorator returned the
    // registrar unwrapped AND the "surface restricted" log, gated on the same flag,
    // never fired. The server came up with its FULL surface, silently, while the
    // operator believed it was locked down. My justification at the time — "the log
    // tells them" — was false about my own code.
    //
    // For a control whose entire purpose is a guarantee, silence on misconfiguration is
    // the one unacceptable outcome.
    expect(() => resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "saef" })).toThrow(
      /is not a known preset/,
    );
    expect(() => resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "saef" })).toThrow(
      /Refusing to start/,
    );
  });
});

describe("allow wins, and is absolute (#873)", () => {
  it("an allow list makes the surface EXACTLY those tools", () => {
    // The alternative reading — allow as a mere exemption from deny — turns an
    // incomplete list into a wide-open surface, which nobody notices until it matters.
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_ALLOW: "generate_image,queue" });
    expect(toolAllowed("generate_image", p)).toBe(true);
    expect(toolAllowed("queue", p)).toBe(true);
    // Never mentioned by any rule — still denied.
    expect(toolAllowed("restart_comfyui", p)).toBe(false);
    expect(toolAllowed("download_model", p)).toBe(false);
  });

  it("deny works on its own", () => {
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_DENY: "restart_comfyui" });
    expect(toolAllowed("restart_comfyui", p)).toBe(false);
    expect(toolAllowed("generate_image", p)).toBe(true);
  });

  it("an EXPLICIT deny still applies on top of an allow list", () => {
    // The first version returned early on the allow match, so naming a tool in BOTH
    // allowed it — `ALLOW=list_local_models,get_history` + `DENY=list_local_models` left
    // a tool whose action:"remove" deletes a model file reachable. Both variables are the
    // operator saying something; the intersection is the only reading that discards
    // neither, and it errs toward the smaller surface.
    const p = resolveToolSurfacePolicy({
      COMFYUI_MCP_TOOL_ALLOW: "list_local_models,get_history",
      COMFYUI_MCP_TOOL_DENY: "list_local_models",
    });
    expect(toolAllowed("list_local_models", p)).toBe(false);
    expect(toolAllowed("get_history", p)).toBe(true);
  });

  it("…but an allow list DOES refine a preset, or the documented opt-in would be a lie", () => {
    // A preset is a broad default. `PRESET=safe` denies panel_* wholesale, and naming two
    // of them in ALLOW is exactly how the docs say to get them back.
    const p = resolveToolSurfacePolicy({
      COMFYUI_MCP_TOOL_PRESET: "safe",
      COMFYUI_MCP_TOOL_ALLOW: "panel_graph_outline",
    });
    expect(toolAllowed("panel_graph_outline", p)).toBe(true);
    expect(toolAllowed("panel_run", p)).toBe(false);
    expect(toolAllowed("restart_comfyui", p)).toBe(false);
  });

  it("a GLOB in allow narrows, but cannot re-open what a preset closed", () => {
    // Measured on the first version, which let any allow match override the preset:
    // ALLOW=list_* re-admitted list_packs — the install-and-execute tool that was the
    // headline finding of the round which added these presets — and ALLOW=* made every
    // preset inert while still reporting itself active.
    //
    // Naming `panel_graph_outline` is a decision about one tool. Writing `list_*` is a
    // decision about a shape, and it sweeps in whatever the next release names that way.
    const glob = resolveToolSurfacePolicy({
      COMFYUI_MCP_TOOL_PRESET: "safe",
      COMFYUI_MCP_TOOL_ALLOW: "list_*",
    });
    expect(toolAllowed("list_packs", glob)).toBe(false);
    expect(toolAllowed("list_api_nodes", glob)).toBe(true); // allowed by safe anyway
    expect(toolAllowed("restart_comfyui", glob)).toBe(false); // outside the allow bound

    const star = resolveToolSurfacePolicy({
      COMFYUI_MCP_TOOL_PRESET: "safe",
      COMFYUI_MCP_TOOL_ALLOW: "*",
    });
    expect(toolAllowed("restart_comfyui", star), "ALLOW=* must not void a preset").toBe(false);

    const readonlyGlob = resolveToolSurfacePolicy({
      COMFYUI_MCP_TOOL_PRESET: "readonly",
      COMFYUI_MCP_TOOL_ALLOW: "panel_*",
    });
    expect(toolAllowed("panel_run", readonlyGlob)).toBe(false);

    // …while the EXACT name still refines, which is the documented opt-in.
    const exact = resolveToolSurfacePolicy({
      COMFYUI_MCP_TOOL_PRESET: "readonly",
      COMFYUI_MCP_TOOL_ALLOW: "panel_run",
    });
    expect(toolAllowed("panel_run", exact)).toBe(true);
  });

  it("a variable SET BUT EMPTY refuses to start — the fail-open by another route", () => {
    // `COMFYUI_MCP_TOOL_ALLOW=${ALLOWED_TOOLS}` in a compose file with ALLOWED_TOOLS
    // unset expands to "". Reading that as "no rules configured" produces the full
    // surface with no log — the identical failure the unknown-preset throw exists to
    // prevent, reached from a different direction.
    for (const v of [
      "COMFYUI_MCP_TOOL_ALLOW",
      "COMFYUI_MCP_TOOL_DENY",
      "COMFYUI_MCP_TOOL_PRESET",
      "COMFYUI_MCP_TOOL_ACTION_ALLOW",
    ]) {
      expect(() => resolveToolSurfacePolicy({ [v]: "" }), v).toThrow(/set but empty/);
      expect(() => resolveToolSurfacePolicy({ [v]: "  ,  " }), v).toThrow(/Refusing to start|set but empty/);
    }
  });

  it("a prefix glob groups a family, and does not match more than it reads like", () => {
    expect(toolMatches("train_start", "train_*")).toBe(true);
    expect(toolMatches("train_doctor", "train_*")).toBe(true);
    expect(toolMatches("generate_image", "train_*")).toBe(false);
    // Not a full glob — a mid-string wildcard is NOT silently honoured, because a rule
    // that matches more than it reads like is worse than one that matches nothing.
    expect(toolMatches("generate_image", "gen*image")).toBe(false);
  });
});

describe("action-level allow lists fail closed", () => {
  it("requires exact tool:action pairs and rejects wildcard or malformed rules", () => {
    for (const value of ["queue:*", "queue", ":list", "queue:", "Queue:list", "queue:list:extra"]) {
      expect(
        () => resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_ACTION_ALLOW: value }),
        value,
      ).toThrow(/invalid rule|Refusing to start/);
    }
  });

  it("bounds every call that carries an action while leaving ordinary tools alone", () => {
    const p = resolveToolSurfacePolicy({
      COMFYUI_MCP_TOOL_ACTION_ALLOW: "queue:list,enqueue_workflow:enqueue",
    });
    expect(toolActionAllowed("queue", { action: "list" }, p)).toBe(true);
    expect(toolActionAllowed("queue", { action: "clear" }, p)).toBe(false);
    expect(toolActionAllowed("enqueue_workflow", { action: "rerun" }, p)).toBe(false);
    expect(toolActionAllowed("get_system_stats", { action: "stats" }, p)).toBe(false);
    expect(toolActionAllowed("panel_graph_outline", {}, p)).toBe(true);
  });

  // THE OVER-PERMISSIVE DIRECTION IS THE ONLY ONE THAT MATTERS HERE.
  //
  // Every test above this point asserts that an ALLOWED action is allowed and that a
  // plainly-different one is not. Neither can see the failures that actually ship: a
  // compare that was loosened to `startsWith`, lowercased "to be forgiving", or split
  // into two independent `.some()` calls. Each of those keeps every existing assertion
  // green while widening the allowlist, so the near-misses get their own tests.
  it("does not admit a near-miss tool or action name", () => {
    const p = resolveToolSurfacePolicy({
      COMFYUI_MCP_TOOL_ACTION_ALLOW: "queue:list",
    });
    expect(toolActionAllowed("queue", { action: "list" }, p)).toBe(true);

    // PREFIX / EXTRA SEGMENT — `startsWith` in either position would pass these.
    for (const action of ["list_all", "listall", "lis", "list ", " list", "list:extra"]) {
      expect(toolActionAllowed("queue", { action }, p), `action ${JSON.stringify(action)}`).toBe(
        false,
      );
    }
    for (const tool of ["queue_admin", "queuex", "que", "my_queue", "enqueue"]) {
      expect(toolActionAllowed(tool, { action: "list" }, p), `tool ${tool}`).toBe(false);
    }

    // CASE — the rule grammar rejects an uppercase RULE, but nothing there constrains
    // the incoming CALL, which is the side an attacker controls.
    for (const [tool, action] of [
      ["queue", "LIST"],
      ["queue", "List"],
      ["QUEUE", "list"],
      ["Queue", "List"],
    ]) {
      expect(toolActionAllowed(tool, { action }, p), `${tool}:${action}`).toBe(false);
    }
  });

  it("does not let two separate rules be recombined into a pair nobody allowed", () => {
    // The classic allowlist bug: `some(r => r.tool === name) && some(r => r.action === a)`
    // reads correct, passes every single-rule test, and quietly permits the CROSS product.
    // Here that would hand an operator who allowed queue INSPECTION a model download, and
    // an operator who allowed a download the ability to CLEAR someone else's queue.
    const p = resolveToolSurfacePolicy({
      COMFYUI_MCP_TOOL_ACTION_ALLOW: "queue:list,download_model:download",
    });
    expect(toolActionAllowed("queue", { action: "list" }, p)).toBe(true);
    expect(toolActionAllowed("download_model", { action: "download" }, p)).toBe(true);

    expect(toolActionAllowed("queue", { action: "download" }, p)).toBe(false);
    expect(toolActionAllowed("download_model", { action: "list" }, p)).toBe(false);
  });

  it("refuses an action that is present but not a string, instead of waving it through", () => {
    // The one shape this function cannot classify. Resolving it as "no action here" is
    // the permissive answer, and permissive is the direction that ships a hole.
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_ACTION_ALLOW: "queue:list" });
    for (const action of [["list"], { toString: () => "list" }, 1, true]) {
      expect(toolActionAllowed("queue", { action }, p), JSON.stringify(action)).toBe(false);
    }
    // ABSENT is genuinely not an action call and stays governed by the tool-level policy.
    expect(toolActionAllowed("queue", {}, p)).toBe(true);
    expect(toolActionAllowed("queue", { action: undefined }, p)).toBe(true);
    expect(toolActionAllowed("queue", { action: null }, p)).toBe(true);
  });

  it("an action list ALONE makes the policy active, or the whole gate is dead code", () => {
    // `withToolSurfaceFilter` returns the registrar UNWRAPPED when `active` is false, so
    // an operator who sets only COMFYUI_MCP_TOOL_ACTION_ALLOW would get a server that
    // logs nothing and enforces nothing. Asserted directly because it is one `||` term
    // away from being true, and losing it is invisible in every allowed/denied test.
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_ACTION_ALLOW: "queue:list" });
    expect(p.active).toBe(true);
    expect(p.allow).toEqual([]);
    expect(p.deny).toEqual([]);
    expect(p.preset).toBeUndefined();

    const registrar = { tool: (...args: unknown[]) => ({ name: args[0] }) };
    expect(withToolSurfaceFilter(registrar, p)).not.toBe(registrar);
  });

  it("blocks before the registered handler on the direct and catalog registration boundary", async () => {
    const p = resolveToolSurfacePolicy({
      COMFYUI_MCP_TOOL_ACTION_ALLOW: "queue:list",
    });
    let called = 0;
    let registeredHandler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
    const registrar = {
      tool: (...args: unknown[]) => {
        registeredHandler = args[args.length - 1] as typeof registeredHandler;
        return { name: args[0] };
      },
    };
    const wrapped = withToolSurfaceFilter(registrar, p);
    wrapped.tool("queue", "queue", {}, async () => {
      called++;
      return { content: [{ type: "text", text: "ran" }] };
    });

    const denied = (await registeredHandler?.({ action: "clear" })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(denied.isError).toBe(true);
    expect(denied.content?.[0]?.text).toContain('queue:clear');
    expect(called).toBe(0);

    await registeredHandler?.({ action: "list" });
    expect(called).toBe(1);
  });

  it("also blocks a denied action in the real compact call_tool catalog", async () => {
    const previous = process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW;
    process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW = "queue:list";
    try {
      const { collectToolCatalog } = await import("../../tools/index.js");
      const catalog = await collectToolCatalog();
      const queue = catalog.get("queue");
      expect(queue).toBeDefined();

      // This would call ComfyUI's destructive queue-clear endpoint if the catalog
      // route bypassed the wrapper. No fetch mock is installed deliberately: the test
      // can only pass when policy denial happens before the real handler.
      const denied = await queue!.handler({ action: "clear" });
      expect(denied.isError).toBe(true);
      expect(denied.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("queue:clear"),
      });
    } finally {
      if (previous === undefined) delete process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW;
      else process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW = previous;
    }
  });

  it("does not let a PREFIX near-miss through on the real catalog route either", async () => {
    // `cancel` and `cancel_queued` are both real members of queue's action enum, so this
    // near-miss survives schema validation and reaches the gate — which the synthetic
    // names above cannot do. An operator allowing targeted `cancel` (one prompt_id) has
    // not allowed `cancel_queued`, which drops the ENTIRE pending queue, someone else's
    // work included. A `startsWith` compare admits it and every other test stays green.
    const previous = process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW;
    process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW = "queue:cancel";
    try {
      const { collectToolCatalog } = await import("../../tools/index.js");
      const catalog = await collectToolCatalog();
      const queue = catalog.get("queue");
      expect(queue).toBeDefined();

      // No fetch mock, deliberately: reaching the handler means reaching ComfyUI, so this
      // can only pass by being refused first.
      const denied = await queue!.handler({ action: "cancel_queued" });
      expect(denied.isError).toBe(true);
      expect(denied.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("queue:cancel_queued"),
      });
    } finally {
      if (previous === undefined) delete process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW;
      else process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW = previous;
    }
  });
});

describe("a denied tool is ABSENT, not refusing (#873)", () => {
  it("never registers, so the model never learns it exists", () => {
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });
    const { registrar, registered } = recordingRegistrar();
    const wrapped = withToolSurfaceFilter(registrar, p);

    wrapped.tool("generate_image");
    wrapped.tool("restart_comfyui");
    wrapped.tool("download_model");

    expect(registered).toEqual(["generate_image"]);
  });

  it("the FACADE is never filtered — restricting must not mean breaking", () => {
    // Removing call_tool from a compact surface leaves a client unable to reach ANY
    // tool. The facade only routes; what it can route to is governed by the same policy
    // through the shared catalog, so exempting it grants nothing.
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_ALLOW: "nothing_matches" });
    const { registrar, registered } = recordingRegistrar();
    const wrapped = withToolSurfaceFilter(registrar, p);

    for (const n of ["list_tools", "describe_tool", "call_tool", "generate_image"]) wrapped.tool(n);

    expect(registered).toEqual(["list_tools", "describe_tool", "call_tool"]);
  });

  it("readonly withholds execution as well as mutation", () => {
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "readonly" });
    expect(toolAllowed("generate_image", p)).toBe(false);
    expect(toolAllowed("enqueue_workflow", p)).toBe(false);
    expect(toolAllowed("restart_comfyui", p)).toBe(false);
    // …but inspection still works, or the preset would be useless.
    //
    // This used to assert `list_local_models` was allowed — a tool whose action:"remove"
    // DELETES a model file. The assertion was wrong before the preset was, and it read
    // as reassurance. Use tools that genuinely only read.
    expect(toolAllowed("get_history", p)).toBe(true);
    expect(toolAllowed("get_system_stats", p)).toBe(true);
  });

  it("safe keeps rendering while withholding machine changes", () => {
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });
    expect(toolAllowed("generate_image", p)).toBe(true);
    expect(toolAllowed("restart_comfyui", p)).toBe(false);
    expect(toolAllowed("install_custom_node", p)).toBe(false);
  });

  it("the presets name only tools that exist", async () => {
    // A preset naming a renamed tool protects nothing while reading as though it does —
    // the 0.50.0 consolidation renamed a great many, and this is the check that keeps a
    // hardcoded list honest against the live surface.
    const { collectToolCatalog } = await import("../../tools/index.js");
    const catalog = await collectToolCatalog();
    const live = new Set([...catalog.tools.keys()]);
    // Globs are patterns, not names — `panel_*` deliberately matches a surface that is
    // registered on a different server and is not in this catalog at all.
    const unknown = [...new Set(Object.values(TOOL_PRESETS).flat())]
      .filter((n) => !n.endsWith("*"))
      .filter((n) => !live.has(n));
    expect(unknown, `preset entries that match no live tool: ${unknown.join(", ")}`).toEqual([]);
  });
});

describe("the presets cover what a NAME no longer reveals (codex P1)", () => {
  it("withholds tools whose destructive action hides behind an inspection-sounding name", () => {
    // The 0.50.0 consolidation folded deletion into `list_local_models` (action:"remove"
    // deletes a model file), config writes into `get_defaults`, queue destruction into
    // `queue`, and pack INSTALLATION into `list_packs` (action:"install_deps" downloads
    // and RUNS third-party code on the ComfyUI host). My first preset list was written
    // from the names and missed every one.
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });
    for (const name of ["list_local_models", "list_packs", "get_defaults", "queue", "apps"]) {
      expect(toolAllowed(name, p), `${name} can mutate and must be withheld by "safe"`).toBe(false);
    }
  });

  it("does NOT withhold search_custom_nodes — it only searches", () => {
    // It was on the deny list, and the justification was that action:"install" installs a
    // pack. It has exactly two actions, `search` and `details`, and is read-only; the
    // installing tool is `install_custom_node`. The false claim came from its description
    // MENTIONING `install_custom_node (action:"install")` — the same cross-reference
    // confusion `declaredActions` strips, made by me while reading. The net effect was an
    // inversion: `safe` withheld a registry search while allowing `list_packs`, which
    // genuinely installs.
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });
    expect(toolAllowed("search_custom_nodes", p)).toBe(true);
  });

  it("STAYS complete: EVERY live tool is classified, and the ledger names only live tools", async () => {
    // THE GUARANTEE, and the reason it is a ledger rather than a pattern.
    //
    // The previous version scanned descriptions for a mutating verb and passed 17/17
    // while `list_packs` — which installs and runs third-party code — was allowed by both
    // presets, because its verb is `install_deps` and the pattern was anchored `^install$`.
    // A pattern can only catch what someone already thought of; being read as coverage is
    // what made it worse than nothing.
    //
    // Exhaustive partition instead: a NEW tool belongs to no list, so it fails here as
    // "unclassified" and someone has to decide. The failure mode is a stopped build, not
    // an assumption that it is harmless.
    const { collectToolCatalog } = await import("../../tools/index.js");
    const catalog = await collectToolCatalog();
    const live = [...catalog.tools.keys()].sort();
    const ledger = [...MUTATING_TOOLS, ...EXECUTION_TOOLS, ...READONLY_TOOLS].sort();

    const unclassified = live.filter((n) => !ledger.includes(n));
    expect(
      unclassified,
      `live tools in NO list — classify each as mutating / execution / readonly: ${unclassified.join(", ")}`,
    ).toEqual([]);

    const phantom = ledger.filter((n) => !live.includes(n));
    expect(phantom, `ledger entries that match no live tool: ${phantom.join(", ")}`).toEqual([]);

    // …and no tool in two lists, or the presets would disagree with themselves.
    const dupes = ledger.filter((n, i) => ledger.indexOf(n) !== i);
    expect([...new Set(dupes)], `tools classified twice: ${dupes.join(", ")}`).toEqual([]);
  });

  it("CROSS-CHECK: nothing classified read-only advertises a mutating action", async () => {
    // Secondary to the ledger above, and worth exactly what it is: the ledger catches a
    // MISSING classification, this catches a WRONG one. It is why `list_packs` moved —
    // once the pattern was widened to match a verb PREFIX (`install_deps`, `add_path`,
    // `generate_skill`) rather than a whole word, it stopped being blind to the family of
    // names the consolidation actually produced.
    const { collectToolCatalog } = await import("../../tools/index.js");
    const catalog = await collectToolCatalog();

    const misclassified: string[] = [];
    for (const name of READONLY_TOOLS) {
      const actions = declaredActions(catalog.tools.get(name)?.description ?? "", {
        selfName: name,
        knownTools: new Set(catalog.tools.keys()),
      });
      const mutating = actions.filter(
        (a) => MUTATING_ACTION_NAMES.test(a) && !EXECUTION_ACTION_NAMES.test(a),
      );
      if (mutating.length) misclassified.push(`${name} (${mutating.join(",")})`);
    }
    expect(
      misclassified,
      `tools classified READONLY that advertise a mutating action: ${misclassified.join("; ")}`,
    ).toEqual([]);
  });

  it("declaredActions strips a CROSS-reference but never a SELF-declaration", () => {
    // The over-stripping direction is the one that matters: a tool whose own declaration
    // got eaten looks action-free, so the cross-check sees nothing and reports no hole —
    // a silent false negative in a guard, which is worse than no guard.
    const known = new Set(["get_defaults", "download_model", "model_metadata"]);

    // Both spellings of a cross-reference go, parenthesised or not.
    expect(
      declaredActions('- action:"generate" — uses get_defaults (action:"set") and download_model action:"download_civitai".', {
        selfName: "generate_image",
        knownTools: known,
      }),
    ).toEqual(["generate"]);

    // A tool naming ITSELF keeps the action…
    expect(
      declaredActions('model_metadata action:"read" — reads embedded metadata.', {
        selfName: "model_metadata",
        knownTools: known,
      }),
    ).toEqual(["read"]);

    // …and so does a reference to a name that is not a known tool, because an unrecognised
    // word is not evidence that the action belongs to someone else.
    expect(
      declaredActions('somethingelse action:"delete"', { selfName: "x", knownTools: known }),
    ).toEqual(["delete"]);
  });

  it("declaredActions never strips a tool's OWN action, measured on all 37 live descriptions", async () => {
    // The hand-written case above proves the rule; this proves it against the real text,
    // which is where it can actually fail. `queue` and `batch` are tool names AND ordinary
    // English words, so a sentence ending "...drains the queue." immediately before a
    // bulleted `action:"clear"` would capture `queue` as a cross-reference and delete a
    // self-declaration — leaving the tool looking action-free and the cross-check
    // reporting no hole.
    //
    // GROUND TRUTH: a tool's own actions are introduced as a BULLET (`- action:"x" — …`);
    // a cross-reference never is. My first attempt at this check read the zod action enum
    // off the catalog entry, resolved it for 0 of 37 tools, and printed a confident pass —
    // so the count is asserted below to keep this from going quietly vacuous the same way.
    const { collectToolCatalog } = await import("../../tools/index.js");
    const catalog = await collectToolCatalog();
    const known = new Set(catalog.tools.keys());

    const selfStripped: string[] = [];
    let measured = 0;
    for (const [name, tool] of catalog.tools) {
      const description = tool.description ?? "";
      const own = [
        ...new Set(
          [...description.matchAll(/(?:^|\n)\s*[-*]\s*action:"([a-z_0-9]+)"/g)].map((m) => m[1]),
        ),
      ];
      if (!own.length) continue;
      measured++;
      const kept = declaredActions(description, { selfName: name, knownTools: known });
      const lost = own.filter((a) => !kept.includes(a));
      if (lost.length) selfStripped.push(`${name} lost ${lost.join(",")}`);
    }

    expect(measured, "no descriptions had bullet-declared actions — this check read nothing").toBeGreaterThan(25);
    expect(selfStripped, `tools whose OWN action was stripped: ${selfStripped.join("; ")}`).toEqual([]);
  });

  it("the PANEL surface is withheld wholesale by both presets (codex P0)", () => {
    // 91 panel_* tools register through a different method on a separate server and
    // bypassed the filter entirely — `panel_run` still queued renders under `readonly`.
    // Denied as a family because classifying 91 by name got several wrong in both
    // directions, and the list grows every release.
    for (const preset of ["safe", "readonly"]) {
      const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: preset });
      for (const name of ["panel_run", "panel_add_node", "panel_graph_outline", "panel_set_property"]) {
        expect(toolAllowed(name, p), `${name} under ${preset}`).toBe(false);
      }
    }
  });

  it("…and can be opted back in explicitly", () => {
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_ALLOW: "panel_graph_outline,panel_query_graph" });
    expect(toolAllowed("panel_graph_outline", p)).toBe(true);
    expect(toolAllowed("panel_run", p)).toBe(false);
  });
});

describe("WIRING: the filter covers the call_tool route, not just registration (#873)", () => {
  it("is applied to the PANEL registration path too (codex P0)", async () => {
    // That path uses `registerTool` on a separate server, so the headless decorator —
    // which proxies `.tool` — could never have caught it.
    const { readFile } = await import("node:fs/promises");
    const src = codeOnly(await readFile(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf-8"));
    const at = src.indexOf("export function registerPanelTools");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 1400);
    expect(body).toContain("resolveToolSurfacePolicy()");
    expect(body).toContain("toolAllowed(d.name, policy)");
    expect(body).toContain("toolActionPolicyError(d.name, args, policy)");
  });

  it("is applied to the OTHER panel registration path as well — createPanelMcpServer", async () => {
    // There are TWO. registerPanelTools serves the MCP SDK; createPanelMcpServer serves
    // the Anthropic Agent SDK (Claude backend, in-process transport). They build from the
    // same buildPanelToolDefs(), so fixing one left `panel_run` queueing renders under
    // PRESET=readonly for every Claude-backend tab — the same hole, reported closed.
    //
    // The previous version of this test grepped only registerPanelTools and passed while
    // that was true, which is why this one names the second function explicitly rather
    // than searching the file as a whole.
    const { readFile } = await import("node:fs/promises");
    const src = codeOnly(await readFile(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf-8"));
    const at = src.indexOf("export function createPanelMcpServer");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 2600);
    expect(body).toContain("resolveToolSurfacePolicy()");
    expect(body).toContain("toolAllowed(d.name, policy)");
    expect(body).toContain("toolActionPolicyError(d.name, args, policy)");
  });

  it("the policy reaches the SPAWNED comfyui child through the env builder BOTH lanes share", async () => {
    // There are two comfyui spawn lanes. I put this forwarding in comfyuiBaseEnv(), which
    // only the Codex/Gemini lane spreads; the DEFAULT Claude lane builds its own literal
    // and calls buildComfyuiMcpEnv directly, so it kept spawning a child with all 37
    // tools while the panel surface was withheld and logged as withheld.
    //
    // That is the same defect as the two panel registration paths — fix one, test the one
    // you fixed — committed again in the same change, one file over. So this asserts on
    // the CHOKE POINT both lanes pass through, not on either call site.
    const { readFile } = await import("node:fs/promises");
    const src = codeOnly(await readFile(new URL("../../services/panel-secrets.ts", import.meta.url), "utf-8"));
    const at = src.indexOf("export function buildComfyuiMcpEnv");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 3200);
    for (const v of [
      "COMFYUI_MCP_TOOL_PRESET",
      "COMFYUI_MCP_TOOL_ALLOW",
      "COMFYUI_MCP_TOOL_DENY",
      "COMFYUI_MCP_TOOL_ACTION_ALLOW",
    ]) {
      // Assert the ASSIGNMENT, not that the name appears somewhere. Checking only for the
      // name passed with the forwarding deleted, because the `process.env.X ?` guard on
      // the line above still mentions X — the test matched the condition and called it
      // the effect.
      expect(body, `${v} must be ASSIGNED into the child env, not merely mentioned`).toContain(
        `${v}: process.env.${v}`,
      );
    }

    // …and both lanes really do route through it, or the choke point is not one.
    const orch = codeOnly(await readFile(new URL("../../orchestrator/index.ts", import.meta.url), "utf-8"));
    expect(orch.match(/buildComfyuiMcpEnv\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("the policy is validated at BOOT, so 'Refusing to start' is true on http too", async () => {
    // The throw is only a refusal-to-start if something calls it before the transport
    // comes up. --transport http builds the server LAZILY inside the request handler, so
    // the socket bound, "server running on http://…" printed, and every initialize came
    // back 500 with the real reason buried in a log line. Fail-closed, so not a hole —
    // but the message promised something that transport did not do.
    const { readFile } = await import("node:fs/promises");
    const src = codeOnly(await readFile(new URL("../../boot.ts", import.meta.url), "utf-8"));
    const call = src.indexOf("resolveToolSurfacePolicy();");
    expect(call).toBeGreaterThan(-1);
    // Above EVERY branch that starts something. Asserting only against the http branch
    // missed --panel-orchestrator, which returns above it and never comes back: a typo'd
    // preset there bound the bridge, the loopback MCP and the console, printed the ready
    // banner, and only threw later at first use, inside a request handler.
    expect(call).toBeLessThan(src.indexOf("if (cli.panelOrchestrator)"));
    expect(call).toBeLessThan(src.indexOf('if (cli.transport === "http")'));
  });

  it("is applied inside collectToolCatalog, which call_tool dispatches through", async () => {
    // The bypass this feature exists to close. Asserted on the source because the
    // catalog is built once per process and the policy is read from the environment at
    // that moment; a runtime assertion here would test my mock, not the wiring.
    const { readFile } = await import("node:fs/promises");
    const src = codeOnly(await readFile(new URL("../../tools/index.ts", import.meta.url), "utf-8"));

    const at = src.indexOf("export async function collectToolCatalog");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 1200);
    expect(body).toContain("withToolSurfaceFilter(");
    expect(body).toContain("resolveToolSurfacePolicy()");

    // …and on the direct registration path too.
    const reg = src.slice(src.indexOf("export async function registerAllTools"), at);
    expect(reg).toContain("withToolSurfaceFilter(");
  });
});
