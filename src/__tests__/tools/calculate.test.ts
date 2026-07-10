import { describe, expect, it } from "vitest";
import { registerCalculateTools } from "../../tools/calculate.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function makeServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerCalculateTools(server as never);
  return handlers;
}

describe("calculate tool", () => {
  it("registers the calculate tool", () => {
    const handlers = makeServer();
    expect([...handlers.keys()]).toEqual(["calculate"]);
  });

  it("splits a string spec on newlines and semicolons (NOT commas)", async () => {
    const handlers = makeServer();
    const res = await handlers.get("calculate")!({ spec: "w = 8\nmin(w, 3); w + 1" });
    const json = JSON.parse(res.content[1].text);
    // min(w, 3) keeps its comma intact => 3 lines, not 4.
    expect(json.results).toEqual([8, 3, 9]);
    expect(json.variables).toEqual({ w: 8 });
  });

  it("accepts an array spec", async () => {
    const handlers = makeServer();
    const res = await handlers.get("calculate")!({ spec: ["1 + 1", "2 * 3"] });
    const json = JSON.parse(res.content[1].text);
    expect(json.results).toEqual([2, 6]);
  });

  it("passes variables and seed through; echoes seed", async () => {
    const handlers = makeServer();
    const res = await handlers.get("calculate")!({
      spec: "ar * 2",
      variables: { ar: 1.5 },
      seed: 42,
    });
    const json = JSON.parse(res.content[1].text);
    expect(json.results).toEqual([3]);
    expect(json.seed).toBe(42);
  });

  it("surfaces per-line errors without failing the whole call", async () => {
    const handlers = makeServer();
    const res = await handlers.get("calculate")!({ spec: "1 + 1\nbad(\n3" });
    expect(res.isError).toBeFalsy();
    const json = JSON.parse(res.content[1].text);
    expect(json.results).toEqual([2, null, 3]);
    expect(json.errors).toHaveLength(1);
    expect(json.errors[0].line).toBe(2);
  });

  it("errors when spec is empty after splitting", async () => {
    const handlers = makeServer();
    const res = await handlers.get("calculate")!({ spec: "\n\n  ;  " });
    expect(res.isError).toBe(true);
  });

  it("flags non-finite results in rendered text", async () => {
    const handlers = makeServer();
    const res = await handlers.get("calculate")!({ spec: "1 / 0" });
    expect(res.content[0].text).toMatch(/Infinity/);
    expect(res.content[0].text).toMatch(/non-finite/);
  });
});
