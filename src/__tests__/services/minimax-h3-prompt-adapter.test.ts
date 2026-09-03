// #2786 — manga-director-codex MiniMax H3 adapter omitted text_to_video from
// supported_modes, so compile_prompt_package refused a valid local H3 T2V spec.
// Native T2V is MiniMaxH3ImageToVideo with both image sockets empty.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ComfyUIError } from "../../utils/errors.js";
import {
  MINIMAX_H3_ADAPTER_ID,
  MINIMAX_H3_MODES,
  adapterDeclaresMode,
  compilePromptPackage,
  formatCompilePass,
  parseMiniMaxH3Adapter,
  readBundledMiniMaxH3Adapter,
  type MiniMaxH3PromptAdapter,
} from "../../services/minimax-h3-prompt-adapter.js";

const SKILL_URL = new URL("../../../plugin/skills/minimax-h3-video/SKILL.md", import.meta.url);
const ADAPTER_URL = new URL(
  "../../../plugin/skills/minimax-h3-video/prompt_adapters/minimax_h3.json",
  import.meta.url,
);

const SKILL = readFileSync(SKILL_URL, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

function spec(mode: string, adapter = MINIMAX_H3_ADAPTER_ID) {
  return {
    prompt_id: "VIDEO-CAL-PB01-H3-T2V-TEST-V1",
    model_target: { adapter, mode },
  };
}

function withoutMode(adapter: MiniMaxH3PromptAdapter, mode: string): MiniMaxH3PromptAdapter {
  return {
    ...adapter,
    supported_modes: adapter.supported_modes.filter((declared) => declared !== mode),
  };
}

describe("#2786 manga-director-codex MiniMax H3 adapter accepts text_to_video", () => {
  const bundled = readBundledMiniMaxH3Adapter();

  it("ships adapter_version 1.0.2 at the bundled prompt_adapters path", () => {
    const fromDisk = parseMiniMaxH3Adapter(readFileSync(ADAPTER_URL, "utf8"));
    expect(fromDisk).toEqual(bundled);
    expect(bundled.adapter).toBe("minimax_h3");
    expect(bundled.adapter_version).toBe("1.0.2");
  });

  it("declares every MiniMax H3 mode, including documented text_to_video", () => {
    expect(bundled.supported_modes).toEqual([...MINIMAX_H3_MODES]);
    expect(adapterDeclaresMode(bundled, "text_to_video")).toBe(true);
  });

  it("compiles a valid text_to_video prompt spec", () => {
    const result = compilePromptPackage(spec("text_to_video"));
    expect(formatCompilePass(result)).toBe(
      "PASS: prompt compiled with generation=0 adapter=minimax_h3 prompt_id=VIDEO-CAL-PB01-H3-T2V-TEST-V1",
    );
  });

  it("still compiles the other MiniMax H3 modes", () => {
    for (const mode of MINIMAX_H3_MODES) {
      if (mode === "text_to_video") continue;
      const result = compilePromptPackage(spec(mode), bundled);
      expect(result).toEqual({
        ok: true,
        generation: 0,
        adapter: "minimax_h3",
        prompt_id: "VIDEO-CAL-PB01-H3-T2V-TEST-V1",
      });
    }
  });

  it("rejects text_to_video when the adapter omits it — the #2786 regression", () => {
    const omitted = withoutMode(bundled, "text_to_video");
    expect(adapterDeclaresMode(omitted, "text_to_video")).toBe(false);
    try {
      compilePromptPackage(spec("text_to_video"), omitted);
      throw new Error("compile should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ComfyUIError);
      if (!(err instanceof ComfyUIError)) throw err;
      expect(err.code).toBe("BLOCKED_PROMPT_ADAPTER_MISMATCH");
      expect(err.message).toBe(
        "BLOCKED_PROMPT_ADAPTER_MISMATCH: minimax_h3 does not declare mode text_to_video",
      );
    }
  });

  it("still rejects a mode the adapter does not declare", () => {
    expect(() => compilePromptPackage(spec("wan_flf"), bundled)).toThrow(
      /BLOCKED_PROMPT_ADAPTER_MISMATCH: minimax_h3 does not declare mode wan_flf/,
    );
  });

  it("keeps the skill's native T2V contract next to the adapter mode name", () => {
    expect(SKILL).toContain("MiniMaxH3ImageToVideo");
    expect(SKILL).toMatch(/both image sockets are empty/);
    expect(SKILL).toContain("text_to_video");
    expect(SKILL).toContain("prompt_adapters/minimax_h3.json");
  });
});
