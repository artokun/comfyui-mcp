import { z } from "zod";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { normalizeInstallPathEnv } from "./utils/install-path-env.js";
import { parseComfyUIUrl, type ComfyUITarget } from "./transport/comfyui-url.js";
import { resetManagerApiCache } from "./services/manager-api-cache.js";
import { comfyuiEnvFilePath, freshSecretValue, loadEnvFileIntoProcess } from "./env-file.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "..");
// Env-file config lives in the user's config dir — ~/.comfyui-mcp/.env — next
// to panel-secrets.json and the token files, so the same path works for
// npx/npm installs and git checkouts on Windows/mac/Linux alike. A package-root
// .env (only reachable in dev checkouts; npm installs resolve into the package
// cache) is legacy: migrate it once, then stop reading it. Real environment
// variables always win — dotenv never overrides values that are already set.
const homeEnvPath = join(homedir(), ".comfyui-mcp", ".env");
const legacyEnvPath = resolve(packageRoot, ".env");
try {
  if (!existsSync(homeEnvPath) && existsSync(legacyEnvPath)) {
    mkdirSync(dirname(homeEnvPath), { recursive: true });
    copyFileSync(legacyEnvPath, homeEnvPath);
    // owner-only, matching panel-secrets.json (no-op on Windows ACLs)
    try {
      chmodSync(homeEnvPath, 0o600);
    } catch {
      /* ignore */
    }
    process.stderr.write(`[comfyui-mcp] migrated ${legacyEnvPath} -> ${homeEnvPath} (the package .env is no longer read)\n`);
  }
} catch {
  // best-effort migration; real env vars and an existing home .env still work
}
// Load the canonical dotenv (path resolution — including the COMFYUI_MCP_ENV_FILE
// override — lives in env-file.ts so the WRITER, services/panel-secrets.ts, and
// every reader can never disagree about which file "the token was saved" means).
// This also records which keys were seeded FROM the file, which is what lets
// freshSecretValue() supersede them on a later re-read (#826).
loadEnvFileIntoProcess();

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
 * Local install paths the ComfyUI Desktop app itself recorded in its
 * installations.json — the authoritative source for Desktop users, who pick an
 * arbitrary install location at setup (e.g. ~/ComfyUI-Installs/ComfyUI) that no
 * directory heuristic can guess. Entries are sorted most-recently-launched
 * first; remote connections are skipped (by sourceId, and by the empty
 * installPath they normally carry — a stale local path on a remote entry must
 * not win). Best-effort: any read/parse failure just falls through to the
 * heuristic scan.
 */
function desktopRecordedInstallPaths(): string[] {
  const home = homedir();
  const configDirs = [
    join(home, "AppData", "Roaming", "Comfy Desktop"), // Windows
    join(home, "Library", "Application Support", "Comfy Desktop"), // macOS
    join(home, ".config", "Comfy Desktop"), // Linux
  ];
  const entries: Array<{ path: string; launched: number }> = [];
  for (const dir of configDirs) {
    try {
      const file = join(dir, "installations.json");
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      if (!Array.isArray(parsed)) continue;
      for (const inst of parsed) {
        if (!inst || typeof inst !== "object") continue;
        const rec = inst as Record<string, unknown>;
        if (rec.sourceId === "remote") continue;
        if (typeof rec.installPath !== "string" || !rec.installPath.trim()) continue;
        entries.push({
          path: rec.installPath,
          launched: typeof rec.lastLaunchedAt === "number" ? rec.lastLaunchedAt : 0,
        });
      }
    } catch {
      // Unreadable/malformed — the heuristic scan below still applies.
    }
  }
  return (
    entries
      .sort((a, b) => b.launched - a.launched)
      .map((e) => e.path)
      // An entry can point at a directory that still EXISTS but is no longer
      // an install (uninstalled/moved — only logs/outputs left). The shared
      // detect filter trusts non-Documents paths without a marker check, so a
      // dead recorded root would win over a real install — require real-root
      // markers here (directly, or one level down for the Desktop-installer
      // wrapper layout that descendToNestedRoot heals).
      .filter((p) => looksLikeComfyUIRoot(p) || looksLikeComfyUIRoot(join(p, "ComfyUI")))
  );
}

