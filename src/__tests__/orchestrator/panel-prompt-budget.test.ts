// #2234 — the panel system preamble was 35,040 characters (7,925 o200k tokens) of
// prose, most of it restating tool documentation the MCP client already receives.
//
// Two costs. Antigravity passes the whole preamble as an argv `-p "<text>"` argument
// and Windows caps a CreateProcess command line at 32,767 characters, so the preamble
// alone left ~2KB of headroom before the `cmdLen > 30_000` preflight rejected the turn.
// And every backend that takes a system preamble paid ~7.5k input tokens on the first
// turn of every fresh conversation.
//
// The fix removes text from a system prompt, which is a behaviour change no ordinary
// test can see: nothing imports the persona and asserts on what it steers. So this file
// pins the three claims the change rests on, each of which would otherwise rot silently.
//
//   1. THE BUDGET. A size ceiling, or the preamble grows straight back — it reached 35KB
//      one well-argued paragraph at a time, and every one of those paragraphs was worth
//      writing. A number is the only thing that says "not here".
//
//   2. THE CARRIER IS REACHABLE. Guidance moved out of the preamble is only "moved" if
//      the pointer resolves. The persona names `panel-operations`; this drives the REAL
//      `list_packs` handler with `action:"skill_read"` and requires the body back. A
//      pointer to a skill that does not load is guidance that was DELETED.
//
//   3. THE MCP DESCRIPTIONS STILL CARRY WHAT THE PREAMBLE STOPPED SAYING. Most cuts were
//      justified by measurement: the panel MCP server registers 96 tools with ~70,000
//      characters of description, and the sentence the preamble was repeating is already
//      in the tool's own description, verbatim. That justification is only true while it
//      stays true — shorten `panel_clear`'s description and "never use it for a new
//      workflow" is gone from BOTH surfaces at once, with nothing else to notice.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { PANEL_SYSTEM_APPEND, resolvePanelPersona } from "../../orchestrator/index.js";
import { buildPanelToolDefs } from "../../orchestrator/panel-tools.js";
import { registerSkillsAccessTools } from "../../tools/skills-access.js";
import { resolveHttpLaneComfyToolMode } from "../../orchestrator/http-backend-tools.js";
import { collectToolCatalog } from "../../tools/index.js";

/**
 * The ceiling, in characters.
 *
 * 16,000 is the owner's number (issue #2234) and it has a mechanical reading: the
 * Antigravity adapter spends the preamble out of a 32,767-character Windows command
 * line, so half of it is the most the steering may take before the user's own message
 * starts losing room.
 */
const PERSONA_MAX_CHARS = 16_000;

/** The skill the preamble hands the moved procedures to. */
const CARRIER_SKILL = "panel-operations";

// Read DEFENSIVELY, the way #1551's test does. A deleted or renamed carrier must fail as
// a readable assertion ("that call actually resolves", below) — a module-scope throw
// collects zero tests from this file and reports as a load error that says nothing about
// which half regressed. Normalized the way the LOADER normalizes (splitFrontmatter strips
// the BOM and folds CRLF), so this does not fail on a core.autocrlf=true checkout.
const SKILL_FILE = fileURLToPath(
  new URL(`../../../plugin/skills/${CARRIER_SKILL}/SKILL.md`, import.meta.url),
);
const SKILL_BODY = existsSync(SKILL_FILE)
  ? readFileSync(SKILL_FILE, "utf-8").replace(/^﻿/, "").replace(/\r\n/g, "\n")
  : "";

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

/** The live `list_packs` handler, registered exactly the way the server registers it. */
function listPacksHandler(): Handler {
  const tools: Array<{ name: string; handler: Handler }> = [];
  const server = {
    tool: (name: string, _desc: string, _shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, handler });
    },
  };
  registerSkillsAccessTools(server as never);
  const tool = tools.find((t) => t.name === "list_packs");
  expect(tool, "list_packs is no longer registered by registerSkillsAccessTools").toBeDefined();
  return tool!.handler;
}

/** Description text keyed by tool name, as `buildPanelToolDefs()` hands it to the client. */
function panelToolDescriptions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const def of buildPanelToolDefs() as Array<{ name: string; description?: string }>) {
    out.set(def.name, def.description ?? "");
  }
  return out;
}

