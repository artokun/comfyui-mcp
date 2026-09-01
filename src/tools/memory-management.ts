import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getSystemStats, comfyApiFetch } from "../comfyui/client.js";
import type { SystemStats } from "../comfyui/types.js";
import { ComfyUIError, errorToToolResult } from "../utils/errors.js";
import { bodyPrefixOf, describeStatus } from "../comfyui/json-guard.js";
import { logger } from "../utils/logger.js";
import {
  settleUntilStable,
  VRAM_OCCUPIED_FREE_RATIO,
  VRAM_OCCUPIED_MIN_TOTAL_BYTES,
} from "../services/vram-settle.js";
import type { SettledRead } from "../services/vram-settle.js";

export {
  VRAM_SETTLE_INTERVAL_MS as CLEAR_VRAM_SETTLE_INTERVAL_MS,
  VRAM_SETTLE_MIN_MS as CLEAR_VRAM_SETTLE_MIN_MS,
  VRAM_SETTLE_TIMEOUT_MS as CLEAR_VRAM_SETTLE_TIMEOUT_MS,
} from "../services/vram-settle.js";

/** The counters `clear_vram` prints — device 0's VRAM + torch pool. */
function vramSignature(stats: SystemStats): string {
  const gpu = stats.devices?.[0];
  if (!gpu) return "";
  return `${gpu.vram_free}:${gpu.torch_vram_free}`;
}

/**
 * The DRIVER counter alone — the one whose release lags (#2704).
 *
 * Deliberately not `vramSignature`: torch gives its pool back in ~400ms while
 * `vram_free` can stay frozen for seconds, so a combined signature moves on
 * torch's schedule and would certify the driver as released while it is still
 * holding ~29 GB. That is the reported bug, and testing movement against the
 * combined signature would reintroduce it.
 */
function vramReleaseSignature(stats: SystemStats): readonly string[] {
  const gpu = stats.devices?.[0];
  if (!gpu) return [""];
  return [`${gpu.vram_free}`];
}

function formatVramStats(stats: SystemStats, settled = true): string {
  const gpu = stats.devices?.[0];
  if (!gpu) return "";
  const vramFreeMB = (gpu.vram_free / 1024 / 1024).toFixed(0);
  const vramTotalMB = (gpu.vram_total / 1024 / 1024).toFixed(0);
  const torchFreeMB = (gpu.torch_vram_free / 1024 / 1024).toFixed(0);
  const torchTotalMB = (gpu.torch_vram_total / 1024 / 1024).toFixed(0);
  // #2704 — the unconfirmed reading is the one that misleads: it UNDERSTATES
  // free VRAM, so it reads as an imminent OOM on a card that is actually empty.
  // Print it (it is the best number we have) but never as a measured result.
  const caveat = settled
    ? ""
    : ` (the card had not finished releasing when this was read — re-check with` +
      ` get_system_stats (action:"stats") before sizing a model load against it)`;
  return `\n\nCurrent VRAM: ${vramFreeMB}/${vramTotalMB} MB free | Torch: ${torchFreeMB}/${torchTotalMB} MB free${caveat}`;
}

/**
 * The signature the post-/free poll must move AWAY from, or null to skip the
 * wait entirely.
 *
 * #2704 — a full unload is only EXPECTED to move the driver's number when the
 * card is actually holding memory. On a card that is already mostly free there
 * is nothing to wait for, and demanding movement that will never come would
 * spend the whole settle cap on the common speculative `clear_vram`. So the
 * wait is armed by the same "occupied" rule the panel applies to these very
 * counters, and an idle card keeps exactly today's fast path.
 *
 * Device 0 only, deliberately: `formatVramStats` prints device 0's counters, so
 * device 0's release is exactly what backs the number being reported. Proving a
 * second card released would not make the printed figure any more true.
 */
function settleBaselineOf(before: SystemStats | null): readonly string[] | null {
  const gpu = before?.devices?.[0];
  if (!gpu) return null;
  const free = gpu.vram_free;
  const total = gpu.vram_total;
  if (!Number.isFinite(free) || !Number.isFinite(total)) return null;
  if (total < VRAM_OCCUPIED_MIN_TOTAL_BYTES) return null;
  if (free > total * VRAM_OCCUPIED_FREE_RATIO) return null;
  return vramReleaseSignature(before as SystemStats);
}

/** Best effort — a baseline we cannot read costs precision, never the clear. */
async function readVramBaseline(): Promise<SystemStats | null> {
  try {
    return await getSystemStats();
  } catch {
    return null;
  }
}

/**
 * /free answers when ComfyUI drops model refs; CUDA/driver release can lag.
 * Poll until the displayed counters stop changing (or we hit the cap) so the
 * printed value matches a follow-up get_system_stats (action:"stats") (#2050).
 *
 * #2704 — "stopped changing" is not on its own evidence of a release, because a
 * release that has not STARTED is equally still. `baseline` is the pre-/free
 * reading the poll must move away from before a plateau counts.
 */
