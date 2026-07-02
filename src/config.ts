import { z } from "zod";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { parseComfyUIUrl, type ComfyUITarget } from "./transport/comfyui-url.js";

// Resolve .env from the package root, not process.cwd()
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "..");
dotenv.config({ path: resolve(packageRoot, ".env") });

/**
 * Does `p` look like a real ComfyUI install root? A ComfyUI Desktop-installer
 * wrapper directory has NONE of these markers, while the real (sometimes nested)
 * root has at least one. Used to detect + self-heal the "doubled COMFYUI_PATH"
 * layout where the actual install lives under `<wrapper>/ComfyUI/`.
 */
export function looksLikeComfyUIRoot(p: string): boolean {
  try {
    return (
      existsSync(join(p, "main.py")) ||
      existsSync(join(p, "output")) ||
      existsSync(join(p, "custom_nodes")) ||
      existsSync(join(p, "models"))
    );
  } catch {
    return false;
  }
}

/**
 * Self-heal the nested ("doubled") ComfyUI Desktop-installer layout: if `p` is
 * not itself a valid root but `p/ComfyUI` is, descend exactly ONE level (never
 * more — guards against re-doubling). Returns `p` unchanged in every other case
 * (already a valid root, or no nested root found), so this is a strict no-op for
 * a correctly-installed (non-nested) ComfyUI.
 */
export function descendToNestedRoot(p: string, label = "COMFYUI_PATH"): string {
  try {
    if (looksLikeComfyUIRoot(p)) return p;
    const nested = join(p, "ComfyUI");
    if (looksLikeComfyUIRoot(nested)) {
      console.error(
        `[comfyui-mcp] ${label} "${p}" looks like a Desktop-installer wrapper ` +
          `(no main.py/output/custom_nodes/models); descending to nested root "${nested}".`,
      );
      return nested;
    }
  } catch {
    // Best-effort: never throw out of path resolution.
  }
  return p;
}

/**
 * Auto-detect ComfyUI installation directories.
 * Checks common locations on macOS, Linux, and Windows.
 * Returns all found paths sorted by preference.
 */
