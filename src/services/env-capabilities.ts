// Live ENVIRONMENT-CAPABILITIES probe for the panel orchestrator.
//
// Gathered ONCE at orchestrator startup (or lazily on the first tab) and CACHED,
// then prepended as a compact one-line block to the panel agent's system prompt
// so the agent is immediately aware of the machine — no probing, no guessing.
//
// Every probe is best-effort and time-bounded: a hung ComfyUI, a slow PowerShell,
// or a missing python must NEVER stall session start. Each field degrades to
// "unknown" (and is simply omitted from the rendered block) on any failure.
//
// Split into:
//   - gatherEnvCapabilities(opts): does all the I/O (fetch /system_stats, probe
//     triton/sageattention, resolve backends) with hard timeouts.
//   - formatEnvBlock(caps): a PURE function (stats object → compact string) that
//     is unit-tested and omits unknown fields cleanly.

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { platform, release, totalmem, cpus } from "node:os";
import { isForceRemoteFlagSet } from "../config.js";
import { resolveComfyuiPython, pythonVersionsAgree } from "./workspace-env.js";
import { resolveLiveInterpreter } from "./live-interpreter.js";
import { parsePyproject } from "./node-authoring.js";
import { detectInstallMode } from "./self-update.js";
import { logger } from "../utils/logger.js";

// The interpreter resolver lives in workspace-env (which owns ComfyUI-base
// resolution) so the environment read and this panel probe share ONE live-first
// implementation and can never disagree (#401 / PR #433). Re-export for
// back-compat with existing importers/tests.
export { resolveComfyuiPython };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriState = "installed" | "not-installed" | "unknown";

/** The structured capabilities snapshot. All fields optional — anything we
 *  couldn't determine is left undefined and omitted from the rendered block. */
export interface EnvCapabilities {
  os?: string; // e.g. "Windows 11", "macOS 14", "Linux"
  cpu?: string; // model string, trimmed
  ramGb?: number; // total RAM, GiB (rounded)
  gpu?: string; // primary GPU model name
  vramTotalGb?: number; // primary GPU total VRAM, GiB (rounded)
  vramFreeGb?: number; // primary GPU free VRAM, GiB (rounded)
  cuda?: string; // CUDA version, e.g. "13.0"
  torch?: string; // torch version, e.g. "2.10.0" (cu suffix stripped)
  python?: string; // python version, e.g. "3.13"
  comfyui?: string; // ComfyUI version
  location?: "LOCAL" | "REMOTE"; // from COMFYUI_URL host
  /** ComfyUI-Manager API generation: "v4" (pip comfyui_manager ≥4.x, full
   *  feature set) or "legacy" (released 3.x — partial features). */
  manager?: "v4" | "legacy" | "unknown";
  triton?: TriState;
  sageattention?: TriState;
  backend?: string; // active provider (human label, e.g. "Claude" / "Grok" / "unknown")
  otherBackendAvailable?: boolean; // is the OTHER provider resolvable?
  /**
   * The comfyui-mcp version this process is actually RUNNING, e.g. "0.48.4" — read
   * from the package.json beside the `dist/` these modules were loaded from, at
   * MODULE LOAD (the closest observable moment to "the build that was loaded"; the
   * caller supplies it, see MCP_VERSION_RUNNING). A running process cannot hot-swap
   * its own code, so this stays true for its whole life; `mcpVersionInstalled` is
   * the one that moves.
   */
  mcpVersion?: string;
  /**
   * The comfyui-mcp version installed ON DISK right now, re-read at each refresh.
   *
   * #846: only `mcpVersion` was ever carried, so the ENV line reported a version
   * captured once at orchestrator startup as though it were still the current state
   * of the machine. After an in-place upgrade the two diverge, and BOTH readings are
   * separately true — the process really is running the old build, and the newer one
   * really is installed. Reporting either alone is what misleads: a bug filed from
   * that session gets version-pinned to a build nobody is running, and triage chases
   * it against the wrong code.
   *
   * Carried so the line can DISCLOSE the drift instead of picking a side. Equal to
   * `mcpVersion` in the ordinary case, where nothing is rendered.
   */
  mcpVersionInstalled?: string;
  panelVersion?: string; // sidebar panel version from the panel's hello, e.g. "0.11.3" / "nightly"
}

// Shape of the bits of /system_stats we read (mirrors the environment read).
interface SystemStatsLike {
  system?: {
    os?: string;
    python_version?: string;
    comfyui_version?: string;
    // Newer ComfyUI reports these; tolerated when absent.
    pytorch_version?: string;
    argv?: string[];
    cwd?: string;
    embedded_python?: boolean;
  };
  devices?: Array<{
    name?: string;
    type?: string;
    vram_total?: number;
    vram_free?: number;
  }>;
}

const IS_WIN = platform() === "win32";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Wrap a promise with a timeout; resolves to `undefined` (never rejects) on
 *  timeout or error, so a single slow probe can't hang session start. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T | undefined>([
      // unknown-ok: undefined IS the unknown value for this helper by design — the
      // timeout branch below resolves to exactly the same thing, and every caller
      // treats it as "this probe did not answer".
      p.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function bytesToGb(bytes: number | undefined): number | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  return Math.round(bytes / (1024 * 1024 * 1024));
}

/** Map node's os.platform()/release() to a friendly OS string. Best-effort:
 *  Windows 11 is detected from the NT build (>= 22000), else "Windows 10". */
