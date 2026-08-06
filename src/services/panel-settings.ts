// Persisted panel settings for the orchestrator's background agent. Survives
// soft reloads and full restarts (it's a small JSON file on disk), so a setting
// like the adult-content consent gate stays put and is queryable across the
// session — the agent reads it before deciding whether to surface NSFW work.
//
// The NSFW gate is a SAFETY control: it defaults OFF (keep everything SFW), and
// only flips ON after an explicit, verified-adult opt-in (18+ and adult content
// legal in the user's region). It governs what the system SURFACES and records
// the user's consent. It never overrides hard limits (no minors, no real-person
// sexual deepfakes, no depictions of actual non-consensual acts).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileDurable } from "../utils/durable-write.js";
import { logger } from "../utils/logger.js";
import { assertNotWritingRealHomeInTests } from "./test-isolation-guard.js";

export interface NsfwConsent {
  /** True only after a verified-adult opt-in through the consent gate. */
  allowed: boolean;
  /** ISO timestamp of the most recent consent decision. */
  decidedAt?: string;
}

/** Non-secret connection config for the Ollama/OpenAI-compatible backend.
 *  API keys never live here — they stay in env (OPENROUTER_API_KEY etc.). */
export interface OllamaAgentConfig {
  /** Default model tag/id (e.g. "gemma4:12b", "xiaomi/mimo-v2.5"). */
  model?: string;
  /** "ollama" (local /api/chat) or "openai" (any OpenAI-compatible endpoint). */
  api?: "ollama" | "openai";
  /** Endpoint base URL (e.g. https://openrouter.ai/api/v1, incl. /v1). */
  baseUrl?: string;
}

export interface AgentSettings {
  /** User-curated model ids pinned to the top of the panel's model picker. */
  preferredModels?: string[];
  ollama?: OllamaAgentConfig;
  /** LM Studio provider (issue #160) — same shape; api/baseUrl unused today
   *  (fixed openai dialect + COMFYUI_MCP_LMSTUDIO_HOST) but kept for #162. */
  lmstudio?: OllamaAgentConfig;
  /** llama.cpp provider (issue #161) — same shape as lmstudio. */
  llamacpp?: OllamaAgentConfig;
  /** Custom OpenAI-compatible endpoint (issue #162): baseUrl + model, both
   *  user-supplied. The API key stays in the 0600 secrets store
   *  (COMFYUI_MCP_CUSTOM_API_KEY), never here. */
  custom?: OllamaAgentConfig;
}

/**
 * An EXPLICIT user pin holding the sidebar panel node-pack at one version.
 *
 * A pin is a promise: while it is set, nothing in this codebase may move the
 * panel — not the auto-sync skill, not `install_comfyui(action:'panel', panel_action:'update')`, not the
 * on-load auto-installer. The user cleared it or nothing happens. See
 * `panel-sync.ts` for the decision logic that honours it.
 */
export interface PanelVersionPin {
  /** The exact panel version the user pinned to, e.g. "0.11.20". */
  version: string;
  /** ISO timestamp of when the pin was set (absent for an env-var pin). */
  pinnedAt?: string;
  /** Optional free-text reason the user gave for pinning. */
  reason?: string;
}

/**
 * The resolved pin, including WHERE it came from — the caller must be able to
 * tell the user how to clear it, and an env pin cannot be cleared by writing the
 * settings file.
 */
export interface PanelPinState {
  /** True when a pin is in force. Nothing may move the panel while true. */
  pinned: boolean;
  /** The pinned version (only when `pinned`). */
  version?: string;
  /** Where the active pin came from; "none" when unpinned. */
  source: "env" | "settings" | "none";
  pinnedAt?: string;
  reason?: string;
  /**
   * The settings file EXISTS but could not be read/parsed, so we cannot PROVE
   * the absence of a pin. Callers must treat this like a pin (refuse to move the
   * panel) rather than as "unpinned" — silently moving a user off a pin we
   * merely failed to read is exactly the failure this feature exists to prevent.
   */
  indeterminate?: boolean;
}

/** Env override for the pin (wins over the settings file, per env > .env > json). */
export const PANEL_PIN_ENV_VAR = "COMFYUI_MCP_PANEL_PIN";

/** Env values that explicitly assert "no pin", overriding a persisted one. */
const PIN_ENV_OFF = new Set(["off", "none", "no", "0", "false", "unpinned"]);

export interface PanelSettings {
  nsfwConsent?: NsfwConsent;
  agent?: AgentSettings;
  /** Persisted explicit panel-version pin (see PanelVersionPin). */
  panelPin?: PanelVersionPin;
}

