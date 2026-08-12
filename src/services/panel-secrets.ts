// Persisted TOOL secrets for the orchestrator's BUILT-IN comfyui MCP server.
//
// The orchestrator spawns the comfyui MCP server (this build, in normal/stdio
// mode) as a subprocess with a FIXED env it controls (COMFYUI_URL, progress dir,
// COMFYUI_PATH…). Tool secrets the user supplies at runtime through the panel —
// e.g. a CivitAI API token for download_model action:"download_civitai", a HuggingFace token for
// download_model — must reach THAT subprocess's env. They can't go into the
// user's ~/.claude.json mcpServers map (user-mcp-config.ts), because that map is
// for the user's OWN, inherited MCP servers; the built-in comfyui server doesn't
// read it. So we persist them here, the orchestrator merges them into the comfyui
// server's spawn env (buildComfyuiMcpEnv), and respawns the server so a live one
// picks up the new value WITHOUT the user fighting reloads.
//
// SECURITY: the file holds raw secrets, so it is written 0600 (owner-only). The
// raw value NEVER enters a log or the agent's chat context — callers pass it
// straight from the panel's secure input, and only the env-var KEYS are ever
// logged (see comfyuiSecretKeys()).

import dotenv from "dotenv";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  comfyuiEnvFilePath,
  freshSecretValue,
  freshSecretValues,
  isShellProvided,
  markFileDerived,
  parseEnvFile,
  unmarkFileDerived,
  MANAGED_SECRET_KEYS_ENV,
} from "../env-file.js";
import { logger } from "../utils/logger.js";
import { downloadsAtRiskOfRespawn } from "./download-jobs.js";
import { runningUnderTestRunner } from "./test-isolation-guard.js";
import { OPENAI_KEY_PROVIDERS, providerModelHint } from "./openai-provider-registry.js";

interface PanelSecrets {
  /** Env vars injected into the built-in comfyui MCP server's spawn env. */
  comfyuiEnv?: Record<string, string>;
  /** Env vars the ORCHESTRATOR reads in-process (not the comfyui child) — e.g.
   *  the OpenRouter API key for the OpenRouter provider backend. Kept SEPARATE
   *  from comfyuiEnv (different allowlist) so a provider key is never injected
   *  into the tool subprocess and a tool token never reaches the LLM backend. */
  agentEnv?: Record<string, string>;
  /** STATUS-ONLY mirror of in-panel OAuth sign-ins (Codex/Grok/Copilot), keyed by
   *  provider id. Holds NO secrets — the native token files (~/.codex/auth.json,
   *  ~/.grok/auth.json, ~/.comfyui-mcp/copilot-auth.json) are the source of truth
   *  for token material. This is deliberately NOT under either allowlist above:
   *  it is read by the panel UI to show "signed in as …" without ever touching a
   *  credential. `setOAuthStatus` sanitizes on write so a hand-edited/corrupt file
   *  can never smuggle anything beyond the five known status fields. */
  oauthStatus?: Record<string, OAuthStatusRecord>;
}

/** Status-only record for an in-panel OAuth sign-in. NEVER put token material here. */
export interface OAuthStatusRecord {
  provider: string;
  account_label: string;
  obtained_at: number;
  expires_at?: number;
  experimental?: boolean;
}

// STRICT ALLOWLIST of env keys a panel-collected secret may set on the comfyui
// MCP child process. The child is a Node subprocess (process.execPath), so an
// arbitrary key (NODE_OPTIONS, PATH, COMFYUI_PATH, LD_PRELOAD, …) could hijack or
// clobber it. We therefore permit ONLY known credential vars the comfyui tools
// read — both on SAVE (reject otherwise) and on LOAD (filter), so even a hand-
// edited or corrupt panel-secrets.json can never inject anything else.
//   CIVITAI_API_TOKEN  → download_model action:"download_civitai" (config.civitaiApiToken)
//   HUGGINGFACE_TOKEN  → HuggingFace downloads   (config.huggingfaceToken)
//   HF_TOKEN           → HuggingFace alias some tooling/hub libs honor
export const COMFYUI_SECRET_ENV_ALLOWLIST = [
  "CIVITAI_API_TOKEN",
  "HUGGINGFACE_TOKEN",
  "HF_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "RUNCOMFY_API_KEY",
  "RUNPOD_API_KEY",
  "REGISTRY_ACCESS_TOKEN",
] as const;

const ALLOWLIST_SET = new Set<string>(COMFYUI_SECRET_ENV_ALLOWLIST);

/** Is `key` a permitted comfyui tool-secret env var? */
export function isAllowedComfyuiSecretKey(key: string): boolean {
  return ALLOWLIST_SET.has(key);
}

// STRICT ALLOWLIST of env keys the ORCHESTRATOR itself may read from the store.
// These configure the agent provider backends in-process (never a subprocess),
// so the injection surface is different from the comfyui child's — but we keep
// the same allowlist discipline so a corrupt file can't set arbitrary env.
//   OPENROUTER_API_KEY → the OpenRouter provider backend (OllamaBackend openai)
//   COMFYUI_MCP_CUSTOM_API_KEY → the user-defined Custom endpoint provider
// The registry providers' keys (GLM_API_KEY/ZHIPU*/ZAI_API_KEY, KIMI_API_KEY,
// MOONSHOT_API_KEY) are DERIVED from openai-provider-registry so a new api-key
// provider is allowlisted by adding one registry entry, not editing this array.
export const AGENT_SECRET_ENV_ALLOWLIST: readonly string[] = [
  "OPENROUTER_API_KEY",
  "COMFYUI_MCP_CUSTOM_API_KEY",
  ...OPENAI_KEY_PROVIDERS.flatMap((p) => p.envKeys),
];
const AGENT_ALLOWLIST_SET = new Set<string>(AGENT_SECRET_ENV_ALLOWLIST);

/** Is `key` a permitted orchestrator agent-secret env var? */
export function isAllowedAgentSecretKey(key: string): boolean {
  return AGENT_ALLOWLIST_SET.has(key);
}

/** Secrets file path. Overridable for tests.
 *
 *  `home` scopes the read to a caller-supplied home directory. It exists because
 *  `readOAuthStatus(home)` already took one and threaded it to `nativeCliStatus`,
 *  while the mirror half reached this function and silently used the REAL home —
 *  so a test that injected a temp home still read the developer's actual logins,
 *  and its result flipped depending on whether that machine happened to be signed
 *  into codex (#859). The docstring there promised "tests never read the
 *  developer's real logins"; for one of its two halves that was false.
 *
 *  Precedence is deliberately env > `home` > real home. `COMFYUI_MCP_PANEL_SECRETS`
 *  is the explicit global redirect and must keep winning, so this adds scoping
 *  where a `home` is passed without changing any path that already worked. */
export function panelSecretsPath(home?: string): string {
  return (
    process.env.COMFYUI_MCP_PANEL_SECRETS ||
    join(home ?? homedir(), ".comfyui-mcp", "panel-secrets.json")
  );
}

// In-process change channel: the tool handler that saves a secret runs in the
// SAME process as the orchestrator (both the in-process Claude panel server and
// the Codex loopback HTTP MCP are hosted by the orchestrator), so a module-level
// emitter is enough to tell the orchestrator to re-inject + respawn.
const emitter = new EventEmitter();

// ── Emission suspension ─────────────────────────────────────────────────────
// A multi-key operation (a Settings SLOT save fans out to a slot's alias keys)
// must not fire a change per key: each successful alias emits BEFORE the later
// alias's failure is known, so a save that ultimately fails — and is rolled back
// — would still have respawned every idle agent against a half-written state,
// and the rollback would respawn them all again (codex gate, round 5, finding
// 7). Suspend for the duration, then emit ONCE for the state actually left.
let emitSuspendDepth = 0;
let suspendedComfyuiChange = false;
/** What the last suspended operation's single emit cost. Read once, then cleared. */
let lastSuspendedAtRisk: AtRiskDownloads = [];
let suspendedAgentChange = false;

/**
 * Fire a change event WITHOUT letting a listener's failure escape.
 *
 * `emit` is synchronous, and these listeners do real work — rebuilding an MCP
 * server's env, scheduling a respawn. They run AFTER the store has already been
 * rewritten, so a throw from one of them propagated out of `setEnvSecret`, past
 * the receipt, and reached the caller as a generic failure for a save that had
 * in fact landed (codex gate). Notifying is not part of the write's transaction:
 * the credential is on disk either way, and a listener that fails is a
 * respawn-didn't-happen problem, which the receipt's own `respawn` field already
 * reports as "nothing was scheduled".
 */
function emitGuarded(event: "change" | "agentChange", payload?: Partial<ComfyuiSecretChange>): void {
  try {
    if (payload === undefined) emitter.emit(event);
    else emitter.emit(event, payload);
  } catch (err) {
    logger.warn(
      `[panel-secrets] a "${event}" listener failed after the store was written ` +
        `(${err instanceof Error ? err.message : String(err)}); the credential IS saved, ` +
        `but whatever that listener drives — a tool-session respawn, a readiness refresh — did not happen.`,
    );
  }
}

/** Downloads in flight at the moment a credential save is about to respawn the tool
 *  session (#1378). Best-effort: a records store this process cannot read must never break
 *  a credential save, and an unreadable store is reported as "none" rather than throwing. */