function detectComfyUIPaths(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  // macOS: ComfyUI Desktop app stores data here
  candidates.push(join(home, "Documents", "ComfyUI"));

  // macOS: Application Support
  candidates.push(join(home, "Library", "Application Support", "ComfyUI"));

  // Common manual install locations
  candidates.push(join(home, "ComfyUI"));
  candidates.push(join(home, "code", "ComfyUI"));
  candidates.push(join(home, "projects", "ComfyUI"));
  candidates.push(join(home, "src", "ComfyUI"));

  // Linux common paths
  candidates.push("/opt/ComfyUI");
  candidates.push(join(home, ".local", "share", "ComfyUI"));

  // Windows common paths
  candidates.push(join(home, "AppData", "Local", "ComfyUI"));
  candidates.push(join(home, "Desktop", "ComfyUI"));

  // Windows: ComfyUI Desktop app installs here
  candidates.push(
    join(home, "AppData", "Local", "Programs", "ComfyUI", "resources", "ComfyUI"),
  );

  // Scan ~/Documents and ~/My Documents for any ComfyUI-named directories
  const documentsDirs = [
    join(home, "Documents"),
    join(home, "My Documents"),
  ];
  for (const dir of documentsDirs) {
    try {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toLowerCase().includes("comfyui")) {
          const fullPath = join(dir, entry.name);
          if (!candidates.includes(fullPath)) {
            candidates.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  // Filter to paths that exist and look like actual ComfyUI installations
  // (must have a models/ or custom_nodes/ subdirectory, or be a known install path)
  const found = candidates.filter((p) => {
    if (!existsSync(p)) return false;
    // Known install paths are trusted without marker check
    if (!p.includes("Documents")) return true;
    // For scanned directories, verify it's a real ComfyUI install
    return existsSync(join(p, "models")) || existsSync(join(p, "custom_nodes"));
  });

  // Self-heal the Desktop-installer "nested ComfyUI" layout: a trusted install
  // path may point at the wrapper dir whose real root is one level down. Descend
  // each hit (no-op for normal installs) and dedupe.
  const healed: string[] = [];
  for (const p of found) {
    const root = descendToNestedRoot(p, "Detected ComfyUI path");
    if (!healed.includes(root)) healed.push(root);
  }
  return healed;
}

// Loopback hostnames for the smart-detection logic. When --comfyui-url points
// at a non-loopback host, the user is targeting a remote ComfyUI and the
// local-FS auto-detection would just create a deceptive footgun (filesystem
// fallbacks writing to an unrelated local install while the remote ComfyUI
// never sees the file).
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
  "0.0.0.0",
]);

/** True when a hostname is loopback (or absent → assume local). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true; // No URL → assume local
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Resolve the ComfyUI path, with auto-detection fallback.
 * Priority: COMFYUI_PATH env var > auto-detected paths.
 *
 * Smart-detection: if the user is targeting a remote ComfyUI (`--comfyui-url`
 * points at a non-loopback host) or Comfy Cloud (`COMFYUI_API_KEY` is set),
 * skip auto-detection — having COMFYUI_PATH point at an unrelated local
 * install causes silent failures (see fix in 0.8.1 upload_*). An explicit
 * COMFYUI_PATH env var still wins.
 */
function resolveComfyUIPath(
  envPath: string | undefined,
  opts: { remoteUrl: boolean; cloud: boolean; remoteHost?: string },
): string | undefined {
  if (envPath) {
    if (opts.remoteUrl) {
      console.error(
        `[comfyui-mcp] WARNING: Both COMFYUI_URL (remote ComfyUI at ${opts.remoteHost})` +
        ` and COMFYUI_PATH (${envPath}) are set.\n` +
        `  Filesystem operations will use ${envPath} while API calls go to ${opts.remoteHost}.\n` +
        `  Unset COMFYUI_PATH if you only intended to target the remote instance.`,
      );
    }
    // Even an explicit env var is descended if it points at the Desktop-installer
    // wrapper rather than the real (nested) root — but only that case logs a notice.
    return descendToNestedRoot(envPath, "COMFYUI_PATH (env)");
  }
  if (opts.remoteUrl || opts.cloud) {
    return undefined;
  }

  const detected = detectComfyUIPaths();
  if (detected.length === 0) return undefined;

  if (detected.length > 1) {
    console.error(
      `[comfyui-mcp] Multiple ComfyUI installations detected:\n` +
        detected.map((p, i) => `  ${i + 1}. ${p}`).join("\n") +
        `\nUsing: ${detected[0]}\n` +
        `Set COMFYUI_PATH to override.`,
    );
  }

  // detectComfyUIPaths() already descends wrapper hits; this is a defensive
  // no-op so the selected path is guaranteed to be a real root.
  return descendToNestedRoot(detected[0], "Detected ComfyUI path");
}

/**
 * Auto-detect which port ComfyUI is running on.
 * Tries common ports: 8000 (Desktop app default), 8188 (repo/CLI default).
 * Returns the first port that responds, or the default if none found.
 */
async function detectComfyUIPort(host: string): Promise<number> {
  const ports = [8188, 8000];

  for (const port of ports) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const protocol = parsedConfig.comfyuiSsl ? "https" : "http";
      const res = await fetch(`${protocol}://${host}:${port}/system_stats`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        console.error(`[comfyui-mcp] Found ComfyUI on port ${port}`);
        return port;
      }
    } catch {
      // Port not responding, try next
    }
  }

  console.error(
    `[comfyui-mcp] ComfyUI not detected on ports ${ports.join(", ")}. Defaulting to 8188.`,
  );
  return 8188;
}

/**
 * Resolve a ComfyUI target from --comfyui-url (argv) or COMFYUI_URL (env).
 * Takes precedence over COMFYUI_HOST/PORT/SSL and skips port auto-detection.
 */
function resolveUrlOverride(): ComfyUITarget | undefined {
  const argv = process.argv.slice(2);
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--comfyui-url") {
      raw = argv[i + 1];
      break;
    }
    if (a.startsWith("--comfyui-url=")) {
      raw = a.slice("--comfyui-url=".length);
      break;
    }
  }
  raw = raw ?? process.env.COMFYUI_URL;
  if (!raw) return undefined;
  try {
    return parseComfyUIUrl(raw);
  } catch (err) {
    console.error(
      `[comfyui-mcp] Ignoring invalid --comfyui-url/COMFYUI_URL "${raw}": ${
        err instanceof Error ? err.message : err
      }`,
    );
    return undefined;
  }
}

