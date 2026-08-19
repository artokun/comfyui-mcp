// Per-provider readiness, computed on the machine that actually RUNS the agents
// (this orchestrator = the user's laptop) — NOT on the ComfyUI host.
//
// The panel's ComfyUI-side Python (comfyui-mcp-panel/__init__.py) also probes
// readiness, but it runs wherever ComfyUI runs. In the "remote ComfyUI, local
// agent" model that's the POD, which has no provider CLIs and no logins, so it
// always reports "CLI not installed" even though the agent is happily running on
// the laptop. This module lets the orchestrator report the TRUTH over the bridge,
// which the panel then prefers (see comfyui-mcp-panel: applyReadiness on a
// {type:"backends"} bridge frame).

import { existsSync, readFileSync } from "node:fs";
import { kimiCodeAuthCandidates } from "../services/code-provider-auth.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { readOAuthStatus } from "../services/code-provider-auth.js";
import { resolveAgyBin } from "./antigravity-backend.js";
import { resolvePiBin } from "./pi-backend.js";
// pi's credential detection is large enough (pi's whole env map + auth.json /
// models.json / Vertex-ADC parsing) to live in its own module; re-exported below
// so existing importers of `piCredentialPresent` are unaffected.
import { piCredentialPresent } from "./pi-credentials.js";
import type { OAuthStatusRecord } from "../services/panel-secrets.js";
import { simpleKeyProvider } from "../services/openai-provider-registry.js";

export { piCredentialPresent } from "./pi-credentials.js";

export type BackendReadiness = {
  backend: string;
  /** The provider's runtime is present (a CLI on PATH, or — for Claude — the SDK). */
  cli: boolean;
  /** A usable login exists. null = unknown (don't nag). */
  auth: boolean | null;
  /** cli && auth-not-false. */
  ready: boolean;
  /** True only for providers the panel must label/gate as experimental (ToS
   *  risk, unverified contract) — currently just copilot. Omitted (not merely
   *  false) for every other backend so this frame stays a pure ADDITION for
   *  existing consumers/tests. */
  experimental?: boolean;
  /** Discovery-only signal used for automatic selection. `ready` retains its
   *  historical install/config semantics; `available` means usable right now.
   *  Optional so older panel/orchestrator pairs remain wire-compatible. */
  available?: boolean;
};

export type BackendDiscoveryOptions = {
  home?: string;
  ollamaBaseUrl?: string;
  ollamaApi?: "ollama" | "openai";
  lmstudioBaseUrl?: string;
  llamacppBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

// CLI binary names per provider (Windows resolves .cmd/.exe via PATHEXT, but we
// probe the common variants explicitly to match the panel's Python).
const CLI_NAMES: Record<string, string[]> = {
  codex: ["codex", "codex.cmd", "codex.exe"],
  gemini: ["gemini", "gemini.cmd", "gemini.exe"],
  grok: ["grok", "grok.cmd", "grok.exe"],
  qwen: ["qwen", "qwen.cmd", "qwen.exe"],
  pi: ["pi", "pi.exe"], // no .cmd — Node can't shell-lessly spawn it (see resolvePiBin)
  ollama: ["ollama", "ollama.exe"],
  lmstudio: ["lms", "lms.exe"],
  llamacpp: ["llama-server", "llama-server.exe"],
};

/** Well-known Ollama install locations probed in addition to PATH (the Windows
 *  installer adds PATH for NEW shells only — an orchestrator started from an
 *  older shell would false-flag "not installed"). */
function ollamaInstalled(home: string): boolean {
  if (onPath(CLI_NAMES.ollama)) return true;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return fileExists(localAppData, "Programs", "Ollama", "ollama.exe");
  }
  return fileExists("/usr/local/bin/ollama") || fileExists("/opt/homebrew/bin/ollama");
}

/** LM Studio install signals: the app drops its `lms` CLI at ~/.lmstudio/bin on
 *  every platform (best cross-OS marker), plus the per-OS app locations. */
