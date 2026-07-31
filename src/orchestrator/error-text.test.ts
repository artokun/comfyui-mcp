// Coverage for the shared text-coercion helpers that keep structured payloads
// from surfacing as the literal "[object Object]" in chat / prompts
// (issues #176, #175).

import { describe, expect, it } from "vitest";
import { errorText, messageText, promptText } from "./error-text.js";

describe("errorText (#176)", () => {
  it("returns the message of an Error", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  it("never returns [object Object] for a plain object error", () => {
    const out = errorText({ code: 429, foo: "bar" });
    expect(out).not.toBe("[object Object]");
    expect(out).toBe('{"code":429,"foo":"bar"}');
  });

  it("extracts a string message field from a structured error", () => {
    expect(errorText({ message: "Individual quota reached." })).toBe(
      "Individual quota reached.",
    );
  });

  it("coerces primitives with String()", () => {
    expect(errorText(42)).toBe("42");
    expect(errorText(null)).toBe("null");
  });

  it("degrades a cyclic object to 'unknown error', never [object Object]", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const out = errorText(cyclic);
    expect(out).not.toBe("[object Object]");
    expect(out).toBe("unknown error");
  });

  it("does not throw and never returns [object Object] for a throwing getter", () => {
    const hostile = {
      get message(): string {
        throw new Error("getter exploded");
      },
    };
    let out = "";
    expect(() => {
      out = errorText(hostile);
    }).not.toThrow();
    expect(out).not.toBe("[object Object]");
  });

  it("coerces an Error whose runtime message is a non-string object", () => {
    const err = new Error("placeholder");
    // Simulate a subclass / runtime that set a non-string message.
    (err as { message: unknown }).message = { code: 500 };
    const out = errorText(err);
    expect(out).not.toBe("[object Object]");
    expect(out).toBe('{"code":500}');
  });
});

describe("promptText (#175)", () => {
  it("passes strings through unchanged", () => {
    expect(promptText("hello")).toBe("hello");
  });

  it("never returns [object Object] for a structured user payload", () => {
    const out = promptText({ type: "image", ref: "input/a.png" });
    expect(out).not.toBe("[object Object]");
    expect(out).toBe('{"type":"image","ref":"input/a.png"}');
  });

  it("extracts a string text field from a multi-part payload", () => {
    expect(promptText({ text: "typed message", parts: [] })).toBe("typed message");
  });

  it("maps null/undefined to empty string", () => {
    expect(promptText(null)).toBe("");
    expect(promptText(undefined)).toBe("");
  });

  it("does NOT collapse an empty-text payload that still carries parts", () => {
    const out = promptText({ text: "", parts: [{ kind: "image", ref: "input/b.png" }] });
    expect(out).not.toBe("");
    expect(out).toContain("input/b.png");
  });

  it("gives a non-empty fallback when serialization fails (circular)", () => {
    const cyclic: Record<string, unknown> = { parts: [1] };
    cyclic.self = cyclic;
    const out = promptText(cyclic);
    expect(out).not.toBe("");
    expect(out).not.toBe("[object Object]");
  });

  it("does not throw on a throwing getter and never returns [object Object]", () => {
    const hostile = {
      get text(): string {
        throw new Error("boom");
      },
      other: "x",
    };
    let out = "";
    expect(() => {
      out = promptText(hostile);
    }).not.toThrow();
    expect(out).not.toBe("[object Object]");
  });

  it("keeps NON-EMPTY text even when the parts read throws", () => {
    const hostile = {
      get text(): string {
        return "hello";
      },
      get parts(): unknown {
        throw new Error("parts exploded");
      },
    };
    let out = "";
    expect(() => {
      out = promptText(hostile);
    }).not.toThrow();
    expect(out).toBe("hello");
  });

  it("never returns '' when text is empty but the parts read throws", () => {
    const hostile = {
      get text(): string {
        return "";
      },
      get parts(): unknown {
        throw new Error("parts exploded");
      },
    };
    let out = "";
    expect(() => {
      out = promptText(hostile);
    }).not.toThrow();
    expect(out).not.toBe("");
    expect(out).not.toBe("[object Object]");
  });
});

