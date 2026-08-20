// #1889 — a node-id rejection said only `Invalid input`, while the field beside it
// said `expected string, received undefined`. Read left-to-right the two lines look
// like ONE sentence about node_id that then blames title, which is what confused the
// reporter:
//
//     Invalid input at node_id
//     Invalid input: expected string, received undefined at title
//
// Cause: zod 4 reports a failed `z.union` as one `invalid_union` issue whose own
// `message` is the constant `"Invalid input"`, with the per-member messages —
// NODE_ID_MESSAGE among them — in a nested `errors` array. The MCP SDK's
// `getParseErrorMessage` (1.30) renders `${issue.message} at ${dotPath}` and never
// descends into the nest, so the useful half was dropped on the way out.
//
// The first suite deliberately goes through a REAL McpServer + Client rather than
// calling `z.object(def.schema).safeParse` directly: the string the reporter quoted
// is produced by the SDK's renderer, not by zod, so a schema-level assertion would
// be testing a different sentence than the one that reached them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildPanelToolDefs, registerPanelTools, type PanelToolCtx } from "../../orchestrator/panel-tools.js";
import { NODE_ID_MESSAGE, describeReceived, unionErrorFor } from "../../orchestrator/node-id.js";

function makeFakeCtx(): PanelToolCtx {
  return {
    call: async (cmd) => ({ content: [{ type: "text", text: JSON.stringify(cmd) }] }),
    confirm: async () => "yes" as const,
    bridge: { send: async () => ({}) } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as PanelToolCtx;
}

describe("#1889 the message an agent actually receives over MCP", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "node-id-union-message-test", version: "1.0.0" });
    registerPanelTools(server, makeFakeCtx());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "node-id-union-message-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  const errorText = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError, `${name} was expected to reject ${JSON.stringify(args)}`).toBe(true);
    return (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
  };

  it("REPRODUCTION: the reporter's exact call now explains node_id instead of saying `Invalid input`", async () => {
    const text = await errorText("panel_set_node_title", {});

    // What they got.
    expect(text).not.toMatch(/^Invalid input at node_id$/m);
    // What they get now — both halves the sibling field had.
    expect(text).toContain(NODE_ID_MESSAGE);
    expect(text).toMatch(/received undefined at node_id/);

    // The sibling line is untouched. Its wording is zod's, not ours, and the fix
    // must not have quietly reworded the field that was already correct.
    expect(text).toContain("Invalid input: expected string, received undefined at title");
  });

  it("the two lines can no longer be misread as one sentence about node_id", async () => {
    const lines = (await errorText("panel_set_node_title", {})).split("\n").filter(Boolean);
    const nodeIdLine = lines.find((l) => l.endsWith("at node_id"));
    const titleLine = lines.find((l) => l.endsWith("at title"));
    expect(nodeIdLine, "no node_id line").toBeDefined();
    expect(titleLine, "no title line").toBeDefined();
    // Each line now stands on its own: names its field's expectation AND its input.
    for (const line of [nodeIdLine!, titleLine!]) {
      expect(line).toMatch(/received/);
      expect(line).not.toBe("Invalid input at node_id");
    }
  });

  it("names what it got, for every shape that fails BOTH union members", async () => {
    const cases: Array<[unknown, string]> = [
      [null, "received null"],
      [4.5, "received 4.5"],
      [true, "received true"],
      [{ id: 3 }, 'received {"id":3}'],
      [[1, 2], "received [1,2]"],
    ];
    for (const [value, expected] of cases) {
      const text = await errorText("panel_set_node_title", { node_id: value, title: "t" });
      expect(text, JSON.stringify(value)).toContain(NODE_ID_MESSAGE);
      expect(text, JSON.stringify(value)).toContain(expected);
    }
  });

  it("a BAD STRING was never affected — that path always printed the message", async () => {
    // `"42px"` fails only the string member, so zod collapses it to a plain
    // `invalid_format` issue and NODE_ID_MESSAGE was already reaching the caller.
    // Stated outright so the fix is not credited with more than it did.
    const text = await errorText("panel_set_node_title", { node_id: "42px", title: "t" });
    expect(text).toContain(NODE_ID_MESSAGE);
  });

  it("panel_run's to_node_id gets the same treatment — #1497's reason was buried the same way", async () => {
    const text = await errorText("panel_run", { to_node_id: 4.5 });
    expect(text).not.toMatch(/^Invalid input at to_node_id$/m);
    expect(text).toContain("a run-to-node target must be a plain integer node id");
    expect(text).toContain("received 4.5");
  });

  it("ACCEPTANCE IS UNCHANGED — this is a wording fix and nothing else", async () => {
    // Every spelling #845/#1425/#1497 fought for still validates. A union-level
    // `error` that accidentally narrowed the union would be a far worse bug than
    // the one being fixed, and it would not show up in any message assertion.
    for (const id of [42, "42", "120:104", "120:113:78", -20, "-20", "-20:3"]) {
      const r = await client.callTool({
        name: "panel_set_node_title",
        arguments: { node_id: id, title: "t" },
      });
      const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
      expect(text, `${JSON.stringify(id)} should reach the handler`).not.toMatch(
        /Input validation error/,
      );
    }
    // …and what was refused is still refused.
    for (const id of ["4.5", "", "abc", "1:", ":1", "1::2", "1:-2"]) {
      const text = await errorText("panel_set_node_title", { node_id: id, title: "t" });
      expect(text, JSON.stringify(id)).toContain(NODE_ID_MESSAGE);
    }
  });
});