function lmstudioInstalled(home: string): boolean {
  if (lmstudioCliPath(home)) return true;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return fileExists(localAppData, "Programs", "LM Studio", "LM Studio.exe");
  }
  if (process.platform === "darwin") return fileExists("/Applications", "LM Studio.app");
  return fileExists(home, ".lmstudio");
}

/** Absolute path (or bare name if on PATH) of the `lms` CLI — the supported
 *  programmatic surface for load/unload/server lifecycle. Used by
 *  services/lmstudio-lifecycle to shell out even when PATH lacks it (the app
 *  adds ~/.lmstudio/bin to PATH for NEW shells only). Null when not found. */
export function lmstudioCliPath(home: string = homedir()): string | null {
  if (onPath(CLI_NAMES.lmstudio)) return "lms";
  const binName = process.platform === "win32" ? "lms.exe" : "lms";
  const inHome = join(home, ".lmstudio", "bin", binName);
  if (fileExists(inHome)) return inHome;
  return null;
}

/** True if any of `names` resolves on the local PATH. */
function onPath(names: string[]): boolean {
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = (process.env.PATH || "").split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      try {
        if (existsSync(join(dir, name))) return true;
      } catch {
        // unreadable PATH entry — skip
      }
    }
  }
  return false;
}

/** True if <geminiHome>/.gemini/settings.json selects API-key auth
 *  (security.auth.selectedType === "gemini-api-key"). This is an
 *  env-independent "configured for API key" signal (issue #456): the gemini CLI
 *  writes it on `/auth` → "Gemini API key" and it persists across processes,
 *  unlike GEMINI_API_KEY which the orchestrator only inherits if set before
 *  launch. Never throws — a missing/corrupt file just means "no signal". */