function friendlyOs(): string {
  const p = platform();
  if (p === "win32") {
    const build = Number(release().split(".")[2] ?? "0");
    return build >= 22000 ? "Windows 11" : "Windows 10";
  }
  if (p === "darwin") return "macOS";
  if (p === "linux") return "Linux";
  return p;
}

/** Prefer the OS string ComfyUI itself reports (more specific), else node's. */
function pickOs(statsOs: string | undefined): string {
  if (statsOs && statsOs.trim()) {
    const s = statsOs.trim();
    // ComfyUI reports things like "nt", "posix", "Windows" — normalize the bland
    // ones back to the friendly node-derived label.
    if (/^(nt|posix|windows|win32)$/i.test(s)) return friendlyOs();
    return s;
  }
  return friendlyOs();
}

/** Tidy ComfyUI's verbose device name into just the model. It reports e.g.
 *  "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync" — strip the "cuda:N "
 *  prefix and the " : <allocator>" suffix. Best-effort; unrecognized shapes pass
 *  through trimmed. */
function cleanGpuName(name: string): string {
  return name
    .trim()
    .replace(/^(?:cuda|cpu|mps|xpu|hip|rocm):\d+\s+/i, "")
    .replace(/\s*:\s*\w+(?:malloc\w*|MallocAsync)?\s*$/i, "")
    .trim();
}

/** Strip the local build suffix from a torch version (2.10.0+cu130 → 2.10.0). */
function cleanTorch(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = v.match(/^([\d.]+)/);
  return m ? m[1] : v;
}

/** Shorten a python version to major.minor (3.13.12 → 3.13). */
function shortPython(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = v.replace(/^Python\s+/i, "").match(/^(\d+\.\d+)/);
  return m ? m[1] : v;
}

/** Probe which ComfyUI-Manager API generation the target serves — /v2/manager/*
 *  is the v4 lineage; released 3.x answers only on /manager/*. Best-effort. */
async function probeManagerGeneration(
  comfyuiUrl: string,
  timeoutMs: number,
): Promise<"v4" | "legacy" | "unknown"> {
  const probe = async (path: string): Promise<boolean> => {
    try {
      const res = await comfyuiFetch(new URL(path, comfyuiUrl), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  };
  if (await probe("/v2/manager/queue/status")) return "v4";
  if (await probe("/manager/queue/status")) return "legacy";
  return "unknown";
}

/** Is the COMFYUI_URL host loopback? → LOCAL, else REMOTE. Unknown URL → LOCAL
 *  (the panel's overwhelming default; never block on an unparseable URL).
 *  --force-remote overrides this, keeping it in sync with isRemoteMode(). */
/** The host of a ComfyUI base URL, or undefined. */
function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** The TCP port of a ComfyUI base URL (defaulting by scheme), or undefined. */
function portFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

function classifyLocation(url: string | undefined): "LOCAL" | "REMOTE" {
  if (!url) return "LOCAL";
  if (isForceRemoteFlagSet()) return "REMOTE";
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0") {
      return "LOCAL";
    }
    return "REMOTE";
  } catch {
    return "LOCAL";
  }
}

// ---------------------------------------------------------------------------
// /system_stats fetch (direct HTTP — no client dependency, mirrors the environment read)
// ---------------------------------------------------------------------------

