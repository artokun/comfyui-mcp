// #796, on a file whose contents are the user's own WRITING.
//
// readOverrides() returned `{}` for both "no overrides file" and "there is one
// and I could not read it", and setPromptOverride is a read-modify-write:
//
//     const o = readOverrides();   // {} after a failed parse
//     o[id] = value;
//     writeOverrides(o);           // …now the file holds ONLY this one override
//
// Every other prompt the user had customised was erased by setting one. This
// file's own write guard already calls its contents "user-authored prompt text"
// and refuses to touch the real one from tests — the same care was missing at the
// read.
//
// The remedy matches the file's OWNERSHIP, which is the distinction this cluster
// keeps turning on: this is our file, so the unreadable original is moved aside
// and replaced. ~/.claude.json is another program's file, so it is refused
// instead of moved.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setPromptOverride,
  clearPromptOverride,
  resolvePrompt,
  panelPromptsPath,
} from "../../services/prompt-overrides.js";

let dir: string;
let file: string;
const OLD = process.env.COMFYUI_MCP_PANEL_PROMPTS;

/** What the user typed, in a file with one typo. */
const USER_TEXT = '{ "planner": "Always think step by step.", "critic": "Be harsh.", }';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-prompts-"));
  file = join(dir, "panel-prompts.json");
  process.env.COMFYUI_MCP_PANEL_PROMPTS = file;
});

afterEach(() => {
  if (OLD === undefined) delete process.env.COMFYUI_MCP_PANEL_PROMPTS;
  else process.env.COMFYUI_MCP_PANEL_PROMPTS = OLD;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("an unreadable overrides file is preserved, not erased", () => {
  it("moves the user's text aside instead of overwriting it", () => {
    writeFileSync(file, USER_TEXT);

    setPromptOverride("newone", "hello");

    const preserved = readdirSync(dir).filter((f) => f.includes(".unreadable-"));
    expect(preserved, "the user's prompt text must be kept").toHaveLength(1);
    expect(readFileSync(join(dir, preserved[0]!), "utf-8")).toBe(USER_TEXT);

    // …and the new override really was written in its place.
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ newone: "hello" });
  });

  it("preserves once — the next set merges normally", () => {
    writeFileSync(file, "{ broken");

    setPromptOverride("a", "1");
    setPromptOverride("b", "2");

    expect(readdirSync(dir).filter((f) => f.includes(".unreadable-"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ a: "1", b: "2" });
  });

  it("preserves valid JSON that is not an object", () => {
    writeFileSync(file, JSON.stringify(["not", "a", "map"]));

    setPromptOverride("a", "1");

    expect(readdirSync(dir).filter((f) => f.includes(".unreadable-"))).toHaveLength(1);
  });
});

describe("the healthy paths are unchanged", () => {
  it("merges into a readable file, keeping the other overrides", () => {
    writeFileSync(file, JSON.stringify({ planner: "keep me", critic: "me too" }));

    setPromptOverride("planner", "changed");

    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      planner: "changed",
      critic: "me too",
    });
    expect(readdirSync(dir).filter((f) => f.includes(".unreadable-"))).toHaveLength(0);
  });

  it("writes into a MISSING file — absent is not unreadable", () => {
    setPromptOverride("planner", "hello");

    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ planner: "hello" });
    expect(readdirSync(dir).filter((f) => f.includes(".unreadable-"))).toHaveLength(0);
  });

  it("an empty value still clears an override", () => {
    writeFileSync(file, JSON.stringify({ planner: "old", critic: "keep" }));

    setPromptOverride("planner", "   ");

    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ critic: "keep" });
  });

  // The QUERY path stays lenient: an unreadable file means built-in defaults
  // apply. A wrong answer, but not a destructive one — and throwing here would
  // break every prompt lookup in the process.
  it("resolvePrompt falls back to the default rather than throwing", () => {
    writeFileSync(file, "{ broken");

    expect(() => resolvePrompt("planner", "BUILT-IN")).not.toThrow();
    expect(resolvePrompt("planner", "BUILT-IN")).toBe("BUILT-IN");
    // …and merely READING must not have touched the file.
    expect(readFileSync(file, "utf-8")).toBe("{ broken");
  });

  // clearPromptOverride was already safe by accident: it only writes when the id
  // is present, and an unreadable file yields `{}`, so `id in o` is false. Pinned
  // so a later refactor cannot quietly turn it into a destructive write.
  it("clearing against an unreadable file writes nothing at all", () => {
    writeFileSync(file, "{ broken");

    clearPromptOverride("planner");

    expect(readFileSync(file, "utf-8")).toBe("{ broken");
    expect(readdirSync(dir).filter((f) => f.includes(".unreadable-"))).toHaveLength(0);
  });

  it("honours the env override for its path", () => {
    expect(panelPromptsPath()).toBe(file);
  });
});
