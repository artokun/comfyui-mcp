// #1969 — an unrecognized argument key used to name only itself. The trajectories
// the in-house model trains on are server-verified successes, so a 2–4B model
// never sees the error-to-recovery transition. The reporter's exact case:
//
//     panel_remove_group { groupid: 2 }
//
// produced `unrecognized_keys: ["groupid"]` AND, separately, `expected number,
// received undefined at group_id`. A small model cannot join those. The schema
// now reports the unrecognized key at the protocol boundary.
//
// The first suite goes through a REAL McpServer + Client rather than calling
// the helper directly: the string an agent reads is produced by the SDK's
// renderer, not by zod, so a schema-level assertion would be testing a
// different sentence than the one that reached them. Same harness as #754 /
// #1889.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerPanelTools, type PanelToolCtx } from "../../orchestrator/panel-tools.js";
import {
  editDistance,
  formatUnrecognizedKeyMessage,
  isAffixMatch,
  pairUnrecognizedKeys,
  suggestKnownKey,
  unrecognizedKeysError,
} from "../../orchestrator/unrecognized-keys.js";

function makeFakeCtx(): PanelToolCtx {
  return {
    call: async (cmd) => ({ content: [{ type: "text", text: JSON.stringify(cmd) }] }),
    confirm: async () => "yes" as const,
    bridge: { send: async () => ({}) } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as PanelToolCtx;
}

describe("#1969 the message an agent actually receives over MCP", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "unrecognized-keys-test", version: "1.0.0" });
    registerPanelTools(server, makeFakeCtx());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "unrecognized-keys-test-client", version: "1.0.0" });
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

  it("REPRODUCTION: panel_remove_group {groupid:2} reports the unknown key", async () => {
    const text = await errorText("panel_remove_group", { groupid: 2 });
    expect(text).toMatch(/Unrecognized key 'groupid'/);
    // Still a refusal — this is a suggestion, not #1968's alias.
    expect(text).toMatch(/Input validation error/);
  });

  it("panel_set_todo still names an unknown key while accepting the canonical items key", async () => {
    const text = await errorText("panel_set_todo", {
      items: [{ text: "queue the first variant", status: "pending" }],
      __e2e_bogus_marker_1969__: true,
    });
    expect(text).toMatch(/Unrecognized key '__e2e_bogus_marker_1969__'/);
  });

  it("panel_move_group reports an extra key without suggesting it is the required id", async () => {
    const text = await errorText("panel_move_group", {
      group_id: 2,
      pos: [0, 0],
      __e2e_bogus_marker_1969__: true,
    });
    expect(text).toMatch(/Unrecognized key '__e2e_bogus_marker_1969__'/);
    expect(text).not.toMatch(/did you mean/);
  });

  it("an extra key that is NOT a missing required field is named without a wrong guess", async () => {
    // panel_create_subgraph takes only node_ids. `title` is the sibling
    // panel_create_group's field — it is extra, not a misspelling of node_ids,
    // and node_ids is present, so there is nothing to join.
    const text = await errorText("panel_create_subgraph", { node_ids: [1], title: "Stage A" });
    expect(text).toMatch(/Unrecognized key 'title'/);
    expect(text).not.toMatch(/did you mean/);
  });

  it("a truly bogus key on an all-optional tool still names the key and does not invent a target", async () => {
    const text = await errorText("panel_graph_outline", { __e2e_bogus_marker_1969__: true });
    expect(text).toContain("__e2e_bogus_marker_1969__");
    expect(text).toMatch(/Unrecognized key/);
    expect(text).not.toMatch(/did you mean/);
  });

  it("ACCEPTANCE IS UNCHANGED — the canonical key still reaches the handler", async () => {
    const r = await client.callTool({
      name: "panel_remove_group",
      arguments: { group_id: 2 },
    });
    const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
    expect(text).not.toMatch(/Input validation error/);
    expect(text).not.toMatch(/Unrecognized key/);
    expect(JSON.parse(text)).toMatchObject({ cmd: "graph_remove_group", group_id: 2 });
  });
});