async function readSettledSystemStats(
  before: SystemStats | null,
): Promise<SettledRead<SystemStats>> {
  return settleUntilStable(
    async () => {
      try {
        return await getSystemStats();
      } catch {
        return null;
      }
    },
    vramSignature,
    {
      baseline: settleBaselineOf(before),
      progressOf: vramReleaseSignature,
      // A baseline we could not READ is not the same as a card with nothing to
      // release. Both arrive here without keys to check, but only the second
      // one may be published as a measured figure.
      confirmable: before !== null,
    },
  );
}

export function registerMemoryManagementTools(server: McpServer): void {
  server.tool(
    "clear_vram",
    "Free GPU VRAM by unloading cached models from ComfyUI. Use this between generation runs with different model families (e.g. switching from SDXL to Flux) or when running low on VRAM. Optionally unload only models or only memory.",
    {
      unload_models: z
        .boolean()
        .optional()
        .default(true)
        .describe("Unload all cached models (default: true)"),
      free_memory: z
        .boolean()
        .optional()
        .default(true)
        .describe("Free cached memory/intermediates (default: true)"),
    },
    async (args) => {
      try {
        // Sample BEFORE the mutation (#2704). A baseline taken after /free is
        // useless: on a lagging driver the first post-/free sample IS the stale
        // pre-release value, so it can never show the release landing. Read
        // failures degrade to null, which restores the pre-#2704 behaviour
        // rather than failing the clear.
        const before = await readVramBaseline();

        // ComfyUI's /free endpoint accepts POST with JSON body
        const res = await comfyApiFetch("/free", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            unload_models: args.unload_models,
            free_memory: args.free_memory,
          }),
        });

        if (!res.ok) {
          // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
          // HTTP status is reported either way, so an unreadable body costs detail in the
          // text, never a wrong conclusion. Verified there is no branch on this value.
          //
          // #385 made this branch REACHABLE. A gateway that reflects the request
          // can put our own credential in the body it answers with, so it is
          // scrubbed like every other body this codebase prints (#828).
          const text = await res.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to free VRAM: ${describeStatus(res.status, res.statusText)}${text ? `\n${bodyPrefixOf(text)}` : ""}`,
              },
            ],
          };
        }

        // Get updated stats — after CUDA release settles, not the first post-/free sample.
        let statsText = "";
        try {
          const settledRead = await readSettledSystemStats(before);
          if (settledRead.value) {
            statsText = formatVramStats(settledRead.value, settledRead.settled);
          }
        } catch {
          // Best effort
        }

        const actions: string[] = [];
        if (args.unload_models) actions.push("models unloaded");
        if (args.free_memory) actions.push("memory freed");

        return {
          content: [
            {
              type: "text" as const,
              text: `VRAM cleared successfully (${actions.join(", ")}).${statsText}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

}

/**
 * The embeddings listing, no longer a tool of its own.
 *
 * 0.50.0 slice 11 folded it into `list_local_models` (action:"embeddings") —
 * both read what the connected ComfyUI has installed, so they belong on the same
 * tool. The body is the old handler verbatim: same /api/embeddings read, same
 * rendering, same "No embeddings installed." degradation.
 */
export async function getEmbeddingsAction(): Promise<CallToolResult> {
      try {
        const res = await comfyApiFetch("/api/embeddings");
        // This site had NO status check, because none could ever run — fetchApi
        // threw first (#385). Converting it without adding one would hand a 4xx
        // body to the parser, and a JSON-shaped error envelope parses fine and
        // is not an array — landing on "No embeddings installed." That is the
        // #796 defect exactly: "could not determine" reported as "determined
        // not", and here it would tell a user with a full embeddings folder that
        // they have none. Say what actually happened instead.
        if (!res.ok) {
          throw new ComfyUIError(
            `ComfyUI /api/embeddings answered ${describeStatus(res.status, res.statusText)}, so the installed ` +
              `embeddings could NOT be listed. This is not a report that none are installed — ` +
              `nothing was read. Confirm the server is up and exposes this route with ` +
              `get_system_stats (action:"health").`,
            "HTTP_ERROR",
          );
        }
        const embeddings = (await res.json()) as string[];

        if (!Array.isArray(embeddings) || embeddings.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No embeddings installed.",
              },
            ],
          };
        }

        const lines = embeddings.map((e, i) => `${i + 1}. ${e}`);

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${embeddings.length} embedding(s):\n\n${lines.join("\n")}\n\nUsage in prompts: \`embedding:name\` (e.g. \`embedding:${embeddings[0]}\`)`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
}
