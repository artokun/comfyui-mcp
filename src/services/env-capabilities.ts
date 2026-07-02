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
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { platform, release, totalmem, cpus } from "node:os";
import { join } from "node:path";
import { isForceRemoteFlagSet } from "../config.js";

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
  triton?: TriState;
  sageattention?: TriState;
  backend?: "Claude" | "Codex" | "Gemini"; // active provider (human label)
  otherBackendAvailable?: boolean; // is the OTHER provider resolvable?
}

// Shape of the bits of /system_stats we read (mirrors get_environment).
interface SystemStatsLike {
  system?: {
    os?: string;
    python_version?: string;
    comfyui_version?: string;
    // Newer ComfyUI reports these; tolerated when absent.
    pytorch_version?: string;
    argv?: string[];
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

/** Is the COMFYUI_URL host loopback? → LOCAL, else REMOTE. Unknown URL → LOCAL
 *  (the panel's overwhelming default; never block on an unparseable URL).
 *  --force-remote overrides this, keeping it in sync with isRemoteMode(). */
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
// /system_stats fetch (direct HTTP — no client dependency, mirrors get_environment)
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
    const res = await fetch(`${base}/system_stats`, { signal: controller.signal });
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
 * Locate the python that ComfyUI actually runs on, the way the
 * triton-sageattention skill describes: prefer the standalone-env / python_embeded
 * / .venv interpreter under COMFYUI_PATH (or the install root inferred from the
 * running server's argv main.py), then fall back to PATH python. Returns the
 * first candidate that exists on disk, or a PATH name as a last resort.
 */
export function findComfyuiPython(
  comfyuiPath: string | undefined,
  statsArgv: string[] | undefined,
): string | undefined {
  const names = IS_WIN ? ["python.exe", "python"] : ["python3", "python"];
  const roots: string[] = [];
  if (comfyuiPath) roots.push(comfyuiPath);
  // Infer the install root from the running server's argv (…/main.py).
  if (Array.isArray(statsArgv)) {
    const mainPy = statsArgv.find((a) => typeof a === "string" && /main\.py$/i.test(a));
    if (mainPy) {
      const root = mainPy.replace(/[\\/]+main\.py$/i, "");
      if (root && !roots.includes(root)) roots.push(root);
    }
  }

  const candidates: string[] = [];
  for (const root of roots) {
    if (IS_WIN) {
      candidates.push(join(root, "standalone-env", "python.exe"));
      candidates.push(join(root, "python_embeded", "python.exe"));
      candidates.push(join(root, ".venv", "Scripts", "python.exe"));
      candidates.push(join(root, "venv", "Scripts", "python.exe"));
      // Desktop app keeps the embedded python a level up beside the install.
      candidates.push(join(root, "..", "python_embeded", "python.exe"));
    } else {
      candidates.push(join(root, ".venv", "bin", "python3"));
      candidates.push(join(root, ".venv", "bin", "python"));
      candidates.push(join(root, "venv", "bin", "python3"));
      candidates.push(join(root, "venv", "bin", "python"));
    }
  }

  for (const c of candidates) {
    // Skip UNC / network roots (\\server\share) — a dead/slow network path makes
    // existsSync() block for seconds and we gather env at startup. Local drive
    // paths are instant. (Linux/Mac UNC isn't a thing; this is the Windows risk.)
    if (/^\\\\/.test(c)) continue;
    try {
      if (existsSync(c)) return c;
    } catch {
      // ignore and continue
    }
  }
  // Last resort: a PATH-resolved interpreter (may not be ComfyUI's, but better
  // than nothing for the import probe).
  return names[0];
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
): Promise<{ triton: TriState; sageattention: TriState }> {
  return new Promise((resolve) => {
    if (!pythonExe) {
      resolve({ triton: "unknown", sageattention: "unknown" });
      return;
    }
    // Print a clear per-package marker so we can tell which imported, even if one
    // succeeds and the other fails (avoids an all-or-nothing answer).
    const code =
      "import importlib.util as u;" +
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
        // If python ran but errored AFTER printing partial output, still trust
        // whatever lines we got; missing lines stay "unknown".
        void err;
        resolve({ triton: read("triton"), sageattention: read("sageattention") });
      },
    );
    child.on?.("error", () => {
      if (done) return;
      done = true;
      resolve({ triton: "unknown", sageattention: "unknown" });
    });
  });
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
 * Determine the active backend label and whether ANY other provider is available.
 * activeBackendId is "claude" | "codex" | "gemini" (from PANEL_AGENT_BACKEND).
 */
export function resolveBackends(activeBackendId: string): {
  backend: "Claude" | "Codex" | "Gemini";
  otherBackendAvailable: boolean;
} {
  const id = activeBackendId.toLowerCase();
  const claudeAvailable = canResolve("@anthropic-ai/claude-agent-sdk");
  // Codex can be the @openai/codex package OR a `codex` CLI on PATH; Gemini the
  // @google/gemini-cli package OR a `gemini` CLI on PATH. Resolving the package is
  // the cheap, synchronous signal we use here (a PATH-only CLI reads as absent).
  const codexAvailable = canResolve("@openai/codex");
  const geminiAvailable = canResolve("@google/gemini-cli");
  const backend = id === "codex" ? "Codex" : id === "gemini" ? "Gemini" : "Claude";
  // "Other available" = any provider other than the active one is resolvable.
  const otherBackendAvailable =
    backend === "Claude"
      ? codexAvailable || geminiAvailable
      : backend === "Codex"
        ? claudeAvailable || geminiAvailable
        : claudeAvailable || codexAvailable;
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
  /** Override probe timeouts (tests). */
  statsTimeoutMs?: number;
  tritonTimeoutMs?: number;
}

export async function gatherEnvCapabilities(opts: GatherOptions): Promise<EnvCapabilities> {
  const caps: EnvCapabilities = {};

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
  if (stats) {
    applyStats(caps, stats);
    statsArgv = stats.system?.argv;
  }

  // --- triton + sageattention (find python, import-probe, ~5s cap) ---
  const python = findComfyuiPython(opts.comfyuiPath, statsArgv);
  const tritonTimeout = opts.tritonTimeoutMs ?? 5000;
  const ts = await withTimeout(probeTritonSage(python, tritonTimeout), tritonTimeout + 1000);
  caps.triton = ts?.triton ?? "unknown";
  caps.sageattention = ts?.sageattention ?? "unknown";

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

function triLabel(state: TriState | undefined): string | undefined {
  if (state === "installed") return "installed";
  if (state === "not-installed") return "not installed";
  return undefined; // unknown → omit
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

  if (parts.length === 0) return "";

  const head = `ENVIRONMENT (live, this machine): ${parts.join(" · ")}.`;
  const guidance =
    " Use this for model/precision/VRAM choices, OS-correct install commands, and the" +
    " acceleration decision — if Triton/SageAttention are absent, default to sdpa + no" +
    " torch.compile (see the triton-sageattention skill) and offer to install.";
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