/**
 * Auto-detect ComfyUI installation directories.
 * Checks the Desktop app's own installation records first, then common
 * locations on macOS, Linux, and Windows.
 * Returns all found paths sorted by preference.
 */
function detectComfyUIPaths(): string[] {
  const home = homedir();
  // Desktop-recorded installs outrank every guessed location.
  const candidates: string[] = [...desktopRecordedInstallPaths()];

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
  "::", // IPv6 wildcard bind — reachable on loopback (::1)
  "0000:0000:0000:0000:0000:0000:0000:0000",
]);

/**
 * True when `host` is an address THIS machine answers on — loopback, or any
 * literal IP currently bound to one of its own interfaces (#742).
 *
 * `isLoopbackHost` answers a narrower question than most of its callers need.
 * Loopback proves the ROUTE is local; it does not follow that a non-loopback
 * address is a different machine. A ComfyUI on this very host addressed as
 * `http://192.168.1.50:8188` — which is how anyone reaches it from a phone, or
 * how Pinokio and several launchers advertise it — is not loopback and is not
 * remote either. The recurrence on #742 is exactly that: the restart guard read
 * "not loopback" as "not ours", skipped its refuse-safe check, and stopped a
 * server it then could not bring back.
 *
 * NO DNS. A hostname is compared as a string against the literal addresses the
 * interfaces report, so it simply never matches — `comfy.lan` returns false even
 * if it resolves here. That is deliberate, not a gap: resolving would mean a DNS
 * round trip on a path that must not block, and a name can resolve differently —
 * or be made to — between this check and the action it authorizes. This gates a
 * REFUSAL, so "cannot prove it is ours" is the safe answer; it leaves today's
 * behaviour exactly as it was.
 *
 * (An earlier version guarded the comparison with an explicit is-this-a-literal-IP
 * test. Mutation testing showed removing it changed no outcome — the equality
 * below already refuses names — so it was a check that could never fire, next to
 * a comment claiming it was what enforced the rule.)
 *
 * Not cached. `networkInterfaces()` is a cheap syscall, and a laptop that
 * changes networks would keep answering from a stale snapshot — wrong in the
 * direction that matters, since the whole point is to be right about which
 * machine we are talking to right now.
 */
export function isOwnHostAddress(host: string | undefined): boolean {
  if (isLoopbackHost(host)) return true;
  const h = canonicalHostForCompare(host);
  // An empty host must never fall through to the comparison: an interface that
  // reported an empty address would then match it.
  if (!h) return false;
  try {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (canonicalHostForCompare(a.address) === h) return true;
      }
    }
  } catch {
    // Enumerating interfaces can fail in a locked-down container. Unknown is
    // not proof, and this gates a refusal — fall through to false.
  }
  return false;
}

/**
 * One canonical spelling for an address, so equality means "same address"
 * rather than "same characters" (#742 review).
 *
 * Textual comparison alone is wrong in the direction that keeps the bug: an
 * interface reports `2600:1700:5892:bc10::22` while a config may carry the same
 * address written `2600:1700:5892:BC10:0:0:0:22`, and a plain `===` calls those
 * different machines. `URL` already implements the canonicalization — it
 * lowercases, collapses to the `::` form, and rewrites IPv4-mapped addresses —
 * so both sides are run through it rather than hand-rolling the rules.
 *
 * IPv4-mapped IPv6 (`::ffff:192.168.1.179`) is folded to its dotted IPv4 form
 * FIRST, because that is the form `networkInterfaces()` reports; left alone,
 * `URL` canonicalizes it to `::ffff:c0a8:1b3` and it still would not match.
 *
 * No zone-suffix handling: `new URL("http://[fe80::1%eth0]/")` throws, so a
 * scoped address cannot reach here through a configured target at all. An
 * earlier version stripped `%eth0` and had a test for it — which passed while
 * exercising something production could never deliver.
 */