describe("#1889 coverage across every node-id argument, not just the reported one", () => {
  // A green test on panel_set_node_title proves the helper works; it says nothing
  // about whether the other node-id arguments route through that helper. This
  // sweeps every registered tool and fails if ANY node-id-shaped field still
  // renders the bare union message.
  const defs = buildPanelToolDefs();

  const nodeIdFields = defs.flatMap((d) =>
    Object.keys(d.schema)
      .filter((k) => k === "node_id" || k === "to_node_id")
      .map((k) => [d.name, k] as const),
  );

  it("the sweep is non-vacuous — it found node-id arguments to check", () => {
    expect(nodeIdFields.length).toBeGreaterThan(5);
  });

  it.each(nodeIdFields)("%s.%s explains itself when it fails every union member", (name, field) => {
    const def = defs.find((d) => d.name === name)!;
    const shape = def.schema as z.ZodRawShape;
    const issue = z
      .object(shape)
      .safeParse({ [field]: null })
      .error?.issues.find((i) => i.path[0] === field);
    expect(issue, `${name}.${field} accepted null?`).toBeDefined();
    expect(issue!.message).not.toBe("Invalid input");
    expect(issue!.message).toMatch(/received null/);
  });
});

describe("#1889 the advertised input schema is untouched", () => {
  // node-id.ts chose `.regex()` over `.refine()` specifically so the MCP input
  // schema carries a `pattern` — a client reading the schema learns the shape
  // without failing a call first. A union-level `error` must not disturb that.
  it("a node_id still advertises anyOf[integer, string with the node-id pattern]", () => {
    const def = buildPanelToolDefs().find((d) => d.name === "panel_set_node_title")!;
    const json = z.toJSONSchema(z.object(def.schema as z.ZodRawShape), { io: "input" }) as {
      properties: Record<string, unknown>;
    };
    expect(json.properties.node_id).toEqual({
      anyOf: [
        { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 },
        { type: "string", pattern: "^-?\\d+(?::\\d+)*$" },
      ],
    });
  });
});

