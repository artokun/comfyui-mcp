// #1398 — a code-mode agent was told, by the INJECTED steering, to look for tools it
// could never see under that name. It scanned its direct declarations, found no bare
// `panel_` name, concluded the live-canvas tools were missing, and started
// investigating a rollback of the product — while the panel MCP endpoint was
// answering tools/list with 91 tools and HTTP 200.
//
// #1353 fixed the message you get when you CALL a missing tool (v0.50.104). The
// reporter had that fix; it is a different surface from the one they followed.
//
// These assert on the RENDERED strings, not on the source. A template literal whose
// `${…}` silently failed to interpolate would type-check, build, and ship the
// placeholder text to the agent — the exact failure this guidance exists to prevent,
// and one no source-grep test can see.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";

// Importing the orchestrator entry transitively reaches resolveLiveInterpreter, which
// shells out to find the python actually serving the port on THIS machine — so these
// tests would assert one thing where ComfyUI is running and another where it is not,
// and CI could not tell us (#1290/#1263). Stubbed at its module boundary.
vi.mock("../../services/live-interpreter.js", async () => ({
  ...(await vi.importActual("../../services/live-interpreter.js")),
  resolveLiveInterpreter: () => undefined,
  observeLiveServerProcess: () => undefined,
}));
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFERRED_PANEL_QUALIFIED_NAME,
  DEFERRED_PANEL_TOOLS_NOTE,
  DEFERRED_PANEL_TOOLS_STEERING,
  withDeferredPanelToolsNote,
} from "../../deferred-panel-tools.js";
import { setPromptOverride } from "../../services/prompt-overrides.js";
import { PANEL_SYSTEM_APPEND, resolvePanelPersona } from "../../orchestrator/index.js";

describe("#1398 the injected steering says where the tools actually are", () => {
  it("names the prefixed spelling a deferred catalog holds", () => {
    // Not "check your deferred tools" — the reporter's agent DID inspect its tools.
    // What it needed was the spelling.
    expect(PANEL_SYSTEM_APPEND).toContain("mcp__panel__panel_graph_outline");
  });

  it("names the catalog to search", () => {
    expect(PANEL_SYSTEM_APPEND).toContain("ALL_TOOLS");
  });

  it("requires BOTH surfaces to be empty before absence may be concluded", () => {
    expect(PANEL_SYSTEM_APPEND).toMatch(/BOTH your direct declarations and your\s+deferred catalog/);
  });

  it("tells the agent not to treat apparent absence as a product fault", () => {
    // The reported harm was not the wrong belief — it was what the agent did next.
    expect(PANEL_SYSTEM_APPEND.toLowerCase()).toContain("roll back");
  });

  it("INTERPOLATED — no un-rendered placeholder reaches the agent", () => {
    // The assertion that catches the silent failure: `${DEFERRED_PANEL_TOOLS_STEERING}`
    // inside a non-template string compiles and ships the literal text.
    expect(PANEL_SYSTEM_APPEND).not.toContain("${");
    expect(PANEL_SYSTEM_APPEND).toContain(DEFERRED_PANEL_TOOLS_STEERING);
  });
});

describe("#1398 both surfaces share one source of truth", () => {
  it("the steering is built from the same note the unknown-tool message uses", () => {
    // Two surfaces phrasing this in their own words is how one ends up a version
    // behind the other — which is exactly what #1398 reported after #1353.
    expect(DEFERRED_PANEL_TOOLS_STEERING).toContain(DEFERRED_PANEL_TOOLS_NOTE);
  });

  it("the qualified name is assembled from the prefix, not written out twice", () => {
    expect(DEFERRED_PANEL_QUALIFIED_NAME).toBe("mcp__panel__panel_graph_outline");
    expect(DEFERRED_PANEL_TOOLS_NOTE).toContain(DEFERRED_PANEL_QUALIFIED_NAME);
  });

  it("the note distinguishes the two spellings rather than mentioning one", () => {
    // "look for mcp__panel__panel_graph_outline" alone leaves a reader unsure whether
    // the bare name was wrong or merely absent.
    expect(DEFERRED_PANEL_TOOLS_NOTE).toContain("not `panel_graph_outline`");
  });
});

describe("#1398 the guidance survives a persona OVERRIDE", () => {
  // codex review, P1: the persona is resolved through resolvePrompt("panel.persona", …),
  // so a locale translation or a user override replaces the WHOLE string — silently
  // taking this guidance with it. A non-English deployment would then reproduce #1398
  // with the fix apparently shipped, which is the hardest version of it to diagnose.
  it("appends the note to an override that lacks it", () => {
    const translated = "Eres el asistente autónomo integrado en el panel de ComfyUI.";
    const out = withDeferredPanelToolsNote(translated);
    expect(out).toContain(translated); // the override is preserved, not replaced
    expect(out).toContain(DEFERRED_PANEL_QUALIFIED_NAME);
    expect(out).toContain("ALL_TOOLS");
  });

  it("is IDEMPOTENT — a persona that already carries it is returned untouched", () => {
    // Applied on every refresh, so a non-idempotent version would grow the prompt by
    // a paragraph each time.
    const once = withDeferredPanelToolsNote("a persona with no tool guidance at all");
    const twice = withDeferredPanelToolsNote(once);
    expect(twice).toBe(once);
    expect(once.split("ALL_TOOLS").length - 1).toBe(1); // exactly one mention, not two
  });

  it("leaves the shipped default persona untouched", () => {
    expect(withDeferredPanelToolsNote(PANEL_SYSTEM_APPEND)).toBe(PANEL_SYSTEM_APPEND);
  });

  it("an empty override still gets the guidance", () => {
    expect(withDeferredPanelToolsNote("")).toContain(DEFERRED_PANEL_QUALIFIED_NAME);
  });
});