function canonicalHostForCompare(host: string | undefined): string {
  const raw = (host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!raw) return "";
  if (!raw.includes(":")) return raw; // IPv4 or a name — already canonical
  let canon: string;
  try {
    // URL canonicalizes IPv6 and re-brackets it; strip the brackets back off.
    canon = new URL(`http://[${raw}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return raw; // not a valid IPv6 literal — compare as written
  }
  // The IPv4-mapped fold happens AFTER canonicalization, not before, and that
  // ordering is the whole point (round-2 review). URL rewrites EVERY mapped
  // spelling to the same hex form — `::ffff:192.168.1.179`,
  // `0:0:0:0:0:ffff:c0a8:1b3` and `::FFFF:C0A8:1B3` all become
  // `::ffff:c0a8:1b3` — so folding here catches all of them with one rule.
  // Folding beforehand caught only the dotted spelling and left the rest
  // classified as somebody else's machine.
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return canon;
}

/** True when a hostname is loopback (or absent → assume local). Bracketed IPv6
 *  (`[::1]`, as URL parsing stores it) is normalized first so every consumer
 *  classifies it the same (codex finding: is_local frame vs FS gating split). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true; // No URL → assume local
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(h);
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
  rawEnvPath: string | undefined,
  opts: { remoteUrl: boolean; cloud: boolean; remoteHost?: string },
): string | undefined {
  // #1512 — normalize BEFORE the truthy check, so a whitespace-only value falls
  // through to auto-detection instead of being adopted as a real (unusable) path.
  const { path: envPath } = normalizeInstallPathEnv(rawEnvPath);
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
 * Best local ComfyUI install path by auto-detection alone (no env var, no
 * remote/cloud gating — the CALLER decides whether a local path applies to its
 * target). Used by the panel orchestrator so a loopback session without
 * COMFYUI_PATH still resolves the local install (Desktop-recorded installs
 * first) and keeps local install/pack tools enabled. Returns undefined when
 * nothing is found.
 */
export function detectLocalComfyUIPath(): string | undefined {
  const detected = detectComfyUIPaths();
  if (detected.length === 0) return undefined;
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
  /**
   * Optional checkout/code root for split installs where COMFYUI_PATH is the
   * server's data/base directory. Code-facing tools (git, comfy-cli,
   * custom_nodes provenance) use this path without moving input/output/user or
   * models away from COMFYUI_PATH.
   */
  comfyuiCodePath: z.string().optional(),
  // COMFYUI_RESTART_COMMAND (panel#1262): the exact shell command that restarts an
  // EXTERNALLY-MANAGED ComfyUI (a container, a systemd unit, a launcher) — e.g.
  // `docker restart comfyui`. When set, restart runs THIS instead of the
  // kill+relaunch that needs the install's launch path resolvable from here
  // (which is exactly what an externally managed install does not offer).
  comfyuiRestartCommand: z.string().optional(),
  comfyuiApiKey: z.string().optional(),
  comfyuiCloudUrl: z.string().default("https://cloud.comfy.org"),
  // Generic auth for self-hosted ComfyUI behind a reverse proxy / API gateway
  // (distinct from Comfy Cloud's COMFYUI_API_KEY). Applied to every ComfyUI
  // HTTP request in local/remote modes when a token is set.
  comfyuiAuthHeader: z.string().optional(),
  comfyuiAuthScheme: z.string().optional(),
  comfyuiAuthToken: z.string().optional(),
  // Cloudflare Access service token (a Client ID + Client Secret PAIR). When both
  // are set, every ComfyUI request carries CF-Access-Client-Id / -Secret so a
  // ComfyUI endpoint fronted by Cloudflare Access lets the connector through
  // instead of returning the interactive sign-in page. Independent of, and
  // additive to, COMFYUI_AUTH_TOKEN.
  cfAccessClientId: z.string().optional(),
  cfAccessClientSecret: z.string().optional(),
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
// Mutable: setComfyuiTarget() re-classifies this on a runtime retarget so
// isRemoteMode()/isLocalMode() track the new host instead of the startup one.
let remoteUrlActive =
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

/**
 * Comfy.org API key for partner/API-node auth (extra_data.api_key_comfy_org).
 * Precedence: COMFY_API_KEY env var, then ~/.comfy-api-key (trimmed file
 * contents) — the file fallback lets headless setups keep the key out of env/
 * process listings (chmod 600 recommended). Best-effort: unreadable/empty file
 * just means no key. Never log the key value.
 * File fallback originally contributed by @joaolvivas in
 * `joaolvivas/comfyui-mcp-byjlucas@4b989e4` and reimplemented here with thanks.
 */
function resolveComfyApiKey(): string | undefined {
  const env = process.env.COMFY_API_KEY;
  if (env && env.trim()) return env.trim();
  try {
    const keyFile = join(homedir(), ".comfy-api-key");
    if (existsSync(keyFile)) {
      const key = readFileSync(keyFile, "utf-8").trim();
      if (key) return key;
    }
  } catch {
    // Unreadable file — behave as if no key is configured.
  }
  return undefined;
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
  comfyuiCodePath: (() => {
    const { path } = normalizeInstallPathEnv(process.env.COMFYUI_CODE_PATH);
    return path ? descendToNestedRoot(path, "COMFYUI_CODE_PATH (env)") : undefined;
  })(),
  comfyuiApiKey: cloudApiKey,
  comfyuiRestartCommand: process.env.COMFYUI_RESTART_COMMAND?.trim() || undefined,
  comfyuiCloudUrl: process.env.COMFYUI_CLOUD_URL,
  comfyuiAuthHeader: process.env.COMFYUI_AUTH_HEADER,
  comfyuiAuthScheme: process.env.COMFYUI_AUTH_SCHEME,
  comfyuiAuthToken: process.env.COMFYUI_AUTH_TOKEN,
  cfAccessClientId: process.env.CF_ACCESS_CLIENT_ID,
  cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
  // HF_TOKEN is the canonical var the huggingface_hub libs read; HUGGINGFACE_TOKEN
  // is a legacy alias we still honor as a fallback.
  huggingfaceToken: process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN,
  githubToken: process.env.GITHUB_TOKEN,
  civitaiApiToken: process.env.CIVITAI_API_TOKEN,
  comfyApiKey: resolveComfyApiKey(),
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

// ── LAZY DOWNLOAD CREDENTIALS (#826) ────────────────────────────────────────
// The two download tokens above are snapshotted from process.env at MODULE LOAD,
// and the canonical .env is read exactly once at boot. In the comfyui MCP CHILD
// that is fatal: `panel_request_secret` writes the token to ~/.comfyui-mcp/.env
// and then relies on the orchestrator RESPAWNING this process to inject it. When
// that respawn does not fire, a snapshotted credential is invisible forever —
// every download keeps returning 401 while a valid token sits on disk, and
// nothing distinguishes "no token configured" from "token present but never
// injected", so an agent following the tool's own advice loops.
//
// Resolve them at ACCESS time instead. A real environment variable still wins;
// otherwise the canonical .env is re-read now (freshSecretValue also handles the
// revoke case, so clearing the slot takes effect without a respawn too). One
// getter covers every consumer of config.civitaiApiToken / config.huggingfaceToken,
// so no call site changes. This removes the structural dependency on the respawn
// rather than papering over it; the respawn remains, as a second path, not the
// only one.
// An EXPLICIT assignment still wins and still works. These fields were plain
// writable properties before, and code (and tests) assign them; a getter-only
// descriptor would make every such assignment throw in strict mode. The override
// is remembered here and cleared by assigning undefined.
const credentialOverrides: { civitaiApiToken?: string; huggingfaceToken?: string } = {};

Object.defineProperty(config, "civitaiApiToken", {
  get: () => credentialOverrides.civitaiApiToken ?? freshSecretValue("CIVITAI_API_TOKEN"),
  set: (v: string | undefined) => {
    credentialOverrides.civitaiApiToken = v;
  },
  enumerable: true,
  configurable: true,
});
Object.defineProperty(config, "huggingfaceToken", {
  // HF_TOKEN is the canonical var the huggingface_hub libs read; HUGGINGFACE_TOKEN
  // is a legacy alias we still honor as a fallback (same order as the boot parse).
  // freshSecretValue resolves each alias FULLY before the next, so the canonical
  // name wins whichever side it came from.
  get: () =>
    credentialOverrides.huggingfaceToken ?? freshSecretValue("HF_TOKEN", "HUGGINGFACE_TOKEN"),
  set: (v: string | undefined) => {
    credentialOverrides.huggingfaceToken = v;
  },
  enumerable: true,
  configurable: true,
});

/** The canonical dotenv path this process reads credentials from. Re-exported so
 *  the orchestrator can name the file it wrote in a user-facing message without
 *  duplicating the resolution rule. Contains no secret. */
export function credentialEnvFilePath(): string {
  return comfyuiEnvFilePath();
}

// Process-start ComfyUI target, captured before any runtime retarget (RunPod
// connect / panel "Local" switch), so a "switch back to local" can restore it.
// If the process itself booted pointed at a remote host, fall back to the
// conventional loopback default so the Local action still means "this machine".
const bootComfyui = {
  host: config.comfyuiHost,
  port: config.resolvedPort,
  ssl: config.comfyuiSsl,
  basePath: config.comfyuiBasePath,
};

/** True when a host is a RunPod proxy (a pod) — the pod/not-pod boundary the
 *  host indicator + local-fallback logic share. */
function isRunpodProxyHost(host: string): boolean {
  return /\.proxy\.runpod\.net$/i.test(host);
}

/** "Local" for the fallback means THIS machine or a private-LAN rig — NOT an
 *  arbitrary remote host: booting against a VPS must still fall back to
 *  loopback (codex finding; the pre-#269 behavior deliberately did). The
 *  numeric ranges apply ONLY to IP literals — a DNS name like
 *  `192.168.example.com` or `fd.example.com` is NOT private (codex finding). */
function isLocalOrLanHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isLoopbackHost(h)) return true;
  // Local DNS forms: bare single-label names (comfybox), mDNS/home suffixes —
  // only when NOT an IP literal (a public IPv6 like 2001:4860::8888 has no dot
  // and must not pass as a bare hostname — codex finding).
  if (!h.includes(".") && isIP(h) === 0) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  if (isIP(h) === 0) return false; // other DNS names — only IP literals get range checks
  return (
    h.startsWith("10.") ||
    h.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^f[cd]/.test(h) || // IPv6 ULA fc00::/7 (fc00–fdff)
    /^fe[89ab][0-9a-f]:/.test(h) // IPv6 link-local fe80::/10 (fe80–febf)
  );
}

/** True when the ACTIVE target is a pod. */
export function isTargetingPod(): boolean {
  return isRunpodProxyHost(config.comfyuiHost);
}

/** True when the ACTIVE target is this machine or a private-LAN rig — the
 *  panels' `is_local` frame predicate (#269): a RunPod pod is false, a
 *  loopback/LAN rig is true, and a generic remote host (VPS, cloud) is ALSO
 *  false — neither "local" nor "pod" (codex rounds on both sides of this). */
export function isTargetingLocalOrLan(): boolean {
  return isLocalOrLanHost(config.comfyuiHost);
}

/** The most recent NON-POD target ("local" = this rig or a LAN rig — #269).
 *  Seeded from the boot target when that IS local/LAN (a VPS/pod boot seeds
 *  nothing; cloud mode's placeholder port 0 is treated as unknown). When the
 *  boot is NOT local/LAN — e.g. a self-restart that inherited the POD url
 *  through the mutated process env — the last learned target is restored from
 *  disk instead (codex finding: restarts forgot the LAN rig and fell back to
 *  127.0.0.1). Advanced by setComfyuiTarget + persisted on every change. */
/** The saved-target path. Default is profile-global; an orchestrator sets
 *  COMFYUI_MCP_LOCAL_TARGET_FILE to a port-scoped path at startup so parallel
 *  orchestrators for DIFFERENT rigs never restore each other's rig (codex
 *  finding). Evaluated per call so the startup assignment takes effect. */
function localTargetFile(): string {
  return process.env.COMFYUI_MCP_LOCAL_TARGET_FILE || join(homedir(), ".comfyui-mcp", "local-target.json");
}

function readSavedLocalTarget(): string | null {
  try {
    const v = JSON.parse(readFileSync(localTargetFile(), "utf-8")) as { url?: unknown };
    return typeof v?.url === "string" ? v.url : null;
  } catch {
    return null;
  }
}

const bootLocalTarget =
  isLocalOrLanHost(bootComfyui.host) && bootComfyui.port > 0
    ? `${bootComfyui.ssl ? "https" : "http"}://${bootComfyui.host}:${bootComfyui.port}${bootComfyui.basePath}`
    : null;
// Restore the saved target ONLY for the pod/restart boot (a self-restart
// inherits the pod URL through the mutated env) — a deliberate boot against a
// VPS must fall back to loopback, not a stale saved rig (codex finding).
let lastNonPodTarget: string | null = bootLocalTarget ?? (isRunpodProxyHost(bootComfyui.host) ? readSavedLocalTarget() : null);
// A deliberate boot against an explicit non-local, non-pod URL invalidates the
// saved rig for this session (codex finding: the stale LAN file was later
// restored after a pod retarget + restart, pointing use_local at the old rig).
// Cloud boots (API key, no explicit URL) leave it alone.
if (!bootLocalTarget && !isRunpodProxyHost(bootComfyui.host) && process.env.COMFYUI_URL?.trim() && !isLoopbackHost(bootComfyui.host)) {
  try {
    rmSync(localTargetFile(), { force: true });
  } catch {
    /* no saved file */
  }
}

/** The loopback-or-LAN ComfyUI URL to fall back to when leaving a remote pod.
 *  "Local" means the most recent non-pod target (boot or learned), falling
 *  back to the loopback default only when nothing non-pod is known (#269:
 *  forcing 127.0.0.1 broke rigs whose local ComfyUI lives on another LAN host). */
export function getLocalComfyuiUrl(): string {
  return lastNonPodTarget ?? "http://127.0.0.1:8188";
}

/**
 * The orchestrator's PROCESS-START local ComfyUI base URL, captured at boot from
 * COMFYUI_URL/argv/defaults and NEVER mutated by a runtime retarget (a panel
 * `hello` calls setComfyuiTarget, which does NOT touch this snapshot). Returns null
 * unless boot pointed at a LOOPBACK instance with a resolved port. Use this — not
 * getComfyUIBaseUrl(), which a client `hello` can steer — as the SERVER-AUTHORIZED
 * target for a self-probe that must not be client-influenced (#509 security).
 */
export function getBootLocalComfyUIBaseUrl(): string | null {
  if (!isLoopbackHost(bootComfyui.host) || !(bootComfyui.port > 0)) return null;
  return `${bootComfyui.ssl ? "https" : "http"}://${bootComfyui.host}:${bootComfyui.port}${bootComfyui.basePath}`;
}

/** #1909: COMFYUI_URL / --comfyui-url may be assigned after this module's init
 *  (boot.ts `connect` writes it after the static import). Re-read so a loopback
 *  host on a non-default port is persisted as that origin, not :8188. This is
 *  still process-start — rescope runs once before hellos, and setComfyuiTarget
 *  still cannot mutate bootComfyui. */
function adoptLiveConfiguredLocalTarget(): void {
  const live = resolveUrlOverride();
  if (!live || !isLocalOrLanHost(live.host) || !(live.port > 0)) return;
  const liveUrl = `${live.ssl ? "https" : "http"}://${live.host}:${live.port}${live.basePath}`;
  lastNonPodTarget = liveUrl;
  if (!isLoopbackHost(live.host)) return;
  // The configured loopback origin IS the process-start local instance.
  bootComfyui.host = live.host;
  bootComfyui.port = live.port;
  bootComfyui.ssl = live.ssl;
  bootComfyui.basePath = live.basePath;
  config.comfyuiHost = live.host;
  config.comfyuiPort = live.port;
  config.resolvedPort = live.port;
  config.comfyuiSsl = live.ssl;
  config.comfyuiBasePath = live.basePath;
}

/** Orchestrator startup hook: re-point the saved-target file (port-scoped, so
 *  parallel orchestrators for different rigs never restore each other's rig)
 *  and re-restore when booted on a pod — the module-init restore ran before
 *  the scoped path was known (codex finding). */
export function rescopeLocalTargetFile(path: string): void {
  process.env.COMFYUI_MCP_LOCAL_TARGET_FILE = path;
  // The deliberate non-local, non-pod boot invalidation from module init ran
  // BEFORE this scoped path existed — repeat it here, or the stale scoped file
  // resurrects the old LAN rig after a pod retarget + restart (codex finding).
  if (!bootLocalTarget && !isRunpodProxyHost(bootComfyui.host) && process.env.COMFYUI_URL?.trim() && !isLoopbackHost(bootComfyui.host)) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* no saved file */
    }
    lastNonPodTarget = null;
    return;
  }
  if (isRunpodProxyHost(bootComfyui.host)) {
    // Pod/restart boot: the SCOPED file is THIS orchestrator's rig — it wins
    // over any profile-global value the module-init restore picked up (codex
    // finding: a headless session's global save defeated the port isolation).
    lastNonPodTarget = readSavedLocalTarget();
  }
  // A live loopback/LAN COMFYUI_URL is not a pod URL, so this will not clobber
  // a pod boot's scoped LAN restore above.
  adoptLiveConfiguredLocalTarget();
  if (lastNonPodTarget !== null) {
    // Persist into the scoped file so the next restart restores it — a direct
    // LAN boot otherwise lives in memory only and the pod-inherited restart
    // falls back to 127.0.0.1 (codex finding).
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ url: lastNonPodTarget }));
    } catch {
      /* best-effort */
    }
  }
}

