// LLM captioning for dataset images — one vision turn per image through the
// user's OWN Claude subscription (the same Agent SDK the panel agent uses),
// NOT a paid API. Deliberately a direct `query()` call, not the panel's
// ClaudeBackend: the panel persona/session machinery would bleed chat-flavored
// prose into what must be a bare caption string.
//
// Images come from readTrainingFile (contained to the training root, ≤2MB) so
// dataset files never touch the /view channel.

import { assertDatasetEditable, getDataset, updateDataset } from "./training-datasets.js";
import { buildAgentSpawnEnv } from "./panel-secrets.js";
import { trainingRoot } from "./training-jobs.js";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

/** Captioning reads staged TRAINING images, not phone-bound display thumbs —
 *  the 2MB action:"file" cap is a display budget, not a property of the data
 *  (codex finding: a valid 8MP training PNG must still caption). 10MB keeps
 *  the vision context sane without rejecting real sets. Contained + image-only
 *  like readTrainingFile. */
const MAX_CAPTION_BYTES = 10 * 1024 * 1024;
const CAPTION_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function readCaptionFile(absPath: string): { data: string; mimeType: string } {
  let p: string;
  try {
    p = realpathSync(absPath);
  } catch {
    p = resolve(absPath);
  }
  const root = realpathSync(trainingRoot());
  const norm = (x: string) => (process.platform === "win32" ? x.toLowerCase() : x);
  if (norm(p) !== norm(root) && !norm(p).startsWith(norm(root) + sep)) {
    throw new Error("path escapes the training root");
  }
  const ext = extname(p).toLowerCase();
  if (!CAPTION_IMAGE_EXTS.has(ext)) {
    throw new Error(`only image files can be captioned (${[...CAPTION_IMAGE_EXTS].join("/")})`);
  }
  const st = statSync(p);
  if (st.size > MAX_CAPTION_BYTES) {
    throw new Error(`image too large to caption (${(st.size / 1024 / 1024).toFixed(1)} MB > 10 MB)`);
  }
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { data: readFileSync(p).toString("base64"), mimeType };
}

// Lazy SDK import (same pattern as claude-backend — the SDK is a heavy optional
// dependency that must not load at MCP boot).
let queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query | null = null;
async function getQuery() {
  if (!queryFn) {
    const mod = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = mod.query;
  }
  return queryFn;
}

/** Model used for captioning — cheap and fast by default (this is a bulk
 *  utility call on the user's subscription). Override via COMFYUI_MCP_CAPTION_MODEL. */
const CAPTION_MODEL = process.env.COMFYUI_MCP_CAPTION_MODEL?.trim() || "claude-haiku-4-5";

/** A PERSISTENT failure that dooms every remaining image — a missing/invalid
 *  Claude Code login, or a backend that can't run vision captioning at all.
 *  captionDataset bails the batch on the first one instead of re-hitting the
 *  same auth wall 32 times (issue #438: the panel backend was Codex, so every
 *  image returned "Not logged in — Please run /login"). */
export class CaptionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionAuthError";
  }
}

/** Does this SDK error text mean "no usable Claude Code credentials", i.e. a
 *  failure that will repeat identically for every image? Matches the Agent
 *  SDK's not-logged-in / invalid-key / auth phrasings. */
function isAuthFailureText(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("not logged in") ||
    t.includes("/login") ||
    t.includes("please run /login") ||
    t.includes("invalid api key") ||
    t.includes("invalid x-api-key") ||
    t.includes("authentication_error") ||
    t.includes("authentication error") ||
    t.includes("oauth token has expired") ||
    t.includes("unauthorized") ||
    (t.includes("credit balance") && t.includes("too low"))
  );
}

function captionPrompt(opts: { guide?: string; trigger?: string }): string {
  const lines = [
    "Write ONE caption for this image for LoRA training. Rules:",
    "- Describe what CHANGES between training images: pose, clothing, background, lighting, expression, framing — NOT the subject's identity (the model learns that from the set, not the captions).",
    "- One or two short comma-separated phrases. No prefix, no quotes, no commentary.",
  ];
  if (opts.trigger) lines.push(`- Start the caption EXACTLY with "${opts.trigger}, " (the set's trigger word).`);
  if (opts.guide) lines.push(`- User guidance: ${opts.guide}`);
  lines.push("Reply with ONLY the caption.");
  return lines.join("\n");
}