describe("#1889 describeReceived is TOTAL — it runs inside zod's error path", () => {
  // A formatter that throws here turns a clean validation refusal into a crash,
  // so the hostile inputs are enumerated rather than assumed. `JSON.stringify`
  // alone fails four of these: it THROWS on a BigInt and on a circular object,
  // and returns the bare `undefined` value for a symbol and a function.
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;

  const cases: Array<[string, unknown, string]> = [
    ["undefined", undefined, "undefined"],
    ["null", null, "null"],
    ["a bigint", 10n, "10n"],
    ["a symbol", Symbol("nope"), "Symbol(nope)"],
    ["a function", () => 1, "a function"],
    ["NaN", Number.NaN, "NaN"],
    ["Infinity", Number.POSITIVE_INFINITY, "Infinity"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "-Infinity"],
    ["a circular object", circular, "an object"],
    ["a plain object", { a: 1 }, '{"a":1}'],
    ["an array", [1, "2"], '[1,"2"]'],
    ["a string", "42px", '"42px"'],
    ["true", true, "true"],
    ["a float", 4.5, "4.5"],
  ];

  it.each(cases)("renders %s without throwing", (_label, input, expected) => {
    expect(describeReceived(input)).toBe(expected);
  });

  it("NaN and Infinity are NOT reported as null", () => {
    // JSON.stringify renders both as `null`, which would tell a caller who passed
    // NaN that they passed null — a different mistake than the one they made.
    expect(JSON.stringify(Number.NaN)).toBe("null"); // the trap, stated outright
    expect(describeReceived(Number.NaN)).toBe("NaN");
    expect(describeReceived(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });

  it("truncates a large value instead of pasting it into the message", () => {
    const huge = { blob: "x".repeat(5000) };
    const rendered = describeReceived(huge);
    expect(rendered.length).toBeLessThanOrEqual(61);
    expect(rendered.endsWith("…")).toBe(true);
  });

  it("a circular ARRAY says array, not object", () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(describeReceived(arr)).toBe("an array");
  });

  // The list below is the probe that found the last hole rather than a
  // decoration on a fix already believed complete. The REVOKED PROXY case threw:
  // `Array.isArray` is itself a proxy trap, so the recovery path inside the
  // catch was another way out of this function. Nine of ten hostile inputs were
  // already handled; enumerating them is what surfaced the tenth.
  //
  // None of these can arrive over the MCP wire, where input is parsed JSON. They
  // are here because the CONTRACT is "cannot throw", and a contract that holds
  // only for the inputs one happened to imagine is not one worth stating.
  const hostile: Array<[string, () => unknown]> = [
    ["a proxy whose get trap throws", () => new Proxy({}, { get: () => { throw new Error("boom"); } })],
    ["a proxy whose ownKeys trap throws", () => new Proxy({}, { ownKeys: () => { throw new Error("boom"); } })],
    ["a REVOKED proxy", () => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; }],
    ["an object whose toJSON throws", () => ({ toJSON: () => { throw new Error("boom"); } })],
    ["an object with a throwing getter", () =>
      Object.defineProperty({}, "x", { get: () => { throw new Error("boom"); }, enumerable: true })],
    ["a null-prototype object", () => Object.create(null)],
    ["a Map", () => new Map([[1, 2]])],
    ["an object whose Symbol.toPrimitive throws", () =>
      ({ [Symbol.toPrimitive]: () => { throw new Error("boom"); } })],
  ];

  it.each(hostile)("survives %s", (_label, make) => {
    let out: string | undefined;
    expect(() => {
      out = describeReceived(make());
    }).not.toThrow();
    expect(typeof out).toBe("string");
  });

  it("a revoked proxy specifically — the one that got past the outer catch", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    // Both the stringify AND the naive `Array.isArray` fallback throw on this.
    expect(() => JSON.stringify(proxy)).toThrow();
    expect(() => Array.isArray(proxy)).toThrow(); // the trap, stated outright
    expect(describeReceived(proxy)).toBe("an object");
  });
});

describe("#1889 unionErrorFor composes the two halves", () => {
  it("keeps the caller's expectation and appends what arrived", () => {
    const fn = unionErrorFor(NODE_ID_MESSAGE);
    expect(fn({ input: undefined })).toBe(`${NODE_ID_MESSAGE}; received undefined`);
    expect(fn({ input: 4.5 })).toBe(`${NODE_ID_MESSAGE}; received 4.5`);
  });
});