function snapshotAtRiskDownloads(): AtRiskDownloads {
  try {
    return downloadsAtRiskOfRespawn();
  } catch (err) {
    logger.debug("[secrets] could not enumerate in-flight downloads for the respawn warning", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Emit, and report what the emit COST (#1378).
 *
 * The snapshot lives here, at the one point where a respawn is actually triggered, rather
 * than at each call site. Three defects came out of having it anywhere else:
 *
 *  - a call site that emits without snapshotting reports nothing at risk (the revoke path,
 *    which had the emit and not the snapshot for a full release);
 *  - a call site that snapshots without emitting warns about a loss that never happened —
 *    a rollback under `withSuspendedEmissions` removes a key, emits nothing because
 *    nothing changed, and still told the user their downloads would not resume;
 *  - and the ordering, which must be snapshot-then-emit because the emit is synchronous
 *    and a listener replaces its tool session inside it, was restated at every site and
 *    therefore could be got wrong at any of them.
 *
 * Suspended: nothing is emitted, so nothing is at risk YET. The outer
 * `withSuspendedEmissions` makes exactly one real emit at the end, and that one returns
 * the snapshot for the whole operation.
 */
function emitComfyuiChange(payload: Partial<ComfyuiSecretChange>): AtRiskDownloads {
  if (emitSuspendDepth > 0) {
    suspendedComfyuiChange = true;
    return [];
  }
  const atRisk = snapshotAtRiskDownloads();
  emitGuarded("change", payload);
  return atRisk;
}

/** In-flight downloads a respawn is about to orphan. Empty is a finding; it is never
 *  absent, so no caller has to tell "none" from "not reported". */
export type AtRiskDownloads = { id: string; filename: string; bytes: number }[];

function emitAgentChange(): void {
  if (emitSuspendDepth > 0) {
    suspendedAgentChange = true;
    return;
  }
  emitGuarded("agentChange");
}

/**
 * Run `fn` with change events suspended, then emit at most one of each for the
 * FINAL state. `decide` sees whether anything was suppressed and returns what to
 * emit — a caller whose operation failed AND was fully rolled back can emit
 * nothing, because nothing changed.
 */
function withSuspendedEmissions<T>(
  fn: () => T,
  decide: (result: T | undefined, suppressed: { comfyui: boolean; agent: boolean }) => {
    comfyui?: Partial<ComfyuiSecretChange> | false;
    agent?: boolean;
  },
): T {
  const outerComfyui = suspendedComfyuiChange;
  const outerAgent = suspendedAgentChange;
  suspendedComfyuiChange = false;
  suspendedAgentChange = false;
  emitSuspendDepth++;
  let result: T | undefined;
  try {
    result = fn();
    return result;
  } finally {
    emitSuspendDepth--;
    const suppressed = { comfyui: suspendedComfyuiChange, agent: suspendedAgentChange };
    suspendedComfyuiChange = outerComfyui;
    suspendedAgentChange = outerAgent;
    // A `finally` that throws REPLACES the outcome of the block it guards — the
    // receipt, or the real error — so nothing in it may escape. The emits are
    // already guarded; `decide` is guarded here for the same reason.
    try {
      const plan = decide(result, suppressed);
      // The ONE real emit for the whole suspended operation, so its snapshot is the
      // operation's at-risk list. Stashed rather than returned because `finally` cannot
      // change what the block returns — the caller reads it back with
      // `takeSuspendedAtRisk()` after the fact.
      if (plan.comfyui) lastSuspendedAtRisk = emitComfyuiChange(plan.comfyui);
      if (plan.agent) emitAgentChange();
    } catch (err) {
      logger.warn(
        `[panel-secrets] deciding what to notify after a secret write failed ` +
          `(${err instanceof Error ? err.message : String(err)}); the store is unaffected, but no change event was fired.`,
      );
    }
  }
}

/** The at-risk list from the last suspended operation's single emit, cleared on read so a
 *  later operation cannot inherit it. */
function takeSuspendedAtRisk(): AtRiskDownloads {
  const at = lastSuspendedAtRisk;
  lastSuspendedAtRisk = [];
  return at;
}

/** Payload for a comfyui tool-secret change. `requested` is true ONLY when the
 *  change ANSWERS an outstanding panel_request_secret (the agent asked the user
 *  for a token to unblock an action) — a Settings-panel slot save, a background
 *  (re)load/migration, or a revoke is `false`. The orchestrator gates the
 *  "token active — retry the action" nudge on this so it is never injected when
 *  no request was outstanding (#164). */
export interface ComfyuiSecretChange {
  requested: boolean;
  /** The save's VERDICT, so a listener that speaks more authoritatively than the
   *  receipt — the "your token is now active, retry" nudge — can refuse to speak
   *  at all unless the save was proven. Absent on a revoke or a reload, where
   *  there is no save to verify. */
  persisted?: SecretSaveReceipt["persisted"];
  /** The panel tab whose panel_request_secret this change answers, when
   *  `requested` — so the orchestrator can nudge ONLY that tab's agent to retry
   *  (never a broadcast to unrelated tabs). Undefined for non-request changes. */
  tabId?: string;
  /** Report back what the subscriber ACTUALLY did about the tool-child respawn.
   *  The emit is synchronous, so whatever a listener reports here is available to
   *  `setEnvSecret`'s caller before it composes its answer. A listener that does
   *  not call this contributes nothing — silence is never read as success (#826). */
  report?: (r: SecretRespawnReport) => void;
}

/** What a subscriber did about respawning the comfyui tool child. Counts only —
 *  never a promise about a future state we have not observed. */
export interface SecretRespawnReport {
  /** Live agent sessions at the moment of the change. */
  live: number;
  /** Sessions replaced RIGHT NOW (they were idle) — an observed respawn. */
  applied: number;
  /** Sessions that were mid-turn, so their replacement is queued for the next
   *  idle. Scheduled, NOT done — describe it that way. */
  scheduled: number;
}

/** Subscribe to "a comfyui tool secret changed". The callback receives whether
 *  the change answered an outstanding secret REQUEST and, if so, the requesting
 *  tab (see ComfyuiSecretChange). Returns an unsubscribe fn. */
export function onComfyuiSecretsChanged(cb: (change: ComfyuiSecretChange) => void): () => void {
  const handler = (payload?: Partial<ComfyuiSecretChange>) =>
    cb({
      requested: payload?.requested === true,
      // The VERDICT must survive this wrapper. It is what the retry nudge is
      // gated on, and dropping it here made the gate always-false — a confirmed
      // save stopped nudging at all, which is #164 broken in the other
      // direction (codex gate). This wrapper normalises; it does not get to
      // decide what the listener may know.
      persisted: payload?.persisted,
      tabId: payload?.requested === true ? payload?.tabId : undefined,
      report: payload?.report,
    });
  emitter.on("change", handler);
  return () => {
    emitter.off("change", handler);
  };
}

/**
 * The OBSERVED outcome of persisting a secret. Every field is something we
 * checked, not something we intend — `panel_request_secret` composes its answer
 * from this instead of asserting a respawn that may never fire (#826).
 */
export interface SecretSaveReceipt {
  /**
   * Downloads that were in flight when this save was about to respawn the tool session
   * (#1378). Captured BEFORE the (synchronous) respawn emit, so an already-applied
   * replacement can still report what it cost — afterwards the list is empty and the
   * warning would describe nothing.
   */
  atRiskDownloads?: AtRiskDownloads;
  /** The env var written. Never the value. */
  key: string;
  /** The canonical file it was written to (contains no secret). */
  path: string;
  /**
   * THE single field that decides whether a caller may narrate success. It is a
   * verdict about the SAVE, not merely about the key.
   *
   *  "yes"      — a read-back proved the key carries this value AND the
   *               whole-file check accounted for every other key the store held.
   *               Nothing less than that is "yes".
   *  "no"       — the read-back proved it does NOT: the save did not take effect.
   *  "unknown"  — neither verdict is established. `uncertainty` says exactly
   *               what could not be established; a renderer must print THAT
   *               rather than assume a cause.
   *  "damaged"  — the key IS in the store, and OTHER credentials it held are
   *               proven gone. `lostKeys` names them. Never a success.
   *
   * "damaged" exists so that data loss cannot be narrated as a save by ANY
   * caller rather than by the callers that remembered to check `lostKeys`. Every
   * success test in this codebase is `persisted === "yes"`, so a damaged receipt
   * fails all of them at once — that is the point, and it is why the answer is a
   * new variant here rather than another check at each call site (codex gate:
   * `storeDamageNote` guarded the ack while `slotSaveConfirmed` and the console's
   * `/api/secrets` both still reported a clean save over destroyed tokens).
   *
   * Deliberately never collapsed: "could not determine" must not harden into a
   * definite answer in either direction, and proven loss must not soften into
   * "could not determine".
   */
  persisted: "yes" | "no" | "unknown" | "damaged";
  /** Why `persisted` is not "yes", when the reason is not self-evident from the
   *  verdict alone. One sentence, no values. */
  uncertainty?: string;
  /** True when every consumer of this key resolves it from the canonical file at
   *  ACCESS time, so an already-running tool process sees it with no respawn. */
  livePickup: boolean;
  /** What the orchestrator's listener reported. `null` when NO listener answered
   *  — then nothing is known to be driving a respawn and we must not claim one. */
  respawn: SecretRespawnReport | null;
  /** Only set when `persisted === "no"`: whether SOME credential for this key is
   *  still in effect after the rollback (a previous working value). Lets the
   *  refusal avoid the false "nothing is configured". Presence only. */
  stillConfigured?: boolean;
  /** The value WAS stored, but a real environment variable of the same name
   *  outranks the store, so readers use that instead. Saying "saved" without
   *  saying this would report a configured state the tools do not use. */
  shadowedByEnv?: boolean;
  /** OTHER credential keys the store held before this write and no longer
   *  holds. Never empty on a healthy write. A save must NEVER be reported as
   *  clean over this: "your token is saved" while the user's other tokens were
   *  destroyed is a fabricated success on top of data loss. Names only.
   *  Present only alongside `persisted: "damaged"` — the two are set together. */
  lostKeys?: string[];
  /** Comment / non-assignment lines the rewrite did not preserve. The store's
   *  own contract is that it keeps them, so losing them is the user's data going
   *  missing — a disclosure every renderer owes, not a detail to compute and
   *  discard (codex gate). A count, never the lines themselves: a comment in a
   *  credential file can contain a credential. */
  lostCommentLines?: number;
  /** Set when the write LANDED but was not established to survive a power loss
   *  (an fsync of the file or of its directory failed). A disclosure, not a
   *  failure: the value is in the store now. */
  durabilityGap?: string;
  /** A pre-write snapshot this write could not delete — a readable copy of the
   *  store as it was, holding the PREVIOUS credential for this key. */
  strayCopy?: string;
}

// ── What a receipt OBLIGES its renderer to say ───────────────────────────────
//
// These live next to the receipt, not next to any one renderer, on purpose. Each
// of the three consumers (the panel_request_secret ack, the agent-secret ack,
// and the console's /api/secrets) grew its own idea of which fields mattered,
// and `lostKeys` reached exactly one of them — so a save that destroyed the
// user's other tokens was narrated as a success by the other two (codex gate).
// A new obligation added to the receipt belongs in `receiptDisclosures` once,
// and every consumer picks it up at the same moment.

/** The store lost OTHER credentials while saving this one. This outranks every
 *  other clause: "your token is saved" while the user's other tokens were
 *  destroyed is a fabricated success on top of data loss. Names only, no values. */
export function storeDamageNote(receipt: SecretSaveReceipt): string | null {
  const lost = receipt.lostKeys ?? [];
  if (!lost.length) return null;
  return (
    `🛑 "${receipt.key}" was written to ${receipt.path}, but the store NO LONGER carries ${lost.join(", ")} — ` +
    `${lost.length > 1 ? "those credentials were" : "that credential was"} lost during the write. Do not treat this as a successful save. ` +
    `Inspect ${receipt.path} and restore the missing ${lost.length > 1 ? "entries" : "entry"} before relying on anything in it.`
  );
}

/** The rewrite did not preserve the user's comment lines, which this store
 *  promises to keep. Not a failed save — the credential is there — but it is the
 *  user's data going missing, and it was computed and then discarded before it
 *  ever reached a receipt (codex gate). A count only: a comment in a credential
 *  file can itself contain a credential. */
export function commentLossNote(receipt: SecretSaveReceipt): string | null {
  const n = receipt.lostCommentLines ?? 0;
  if (n <= 0) return null;
  return (
    `⚠️ ${n} comment line${n > 1 ? "s" : ""} in ${receipt.path} did not survive this write. ` +
    `The credential itself is unaffected, but this store is meant to preserve them — check the file if those notes mattered.`
  );
}

/** The write landed but was not established to survive a power loss. */
export function durabilityNote(receipt: SecretSaveReceipt): string | null {
  if (!receipt.durabilityGap) return null;
  return (
    `⚠️ The value IS in ${receipt.path} now, but this write was not made crash-durable: ${receipt.durabilityGap}. ` +
    `If the machine loses power before the filesystem flushes on its own, set the credential again.`
  );
}

/** The store holds the value, but a real environment variable of the same name
 *  outranks it, so the readers use THAT. Reporting "saved" without this is a
 *  configured state the tools do not use. */
export function shadowedNote(receipt: SecretSaveReceipt): string | null {
  if (!receipt.shadowedByEnv) return null;
  return (
    `⚠️ "${receipt.key}" was stored in ${receipt.path}, but it is NOT the value in use: a real environment variable named ${receipt.key} is set outside this app and takes precedence over the store. ` +
    `Nothing changed for the tools. To make the value you just supplied take effect, unset ${receipt.key} in the environment this app was started from and restart it — or leave the environment variable as the source of truth. ` +
    `(The value itself is never shown or logged.)`
  );
}

/**
 * EVERY clause this receipt obliges its renderer to state, most severe first.
 *
 * THE choke point: a consumer renders these and is done, instead of knowing
 * which receipt fields exist. Empty means the receipt carries no obligation —
 * which is not the same as "the save succeeded"; that question is `persisted`.
 */
export function receiptDisclosures(receipt: SecretSaveReceipt): string[] {
  return [
    atRiskNote(receipt.atRiskDownloads ?? [], receipt.respawn),
    storeDamageNote(receipt),
    strayCopyNote(receipt),
    commentLossNote(receipt),
    durabilityNote(receipt),
    shadowedNote(receipt),
  ].filter((n): n is string => n !== null);
}

/**
 * What the respawn this change triggers is about to cost, or has already cost (#1378).
 *
 * Lives beside the other disclosures rather than in one caller's renderer, because the
 * caller that had it was the agent-facing one and the Settings endpoint — which saves
 * through the same path and orphans the same transfers — rendered nothing at all (codex).
 *
 * THE RESPAWN'S TIMING DECIDES THE SENTENCE, and "not reported" is its own case. A save
 * that collects no respawn report has not established that no respawn happened; saying
 * "will not resume" invites the user to act on a transfer that may be dead already, and
 * saying "already lost" claims an event nobody observed.
 */
export function atRiskNote(
  atRisk: AtRiskDownloads | readonly { filename: string; bytes: number }[],
  // `undefined` is a THIRD answer: no report was collected on this path, which is not
  // `null` ("a listener reported doing nothing"). The wording distinguishes them.
  respawn: SecretSaveReceipt["respawn"] | undefined,
): string | null {
  if (!atRisk.length) return null;
  const listed = atRiskDownloadSummary(atRisk);
  // Why this is unrecoverable, stated once: the auth header is part of each download's
  // cache identity, so the bytes on disk can no longer be found under the new one.
  const consequence =
    `The new credentials change each download's cache identity, so those transfers will ` +
    `NOT resume: re-issuing them starts from 0% even though the partial files remain on ` +
    `disk (#1378).`;
  if (respawn?.applied) {
    return (
      `🛑 The tool session was replaced immediately, and ${listed} were in flight. ${consequence} ` +
      `Nothing can recover them under the new identity — that is the cost already paid, not a ` +
      `warning you can act on.`
    );
  }
  if (respawn?.scheduled) {
    return (
      `⚠️ ${listed} are in flight and the tool session is queued to be rebuilt at the end of ` +
      `this turn. ${consequence} If that matters, let them finish before the rebuild.`
    );
  }
  return (
    `⚠️ ${listed} were in flight when this credential change fired its tool-session rebuild. ` +
    `Whether that rebuild has already happened was not reported here, so this is not a claim ` +
    `either way about transfers you may still be able to save. ${consequence}`
  );
}

/**
 * #1567 — what a DEFERRED respawn is orphaning, said at the moment it fires.
 *
 * `atRiskNote` above is for the save. It is built from a snapshot taken before the emit,
 * which is correct for an `applied` respawn — the emit IS the damage — and structurally
 * incapable of covering a `scheduled` one, where the damage happens arbitrarily later. A
 * reporter saved a token with nothing in flight (so the save-time check correctly warned
 * about nothing), started nine downloads over the next two turns, and lost all ~48GB when
 * the queued respawn landed, with no warning at any point.
 *
 * ## Why this does NOT reuse `atRiskNote`'s consequence
 *
 * That sentence says the transfers will not resume and re-issuing restarts from 0%,
 * because the new credential changes each download's cache identity. True when the
 * credential changes MID-TRANSFER. It is wrong for the case this note exists for, and the
 * reporter proved it: their downloads began AFTER the save, so identity never moved and
 * re-issuing resumed from the `.partial` files at 4%/1%/2%. ~11GB was recoverable — but
 * only because they checked the partials rather than believing the prediction.
 *
 * So this states what is observable here (these are being killed now, the partials are on
 * disk) and is explicit that resumability depends on something this code cannot see: which
 * side of the credential change each transfer started on. Claiming either outcome would be
 * asserting the thing that actually varies.
 */
export function orphanedByDeferredRespawnNote(
  orphaned: AtRiskDownloads | readonly { filename: string; bytes: number }[],
): string | null {
  if (!orphaned.length) return null;
  return (
    `🛑 The queued tool-session rebuild is happening NOW, and ${atRiskDownloadSummary(orphaned)} ` +
    `were still transferring. They belong to the session being replaced, so they are being ` +
    `killed — this is the rebuild that was queued when a comfyui credential was saved earlier ` +
    `(#1567).\n\n` +
    `The partial files are still on disk, so re-issuing each download is worth doing: it can ` +
    `RESUME from them rather than starting over. A transfer that was already running when the ` +
    `credential changed has a different cache identity and definitely restarts from 0%; one ` +
    `started after that save keeps its identity and usually resumes — but resumption also needs ` +
    `the server to still offer the same validator and honour a range request, so it is not ` +
    `guaranteed either way. Read the progress each re-issue reports instead of assuming.\n\n` +
    `Re-issue them now if they are still wanted; nothing else will pick them up.`
  );
}

/** A pre-write snapshot the write could not delete: a readable copy of the store
 *  holding the PREVIOUS credential for this key. Harmless clutter after a
 *  rotation on a single-user machine, but the user should know it is there. */
export function strayCopyNote(receipt: SecretSaveReceipt): string | null {
  if (!receipt.strayCopy) return null;
  // Say only what the FILE KIND establishes. `.pre-*` is a snapshot of the store
  // as it was, so it holds the previous value; `.tmp-*` is a failed writer's
  // proposed new content, which is a different thing entirely — and both were
  // being described as "the previous value", asserting contents nobody looked at
  // (codex gate). Neither is ever opened to check: that would mean reading a
  // credential in order to describe it.
  const kinds = [
    /\.pre-/.test(receipt.strayCopy) ? "a snapshot of the store from before a write" : null,
    /\.tmp-/.test(receipt.strayCopy) ? "an unfinished write's proposed new store" : null,
  ].filter((k): k is string => k !== null);
  return (
    `⚠️ A leftover file beside ${receipt.path} could not be deleted: ${receipt.strayCopy}. ` +
    `${kinds.length ? `It is ${kinds.join(" / ")}` : "Its provenance was not established"}, ` +
    `so it may contain credential values — the file itself was not read. Delete it by hand.`
  );
}

/**
 * The same obligations for a REMOVAL. A revoke is a store rewrite, so it can
 * lose credentials, drop comments, and fail to be durable exactly as a save can
 * — and its consumer was reading only "did anything change", so an incomplete
 * loss account came back as a clean `200 {ok:true}` (codex gate). Defined here,
 * beside the save's, so the two cannot drift into disagreeing about what a store
 * write owes its caller.
 */
/**
 * The one description of what a respawn is about to cost, shared by both paths (#1378).
 *
 * Save and revoke reach the same emit and lose the same transfers, so they say it the same
 * way — two hand-rolled summaries would drift, and the revoke half was missing entirely
 * until codex pointed at it.
 */
export function atRiskDownloadSummary(atRisk: AtRiskDownloads | readonly { filename: string; bytes: number }[]): string {
  const gb = atRisk.reduce((n, d) => n + d.bytes, 0) / 1024 ** 3;
  const names = atRisk
    .map((d) => d.filename)
    .slice(0, 3)
    .join(", ");
  return `${atRisk.length} download(s) (${names}${atRisk.length > 3 ? ", …" : ""}), about ${gb.toFixed(2)} GB fetched`;
}

export function removeDisclosures(outcome: SecretRemoveOutcome, path: string): string[] {
  const out: string[] = [];
  if (outcome.atRiskDownloads.length) {
    // WHAT THE REVOKE COST (#1378, #1409). Removing the credential a gated transfer is
    // authenticated with respawns the tool session, which changes each download's cache
    // identity — the `.partial` at 96% becomes unreachable and re-issuing starts from zero.
    //
    // Unlike the save path, this one collects no respawn reports, so whether the rebuild
    // has ALREADY happened is not established here. The sentence says so rather than
    // picking one: "already lost" would be a claim we did not check, and "will be lost"
    // invites the user to act on a transfer that may be dead already.
    out.push(
      `⚠️ ${atRiskDownloadSummary(outcome.atRiskDownloads)} — these were in flight when the ` +
        `credential was removed. Whether the tool session has been rebuilt yet is not reported ` +
        `on this path, but a rebuild changes each download's cache identity, so those transfers ` +
        `do NOT resume: re-issuing starts from 0% even though the partial files remain on disk ` +
        `(#1378).`,
    );
  }
  if (outcome.lostKeys.length) {
    out.push(
      `🛑 The store no longer carries ${outcome.lostKeys.join(", ")} — ` +
        `${outcome.lostKeys.length > 1 ? "those credentials were" : "that credential was"} lost during this removal. ` +
        `Inspect ${path} and restore ${outcome.lostKeys.length > 1 ? "them" : "it"} before relying on anything in it.`,
    );
  }
  if (outcome.uncertainty) {
    out.push(
      `⚠️ Whether this removal cost anything else is NOT established: ${outcome.uncertainty}. ` +
        `The key itself is gone; check ${path} before relying on the rest of it.`,
    );
  }
  if (outcome.lostCommentLines > 0) {
    out.push(
      `⚠️ ${outcome.lostCommentLines} comment line${outcome.lostCommentLines > 1 ? "s" : ""} in ${path} did not survive this removal.`,
    );
  }
  if (outcome.durabilityGap) {
    out.push(
      `⚠️ The removal was not made crash-durable: ${outcome.durabilityGap}. If the machine loses power, the credential may come back.`,
    );
  }
  if (outcome.resurrectionRisk) out.push(`🛑 ${outcome.resurrectionRisk}`);
  if (outcome.incomplete) out.push(`🛑 ${outcome.incomplete}`);
  return out;
}

/**
 * May a caller present this removal as a clean revoke?
 *
 * Only when the store demonstrably no longer carries the credential AND the
 * removal can account for what it cost. A revoke whose loss account was never
 * completed, that will be undone by the boot migration, or that only partly
 * ran, was still answering `200 {ok:true}` next to a warning saying exactly
 * that (codex gate) — and a consumer reads the flag, not the prose.
 *
 * Comment loss and a durability gap are deliberately NOT here: they are things
 * the revoke cost, not doubts about the revoke itself.
 */
export function revokeIsClean(outcome: SecretRemoveOutcome): boolean {
  return (
    outcome.lostKeys.length === 0 &&
    !outcome.uncertainty &&
    !outcome.resurrectionRisk &&
    !outcome.incomplete
  );
}

/**
 * May this change fire the "your token is now active — retry the action" nudge?
 *
 * The nudge is the loudest thing in the system: it is injected straight into the
 * agent's turn as an instruction, and it OUTRANKS the receipt the tool reply is
 * built from. It was gated on `requested` alone, so a save whose read-back could
 * not be taken — or one that destroyed other credentials — produced an honest
 * tool reply beside a message telling the agent it had worked, and the agent
 * follows the instruction (codex gate). That is #826 itself, in the one place
 * that speaks over the honest answer.
 *
 * A change with no verdict (a revoke, a background reload) never carries
 * `requested`, so it cannot reach here claiming a save.
 */
export function changeJustifiesRetryNudge(change: ComfyuiSecretChange): boolean {
  return change.requested === true && change.persisted === "yes" && !!change.tabId;
}

/**
 * Keys whose EVERY reader resolves them at ACCESS time from the canonical .env
 * (via env-file.ts freshSecretValue), so a value saved after a process started
 * is visible to it with no respawn:
 *   CIVITAI_API_TOKEN / HF_TOKEN / HUGGINGFACE_TOKEN → config.ts lazy getters
 *   RUNPOD_API_KEY                                    → services/runpod-client.ts
 *   REGISTRY_ACCESS_TOKEN                             → services/node-authoring.ts
 *
 * DELIBERATELY EXCLUDED, though they are allowlisted and do take effect in the
 * orchestrator's own process.env immediately:
 *   GEMINI_API_KEY / GOOGLE_* — forwarded into the Gemini CLI SUBPROCESS's spawn
 *     env (gemini-backend buildAgentSpawnEnv keep-list), so a live CLI keeps the
 *     old key until it is respawned (codex gate, round 1, answer A).
 *   OPENROUTER/GLM/KIMI/… — keyed backends capture the credential at
 *     construction (#278), so a live one keeps the old key until rebuilt.
 *   RUNCOMFY_API_KEY — no reader resolves it lazily.
 * For those the receipt says a respawn is needed and reports its actual
 * disposition, rather than claiming a pickup that a running subprocess will not
 * make. Over-claiming here is exactly the #826 defect in miniature.
 */
const LIVE_RELOAD_KEYS = new Set([
  "CIVITAI_API_TOKEN",
  "HF_TOKEN",
  "HUGGINGFACE_TOKEN",
  "RUNPOD_API_KEY",
  "REGISTRY_ACCESS_TOKEN",
]);

/** True when a saved value for `key` is picked up by EVERY one of its readers
 *  without any process being respawned. Presence-only; never touches a value. */
export function hasLivePickup(key: string): boolean {
  return LIVE_RELOAD_KEYS.has(key);
}

/**
 * The legacy store, or NULL when it exists but could not be read.
 *
 * The lenient `read()` below folds "unreadable" into "empty", and for a REVOKE
 * that is the difference between "there is nothing to purge" and "we cannot see
 * whether there is something to purge". The revoke reported a clean result on
 * the strength of the first while the file may still hold the key — and once it
 * becomes readable again the boot migration puts the credential back (codex
 * gate). Callers that only need best-effort content keep using `read()`.
 *
 * Rebase resolution: `main` (#859) threaded an optional `home` through this
 * reader so the suite can point the credential store at a temp dir instead of
 * the developer's real ~/.comfyui-mcp. That parameter is carried onto BOTH
 * functions here — dropping it would put the tests back to reading and writing
 * live credentials, which is the bug #859 fixed.
 */
function readOrNull(home?: string): PanelSecrets | null {
  const p = panelSecretsPath(home);
  if (!existsSync(p)) return {}; // genuinely absent: nothing to purge, and that IS known
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as PanelSecrets) : {};
  } catch (err) {
    // Never echo file contents (they're secret) — just the failure.
    logger.warn(`[panel-secrets] could not parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function read(home?: string): PanelSecrets {
  return readOrNull(home) ?? {};
}

function write(secrets: PanelSecrets): string | null {
  // The LEGACY store is a credential file too, redirected by its own env var —
  // and the runtime guard only ever covered the canonical one, so a test could
  // still rewrite the developer's real panel-secrets.json (codex gate).
  assertPanelSecretsRedirectedInTests();
  const p = panelSecretsPath();
  mkdirSync(dirname(p), { recursive: true });
  // Atomic for the same reason as the .env: an in-place truncate+write that is
  // interrupted leaves the OAuth status mirror and any legacy tokens destroyed.
  // (0600 is applied to the temp file before the rename, so the credential is
  // never briefly world-readable.)
  const durabilityGap = writeFileAtomic(p, JSON.stringify(secrets, null, 2));
  // RETURNED as well as logged. A caller that HAS a receipt must be able to
  // carry this: a revoke whose legacy purge was not made crash-durable can be
  // undone by a power loss, and the boot migration then resurrects the
  // credential the user just revoked — so `revokeIsClean` was able to answer
  // ok:true over it (codex gate). Callers with nowhere to put it still get the
  // log. Never the contents: a path and an errno only.
  if (durabilityGap) logger.warn(`[panel-secrets] ${durabilityGap}`);
  return durabilityGap;
}

// ── Canonical env-secret store: ~/.comfyui-mcp/.env ─────────────────────────
// The SINGLE source of truth for flat API-token secrets (RUNPOD/CIVITAI/HF/…).
// config.ts loads this file into process.env at boot for BOTH the orchestrator
// and every spawned comfyui-mcp agent, so a token here reaches everywhere with
// no separate injection. (Structured OAuth login state stays in the JSON store —
// it isn't a flat KEY=value env var.) Writes are a surgical single-line upsert:
// the rest of the user's .env — comments, other keys — is preserved byte-for-byte.

/** Path to the canonical dotenv. Delegates to env-file.ts, which is the SINGLE
 *  resolver config.ts (the reader, in this process AND in the spawned comfyui
 *  child) also uses — so the file we write can never be a different file from the
 *  one the tools read (#826). */
export function envFilePath(): string {
  return comfyuiEnvFilePath();
}

/**
 * Encode a value for a .env line.
 *
 * The previous encoder used JSON.stringify, which is NOT what dotenv decodes: a
 * double-quoted dotenv value only expands \n and \r, so a credential containing
 * a quote or a backslash was written JSON-escaped and read back with the escapes
 * still in it (codex gate, round 1, finding 3). That silently stored the WRONG
 * value. Encode in a form dotenv actually reverses:
 *   - bare when the value needs no quoting at all;
 *   - single-quoted (dotenv treats these literally — no escape expansion) when
 *     the value contains no single quote and no newline;
 *   - double-quoted with \n / \r escaped otherwise, which needs the value to
 *     carry no double quote and no backslash (dotenv would not undo those).
 * `encodeEnvValue` returns null when the value cannot be represented faithfully;
 * the caller REFUSES rather than writing something that reads back different.
 */
function envValueCandidates(value: string): string[] {
  return [
    value, // bare — only survives when the value needs no quoting at all
    `'${value}'`, // single-quoted: dotenv takes these literally
    `"${value}"`, // double-quoted
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`, // double-quoted, escaped
  ];
}

/**
 * Build the `KEY=value` line and PROVE dotenv reads it back as the same value.
 *
 * Candidates are TRIED, not guessed: a hand-picked encoding plus a "does this
 * round-trip?" check only validates the encoding it happened to choose, so a
 * value another encoding could store faithfully would be refused for no reason
 * (codex gate, round 2, finding 5). The first candidate dotenv reverses exactly
 * wins; only if none does is the value refused — before the file is touched, and
 * without ever including the value in the error.
 */
function encodeEnvLine(key: string, value: string): string {
  // Refuse CONTROL characters outright, before any encoding is considered.
  //   - a line break: this store's upsert/remove are LINE-based, so the next
  //     save of any OTHER key would match only the value's first physical line
  //     and leave its continuation behind as garbage;
  //   - a NUL: dotenv will round-trip it happily, so the read-back would CONFIRM
  //     the save — but process.env truncates at NUL, so the value the readers and
  //     the spawned child actually get is a different, shorter string (codex
  //     gate, round 3, finding 4). A confirmed save that delivers something else
  //     is the worst outcome of all;
  //   - any other C0 control: same class of hazard, no credential contains one.
  // eslint-disable-next-line no-control-regex
  // Written with \u escapes on purpose: a literal control byte in this
  // source would make the file read as a binary blob to git, unreviewable
  // in a diff.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(
      `The value supplied for "${key}" cannot be stored faithfully in ${envFilePath()} — it contains a control character ` +
        `(a line break, a NUL, or similar), which neither this line-based store nor a process environment can carry unchanged. Nothing was written. ` +
        `Set ${key} as a real environment variable instead (it takes precedence over the file), or re-issue it without control characters.`,
    );
  }
  for (const candidate of envValueCandidates(value)) {
    const line = `${key}=${candidate}`;
    try {
      if (dotenv.parse(line)[key] === value) return line;
    } catch {
      // Unrepresentable in this form — try the next.
    }
  }
  throw new Error(
    `The value supplied for "${key}" cannot be stored faithfully in ${envFilePath()} — ` +
      `no dotenv encoding of it reads back as the value given (this happens with combinations of quote, backslash and newline characters). ` +
      `Nothing was written. Set ${key} as a real environment variable instead (it takes precedence over the file), ` +
      `or re-issue a token without those characters.`,
  );
}

/**
 * Every line dotenv would read as an assignment to `key` — including the
 * `export KEY=…` form it accepts. Matching only `KEY=` left an `export` line
 * behind: an upsert would append a second assignment and a revoke would remove
 * the wrong one, leaving the OLD credential effective while the tool reported
 * the key cleared (codex gate, round 3, finding 2). Upsert and revoke share this
 * so they can never disagree about what "a line for this key" means.
 */
function envKeyLinePattern(key: string): RegExp {
  // Mirrors dotenv's own assignment forms: optional leading whitespace, an
  // optional `export `, then either `KEY=` (with optional space around the `=`)
  // or `KEY: ` — the colon form dotenv also accepts (codex gate, round 4,
  // finding 3). Missing the colon form meant an upsert APPENDED a second
  // assignment and a revoke left the colon line supplying the old credential.
  // The key is escaped even though every caller passes an allowlisted shell
  // identifier, so this can never become a pattern-injection surface.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:export\\s+)?${escaped}(?:\\s*=|:\\s)`);
}

/**
 * REFUSE to write the real credential store from a test run.
 *
 * `console-secrets.test.ts` drove the live /api/secrets endpoint without
 * redirecting COMFYUI_MCP_ENV_FILE, so every `npm test` overwrote the
 * developer's actual ~/.comfyui-mcp/.env — their CivitAI token became a dummy
 * and a revoke case deleted whichever slot it cleared. That ran unnoticed for
 * weeks.
 *
 * A static sweep over test sources cannot close this: a test that imports the
 * setter under an alias, or reaches a write through a helper, matches no marker
 * and passes the sweep. The RUNTIME can, because it sees the write itself
 * however the caller spelled it — so a forgotten redirect becomes a failing test
 * at the moment of the write instead of a silent overwrite (coordinator finding).
 */
function assertStoreIsRedirectedInTests(): void {
  if (!runningUnderTestRunner()) return; // detection is uncertain → ALLOW the write
  if (process.env.COMFYUI_MCP_ENV_FILE) return;
  throw new Error(
    "Refusing to write the credential store from a test run: COMFYUI_MCP_ENV_FILE is not set, " +
      `so this would write the developer's real ${comfyuiEnvFilePath()} and can destroy live tokens. ` +
      "Point COMFYUI_MCP_ENV_FILE at a temp file in the test's setup (see secret-store-test-isolation.test.ts).",
  );
}

/** The same refusal for the LEGACY json store, which has its own redirect. */
function assertPanelSecretsRedirectedInTests(): void {
  if (!runningUnderTestRunner()) return; // uncertain → ALLOW the write
  if (process.env.COMFYUI_MCP_PANEL_SECRETS) return;
  throw new Error(
    "Refusing to write the legacy credential store from a test run: COMFYUI_MCP_PANEL_SECRETS is not set, " +
      `so this would write the developer's real ${panelSecretsPath()} and can destroy live tokens and OAuth state. ` +
      "Point COMFYUI_MCP_PANEL_SECRETS at a temp file in the test's setup.",
  );
}

// `runningUnderTestRunner` lives in test-isolation-guard.ts, which is a leaf:
// the other real-home writers (panel-pin-guard, panel-settings,
// prompt-overrides) need the same predicate and must not pull this module in
// to get it. Re-exported so existing importers keep working.
export { runningUnderTestRunner } from "./test-isolation-guard.js";

/** Keys this write is ALLOWED to change. Anything else that the store carried
 *  before and does not carry after is DATA LOSS, and the caller must not report
 *  a clean save over it. */
export interface EnvWriteOutcome {
  /** The file changed on disk. */
  changed: boolean;
  /** Keys the store held BEFORE and no longer holds, other than the one this
   *  write was for. Never contains a value — names only. */
  lostKeys: string[];
  /** Non-assignment lines (comments, blanks) that did not survive the rewrite. */
  lostCommentLines: number;
  /**
   * Whether `lostKeys` is a COMPLETE account of what this write cost.
   *   "clean"   — the whole file was read back afterwards and every key it held
   *               before is accounted for.
   *   "unknown" — it is not established. Either the read-back could not be
   *               performed, or the store changed under us in a way that makes
   *               the account incomplete. NOT proof of loss — and not proof of
   *               safety either, which is the only reason it exists: an empty
   *               `lostKeys` from an account that was never taken must never be
   *               narrated as "nothing was lost".
   */
  lossCheck: "clean" | "unknown";
  /** Why `lossCheck` is "unknown" — one sentence, no values. Absent when clean. */
  lossCheckNote?: string;
  /** Null when the bytes reached the device and the rename was made durable as
   *  far as this platform allows. Otherwise a sentence naming exactly what could
   *  NOT be flushed. The write still LANDED (a rename is atomic either way); what
   *  is not established is that it survives a power loss — and an ignored fsync
   *  failure made a receipt claim exactly that (codex gate). */
  durabilityGap: string | null;
  /** A pre-write SNAPSHOT this operation could not delete. It holds the store as
   *  it was — for a revoke, that is the credential just removed, in a readable
   *  file next to the store. The stale sweep will not catch it either: a fresh
   *  snapshot belongs to a live writer and is deliberately left alone. */
  strayCopy?: string;
}

/** An errno for a message, without ever quoting file contents. */
function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code ?? (err instanceof Error ? err.name : "unknown error");
}

