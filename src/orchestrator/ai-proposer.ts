// One-shot AI metadata proposer for Model Explorer's "Ask AI".
//
// Runs a SINGLE Claude Agent-SDK turn (no tools, no session) to distill the raw,
// messy metadata scraped from a .safetensors + Civitai into clean, prompt-ready
// structured fields. It reuses the orchestrator's Claude auth (same as the panel
// chat) — the AI hub — but is a discrete structured call, not the per-tab
// conversational agent (that "shared-context loop" is a larger, later rewrite).
//
// Returns a proposal the user REVIEWS and saves; nothing is written here.
import { loadQuery } from "./claude-backend.js";
import { logger } from "../utils/logger.js";
import { resolvePrompt } from "../services/prompt-overrides.js";
import { buildAgentSpawnEnv } from "../services/panel-secrets.js";

export interface ModelCardEvidence {
  filename: string;
  classify?: Record<string, unknown>;
  model_card?: Record<string, unknown>;
  prompt_director?: Record<string, unknown>;
  modelspec?: Record<string, unknown>;
  tag_frequency_top?: Array<{ token: string; count: number }>;
  description?: string;
  example_prompts?: string[];
}

export const SYSTEM = `You are a metadata curator for AI image/video model files (LoRAs, checkpoints, VAEs, etc.) used in ComfyUI. Given raw, messy metadata scraped from a .safetensors file and Civitai, produce CLEAN, concise, prompt-ready structured metadata.

Rules:
- Output ONLY a single JSON object. No prose, no markdown fences.
- Distill marketing fluff into a tight, factual semantic_intent (1-2 sentences).
- trigger_tokens: the EXACT activation tokens (short), deduped. NEVER invent tokens not evidenced by trained tags / trainedWords / example prompts.
- prompt_guidance: 1-3 practical sentences on how to prompt this model well.
- Suggest default_strength_model / default_strength_clip and a safe strength_min/max ONLY when the evidence supports it (e.g. a weight like <lora:name:0.8> appears in an example prompt). Otherwise OMIT those fields entirely — do not guess.
- tags: short lowercase tags. compatible_families: only if reasonably certain.
- Do NOT fabricate civitai ids, hashes, or any fact not present in the evidence.`;

const SCHEMA_HINT = `Return a JSON object. All fields optional — include ONLY what the evidence supports:
{
  "display_name": string,
  "semantic_intent": string,
  "description_clean": string,
  "prompt_guidance": string,
  "preservation_guidance": string,
  "trigger_tokens": string[],
  "activation_phrases": string[],
  "negative_tokens": string[],
  "default_strength_model": number,
  "default_strength_clip": number,
  "strength_min": number,
  "strength_max": number,
  "tags": string[],
  "compatible_families": string[]
}`;

function buildUserText(ev: ModelCardEvidence): string {
  const parts: string[] = [`FILE: ${ev.filename}`];
  if (ev.classify) parts.push(`CLASSIFY: ${JSON.stringify(ev.classify)}`);
  if (ev.model_card && Object.keys(ev.model_card).length)
    parts.push(`CURRENT model_card: ${JSON.stringify(ev.model_card)}`);
  if (ev.prompt_director && Object.keys(ev.prompt_director).length)
    parts.push(`CURRENT prompt_director: ${JSON.stringify(ev.prompt_director)}`);
  if (ev.modelspec && Object.keys(ev.modelspec).length)
    parts.push(`modelspec (read-only): ${JSON.stringify(ev.modelspec)}`);
  if (ev.tag_frequency_top?.length)
    parts.push(`TOP TRAINING TAGS (freq): ${JSON.stringify(ev.tag_frequency_top)}`);
  if (ev.description)
    parts.push(`CIVITAI DESCRIPTION (may be messy marketing):\n${ev.description.slice(0, 4000)}`);
  if (ev.example_prompts?.length)
    parts.push(`EXAMPLE PROMPTS:\n${ev.example_prompts.slice(0, 5).map((p, i) => `${i + 1}. ${p.slice(0, 500)}`).join("\n")}`);
  parts.push(SCHEMA_HINT, "Return ONLY the JSON object.");
  return parts.join("\n\n");
}

function extractJson(s: string): Record<string, unknown> | null {
  let t = s.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function proposeModelCard(
  ev: ModelCardEvidence,
  model?: string,
): Promise<{ proposal: Record<string, unknown> | null; raw: string }> {
  const query = await loadQuery();
  const q = query({
    prompt: buildUserText(ev),
    options: {
      ...(model ? { model } : {}),
      systemPrompt: resolvePrompt("proposer.modelCard", SYSTEM),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: [],
      strictMcpConfig: true,
      maxTurns: 1,
      // SECURITY: the SDK spawns a Claude Code subprocess; `env` REPLACES its
      // environment entirely. Pass the agent env (process.env MINUS tool-only
      // secrets) so RunPod/HF/CivitAI tokens never reach the LLM subprocess.
      env: buildAgentSpawnEnv(),
    } as unknown as Parameters<typeof query>[0]["options"],
  });

  let text = "";
  let result = "";
  for await (const m of q as AsyncIterable<Record<string, unknown>>) {
    const mm = m as any;
    if (mm?.type === "assistant" && mm.message?.content) {
      for (const b of mm.message.content) if (b?.type === "text" && b.text) text += b.text;
    } else if (mm?.type === "result" && typeof mm.result === "string") {
      result = mm.result;
    }
  }
  const raw = (result || text).trim();
  const proposal = extractJson(raw);
  if (!proposal) logger.warn(`[ai-proposer] no JSON parsed from model reply (${raw.length} chars)`);
  return { proposal, raw };
}
