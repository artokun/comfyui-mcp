import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { getObjectInfo, getSystemStats } from "../comfyui/client.js";
import { searchCivitaiModels } from "../services/civitai-resolver.js";
import { searchHuggingFaceModels } from "../services/model-resolver.js";
import {
  findMissingModels,
  resolveCandidatesDetailed,
  type ModelCandidate,
  type ObjectInfoLike,
  type ResolveDeps,
} from "../services/missing-models.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { config } from "../config.js";

function parseWorkflow(input: unknown): WorkflowJSON {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ValidationError("Workflow JSON must be an object with node IDs as keys");
      }
      return parsed as WorkflowJSON;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Invalid JSON string: ${(err as Error).message}`);
    }
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as WorkflowJSON;
  }
  throw new ValidationError("Workflow must be a JSON string or object");
}

/** Weight files worth offering; skip READMEs, configs, previews. */
const WEIGHT_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i;

/**
 * List a HuggingFace repo's weight files WITH sizes. HF search returns REPOS,
 * not files, so without this expansion a candidate has no size, no precision and
 * no fit verdict — i.e. none of what makes the list useful on a small GPU.
 *
 * Must be `/tree/main`: the plain `/api/models/{id}` response carries
 * `siblings[].rfilename` but NO size, and `?blobs=true` 400s. Verified live.
 * The repo id is `org/name` — its slash is part of the PATH, so it must not be
 * percent-encoded (encoding the whole id yields a 404).
 */
async function hfRepoFiles(repoId: string): Promise<Array<{ filename: string; size_bytes?: number }>> {
  const path = repoId.split("/").map(encodeURIComponent).join("/");
  // Captured ONCE: the credential getters resolve from the canonical store on
  // every access, so testing one read and interpolating another can send a
  // different token — or `Bearer undefined` — if the store is rewritten in
  // between (codex gate, round 6, finding 3).
  const hfToken = config.huggingfaceToken;
  const res = await fetch(`https://huggingface.co/api/models/${path}/tree/main`, {
    // config.huggingfaceToken resolves at ACCESS time from the canonical
    // ~/.comfyui-mcp/.env and honours the HUGGINGFACE_TOKEN alias too (#826):
    // reading process.env.HF_TOKEN directly made a token saved after this
    // process started invisible here, while the save reported live pickup.
    headers: hfToken ? { authorization: `Bearer ${hfToken}` } : undefined,
    // Third-party API: bound the wait (same class as #1026).
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as Array<{ type?: string; path?: string; size?: number }>;
  if (!Array.isArray(body)) return [];
  return body
    .filter((e) => e.type === "file" && typeof e.path === "string" && WEIGHT_RE.test(e.path))
    .map((e) => ({ filename: e.path as string, size_bytes: typeof e.size === "number" ? e.size : undefined }));
}

function liveDeps(): ResolveDeps {
  return {
    searchCivitai: async (query, types) => {
      const res = await searchCivitaiModels(query, { types, limit: 6 });
      return res.hits.map((h) => ({
        name: h.name,
        model_id: h.model_id,
        version_id: h.version_id,
        size_mb: h.size_mb,
        base_model: h.base_model,
      }));
    },
    searchHf: async (query) => (await searchHuggingFaceModels(query, { limit: 4 })).map((m) => ({ id: m.id })),
    hfRepoFiles,
    vramBytes: async () => {
      const stats = await getSystemStats();
      const vram = stats.devices?.[0]?.vram_total;
      return typeof vram === "number" && vram > 0 ? vram : undefined;
    },
  };
}

function human(bytes?: number): string {
  if (!bytes || bytes <= 0) return "?";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

const FIT_ICON: Record<string, string> = { fits: "✓ fits", tight: "~ tight", too_big: "✗ won't fit", unknown: "? unknown" };

function renderCandidate(c: ModelCandidate): string {
  const bits = [
    `- **${c.filename}**`,
    `${human(c.size_bytes)}`,
    c.precision === "unknown" ? "" : c.quant ? `${c.precision.toUpperCase()} ${c.quant}` : c.precision.toUpperCase(),
    c.source,
    FIT_ICON[c.fit ?? "unknown"] ?? "",
    c.base_model ? `base: ${c.base_model}` : "",
    c.match === "exact" ? "**exact name**" : c.match === "stem" ? "same name, different format" : "",
  ].filter(Boolean);
  let line = bits.join("  ·  ");
  if (c.requires_pack) line += `\n    ⚠️ needs the **${c.requires_pack}** node pack — a GGUF will NOT load in CheckpointLoaderSimple.`;
  if (c.url) line += `\n    ${c.url}`;
  else if (c.civitai_model_id) line += `\n    civitai model ${c.civitai_model_id}${c.civitai_version_id ? ` (version ${c.civitai_version_id})` : ""} → download_model action:"download_civitai"`;
  return line;
}

/**
 * The missing-model resolver, no longer a tool of its own.
 *
 * 0.50.0 slice 11 folded it into `download_model` (action:"resolve_missing");
 * see ./model-management.ts for the dispatcher. The body below is the old
 * handler verbatim — same object-info read, same candidate lookup, same
 * "could not look" vs "nothing exists" distinction (#796).
 */
export async function resolveMissingModelsAction(args: {
  workflow: string | Record<string, unknown>;
  limit?: number;
}): Promise<CallToolResult> {
      try {
        const workflow = parseWorkflow(args.workflow);
        const objectInfo: ObjectInfoLike = await getObjectInfo();
        const missing = findMissingModels(workflow as Record<string, unknown>, objectInfo);

        if (missing.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "## No missing models\n\nEvery model this workflow references is present on the connected ComfyUI. (If it still fails to run, check missing custom node packs with list_packs (action:\"extract_deps\").)",
              },
            ],
          };
        }

        const deps = liveDeps();
        const lines: string[] = [`## ${missing.length} missing model(s)`, ""];

        for (const m of missing) {
          lines.push(
            `### \`${m.name}\``,
            `needed by node ${m.node_id} (${m.node_type} · ${m.widget})${m.directory ? ` → installs to \`models/${m.directory}/\`` : ""}`,
            "",
          );
          const lookup = await resolveCandidatesDetailed(m, deps, { limit: args.limit ?? 8 }).catch(
            (err) => ({
              candidates: [],
              failedProviders: [
                `the candidate lookup itself (${err instanceof Error ? err.message : String(err)})`,
              ],
            }),
          );
          if (lookup.candidates.length === 0) {
            lines.push(
              lookup.failedProviders.length > 0
                ? `_No candidates — but the lookup FAILED (${lookup.failedProviders.join("; ")}), so ` +
                  `this is "could not look", NOT "nothing exists". Check the network/provider and retry, ` +
                  `or try download_model action:"search" / action:"search_civitai" with a different query._`
                : `_No candidates found on CivitAI or HuggingFace — try download_model action:"search" / action:"search_civitai" with a different query._`,
              "",
            );
            continue;
          }
          if (lookup.failedProviders.length > 0) {
            lines.push(
              `_(Partial results — the ${lookup.failedProviders.join("; ")} lookup failed; other sources may have more.)_`,
              "",
            );
          }
          lines.push(...lookup.candidates.map(renderCandidate), "");
        }

        lines.push(
          "---",
          "Nothing was downloaded. Pick a candidate and call **download_model** with " +
            '`action:"download"` (url) or `action:"download_civitai"` (id)' +
            ", passing the model's directory as `target_subfolder`.",
          "Names can collide across quantisations and base models — prefer an **exact name** match, and check `base:` before taking a fuzzy one.",
        );

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
}