/**
 * Write EVERY byte, or throw before anything is renamed.
 *
 * `writeSync` is allowed to write fewer bytes than it was given, and both
 * writers took its word for it: a short write followed by an fsync makes a
 * TRUNCATED temp file durable, and the rename then installs it over the store —
 * the exact whole-file truncation this atomic write exists to prevent, arriving
 * by the one route nobody was checking (codex gate). Loop until the buffer is
 * out, and refuse to progress if it ever stops making progress; both happen
 * BEFORE the rename, so the store is untouched and refusing is correct.
 */
function writeAllSync(fd: number, body: string): void {
  const buf = Buffer.from(body, "utf8");
  let written = 0;
  while (written < buf.length) {
    const n = writeSync(fd, buf, written, buf.length - written);
    if (n <= 0) {
      throw new Error(
        `Could not write the credential store: the filesystem accepted ${written} of ${buf.length} bytes and then stopped. Nothing was written — the store is unchanged.`,
      );
    }
    written += n;
  }
}

/**
 * Delete the temp files and pre-write snapshots a CRASHED writer left behind.
 *
 * The snapshot is a hard link (or a copy) of the credential store, so a process
 * killed between the link and its cleanup leaves a readable file containing the
 * credentials as they were — including one the user has since revoked. Nothing
 * reads those files, but "revoked" has to mean the credential is gone, and a
 * later revoke was reporting a clean result while a copy of the token sat in the
 * same directory (codex gate).
 *
 * Only files OLDER than `ageMs` are touched: a live writer's sentinel exists for
 * microseconds, so this can never delete one out from under a concurrent save
 * (and if it somehow did, that save's account degrades to "unknown" — it does
 * not silently claim to be clean).
 *
 * Best effort by design; returns the paths it could NOT remove so a revoke can
 * disclose them.
 */