/** True when the ACTIVE ComfyUI target is loopback (renders run on this machine
 *  rather than a remote pod) — the honest-host-indicator predicate. */
export function isTargetingLocal(): boolean {
  return isLoopbackHost(config.comfyuiHost);
}

// ── Target-change subscribers (honest host indicator) ────────────────────────
// setComfyuiTarget() fires these so the orchestrator can broadcast a
// `comfyui_target` frame to the control panels the moment renders move between
// local and a RunPod pod — the UI must never lie about where a job runs.
type ComfyuiTargetListener = (url: string, isLocal: boolean) => void;
const comfyuiTargetListeners = new Set<ComfyuiTargetListener>();

// ── Target generation (#742 r11/r12) ─────────────────────────────────────────
// Monotonic epoch bumped in setComfyuiTarget BEFORE the mutation is
// observable, so any observer of the new target value (including synchronous
// target-change listeners) always sees the new generation with it — the
// target-generation contract. A final-state base comparison (A vs A) cannot
// detect an intervening A→B→A mutation, so consumers that read the mutable
// target across an await (e.g. the panel restart's refuse-safe preflight)
// must instead require the GENERATION to be unchanged after the await — any
// mutation, including a round trip back to the same base, bumps it.
let comfyuiTargetGeneration = 0;