function geminiSettingsUsesApiKey(geminiHome: string): boolean {
  try {
    const raw = readFileSync(join(geminiHome, ".gemini", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      security?: { auth?: { selectedType?: unknown } };
    };
    return parsed?.security?.auth?.selectedType === "gemini-api-key";
  } catch {
    return false;
  }
}

/** True if <home>/.qwen/settings.json selects an auth type
 *  (security.auth.selectedType is a non-empty string) — the env-independent
 *  "configured" signal for Qwen Code, mirroring geminiSettingsUsesApiKey. `/auth`
 *  writes it and it persists across processes, unlike DASHSCOPE_API_KEY which
 *  the orchestrator only inherits if set before launch. A stale or keyless
 *  selection still surfaces via the connect ack's model probe (degraded), same
 *  as every other provider. Never throws — a missing/corrupt file just means
 *  "no signal". */
function qwenSettingsConfigured(home: string): boolean {
  try {
    const raw = readFileSync(join(home, ".qwen", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      security?: { auth?: { selectedType?: unknown } };
    };
    const t = parsed?.security?.auth?.selectedType;
    return typeof t === "string" && t.trim().length > 0;
  } catch {
    return false;
  }
}

function fileExists(...parts: string[]): boolean {
  try {
    return existsSync(join(...parts));
  } catch {
    return false;
  }
}

function claudeCredentialPresent(home: string): boolean {
  try {
    const raw = JSON.parse(
      readFileSync(join(home, ".claude", ".credentials.json"), "utf8"),
    ) as { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown } };
    const oauth = raw?.claudeAiOauth;
    return [oauth?.accessToken, oauth?.refreshToken].some(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
  } catch {
    return false;
  }
}

function staticAvailability(readiness: BackendReadiness, home: string): boolean {
  if (["ollama", "lmstudio", "llamacpp"].includes(readiness.backend)) return false;
  if (readiness.backend === "claude") return claudeCredentialPresent(home);
  return readiness.ready;
}

function modelsEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

async function probeJsonShape(
  url: string,
  valid: (value: unknown) => boolean,
  options: Required<Pick<BackendDiscoveryOptions, "timeoutMs" | "fetchImpl">>,
): Promise<boolean> {
  try {
    const response = await options.fetchImpl(url, {
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    return valid(await response.json());
  } catch {
    return false;
  }
}

/** Overlay live local-service availability onto the static snapshot. Raw open
 *  ports do not count: every endpoint must return its provider's JSON shape. */
export async function discoverBackendAvailability(
  snapshot: BackendReadiness[],
  options: BackendDiscoveryOptions = {},
): Promise<BackendReadiness[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const ollamaBase = (options.ollamaBaseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const lmstudioBase = options.lmstudioBaseUrl ?? "http://127.0.0.1:1234/v1";
  const llamacppBase = options.llamacppBaseUrl ?? "http://127.0.0.1:8080/v1";
  const json = { fetchImpl, timeoutMs };
  const checks = new Map<string, Promise<boolean>>([
    [
      "ollama",
      options.ollamaApi === "openai"
        ? probeJsonShape(modelsEndpoint(ollamaBase), (v) => Array.isArray((v as { data?: unknown })?.data), json)
        : probeJsonShape(`${ollamaBase.replace(/\/v1$/i, "")}/api/tags`, (v) => Array.isArray((v as { models?: unknown })?.models), json),
    ],
    [
      "lmstudio",
      probeJsonShape(modelsEndpoint(lmstudioBase), (v) => Array.isArray((v as { data?: unknown })?.data), json),
    ],
    [
      "llamacpp",
      probeJsonShape(modelsEndpoint(llamacppBase), (v) => Array.isArray((v as { data?: unknown })?.data), json),
    ],
  ]);
  const live = new Map<string, boolean>();
  await Promise.all(
    [...checks].map(async ([backend, check]) => live.set(backend, await check)),
  );
  return snapshot.map((entry) => {
    if (!live.has(entry.backend)) return entry;
    const available = live.get(entry.backend) === true;
    return {
      ...entry,
      available,
      // A reachable local service is usable even if its binary/app lives outside
      // our install probes. Preserve cli=false when stopped so the UI can still
      // distinguish "not installed" from "installed but not running".
      ...(available ? { cli: true, auth: true, ready: true } : {}),
    };
  });
}

/** The panel's in-panel-OAuth status records — injectable for tests (so a test
 *  never has to touch the real ~/.comfyui-mcp/panel-secrets.json), defaulting
 *  to the real store. Never throws — a corrupt/missing store just means "no
 *  panel sign-ins known", not a readiness crash. */
function panelOAuthRecords(opts?: { oauthStatus?: OAuthStatusRecord[]; home?: string }): OAuthStatusRecord[] {
  if (opts?.oauthStatus) return opts.oauthStatus;
  try {
    // Thread the (test-injectable) home through — readOAuthStatus also detects
    // native CLI auth files under it, and reading the REAL home from inside a
    // test-scoped readiness probe would leak the developer's own logins.
    return readOAuthStatus(opts?.home);
  } catch {
    return [];
  }
}

/** True if `providerId` has an in-panel OAuth status entry that isn't expired.
 *  A record with no `expires_at` (copilot's device-code tokens, e.g.) is
 *  treated as "no known expiry" — mirrors the resolvers' own tokenExpiring()
 *  semantics in code-provider-auth.ts, which likewise never expires a token
 *  it has no expiry info for. */
function hasValidPanelOAuth(providerId: string, records: OAuthStatusRecord[], nowMs: number): boolean {
  const rec = records.find((r) => r.provider === providerId);
  if (!rec) return false;
  if (typeof rec.expires_at !== "number") return true;
  return rec.expires_at * 1000 > nowMs;
}

/**
 * Readiness for one backend, evaluated locally.
 *
 * - claude: the orchestrator IS the Claude Agent SDK host — no separate CLI. If
 *   this process is running we can attempt Claude; a genuinely dead/unsigned
 *   Claude still surfaces via the connect ack's model probe (degraded). So we
 *   report it usable here rather than false-flagging "CLI not installed".
 * - codex/gemini: the CLI must be on PATH AND a login cached on disk.
 */
export function backendReadiness(
  backend: string,
  opts?: {
    home?: string;
    customEndpointConfigured?: boolean;
    oauthStatus?: OAuthStatusRecord[];
    now?: number;
  },
): BackendReadiness {
  const b = (backend || "").toLowerCase();
  const home = opts?.home ?? homedir();
  const nowMs = opts?.now ?? Date.now();
  if (b === "claude") {
    return { backend: "claude", cli: true, auth: true, ready: true };
  }
  if (b === "codex") {
    const cli = onPath(CLI_NAMES.codex);
    // The panel's in-panel OAuth for codex writes the SAME ~/.codex/auth.json
    // an external `codex login` would (see persistOAuthResult), so the native
    // file check below already picks it up in practice — the OAuth-status
    // check is kept as an explicit, independent signal (belt-and-suspenders,
    // and the only signal at all for a provider with no dedicated file check).
    const auth =
      fileExists(home, ".codex", "auth.json") ||
      hasValidPanelOAuth("codex", panelOAuthRecords(opts), nowMs);
    return { backend: "codex", cli, auth, ready: cli && auth };
  }
  if (b === "chatgpt") {
    // Direct Codex OAuth — no CLI; ~/.codex/auth.json from `codex login`.
    const auth = fileExists(home, ".codex", "auth.json");
    return { backend: "chatgpt", cli: true, auth, ready: !!auth };
  }
  const simpleKeyReg = simpleKeyProvider(b);
  if (simpleKeyReg) {
    // Simple OpenAI-compatible api-key providers (glm, moonshot, …) — hosted, no
    // CLI. Readiness = one of the provider's env keys is set (a bad key still
    // surfaces via the connect ack's model probe → degraded). Derived from the
    // openai-provider-registry so a new such provider needs no branch here.
    // `kimi` is deliberately EXCLUDED (simpleKeyAuth=false): its dual OAuth-or-
    // KIMI_API_KEY readiness is kept bespoke just below.
    const auth = simpleKeyReg.envKeys.some((k) => !!process.env[k]?.trim());
    return { backend: b, cli: true, auth, ready: auth };
  }
  if (b === "kimi") {
    const apiKey = process.env.KIMI_API_KEY?.trim();
    // Asks the SAME resolver the auth path uses. This used to re-derive the location
    // and looked only in the legacy ~/.kimi, so a user signed in with the current
    // kimi-code CLI (~/.kimi-code) was reported {auth:false, ready:false} while their
    // credentials resolved fine everywhere else — and the panel told them they were not
    // signed in.
    const oauth = kimiCodeAuthCandidates(home).some((p) => existsSync(p));
    const auth = !!apiKey || oauth;
    return { backend: "kimi", cli: true, auth, ready: auth };
  }
  if (b === "gemini") {
    const cli = onPath(CLI_NAMES.gemini);
    // API-key auth is a first-class gemini CLI mode and writes NO
    // oauth_creds.json (issue #456). Mirror the kimi branch and accept ANY of:
    //   1. GEMINI_API_KEY / GOOGLE_API_KEY in the orchestrator's env, or
    //   2. Google OAuth cached at <home>/.gemini/oauth_creds.json (or
    //      GEMINI_CLI_HOME when set), or
    //   3. an env-independent "configured for API key" signal —
    //      <home>/.gemini/settings.json with
    //      security.auth.selectedType === "gemini-api-key". This lets a user
    //      who authed with a key before ComfyUI launched (so the key isn't in
    //      this process's env yet) still read as ready rather than "not signed
    //      in"; a genuinely-bad/absent key surfaces via the connect ack's model
    //      probe (degraded), same as every other key provider.
    const geminiHome = process.env.GEMINI_CLI_HOME || home;
    const apiKey =
      !!(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim());
    const oauth = fileExists(geminiHome, ".gemini", "oauth_creds.json");
    const apiKeyConfigured = geminiSettingsUsesApiKey(geminiHome);
    const auth = apiKey || oauth || apiKeyConfigured;
    return { backend: "gemini", cli, auth, ready: cli && auth };
  }
  if (b === "antigravity") {
    // Antigravity CLI (`agy`, issue #262) — Google subscription (AI Pro/Ultra).
    // Auth lives in the system keyring, which we deliberately do NOT read
    // (per #262: no token extraction) — so auth is UNKNOWN (null, don't nag)
    // when the CLI is present; the real auth signal is the connect ack's
    // `agy models` probe, which degrades with sign-in guidance when it fails.
    // resolveAgyBin covers COMFYUI_MCP_ANTIGRAVITY_PATH, PATH, and the official
    // installers' well-known locations (%LOCALAPPDATA%\agy\bin, ~/.local/bin).
    const cli = !!resolveAgyBin(home);
    return { backend: "antigravity", cli, auth: cli ? null : false, ready: cli };
  }
  if (b === "pi") {
    // pi.dev CLI (`pi`, issue #491) — a multi-provider coding agent. Auth lives
    // in ~/.pi/agent/auth.json (API keys + `/login` subscriptions) or provider
    // env vars. UNLIKE agy, `pi --list-models` is NOT an auth probe (it prints
    // the built-in catalog with no key), so readiness must NOT key off the CLI
    // alone — that would greet a keyless pi green-ready and then fail its first
    // turn (issue #491 codex P1a). We report ready ONLY when a WELL-FORMED,
    // PRESENT credential is verifiable — see pi-credentials.ts, which mirrors
    // pi's own resolution (its full provider env map minus the keys our spawn
    // env strips, a parsed auth.json record that actually carries a key/token, a
    // JSONC models.json provider with its own apiKey/oauth, or Google Vertex ADC
    // with an existing credentials file plus project+location). When the CLI is
    // present but no credential is verifiable, auth is UNKNOWN (null) and ready
    // is FALSE — the panel then shows "configure a provider", not green.
    // Residual (accepted, and the UI wording must not over-promise): a present
    // but revoked/quota-exhausted key is indistinguishable from a good one here
    // and still fails on the first turn.
    const cli = !!resolvePiBin(home);
    const authKnown = piCredentialPresent(home);
    const auth = authKnown ? true : cli ? null : false;
    return { backend: "pi", cli, auth, ready: cli && authKnown };
  }
  if (b === "grok") {
    const cli = onPath(CLI_NAMES.grok);
    // Same reasoning as codex above: the panel's in-panel OAuth writes the
    // same ~/.grok/auth.json an external `grok` login would.
    const auth =
      fileExists(home, ".grok", "auth.json") ||
      hasValidPanelOAuth("grok", panelOAuthRecords(opts), nowMs);
    return { backend: "grok", cli, auth, ready: cli && auth };
  }
  if (b === "qwen") {
    // Qwen Code CLI (`qwen --acp`, issue #1417). `.cmd` IS probed — unlike pi,
    // we spawn through the shell on Windows (see qwen-backend resolveSpawn), so
    // a `qwen.cmd` shim is genuinely runnable. Auth (the CLI owns it) reads as
    // present when ANY of: a Qwen-side key is in the orchestrator's env
    // (DASHSCOPE_API_KEY / BAILIAN_CODING_PLAN_API_KEY / OPENAI_API_KEY), cached
    // OAuth creds exist at <home>/.qwen/oauth_creds.json (the free tier ended
    // 2026-04-15, but a Coding Plan key configured via /auth lands in
    // settings.json — covered by the next signal), or ~/.qwen/settings.json
    // selects an auth type (the env-independent "configured" signal, mirroring
    // the gemini branch's settings check — this also covers the generic
    // OPENAI_API_KEY + selectedType:"openai" setup, which a bare env probe
    // can't distinguish from an unrelated OPENAI_API_KEY the user set for
    // something else). A stale/bad credential still surfaces via the connect
    // ack's model probe → degraded, same as every other provider.
    const cli = onPath(CLI_NAMES.qwen);
    const envKey = !!(
      process.env.DASHSCOPE_API_KEY?.trim() ||
      process.env.BAILIAN_CODING_PLAN_API_KEY?.trim()
    );
    const auth =
      envKey ||
      fileExists(home, ".qwen", "oauth_creds.json") ||
      qwenSettingsConfigured(home);
    return { backend: "qwen", cli, auth, ready: cli && auth };
  }
  if (b === "copilot") {
    // No external CLI/native-file concept for Copilot — the in-panel device-
    // code OAuth (experimental, gated behind allow_experimental in
    // oauth-bridge.ts) is the ONLY sign-in path, so it's the only signal here.
    // `experimental: true` lets the panel (Task 7) label/gate this row even
    // once signed in — this backend is opt-in ToS-risk territory, never a
    // default or auto-pick.
    const auth = hasValidPanelOAuth("copilot", panelOAuthRecords(opts), nowMs);
    return { backend: "copilot", cli: true, auth, ready: auth, experimental: true };
  }
  if (b === "ollama") {
    // No login concept — a local daemon. Binary presence is the readiness
    // signal here (mirrors claude's posture); a stopped daemon still surfaces
    // via the connect ack's model probe (GET /api/tags fails → degraded ack).
    const cli = ollamaInstalled(home);
    return { backend: "ollama", cli, auth: cli ? true : null, ready: cli };
  }
  if (b === "lmstudio") {
    // Same posture as ollama: a local server, no login concept. App/CLI
    // presence is the readiness signal; a stopped server still surfaces via
    // the connect ack's model probe (GET /v1/models fails → degraded ack).
    const cli = lmstudioInstalled(home);
    return { backend: "lmstudio", cli, auth: cli ? true : null, ready: cli };
  }
  if (b === "llamacpp") {
    // llama.cpp's llama-server: PATH presence is the install signal (no app
    // dirs — people build it or unzip a release anywhere). A stopped server
    // surfaces via the connect ack's probe; when the binary isn't findable we
    // still allow a REACHABLE server to count (checked at connect), so `cli`
    // false + a live endpoint is fine — mirrors the "installed elsewhere"
    // reality of this tool.
    const cli = onPath(CLI_NAMES.llamacpp);
    return { backend: "llamacpp", cli, auth: cli ? true : null, ready: cli };
  }
  if (b === "custom") {
    // A user-defined OpenAI-compatible endpoint (issue #162) — nothing to
    // install, no login flow. Readiness = a base URL is configured (panel
    // Settings or COMFYUI_MCP_CUSTOM_BASE_URL; the caller passes the resolved
    // truth via opts). A wrong URL or key still surfaces via the connect ack's
    // model probe (degraded), same as every other endpoint provider.
    const configured =
      opts?.customEndpointConfigured ?? !!process.env.COMFYUI_MCP_CUSTOM_BASE_URL;
    return { backend: "custom", cli: configured, auth: configured ? true : null, ready: configured };
  }
  if (b === "openrouter") {
    // Hosted — no CLI. Readiness = an OpenRouter API key in the orchestrator's
    // env (OPENROUTER_API_KEY, or the shared COMFYUI_MCP_OLLAMA_API_KEY). A bad
    // key still surfaces via the connect ack's model probe (degraded).
    const key = !!(process.env.OPENROUTER_API_KEY || process.env.COMFYUI_MCP_OLLAMA_API_KEY);
    return { backend: "openrouter", cli: key, auth: key ? true : false, ready: key };
  }
  return { backend: b, cli: false, auth: false, ready: false };
}

/** Readiness for every known backend, plus a rolled-up any_ready. */
export function allBackendReadiness(
  backends: Iterable<string>,
  opts?: {
    home?: string;
    customEndpointConfigured?: boolean;
    oauthStatus?: OAuthStatusRecord[];
    now?: number;
  },
): {
  backends: BackendReadiness[];
  any_ready: boolean;
} {
  const home = opts?.home ?? homedir();
  const list = [...backends].map((b) => {
    const readiness = backendReadiness(b, opts);
    return { ...readiness, available: staticAvailability(readiness, home) };
  });
  return { backends: list, any_ready: list.some((r) => r.ready) };
}
