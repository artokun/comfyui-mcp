// Aggregate pre-flight health check for a connected ComfyUI instance.
//
// Originally contributed by João Lucas (github.com/joaolvivas) in
// joaolvivas/comfyui-mcp-byjlucas@de82ecda (2026-05-12). Refactored to
// match this repo's service/tool split.

import { ConnectionError } from "../utils/errors.js";
import { isCloudMode } from "../config.js";
import { getQueue, getSystemStats, comfyApiFetch } from "../comfyui/client.js";
import { scrubLogLines } from "../comfyui/json-guard.js";

const CRITICAL_MODEL_CATS = [
  "checkpoints",
  "diffusion_models",
  "loras",
  "vae",
  "text_encoders",
  "controlnet",
] as const;

export interface HealthCheckOptions {
  modelCategories?: string[];
  recentErrors?: number;
}

/**
 * The ComfyUI FRONTEND package version, as reported by /system_stats.
 *
 * ComfyUI gives this two ways and they can disagree, which is itself worth
 * seeing: `comfy_package_versions[comfyui-frontend-package].installed` is what is
 * actually loaded, and `required_frontend_version` is what this ComfyUI asked
 * for. A mismatch means someone pinned or overrode the frontend — exactly the
 * situation in panel#779, where `--front-end-version …@1.47.12` was the fix.
 *
 * Returns "?" when neither is present rather than inventing one. An unknown
 * version must not read as an absent problem.
 */
function describeFrontendVersion(stats: Record<string, any>): string {
  // Both fields live under `system`, verified against a live ComfyUI 0.30.2 —
  // the first draft read them off the top level and silently produced "?" on a
  // server that reports them perfectly well. Top-level is still accepted in case
  // another build puts them there, but `system` is where they actually are.
  const pkgs = Array.isArray(stats?.system?.comfy_package_versions)
    ? stats.system.comfy_package_versions
    : Array.isArray(stats?.comfy_package_versions)
      ? stats.comfy_package_versions
      : [];
  const fe = pkgs.find((p: any) => p?.name === "comfyui-frontend-package");
  const installed = typeof fe?.installed === "string" ? fe.installed : undefined;
  const required =
    typeof stats?.system?.required_frontend_version === "string"
      ? stats.system.required_frontend_version
      : typeof stats?.required_frontend_version === "string"
        ? stats.required_frontend_version
        : undefined;
  if (installed && required && installed !== required) {
    return `${installed} (this ComfyUI expects ${required} — pinned or overridden)`;
  }
  return installed ?? required ?? "?";
}

