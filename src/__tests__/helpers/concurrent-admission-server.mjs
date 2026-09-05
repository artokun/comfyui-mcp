// A minimal stdio MCP server whose only job is to report how many tool handlers were open
// at once (#2692). Spawned as a real child process by
// `src/__tests__/services/mcp-concurrent-admission.test.ts` — an in-process transport would
// prove nothing about how requests arrive off a pipe, which is the thing under test.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

let inFlight = 0;
let peak = 0;
let completed = 0;

const server = new McpServer({ name: "admission-probe", version: "0" });

server.registerTool(
  "slow",
  { description: "Sleep, reporting the widest overlap seen.", inputSchema: { ms: z.number() } },
  async ({ ms }) => {
    // Sampled BEFORE the sleep: how many siblings were already admitted when this handler
    // began, and how many had already finished. `completedBefore` is the number the gate's
    // "staggered arrival" mechanism needs to be non-zero.
    inFlight++;
    if (inFlight > peak) peak = inFlight;
    const completedBefore = completed;
    const admittedAtStart = inFlight;
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    completed++;
    return {
      content: [
        { type: "text", text: JSON.stringify({ admittedAtStart, completedBefore, peak }) },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
