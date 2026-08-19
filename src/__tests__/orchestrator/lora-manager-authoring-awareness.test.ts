// #1708 — LoRA Manager's autocomplete loader is a recurring agent-failure mode, and
// BOTH halves of the steering are inert data no behavioural test can see:
//
//   * a bundled SKILL.md is unused by any import, so deleting it keeps every suite
//     green while the knowledge silently stops shipping; and
//   * the system-prompt paragraph is one string literal in index.ts — delete it and
//     the orchestrator still builds, still spawns, still passes.
//
// So both are asserted at their SOURCE, on the claims verified against LoRA Manager
// 1.2.1 (py/nodes/lora_loader.py) and the panel's add-node guard.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import { buildPanelToolDefs } from "../../orchestrator/panel-tools.js";

const PROMPT_SRC = readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf-8");
const SKILL_URL = new URL("../../../plugin/skills/lora-manager/SKILL.md", import.meta.url);
const SKILL = existsSync(SKILL_URL)
  ? readFileSync(SKILL_URL, "utf-8").replace(/^﻿/, "").replace(/\r\n/g, "\n")
  : "";

describe("the system prompt steers LoRA Manager autocomplete adds (#1708)", () => {
  it("carries the LoRA Manager section", () => {
    expect(PROMPT_SRC).toMatch(/LORA MANAGER AUTOCOMPLETE NODES/);
  });

  it("names the STRING-socket loader, not a reload", () => {
    const section = PROMPT_SRC.slice(PROMPT_SRC.indexOf("LORA MANAGER AUTOCOMPLETE NODES"));
    expect(section).toContain("LoRA Text Loader (LoraManager)");
    expect(section).toMatch(/reload, panel_refresh_nodes, and retry will keep failing/);
    expect(section).toContain("Lora Loader (LoraManager)");
  });

  it("points at the skill by the name list_packs actually resolves", () => {
    const section = PROMPT_SRC.slice(PROMPT_SRC.indexOf("LORA MANAGER AUTOCOMPLETE NODES"));
    expect(section).toMatch(/skill_read", name:"lora-manager"/);
  });
});

describe("the lora-manager skill states the verified add split (#1708)", () => {
  it("is bundled at the path the system prompt tells the agent to load", () => {
    expect(existsSync(SKILL_URL)).toBe(true);
  });

  it("is a loadable skill — frontmatter name matches its directory", () => {
    expect(SKILL).toMatch(/^---\nname: lora-manager\n/);
    expect(SKILL).toMatch(/\ndescription: .+/);
  });

  it("splits addable vs refused LoRA Manager class_types by their real names", () => {
    expect(SKILL).toContain("LoRA Text Loader (LoraManager)");
    expect(SKILL).toContain("Lora Loader (LoraManager)");
    expect(SKILL).toContain("Lora Stacker (LoraManager)");
    expect(SKILL).toMatch(/`lora_syntax` is a \*\*STRING socket\*\*/);
  });

  it("does not send the agent back to reload or retry the autocomplete loader", () => {
    expect(SKILL).toMatch(/Reload, `panel_refresh_nodes`, and retry\s+\*\*cannot\*\* clear it/);
    expect(SKILL).toMatch(/Do \*\*not\*\* add\s+`Lora Loader \(LoraManager\)`/);
  });
});

describe("panel_add_node's description names the working LoRA Manager class (#1708)", () => {
  it("tells the agent to add LoRA Text Loader, not to reload", () => {
    const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
    if (!def) throw new Error("panel_add_node is not registered");
    expect(def.description).toContain("LoRA Text Loader (LoraManager)");
    expect(def.description).toContain("Lora Loader (LoraManager)");
    expect(def.description).toMatch(/reload\/retry will not clear it/);
  });
});