export async function runHealthCheck(
  options: HealthCheckOptions = {},
): Promise<string> {
  const categories = options.modelCategories ?? [...CRITICAL_MODEL_CATS];
  const recentErrors = options.recentErrors ?? 20;
  const lines: string[] = ["## Health Check\n"];

  try {
    const stats = (await getSystemStats()) as unknown as Record<string, any>;
    const sys = stats.system ?? {};
    const dev = stats.devices?.[0] ?? {};
    const vramTotalGB = dev.vram_total
      ? (dev.vram_total / 1024 ** 3).toFixed(1)
      : "?";
    const vramFreeGB = dev.vram_free
      ? (dev.vram_free / 1024 ** 3).toFixed(1)
      : "?";
    const ramFreeGB = sys.ram_free
      ? (sys.ram_free / 1024 ** 3).toFixed(1)
      : "?";
    lines.push(
      `**ComfyUI**: ${sys.comfyui_version ?? "?"} | ` +
        // panel#779 — the FRONTEND package version, which /system_stats reports and
        // nothing here read. That outage (a blank agent panel on a fresh install)
        // turned entirely on it: ComfyUI 0.30.0 was identical between the broken
        // and working machines, and the frontend was 1.50.3 vs 1.47.12. A reporter
        // had to be asked for it after an hour of eliminating everything else, and
        // "ComfyUI version" alone will keep hiding this class of skew.
        `frontend ${describeFrontendVersion(stats)} | ` +
        `Python ${(sys.python_version ?? "").split(" ")[0] || "?"} | ` +
        `PyTorch ${sys.pytorch_version ?? "?"}`,
    );
    lines.push(
      `**GPU**: ${dev.name ?? "?"} | VRAM free ${vramFreeGB}/${vramTotalGB} GB | RAM free ${ramFreeGB} GB`,
    );
  } catch (err) {
    throw new ConnectionError(
      `ComfyUI unreachable: ${err instanceof Error ? err.message : err}`,
    );
  }

  try {
    const q = await getQueue();
    const running = q.queue_running?.length ?? 0;
    const pending = q.queue_pending?.length ?? 0;
    lines.push(`**Queue**: ${running} running, ${pending} pending`);
  } catch (err) {
    lines.push(
      `**Queue**: ERROR — ${err instanceof Error ? err.message : err}`,
    );
  }

  if (isCloudMode()) {
    // Comfy Cloud has its own model library and no /internal/logs equivalent.
    lines.push(`\n**Models**: managed by Comfy Cloud (not listable from this client)`);
    lines.push(`**Recent errors**: not available in cloud mode`);
    return lines.join("\n");
  }

  const modelLines: string[] = [];
  let totalModelsSeen = 0;
  for (const cat of categories) {
    try {
      const res = await comfyApiFetch(`/models/${cat}`);
      if (!res.ok) {
        modelLines.push(`- ${cat}: REST ${res.status}`);
        continue;
      }
      const files = (await res.json()) as unknown;
      const count = Array.isArray(files) ? files.length : 0;
      totalModelsSeen += count;
      if (count === 0) {
        modelLines.push(
          `- ${cat}: **EMPTY** ⚠️ (check extra_model_paths.yaml)`,
        );
      } else {
        const preview = (files as string[]).slice(0, 3).join(", ");
        const more = count > 3 ? ` (+${count - 3} more)` : "";
        modelLines.push(`- ${cat}: ${count} — ${preview}${more}`);
      }
    } catch (err) {
      modelLines.push(
        `- ${cat}: ERROR — ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  lines.push(`\n**Models** (${totalModelsSeen} total across ${categories.length} categories):`);
  lines.push(...modelLines);

  // Recent custom-node errors from /internal/logs (best-effort; older
  // ComfyUI versions and remote-only deployments may not expose it).
  // #1146 — recent_errors:0 means "show me none", and it returned EVERYTHING.
  //
  // `slice(-0)` is `slice(0)`: -0 === 0 in JS, so the negative-index reading
  // never happens and the whole array comes back. A reporter asking for zero got
  // the full historical ComfyUI log and a response truncated at ~12k tokens —
  // the opposite of the request, from the one argument value meant to suppress
  // it. Any non-positive limit takes the explicit branch instead.
  //
  // And it is reported as NOT REQUESTED, not as "none in /internal/logs". The
  // log was never read for content, so claiming it is clean would assert an
  // absence nobody observed — a caller trying to shrink a response would be told
  // their server is healthy as a side effect of asking for a shorter answer.
  if (recentErrors <= 0) {
    lines.push(`\n**Recent errors**: not requested (recent_errors=${recentErrors}) — the log was NOT checked, which is not the same as it being clean.`);
  } else {
    try {
      const res = await comfyApiFetch("/internal/logs");
      if (res.ok) {
        const text = await res.text();
        // #1206 — these lines go straight into the health report, which is a
        // DIAGNOSTIC users paste into bug reports. A custom node logging the URL
        // it fetched can put a CivitAI/HF token in one, so scrub before emitting.
        // Per line, and fail-closed VISIBLY, for the same reasons as getLogs.
        const errLines = scrubLogLines(
          text
            .split("\n")
            .filter((l) => /traceback|error|exception/i.test(l))
            .slice(-recentErrors),
        );
        if (errLines.length > 0) {
          lines.push(`\n**Recent errors** (last ${errLines.length}):`);
          for (const e of errLines) lines.push(`  ${e.trim()}`);
        } else {
          lines.push(`\n**Recent errors**: none in /internal/logs`);
        }
      }
    } catch {
      // Logs endpoint unavailable — silent.
    }
  }

  return lines.join("\n");
}