function sweepStaleSidecars(target: string, ageMs = 60_000): string[] {
  const dir = dirname(target);
  const base = `${basename(target)}.`;
  const survivors: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return survivors; // cannot list; nothing claimed either way
  }
  const cutoff = Date.now() - ageMs;
  for (const entry of entries) {
    if (!entry.startsWith(base)) continue;
    if (!/\.(tmp|pre)-/.test(entry.slice(base.length - 1))) continue;
    const full = join(dir, entry);
    try {
      if (statSync(full).mtimeMs > cutoff) continue; // a live writer's, leave it
      rmSync(full, { force: true });
    } catch {
      survivors.push(full);
    }
  }
  return survivors;
}

/**
 * Flush the DIRECTORY so a rename that happened is still there after a power
 * loss. `fsync` on the file makes its CONTENT durable; it says nothing about the
 * directory entry that now points at it, and a rename whose directory was never
 * synced can be lost while the temp file is gone too — leaving no file at all
 * where the store used to be. Omitting this is why "the write is durable" was a
 * claim rather than an observation (codex gate).
 *
 * Windows has no syncable directory handle: the open succeeds and `fsync`
 * answers EPERM, on every version. There is therefore nothing to attempt and
 * nothing that failed — NTFS journals the rename's own metadata. This function
 * says so by returning null there rather than reporting a durability gap on
 * every single save on that platform; what it never does is claim, anywhere,
 * that a directory sync happened when it did not.
 *
 * Returns null when there is no gap, or a sentence naming the gap.
 */
function syncDirectory(dir: string): string | null {
  if (process.platform === "win32") return null;
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
    return null;
  } catch (err) {
    const code = errCode(err);
    // ONLY "this filesystem does not implement directory syncing" is the
    // platform's answer rather than a failure of this write. EACCES and EISDIR
    // were also being swallowed, and neither means that: a directory can be
    // writable and searchable but not readable, so the rewrite succeeds while
    // `openSync(dir, "r")` is refused — no sync happened, and the receipt said
    // there was no gap. That is an unobserved durability claim, which is the
    // thing this whole field exists to stop (codex gate).
    if (code === "EINVAL" || code === "ENOTSUP") return null;
    return (
      `the rename was not made durable — syncing the directory ${dir} failed (${code}), ` +
      `so a power loss immediately after this save may leave the store without it`
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do; the sync verdict above already stands */
      }
    }
  }
}

/**
 * Rewrite the canonical .env ATOMICALLY, and prove nothing else was lost.
 *
 * The old in-place read/modify/write had two accidental failure modes on a real
 * machine, and BOTH were invisible because the read-back only checked our own
 * key (coordinator finding):
 *   - a crash or a full disk between truncate and flush left the user's whole
 *     credential store truncated — every token, not just the one being set;
 *   - two writers each read the old file and the later write silently dropped
 *     the other's newly saved key.
 * And in both cases the per-key read-back still said "yes", so we confirmed a
 * save over data loss — a fabricated success on top of destroyed credentials.
 *
 * So: write a temp file in the SAME directory, fsync it, then rename over the
 * target (rename is atomic on both POSIX and Windows, so a reader sees either
 * the whole old file or the whole new one — never a truncated one), then fsync
 * the directory so the rename itself is durable. Before the rename, re-read the
 * target and abort if it changed since we read it, which is the compare-and-swap
 * that stops a concurrent writer's key from being dropped; the caller retries
 * against the newer content. After the rename, compare the parsed keys and the
 * comment lines against what we started with, so a loss can be REPORTED rather
 * than confirmed as success.
 *
 * THE LOSS ACCOUNT IS TAKEN FROM THE FILE WE ACTUALLY REPLACED. This is the
 * part that was wrong. The compare-and-swap is a CHECK followed by a RENAME, and
 * those are two operations: a writer that lands between them is replaced by our
 * rename, and if the account is computed from the read we did EARLIER it appears
 * in neither snapshot — so its key was silently destroyed and the receipt still
 * said "saved, nothing lost" (codex gate). So immediately before the rename we
 * `link` the target to a sentinel — atomic, and it leaves the target in place —
 * and the account is computed against the SENTINEL: the content that was really
 * there at the swap. A writer that landed after the compare-and-swap check is
 * then reported as lost instead of vanishing.
 *
 * What remains unobservable is a writer landing between the `link` and the
 * `rename` — two adjacent syscalls with nothing in between. Closing even that
 * needs an OS-level lock this store does not take. So on top of the account we
 * refuse to claim it is COMPLETE whenever there is evidence of a live competitor
 * (a compare-and-swap conflict on an earlier attempt, a post-rename read that is
 * not what we wrote, or a sentinel we could not capture), which is what
 * `lossCheck` reports.
 *
 * Everything after the rename is a DISCLOSURE, never a refusal. The store has
 * already changed by then, so a failure to verify, chmod or sync must ride out
 * on the outcome. Throwing there turned a completed destructive operation into a
 * generic error the caller retried against a store that had already lost keys
 * (codex gate).
 */
function rewriteEnvFile(
  mutate: (lines: string[]) => string[] | null,
  opts: { intentionalKey?: string; removing?: boolean } = {},
): EnvWriteOutcome {
  assertStoreIsRedirectedInTests();
  const p = envFilePath();
  mkdirSync(dirname(p), { recursive: true });
  // Clear out anything a CRASHED writer left: a stale pre-write snapshot is a
  // readable copy of the credentials as they were, including ones since revoked.
  // Survivors are REPORTED, not dropped — the revoke path carried this
  // obligation and the save path did not, so a save could return
  // `persisted: "yes"` with an old credential still readable beside the store
  // (codex gate).
  const preexistingStrays = sweepStaleSidecars(p);

  const ATTEMPTS = 5;
  // OBSERVED evidence that another process is writing this store right now. It
  // survives a successful retry on purpose: the writer we collided with a moment
  // ago can equally have landed inside this attempt's check→rename window, where
  // nothing can see it.
  let sawConcurrentWriter = false;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const existed = existsSync(p);
    const raw = existed ? readFileSync(p, "utf-8") : "";

    const next = mutate(raw.length ? raw.split(/\r?\n/) : []);
    if (next === null) {
      // Nothing to change: no rename, so nothing to account for — except a
      // crashed writer's snapshot the sweep could not clear, which is still a
      // readable copy of the credentials and still the caller's to know about.
      return {
        changed: false,
        lostKeys: [],
        lostCommentLines: 0,
        lossCheck: "clean",
        durabilityGap: null,
        ...(preexistingStrays.length
          ? { strayCopy: `${preexistingStrays.join(", ")} (left by an interrupted earlier write)` }
          : {}),
      };
    }
    const body = next.join("\n");

    const nonce = randomBytes(6).toString("hex");
    const tmp = `${p}.tmp-${process.pid}-${nonce}`;
    // The snapshot of what we REPLACE, captured at the swap itself.
    const sentinel = `${p}.pre-${process.pid}-${nonce}`;
    let sentinelTaken = false;
    /** The snapshot came from a COPY, not a link. A copy is not atomic and takes
     *  measurable time, so it is a weaker observation than the link: a writer
     *  landing between the copy and the rename is invisible to it. */
    let sentinelViaCopy = false;
    /** Was there a file to replace at the moment of the swap? When there was
     *  not, "nothing was there" IS the snapshot — there is nothing to lose. */
    let targetExistedAtSwap = false;
    let fd: number | undefined;
    let durabilityGap: string | null = null;
    /** A pre-write snapshot that could not be deleted — this operation's own, or
     *  a crashed writer's that the sweep above could not clear. */
    let strayCopy: string | null = preexistingStrays.length
      ? `${preexistingStrays.join(", ")} (left by an interrupted earlier write)`
      : null;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeAllSync(fd, body);
      // Flush to the device before the rename: a rename that lands while the
      // bytes are still in the page cache can leave an empty file after a power
      // loss, which is the truncation this whole change exists to prevent.
      try {
        fsyncSync(fd);
      } catch (err) {
        // NOT swallowed. Proceeding is right — the rename is still atomic, so
        // the store is never left half-written — but a receipt that then says
        // "saved" over an unflushed write claims a durability nobody
        // established (codex gate). The gap rides out on the outcome instead.
        durabilityGap =
          `the new content could not be flushed to the device before the rename (fsync: ${errCode(err)}), ` +
          `so a power loss immediately after this save may leave ${p} without it`;
      }
      closeSync(fd);
      fd = undefined;

      // COMPARE-AND-SWAP: if the target changed since we read it, someone else
      // wrote in the meantime and our `next` was computed from stale content.
      // Retry against the newer file rather than clobbering their save.
      const current = existsSync(p) ? readFileSync(p, "utf-8") : "";
      if (current !== raw) {
        rmSync(tmp, { force: true });
        sawConcurrentWriter = true;
        continue;
      }
      // Capture the file we are about to replace, as late as it can be captured.
      // `link` is atomic and does NOT disturb the target, so unlike a
      // rename-aside it never leaves a moment where the store does not exist for
      // readers. Filesystems without hard links (exFAT, some network mounts) fall
      // back to a copy; if neither works the account falls back to `raw` and the
      // outcome says the swap could not be snapshotted.
      // The link is ATTEMPTED unconditionally — never gated on an `existsSync`
      // first. Asking "does it exist?" and then acting is another check-then-act
      // pair, and it had exactly the bug the sentinel exists to fix: a writer
      // that CREATED the store between the check and the rename was clobbered
      // while we recorded "there was nothing there" and reported a clean save
      // (codex gate). ENOENT from the link is itself the observation, taken at
      // the same instant as the snapshot would have been.
      try {
        linkSync(p, sentinel);
        sentinelTaken = true;
        targetExistedAtSwap = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          targetExistedAtSwap = false; // OBSERVED: nothing to replace
        } else {
          // Filesystems without hard links (exFAT, some network mounts). A copy
          // is not atomic, but it is still a snapshot taken at the swap.
          try {
            copyFileSync(p, sentinel);
            sentinelTaken = true;
            sentinelViaCopy = true;
            targetExistedAtSwap = true;
            // copyFileSync creates with the default mode, and this file is a
            // copy of the credential store — put it back to owner-only at once.
            try {
              chmodSync(sentinel, 0o600);
            } catch {
              /* no-op on Windows */
            }
          } catch (copyErr) {
            if ((copyErr as NodeJS.ErrnoException)?.code === "ENOENT") {
              targetExistedAtSwap = false;
            } else {
              // Neither worked: we are about to replace something we could not
              // look at. Reported below as an incomplete account.
              targetExistedAtSwap = true;
            }
          }
        }
      }
      // #881 — THE SWAP WINDOW. The compare-and-swap above closes the gap
      // between our first read and our decision. It cannot close the gap between
      // that check and this rename, and a writer landing in THAT window was
      // overwritten silently: the loss account compares the store against the
      // sentinel, which was captured before their write, so it saw only our own
      // intended changes and reported the save clean. Losing another process's
      // credential is bad; reporting it as a clean save is what made it
      // undiagnosable.
      //
      // Re-read at the LAST possible moment and retry if the file moved under
      // us. Retrying (rather than refusing) is what preserves their key: the
      // next pass recomputes `next` from their content, so both writes survive.
      //
      // Compared by CONTENT, not by inode. st_ino is the more precise signal —
      // the sentinel is a hard link, so a replacement gives `p` a new inode
      // while the sentinel keeps the old one — but Node reports an unstable or
      // zero `ino` on Windows, which is the platform this store is most used on.
      // A content comparison is exact everywhere and costs one small read.
      //
      // HONEST LIMIT: this NARROWS the window, it does not close it. A writer
      // landing between this read and the rename below is still unobservable
      // without an OS-level atomic compare-and-swap, which no portable API
      // offers. What it removes is the SILENT part — after this, a collision we
      // can see is retried instead of clobbered.
      if (sentinelTaken) {
        // readFileSync + catch, NOT existsSync-then-read: this is a
        // check-then-act pair otherwise, and the read is the observation anyway.
        let atSwap = "";
        try {
          atSwap = readFileSync(p, "utf-8");
        } catch {
          atSwap = ""; // gone entirely — also a change
        }
        if (atSwap !== raw) {
          rmSync(tmp, { force: true });
          rmSync(sentinel, { force: true });
          sentinelTaken = false;
          sawConcurrentWriter = true;
          continue;
        }
      }
      renameSync(tmp, p);
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      // Cleanup must not replace the real error with its own — a catch that can
      // throw is not a catch.
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* a stray temp file is not worth losing the reason for */
      }
      let leftBehind: string | null = null;
      try {
        rmSync(sentinel, { force: true });
      } catch (rmErr) {
        // The snapshot is a link to the store as it is RIGHT NOW, and it is
        // FRESH — so the stale sweep will skip it for the next minute as a live
        // writer's. Dropping this failure left a readable copy of the
        // credentials behind with nothing saying so, and a revoke moments later
        // could report clean over it (codex gate). The refusal below is still
        // correct — the store is untouched — but it must carry this.
        leftBehind = `${sentinel} (${errCode(rmErr)})`;
      }
      // Still BEFORE the rename: the store is untouched, so refusing is correct
      // and the caller's "nothing was written" is true.
      if (leftBehind) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)} ` +
            `Nothing was written to ${p}. However, a pre-write snapshot could not be cleaned up: ${leftBehind} — ` +
            `it is a readable copy of the credential store as it is now. Delete it by hand.`,
        );
      }
      throw err;
    }

    // ─── AFTER THE RENAME. The store has changed. Nothing below may throw. ───
    // The BASIS for the loss account: what was really under the rename, not what
    // we read before deciding. When the two differ, a writer landed after the
    // compare-and-swap check — the exact case that used to disappear without
    // trace, and the reason `basisRaw` exists at all.
    let basisRaw = targetExistedAtSwap ? raw : "";
    let basisIsSnapshot = !targetExistedAtSwap || sentinelTaken;
    if (sentinelTaken) {
      try {
        basisRaw = readFileSync(sentinel, "utf-8");
      } catch {
        basisIsSnapshot = false;
        basisRaw = raw;
      }
    }
    // GUARDED. `rmSync` can fail (EPERM, EBUSY on Windows), and this is after
    // the rename — an unguarded cleanup that throws here would discard the whole
    // disclosure about a store that has already changed, which is the very
    // failure mode this section exists to prevent (codex gate). A sentinel we
    // cannot remove is clutter in the user's own 0600 directory, so it is
    // reported to the log by NAME and never allowed to cost the receipt.
    try {
      rmSync(sentinel, { force: true });
    } catch (err) {
      // REPORTED, not only logged. This snapshot holds the store as it was —
      // for a REVOKE, that is the credential the user just removed, sitting in a
      // readable file next to the store. The sweep will not catch it either: it
      // deliberately skips fresh files, because a fresh one belongs to a live
      // writer. So a revoke could come back clean with the old token still on
      // disk (codex gate). It rides out on the outcome instead.
      strayCopy = strayCopy
        ? `${strayCopy}; ${sentinel} (${errCode(err)})`
        : `${sentinel} (${errCode(err)})`;
      logger.warn(
        `[panel-secrets] could not remove the pre-write snapshot ${sentinel} (${errCode(err)}); ` +
          `it is a copy of the credential store and can be deleted by hand.`,
      );
    }
    const before = dotenvParseSafe(basisRaw);
    const beforeComments = commentLines(basisRaw);

    const dirGap = syncDirectory(dirname(p));
    if (dirGap && !durabilityGap) durabilityGap = dirGap;
    try {
      chmodSync(p, 0o600);
    } catch {
      /* chmod is a no-op on Windows; ignore */
    }

    // WHOLE-FILE verification. "Our key is present" is not enough — that is
    // exactly the check that confirmed a save while other tokens were lost.
    let afterRaw: string | null;
    try {
      afterRaw = existsSync(p) ? readFileSync(p, "utf-8") : "";
    } catch (err) {
      // The rename already happened. We cannot say what is in the store, and we
      // must not say "nothing was lost" from an account we could not take.
      return {
        changed: body !== raw,
        lostKeys: [],
        lostCommentLines: 0,
        lossCheck: "unknown",
        lossCheckNote:
          `${p} was rewritten but could not be read back afterwards (${errCode(err)}), ` +
          `so whether it still carries the other credentials it held is not established`,
        durabilityGap,
        ...(strayCopy ? { strayCopy } : {}),
      };
    }
    const after = dotenvParseSafe(afterRaw);
    const lostKeys: string[] = [];
    for (const k of Object.keys(before)) {
      if (opts.intentionalKey && k === opts.intentionalKey) continue;
      if (!(k in after)) lostKeys.push(k);
    }
    // Verify against what we ACTUALLY WROTE, not merely against what we expected
    // to find. A file that is no longer our content means a writer landed after
    // our rename — observable, unlike the link→rename window, and it makes the
    // key account incomplete in exactly the same way.
    const raced = afterRaw !== body;
    // `lostKeys` is a COMPLETE account only when we snapshotted what we replaced
    // and nothing rewrote the file afterwards. Anything else and the empty list
    // means "we did not see any", not "there were none".
    const lossCheckNote = raced
      ? `${p} does not read back as the content this save wrote, so something else rewrote it in the meantime; ` +
        `what that write kept or dropped is not established here`
      : !basisIsSnapshot
        ? `the state this save replaced in ${p} could not be snapshotted, so the loss account rests on a read taken before the swap ` +
          `and cannot cover a write that landed after it`
        : sentinelViaCopy
          ? `this filesystem does not support hard links, so the state this save replaced was snapshotted by COPYING it — ` +
            `which is not atomic and takes measurable time, unlike the link used elsewhere. A write landing during that copy, ` +
            `or between it and the rename, is not covered by the account above`
          : sawConcurrentWriter
          ? `another process was writing ${p} during this save (a compare-and-swap conflict was hit and retried). ` +
            `The store is re-read immediately before the rename, so a write that landed up to that point was seen and retried ` +
            `against rather than replaced (#881); but that read and the rename are still two adjacent operations, and a write ` +
            `landing in the gap between them is replaced by this one without appearing in any read — this save cannot rule that out`
          : null;
    return {
      changed: afterRaw !== raw,
      lostKeys,
      lostCommentLines: Math.max(0, beforeComments - commentLines(afterRaw)),
      lossCheck: lossCheckNote ? "unknown" : "clean",
      ...(lossCheckNote ? { lossCheckNote } : {}),
      durabilityGap,
      ...(strayCopy ? { strayCopy } : {}),
    };
  }
  throw new Error(
    `Could not update ${p}: another process changed it during each of ${ATTEMPTS} attempts. ` +
      `Nothing was written — retry, or close whatever else is writing the credential store.`,
  );
}

