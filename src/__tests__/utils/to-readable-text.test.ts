// Regression: structured payloads (backend failures, ComfyUI execution errors,
// panel parts) must NEVER render as the literal string "[object Object]" when
// they land in chat text or a model prompt. See panel issues #176 / #175 / #168.

import { describe, expect, it } from "vitest";
import { toReadableText } from "../../utils/errors.js";

describe("toReadableText", () => {
  it("passes a plain string through untouched", () => {
    expect(toReadableText("hello")).toBe("hello");
  });

  it("uses the caller fallback for null/undefined", () => {
    expect(toReadableText(null, "nope")).toBe("nope");
    expect(toReadableText(undefined, "nope")).toBe("nope");
  });

  it("prefers a string message/error/text/detail field on an object", () => {
    expect(toReadableText({ message: "quota reached" })).toBe("quota reached");
    expect(toReadableText({ error: "boom" })).toBe("boom");
    expect(toReadableText({ text: "hi" })).toBe("hi");
    expect(toReadableText({ detail: "d" })).toBe("d");
  });

  it("uses an Error's message", () => {
    expect(toReadableText(new Error("kaboom"))).toBe("kaboom");
  });

  it("JSON-serializes an arbitrary object instead of [object Object]", () => {
    const out = toReadableText({ code: 429, node: "KSampler" });
    expect(out).not.toContain("[object Object]");
    expect(out).toBe('{"code":429,"node":"KSampler"}');
  });

  it("NEVER returns [object Object] for a structured backend failure", () => {
    // The exact #176 shape: a quota failure carried as a structured object.
    const failure = { type: "quota", nested: { limit: 0 } };
    const out = toReadableText(failure, "unknown error");
    expect(out).not.toBe("[object Object]");
    expect(out).not.toContain("[object Object]");
  });

  it("falls back for a cyclic object rather than throwing or coercing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toReadableText(cyclic, "unreadable")).toBe("unreadable");
  });
});