describe("#2234 the panel preamble stays inside its budget", () => {
  it("PANEL_SYSTEM_APPEND is under the character ceiling", () => {
    // Reported rather than asserted bare: when this trips, the next author needs to know
    // by how much, not just that it did.
    expect({ chars: PANEL_SYSTEM_APPEND.length, max: PERSONA_MAX_CHARS }).toEqual({
      chars: Math.min(PANEL_SYSTEM_APPEND.length, PERSONA_MAX_CHARS),
      max: PERSONA_MAX_CHARS,
    });
  });

  it("the RENDERED persona is under it too, not just the literal", () => {
    // resolvePanelPersona() is what a backend actually receives — it re-applies the
    // deferred-catalog steering on top of any prompt override. Measuring only the
    // literal would miss anything appended after it.
    const persona = resolvePanelPersona();
    expect({ chars: persona.length, max: PERSONA_MAX_CHARS }).toEqual({
      chars: Math.min(persona.length, PERSONA_MAX_CHARS),
      max: PERSONA_MAX_CHARS,
    });
  });

  it("is not vacuous — the preamble still says something", () => {
    // The trivial way to pass a size ceiling is to empty the string, which would ship a
    // panel agent with no steering at all and every assertion above still green.
    expect(PANEL_SYSTEM_APPEND.length).toBeGreaterThan(8_000);
  });
});

describe("#2234 what left the preamble is reachable through the carrier skill", () => {
  it("the preamble names the carrier skill and the call that loads it", () => {
    expect(PANEL_SYSTEM_APPEND).toContain(CARRIER_SKILL);
    // The exact invocation, not just the name: an agent told "read the panel-operations
    // skill" with no call to make is the #1398 failure shape again.
    expect(PANEL_SYSTEM_APPEND).toContain(`action:"skill_read", name:"${CARRIER_SKILL}"`);
  });

  it("that call actually resolves through the live list_packs handler", async () => {
    // The reachability proof. Not `existsSync` on the directory — the production reader
    // validates the name, resolves it under the skills root, and reads SKILL.md, and any
    // of those can reject a skill that is sitting right there on disk.
    const res = await listPacksHandler()({ action: "skill_read", name: CARRIER_SKILL });
    expect(res.isError ?? false, res.content?.[0]?.text).toBe(false);
    expect(res.content[0].text).toContain("# Panel agent operations");
  });

  it("the frontmatter name matches the name the preamble tells the agent to pass", () => {
    // skill_read resolves plugin/skills/<name>/SKILL.md by DIRECTORY, but Claude loads
    // the skill by its frontmatter name. A disagreement gives one surface a skill the
    // other cannot address.
    expect(SKILL_BODY).toMatch(new RegExp(`^---\\nname: ${CARRIER_SKILL}\\n`));
  });

  // Each entry is a section that LEFT the preamble in this change. The marker is a
  // phrase specific enough that deleting the section deletes the marker with it.
  it.each([
    ["subgraph boundary rails", "panel_expose_subgraph_output"],
    ["group-to-subgraph refactor", "panel_subgraph_group"],
    ["dissolving a subgraph", "panel_unpack_subgraph"],
    ["merging workflows across tabs", "panel_copy_nodes"],
    ["blueprint library reuse", "panel_save_subgraph"],
    ["pinning edits to one workflow", "panel_set_workflow_target"],
    ["opening a staged workflow file", "panel_load_workflow(path:<file>)"],
    ["untangling Get/Set buses", "panel_strip_workflow"],
    ["slicing a toggle-template monolith", "panel_slice_workflow"],
    ["authoring rgthree Fast Groups", "matchTitle"],
    ["the LoRA Manager autocomplete limit", "AUTOCOMPLETE_TEXT_LORAS"],
    ["the CivitAI browser flow", "panel_civitai_highlight"],
    ["downloading model weights", "target_subfolder"],
    ["hardware and runtime stats", "nvidia-smi"],
    ["Prompt Director audits", "panel_audit_prompt_director"],
    ["the crash-recovery ladder", "COMFYUI_PATH/custom_nodes/"],
    ["run-to-node debugging", "MaskToImage"],
    ["multi-stage chaining", 'upload_image (action:"stage")'],
    ["video verification off the filesystem", 'get_image (action:"list_outputs")'],
    ["connecting MCP servers", "panel_add_mcp"],
  ])("the carrier still covers %s", (_topic, marker) => {
    expect(SKILL_BODY).toContain(marker);
  });
});