/** dotenv.parse that never throws — an unreadable/garbage store yields {}. */
function dotenvParseSafe(raw: string): Record<string, string> {
  try {
    return dotenv.parse(raw);
  } catch {
    return {};
  }
}

/** How many non-empty, non-assignment lines (i.e. comments) the text carries.
 *  Used only to DETECT loss; the lines themselves are never reported. */
function commentLines(raw: string): number {
  return raw.split(/\r?\n/).filter((l) => l.trim().startsWith("#")).length;
}

/** Upsert `KEY=value` into the canonical .env, 0600, preserving every other line
 *  (comments included). Replaces the FIRST uncommented `KEY=` line and DROPS any
 *  later duplicates, else appends. Dropping the duplicates matters: dotenv lets a
 *  later assignment win, so replacing only the first would leave a stale line
 *  authoritative — the save would report a value the readers never resolve
 *  (codex gate, round 2, finding 3). The read-back would catch it, but leaving
 *  one line for the key means there is nothing to catch. */
function upsertEnvFile(key: string, value: string): EnvWriteOutcome {
  // Encode + verify BEFORE touching the file, so an unrepresentable value never
  // half-lands (it would read back different and look like tampering).
  const line = encodeEnvLine(key, value);
  const re = envKeyLinePattern(key);
  return rewriteEnvFile(
    (original) => {
      const lines: string[] = [];
      let replaced = false;
      for (const existing of original) {
        if (re.test(existing)) {
          if (!replaced) {
            lines.push(line);
            replaced = true;
          }
          continue; // a later duplicate would outrank the line we just wrote
        }
        lines.push(existing);
      }
      if (!replaced) {
        // Drop a single trailing empty line so we don't accumulate blanks, then add.
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        lines.push(line);
        lines.push("");
      }
      return lines;
    },
    { intentionalKey: key },
  );
}

/**
 * Remove EVERY uncommented assignment to `key` from the canonical .env
 * (including the `export KEY=` form dotenv honors). A revoke that leaves one
 * form behind reports the credential cleared while it is still in effect.
 *
 * This used to THROW when the rewrite also lost other keys. That inverted the
 * repo's own rule: the removal had already happened, so the throw turned a
 * COMPLETED destructive operation into a generic failure, which the console then
 * rendered as `ok:false` and the caller retried — a second removal against a
 * store that had already lost credentials (codex gate). Everything after the
 * rename is a DISCLOSURE. The loss now rides out on the outcome.
 */
function removeEnvFileKey(key: string): EnvWriteOutcome {
  // BEFORE the early return. `rewriteEnvFile` asserts this, but the "no file, so
  // nothing to do" shortcut returned in front of it — and the caller
  // (`removeEnvSecret`) then went on to purge and REWRITE the legacy
  // panel-secrets.json, so a test that reached a removal through a helper could
  // still delete the developer's real legacy credential (codex gate). A guard
  // with a path around it is not a guard.
  assertStoreIsRedirectedInTests();
  const p = envFilePath();
  if (!existsSync(p)) {
    return { changed: false, lostKeys: [], lostCommentLines: 0, lossCheck: "clean", durabilityGap: null };
  }
  const re = envKeyLinePattern(key);
  return rewriteEnvFile(
    (lines) => {
      const kept = lines.filter((l) => !re.test(l));
      return kept.length === lines.length ? null : kept; // nothing to remove
    },
    { intentionalKey: key, removing: true },
  );
}

/** Legacy JSON store writer — kept atomic, and durable, for the same reasons.
 *  Returns a durability gap sentence, or null. Like the .env writer it never
 *  throws for anything that happens AFTER the rename. */
function writeFileAtomic(target: string, body: string): string | null {
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd: number | undefined;
  let durabilityGap: string | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeAllSync(fd, body);
    try {
      fsyncSync(fd);
    } catch (err) {
      // Same rule as the .env writer: an ignored fsync failure is a durability
      // claim nobody checked (codex gate). Proceed, but report it.
      durabilityGap =
        `the new content could not be flushed to the device before the rename (fsync: ${errCode(err)}), ` +
        `so a power loss immediately after this write may leave ${target} without it`;
    }
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    rmSync(tmp, { force: true });
    // Still BEFORE the rename — the target is untouched, so refusing is correct.
    throw err;
  }
  // ─── AFTER THE RENAME. Nothing below may throw. ───
  // A rename is not durable until the DIRECTORY it happened in is synced: the
  // new name can be lost while the temp name is gone too, leaving no file where
  // the store used to be. This was missing here as well as in the .env writer.
  const dirGap = syncDirectory(dirname(target));
  if (dirGap && !durabilityGap) durabilityGap = dirGap;
  try {
    chmodSync(target, 0o600);
  } catch {
    /* ignore */
  }
  return durabilityGap;
}

/** True when `key` may be persisted (union of the comfyui-tool + agent-provider
 *  allowlists — both now land in the same canonical .env). */
export function isAllowedSecretKey(key: string): boolean {
  return isAllowedComfyuiSecretKey(key) || isAllowedAgentSecretKey(key);
}

/**
 * THE canonical secret setter: persist a flat token to ~/.comfyui-mcp/.env,
 * apply it to process.env immediately (so in-process readers see it now), and
 * emit so the orchestrator re-probes provider readiness AND respawns the agent
 * on idle (the respawn reloads .env → the child gets the new key). Rejects a
 * non-allowlisted key so a stray key can never be written.
 */