describe("#1969 pairing is the join, not a thesaurus", () => {
  it("group → group_id is an affix, not a coincidental neighbour", () => {
    expect(isAffixMatch("group", "group_id")).toBe(true);
    expect(suggestKnownKey("group", ["group_id", "pos", "title"])).toBe("group_id");
  });

  it("groupid (missing underscore) still lands on group_id", () => {
    expect(suggestKnownKey("groupid", ["group_id", "title"])).toBe("group_id");
  });

  it("todos does NOT look like items — the 1:1 leftover is what joins them", () => {
    expect(suggestKnownKey("todos", ["items"])).toBeUndefined();
    const paired = pairUnrecognizedKeys(["todos"], ["items"], ["items"], { todos: [] });
    expect(paired.get("todos")?.key).toBe("items");
  });

  it("does not join an extra key onto a field that was already provided", () => {
    const paired = pairUnrecognizedKeys(["title"], ["node_ids"], ["node_ids"], {
      node_ids: [1],
      title: "Stage A",
    });
    expect(paired.has("title")).toBe(false);
  });

  it("a random token is not a typo of a short required key", () => {
    expect(suggestKnownKey("__e2e_bogus_marker_1969__", ["max_chars"])).toBeUndefined();
  });
});

describe("#1969 the schema-level error map is what strictPanelSchema installs", () => {
  // Same construction registerPanelTools uses. Proves the map is what changes
  // issue.message, so a future edit that wires the helper and then forgets to
  // pass it into z.object({error}) fails here rather than only on MCP wording.
  it("the reporter's sentence is what formatUnrecognizedKeyMessage emits", () => {
    expect(
      formatUnrecognizedKeyMessage(["group"], ["group_id"], ["group_id"], { group: 2 }),
    ).toBe("Unrecognized key 'group' — did you mean 'group_id'?");
  });

  it("safeParse of the reporter's payload carries that sentence on the issue", () => {
    const shape = { group_id: z.number().int() };
    const payload = { group: 2 };
    const schema = z.object(shape, { error: unrecognizedKeysError(shape) }).strict();
    const result = schema.safeParse(payload);
    expect(result.success).toBe(false);
    if (result.success) return;
    const unrecognized = result.error.issues.filter((i) => i.code === "unrecognized_keys");
    expect(unrecognized.length).toBeGreaterThan(0);
    expect(unrecognized[0]?.message).toBe(
      formatUnrecognizedKeyMessage(["group"], Object.keys(shape), ["group_id"], payload),
    );
  });

  it("formatUnrecognizedKeyMessage never throws on a hostile input", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() =>
      formatUnrecognizedKeyMessage(["group"], ["group_id"], ["group_id"], proxy),
    ).not.toThrow();
  });

  it("editDistance is the identity for equal strings and |len| for empty", () => {
    expect(editDistance("group_id", "group_id")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// #1969 REVIEW of 90d9cf6 — the 1:1 leftover rule fires on COUNTS, not on
// meaning. 34 of the 95 registered panel tools take exactly one required key,
// so before this split every one of them answered any stray key with a
// confident guess. `panel_remove_node {dry_run:true}` → "did you mean
// 'node_id'?" reads exactly like the true `group` → `group_id` case, and the
// 2–4B models this change exists to serve cannot tell them apart — so the
// wrong repair ("move the value into node_id") is the one they act on.
//
// The split is by VALUE compatibility, which is the evidence already in hand:
// the reporter's own `todos` → `items` survives as a "did you mean" because
// the todo array they sent is a valid `items`.
// ---------------------------------------------------------------------------
describe("#1969 review — a structural join must not be phrased as a guess about intent", () => {
  const fitsFor = (shape: Record<string, z.ZodType>) => (target: string, value: unknown) =>
    shape[target] ? shape[target]!.safeParse(value).success : false;

  it("a stray key whose value cannot fit the missing required key is NOT a 'did you mean'", () => {
    const shape = { node_id: z.number() };
    const msg = formatUnrecognizedKeyMessage(
      ["dry_run"],
      Object.keys(shape),
      ["node_id"],
      { dry_run: true },
      fitsFor(shape),
    );
    expect(msg).toBe("Unrecognized key 'dry_run' — required key 'node_id' is missing");
    // The join is still in ONE sentence — that is the ask — but it states the
    // schema fact rather than asserting what the caller meant.
    expect(msg).not.toMatch(/did you mean/);
    expect(msg).toContain("node_id");
  });

  it("the reporter's todos → items SURVIVES as a 'did you mean' because the value fits", () => {
    const shape = { items: z.array(z.object({ text: z.string() })) };
    const msg = formatUnrecognizedKeyMessage(
      ["todos"],
      Object.keys(shape),
      ["items"],
      { todos: [{ text: "queue the first variant" }] },
      fitsFor(shape),
    );
    expect(msg).toBe("Unrecognized key 'todos' — did you mean 'items'?");
  });

  it("a NAME match stays confident even when the value does not fit — the names still pair", () => {
    // `group` → `group_id` is rule 1 (affix). A caller who sends the right key
    // under the wrong name with a bad value should still be told the name.
    const shape = { group_id: z.number() };
    const msg = formatUnrecognizedKeyMessage(
      ["group"],
      Object.keys(shape),
      ["group_id"],
      { group: "not-a-number" },
      fitsFor(shape),
    );
    expect(msg).toBe("Unrecognized key 'group' — did you mean 'group_id'?");
  });

  it("pairUnrecognizedKeys marks the rule-3 join unconfident without a fits predicate", () => {
    const paired = pairUnrecognizedKeys(["dry_run"], ["node_id"], ["node_id"], { dry_run: true });
    expect(paired.get("dry_run")).toEqual({ key: "node_id", confident: false });
  });

  // Same principle one rule up: rules 1-2 match on the NAME, and when two names
  // match equally well the old length tiebreak picked the shorter one and stated
  // it as the answer.
  it("two equally good affix matches REFUSE rather than pick one", () => {
    expect(suggestKnownKey("id", ["from_node_id", "to_node_id"])).toBeUndefined();
    expect(suggestKnownKey("name", ["from_slot_name", "to_slot_name"])).toBeUndefined();
  });

  it("but a SINGLE affix match is still named", () => {
    expect(suggestKnownKey("id", ["to_node_id", "pos"])).toBe("to_node_id");
    expect(suggestKnownKey("group", ["group_id", "pos", "title"])).toBe("group_id");
  });

  it("a name tie that the VALUE can settle is still answered", () => {
    // panel_edit_node carries both node_id and node_ids, so `node` ties on the
    // name. A scalar 5 is not a node_ids, so the value decides. Refusing here
    // would silence a case the original ranking got right.
    const fits = (target: string, value: unknown) =>
      target === "node_id" ? typeof value === "number" : Array.isArray(value);
    expect(suggestKnownKey("node", ["node_id", "node_ids"], fits, 5)).toBe("node_id");
    expect(suggestKnownKey("node", ["node_id", "node_ids"], fits, [1, 2])).toBe("node_ids");
    // ...but a value that fits BOTH leaves it ambiguous, so it still refuses.
    const fitsBoth = () => true;
    expect(suggestKnownKey("node", ["node_id", "node_ids"], fitsBoth, 5)).toBeUndefined();
  });

  it("panel_edit_node {node:5} keeps the suggestion the original ranking got right", async () => {
    const server = new McpServer({ name: "tiebreak-probe", version: "1.0.0" });
    registerPanelTools(server, makeFakeCtx());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "tiebreak-probe-client", version: "1.0.0" });
    await Promise.all([server.connect(st), c.connect(ct)]);
    const r = await c.callTool({ name: "panel_edit_node", arguments: { node: 5, title: "x" } });
    const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
    expect(r.isError).toBe(true);
    expect(text).toMatch(/did you mean 'node_id'\?/);
    await c.close();
    await server.close();
  });

  it("panel_connect {id} over the real surface names neither endpoint", async () => {
    // The live shape is what made this reachable: panel_connect carries both
    // from_node_id and to_node_id, so `id` is genuinely ambiguous.
    const server = new McpServer({ name: "ambiguity-probe", version: "1.0.0" });
    registerPanelTools(server, makeFakeCtx());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "ambiguity-probe-client", version: "1.0.0" });
    await Promise.all([server.connect(st), c.connect(ct)]);
    const r = await c.callTool({ name: "panel_connect", arguments: { id: 5 } });
    const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
    expect(r.isError).toBe(true);
    expect(text).toMatch(/Unrecognized key 'id'/);
    expect(text).not.toMatch(/did you mean 'to_node_id'/);
    expect(text).not.toMatch(/did you mean 'from_node_id'/);
    await c.close();
    await server.close();
  });
});

