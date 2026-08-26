// Aggregate pre-flight health check for a connected ComfyUI instance.
//
// Originally contributed by João Lucas (github.com/joaolvivas) in
// joaolvivas/comfyui-mcp-byjlucas@de82ecda (2026-05-12). Refactored to
// match this repo's service/tool split.

import { ConnectionError } from "../utils/errors.js";
import { isCloudMode } from "../config.js";
import { getQueue, getSystemStats, comfyApiFetch } from "../comfyui/client.js";
import type { SystemStats } from "../comfyui/types.js";
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
    const stats = await getSystemStats({ diagnosticContext: "health" });
    const sys: Partial<SystemStats["system"]> = stats.system ?? {};
    const dev: Partial<SystemStats["devices"][number]> = stats.devices?.[0] ?? {};
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
        const rawText = await res.text();
        // /internal/logs returns a JSON-wrapped string. Parse it to get the actual logs.
        let text: string;
        try {
          const parsed = JSON.parse(rawText);
          // Ensure the parsed value is a string, not an object or other type
          text = typeof parsed === "string" ? parsed : rawText;
        } catch {
          // If not JSON, use the raw text
          text = rawText;
        }

        // #1206 — these lines go straight into the health report, which is a
        // DIAGNOSTIC users paste into bug reports. A custom node logging the URL
        // it fetched can put a CivitAI/HF token in one, so scrub before emitting.
        // Per line, and fail-closed VISIBLY, for the same reasons as getLogs.
        //
        // #2329 — match severity on the line itself, not a bare substring. A log
        // line containing "error" in a message like "0 errors found" is not an
        // actual error. Only lines with [ERROR]/[EXCEPTION] markers or starting
        // with "Traceback" are errors. Keep traceback continuation lines (indented).
        // #2347 — severity is matched on the entry BODY, after the timestamp prefix.
        // /internal/logs joins each record as `l["t"] + " - " + l["m"]`
        // (api_server/routes/internal/internal_routes.py), so every line begins with a
        // timestamp. #2329 matched `^Traceback` against the raw line, which therefore
        // could never fire: measured on a live 105-line log, 0 lines start with
        // "Traceback".
        //
        // #2355 — ColoredFormatter prepends ANSI-wrapped `[LEVEL]` tags before the
        // message, even when given ColoredFormatter("%(message)s"). After stripping
        // the timestamp, the body still begins with `\x1b[1m\x1b[31m[ERROR]\x1b[0m `,
        // so anchored patterns like `^!!!` or `^Traceback` need the ANSI escapes
        // stripped first. The ColoredFormatter output has ANSI codes immediately after
        // the timestamp prefix: `\x1b[...m[LEVEL]\x1b[0m message`.
        //
        // Stripping ANSI leaves the [LEVEL] marker intact so existing patterns like
        // `/[ERROR]/` continue to work. The anchored patterns need to account for
        // the optional [LEVEL] tag that may precede them.
        const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
        const bodyOf = (line: string): string => {
          // Strip timestamp prefix and ANSI escape sequences
          let body = line.replace(/^\S+ - /, "");
          body = stripAnsi(body);
          return body;
        };

        // What stock ComfyUI actually emits. #2329 keyed on `[ERROR]`/`[EXCEPTION]`,
        // which its in-memory handler never writes — app/logger.py formats the memory
        // handler with ColoredFormatter("%(message)s"), message only. The bracketed
        // forms come from ComfyUI-Manager printing its own prefix, which is why a live
        // test appeared to pass: it was reading Manager lines, not ComfyUI ones.
        //
        // The consequence was worse than the blob it replaced: execution.py's
        // "!!! Exception during processing !!!", the traceback that follows it, and
        // "Got an OOM, unloading all loaded models." were all invisible, so a crashed
        // render reported byte-identically to a healthy server in the diagnostic users
        // paste into bug reports.
        //
        // #2355 — after stripping ANSI codes (which ColoredFormatter wraps around
        // [LEVEL] tags), the body may be `[ERROR] !!! Exception...` instead of
        // `!!! Exception...`. Patterns must account for this optional [LEVEL] prefix.
        const ERROR_HEADERS: readonly RegExp[] = [
          /^(?:\[(?:ERROR|WARNING|INFO|DEBUG|CRITICAL|EXCEPTION)\]\s*)?!!!\s*Exception during processing/i,   // execution.py render failure, possibly with [LEVEL]
          /^(?:\[(?:ERROR|WARNING|INFO|DEBUG|CRITICAL|EXCEPTION)\]\s*)?Traceback\s*\(/i,                       // traceback header, possibly with [LEVEL]
          /\[ERROR\]|\[EXCEPTION\]/i,               // ComfyUI-Manager / file handler
        ];
        const ERROR_SIGNALS: readonly RegExp[] = [
          ...ERROR_HEADERS,
          /^(?:\[(?:ERROR|WARNING|INFO|DEBUG|CRITICAL|EXCEPTION)\]\s*)?[A-Za-z0-9_.]*(Error|Exception)\s*:/,          // exception tail, possibly with [LEVEL]
          /\bGot an OOM\b/i,                        // model_management OOM notice
          /\bAllocation on device\b/i,              // torch allocator OOM
          /\bCUDA out of memory\b/i,
          /\b(ERROR|EXCEPTION)\s*:/,                // an explicit level prefix
        ];
        const isHeader = (body: string): boolean => ERROR_HEADERS.some((re) => re.test(body));
        const isSignal = (body: string): boolean => ERROR_SIGNALS.some((re) => re.test(body));

        const allLines = text.split("\n");
        const bodies = allLines.map(bodyOf);
        const errorGroups: string[][] = [];
        const processed = new Set<number>();

        for (let i = 0; i < allLines.length; i++) {
          if (processed.has(i) || !isSignal(bodies[i])) continue;

          // Walk BACKWARDS to the header this line belongs to. #2329 only extended
          // forwards, so matching an exception TAIL ("RuntimeError: ...") dropped every
          // frame above it and the "!!! Exception during processing !!!" header with
          // them — the caller saw the exception name and nothing that located it.
          let first = i;
          if (!isHeader(bodies[i])) {
            for (let j = i - 1; j >= 0 && i - j <= 200; j--) {
              if (processed.has(j)) break;
              const b = bodies[j];
              if (isHeader(b)) { first = j; break; }
              // Frames are indented; anything else ends the traceback above us.
              if (!/^[ \t]/.test(b) && b.trim() !== "") break;
            }
          }

          const group: string[] = [];
          for (let k = first; k <= i; k++) { group.push(allLines[k]); processed.add(k); }

          // Then forwards through the frames and the exception tail below.
          for (let j = i + 1; j < allLines.length; j++) {
            const b = bodies[j];
            if (isHeader(b)) break;
            if (/^[ \t]/.test(b) || b.trim() === "") { group.push(allLines[j]); processed.add(j); continue; }
            // A bare exception tail closes the traceback it belongs to; take it and stop.
            // The tail may be prefixed with a [LEVEL] tag from ColoredFormatter.
            if (/^(?:\[(?:ERROR|WARNING|INFO|DEBUG|CRITICAL|EXCEPTION)\]\s*)?[A-Za-z0-9_.]*(Error|Exception)\s*:/.test(b)) {
              group.push(allLines[j]); processed.add(j);
            }
            break;
          }
          errorGroups.push(group);
        }
        // Take the last N error groups, then flatten them into lines for scrubbing
        const recentErrorGroups = errorGroups.slice(-recentErrors);
        const errorLines = recentErrorGroups.flat();
        // Strip ANSI escape sequences before scrubbing secrets, so the patterns used
        // by scrubSecretShapedText don't get confused by control bytes.
        const ansiStripped = errorLines.map((line) => stripAnsi(line));
        const errLines = scrubLogLines(ansiStripped);
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
