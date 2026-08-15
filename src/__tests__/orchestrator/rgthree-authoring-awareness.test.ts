// #1551 — rgthree's Fast Groups Bypasser/Muter are a recurring agent-failure mode, and BOTH
// halves of the fix are the kind that no behavioural test can see:
//
//   * a bundled SKILL.md is inert data — nothing imports it, so deleting it keeps every
//     suite green while the knowledge silently stops shipping; and
//   * the system-prompt paragraph is one string literal in index.ts — delete it and the
//     orchestrator still builds, still spawns, still passes, and the agent simply never
//     learns the facts again.
//
// So both are asserted at their SOURCE, on the specific claims that were expensive to
// establish (they were verified against the installed pack and the panel's own guard, not
// copied from the report — the report got three of them wrong).
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const PROMPT_SRC = readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf-8");
// Read defensively: a DELETED skill must fail as a readable assertion ("the skill is
// bundled" below), not as a module-scope throw that collects zero tests and hides which
// of the two halves of #1551 regressed.
const SKILL_URL = new URL("../../../plugin/skills/rgthree/SKILL.md", import.meta.url);
const SKILL = existsSync(SKILL_URL) ? readFileSync(SKILL_URL, "utf-8") : "";

describe("the system prompt teaches AUTHORING rgthree toggles, not just reading them (#1551)", () => {
  it("carries the authoring section", () => {
    expect(PROMPT_SRC).toMatch(/AUTHORING rgthree TOGGLES/);
  });

  it("names panel_set_property as the configuration tool, NOT panel_set_widget", () => {
    // The whole point of the section. `matchTitle`/`sort`/`toggleRestriction` are
    // node PROPERTIES; panel_set_widget refuses them.
    const section = PROMPT_SRC.slice(PROMPT_SRC.indexOf("AUTHORING rgthree TOGGLES"));
    expect(section).toMatch(/configured with panel_set_property, NOT panel_set_widget/);
  });

  it("says absence from /object_info is NOT evidence the node is unavailable", () => {
    const section = PROMPT_SRC.slice(PROMPT_SRC.indexOf("AUTHORING rgthree TOGGLES"));
    expect(section).toMatch(/absent from \/object_info/);
    expect(section).toMatch(/NOT evidence/);
  });

  it("points at the skill by the name list_packs actually resolves", () => {
    // A pointer to a skill that cannot be loaded is worse than none: the agent is told
    // expertise exists, calls for it, and gets nothing.
    const section = PROMPT_SRC.slice(PROMPT_SRC.indexOf("AUTHORING rgthree TOGGLES"));
    expect(section).toMatch(/skill_read", name:"rgthree"/);
  });
});

describe("the rgthree skill states the facts that were verified against the pack (#1551)", () => {
  it("is bundled at the path the system prompt tells the agent to load", () => {
    // list_packs(action:"skill_read", name:"rgthree") resolves plugin/skills/<name>/SKILL.md.
    expect(existsSync(SKILL_URL)).toBe(true);
  });

  it("is a loadable skill — frontmatter name matches its directory", () => {
    expect(SKILL).toMatch(/^---\nname: rgthree\n/);
    expect(SKILL).toMatch(/\ndescription: .+/);
  });

  it("gives every Fast Groups filter property by its exact source name", () => {
    // Verified in rgthree-comfy/src_web/comfyui/fast_groups_muter.ts (PROPERTY_* consts).
    // A typo'd property name is a silent no-op on the canvas, so these are load-bearing.
    for (const prop of [
      "matchTitle",
      "matchColors",
      "toggleRestriction",
      "sort",
      "customSortAlphabet",
      "showNav",
      "showAllGraphs",
    ]) {
      expect(SKILL).toContain(prop);
    }
  });

  it("gets the Bypasser/Muter mode split the right way round", () => {
    // Bypasser modeOff = 4 (bypass, passthrough); Muter modeOff = LiteGraph.NEVER = 2
    // (mute, kills downstream). Swapping these breaks the chain instead of shortening it.
    expect(SKILL).toMatch(/Bypasser \(rgthree\)` sets the nodes of a group to \*\*bypass\*\* \(mode `4`/);
    expect(SKILL).toMatch(/Muter \(rgthree\)` sets\s+them to \*\*mute\*\* \(mode `2`/);
  });

  it("splits the frontend-only nodes by whether panel_add_node ACCEPTS them", () => {
    // The report claimed panel_add_node adds all of them "(verified)". It does not: the
    // panel exempts a POSITIVE allowlist (FRONTEND_ONLY_NODE_TYPES in the panel repo's
    // web/js/lib/node-resolve.js) and fails CLOSED on everything else. The author had
    // verified one allowlisted node and generalized. Both columns must survive.
    expect(SKILL).toMatch(/`panel_add_node` WORKS/);
    expect(SKILL).toMatch(/`panel_add_node` REFUSES/);
    for (const addable of [
      "Fast Groups Bypasser (rgthree)",
      "Fast Groups Muter (rgthree)",
      "Node Collector (rgthree)",
      "Label (rgthree)",
    ]) {
      expect(SKILL).toContain(addable);
    }
    for (const refused of ["Bookmark (rgthree)", "Mute / Bypass Relay (rgthree)"]) {
      expect(SKILL).toContain(refused);
    }
  });

  it("tells the agent to READ the geometric-membership honesty report", () => {
    // panel_create_group reports extra_node_ids/missing_node_ids + a warning when live
    // membership differs from the requested set. Ignoring it is how a toggle silently
    // disables part of an adjacent stage — the concrete damage in the report.
    expect(SKILL).toContain("extra_node_ids");
    expect(SKILL).toContain("missing_node_ids");
  });

  it("does not claim the stripper dissolves rgthree Context buses", () => {
    // Gate P1. The report said panel_strip_workflow "resolves them when you need the
    // true graph". It does not: Context* are REAL EXECUTABLE backend nodes (they are in
    // rgthree's NODE_CLASS_MAPPINGS), and panel_flatten_workflow's own description says
    // "Real executable nodes (rgthree Context/Context Switch, Seed Everywhere) are KEPT
    // — they run." Only VIRTUAL wiring (Get/Set, Reroute, UE) is resolved. An agent told
    // otherwise waits for a flattening that never happens.
    expect(SKILL).toMatch(/\*\*These are NOT virtual\s+wiring\.\*\*/);
    expect(SKILL).toMatch(/deliberately \*\*keep\*\* them/);
    expect(SKILL).not.toMatch(/`panel_strip_workflow` resolves them/);
  });

  it("warns that a fresh Power Lora Loader has NO lora_N rows to write", () => {
    // Gate P1. addNewLoraWidget runs only from configure() (loading a saved graph) and
    // from the on-canvas "➕ Add Lora" button, which needs a mouse event and a chooser
    // dialog. No panel tool presses it, so the documented write would be the agent's
    // FIRST call after adding a loader — and it fails with `has no widget`.
    expect(SKILL).toMatch(/no `lora_N` widgets at all/);
    expect(SKILL).toMatch(/No panel tool can press it/);
  });

  it("writes a whole row as a JSON STRING, which is what the schema accepts", () => {
    // Gate P1. panel_set_widget's `value` is z.union([string, number, boolean]) — a
    // literal object is rejected by tool-arg validation before any write happens. The
    // panel JSON.parses a string value for a composite widget and merges it, so the
    // JSON-string form is the one that actually works.
    expect(SKILL).toMatch(/JSON\s*\n?\s*object STRING/);
    expect(SKILL).toMatch(/only string\/number\/boolean/);
    // And the example must not hand over a bare object literal.
    expect(SKILL).toMatch(/widget="lora_1", value='\{"on":false,"strength":0\.6\}'/);
  });

  it("does not point the agent at Seed's control_after_generate widget", () => {
    // Gate P1. rgthree's Seed SPLICES control_after_generate out of its widgets in
    // onNodeCreated and drives behaviour through special seed values instead (-1/-2/-3).
    // Naming that widget sends a write at something that does not exist; and claiming
    // the seed is regenerated every run would have an agent discard a user's fixed seed,
    // which main() returns unchanged.
    expect(SKILL).toMatch(/deletes the built-in `control_after_generate` widget/);
    expect(SKILL).toMatch(/`-1` randomize, `-2` increment,\s+`-3` decrement/);
    expect(SKILL).toMatch(/returned \*\*unchanged\*\*/);
  });

  it("does not send the agent to panel_move_group to fix membership", () => {
    // It cannot: move_nodes defaults to true, so the box AND its contents move together
    // and the same nodes stay inside. The panel's own warning names panel_edit_node /
    // panel_auto_layout, which is what the skill must say.
    expect(SKILL).toMatch(/`panel_move_group` does \*\*not\*\* help/);
    expect(SKILL).toMatch(/panel_edit_node/);
  });
});
