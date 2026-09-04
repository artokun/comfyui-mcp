// #1425 — subgraph-qualified node ids (`120:104`) are real ROOT-level ids left by
// an unpacked subgraph. The readers hand them out; every WRITE tool refused them,
// leaving 18 of 21 nodes uneditable in the reporter's workflow.
//
// The dangerous direction is NOT the refusal — it is the fix done halfway. #845
// left a `Number.parseInt(v, 10)` on this path, so widening the pattern WITHOUT
// changing the transform turns a loud refusal into a silent edit of node 263 when
// the caller asked for 263:78. Every assertion about acceptance below is paired
// with one about identity for that reason.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  NODE_ID_MESSAGE,
  NODE_ID_PATTERN,
  isNodeIdString,
  isQualifiedNodeId,
  normalizeNodeId,
} from "../../orchestrator/node-id.js";

describe("#1425 which strings name a node", () => {
  it("accepts the plain integer forms #845 already allowed", () => {
    for (const v of ["42", "0", "-20", "007"]) expect(isNodeIdString(v)).toBe(true);
  });

  it("accepts subgraph-qualified ids at any depth", () => {
    // The reporter's own ids: two- and three-segment forms from one workflow.
    for (const v of ["120:104", "263:78", "120:113:78", "1:2:3:4"]) {
      expect(isNodeIdString(v)).toBe(true);
      expect(isQualifiedNodeId(v)).toBe(true);
    }
  });

  it("still rejects what #845 rejected", () => {
    for (const v of ["42px", "4.5", "", " ", "1:", ":1", "1::2", "1:2:", "1:-2", "1: 2"]) {
      expect(isNodeIdString(v)).toBe(false);
    }
  });
});

describe("#2855 named ids the graph readers print", () => {
  it("accepts named ids like sampler / mac_studio_vlm", () => {
    for (const v of ["sampler", "mac_studio_vlm", "KSampler", "node_1", "t2i-encoder"]) {
      expect(isNodeIdString(v)).toBe(true);
      expect(isQualifiedNodeId(v)).toBe(false);
    }
  });

  it("a named id is passed through UNTOUCHED — parseInt would be NaN", () => {
    expect(normalizeNodeId("sampler")).toBe("sampler");
    expect(normalizeNodeId("mac_studio_vlm")).toBe("mac_studio_vlm");
    expect(Number.parseInt("sampler", 10)).toBeNaN();
    expect(normalizeNodeId("sampler")).not.toBeNaN();
  });

  it("still refuses 42px so it cannot become node 42", () => {
    expect(isNodeIdString("42px")).toBe(false);
    expect(Number.parseInt("42px", 10)).toBe(42);
  });

  it("a plain id is not a qualified one", () => {
    expect(isQualifiedNodeId("42")).toBe(false);
    expect(isQualifiedNodeId("-20")).toBe(false);
  });

  it("a leading negative is a boundary rail; an inner one is not a shape at all", () => {
    // Rail ids (-10/-20) are real and the readers emit them, so `-20:3` has to
    // survive; `1:-2` is not produced by anything and must not be invented here.
    expect(isNodeIdString("-20:3")).toBe(true);
    expect(isNodeIdString("1:-2")).toBe(false);
  });
});

describe("#1425 what goes on the wire", () => {
  it("a plain id still becomes the NUMBER the wire has always carried", () => {
    expect(normalizeNodeId(42)).toBe(42);
    expect(normalizeNodeId("42")).toBe(42);
    expect(normalizeNodeId("-20")).toBe(-20);
    expect(normalizeNodeId("007")).toBe(7);
  });

  it("a qualified id is passed through UNTOUCHED — parsing it is the bug", () => {
    // The whole point: `Number.parseInt("263:78", 10)` is 263, a DIFFERENT node.
    expect(normalizeNodeId("263:78")).toBe("263:78");
    expect(normalizeNodeId("120:113:78")).toBe("120:113:78");
    expect(Number.parseInt("263:78", 10)).toBe(263); // the trap, stated outright
    expect(normalizeNodeId("263:78")).not.toBe(263);
  });

  it("never returns NaN — an unparseable id must not reach the panel as one", () => {
    for (const v of ["42", "-20", "263:78", "120:113:78", "sampler"]) {
      const out = normalizeNodeId(v);
      expect(typeof out === "number" ? Number.isNaN(out) : false).toBe(false);
    }
  });

  it("the rejection message names the qualified shape", () => {
    // A caller holding `263:78` needs to know whether it is unsupported or
    // malformed; the old message ("must be an integer") answered neither.
    expect(NODE_ID_MESSAGE).toContain("120:104");
  });
});

describe("#1425 what the tool schema ADVERTISES", () => {
  it("keeps a pattern on the wire schema — a refine would advertise nothing", () => {
    // Validating through `.refine()` type-checks and passes every behavioural test
    // above, while rendering as a bare {"type":"string"}: clients would be told
    // LESS about a node id than the old integer-only rule told them. Measured, not
    // assumed — this is the assertion that catches a switch back.
    const schema = z.toJSONSchema(
      z.object({ node_id: z.string().regex(NODE_ID_PATTERN, NODE_ID_MESSAGE) }),
      { io: "input", unrepresentable: "any" },
    ) as { properties: { node_id: { pattern?: string } } };
    expect(schema.properties.node_id.pattern).toBeTruthy();
    // And the advertised pattern must actually admit the shape this issue is about.
    const advertised = new RegExp(schema.properties.node_id.pattern!);
    expect(advertised.test("263:78")).toBe(true);
    expect(advertised.test("42")).toBe(true);
    expect(advertised.test("sampler")).toBe(true);
    expect(advertised.test("1:-2")).toBe(false);
    expect(advertised.test("42px")).toBe(false);
  });
});