/** Caption ONE image (path under the training root). Returns the bare caption. */
export async function captionImage(opts: {
  imagePath: string;
  guide?: string;
  trigger?: string;
}): Promise<string> {
  const { data, mimeType } = readCaptionFile(opts.imagePath);
  const query = await getQuery();
  const userContent = [
    {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        data,
      },
    },
    { type: "text" as const, text: captionPrompt(opts) },
  ];
  async function* turns() {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: userContent },
      parent_tool_use_id: null,
    };
  }
  // No tools, single turn — a utility call, not an agent session. The spawn
  // env is SCRUBBED of tool-only secrets (RunPod/CivitAI/HF keys) — the
  // caption subprocess has no business seeing them (codex finding; same
  // invariant as ClaudeBackend/ai-proposer).
  const q = query({
    prompt: turns(),
    options: { model: CAPTION_MODEL, maxTurns: 1, tools: [], env: buildAgentSpawnEnv() } as never,
  });
  let text = "";
  for await (const msg of q) {
    const m = msg as {
      type: string;
      subtype?: string;
      is_error?: boolean;
      // Agent SDK 0.3.x contract: an ERROR result (SDKResultError, subtype
      // `error_during_execution` etc.) carries its text in `errors: string[]`
      // and has NO `result` field. Only a SUCCESS result (SDKResultSuccess)
      // has `result: string`. Reading the wrong field is how the auth message
      // was being lost (issue #438 codex round 1).
      errors?: string[];
      result?: string;
      message?: { content?: Array<{ type: string; text?: string }> };
    };
    if (m.type === "assistant" && m.message?.content) {
      text += m.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    } else if (m.type === "result" && (m.is_error || (m.subtype && m.subtype !== "success"))) {
      // The SDK reports a failed run (e.g. "Not logged in — Please run /login")
      // as an error `result` message, NOT a thrown exception — previously this
      // was silently dropped and every image failed with the generic "empty
      // caption" message. Pull the text from `errors[]` (the error variant's
      // field), and flag auth failures so the batch bails.
      const detail =
        (Array.isArray(m.errors) ? m.errors.join("; ") : "").trim() ||
        (m.result ?? "").trim() ||
        `caption run failed (${m.subtype ?? "error"})`;
      if (isAuthFailureText(detail)) {
        // #2849 — the panel BUILDS this server's environment from its own secret
        // allowlist (and the orchestrator unsets ANTHROPIC_API_KEY outright for the
        // subscription lane), so a key exported in the user's shell never arrives
        // here. Naming it as the remedy sends an already-blocked user to a setting
        // that cannot take effect. Standalone — this server run from the user's own
        // MCP client — DOES inherit the shell env, and there the advice is correct;
        // COMFYUI_MCP_TAB is the lane marker the orchestrator stamps per spawn.
        const panelLane = Boolean(process.env.COMFYUI_MCP_TAB?.trim());
        const remedy = panelLane
          ? "Run `claude /login` in a TERMINAL, then retry — this server's environment is " +
            "built by the panel, so an API key exported in your shell never reaches it. "
          : "Run `claude /login`, or set ANTHROPIC_API_KEY, then retry. ";
        throw new CaptionAuthError(
          `Claude captioning is unavailable — the Claude Code session is not authenticated ` +
            `(SDK said: ${detail}). ` +
            remedy +
            `Captioning always runs through Claude regardless of the panel's active backend.`,
        );
      }
      throw new Error(detail);
    }
  }
  const caption = text.trim().replace(/^["']|["']$/g, "");
  if (!caption) throw new Error("the model returned an empty caption");
  return caption;
}

export interface CaptionDatasetResult {
  captioned: number;
  failed: Array<{ file: string; error: string }>;
}

/** Caption a whole staged dataset (or a subset) and WRITE the captions into
 *  its .txt files. Sequential on purpose — a subscription isn't a rate pool. */
export async function captionDataset(
  name: string,
  opts: { guide?: string; trigger?: string; only?: string[] } = {},
): Promise<CaptionDatasetResult> {
  const detail = getDataset(name);
  // In-use check BEFORE spending subscription turns: a dataset a running job
  // trains from would reject every write anyway (codex finding — the loop
  // used to spend one vision turn per image and write zero captions).
  await assertDatasetEditable(detail.datasetPath, "captioning");
  const only = opts.only?.length ? new Set(opts.only) : null;
  const targets = detail.items.filter((it) => !only || only.has(it.file));
  if (!targets.length) throw new Error(only ? "none of the requested files are in this dataset" : "dataset has no images");
  const failed: CaptionDatasetResult["failed"] = [];
  let captioned = 0;
  for (const it of targets) {
    try {
      const caption = await captionImage({
        imagePath: `${detail.datasetPath}/${it.file}`,
        guide: opts.guide,
        trigger: opts.trigger,
      });
      await updateDataset(name, { setCaptions: { [it.file]: caption } });
      captioned++;
    } catch (err) {
      // A PERSISTENT auth/credential failure dooms every remaining image — the
      // whole batch runs on one Claude session (issue #438). Fail fast with an
      // actionable error instead of iterating N files re-hitting the same wall.
      // Per-file transient errors (bad image, empty caption, write conflict)
      // still just get recorded and the loop continues.
      if (
        err instanceof CaptionAuthError ||
        (err instanceof Error && isAuthFailureText(err.message))
      ) {
        const message = err instanceof CaptionAuthError ? err.message : (err as Error).message;
        throw new CaptionAuthError(message);
      }
      failed.push({ file: it.file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { captioned, failed };
}