/** Force remote classification for a loopback --comfyui-url (dstack/RunPod port-forwards). */
function resolveForceRemote(): boolean {
  const argv = process.argv.slice(2);
  if (argv.includes("--force-remote")) return true;
  const env = process.env.COMFYUI_MCP_FORCE_REMOTE;
  return env === "1" || env === "true";
}

const configSchema = z.object({
  comfyuiHost: z.string().default("127.0.0.1"),
  comfyuiPort: z.coerce.number().int().positive().optional(),
  comfyuiSsl: z.coerce.boolean().default(false),
  comfyuiBasePath: z.string().default(""),
  comfyuiPath: z.string().optional(),
  comfyuiApiKey: z.string().optional(),
  comfyuiCloudUrl: z.string().default("https://cloud.comfy.org"),
  // Generic auth for self-hosted ComfyUI behind a reverse proxy / API gateway
  // (distinct from Comfy Cloud's COMFYUI_API_KEY). Applied to every ComfyUI
  // HTTP request in local/remote modes when a token is set.
  comfyuiAuthHeader: z.string().optional(),
  comfyuiAuthScheme: z.string().optional(),
  comfyuiAuthToken: z.string().optional(),
  huggingfaceToken: z.string().optional(),
  githubToken: z.string().optional(),
  civitaiApiToken: z.string().optional(),
  comfyApiKey: z.string().optional(),
});

export type Config = z.infer<typeof configSchema> & { resolvedPort: number };

const urlOverride = resolveUrlOverride();
const cloudApiKey = process.env.COMFYUI_API_KEY?.trim() || undefined;
const cloudActive = Boolean(cloudApiKey);
const forceRemote = resolveForceRemote();
const remoteUrlActive =
  Boolean(urlOverride) && (forceRemote || !isLoopbackHost(urlOverride?.host));

if (cloudActive) {
  console.error(
    `[comfyui-mcp] Comfy Cloud mode enabled (COMFYUI_API_KEY set) — local FS/process tools will throw.`,
  );
}

if (forceRemote && !urlOverride) {
  console.error(
    `[comfyui-mcp] WARNING: --force-remote/COMFYUI_MCP_FORCE_REMOTE set but no ` +
      `--comfyui-url/COMFYUI_URL given — there's no target to force remote, so this has no effect.`,
  );
}

const parsedConfig = configSchema.parse({
  comfyuiHost: urlOverride?.host ?? process.env.COMFYUI_HOST,
  comfyuiPort: urlOverride?.port ?? (process.env.COMFYUI_PORT || undefined),
  comfyuiSsl: urlOverride?.ssl ?? process.env.COMFYUI_SSL,
  comfyuiBasePath: urlOverride?.basePath ?? "",
  comfyuiPath: resolveComfyUIPath(process.env.COMFYUI_PATH, {
    remoteUrl: remoteUrlActive,
    cloud: cloudActive,
    remoteHost: urlOverride?.host ? `${urlOverride.host}:${urlOverride.port}` : undefined,
  }),
  comfyuiApiKey: cloudApiKey,
  comfyuiCloudUrl: process.env.COMFYUI_CLOUD_URL,
  comfyuiAuthHeader: process.env.COMFYUI_AUTH_HEADER,
  comfyuiAuthScheme: process.env.COMFYUI_AUTH_SCHEME,
  comfyuiAuthToken: process.env.COMFYUI_AUTH_TOKEN,
  huggingfaceToken: process.env.HUGGINGFACE_TOKEN,
  githubToken: process.env.GITHUB_TOKEN,
  civitaiApiToken: process.env.CIVITAI_API_TOKEN,
  comfyApiKey: process.env.COMFY_API_KEY,
});