async function fetchSystemStats(
  comfyuiUrl: string,
  timeoutMs: number,
): Promise<SystemStatsLike | undefined> {
  const base = comfyuiUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await comfyuiFetch(`${base}/system_stats`, { signal: controller.signal });
    if (!res.ok) return undefined;
    return (await res.json()) as SystemStatsLike;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** True when a /system_stats payload actually reports a GPU device (a non-CPU
 *  entry). ComfyUI can answer /system_stats during cold start BEFORE its CUDA
 *  device list is populated, so the first response may carry system info but no
 *  GPU — which would leave GPU/VRAM blank in the env block. */
function hasGpuDevice(stats: SystemStatsLike | undefined): boolean {
  const devices = Array.isArray(stats?.devices) ? stats!.devices! : [];
  return devices.some((d) => (d.type ?? "").toLowerCase() !== "cpu");
}

/**
 * Fetch /system_stats with a BOUNDED retry so GPU/VRAM reliably populate even
 * when ComfyUI is still coming up: retry a few times (short backoff) while the
 * fetch fails OR returns no GPU device, then return the best result we got (never
 * discarded just because the GPU wasn't ready — os/python/torch still populate).
 * Every attempt is individually time-bounded (via withTimeout) and the whole loop
 * is bounded by attempts*(timeout+slack) + (attempts-1)*backoff, so session start
 * stays time-bounded and can NEVER hang. In the common case (a warm local ComfyUI)
 * the first attempt returns a GPU immediately and no retry happens.
 */
async function fetchSystemStatsWithRetry(
  comfyuiUrl: string,
  timeoutMs: number,
  attempts = 3,
  backoffMs = 300,
): Promise<SystemStatsLike | undefined> {
  let best: SystemStatsLike | undefined;
  for (let i = 0; i < attempts; i++) {
    const stats = await withTimeout(fetchSystemStats(comfyuiUrl, timeoutMs), timeoutMs + 500);
    if (stats) {
      best = stats;
      if (hasGpuDevice(stats)) return stats; // GPU present → done, no more retries
    }
    // Fetch failed, or answered without a GPU device yet (cold start) — brief
    // backoff, then retry (skip the wait after the final attempt).
    if (i < attempts - 1) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, backoffMs);
        t.unref?.();
      });
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Triton / SageAttention detection from the ComfyUI LOG (authoritative for the
// HOST — local OR a remote pod). The python import-probe below reaches only the
// ORCHESTRATOR's machine; in REMOTE mode COMFYUI_PATH is unset, so it can't see
// what a remote ComfyUI has. But ComfyUI logs what it's ACTUALLY using at startup
// ("Using sage attention", "Enabling comfy-kitchen triton backend"), so a positive
// log marker is ground truth wherever ComfyUI runs. We only read a POSITIVE signal
// (absence isn't proof of not-installed). This is what the agent needs to pick
// host-correct node settings (attention mode / precision / torch.compile).
// ---------------------------------------------------------------------------

async function detectAttentionFromComfyLog(
  comfyuiUrl: string,
  timeoutMs: number,
): Promise<{ triton?: TriState; sageattention?: TriState }> {
  const base = comfyuiUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(`${base}/internal/logs`, { signal: controller.signal });
    if (!res.ok) return {};
    const data = (await res.json()) as unknown;
    // /internal/logs returns { entries: [{ t, m }] } (m = message) on recent
    // ComfyUI; tolerate a raw string / other shapes defensively.
    const entries = (data as { entries?: unknown[] })?.entries;
    const text = Array.isArray(entries)
      ? entries
          .map((e) => (typeof e === "string" ? e : ((e as { m?: string })?.m ?? "")))
          .join("\n")
      : typeof data === "string"
        ? data
        : JSON.stringify(data);
    const out: { triton?: TriState; sageattention?: TriState } = {};
    if (/Using sage attention/i.test(text)) out.sageattention = "installed";
    if (/Enabling comfy-kitchen triton backend|Found triton \d/i.test(text))
      out.triton = "installed";
    return out;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Triton + SageAttention detection (find the ComfyUI python, then import-probe)
// ---------------------------------------------------------------------------

/**
 * Back-compat shim: returns just the interpreter path (LIVE-first resolution lives
 * in workspace-env.resolveComfyuiPython). Prefer resolveComfyuiPython when the caller
 * needs to know whether the interpreter is the LIVE server's own (issue #401).
 */
export function findComfyuiPython(
  comfyuiPath: string | undefined,
  statsArgv: string[] | undefined,
): string | undefined {
  return resolveComfyuiPython(comfyuiPath, statsArgv).python;
}

/**
 * Probe whether triton + sageattention are importable in the ComfyUI python.
 * Best-effort, hard ~5s timeout. Returns one tri-state per package:
 *   installed | not-installed | unknown
 * "unknown" when we couldn't run python at all (no interpreter / spawn error /
 * timeout) — we don't want to claim "not installed" when we simply couldn't ask.
 */
export function probeTritonSage(
  pythonExe: string | undefined,
  timeoutMs = 5000,
): Promise<{ triton: TriState; sageattention: TriState; pythonVersion?: string }> {
  return new Promise((resolve) => {
    if (!pythonExe) {
      resolve({ triton: "unknown", sageattention: "unknown" });
      return;
    }
    // Print a clear per-package marker so we can tell which imported, even if one
    // succeeds and the other fails (avoids an all-or-nothing answer). Also print
    // the interpreter's own major.minor so the caller can confirm we probed the
    // SAME python the running ComfyUI reports (#401 — a mismatch means we're
    // looking at the wrong environment and any negative is untrustworthy).
    // Print the FULL `sys.version` banner (single line) — the same string
    // /system_stats reports — so the caller can spot a build/compiler disagreement,
    // not just a major.minor one (#401 review).
    const code =
      "import importlib.util as u,sys;" +
      "print('python', ' '.join(sys.version.split()));" +
      "print('triton', u.find_spec('triton') is not None);" +
      "print('sageattention', u.find_spec('sageattention') is not None)";
    let done = false;
    const child = execFile(
      pythonExe,
      ["-c", code],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (done) return;
        done = true;
        // Spawn failure (ENOENT) or non-import error with no output → unknown.
        const out = (stdout || "").toString();
        if (!out.trim()) {
          resolve({ triton: "unknown", sageattention: "unknown" });
          return;
        }
        const read = (name: string): TriState => {
          const m = out.match(new RegExp(`^${name}\\s+(True|False)`, "m"));
          if (!m) return "unknown";
          return m[1] === "True" ? "installed" : "not-installed";
        };
        const pyMatch = out.match(/^python\s+(.+)$/m);
        // If python ran but errored AFTER printing partial output, still trust
        // whatever lines we got; missing lines stay "unknown".
        void err;
        resolve({
          triton: read("triton"),
          sageattention: read("sageattention"),
          pythonVersion: pyMatch ? pyMatch[1].trim() : undefined,
        });
      },
    );
    child.on?.("error", () => {
      if (done) return;
      done = true;
      resolve({ triton: "unknown", sageattention: "unknown" });
    });
  });
}

/**
 * Packages the RUNNING server's own launch flags PROVE are importable in whatever
 * environment it is actually using (#401 recurrence, 0.49.4).
 *
 * This is an observation, not an inference. ComfyUI does not merely *prefer* these
 * backends — it calls `exit(-1)` during startup when the flag is given and the module
 * cannot be imported (`comfy/ldm/modules/attention.py`: "To use the
 * `--use-sage-attention` feature, the `sageattention` package must be installed
 * first."). So a server that is UP, answering `/system_stats`, and reporting the flag in
 * its OWN `sys.argv` has already demonstrated the import succeeded. `argv` here is the
 * server's self-report, which is exactly the right question — "what is the process that
 * answered me running with?" — not a layout guess.
 *
 * Only flags with that hard fail-fast contract belong here. A flag that merely enables an
 * optional path would make this fabricate a positive.
 */
const ARGV_PROVEN_PACKAGES: ReadonlyArray<{
  pkg: "triton" | "sageattention";
  flag: string;
}> = [{ pkg: "sageattention", flag: "--use-sage-attention" }];

/**
 * Which of the packages we report are proven present by the running server's argv.
 *
 * EXACT token match only — the RAW argv string, not a trimmed or lower-cased version of
 * it. `sys.argv` is what argparse itself parsed: `" --use-sage-attention "` and
 * `"--USE-SAGE-ATTENTION"` are tokens ComfyUI did NOT recognise as the flag, so the
 * server did not enable the backend and nothing was proven. Normalising them here would
 * manufacture the positive out of a token that had no effect.
 *
 * Earlier versions also split on `=` to accept `--flag=value`; that spelling cannot occur
 * for an argparse `store_true` flag, so the leniency bought nothing and only widened what
 * could be mistaken for the flag. This function's whole job is to assert a POSITIVE, and
 * a fabricated positive reads to an agent as "the acceleration is there" — the exact
 * false report in the other direction from the one #401 is about.
 */
export function packagesProvenByServerArgv(
  argv: string[] | undefined,
): Set<"triton" | "sageattention"> {
  const proven = new Set<"triton" | "sageattention">();
  if (!Array.isArray(argv)) return proven;
  const tokens = argv.filter((t): t is string => typeof t === "string");
  for (const { pkg, flag } of ARGV_PROVEN_PACKAGES) {
    if (tokens.includes(flag)) proven.add(pkg);
  }
  return proven;
}

/**
 * Did the interpreter we probed CONTRADICT something the running server proved?
 *
 * Returns the name of the first contradicted package, or undefined. A contradiction is
 * decisive evidence about the SOURCE, not just about that one datum: an interpreter that
 * reports "sageattention is absent" for a server that could not have started without
 * sageattention is provably not the environment the server imports from, so every
 * negative it produced is worthless — including the ones nothing happens to contradict.
 *
 * This is the hole the 0.49.4 recurrence fell through. The previous guard cross-checked
 * the probe's python version against `/system_stats`, but a venv reports the SAME
 * `sys.version` as the base interpreter it was created from — by construction. So the
 * version check can never separate a venv from its base, which is precisely the confusion
 * that produces a wrong-environment probe, and "versions agree" was read as corroboration
 * when it carried no information at all.
 */
export function contradictedPackage(
  probe: { triton: TriState; sageattention: TriState } | undefined,
  proven: Set<"triton" | "sageattention">,
): "triton" | "sageattention" | undefined {
  if (!probe) return undefined;
  for (const pkg of proven) {
    if (probe[pkg] === "not-installed") return pkg;
  }
  return undefined;
}

/**
 * Reconcile a raw import-probe tri-state against how much we trust the interpreter
 * we probed (#401). A definitive "not-installed" is only believable when we probed
 * ComfyUI's OWN python — i.e. the LIVE interpreter resolved from the running server's
 * argv root, whose major.minor also matches what /system_stats reports. When the
 * interpreter is NOT the live one (a bare PATH fallback, or a different/persisted
 * workspace) or its version disagrees with the running ComfyUI, we are looking at the
 * wrong environment, so a "not-installed" is downgraded to "unknown" rather than
 * emitted as a false negative that would make an agent disable working acceleration.
 * Positives pass through unchanged (a positive can't be a harmful false negative).
 */
export function reconcileProbeState(
  state: TriState | undefined,
  opts: {
    /** We OBSERVED which interpreter the server runs (we launched it, or the OS told
     *  us) — see live-interpreter.ts. Layout inference does NOT count. */
    observed: boolean;
    runningPython?: string;
    probePython?: string;
  },
): TriState {
  const s = state ?? "unknown";
  // Compares the FULL `sys.version` banner when both sides carry one (build date and
  // compiler included), degrading to the dotted version at whatever precision both
  // supply. A CONTRADICTION check only — cloned venvs report identical banners.
  const versionMismatch = !!(
    opts.runningPython &&
    opts.probePython &&
    !pythonVersionsAgree(opts.runningPython, opts.probePython)
  );
  // Only an OBSERVED interpreter may state a negative. Nothing inferred from install
  // layout qualifies, however plausible: a sole .venv under the server's own root, a
  // matching python, a matching torch build — all of those are satisfied by a sibling
  // environment that is not the one ComfyUI is running, and a wrong guess is exactly
  // what produced the false "Triton: not installed" that made an agent strip working
  // acceleration (#401). Everything else degrades to "unknown".
  //
  // The asymmetry is deliberate: positives ALWAYS pass through. A package we can see
  // installed is really installed, whichever environment we happened to look at.
  const trustworthy = opts.observed && !versionMismatch;
  return s === "not-installed" && !trustworthy ? "unknown" : s;
}

// ---------------------------------------------------------------------------
// Backend availability (active provider + whether the OTHER is resolvable)
// ---------------------------------------------------------------------------

/** Can a module be resolved from this package's perspective? Best-effort. */
function canResolve(specifier: string): boolean {
  try {
    const require = createRequire(import.meta.url);
    require.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * Human labels for every panel backend id (PANEL_AGENT_BACKEND / per-tab
 * selection). The env block reports the ACTUAL active provider for the turn — an
 * unrecognized id degrades to "unknown" rather than being silently mislabeled as
 * "Claude" (#358: a Grok turn must NOT say "Backend: Claude"). Keep in sync with
 * the BackendId union in orchestrator/agent-backend.ts.
 */
export const BACKEND_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  antigravity: "Antigravity",
  pi: "Pi",
  grok: "Grok",
  glm: "GLM",
  kimi: "Kimi",
  moonshot: "Kimi K3 (Moonshot)",
  minimax: "MiniMax",
  ollama: "Ollama",
  openrouter: "OpenRouter",
  copilot: "Copilot",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  custom: "Custom endpoint",
};

/**
 * Determine the active backend label and whether ANY other provider is available.
 * activeBackendId is a PANEL_AGENT_BACKEND / per-tab backend id (e.g. "claude",
 * "codex", "gemini", "grok", "ollama"…). An unknown id resolves to "unknown" so
 * the env block never reports a WRONG specific provider (#358).
 */
export function resolveBackends(activeBackendId: string): {
  backend: string;
  otherBackendAvailable: boolean;
} {
  const id = activeBackendId.toLowerCase();
  const claudeAvailable = canResolve("@anthropic-ai/claude-agent-sdk");
  // Codex can be the @openai/codex package OR a `codex` CLI on PATH; Gemini the
  // @google/gemini-cli package OR a `gemini` CLI on PATH. Resolving the package is
  // the cheap, synchronous signal we use here (a PATH-only CLI reads as absent).
  const codexAvailable = canResolve("@openai/codex");
  const geminiAvailable = canResolve("@google/gemini-cli");
  // Own-property lookup ONLY — a plain-object index would resolve inherited keys
  // like "constructor"/"__proto__" to prototype members (a function/object),
  // wrongly labeling those ids instead of degrading to "unknown".
  const backend = Object.hasOwn(BACKEND_LABELS, id) ? BACKEND_LABELS[id] : "unknown";
  // "Other available" = one of the three SDK/CLI-resolvable providers OTHER than
  // the active one is present. (A cheap synchronous signal; the full provider set
  // is larger, but these three are the ones we can detect without I/O.)
  const otherBackendAvailable =
    (claudeAvailable && id !== "claude") ||
    (codexAvailable && id !== "codex") ||
    (geminiAvailable && id !== "gemini");
  return { backend, otherBackendAvailable };
}

// ---------------------------------------------------------------------------
// gather — orchestrate the probes (cached by the caller)
// ---------------------------------------------------------------------------

export interface GatherOptions {
  comfyuiUrl?: string;
  comfyuiPath?: string;
  /** "claude" | "codex" — the active PANEL_AGENT_BACKEND. */
  backendId?: string;
  /** comfyui-mcp package version this process is RUNNING (caller supplies; kept out
   *  of this module). */
  mcpVersion?: string;
  /**
   * Read the comfyui-mcp version currently INSTALLED on disk (#846). Injectable
   * for tests; defaults to the live package read.
   *
   * This is GATHERED here rather than supplied by the caller, and that placement
   * is the fix. `mcpVersion` is the caller's own build — a constant for the life
   * of its process — so it is passed in. The installed version is a fact about the
   * MACHINE that can change while we run, which makes it a probe like every other
   * one in this module, refreshed on every gather by construction. The bug was a
   * caller reading it ONCE at startup beside the version it was legitimately
   * caching; there is now no place left to cache it by accident.
   */
  readInstalledMcpVersion?: () => string | undefined;
  /** Sidebar panel version, learned from the panel's `hello` frame. */
  panelVersion?: string;
  /** Port the connected ComfyUI listens on — used to find the server PROCESS and read
   *  the interpreter it is actually running (#401). Defaults to the port in
   *  `comfyuiUrl`, which is the live target and may change at runtime. */
  port?: number;
  /** Override probe timeouts (tests). */
  statsTimeoutMs?: number;
  tritonTimeoutMs?: number;
}

// The panel's known custom_nodes dir names (registry unpack vs repo name), kept
// in sync with panel-installer's FAST_PATH_DIRS.
const PANEL_DIR_NAMES = ["comfyui-mcp-panel", "comfyui-agent-panel"] as const;
// pyproject `[project].name` — the AUTHORITATIVE panel identity (a dir may be
// squatted; the project name is not). Mirrors panel-installer's PANEL_REGISTRY_ID.
const PANEL_PROJECT_NAME = "comfyui-agent-panel";

/**
 * Fallback panel version from DISK. The panel version normally rides the panel's
 * `hello`, but a stale (browser-cached) panel — one loaded before the panel began
 * advertising its version — omits it, leaving the agent's ENV line `panel=?` and
 * bug reports unable to version-match the panel. Read the INSTALLED panel's
 * version from its `pyproject.toml` under ComfyUI's custom_nodes.
 *
 * Parsing is delegated to the shipped `parsePyproject` (the same minimal reader
 * that gates panel install/reinstall) so there is ONE pyproject convention, not
 * two. We only accept a version whose `[project].name` is authoritatively the
 * panel's — a non-panel pyproject squatting a known dir name yields undefined,
 * never a wrong version. Best-effort: returns undefined on any failure, never
 * throws.
 */
export function readInstalledPanelVersion(comfyuiPath?: string): string | undefined {
  if (!comfyuiPath) return undefined;
  for (const name of PANEL_DIR_NAMES) {
    try {
      const toml = readFileSync(
        join(comfyuiPath, "custom_nodes", name, "pyproject.toml"),
        "utf8",
      );
      const parsed = parsePyproject(toml);
      if (parsed.projectName === PANEL_PROJECT_NAME && parsed.version) return parsed.version;
    } catch {
      /* try the next known dir name */
    }
  }
  return undefined;
}

/**
 * The comfyui-mcp version INSTALLED on disk right now (#846) — undefined when it
 * cannot be read.
 *
 * Distinct from the version the calling process is RUNNING, which cannot change
 * while it runs (a Node process cannot hot-swap its own code) and is therefore
 * passed in. After an in-place upgrade the two diverge, and reporting only the
 * cached one described a moment that had passed.
 */
export function readInstalledMcpVersion(): string | undefined {
  try {
    return detectInstallMode().currentVersion ?? undefined;
  } catch {
    return undefined;
  }
}

export async function gatherEnvCapabilities(opts: GatherOptions): Promise<EnvCapabilities> {
  const caps: EnvCapabilities = {};

  // --- our own build versions (caller-supplied; panel version rides the hello) ---
  caps.mcpVersion = opts.mcpVersion;
  // Re-read EVERY gather (#846). Guarded: a failed read must leave the line saying
  // nothing about drift, never invent a mismatch out of a missing reading.
  try {
    caps.mcpVersionInstalled = (opts.readInstalledMcpVersion ?? readInstalledMcpVersion)();
  } catch {
    caps.mcpVersionInstalled = undefined;
  }
  // Prefer the live hello's panel version; fall back to the INSTALLED panel's
  // pyproject version so a stale (cached) panel that omits it from the hello
  // still gets the agent's ENV line stamped (report_issue can version-match).
  caps.panelVersion = opts.panelVersion ?? readInstalledPanelVersion(opts.comfyuiPath);

  // --- cheap, synchronous local machine facts (node os) ---
  caps.os = friendlyOs();
  try {
    const cpuList = cpus();
    if (cpuList.length && cpuList[0]?.model) caps.cpu = cpuList[0].model.trim();
  } catch {
    /* leave cpu unknown */
  }
  caps.ramGb = bytesToGb(totalmem());
  caps.location = classifyLocation(opts.comfyuiUrl);

  // --- backends (synchronous module resolution) ---
  const { backend, otherBackendAvailable } = resolveBackends(opts.backendId ?? "claude");
  caps.backend = backend;
  caps.otherBackendAvailable = otherBackendAvailable;

  // --- /system_stats (GPU/VRAM/CUDA/torch/python/comfyui versions) ---
  const stats = opts.comfyuiUrl
    ? await fetchSystemStatsWithRetry(opts.comfyuiUrl, opts.statsTimeoutMs ?? 4000)
    : undefined;

  let statsArgv: string[] | undefined;
  let statsCwd: string | undefined;
  let statsEmbedded: boolean | undefined;
  // RAW sys.version banner — caps.python is truncated to major.minor for DISPLAY, so
  // the contradiction check needs the untruncated string (#401 review).
  let statsPythonRaw: string | undefined;
  if (stats) {
    applyStats(caps, stats);
    statsArgv = stats.system?.argv;
    statsCwd = stats.system?.cwd;
    statsPythonRaw = stats.system?.python_version?.trim() || undefined;
    statsEmbedded =
      typeof stats.system?.embedded_python === "boolean"
        ? stats.system.embedded_python
        : undefined;
  }

  // --- ComfyUI-Manager API generation (v4 vs released 3.x) ---
  if (opts.comfyuiUrl) {
    caps.manager = await withTimeout(
      probeManagerGeneration(opts.comfyuiUrl, opts.statsTimeoutMs ?? 4000),
      (opts.statsTimeoutMs ?? 4000) + 1000,
    ).then((m) => m ?? "unknown");
  }

  // --- triton + sageattention (resolve the LIVE python, import-probe, ~5s cap) ---
  // In REMOTE mode the local python-import probe can't reach the server's host, and a
  // coincident LOCAL path is NOT the remote interpreter — probing it risks BOTH a
  // false negative and a false positive for the remote server. So skip the probe
  // entirely and rely solely on the ComfyUI-log positive markers below (#401 round 3).
  const remote = caps.location === "REMOTE";
  let observed = false;
  let ts: Awaited<ReturnType<typeof probeTritonSage>> | undefined;
  if (!remote) {
    // GROUND TRUTH first (we launched it / the OS says so); otherwise probe the layout
    // GUESS, whose positives are still real but whose negatives can never stand.
    const live = resolveLiveInterpreter({
      port: opts.port ?? portFromUrl(opts.comfyuiUrl) ?? 8188,
      host: hostFromUrl(opts.comfyuiUrl),
      remote,
      serverArgv: statsArgv,
    });
    observed = !!live;
    const python =
      live?.python ??
      resolveComfyuiPython(opts.comfyuiPath, statsArgv, {
        cwd: statsCwd,
        remote,
        embeddedPython: statsEmbedded,
      }).python;
    const tritonTimeout = opts.tritonTimeoutMs ?? 5000;
    ts = await withTimeout(probeTritonSage(python, tritonTimeout), tritonTimeout + 1000);
  }

  // A definitive "not-installed" requires that we OBSERVED which interpreter the
  // server runs (we launched it, or the OS told us) AND that it does not contradict
  // the running instance's python. Everything else — a bare PATH fallback, a
  // different workspace, a Desktop bundle whose layout we merely guessed at, or a
  // REMOTE server we cannot observe at all — degrades to "unknown" rather than emit
  // the false negative that made an agent disable working acceleration (#401).
  // A positive ("installed") always passes through: it can't be a harmful false
  // negative, and the log-marker check below only ever reinforces a positive.
  //
  // Before any of that: if the probe contradicts something the SERVER's own launch flags
  // prove, the probe is looking at the wrong environment and every negative it produced
  // is void — not just the contradicted one. That is the 0.49.4 recurrence exactly: a
  // server running with --use-sage-attention (which it could not have started without)
  // while the probed interpreter reported BOTH sageattention and triton absent. Voiding
  // only sageattention would have left the false "Triton: not installed" standing, which
  // is the finding that made an agent strip working acceleration in the first place.
  // …and a contradiction discredits the SOURCE, so its POSITIVES go too. The
  // pass-positives-through asymmetry is right for an interpreter that is merely
  // UNOBSERVED — a package really is installed somewhere, and saying so is harmless.
  // It is wrong once we have proof the interpreter is not the server's environment:
  // "Triton: installed" read off the wrong venv tells an agent to enable triton kernels
  // on a server that may not have them, which fails the render. That is the SAME false
  // capability report as #401 with the sign flipped, and voiding one direction while
  // keeping the other would be believing a witness we have just caught being wrong.
  // The genuinely observed positives survive anyway: the argv-proven flag is re-applied
  // immediately below, and the ComfyUI-log markers after it.
  const provenByArgv = packagesProvenByServerArgv(statsArgv);
  const contradicted = contradictedPackage(ts, provenByArgv);
  if (contradicted) {
    logger.info(
      "Discarding this interpreter's capability results entirely: it contradicts the running ComfyUI's own launch flags",
      {
        contradicted,
        probePython: ts?.pythonVersion ?? "(unreported)",
        runningPython: statsPythonRaw ?? "(unreported)",
      },
    );
  }
  const reconcile = (state: TriState | undefined): TriState =>
    contradicted
      ? "unknown"
      : reconcileProbeState(state, {
          observed,
          runningPython: statsPythonRaw ?? caps.python,
          probePython: ts?.pythonVersion,
        });
  caps.triton = reconcile(ts?.triton);
  caps.sageattention = reconcile(ts?.sageattention);
  // The launch flag is a stronger observation than any local import probe — it is the
  // running process telling us what it loaded. Applied after reconcile so it can only
  // ever raise a state to "installed", never lower one.
  for (const pkg of provenByArgv) caps[pkg] = "installed";

  // A positive signal from the ComfyUI HOST's log wins over the local python probe:
  // in remote mode (pod) the probe can't reach the host, and even locally the log
  // reflects what ComfyUI is actually USING. So the agent sees the host's real
  // Sage/Triton state and configures nodes accordingly.
  if (opts.comfyuiUrl) {
    const logTimeout = opts.statsTimeoutMs ?? 4000;
    const fromLog = await withTimeout(
      detectAttentionFromComfyLog(opts.comfyuiUrl, logTimeout),
      logTimeout + 1000,
    );
    if (fromLog?.sageattention) caps.sageattention = fromLog.sageattention;
    if (fromLog?.triton) caps.triton = fromLog.triton;
  }

  return caps;
}

/** Merge a /system_stats payload into a caps object (pure-ish; mutates caps). */
export function applyStats(caps: EnvCapabilities, stats: SystemStatsLike): void {
  const sys = stats.system ?? {};
  caps.os = pickOs(sys.os);
  caps.python = shortPython(sys.python_version) ?? caps.python;
  caps.comfyui = sys.comfyui_version || caps.comfyui;

  // torch version + CUDA line. ComfyUI may report pytorch_version (e.g.
  // "2.10.0+cu130"); derive the CUDA line from the +cuXXX suffix when present.
  const torchRaw = sys.pytorch_version;
  if (torchRaw) {
    caps.torch = cleanTorch(torchRaw);
    const cu = torchRaw.match(/\+cu(\d{2,3})/i);
    if (cu) {
      const digits = cu[1];
      // cu130 → 13.0, cu128 → 12.8 (last digit is the minor).
      caps.cuda = `${digits.slice(0, -1)}.${digits.slice(-1)}`;
    }
  }

  // Primary CUDA/GPU device (first non-CPU device, else first device).
  const devices = Array.isArray(stats.devices) ? stats.devices : [];
  const gpu = devices.find((d) => (d.type ?? "").toLowerCase() !== "cpu") ?? devices[0];
  if (gpu) {
    if (gpu.name) caps.gpu = cleanGpuName(gpu.name);
    caps.vramTotalGb = bytesToGb(gpu.vram_total);
    caps.vramFreeGb = bytesToGb(gpu.vram_free);
  }
}

// ---------------------------------------------------------------------------
// formatEnvBlock — PURE: caps → compact single-line block (unit tested)
// ---------------------------------------------------------------------------

/**
 * Render one capability tri-state for the banner.
 *
 * "unknown" USED to be omitted, which is where the whole three-state model was thrown
 * away: an omitted Triton line and a Triton line that says "absent" are the same text to
 * the reader, and the guidance sentence below tells the agent that absence means "default
 * to sdpa + no torch.compile". So every careful degrade-to-unknown upstream landed on the
 * agent as the false negative it was avoiding. "unknown" is now SAID, and said in a form
 * that cannot be skimmed as a negative.
 *
 * `undefined` (the field was never populated at all) is still omitted — that is a
 * different thing from a probe that ran and could not decide.
 */
function triLabel(state: TriState | undefined): string | undefined {
  if (state === "installed") return "installed";
  if (state === "not-installed") return "not installed";
  if (state === "unknown") return "UNKNOWN (probe could not verify — NOT a negative)";
  return undefined;
}

/**
 * Render the compact ENVIRONMENT block. Returns "" when nothing useful is known
 * (so the caller appends nothing). Unknown fields are omitted cleanly.
 */
export function formatEnvBlock(caps: EnvCapabilities): string {
  const parts: string[] = [];

  if (caps.os) parts.push(`OS ${caps.os}`);

  if (caps.gpu) {
    const vram = typeof caps.vramTotalGb === "number" ? ` (${caps.vramTotalGb} GB VRAM)` : "";
    parts.push(`GPU ${caps.gpu}${vram}`);
  }

  if (typeof caps.ramGb === "number") parts.push(`${caps.ramGb} GB RAM`);
  if (caps.cuda) parts.push(`CUDA ${caps.cuda}`);
  if (caps.torch) parts.push(`torch ${caps.torch}`);
  if (caps.python) parts.push(`python ${caps.python}`);

  if (caps.comfyui || caps.location) {
    const loc = caps.location ? ` (${caps.location})` : "";
    // Drop the version segment cleanly when it's unknown → "ComfyUI (LOCAL)".
    const ver = caps.comfyui ? ` ${caps.comfyui}` : "";
    parts.push(`ComfyUI${ver}${loc}`);
  }

  if (caps.manager === "v4") {
    parts.push("Manager v4");
  } else if (caps.manager === "legacy") {
    // The agent should relay this to the user when node/model operations
    // degrade — comfyui-mcp is optimized for Manager v4+.
    parts.push(
      "Manager 3.x LEGACY (partial feature set — recommend upgrading to ComfyUI-Manager v4+; comfyui-mcp is optimized for v4)",
    );
  }

  const triton = triLabel(caps.triton);
  if (triton) parts.push(`Triton: ${triton}`);
  const sage = triLabel(caps.sageattention);
  if (sage) parts.push(`SageAttention: ${sage}`);

  if (caps.backend) {
    // With three providers the specific "other" isn't single-valued, so name them
    // generically when an alternative is resolvable.
    const otherClause = caps.otherBackendAvailable ? "; other providers available" : "";
    parts.push(`Backend: ${caps.backend}${otherClause}`);
  }

  // Our own build versions — so the agent can stamp them into bug reports without
  // digging (report-bug skill requires both).
  //
  // #846: the version named FIRST is the one this process is RUNNING, because that
  // is the build whose behaviour the agent is about to describe in a bug report. An
  // upgrade that landed while the orchestrator was up does not change that, and
  // silently reporting the newer on-disk number instead would pin every issue to
  // code nobody executed. So the drift is DISCLOSED, with the action that resolves
  // it — a restart is the only thing that makes the two agree.
  const upgradeClause =
    caps.mcpVersion &&
    caps.mcpVersionInstalled &&
    caps.mcpVersionInstalled !== caps.mcpVersion
      ? ` (this process is RUNNING ${caps.mcpVersion}; ${caps.mcpVersionInstalled} is now installed on disk` +
        " — restart the orchestrator to load it, and report bugs against the RUNNING version)"
      : "";
  const versions = [
    caps.mcpVersion && `comfyui-mcp ${caps.mcpVersion}${upgradeClause}`,
    caps.panelVersion && `panel ${caps.panelVersion}`,
  ].filter(Boolean);
  if (versions.length) parts.push(versions.join(" · "));

  if (parts.length === 0) return "";

  const head = `ENVIRONMENT (live, this machine): ${parts.join(" · ")}.`;
  const guidance =
    " Use this for model/precision/VRAM choices, OS-correct install commands, and the" +
    " acceleration decision — default to sdpa + no torch.compile (see the" +
    " triton-sageattention skill) and offer to install ONLY where this line says" +
    " \"not installed\". \"UNKNOWN\" means the probe could not verify which interpreter the" +
    " running ComfyUI uses; it is NOT a report of absence. Never disable Triton/" +
    `SageAttention or edit a user's workflow on an UNKNOWN — call install_comfyui (action:"environment")` +
    " (python_probe_reason says what could not be established) or ask the user first.";
  return head + guidance;
}

// ---------------------------------------------------------------------------
// buildPanelSystemAppend — PREPEND the env block to the existing static prompt
// ---------------------------------------------------------------------------

/**
 * Surgical builder: returns the existing static panel prompt with a compact env
 * block PREPENDED. If the env block is empty (probe failed/timed out entirely),
 * returns the static prompt unchanged — the prompt MUST always build.
 */
export function buildPanelSystemAppend(
  staticPrompt: string,
  caps: EnvCapabilities | undefined,
): string {
  const block = caps ? formatEnvBlock(caps) : "";
  if (!block) return staticPrompt;
  return `${block}\n\n${staticPrompt}`;
}
