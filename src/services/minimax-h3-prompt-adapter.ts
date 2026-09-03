// #2786 — manga-director-codex MiniMax H3 prompt adapter.
// Native H3 T2V is MiniMaxH3ImageToVideo with both image sockets empty
// (plugin/skills/minimax-h3-video). compile_prompt_package must accept
// model_target.mode=text_to_video when adapter=minimax_h3.

import { readFileSync } from "node:fs";
import { ComfyUIError } from "../utils/errors.js";

export const MINIMAX_H3_ADAPTER_ID = "minimax_h3";

export const MINIMAX_H3_MODES = [
  "text_to_video",
  "image_to_video",
  "first_last_frame",
  "last_frame_to_video",
  "reference_to_video",
] as const;

export type MiniMaxH3Mode = (typeof MINIMAX_H3_MODES)[number];

export interface MiniMaxH3PromptAdapter {
  adapter: typeof MINIMAX_H3_ADAPTER_ID;
  adapter_version: string;
  supported_modes: MiniMaxH3Mode[];
}

export interface MiniMaxH3PromptSpec {
  prompt_id: string;
  model_target: {
    adapter: string;
    mode: string;
  };
}

export interface MiniMaxH3CompilePass {
  ok: true;
  generation: 0;
  adapter: typeof MINIMAX_H3_ADAPTER_ID;
  prompt_id: string;
}

export const MINIMAX_H3_ADAPTER_URL = new URL(
  "../../plugin/skills/minimax-h3-video/prompt_adapters/minimax_h3.json",
  import.meta.url,
);

export function isMiniMaxH3Mode(value: string): value is MiniMaxH3Mode {
  for (const mode of MINIMAX_H3_MODES) {
    if (mode === value) return true;
  }
  return false;
}

function isModeList(value: unknown): value is MiniMaxH3Mode[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !isMiniMaxH3Mode(item) || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

export function parseMiniMaxH3Adapter(raw: string): MiniMaxH3PromptAdapter {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ComfyUIError(
      "minimax_h3 adapter JSON is not parseable",
      "BLOCKED_PROMPT_ADAPTER_MISMATCH",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ComfyUIError(
      "minimax_h3 adapter JSON is not an object",
      "BLOCKED_PROMPT_ADAPTER_MISMATCH",
    );
  }
  const rec = parsed;
  const adapter = "adapter" in rec ? rec.adapter : undefined;
  const adapter_version = "adapter_version" in rec ? rec.adapter_version : undefined;
  const supported_modes = "supported_modes" in rec ? rec.supported_modes : undefined;
  if (
    adapter !== MINIMAX_H3_ADAPTER_ID ||
    typeof adapter_version !== "string" ||
    adapter_version.length === 0 ||
    !isModeList(supported_modes)
  ) {
    throw new ComfyUIError(
      "minimax_h3 adapter JSON is missing adapter, adapter_version, or supported_modes",
      "BLOCKED_PROMPT_ADAPTER_MISMATCH",
    );
  }
  return { adapter, adapter_version, supported_modes };
}

export function readBundledMiniMaxH3Adapter(): MiniMaxH3PromptAdapter {
  return parseMiniMaxH3Adapter(readFileSync(MINIMAX_H3_ADAPTER_URL, "utf8"));
}

function promptSpecOf(value: unknown): MiniMaxH3PromptSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ComfyUIError(
      "prompt spec is not an object",
      "BLOCKED_PROMPT_ADAPTER_MISMATCH",
    );
  }
  const rec = value;
  const prompt_id = "prompt_id" in rec ? rec.prompt_id : undefined;
  const model_target = "model_target" in rec ? rec.model_target : undefined;
  if (typeof prompt_id !== "string" || prompt_id.length === 0) {
    throw new ComfyUIError("prompt spec is missing prompt_id", "BLOCKED_PROMPT_ADAPTER_MISMATCH");
  }
  if (typeof model_target !== "object" || model_target === null || Array.isArray(model_target)) {
    throw new ComfyUIError(
      "prompt spec is missing model_target",
      "BLOCKED_PROMPT_ADAPTER_MISMATCH",
    );
  }
  const adapter = "adapter" in model_target ? model_target.adapter : undefined;
  const mode = "mode" in model_target ? model_target.mode : undefined;
  if (
    typeof adapter !== "string" ||
    adapter.length === 0 ||
    typeof mode !== "string" ||
    mode.length === 0
  ) {
    throw new ComfyUIError(
      "prompt spec model_target needs adapter and mode",
      "BLOCKED_PROMPT_ADAPTER_MISMATCH",
    );
  }
  return { prompt_id, model_target: { adapter, mode } };
}

export function adapterDeclaresMode(
  adapter: MiniMaxH3PromptAdapter,
  mode: string,
): mode is MiniMaxH3Mode {
  return adapter.supported_modes.some((declared) => declared === mode);
}

export function compilePromptPackage(
  spec: unknown,
  adapter: MiniMaxH3PromptAdapter = readBundledMiniMaxH3Adapter(),
): MiniMaxH3CompilePass {
  const prompt = promptSpecOf(spec);
  const { adapter: adapterId, mode } = prompt.model_target;
  if (adapterId !== adapter.adapter || !adapterDeclaresMode(adapter, mode)) {
    throw new ComfyUIError(
      `BLOCKED_PROMPT_ADAPTER_MISMATCH: ${adapterId} does not declare mode ${mode}`,
      "BLOCKED_PROMPT_ADAPTER_MISMATCH",
    );
  }
  return {
    ok: true,
    generation: 0,
    adapter: adapter.adapter,
    prompt_id: prompt.prompt_id,
  };
}

export function formatCompilePass(result: MiniMaxH3CompilePass): string {
  return (
    `PASS: prompt compiled with generation=${result.generation} ` +
    `adapter=${result.adapter} prompt_id=${result.prompt_id}`
  );
}