describe("#2234 the carrier is reachable on the lane the report came from", () => {
  // Gate P1. The preamble tells the agent to call `list_packs`, but Antigravity — the
  // backend in the report — reaches the comfyui server through
  // makeHttpBackendMcpServers(), whose default tool mode is COMPACT (#291: the full
  // surface crowds panel_* out of a Codex/Gemini session's tool budget). In compact mode
  // the server advertises only list_tools / describe_tool / call_tool, so `list_packs` is
  // not a name the agent can call directly. That was survivable while the preamble merely
  // SUGGESTED skills; it is not survivable once 20 topics of guidance live behind it.

  it("that lane really does default to compact", () => {
    // Measured, not assumed — this is the premise the routing note rests on.
    expect(resolveHttpLaneComfyToolMode({} as NodeJS.ProcessEnv)).toBe("compact");
    expect(resolveHttpLaneComfyToolMode({ COMFYUI_MCP_TOOL_MODE: "full" } as NodeJS.ProcessEnv))
      .toBe("full");
  });

  it("the preamble names the compact route instead of assuming a direct call", () => {
    expect(PANEL_SYSTEM_APPEND).toContain("COMPACT mode");
    expect(PANEL_SYSTEM_APPEND).toContain("list_tools / describe_tool / call_tool");
    expect(PANEL_SYSTEM_APPEND).toMatch(/route it as call_tool/);
    // And it must say absence is not proof of absence — the #1398 shape, one lane over.
    expect(PANEL_SYSTEM_APPEND).toMatch(/absent from your tool list is NOT missing/);
  });

  it("call_tool can actually reach the tool the carrier pointer names", async () => {
    // The compact facade dispatches through this catalog, so a name present here is
    // reachable as call_tool({ name, args }). If list_packs ever left the catalog, the
    // routing note would be pointing at a dead end.
    const catalog = await collectToolCatalog();
    expect(catalog.tools.has("list_packs")).toBe(true);
    // The other comfyui tools the preamble names by bare name, for the same reason.
    for (const name of ["download_model", "get_system_stats", "upload_image", "get_image"]) {
      expect(catalog.tools.has(name), `${name} is not reachable through call_tool`).toBe(true);
    }
  });
});

describe("#2234 the cuts justified by MCP registration are still covered there", () => {
  // Measured on this branch: buildPanelToolDefs() registers 96 tools carrying ~70,000
  // characters of description, and each row below is a sentence the preamble used to
  // repeat that the tool's OWN description already states. If a row fails, the guidance
  // is gone from both surfaces and belongs back in the preamble or in the skill.
  const descriptions = panelToolDescriptions();

  it.each([
    ["panel_clear", "NEVER use this for a 'new workflow'"],
    ["panel_new_workflow", "NEVER use panel_clear for a new workflow"],
    ["panel_set_workflow_target", "pinning to a background tab is REJECTED at pin time"],
    ["panel_subgraph_group", "TOGGLEABLE"],
    ["panel_expose_subgraph_output", "do NOT panel_connect to a guessed rail node id"],
    ["panel_expose_subgraph_input", "do NOT panel_connect to a guessed rail node id"],
    ["panel_unpack_subgraph", "INVERSE of panel_create_subgraph"],
    ["panel_copy_nodes", "clipboard PERSISTS across workflow switches"],
    ["panel_paste_nodes", "merge/compose workflows"],
    ["panel_save_subgraph", "blueprint LIBRARY"],
    ["panel_add_subgraph", "REUSE a built subgraph in another workflow"],
    // The guarantee is server-side reading, not the old wording: panel#2011 reworded this
    // clause when `path` learned API/prompt format. Pin the sentence that still states it.
    ["panel_load_workflow", "read SERVER-SIDE so a large graph never enters your context"],
    ["panel_strip_workflow", "Get/Set buses"],
    ["panel_slice_workflow", "Fast Groups Bypasser/Muter"],
    ["panel_set_property", "matchTitle"],
    ["panel_add_node", "AUTOCOMPLETE_TEXT_"],
    ["panel_open_civitai", "panel_civitai_highlight"],
    ["panel_audit_prompt_director", "before saying the model/LoRA setup is correct"],
    ["panel_show_media", "whenever the user asks to SEE"],
    ["panel_ui_render", "comfy:chart"],
    ["panel_enter_subgraph", "subgraph"],
    ["panel_restart_comfyui", "ABORTS any in-progress or queued generation"],
    ["panel_update_node", "nightly"],
    ["panel_add_mcp", "ALWAYS ask the user before connecting a remote"],
  ])("%s still documents it natively", (tool, phrase) => {
    const desc = descriptions.get(tool);
    expect(desc, `${tool} is no longer a registered panel tool`).toBeDefined();
    expect(desc).toContain(phrase);
  });

  it("the native surface is large enough for that argument to hold at all", () => {
    // The measurement the cuts were argued from, pinned so the claim in the PR body can
    // be re-checked rather than believed. If the panel surface ever collapses to a
    // handful of tools, "the descriptions already say it" stops being true wholesale.
    const total = [...descriptions.values()].reduce((n, d) => n + d.length, 0);
    expect(descriptions.size).toBeGreaterThan(80);
    expect(total).toBeGreaterThan(50_000);
  });
});