/** The current target generation — increments on every successful setComfyuiTarget. */
export function getComfyuiTargetGeneration(): number {
  return comfyuiTargetGeneration;
}

export function onComfyuiTargetChanged(cb: ComfyuiTargetListener): () => void {
  comfyuiTargetListeners.add(cb);
  return () => comfyuiTargetListeners.delete(cb);
}
function emitComfyuiTargetChanged(): void {
  const url = getComfyUIBaseUrl();
  // is_local = loopback/LAN rig (#269): pod → false, VPS/cloud remote → false
  // (neither local nor pod), restored LAN rig → true. One predicate for the
  // seed frame and every change frame.
  const local = isTargetingLocalOrLan();
  for (const cb of comfyuiTargetListeners) {
    try {
      cb(url, local);
    } catch {
      // A subscriber must never break a retarget.
    }
  }
}

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

/**
 * True when the configured ComfyUI target is provably on THIS machine (#742).
 *
 * Distinct from `isLocalMode()`, which reports the classification. This reports
 * the physical question that classification stands in for, and the two disagree
 * for exactly one case: a local instance addressed by one of this host's own
 * non-loopback addresses. That case is `isRemoteMode() === true` and
 * `targetIsOnThisMachine() === true`, and it is the #742 recurrence.
 *
 * `--force-remote` / `COMFYUI_MCP_FORCE_REMOTE` wins outright. A tunnel or
 * port-forward makes the address say "here" about an instance that is
 * elsewhere, and the flag exists for the user to say so; an inference must not
 * overrule it. (This is the mirror of the note in panel-tools about a cloud pod
 * fronted at 127.0.0.1.)
 */