describe("#1398 the guidance reaches the agent THROUGH the override path", () => {
  // setPromptOverride is a read-modify-WRITE of ~/.comfyui-mcp/panel-prompts.json —
  // the real one. Redirect it, or a test run edits the user's own persona override.
  let dir = "";
  let prev: string | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cmcp-prompts-"));
    prev = process.env.COMFYUI_MCP_PANEL_PROMPTS;
    process.env.COMFYUI_MCP_PANEL_PROMPTS = join(dir, "panel-prompts.json");
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.COMFYUI_MCP_PANEL_PROMPTS;
    else process.env.COMFYUI_MCP_PANEL_PROMPTS = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  // The helper being correct proves nothing about it being CALLED. A mutation run
  // showed exactly that: dropping the call at the resolution site left all twelve
  // tests above green, so the wiring is asserted here on the real resolver.
  it("a TRANSLATED persona override still carries the guidance", () => {
    const translated = "Eres el asistente autónomo integrado en el panel lateral de ComfyUI.";
    setPromptOverride("panel.persona", translated);
    try {
      const persona = resolvePanelPersona();
      expect(persona).toContain(translated); // the translation is honoured…
      expect(persona).toContain(DEFERRED_PANEL_QUALIFIED_NAME); // …and so is this
      expect(persona).toContain("ALL_TOOLS");
    } finally {
      setPromptOverride("panel.persona", "");
    }
  });

  it("with no override, the shipped persona is returned unchanged", () => {
    setPromptOverride("panel.persona", "");
    expect(resolvePanelPersona()).toBe(PANEL_SYSTEM_APPEND);
  });
});

describe("#1398 the install line itself", () => {
  // `panelSystemAppend` is a local inside runPanelOrchestrator(), so a call site that
  // bypasses resolvePanelPersona() and calls resolvePrompt() directly is invisible to
  // every behavioural test above — confirmed by a mutation run that left all 14 green
  // while the guidance stopped reaching agents entirely.
  //
  // A source assertion is a weak instrument and is used here for the one thing it can
  // do: notice the line being removed. It is verified the only way that means
  // anything, by deleting the line and watching this fail.
  it("runPanelOrchestrator builds the persona through resolvePanelPersona()", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../orchestrator/index.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("let panelSystemAppend = resolvePanelPersona();");
    // And nothing else may resolve the persona behind its back. Keyed on the
    // FALLBACK, not the id string (codex round 2, P2): a bypass written as
    // `resolvePrompt(PANEL_PERSONA_ID, PANEL_SYSTEM_APPEND)` passes an id-literal
    // check while dropping the remedy. Any such call still has to name the fallback.
    const direct = src.match(/resolvePrompt\("panel\.persona"/g) ?? [];
    expect(direct).toHaveLength(1); // exactly one: inside resolvePanelPersona itself
    // Matches ANY resolvePrompt whose fallback is the persona, whatever the id
    // expression is — so `resolvePrompt(PANEL_PERSONA_ID, PANEL_SYSTEM_APPEND)` is
    // caught too. (Comments and registerPrompt legitimately name the constant, so
    // counting bare mentions would be brittle in the way codex warned about.)
    // `[^)]*` could not cross a nested `)` (codex round 3), so an equivalent
    // refactor like `resolvePrompt(promptIdFor("panel.persona"), PANEL_SYSTEM_APPEND)`
    // matched nothing and failed this guard for no reason. Bounded-span instead: it
    // spans a nested call while still not running away across the file.
    const resolvers = src.match(/resolvePrompt\([\s\S]{0,200}?PANEL_SYSTEM_APPEND/g) ?? [];
    expect(resolvers).toHaveLength(1); // only resolvePanelPersona resolves the persona
  });
});

describe("#1398 idempotence is keyed on the GUIDANCE, not the tool name", () => {
  // codex round 2, P1. A persona that merely mentions the qualified name — a user
  // override naming the tool, a translation keeping identifiers — used to be treated
  // as already-fixed and received none of the actual guidance.
  it("a persona that only MENTIONS the tool name still gets the guidance", () => {
    const mentionsOnly = `Usa ${DEFERRED_PANEL_QUALIFIED_NAME} para leer el lienzo.`;
    const out = withDeferredPanelToolsNote(mentionsOnly);
    expect(out).not.toBe(mentionsOnly);
    expect(out).toContain("ALL_TOOLS");
    expect(out).toContain(DEFERRED_PANEL_TOOLS_STEERING);
  });

  it("a persona carrying the FULL steering is still returned untouched", () => {
    const already = `preamble

${DEFERRED_PANEL_TOOLS_STEERING}`;
    expect(withDeferredPanelToolsNote(already)).toBe(already);
  });
});