export function setEnvSecret(
  key: string,
  value: string,
  opts: { requested?: boolean; tabId?: string } = {},
): SecretSaveReceipt {
  const trimmed = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid env var name "${key}" — use a valid shell identifier.`);
  }
  if (!isAllowedSecretKey(trimmed)) {
    throw new Error(
      `Env var "${trimmed}" is not an accepted secret. Allowed: ${[...new Set([...COMFYUI_SECRET_ENV_ALLOWLIST, ...AGENT_SECRET_ENV_ALLOWLIST])].join(", ")}.`,
    );
  }
  if (value.trim() === "") {
    // A blank/whitespace-only value WRITES and READS BACK fine, so the save
    // would be confirmed — while every reader (freshSecretValue) treats a blank
    // as absent and every request stays unauthenticated. That is precisely the
    // #826 shape: a confirmed save nothing downstream can use (codex gate,
    // round 2, finding 1). Refuse it up front; nothing is written.
    throw new Error(
      `No value was supplied for "${trimmed}" (it was empty or whitespace only). Nothing was saved — the credential is still unset.`,
    );
  }
  const previous = process.env[trimmed];
  const previouslyShellProvided = isShellProvided(trimmed);
  const writeOutcome = upsertEnvFile(trimmed, value);
  // A REAL environment variable outranks the store — that is this codebase's own
  // rule, and the panel does not get to break it. Overwriting process.env here
  // (and calling markFileDerived on it) replaced the live shell value AND
  // relabelled its provenance, so behaviour changed again after a full restart
  // when the shell value came back (coordinator finding). The value IS written
  // to the store, so it takes effect the moment the env var is unset; until then
  // the receipt says plainly that it is not the value in use.
  if (!previouslyShellProvided) {
    process.env[trimmed] = value; // live in-process effect
    // The canonical file is now this key's AUTHORITY even though we just assigned
    // process.env, so a later re-read (a rotate by another process, a revoke) wins
    // over this in-memory copy instead of being pinned by it.
    markFileDerived(trimmed);
  }
  // VERIFY the write by reading the canonical file back. Reporting "saved" from
  // the mere absence of a throw is how a caller ends up believing it is
  // configured while nothing downstream can see the value (#826). The comparison
  // is against the value we already hold; neither the stored nor the supplied
  // value is logged, and only the verdict leaves this function.
  //
  // ORDER MATTERS. "yes" is the verdict for a save that is BOTH proven and
  // clean, so every weaker outcome has to be able to displace it:
  //   - the store unreadable            → unknown (nothing established)
  //   - the key not carrying the value  → no
  //   - other credentials proven gone   → damaged (worse than unknown; say so)
  //   - the loss account not completed  → unknown (an empty lostKeys from an
  //                                       account never taken is not "nothing
  //                                       was lost")
  const readBack = parseEnvFile();
  let persisted: SecretSaveReceipt["persisted"];
  let uncertainty: string | undefined;
  if (readBack === null) {
    persisted = "unknown";
    uncertainty = `${envFilePath()} could not be read back, so whether the value reached the store is not established`;
  } else if (readBack[trimmed] !== value) {
    persisted = "no";
  } else if (writeOutcome.lostKeys.length) {
    persisted = "damaged";
  } else if (writeOutcome.lossCheck === "unknown") {
    persisted = "unknown";
    uncertainty =
      `${trimmed} does read back from ${envFilePath()} with the value supplied, but this save cannot account for the rest of the store: ` +
      `${writeOutcome.lossCheckNote ?? "the whole-file check could not be completed"}`;
  } else {
    persisted = "yes";
  }
  if (persisted === "no") {
    // The durable store demonstrably does not carry this value. ROLL BACK the
    // in-process assignment and emit NOTHING, so the system is left exactly as it
    // was and the caller's "nothing is configured" is TRUE (codex gate, round 1,
    // finding 2: without this, the value was live in the orchestrator's env — and
    // would be injected into the next child — while the tool reported failure,
    // the opposite false verdict).
    if (previous === undefined) delete process.env[trimmed];
    else process.env[trimmed] = previous;
    // Restore the key's PRECEDENCE too — leaving it marked file-derived would
    // change how the restored value resolves from here on (codex gate, round 2,
    // finding 3).
    if (previouslyShellProvided) unmarkFileDerived(trimmed);
    return {
      key: trimmed,
      path: envFilePath(),
      persisted,
      ...(uncertainty ? { uncertainty } : {}),
      livePickup: hasLivePickup(trimmed),
      respawn: null,
      // The store may ALSO have lost other keys on the way to not saving this
      // one. That is the same disclosure as on any other verdict, and dropping
      // it here because the headline is already a refusal would hide the worse
      // half of what happened.
      ...(writeOutcome.lostKeys.length ? { lostKeys: writeOutcome.lostKeys } : {}),
      ...(writeOutcome.lostCommentLines ? { lostCommentLines: writeOutcome.lostCommentLines } : {}),
      ...(writeOutcome.durabilityGap ? { durabilityGap: writeOutcome.durabilityGap } : {}),
    ...(writeOutcome.strayCopy ? { strayCopy: writeOutcome.strayCopy } : {}),
      // Whether a credential for this key is STILL in effect after the rollback.
      // "Nothing is configured" is false when a previous working value survived,
      // and telling the user that would send them hunting the wrong problem.
      // Presence only — the value is neither returned nor logged.
      stillConfigured: freshSecretValue(trimmed) !== undefined,
    };
  }
  // Only a COMFYUI tool secret should restart the comfyui MCP child + inject the
  // "retry the download that needed this token" nudge (#269): saving an
  // agent-ONLY provider key (OPENROUTER/GLM/KIMI…) previously restarted every
  // agent with that nonsensical download-retry message. Agent-only keys fire
  // just "agentChange" (readiness/model refresh) below.
  // `requested` rides the change so the orchestrator only injects the retry
  // nudge when this save ANSWERS an outstanding panel_request_secret — a
  // Settings slot save / background reload / revoke leaves it false (#164).
  // Collect what listeners actually did. `emit` is SYNCHRONOUS, so every report
  // has landed by the time this returns — the receipt describes observed work,
  // not an intention. No listener → `respawn: null`, never a fabricated zero.
  const reports: SecretRespawnReport[] = [];
  // #1378 — SNAPSHOT BEFORE THE EMIT, because the emit is where the damage happens.
  //
  // `emitComfyuiChange` is synchronous and a listener may replace its tool session inside
  // it, so by the time the receipt is rendered those downloads are already orphaned. My
  // first version enumerated them afterwards and told the user "let them finish and save
  // the credential afterwards" about transfers that had been dead for a tick — advice that
  // was not merely useless but wrong about what had happened.
  //
  // Taken before, the list is what WAS in flight, which is the right thing to report in
  // both cases: still running for a queued respawn, already lost for an applied one. The
  // receipt words those differently.
  let atRiskDownloads: AtRiskDownloads = [];
  if (isAllowedComfyuiSecretKey(trimmed))
    atRiskDownloads = emitComfyuiChange({
      requested: opts.requested === true,
      // The verdict rides along, so a listener cannot make a louder claim than
      // the receipt does. `persisted` is already settled at this point.
      persisted,
      tabId: opts.tabId,
      report: (r: SecretRespawnReport) => reports.push(r),
    });
  if (isAllowedAgentSecretKey(trimmed)) emitAgentChange(); // flip provider readiness live
  return {
    atRiskDownloads,
    key: trimmed,
    path: envFilePath(),
    persisted,
    ...(uncertainty ? { uncertainty } : {}),
    livePickup: hasLivePickup(trimmed),
    ...(previouslyShellProvided ? { shadowedByEnv: true } : {}),
    ...(writeOutcome.lostKeys.length ? { lostKeys: writeOutcome.lostKeys } : {}),
    // Computed by the writer and, until now, dropped on the floor right here —
    // so a rewrite that lost the user's comments was acknowledged as a healthy
    // save on every consumer path while the code claimed it preserved them
    // (codex gate).
    ...(writeOutcome.lostCommentLines ? { lostCommentLines: writeOutcome.lostCommentLines } : {}),
    ...(writeOutcome.durabilityGap ? { durabilityGap: writeOutcome.durabilityGap } : {}),
    ...(writeOutcome.strayCopy ? { strayCopy: writeOutcome.strayCopy } : {}),
    respawn: reports.length
      ? reports.reduce(
          (a, b) => ({
            live: a.live + b.live,
            applied: a.applied + b.applied,
            scheduled: a.scheduled + b.scheduled,
          }),
          { live: 0, applied: 0, scheduled: 0 },
        )
      : null,
  };
}

/**
 * What a removal actually did. A revoke is DESTRUCTIVE, so it returns the same
 * account a save does: a boolean cannot carry "and it also lost your other
 * tokens", and the version that threw that fact instead turned a completed
 * removal into a retryable-looking failure (codex gate).
 */
export interface SecretRemoveOutcome {
  /** Something changed: a store line removed, the in-process copy dropped, or a
   *  legacy JSON entry purged. */
  changed: boolean;
  /**
   * Downloads that were in flight when this revoke was about to respawn the tool session
   * (#1378, #1409). Same field and same capture point as `SecretSaveReceipt` — a revoke
   * reaches the same synchronous emit, and removing the credential a gated transfer is
   * authenticated with is at least as likely to cost one as replacing it.
   *
   * Empty when nothing changed (no emit, so nothing was at risk) and when the key is not
   * a ComfyUI one — never absent, so a caller need not distinguish "none" from "not
   * reported".
   */
  atRiskDownloads: AtRiskDownloads;
  /** OTHER credential keys the store held before and no longer holds. Names
   *  only. Non-empty means the revoke happened AND cost something else. */
  lostKeys: string[];
  /** Comment lines the rewrite did not preserve. */
  lostCommentLines: number;
  /** Present when the removal's whole-file account could not be completed —
   *  `lostKeys` is then not a statement that nothing else was lost. */
  uncertainty?: string;
  /** Present when the removal LANDED but was not established to survive a power
   *  loss. */
  durabilityGap?: string;
  /** The canonical store no longer carries the key, but the LEGACY json store
   *  could not be purged — so the boot migration puts it back. A revoke that
   *  returns on the next start is not a revoke, and the caller must say so. */
  resurrectionRisk?: string;
  /** Part of a multi-alias revoke could not be performed, while another part
   *  already had been. Present only when something WAS removed — when nothing
   *  was, the operation refuses instead. */
  incomplete?: string;
}

/** Canonical remover: drop a token from .env + process.env + emit. Also PURGES
 *  the legacy panel-secrets.json maps (#269): without this a key revoked from
 *  .env would RESURRECT on the next boot, because migrateSecretsToEnv() re-adds
 *  any key still present in the JSON store that .env no longer provides. */
export function removeEnvSecret(key: string): SecretRemoveOutcome {
  const outcome = removeEnvFileKey(key);
  const removed = outcome.changed;
  // Dropping the IN-PROCESS value is a change in its own right. A SHELL-provided
  // key has no line in the store, so `removed` is false — and gating the emit on
  // `removed` alone meant no child was ever respawned for it, leaving a live
  // tool session using a credential the user had just revoked while the console
  // answered that it no longer resolves (codex gate, round 6, finding 1). The
  // respawn is what actually takes it out of the child's env.
  const envDeleted = process.env[key] !== undefined;
  if (envDeleted) delete process.env[key];
  // Purge the legacy JSON maps so a revoked key can't resurrect via migration.
  // This runs AFTER the .env removal has already landed, so it must not throw:
  // the revoke has happened, and a throw here made the console answer a generic
  // failure with no `cleared` and no "do not retry" — turning a completed
  // destructive operation back into a refusal (codex gate). A purge that failed
  // is a DISCLOSURE, and a specific one: the key comes back on the next start.
  let purgedJson = false;
  let resurrectionRisk: string | undefined;
  try {
    const s = readOrNull();
    if (s === null) {
      // NOT "there is nothing to purge" — we could not look. The file may still
      // hold this key, and the boot migration re-adds any legacy key the
      // canonical store no longer provides (codex gate).
      resurrectionRisk =
        `"${key}" was removed from ${envFilePath()}, but the legacy store ${panelSecretsPath()} could not be READ, ` +
        `so whether it still holds an entry for this key is not established. If it does, the boot migration re-adds this credential on the next start. ` +
        `Check that file before relying on the revoke.`;
      logger.warn(`[panel-secrets] ${resurrectionRisk}`);
    } else {
    for (const map of [s.comfyuiEnv, s.agentEnv]) {
      if (map && Object.prototype.hasOwnProperty.call(map, key)) {
        delete map[key];
        purgedJson = true;
      }
    }
    if (purgedJson) {
      const jsonGap = write(s);
      if (jsonGap) {
        // The purge LANDED but is not established to survive a power loss — and
        // the consequence is specific: if it is lost, the legacy entry is back
        // and the boot migration re-adds the credential. That is the same
        // outcome as a failed purge, so it is reported the same way rather than
        // as a generic durability note nobody connects to the revoke.
        resurrectionRisk =
          `"${key}" was removed from both stores, but purging the legacy store ${panelSecretsPath()} was not made crash-durable: ${jsonGap}. ` +
          `If the machine loses power before the filesystem flushes on its own, that entry returns and the boot migration re-adds this credential. ` +
          `Re-check ${panelSecretsPath()} after any unclean shutdown.`;
      }
    }
    }
  } catch (err) {
    purgedJson = false;
    resurrectionRisk =
      `"${key}" was removed from ${envFilePath()}, but the legacy store ${panelSecretsPath()} could not be purged (${errCode(err)}). ` +
      `It still holds an entry for this key, and the boot migration re-adds any legacy key the canonical store does not provide — so this credential COMES BACK on the next start. ` +
      `Remove it from that file by hand to revoke it permanently.`;
    logger.warn(`[panel-secrets] ${resurrectionRisk}`);
  }
  // A pre-write snapshot a crashed writer left behind is a readable copy of the
  // store as it was — with this credential still in it. `rewriteEnvFile` sweeps
  // them, so this only names the ones that could not be removed: a revoke must
  // not report the credential gone while a copy of it is sitting next to the
  // store (codex gate).
  // The snapshot THIS removal took and could not delete is fresh, so the sweep
  // below deliberately leaves it — it cannot tell a live writer's from ours.
  // It holds the credential we just revoked, so it must be named here.
  if (outcome.strayCopy && !resurrectionRisk) {
    resurrectionRisk =
      `"${key}" was removed from ${envFilePath()}, but the pre-write snapshot this removal took could not be deleted: ${outcome.strayCopy}. ` +
      `That file is a link to the store as it stood BEFORE the revoke — so it still holds the credential just removed. Delete it by hand.`;
    logger.warn(`[panel-secrets] ${resurrectionRisk}`);
  }
  const strayCopies = sweepStaleSidecars(envFilePath());
  if (strayCopies.length && !resurrectionRisk) {
    // Provenance only as far as the file KIND establishes it. A `.pre-*` is a
    // snapshot of the store as it was; a `.tmp-*` is an unfinished write's
    // proposed content — a different thing, and neither is opened to look.
    resurrectionRisk =
      `"${key}" was removed from ${envFilePath()}, but ${strayCopies.length} leftover file${strayCopies.length > 1 ? "s" : ""} from an interrupted write could not be deleted ` +
      `(${strayCopies.join(", ")}). ${strayCopies.length > 1 ? "They are" : "It is"} a store snapshot or an unfinished write's content — not read here — so ${strayCopies.length > 1 ? "they" : "it"} may still hold this credential. ` +
      `Delete ${strayCopies.length > 1 ? "them" : "it"} by hand.`;
    logger.warn(`[panel-secrets] ${resurrectionRisk}`);
  }
  const changed = removed || purgedJson || envDeleted;
  // #1378 — REVOKE ORPHANS DOWNLOADS TOO (codex P1, filed separately as #1409).
  //
  // The fix landed on the SET path only, and revoke reaches the same emit two functions
  // later. A listener replacing its tool session inside that synchronous emit kills an
  // in-flight transfer whether the credential was written or removed — and removing the
  // credential a gated download is authenticated with is, if anything, the likelier way to
  // lose one. Snapshot before the emit for the same reason as above: afterwards the
  // transfers are already gone and the list is empty, which reads as "nothing was at risk".
  let atRiskDownloads: AtRiskDownloads = [];
  if (changed) {
    // comfyui-only restart (#269). The emit reports what it cost — see emitComfyuiChange:
    // under suspended emissions (a rollback) it emits nothing and costs nothing, which is
    // why this is not a snapshot taken beside the call.
    if (isAllowedComfyuiSecretKey(key)) atRiskDownloads = emitComfyuiChange({});
    if (isAllowedAgentSecretKey(key)) emitAgentChange();
  }
  return {
    changed,
    atRiskDownloads,
    lostKeys: outcome.lostKeys,
    lostCommentLines: outcome.lostCommentLines,
    ...(outcome.lossCheck === "unknown"
      ? {
          uncertainty:
            outcome.lossCheckNote ??
            `the whole-file check could not be completed, so whether removing "${key}" cost anything else is not established`,
        }
      : {}),
    ...(outcome.durabilityGap ? { durabilityGap: outcome.durabilityGap } : {}),
    ...(resurrectionRisk ? { resurrectionRisk } : {}),
  };
}

/**
 * One-time migration to the canonical .env: any flat token still living in the
 * legacy panel-secrets.json (comfyuiEnv / agentEnv) is upserted into .env unless
 * .env / a real env var already provides it. NON-DESTRUCTIVE — it only ADDS
 * missing keys; it never rewrites unrelated .env lines and never deletes from the
 * JSON store (left inert). Idempotent. Returns the keys migrated.
 *
 * This runs at BOOT, where there is no receipt to hand anything back on — so
 * what the write cost is LOGGED rather than dropped. It was being discarded
 * outright, and the key then reported as migrated and hydrated into process.env,
 * so a migration that destroyed another credential looked like a clean start
 * (codex gate). Key NAMES only ever reach the log.
 */
export function migrateSecretsToEnv(): string[] {
  const s = read();
  const migrated: string[] = [];
  for (const map of [s.comfyuiEnv, s.agentEnv]) {
    if (!map || typeof map !== "object") continue;
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== "string" || !v) continue;
      if (!isAllowedSecretKey(k)) continue;
      if (process.env[k]) continue; // .env / real env already wins
      const outcome = upsertEnvFile(k, v);
      if (outcome.lostKeys.length) {
        logger.warn(
          `[panel-secrets] migrating ${k} into ${envFilePath()} lost ${outcome.lostKeys.join(", ")} — ` +
            `inspect that file and restore the missing entries before relying on it.`,
        );
      } else if (outcome.lossCheck === "unknown") {
        logger.warn(
          `[panel-secrets] migrating ${k} into ${envFilePath()}: whether it cost any other credential is NOT established — ` +
            `${outcome.lossCheckNote ?? "the whole-file check could not be completed"}.`,
        );
      }
      if (outcome.durabilityGap) {
        logger.warn(`[panel-secrets] migrating ${k}: ${outcome.durabilityGap}`);
      }
      // VERIFY OUR OWN KEY, exactly as the setter does. The migration never
      // did: it wrote, then reported the key migrated and hydrated it into
      // process.env from the value it happened to hold — so a competitor that
      // replaced the file after the rename produced a "migrated" key that the
      // resolver, reading the file, treats as absent (codex gate). A boot line
      // saying a credential is in place while nothing can resolve it is the
      // #826 shape at startup.
      const readBack = parseEnvFile();
      if (readBack === null || readBack[k] !== v) {
        logger.warn(
          `[panel-secrets] ${k} was written to ${envFilePath()} during migration, but ` +
            `${readBack === null ? "the file could not be re-read" : "it does not read back with that value"} — ` +
            `NOT reporting it as migrated. The legacy entry is untouched, so the next start retries.`,
        );
        continue; // no process.env, no file-derived mark, not counted as migrated
      }
      process.env[k] = v;
      // The canonical file is this value's AUTHORITY now — it lives there. Without
      // the mark it would read as SHELL-provided, so buildComfyuiMcpEnv would
      // inject it to the child unmarked and the child would pin it: a later
      // rotate or revoke invisible to that child while the save reports live
      // pickup (codex gate, round 3, finding 1).
      markFileDerived(k);
      migrated.push(k);
    }
  }
  return migrated;
}

// SANITIZE on every write: copy only the five known status fields and coerce
// their types. Even a hand-edited or corrupt panel-secrets.json therefore can
// never inject anything beyond this shape into the mirror — critically, it
// can never smuggle in token material via an unexpected key.
function sanitizeOAuthStatus(rec: OAuthStatusRecord): OAuthStatusRecord {
  const out: OAuthStatusRecord = {
    provider: String(rec?.provider ?? "").trim(),
    account_label: String(rec?.account_label ?? "").trim(),
    obtained_at:
      typeof rec?.obtained_at === "number" && Number.isFinite(rec.obtained_at)
        ? rec.obtained_at
        : Date.now(),
  };
  if (typeof rec?.expires_at === "number" && Number.isFinite(rec.expires_at)) {
    out.expires_at = rec.expires_at;
  }
  if (typeof rec?.experimental === "boolean") {
    out.experimental = rec.experimental;
  }
  return out;
}

/** Upsert the status-only OAuth mirror entry for `rec.provider`. Sanitizes the
 *  record first (see `sanitizeOAuthStatus`) — callers pass status fields only,
 *  never token material. */
export function setOAuthStatus(rec: OAuthStatusRecord): void {
  const sanitized = sanitizeOAuthStatus(rec);
  if (!sanitized.provider) throw new Error("setOAuthStatus: record is missing a provider id.");
  const secrets = read();
  const status =
    secrets.oauthStatus && typeof secrets.oauthStatus === "object" ? secrets.oauthStatus : {};
  status[sanitized.provider] = sanitized;
  secrets.oauthStatus = status;
  write(secrets);
}

/** All stored OAuth status records (re-sanitized on read, defense in depth).
 *  `home` scopes the read — see `panelSecretsPath` (#859). */
export function listOAuthStatus(home?: string): OAuthStatusRecord[] {
  const status = read(home).oauthStatus;
  if (!status || typeof status !== "object") return [];
  return Object.values(status).map(sanitizeOAuthStatus);
}

/** Remove a provider's status mirror entry. No-op if absent. */
export function clearOAuthStatus(provider: string): void {
  const secrets = read();
  const status = secrets.oauthStatus;
  if (!status || typeof status !== "object" || !(provider in status)) return;
  delete status[provider];
  secrets.oauthStatus = status;
  write(secrets);
}

/** The persisted env vars to inject into the comfyui MCP server. Never logged.
 *  FILTERED through the allowlist (defense in depth): even a hand-edited/corrupt
 *  panel-secrets.json can only ever contribute allowlisted credential keys. */
export function loadComfyuiSecretEnv(): Record<string, string> {
  // Resolved through the env-file snapshot, allowlist-filtered: a real env var
  // still wins, otherwise the canonical .env is re-read NOW. Reading raw
  // process.env here would inject a value that went stale when another writer
  // rotated the file, and the child would then pin that stale copy (codex gate,
  // round 2, finding 2). ONE snapshot for all keys, so a rotation landing
  // mid-build cannot produce a half-old/half-new env (round 4, finding 6).
  return freshSecretValues(COMFYUI_SECRET_ENV_ALLOWLIST);
}

/** The env-var KEYS currently stored (e.g. for a redacted log line). No values. */
export function comfyuiSecretKeys(): string[] {
  return Object.keys(loadComfyuiSecretEnv());
}

/**
 * Persist a secret as an env var for the built-in comfyui MCP server, then emit
 * a change so the orchestrator re-injects it and respawns the server. `value` is
 * the raw secret (the caller already applied any prefix); it is never logged.
 */