export function targetIsOnThisMachine(): boolean {
  if (forceRemote) return false;
  try {
    return isOwnHostAddress(new URL(getComfyUIBaseUrl()).hostname);
  } catch {
    return false; // unparseable target — cannot prove it is ours
  }
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

/**
 * Retarget the shared `config` (and thus getComfyUIApiHost()/getClient()) to a new
 * ComfyUI URL at runtime. The panel orchestrator calls this from applyComfyuiUrl when
 * the desktop `hello` points at a different ComfyUI, so the orchestrator's OWN
 * in-process client — the direct call_tool path used by the mobile app
 * (get_workflow, get_image, …) — follows the retarget instead of staying pinned to the process-start
 * ComfyUI. Callers MUST resetClient() afterwards so the cached client rebuilds against
 * the new host. Returns false on a malformed URL (target left unchanged).
 */
export function setComfyuiTarget(url: string): boolean {
  let t: ComfyUITarget;
  try {
    t = parseComfyUIUrl(url);
  } catch {
    return false;
  }
  // Bump the target generation BEFORE the mutation is observable (#742 r12):
  // the contract is that ANY observer of the new target value — including a
  // synchronous target-change listener fired below — sees the new generation
  // with it. The reverse ordering (new target fanned out with the old epoch)
  // is the violation; a post-parse failure leaving the epoch advanced is
  // harmless by comparison (consumers like the #742 r10 check simply refuse
  // conservatively), and nothing past this point can fail the retarget anyway.
  comfyuiTargetGeneration += 1;
  config.comfyuiHost = t.host;
  config.comfyuiPort = t.port;
  config.resolvedPort = t.port;
  config.comfyuiSsl = t.ssl;
  config.comfyuiBasePath = t.basePath;
  // Re-classify local vs remote so isRemoteMode()/isLocalMode() follow the new
  // target — they read this module-level flag, not the host on each call, so a
  // retarget that crosses the loopback boundary would otherwise stay misclassed.
  remoteUrlActive = forceRemote || !isLoopbackHost(t.host);
  // Keep comfyuiPath consistent with the mode: a remote target has no local FS
  // (local-FS tools must throw), a loopback target re-resolves the local path
  // (honoring COMFYUI_PATH). Without this, remote→local leaves path undefined and
  // local→remote leaves a stale local path that FS tools would wrongly trust.
  config.comfyuiPath = resolveComfyUIPath(process.env.COMFYUI_PATH, {
    remoteUrl: remoteUrlActive,
    cloud: isCloudMode(),
    remoteHost: t.host,
  });
  // Track the newest local/LAN non-pod target — it is what "Local" means from
  // now on (boot may have been loopback while the real rig was learned later,
  // #269). A VPS or other generic remote target is NOT a local fallback.
  // Persisted: an orchestrator self-restart boots on the POD url (env was
  // mutated) and would otherwise forget the rig (codex finding).
  if (isLocalOrLanHost(t.host)) {
    lastNonPodTarget = `${t.ssl ? "https" : "http"}://${t.host}:${t.port}${t.basePath}`;
    try {
      mkdirSync(dirname(localTargetFile()), { recursive: true });
      writeFileSync(localTargetFile(), JSON.stringify({ url: lastNonPodTarget }));
    } catch {
      /* best-effort */
    }
  }
  // Keep the process env in step: readers like reportDownloadProgress stamp
  // from COMFYUI_URL, and a runtime retarget must not leave them pinning the
  // process-start host (codex finding).
  process.env.COMFYUI_URL = url;
  // We are pointed at a DIFFERENT ComfyUI now, so the detected ComfyUI-Manager
  // dialect describes the previous one. It is normally keyed by base URL and
  // would simply miss — but a round trip (local → pod → local) can land back on
  // an identical base string whose server was restarted meanwhile, which is
  // exactly the stale-dialect case #646 is about. Drop it at the canonical
  // retarget choke point rather than relying on the key.
  resetManagerApiCache("comfyui target changed");
  // Tell the control panels where renders run now (local ⇄ pod).
  emitComfyuiTargetChanged();
  return true;
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
  const headers: Record<string, string> = {};
  const token = config.comfyuiAuthToken?.trim();
  if (token) {
    const header = config.comfyuiAuthHeader?.trim() || "Authorization";
    // An unset/empty scheme defaults to "Bearer" for the Authorization header and
    // to none (raw token) for any custom header. Set COMFYUI_AUTH_SCHEME to force
    // a specific scheme (e.g. "Token").
    const scheme =
      config.comfyuiAuthScheme?.trim() ||
      (header.toLowerCase() === "authorization" ? "Bearer" : "");
    headers[header] = scheme ? `${scheme} ${token}` : token;
  }
  // Cloudflare Access service token — sent as a PAIR (both headers) or not at all,
  // so a half-configured token never produces a broken request. Additive: works
  // alongside or instead of COMFYUI_AUTH_TOKEN, and applies to every ComfyUI
  // endpoint (harmless on endpoints not behind Cloudflare Access — they ignore it).
  const cfId = config.cfAccessClientId?.trim();
  const cfSecret = config.cfAccessClientSecret?.trim();
  if (cfId && cfSecret) {
    headers["CF-Access-Client-Id"] = cfId;
    headers["CF-Access-Client-Secret"] = cfSecret;
  }
  return headers;
}
