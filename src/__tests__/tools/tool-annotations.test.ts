// #1106 — tools declared no MCP annotations, so a client could not gate a
// money-spending or destructive call. Split out of #269's finding 5: `runpod
// (action:"create")` is invocable without confirmation, and its "SPENDS MONEY"
// warning lives only in prose a host cannot act on.
//
// This covers the FRICTION-ADDING slice only. See the assertion at the bottom for
// why readOnlyHint is absent everywhere.

import { describe, expect, it } from "vitest";
import { listRegisteredTools } from "../../tools/introspect.js";

type Tool = { name: string; annotations?: Record<string, unknown> };

/** Tools whose effects are unambiguous: they spend money, reach the network, or
 *  change an install. Over-marking these is harmless — the worst case is a
 *  confirmation the user did not need. */
const MUST_BE_MARKED = ["runpod", "install_comfyui", "download_model"];

describe("#1106 money and destructive tools carry machine-readable annotations", () => {
  let tools: Tool[];
  it("loads the real registered surface", async () => {
    tools = (await listRegisteredTools()) as Tool[];
    expect(tools.length).toBeGreaterThan(20);
  });

  for (const name of MUST_BE_MARKED) {
    it(`${name} is marked destructive and open-world`, async () => {
      tools ??= (await listRegisteredTools()) as Tool[];
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} is not registered`).toBeTruthy();
      expect(t!.annotations, `${name} declares no annotations`).toBeTruthy();
      expect(t!.annotations!.destructiveHint).toBe(true);
      expect(t!.annotations!.openWorldHint).toBe(true);
    });
  }

  it("NO tool claims readOnlyHint yet — absent is honest, wrong is dangerous", async () => {
    // The asymmetry that shapes this whole issue: a missing destructiveHint leaves
    // a host where it is today, but a readOnlyHint on something that mutates
    // DISABLES a confirmation it would otherwise have shown. It also cannot be
    // answered per-tool while the surface is action-parameterized — `list_packs`
    // is read-only in every action, but a tool with mixed actions cannot carry one
    // honest value. Until that is decided deliberately, nothing claims it.
    tools ??= (await listRegisteredTools()) as Tool[];
    const claiming = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(
      claiming,
      `these claim readOnlyHint before the mixed-action question was settled: ${claiming.join(", ")}`,
    ).toEqual([]);
  });
});
