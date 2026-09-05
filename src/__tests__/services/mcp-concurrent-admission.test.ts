// #2692 — THE MEASUREMENT THE BATCH BUDGET IS BUILT ON, kept executable rather than
// written down.
//
// `inline-frame-budget.ts` prices a call by how many sibling image fetches are open at the
// same time. That is only a usable signal if parallel `tools/call` requests are ADMITTED
// before any of them completes: if they arrived staggered — each handler finishing before
// the next was even admitted — every one would read a peak of one, spend a full per-image
// budget, and the batch would overrun the frame exactly as it did before the fix. The whole
// design rests on that being false, so it is measured here instead of assumed.
//
// A real spawned child over stdio, not `InMemoryTransport`: the in-memory pump hands
// messages over inside one process and could not tell us anything about how requests arrive
// off a pipe, which is the production path (the code-mode host talks stdio to this server).
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../helpers/concurrent-admission-server.mjs", import.meta.url));

interface Probe {
  admittedAtStart: number;
  completedBefore: number;
  peak: number;
}

describe("parallel MCP tool calls overlap in the handler (#2692)", () => {
  it("nine parallel calls are all admitted before any completes", async () => {
    const client = new Client({ name: "admission-test", version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [SERVER] }),
    );
    try {
      const started = Date.now();
      const results = await Promise.all(
        Array.from({ length: 9 }, () =>
          client.callTool({ name: "slow", arguments: { ms: 150 } }),
        ),
      );
      const elapsed = Date.now() - started;
      const probes = results.map(
        (r) => JSON.parse((r.content as Array<{ text: string }>)[0].text) as Probe,
      );

      // Serial execution would take 9 x 150 ms. A generous ceiling: the claim is "not
      // serialized", not "exactly parallel", and CI machines are loaded.
      expect(elapsed).toBeLessThan(9 * 150);

      // The direct refutation of the staggered-arrival mechanism: no handler started after
      // another had already finished, and the last one in saw all nine open.
      expect(probes.every((p) => p.completedBefore === 0)).toBe(true);
      expect(Math.max(...probes.map((p) => p.admittedAtStart))).toBe(9);
      expect(Math.max(...probes.map((p) => p.peak))).toBe(9);
    } finally {
      await client.close();
    }
  }, 30_000);
});