/** Settings file path. Overridable for tests. */
export function panelSettingsPath(): string {
  return (
    process.env.COMFYUI_MCP_PANEL_SETTINGS ||
    join(homedir(), ".comfyui-mcp", "panel-settings.json")
  );
}

/**
 * Read the settings file, reporting whether the read was CONCLUSIVE.
 *
 * `unreadable` is true only when the file exists but could not be read/parsed —
 * i.e. `{}` here is NOT proof that a key is unset. Most callers don't care (a
 * missing NSFW consent and an unreadable one both mean "not consented"), but the
 * panel pin does: an unreadable file must not be reported as "no pin".
 */
function readRaw(): { settings: PanelSettings; unreadable: boolean } {
  const p = panelSettingsPath();
  if (!existsSync(p)) return { settings: {}, unreadable: false };
  try {
    const raw = readFileSync(p, "utf-8");
    // A zero-byte file is the signature of a torn write (crash between
    // truncate and write). It provably contains NO settings — treating it as
    // unreadable would report an indeterminate pin (which counts as PINNED)
    // forever, over a file that holds nothing. Non-empty unparseable content
    // stays unreadable: it could have held a pin, so it must fail closed.
    if (raw.length === 0) return { settings: {}, unreadable: false };
    const parsed = JSON.parse(raw) as unknown;
    // Valid JSON but not a plain object (`null`, `"x"`, and CRUCIALLY `[]`):
    // the file is present and structurally wrong, so a key's absence is not
    // proven. An array is the nasty one — `typeof [] === "object"`, so an
    // unguarded check would accept it, report "no pin" on a file we never
    // understood, and then silently DROP a pin written to it (an expando
    // property on an array does not survive JSON.stringify).
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { settings: parsed as PanelSettings, unreadable: false }
      : { settings: {}, unreadable: true };
  } catch (err) {
    logger.warn(`[panel-settings] could not parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
    return { settings: {}, unreadable: true };
  }
}

function read(): PanelSettings {
  return readRaw().settings;
}

function write(settings: PanelSettings): void {
  const p = panelSettingsPath();
  // This file carries the panel version pin — a test run writing the real one
  // changes what updates a live install will accept. Refuse at the write.
  assertNotWritingRealHomeInTests(p, "the panel settings");
  mkdirSync(dirname(p), { recursive: true });
  // Durable AND atomic (#798): this file carries the panel version PIN — a
  // protection record the user is told is in force the moment this returns. A
  // buffered write can be lost to a crash while the pin-write's report (and
  // the user's belief) survives, leaving the panel unpinned when everyone
  // thinks it is pinned; a torn write would read as unreadable, which the pin
  // reader must treat as indeterminate (pinned) forever. Write to a temp file,
  // fsync, and rename over the target so neither can happen.
  try {
    writeFileDurable(p, JSON.stringify(settings, null, 2));
  } catch (err) {
    // The write MAY have landed (the atomic rename can precede a directory
    // sync failure), so a bare failure would misreport a possibly-in-force
    // pin as absent. Say exactly what is and is not proven.
    throw new Error(
      `Could not durably write the panel settings at ${p}: ${
        err instanceof Error ? err.message : String(err)
      }. The change may still have landed on disk without a proven-durable ` +
        `directory entry — re-read the setting before assuming it did not take.`,
    );
  }
}

/** Current NSFW consent state. Defaults to OFF when never set.
 *
 *  FAIL-CLOSED: `read()` casts arbitrary on-disk JSON, so a tampered or
 *  legacy/corrupt settings file could carry a non-boolean `allowed` (e.g. the
 *  truthy STRING "false", 1, "true"). Adult content must be enabled ONLY on a
 *  strict boolean `true`; every other value is treated as NOT consented. We also
 *  normalize `decidedAt` to a string-or-undefined so callers never see junk. */
export function getNsfwConsent(): NsfwConsent {
  const raw = read().nsfwConsent as Partial<NsfwConsent> | undefined;
  const allowed = raw?.allowed === true;
  const decidedAt = typeof raw?.decidedAt === "string" ? raw.decidedAt : undefined;
  return decidedAt === undefined ? { allowed } : { allowed, decidedAt };
}

/**
 * Persist an NSFW consent decision. `allowed` true ONLY after a verified-adult
 * opt-in; false revokes. Stamps the decision time.
 */
export function setNsfwConsent(allowed: boolean): NsfwConsent {
  const decidedAt = new Date().toISOString();
  const settings = read();
  settings.nsfwConsent = { allowed, decidedAt };
  write(settings);
  return settings.nsfwConsent;
}

// ---------------------------------------------------------------------------
// Panel version pin
// ---------------------------------------------------------------------------

/** Normalize a pin version string; returns undefined for junk/blank. */
function normalizePinVersion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v.length > 0 && v.length <= 64 ? v : undefined;
}

/**
 * Resolve the ACTIVE panel-version pin.
 *
 * Precedence mirrors the rest of the project's config (env > `~/.comfyui-mcp/.env`
 * > the JSON settings store): `~/.comfyui-mcp/.env` is loaded into `process.env`
 * at boot, so a single `process.env` check covers both env layers.
 * `COMFYUI_MCP_PANEL_PIN=off` (or none/no/0/false/unpinned) is an explicit
 * "no pin" that overrides a persisted one — the env escape hatch when the
 * settings file can't be edited.
 *
 * Never throws: a pin we cannot read is reported `indeterminate`, which callers
 * MUST treat as pinned.
 */
export function getPanelPinState(env: NodeJS.ProcessEnv = process.env): PanelPinState {
  const rawEnv = env[PANEL_PIN_ENV_VAR];
  // PRESENCE, not truthiness-after-trim. A whitespace-only value ("   ") is a
  // SET variable we cannot interpret; trimming first and falling through made it
  // resolve `unpinned` and let the mutation proceed — the same present-but-
  // unreadable fail-open as the settings file. An EMPTY value is treated as
  // unset, which is the ordinary meaning of `FOO=` and of an unset dotenv key.
  if (typeof rawEnv === "string" && rawEnv.length > 0) {
    const trimmed = rawEnv.trim();
    if (PIN_ENV_OFF.has(trimmed.toLowerCase())) {
      // The explicit no-pin escape hatch, and the ONLY way an env value clears.
      return { pinned: false, source: "none" };
    }
    const version = normalizePinVersion(trimmed);
    if (version) return { pinned: true, version, source: "env" };
    // Present but unusable (whitespace-only, or junk) — we cannot tell what the
    // user meant, so we do NOT fall through to "unpinned".
    return { pinned: true, source: "env", indeterminate: true };
  }

  const { settings, unreadable } = readRaw();
  if (unreadable) return { pinned: true, source: "settings", indeterminate: true };

  // ONLY an absent key means unpinned. A key that is PRESENT but malformed
  // (`null`, `false`, `0`, `"0.11.3"`, `[]`) is somebody's hand-edit that we
  // failed to understand — reading it as "no pin" would move a user who
  // believed they were pinned. Present-but-unreadable resolves to pinned.
  if (!("panelPin" in settings) || settings.panelPin === undefined) {
    return { pinned: false, source: "none" };
  }
  const raw = settings.panelPin as Partial<PanelVersionPin> | undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { pinned: true, source: "settings", indeterminate: true };
  }
  const version = normalizePinVersion(raw.version);
  if (!version) {
    // A `panelPin` key exists but its version is junk: something pinned this
    // install, so refuse to move it rather than guessing it away.
    return { pinned: true, source: "settings", indeterminate: true };
  }
  const state: PanelPinState = { pinned: true, version, source: "settings" };
  if (typeof raw.pinnedAt === "string") state.pinnedAt = raw.pinnedAt;
  if (typeof raw.reason === "string") state.reason = raw.reason;
  return state;
}

/** Human-readable one-liner for a pin state, for messages the user reads. */
export function describePanelPin(pin: PanelPinState): string {
  if (!pin.pinned) return "not pinned";
  if (pin.indeterminate) {
    return pin.source === "env"
      ? `pinned via ${PANEL_PIN_ENV_VAR}, but its value is unusable`
      : `possibly pinned — ${panelSettingsPath()} could not be read`;
  }
  const where =
    pin.source === "env" ? `${PANEL_PIN_ENV_VAR} env var` : panelSettingsPath();
  return `pinned to ${pin.version} (via ${where})${pin.reason ? ` — ${pin.reason}` : ""}`;
}

function assertSettingsWritable(): PanelSettings {
  const { settings, unreadable } = readRaw();
  if (unreadable) {
    throw new Error(
      `Refusing to rewrite ${panelSettingsPath()}: it exists but could not be ` +
        `parsed, so writing would silently discard whatever else is in it. Fix or ` +
        `delete that file and retry (or set ${PANEL_PIN_ENV_VAR} in the environment, ` +
        `which takes precedence).`,
    );
  }
  return settings;
}

/**
 * Persist an explicit pin. Throws on a blank version or an unparseable settings
 * file (see assertSettingsWritable) — never silently drops the request.
 */
export function setPanelVersionPin(version: string, reason?: string): PanelVersionPin {
  const normalized = normalizePinVersion(version);
  if (!normalized) {
    throw new Error(
      "A panel version pin needs a non-empty version string (e.g. \"0.11.20\").",
    );
  }
  const settings = assertSettingsWritable();
  const pin: PanelVersionPin = { version: normalized, pinnedAt: new Date().toISOString() };
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (trimmedReason) pin.reason = trimmedReason;
  settings.panelPin = pin;
  write(settings);
  // VERIFY the pin actually landed, by re-reading it. Telling a user "pinned"
  // when nothing persisted is the same fabricated-success failure this whole
  // feature exists to prevent — and it is the worse direction, because they
  // would then believe they are protected. (Env is deliberately excluded here:
  // we are confirming the FILE, not an override that would mask a failed write.)
  const persisted = getPanelPinState({});
  if (!persisted.pinned || persisted.version !== pin.version) {
    throw new Error(
      `Pin did NOT persist: after writing ${panelSettingsPath()} the stored pin reads ` +
        `back as ${persisted.version ?? "absent/unreadable"} rather than ${pin.version}. ` +
        `NOT reporting the panel as pinned. Check that file is writable and well-formed.`,
    );
  }
  return pin;
}

/**
 * Remove the persisted pin. Returns the pin that was removed, or undefined when
 * there wasn't one. Does NOT (and cannot) clear an env-var pin — callers must
 * report that separately so the user isn't told they're unpinned when they
 * aren't.
 */
export function clearPanelVersionPin(): PanelVersionPin | undefined {
  const settings = assertSettingsWritable();
  // Keyed on PRESENCE, not truthiness: a malformed falsy pin (`null`, `false`,
  // `0`) is an active indeterminate pin, so `!previous` would have refused to
  // delete it and left the user permanently blocked with "no pin was set".
  if (!("panelPin" in settings) || settings.panelPin === undefined) return undefined;
  const raw = settings.panelPin as unknown;
  // A malformed stored pin still gets removed; describe it as unreadable rather
  // than returning junk (or undefined, which callers render as "no pin existed").
  // The version is validated too, not just the container: `{ version: null }`
  // and `{ version: " " }` are OBJECTS, and returning them verbatim made unpin
  // report "was null" / "was " for a pin that getPanelPinState called
  // indeterminate — two parts of the system describing the same pin differently.
  const rawVersion =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? normalizePinVersion((raw as Partial<PanelVersionPin>).version)
      : undefined;
  const previous: PanelVersionPin = rawVersion
    ? (raw as PanelVersionPin)
    : { version: "(unreadable)" };
  delete settings.panelPin;
  write(settings);
  // Symmetrically verified: a "pin removed" we did not observe would leave the
  // user believing a sync can now proceed when it still cannot.
  const persisted = getPanelPinState({});
  if (persisted.pinned) {
    throw new Error(
      `Pin was NOT removed: ${panelSettingsPath()} still reads back as pinned after ` +
        `the write. NOT reporting the pin as cleared.`,
    );
  }
  return previous;
}

/** Persisted agent backend/model preferences ({} when never set). */
export function getAgentSettings(): AgentSettings {
  return read().agent ?? {};
}

/**
 * Merge a partial update into the persisted agent settings. `preferredModels`
 * replaces the whole list (the panel sends the full edited list); `ollama`
 * fields merge per-key so e.g. a model change doesn't clobber the base URL.
 */
/**
 * Canonical form of a preferred-models list: trim, drop blanks, dedup, cap at 50.
 * Exported so the set_config handler can compare an INCOMING list against the
 * persisted one on the SAME footing — comparing a raw payload against this
 * normalized list would report "changed" on every heartbeat and revive the
 * config-repush loop (#393 follow-up).
 */
export function normalizePreferredModels(list: string[]): string[] {
  return [...new Set(list.map((m) => m.trim()).filter(Boolean))].slice(0, 50);
}

export function setAgentSettings(patch: AgentSettings): AgentSettings {
  const settings = read();
  const prev = settings.agent ?? {};
  const next: AgentSettings = { ...prev };
  if (patch.preferredModels !== undefined) {
    next.preferredModels = normalizePreferredModels(patch.preferredModels);
  }
  if (patch.ollama !== undefined) {
    next.ollama = { ...prev.ollama, ...patch.ollama };
  }
  if (patch.lmstudio !== undefined) {
    next.lmstudio = { ...prev.lmstudio, ...patch.lmstudio };
  }
  if (patch.llamacpp !== undefined) {
    next.llamacpp = { ...prev.llamacpp, ...patch.llamacpp };
  }
  if (patch.custom !== undefined) {
    next.custom = { ...prev.custom, ...patch.custom };
  }
  settings.agent = next;
  write(settings);
  return next;
}