// Resolve port:
// - Cloud mode: no port needed (resolvedPort is a placeholder; getComfyUIApiHost()
//   throws via requireLocalMode() in cloud mode so the value is never read).
// - Otherwise: explicit url/env wins, then auto-detect against the host.
let resolvedPort: number;
if (cloudActive) {
  resolvedPort = parsedConfig.comfyuiPort ?? 0;
} else {
  resolvedPort = parsedConfig.comfyuiPort
    ?? (urlOverride ? urlOverride.port : await detectComfyUIPort(parsedConfig.comfyuiHost));
}

export const config: Config = { ...parsedConfig, resolvedPort };

// ── Mode helpers ──────────────────────────────────────────────────────────
// Three modes, mutually exclusive in practice:
//   - cloud:  COMFYUI_API_KEY set → talk to Comfy Cloud over HTTPS+X-API-Key
//   - remote: --comfyui-url points at a non-loopback host → talk to remote
//             ComfyUI; local-FS/process tools should throw
//   - local:  everything else
// Tools that fundamentally need a local install (process control, manifest,
// model removal, etc.) MUST check config.comfyuiPath and throw clearly if
// undefined. The dispatcher in src/comfyui/client.ts handles cloud routing
// for HTTP-backed primitives.

export function isCloudMode(): boolean {
  return Boolean(config.comfyuiApiKey);
}

export function isRemoteMode(): boolean {
  return !isCloudMode() && remoteUrlActive;
}

export function isLocalMode(): boolean {
  return !isCloudMode() && !isRemoteMode();
}

/** For env-capabilities.ts, which classifies a URL independently of urlOverride. */
export function isForceRemoteFlagSet(): boolean {
  return forceRemote;
}

/** Filesystem-safe id for the target instance — scopes per-instance data (e.g. generations DB). */
export function getInstanceSlug(): string {
  if (isCloudMode()) return "comfy-cloud";
  const host = isLoopbackHost(config.comfyuiHost) ? "localhost" : config.comfyuiHost;
  const raw = `${host}_${config.resolvedPort}`;
  const slug = raw.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return slug || "comfyui";
}

export function getCloudUrl(): string {
  return config.comfyuiCloudUrl;
}

export function getApiKey(): string {
  if (!config.comfyuiApiKey) {
    throw new Error("Comfy Cloud API key not configured (COMFYUI_API_KEY).");
  }
  return config.comfyuiApiKey;
}

export function getComfyUIApiHost(): string {
  return `${config.comfyuiHost}:${config.resolvedPort}`;
}

export function getComfyUIProtocol(): "http" | "https" {
  return config.comfyuiSsl ? "https" : "http";
}

/** The URL path prefix ComfyUI is mounted under (e.g. "/comfyapi"), or "". */
export function getComfyUIBasePath(): string {
  return config.comfyuiBasePath;
}

/**
 * Canonical base URL for ComfyUI HTTP requests: protocol + host:port + path
 * prefix, no trailing slash. Append endpoint paths (e.g. `/system_stats`) to
 * this so reverse-proxied / path-prefixed instances route correctly.
 */
export function getComfyUIBaseUrl(): string {
  return `${getComfyUIProtocol()}://${getComfyUIApiHost()}${config.comfyuiBasePath}`;
}

/**
 * Generic auth header(s) for a self-hosted ComfyUI behind a gateway/proxy.
 * Empty when no token is configured. Examples:
 *   COMFYUI_AUTH_TOKEN=abc                       → Authorization: Bearer abc
 *   COMFYUI_AUTH_HEADER=X-API-Key TOKEN=abc      → X-API-Key: abc
 *   COMFYUI_AUTH_SCHEME=Token TOKEN=abc          → Authorization: Token abc
 * This is independent of Comfy Cloud mode (COMFYUI_API_KEY / X-API-Key).
 */
export function getComfyUIAuthHeaders(): Record<string, string> {
  const token = config.comfyuiAuthToken?.trim();
  if (!token) return {};
  const header = config.comfyuiAuthHeader?.trim() || "Authorization";
  // An unset/empty scheme defaults to "Bearer" for the Authorization header and
  // to none (raw token) for any custom header. Set COMFYUI_AUTH_SCHEME to force
  // a specific scheme (e.g. "Token").
  const scheme =
    config.comfyuiAuthScheme?.trim() ||
    (header.toLowerCase() === "authorization" ? "Bearer" : "");
  return { [header]: scheme ? `${scheme} ${token}` : token };
}