describe("#1969 review — the live surface, not a hand-built shape", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "unrecognized-keys-review", version: "1.0.0" });
    registerPanelTools(server, makeFakeCtx());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "unrecognized-keys-review-client", version: "1.0.0" });
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

  it("panel_remove_node {dry_run:true} names node_id WITHOUT claiming that is what was meant", async () => {
    const text = await errorText("panel_remove_node", { dry_run: true });
    expect(text).toMatch(/Unrecognized key 'dry_run'/);
    expect(text).toMatch(/required key 'node_id' is missing/);
    expect(text).not.toMatch(/did you mean/);
  });

  it("panel_set_todo still reports an invalid extra key over the real surface", async () => {
    const text = await errorText("panel_set_todo", {
      items: [{ text: "queue the first variant", status: "pending" }],
      __e2e_bogus_marker_1969__: true,
    });
    expect(text).toMatch(/Unrecognized key '__e2e_bogus_marker_1969__'/);
  });

  it("panel_remove_group {groupid:2} still reports an invalid key over the real surface", async () => {
    const text = await errorText("panel_remove_group", { groupid: 2 });
    expect(text).toMatch(/Unrecognized key 'groupid'/);
  });
});

// ---------------------------------------------------------------------------
// #2217 — the arm where NOTHING pairs. #1969's suggester is live and correct:
// `panel_restart_comfyui {forced:true}` is told 'force', because `forced` is an
// edit-1 neighbour. `reason` is not near `force`, and `panel_restart_comfyui`
// has no required keys, so every rule declines and the caller was told what is
// wrong and nothing about what is right.
//
// The served JSON schema already carries `properties`, so this is not
// information the client lacks — it is information the client did not JOIN,
// which is the same gap #1969 was opened to close. The two suites below are
// therefore the point: the reported call gains the list, and every call that
// already had an answer must NOT gain it.
// ---------------------------------------------------------------------------
describe("#2217 a key with no near-miss names the keys that ARE accepted", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "unrecognized-keys-2217", version: "1.0.0" });
    registerPanelTools(server, makeFakeCtx());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "unrecognized-keys-2217-client", version: "1.0.0" });
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

  /** The accepted keys as the CLIENT sees them — the served schema, not the
   *  zod source. If those two ever diverge, the message names the wrong list. */
  const servedKeys = async (name: string): Promise<string[]> => {
    const tools = await client.listTools();
    const schema = tools.tools.find((t) => t.name === name)?.inputSchema;
    return Object.keys((schema?.properties ?? {}) as Record<string, unknown>);
  };

  it("REPRODUCTION: panel_restart_comfyui {reason} now names 'force'", async () => {
    const text = await errorText("panel_restart_comfyui", { reason: "Load custom-node fix" });
    expect(text).toContain("Unrecognized key 'reason' — accepted keys: 'force'");
    // Still a refusal, and still no invented target: the tool does not accept
    // a `reason`, and forwarding one is parked with #1968's `title`.
    expect(text).toMatch(/Input validation error/);
    expect(text).not.toMatch(/did you mean/);
  });

  it("CONTROL: the near-miss 'forced' keeps #1969's answer and does NOT gain the list", async () => {
    const text = await errorText("panel_restart_comfyui", { forced: true });
    expect(text).toMatch(/Unrecognized key 'forced' — did you mean 'force'\?/);
    expect(text).not.toMatch(/accepted keys/);
  });

  it("CONTROL: the canonical key still reaches the handler", async () => {
    const r = await client.callTool({ name: "panel_restart_comfyui", arguments: { force: true } });
    const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
    expect(text).not.toMatch(/Input validation error|Unrecognized key/);
  });

  it("a tool that takes NO arguments says so instead of an empty list", async () => {
    // Dies if panel_free_vram ever gains a key — at which point this pins the
    // wrong tool, not the wrong behaviour.
    expect(await servedKeys("panel_free_vram")).toEqual([]);
    const text = await errorText("panel_free_vram", { reason: "cleanup" });
    expect(text).toContain("Unrecognized key 'reason' — this tool takes no arguments");
    expect(text).not.toMatch(/accepted keys/);
  });

  it("the WIDEST live shape is listed in full — no elision", async () => {
    const keys = await servedKeys("panel_query_graph");
    expect(keys.length).toBeGreaterThan(10);
    const text = await errorText("panel_query_graph", { node_type: "KSampler" });
    expect(text).toContain("Unrecognized key 'node_type' — accepted keys:");
    // Every key the client was served is named. A cap would hide the one the
    // caller wanted; measured, the full clause is 152 characters.
    for (const k of keys) expect(text).toContain(`'${k}'`);
    expect(text).not.toMatch(/…|\.\.\./);
  });

  it("a rule-3 tool keeps 'required key … is missing' and does NOT also get the list", async () => {
    // The join was already made for this caller; 14 more names would bury it.
    const text = await errorText("panel_remove_node", { dry_run: true });
    expect(text).toMatch(/Unrecognized key 'dry_run' — required key 'node_id' is missing/);
    expect(text).not.toMatch(/accepted keys/);
  });

  it("the ambiguous panel_connect {id} names BOTH endpoints without guessing one", async () => {
    // #1969 refuses to pick between from_node_id and to_node_id. Listing the
    // accepted keys hands the caller both candidates, which is the honest
    // answer — and it is still not a "did you mean".
    const text = await errorText("panel_connect", { id: 5 });
    expect(text).toContain("Unrecognized key 'id' — accepted keys:");
    expect(text).toContain("'from_node_id'");
    expect(text).toContain("'to_node_id'");
    expect(text).not.toMatch(/did you mean/);
  });

  it("two stray keys get ONE trailing clause, not one list each", async () => {
    const text = await errorText("panel_restart_comfyui", { reason: "a", why: "b" });
    expect(text).toContain(
      "Unrecognized key 'reason'; Unrecognized key 'why'; accepted keys: 'force'",
    );
    expect(text.match(/accepted keys/g)).toHaveLength(1);
  });
});