describe("promptText — literal [object Object] artifact (#534)", () => {
  it("maps an exact literal sentinel string to empty", () => {
    expect(promptText("[object Object]")).toBe("");
  });

  it("trims a padded exact sentinel to empty", () => {
    expect(promptText("  [object Object]  ")).toBe("");
  });

  it("strips a standalone leading sentinel line and keeps the real message", () => {
    expect(promptText("[object Object]\n\n지금 연결된 니 모델이 뭐야")).toBe(
      "지금 연결된 니 모델이 뭐야",
    );
  });

  it("strips a leading sentinel line with a single newline too", () => {
    expect(promptText("[object Object]\nhello")).toBe("hello");
  });

  it("tolerates horizontal whitespace around a leading sentinel line", () => {
    expect(promptText("  [object Object]  \n\nreal message")).toBe("real message");
  });

  it("does NOT touch a legitimate mid-prose mention of the phrase", () => {
    const prose = "my logs printed [object Object] and I want to know why";
    expect(promptText(prose)).toBe(prose);
  });

  it("does NOT strip a sentinel that is not on its own leading line", () => {
    const prose = "here is the value: [object Object]";
    expect(promptText(prose)).toBe(prose);
  });

  it("only strips the FIRST leading sentinel line, leaving inline copies intact", () => {
    expect(promptText("[object Object]\n\nkeep [object Object] here")).toBe(
      "keep [object Object] here",
    );
  });
});

describe("messageText (#421, #422)", () => {
  it("passes a plain string reply through unchanged", () => {
    expect(messageText("Done — 4 images rendered.")).toBe("Done — 4 images rendered.");
  });

  it("extracts readable text from a structured object payload", () => {
    const out = messageText({ text: "the run finished" });
    expect(out).not.toBe("[object Object]");
    expect(out).toBe("the run finished");
  });

  it("joins array-of-parts structured content", () => {
    const out = messageText([
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]);
    expect(out).toBe("hello world");
  });

  it("reaches into content/value/output_text/message keys", () => {
    expect(messageText({ content: "via content" })).toBe("via content");
    expect(messageText({ output_text: "via output_text" })).toBe("via output_text");
    expect(messageText({ message: { text: "nested" } })).toBe("nested");
  });

  it("treats the literal [object Object] sentinel as empty (not real content)", () => {
    expect(messageText("[object Object]")).toBe("");
  });

  it("treats a PADDED sentinel as empty (trims before judging)", () => {
    expect(messageText(" [object Object] ")).toBe("");
    expect(messageText({ text: "  [object Object]  " })).toBe("");
  });

  it("falls through a whitespace-only text to a real sibling key", () => {
    expect(messageText({ text: " ", content: "real final" })).toBe("real final");
  });

  it("preserves internal/edge spacing of a genuine message", () => {
    expect(messageText("  hello world  ")).toBe("  hello world  ");
  });

  it("returns '' (no throw) for a revoked Proxy payload", () => {
    const revocable = Proxy.revocable({ text: "x" }, {});
    revocable.revoke();
    let out = "unset";
    expect(() => {
      out = messageText(revocable.proxy);
    }).not.toThrow();
    expect(out).toBe("");
  });

  it("returns '' (never [object Object]) for an unreadable object so callers can fall back", () => {
    const out = messageText({ foo: 1, bar: 2 });
    expect(out).not.toBe("[object Object]");
    expect(out).toBe("");
  });

  it("does not throw and returns '' for a throwing getter", () => {
    const hostile = {
      get text(): string {
        throw new Error("boom");
      },
    };
    let out = "";
    expect(() => {
      out = messageText(hostile);
    }).not.toThrow();
    expect(out).not.toBe("[object Object]");
  });

  it("does not recurse forever on a cyclic payload", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.text = cyclic;
    let out = "";
    expect(() => {
      out = messageText(cyclic);
    }).not.toThrow();
    expect(out).toBe("");
  });
});