export function setComfyuiSecret(
  key: string,
  value: string,
  opts: { requested?: boolean; tabId?: string } = {},
): SecretSaveReceipt {
  const trimmed = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid env var name "${key}" — use a valid shell identifier (letters, digits, underscore).`);
  }
  if (!isAllowedComfyuiSecretKey(trimmed)) {
    // SECURITY: never let an arbitrary key reach the comfyui Node child's env.
    throw new Error(
      `Env var "${trimmed}" is not an accepted comfyui tool secret. Allowed: ${COMFYUI_SECRET_ENV_ALLOWLIST.join(", ")}.`,
    );
  }
  // `opts.requested` is set ONLY by panel_request_secret (an agent-driven token
  // ask) so the orchestrator can nudge "retry the action"; the Settings slot
  // save path (setPanelSecret) omits it → no spurious nudge (#164).
  return setEnvSecret(trimmed, value, opts); // canonical store = ~/.comfyui-mcp/.env
}

/** Remove a stored comfyui secret. Returns false if absent. Emits on removal. */
export function removeComfyuiSecret(key: string): SecretRemoveOutcome {
  return removeEnvSecret(key);
}

/** The persisted agent-provider secrets (e.g. OPENROUTER_API_KEY), filtered
 *  through the agent allowlist. Never logged. */
export function loadAgentSecretEnv(): Record<string, string> {
  // Same access-time resolution as loadComfyuiSecretEnv, from one snapshot: env
  // wins, else the canonical .env re-read now, so the readiness/masked-slot
  // views never report a value the file no longer carries.
  return freshSecretValues(AGENT_SECRET_ENV_ALLOWLIST);
}

/**
 * Copy stored agent secrets into process.env so every in-process reader
 * (openrouterDeps, backendReadiness, the ollama key fallback) sees one source
 * of truth. An EXPLICIT env value WINS — the shell/.env stays the escape hatch;
 * the store only fills what env didn't provide. Called at orchestrator startup
 * and whenever an agent secret changes. Returns the keys it hydrated.
 */
export function hydrateAgentSecretsIntoEnv(): string[] {
  // Canonical secrets already come from ~/.comfyui-mcp/.env (dotenv at boot). This
  // now performs the one-time, non-destructive migration of any legacy tokens
  // still in panel-secrets.json into .env, so everything converges to one place.
  // Idempotent — a no-op once migrated. (Kept this name so the boot/agent-change
  // callers are unchanged.)
  return migrateSecretsToEnv();
}

/** Subscribe to "an agent provider secret changed". Returns an unsubscribe fn. */
export function onAgentSecretsChanged(cb: () => void): () => void {
  emitter.on("agentChange", cb);
  return () => {
    emitter.off("agentChange", cb);
  };
}

/**
 * Persist an agent-provider secret (e.g. OPENROUTER_API_KEY) to the 0600 store
 * and hydrate it into process.env immediately, then emit so the orchestrator
 * re-probes readiness / re-pushes the model list. Rejects non-allowlisted keys.
 */
export function setAgentSecret(key: string, value: string): SecretSaveReceipt {
  const trimmed = key.trim();
  if (!isAllowedAgentSecretKey(trimmed)) {
    throw new Error(
      `Env var "${trimmed}" is not an accepted agent secret. Allowed: ${AGENT_SECRET_ENV_ALLOWLIST.join(", ")}.`,
    );
  }
  return setEnvSecret(trimmed, value); // canonical store = ~/.comfyui-mcp/.env
}

/** Remove a stored agent secret. Returns false if absent. Also drops it from
 *  process.env (setAgentSecret put it there — a revoked key must stop applying
 *  NOW, not on the next restart). Emits on removal. */
export function removeAgentSecret(key: string): SecretRemoveOutcome {
  return removeEnvSecret(key);
}

/**
 * Build the comfyui MCP server's spawn env: the orchestrator's `base` env
 * (COMFYUI_URL, progress dir, COMFYUI_PATH…) MERGED with the persisted tool
 * secrets. Secrets win over base on a key clash (a user-supplied token overrides
 * any inherited default). This is THE single env-builder both provider paths
 * (Claude in-process + Codex stdio) use, so a saved secret reaches either.
 */
export function buildComfyuiMcpEnv(base: Record<string, string>): Record<string, string> {
  const secrets = loadComfyuiSecretEnv();
  // Which of the injected credentials does the canonical FILE own? Those must be
  // marked so the child treats its inherited copy as file-derived and a later
  // rotate/revoke supersedes it (codex gate, round 1, finding 1). Only a
  // SHELL-provided key — a real environment variable, the escape hatch — is left
  // unmarked, so the child keeps pinning it. Provenance, not a value comparison:
  // a value that merely went stale because another writer rotated the file is
  // still file-owned (codex gate, round 2, finding 2).
  const managed = Object.keys(secrets).filter((k) => !isShellProvided(k));
  const out: Record<string, string> = {
    ...base,
    // PIN the canonical dotenv path into the child (#826). The child resolves
    // credentials from that file at access time, so if the orchestrator writes
    // to a non-default path (COMFYUI_MCP_ENV_FILE) while the child resolves the
    // default one, a saved token is written to a file nothing reads — a "saved
    // successfully" that the tools can never see. Forwarding the override makes
    // writer and reader the same file by construction. Not a secret: a path.
    ...(process.env.COMFYUI_MCP_ENV_FILE
      ? { COMFYUI_MCP_ENV_FILE: process.env.COMFYUI_MCP_ENV_FILE }
      : {}),
    // #873 — THE OPERATOR'S TOOL-SURFACE POLICY, forwarded HERE because this is the one
    // function BOTH comfyui spawn lanes share.
    //
    // I first put this in comfyuiBaseEnv(), which only the Codex/Gemini lane spreads. The
    // Claude lane — the DEFAULT backend — builds its own literal and calls this function
    // directly, so it kept spawning a child with all 37 tools while the panel surface was
    // correctly withheld and logged as withheld. An operator setting PRESET=readonly got
    // a server that reported itself restricted and still offered restart_comfyui,
    // install_custom_node and download_model.
    //
    // That is the same defect I had just written a commit message about — fixing one of
    // two registration paths and testing only the one I fixed — committed again, in the
    // same change, one file over. Two call sites is the bug; the choke point is the fix.
    // The child's env is CONSTRUCTED rather than inherited (a spread cannot remove a
    // revoked credential, see below), so an unforwarded variable simply does not exist
    // over there.
    ...(process.env.COMFYUI_MCP_TOOL_PRESET
      ? { COMFYUI_MCP_TOOL_PRESET: process.env.COMFYUI_MCP_TOOL_PRESET }
      : {}),
    ...(process.env.COMFYUI_MCP_TOOL_ALLOW
      ? { COMFYUI_MCP_TOOL_ALLOW: process.env.COMFYUI_MCP_TOOL_ALLOW }
      : {}),
    ...(process.env.COMFYUI_MCP_TOOL_DENY
      ? { COMFYUI_MCP_TOOL_DENY: process.env.COMFYUI_MCP_TOOL_DENY }
      : {}),
    ...(process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW !== undefined
      ? { COMFYUI_MCP_TOOL_ACTION_ALLOW: process.env.COMFYUI_MCP_TOOL_ACTION_ALLOW }
      : {}),
    // KEY NAMES only — never values.
    ...(managed.length ? { [MANAGED_SECRET_KEYS_ENV]: managed.join(",") } : {}),
    ...secrets,
  };
  // The RESOLVER is authoritative for the WHOLE allowlist, not just for the keys
  // it happens to supply. Object spreading can only add and overwrite — it can
  // never REMOVE — so a credential the caller copied into `base` from raw
  // process.env survived an external revoke that `loadComfyuiSecretEnv` had
  // correctly dropped, and the next child inherited the stale token unmarked and
  // treated it as a real env override (coordinator finding). Deleting what the
  // resolver did not provide makes a revoke actually revoke, by construction.
  for (const key of COMFYUI_SECRET_ENV_ALLOWLIST) {
    if (!(key in secrets)) delete out[key];
  }
  return out;
}

// ── Agent-provider spawn env (tool-secret scoping) ───────────────────────────
// Tool secrets (RunPod/HF/CivitAI/RunComfy/Registry tokens…) live in process.env
// because config.ts loads ~/.comfyui-mcp/.env at boot and setEnvSecret applies
// live. That is CORRECT for the comfyui tool child (buildComfyuiMcpEnv), but the
// agent-provider subprocesses (Codex app-server, Gemini/Grok CLI…) must NEVER
// inherit them — a tool credential has no business in an LLM vendor's process.
// buildAgentSpawnEnv is the single spawn-env builder those backends use: a copy
// of process.env with every TOOL-ONLY secret key stripped.

/** Secret env keys that are TOOL-only (comfyui allowlist minus agent allowlist)
 *  — these must never reach an agent-provider subprocess's env. */
export const TOOL_ONLY_SECRET_ENV_KEYS: readonly string[] =
  COMFYUI_SECRET_ENV_ALLOWLIST.filter((k) => !AGENT_ALLOWLIST_SET.has(k));

/**
 * Build the env an AGENT-PROVIDER subprocess (Codex/Gemini/Grok CLI…) spawns
 * with: `base` (default process.env) with all tool-only secret keys removed.
 * `keep` re-admits specific keys when they double as the provider's OWN
 * credential (e.g. GEMINI_API_KEY for the Gemini CLI — same vendor, not a leak).
 */
export function buildAgentSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
  opts: { keep?: readonly string[] } = {},
): NodeJS.ProcessEnv {
  const keep = new Set(opts.keep ?? []);
  const out: NodeJS.ProcessEnv = { ...base };
  for (const k of TOOL_ONLY_SECRET_ENV_KEYS) {
    if (!keep.has(k)) delete out[k];
  }
  return out;
}

export interface CredentialSlot {
  id: string;
  label: string;
  envKeys: string[];
  store: "comfyui" | "agent";
  help?: string;
}

/** UI credential slots. Each slot writes ALL its envKeys (alias fan-out) into its
 *  store. `store` decides which allowlist/setter applies. */
export const CREDENTIAL_SLOTS: CredentialSlot[] = [
  { id: "openrouter", label: "OpenRouter", envKeys: ["OPENROUTER_API_KEY"], store: "agent", help: "Hosted models (MiMo, MiniMax, GPT, Claude…)" },
  // The simple api-key providers (glm/kimi/moonshot) are DERIVED from the
  // openai-provider-registry — one entry there feeds its slot here automatically.
  ...OPENAI_KEY_PROVIDERS.map(
    (p): CredentialSlot => ({
      id: p.id,
      label: p.slotLabel,
      envKeys: p.envKeys,
      store: "agent",
      // Append the generated model hint so the card says which model the
      // provider is actually on and how to change it — the override env var
      // existed but was invisible outside the source.
      help: `${p.slotHelp} · ${providerModelHint(p)}`,
    }),
  ),
  { id: "civitai", label: "Civitai", envKeys: ["CIVITAI_API_TOKEN"], store: "comfyui", help: "Model downloads" },
  { id: "huggingface", label: "HuggingFace", envKeys: ["HF_TOKEN", "HUGGINGFACE_TOKEN"], store: "comfyui", help: "Model downloads" },
  { id: "google", label: "Google / Gemini", envKeys: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"], store: "comfyui", help: "Nano Banana concept images" },
  { id: "runcomfy", label: "RunComfy", envKeys: ["RUNCOMFY_API_KEY"], store: "comfyui", help: "Cloud pods / training" },
  { id: "runpod", label: "RunPod", envKeys: ["RUNPOD_API_KEY"], store: "comfyui", help: "Manage GPU pods (status/start/stop/connect)" },
  { id: "registry", label: "Comfy Registry", envKeys: ["REGISTRY_ACCESS_TOKEN"], store: "comfyui", help: "Publishing custom nodes" },
];

const SLOT_BY_ID = new Map(CREDENTIAL_SLOTS.map((s) => [s.id, s]));

/** Mask a secret for display: first 4 + ellipsis + last 3. Short values fully masked. */
export function maskSecret(v: string): string {
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-3)}`;
}

/** The OBSERVED outcome of a slot save across all of the slot's alias keys. */
export interface SlotSaveOutcome {
  slot: string;
  receipts: SecretSaveReceipt[];
  /**
   * Downloads in flight when this slot save's single respawn emit fired (#1378).
   *
   * The slot fan-out suspends per-alias emits and makes ONE at the end, so this is that
   * emit's own snapshot — not a per-alias guess, and empty when the operation rolled back
   * and emitted nothing.
   */
  atRiskDownloads: AtRiskDownloads;
  /** Every alias landed, proven by read-back. */
  confirmed: boolean;
  /** The slot was left exactly as it was before this call (no alias carries the
   *  new value). Only meaningful when `confirmed` is false. */
  rolledBack: boolean;
  /** Aliases PROVEN to still carry the NEW value despite the overall failure,
   *  because restoring them did not take effect. Non-empty means the slot is in a
   *  MIXED state and the caller must say so — claiming "nothing was
   *  half-applied" over this is the round-4 defect. */
  strandedKeys: string[];
  /** Aliases whose restore could NOT be verified either way (the store went
   *  unreadable). Neither proven restored nor proven stranded — the caller must
   *  say so rather than pick one (codex gate, round 5, finding 2). */
  unverifiedKeys: string[];
  /** OTHER credential keys the store lost while this slot was being written.
   *  Aggregated from the receipts so no consumer has to know that receipts carry
   *  it. Non-empty ⇒ `confirmed` is false, by construction: a receipt that
   *  carries lost keys has `persisted: "damaged"`, and `confirmed` is derived
   *  from `persisted === "yes"`. */
  lostKeys: string[];
  /** Everything the ROLLBACK's own writes owe the caller — dropped comments, a
   *  durability gap, an account it could not complete. A rollback is a store
   *  write the user never asked for; what it cost is theirs to know. */
  restoreWarnings?: string[];
}

/**
 * Set every env key of a slot (alias fan-out) into its store.
 *
 * ALL-OR-NOTHING across the aliases. The fan-out is serial, so a slot like
 * HuggingFace could land HF_TOKEN and then fail on HUGGINGFACE_TOKEN — leaving
 * the first alias live and effective while the caller reported failure and said
 * nothing was half-applied (codex gate, round 4, finding 1). On any failure the
 * aliases this call changed are restored to their previous values, and any that
 * could NOT be restored are reported as stranded rather than glossed over.
 *
 * Throws on unknown slot, and re-throws a per-key validation failure (a control
 * character, an unrepresentable value) AFTER restoring — so the caller still
 * gets the specific reason.
 */