describe("#2217 the sentence, at the formatter", () => {
  it("emits the reported string exactly", () => {
    expect(formatUnrecognizedKeyMessage(["reason"], ["force"], [], { reason: "x" })).toBe(
      "Unrecognized key 'reason' — accepted keys: 'force'",
    );
  });

  it("an empty shape cannot produce a dangling 'accepted keys:'", () => {
    expect(formatUnrecognizedKeyMessage(["reason"], [], [], { reason: "x" })).toBe(
      "Unrecognized key 'reason' — this tool takes no arguments",
    );
  });

  it("a paired key and an unpaired one keep their own answers, list stated once", () => {
    const shape = { group_id: z.number(), pos: z.array(z.number()) };
    const msg = formatUnrecognizedKeyMessage(["group", "reason"], Object.keys(shape), [], {
      group: 2,
      reason: "x",
    });
    expect(msg).toBe(
      "Unrecognized key 'group' — did you mean 'group_id'?; Unrecognized key 'reason'; " +
        "accepted keys: 'group_id', 'pos'",
    );
  });

  it("the list is stated in the schema's own order", () => {
    expect(formatUnrecognizedKeyMessage(["zzz"], ["b", "a", "c"], [], { zzz: 1 })).toBe(
      "Unrecognized key 'zzz' — accepted keys: 'b', 'a', 'c'",
    );
  });

  it("still never throws on a hostile input", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => formatUnrecognizedKeyMessage(["reason"], ["force"], [], proxy)).not.toThrow();
  });
});
