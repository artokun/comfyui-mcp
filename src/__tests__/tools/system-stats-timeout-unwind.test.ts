// #1672 — get_system_stats(action:"stats") during a long VAE/audio decode
// reported "The operation was aborted due to timeout" and then left the
// enclosing call_tool cell pending until something killed it. The abort
// cancelled fetch() after headers, but Response.text() / JSON.parse did not
// observe it. These tests drive the SHIPPED path (call_tool → get_system_stats
// → getSystemInfo → getSystemStats → fetch+decode) against a body that never
// finishes, and assert call_tool settles promptly with a structured timeout.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolCatalog } from "../../tools/catalog.js";
import { registerCompactTools } from "../../tools/compact.js";
import { registerSystemStatsTools } from "../../tools/system-stats.js";
import { SYSTEM_STATS_TIMEOUT_MS } from "../../comfyui/client.js";
import { raceAbort } from "../../comfyui/fetch.js";

vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: "" },
  getComfyUIApiHost: () => "127.0.0.1:8188",
  getComfyUIBasePath: () => "",
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  isCloudMode: () => false,
  isRemoteMode: () => false,
}));

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** A Response whose body decode never settles — even after the request abort. */
function hangingDecodeResponse(): Response {
  const res = new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(res, "text", {
    value: () => new Promise<string>(() => { /* never settles */ }),
  });
  return res;
}

async function shippedCallToolClient(): Promise<Client> {
  const catalog = new ToolCatalog();
  registerSystemStatsTools(catalog.asRegistrar());
  const server = new McpServer({ name: "test-1672", version: "0.0.0" });
  registerCompactTools(server, catalog);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-1672-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("raceAbort (#1672)", () => {
  it("rejects as soon as the signal aborts, without waiting for work", async () => {
    const ctl = new AbortController();
    let finished = false;
    const pending = raceAbort(ctl.signal, () => new Promise<string>(() => { /* hang */ }));
    const raced = Promise.race([
      pending.then(
        () => {
          finished = true;
          return "resolved";
        },
        () => {
          finished = true;
          return "rejected";
        },
      ),
      new Promise<"still-pending">((r) => setTimeout(() => r("still-pending"), 20)),
    ]);
    ctl.abort(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(await raced).toBe("rejected");
    expect(finished).toBe(true);
  });
});

describe("call_tool(get_system_stats) unwinds a decode that ignores abort (#1672)", () => {
  let restoreTimeout: (() => void) | undefined;

  beforeEach(() => {
    vi.unstubAllGlobals();
    const orig = AbortSignal.timeout.bind(AbortSignal);
    // Keep every OTHER deadline real; only the stats probe is shortened so
    // this test can wait for the shipped timer instead of faking the clock
    // (fake timers break the in-memory MCP pair).
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) =>
      orig(ms === SYSTEM_STATS_TIMEOUT_MS ? 40 : ms),
    );
    restoreTimeout = () => spy.mockRestore();
  });

  afterEach(() => {
    restoreTimeout?.();
    restoreTimeout = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("settles call_tool promptly with a structured timeout, not a hang", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => hangingDecodeResponse()),
    );

    const client = await shippedCallToolClient();
    const started = Date.now();
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "get_system_stats", args: { action: "stats" } },
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(res.isError).toBe(true);
    const body = JSON.parse(textOf(res));
    expect(body.error).toBe("COMFYUI_HTTP_TIMEOUT");
    expect(body.message).toMatch(/\/system_stats/);
    expect(body.message).toMatch(/timeout is not a refusal/);
    expect(body.message).not.toMatch(/The operation was aborted due to timeout/);
    expect(body.details).toEqual({
      endpoint: "/system_stats",
      timeout_ms: SYSTEM_STATS_TIMEOUT_MS,
    });
  });
});