export function setPanelSecret(slotId: string, value: string): SlotSaveOutcome {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  const before = slot.envKeys.map((key) => ({
    key,
    previous: freshSecretValue(key),
    // Provenance matters for the restore: writing a SHELL-provided value back
    // through the setter would persist it into the store and mark it
    // file-derived — restoring the text while silently changing where the value
    // lives and how it resolves (codex gate, round 5, finding 2).
    wasShellProvided: isShellProvided(key),
  }));

  const receipts: SecretSaveReceipt[] = [];
  let thrown: unknown = null;
  let failed = false;
  let damaged = false;
  let strandedKeys: string[] = [];
  let unverifiedKeys: string[] = [];
  /** Credentials the ROLLBACK's own writes cost, on top of the fan-out's. */
  const restoreLostKeys = new Set<string>();
  /** Everything else the rollback's writes owe the caller. */
  const restoreWarnings: string[] = [];
  /** The aliases this call actually tried to write. The rollback restores ONLY
   *  these: it used to walk the whole alias list, so an alias the fan-out never
   *  reached — one another writer may legitimately have updated in the meantime
   *  — was overwritten with a stale snapshot, and because that key is the
   *  restore's own intentional key the clobber was excluded from `lostKeys` and
   *  reported as a successful restore (codex gate). */
  const attempted = new Set<string>();
  /** Aggregated once, here, so no consumer of a slot save has to reach into the
   *  receipts to learn that the store lost credentials. */
  const lostKeysOf = (rs: SecretSaveReceipt[]) => [
    ...new Set(rs.flatMap((r) => r.lostKeys ?? [])),
  ];

  const outcome = withSuspendedEmissions(
    (): SlotSaveOutcome => {
      for (const key of slot.envKeys) {
        try {
          // Recorded BEFORE the call: a write that throws part-way may still
          // have touched the store, so "attempted" is the set the rollback is
          // allowed to act on — never the whole alias list.
          attempted.add(key);
          const receipt = setEnvSecret(key, value);
          receipts.push(receipt);
          if (receipt.persisted === "damaged") {
            // The store lost OTHER credentials. Stop the fan-out — but do NOT
            // roll back: a rollback cannot bring the lost keys back, and it is
            // one more destructive rewrite of a store already known to be
            // damaged. What the user needs is the truth about the state we are
            // in, not another write on top of it.
            damaged = true;
            break;
          }
          if (receipt.persisted !== "yes") {
            // "unknown" is not a proven failure, but it is not a proven success
            // either — stop rather than layering more unverified writes on it.
            failed = true;
            break;
          }
        } catch (err) {
          thrown = err;
          failed = true;
          break;
        }
      }
      if (damaged) {
        return {
          slot: slotId,
          receipts,
          // Derived from the receipts, so a damaged one can never read as
          // confirmed anywhere: `slotSaveConfirmed` is this field.
          confirmed: false,
          rolledBack: false,
          strandedKeys: [],
          unverifiedKeys: [],
          lostKeys: lostKeysOf(receipts),
          // Filled in after the suspended emit below — it has not happened yet here.
          atRiskDownloads: [],
        };
      }
      if (!failed) {
        return {
          slot: slotId,
          receipts,
          confirmed: true,
          rolledBack: false,
          strandedKeys: [],
          unverifiedKeys: [],
          lostKeys: [],
          atRiskDownloads: [],
        };
      }
      // Restore every alias this call actually changed, and PROVE each restore
      // from the store rather than from freshSecretValue — which falls back to
      // the in-process copy when the store is unreadable and would therefore
      // "confirm" a restore that never reached disk.
      for (const { key, previous, wasShellProvided } of before) {
        // An alias this call never wrote may be reconciled IN PROCESS (that is
        // free and cannot clobber anything), but it must never be WRITTEN back:
        // another ordinary writer may have updated it while we were failing, and
        // the snapshot in hand is older than that.
        const { state, lostKeys, disclosures } = restoreEnvKey(key, previous, wasShellProvided, {
          mayWrite: attempted.has(key),
        });
        if (state === "stranded") strandedKeys.push(key);
        else if (state === "unverified") unverifiedKeys.push(key);
        // A ROLLBACK is a store write like any other, so it can lose credentials
        // like any other — and dropping that here because the headline is
        // already a failure would hide the worse half of what happened. Same
        // rule, same place, no second mechanism.
        for (const k of lostKeys) restoreLostKeys.add(k);
        restoreWarnings.push(...disclosures);
      }
      return {
        slot: slotId,
        receipts,
        confirmed: false,
        rolledBack: strandedKeys.length === 0 && unverifiedKeys.length === 0,
        strandedKeys,
        unverifiedKeys,
        lostKeys: [...new Set([...lostKeysOf(receipts), ...restoreLostKeys])],
        atRiskDownloads: [],
        ...(restoreWarnings.length ? { restoreWarnings } : {}),
      };
    },
    (result) => {
      // Emit ONCE, for the state actually left. A save that failed and was fully
      // rolled back changed nothing, so it must not respawn anything.
      const changed = !!result && (result.confirmed || !result.rolledBack);
      if (!changed) return {};
      // Keyed off the SLOT, not off whether a per-key emit happened to be
      // suppressed during the fan-out: a proven-failed write returns before
      // emitting, so a slot left partially STRANDED would suppress nothing and
      // therefore emit nothing — leaving a child that needs a respawn to see the
      // change running on its old spawn env until something unrelated restarted
      // it (codex gate, final round).
      return {
        comfyui: slot.store === "comfyui" ? {} : false,
        agent: slot.store === "agent",
      };
    },
  );
  // WHAT THE SINGLE EMIT COST (#1378). The fan-out suspends per-alias emits and makes one
  // at the end, inside `withSuspendedEmissions`' finally — which cannot change what the
  // block returns, so the snapshot is read back here. A rolled-back save emits nothing and
  // this is empty, which is the point: it must not warn about a loss that did not happen.
  outcome.atRiskDownloads = takeSuspendedAtRisk();
  if (thrown) {
    // The rethrow is a refusal — correct, because the value the caller supplied
    // is not in place. But the ROLLBACK on the way out is a store write, and
    // what it cost must not be swallowed by that refusal: `restoreLostKeys` was
    // collected and then discarded here, so a rollback that destroyed another
    // credential vanished behind the original validation error (codex gate).
    const damageOnTheWayOut = [
      ...(restoreLostKeys.size
        ? [
            `🛑 Rolling the slot back also lost ${[...restoreLostKeys].join(", ")} from ${envFilePath()} — ` +
              `restore that file before relying on anything in it.`,
          ]
        : []),
      ...restoreWarnings,
    ];
    const mixed = [...strandedKeys, ...unverifiedKeys];
    if (mixed.length || damageOnTheWayOut.length) {
      throw new Error(
        `${thrown instanceof Error ? thrown.message : String(thrown)} ` +
          `${damageOnTheWayOut.length ? `${damageOnTheWayOut.join(" ")} ` : ""}` +
          `${
            mixed.length
              ? `Restoring the slot could not be confirmed for ${mixed.join(", ")}, so it may be in a MIXED state. Set "${slotId}" again, or clear it, before relying on it.`
              : `The slot itself was restored.`
          }`,
      );
    }
    throw thrown;
  }
  return outcome;
}

/**
 * Put one alias key back to its pre-save state, and say whether that is PROVEN.
 *   "restored"   — the store agrees the key is back to `previous`.
 *   "stranded"   — the store proves it still carries the new value.
 *   "unverified" — the store could not be read, so neither is established.
 * Never collapses "unverified" into either verdict.
 *
 * Also returns any OTHER credentials the restore's own writes cost. A rollback
 * is a store rewrite like any other and can lose keys like any other; the
 * caller folds these into the slot outcome so a rollback's damage travels the
 * same path as a save's rather than needing its own reporting.
 */
function restoreEnvKey(
  key: string,
  previous: string | undefined,
  wasShellProvided: boolean,
  opts: { mayWrite: boolean } = { mayWrite: true },
): {
  state: "restored" | "stranded" | "unverified" | "skipped";
  lostKeys: string[];
  disclosures: string[];
} {
  const lostKeys = new Set<string>();
  // EVERYTHING the rollback's own writes owe the caller — not just lost keys.
  // A rollback that dropped comments, could not be made durable, or could not
  // complete its loss account is the user's data affected by an operation they
  // never asked for, and it was being discarded (codex gate).
  const disclosures: string[] = [];
  const done = (state: "restored" | "stranded" | "unverified" | "skipped") => ({
    state,
    // A key this restore is itself putting back is not collateral.
    lostKeys: [...lostKeys].filter((k) => k !== key),
    disclosures,
  });
  // Already as it was? Then this call never changed it — rewriting would be a
  // pointless write that can itself fail and manufacture a "stranded" verdict
  // for a key that was never touched.
  const current = parseEnvFile();
  if (current !== null) {
    const wanted = wasShellProvided || previous === undefined ? undefined : previous;
    if (current[key] === wanted) {
      // Keep the in-process copy AND the provenance in step with the store.
      // Both directions matter: a shell value must stop being file-owned, and a
      // value the FILE supplies must be marked file-owned — otherwise a key the
      // file gained after boot would be treated as a real env override from here
      // on, and a later legitimate rotation of that file entry would be masked
      // (codex gate, round 10).
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      if (wasShellProvided) unmarkFileDerived(key);
      else if (previous !== undefined) markFileDerived(key);
      return done("restored");
    }
  }
  // Past the no-write reconciliation above, every remaining path WRITES the
  // store. For an alias this call never touched that is not a restore, it is a
  // clobber: the value on disk is newer than the snapshot in hand, and putting
  // the snapshot back would overwrite another writer's legitimate update — and
  // because this key is the restore's own intentional key, the loss would be
  // excluded from `lostKeys` and reported as a successful restore (codex gate).
  if (!opts.mayWrite) return done("skipped");
  try {
    if (wasShellProvided) {
      // The value belongs to the ENVIRONMENT, not to the store: drop whatever we
      // wrote and hand precedence back, rather than persisting a shell secret.
      const out = removeEnvFileKey(key);
      for (const k of out.lostKeys) lostKeys.add(k);
      if (out.lossCheck === "unknown" && out.lossCheckNote) {
        disclosures.push(`⚠️ Rolling "${key}" back: ${out.lossCheckNote}.`);
      }
      if (out.durabilityGap) {
        disclosures.push(`⚠️ Rolling "${key}" back was not made crash-durable: ${out.durabilityGap}.`);
      }
      if (out.lostCommentLines > 0) {
        disclosures.push(
          `⚠️ Rolling "${key}" back cost ${out.lostCommentLines} comment line${out.lostCommentLines > 1 ? "s" : ""} in the store.`,
        );
      }
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      unmarkFileDerived(key);
    } else if (previous === undefined) {
      const out = removeEnvSecret(key);
      for (const k of out.lostKeys) lostKeys.add(k);
      disclosures.push(...removeDisclosures(out, envFilePath()).map((d) => `Rolling "${key}" back: ${d}`));
    } else {
      const receipt = setEnvSecret(key, previous);
      for (const k of receipt.lostKeys ?? []) lostKeys.add(k);
      disclosures.push(...receiptDisclosures(receipt).map((d) => `Rolling "${key}" back: ${d}`));
    }
  } catch {
    return done("stranded");
  }
  const parsed = parseEnvFile();
  if (parsed === null) return done("unverified");
  const inStore = parsed[key];
  if (wasShellProvided) return done(inStore === undefined ? "restored" : "stranded");
  if (previous === undefined) return done(inStore === undefined ? "restored" : "stranded");
  return done(inStore === previous ? "restored" : "stranded");
}

/** True when EVERY key of a slot save is proven to have landed. A single alias
 *  that did not persist means the slot is not reliably configured — the reader
 *  that happens to consult that alias would find nothing. */
export function slotSaveConfirmed(outcome: SlotSaveOutcome): boolean {
  return outcome.confirmed;
}

/** The keys of a slot save whose persistence could NOT be confirmed, with their
 *  verdict — for an honest answer that names what is uncertain. No values. */
export function unconfirmedSlotKeys(
  receipts: SecretSaveReceipt[],
): { key: string; persisted: SecretSaveReceipt["persisted"] }[] {
  return receipts
    .filter((r) => r.persisted !== "yes")
    .map((r) => ({ key: r.key, persisted: r.persisted }));
}

/** Clear a slot: remove EVERY env key (alias fan-out, mirroring setPanelSecret)
 *  from its store. Throws on unknown slot — that is a refusal BEFORE anything is
 *  removed, which is the only place a refusal belongs on this path. Everything
 *  the removals cost is DISCLOSED in the returned outcome instead.
 *  This is the revoke path (issue #203) — without it a saved key could only be
 *  overwritten, never removed, short of hand-editing panel-secrets.json. */
export function clearPanelSecret(slotId: string): SecretRemoveOutcome {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  const remove = slot.store === "agent" ? removeAgentSecret : removeComfyuiSecret;
  let changed = false;
  const lostKeys = new Set<string>();
  let lostCommentLines = 0;
  const uncertainties: string[] = [];
  const resurrectionRisks: string[] = [];
  let durabilityGap: string | undefined;
  const failures: string[] = [];
  const atRisk = new Map<string, AtRiskDownloads[number]>();
  let firstError: unknown = null;
  for (const key of slot.envKeys) {
    let out: SecretRemoveOutcome;
    try {
      out = remove(key);
    } catch (err) {
      // The fan-out is SERIAL, so an earlier alias may already be gone. Letting
      // this throw discarded that completed removal entirely — the console saw
      // only a generic failure, with no `cleared` and no "do not retry"
      // (codex gate). Record it and carry on: the outcome reports both what was
      // removed and what could not be.
      if (firstError === null) firstError = err;
      failures.push(`${key} (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    changed = out.changed || changed;
    if (out.resurrectionRisk) resurrectionRisks.push(out.resurrectionRisk);
    // A key this fan-out itself removes is not collateral — the aliases of one
    // slot are all being cleared on purpose.
    for (const k of out.lostKeys) if (!slot.envKeys.includes(k)) lostKeys.add(k);
    lostCommentLines += out.lostCommentLines;
    if (out.uncertainty) uncertainties.push(out.uncertainty);
    if (out.durabilityGap && !durabilityGap) durabilityGap = out.durabilityGap;
    // Aggregated, and deduped by filename (#1378). The fan-out is SERIAL, so the FIRST
    // alias whose removal emits is the one that catches the transfers still running; by
    // the second the session is already replaced and its snapshot is empty. Keeping the
    // largest byte count means the report never understates what was in flight.
    for (const d of out.atRiskDownloads) {
      // Keyed on the job id, NOT the displayed filename (codex P2): two credential-shaped
      // names both redact to "(redacted).safetensors", and keying on that reported one
      // download and the larger byte count where there were two and a total.
      const seen = atRisk.get(d.id);
      if (!seen || d.bytes > seen.bytes) atRisk.set(d.id, d);
    }
  }
  // Nothing was removed and something failed: nothing happened, so REFUSING is
  // correct and the caller's "it is still there" is true. Anything else is a
  // disclosure about a revoke that partly ran.
  if (!changed && firstError !== null) throw firstError;
  return {
    changed,
    atRiskDownloads: [...atRisk.values()],
    ...(failures.length
      ? {
          incomplete:
            `The revoke could not be completed for ${failures.join(", ")}. ` +
            `What WAS removed has already been removed — do not simply repeat the revoke; check which aliases are still present first.`,
        }
      : {}),
    lostKeys: [...lostKeys],
    lostCommentLines,
    ...(uncertainties.length ? { uncertainty: uncertainties.join(" ") } : {}),
    ...(durabilityGap ? { durabilityGap } : {}),
    ...(resurrectionRisks.length ? { resurrectionRisk: resurrectionRisks.join(" ") } : {}),
  };
}

/** Whether a slot still resolves to a credential — read AFTER a revoke to prove
 *  the clear actually took effect rather than reporting the removal of one line
 *  while another form of the assignment still supplies the value. */
export function slotStillResolves(slotId: string): boolean {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  return slot.envKeys.some((k) => freshSecretValue(k) !== undefined);
}

/**
 * The revoke's VERIFIED end state:
 *   "gone"           — the store is readable and carries no alias of this slot.
 *   "still-resolves" — an alias still supplies a credential.
 *   "unknown"        — the store could not be read, so neither is established.
 *
 * `slotStillResolves` alone is not enough here: after a revoke deletes this
 * process's copy, an unreadable store makes every alias resolve to undefined —
 * which reads as "gone" while a child that CAN read the file still finds the old
 * credential there. Reporting a revoke on that basis is a false acknowledgement
 * (codex gate, round 5, finding 3).
 */
export function slotRevokeState(slotId: string): "gone" | "still-resolves" | "unknown" {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  const parsed = parseEnvFile();
  if (parsed === null) return "unknown"; // the store may still carry it; we cannot tell
  if (slot.envKeys.some((k) => typeof parsed[k] === "string" && parsed[k].trim())) {
    return "still-resolves";
  }
  return slotStillResolves(slotId) ? "still-resolves" : "gone";
}

/** The slot's keys currently supplied by a REAL environment variable. Read
 *  BEFORE a revoke: this store can delete them from THIS process, but not from
 *  the environment the process was started with, so they come back on the next
 *  start. Calling that a completed revoke would be a state we did not reach. */
export function slotShellProvidedKeys(slotId: string): string[] {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  return slot.envKeys.filter((k) => isShellProvided(k));
}

/** Masked per-slot state: set = ANY of the slot's alias env keys resolves.
 *  Checking only the PRIMARY alias reported a slot as unset when only its legacy
 *  alias was configured (e.g. HUGGINGFACE_TOKEN without HF_TOKEN) — a "not
 *  configured" verdict for a credential that is in effect (codex gate, round 4,
 *  answer B). The mask shows the alias that actually resolves. */
export function listPanelSecretsMasked(): { id: string; label: string; set: boolean; masked: string | null }[] {
  return CREDENTIAL_SLOTS.map((slot) => {
    // Resolved with the SAME alias precedence a reader uses (freshSecretValue
    // over the whole alias list), not by resolving each alias independently and
    // taking the first: those differ — a shell-set legacy alias outranks a
    // file-set canonical one for a reader, so picking per-alias would display a
    // token consumers are not using (codex gate, round 5, finding 6).
    const val = freshSecretValue(...slot.envKeys);
    return { id: slot.id, label: slot.label, set: !!val, masked: val ? maskSecret(val) : null };
  });
}
