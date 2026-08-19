// In-process MCP server that gives the orchestrator's background agent LIVE
// control of the workflow the user is actually looking at.
//
// The panel pack already implements a fixed allowlist of graph executors
// (graph_get_state, graph_add_node, graph_set_widget, graph_run, …). This
// server exposes those operations to the background agent as MCP tools, each
// forwarding to the panel over the bridge
// the orchestrator owns (bridge.send → rid-correlated reply). Because it runs
// IN the orchestrator process (createSdkMcpServer, not a stdio subprocess), the
// tools can reach the live UiBridge directly.
//
// Each agent gets its own server bound to its tab id, so commands always target
// the workflow in that browser tab — no tab_id juggling for the model.
//
// PARITY (Codex): the tool definitions live in ONE shared list
// (`buildPanelToolDefs`) so they can be registered onto BOTH:
//   (a) the in-process Anthropic Agent SDK server (`createPanelMcpServer`,
//       used by the Claude backend), AND
//   (b) a `@modelcontextprotocol/sdk` `McpServer` over HTTP
//       (`registerPanelTools`, used by the Codex backend via an orchestrator-
//       hosted loopback HTTP MCP — see panel-mcp-http.ts).
// Sharing the list means the panel_* surface (including the destructive-confirm
// gating for panel_clear/panel_restart_comfyui) is IDENTICAL across providers,
// so parity is automatic — neither path reimplements a tool.

import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
// #873 — the operator's tool-surface policy also governs the panel surface.
import {
  resolveToolSurfacePolicy,
  toolActionPolicyError,
  toolAllowed,
} from "../tools/tool-surface-filter.js";
import { logger as toolPolicyLogger } from "../utils/logger.js";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  forwardedByReferenceNote,
  oversizedInlineRefusal,
  resolveServableViewRef,
  unverifiedViewRefNote,
  type ForwardedByReference,
  type UnverifiedViewRef,
  type ViewRefProbe,
} from "../services/comfy-view-ref.js";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { assertPanelNotTargetedUnverifiable } from "../services/panel-pin-guard.js";
import { nodesInstallCommandArgs } from "../services/node-management.js";
import {
  formatQueueStatusPartialNote,
  getManifestPartialLeftover,
} from "../services/manifest-partial.js";
import { searchPanelNodes } from "../services/manager-node-search.js";
import { isPanelAnsweredError } from "../services/panel-answered.js";
import { isPreExecutorRefusal } from "../services/panel-refusal.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { parse as parseYaml } from "yaml";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UiBridge } from "../services/ui-bridge.js";
import { SEMVER_RE } from "../services/ui-bridge.js";
import { compareSemver } from "../services/self-update.js";
import {
  primePanelBase,
  verifiedPanelDiskVersion,
} from "../services/panel-workspace.js";
import { conversationOfScopeAddress, isScopeAddress, shortTabId } from "../services/session-scope.js";
import type { ScopeRepinOutcome } from "./turn-origins.js";
import { NODE_ID_MESSAGE, NODE_ID_PATTERN, normalizeNodeId } from "./node-id.js";
import {
  parseContradictoryPromotedWidgetRefusal,
  resolveInnerPromotedTarget,
} from "./promoted-widget.js";
import {
  isPlainObject,
  isStampMismatchSaveRefusal,
  patchOpenIdentity,
  shouldRebindOpenIdentity,
  workflowFromSerializeReply,
} from "./open-identity-normalization.js";
import {
  clearSwitchHold,
  describeSwitchHold,
  recordSwitchHold,
  successProvesSwitchCleared,
} from "./switch-hold.js";
import { NO_ORIGIN_REMEDY } from "./fence-refusal.js";

/** #884 — journal TICKETS (run completions #468, ask answers #486) must be
 *  keyed by the REAL tab a run/card was routed to: the panel reports back under
 *  that tab id, and a ticket keyed by the shared scope address a tool ctx is
 *  bound to can never correlate — the agent's own render would come back
 *  labeled "foreign" and boundary sweeps could never close the ticket (codex
 *  round 3, P1). Resolves the scope to the active tab; a real-tab ctx is
 *  returned unchanged. */
function journalTabFor(ctx: PanelToolCtx): string {
  if (!isScopeAddress(ctx.tabId)) return ctx.tabId;
  // Pass the ctx's own (backend-qualified) scope address so the RIGHT
  // conversation's in-flight-turn pin is consulted (#884 P0).
  const b = ctx.bridge as { resolveSharedTabId?: (scopeId?: string) => string | undefined };
  return b.resolveSharedTabId?.(ctx.tabId) ?? ctx.tabId;
}

/** #704 — the CONVERSATION a ticket belongs to: the backend-qualified agent key
 *  (`orchestrator::<backend>`) this tool session is bound to. The tab a run was
 *  routed to is only its address and it churns across a panel reconnect (a new
 *  `tmp:` id, no same-socket migration to follow), which is what made an agent's
 *  own render come back as "origin UNDETERMINED"; the conversation does not.
 *  Undefined for the bare scope / a real-tab binding, which leaves the journal on
 *  its by-tab ownership rule. */
function journalConversationFor(ctx: PanelToolCtx): string | undefined {
  return conversationOfScopeAddress(ctx.tabId);
}
import {
  BRIDGE_DEFAULT_TIMEOUT_MS,
  BRIDGE_READ_DEFAULT_TIMEOUT_MS,
  dispatchOutcomeOf,
  isCapabilityRefusal,
  isPanelCmdUnsupportedError,
  isReplyTimeoutTagged,
  isRoutingAmbiguity,
  requiresWorkflowStampEnforcement,
} from "../services/ui-bridge.js";
import {
  type WorkflowTargetStore,
  withWorkflowTarget,
} from "../services/workflow-target-store.js";
import {
  addUserMcpServer,
  readUserMcpServers,
  removeUserMcpServer,
  setUserMcpServerSecret,
} from "../services/user-mcp-config.js";
import {
  setComfyuiSecret,
  setAgentSecret,
  isAllowedAgentSecretKey,
  receiptDisclosures,
  shadowedNote,
  storeDamageNote,
  type SecretSaveReceipt,
} from "../services/panel-secrets.js";
import { flattenUiWorkflow } from "../services/flatten-workflow.js";
import { describeUnappliedFilters } from "./civitai-filter-guard.js";
import { recordTodo, normalizeTodoItems, TODO_STATUS_INPUTS } from "./todo-state.js";
import { applyCapturedWidgetValues } from "../services/live-widget-overlay.js";
import { listWorkflowLibraryKeys, userdataFetch } from "../services/userdata-library.js";
import { getNsfwConsent, setNsfwConsent } from "../services/panel-settings.js";
import { QueueMonitor } from "../services/queue-monitor.js";
import { RunCompletions } from "./run-completion-journal.js";
import {
  AskAnswers,
  askFingerprint,
  PANEL_ASK_ID_PREFIX,
  type AskEntry,
  type AskRecovery,
} from "./ask-answer-journal.js";
import {
  getClient,
  getObjectInfo,
  backfillObjectInfo,
  getQueueVerified,
  resetClient,
  resetObjectInfoCache,
} from "../comfyui/client.js";
import { convertUiToApi, collectNodeTypes } from "../services/workflow-converter.js";
import type { ObjectInfo } from "../comfyui/types.js";
import {
  restartComfyUI,
  preflightLocalRestart,
  readServingArgv,
  describeArgvDrift,
  recordRestartDispatch,
  clearRestartDispatch,
  getRestartDispatchRecord,
  RESTART_DISPATCH_CAUSATION_WINDOW_MS,
  PROCESS_WIDE_RESTART_DISPATCH_TOKEN,
  __processControlTestHooks,
} from "../services/process-control.js";
import { resetManagerApiCache } from "../services/manager-api-cache.js";
import {
  desktopSavedLaunchArgs,
  describeSavedLaunchArgDrift,
} from "../services/desktop-launch-args.js";
import {
  config,
  isRemoteMode,
  isCloudMode,
  getBootLocalComfyUIBaseUrl,
  getComfyUIBaseUrl,
  getComfyuiTargetGeneration,
} from "../config.js";
import { normalizeInstallPathEnv } from "../utils/install-path-env.js";
import { sliceWorkflow } from "../services/workflow-slicer.js";
import { validateA2UISpecServer } from "../services/a2ui-spec.js";
import type { UiWorkflow } from "../comfyui/types.js";

/** #1700 — orchestrator wires this so panel_reload can fork-respawn the agent
 *  with a freshly-read MCP set. Unset in tests that only exercise the tool. */
let applyMcpReload: ((agentKey: string) => void) | undefined;

/** Bind (or clear) the in-process MCP-config respawn used by panel_reload. */
export function setApplyMcpReload(fn: ((agentKey: string) => void) | undefined): void {
  applyMcpReload = fn;
}

/** Treat these as an affirmative answer to a yes/no confirm card (destructive-op
 *  gate). Deliberately BROAD/lenient — a false "no" only SKIPS a destructive op, so
 *  erring toward "not yes" is safe. NEVER use this for the adult-consent gate: a
 *  false positive there would enable adult content without genuine consent. Use
 *  classifyConsentReply() for that. */
function isAffirmative(reply: unknown): boolean {
  if (typeof reply !== "string") return false;
  return /^(yes|allow|allowed|true|on|ok(ay)?|sure|agree|confirm|enable|i'?m? ?18|18\+?|adult)/i.test(
    reply.trim(),
  );
}

// The exact option labels the adult-consent card presents. Single source of truth
// shared by the card and its STRICT reply classifier so the gate matches on option
// IDENTITY, never on a loose heuristic.
const CONSENT_YES_LABEL = "Yes — I'm 18+ and it's legal in my region";
const CONSENT_NO_LABEL = "No — keep it SFW";

// STRICT, whole-string affirmatives/declines accepted from the card's free-text
// ("Other") box in addition to the exact option labels. Anchored ^…$ so ONLY an
// unambiguous token counts — unlike the broad isAffirmative() PREFIX match, a
// free-text reply like "adult content is illegal here", "On second thought, no",
// or "18 is the age but I decline" can NEVER be read as consent. Consent semantics
// (18+ AND legal) really live in the affirmative BUTTON; these bare tokens are the
// pragmatic fallback for a user who types instead of clicking.
const CONSENT_STRICT_YES_RE = /^(yes|y|yep|yeah|i agree|i consent|agreed?|confirm(ed)?|enable)$/i;
const CONSENT_STRICT_NO_RE = /^(no|n|nope|decline|declined|cancel|keep (it )?sfw|sfw)$/i;

/**
 * STRICT classification of an adult-consent card reply — the ONLY gate that may
 * turn adult mode ON. Returns:
 *   "grant"   → the EXACT affirmative option, or a strict whole-string yes token
 *               → turn consent ON.
 *   "decline" → the EXACT decline option, or a strict whole-string no token
 *               → turn consent OFF.
 *   "unclear" → anything else (free text, ambiguous, non-string) → change NOTHING
 *               (never grants; never revokes a prior genuine grant).
 * Never routes through isAffirmative() — a loose prefix match must not gate adult
 * content.
 */
function classifyConsentReply(reply: unknown): "grant" | "decline" | "unclear" {
  if (typeof reply !== "string") return "unclear";
  // Exact OPTION IDENTITY: a button click echoes the card's label verbatim, so match
  // it BYTE-FOR-BYTE — no .trim(). Trimming here would strip zero-width/BOM/line-
  // separator characters (U+2028/U+2029/U+FEFF, \n) and let a near-label like
  // " Yes — I'm 18+…﻿" pass as the exact affirmative, defeating the exact-identity
  // invariant this classifier exists to hold.
  if (reply === CONSENT_YES_LABEL) return "grant";
  if (reply === CONSENT_NO_LABEL) return "decline";
  // Free-text ("Other" box) fallback: a small set of unambiguous whole-string tokens.
  // This path is DELIBERATELY loose — a user who types " yes " is consenting — so a
  // minimal .trim() of surrounding whitespace is applied ONLY here, never to the
  // exact-label comparison above.
  const t = reply.trim();
  if (CONSENT_STRICT_YES_RE.test(t)) return "grant";
  if (CONSENT_STRICT_NO_RE.test(t)) return "decline";
  return "unclear";
}

export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
  /**
   * #1589 — the MACHINE-READABLE half of a reply, for tools whose result is a
   * DOCUMENT rather than a sentence.
   *
   * `content` is written for the model: prose first, so a conversion warning is
   * read before the graph it applies to (#361). That ordering is right for the
   * reader and useless for a script, which then has to hunt for the first `{`
   * and slice. `structuredContent` is the MCP field for exactly this — the same
   * data, already parsed.
   *
   * NO `outputSchema` is declared for these tools, deliberately. The MCP SDK
   * validates structuredContent ONLY when the tool declares one
   * (`validateToolOutput` returns early on `!tool.outputSchema`), and it hard-
   * fails a reply that declares a schema and omits the structured half. Adding a
   * schema would make every future non-structured branch of the same tool — every
   * `fail(...)`, every early return — a protocol error, so the field stays
   * additive: present when there is a document, absent otherwise.
   */
  structuredContent?: Record<string, unknown>;
};

function ok(value: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

/**
 * panel#1339 — the MACHINE-READABLE half of a `no trusted identity` refusal.
 *
 * The prose half of this refusal used ONE sentence for two opposite outcomes
 * (`refreshed` and `already_current`), so the caller could not tell "answering you
 * is what installed your fence — retry" from "this call repaired nothing, and the
 * identity quoted is not necessarily the one you were refused against". Splitting
 * the sentence fixes the reading; it does not fix the DECIDING, because deciding
 * from a sentence means an agent re-runs a mutation by pattern-matching an error
 * message. That is the one thing this project never does. So the discriminator is
 * carried as a field.
 *
 * EVERY field is tri-state on purpose. A boolean here would recreate the exact
 * collapse this exists to remove: `false` would have to mean both "no" and "we
 * could not find out", and those demand different next actions.
 *
 * `dispatched` is read from the BRIDGE'S OWN typed flag (`dispatchOutcomeOf`), never
 * from the message text. The predicate that selects this whole branch
 * (`isNoTrustedIdentityRefusal`) IS a text match, which is fine for choosing what to
 * explain and unfit for authorising a re-run: any error that merely quotes the phrase
 * would satisfy it. So the "nothing was applied" claim — the claim a caller would act
 * on — stands on the typed flag alone, and says `unknown` when the flag is absent.
 */
type FenceRepairDiagnosis = {
  /** Was the mutation written to the panel socket? From the bridge's typed flag only. */
  dispatched: "no" | "yes" | "unknown";
  /** May this exact call be re-issued without risking a DOUBLE-APPLY? `yes` only
   *  when `dispatched` is `no` — i.e. only when the bridge itself said so. */
  retry_safe: "yes" | "no" | "unknown";
  /** The read-only re-derivation's own verdict, verbatim, so a caller never has to
   *  re-derive it from the wording. `check_threw` = the diagnosis itself failed. */
  rebind_status: WorkflowFenceRebind["status"] | "check_threw";
  /** THE DISCRIMINATOR. `yes` = this refusal is what installed the fence, so the
   *  retry works because of it. `no` = nothing was repaired for you. */
  fence_repaired_by_this_call: "yes" | "no" | "unknown";
  /** Is a bare re-issue expected to get PAST the fence? Independent of `retry_safe`,
   *  which only says a re-issue is harmless. */
  retry_clears_refusal: "yes" | "no" | "unknown";
  /** The one next call to make. `verify_applied_then_decide` is what any branch
   *  degrades to when `dispatched` is not `no`: the fence question may be settled,
   *  but ordering a re-issue while the original write's fate is open is how a
   *  mutation gets double-applied. */
  next_action:
    | "retry_same_call"
    | "confirm_target_then_retry"
    | "verify_applied_then_decide"
    | "open_workflow"
    | "open_or_save_workflow"
    | "unknown";
  /** WHAT THIS SESSION'S FENCE WAS before the check, as its own tri-state — because
   *  `refreshed` covers three different priors and only one of them is an absence:
   *  `absent` = definitively none; `present` = a fence naming a DIFFERENT workflow,
   *  which the adoption replaced (`prior_fence_uuid` names it); `unreadable` = the
   *  read failed, so nothing is claimed either way. Folding `unreadable` into
   *  `absent` is the fold FenceRead's own contract forbids. */
  prior_fence: "absent" | "present" | "unreadable";
  prior_fence_uuid?: string;
  /** The live workflow identity the check read, when it read one. */
  workflow_uuid?: string;
  /** RAW EVIDENCE, not a verdict: the routing key this session was bound to before and
   *  after the check. `tab_before === tab_after` does NOT prove the session never
   *  moved — a move-and-return is invisible to it — which is precisely why
   *  `retry_clears_refusal` stays `unknown` on the `already_current` path rather than
   *  being derived from this pair. */
  tab_before: string;
  tab_after: string;
};

/** A refusal that also carries {@link FenceRepairDiagnosis}. The text is unchanged by
 *  this wrapper: the field is ADDITIVE, so a client that ignores structuredContent
 *  reads exactly what it read before. */
function failWithFenceDiagnosis(text: string, diagnosis: FenceRepairDiagnosis): ToolResult {
  const res = fail(text);
  res.structuredContent = { panel_fence: diagnosis };
  return res;
}

/**
 * #971 — the AMBIGUOUS-rebind refusal, worded so it can be acted on.
 *
 * Refusing here is right (#474: with 2+ live tabs the rebind is ambiguous, so the
 * user picks rather than us guessing). What was wrong is what it refused WITH:
 * rebindToActiveTab propagates the bridge's raw resolve error, which ends
 * "— pass tab_id". This tool has no tab_id parameter (schema: mode/path/filename)
 * and #754 made these schemas strict, so an unknown key is a hard validation error
 * rather than a no-op. Since panel_open_workflow's own refusal names THIS tool as
 * the way out, an instruction that cannot be followed closes the loop and the
 * session stays wedged with no exit — the reporter's wedge.
 *
 * The action named here is the one that actually works, which is NOT the obvious one.
 * UiBridge.setLastActiveTab is documented as the ONLY writer of lastActiveTabId and
 * fires on `msg.type === "user_message"` (ui-bridge.ts) — a tab becomes last-active
 * when a MESSAGE IS SENT from its Agent panel, not when the browser tab is focused or
 * clicked. "Switch to the tab you want" (which panel_reload's sibling message says)
 * would leave the state unchanged and send the user round the loop again.
 * Name the connected tabs too, so the user knows what they are choosing among.
 */
function ambiguousRebindGuidance(ctx: PanelToolCtx, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  // Only reword the ambiguity refusal — every other failure keeps its own words.
  if (!/multiple|last active|pass tab_id/i.test(raw)) return raw;
  let listed = "";
  try {
    const live = typeof ctx.bridge.tabs === "function" ? ctx.bridge.tabs() : undefined;
    if (Array.isArray(live)) {
      // isHeadless THROUGH the bridge — a detached reference loses `this` and throws
      // on `this.conns` (#478). A headless viewer is not a pickable canvas tab.
      const isHeadlessTab = (id: string): boolean =>
        typeof ctx.bridge.isHeadless === "function" && ctx.bridge.isHeadless(id);
      const names = live
        .filter((t) => !isHeadlessTab(t.tab_id))
        .map((t) => (t.title ? `${shortTabId(t.tab_id)} ("${t.title}")` : shortTabId(t.tab_id)));
      if (names.length) listed = ` Connected ComfyUI tabs: ${names.join(", ")}.`;
    }
  } catch {
    // Enumeration is best-effort; the instruction below stands without the list.
  }
  return (
    "Several ComfyUI tabs are connected and none is marked active, so this session cannot " +
    "tell which one to follow — and this tool takes no tab_id to disambiguate with." +
    `${listed} A tab becomes the active one when a message is SENT from its Agent panel ` +
    "(focusing or clicking the browser tab does not do it), so ask the user to send any " +
    "message from the Agent panel in the ComfyUI tab they want you working in, then call " +
    'panel_set_workflow_target({mode:"current"}) again. Nothing was rebound.'
  );
}


// ── Honest secret-save reporting (#826) ─────────────────────────────────────
// `panel_request_secret` used to answer "the comfyui tools respawn with it as
// soon as this turn ends" unconditionally — a claim about a FUTURE event nothing
// verified. When the respawn did not fire, the token sat on disk while every
// download kept returning the same 401, and no signal separated "no token
// configured" from "token present but never injected". These two helpers turn a
// SecretSaveReceipt (all observed facts) into text that states only what was
// checked. Neither ever touches, formats, or logs a secret VALUE.

/** Error for a save a read-back proved did not take effect. Refusing here is
 *  correct: the credential is not in place, so proceeding would send the caller
 *  back into the same failure believing it was fixed. */
export function secretNotPersisted(receipt: SecretSaveReceipt): Error {
  // Whether a credential SURVIVED the rollback changes what the caller should do
  // next, so it must not be flattened into a blanket "nothing is configured"
  // (codex gate, round 2, finding 3): if a previous working value is still in
  // place, telling the user nothing is configured sends them after the wrong
  // problem, and telling them not to retry may be wrong too.
  // `stillConfigured` is a PRESENCE check: some credential for this key
  // resolves. It does not establish WHICH — the in-process value was rolled
  // back, but the store was not, so what resolves may be the value that was
  // there before, or one a competing writer put there in the meantime. Calling
  // it "the credential that was in place BEFORE this attempt" asserted a
  // predecessor state nobody observed (codex gate).
  const state = receipt.stillConfigured
    ? `The new value was rolled back in this process rather than left half-applied, and SOME credential for this key still resolves — ` +
      `which one is not established: it may be the value that was in place before this attempt, or one another writer has since stored. ` +
      `Either way it is NOT the value you just supplied, so do not read this as "now fixed"; check ${receipt.path} to see what is actually there.`
    : `The value was rolled back rather than left half-applied, so nothing is configured — do not retry the action that needed it.`;
  // A failed save can ALSO have destroyed other credentials on its way — the
  // rewrite happened, it just did not leave OUR key behind. Leading with "was
  // NOT saved, set it again" over that hides completed damage and sends the user
  // to write over an already-damaged store (codex gate). Every obligation the
  // receipt carries comes first, from the one shared list.
  const disclosures = receiptDisclosures(receipt);
  return new Error(
    `${disclosures.length ? `${disclosures.join(" ")} ` : ""}` +
      `"${receipt.key}" was NOT saved: writing ${receipt.path} appeared to succeed, but reading the file back does not show that key with the value just supplied. ` +
      `${state} ` +
      `${
        disclosures.length
          ? `Because the rewrite also cost the store other entries, restore ${receipt.path} FIRST — do not simply set the key again on top of it.`
          : `Check that ${receipt.path} is writable and not being rewritten by another process, then set the key again (panel Settings › credentials, or the env var directly, which takes precedence over the file).`
      }`,
  );
}

/**
 * The panel's `secret_saved` answer, derived from the receipt.
 *
 * The Settings-panel bridge route discarded the receipt entirely and replied
 * `ok:true` whenever the call did not throw — so an unverifiable save, and one
 * that PROVED other credentials were destroyed, both painted the panel green
 * (codex gate). This is that decision, in one place, testable without standing
 * up an orchestrator: `ok` is the same question every other consumer asks —
 * `persisted === "yes"` — and the disclosures come from the one shared list.
 *
 * `error` on a non-"yes" verdict is a DISCLOSURE, not a claim the write did not
 * happen: for "damaged" and "unknown" it says what did happen and what is not
 * established. Only "no" is a proven failure.
 */
export function secretSavedReply(receipt: SecretSaveReceipt): {
  ok: boolean;
  error?: string;
  warnings?: string[];
} {
  const warnings = receiptDisclosures(receipt);
  if (receipt.persisted === "yes") {
    return { ok: true, ...(warnings.length ? { warnings } : {}) };
  }
  const error =
    receipt.persisted === "damaged"
      ? (storeDamageNote(receipt) ??
        `"${receipt.key}" was written, but the credential store lost other entries.`)
      : receipt.persisted === "no"
        ? secretNotPersisted(receipt).message
        : `"${receipt.key}" was written to ${receipt.path}, but the save is NOT confirmed — treat it as UNKNOWN: ` +
          `${receipt.uncertainty ?? "the file could not be re-read to confirm it"}.`;
  return { ok: false, error, ...(warnings.length ? { warnings } : {}) };
}

// The note builders and the disclosure list live with the receipt they describe
// (services/panel-secrets.ts) so that the console endpoint and this file cannot
// drift apart on which of them matter — the drift that let `lostKeys` reach the
// ack and nowhere else. Re-exported here because this is where callers and tests
// have always imported them from.
export {
  storeDamageNote,
  shadowedNote,
  commentLossNote,
  durabilityNote,
  receiptDisclosures,
} from "../services/panel-secrets.js";

/** The ack for a comfyui tool secret: what was verified, how the running tools
 *  pick it up, and the ACTUAL respawn disposition — never a promise. */
export function describeComfyuiSecretSave(receipt: SecretSaveReceipt): string {
  // Data loss outranks everything: never narrate a save over destroyed tokens.
  const damaged = storeDamageNote(receipt);
  if (damaged) return damaged;
  // A shadowed save has no live pickup and no useful respawn story — the readers
  // are using the environment variable regardless. Lead with that and stop.
  const shadowed = shadowedNote(receipt);
  if (shadowed) return shadowed;
  const parts: string[] = [];
  parts.push(
    receipt.persisted === "yes"
      ? `🔒 Saved env "${receipt.key}" to ${receipt.path} — verified by reading the file back (the value itself is never shown or logged).`
      : // NOT a fixed cause. The verdict is "unknown" for more than one reason
        // now — the file could not be re-read, OR it read back correctly but a
        // concurrent writer means this save cannot account for the rest of the
        // store — and asserting the wrong one sends the user to the wrong check
        // (codex gate). Print what the receipt says was not established.
        `🔒 Wrote env "${receipt.key}" to ${receipt.path}, but the save is NOT confirmed — treat it as UNKNOWN: ` +
        `${receipt.uncertainty ?? `${receipt.path} could not be re-read to confirm it`}. ` +
        `Treat the steps below as unconfirmed and re-check if the action still fails.`,
  );
  // Every remaining obligation the receipt carries — lost comment lines, a
  // durability gap — from the one list every consumer uses. (Damage and
  // shadowing already returned above; nothing else can appear twice.)
  parts.push(...receiptDisclosures(receipt));
  // Every claim below rests on the value actually being IN the store. When that
  // could not be confirmed, none of them may be made (codex gate, round 2,
  // finding 4): a running tool child falls back to whatever it inherited when
  // the file is unreadable, so "it picks it up, retry now" would be a promise
  // about a state nobody observed — the #826 defect again.
  const confirmed = receipt.persisted === "yes";
  if (!confirmed) {
    parts.push(
      `Because that could not be confirmed, I cannot say the comfyui tools can see the new value: a running tool session falls back to the credential it started with whenever the store is unreadable.`,
    );
  } else if (receipt.livePickup) {
    // This is the property that makes the answer safe to act on immediately: the
    // tools resolve this key from the file at USE time, so the already-running
    // tool process sees it whether or not any respawn happens.
    //
    // #1567 — but "no respawn required" was printed UNCONDITIONALLY, including on
    // the same message that reported one already queued. Both statements were
    // true about different things: the key needs no respawn, and a respawn is
    // pending anyway. Read together they say "nothing is about to happen", and a
    // reporter acted on that by starting ~48GB of downloads that the pending
    // respawn then killed.
    //
    // The sentence is kept where it is correct — nothing scheduled, nothing
    // applied — because that is the case it was written for and deleting it
    // would lose a genuinely useful "you can retry right now".
    const pending = receipt.respawn?.scheduled ?? 0;
    const already = receipt.respawn?.applied ?? 0;
    const readsItAtUseTime = `The comfyui tools re-read that file each time they use this credential, so the tool process already running picks it up — no reload needed`;
    if (pending > 0) {
      parts.push(
        `${readsItAtUseTime}. But a tool-session respawn is STILL PENDING from this save ` +
          `(${pending} queued, normally for the end of this turn), and it replaces the tool session ` +
          `when it fires. Anything long-running that session owns is lost at that point — model ` +
          `downloads in particular. This message cannot list them, because a transfer started AFTER ` +
          `this save did not exist when the check ran (#1567). ` +
          // #1567 item 2 — the advice used to be "let the respawn land before you start a long
          // download", which put the burden on the user to sequence around a rebuild they cannot
          // see. The respawn now WAITS instead, so this says what the scheduler will actually do
          // — including the one case that still costs transfers, since a promise with an
          // unstated exception is how this receipt misled someone the first time.
          `You do not have to sequence around it: when it comes due it waits for in-flight model ` +
          `downloads to finish rather than killing them. It stops waiting only if every one of them ` +
          `makes no progress for a couple of minutes, and it reports what it gave up on when that ` +
          `happens.`,
      );
    } else if (already > 0) {
      // A respawn HAPPENED. Saying none was required describes a different save,
      // and #1378's at-risk warning above is reporting what that one cost.
      parts.push(`${readsItAtUseTime} — and the tool session was rebuilt just now regardless.`);
    } else {
      parts.push(`${readsItAtUseTime}, and no respawn required.`);
    }
  } else {
    parts.push(
      `This key is read from the tool process's environment at startup, so only a respawned tool session will see it.`,
    );
  }
  if (receipt.respawn === null) {
    parts.push(
      `No agent session reported back, so NO tool-session respawn was scheduled by this save.`,
    );
  } else {
    const { applied, scheduled, live } = receipt.respawn;
    const bits: string[] = [];
    if (applied) bits.push(`${applied} replaced now`);
    if (scheduled) bits.push(`${scheduled} queued for the end of this turn`);
    parts.push(
      bits.length
        ? `Tool sessions being rebuilt with the new environment: ${bits.join(", ")} (of ${live} live).`
        : `No live tool session needed rebuilding (${live} live).`,
    );
  }
  // #1378's warning is NOT rendered here any more. It moved into `receiptDisclosures`
  // (pushed above), because this renderer is the agent-facing one and the Settings
  // endpoint saves through the same path, orphans the same transfers, and said nothing at
  // all. One description, every consumer — the alternative is what already happened once.

  parts.push(
    !confirmed
      ? `Before relying on it, re-check ${receipt.path} carries "${receipt.key}"; if the action fails again the same way, treat the credential as unset and set it again.`
      : receipt.livePickup
        ? `Retry the action that needed this credential now.`
        : `Retry after the tool session is rebuilt.`,
  );
  return parts.join(" ");
}

/**
 * True only when a comfy_reboot ToolResult carries a CONFIRMED `rebooting:true`
 * from the panel. `ctx.call` wraps the panel reply via ok() as JSON text and never
 * throws, so a busy-guard/forbidden/no-endpoint refusal comes back as a normal
 * ToolResult with `rebooting:false`. Gate cache invalidation on this so a refused
 * restart never closes the shared client mid-generation. Defensive: any error
 * flag or unparseable/absent field is treated as NOT confirmed.
 */
export function rebootConfirmed(res: ToolResult): boolean {
  try {
    if (res?.isError) return false;
    const text = res?.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") return false;
    const parsed = JSON.parse(text) as { rebooting?: unknown };
    return parsed?.rebooting === true;
  } catch {
    return false;
  }
}

/**
 * True when a comfy_reboot ToolResult is the bridge's canonical POST-WRITE mid-command
 * drop — the command was ACTUALLY WRITTEN to the panel socket and the connection then
 * died before a reply (the reboot handler exits the instant it accepts, so the socket
 * dies mid-flight). The bridge emits this for a MUTATING command as
 * "disconnected mid-command … OUTCOME UNKNOWN" (ui-bridge.ts handleMidCommandDisconnect).
 *
 * Deliberately NOT matched (coordinator P0): a raw PRE-WRITE `sock.send()` failure
 * (ECONNRESET / socket hang up / EPIPE / "was NOT dispatched") — that means the command
 * was NEVER written, so NOTHING was dispatched. Treating a pre-write send failure as an
 * accepted/ambiguous "dropped reboot" would let readiness certify a cycle that was never
 * even requested. Also NOT matched: pre-dispatch "is not open" / "did not reply within N
 * ms" (a live-but-frozen tab) / idempotent-read grace expiry — those return verbatim.
 * A genuine refusal comes back as a NON-error `rebooting:false` (rebootConfirmed handles).
 */
export function rebootDropped(res: ToolResult): boolean {
  if (!res?.isError) return false;
  const text = res?.content?.find((c) => c.type === "text")?.text ?? "";
  // The AUTHORITATIVE signal is the bridge's TYPED dispatch flag (dispatchOutcomeOf),
  // checked by the caller BEFORE this. This text match is a defense-in-depth fallback:
  // the pre-write wrapper ("the command was NOT dispatched") must WIN even if its quoted
  // detail contains a post-write phrase, so a pre-write send failure is never a "drop".
  if (/NOT dispatched/i.test(text)) return false;
  return /disconnected mid-command|OUTCOME UNKNOWN/i.test(text);
}

/**
 * True when a comfy_reboot ToolResult is a NON-error, NON-fired refusal whose
 * cause is that the panel could reach NO ComfyUI-Manager reboot endpoint — i.e.
 * every Manager reboot route answered 404/405 (the classic legacy Manager 3.x
 * symptom: `POST /v2/manager/reboot → 405; GET /manager/reboot → 404`,
 * panel #253/#266 and this repo #425). This is distinct from:
 *   - a busy-guard refusal (a generation is running) — its text speaks to the
 *     queue/generation, never to a "reboot endpoint", so it does NOT match; and
 *   - a Manager-security 403 refusal — that speaks to "security"/"forbidden".
 * Only a no-endpoint refusal is safe to retry through the headless managed
 * restart (kill + relaunch), and only for a LOCAL, process-controllable target.
 */
export function rebootNoEndpoint(res: ToolResult): boolean {
  if (res?.isError) return false;
  const text = res?.content?.find((c) => c.type === "text")?.text ?? "";
  // A busy-guard / security refusal must never be treated as "no endpoint" — a
  // kill+relaunch fallback would abort a running render or defeat the security
  // gate. Require the reboot-endpoint signature AND the absence of those.
  if (/busy|in progress|generation|queue is|running|security|forbidden|403/i.test(text)) {
    return false;
  }
  return /reboot endpoint|reboot route|was NOT restarted|no reachable .*reboot/i.test(text);
}

interface PanelRebootTiming {
  /** Grace pause after the reboot fires before probing (lets the origin go down). */
  settleMs: number;
  /** Total readiness budget — generous, a real restart can take 15–60s+. */
  budgetMs: number;
  /** Interval between readiness probes. */
  intervalMs: number;
  /** Per-probe timeout for the bridge readiness call. */
  probeTimeoutMs: number;
}

let panelRebootTimingOverride: PanelRebootTiming | null = null;

// The whole readiness wait (settle + poll budget) MUST finish comfortably below the
// client's outer ~300s tools/call timeout, so a FAILING wait always returns a clean
// ready:false in time instead of being killed as a bare 300s timeout — even if the
// COMFYUI_PANEL_REBOOT_* env overrides are set absurdly high (coordinator codex P2).
const MAX_REBOOT_SETTLE_MS = 10_000; // 10s
const MAX_REBOOT_BUDGET_MS = 240_000; // 240s  → settle+budget ≤ 250s < 300s outer

// #404: hard ceiling on how long the panel_restart_comfyui CONFIRMATION card waits for
// a yes/no answer. A restart is user-initiated, so a present user answers in seconds;
// the failure mode is an unanswered/undelivered card AFTER a prior restart's reconnect
// (the "second restart in one turn" repro: the panel tab is backgrounded or still
// re-registering, so the card is never seen/answered). Previously the confirm inherited
// the full remaining ~255s budget, so it blocked for ~4 minutes and read as an
// indefinite hang (the user killed it at ~2min). Bounding the WAIT here — well under the
// ~240s ask deadline and the ~300s tools/call budget — makes an unanswered card fail
// fast with an actionable retry / restart_comfyui hint. It NEVER shortcuts the
// confirmation itself (no auto-confirm): it bounds only how long we wait for the answer.
const RESTART_CONFIRM_TIMEOUT_MS = 90_000; // 90s

// #742 decline-probe recheck window: a single ECONNREFUSED is NOT proof of a
// lost server — a genuinely restarting instance is refused during its normal
// down window (codex gate). When the decline path probes before reporting, it
// rechecks over this SHORT, bounded window and only declares DOWN when the
// endpoint is STILL refused at the end of it; a recovery inside the window is
// reported as such. Deliberately small: the turn already ended on the user's
// decline, so this is a report-time check and must not stall.
const DECLINE_PROBE_WINDOW_MS = 6_000; // 6s total
const DECLINE_PROBE_INTERVAL_MS = 2_000; // 2s between samples
const DECLINE_PROBE_TIMEOUT_MS = 2_000; // per-sample probe ceiling
// #742 r4/r5: the decline path may name restart causation only against a
// dispatch RECORDED within RESTART_DISPATCH_CAUSATION_WINDOW_MS (imported from
// process-control) whose token THIS session holds — see sessionRestartDispatch.

function parsePositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Reboot-readiness timing from env, with each value HARD-CAPPED so no override can
 *  push the total wait past the outer tools/call budget (coordinator codex P2).
 *  The probe interval defaults to a TIGHT 500ms: the observer runs CONCURRENTLY with
 *  the reboot dispatch and must catch a BRIEF down window (a fast restart can be down
 *  for well under 2s), needing >=2 down probes inside it (coordinator HIGH). settleMs
 *  is retained only for the env cap; the observer no longer settles before probing. */
function computeRebootTimingFromEnv(): PanelRebootTiming {
  return {
    settleMs: Math.min(
      MAX_REBOOT_SETTLE_MS,
      Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_REBOOT_SETTLE_S", 3) * 1000),
    ),
    budgetMs: Math.min(
      MAX_REBOOT_BUDGET_MS,
      Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_REBOOT_BUDGET_S", 120) * 1000),
    ),
    intervalMs: Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_REBOOT_INTERVAL_S", 0.2) * 1000),
    probeTimeoutMs: Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_REBOOT_PROBE_S", 2) * 1000),
  };
}

function getPanelRebootTiming(): PanelRebootTiming {
  return panelRebootTimingOverride ?? computeRebootTimingFromEnv();
}

/** The default generous readiness budget, in seconds — reported to callers. */
export function panelRebootBudgetSeconds(): number {
  return Math.round(getPanelRebootTiming().budgetMs / 1000);
}

export const __panelToolsTestHooks = {
  /** Inject fast reboot-readiness timing so tests don't wait the real ~120s budget. */
  setPanelRebootTiming(timing: PanelRebootTiming | null): void {
    panelRebootTimingOverride = timing;
  },
  /** Inject a fake boot-endpoint probe so readiness tests drive the real proof loop
   *  without real HTTP. Returns a ProbeStatus, or a boolean (true→healthy/false→down)
   *  so DOWN→UP can be scripted with plain booleans. null restores the live probe. */
  setHealthProbe(
    fn:
      | ((base: string | null, timeoutMs: number) => Promise<boolean | ProbeStatus>)
      | null,
  ): void {
    healthProbeOverride = fn;
  },
  /** Inject a fake #742 restart preflight so reboot tests don't probe real
   *  processes/ports. null restores the live preflightLocalRestart. */
  setLocalRestartPreflight(
    fn:
      | (() => Promise<{
          ok: boolean;
          reason?: string;
          observedArgv?: string[];
          isDesktopApp?: boolean;
          note?: string;
        }>)
      | null,
  ): void {
    localRestartPreflightOverride = fn;
  },
  /** Inject a fast #742 decline-probe recheck window so decline-path tests
   *  don't wait the real ~6s. null restores the DECLINE_PROBE_* constants. */
  setDeclineProbeTiming(
    timing: { windowMs: number; intervalMs: number; probeTimeoutMs: number } | null,
  ): void {
    declineProbeTimingOverride = timing;
  },
  /** Inject a fake #1249 server-side /free so the frozen-tab settle can be
   *  driven without real HTTP. null restores the live freeVramDirect. */
  setFreeVramDirect(fn: ((base: string) => Promise<FreeVramDirectOutcome>) | null): void {
    freeVramDirectOverride = fn;
  },
  /** Direct access to the #742 decline recheck loop so its hard-deadline
   *  guarantee (codex gate r2) can be unit-tested with a custom deadline. */
  probeDeclineRecovery,
  /** r5: the restart-dispatch record THIS session (ctx) holds, or null. */
  getSessionRestartDispatch(
    ctx: PanelToolCtx,
  ): { at: number; base: string | null } | null {
    return sessionRestartDispatch(ctx);
  },
  /** r5: seed a restart-dispatch record HELD BY this session (ctx) — with an
   *  explicit `at` so fresh/stale shapes don't need a real restart. */
  seedSessionRestartDispatch(
    ctx: PanelToolCtx,
    record: { at: number; base: string | null },
  ): void {
    const token = randomUUID();
    __processControlTestHooks.setRestartDispatchRecord(token, record);
    sessionRestartDispatchTokens.set(ctx, token);
  },
  looksLikeSystemStats,
  probeComfyHealth,
  probeComfyEndpoint,
  captureRebootHealthBase,
  sameHttpOrigin,
  sameHttpBase,
  isLoopbackOrigin,
  loopbackProbeUrl,
  /** Compute reboot timing from env WITH the P2 hard caps (bypasses any override). */
  computeRebootTimingFromEnv,
  /** #404: the hard ceiling on the panel_restart_comfyui confirmation-card wait. */
  RESTART_CONFIRM_TIMEOUT_MS,
  /** Zero out the post-drop retry settle so retry-once tests don't sleep. */
  setRetrySettleMs(ms: number | null): void {
    retrySettleMsOverride = ms;
  },
  /** Inject fast reconnect-wait timing so #400/#402 tests don't wait the real ~20s. */
  setReconnectWaitTiming(timing: { budgetMs: number; intervalMs: number } | null): void {
    reconnectWaitTimingOverride = timing;
  },
  /** Shrink the #1175 late-acknowledgement grace so a reconcile test doesn't wait 10s. */
  setRunLateAckGraceMs(ms: number | null): void {
    runLateAckGraceMsOverride = ms;
  },
  isRetrySafeCmd,
  isTransientReconnectError,
  // CivitAI sample-image gating (#623): the predicate that decides which results'
  // pixels may be shown to the agent, and the bounded thumbnail fetcher.
  civitaiSampleEligible,
  fetchCivitaiSampleImages,
  // Adult-consent classifier + its exact card labels (#390 gate tests).
  classifyConsentReply,
  CONSENT_YES_LABEL,
  CONSENT_NO_LABEL,
  // #384 live-canvas capture fallback (defined later in the module).
  reconstructUiFromState: (reply: unknown) => reconstructUiFromState(reply),
  resolveWorkflowInput: (
    args: Record<string, unknown>,
    ctx: PanelToolCtx,
    allowStateFallback = true,
  ) => resolveWorkflowInput(args, ctx, allowStateFallback),
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Post-reconnect retry-once for idempotent panel commands ──────────────────
// A tool-triggered ComfyUI reboot (#278/#481), a panel_free_vram (#310), or a
// Manager-backed call racing a post-restart reconnect (#332) can drop the panel
// tab's transport the instant AFTER a command was dispatched — or replace the
// tab under a BRAND-NEW socket/tab id with no migration alias, orphaning this
// session. The bridge's own mid-command resume only helps when the SAME tab id
// re-hellos; when the id changed, the in-flight command surfaces a bare
// "no connected tab" / "disconnected mid-command … genuinely gone" / "Failed to
// fetch" and the agent is told to hand-call panel_set_workflow_target(current).
//
// For commands that are SAFE to re-issue (idempotent reads, plus idempotent
// UI-state writes like set_todo that fully REPLACE state), we transparently
// rebind onto the now-live tab (ensureReachable) and retry ONCE after a short
// settle. Mutating graph edits (add_node/connect/set_widget/…) are deliberately
// EXCLUDED — re-issuing them could double-apply — so they keep surfacing the
// bridge's honest OUTCOME-UNKNOWN error.
// #599: commands whose FRONTEND handler intentionally awaits a fresh /object_info
// re-register before it can reply — the refresh-before-validate path in
// graph_set_widget (#338/#458) and graph_add_node (#289/#458), and the explicit
// forced node-def refresh in refresh_nodes (#608). On a large install with many
// custom-node packs a legitimate /object_info fetch can take longer than the
// bridge's 6000 ms DEFAULT ack window, so the panel replies late and the tool
// returns a FALSE "tab did not reply" timeout even though the write is valid and
// in progress. Give these a larger BOUNDED ack budget so a slow-but-valid refresh
// is not mistaken for a dead tab — still capped (never Infinity) so a genuinely
// frozen/backgrounded tab fails in bounded time instead of hanging forever.
const OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS = 30_000;

// #1639 — while a ComfyUI prompt is running the frontend main thread often
// cannot service graph_* at all (reads included). Waiting out the 20/30 s ack
// bound only surfaces "tab may be backgrounded or frozen" with an unknown
// mutation outcome. Fail closed BEFORE dispatch for canvas-touching graph
// commands so the agent gets an explicit QUEUE BUSY instead. `graph_run` is
// excluded: queuing behind an in-flight job is the documented sweep path, and
// panel_run already has its own duplicate fence.
function queueBusySnapshotNote(): string {
  const snap = QueueMonitor.snapshot();
  if (!snap.running) return "";
  const prompt = snap.runningPromptId ? ` (running prompt ${snap.runningPromptId}` : "";
  const node = snap.currentNode ? `, currently at node ${snap.currentNode}` : "";
  const close = snap.runningPromptId ? ")" : "";
  return `${prompt}${node}${close}`;
}

function graphCmdBlockedByRunningPrompt(cmd: Record<string, unknown>): string | null {
  const name = typeof cmd.cmd === "string" ? cmd.cmd : "";
  if (!name.startsWith("graph_") || name === "graph_run") return null;
  const snap = QueueMonitor.snapshot();
  if (!snap.running) return null;
  return (
    `${name} was NOT sent — nothing was applied. QUEUE BUSY: a ComfyUI prompt is running` +
    `${queueBusySnapshotNote()}. The panel tab typically cannot answer graph_* commands ` +
    `(including read-only graph_query / graph_outline) while a prompt is executing — ` +
    `waiting out the ack timeout would only surface a generic "tab may be backgrounded ` +
    `or frozen" with an unknown outcome. Retry after queue (action:"list") shows running: 0.`
  );
}

function queueBusyTimeoutNote(): string {
  if (!QueueMonitor.snapshot().running) return "";
  return (
    `\n\nQUEUE BUSY: a ComfyUI prompt is still running${queueBusySnapshotNote()}. ` +
    `The panel tab typically cannot answer graph_* (including read-only queries) while a ` +
    `prompt is executing — this is not a backgrounded or frozen tab. Retry after queue ` +
    `(action:"list") shows running: 0.`
  );
}

const RETRY_SAFE_CMDS = new Set<string>([
  // Idempotent reads (mirror UiBridge.READONLY_CMDS + list/status probes).
  "graph_serialize",
  "graph_outline",
  "graph_get_errors",
  "graph_get_subgraph",
  "graph_prompt_director_audit",
  "graph_query",
  "get_todo",
  "workflow_list",
  "nodes_list",
  "nodes_queue_status",
  "node_queue_status",
  // Idempotent full-replace UI state — re-sending the same list is a no-op (#481).
  "set_todo",
  // #608: a forced /object_info re-register + combo refresh. Non-destructive and
  // idempotent (re-running just re-fetches the current defs), so a dropped
  // transport can safely re-issue it once.
  "refresh_nodes",
]);

/** A command whose result is unchanged by being re-issued after a reconnect —
 *  so it is safe to transparently retry once when the transport dropped. */
function isRetrySafeCmd(cmd: Record<string, unknown>): boolean {
  const name = typeof cmd.cmd === "string" ? cmd.cmd : "";
  return RETRY_SAFE_CMDS.has(name);
}

// Graph-EDIT mutations that CHANGE the user's canvas (undoable edits). These are
// the #436 bug surface: a real side effect the bridge will NOT auto-retry, so —
// unlike a read — such a command can be neither parked mid-command nor retried
// once, and firing it into the post-restart "Connected: none" window fails with
// "no connected tab". It must await a stable binding BEFORE dispatch.
//
// This is an EXPLICIT ALLOWLIST, deliberately NOT "everything not read-only":
// several genuine reads/probes/views that flow through ctx.call are absent from
// BRIDGE_READONLY_CMDS (e.g. graph_list_subgraphs, training_get_state,
// graph_canvas, graph_screenshot), so an exclusion rule would wrongly make THOSE
// wait out the reconnect budget. Under-inclusion here is at worst an unfixed edge
// (a command keeps today's behavior); over-inclusion would regress a read — so we
// list only commands that unambiguously mutate the graph. Keep in sync when new
// graph-edit tools are added (mirrors the RETRY_SAFE_CMDS maintenance model).
const MUTATING_GRAPH_EDIT_CMDS = new Set<string>([
  "graph_add_node",
  "graph_remove_node",
  "graph_clear",
  "graph_connect",
  "graph_disconnect",
  "graph_set_widget",
  "graph_remove_widget",
  "graph_set_node_property",
  // Legacy bridge commands remain behind compatibility tool names so panels that
  // predate graph_edit_node continue to receive commands they actually implement.
  "graph_move_node",
  "graph_resize_node",
  "graph_set_title",
  "graph_set_node_collapsed",
  "graph_set_node_color",
  "graph_edit_node",
  "graph_set_node_mode",
  "graph_update_node",
  "graph_create_group",
  "graph_edit_group",
  "graph_remove_group",
  "graph_move_group",
  "graph_create_subgraph",
  "graph_add_subgraph",
  "graph_save_subgraph",
  "graph_unpack_subgraph",
  "graph_subgraph_group",
  "graph_expose_subgraph_input",
  "graph_expose_subgraph_output",
  "graph_promote_widget",
  "graph_move_rail",
  "graph_paste_nodes",
  "graph_auto_layout",
  "graph_load",
]);

/** A MUTATING graph edit that must await a stable tab binding before dispatch so
 *  it never fires into the post-restart "Connected: none" window (#436). */
function isMutatingGraphCmd(cmd: Record<string, unknown>): boolean {
  const name = typeof cmd.cmd === "string" ? cmd.cmd : "";
  return MUTATING_GRAPH_EDIT_CMDS.has(name);
}

/**
 * #1519 — a graph command the panel FENCES that does not mutate the canvas.
 *
 * The panel's `activeWorkflowFenceApplies` fences every `graph_*` command, reads
 * included, and exempts the recovery probe `workflow_list`
 * (`commandIsCanvasTargetless`, panel #759). So "fenced, and not a mutation" is
 * exactly the `graph_*` names that are not in MUTATING_GRAPH_EDIT_CMDS — derived
 * from that one allowlist rather than kept as a second one, so a newly added edit
 * command cannot drift into being classified as a read.
 *
 * The `graph_` prefix is load-bearing for a second reason: the diagnosis this
 * gates runs `workflow_list`, which flows back through this same catch. Keying on
 * the prefix keeps the probe OUT of the branch that launched it, so a panel that
 * fences the probe too (a build predating the #759 exemption) surfaces its own
 * refusal instead of recursing.
 */
function isFencedGraphRead(cmd: Record<string, unknown>): boolean {
  const name = typeof cmd.cmd === "string" ? cmd.cmd : "";
  return name.startsWith("graph_") && !MUTATING_GRAPH_EDIT_CMDS.has(name);
}

/** True when an error is a TRANSIENT transport/reconnect drop (the tab went away
 *  or was replaced), NOT a genuine command error or a live-but-frozen reply
 *  timeout. Deliberately EXCLUDES "did not reply within N ms" (a backgrounded/
 *  frozen tab — retrying just double-waits, #334) and "OUTCOME UNKNOWN" (a
 *  mutating command that may already have applied). */
function isTransientReconnectError(err: unknown): boolean {
  // #1001 — the TYPED marker wins over the text. A routing-ambiguity refusal
  // (the turn was issued from several workflows at once) opens with the literal
  // words "no connected tab", so the regex below matched it and called a fully
  // connected panel "transient". Nothing about it is: the pin is settled for the
  // whole batch, so the retry is guaranteed to fail identically, and the caller
  // then reported "still reconnecting after a restart/reload" about a panel that
  // never disconnected. Waiting cannot clear this; only an explicit target or the
  // next single-origin message can.
  if (isRoutingAmbiguity(err)) return false;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /no connected tab|genuinely gone|is not open|Failed to fetch|Panel not reachable|ECONNRESET|socket hang up|premature close|other side closed|ECONNABORTED|EPIPE/i.test(
    msg,
  );
}

/**
 * #1027 — the panel's WORKFLOW-SWITCH critical section, which is retryable by
 * construction and was not being retried.
 *
 * While a workflow switch/reload is in flight the panel refuses every graph and
 * workflow executor rather than queueing it, because refusing cannot reorder or
 * double-apply. Its own words:
 *
 *   the panel is switching/refreshing "<key>" right now, so "<cmd>" was NOT
 *   applied — nothing changed. Retry in a moment.
 *
 * Two facts make this the safest retry in the file: the panel STATES nothing was
 * applied, and the section lasts a fraction of a second. Yet none of that text
 * matched the transient classifier, so a read issued right after
 * panel_open_workflow surfaced the refusal to the agent instead of waiting the
 * ~400ms the panel asked for. A reporter driving several tabs read-only hit it
 * repeatedly, and read the resulting instance-mismatch errors as a wedge.
 *
 * TEXT-matched, deliberately, unlike #1001's typed marker: this error is minted
 * in the browser and arrives over the wire, so there is no object identity to
 * carry a symbol across. The phrasing is distinctive enough to key on, and the
 * retry it enables is bounded to RETRY-SAFE commands either way.
 */
function isWorkflowSwitchGuardRefusal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /panel is switching\/refreshing|panel is switching or reloading/i.test(msg);
}

/**
 * #1330 — the panel's workflow-instance fence refused this command.
 *
 * Distinct from every other refusal here in one way that matters: the panel checks the
 * fence BEFORE the handler runs, so "Nothing was applied" is structural, not a claim.
 * That is what makes it safe to tell a caller to retry — and it is why this is worth
 * separating from the transport failures around it, where the outcome is unknown.
 *
 * Matched on the leading token the panel preserves deliberately for exactly this
 * purpose (see workflowInstanceMismatchMessage: "the leading `workflow instance
 * mismatch:` token is preserved deliberately").
 */
function isWorkflowInstanceMismatch(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /workflow instance mismatch/i.test(msg);
}

/**
 * #1331 — the bridge refused a mutation because the active workflow has no identity to
 * fence against (ui-bridge's `no trusted identity` branch).
 *
 * A DIFFERENT refusal from the one above, and the pair is easy to conflate: that one is
 * two identities disagreeing, this one is there being no identity at all. They also need
 * different handling — a mismatch may clear by itself, this never does.
 *
 * Kept separate from the capability refusal beside it because those need opposite
 * advice: a capability gap needs a panel UPDATE, this needs the workflow re-opened. What
 * they share is that the generic "retry / rebind with mode:current" wrapper can clear
 * NEITHER, and appending it sent the reporter of #1331 through four calls to reach a
 * state the panel already believed it was in.
 */
function isNoTrustedIdentityRefusal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /no trusted identity/i.test(msg);
}

/**
 * #1480 — the panel's GRAPH-BINDING guard refused: the live canvas carries a different
 * workflow's identity tag than the active workflow (`graphBindingRefusalMessage`'s
 * `root-workflow-uuid-mismatch` verdict).
 *
 * A THIRD distinct refusal, and the trio is easy to conflate. The two above are the
 * bridge's per-command STAMP fence (`workflow instance mismatch`) and the bridge having
 * NO identity to stamp with (`no trusted identity`); this one is the panel comparing the
 * tag on the mounted LiteGraph root against the active workflow's identity and finding
 * two tags that disagree. It is raised by the panel, before every executor, so its
 * "was NOT applied" claim is structural — the same property that makes the two above
 * safe to annotate.
 *
 * Matched on the bracketed token the panel emits for exactly this purpose
 * (`[root-workflow-uuid-mismatch] …`), not on the prose after it, and ANCHORED to the
 * start (codex): a bare `contains` also fires on any message that merely QUOTES the
 * token — a wrapped or re-surfaced refusal, an error about the token as a value — and
 * would then spend a round trip telling that caller to re-open a workflow. The anchor is
 * the panel's real shape, not a hopeful one: a panel executor's error text becomes this
 * Error's message verbatim, with no prefix (ui-bridge's reply-error reject).
 */
function isRootWorkflowUuidMismatch(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /^\s*\[root-workflow-uuid-mismatch\]/i.test(msg);
}

/**
 * #1480 — WHICH `panel_open_workflow` SELECTOR EXISTS FOR THE ACTIVE TAB.
 *
 * The mismatch refusal's remedy is `panel_open_workflow(<path>)`, and for a NEVER-SAVED
 * tab there is no path to pass: `workflow_list` reports `path: null` and `filename: null`
 * for it by contract, because native ComfyUI reuses the "Unsaved Workflow" title across
 * unsaved tabs (#186). The reporter followed the remedy with the tab's TITLE, got "no
 * workflow matching", and every other documented exit was blocked too — reload refuses on
 * unsaved changes, save refuses under this very guard (#708) — so the session dead-ended
 * with the canvas readable and unedittable.
 *
 * The exit was there the whole time and nothing named it: the per-instance ROUTING KEY
 * (`tmp:<uuid>`) is a valid `workflow_open` selector — for an unsaved tab it is the ONLY
 * one it has (`workflowRecordMatchesSelector`) — and `workflow_list` already publishes it
 * as `routing_key` on every record. So this reads the ONE fact that decides which remedy
 * is followable, and the caller names that one instead of the generic `<path>`.
 *
 * Read-only, and `workflow_list` is exempt from the fence being reported on, so this can
 * run on the refusal path without being refused by it. Anything unreadable answers
 * "unknown" and the caller says so rather than picking a selector it cannot support.
 */
interface ActiveTabRebindSelector {
  status: "unsaved" | "saved" | "unknown";
  /** The selector to pass to `panel_open_workflow`, when one is established. */
  selector: string | null;
  /** Display label, for a message that has to refer to the tab a human is looking at. */
  title: string | null;
  /** Why the answer is "unknown" — never a guess dressed as a reason. */
  why: string;
}

async function readActiveTabRebindSelector(ctx: PanelToolCtx): Promise<ActiveTabRebindSelector> {
  const unknown = (why: string): ActiveTabRebindSelector => ({
    status: "unknown",
    selector: null,
    title: null,
    why,
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    const res = await ctx.call({ cmd: "workflow_list" }, 6000);
    if (res?.isError) return unknown(`the workflow list read failed (${toolResultText(res)})`);
    parsed = parseToolResultJson(res);
  } catch (err) {
    return unknown(
      `the workflow list read threw (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const active = parsed?.active;
  if (!active || typeof active !== "object") {
    return unknown("the workflow list reported no active workflow");
  }
  const rec = active as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const title = str(rec.title);
  const path = str(rec.path);
  const routingKey = str(rec.routing_key) ?? str(rec.key);
  // SAVED is decided by the presence of a real path, the same fact the panel keys
  // `persisted` on — never by the routing key's spelling, which is panel-owned and
  // would silently reclassify every tab if its prefix ever changed.
  if (path) return { status: "saved", selector: path, title, why: "" };
  if (!routingKey) {
    return unknown("the active tab reported neither a path nor a routing key");
  }
  return { status: "unsaved", selector: routingKey, title, why: "" };
}

let retrySettleMsOverride: number | null = null;
/** Short pause before the single post-drop retry, letting the replacement tab
 *  finish its reconnect hello so ensureReachable can resolve it. Test-overridable. */
function retrySettleMs(): number {
  if (retrySettleMsOverride != null) return retrySettleMsOverride;
  return Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_RETRY_SETTLE_S", 0.4) * 1000);
}

interface ReconnectWaitTiming {
  /** Total wall-clock budget to wait for a tab to (re)connect after a restart/reload. */
  budgetMs: number;
  /** Interval between canReach polls. */
  intervalMs: number;
}
let reconnectWaitTimingOverride: ReconnectWaitTiming | null = null;
/** Bounded wait for a browser tab to (re)connect after a full ComfyUI restart or a
 *  soft-reload — the "Connected: none" window in which every panel_* call fires into
 *  a dead binding (#400) or a mutating open/save returns OUTCOME UNKNOWN (#402). The
 *  browser reconnects its own socket seconds-to-tens-of-seconds after ComfyUI comes
 *  back, so the existing single ~400ms retry always loses the race. Test-overridable. */
/** Hard ceiling on the reconnect wait so an oversized env value can never make a
 *  tool block near/over the outer MCP tools/call deadline (~300s). */
const RECONNECT_WAIT_MAX_MS = 60_000;
function reconnectWaitTiming(): ReconnectWaitTiming {
  if (reconnectWaitTimingOverride) return reconnectWaitTimingOverride;
  return {
    budgetMs: Math.min(
      RECONNECT_WAIT_MAX_MS,
      Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_RECONNECT_WAIT_S", 20) * 1000),
    ),
    intervalMs: Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_RECONNECT_POLL_S", 0.5) * 1000),
  };
}

interface PanelReadyResult {
  ready: boolean;
  waited_ms: number;
  attempts: number;
  /** How readiness was established after an ACCEPTED reboot:
   *   - "observed-cycle": we saw the boot endpoint go DOWN then become healthy — a
   *     directly observed restart cycle. This is the ONLY sound proof that THIS ComfyUI
   *     instance cycled, and the only value ever set.
   *   undefined when it does not recover within budget (couldn't-confirm), or no signal. */
  via?: "observed-cycle";
  /** True once the boot endpoint was observed unreachable after the accepted dispatch. */
  sawDown: boolean;
  /** The status of the LAST sample taken, or undefined if none was.
   *
   *  `sawDown` LATCHES on a single "down" and never clears, which is right for proving a
   *  cycle STARTED and wrong for describing where things ended up: a transient refusal
   *  followed by an endpoint that answers (or answers 5xx, i.e. "unknown") leaves sawDown
   *  true forever (codex #742 r2). Anything reporting a server as not-back must read this
   *  instead — it is the only field that says what the last observation actually saw. */
  lastStatus?: ProbeStatus;
}

/** True when a decoded /system_stats body has the recognizable ComfyUI shape (a
 *  `system` object and/or a `devices` array) — the same fields get_system_stats (action:"health") /
 *  install_comfyui (action:"environment") read. A bare 2xx from a reverse-proxy login page, an SPA
 *  catch-all, or a proxy error page is NOT ComfyUI and must NOT certify recovery
 *  (codex #509 P1). */
function looksLikeSystemStats(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { system?: unknown; devices?: unknown };
  const hasSystem = b.system != null && typeof b.system === "object";
  const hasDevices = Array.isArray(b.devices);
  return hasSystem || hasDevices;
}

/** The CONCRETE loopback FAMILY of a hostname, or null when it isn't an unambiguous
 *  loopback literal. IPv4 loopback (127.0.0.1 / the 0.0.0.0 wildcard) → "127.0.0.1";
 *  IPv6 loopback (::1 / the :: wildcard) → "::1". The families are kept DISTINCT so a
 *  v4 tab and a v6 instance at the same port are NOT wrongly matched (coordinator
 *  finding 4: v6 A on [::1]:8188 + v4 B on 127.0.0.1:8188 are DIFFERENT instances).
 *
 *  `localhost` returns null ON PURPOSE (coordinator P0): a URL preserves the literal
 *  "localhost" and does NOT reveal whether the browser actually reached 127.0.0.1 or
 *  ::1 — so PINNING it to a family we can't verify could send the auth-bearing probe to
 *  a DIFFERENT-family instance than the reboot went to (v6 A rebooted, v4 B probed →
 *  false cert + auth leak). We therefore refuse the ambiguity: a `localhost` boot/tab
 *  origin is NOT directly-probeable and routes to the honest dispatched-unconfirmed
 *  result instead of the direct-probe certification path. */
function loopbackFamily(host: string): "127.0.0.1" | "::1" | null {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "127.0.0.1" || h === "0.0.0.0") return "127.0.0.1";
  if (h === "::1" || h === "::" || h === "0000:0000:0000:0000:0000:0000:0000:0000") return "::1";
  return null;
}

/** True when a hostname is loopback-equivalent (either family, incl. the wildcard
 *  binds 0.0.0.0/:: which are reachable on loopback). */
function isLoopbackHostName(host: string): boolean {
  return loopbackFamily(host) !== null;
}

/** The scheme://host:port origin of a URL (default ports made explicit), or null if
 *  unparseable. Loopback hosts canonicalize to their FAMILY loopback (v4 → 127.0.0.1,
 *  v6 → ::1) — so 127.0.0.1/0.0.0.0 compare equal, and ::1/:: compare equal. NOTE:
 *  `localhost` is deliberately NOT folded (loopbackFamily returns null for it), so it
 *  compares UNEQUAL to a concrete literal — callers that would harm a user by treating
 *  that as proof of difference must degrade it to "unknown" themselves (#1233),
 *  but a v4 host and a v6 host DIFFER (they may be different instances). Ports differ. */
function httpOriginOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const host = u.hostname.toLowerCase();
    const canonHost = loopbackFamily(host) ?? host;
    return `${u.protocol}//${canonHost}:${port}`;
  } catch {
    return null;
  }
}

/** Rewrite a CONCRETE loopback-literal base URL to one that is actually CONNECTABLE and
 *  that AGREES with loopbackFamily's identity canonicalization — so the probe (and the
 *  auth headers it carries) can never hit a DIFFERENT-family instance than the one
 *  identity matched (coordinator P1). Every IPv4-family loopback literal (127.0.0.1 /
 *  0.0.0.0) → the literal 127.0.0.1; every IPv6-family loopback literal (::1 / ::) → the
 *  bracketed literal [::1]. A DNS-ambiguous `localhost` has no concrete family and is
 *  left UNCHANGED (callers gate it out via loopbackFamily before probing). Non-loopback
 *  hosts are returned unchanged. */
function loopbackProbeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const fam = loopbackFamily(u.hostname);
    if (fam === "127.0.0.1") u.hostname = "127.0.0.1";
    else if (fam === "::1") u.hostname = "[::1]";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return rawUrl;
  }
}

/** True when two URLs share the exact same scheme + host + port (path ignored).
 *  Used ONLY for the redirect host-escape check — a same-host redirect isn't a
 *  host escape. Instance IDENTITY uses sameHttpBase (path-aware) instead. */
function sameHttpOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  const oa = a ? httpOriginOf(a) : null;
  const ob = b ? httpOriginOf(b) : null;
  return oa != null && oa === ob;
}

/** The canonical scheme://host:port/path form of a URL (loopback host normalized,
 *  trailing slashes stripped, path case-sensitive), or null if unparseable. Two
 *  ComfyUI instances reverse-proxied under the SAME host:port but DIFFERENT path
 *  prefixes (/a vs /b) are DISTINCT — so instance identity must include the path. */
function canonicalHttpBase(rawUrl: string): string | null {
  const origin = httpOriginOf(rawUrl);
  if (origin == null) return null;
  try {
    const path = new URL(rawUrl).pathname.replace(/\/+$/, "");
    return `${origin}${path}`;
  } catch {
    return null;
  }
}

/** True when two URLs identify the SAME instance: same scheme+host+port AND the
 *  same path prefix (a reverse-proxied mount point is part of its identity). */
function sameHttpBase(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = a ? canonicalHttpBase(a) : null;
  const cb = b ? canonicalHttpBase(b) : null;
  return ca != null && ca === cb;
}

/** True when a URL's host is loopback-EQUIVALENT (incl. the wildcard binds 0.0.0.0/::,
 *  which are reachable on loopback) — the only hosts the orchestrator can reach on its
 *  OWN machine to health-probe (the #509 local case). */
function isLoopbackOrigin(rawUrl: string): boolean {
  try {
    return isLoopbackHostName(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

type ProbeStatus = "healthy" | "down" | "unknown";

/** Connection error codes that DEFINITIVELY mean the endpoint's PORT is not accepting —
 *  the listener is gone (a restarting process closed it). This is the ONLY connection
 *  failure that proves a process-down for the cycle proof, and for a LOOPBACK probe the
 *  ONLY sound one: ECONNREFUSED = the host actively refused the connection because nothing
 *  is listening on that port. Everything else is (correctly) NOT a listener-down:
 *   - ECONNRESET / EPIPE / EPROTO / ETIMEDOUT / "socket hang up" — a still-LISTENING server
 *     can reset a connection or transiently fail TLS without going down;
 *   - ENETUNREACH / EHOSTUNREACH / ENETDOWN / EHOSTDOWN — a local network/routing failure;
 *     the ComfyUI process can still be listening while the stack is momentarily unavailable
 *     (codex High);
 *   - ENOTFOUND / EAI_AGAIN — DNS (inapplicable to a loopback literal), not a listener-down.
 *  A genuine restart CLOSES the loopback port, so repeated polling observes ECONNREFUSED
 *  during the down window; the ambiguous codes above stay "unknown" so a transient glitch
 *  + a later 200 can never fake a restart cycle. */
const PORT_NOT_LISTENING_CODES = new Set([
  "ECONNREFUSED", // host refused — nothing listening on the port (the restarting-process signal)
]);

/** Extract a connection error's OS code (undici wraps the real error under `.cause`). */
function connErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e?.code === "string") return e.code;
  if (typeof e?.cause?.code === "string") return e.cause.code;
  return undefined;
}

/**
 * Probe the boot endpoint and CLASSIFY it. Because the down→up transition is the SOLE
 * proof a process actually CYCLED, "down" must mean the endpoint STOPPED SERVING at the
 * CONNECTION level — the port isn't accepting (a restarting process closes its listener).
 * The boot endpoint in the certify path is a DIRECT loopback ComfyUI (no reverse proxy —
 * captureRebootHealthBase probes 127.0.0.1/[::1] directly), so:
 *   - "down" = a CONNECTION failure whose code DEFINITIVELY means the port isn't accepting
 *     (ECONNREFUSED — the process is not listening, a genuine restart). Ambiguous
 *     mid-connection errors (ECONNRESET / EPIPE / EPROTO / hang up) and network/DNS
 *     reachability failures (ENETUNREACH / EHOSTUNREACH / ENOTFOUND …) do NOT count — the
 *     server can still be listening — so they are "unknown". ECONNREFUSED is the ONLY
 *     signal that proves a cycle.
 *   - "healthy" = a same-origin 2xx carrying a real /system_stats body.
 *   - "unknown" = the server RESPONDED (so its HTTP listener is UP — NOT a process-down),
 *     just not as ComfyUI-up-and-serving-stats: ANY 5xx (a transient 500 is an app error,
 *     NOT a restart — codex false-success fix), a 3xx (redirect:"manual", so a login/SPA
 *     redirect can't certify and no auth is sent onward), a 4xx (401/403/404/429), a
 *     wrong-origin URL, or a 2xx with a non-ComfyUI / malformed body; AND our own request
 *     TIMEOUT (the port accepted the connection but was slow to answer → listening, not
 *     down). "unknown" is NOT a down and NEVER contributes to the cycle proof — so a
 *     transient 5xx / slow response can never masquerade as a restart.
 * Never throws.
 */
async function probeComfyEndpoint(base: string | null, timeoutMs: number): Promise<ProbeStatus> {
  if (!base) return "unknown";
  const url = `${base}/system_stats`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    const res = await comfyuiFetch(url, { signal: controller.signal, redirect: "manual" });
    const status = res.status;
    // A 5xx means the HTTP server ANSWERED — its listener is UP — so it is NOT proof the
    // process went down; treat it as "unknown", never "down" (a transient 500 must not
    // fake a restart cycle). Same for 3xx/4xx.
    if (status < 200 || status >= 300) return "unknown"; // 3xx/4xx/5xx = responded, not stats
    if (res.url && !sameHttpOrigin(res.url, url)) return "unknown"; // wrong origin
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return "unknown"; // 2xx but not JSON — up, but not a /system_stats we trust
    }
    return looksLikeSystemStats(body) ? "healthy" : "unknown";
  } catch (err) {
    // OUR abort = a TIMEOUT: the port accepted the connection but was slow to answer, so
    // its listener is UP (not a process-down) → "unknown", never part of a cycle proof (a
    // transiently-slow no-op server must not fake a restart).
    if (controller.signal.aborted) return "unknown";
    // A connection failure is "down" ONLY when its code DEFINITIVELY means the port isn't
    // accepting (ECONNREFUSED &c). An AMBIGUOUS mid-connection error (ECONNRESET / EPIPE /
    // EPROTO / hang up) can come from a STILL-listening server, so it is "unknown" — never
    // a down that a later 200 could turn into a phantom cycle (codex High).
    const code = connErrorCode(err);
    return code != null && PORT_NOT_LISTENING_CODES.has(code) ? "down" : "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/** Boolean healthy? wrapper over probeComfyEndpoint (redirect-safe). */
async function probeComfyHealth(base: string | null, timeoutMs: number): Promise<boolean> {
  return (await probeComfyEndpoint(base, timeoutMs)) === "healthy";
}

/** Coerce a health-probe override's boolean (true→healthy / false→down) or an explicit
 *  ProbeStatus, so tests can script recovery sequences with plain booleans. */
function normalizeProbe(v: boolean | ProbeStatus): ProbeStatus {
  if (v === true) return "healthy";
  if (v === false) return "down";
  return v;
}

interface DeclineProbeOutcome {
  /**
   * "healthy"   — the FIRST sample was healthy (a clean decline; no recheck).
   * "recovered" — an early sample was a proven down but a LATER sample came
   *               back healthy inside the window (a genuine restart's down
   *               window — NEVER a lost server, codex gate).
   * "down"      — no healthy sample AND the LAST sample taken within the
   *               window was a proven down AND the FULL window ran its
   *               course (the deadline did not truncate it — a truncated
   *               observation can't prove permanence, codex gate r3). Only
   *               this may be reported as a loss — a single refused sample,
   *               or a shortened window, never suffices.
   * "ambiguous" — anything else (no healthy sample, last sample not a proven
   *               down, or a truncated window) — the plain cancel line,
   *               never alarmist.
   */
  status: "healthy" | "recovered" | "down" | "ambiguous";
  attempts: number;
  waited_ms: number;
}

/**
 * The #742 decline-path recheck: poll `base` over a short, bounded window
 * (clamped to `deadline`) so a server that is merely mid-restart is not
 * falsely declared lost on a single ECONNREFUSED. Samples immediately, then
 * sleeps intervalMs between samples — "still refused at the END of the
 * window" is the only down verdict, and ONLY when the full window ran: a
 * deadline that truncates the window downgrades the verdict to "ambiguous"
 * regardless of the samples taken (r3). The deadline is HARD (codex gate
 * r2): no awaited probe may START once the remaining budget is exhausted —
 * the loop stops and the verdict falls to the last known state (or
 * "ambiguous" when nothing was sampled). Never throws.
 */
async function probeDeclineRecovery(
  base: string | null,
  windowMs: number,
  intervalMs: number,
  probeTimeoutMs: number,
  deadline: number,
): Promise<DeclineProbeOutcome> {
  const start = Date.now();
  const windowEnd = start + Math.max(1, windowMs);
  const end = Math.min(windowEnd, deadline);
  // r3: a window the deadline cuts short can never prove permanence — DOWN
  // requires the FULL recheck window to have run its course.
  const truncated = end < windowEnd;
  const probe = healthProbeOverride ?? probeComfyEndpoint;
  let attempts = 0;
  let sawDown = false;
  let last: ProbeStatus = "unknown";
  for (;;) {
    // HARD deadline: NEVER begin an awaited probe with an exhausted remainder
    // (clamping an expired remainder to a 1ms timeout would still start — and
    // await — a probe PAST the deadline, defeating the guarantee).
    const remaining = end - Date.now();
    if (remaining <= 0) break;
    attempts++;
    const t = Math.min(probeTimeoutMs, remaining);
    let status: ProbeStatus = "unknown";
    try {
      status = normalizeProbe(await probe(base, t));
    } catch {
      status = "unknown";
    }
    if (status === "healthy") {
      return {
        status: sawDown ? "recovered" : "healthy",
        attempts,
        waited_ms: Date.now() - start,
      };
    }
    if (status === "down") sawDown = true;
    last = status;
    const left = end - Date.now();
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(intervalMs, left))));
  }
  return {
    status: last === "down" && !truncated ? "down" : "ambiguous",
    attempts,
    waited_ms: Date.now() - start,
  };
}

/**
 * The FIXED ComfyUI base URL to health-probe during a reboot readiness wait, or
 * null when we must fall back to the panel round-trip (as before #509). Captured by
 * the handler BEFORE it dispatches comfy_reboot and held for the whole wait.
 *
 * SECURITY (coordinator codex P1): the probe TARGET is the orchestrator's own
 * PROCESS-START local ComfyUI endpoint (getBootLocalComfyUIBaseUrl) — captured at
 * boot and IMMUTABLE. It is deliberately NOT getComfyUIBaseUrl(): that reflects the
 * mutable runtime config a panel `hello` can retarget (applyComfyuiUrl →
 * setComfyuiTarget), so a client could steer it. And it is NEVER the client-advertised
 * `hello.comfyui_url` (spoofable; comfyuiFetch would leak the configured ComfyUI auth
 * headers to an attacker-chosen origin). The tab origin is used ONLY as a gate, and the
 * gate reads the SERVER-OBSERVED handshake Origin (tabServerOrigin) — which the browser
 * sets and blocks page JS from forging — NOT the spoofable hello.comfyui_url: we
 * self-probe our OWN boot endpoint solely when the rebooted tab PROVABLY (by its
 * handshake) fronts THAT SAME instance, so a socket that merely CLAIMS the boot URL can't
 * ride an unrelated boot-instance cycle to a false certification (codex High). Null
 * (→ honest dispatched-unconfirmed) when:
 *   - cloud OR remote mode; or
 *   - the orchestrator didn't boot against a LOCAL loopback ComfyUI; or
 *   - the tab isn't SERVER-TRUSTED-local (tabIsLocal — arrived on the token-less
 *     loopback primary listener; relay/tunnel/LAN/pairing → false); or
 *   - the tab's HANDSHAKE origin is absent, ambiguous (`localhost`), or does NOT match our
 *     boot endpoint by scheme+host+port (concrete-family loopback-canonicalized) — i.e. it
 *     drives a DIFFERENT instance / family, or one we can't verify; AND, because a handshake
 *     Origin carries NO path, a boot target mounted under a basePath fails path-aware
 *     identity and is (soundly) fail-closed to dispatched-unconfirmed.
 */
/**
 * #851 — what to tell the caller about `restart_comfyui` when the panel's confirmation
 * card timed out.
 *
 * The old text recommended it unconditionally. It targets COMFYUI_URL, not the ComfyUI
 * the panel runs inside, so a reporter who followed that advice aimed a restart at a
 * different server than the one they had been working on — and got "No ComfyUI process
 * found on port 8188" while the panel was working fine on the live canvas.
 *
 * `panelBase` comes from captureRebootHealthBase(), which is a PROOF rather than a
 * comparison: null in remote/cloud mode, and whenever the tab's origin cannot be shown
 * to front the local boot instance. "Unproven" is deliberately NOT folded into
 * "different" — that would fire the warning on ordinary remote installs where the two
 * ARE the same server, trading a wrong recommendation for a wrong alarm.
 *
 * Pure, so the three-way decision is testable without a live panel.
 */
/**
 * panel#654 — did the browser tab come back after the restart, and DO WE KNOW?
 *
 * `panel_tab_reconnected` was a bare boolean, and `false` meant two unrelated
 * things:
 *
 *   - the tab was watched for a newer hello and did not come back;
 *   - **nothing was ever watched**, so there is no observation to report.
 *
 * The second is the common one and it is silent. `awaitPostRestartReachable`
 * opens with `if (before == null) return false` — immediate, nothing awaited —
 * and `before` is `bridge.tabConnectionIdentity(tabId)`, which is `undefined`
 * whenever the socket is not OPEN **at capture time** (captured BEFORE the
 * restart dispatch, so a socket still settling after a Manager install lands
 * exactly there), or the tab session id is absent, or resolveTarget throws.
 * The reporter's output — `server_ready:true` with `panel_tab_reconnected:false`
 * — is reproducible with the panel never having failed at all, which is why
 * every panel-side measurement in that thread showed healthy recovery: the
 * panel was reconnecting fine and the orchestrator never looked.
 *
 * A reader who sees `false` concludes the panel is dead and hard-refreshes the
 * browser. That is the manual step this issue is about, and on this path it may
 * have been unnecessary every time.
 *
 * THE GATE IS NOT WEAKENED. `ready` and `graph_tools_ready` are still computed
 * from the boolean, so an undetermined reconnect still withholds graph tools —
 * failing closed on capability is right, and a weaker proof would be worse. What
 * changes is that the REPLY stops asserting an observation that was never made.
 * `"unknown"` follows the shape this file already uses for exactly this
 * distinction (`stale: true | "unknown"`), rather than inventing a second field
 * that a reader could miss while still acting on the misleading boolean.
 *
 * `serverReady:false` is undetermined too, and for the same reason: the tab is
 * only watched once the server is back, so nothing was observed about it.
 */
export type TabReconnectReport = true | false | "unknown";

export function classifyTabReconnect({
  serverReady,
  baselineCaptured,
  tabBack,
}: {
  serverReady: boolean;
  baselineCaptured: boolean;
  tabBack: boolean;
}): TabReconnectReport {
  if (tabBack === true) return true; // a newer hello from the same tab was seen
  if (!serverReady) return "unknown"; // never watched — the server never came back
  return baselineCaptured ? false : "unknown";
}

/**
 * Is `restart_comfyui` aimed at the same ComfyUI this panel is on? (#851, #1233)
 *
 * Extracted from restartTimeoutFallbackAdvice for #1593, which needs the same
 * DECISION with different wording. The alternative was a second comparison
 * somewhere else, and two readers of the same evidence that can disagree is the
 * defect #851 itself was: a call that recommends another tool without checking
 * which machine that tool points at.
 *
 *  - `same`     — provably one instance. Recommending the headless tool is safe.
 *  - `different`— PROVEN two. `proven` names the panel's side. Recommending the
 *                 headless tool would aim a restart at the wrong server, which on
 *                 a shared instance is worse than doing nothing.
 *  - `unproven` — no proof either way. Recommend it, and say what was not checked.
 *
 * Nothing here is new logic; the branches and their reasons are documented at
 * their original site below and are unchanged.
 */
export function classifyRestartFallbackTarget({
  headlessBase,
  panelBase,
  observedOrigin = null,
}: {
  headlessBase: string;
  panelBase: string | null;
  observedOrigin?: string | null;
}): { kind: "same" } | { kind: "different"; proven: string } | { kind: "unproven" } {
  if (panelBase != null && sameHttpBase(headlessBase, panelBase)) return { kind: "same" };
  const dnsAmbiguous = (u: string | null) => {
    if (!u) return false;
    try {
      return new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, "") === "localhost";
    } catch {
      return false;
    }
  };
  const originMismatch =
    observedOrigin != null &&
    !dnsAmbiguous(observedOrigin) &&
    !dnsAmbiguous(headlessBase) &&
    !sameHttpOrigin(headlessBase, observedOrigin)
      ? observedOrigin
      : null;
  const proven = panelBase ?? originMismatch;
  return proven != null ? { kind: "different", proven } : { kind: "unproven" };
}

export function restartTimeoutFallbackAdvice({
  headlessBase,
  panelBase,
  observedOrigin = null,
}: {
  headlessBase: string;
  panelBase: string | null;
  /**
   * #1233 — the tab's SERVER-OBSERVED handshake Origin, read directly rather than
   * through captureRebootHealthBase's proof.
   *
   * That proof answers "is this provably the boot instance", so it collapses a
   * CONFIRMED MISMATCH into the same `null` as an absent or unprovable origin — and the
   * confirmed mismatch is exactly the case panel#851 was filed about (a tab fronting a
   * second local ComfyUI on another port). The evidence was computed and then discarded.
   * Passing it separately lets a confirmed mismatch reach the strong warning without
   * loosening the proof, which is correctly strict for its own purpose.
   */
  observedOrigin?: string | null;
}): string {
  // The DECISION lives in classifyRestartFallbackTarget (above) so #1593's refusal
  // reaches the same verdict rather than re-deriving it. The prose below, and the
  // reasoning attached to each branch, is unchanged.
  const verdict = classifyRestartFallbackTarget({ headlessBase, panelBase, observedOrigin });
  if (verdict.kind === "same") {
    return "or use restart_comfyui to restart the server directly without a panel card.";
  }
  // Proven different: either the proof resolved a base that differs, or the observed
  // origin — which the browser sets and page JS cannot forge — differs outright.
  // ORIGIN-only compare for the raw Origin, deliberately. `tabServerOrigin` is pathless
  // (scheme+host+port — the browser sends no path on a WS upgrade), while `headlessBase`
  // may carry a basePath mount such as :8188/comfy. A path-AWARE compare therefore reads
  // a correctly-mounted install as a mismatch and fires the strong warning at a server
  // that IS the right one — the cry-wolf failure this branch exists to avoid, which is
  // how it was found. A pathless Origin can prove a different host:port; it cannot prove
  // a different path, so it is only ever used for the claim it can actually support.
  // (captureRebootHealthBase fails closed on the same ambiguity for the same reason.)
  // #1233 (codex) — a DNS-ambiguous `localhost` on EITHER side is NOT proof of a
  // different server. loopbackFamily() deliberately excludes it (a coordinator P0: it
  // can resolve to either family, or to something else entirely), so `localhost:8188`
  // vs `127.0.0.1:8188` canonicalizes unequal and would fire the strong warning at what
  // is very likely the same instance. Absence of proof is not proof of difference, so
  // an ambiguous host degrades to UNPROVEN — the same direction captureRebootHealthBase
  // takes for the same input.
  if (verdict.kind === "different") {
    return (
      `Do NOT reach for restart_comfyui here without checking: it targets ${headlessBase}, ` +
      `while this panel is running inside ${verdict.proven}. Restarting the first would hit a ` +
      "different server than the one you have been working on. That may find nothing there " +
      "at all — or it may SUCCEED and take down a ComfyUI you did not mean to touch, which " +
      "on a shared instance is the worse outcome."
    );
  }
  return (
    `or use restart_comfyui, which restarts ${headlessBase} directly without a panel ` +
    "card — check that this is the same ComfyUI you have been working on, since I " +
    "could not confirm which one this panel is running inside."
  );
}

/**
 * #1593 — WHAT TO TELL A CALLER WHOSE PANEL RESTART WAS REFUSED.
 *
 * The #814 refusal ends "USE restart_comfyui INSTEAD", unconditionally. #851 is
 * the record of why an unconditional recommendation is a defect: `restart_comfyui`
 * targets COMFYUI_URL, not the ComfyUI the panel is running inside, and a reporter
 * who followed exactly that advice aimed a restart at a different machine.
 *
 * #851 fixed the branch it was filed against — the confirmation-card timeout — and
 * that fix has been sitting next door ever since, never consulted here. This is
 * the same evidence reaching the branch a user is far more likely to hit, because
 * the refusal fires whenever the panel's instance cannot be accounted for, which is
 * precisely when the two addresses are most likely to differ.
 *
 * The three answers are not cosmetic variations:
 *
 *   different  — the handoff is PROVEN bad, and the old text recommended it anyway.
 *                This is the case that matters: on a shared instance, aiming a
 *                restart at the wrong server is worse than doing nothing.
 *   unproven   — recommend it, and NAME what was not established, rather than
 *                implying a check that did not happen.
 *   same       — NOT REACHABLE FROM EITHER REFUSAL, and deliberately kept anyway.
 *                Both call sites are guarded by `!bound`, and `bound` is the same
 *                predicate as this verdict (panelBase != null && sameHttpBase(...)),
 *                so a refusal that fires has already excluded `same`. It is not a
 *                user-visible branch and must not be described as one. It stays
 *                because this function is TOTAL over the classifier's three
 *                verdicts: a future caller whose boundness test is not that exact
 *                predicate would otherwise fall through to the "unproven" text and
 *                claim a check failed that in fact succeeded. A tripwire in this
 *                branch is not hit by any of the handler-driven tests.
 *
 * Both addresses are named in every branch. The refusal previously named neither,
 * so the reader could not tell which two things had failed to be shown equal —
 * #1593's reporter had to paraphrase the address back to us.
 */
export function restartRefusalHandoffAdvice(args: {
  headlessBase: string;
  panelBase: string | null;
  observedOrigin?: string | null;
}): string {
  const verdict = classifyRestartFallbackTarget(args);
  if (verdict.kind === "same") {
    return (
      `USE restart_comfyui INSTEAD: it is not tied to a browser tab — it acts on ` +
      `${args.headlessBase}, which this panel is PROVABLY on, and which it CAN identify and ` +
      `check before stopping. That handoff is verified here, not assumed.`
    );
  }
  if (verdict.kind === "different") {
    return (
      `Do NOT reach for restart_comfyui here: it targets ${args.headlessBase}, while this ` +
      `panel is running inside ${verdict.proven} — a DIFFERENT server, so it would restart ` +
      `something you have not been working on. That may find nothing there at all, or it may ` +
      `SUCCEED and take down a ComfyUI you did not mean to touch. Restart this one from ` +
      `whatever launches it (its own launcher, the Desktop app, or your terminal).`
    );
  }
  return (
    `USE restart_comfyui INSTEAD: unlike this panel-scoped restart, it is not tied to a ` +
    `browser tab — it acts on the ComfyUI this server is configured for ` +
    `(${args.headlessBase}), which it CAN identify and check before stopping. I could NOT ` +
    `confirm that this is the same ComfyUI this panel is running inside, so check that ` +
    `before you run it. Or restart ComfyUI from whatever launches it (its own launcher, ` +
    `the Desktop app, or your terminal).`
  );
}

/**
 * Node definitions from the ComfyUI the PANEL is connected to (#1359 / #1006).
 *
 * The panel has served these since 0.13.0 and the orchestrator never asked. Everything
 * that pairs a panel-captured graph with definitions was reading the graph from the tab
 * and the schema from COMFYUI_URL — one machine locally, two for a remote panel, and no
 * way at all to convert a live canvas in a tunnel or loopback-only topology, where the
 * browser is the only thing that can reach that ComfyUI.
 *
 * FAIL CLOSED, DELIBERATELY, AND ALL THE WAY THROUGH. Every failure here returns a
 * message instead of falling back to `getObjectInfo()`. A fallback is the tempting move
 * and it is the dangerous one: both hosts can answer, and if they disagree the caller
 * gets a confident workflow converted against the wrong ComfyUI's schema — wrong widget
 * order, wrong input names, silently. That is worse than the ECONNREFUSED this issue was
 * filed about, which at least announced itself. The panel makes the same choice on its
 * side and says so in its own comment.
 *
 * An OLD PANEL is handled upstream and authoritatively: BRIDGE_CMD_MIN_PANEL_VERSION
 * carries `graph_get_object_info: "0.13.0"`, so a panel predating the command is refused
 * by the version gate with the version it needs — rather than answering the raw
 * `Unknown command "graph_get_object_info"`, which reads like a broken ComfyUI.
 */
async function panelObjectInfo(
  ctx: PanelToolCtx,
  /** The node types on the canvas being converted, so the reply can be judged against the
   *  graph it is supposed to define rather than against its own shape. */
  neededTypes: readonly string[] = [],
): Promise<{ ok: true; objectInfo: ObjectInfo } | { ok: false; message: string }> {
  let reply: unknown;
  try {
    // NO `if_none_match`, DELIBERATELY, EVEN THOUGH THE PAYLOAD IS LARGE.
    //
    // The panel offers a fingerprint cache and this caller declines it. Its fingerprint is
    // computed over the SORTED TYPE NAMES and nothing else (object-info-fingerprint.js), so
    // `unchanged: true` establishes only that the same node types exist. `convertUiToApi`
    // maps `widgets_values` POSITIONALLY onto each def's declared input order — so a
    // renamed widget, a reordered input, or an edited combo list changes the conversion
    // while leaving the type set, and therefore the fingerprint, identical.
    //
    // Reusing a cached map on `unchanged` would convert this canvas against a schema that
    // has since moved and return a confidently wrong workflow — the same failure this whole
    // change exists to prevent, bought back for a saved download. The panel's own reply
    // says as much: "That does not establish that individual definitions are identical …
    // Re-read without if_none_match if you need those."
    //
    // So the cost is accepted: a strip is user-initiated and infrequent, and correctness
    // here is worth more than the transfer.
    //
    // The panel fetches a full /object_info here — megabytes on a large install — so it
    // needs the bounded refresh budget, not the default ack. A false timeout would read as
    // "the panel cannot serve definitions" for a panel that served them.
    reply = await ctx.bridge.send(
      { cmd: "graph_get_object_info" },
      { tabId: ctx.tabId, timeoutMs: OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS },
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message:
        `Could not read node definitions from the panel's own ComfyUI: ${raw}

` +
        `The live canvas is converted using definitions from the ComfyUI the PANEL is ` +
        `connected to, not from COMFYUI_URL — those are different machines whenever the ` +
        `panel is remote, and only the browser can reach a tunnelled or loopback-only host. ` +
        `Or pass an explicit \`pack\`/\`path\`/\`graph\` source, which is read from ` +
        `COMFYUI_URL by design.

No fallback to COMFYUI_URL is attempted on purpose ` +
        `(#1359): both hosts can answer, and converting this canvas against a different ` +
        `ComfyUI's schema would return a confidently wrong workflow instead of an error.`,
    };
  }

  const r = (reply ?? {}) as {
    ok?: boolean;
    served_by?: string;
    detail?: string;
    object_info?: ObjectInfo;
  };
  if (r.ok === false) {
    return {
      ok: false,
      message:
        `The panel could not obtain node definitions from its own ComfyUI` +
        (r.served_by ? ` (${r.served_by})` : "") +
        `. ${r.detail ?? ""}

The conversion is refused rather than retried against ` +
        `COMFYUI_URL, which would convert this canvas against a different server's schema.`,
    };
  }
  if (!r.object_info || typeof r.object_info !== "object") {
    // `unchanged: true` lands here too, and that is correct: this caller sends no
    // if_none_match, so a payload-free reply means the contract was not met.
    return {
      ok: false,
      message:
        `The panel replied without node definitions` +
        (r.served_by ? ` (it reported serving from ${r.served_by})` : "") +
        `. Nothing was converted — a partial or absent schema produces a wrong workflow, ` +
        `so this refuses instead of guessing.`,
    };
  }
  // AN EMPTY MAP IS NOT A SCHEMA, and accepting one was the hole in the first version of
  // this "fail closed" path. `{ok: true, object_info: {}}` passed every check above, and
  // convertUiToApi SKIPS every node whose type it cannot find — so the caller got a
  // successful reply containing an empty or gutted workflow, with no error anywhere. A
  // silent wrong answer, which is the outcome this whole change exists to prevent, reached
  // through the success branch instead of the failure one.
  //
  // A running ComfyUI always defines core nodes, so zero entries cannot be a true schema;
  // it is a regressed panel, a proxy rewriting the body, or an error page. Nothing weaker
  // is asserted here — a map that is merely MISSING some of this graph's types is a real
  // and legitimate case (an uninstalled custom node), and convertUiToApi already reports
  // those as warnings rather than pretending they converted.
  if (Object.keys(r.object_info).length === 0) {
    return {
      ok: false,
      message:
        `The panel returned an EMPTY node-definition map` +
        (r.served_by ? ` from ${r.served_by}` : "") +
        `. A running ComfyUI always defines its core nodes, so this is a regressed panel, a ` +
        `proxy rewriting the response, or an error page — not a real schema. Converting ` +
        `against it would silently drop every node and hand back an empty workflow that ` +
        `looks like a success, so nothing was converted.`,
    };
  }
  // …and "non-empty" is not the same as "a schema" (codex, round 2). A proxy or a backend
  // that answers 200 with `{"error": "..."}` produces a map with ONE key, which sailed
  // through a zero-length check and was handed to the converter — which then skips every
  // node it cannot find and returns a successful, empty workflow. The same silent loss,
  // one key up from the case I had just fixed.
  //
  // So the test is STRUCTURAL: at least one entry that actually looks like a node
  // definition (an object carrying `input` or `output`, which every real /object_info entry
  // does). Deliberately not "every entry" — a single malformed record among thousands is a
  // pack's problem and the converter reports it per node, whereas requiring perfection here
  // would refuse a working install over one bad custom node.
  //
  // AND THE TEST HAS TO BE ABOUT THIS GRAPH (codex, round 3). "at least one entry that
  // looks like a definition" is satisfied by a single unrelated record — `{meta: {input:
  // {}}}` passes — while none of the types this canvas actually uses are present, and the
  // converter then skips every node and returns the same empty workflow. A structural
  // decoy is still a decoy.
  //
  // So the question asked is the one that matters for a conversion: does this map define
  // ANY of the node types on the canvas? Zero coverage of a non-empty graph is not a
  // schema for it, whatever else the payload contains.
  const looksLikeNodeDef = (v: unknown): boolean =>
    !!v && typeof v === "object" && ("input" in (v as object) || "output" in (v as object));
  if (!Object.values(r.object_info).some(looksLikeNodeDef)) {
    return {
      ok: false,
      message:
        `The panel returned something that is not a node-definition map` +
        (r.served_by ? ` from ${r.served_by}` : "") +
        ` — ${Object.keys(r.object_info).length} key(s), none of which look like a node ` +
        `definition. That is characteristic of a proxy or backend answering 200 with an ` +
        `error body. Converting against it would silently drop every node and hand back an ` +
        `empty workflow that reads as success, so nothing was converted.`,
    };
  }
  // ZERO COVERAGE OF THIS GRAPH is the decisive test, and the one a structural check
  // cannot make on its own. A payload can be well-formed, non-empty, and about something
  // else entirely — at which point the converter skips every node and returns an empty
  // workflow that reads as a success.
  //
  // Only a total miss refuses. PARTIAL coverage converts and warns, and that is not a
  // judgement call — MEASURED against this machine's live /object_info and three real pack
  // workflows:
  //
  //   anima              52 types, 36 covered, 16 missing
  //   anima-img2img      39 types, 33 covered,  6 missing
  //   krea2-identity     14 types, 13 covered,  1 missing
  //
  // Every real workflow has misses, and all of them are legitimate: frontend-only virtual
  // nodes (Note, GetNode, SetNode, "Label (rgthree)"), UUID-typed SUBGRAPH nodes, and
  // uninstalled packs. So "refuse if ANY type is missing" would refuse ALL THREE — the
  // over-broad direction is not hypothetical here, it is the default outcome. Zero coverage
  // never occurred, which is what makes it a usable signal for "this payload is not about
  // this canvas".
  //
  // That measurement also settles the direction that would have been catastrophic:
  // `collectNodeTypes` does return the same strings that appear as /object_info KEYS. If it
  // did not, `t in object_info` would always be false and this would refuse EVERY
  // live-canvas strip.
  if (neededTypes.length > 0) {
    const covered = neededTypes.filter((t) => t in (r.object_info as Record<string, unknown>));
    if (covered.length === 0) {
      return {
        ok: false,
        message:
          `The panel returned node definitions that do not describe this canvas` +
          (r.served_by ? ` (served from ${r.served_by})` : "") +
          `: none of its ${neededTypes.length} node type(s) — e.g. ${neededTypes.slice(0, 3).join(", ")} — ` +
          `appear among the ${Object.keys(r.object_info).length} definition(s) returned. ` +
          `Converting against it would drop every node and hand back an empty workflow that ` +
          `reads as success, so nothing was converted.`,
      };
    }
  }
  return { ok: true, objectInfo: r.object_info };
}

/**
 * #1359 — an /object_info failure that names WHICH host it asked.
 *
 * ONLY pack/path/inline sources reach this now. The live-canvas branch it used to carry —
 * "THE GRAPH AND ITS NODE DEFINITIONS CAME FROM DIFFERENT PLACES", with a WORKAROUND
 * telling the user to repoint COMFYUI_URL — described a split that no longer exists: the
 * live canvas takes its definitions from the panel that supplied the graph. That message
 * was the best available answer while the split stood, and keeping it would now be a
 * confident explanation of a situation the code cannot produce.
 *
 * For a pack/path/inline source COMFYUI_URL genuinely IS the right authority, so the bare
 * failure is already about the host the caller asked for. Say only what is true.
 */
function objectInfoHostMismatchMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const configured = getComfyUIBaseUrl();
  return `${raw}

Node definitions are read from COMFYUI_URL (${configured}) for a pack/path/inline source. That host did not answer /object_info.`;
}
function captureRebootHealthBase(ctx: PanelToolCtx): string | null {
  if (isCloudMode() || isRemoteMode()) return null;
  const bootBase = getBootLocalComfyUIBaseUrl(); // server-authorized, hello-immutable
  if (!bootBase || !isLoopbackOrigin(bootBase)) return null;
  const base = bootBase.replace(/\/+$/, "");
  // Server-trusted provenance: the tab arrived on the token-less loopback listener.
  if (ctx.bridge?.tabIsLocal?.(ctx.tabId) !== true) return null;
  // And the rebooted tab must provably front THAT SAME boot instance. Use the SERVER-
  // OBSERVED handshake Origin (tabServerOrigin) — the browser sets it on the WS upgrade
  // and blocks page JS from forging it — NOT the spoofable client hello.comfyui_url
  // (tabOrigin): a non-Comfy socket on the host could otherwise CLAIM the boot URL, ack
  // comfy_reboot without rebooting, and ride an unrelated boot-instance cycle to a false
  // ready:true (codex High). A handshake Origin proves only scheme+host+port (it carries
  // NO path), so we compare it path-AWARE (sameHttpBase) against the boot base: when the
  // boot target is mounted under a basePath (e.g. …:8188/comfy) the pathless Origin cannot
  // prove the tab fronts THAT mount vs another instance at the same host:port, so we FAIL
  // CLOSED to the honest dispatched-unconfirmed result rather than certify unsoundly (codex
  // P1). The common pathless boot base matches an equal Origin and certifies. Loopback
  // identity canonicalizes only CONCRETE literals by family (127.0.0.1 ≡ a 0.0.0.0 bind;
  // ::1 ≡ a :: bind) — a DNS-ambiguous `localhost` on EITHER side yields no family
  // (loopbackFamily → null), so it never matches a concrete literal and this returns null
  // (coordinator P0). A different instance / family / path / absent Origin → null too.
  const origin = ctx.bridge?.tabServerOrigin?.(ctx.tabId);
  if (!sameHttpBase(origin, base)) return null;
  // Return a CONNECTABLE probe URL bound to the SAME concrete family identity matched
  // above: a wildcard-bound (0.0.0.0/::) local ComfyUI is reachable on loopback, so probe
  // the family literal at that port (127.0.0.1 / [::1]). The probe (and the auth headers
  // it carries) can therefore never cross to a different-family instance.
  return loopbackProbeUrl(base);
}

/**
 * #1671 — the configured LOCAL boot instance, when that is a known loopback
 * process this orchestrator can account for without a live panel tab.
 *
 * `captureRebootHealthBase` requires a live tab handshake. After a crash that
 * takes the panel bridge offline that proof is gone — the tab is the component
 * that disappeared. The configured boot URL is still known, and it is the same
 * target `restart_comfyui` would act on. Returning it is NOT a claim that the
 * vanished tab fronted this instance; callers must still refuse a proven
 * mismatch (see offlineRestartHealthBase).
 */
function configuredBootRestartBase(): string | null {
  if (isCloudMode() || isRemoteMode()) return null;
  const bootBase = getBootLocalComfyUIBaseUrl();
  if (!bootBase || !isLoopbackOrigin(bootBase)) return null;
  const base = bootBase.replace(/\/+$/, "");
  if (!sameHttpBase(getComfyUIBaseUrl(), base)) return null;
  return loopbackProbeUrl(base);
}

/**
 * #1671 — which base, if any, a panel-offline crash recovery may restart.
 *
 * Prefer a still-provable tab binding. If the tab is gone, fall back to the
 * configured boot instance UNLESS the last-known handshake Origin proves the
 * panel was on a DIFFERENT server (#851/#1593: never restart the wrong one).
 */
function offlineRestartHealthBase(ctx: PanelToolCtx): string | null {
  const bound = captureRebootHealthBase(ctx);
  if (bound != null && sameHttpBase(getComfyUIBaseUrl(), bound)) return bound;
  const observed = ctx.bridge?.tabServerOrigin?.(ctx.tabId) ?? null;
  const verdict = classifyRestartFallbackTarget({
    headlessBase: getComfyUIBaseUrl(),
    panelBase: bound,
    observedOrigin: observed,
  });
  if (verdict.kind === "different") return null;
  return configuredBootRestartBase();
}

let healthProbeOverride:
  | ((base: string | null, timeoutMs: number) => Promise<boolean | ProbeStatus>)
  | null = null;

/** Test injection for the #742 refuse-safe restart preflight (the real one is
 *  preflightLocalRestart in process-control). null → the live preflight. */
let localRestartPreflightOverride:
  | (() => Promise<{
      ok: boolean;
      reason?: string;
      observedArgv?: string[];
      isDesktopApp?: boolean;
      note?: string;
    }>)
  | null = null;

/** Test injection for the #742 decline-probe recheck window, so tests don't
 *  wait the real ~6s. null → the DECLINE_PROBE_* constants. */
let declineProbeTimingOverride: {
  windowMs: number;
  intervalMs: number;
  probeTimeoutMs: number;
} | null = null;

// #742 r5: restart-dispatch tokens held PER SESSION. Each MCP session gets its
// own PanelToolCtx (one per connection — see the session factory in
// panel-mcp-http), so keying by the ctx object scopes a dispatch record to the
// session that dispatched it: session A's failed restart can never ground
// causation for session B's decline, and A's recovery clears only A's record.
// WeakMap → entries die with their session's ctx.
const sessionRestartDispatchTokens = new WeakMap<object, string>();

/** Stamp a restart dispatch and hold its token on THIS session (replacing any
 *  record the session previously held — a session has at most one live one).
 *  Returns the held token so clears can be CLEAR-IF-SAME (r15). */
function stampSessionRestartDispatch(ctx: PanelToolCtx, base: string | null): string {
  const prev = sessionRestartDispatchTokens.get(ctx);
  if (prev) clearRestartDispatch(prev);
  const token = recordRestartDispatch(base);
  sessionRestartDispatchTokens.set(ctx, token);
  return token;
}

/** The dispatch token THIS session currently holds, or undefined. */
function sessionRestartDispatchToken(ctx: PanelToolCtx): string | undefined {
  return sessionRestartDispatchTokens.get(ctx);
}

/** The restart-dispatch record THIS session holds, or null. */
function sessionRestartDispatch(
  ctx: PanelToolCtx,
): { at: number; base: string | null } | null {
  const held = sessionRestartDispatchToken(ctx);
  return held ? getRestartDispatchRecord(held) : null;
}

/** Clear ONLY when the session STILL holds `token` (r15): a newer dispatch
 *  that landed since `token` was validated keeps its record — a
 *  read-current-then-clear would evict the newer dispatch's record and make a
 *  later persistent DOWN falsely report "no restart was dispatched". */
function clearSessionRestartDispatchIfSame(ctx: PanelToolCtx, token: string): void {
  if (sessionRestartDispatchTokens.get(ctx) !== token) return;
  sessionRestartDispatchTokens.delete(ctx);
  clearRestartDispatch(token);
}

/**
 * The concurrent-observation gate shared between the reboot handler and observeRecovery.
 * It separates PROBING (which starts concurrently with the dispatch so a FAST reboot whose
 * down→up happens entirely inside the ack/drop/timeout window is still captured) from
 * COUNTING (which is admitted only from the POST-write instant, so a pre-dispatch sample
 * can never contribute to the down→up cycle) — coordinator design.
 */
interface DispatchObservationGate {
  /** Flipped true SYNCHRONOUSLY the instant AFTER the reboot command is written to the
   *  socket (ctx.bridge.send()'s executor writes synchronously). The observer neither
   *  probes nor counts before this, so no sample taken before the command was dispatched
   *  can mark the endpoint "down" (coordinator: "don't count pre-dispatch downs"). */
  dispatched: boolean;
  /** The wall-clock instant `dispatched` flipped (∞ until then). A probe SAMPLE counts
   *  toward the down→up cycle only if it was taken at/after this instant — an explicit
   *  post-write COUNTING gate (the observer also structurally defers its first probe until
   *  dispatched, so both agree). */
  dispatchedAt: number;
  /** Flipped true to ABORT observation — a PRE-write send failure (nothing transmitted) or
   *  a non-accepted refusal. The observer stops promptly and NOTHING certifies. */
  cancelled: boolean;
  /** Mutable proof deadline. Starts at the whole-handler cap so probing spans the (possibly
   *  slow) ack window; tightened to (ack-completion + budget) once the dispatch outcome is
   *  known, so a slow ack does not eat the readiness budget. */
  deadline: number;
  /** A NOTIFICATION that resolves the microtask AFTER the socket write. The observer AWAITS
   *  this (rather than polling on a timer) so its FIRST probe fires the instant the command
   *  is dispatched — NO leading timer window in which a sub-millisecond down→up could be
   *  missed (codex). Always resolved by the handler right after ctx.bridge.send() returns,
   *  on EVERY path, so the observer never hangs. */
  waitDispatched: Promise<void>;
}

interface ObserveRecoveryOpts {
  /** The FIXED boot /system_stats base to probe (captured before dispatch, bound to the
   *  exact host FAMILY the reboot was dispatched to). Must be non-null — the caller returns
   *  the honest dispatched-unconfirmed result when there is no probeable boot endpoint. */
  healthBase: string;
  /** When present, run in CONCURRENT mode (started before/with the dispatch): defer probing
   *  until gate.dispatched (post-write), honor gate.cancelled, and use gate.deadline as the
   *  live deadline. Absent → legacy mode (started AFTER the restart's synchronous work;
   *  probe immediately against the fixed `deadline`). */
  gate?: DispatchObservationGate;
}

/**
 * Observe the boot endpoint's recovery AFTER a reboot was dispatched, and certify ONLY on
 * an OBSERVED DOWN→UP cycle. Acceptance (dispatch confirmed/dropped) is the guard against
 * a NO-OP, but we deliberately do NOT certify a lone healthy endpoint after a settle:
 * the panel emits rebooting:true even when it merely INFERS a reboot from a dropped fetch
 * (its comfy_reboot handler's catch branch), so a confirmed ack is NOT a guarantee that a
 * real Manager reboot was accepted — treat it like the ambiguous DROP and require the
 * endpoint to actually go DOWN then come back (coordinator: panel invariant unverifiable).
 *   - ANY single "down" (an ECONNREFUSED — the port stopped listening) marks it going down;
 *     the next "healthy" → observed-cycle.
 *   - Never healthy after an observed down, OR never a down at all → couldn't-confirm.
 *
 * CONCURRENT mode (a `gate` is supplied): the caller starts this BEFORE awaiting the full
 * dispatch, so probes are already sampling the endpoint DURING the ack/drop/timeout window
 * — catching a FAST reboot whose down→up completes before the ack returns (the #509 fast-
 * reboot false-timeout). PROBE-FIRST-THEN-SLEEP: the observer AWAITS the post-write
 * notification (gate.waitDispatched — no timer poll, so no leading window in which a
 * sub-millisecond cycle could be missed), then takes its FIRST probe IMMEDIATELY at the
 * post-write dispatch instant (no leading interval sleep), sleeping intervalMs only BETWEEN
 * subsequent probes. COUNTING stays post-write: a sample
 * marks the cycle only if taken at/after gate.dispatchedAt, so a pre-dispatch down never
 * contributes. gate.deadline is the live deadline (tightened to ack-completion + budget so a
 * slow ack doesn't eat it); gate.cancelled aborts.
 * LEGACY mode (no gate): started AFTER the restart's synchronous work; probe immediately
 * against the fixed `deadline`.
 */
async function observeRecovery(
  timing: PanelRebootTiming,
  deadline: number,
  opts: ObserveRecoveryOpts,
): Promise<PanelReadyResult> {
  const start = Date.now();
  const gate = opts.gate;
  const intervalMs = panelRebootTimingOverride
    ? Math.max(1, timing.intervalMs)
    : Math.max(50, timing.intervalMs);
  const probe = healthProbeOverride ?? probeComfyEndpoint;
  const currentDeadline = () => gate?.deadline ?? deadline;
  let sawDown = false;
  let lastStatus: ProbeStatus | undefined;
  let attempts = 0;
  for (;;) {
    if (gate?.cancelled) break;
    if (currentDeadline() - Date.now() <= 0) break;
    if (gate && !gate.dispatched) {
      // CONCURRENT mode, not yet dispatched: AWAIT the post-write NOTIFICATION (resolves the
      // microtask after the socket write) WITHOUT probing — no timer poll, so there is NO
      // leading window in which a sub-millisecond down→up could be missed (codex). The very
      // first probe then fires the instant the command is dispatched (probe-first).
      await gate.waitDispatched;
      if (gate.cancelled) break;
      // Fall through and probe immediately (a fast non-accepted outcome that resolves before
      // this observer wakes will already have set gate.cancelled above; otherwise a single
      // read of our OWN boot endpoint during the sub-ack window is the accepted benign
      // residual — see the handler's INHERENT TRADEOFF note — and is discarded on refusal).
    }
    // PROBE NOW (no leading interval sleep) — the first sample lands at the post-write
    // dispatch instant so a sub-interval down→up is caught (coordinator: probe-first).
    const sampleAt = Date.now();
    attempts++;
    const t = Math.max(1, Math.min(timing.probeTimeoutMs, currentDeadline() - Date.now()));
    let status: ProbeStatus = "unknown";
    try {
      status = normalizeProbe(await probe(opts.healthBase, t));
    } catch {
      status = "unknown";
    }
    if (gate?.cancelled) break;
    // COUNTING gate: a sample contributes to the cycle only if taken at/after the post-write
    // dispatched instant (defensive — the observer also defers its first probe to dispatch).
    if (gate == null || sampleAt >= gate.dispatchedAt) {
      lastStatus = status;
      if (status === "down") {
        sawDown = true;
      } else if (status === "healthy" && sawDown) {
        return {
          ready: true,
          waited_ms: Date.now() - start,
          attempts,
          via: "observed-cycle",
          sawDown,
          lastStatus,
        };
      }
      // "healthy" without a prior down, and "unknown", are ignored — keep looking.
    }
    // Sleep BETWEEN probes (both modes).
    const left = currentDeadline() - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }
  return { ready: false, waited_ms: Date.now() - start, attempts, sawDown, lastStatus };
}

// ---- workflow_open verify-after-timeout (#215/#319/#496/#661) --------------
// `panel_open_workflow` forwards `workflow_open` over the UI bridge and waits for
// the tab to ACK. When the target tab is BACKGROUNDED/FROZEN, or the workflow is
// already the active one, the tab can be slow to ack and the bridge surfaces a
// `did not reply to "workflow_open" within N ms` TIMEOUT — yet the switch itself
// genuinely happened (the executor ran; the ack just didn't make it back in the
// window). `workflow_list.active` is only a selector, however: after reconnect it
// can name the target whether this open ran, failed, or never arrived. Recovery is
// therefore allowed only when the panel's #514 `last_open` receipt correlates to
// this bridge request's exact rid and says that it was applied.

/**
 * True only when a ToolResult is the bridge's ACK-TIMEOUT for a command — i.e.
 * the tab never replied within the window (`did not reply to "…" within N ms`).
 * This is the ONLY error we verify-after: a GENUINE executor failure (e.g. "no
 * workflow matching …") comes back as a normal error REPLY the bridge received
 * and relayed, NOT a timeout, so it is never treated as a candidate for recovery
 * and still fails clearly. Defensive: non-error results are never a timeout.
 */
function isAckTimeout(res: ToolResult): boolean {
  if (!res?.isError) return false;
  const text = res?.content?.find((c) => c.type === "text")?.text ?? "";
  // Match the CANONICAL bridge ack-timeout SPECIFICALLY (ui-bridge.ts): a
  // `Panel tab <id> did not reply to "workflow_open" within N ms` message. Anchor
  // on the bridge preamble AND the exact command name so a merely timeout-WORDED
  // acked executor error (which the panel relays verbatim) is NOT mistaken for a
  // no-reply and thus never masked as a false "recovered" success (codex gate).
  //
  // #803 — the tab-id segment is `.+?` (LAZY, bounded by the fixed 19-char
  // ` did not reply to "` that follows), NOT `\S+`. The bridge now emits the FULL
  // routing tab id instead of an 8-char slice, and a routing id is `wf:<path>` — a
  // saved workflow whose filename contains a SPACE ("Untitled 2026-08-04 06-15-58.json",
  // ComfyUI's own default name) would make `\S+` fail to match. The whole
  // verify-after-timeout recovery would then silently stop firing for exactly the
  // workflows these reports were filed against: a guard quietly answering "no"
  // because it could not parse, which is the very fold this cluster is about.
  // Mirrors isReplyTimeoutError's identical `.+?` segmentation.
  //
  // START-ANCHORED (codex gate). The old form matched the phrase ANYWHERE, so an
  // ACKED executor error that merely EMBEDS or WRAPS it — `relay failed: Panel tab
  // … did not reply to "workflow_open" …` — was treated as a no-reply and sent
  // down the receipt-recovery path, where it could be reported as a "recovered"
  // success. Only the bridge's own message starts with the preamble; ctx.call
  // surfaces a reply timeout as exactly `Error: ` + that message (and may APPEND a
  // retry token), so the optional prefix plus a start anchor is the tight form
  // that still admits every real ack timeout. The tail stays open on purpose —
  // anchoring the end would reject the appended-token variant and silently switch
  // the recovery off, which is the same failure in the opposite direction.
  //
  // Matched against the RAW text — no `.trim()` (codex gate, and the same call
  // isReplyTimeoutError documents). The bridge message never carries leading
  // whitespace, so trimming buys nothing and only lets a whitespace/newline-
  // prefixed acked error reach the receipt-recovery path.
  return /^(?:Error: )?Panel tab .+? did not reply to "workflow_open" within \d+\s*ms/i.test(text);
}

/**
 * #1468 — carry the bridge's AUTHORITATIVE reply-timeout marker across the
 * error → ToolResult conversion in `ctx.call`.
 *
 * Two codex rounds rejected deciding this from message TEXT, and both were right.
 * `isAckTimeout`'s looseness is safe for `workflow_open` because a match there
 * only opens a door — the panel's #514 receipt, correlated to the request's exact
 * rid, is what actually decides. A caller with no receipt has the predicate doing
 * all the work: match plus one root-looking read promotes an error to success. No
 * amount of regex tightening fixes that, because ACKED panel errors arrive as
 * ARBITRARY `msg.error` text (ui-bridge) and `ctx.call` flattens both kinds into
 * the same text-only result — so any sentence the bridge can write, a panel error
 * can also contain.
 *
 * `markReplyTimeout`/`isReplyTimeoutTagged` already answer the question exactly,
 * on the error object, at the only place that KNOWS: the bridge. The information
 * was simply being dropped in translation. This preserves it as a non-enumerable
 * symbol so the result's JSON payload is byte-identical and nothing downstream
 * can observe it by accident.
 */
const REPLY_TIMEOUT_RESULT = Symbol("panel.replyTimeoutResult");

function carryReplyTimeoutMark(err: unknown, res: ToolResult): ToolResult {
  if (!isReplyTimeoutTagged(err)) return res;
  Object.defineProperty(res, REPLY_TIMEOUT_RESULT, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return res;
}

/** True only for a ToolResult that `ctx.call` produced from a BRIDGE-TAGGED
 *  reply timeout — the tab was reached and never answered. An acked executor
 *  error can never carry this, whatever its text says. */
function isReplyTimeoutResult(res: ToolResult): boolean {
  return res?.isError === true && (res as Record<symbol, unknown>)[REPLY_TIMEOUT_RESULT] === true;
}

/**
 * #1560 — the same translation problem, for the OTHER fact: did anything answer?
 *
 * `isReplyTimeoutResult` above identifies ONE way a command can go unanswered (the
 * bridge's own tagged reply timeout). That is not the question a caller reporting on
 * the CHANNEL is asking — a routing refusal, a dead socket and a mid-command
 * disconnect are equally "no answer", and none of them carry that tag. The complement
 * is what can be stated positively and exactly: the panel SENT a reply, which the
 * bridge marks at the single branch that receives one (`attachPanelAnswered`).
 *
 * Kept off the JSON payload as a module-private Symbol, exactly like the marker
 * above, so the result's serialisation is byte-identical and nothing downstream can
 * observe it by accident. A Symbol created here is unreachable from any wire object,
 * which is why this — unlike the string-keyed read on the Error — needs no
 * own-property dance: there is no `Object.prototype` slot an attacker or a careless
 * dependency could fill. And the read's failure direction is the safe one anyway: a
 * mark wrongly seen suppresses a note, which is how this path behaved before #1560.
 */
const PANEL_ANSWERED_RESULT = Symbol("panel.answeredResult");

function carryPanelAnsweredMark(err: unknown, res: ToolResult): ToolResult {
  if (res?.isError !== true) return res;
  if (!isPanelAnsweredError(err)) return res;
  Object.defineProperty(res, PANEL_ANSWERED_RESULT, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return res;
}

/** True only for a ToolResult `ctx.call` produced from an error the BRIDGE minted
 *  out of a received reply. A timeout, a routing refusal or a dead socket can never
 *  carry this, whatever their text says — and neither can an error from a panel too
 *  old to be marked, which is why its absence claims nothing on its own. */
function isPanelAnsweredResult(res: ToolResult): boolean {
  return res?.isError === true && (res as Record<symbol, unknown>)[PANEL_ANSWERED_RESULT] === true;
}

// ---- panel_exit_subgraph settle-after-ack-timeout (#1468) ------------------
// `graph_exit_subgraph` timed out at 15 s while a following `panel_graph_outline`
// proved the view HAD returned to root — an applied navigation reported as a
// failed one. The bound is not the cause: the panel's own receipt
// (`confirmCanvasNavigation`) budgets 25 polls × 40 ms ≈ 1 s and returns early on
// success, so 15 s already clears its worst case by 15×. What fails is the ANSWER
// getting back from a busy tab. The effect, though, is locally observable — so on
// a no-reply we ask, exactly as #1473 does for the fence, instead of handing the
// caller "may have been applied" and the homework.

/** The one decisive observation: the canvas is at the root graph. */
function exitConfirmedAtRootNote(): string {
  return (
    `CHECKED FOR YOU: the tab did not ACKNOWLEDGE the exit within the window, but a graph read ` +
    `taken immediately afterwards, on that same tab, reports the canvas at the ROOT graph — the ` +
    `state this tool exists to reach. No recovery step is needed and a retry would be wasted ` +
    `work. A missing acknowledgement is not evidence the navigation failed; here it is evidence ` +
    `the tab was too busy to answer in time. Stated precisely: what is established is WHERE THE ` +
    `CANVAS IS, not that this command is what put it there — someone navigating out on the ` +
    `canvas while the tab was unresponsive would read identically. Both leave you where you ` +
    `asked to be, so the distinction changes nothing you would do next; it is drawn because only ` +
    `one of the two was actually observed.`
  );
}

/**
 * The NON-decisive observation, stated as non-decisive. `graph_exit_subgraph`
 * pops to the IMMEDIATE PARENT, not to root (#412) — so "still inside a subgraph"
 * is equally consistent with the exit never landing and with the exit landing in
 * the parent of a NESTED subgraph. Recommending a retry on this reading would pop
 * a level the caller wanted to keep, which is the same class of harm as the false
 * failure being fixed, one step removed.
 */
function exitInconclusiveInSubgraphNote(title: string | null): string {
  const where = title ? `subgraph “${title}”` : "a subgraph";
  return (
    `CHECKED FOR YOU — and the check does NOT settle it. A graph read taken immediately after the ` +
    `missing acknowledgement reports the canvas inside ${where}. panel_exit_subgraph pops to the ` +
    `IMMEDIATE PARENT, not to the root graph, so this single observation cannot separate two ` +
    `cases: the exit never landed and you are where you started, OR the exit DID land and this is ` +
    `the parent you popped into from a nested subgraph. Settle it with a scope read ` +
    `(panel_graph_outline, or the canvas breadcrumb) before acting. If you do re-issue, use the ` +
    `retry_of token above rather than a bare repeat: a token names the original mutation and is ` +
    `answered from its ledger entry WITHOUT running the executor again (#694), whereas identical ` +
    `args with no token execute fresh — and from the second case that pops another level you may ` +
    `have wanted to keep.`
  );
}

/**
 * After an ack timeout on `graph_exit_subgraph`, take ONE scope read and report
 * what it found. Returns the untouched timeout when the read cannot answer —
 * #1473's rule: an unknown answer claims nothing in either direction, and reading
 * every probe failure as proof would invent a verdict out of a backgrounded tab.
 */
async function settleExitSubgraphAfterAckTimeout(
  ctx: PanelToolCtx,
  timedOut: ToolResult,
): Promise<ToolResult> {
  // The observation is only evidence about the tab the navigation was DISPATCHED
  // to (codex P1). `ctx.call` runs `ensureReachable` first, which silently rebinds
  // an unpinned current-mode session onto the sole remaining interactive tab when
  // the bound one has gone — the exact situation an unanswered command makes
  // likely. Without this the probe could read a DIFFERENT tab's canvas, and that
  // tab sitting at root would be reported as this navigation having landed: a
  // wrong-target success, which is worse than the false failure being fixed.
  const dispatchTab = ctx.tabId;
  // `fields:"ids", limit:1` is the cheapest shape that still carries `viewing` —
  // the panel builds that field unconditionally on every graph_query return path.
  const probe = await ctx.call({ cmd: "graph_query", fields: "ids", limit: 1 }, 8000);
  // Checked AFTER the call, because the rebind happens inside it. A moved binding
  // makes the reading inconclusive, not false — so it takes the same "claim
  // nothing" exit as an unanswerable probe.
  if (ctx.tabId !== dispatchTab) return timedOut;
  const viewing = parseToolResultJson(probe)?.viewing as
    | { scope?: unknown; title?: unknown; owner_node_id?: unknown }
    | undefined;
  const scope = typeof viewing?.scope === "string" ? viewing.scope : null;

  if (scope === "root") {
    // `at_root`, NOT `exited`. The read proves WHERE THE CANVAS IS; it cannot
    // prove this command is what put it there (the user may have navigated out on
    // the canvas while the tab was too busy to answer us). Those happen to be the
    // same actionable answer — the caller's goal state holds either way — but only
    // one of them is something the observation actually establishes, and naming
    // the stronger claim would be this issue's own defect pointed the other way.
    return ok({
      viewing,
      at_root: true,
      acknowledged: false,
      confirmed_by: "graph read after ack timeout",
      note: exitConfirmedAtRootNote(),
    });
  }
  if (scope === "subgraph") {
    const title = typeof viewing?.title === "string" && viewing.title ? viewing.title : null;
    const text = timedOut.content?.find((c) => c.type === "text")?.text ?? "";
    return {
      ...timedOut,
      content: [{ type: "text", text: `${text}\n\n${exitInconclusiveInSubgraphNote(title)}` }],
    };
  }
  return timedOut;
}

// ---- panel_free_vram: verifiable when the canvas tab is frozen (#1249) -----
// `free_vram` is a purely SERVER-SIDE operation — the panel's handler is a plain
// `POST /free` against the ComfyUI the tab fronts — yet the tool treated the
// frozen tab's ACK as the only source of truth: a reply timeout left the caller
// with "MUTATES … may have been applied" and no way to verify recovery. The
// settle below takes the path the tab was only proxying: when the tab PROVABLY
// fronts the orchestrator's local boot instance (the captureRebootHealthBase
// gate — loopback, server-trusted, handshake-origin-matched), issue /free
// DIRECTLY and read /system_stats around it.
//
// Why re-issuing is safe HERE and nowhere else on the timeout path: /free is
// IDEMPOTENT. Unloading already-unloaded models and freeing an already-empty
// cache is a no-op, so the copy the frozen tab may still execute when it wakes
// cannot double-apply — the exact hazard the bridge's "do not blind-retry"
// disclosure guards against for every other mutation does not exist for this
// one command. This is a per-command exception, argued per command; it is NOT a
// precedent for settling other mutations this way.

/** Per-request bound for the direct /free + /system_stats round-trips, so a
 *  wedged server degrades to the honest outcome-unknown instead of hanging the
 *  tool call. ComfyUI applies /free synchronously before answering, so a large
 *  unload can take seconds — 10s matches the bound probeComfyEndpoint callers
 *  already pay on this same server. */
const FREE_VRAM_DIRECT_TIMEOUT_MS = 10_000;

/** The VRAM counters of one /system_stats device entry, read when present. */
interface VramDeviceSample {
  name?: string;
  vram_total?: number;
  vram_free?: number;
}

/** GET `${base}/system_stats` and return its device VRAM counters, or null when
 *  the read cannot answer (unreachable, non-2xx, non-ComfyUI body). Never
 *  throws: an unreadable stat is "no numbers", never evidence in either
 *  direction — the POST's own status is what certifies the free. */
async function readVramDevices(
  base: string,
  timeoutMs: number,
): Promise<VramDeviceSample[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    const res = await comfyuiFetch(`${base}/system_stats`, {
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.status < 200 || res.status >= 300) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null; // 2xx but not JSON — up, but not a /system_stats we trust
    }
    if (!looksLikeSystemStats(body)) return null;
    const devices = (body as { devices?: unknown }).devices;
    if (!Array.isArray(devices)) return null;
    return devices.map((d) => {
      const dev = (d ?? {}) as Record<string, unknown>;
      const sample: VramDeviceSample = {};
      if (typeof dev.name === "string") sample.name = dev.name;
      if (typeof dev.vram_total === "number") sample.vram_total = dev.vram_total;
      if (typeof dev.vram_free === "number") sample.vram_free = dev.vram_free;
      return sample;
    });
  } catch {
    return null; // unreachable/timed out — no numbers to report
  } finally {
    clearTimeout(timer);
  }
}

interface FreeVramDirectOutcome {
  ok: boolean;
  /** Failure detail when !ok (HTTP status / transport error), already worded
   *  for the caller. Absent on success. */
  reason?: string;
  before?: VramDeviceSample[] | null;
  after?: VramDeviceSample[] | null;
}

/** Issue ComfyUI's /free DIRECTLY against a proven-local base and read the
 *  VRAM counters around it. Never throws — every failure is a value, so the
 *  settle can degrade to the honest outcome-unknown instead of masking the
 *  original timeout behind a new error. */
async function freeVramDirect(base: string): Promise<FreeVramDirectOutcome> {
  const before = await readVramDevices(base, FREE_VRAM_DIRECT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FREE_VRAM_DIRECT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await comfyuiFetch(`${base}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, reason: `POST ${base}/free answered HTTP ${res.status}` };
    }
  } catch (err) {
    const msg = controller.signal.aborted
      ? `POST ${base}/free did not answer within ${FREE_VRAM_DIRECT_TIMEOUT_MS} ms`
      : `POST ${base}/free failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(timer);
  }
  const after = await readVramDevices(base, FREE_VRAM_DIRECT_TIMEOUT_MS);
  return { ok: true, before, after };
}

/** Test injection for the direct server-side /free, so the settle can be
 *  driven without real HTTP. null restores the live path. */
let freeVramDirectOverride: ((base: string) => Promise<FreeVramDirectOutcome>) | null = null;

/**
 * After an ack timeout on `free_vram`, settle the outcome against the one
 * channel a frozen tab cannot block: the ComfyUI server itself.
 *
 * Returns the timeout UNTOUCHED in every case where nothing was verified —
 * no provable local server (remote/cloud tab, ambiguous origin, untrusted
 * socket), or a direct /free that itself failed. #1473's rule: an unknown
 * answer claims nothing in either direction, and the bridge's original
 * outcome-unknown disclosure is already the honest verdict there.
 */
async function settleFreeVramAfterAckTimeout(
  ctx: PanelToolCtx,
  timedOut: ToolResult,
): Promise<ToolResult> {
  // The same gate the restart certification uses: null unless the tab PROVABLY
  // fronts THIS orchestrator's local boot instance (loopback + server-trusted +
  // handshake-origin match). Without that proof a direct /free could aim at a
  // DIFFERENT server than the one the tab was asked to free — reporting that as
  // this command's success would be the wrong-target success the gate exists to
  // prevent, which is worse than the honest unknown being fixed.
  const base = captureRebootHealthBase(ctx);
  if (!base) return timedOut;
  const direct = await (freeVramDirectOverride ?? freeVramDirect)(base);
  if (!direct.ok) {
    // The tab never answered AND the server-side path failed. The outcome stays
    // unknown — say so, and name what was tried, without claiming either way.
    const text = timedOut.content?.find((c) => c.type === "text")?.text ?? "";
    return {
      ...timedOut,
      content: [
        {
          type: "text",
          text:
            `${text}\n\nThe server-side fallback also could not reach ComfyUI's /free ` +
            `(${direct.reason ?? "no detail"}), so whether VRAM was freed remains UNVERIFIED — ` +
            `check with get_system_stats (action:"health") once the server answers.`,
        },
      ],
    };
  }
  const statsNote =
    direct.before != null && direct.after != null
      ? "vram_before/vram_after are the server's own /system_stats counters around the free."
      : "The /system_stats read around it did not answer, so no VRAM counters are reported — the 2xx from /free is the verification, not a measured delta.";
  return ok({
    freed: true,
    unload_models: true,
    free_memory: true,
    acknowledged: false,
    verified: "server-side",
    via: `POST ${base}/free`,
    ...(direct.before != null ? { vram_before: direct.before } : {}),
    ...(direct.after != null ? { vram_after: direct.after } : {}),
    note:
      `The panel tab never acknowledged (frozen or backgrounded), so the free was issued ` +
      `DIRECTLY to the ComfyUI server this tab provably fronts — the same /free endpoint the ` +
      `panel would have called — and the server confirmed it. /free is idempotent: if the tab's ` +
      `queued copy still executes when the tab wakes, it is a no-op, so nothing was applied ` +
      `twice. ${statsNote}`,
  });
}

// ---- panel_install_node: accepted-but-never-enqueued (#1129) ---------------
// #1143 fixed the pre-queue REFUSAL (403/404 → direct clone). This is the other
// half of the same family: legacy Manager 3.x answers the install POST with
// `queued: true`, and the task never enters the queue at all. The reporter's
// follow-up read showed an idle queue with `total_count: 0` and no directory
// under custom_nodes, while this tool had already said "queued".
//
// It is the third time this repo has met the same lesson, so it is worth stating
// once: ComfyUI-Manager's acknowledgement is not a receipt. `getlist` cannot
// distinguish an unreachable registry from an empty one; a download reports done
// when the QUEUE DRAINS rather than when the transfer finishes; and here an
// accepted request is simply dropped. "Accepted" is never evidence of "happened",
// so the only honest reply is one that went and looked.
//
// NOTE the asymmetry with install_custom_node, which already verifies and clones:
// that path owns the filesystem it installs into. This one drives whatever
// ComfyUI the PANEL is bound to, which need not be this machine — so it can
// report the truth but must not quietly clone somewhere else.

/** True when the panel's reply claims the install was accepted/queued. */
function claimsQueued(reply: Record<string, unknown> | null): boolean {
  if (!reply) return false;
  return reply.queued === true || reply.pending === true;
}

/**
 * `total_count` counts EVERY task the Manager has seen, completed ones included —
 * so a fast install that already finished still leaves it ≥ 1. Zero therefore
 * means nothing was ever enqueued, which is the decisive reading and the
 * reporter's exact signature.
 *
 * Not my arithmetic: `countsFromStatus` in node-management.ts states the 3.x
 * contract outright — "total_count = done + in_progress + queued exactly" — and
 * derives pending from it. So `done_count` cannot be non-zero while total is 0.
 *
 * v4 reports `pending_count` directly and need not carry `total_count` at all, so
 * this simply never fires there. That is correct: the dropped-enqueue defect is a
 * legacy-3.x behaviour, and a shape that cannot answer must not be made to.
 *
 * ONE KNOWN WAY THIS READS ZERO AFTER A REAL INSTALL: the counters are cleared by
 * `POST /manager/queue/reset`, which this codebase itself issues from
 * manager-config.ts and workflow-deps.ts. Neither is in panel_install_node's
 * path, and the read below happens immediately after the install returns, so it
 * takes a CONCURRENT reset from another operation to land in that window.
 *
 * That residual case is the reason this only WARNS. A definite failure verdict
 * would be wrong there, and wrong in the same direction as the bug being fixed —
 * a confident claim the evidence does not support. A spurious "go and check"
 * costs one read; a spurious "it definitely failed" costs a reinstall.
 */
function queueNeverSawATask(reply: Record<string, unknown> | null): boolean {
  const status = (reply?.status ?? reply) as Record<string, unknown> | undefined;
  if (typeof status?.total_count !== "number" || status.total_count !== 0) return false;
  // PRESENT and zero, not absent-or-zero (codex P2). `panel-installer.ts`'s
  // established legacy-empty proof requires every count to be reported and exact;
  // accepting a missing field would let a payload that never described the queue
  // stand in for one that did. A `pending_count`, if this build reports one, has
  // to agree as well.
  const presentZero = (v: unknown): boolean => v === 0;
  if (!presentZero(status.done_count) || !presentZero(status.in_progress_count)) return false;
  if (status.pending_count !== undefined && !presentZero(status.pending_count)) return false;
  // IDLE TOO, not just empty (codex P1). A snapshot taken while the Manager is
  // mid-accept can read zero before its counters move, and a running worker is
  // the one state where zero means "not yet" rather than "never". The panel's own
  // queue predicate draws the same line, so this matches rather than invents one.
  // Absent/non-boolean is NOT treated as idle: unknown answers nothing.
  if (status.is_processing !== false) return false;
  // Coherent, by the 3.x contract quoted above: with total 0, both of these must
  // be 0 as well. Anything else is a shape this reasoning does not describe.
  return true;
}

/**
 * After an install the panel reported as queued, confirm it actually was.
 *
 * Two NEGATIVE observations are required before this contradicts the panel: the
 * queue never saw a task, AND the pack is absent from the installed list. Either
 * alone is too weak — a queue shape without `total_count` proves nothing, and a
 * pack missing from the list moments after enqueuing is normal, because it has
 * not been cloned yet. Together they are the reported failure exactly.
 *
 * Anything inconclusive returns the panel's own reply untouched (#1473's rule).
 */
/**
 * The panel identity a route key currently resolves to, or `undefined` when this
 * bridge cannot report one.
 *
 * `undefined` means UNKNOWN, and callers must treat it as such rather than as
 * "unchanged" (codex, final pass). Comparing two unknowns yields equality, which
 * would let a same-key takeover pass the guard while the message claims the read
 * happened "on that same panel" — a false statement produced by a guard that
 * cannot see. The real UiBridge always implements this; only lightweight or mock
 * contexts do not, and those simply do not get the warning.
 */
function panelIncarnation(ctx: PanelToolCtx, tabId: string): string | undefined {
  const b = ctx.bridge as { tabIncarnation?: (t: string) => string | undefined };
  return typeof b.tabIncarnation === "function" ? b.tabIncarnation(tabId) : undefined;
}

async function settleDroppedEnqueue(
  ctx: PanelToolCtx,
  res: ToolResult,
  dispatch: { tab: string; incarnation: string | undefined },
): Promise<ToolResult> {
  if (res.isError) return res;
  if (!claimsQueued(parseToolResultJson(res))) return res;

  // The queue is only evidence about the panel the install was DISPATCHED to
  // (codex P1 — and the same guard #1468 needed, which I did not carry across).
  // `ctx.call` runs ensureReachable first, which silently rebinds an unpinned
  // current-mode session onto the sole remaining interactive tab. A reconnect
  // between the two calls would let ANOTHER ComfyUI's empty queue be reported as
  // evidence about this install.
  // The ROUTE KEY alone is not the panel (codex P1, round 3). A `wf:` key is
  // `wf:<tabRouteId>:<path>` — it names a WORKFLOW, so it recurs, and a different
  // browser tab can take it over without `ctx.tabId` changing at all. The bridge
  // draws exactly this distinction and exposes `tabIncarnation` for it (#486), so
  // both are captured: the key AND the incarnation currently holding it.
  const queue = await ctx.call({ cmd: "nodes_queue_status" }, 15000);
  if (ctx.tabId !== dispatch.tab) return res;
  // Both captured BEFORE the install was dispatched, not here — a takeover that
  // happens DURING the install is already baked in by the time this function
  // runs, so comparing two post-install readings would always agree and the guard
  // would be decorative. Its own test caught exactly that.
  // UNKNOWN is not "unchanged": a bridge that cannot report an incarnation cannot
  // rule out a same-key takeover, so it does not get to make a claim about which
  // panel answered.
  if (dispatch.incarnation === undefined) return res;
  if (panelIncarnation(ctx, ctx.tabId) !== dispatch.incarnation) return res;
  if (queue.isError || !queueNeverSawATask(parseToolResultJson(queue))) return res;

  // NO PROVENANCE CLAIM AT ALL — deliberately, after five review rounds.
  //
  // Earlier drafts explained WHY the task was probably dropped ("the Manager
  // accepted a git URL it does not recognise") and prescribed accordingly. Every
  // round found that explanation false in some reachable state: an id-only
  // install submits no URL; a `repository` that is any non-empty string is not
  // necessarily a URL. Each fix branched on a fact the request does not reliably
  // carry, and each branch was a fresh chance to assert the wrong cause.
  //
  // What this function actually observed is the queue reading. That is worth
  // saying, needs no provenance, and cannot be wrong. The cause belongs to
  // whoever can see the install — so the message asks for the ONE check that
  // settles it and stops there. Less useful in the common case; never false.
  return appendNote(
    res,
    `WARNING — THE QUEUE DOES NOT HAVE THIS TASK. The Manager accepted the install above, but a ` +
      `read taken immediately afterwards, on that same panel, reports an IDLE queue holding no ` +
      `tasks at all (total_count, done, in_progress all 0). "queued" is its acknowledgement, not ` +
      `a receipt.\n\n` +
      `THIS IS NOT PROOF EITHER WAY. Those counters are also cleared by a queue RESET, which ` +
      `other operations in this server issue, so an install that really ran can read exactly ` +
      `like this if a reset landed in between.\n\n` +
      `SO CHECK: call panel_list_nodes and see whether the pack is actually there. Do not restart ` +
      `on the assumption it installed, and do not reinstall on the assumption it did not.\n\n` +
      `IF IT IS ABSENT: install it through the headless install_custom_node, which verifies the ` +
      `pack really landed instead of trusting the queue, and can clone a repository URL directly ` +
      `when the Manager will not take it. This tool cannot clone for you — it drives whatever ` +
      `ComfyUI the panel is bound to, which need not be this machine.`,
  );
}

/**
 * #1699 — a drained Manager queue is not apply_manifest completion when
 * custom_nodes were never submitted. Keep the panel payload parseable (do not
 * append prose after the JSON) and name the leftover entries on the object.
 */
function annotateQueueStatusWithManifestPartial(res: ToolResult): ToolResult {
  const leftover = getManifestPartialLeftover();
  if (!leftover || leftover.not_started.length === 0) return res;
  if (res.isError) return res;
  const parsed = parseToolResultJson(res);
  if (!parsed) return appendNote(res, formatQueueStatusPartialNote(leftover));
  return {
    ...res,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ...parsed,
            apply_manifest_partial: leftover,
            queue_complete_for_apply_manifest: false,
          },
          null,
          2,
        ),
      },
      ...res.content.slice(1),
    ],
  };
}

/** Parse a ctx.call ToolResult's text payload as JSON, or null if not parseable. */
function parseToolResultJson(res: ToolResult): Record<string, unknown> | null {
  if (!res || res.isError) return null;
  const text = res?.content?.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toolResultText(res: ToolResult): string {
  return res?.content?.find((c) => c.type === "text")?.text ?? "workflow_open failed";
}

/** Append a disclosure to a ToolResult's FIRST text block, preserving everything
 *  else about it — including `isError` and any non-text content. Used where the
 *  original message must reach the caller VERBATIM and we are only adding what we
 *  additionally know, never restating (or re-classifying) what it already said. */
/** All text in a tool result, joined — for quoting one result inside another. */
function textOfToolResult(res: ToolResult): string {
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ").trim();
}

/**
 * #1329 — the panel's STALE NODE SCHEMA refusal, which is worth acting on rather than
 * relaying.
 *
 * It is the one refusal here whose prescribed remedy has no decision in it: the class
 * this page registered has drifted from the server's, and `refresh_nodes` re-fetches
 * /object_info and re-registers it in place. The reporter ran that by hand twice and it
 * worked twice.
 *
 * Matched on the drift sentence rather than on "panel_refresh_nodes", which appears in
 * several unrelated remedies — keying on the recommendation would make any of them
 * trigger an add-retry.
 */
function isStaleNodeSchemaRefusal(res: ToolResult): boolean {
  if (!res.isError) return false;
  return /added or retyped since this page loaded its node schema/i.test(textOfToolResult(res));
}

function appendToolResultText(res: ToolResult, extra: string): ToolResult {
  const idx = res?.content?.findIndex((c) => c.type === "text") ?? -1;
  const block = idx >= 0 ? res.content[idx] : undefined;
  if (!block || block.type !== "text") return res;
  const content = [...res.content];
  content[idx] = { type: "text", text: `${block.text}${extra}` };
  return { ...res, content };
}

// ---- #1695: bound the panel_set_widget previous/new echo --------------------
//
// Code-mode clients (Codex `functions.exec`) batch several panel_set_widget
// calls into one script, and the OUTER tool result accumulates every nested
// reply. Each reply echoes the previous and new widget values verbatim; two
// long CLIPTextEncode prompts per call push the aggregate past the client's
// tool-result budget ("Output exceeded the available model context and was
// truncated") even though every mutation succeeded — and the truncation can
// hide exactly the per-call status the caller needs. The echo is confirmation,
// not transport (a read-back belongs to panel_query_graph), so a long string
// value is summarized server-side as { chars, sha256, preview }: the hash keeps
// the confirmation verifiable, the preview keeps it legible, and `echo: "full"`
// opts back into the verbatim reply.
//
// Server-side on purpose — the echo is produced by the panel frontend, and an
// old panel keeps echoing verbatim no matter what a new one would do (the same
// reason fitQueryGraphReply re-fits here, #807).
const SET_WIDGET_ECHO_SUMMARY_THRESHOLD = 1000;
const SET_WIDGET_ECHO_PREVIEW_CHARS = 160;

function summarizeSetWidgetEcho(res: ToolResult, full: boolean): ToolResult {
  if (full || res.isError) return res;
  const payload = parseToolResultJson(res);
  const set = payload?.set;
  if (!payload || !set || typeof set !== "object" || Array.isArray(set)) return res;
  const record = set as Record<string, unknown>;
  const summarize = (v: unknown): unknown => {
    if (typeof v !== "string" || v.length <= SET_WIDGET_ECHO_SUMMARY_THRESHOLD) return v;
    return {
      chars: v.length,
      sha256: createHash("sha256").update(v, "utf8").digest("hex"),
      preview: `${v.slice(0, SET_WIDGET_ECHO_PREVIEW_CHARS)}…`,
    };
  };
  const previous = summarize(record.previous);
  const value = summarize(record.value);
  // Nothing crossed the threshold — return the reply untouched rather than
  // dressing up an unfitted payload as a fitted one.
  if (previous === record.previous && value === record.value) return res;
  const idx = res.content.findIndex((c) => c.type === "text");
  if (idx < 0) return res;
  const fitted = {
    ...payload,
    set: { ...record, previous, value },
    echo: "summary",
    echo_full:
      'Long string values were summarized as {chars, sha256, preview} so batched calls do not overflow the outer tool result; the mutation was applied. Re-call with echo: "full" for the verbatim strings, or read the live value back with panel_query_graph.',
  };
  return {
    ...res,
    content: res.content.map((c, i) =>
      i === idx && c.type === "text" ? { ...c, text: JSON.stringify(fitted, null, 2) } : c,
    ),
  };
}

// ---- #809: turn the panel's silent `truncated: true` booleans into a remedy --------
//
// A bare boolean is the WORST truncation signal there is: it is a field, not prose, so
// a model reading the result gets no instruction from it at all. The observed failure
// (a Kimi session on a 690-node graph) is an agent concluding the TOOL cannot do the
// thing and escalating to the human, when a different argument would have answered it.
//
// These riders are applied ORCHESTRATOR-side on purpose. The panel ships as a separate
// package on its own release cadence, so attaching the remedy here means every user
// gets it the moment they update the MCP server, regardless of their panel build. When
// a newer panel supplies its own hint under the same key, the rider defers to it.
// The REAL panel-side clamp for graph_find_nodes (`Math.min(Math.max(limit ?? 40, 1), 200)`
// in comfyui-mcp-panel.js). Kept as named constants so the zod `.max()`, the parameter
// description and the truncation remedy below cannot drift apart — the drift is exactly
// what made `panel_find_nodes` claim "no truncation" while capping at 40 (#809).
const FIND_NODES_DEFAULT_LIMIT = 40;
const FIND_NODES_LIMIT_CEILING = 200;

// #809: panel_graph_outline's budget. Deliberately the SAME name and the SAME
// 500–60000 clamp as panel_query_graph's max_chars — one budget concept, one spelling,
// so an agent that has learned the lever on one graph read already knows it on the
// other. The outline degrades by RESOLUTION, never by coverage: half a map is not a
// smaller map, and an agent handed the first 200 of 690 nodes cannot tell what it is
// missing. See the panel-side ladder in comfyui-mcp-panel.js (graph_outline).
const OUTLINE_MAX_CHARS_FLOOR = 500;
const OUTLINE_MAX_CHARS_DEFAULT = 24000;
const OUTLINE_MAX_CHARS_CEILING = 60000;

interface TruncationRule {
  /** Attach only when the panel reply carries this field as boolean `true`. */
  flag: string;
  /** Field to attach the remedy under. Must not collide with a panel-supplied field. */
  key: string;
  /** Build the remedy from the reply. Keep it one sentence — it is spent from context. */
  text: (payload: Record<string, unknown>) => string;
}

/** Count of an array-valued reply field, or null when it isn't an array. */
function replyCount(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return Array.isArray(v) ? v.length : null;
}

/** "N of M" when both are known, else "N" — never invent a total we weren't given. */
function shownOf(shown: number | null, total: unknown): string {
  const t = typeof total === "number" && Number.isFinite(total) ? total : null;
  if (shown == null) return t == null ? "some" : `some of ${t}`;
  return t == null ? `${shown}` : `${shown} of ${t}`;
}

function withTruncationHints(res: ToolResult, rules: TruncationRule[]): ToolResult {
  const payload = parseToolResultJson(res);
  if (!payload) return res;
  let changed = false;
  for (const rule of rules) {
    if (payload[rule.flag] !== true) continue;
    // Never clobber a hint the panel itself supplied — a newer panel knows its own caps
    // better than this rider does.
    if (payload[rule.key] != null) continue;
    payload[rule.key] = rule.text(payload);
    changed = true;
  }
  // Synthetic flags (markBudgetIgnored) are plumbing, not part of the tool's result —
  // strip them so a caller never sees a field the panel did not send.
  if (payload.__budget_ignored !== undefined) {
    delete payload.__budget_ignored;
    changed = true;
  }
  if (!changed) return res;
  // Rewrite ONLY the JSON text block, so an image-carrying reply keeps its other parts.
  const idx = res.content.findIndex((c) => c.type === "text");
  if (idx < 0) return res;
  return {
    ...res,
    content: res.content.map((c, i) =>
      i === idx && c.type === "text" ? { ...c, text: JSON.stringify(payload, null, 2) } : c,
    ),
  };
}

/**
 * #809 (codex gate): set a synthetic `__budget_ignored` flag when the caller asked for a
 * `max_chars` on the outline and the reply shows no sign of it. A panel that supports the
 * budget echoes `max_chars` back; an older build silently returns the full outline, so
 * the bound this tool advertises did not apply. The flag is stripped again before the
 * result is returned — it exists only to drive the rider.
 */
/**
 * A 0-node outline is a CLAIM, and one made mid-restore is not established (#1184).
 *
 * Right after a ComfyUI restart and a tab switch, graph_outline returned
 * `node_count: 0` for a tab holding a 7-node starter graph — the frontend was
 * still restoring, and the canvas transiently had nothing on it. The agent
 * trusted the empty read, reported the canvas empty, and BUILT A NEW 9-NODE
 * PIPELINE alongside the invisible one. A later panel_query_graph showed 16
 * nodes: ids 1–7 had been there the whole time, which the frontend knew, because
 * the new adds started at id 8.
 *
 * That is the worst shape of this defect class, because the action taken on the
 * false read DESTROYS WORK: a duplicate pipeline cannot be un-built, and the user
 * is left with two overlapping graphs and no way to tell which nodes are theirs.
 *
 * It is also unusually cheap to get right. Unlike most "could not determine"
 * cases, an empty outline is trivially RE-VERIFIABLE: read it again, and the
 * restore has either finished or it has not.
 *
 * So an empty first read is re-read once after a short settle:
 *   - second read non-empty  → the first was a race; report the real graph.
 *   - second read still empty → "empty" is now OBSERVED TWICE, not assumed, and
 *     is reported plainly with no hedge (a blank canvas is a normal state and
 *     must not be narrated as suspicious).
 *
 * The whole cost lands on the genuinely-empty case — one extra cheap read — which
 * is the right place for it: a blank canvas is common but harmless to re-check,
 * while a false empty is rare and expensive.
 *
 * Never throws: a failed re-read leaves the original reply exactly as it was.
 */
async function confirmEmptyOutline(
  ctx: PanelToolCtx,
  res: ToolResult,
  reread: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    if (res.isError) return res;
    const first = parseToolResultJson(res);
    if (!first || first.node_count !== 0) return res;

    // Which workflow this empty answer is ABOUT (codex review). The re-read is a
    // second round trip, and the user can switch tabs during it — so a non-empty
    // second outline might describe a DIFFERENT workflow entirely. Substituting
    // it would report workflow B's graph as though it confirmed a read of A,
    // which is a worse failure than the empty read this exists to fix.
    const identityBefore = currentWorkflowFence(ctx);

    // A BOUNDED POLL, not a single retry (codex review). A restore after a
    // ComfyUI restart has no guaranteed duration, and one 400ms attempt is an
    // arbitrary cliff: if the restore is still going at that instant, the fix
    // silently fails to cover the very report it is for. Poll briefly instead,
    // stopping the moment nodes appear.
    for (const waitMs of EMPTY_OUTLINE_RECHECK_STEPS_MS) {
      await sleep(waitMs);
      const second = await reread();
      // Redundant with the parsed-null guard below TODAY — an error result carries
      // no parseable JSON — and kept anyway: it states the intent directly, and
      // would still hold if an error result ever carried a structured body.
      if (second.isError) continue;
      const parsed = parseToolResultJson(second);
      if (!parsed || parsed.node_count === 0) continue;

      // Nodes appeared — but only adopt them if the canvas is still the SAME
      // workflow. A changed identity means the second read answers a different
      // question, so the original (honest, empty) answer stands.
      const identityAfter = currentWorkflowFence(ctx);
      if (
        identityBefore.known &&
        identityAfter.known &&
        identityBefore.uuid !== identityAfter.uuid
      ) {
        return res;
      }
      return second;
    }
    return res;
  } catch {
    return res;
  }
}

/**
 * The back-off schedule for re-reading an empty outline (#1184).
 *
 * A bounded poll rather than one attempt: a restore after a ComfyUI restart has
 * no guaranteed duration, so a single fixed wait is an arbitrary cliff that would
 * silently miss a slower restore (codex review). Stops the moment nodes appear.
 *
 * Bounded deliberately at ~1.2s total. A genuinely blank canvas is a COMMON
 * state and pays this whole cost, so it has to stay small enough not to be felt;
 * a longer poll would buy rarer restores at the expense of every empty read.
 */
const EMPTY_OUTLINE_RECHECK_STEPS_MS = [250, 400, 550] as const;

/**
 * Enforce `max_chars` when the PANEL could not (#1203).
 *
 * A panel older than the budget protocol ignores `max_chars` and returns the
 * whole outline. The orchestrator already noticed — that is what
 * `markBudgetIgnored` is for — and then forwarded the unbounded reply anyway,
 * with a note explaining that the bound the caller had explicitly set did not
 * apply. A 137-node outline arrived that way, which is the exact context flood
 * `max_chars` exists to prevent, and the disclosure came AFTER the cost was
 * already paid. A warning is not a bound.
 *
 * WHY REFUSE RATHER THAN TRUNCATE. This tool's contract is that coverage is
 * never traded away: over budget the outline sheds RESOLUTION — widget values,
 * then titles, then a per-group summary — so whatever comes back still describes
 * the whole graph, and if even the floor will not fit it returns NO outline
 * rather than a partial one that reads as complete. Cutting the rendered text at
 * a character count would break exactly that guarantee: the result would look
 * like a finished outline that simply ends, and a caller acting on it would
 * believe the graph stops where the string does — the #1184 failure again, with
 * the truncation invisible instead of announced.
 *
 * Shedding resolution is the panel's job and needs the graph, not its rendering.
 * The orchestrator has only the rendered text, so the honest move is the one the
 * panel itself makes at its floor: return no outline, and say precisely what
 * happened, how big the outline actually was, and which of the three levers
 * (raise the bound, update the panel, scope the read) will work.
 *
 * The counts and `viewing` survive — they are the part of the reply that is
 * small, true, and independent of the budget.
 */
function enforceOutlineBudget(res: ToolResult, requested: unknown): ToolResult {
  if (typeof requested !== "number") return res;
  const payload = parseToolResultJson(res);
  if (!payload) return res;
  // A panel that supports the budget echoes it back and has already applied its
  // own ladder. Nothing to enforce, and second-guessing it would be wrong.
  if (typeof payload.max_chars === "number") return res;
  const outline = payload.outline;
  if (typeof outline !== "string") return res;
  // Within the bound already. The panel ignored the parameter, but the reply
  // honours it, and refusing a reply that FITS would be a bound in name only.
  if (outline.length <= requested) return res;

  const idx = res.content.findIndex((c) => c.type === "text");
  if (idx < 0) return res;

  const nodes = typeof payload.node_count === "number" ? payload.node_count : null;
  const groups = typeof payload.group_count === "number" ? payload.group_count : null;
  const shape =
    nodes != null
      ? `The graph has ${nodes} node(s)${groups != null ? ` and ${groups} group(s)` : ""}.`
      : "";
  // The refusal goes IN the outline field, not an empty string (codex review).
  // Two reasons. It is what the panel itself does at its own floor, so a caller
  // that handles one refusal handles both. And an empty outline next to
  // `node_count: 137` is exactly the contradiction #1184 was about — a consumer
  // that reads `outline` and finds nothing has been told the canvas is empty by
  // a reply whose own counts say otherwise. Bounded and fixed-length, so it
  // cannot itself overrun a budget whose floor is OUTLINE_MAX_CHARS_FLOOR.
  payload.outline =
    `NO OUTLINE — this panel build ignores \`max_chars\`, and its full reply (${outline.length} chars) exceeds the bound of ${requested} you set. ` +
    `It is withheld rather than cut, because a truncated outline would read as a complete one. ` +
    `${shape} See \`max_chars_hint\` for what to do.`.trim();
  payload.detail_level = "refused";
  payload.degraded = true;
  payload.budget_applied_by = "orchestrator";
  payload.unbounded_chars = outline.length;
  payload.degraded_reason =
    `This panel build ignores \`max_chars\`, so it returned the FULL outline (${outline.length} chars) against a bound of ${requested}. ` +
    `It is withheld rather than cut: a truncated outline would read as a complete one. ${shape}`.trim();

  return {
    ...res,
    content: res.content.map((c, i) =>
      i === idx && c.type === "text" ? { ...c, text: JSON.stringify(payload, null, 2) } : c,
    ),
  };
}

/** The three levers when the orchestrator had to withhold an outline (#1203),
 *  in the order worth trying. Shared so the two riders cannot drift. */
function outlineBudgetRemedies(unbounded: number | null): string {
  // Every "raise it" must name the ceiling, or a caller already at the maximum
  // is sent on a retry that cannot change anything (the repo-wide remedy check,
  // which caught this text before it shipped).
  // The ceiling has to sit next to the parameter name, not at the end of the
  // sentence: the remedy check reads "raise `X` … up to N" as one phrase, and it
  // is right to — a caller skimming for whether the retry is possible should not
  // have to finish the clause.
  const raise =
    unbounded == null
      ? `Raise \`max_chars\` up to ${OUTLINE_MAX_CHARS_CEILING}`
      : unbounded <= OUTLINE_MAX_CHARS_CEILING
        ? `Raise \`max_chars\` up to ${OUTLINE_MAX_CHARS_CEILING} — this outline needs at least ${unbounded} to be accepted whole`
        : `Raising \`max_chars\` will NOT help — the full outline is past its ceiling of ${OUTLINE_MAX_CHARS_CEILING}`;
  return (
    `${raise}; update the ComfyUI Agent Panel, which can shed per-node detail and still cover every node inside a smaller bound; ` +
    `or scope the read with panel_query_graph {ids:[…], fields:'detail'}.`
  );
}

function markBudgetIgnored(res: ToolResult, requested: unknown): ToolResult {
  if (typeof requested !== "number") return res;
  const payload = parseToolResultJson(res);
  if (!payload || typeof payload.max_chars === "number") return res;
  const idx = res.content.findIndex((c) => c.type === "text");
  if (idx < 0) return res;
  payload.__budget_ignored = true;
  return {
    ...res,
    content: res.content.map((c, i) =>
      i === idx && c.type === "text" ? { ...c, text: JSON.stringify(payload, null, 2) } : c,
    ),
  };
}

/** The MAX_STATE_NODES views (#809): a FIXED panel-side cap with no parameter to
 *  raise. Saying so plainly — and naming the tool that CAN target the rest — is the
 *  honest remedy; inventing a lever these tools do not have would be the same defect
 *  in the other direction. */
function fixedCapHint(
  what: string,
  shown: number | null,
  total: unknown,
  targeted: string,
): string {
  return (
    `Showing ${shownOf(shown, total)} ${what} — this view has a FIXED cap and no parameter raises it. ` +
    targeted
  );
}

// ---- #807: ONE budget, for the WHOLE panel_query_graph reply ----------------------
//
// `max_chars` used to bound the `text` field and nothing else. Everything else in the
// reply — the `groups` array with each group's full member `node_ids`, and the subgraph
// `rails` — rode ALONGSIDE it under separate fixed caps, and was serialized BEFORE the
// rows the caller had asked for. On a 690-node graph that is not a rounding error: at
// the panel's own caps those riders alone can render to well over 100k characters, so a
// reply announcing "truncated at 12 of 690 by max_chars=12000" could hand back ten times
// that. A budget figure that does not describe the actual payload is a fabricated
// observation, and the agent that reads it concludes the TOOL cannot show it node
// detail — which is exactly what the reporter's session concluded.
//
// The accounting is applied HERE, once, over the finished payload, for the same reason
// the #809 riders are: this is the last place the reply is touched before the caller
// sees it, it measures the EXACT string that will be returned (pretty-printed JSON,
// escaping and all), and it holds against every panel build rather than only the ones
// that ship after it.
//
// Two rules govern what gets shed:
//   1. The rows that ANSWER THE QUERY are never dropped to make room for context. The
//      riders are spent from what is left over, and are moved to the END of the object
//      so the answer is also what a reader meets first.
//   2. Coverage before resolution, mirroring panel_graph_outline's ladder: dropping
//      every group's membership still leaves a complete group index, whereas listing
//      half the groups reads as "this graph has that many groups".
const QUERY_GRAPH_MAX_CHARS_FLOOR = 500;
const QUERY_GRAPH_MAX_CHARS_DEFAULT = 12000;
const QUERY_GRAPH_MAX_CHARS_CEILING = 60000;

/** The panel's own clamp for graph_query's budget, mirrored so the figure this module
 *  reports and enforces is the one the panel was actually working to. */
function clampQueryGraphMaxChars(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return QUERY_GRAPH_MAX_CHARS_DEFAULT;
  return Math.min(
    Math.max(Math.floor(n), QUERY_GRAPH_MAX_CHARS_FLOOR),
    QUERY_GRAPH_MAX_CHARS_CEILING,
  );
}

/** The reply fields that are CONTEXT rather than answer. `viewing` is deliberately not
 *  one of them: it identifies which graph the answer describes, it is a couple of small
 *  fields, and a reply that cannot say what it is about is worse than a bigger one. */
const QUERY_GRAPH_RIDER_KEYS = [
  "groups_truncated",
  "groups_truncation_hint",
  "groups",
  "rails",
] as const;

/** The fields THIS accounting authors. Any inbound copy is dropped before measuring, so
 *  a stale claim from a different measurement can never ride out as if this one made it
 *  (independent gate P0). `max_chars` is re-set unconditionally just below. */
const QUERY_GRAPH_OWNED_KEYS: ReadonlySet<string> = new Set([
  "max_chars",
  "groups_membership_omitted",
  "groups_omitted",
  "rails_omitted",
  "budget_overrun",
]);

/** A group reduced to its INDEX form: which groups exist, what they are called, and how
 *  many nodes each holds. Membership and geometry are what grow with the graph. */
function groupIndexEntry(g: unknown): unknown {
  if (!g || typeof g !== "object" || Array.isArray(g)) return g;
  const r = g as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("id" in r) out.id = r.id;
  if ("title" in r) out.title = r.title;
  // `node_count` is the group's TRUE size on every panel that reports it. Falling back
  // to the length of `node_ids` is only sound when that list was not itself clipped —
  // otherwise the count would understate the group, which is the same lie one rung down.
  if (typeof r.node_count === "number") out.node_count = r.node_count;
  else if (Array.isArray(r.node_ids) && r.node_ids_truncated === undefined)
    out.node_count = r.node_ids.length;
  return out;
}

/**
 * Fit the WHOLE panel_query_graph reply inside the `max_chars` it advertises, by
 * shedding CONTEXT — never the rows that answer the query.
 *
 * EVERY reply is measured, including the ones with no riders to shed (codex gate
 * SEVERE): the early "there is nothing to cut, so skip the accounting" shortcut let a
 * reply with a large `viewing`, a field this build has never seen, or simply very long
 * rows exceed the budget it reports with nothing said. There is no third outcome here —
 * a reply either fits the budget it names or carries `budget_overrun` saying it does
 * not. Nothing is invented on the way: a result that fits is never dressed up as a
 * truncated one (the false-truncation defect #809 also exists to remove).
 *
 * An error or non-JSON reply is passed through untouched. It makes no budget CLAIM —
 * there is no `max_chars` on it to be wrong — and rewriting a failure message to
 * mention a character budget would bury the failure.
 *
 * EVERY text block is counted, not only the one carrying the JSON, and a non-text block
 * (this tool emits none, but the shape allows them) has its PRESENCE disclosed rather
 * than silently ignored — `max_chars` bounds characters, and calling image bytes
 * characters would be its own false figure.
 */
function fitQueryGraphReply(res: ToolResult, requested: unknown): ToolResult {
  const payload = parseToolResultJson(res);
  if (!payload) return res;
  const idx = res.content.findIndex((c) => c.type === "text");
  if (idx < 0) return res;

  const budget = clampQueryGraphMaxChars(requested);
  // EVERY text block counts, not just the one carrying the JSON (independent gate P0).
  // Measuring the first block and leaving the rest untouched is the SAME defect this
  // function exists to remove — a budget describing one part of a reply while something
  // rides beside it — relocated from `groups`/`rails` to the block list. A small fitted
  // payload next to an unmeasured 100k second block would report `max_chars` and no
  // overrun. "The last place the reply is touched" has to mean the whole reply.
  const siblingText = res.content.reduce(
    (n, c, i) => (i !== idx && c.type === "text" ? n + (c.text?.length ?? 0) : n),
    0,
  );
  // Blocks that are not text (this tool emits none, but the shape allows them) are not
  // counted — `max_chars` bounds characters, and calling image bytes characters would be
  // its own false figure — so their PRESENCE is disclosed instead of silently ignored.
  const nonTextBlocks = res.content.filter((c) => c.type !== "text").length;
  const render = (p: Record<string, unknown>): string => JSON.stringify(p, null, 2);
  /** The whole reply's character count: the fitted JSON plus every sibling text block. */
  const sizeOf = (p: Record<string, unknown>): number => render(p).length + siblingText;
  const replaceWith = (p: Record<string, unknown>): ToolResult => ({
    ...res,
    content: res.content.map((c, i) =>
      i === idx && c.type === "text" ? { ...c, text: render(p) } : c,
    ),
  });

  const riderKeys = new Set<string>(QUERY_GRAPH_RIDER_KEYS);
  const answer: Record<string, unknown> = {};
  const riders: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (riderKeys.has(k)) riders[k] = v;
    else if (!QUERY_GRAPH_OWNED_KEYS.has(k)) answer[k] = v;
  }
  // The budget this call ENFORCED, always — it is the number the fitting below works
  // to, and it is measured with this field already present. Deferring to a panel-supplied
  // `max_chars` would report a bound nothing checked (codex gate SEVERE): a reply fitted
  // to 4000 could announce 3777 and look compliant at 3900.
  //
  // The loop above drops any INBOUND copy of the fields this function authors, for the
  // same reason (independent gate P0). An arriving `budget_overrun` is a claim from a
  // different measurement: carried through, a reply that fits after fitting would still
  // announce that it does not — a false positive on the one marker that has to be
  // trustworthy, and a caller who learns to distrust it will ignore the real ones. This
  // accounting is the sole author of these fields, so it is also their sole source.
  answer.max_chars = budget;

  const groups = Array.isArray(riders.groups) ? (riders.groups as unknown[]) : null;
  const hasGroups = !!groups && groups.length > 0;
  const hasRails = riders.rails !== undefined;

  /** The answer plus whichever riders `r` still carries, riders last. */
  const assemble = (r: Record<string, unknown>): Record<string, unknown> => {
    const p: Record<string, unknown> = { ...answer };
    for (const k of QUERY_GRAPH_RIDER_KEYS) if (r[k] !== undefined) p[k] = r[k];
    return p;
  };

  const full = assemble(riders);
  const fullChars = sizeOf(full);
  if (fullChars <= budget) return replaceWith(full);

  /**
   * How the caller gets shed context back, judged against where they actually are.
   *
   * `needed` is the size of the reply that still carries it; `floor` is that same reply
   * with NO matching rows at all — the smallest this call could ever be while keeping
   * it. Both are MEASURED, not estimated, which is what lets each branch below be true:
   * narrowing the query can only help while `floor` fits, and raising `max_chars` can
   * only help while `needed` (or, combined with narrowing, `floor`) is under the
   * ceiling. Every other phrasing is a dead retry — a real lever that cannot move,
   * which costs the same round trip as naming one that does not exist.
   *
   * Response FIELDS are named bare on purpose: backticks here mean "a lever on this
   * tool", and dressing a field as a parameter is that same wasted retry.
   */
  //
  // And the ROWS IN HAND may already be a cut set. The panel stops adding rows at this
  // same `max_chars` and reports `truncated_by:"max_chars"` when it did, so on that path
  // raising the budget returns MORE ROWS as well — a budget sized to "these rows plus
  // the riders" is then not enough to keep both, and calling that size "the untruncated
  // reply" describes a reply nobody has seen (codex gate MAJOR).
  const rowsCutByBudget = answer.truncated_by === "max_chars";
  const recovery = (needed: number, floor: number): string => {
    const narrow =
      floor <= budget
        ? " Narrowing this query (`ids`/`types`/`where`/`limit`) frees budget for them too."
        : "";
    const alsoMoreRows = rowsCutByBudget
      ? " But the panel cut the ROWS at this same budget too, so raising it returns more rows as well and may still not leave room for them — narrow the query (`ids`/`types`/`where`/`limit`) in the same call to be sure."
      : narrow;
    if (budget >= QUERY_GRAPH_MAX_CHARS_CEILING) {
      return floor <= budget
        ? `\`max_chars\` is already at its ceiling of ${QUERY_GRAPH_MAX_CHARS_CEILING}.${narrow}`
        : `\`max_chars\` is already at its ceiling of ${QUERY_GRAPH_MAX_CHARS_CEILING}, and they need ~${floor} chars even with no matching rows at all, so one reply cannot carry them.`;
    }
    if (needed <= QUERY_GRAPH_MAX_CHARS_CEILING)
      return `Keeping them alongside THESE rows takes ~${needed} chars: raise \`max_chars\` (up to ${QUERY_GRAPH_MAX_CHARS_CEILING}) to about that.${alsoMoreRows}`;
    if (floor <= QUERY_GRAPH_MAX_CHARS_CEILING)
      return `Keeping them alongside THESE rows takes ~${needed} chars, past this tool's ceiling — but only ~${floor} chars without the rows, so raise \`max_chars\` (up to ${QUERY_GRAPH_MAX_CHARS_CEILING}) AND narrow the query (\`ids\`/\`types\`/\`where\`/\`limit\`) together.`;
    return `They need ~${floor} chars even with no matching rows at all, past \`max_chars\`'s ceiling of ${QUERY_GRAPH_MAX_CHARS_CEILING}, so no combination of raising it and narrowing this query returns them here.`;
  };
  /** The same reply with the answer rows removed — the floor `recovery` reasons about. */
  const floorOf = (r: Record<string, unknown>): number =>
    sizeOf({ ...assemble(r), ...(answer.text !== undefined ? { text: "" } : {}) });

  const outline =
    ` panel_graph_outline's GROUPS index lists every member id — but only while its own max_chars affords a node-level rung; if it reports detail_level:"groups" it gives counts, not ids.`;

  // Every note below states what was OBSERVED — that the reply did not fit — and never
  // that dropping this made it fit (codex gate MAJOR). Whether it ultimately did is
  // answered by the presence or absence of `budget_overrun`, which is checked, not
  // predicted.

  // The panel caps its own groups list at 200 BEFORE this code sees it, so the coverage
  // claim any note here can make is about what the reply CARRIED, never about the graph
  // (codex gate MAJOR — "every group is still listed" sat next to the panel's own
  // "showing 200 of 640" and contradicted it).
  const groupsPreCapped = riders.groups_truncated === true;

  // Rung 1 — every group the reply carried still listed, membership and geometry gone.
  if (hasGroups) {
    const reduced: Record<string, unknown> = { ...riders, groups: groups!.map(groupIndexEntry) };
    const p = assemble(reduced);
    p.groups_membership_omitted =
      `Member node_ids and box geometry were omitted from all ${groups!.length} group(s): the whole reply did not fit \`max_chars\`=${budget}, ` +
      `and the rows answering your query are never dropped to make room for context. ` +
      (groupsPreCapped
        ? `Every group this reply CARRIED is still listed with an exact node_count — but the panel had already capped that list before this call saw it (see groups_truncation_hint), so ${groups!.length} is not the graph's total. `
        : `Every group is still listed and each node_count is exact. `) +
      recovery(fullChars, floorOf(riders)) +
      outline;
    if (sizeOf(p) <= budget) return replaceWith(p);
  }

  // The panel's OWN cap markers are evidence about the GRAPH, not payload this code is
  // free to spend: `groups_truncation_hint` is the only place the real group count
  // ("Showing 200 of 640") survives, so dropping it while dropping the list destroys the
  // one coverage fact the caller could still have had (codex gate MAJOR). They are two
  // short fields and they are kept on every rung below the index.
  const capEvidence: Record<string, unknown> = {};
  if (riders.groups_truncated !== undefined) capEvidence.groups_truncated = riders.groups_truncated;
  if (riders.groups_truncation_hint !== undefined)
    capEvidence.groups_truncation_hint = riders.groups_truncation_hint;

  // Rung 2 — the group index itself goes. Its true size is stated in its place.
  //
  // An EMPTY `groups: []` is not a rider to shed, it is an OBSERVATION — "this graph has
  // no groups" — costing about fifteen characters. Deleting it saved nothing and quietly
  // turned a stated zero into an absent field, which is the same coverage loss one rung
  // up (codex gate MAJOR). Only a non-empty list is dropped here.
  const withoutGroups: Record<string, unknown> = { ...riders };
  if (hasGroups) delete withoutGroups.groups;
  const noGroups = assemble(withoutGroups);
  if (hasGroups) {
    // The count we can vouch for is "what this reply carried", not "what the graph has".
    const carried =
      groupsPreCapped
        ? `the ${groups!.length} group(s) this reply carried (the panel had already capped that list, so that is not the graph's total — its own groups_truncated / groups_truncation_hint are kept here and record the real figure)`
        : `all ${groups!.length} group(s)`;
    noGroups.groups_omitted =
      `The groups rider was dropped entirely — ${carried} — because the whole reply did not fit \`max_chars\`=${budget} even with their membership already omitted, ` +
      `and the rows answering your query are never dropped to make room for it. ` +
      recovery(fullChars, floorOf(riders)) +
      outline;
  }
  if (sizeOf(noGroups) <= budget) return replaceWith(noGroups);

  // Rung 3 — the subgraph rails go too. The cap evidence, and an empty groups
  // observation, still ride.
  const bareRiders: Record<string, unknown> = { ...capEvidence };
  if (!hasGroups && riders.groups !== undefined) bareRiders.groups = riders.groups;
  const bare = assemble(bareRiders);
  if (hasGroups && noGroups.groups_omitted !== undefined)
    bare.groups_omitted = noGroups.groups_omitted;
  if (hasRails) {
    bare.rails_omitted =
      `The subgraph boundary rails were dropped because the reply did not fit \`max_chars\`=${budget} without them. ` +
      recovery(sizeOf(noGroups), floorOf(withoutGroups));
  }

  // Every rider is gone and it STILL does not fit. What is left is the rows, the fields
  // that say which graph they came from, and the sentences saying what was dropped —
  // none of which may be silently cut, so the overrun is DISCLOSED with the real number
  // rather than left standing behind a `max_chars` that did not hold.
  //
  // WHICH part is responsible has to be measured, not assumed (codex gate MAJOR). The
  // earlier wording called every non-rider byte "the rows that answer your query" and
  // then offered to shrink them, which on a reply carrying a 3000-character subgraph
  // title blamed the wrong field AND named two levers that cannot touch it — the dead
  // retry this whole accounting exists to prevent. `lower max_chars` and `narrow the
  // query` both act on the ROWS ONLY, so they are offered only while the rest of the
  // reply would fit without them.
  const withoutRows = (p: Record<string, unknown>): Record<string, unknown> =>
    answer.text !== undefined ? { ...p, text: "" } : p;
  const rowsChars = render(answer).length - render(withoutRows(answer)).length;
  const floorWithNotes = sizeOf(withoutRows(bare));
  const shrink =
    floorWithNotes <= budget
      ? budget > QUERY_GRAPH_MAX_CHARS_FLOOR
        ? `Both levers act on the rows, so for a smaller reply lower \`max_chars\` (floor ${QUERY_GRAPH_MAX_CHARS_FLOOR}) or narrow the query with \`ids\`/\`types\`/\`where\`/\`limit\`.`
        : `\`max_chars\` is already at its floor of ${QUERY_GRAPH_MAX_CHARS_FLOOR}, so narrow the query with \`ids\`/\`types\`/\`where\`/\`limit\` for a smaller reply.`
      : `Lowering \`max_chars\` and narrowing the query both act on the ROWS ONLY, and everything else here is already ${floorWithNotes} chars on its own — so neither would bring this reply under the budget, and no parameter shrinks the rest.`;
  // "Nothing was discarded" is FALSE next to a groups_omitted note saying exactly what
  // was (codex gate r4). Two fields down, that contradiction is the kind a reader
  // resolves by distrusting both. Say which of the two situations this is.
  const shedSomething = hasGroups || hasRails;
  // Sibling text blocks are part of the reply and part of the figure, so they are named
  // rather than folded silently into "everything else" (independent gate P0).
  const siblings =
    siblingText > 0
      ? `${res.content.filter((c, i) => i !== idx && c.type === "text").length} further text block(s) carrying ${siblingText} chars, `
      : "";
  const nonText =
    nonTextBlocks > 0
      ? ` This reply also carries ${nonTextBlocks} non-text block(s), whose bytes \`max_chars\` does not bound and this figure does not count.`
      : "";
  const overrun = (size: number): string =>
    `This reply is ${size} chars, over \`max_chars\`=${budget} — that figure counts the JSON framing and escaping, every text block, and this note itself. ` +
    `Of it, the rows answering your query are ${rowsChars} chars; the remaining ${size - rowsChars} is ${siblings}the fields identifying the graph this came from, anything else the panel sent, and the note(s) above saying which context was dropped. ` +
    (shedSomething
      ? `The context that COULD be dropped for the budget already has been, and the note(s) above record it; what remains was not cut down any further. `
      : `Nothing was discarded to meet the budget — there was no context to drop. `) +
    `The rows are your answer, and a silently short answer — or a silently missing rider, or a silently missing explanation of one — is the defect this accounting exists to prevent. ` +
    shrink +
    nonText;
  // The stated size must include the statement (codex gate MAJOR), so solve for it: the
  // note only grows the payload, and only its own digit count feeds back, so this
  // settles in one or two passes. The loop is bounded and the last pass is emitted
  // regardless — a size that is a character or two low is still the honest order of
  // magnitude, and the `budget_overrun` field itself is what carries the finding.
  let claimed = sizeOf({ ...bare, budget_overrun: overrun(sizeOf(bare)) });
  for (let i = 0; i < 4; i++) {
    const attempt = { ...bare, budget_overrun: overrun(claimed) };
    const size = sizeOf(attempt);
    if (size === claimed) return replaceWith(attempt);
    claimed = size;
  }
  return replaceWith({ ...bare, budget_overrun: overrun(claimed) });
}

// ---- panel_civitai_results inline sample thumbnails (#623) -------------------
// The agent recommends CivitAI models/LoRAs for a VISUAL medium, so it must be
// able to SEE the sample images — not just read titles + download counts. The
// civitai_results reply already carries the panel's same-origin proxy media URLs
// (/comfyui_mcp_panel/civitai/media?… served by the ComfyUI server the
// orchestrator is connected to), so we fetch the top-N NON-GATED thumbnails here
// and hand them back as MCP image content blocks — the same {type:"image"} bytes
// mechanism panel_show_media / get_image (action:"view") use.
//
// NSFW/consent gate preservation is the load-bearing invariant: a result the
// panel would render as a BLURRED/gated placeholder (rating outside the user's
// enabled browsing levels) is NEVER fetched, so this vision path can never leak a
// sample the human-facing UI withholds. See civitaiSampleEligible for the
// fail-CLOSED gating rule and fetchCivitaiSampleImages for the same-origin lock.
const CIVITAI_SAMPLE_MAX_BYTES = 4 * 1024 * 1024; // per-thumbnail cap (450px jpeg ≈ tens of KB)
const CIVITAI_SAMPLE_DEFAULT = 4; // thumbnails delivered by default — bounds context
const CIVITAI_SAMPLE_MAX = 8; // hard ceiling even if the agent asks for more

/**
 * The `civitai_*` commands whose reply time is bounded by CivitAI rather than by
 * the tab (#1520). Of the six in the family, exactly these two await the
 * in-flight fetch panel-side (`state.activeReloadPromise`): `civitai_results`
 * and `civitai_highlight`. `clear_highlight`, `switch_tab` and `open_lightbox`
 * do not, and keep the tighter bound.
 *
 * `civitai_search` is the sixth and is not on either path: it dispatches through
 * `ctx.bridge.send` so the handler can inspect the reply, and already takes
 * `BRIDGE_DEFAULT_TIMEOUT_MS` — #1468 raised it because `driveSearch` returns
 * without awaiting at all. The family is not uniform; do not assume a single
 * bound describes it.
 *
 * That await is deliberate (panel#793): without it an agent that opened the
 * browser and immediately asked for results got `{count:0, total:0}`, which
 * reads as "this search found nothing" while a concurrent `civitai_highlight`
 * *did* wait and *did* see cards — two commands disagreeing about whether
 * results existed. So the fix is not to remove the wait but to stop charging it
 * against a bound sized for a local read.
 *
 * Timing out here is not harmless in either case:
 *   - `civitai_results` is a pure read; the caller simply loses the answer.
 *   - `civitai_highlight` *lands* — the panel installs the glow once the reload
 *     resolves — so the caller is told the command failed while its effect
 *     arrives anyway. That is the #1468 false-failure shape. Re-issuing is safe
 *     (`driveHighlight` clears before installing), but the report was wrong.
 *
 * 20 s is not a cure — no bound covers a CivitAI 503-and-retry. It is the
 * tolerant bound every other read already gets (#357: a busy-but-alive tab
 * fails a tight one), and it is the window the panel's own bounded wait has to
 * fit inside to be able to answer at all.
 */
const CIVITAI_COUPLED_READ_TIMEOUT_MS = BRIDGE_READ_DEFAULT_TIMEOUT_MS;
const CIVITAI_SAMPLE_FETCH_TIMEOUT_MS = 8000;
// Extra fetch ATTEMPTS allowed beyond the requested image count, so a few
// 404/non-image/oversize URLs don't starve the result — but a malformed reply
// with many dud eligible URLs still can't trigger unbounded requests (the cap is
// on attempts, not just successes).
const CIVITAI_SAMPLE_ATTEMPT_SLACK = 4;
// The exact same-origin proxy path the panel serves CivitAI media from (appended
// to the ComfyUI base path). urls[0] MUST resolve to EXACTLY this pathname on the
// ComfyUI origin or it is not fetched (SSRF / auth-header-exfil guard — see
// fetchCivitaiSampleImages).
const CIVITAI_MEDIA_PROXY_PATH = "/comfyui_mcp_panel/civitai/media";

/**
 * Decide whether a single civitai_results item's sample thumbnail may be shown to
 * the agent as pixels. FAILS CLOSED: pixels are delivered ONLY when the panel
 * EXPLICITLY marks the item in-level (`gated === false`).
 *   • gated === false → newer panel proved it in-level (and, because the panel
 *     only sets gated=false when a real thumbnail exists, urls[0] is guaranteed to
 *     be the small thumbnail, never a full-res image) → SHOW.
 *   • gated === true  → the panel renders a blurred placeholder → WITHHOLD.
 *   • gated absent    → an OLDER panel that predates the flag: we cannot prove the
 *     result is in-level (nor that urls[0] is a thumbnail rather than a full-res
 *     image on a card whose thumbnail was suppressed) → WITHHOLD.
 * A missing/ambiguous flag therefore NEVER leaks a sample the UI would blur,
 * regardless of which panel build is connected or which tab is active.
 */
function civitaiSampleEligible(item: Record<string, unknown>): boolean {
  return item.gated === false;
}

/**
 * Best-effort fetch of up to `max` NON-GATED sample thumbnails from a parsed
 * civitai_results reply, as MCP image blocks paired with their result id (so the
 * agent can map each picture back to the items array). NEVER throws: any fetch
 * failure, non-image response, oversize body, or unreachable proxy simply yields
 * fewer (or zero) images — the caller still returns the full text results.
 *
 * SECURITY: only the panel's OWN same-origin CivitAI media proxy is fetched. urls[0]
 * must be a root-absolute path that resolves to CIVITAI_MEDIA_PROXY_PATH on the
 * ComfyUI origin; absolute/protocol-relative/off-origin/off-path URLs are refused,
 * and redirects are treated as errors. This prevents a malformed or compromised
 * panel reply from turning the fetch into an SSRF that exfiltrates the ComfyUI auth
 * headers comfyuiFetch attaches.
 */
async function fetchCivitaiSampleImages(
  reply: Record<string, unknown>,
  max: number,
): Promise<Array<{ id: unknown; image: { type: "image"; data: string; mimeType: string } }>> {
  const out: Array<{ id: unknown; image: { type: "image"; data: string; mimeType: string } }> = [];
  if (max <= 0) return out;
  const items = Array.isArray(reply.items) ? (reply.items as Record<string, unknown>[]) : [];
  const base = getComfyUIBaseUrl();
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return out; // no resolvable ComfyUI origin — deliver text only
  }
  const baseOrigin = baseUrl.origin;
  // The ONE canonical proxy pathname on this ComfyUI = base path + proxy route.
  // We require an EXACT match (not endsWith), so a same-origin reverse-proxy route
  // that merely *ends with* the proxy path (e.g. /other/comfyui_mcp_panel/civitai/media)
  // cannot receive an auth-bearing request.
  const expectedPath = baseUrl.pathname.replace(/\/+$/, "") + CIVITAI_MEDIA_PROXY_PATH;
  // Bound total network ATTEMPTS, not just successes: with images:1 and a reply
  // carrying 50 dud eligible URLs we must not fire 50 fetches.
  const maxAttempts = max + CIVITAI_SAMPLE_ATTEMPT_SLACK;
  let attempts = 0;
  for (const item of items) {
    if (out.length >= max || attempts >= maxAttempts) break;
    if (!item || typeof item !== "object") continue;
    if (!civitaiSampleEligible(item)) continue;
    const urls = Array.isArray(item.urls) ? item.urls : [];
    // urls[0] is always the smaller thumbnail/poster (media: [thumb, full];
    // model: [cover]); the full/video URL is intentionally NOT fetched.
    const raw = urls.find((u): u is string => typeof u === "string" && u.length > 0);
    if (!raw) continue;
    // Refuse anything but a root-absolute same-origin path: no scheme (http:,
    // file:, data:, …), no protocol-relative //host prefix, and no backslash
    // (the WHATWG parser folds `\`→`/` for special schemes, so `/\host` could
    // otherwise resolve to an authority). The strict origin + exact-path checks
    // below are the real guard; this just refuses the obvious tricks up front.
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) continue;
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      continue; // unresolvable URL — skip, keep going
    }
    // Defense-in-depth: the resolved URL must stay on the ComfyUI origin AND be
    // EXACTLY the CivitAI media proxy endpoint — never any other route.
    if (url.origin !== baseOrigin) continue;
    if (url.pathname !== expectedPath) continue;
    attempts++; // count this as a network attempt BEFORE the fetch
    try {
      const resp = await comfyuiFetch(url.toString(), {
        signal: AbortSignal.timeout(CIVITAI_SAMPLE_FETCH_TIMEOUT_MS),
        // A same-origin URL must not be allowed to 30x-bounce to another host
        // (which would carry the auth headers off-origin). The proxy streams
        // bytes directly, so a legitimate response never redirects.
        redirect: "error",
      });
      if (!resp.ok) continue;
      const mime = (resp.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!mime.startsWith("image/")) continue; // never inline a video/other body
      // Require an HONEST, bounded Content-Length so a chunked/length-less body
      // can't buffer unbounded memory into arrayBuffer(). The proxy always sets it.
      const declared = Number(resp.headers.get("content-length") ?? "");
      if (!Number.isFinite(declared) || declared <= 0 || declared > CIVITAI_SAMPLE_MAX_BYTES) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0 || buf.length > CIVITAI_SAMPLE_MAX_BYTES) continue;
      out.push({
        id: item.id,
        image: { type: "image", data: buf.toString("base64"), mimeType: mime },
      });
    } catch {
      // best-effort — skip this thumbnail, the text path is unaffected
    }
  }
  return out;
}

// ---- panel_run reply interpretation (#213/#331/#248/#194) -------------------
// `panel_run` forwards `graph_run` to the panel, which drives `app.queuePrompt`
// and forwards ComfyUI's /prompt outcome back. ComfyUI splits a rejection into
// TWO channels:
//   • per-node problems      -> `node_errors` (a map keyed by node id)
//   • TOP-LEVEL problems     -> `error`       (e.g. prompt_outputs_failed_validation,
//                                              missing_node_type) — leaves node_errors EMPTY
// #213: the panel's success guard looked ONLY at node_errors, so a top-level
// rejection (empty node_errors) slipped through as `queued:true` — a FALSE
// success the agent then waited a whole turn on. We therefore DERIVE the verdict
// from the authoritative fields (mirroring the #485 enqueue-validation parsing):
// a reply is a rejection when it carries a non-empty `error`, a non-empty
// `node_errors`, or an explicit `queued:false` — regardless of any `queued:true`
// flag that may accompany it. Only a reply with NONE of those is a real queue.

/** True when a graph_run reply's top-level `error` channel is populated (an
 *  object with any keys, or a non-blank string). Empty object / "" / absent = no. */
function hasTopLevelError(error: unknown): boolean {
  if (typeof error === "string") return error.trim().length > 0;
  if (error != null && typeof error === "object") return Object.keys(error as object).length > 0;
  return false;
}

/** True when a graph_run reply's `node_errors` channel names at least one node. */
function hasNodeErrors(nodeErrors: unknown): boolean {
  return (
    nodeErrors != null &&
    typeof nodeErrors === "object" &&
    Object.keys(nodeErrors as object).length > 0
  );
}

/**
 * Format a ComfyUI /prompt rejection payload (the top-level `error` object plus
 * per-node `node_errors`) into a human-readable failure — the same shape the
 * #485 HTTP enqueue path surfaces, so panel_run and enqueue_workflow read alike.
 */
function formatRunRejection(payload: { error?: unknown; node_errors?: unknown }): string {
  let headline = "ComfyUI refused to queue the workflow";
  const topError = payload.error;
  const extraLines: string[] = [];
  if (topError && typeof topError === "object") {
    const te = topError as { type?: unknown; message?: unknown; details?: unknown };
    const msg = typeof te.message === "string" ? te.message.trim() : "";
    const type = typeof te.type === "string" ? te.type.trim() : "";
    if (msg) headline = `ComfyUI refused to queue the workflow: ${msg}${type ? ` (${type})` : ""}`;
    else if (type) headline = `ComfyUI refused to queue the workflow (${type})`;
    const details = typeof te.details === "string" ? te.details.trim() : "";
    if (details) extraLines.push(details);
  } else if (typeof topError === "string" && topError.trim()) {
    headline = `ComfyUI refused to queue the workflow: ${topError.trim()}`;
  }

  const lines: string[] = [...extraLines];
  const ne = payload.node_errors;
  if (ne && typeof ne === "object") {
    for (const [nodeId, info] of Object.entries(ne as Record<string, unknown>)) {
      const i = (info ?? {}) as { class_type?: unknown; errors?: unknown };
      const cls = typeof i.class_type === "string" ? i.class_type : "node";
      const errs = Array.isArray(i.errors) ? i.errors : [];
      if (errs.length === 0) {
        lines.push(`- ${cls} (node ${nodeId}): validation failed`);
        continue;
      }
      for (const e of errs as Array<{ message?: unknown; details?: unknown }>) {
        const detail = typeof e?.details === "string" && e.details ? ` (${e.details})` : "";
        const m = typeof e?.message === "string" ? e.message : "validation failed";
        lines.push(`- ${cls} (node ${nodeId}): ${m}${detail}`);
      }
    }
  }
  return lines.length ? `${headline}\n${lines.join("\n")}` : headline;
}

/**
 * Inspect a graph_run ToolResult and return a FAILURE ToolResult when the run
 * did NOT genuinely enter ComfyUI's queue, or `null` when it is a real queue
 * (so the caller may append the success/anti-poll guidance).
 *
 *  - An isError reply (no connected tab #331, a thrown app.queuePrompt #248, a
 *    transport drop) is passed through VERBATIM — its full detail/browser stack
 *    is preserved and the success-only "you'll be notified" note is NOT added.
 *  - A NON-error reply is parsed: a top-level `error`, a non-empty `node_errors`,
 *    or an explicit `queued:false` is surfaced as a formatted failure (#213) —
 *    even when a stale `queued:true` accompanies it.
 *  - Anything else (a plain `queued:true`, or an unparseable reply we must not
 *    regress) returns null and is treated as a genuine queue.
 */
/**
 * #944 — a `prompt_id` is not a flag, it is a RECEIPT.
 *
 * ComfyUI has a PARTIAL-validation path: when some output nodes fail validation
 * but at least one valid output remains, it drops the bad ones ("Output will be
 * ignored"), returns a prompt_id, and executes the rest. That reply carries
 * `node_errors` AND a prompt id at the same time.
 *
 * The #213 rule — node_errors means rejection, even alongside queued:true — read
 * that as a total refusal and reported "ComfyUI refused to queue the workflow"
 * for a render that was already running. The agent then diagnosed a live graph,
 * asked the user to mute a node mid-render, and twice tried to "retry"; only the
 * #556 graph-changed guard stopped it double-queueing a 20-minute video.
 *
 * `queued:true` is a flag the panel sets. A prompt_id is an identifier ComfyUI
 * MINTED, and it only mints one when it accepted the prompt — which is why this
 * overrides the flag-based rule and #213 does not regress: that reply had no
 * prompt id. The same asymmetry the retry guard already relies on.
 */
function acceptedPromptId(parsed: Record<string, unknown> | null): string | null {
  const pid = parsed?.prompt_id;
  return typeof pid === "string" && pid.trim() !== "" ? pid.trim() : null;
}

/**
 * EVERY prompt id a graph_run reply minted, first one first (#949).
 *
 * `batch_count > 1` makes the panel report `prompt_ids` for all N renders
 * alongside `prompt_id` for the first. Reading only `prompt_id` ticketed one run
 * and left 2..N uncorrelated, so their completions came back as "does NOT match
 * any run you queued … its origin is UNDETERMINED" — for runs the agent had just
 * queued itself.
 *
 * Deduped and order-preserving: `prompt_id` normally repeats the first entry of
 * `prompt_ids`, and a duplicate would open two tickets for one render.
 */
export function acceptedPromptIds(parsed: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const id = v.trim();
    if (id !== "" && !out.includes(id)) out.push(id);
  };
  add(parsed?.prompt_id);
  const many = parsed?.prompt_ids;
  if (Array.isArray(many)) for (const v of many) add(v);
  return out;
}

function detectRunRejection(res: ToolResult): ToolResult | null {
  // Bridge/transport/executor error: never a queue. Preserve it verbatim (#248),
  // no success note (#331). fail() already carries err.message (incl. any stack).
  if (res?.isError) return res;

  const parsed = parseToolResultJson(res);
  if (!parsed) return null; // unparseable non-error reply — don't regress a success

  const topError = parsed.error;
  const nodeErrors = parsed.node_errors;
  const rejected =
    hasTopLevelError(topError) || hasNodeErrors(nodeErrors) || parsed.queued === false;
  if (!rejected) return null; // genuine queue (queued:true / no rejection signal)

  const promptId = acceptedPromptId(parsed);
  if (promptId) {
    // THE #944 SHAPE, and only this shape: node_errors WITHOUT a top-level error
    // and without queued:false. That is literally what ComfyUI returns from its
    // partial-validation path (validate_prompt keeps the good outputs, so the
    // server answers 200 with prompt_id + node_errors and no `error` key). The
    // prompt is in the queue; the failing outputs were dropped, not refused.
    if (!hasTopLevelError(topError) && parsed.queued !== false) return null;

    // Anything else pairing a prompt id with a rejection is a CONTRADICTION, and
    // the two claims come from different places — the panel's own refusals (the
    // #556/#772 run-to-node race) are prose it wrote, while a prompt id may be a
    // field echoed from an earlier run. We cannot tell which is true, so we must
    // not assert either. Saying "refused" here would be the #944 lie in miniature;
    // saying "queued" would invite the caller to wait on a render that may not
    // exist. Report the conflict and send them to the queue to settle it.
    return fail(
      `${formatRunRejection({ error: topError, node_errors: nodeErrors })}\n\n` +
        `[UNCERTAIN] That rejection arrived in the SAME reply as a prompt id (${promptId}), and the two ` +
        `contradict each other — a prompt id normally means ComfyUI accepted the work. This tool cannot ` +
        `tell which is true, so it is not claiming either. Do NOT re-run: check queue (action:"list") and ` +
        `get_history first, because a render may already be in flight.`,
    );
  }

  return fail(formatRunRejection({ error: topError, node_errors: nodeErrors }));
}

/**
 * The disclosure for a run ComfyUI accepted while dropping some outputs (#944).
 * Returns null when nothing was dropped — a clean run says nothing extra.
 *
 * This has to be loud. The failure it replaces was loud and WRONG; a partial run
 * that stays silent would be the opposite error, letting the agent believe every
 * output is coming and wait for a file that will never be written.
 */
function describeDroppedOutputs(parsed: Record<string, unknown> | null): string {
  if (!parsed || !acceptedPromptId(parsed)) return "";
  // Mirrors detectRunRejection's acceptance test exactly: only the partial-
  // validation shape reaches the success path, so only it gets this note. A
  // reply that ALSO carried a top-level error was reported as UNCERTAIN and
  // never got here — describing it as an accepted-but-partial run would
  // contradict that.
  if (hasTopLevelError(parsed.error) || parsed.queued === false) return "";
  const ne = parsed.node_errors;
  if (!hasNodeErrors(ne)) return "";

  const lines: string[] = [];
  if (ne && typeof ne === "object") {
    for (const [nodeId, info] of Object.entries(ne as Record<string, unknown>)) {
      const i = (info ?? {}) as { class_type?: unknown; errors?: unknown };
      const cls = typeof i.class_type === "string" ? i.class_type : "node";
      const errs = Array.isArray(i.errors) ? i.errors : [];
      if (errs.length === 0) {
        lines.push(`- ${cls} (node ${nodeId}): validation failed`);
        continue;
      }
      for (const e of errs as Array<{ message?: unknown; details?: unknown }>) {
        const detail = typeof e?.details === "string" && e.details ? ` (${e.details})` : "";
        const m = typeof e?.message === "string" ? e.message : "validation failed";
        lines.push(`- ${cls} (node ${nodeId}): ${m}${detail}`);
      }
    }
  }
  return (
    `\n\n[PARTIAL] ComfyUI ACCEPTED this prompt and is running it, but it dropped ` +
    `${lines.length || "one or more"} output(s) that failed validation — its "Output will be ignored" path. ` +
    `The remaining outputs ARE executing.\n${lines.join("\n")}\n` +
    `Do NOT re-run and do NOT edit the graph to "fix" this right now: a render is IN FLIGHT, ` +
    `and ComfyUI has already excluded the failing output(s) itself. Expect no file from them. ` +
    `Repair them after this run finishes, or interrupt it deliberately with queue (action:"cancel").`
  );
}

/**
 * #772 — the ONE graph_run rejection that is explicitly safe to re-issue: the
 * run-to-node stamp race.
 *
 * A scoped (`to_node_id`) run is dispatched, then applied on a deferred tick. If
 * the graph changed in between, the panel refuses to run the modified graph under
 * a scope built for the old one AND refuses to fall through to a full-graph
 * execution (#556) — so it CERTIFIES that nothing entered the queue. That
 * certification is the whole basis for retrying: rebuilding the scope against the
 * graph as it is now is exactly what the caller would do by hand, and the caller
 * is currently made to do it by hand for a race they cannot see.
 *
 * FAILS CLOSED in every other direction, because a wrong "yes" here queues a
 * second render:
 *  - the reply must be a panel ANSWER (`!isError`). A transport error, a reply
 *    timeout, or a mid-command drop leaves the outcome UNKNOWN — the command may
 *    already be queued — and an unknown must never be retried;
 *  - the reply must PARSE. An unreadable reply is an unknown, not a clean queue;
 *  - STRUCTURED queue evidence VETOES the retry, and beats prose (codex gate).
 *    `detectRunRejection` classifies any non-empty `error` as a rejection even
 *    when the same reply carries `queued:true` (#213) — deliberately, because a
 *    stale success flag must not mask a validation failure. But for the RETRY
 *    decision that reply is the opposite case: an OBSERVED positive queue signal.
 *    "Nothing was queued" is prose the panel wrote; `queued:true` / a `prompt_id`
 *    is a fact it reported. A wrong "yes" here queues a second render, so any
 *    positive queue evidence wins and the run is never re-issued;
 *  - the text must then carry BOTH the race verdict and the explicit
 *    "Nothing was queued" certification. Either alone is not proof, so a future
 *    panel that drops the certification simply stops qualifying;
 *  - the caller must actually have sent a scoped run — checked at the call site
 *    from OUR OWN args, never inferred from panel prose.
 */
function isRetryableRunToNodeStampRace(res: ToolResult, rejection: ToolResult): boolean {
  if (res?.isError) return false; // outcome unknown — never retry
  const parsed = parseToolResultJson(res);
  if (!parsed) return false; // unreadable reply — an unknown, not a clean queue
  if (parsed.queued === true) return false; // observed queue evidence vetoes prose
  if (typeof parsed.prompt_id === "string" && parsed.prompt_id.trim() !== "") return false;
  const text = toolResultText(rejection);
  return (
    /workflow graph CHANGED after the run was queued/i.test(text) &&
    /Nothing was queued/i.test(text)
  );
}

export const __panelRunTestHooks = {
  detectRunRejection,
  formatRunRejection,
  isRetryableRunToNodeStampRace,
  describeDroppedOutputs,
};

/** Drop a trailing .json (case-insensitive) so filename/path forms compare equal. */
function stripJsonExt(s: unknown): string | null {
  return typeof s === "string" ? s.replace(/\.json$/i, "") : null;
}

/**
 * Does a panel-reported workflow identity correspond to `path`? This is an
 * additional wrong-workflow guard around an exact receipt rid; it is never used
 * alone to prove an open command happened.
 */
function activeMatchesTarget(active: unknown, path: string): boolean {
  if (!active || typeof active !== "object") return false;
  const a = active as { path?: unknown; filename?: unknown; key?: unknown };
  if (a.path === path || a.filename === path || a.key === path) return true;
  const want = stripJsonExt(path);
  if (want == null) return false;
  return stripJsonExt(a.filename) === want || stripJsonExt(a.path) === want;
}

/**
 * Exact saved-workflow identity for command-fence refreshes.  Unlike
 * activeMatchesTarget(), this deliberately does NOT accept a filename/basename:
 * a successful open of `workflows/a/foo.json` cannot safely adopt the UUID of
 * an active `workflows/b/foo.json`.  The panel's saved workflow routing key is
 * `wf:<canonical path>`, which is the only pathless fallback that is still an
 * exact identity.
 */
function activeMatchesOpenRefreshTarget(active: unknown, path: string): boolean {
  const targetIdentity = canonicalRequestedSavedIdentity(path);
  return !!targetIdentity && canonicalSavedRecordIdentity(active) === targetIdentity;
}

/**
 * #887 — THREE readings of the post-open active record, because
 * `activeMatchesOpenRefreshTarget` returning false is not one answer.
 *
 * That predicate is a UUID-adoption gate, and for adoption both "a different
 * workflow is active" and "I cannot tell what is active" correctly mean *do not
 * adopt*. Reusing it to WARN would be a different claim on the same evidence:
 * it returns false whenever `canonicalSavedRecordIdentity(active)` is null, which
 * includes an ordinary UNSAVED tab (`tmp:` routing keys are deliberately rejected
 * as saved identities). An open whose caller then has "Unsaved Workflow" active —
 * the single most common state there is — would raise a wrong-canvas alarm on
 * every call.
 *
 * So `different` is only returned when the panel POSITIVELY identified what is
 * active and it is not the target. An active record we cannot read at all stays
 * `indeterminate`, and the caller says nothing: unproven degrades to unknown,
 * never to the negative. That rule is why the previous attempt at this issue was
 * withdrawn, and it is the rule this module already states for every other
 * proof-of-sameness oracle.
 *
 * An unsaved tab IS a positive identification: a `tmp:` routing key cannot be the
 * saved workflow the caller named, so that case is genuinely `different` — but it
 * reaches that verdict by being READ, not by failing to canonicalize.
 */
export type OpenActiveReading = "same" | "different" | "indeterminate";

/** #887 — what the post-open corroborating read OBSERVED, when it contradicts the open. */
export type OpenDriftNotice = { drifted: true; activeLabel: string };

/**
 * Would this active record plausibly BE the requested workflow? Used only to
 * SUPPRESS a drift warning, never to prove sameness, so it is deliberately
 * generous: every normalization that could make two spellings the same file is
 * applied, and ties break toward silence. A miss here costs a warning we could
 * have given; a false positive here FAILS a healthy open, which is far worse.
 *
 * `activeMatchesTarget` alone is not enough — it is raw string equality, so
 * `./workflows/a.json`, `workflows\a.json` and `Workflows/A.json` all read as
 * different files from `workflows/a.json`. This file already warns against
 * exactly that conflation for the recovery path. Case folding is safe HERE
 * (and only here) because the generous direction is the silent one.
 */
function plausiblySameSavedWorkflow(active: unknown, path: string): boolean {
  if (activeMatchesTarget(active, path)) return true;
  if (!active || typeof active !== "object") return false;
  const want = canonicalSavedWorkflowPath(path);
  if (!want) return false;
  const fold = (s: string) => s.toLowerCase();
  const wantFolded = fold(want);
  const wantNoExt = stripJsonExt(wantFolded);
  const a = active as { path?: unknown; filename?: unknown; key?: unknown };
  for (const raw of [a.path, a.filename, a.key]) {
    const got = canonicalSavedWorkflowPath(raw);
    if (!got) continue;
    const gotFolded = fold(got);
    if (gotFolded === wantFolded) return true;
    if (wantNoExt !== null && stripJsonExt(gotFolded) === wantNoExt) return true;
  }
  return false;
}

export function readOpenActiveAgainstTarget(
  active: unknown,
  path: string,
  activeConfirmed?: unknown,
): OpenActiveReading {
  // #433/#3014 — `active_confirmed:false` is the panel telling us this value is
  // untrustworthy. It is already refused as adoption evidence; it cannot be
  // better evidence for failing an open than it is for stamping one.
  if (activeConfirmed === false) return "indeterminate";
  if (activeMatchesOpenRefreshTarget(active, path)) return "same";
  if (!canonicalRequestedSavedIdentity(path)) return "indeterminate"; // our own side is unreadable
  if (!active || typeof active !== "object") return "indeterminate";
  // The STRICT gate above failing is not enough to warn. It requires a canonical
  // saved identity on both sides, and it refuses a record whose routing_key is
  // absent, replayed, or malformed (#716 P1) — even when that record's PATH is the
  // very workflow we opened. Declining to adopt a uuid on that evidence is right;
  // telling the caller a different canvas is mounted would be a false alarm on the
  // same workflow.
  if (plausiblySameSavedWorkflow(active, path)) return "indeterminate";
  const a = active as { path?: unknown; filename?: unknown; key?: unknown };
  const identified =
    (typeof a.path === "string" && a.path !== "") ||
    (typeof a.filename === "string" && a.filename !== "") ||
    (typeof a.key === "string" && a.key !== "");
  return identified ? "different" : "indeterminate";
}

/**
 * #887 — observe what is active after an open, WITHOUT adopting anything.
 *
 * Split out of `refreshOpenWorkflowUuid` because the two questions have different
 * preconditions. Adoption is gated on the open reply corroborating the requested
 * identity — a reply that cannot prove which workflow it opened must never
 * authorize a fence refresh. Pure observation needs none of that: "what does the
 * panel say is active right now" is answerable regardless of what the open replied,
 * and on the path that matters most the open reply is an ERROR carrying no JSON at
 * all. Requiring corroboration there is what kept the reporter's own case
 * unexamined.
 */
/**
 * #1337 — CLEAR THE FENCE ON THE VERDICT THAT PROVED IDENTITY.
 *
 * A reporter's session lost the canvas permanently: every graph call refused with
 * `workflow instance mismatch`, and the one fence-EXEMPT recovery could not clear it.
 *
 * `workflow_open` re-derives the fence only on its success branch. The verdict
 *
 *   "workflow_open RAN and the canvas IS bound to X — that much was proven — but the
 *    graph on it does not match the state that was loaded … You are NOT on the wrong
 *    workflow: X IS the active one."
 *
 * is delivered as an ERROR, so control never reaches the re-derivation. That mismatches
 * two different levels: the verdict asserts IDENTITY was proven, and what it withholds
 * is CONTENT (frontend normalisation vs a partial load). Applying content-level
 * uncertainty to an identity-level fence is what leaves the session with no in-band
 * recovery — the only remaining move is a browser reload, which destroys unsaved work.
 *
 * MEASURED, because the comment that justified the old behaviour asserts otherwise:
 *   • the panel really does publish NO workflow_uuid on this reply (its own
 *     FENCE_NOT_REFRESHED text), so there is nothing to adopt FROM THE REPLY — true;
 *   • but `workflow_list` IS fence-exempt (commandIsCanvasTargetless in the panel's
 *     workflow-chat-identity.js), and the panel's own recovery text names
 *     panel_list_workflows as "exempt from the fence" and says it "republishes the
 *     active identity". So the fence CAN be re-derived here; nothing tried.
 *
 * This runs that exempt re-derivation and reports what it achieved. The open still
 * FAILS — the content warning is preserved verbatim, because "re-read before editing"
 * is still the right instruction — and nothing is adopted on the UNPROVEN verdict,
 * where identity itself is in doubt.
 *
 * #1639 — IDENTITY CLAIM IS NOT CONTENT. The #1337 re-derivation assumed that
 * "the canvas IS bound to X" meant later graph reads would show X. A later session
 * showed the opposite: workflow_list / this verdict named B, FENCE: CLEARED, and
 * both panel_graph_outline and panel_query_graph then returned the PREVIOUS
 * workflow as ordinary successes. Clearing the fence on an identity claim is what
 * turns a wrong-graph read into a trusted one. So this path now probes the live
 * graph UNDER THE EXISTING FENCE first:
 *   - the read SUCCEEDS → the canvas still answers as the previous workflow.
 *     Do not re-derive. Contradict "you are on the right workflow".
 *   - the read is refused with `workflow instance mismatch` → the canvas identity
 *     actually moved. That is the #1337 wedge; re-derive as before.
 *   - the read does not come back → content is unverified. Do not re-derive.
 */
type LiveGraphUnderFence =
  | { status: "answered" }
  | { status: "mismatch_refused" }
  | { status: "unanswered"; detail: string };

async function probeLiveGraphUnderCurrentFence(ctx: PanelToolCtx): Promise<LiveGraphUnderFence> {
  // `fields:"ids", limit:1` is the cheapest shape that still has to pass the
  // instance fence — we only need whether the canvas STILL ACCEPTS this session's
  // stamp, not the graph itself.
  let res: ToolResult;
  try {
    res = await ctx.call({ cmd: "graph_query", fields: "ids", limit: 1 }, 8000);
  } catch (err) {
    if (isWorkflowInstanceMismatch(err)) return { status: "mismatch_refused" };
    return { status: "unanswered", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!res?.isError) return { status: "answered" };
  const text = toolResultText(res);
  if (isWorkflowInstanceMismatch(text)) return { status: "mismatch_refused" };
  // An acked executor error still means the fence passed — the canvas is the
  // one this session was already bound to.
  if (isPanelAnsweredResult(res)) return { status: "answered" };
  return { status: "unanswered", detail: text };
}

function identityClaimedContentUnverifiedNote(detail: string): string {
  const busy = queueBusyTimeoutNote();
  return (
    `\n\nFENCE: NOT cleared (live graph unread). The panel asserted the canvas IS bound to the ` +
    `requested workflow, but a live graph read did not come back (${detail || "no reason was reported"}), ` +
    `so content is UNVERIFIED. Identity-matched is not content-matched: do NOT trust ` +
    `"you are on the right workflow" / "You are NOT on the wrong workflow". Do NOT edit or save ` +
    `expecting the opened file. Retry the graph read (panel_graph_outline) once the tab answers.` +
    busy
  );
}

type OpenIdentityRebind =
  | { status: "rebound"; destPath: string; destUuid?: string; restoredWidgets: number }
  | { status: "skipped" };

/**
 * #1710 — restamp extra.comfyui_mcp onto the dest the tab is already bound to,
 * and copy dest-file promoted widgets onto any live empty slots.
 *
 * Fail-closed: dest file unreadable, node-set mismatch, or a non-empty live
 * widget that disagrees with dest (#1639 previous graph) leaves extra alone.
 */
async function tryRebindConfirmedOpenIdentity(
  ctx: PanelToolCtx,
  destPath: string,
): Promise<OpenIdentityRebind> {
  let live: Record<string, unknown> | null = null;
  try {
    const serialized = await ctx.call({ cmd: "graph_serialize" }, 8000);
    live = workflowFromSerializeReply(parseToolResultJson(serialized));
  } catch {
    return { status: "skipped" };
  }
  if (!live) return { status: "skipped" };

  let dest: Record<string, unknown>;
  try {
    dest = await readWorkflowFromPath(destPath);
  } catch {
    return { status: "skipped" };
  }
  if (!shouldRebindOpenIdentity({ live, dest, destPath })) return { status: "skipped" };

  const destUuid = await activeWorkflowUuidForPath(ctx, destPath);
  const { graph, restoredWidgets } = patchOpenIdentity(live, dest, destPath, destUuid);
  const loaded = await ctx.call({ cmd: "graph_load", graph }, 30000);
  if (loaded.isError) return { status: "skipped" };
  if (destUuid) refreshWorkflowUuid(ctx, { workflow_uuid: destUuid });
  return { status: "rebound", destPath, destUuid, restoredWidgets };
}

async function activeWorkflowUuidForPath(ctx: PanelToolCtx, destPath: string): Promise<string | undefined> {
  try {
    const list = parseToolResultJson(await ctx.call({ cmd: "workflow_list" }, 6000));
    if (!list) return undefined;
    if (readOpenActiveAgainstTarget(list.active, destPath, list.active_confirmed) !== "same") {
      return undefined;
    }
    return responseWorkflowUuid(list.active);
  } catch {
    return undefined;
  }
}

async function activeSavedPath(ctx: PanelToolCtx): Promise<string | undefined> {
  try {
    const list = parseToolResultJson(await ctx.call({ cmd: "workflow_list" }, 6000));
    const path = isPlainObject(list?.active) ? list.active.path : undefined;
    return typeof path === "string" && path ? path : undefined;
  } catch {
    return undefined;
  }
}

function openedIdentityReboundResult(
  destPath: string,
  rebound: Extract<OpenIdentityRebind, { status: "rebound" }>,
): ToolResult {
  return ok({
    opened: { path: destPath },
    identity_rebound: true,
    restored_promoted_widgets: rebound.restoredWidgets,
    note:
      `Opened ${destPath}. Frontend-normalized presentation/widget fields differed after load; ` +
      `extra.comfyui_mcp.workflow_path/workflow_uuid were rebound to this workflow so a later ` +
      `save will not refuse a source-stamp mismatch.` +
      (rebound.restoredWidgets > 0
        ? ` Restored ${rebound.restoredWidgets} empty promoted widget value(s) from the saved graph.`
        : ""),
  });
}

function identityClaimedButLiveGraphUnchangedNote(ctx: PanelToolCtx): string {
  const fence = currentWorkflowFence(ctx);
  const fenceTxt =
    fence.known && fence.uuid
      ? `under this session's existing fence (${fence.uuid})`
      : `without being refused by a workflow-instance fence`;
  return (
    `\n\nFENCE: NOT cleared (live graph still answers). CONTENT MISMATCH: the panel asserted the ` +
    `canvas IS bound to the requested workflow, but a live graph read still answers ${fenceTxt} — ` +
    `the graph on screen is the PREVIOUS workflow, not the one just opened. That is the failure ` +
    `the fence exists to prevent: clearing it here would let later reads of this graph succeed ` +
    `as if they were the opened file. Do NOT trust "you are on the right workflow" / ` +
    `"You are NOT on the wrong workflow". Do NOT edit or save expecting the opened file. ` +
    `Read the graph (panel_graph_outline) to see what is actually open, then retry ` +
    `panel_open_workflow or panel_load_workflow if the canvas did not switch.`
  );
}

async function clearFenceOnIdentityProvenOpen(
  ctx: PanelToolCtx,
  res: ToolResult,
  requestedPath?: string,
): Promise<{ res: ToolResult; repaired: boolean }> {
  const text = toolResultText(res);
  // ONLY the class that states identity was proven. The UNPROVEN verdict ("could not
  // prove that the active canvas was rebound") must keep failing closed: re-deriving a
  // fence onto a canvas we cannot identify is how an edit lands on the wrong graph.
  if (!/the canvas IS bound to/i.test(text)) return { res, repaired: false };

  const canvas = await probeLiveGraphUnderCurrentFence(ctx);
  if (canvas.status === "answered") {
    // #1710 — the old stamp still answering is ALSO what a save-as copy looks
    // like: dest tab, dest nodes, extra.comfyui_mcp still naming the source.
    // Confirm dest file content before touching extra (#1639 stays fail-closed).
    if (requestedPath) {
      const rebound = await tryRebindConfirmedOpenIdentity(ctx, requestedPath);
      if (rebound.status === "rebound") {
        return { res: openedIdentityReboundResult(requestedPath, rebound), repaired: true };
      }
    }
    return { res: appendToolResultText(res, identityClaimedButLiveGraphUnchangedNote(ctx)), repaired: false };
  }
  if (canvas.status === "unanswered") {
    return { res: appendToolResultText(res, identityClaimedContentUnverifiedNote(canvas.detail)), repaired: false };
  }

  let note: string;
  // #1560 — reported STRUCTURALLY, never re-read out of the sentence below. The caller
  // uses this to decide whether a "the channel is not answering" note would contradict
  // the line above it, and a prose predicate over our own wording is exactly the
  // coupling that rots the first time someone edits the message.
  let repaired = false;
  try {
    const rebind = await rebindWorkflowFence(ctx);
    repaired = rebind.status === "refreshed" || rebind.status === "already_current";
    note =
      rebind.status === "refreshed" || rebind.status === "already_current"
        ? `\n\nFENCE: CLEARED. This reply published no workflow_uuid, so the fence was re-derived ` +
          `from the panel's own fence-EXEMPT workflow_list read instead — the active identity is ` +
          `${rebind.uuid}, and graph commands from this session are stamped with it again. You do ` +
          `NOT need to reload the browser tab, and no unsaved canvas work is at risk. The content ` +
          `warning above still stands: re-read the graph before editing.`
        : `\n\nFENCE: NOT cleared (${rebind.status}). The re-derivation was attempted — the panel ` +
          `publishes no workflow_uuid on this verdict, so the fence-exempt workflow_list read is ` +
          `the only way to refresh it — and it did not establish an identity. Graph commands stay ` +
          `refused. Try panel_list_workflows directly; if that also fails, the panel tab is the ` +
          `thing to fix.`;
  } catch (err) {
    note =
      `\n\nFENCE: NOT cleared — the re-derivation threw, so the fence state is UNKNOWN and graph ` +
      `commands may still be refused. (${err instanceof Error ? err.message : String(err)})`;
  }
  return { res: appendToolResultText(res, note), repaired };
}

/**
 * #1560 — what the post-open exempt read ACTUALLY observed, kept as three answers
 * rather than one nullable notice.
 *
 * The old shape returned `OpenDriftNotice | null`, and `null` carried two facts that
 * want opposite remedies: "asked, and nothing has drifted" and "asked, and the panel
 * never came back". The second was swallowed with the comment *"could not ask —
 * nothing was observed, so nothing is claimed"* — true about the WORKFLOW, and it
 * threw away a measurement about the CHANNEL that was the reporter's whole answer.
 */
type OpenActiveProbe =
  /** The panel answered, and names a DIFFERENT workflow as active. */
  | { status: "different"; activeLabel: string }
  /** The panel answered; the active record is this target, or unreadable enough that
   *  nothing may be claimed about it. Says nothing about the channel — it works. */
  | { status: "quiet" }
  /** The read did NOT come back. `detail` is the failure verbatim, so the note quotes
   *  a measurement rather than paraphrasing one. */
  | { status: "unanswered"; detail: string };

async function observeActiveAfterOpen(
  ctx: PanelToolCtx,
  requestedPath: string,
): Promise<OpenActiveProbe> {
  let list: Record<string, unknown> | null = null;
  try {
    const res = await ctx.call({ cmd: "workflow_list" }, 6000);
    // NOT EVERY `isError` IS A SILENCE (review, P1). The first version of this read
    // every failed read as "the panel never came back", and an ACKNOWLEDGED panel
    // error is `isError` too — the tab received the command, ran its gate and replied
    // refusing it. Labelling that `NOT ANSWERING` states the opposite of what was
    // observed and hands the user a hard-refresh for a tab that is working, which is
    // this bug's own failure mode pointed the other way.
    //
    // The two are told apart STRUCTURALLY, at the bridge branch that receives the
    // reply — never from the message, which is arbitrary panel text and is
    // TRANSLATED, so a wording rule would answer wrongly in eleven of twelve locales.
    // Absence of the mark is the honest default: a timeout, a routing refusal and a
    // dead socket all mint no reply, and so does a panel too old to be marked at all.
    if (res?.isError) {
      // It answered. That says nothing about this workflow — same silence as a reply
      // that arrived and did not parse, below — but it does refute a channel claim.
      if (isPanelAnsweredResult(res)) return { status: "quiet" };
      return { status: "unanswered", detail: toolResultText(res) };
    }
    list = parseToolResultJson(res);
  } catch (err) {
    // BELT AND BRACES, and stated as such rather than dressed up as a guard: `ctx.call`
    // converts a bridge throw into an `isError` ToolResult and does not rethrow, so on
    // today's code this arm cannot be reached — the branch above is what fires for the
    // reporter's timeout. It is kept (a) because the pre-existing code had a catch here
    // and removing it would let a future throw escape a tool handler instead of
    // degrading, and (b) because if it ever DOES fire, "the read did not come back" is
    // the true statement, not silence. A mutation of this line therefore survives by
    // construction, not for want of a test.
    return { status: "unanswered", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!list) return { status: "quiet" };
  if (readOpenActiveAgainstTarget(list.active, requestedPath, list.active_confirmed) !== "different") {
    return { status: "quiet" };
  }
  return { status: "different", activeLabel: describeActiveRecord(list.active) };
}

/**
 * #1560 — THE SILENCE IS THE ANSWER.
 *
 * The reporter called `panel_open_workflow`, got the UNPROVEN verdict, watched every
 * `panel_*` graph call refuse with `workflow instance mismatch`, ran
 * `panel_set_workflow_target({mode:"current"})` (the documented recovery, which reported
 * "the panel did not answer"), and then retried `panel_open_workflow` TWICE more —
 * because nothing had told them the retries could not work.
 *
 * This process already knew. `observeActiveAfterOpen` had just sent a `workflow_list`,
 * which is the read the fence EXEMPTS, and it had not come back. That failure
 * discriminates the two situations the reporter could not tell apart:
 *
 *  - `mode:"current"` re-derives through `rebindWorkflowFence`, whose ONLY probe is its
 *    own `workflow_list` round trip. It reads the channel that just failed, so it is not
 *    a different thing to try.
 *  - `workflow_open` is fence-exempt, but exemption is about the STAMP, not the socket.
 *    A retry still needs the panel to answer.
 *
 * WHAT IT MAY NOT SAY. One bounded read failed. That is not permanence: a tab still
 * reconnecting after a ComfyUI restart answers late and the session recovers by itself.
 * The note reports the reading and the retry, and only then names the tab as the thing
 * to fix — it never asserts the panel is gone, and it never touches the fence.
 *
 * IT DELIBERATELY DOES NOT CARRY `panelTooOldNote`, even though #1560's reporter WAS on
 * an old panel (0.11.37). That note diagnoses a panel that ANSWERS while publishing no
 * `workflow_uuid`, and says "if it IS below {needed}, that is the whole cause of this
 * failure". Here nothing answered at all — a current 0.14.x panel behind a closed or
 * wedged tab produces this identical silence — so appending it would name a cause this
 * observation cannot support. Review already caught that direction once on this note
 * (`panel_set_workflow_target`), and the reasoning is the same.
 */
function panelChannelSilentNote(detail: string): string {
  return (
    `\n\nPANEL CHANNEL: NOT ANSWERING. Right after this open, a \`workflow_list\` read was sent — ` +
    `the one read this session's workflow fence EXEMPTS — and it did not come back: ` +
    `${detail || "no reason was reported"}. That is a measurement about the CHANNEL, not about ` +
    `this workflow, and it is what tells the two remaining moves apart:\n` +
    `  • panel_set_workflow_target({mode:"current"}) — the documented recovery — re-derives the ` +
    `fence from its own \`workflow_list\` round trip. It reads the same channel that just failed, ` +
    `so expect it to fail the same way; it is not a different thing to try.\n` +
    `  • Retrying panel_open_workflow does not help either. The open is exempt from the FENCE, ` +
    `not from needing an answer, and it did not get one.\n` +
    `WHAT THIS DOES NOT ESTABLISH: one bounded read failed, which is not evidence that the panel ` +
    `is permanently gone. A tab still reconnecting after a ComfyUI restart or reload answers late ` +
    `and recovers on its own — so retry ONCE, a few seconds from now. If it is still silent, the ` +
    `panel JS running in the open browser tab is the thing to fix: HARD-REFRESH the ComfyUI tab ` +
    `(Ctrl+Shift+R). Restarting ComfyUI alone does NOT do it, and a ComfyUI-Manager pack update ` +
    `that reported FAILED leaves the previous panel JS live in the tab that is already open.`
  );
}

/**
 * Human-readable name for whatever the panel says is active, for the #887 warning.
 *
 * PATH FIRST, deliberately. The case this guard exists for is a same-basename
 * workflow in another directory, and naming it by its bare `filename` produces a
 * sentence that refutes itself — "workflows/a/foo.json was opened, but foo.json is
 * active now" reads as the same file. The directory IS the distinguishing
 * information. `title` precedes the bare filename for the unsaved case, where the
 * panel puts the human label there and leaves path/filename null.
 */
export function describeActiveRecord(active: unknown): string {
  if (!active || typeof active !== "object") return "another workflow";
  const a = active as { path?: unknown; filename?: unknown; key?: unknown; title?: unknown };
  for (const v of [a.path, a.title, a.filename, a.key]) {
    if (typeof v === "string" && v !== "") return v;
  }
  return "another workflow";
}

/** Normalizes only syntax the panel's saved-path/routing identity normalizes. */
function canonicalSavedWorkflowPath(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  // `tmp:<uuid>` is a per-tab ephemeral routing handle, never a saved workflow
  // path. `wf:<path>` is likewise a routing token, not a path; accepting either
  // here could manufacture `wf:tmp:…` and refresh a durable command fence.
  if (!normalized || /^(?:tmp:|wf:)/i.test(normalized)) return null;
  return normalized;
}

interface OpenVerifyTiming {
  /** Total wall-clock budget to confirm the target became active. */
  budgetMs: number;
  /** Interval between `workflow_list` probes. */
  intervalMs: number;
  /** Per-probe timeout for the `workflow_list` round-trip. */
  probeTimeoutMs: number;
}

let openVerifyTimingOverride: OpenVerifyTiming | null = null;

function getOpenVerifyTiming(): OpenVerifyTiming {
  if (openVerifyTimingOverride) return openVerifyTimingOverride;
  return {
    budgetMs: Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_OPEN_VERIFY_BUDGET_S", 6) * 1000),
    intervalMs: Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_OPEN_VERIFY_INTERVAL_S", 1) * 1000),
    probeTimeoutMs: Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_OPEN_VERIFY_PROBE_S", 4) * 1000),
  };
}

interface OpenVerifyResult {
  receipt: "applied" | "not_applied" | "unknown" | "unsupported" | "missing";
  error?: string;
  /**
   * #716 — only populated when this exact open receipt is applied AND the
   * currently-active workflow still matches its resolved target.  A late receipt
   * for an older open must never refresh the command fence for a newer canvas.
   */
  workflowUuid?: string;
  waited_ms: number;
  attempts: number;
}

// Strict canonical RFC UUID for a command-fence refresh: lowercase only, an
// assigned RFC version, and the RFC variant. Do not normalize this transport
// value — an uppercase or malformed producer value must leave the prior fence.
// Keep this check at the command-response boundary: a missing, malformed, or
// old-panel response must leave the existing command fence intact, never turn
// a graph mutation into an unstamped send.
const WORKFLOW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function responseWorkflowUuid(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as { workflow_uuid?: unknown }).workflow_uuid;
  if (typeof raw !== "string") return undefined;
  return WORKFLOW_UUID_RE.test(raw) ? raw : undefined;
}

/** Refresh only the bridge-owned command stamp, never caller data. */
function refreshWorkflowUuid(ctx: PanelToolCtx, value: unknown): boolean {
  const uuid = responseWorkflowUuid(value);
  const refresh = (ctx.bridge as unknown as { refreshWorkflowUuid?: unknown }).refreshWorkflowUuid;
  return uuid && typeof refresh === "function" ? refresh.call(ctx.bridge, ctx.tabId, uuid) : false;
}

/**
 * #814 — workflow_new and workflow_save/workflow_save_as all re-point the active
 * workflow, and each of their handlers repairs the session's command fence by
 * calling `rebindWorkflowFence(ctx)` unconditionally — a GENERIC re-derivation
 * that makes its OWN independent `workflow_list` round trip and has no access to
 * the command's own reply. That read is refused by the exact fence this whole
 * flow exists to repair (#1071), and the only remaining recovery
 * (`unreadableOrHealed`'s check for the panel's async hello re-advertise) is
 * timing-dependent — a reporter hit exactly this: the save reply already proved
 * the new uuid, and the very next command still failed with
 * root-workflow-uuid-mismatch.
 *
 * Each of these replies ALREADY carries `workflow_uuid` directly (#762 for
 * workflow_new, #800 for workflow_save/save_as), published only after the
 * panel's own FINAL SYNCHRONOUS check that this target is still the active
 * workflow — the identical proof `workflow_open`'s reply carries, which
 * `refreshOpenWorkflowUuid` already trusts as a fallback. Trust it FIRST here
 * too, before ever attempting the round trip that can be refused.
 *
 * No corroboration gate is needed (unlike workflow_open, which must verify the
 * reply's identity against a caller-supplied path): there is no caller target to
 * corroborate against — this session's own tab just performed the operation that
 * produced this exact reply.
 *
 * Returns null when the reply carries no adoptable uuid (an older panel build,
 * or the panel's own check could not prove it — #716's fail-closed omission), so
 * the caller falls back to the EXISTING rebindWorkflowFence(ctx) round trip
 * completely unchanged.
 */
function refreshFenceFromOwnReply(ctx: PanelToolCtx, reply: ToolResult): WorkflowFenceRebind | null {
  const before = currentWorkflowFence(ctx);
  const parsed = parseToolResultJson(reply);
  if (!parsed) return null;
  const uuid = responseWorkflowUuid(parsed);
  if (!uuid) return null;
  try {
    return refreshWorkflowUuid(ctx, parsed) ? { status: "refreshed", uuid, before } : null;
  } catch {
    return null; // never surface a throw here as worse than the existing fallback
  }
}

/**
 * The stamp currently fencing this session's tab — TRI-STATE, because reading it
 * is itself an operation that can fail (codex gate).
 *
 *  - `{ known: true, uuid }` — there IS a fence, and this is it.
 *  - `{ known: true }`       — there is definitively NO fence.
 *  - `{ known: false }`      — we could not find out: this bridge has no accessor,
 *                              or the resolver threw and the guard swallowed it.
 *
 * Collapsing the third into the second is exactly the fold this cluster is about.
 * It made a failed read render as "it has no graph command fence" — an absence
 * nobody observed. Never throws.
 */
type FenceRead = { known: true; uuid?: string } | { known: false };

function currentWorkflowFence(ctx: PanelToolCtx): FenceRead {
  const read = (ctx.bridge as unknown as { workflowUuidFor?: unknown }).workflowUuidFor;
  if (typeof read !== "function") return { known: false };
  try {
    const out = read.call(ctx.bridge, ctx.tabId) as unknown;
    // The bridge answers TRI-STATE (TabWorkflowUuidRead). Preserve it: swallowing
    // its `known:false` back into an absent fence here would undo the whole point,
    // since the bridge is the only thing that can see the stamp.
    if (out && typeof out === "object" && "known" in out) {
      const r = out as { known: unknown; uuid?: unknown };
      if (r.known !== true) return { known: false };
      return { known: true, uuid: typeof r.uuid === "string" && r.uuid.length > 0 ? r.uuid : undefined };
    }
    // A lightweight/legacy stub that still returns a bare string|undefined: a
    // string is a fence; anything else is NOT evidence of absence, only of a
    // shape we cannot interpret.
    return typeof out === "string" && out.length > 0 ? { known: true, uuid: out } : { known: false };
  } catch {
    return { known: false };
  }
}

// ---- #770/#803/#716 — re-deriving the command fence from the LIVE canvas ------
//
// The per-command workflow stamp (#570) is set from a tab's HELLO. For a
// `mode:"current"` session that hello is the ONLY moment it is ever refreshed —
// and a hello is not the only way the active canvas can change identity. A
// workflow replaced in place on a still-open socket, a frontend soft reload, or a
// reconnect that re-registers under a DIFFERENT routing key all give the canvas a
// new workflow uuid with no new hello for the key this session holds. The stamp
// then names a workflow instance that no longer exists, the panel's fence
// correctly refuses every stamped command, and NOTHING in the orchestrator could
// replace it: the open/pin refresh paths (#716) require a caller-supplied SAVED
// path to corroborate, so they cannot fire for `mode:"current"` at all, and
// cannot fire for an UNSAVED (`tmp:`) canvas under any mode. That is the wedge —
// and it is why the recovery the error text prescribed could not recover.
//
// This is the one place that answers the question `mode:"current"` actually asks
// — "bind me to whatever workflow is live NOW" — by reading the panel's own
// authoritative active record. It needs no CALLER-PATH corroboration, because
// there is no caller-supplied target to corroborate: the live active canvas IS
// the target. That is also why it works for an unsaved canvas.
//
// But it DOES need RECORD corroboration, which is a different axis and was the
// gate's P0 (see corroborateActiveForFence). "The caller named no target" does
// not imply "any active record the reply happens to carry describes this tab".
// A stale or mixed workflow_list can hand back another canvas's perfectly valid
// uuid; adopting it would overwrite this tab's stamp, wedge the next command,
// and report `bound` while doing so.
//
// It does NOT weaken #570. The fence still fails closed for every command issued
// AFTER this point: if the user switches again, the next command carries what
// this call adopted and the panel refuses it, exactly as before. All that changes
// is that an explicit, user-initiated "follow what's live" can now actually
// re-point the fence.

/**
 * The DISTINCT answers to the distinct questions a fence rebind asks.
 * Deliberately not one boolean: "could not read the identity" is not "the
 * identity is unchanged", and neither is "there was no fence to begin with".
 * Folding them is what produced a tool reporting success while the session
 * stayed wedged (#803 step 7).
 */
export type WorkflowFenceRebind =
  /** Read the live identity; it differed from the stamp and has REPLACED it. */
  | { status: "refreshed"; uuid: string; before: FenceRead }
  /** #1646 — a READ-ONLY probe (`adopt:false`) found the live identity differs
   *  from the fence and deliberately did NOT adopt it: a mismatch diagnosis
   *  must never re-point mutation routing on its own authority. */
  | { status: "diverged"; uuid: string; before: FenceRead }
  /** Read the live identity; the stamp already named it. Nothing to repair. */
  | { status: "already_current"; uuid: string; before: FenceRead }
  /** The panel did not answer, or its reply was not readable. Unknown, not "fine". */
  | { status: "unreadable"; before: FenceRead; detail: string }
  /** The panel answered, but no usable identity could be adopted from it. TWO
   *  different facts with different remedies, so they are discriminated rather
   *  than bucketed: `no_uuid` = this panel build exposes no workflow identity at
   *  all (a cached/older bundle — updating it is the fix); `uncorroborated` = it
   *  DOES report one, but the reply did not hang together well enough to prove
   *  the record describes the live canvas (a stale/mixed snapshot — retrying is
   *  the fix). Telling a user to update a current panel would be as unactionable
   *  as telling them to retry a build that will never answer. */
  | {
      status: "no_identity";
      before: FenceRead;
      kind: "no_uuid" | "uncorroborated";
      why: string;
      /** #1292 — how hard we already tried, so the remedy can stop telling a
       *  caller to do the thing this function just did. Present only on the
       *  `uncorroborated` path, which is the one that rechecks. `settles` is
       *  whether waiting could EVER have helped: false means the reply's SHAPE
       *  is wrong (an older build sends no open-workflow list), and telling that
       *  caller to try again in a moment is advice that can never come true. */
      rechecks?: { attempts: number; waitedMs: number; settles: boolean };
      /** #1401 — the uuid the panel reported but could not corroborate. NOT
       *  adopted, and never treated as the live identity; used only so the
       *  message can stop asserting certain failure when it EQUALS the fence
       *  this session already holds. */
      seenUuid?: string;
    }
  /** A live identity was read, but the bridge declined to adopt it (the tab stopped
   *  being reachable, or the uuid failed the orchestrator's shape/origin check).
   *  A clean `false` — nothing was written. `refusalReason` names WHICH of the
   *  validator's three gates tripped when the bridge can tell us (#1077); absent
   *  on an older bridge, which is why the remedy below must still stand alone. */
  | { status: "rejected"; uuid: string; before: FenceRead; refusalReason?: string }
  /** Our read was refused, but the fence CHANGED underneath us while we asked —
   *  the panel's mismatch re-hello re-advertised its identity and the hello
   *  handler adopted it (#1043/#932). The session is bound again, just not by us. */
  | { status: "healed_by_panel"; uuid: string; before: FenceRead }
  /** The adoption itself THREW. Distinct from `rejected` (codex gate): a refusal
   *  proves the old fence is untouched, whereas a throw can land on either side
   *  of the write, so whether the fence changed is UNKNOWN and must not be
   *  described either way. */
  | { status: "adopt_error"; uuid: string; before: FenceRead; detail: string };

/**
 * Is this `workflow_list` reply's top-level `active` record CORROBORATED — i.e.
 * does the panel's own open-workflow list agree that this record describes the
 * canvas that is live right now?
 *
 * THE RULE THIS RESTORES (independent gate, P0). `resolveOpenWorkflow` already
 * decided that an uncorroborated top-level `active` object "may remain a
 * compatibility-valid pin selector, but is never a safe source for replacing a
 * command fence". The first version of the rebind bypassed that rule, reasoning
 * that `mode:"current"` has no caller-supplied target to corroborate against.
 * That was right about the CALLER and wrong about the axis. The question a fence
 * adoption asks is not "did the caller name a target we must check", it is
 * "does this record describe the canvas we are about to stamp" — and a MIXED or
 * STALE reply answers that wrongly no matter what the caller asked for. Adopting
 * another canvas's valid uuid passes the shape/origin validator, overwrites this
 * tab's stamp, and gets reported as `bound`: a fresh wedge, announced as a
 * recovery. That is strictly worse than the wedge this PR exists to fix.
 *
 * FAILS CLOSED. Anything that cannot be positively corroborated returns a reason
 * and the caller lands in `no_identity`, which already says honestly that the
 * fence was not replaced and names what to do. A recovery that declines is fine.
 */
function corroborateActiveForFence(
  parsed: Record<string, unknown>,
):
  | { ok: true; active: Record<string, unknown> }
  /** `settles` — could a LATER read of the same panel answer differently? #1292
   *  rechecks, and rechecking a fact that cannot change only makes the same
   *  error slower. A SNAPSHOT fact (what is open, which entry is flagged, whether
   *  the panel has finished confirming) settles; a SHAPE fact (this build does
   *  not send a `workflows` array; these records share no comparable identity
   *  field) does not, no matter how long anyone waits. */
  /** `seenUuid` — the identity the panel REPORTED for the active canvas, when it
   *  reported one at all. Deliberately kept on the FAILURE path (#1401): it must
   *  never be adopted, but it is the only thing that can tell "we could not
   *  confirm the canvas" apart from "the canvas is a different one". A caller
   *  whose preserved fence equals this uuid is not broken, and telling them their
   *  graph tools will keep failing sends them to a hard refresh for nothing. */
  | { ok: false; why: string; settles: boolean; seenUuid?: string } {
  const active = parsed.active;
  // Read once, up front, so every failure branch below can report it. Undefined
  // whenever the record is missing, unreadable, or carries no usable uuid.
  const seenUuid =
    active && typeof active === "object"
      ? responseWorkflowUuid(active as Record<string, unknown>)
      : undefined;
  if (!active || typeof active !== "object") {
    // SETTLES: mid-restore the frontend genuinely has no active workflow yet —
    // that is #1184's finding in this reply's terms, and it is the window here.
    return { ok: false, seenUuid, why: "the reply carried no active-workflow record", settles: true };
  }
  // #514: the panel says so itself when its active record is not confirmed. An
  // explicit `false` is the panel telling us the value is untrustworthy — never
  // adopt through that. (Absent = an older panel that cannot say; the list
  // corroboration below then has to carry the whole weight.)
  if (parsed.active_confirmed === false) {
    // SETTLES: this is the reported window itself — the panel says "not yet",
    // and a moment later it says otherwise (#1292).
    return {
      ok: false,
      seenUuid,
      why: "the panel reported its active workflow as UNCONFIRMED",
      settles: true,
    };
  }
  const list = parsed.workflows;
  // TWO DIFFERENT FACTS, and #1292 made the difference cost real time. An ABSENT
  // `workflows` field is a property of the installed build — it will not appear
  // by waiting — while an EMPTY list is a snapshot of what is open right now,
  // which a mid-restore panel reports before its tabs come back. Folding them
  // would make every recovery on an older panel 2.9s slower for nothing.
  if (!Array.isArray(list)) {
    return {
      ok: false,
      seenUuid,
      why: "the reply carried no open-workflow list to corroborate the active record against",
      settles: false,
    };
  }
  if (list.length === 0) {
    return {
      ok: false,
      seenUuid,
      why: "the reply's open-workflow list was empty, so nothing corroborates the active record",
      settles: true,
    };
  }
  // Only an AFFIRMATIVE per-record flag can nominate the corroborating entry;
  // inferring it from the active object would be circular.
  const flaggedActive = list.filter(
    (w): w is OpenWorkflowRecord =>
      !!w && typeof w === "object" && (w as { active?: unknown }).active === true,
  );
  if (flaggedActive.length === 0) {
    // SETTLES: a snapshot taken before the panel re-flagged its active tab.
    return {
      ok: false,
      seenUuid,
      why: "no entry in the open-workflow list is marked active",
      settles: true,
    };
  }
  if (flaggedActive.length > 1) {
    // A mixed/partial snapshot. Exactly the shape that would let another canvas's
    // uuid through, so it is refused rather than arbitrated.
    return {
      ok: false,
      seenUuid,
      why: `${flaggedActive.length} entries in the open-workflow list are marked active (a mixed reply)`,
      // SETTLES: "mixed" IS the half-reconciled state, by definition.
      settles: true,
    };
  }
  // Same tri-state primitive the pin path uses. `false` = they name DIFFERENT
  // canvases (the stale/mixed case). `undefined` = they share no comparable
  // identity field, so agreement was never established — which is not agreement.
  const flagged = flaggedActive[0];
  const verdict = identityVerdict(flagged, active);
  if (verdict === false) {
    return {
      ok: false,
      seenUuid,
      why: "the active record and the entry marked active in the open-workflow list name DIFFERENT workflows (a stale or mixed reply)",
      // SETTLES: a stale half of the snapshot catches up.
      settles: true,
    };
  }
  if (verdict !== true) {
    // #1650 — unsaved (`tmp:`) tabs never have path/filename. After a reconnect
    // the top-level `active` record historically omitted `key`/`routing_key`
    // whenever the panel had not yet established a workflow identity, while the
    // unique flagged-active list entry still carried the per-tab `tmp:` handle
    // from `workflowTabId()`. Those two records describe the same canvas; they
    // just do not share a field that `identityVerdict` can pair. The reverse
    // (handle on `active`, omitted on the list row) is the same gap.
    //
    // Restricted to BOTH sides being unsaved and exactly one flagged-active
    // (already checked above). A saved path on either side is a different
    // canvas, not a missing field.
    if (unsavedTmpHandleCorroborates(flagged, active)) {
      return { ok: true, active: fenceRecordForAdoption(flagged, active) };
    }
    return {
      ok: false,
      seenUuid,
      why: "the active record and the open-workflow list share no comparable identity field, so nothing corroborates it",
      // DOES NOT SETTLE: a field the records do not carry will not appear by
      // waiting — that is the reply's SHAPE, not its timing.
      settles: false,
    };
  }
  return { ok: true, active: fenceRecordForAdoption(flagged, active) };
}

/**
 * Re-derive this session's command fence from the panel's live active canvas.
 * NEVER throws and NEVER fabricates: every failure mode gets its own status, and
 * the caller — not this function — decides what that means for its own report.
 */
/**
 * A refused read may have REPAIRED the fence on its way out (#1043/#932).
 *
 * The panel answers a workflow-instance mismatch by re-advertising its current
 * identity (noteWorkflowInstanceMismatch → sendHello), and the orchestrator's
 * hello handler adopts a validated identity into the tab's command stamp. That
 * budget is per-identity and RESETS when the live uuid changes — so right after a
 * workflow_new, the very refusal we just collected is what buys the re-hello that
 * fixes the fence.
 *
 * It lands asynchronously, though, so reporting the reading we took BEFORE the
 * call describes a state that may no longer exist by the time the caller sees it:
 * "NOT recovered" about a session that is, by then, fine. Wait one settle and
 * re-read before saying so.
 *
 * Only claims a repair when BOTH reads are known and the uuid actually CHANGED —
 * an unreadable fence proves nothing, and #770/#803 exist precisely because a
 * failed read used to render as a definite answer.
 */
async function unreadableOrHealed(
  ctx: PanelToolCtx,
  before: FenceRead,
  detail: string,
): Promise<WorkflowFenceRebind> {
  await sleep(retrySettleMs());
  const now = currentWorkflowFence(ctx);
  if (before.known && now.known && now.uuid && now.uuid !== before.uuid) {
    return { status: "healed_by_panel", uuid: now.uuid, before };
  }
  return { status: "unreadable", before, detail };
}

/**
 * The version-gap sentence for a fence rebind that failed on an OLD panel (#1043).
 *
 * Empty string when the panel is new enough, or when its version is unknown —
 * an unproven version must never be narrated as "yours is too old", which would
 * send someone to update a panel that is already current. That is the same
 * three-state discipline the rest of this file runs on.
 *
 * Never throws: this decorates an error path, and a decoration that fails must
 * not replace the diagnosis it was meant to improve.
 */
function panelTooOldNote(ctx: PanelToolCtx): string {
  try {
    const v = ctx.bridge?.panelTooOldForReplyUuid?.(ctx.tabId);
    // #1560 — A PANEL TOO OLD TO HELP IS ALSO TOO OLD TO SAY SO.
    //
    // The note below needs an advertised version, and `panel_version` has only
    // ridden the hello since panel v0.11.83. So the panels most likely to be
    // causing this deadlock — anything below 0.11.45 — cannot report it, and the
    // reporter of #1560 (on 0.11.37, after two Manager self-updates of the pack
    // crashed) got a bare "the panel did not answer" with nothing to act on.
    //
    // Deliberately WEAKER than the version case, and weaker still after review: an
    // absent version proves only "below 0.11.83", NOT "below the minimum". Panels
    // in 0.11.45–0.11.82 publish the reply uuid and simply predate version
    // advertisement, so this must read as SOMETHING TO CHECK and never as a finding
    // — naming a cause that is not theirs is the failure this whole cluster exists
    // to avoid.
    if (v?.neverAdvertised) {
      return (
        `

WORTH CHECKING — THE PANEL'S VERSION IS UNKNOWN HERE: this session's panel has never ` +
        `reported its version, and panels have advertised one on connect since 0.11.83, so ` +
        `this one is older than that. That does NOT by itself mean it is too old: a panel ` +
        `reports the new workflow's identity ON THE REPLY from ${v.needed} onwards, and ` +
        `0.11.45–0.11.82 do that while still not advertising a version. But if it IS below ` +
        `${v.needed}, that is the whole cause of this failure rather than anything about this ` +
        `workflow — on ${v.needed}+ the command that re-pointed the canvas repairs the fence ` +
        `from its own reply and never makes the read that just failed. ` +
        `Find out with install_comfyui (action:"panel", panel_action:"status"). If it is ` +
        `older, update with install_comfyui (action:"panel", panel_action:"sync"), restart ` +
        `ComfyUI, and HARD-REFRESH the browser tab (Ctrl+Shift+R) — a pack update that ` +
        `ComfyUI-Manager reported as FAILED leaves the old panel JS running in the open tab, ` +
        `so a restart alone does not pick it up.`
      );
    }
    if (!v?.tooOld) return "";
    // #1229 — IS THE INSTALL EVEN BEHIND, OR ONLY WHAT COMFYUI IS SERVING?
    //
    // This branch compares the RUNNING panel against the minimum and concludes
    // "pack is out of date" — but the reporter's pack on disk was 0.14.37 while
    // the session ran 0.11.38: ComfyUI-Manager had updated the pack IN PLACE
    // after ComfyUI started, and ComfyUI keeps serving the web assets it
    // registered at startup. Prescribing `sync` there is a no-op remedy — the
    // disk already clears the floor — and it cost the reporter a full
    // pack-version investigation to discover that. The actual fix is a RESTART
    // plus a hard-refresh, and a hard-refresh ALONE provably does not work,
    // because the new assets are registered server-side at startup, not re-read
    // from disk on reload.
    //
    // Same proof discipline as resolveStaleBundleSkew (#774): only a disk
    // version re-read NOW from the observed install dir may override the update
    // advice. Anything unproven — no observation, an unparseable version, or a
    // disk version genuinely below the floor — falls through to the sync remedy
    // unchanged, which is correct for a pack that really is behind.
    const disk = verifiedPanelDiskVersion()?.trim();
    if (!disk) {
      // The observation is missing or stale (most often the live-base
      // resolution lapsed and this refusal is the first thing to ask in a
      // while). Refresh it in the background — never awaited, since building
      // an error message must not block on I/O — so a retry can answer.
      void primePanelBase().catch(() => {});
    }
    if (disk && SEMVER_RE.test(disk) && compareSemver(disk, v.needed) >= 0) {
      return (
        `

WHY THIS READ WAS NEEDED AT ALL: this session's RUNNING panel is ${v.version}, ` +
        `and a panel only reports the new workflow's identity ON THE REPLY from ` +
        `${v.needed} onwards — but DO NOT SYNC THE PANEL: the pack ON DISK is ` +
        `${disk}, which already meets ${v.needed}, so a sync would change nothing. ` +
        `What is stale is what ComfyUI is SERVING: the pack was updated after ` +
        `ComfyUI started, and ComfyUI keeps serving the web assets it registered ` +
        `at startup. Restart ComfyUI so it serves ${disk}, then HARD-REFRESH the ` +
        `browser tab (Ctrl+Shift+R) — a hard refresh ALONE does not fix this, ` +
        `because the assets are registered server-side at startup, not re-read ` +
        `from disk on reload.`
      );
    }
    return (
      `

WHY THIS READ WAS NEEDED AT ALL: this session's panel is ${v.version}, and a ` +
      `panel only reports the new workflow's identity ON THE REPLY from ${v.needed} ` +
      `onwards. On ${v.needed}+ the command that re-pointed the canvas repairs the ` +
      `fence from its own reply and never makes this read — so UPDATING THE PANEL ` +
      `to ${v.needed} or later removes this failure rather than working around it. ` +
      `Update it with install_comfyui (action:"panel", panel_action:"sync"), then ` +
      `restart ComfyUI.`
    );
  } catch {
    return "";
  }
}

/**
 * #1292 — THE RECONCILIATION WINDOW IS OURS TO ABSORB, NOT THE CALLER'S TO WAIT OUT.
 *
 * Right after `panel_restart_comfyui` and the tab's reconnect, the panel is
 * briefly mid-reconciliation: it answers `workflow_list`, but its active record
 * is marked UNCONFIRMED (or the list is momentarily mixed). Corroboration
 * correctly refuses — and the caller got a hard failure for a state that fixes
 * itself, with the remedy "call this again in a moment". The reporter did, and
 * the identical call returned `already_current`.
 *
 * A recovery operation that tells you to retry it is one that has not finished
 * recovering. So this path rechecks with a FRESH read, three times over ~2.9s.
 *
 * WHY THESE AND NOT A LONGER BUDGET: this runs only when the rebind has already
 * failed, so the cost is paid on a path that was going to fail anyway — but it is
 * still latency added to a tool call, and the window this covers is a local
 * process reconnecting. The reporter's five seconds is an upper bound with a
 * human in it, not a measurement of the settle.
 *
 * WHY ONLY `uncorroborated`: the sibling failure `no_uuid` means the installed
 * panel exposes no workflow identity at all. Rechecking a build that will never
 * answer differently just makes the same error slower — the distinction the
 * status already draws, now with teeth.
 *
 * The corroboration rule itself does NOT move. It still fails closed on every
 * attempt; a recheck buys a fresh snapshot to judge, never a lower bar. What
 * would be unsafe is arbitrating a mixed reply, and that is exactly what is not
 * happening here.
 */
const FENCE_CORROBORATION_RECHECK_STEPS_MS = [400, 900, 1600] as const;

/**
 * #1478 — NAME THE CAUSE OF A MISMATCH THE LOAD MAY HAVE CREATED.
 *
 * An API-format `graph_load` can re-mint the canvas workflow instance, which leaves this
 * session's fence naming the old one — so the very next `panel_graph_outline` is refused
 * with `workflow instance mismatch`. The reporter hit that twice, deterministically. The
 * refusal then says "NO PANEL COMMAND CLAIMED IT", pointing at "the user switched tabs"
 * when a panel command one call earlier is the actual cause.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — and four review rounds are the reason:
 *
 *  1. It does NOT auto-repair the fence. The obvious fix runs the same re-derivation the
 *     documented recovery runs, and that adopts WHATEVER IS ACTIVE NOW with no tie to the
 *     load: a user switching canvases in the window would stamp the session to a different
 *     workflow and the next edit would land on the wrong graph. `panel_set_workflow_target`
 *     is sound doing this only because the user explicitly asked to follow what is live.
 *  2. It does NOT claim the fence IS stale. Every categorical version of that sentence was
 *     falsified: a UI-format load with an active workflow passes `__cmcpKeepInstance: true`
 *     and preserves the instance outright; and a second API load into the same
 *     already-active `graph_load.json` workflow reuses that object, so its uuid — which is
 *     object-keyed — does not change either. The reply carries nothing that separates
 *     "re-minted" from "reused", so asserting staleness is a guess dressed as a fact.
 *
 * So it states the CONDITIONAL, which is true on every path: this kind of load can move
 * the instance, here is the symptom, here is the cause, here is the one call that clears
 * it. A reader who is not refused ignores it; a reader who is refused stops hunting a tab
 * switch that never happened.
 *
 * The categorical version needs the panel's help: give `graph_load`'s reply a
 * `workflow_uuid`, as #762/#800 did for `workflow_new` / `workflow_save`, and the load can
 * then compare it against the fence and say exactly what happened — or claim the identity
 * it created outright, which is race-proof and refusal-proof and is why those two work
 * that way.
 */
function noteStaleFenceAfterLoad(): string {
  return (
    `

NOTE: an API-format load CAN re-mint the canvas workflow instance. If your next ` +
    `graph command is refused with "workflow instance mismatch", that is why — the cause is ` +
    `this load, NOT the user switching tabs (the refusal's own text suggests otherwise). ` +
    `Clear it with panel_set_workflow_target({mode:"current"}), which re-derives the fence ` +
    `from the live canvas, then retry. If the next command is not refused, nothing needs doing.`
  );
}

async function rebindWorkflowFence(
  ctx: PanelToolCtx,
  opts?: { adopt?: boolean },
): Promise<WorkflowFenceRebind> {
  const tabAtStart = ctx.tabId;
  let before = currentWorkflowFence(ctx);
  // `before` describes the tab we are ABOUT to compare against — but ctx.call can
  // MOVE us (workflow_list is retry-safe; its retry runs ensureReachable, which
  // rebinds an orphaned current-mode session). Re-read after any move, or we would
  // compare the NEW tab's live canvas against the OLD tab's fence: an accidental
  // `already_current` would then skip a refresh the new tab genuinely needed, and
  // report a recovered binding that is still wedged (codex gate).
  const syncFenceToCurrentTab = (): void => {
    if (ctx.tabId !== tabAtStart) before = currentWorkflowFence(ctx);
  };
  // One read + corroboration. Returns null when the READ failed in a way that is
  // its own status (`unreadable`/`healed_by_panel`) — those are not the transient
  // window this rechecks, and the settle inside unreadableOrHealed already covers
  // the case where the refusal itself repaired the fence.
  const readAndCorroborate = async (): Promise<
    | { done: WorkflowFenceRebind }
    | { corroborated: ReturnType<typeof corroborateActiveForFence> }
  > => {
    let parsed: Record<string, unknown> | null = null;
    try {
      const res = await ctx.call({ cmd: "workflow_list" }, 6000);
      syncFenceToCurrentTab();
      if (res?.isError) {
        return { done: await unreadableOrHealed(ctx, before, toolResultText(res)) };
      }
      parsed = parseToolResultJson(res);
    } catch (err) {
      syncFenceToCurrentTab();
      return {
        done: await unreadableOrHealed(
          ctx,
          before,
          err instanceof Error ? err.message : String(err ?? "unknown error"),
        ),
      };
    }
    if (!parsed) {
      return {
        done: await unreadableOrHealed(
          ctx,
          before,
          "the panel's workflow_list reply was not readable as JSON",
        ),
      };
    }
    // CORROBORATE before adopting. The uuid must come from a record the panel's own
    // open-workflow list agrees is the live canvas — otherwise a stale or mixed
    // reply's uuid (valid in shape, belonging to ANOTHER canvas) would overwrite
    // this tab's stamp and be reported as a successful rebind.
    return { corroborated: corroborateActiveForFence(parsed) };
  };

  const first = await readAndCorroborate();
  if ("done" in first) return first.done;
  let corroborated = first.corroborated;
  let attempts = 1;
  let waitedMs = 0;
  // #1292 — recheck the RECONCILIATION WINDOW with a fresh read, never a lower bar.
  // Only a failure that CAN settle is worth re-reading (codex review, P2): a reply
  // whose SHAPE is wrong — an older build that sends no `workflows` array, records
  // sharing no comparable identity field — will say exactly the same thing 2.9s
  // later, so retrying it just makes the identical error slower. That is the same
  // reasoning that keeps `no_uuid` out of this loop, applied one level down.
  for (const waitMs of FENCE_CORROBORATION_RECHECK_STEPS_MS) {
    if (corroborated.ok || !corroborated.settles) break;
    await sleep(waitMs);
    waitedMs += waitMs;
    attempts++;
    const next = await readAndCorroborate();
    if ("done" in next) return next.done;
    corroborated = next.corroborated;
  }
  if (!corroborated.ok) {
    return {
      status: "no_identity",
      before,
      kind: "uncorroborated",
      why: corroborated.why,
      rechecks: { attempts, waitedMs, settles: corroborated.settles },
      ...(corroborated.seenUuid ? { seenUuid: corroborated.seenUuid } : {}),
    };
  }
  const active = corroborated.active;
  const uuid = responseWorkflowUuid(active);
  if (!uuid) {
    return {
      status: "no_identity",
      before,
      kind: "no_uuid",
      why: "the active workflow record carries no usable workflow_uuid",
    };
  }
  // "already current" requires a KNOWN prior fence equal to the live uuid. An
  // UNKNOWN prior fence must not short-circuit the adoption: we would be claiming
  // the stamp already matched without ever having read it.
  if (before.known && before.uuid === uuid) return { status: "already_current", uuid, before };
  // #1646 — a READ-ONLY probe never moves the fence: the live canvas naming a
  // DIFFERENT workflow is reported, not adopted. Only a deliberate rebind
  // (panel_set_workflow_target, open/new) may replace the fence — a mismatch
  // diagnosis that re-pointed the session on its own authority routed the
  // caller's NEXT edits onto the very canvas the refusal named as the wrong one.
  if (opts?.adopt === false) return { status: "diverged", uuid, before };
  // refreshWorkflowUuid routes through the orchestrator's validator, which
  // re-checks reachability and the uuid's shape/origin binding. A `false` here is
  // a REFUSAL, not a no-op, so it gets its own status rather than being reported
  // as a successful rebind.
  // The adoption is itself an operation that can fail — the bridge hands the value
  // to an orchestrator-supplied validator that reads live connection state. A
  // throw here would escape this whole handler AFTER the target store write and
  // push, taking the "APPLIED (do not repeat this part)" disclosure with it and
  // leaving the caller unable to tell what happened (rules 3 and 4). Catch it, and
  // do NOT claim the fence is unchanged: a throw can land on either side of the
  // write, so `rejected`'s "the previous fence is unchanged" would be a state
  // nobody observed.
  try {
    if (refreshWorkflowUuid(ctx, active)) return { status: "refreshed", uuid, before };
    // #1077 — carry WHY. The validator has three independent gates and all of
    // them used to surface as the same bare "REFUSED", which left a wedged
    // session with nothing to act on. One of them (no server-observed Origin on
    // a relay connection) is structurally unsatisfiable, so a caller told only
    // "refused" will keep refreshing a tab that can never recover.
    const why = ((): string | undefined => {
      try {
        const read = (ctx.bridge as unknown as { lastFenceRefusal?: unknown }).lastFenceRefusal;
        return typeof read === "function"
          ? (read.call(ctx.bridge, ctx.tabId) as string | undefined)
          : undefined;
      } catch {
        return undefined; // a diagnostic must never replace the outcome
      }
    })();
    return { status: "rejected", uuid, before, refusalReason: why };
  } catch (err) {
    return {
      status: "adopt_error",
      uuid,
      before,
      detail: err instanceof Error ? err.message : String(err ?? "unknown error"),
    };
  }
}

/**
 * The ONE remedy that is actually reachable from every wedged state below, and
 * the one the reporters found to be the only thing that worked.
 *
 * Deliberately says MANUAL browser refresh and deliberately steers OFF
 * `panel_reload`: in #803 the agent followed a `panel_reload({scope:"frontend"})`
 * instruction and the tab never answered again — the prescribed recovery made a
 * partially-working session fully unresponsive. Naming a remedy that has been
 * observed to make things worse is not better than naming none.
 */
const RELOAD_TAB_REMEDY =
  "Ask the user to manually refresh (F5, or Ctrl+Shift+R for a hard refresh) the ComfyUI " +
  "browser tab, then call this again. Do NOT use panel_reload for this: it has been observed " +
  "to leave the tab permanently unresponsive from exactly this state (#803).";

/**
 * The one TRUE account of what a fence rebind achieved, and how usable the
 * session actually is afterwards.
 *
 *  - `bound`         — graph reads AND mutations will work.
 *  - `reads_only`    — nothing was STALE (so nothing failed to be repaired), but
 *                      no workflow identity exists, so mutations stay refused.
 *                      This is a pre-existing condition, not a wedged binding —
 *                      reporting it as a failed recovery would be the same fold
 *                      in the opposite direction.
 *  - `not_recovered` — the session is STILL fenced by a stamp that does not name
 *                      the live canvas. The caller must not report success.
 *
 *  - `unverified`    — the fence is repaired, but whether this panel build also
 *                      permits graph EDITS could not be determined from this
 *                      context. An unknown is not a yes; it is also not a no.
 *
 * `canMutate` is `bridge.tabCanMutateGraph(tabId)` — the SEPARATE question of
 * whether this panel build advertises the two write-boundary fences a graph
 * MUTATION requires (codex gate). A stamp is necessary but NOT sufficient: an
 * older bundle can report a perfectly good workflow uuid and still have every
 * mutation refused at dispatch. Reporting `bound` off the stamp alone answered a
 * question nobody asked — and reporting `bound` off an UNANSWERABLE capability
 * probe is the same mistake one step further out, so that gets its own value
 * rather than being rounded to the good news.
 */
function describeFenceRebind(
  r: WorkflowFenceRebind,
  canMutate: boolean | undefined,
  /**
   * WHY mutations are refused, when they are. An unroutable tab and an old panel
   * both yield `canMutate:false` but need opposite advice, and narrating the
   * first as the second is a bucket standing in for a cause (codex gate P1).
   */
  refusalCause?: "unroutable" | "disconnected" | "no_identity" | "capability",
  /**
   * #1043 — the version-gap sentence, when the connected panel is PROVABLY too
   * old to publish the reply uuid this rebind exists to avoid needing. Passed in
   * rather than looked up: this renderer is pure, and keeping it that way is what
   * makes its wording testable without a bridge.
   */
  panelGapNote = "",
): {
  binding: "bound" | "reads_only" | "unverified" | "not_recovered";
  note: string;
  /** #1473 — this verdict is UNRESOLVED rather than negative, and one cheap graph read
   *  settles it. Set only where the reported identity MATCHES the fence already held: the
   *  session is then either fine (a reconciliation race) or fenced to a stale record, and
   *  those are indistinguishable from here but trivially distinguishable by asking. */
  settleByRead?: true;
} {
  // A panel that cannot fence a WRITE gives reads only, however good the stamp is.
  const mutationsRefused = canMutate === false;
  const mutationsUnknown = canMutate === undefined;
  const okBinding: "bound" | "reads_only" | "unverified" = mutationsRefused
    ? "reads_only"
    : mutationsUnknown
      ? "unverified"
      : "bound";
  const unknownCaveat = mutationsUnknown
    ? `\n\nNOT VERIFIED: whether this panel build also permits graph EDITS could not be ` +
      `determined from this context — the fence is repaired, but treat mutation readiness as ` +
      `unconfirmed until a graph command succeeds.`
    : "";
  // Its own remedy, NOT the reload sentence: re-calling this tool cannot add a
  // missing panel capability, so telling the caller to "call this again" here
  // would be another instruction that provably cannot work.
  const mutationCaveat = mutationsRefused && refusalCause === "disconnected"
    ? `\n\nBUT this tab's panel socket is CLOSING or already closed, so graph mutations are ` +
      `refused. That is a transport state, not a panel-version problem: the pack is fine and ` +
      `hard-refreshing is not the fix. Reads through this session are unreliable until it ` +
      `reconnects.` +
      `\n\nWHAT TO DO: wait for the panel to reconnect — it does so on its own — then call ` +
      `this again.`
    : mutationsRefused && refusalCause === "no_identity"
    ? `\n\nBUT graph MUTATIONS are refused because this session has no trusted workflow ` +
      `identity for the tab to fence a write against. The panel build is FINE — it advertises ` +
      `the write fence — so updating the pack and hard-refreshing will not help. Reads work.` +
      `\n\nWHAT TO DO: call this tool again to bind an identity. If it keeps coming back ` +
      `without one, have the user click into the workflow tab so the panel reports an active ` +
      `canvas, then call this again.`
    : mutationsRefused && refusalCause === "unroutable"
    ? `\n\nBUT this tab is NOT REACHABLE from the orchestrator right now, so graph mutations ` +
      `are refused — and reads are not working either, whatever this note says about them. ` +
      `This is NOT a panel-version problem: updating the pack and hard-refreshing cannot help, ` +
      `because there is nothing to refresh until the tab is connected again.` +
      `\n\nWHAT TO DO: check that the ComfyUI browser tab is still open and its panel is ` +
      `connected, then call this again.`
    : mutationsRefused
    ? `\n\nBUT graph MUTATIONS are still refused for this tab: its panel build does not ` +
      `advertise the write-boundary workflow fence a graph edit requires, and no rebind — ` +
      `including calling this tool again — can add it. Reads work now (this call just read the ` +
      `live canvas).\n\nWHAT TO DO FOR EDITS: update the comfyui-mcp-panel pack, then have the ` +
      `user HARD-refresh (Ctrl+Shift+R) the ComfyUI browser tab — an open tab keeps running its ` +
      `cached bundle, so the capability lags the version on disk until it does. Do NOT use ` +
      `panel_reload for this: it has been observed to leave the tab permanently unresponsive ` +
      `(#803).`
    : "";
  switch (r.status) {
    case "diverged":
      // #1646 — produced ONLY by a read-only probe (`adopt:false`), which the
      // mismatch diagnosis uses; the deliberate rebinds this renderer serves
      // never pass it. Handled anyway, because an unhandled union member would
      // silently render as `undefined` — say exactly what happened if a future
      // caller ever routes one here.
      return {
        binding: "not_recovered",
        note:
          ` The live canvas is a DIFFERENT workflow instance (${r.uuid}) than this session's ` +
          `fence, and it was deliberately NOT adopted — a diagnosis must never re-point ` +
          `mutation routing on its own.` +
          (r.before.known && r.before.uuid ? ` The fence still names ${r.before.uuid}.` : "") +
          `\n\nWHAT TO DO: re-open the workflow you mean with panel_open_workflow, or re-target ` +
          `the live canvas deliberately by calling this tool with mode:"current".`,
      };
    case "refreshed":
      return {
        binding: okBinding,
        note:
          ` Rebound the graph command fence onto the live canvas (workflow instance ${r.uuid})` +
          `${r.before.known && r.before.uuid ? `, replacing the stale ${r.before.uuid}` : ""} — ` +
          `graph ${mutationsRefused ? "READS" : "tools"} will now target the workflow the panel ` +
          `reported as active a moment ago. (If the user switched tabs again in that instant, the ` +
          `next graph command fails closed with a fresh instance mismatch — safe, and cleared by ` +
          `calling this again.)${mutationCaveat}${unknownCaveat}`,
      };
    case "already_current":
      return {
        binding: okBinding,
        note:
          ` The graph command fence already named the canvas the panel reported as active a ` +
          `moment ago (workflow instance ${r.uuid}), so nothing needed rebinding.` +
          // The SAME post-probe window as `refreshed` (codex gate). This branch used
          // to jump straight to "the mismatch is coming from the panel" and send the
          // caller to a browser reload — but a switch after workflow_list replied
          // leaves the stamp stale here too, and the immediate remedy for that is
          // this very call, not a reload. Reserve the reload for a mismatch that
          // PERSISTS across a repeat, which is the only thing that actually
          // implicates the panel.
          ` (If the user switched tabs again in that instant, the next graph command ` +
          `fails closed with a fresh instance mismatch — safe, and cleared by calling this ` +
          `again.)${mutationCaveat}${unknownCaveat}` +
          (mutationsRefused
            ? ""
            : `\n\nWHAT TO DO if graph tools are still failing: call this once more. If the ` +
              `mismatch SURVIVES that repeat, this session and the panel agree on the target ` +
              `and the disagreement is inside the panel — ${RELOAD_TAB_REMEDY}`),
      };
    case "healed_by_panel":
      // Reported as BOUND, and the provenance said out loud: the stamp came from
      // the panel's own re-advertised identity through the hello handler's
      // validator — the same path that sets it normally — not from a reading we
      // took. Calling this "not recovered" because OUR read failed would report a
      // wedge that no longer exists.
      return {
        binding: "bound",
        note:
          ` The read was refused, but this session's fence CHANGED while it ran: the panel ` +
          `re-advertised its live identity (${r.uuid}) and it was adopted, replacing ` +
          `${r.before.known && r.before.uuid ? r.before.uuid : "the previous stamp"}. Graph tools ` +
          `should work now — the repair came from the panel, not from this call, so treat the ` +
          `next graph command as the confirmation.`,
      };
    case "rejected":
      return {
        binding: "not_recovered",
        note:
          ` Read the live canvas identity (${r.uuid}) but could NOT adopt it as this session's ` +
          `graph command fence.` +
          // #1077 — name the gate when we can. "the bound tab stopped being
          // reachable, OR the panel reported an identity this orchestrator does
          // not trust" listed two causes with different remedies and left the
          // caller to guess which; one of them cannot be fixed by retrying at all.
          (r.refusalReason
            ? ` The orchestrator's validator refused it because ${r.refusalReason}.`
            : ` Either the bound tab stopped being reachable, or the panel reported an identity ` +
              `this orchestrator does not trust — this bridge could not say which.`) +
          ` The adoption was REFUSED, so the previous fence is unchanged and graph tools will ` +
          `keep failing.` +
          `\n\nWHAT TO DO: ${
            // A structurally-unsatisfiable gate must not be answered with "refresh
            // the tab" — the reporter did that repeatedly, including closing and
            // reopening it, and it could never have worked.
            r.refusalReason && /no server-observed Origin/i.test(r.refusalReason)
              ? // panel#1065 — SHARED with fence-refusal.ts, because this copy went stale.
                // It still described the world before #1240 gave the relay path its
                // origin: it told the user to abandon the relay backend and to report
                // a protocol gap that had already been closed. Someone did exactly
                // that, on a version that had the fix.
                NO_ORIGIN_REMEDY
              : RELOAD_TAB_REMEDY
          }`,
      };
    case "adopt_error":
      return {
        binding: "not_recovered",
        note:
          ` Read the live canvas identity (${r.uuid}), but adopting it as this session's graph ` +
          `command fence THREW. Unlike a refusal, this does not tell us the previous fence ` +
          `survived: the failure can have landed on either side of the write, so whether the ` +
          `fence changed is UNKNOWN. Do not assume either way — the next graph command's ` +
          `outcome is the reliable answer, and it is safe to find out (a mismatched fence is ` +
          `refused, never misapplied).` +
          `\n\nWHAT TO DO: call this again — a second attempt is safe and settles it. If it ` +
          `keeps throwing: ${RELOAD_TAB_REMEDY}` +
          `\n\nUNDERLYING CAUSE: ${r.detail}`,
      };
    case "unreadable":
      // ALWAYS not_recovered, with or without a prior fence (codex gate). The read
      // we just attempted FAILED, so nothing about this session was observed —
      // including whether graph READS work. The earlier draft reported the
      // no-prior-fence case as a usable `reads_only`, which asserted a capability
      // straight out of a failed observation: the exact "could not determine X,
      // therefore X" fold this cluster exists to remove. Say UNKNOWN and say what
      // is possible.
      //
      // The quoted cause is a WRAPPED transport error whose own text may suggest
      // rebinding with mode:"current" — the call that just failed. Quote it last,
      // label it as a quote, and disarm it explicitly rather than letting the
      // reader end on advice that provably cannot work.
      return {
        binding: "not_recovered",
        note:
          ` Could NOT read the live canvas identity — the panel did not answer, so NOTHING ` +
          `about this session's graph binding was observed.` +
          // #1043 — NAME THE VERSION GAP when that is what this is.
          //
          // The repair that would have avoided this read entirely
          // (refreshFenceFromOwnReply, #1161) trusts a workflow_uuid the panel
          // only publishes from 0.11.45. Three reports — #1043, #1077, #1174 —
          // deadlocked here on OLDER panels: the fix is present and inert, and
          // the message said only "could not be read", which reads as a mystery
          // rather than as "update the panel".
          //
          // Only a PARSEABLE version below the minimum says this; an unknown
          // version stays quiet rather than telling someone to update a panel
          // that may already be current.
          panelGapNote +
          // THREE states, not two (codex gate). "We could not read the existing
          // fence either" must not render as "it has no fence" — that absence was
          // never observed, and it is the same fold one level down.
          (!r.before.known
            ? ` What fence it currently carries could not be read either, so its binding is ` +
              `entirely unknown — not known-good and not known-absent.`
            : r.before.uuid
              ? ` It is still fenced to the previous workflow instance (${r.before.uuid}), which ` +
                `the panel will keep refusing.`
              : ` It has no graph command fence; whether graph reads work is unknown, because the ` +
                `read that would have told us is the one that failed.`) +
          ` This is not a rebind — it is an unknown.` +
          // #1071 — WHY the read failed decides the remedy, exactly as the
          // no_identity case below already does. Bucketing them would hand half the
          // callers an instruction they cannot act on.
          //
          //  - REFUSED BY THE FENCE: retrying is provably useless. This rebind reads
          //    workflow_list, which the panel fences, so the fence being wrong is
          //    precisely what makes the read fail — every time, forever. A reporter
          //    called this five times over twenty minutes on "retry in a moment" and
          //    lost the canvas for the rest of the task. workflow_open is the one
          //    command the fence EXEMPTS, so it still runs while everything else is
          //    refused, and it now re-derives the fence from its own reply.
          //  - ANY OTHER CAUSE (a dead tab, a transport drop, a busy panel): the
          //    panel is not answering at all, so reopening would fail too and
          //    retrying really is the reachable move.
          (/workflow instance mismatch/i.test(r.detail)
            ? `\n\nWHAT TO DO: reopen the workflow you want with panel_open_workflow(<path>). ` +
              `The panel refused the read because of the FENCE itself, so retrying this call ` +
              `cannot work — it needs the very read the fence blocks. The panel's fence EXEMPTS ` +
              `workflow_open, so it still runs while everything else is refused, and it ` +
              `re-derives this session's fence from its own reply. Note panel_list_workflows is ` +
              `fenced too, so if you do not already know the path, ask the user rather than ` +
              `guessing. If the canvas you want is an UNSAVED one (a blank workflow you just ` +
              `created), there is no path to reopen and opening anything else would abandon it — ` +
              `that case needs the tab refresh below, not a reopen. If reopening also fails: ` +
              `${RELOAD_TAB_REMEDY}`
            : `\n\nWHAT TO DO: retry in a moment — a busy or mid-reconnect panel often answers ` +
              `on the next attempt. If it keeps failing: ${RELOAD_TAB_REMEDY}`) +
          `\n\nUNDERLYING CAUSE (quoted verbatim — disregard any rebind advice inside it; ` +
          `rebinding is what just failed): ${r.detail}`,
      };
    case "no_identity":
      // THREE answers, because there are three states (codex gate):
      //  - a KNOWN stale fence  → the session really is wedged  → not_recovered;
      //  - a KNOWN absent fence → nothing was stale, the panel is simply
      //    identity-less                                        → reads_only;
      //  - an UNREADABLE prior fence → we cannot say either way → unverified.
      //    Failing here would report a wedge nobody observed; succeeding would
      //    report a repair nobody observed. Neither is available, so say so.
    {
      // WHY nothing was adopted decides the remedy. A panel that exposes no
      // identity needs UPDATING (retrying forever will not help); a reply that
      // did not hang together needs RETRYING (the pack is fine). Bucketing them
      // would hand half the callers an instruction they cannot act on.
      const lead =
        r.kind === "no_uuid"
          ? ` The panel answered but reported NO workflow identity for the active canvas`
          : ` The panel answered, but its reply could not be corroborated, so nothing was ` +
            `adopted — ${r.why}. NOTHING was written to this session's fence: adopting an ` +
            `uncorroborated record could have stamped ANOTHER canvas's identity onto this tab`;
      const remedy =
        r.kind === "no_uuid"
          ? `\n\nWHAT TO DO: ${RELOAD_TAB_REMEDY} Make it a HARD refresh here specifically: a ` +
            `plain reload can serve the same cached bundle again; only a hard refresh replaces ` +
            `it. If a hard refresh does not help, the installed pack itself predates the ` +
            `per-workflow identity and must be UPDATED — no rebind can add it.`
          : // #1292 — DO NOT PRESCRIBE WHAT WE JUST DID. This path now rechecks
            // with fresh reads before failing, so "call this again in a moment"
            // would be advice the tool already took on the caller's behalf — and
            // taking it a fourth time is the least likely thing left to work.
            // When the rechecks ran, say so and move on to the remedy that has
            // not been tried.
            (r.rechecks && !r.rechecks.settles
              ? // Waiting cannot fix a reply whose SHAPE is wrong, so do not
                // prescribe waiting. This said "call this again in a moment" to
                // a caller whose panel will answer identically forever.
                `\n\nWHY RETRYING WILL NOT HELP: this is the shape of the panel's reply, not a ` +
                `moment in its reconciliation — a later read answers the same way. ` +
                `${RELOAD_TAB_REMEDY} If it survives a hard refresh, the installed pack is too ` +
                `old to corroborate its own active workflow and must be UPDATED.`
              : r.rechecks && r.rechecks.attempts > 1
              ? `\n\nALREADY TRIED: the panel was re-read ${r.rechecks.attempts} times over ` +
                `~${(r.rechecks.waitedMs / 1000).toFixed(1)}s and never corroborated. That window ` +
                `covers the usual post-restart reconciliation, so this is probably NOT the ` +
                `transient case.\n\nWHAT TO DO: ${RELOAD_TAB_REMEDY}`
              : `\n\nWHAT TO DO: call this again in a moment. A stale or mixed workflow list is ` +
                `usually transient — it settles once the panel finishes reconciling its tabs. ` +
                `If it persists across a few attempts: ${RELOAD_TAB_REMEDY}`);
      if (!r.before.known) {
        return {
          binding: "unverified",
          note:
            `${lead}, and this session's existing fence could not be read either — so whether ` +
            `its graph binding is healthy could NOT be determined. Routing is set. Treat graph ` +
            `tools as unconfirmed: if the next one fails with a workflow-instance mismatch, ` +
            `that is the answer.${remedy}`,
        };
      }
      // #1401 — the SAME uuid is not the same situation.
      //
      // The gate is right to refuse an uncorroborated identity, and nothing here
      // adopts one. What was wrong was the consequence asserted afterwards: when
      // the identity the panel reported EQUALS the fence this session already
      // holds, graph tools are not fenced to a different instance and generally
      // keep working — the reporter's next call was a panel_graph_outline that
      // succeeded, after being told it would keep failing and to hard-refresh.
      //
      // So this splits on evidence rather than reporting the worst case for both:
      // a MATCHING uuid rules OUT the fenced-to-another-instance case without ruling
      // IN liveness (codex: a stale/background record can carry the right uuid), so it
      // reports what is ruled out and sends the caller to the read that settles it; a
      // DIFFERENT or absent uuid keeps the original certain-failure wording.
      const fenceStillMatches =
        r.status === "no_identity" && r.seenUuid !== undefined && r.seenUuid === r.before.uuid;
      if (fenceStillMatches) {
        return {
          binding: "not_recovered",
          settleByRead: true,
          note:
            `${lead}. This session's fence was NOT re-derived, and whether that reply describes ` +
            `the LIVE canvas is exactly what could not be confirmed — a stale or background ` +
            `record can carry the right uuid and still not be the canvas in front of the user, ` +
            `so this is NOT a claim that graph tools work. What IS known is narrower and still ` +
            `useful: the identity it reported matches the fence this session already holds ` +
            `(${r.before.uuid}), so this is not the case where the session is fenced to a ` +
            `DIFFERENT workflow instance — which is the one that keeps graph tools failing.` +
            `

WHAT TO DO: settle it with a graph read — call panel_graph_outline. That ` +
            `answers the question this could not: if it succeeds, the binding was fine and this ` +
            `was a reconciliation race. If it fails with a workflow-instance mismatch, the ` +
            `reply was stale after all — then ${RELOAD_TAB_REMEDY}`,
        };
      }
      return r.before.uuid
        ? {
            binding: "not_recovered",
            note:
              `${lead}, so this session is STILL fenced to the previous workflow instance ` +
              `(${r.before.uuid}) and graph tools will keep failing.${remedy}`,
          }
        : r.kind === "no_uuid"
          ? {
              binding: "reads_only",
              // Honest limit (codex gate): "until it reconnects with one" was not
              // actionable — a panel build that has no workflow identity will never
              // acquire one merely by reconnecting. Name the remedy that exists.
              note:
                ` The panel answered but reports NO workflow identity for the active canvas. ` +
                `Graph READS work; graph MUTATIONS stay refused, because there is no instance ` +
                `for the panel to fence a write against. Routing is set.` +
                `\n\nNOTE: reconnecting alone will NOT restore mutations — a panel build that ` +
                `reports no workflow identity needs the comfyui-mcp-panel pack UPDATED (then a ` +
                `hard refresh of the ComfyUI browser tab, since the open tab can keep running a ` +
                `cached older bundle). Until then this session is read-only for graph tools.`,
            }
          : {
              // A panel that DOES report identities, whose reply merely did not hang
              // together this time. Nothing was stale (no prior fence) and nothing was
              // adopted, so the session is no worse than before — but we did not
              // establish a fence either, and saying "reads work, mutations don't"
              // would describe a permanent limitation this is not.
              binding: "unverified",
              note:
                ` The panel's reply could not be corroborated, so nothing was adopted — ` +
                `${r.why}. NOTHING was written to this session's fence: adopting an ` +
                `uncorroborated record could have stamped ANOTHER canvas's identity onto this ` +
                `tab. This session had no fence to damage, so it is no worse off — but no ` +
                `fence was established either, so graph mutations remain unconfirmed.` +
                `\n\nWHAT TO DO: call this again in a moment. A stale or mixed workflow list ` +
                `is usually transient — it settles once the panel finishes reconciling its ` +
                `tabs. If it persists across a few attempts: ${RELOAD_TAB_REMEDY}`,
            };
    }
  }
}

/**
 * A successful open reply belongs to that exact bridge request, but another
 * navigation may have completed before the caller receives it. Re-read the
 * active object and accept the returned UUID only while it still names this
 * open's canonical target; otherwise leave the old stamp to fail closed.
 */
async function refreshOpenWorkflowUuid(
  ctx: PanelToolCtx,
  requestedPath: string,
  openResult: ToolResult,
): Promise<OpenDriftNotice | null> {
  const parsedOpen = parseToolResultJson(openResult);
  const opened = parsedOpen?.opened;
  const openedPath =
    opened && typeof opened === "object" && typeof (opened as { path?: unknown }).path === "string"
      ? (opened as { path: string }).path
      : undefined;
  // The caller's original token is the fence target. A panel can resolve an
  // alias/basename to a path, but that reply must never retroactively turn the
  // alias into a UUID-refresh authorization. Require the reply to corroborate
  // the original exact saved identity before consulting the live active record.
  const requestedIdentity = canonicalRequestedSavedIdentity(requestedPath);
  const openedIdentity = openedPath
    ? canonicalSavedRecordIdentity({ path: openedPath, routing_key: parsedOpen?.routing_key })
    : null;
  if (!requestedIdentity || requestedIdentity !== openedIdentity) {
    // #812 — the SAVED corroboration above can never succeed for an unsaved
    // target (there is no path), so try the parallel UNSAVED identity: the
    // caller's literal token against the panel's own proven routing_key for
    // the tab it just opened. Exact equality only — see
    // canonicalUnsavedWorkflowIdentity for why that carries no alias risk.
    //
    // Trust level matches the EXISTING "could not ask" fallback below exactly:
    // adopt the reply's own workflow_uuid directly, which the panel published
    // only after its own final synchronous check that this target was still
    // the active workflow (#716). No extra workflow_list round trip — that
    // read is itself refused by the exact wedge this exists to repair
    // (#1071), which is the same trap `panel_new_workflow`'s recovery hit.
    const requestedUnsaved = canonicalUnsavedWorkflowIdentity(requestedPath);
    if (requestedUnsaved && requestedUnsaved === parsedOpen?.routing_key) {
      refreshWorkflowUuid(ctx, parsedOpen);
    }
    return null;
  }

  // THREE outcomes for this corroborating read, not two — and conflating the last
  // two is #1071 (also #932/#1043).
  //
  // `workflow_list` is NOT exempt from the panel's fence (activeWorkflowFenceApplies
  // exempts only canvas-independent ops, workflow_open/new, and non-active-targeted
  // rename/close). So in exactly the state this refresh exists to repair — a session
  // fenced to a workflow instance that is no longer active — the read is REFUSED by
  // the stale fence, the old code took the `return` / `catch`, and the fence was
  // never refreshed. The recovery was gated behind the one call the wedge blocks.
  //
  // The open reply already carries what is needed. The panel publishes
  // `workflow_uuid` there only after a FINAL SYNCHRONOUS check that `target` is
  // still the active workflow (#716, activeWorkflowUuidForOpenReply) — omitting it
  // otherwise, expressly so "the MCP keeps its existing fence fail-closed". It is a
  // fence-quality value the panel went out of its way to prove; using it when the
  // read cannot be made is what it is for.
  let list: Record<string, unknown> | null = null;
  let readable = false;
  try {
    const res = await ctx.call({ cmd: "workflow_list" }, 6000);
    if (!res?.isError) {
      list = parseToolResultJson(res);
      readable = list !== null;
    }
  } catch {
    readable = false;
  }

  if (readable) {
    // ANSWERED. It either confirms our target is active — prefer the just-read
    // value, which is fresher than the reply — or it names a DIFFERENT active
    // workflow, in which case another tab won the slot and adopting our target's
    // uuid would fence this session to a canvas that is not mounted. Adopt nothing.
    //
    // #887 — declining to adopt was right and was never enough. This is the ONLY
    // genuinely later observation in the whole open path: it sits behind a real
    // `await ctx.call(...)` round trip to the panel, so unlike anything inside the
    // panel's own synchronous post-load window it can actually see the active
    // pointer having settled somewhere else. It saw the contradiction, kept the
    // session safe, and told the CALLER nothing — the tool result still reported a
    // plain success naming the path the agent asked for. The agent then had every
    // reason to Save-As onto what it believed was that canvas.
    const reading = readOpenActiveAgainstTarget(list!.active, requestedPath, list!.active_confirmed);
    if (reading === "different") {
      return { drifted: true, activeLabel: describeActiveRecord(list!.active) };
    }
    if (reading === "indeterminate") return null;
    refreshWorkflowUuid(ctx, list!.active) || refreshWorkflowUuid(ctx, parsedOpen);
    return null;
  }

  // COULD NOT ASK — the wedged case. Fall back to the reply's proven uuid rather
  // than leaving the session fenced to a dead instance forever. This is strictly
  // safer than the alternative it replaces: a stamp the panel proved against its
  // own active workflow can only authorize commands naming the canvas that is
  // actually mounted, whereas doing nothing here guarantees every subsequent
  // command is refused. A reply that carries no uuid (the panel could not prove
  // it) still refreshes nothing, so fail-closed is preserved.
  //
  // #887 — and NO drift notice from here, deliberately. This branch is reached
  // precisely because the corroborating read could not be made, so nothing was
  // observed about what is active. Warning here would be inventing the finding.
  refreshWorkflowUuid(ctx, parsedOpen);
  return null;
}

/** Exact resolved-path check for an open receipt. A filename/basename is not a
 * workflow identity: `other/foo.json` must never confirm `wanted/foo.json`. */
function resolvedOpenPathMatches(receipt: Record<string, unknown>, path: string): boolean {
  const resolved = receipt.resolved;
  if (!resolved || typeof resolved !== "object") return false;
  const actual = (resolved as Record<string, unknown>).path;
  if (typeof actual !== "string") return false;
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  return normalize(actual) === normalize(path);
}

/**
 * Poll `workflow_list` for the #514 `last_open` receipt for this exact bridge rid.
 * Active workflow state is deliberately ignored as recovery proof. Older panels
 * without receipt fields are identified promptly and remain undetermined.
 */
async function waitForOpenReceipt(
  ctx: PanelToolCtx,
  path: string,
  rid: string,
  timing: OpenVerifyTiming,
): Promise<OpenVerifyResult> {
  const start = Date.now();
  const deadline = start + timing.budgetMs;
  const intervalMs = openVerifyTimingOverride
    ? Math.max(1, timing.intervalMs)
    : Math.max(100, timing.intervalMs);
  let attempts = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    const probeTimeoutMs = Math.max(1, Math.min(timing.probeTimeoutMs, remaining));
    const probe = await ctx.call({ cmd: "workflow_list" }, probeTimeoutMs);
    attempts++;
    const parsed = parseToolResultJson(probe);
    if (parsed) {
      // #514 always includes active_confirmed, including when last_open is null.
      // Its absence identifies an older panel which cannot make recovery claims.
      if (!("active_confirmed" in parsed) && !("last_open" in parsed)) {
        return { receipt: "unsupported", waited_ms: Date.now() - start, attempts };
      }
      const lastOpen = parsed.last_open;
      if (lastOpen && typeof lastOpen === "object") {
        const receipt = lastOpen as Record<string, unknown>;
        if (receipt.rid === rid && receipt.answers_only_command_rid === rid && receipt.cmd === "workflow_open") {
          // The exact RID identifies this command. Keep a target check as an
          // accidental wrong-workflow guard; active itself is never proof.
          if (!resolvedOpenPathMatches(receipt, path)) {
            return { receipt: "unknown", waited_ms: Date.now() - start, attempts };
          }
          if (receipt.applied === true) {
            // A receipt proves this open applied, but a later user switch could
            // have made another canvas active before this probe.  Refresh only
            // when the current active object still names this exact target.
            const active = parsed.active;
            const resolved = receipt.resolved as Record<string, unknown>;
            const resolvedPath = resolved.path as string;
            // The receipt has already proved the command's exact resolved path.
            // Still require its routing claim and the live active record to
            // corroborate the ORIGINAL request identity before refreshing.
            const requestedIdentity = canonicalRequestedSavedIdentity(path);
            const resolvedIdentity = canonicalSavedRecordIdentity({
              path: resolvedPath,
              routing_key: resolved.routing_key,
            });
            const workflowUuid =
              requestedIdentity &&
              requestedIdentity === resolvedIdentity &&
              activeMatchesOpenRefreshTarget(active, path)
              ? responseWorkflowUuid(active)
              : undefined;
            return { receipt: "applied", workflowUuid, waited_ms: Date.now() - start, attempts };
          }
          if (receipt.applied === false) {
            return {
              receipt: "not_applied",
              error: typeof receipt.error === "string" ? receipt.error : undefined,
              waited_ms: Date.now() - start,
              attempts,
            };
          }
          return { receipt: "unknown", waited_ms: Date.now() - start, attempts };
        }
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }
  return { receipt: "missing", waited_ms: Date.now() - start, attempts };
}

/**
 * `panel_open_workflow` body, shared across transports. Forwards `workflow_open`
 * and returns its reply verbatim on success or on a GENUINE failure (a normal
 * error reply, e.g. "no workflow matching"). Only on an ACK-TIMEOUT does it
 * verify the exact panel-side receipt: SUCCESS (with a `recovered` note) only when
 * that receipt confirms this request was applied. Missing, stale, or old-panel
 * receipts remain undetermined rather than fabricating success.
 */
/** Terminal error for a MUTATING panel command when the pre-send reachability wait
 *  gave up (no tab reconnected within budget / an ambiguous multi-tab session). We
 *  must NOT dispatch — firing into a dead binding is exactly the OUTCOME-UNKNOWN /
 *  double-apply risk the pre-send wait exists to prevent (codex). */
function noReachableTabFail(cmd: string, ctx?: PanelToolCtx): ToolResult {
  // #971 — TWO CAUSES, OPPOSITE REMEDIES, and they were folded into one sentence
  // that sent the reporter in a circle:
  //
  //   panel_open_workflow  -> "no reachable tab … or rebind with
  //                            panel_set_workflow_target({mode:'current'})"
  //   mode:"current"       -> its only probe is a workflow_list call TO A TAB
  //
  // So the advice needed exactly the thing whose absence caused the failure. The
  // reporter had already run the rebind — it reported `bound` — and was sent back
  // to it.
  //
  // The two causes want different answers, and the bridge can tell them apart:
  //  • nothing connected  → there is nothing to rebind ONTO. Say so, and name the
  //    thing that does help (the tab reconnecting, or the user opening/refreshing
  //    one).
  //  • tabs connected, none is ours → `mode:"current"` is exactly right: it
  //    re-points the session at the active tab.
  let connected: number | null = null;
  try {
    const tabs = ctx?.bridge?.tabs?.();
    if (Array.isArray(tabs)) {
      connected = tabs.filter(
        (t) => !(typeof ctx?.bridge?.isHeadless === "function" && ctx.bridge.isHeadless(t.tab_id)),
      ).length;
    }
  } catch {
    connected = null; // an unreadable bridge earns the neutral wording below
  }

  if (connected === 0) {
    // MEASURED, not assumed. An earlier draft of this said "rebinding CANNOT
    // help while nothing is connected". That is false: with zero tabs
    // `mode:"current"` returns `deferred: true`, CLEARS the stale binding, and
    // arms a bind onto the first tab that reconnects. It is worth doing — it
    // just does not make the command retryable NOW, which is what the caller is
    // actually asking. Saying which of those it does is the difference between
    // a useful instruction and the loop the reporter hit.
    return fail(
      `${cmd} — this session has no reachable panel tab, and NO panel tab is connected at all ` +
        `(still reconnecting after a restart/reload, or the ComfyUI browser tab is closed). ` +
        `Nothing was sent. A rebind will NOT make this retryable yet: with nothing connected, ` +
        `panel_set_workflow_target({mode:"current"}) clears the stale binding and DEFERS, taking ` +
        `effect on the first tab that reconnects — useful, but it does not bring a tab back. ` +
        `Wait for the reconnect and retry, or ask the user to open/refresh the ComfyUI browser tab.`,
    );
  }
  if (connected !== null && connected > 0) {
    return fail(
      `${cmd} — this session has no reachable panel tab, though ${connected} panel tab(s) are ` +
        `connected — none of them is bound to this session (its tab was replaced, or several are ` +
        `open and the session's is gone). Nothing was sent. Rebind onto the live one with ` +
        `panel_set_workflow_target({mode:"current"}), then retry.`,
    );
  }
  // Bridge could not enumerate tabs: keep the old, cause-neutral wording rather
  // than guessing which of the two it is.
  return fail(
    `${cmd} — this session has no reachable panel tab yet (still reconnecting after a ` +
      `restart/reload, or multiple tabs are open and none is this session's). Nothing was ` +
      `sent. Retry in a moment, or rebind with panel_set_workflow_target({mode:"current"}).`,
  );
}

async function openWorkflowWithVerify(path: string, ctx: PanelToolCtx): Promise<ToolResult> {
  // #402: after a full ComfyUI restart the browser tab re-registers a few seconds
  // later. Awaiting a stable binding BEFORE dispatching a mutating workflow_open
  // (nothing is sent yet — no double-apply risk) means the command reaches a live
  // tab instead of firing into the "Connected: none" window and coming back
  // OUTCOME UNKNOWN. A healthy session returns from this instantly; if no tab
  // reconnects within budget we REFUSE rather than dispatch into a dead binding.
  if (ctx.awaitReachable && !(await ctx.awaitReachable())) {
    return noReachableTabFail("workflow_open", ctx);
  }
  let dispatchedRid: string | undefined;
  const res = await ctx.call(
    { cmd: "workflow_open", path },
    15000,
    (rid) => {
      dispatchedRid = rid;
    },
  );
  // Success, or a genuine acked error (missing file / real executor error) — the
  // caller must see it as-is. A slow-ack TIMEOUT or a mid-command reconnect DROP
  // ("OUTCOME UNKNOWN", #402) both warrant a receipt lookup, which can turn an
  // unknown outcome into a definite one without inferring from active state.
  if (!isAckTimeout(res) && !isReconnectDrop(res)) {
    // #716 — re-read the active record after this exact successful open before
    // refreshing the next command's stamp. This prevents a late reply from an
    // earlier open from overwriting the fence after another tab became active.
    if (res.isError) {
      // #887 — THE REPORTER'S OWN PATH. The panel throws for every open verdict
      // short of PROVEN, so the case in the ticket ("Tool errors saying the
      // requested workflow is active") arrives here, not below. Gating the
      // corroborating read on success left exactly the reported scenario
      // unexamined: the panel's message asserts the target IS active, and nothing
      // in this process ever checked whether it still was.
      //
      // OBSERVE ONLY — never adopt. The open did not prove itself, and the panel
      // deliberately withholds `workflow_uuid` in that case to keep the fence
      // fail-closed. Reading what is active cannot change that; it only adds a
      // fact to a message that is already an error.
      //
      // AND ONLY FOR THE CLASS WHERE THE LOAD ACTUALLY RAN. A genuine acked
      // failure — a missing file, a real executor error — means nothing was
      // opened, so another workflow being active is the expected state, not
      // drift; warning there would be noise, and this repo already pins that a
      // genuine error must not trigger a workflow_list round trip at all. Every
      // rebind-unproven message the panel emits opens with `workflow_open RAN`
      // (its own contract wording for "the load executed, the proof did not"),
      // which is exactly the class that can assert a false active workflow.
      if (!/workflow_open RAN/i.test(toolResultText(res))) return res;
      const probe = await observeActiveAfterOpen(ctx, path);
      if (probe.status !== "different") {
        const cleared = await clearFenceOnIdentityProvenOpen(ctx, res, path);
        // #1560 — the probe's SILENCE, reported. Suppressed when the fence was in fact
        // repaired: that re-derivation is itself a `workflow_list` round trip, so a
        // success there proves the channel answered and the note would contradict the
        // line above it. Gated on the STRUCTURED outcome, never on its wording.
        if (probe.status === "unanswered" && !cleared.repaired) {
          return appendToolResultText(cleared.res, panelChannelSilentNote(probe.detail));
        }
        return cleared.res;
      }
      const drift = probe;
      return fail(
        `${toolResultText(res)}\n\nAND — checked after that failure — ${drift.activeLabel} is the ` +
          `ACTIVE workflow now, not ${path}. Whatever that message says about ${path} being active, ` +
          `it is not: the canvas you would read or write is ${drift.activeLabel}. Do NOT save, ` +
          `save-as, or edit expecting ${path}. Call panel_list_workflows to see the current state.`,
      );
    }
    {
      const drift = await refreshOpenWorkflowUuid(ctx, path, res);
      // #887 — the read above is the ONLY observation in this whole path taken
      // after a real round trip, so it is the only thing that can catch the active
      // pointer having settled elsewhere. It already declined to adopt the uuid;
      // reporting a plain success alongside that silence is what let an agent
      // Save-As onto the wrong canvas.
      //
      // This FAILS the open rather than annotating it. The caller asked for a
      // workflow to be made active and it is not active — a success naming the
      // requested path is false on the one point the caller acts on, and the next
      // act is typically a write. The session's fence is untouched (nothing was
      // adopted), so the tab that IS active keeps its own protection.
      if (drift) {
        return fail(
          `workflow_open: ${path} was opened, but ${drift.activeLabel} is the ACTIVE workflow now — ` +
            `the panel confirmed this on a re-read after the open completed. This session's ` +
            `workflow identity was NOT re-pointed at ${path}, so the canvas you would read or ` +
            `write is ${drift.activeLabel}, not ${path}. Do NOT save, save-as, or edit expecting ` +
            `${path}. Call panel_list_workflows to see the current state, then re-open ${path} ` +
            `if you still need it — another tab became active during or after the open.`,
        );
      }
    }
    return res;
  }

  if (!dispatchedRid) {
    return fail(
      `${toolResultText(res)}\n\nworkflow_open outcome is undetermined: the command may have been sent, but this ` +
        `bridge/panel combination did not expose a request id for receipt correlation. Do not assume ` +
        `the workflow was opened; inspect the current workflow before deciding whether to retry.`,
    );
  }
  const timing = getOpenVerifyTiming();
  const verify = await waitForOpenReceipt(ctx, path, dispatchedRid, timing);
  if (verify.receipt === "applied") {
    if (verify.workflowUuid) refreshWorkflowUuid(ctx, { workflow_uuid: verify.workflowUuid });
    return ok({
      opened: { path },
      recovered: true,
      note:
        `"${path}" was confirmed applied by the panel's request-id-correlated open receipt after ` +
        `${(verify.waited_ms / 1000).toFixed(1)}s (${verify.attempts} probe${verify.attempts === 1 ? "" : "s"}). ` +
        `Do NOT retry.`,
    });
  }
  // The ack was inconclusive and the receipt did not prove application.
  if (verify.receipt === "not_applied") {
    return fail(
      `workflow_open was confirmed not applied by the panel's request-id-correlated receipt` +
        `${verify.error ? `: ${verify.error}` : "."} It is safe to retry.`,
    );
  }
  const reason =
    verify.receipt === "unsupported"
      ? "this panel version does not provide request-id-correlated open receipts"
      : verify.receipt === "unknown"
        ? "the matching panel receipt did not confirm that the command was applied"
        : "no request-id-correlated panel receipt was observed";
  return fail(
    `${toolResultText(res)}\n\nworkflow_open outcome is undetermined: ${reason}. ` +
      `Do not assume the workflow was opened; inspect the current workflow before deciding whether to retry.`,
  );
}

/** True when a ToolResult is a MID-COMMAND reconnect drop ("disconnected
 *  mid-command … OUTCOME UNKNOWN") — the command was written but the tab dropped
 *  before a reply while reconnecting after a restart/reload (#402). Re-verifying an
 *  idempotent workflow-state change is safe on this signal. */
function isReconnectDrop(res: ToolResult): boolean {
  if (!res?.isError) return false;
  const text = res?.content?.find((c) => c.type === "text")?.text ?? "";
  // A pre-write "NOT dispatched" send failure must NOT verify (nothing happened) —
  // let it surface as-is; only a POST-write mid-command drop is re-verifiable.
  if (/NOT dispatched/i.test(text)) return false;
  return /disconnected mid-command|OUTCOME UNKNOWN/i.test(text);
}

/** An open-workflow record as reported by `workflow_list` (path/filename/key). */
interface OpenWorkflowRecord {
  path?: string;
  filename?: string;
  key?: string;
  /** Per-instance routing id ("wf:<path>" saved / "tmp:<uuid>" unsaved). */
  routing_key?: string;
  /** Per-record authoritative "is the active canvas" flag from workflow_list. */
  active?: boolean;
}

/**
 * The matched open-workflow record PLUS whether it is the ACTIVE canvas. The panel
 * has no way to read/mutate a NON-active workflow's graph (every graph executor runs
 * against app.canvas.graph and fails closed on a workflow_path mismatch — panel
 * #349/#186), so a pin can only be honored when its target is the workflow currently
 * in view. `isActive` lets the caller reject an open-but-background pin AT PIN TIME
 * instead of accepting it and surfacing a deferred "workflow mismatch" on the next
 * graph call (#556/#571).
 */
interface ResolvedOpenWorkflow {
  record: OpenWorkflowRecord;
  /**
   * TRI-STATE. `true` = the target IS the active canvas (pin honorable). `false` =
   * the target is POSITIVELY KNOWN to be a background tab (reject at pin time). `undefined`
   * = INDETERMINATE (the list carried no active signal — older/partial panel); the caller
   * must stay LENIENT and pin anyway rather than fail closed (#556/#571 vs older-panel compat).
   */
  isActive?: boolean;
  /** Human label for the workflow currently active (for a clear pin-time error). */
  activeLabel?: string;
  /** UUID from the same authoritative active workflow_list record, if valid. */
  workflowUuid?: string;
}

/**
 * Resolve a caller-supplied pin `path` (path / filename / key, any form) to the
 * AUTHORITATIVE open-workflow record from a fresh `workflow_list` — the single
 * source of truth for which tabs exist, their canonical `key`, and which one is
 * ACTIVE (#259). Returns:
 *  - a {record, isActive} pair when the workflow IS open (so the caller can
 *    canonicalize the pin to its stable key AND reject a background target that the
 *    panel could never route to — #556/#571);
 *  - `null` when workflow_list is unreachable/empty or carries no `workflows`
 *    array (indeterminate — caller should fall back to the raw path, NOT fail);
 *  - the sentinel `NOT_OPEN` when the list IS known but the target is absent, so
 *    the caller can FAIL CLOSED instead of letting the panel silently route the
 *    pin to some other open tab.
 */
const NOT_OPEN = Symbol("workflow-not-open");
async function resolveOpenWorkflow(
  ctx: PanelToolCtx,
  path: string,
): Promise<ResolvedOpenWorkflow | null | typeof NOT_OPEN> {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = parseToolResultJson(await ctx.call({ cmd: "workflow_list" }, 6000));
  } catch {
    return null; // transport error — indeterminate, don't fail the pin
  }
  if (!parsed) return null;
  const rawList = (parsed as { workflows?: unknown }).workflows;
  if (!Array.isArray(rawList) || rawList.length === 0) {
    // No enumerable tab list (older panel / stub) — can't verify, don't fail closed.
    return null;
  }
  const activeObj = (parsed as { active?: unknown }).active;
  const activeLabel = workflowRecordLabel(activeObj);

  // A caller token (path / filename / key) can match MORE THAN ONE open record —
  // e.g. two tabs share the filename "A.json" from different dirs, or two never-saved
  // tabs. Selecting the wrong same-token record and then reading its `active` flag would
  // misjudge active-ness (codex P1). So gather ALL matches and disambiguate toward the
  // one that is actually the live canvas before deciding.
  const matches = rawList.filter((wf) => activeMatchesTarget(wf, path)) as OpenWorkflowRecord[];
  let rec: OpenWorkflowRecord | undefined;
  if (matches.length === 1) {
    rec = matches[0];
  } else if (matches.length > 1) {
    // Prefer an EXACT stable-identity (key/path) match to the caller token; then prefer
    // the record that is the active canvas; otherwise leave it unresolved and let the
    // active-object branch / NOT_OPEN handle it (never guess among ambiguous tabs).
    const exact = matches.filter((m) => m.key === path || m.path === path);
    const activePreferred = matches.filter((m) => m.active === true || recMatchesActive(m, activeObj));
    rec = exact.length === 1 ? exact[0] : activePreferred.length === 1 ? activePreferred[0] : undefined;
  }

  if (rec) {
    const isActive = computeIsActive(rec, activeObj);
    // Only the top-level active object is the panel's direct current-canvas
    // report. An affirmatively-active per-record flag alone remains sufficient
    // to route a legacy pin, but is NOT enough to replace a command identity:
    // a stale/mixed list can say `rec.active:true` for A while top-level active
    // (and its UUID) is B. Refresh only when both expose the same exact saved
    // path/routing identity; aliases and routing tokens are deliberately
    // irrelevant. The caller-path check happens in resolvePinTarget(), where
    // the refreshed value is handed to the bridge-owned command fence.
    const workflowUuid =
      isActive === true &&
      activeRecordMatchesExactSavedIdentity(rec, activeObj)
        ? responseWorkflowUuid(activeObj)
        : undefined;
    return { record: rec, isActive, activeLabel, workflowUuid };
  }
  // The active object is authoritative too, in case it isn't mirrored in the array.
  if (activeMatchesTarget(activeObj, path)) {
    return {
      record: activeObj as OpenWorkflowRecord,
      isActive: true,
      activeLabel,
      // The top-level active object was not corroborated by a selected entry in
      // workflow_list. It may remain a compatibility-valid pin selector, but it
      // is never a safe source for replacing a command fence.
      workflowUuid: undefined,
    };
  }
  return NOT_OPEN;
}

/**
 * Is `rec` the active canvas? TRI-STATE (#556/#571):
 *  - the record's OWN `active` boolean is authoritative and immune to filename aliasing;
 *  - else compare `rec` to the `active` object by STABLE identity (key/path/routing_key —
 *    never filename alone, which can collide across tabs). This yields `true`/`false`
 *    ONLY when the two share a COMPARABLE identity dimension;
 *  - else (no per-record flag AND nothing comparable) → `undefined` (indeterminate): the
 *    caller must stay lenient rather than fail a valid pin on an older/partial panel.
 */
function computeIsActive(rec: OpenWorkflowRecord, activeObj: unknown): boolean | undefined {
  if (typeof rec.active === "boolean") return rec.active;
  return identityVerdict(rec, activeObj);
}

/**
 * Per-tab unsaved handle (`tmp:<id>`). Unsaved tabs have no path/filename; this
 * is the only unique identity they publish. Accepts any non-empty `tmp:` token
 * (not only RFC-uuid suffixes) so a panel that mints a shorter handle still
 * corroborates — `canonicalUnsavedWorkflowIdentity` stays strict for OPEN,
 * which is a caller-supplied selector.
 */
function recordTmpHandle(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { key?: unknown; routing_key?: unknown };
  for (const v of [rec.routing_key, rec.key]) {
    if (typeof v === "string" && /^tmp:\S+$/.test(v)) return v;
  }
  return null;
}

/** Canonical saved path, or null when the record is unsaved / has no path. */
function recordSavedPath(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  return canonicalSavedWorkflowPath((value as { path?: unknown }).path);
}

/**
 * #1650 — the unique flagged-active list entry and the top-level `active`
 * record describe the same UNSAVED canvas even when they do not share a
 * pairable field. True only when BOTH sides lack a saved path and at least
 * one carries a `tmp:` handle. A saved path on either side is a different
 * canvas (or a mixed reply), not a missing field.
 */
function unsavedTmpHandleCorroborates(listRec: unknown, activeObj: unknown): boolean {
  if (recordSavedPath(listRec) || recordSavedPath(activeObj)) return false;
  if (!(recordTmpHandle(listRec) || recordTmpHandle(activeObj))) return false;
  const listUuid = responseWorkflowUuid(listRec);
  const activeUuid = responseWorkflowUuid(activeObj);
  // Two published uuids that disagree are a mixed reply, not a missing field.
  if (listUuid && activeUuid && listUuid !== activeUuid) return false;
  return true;
}

/**
 * Record to adopt a fence uuid from. Prefer the top-level `active` object
 * (it is the one that historically carries `workflow_uuid`); fall back to
 * the flagged list row when only that row published one.
 */
function fenceRecordForAdoption(
  listRec: OpenWorkflowRecord,
  activeObj: unknown,
): Record<string, unknown> {
  const active = activeObj as Record<string, unknown>;
  if (responseWorkflowUuid(active)) return active;
  const list = listRec as Record<string, unknown>;
  if (responseWorkflowUuid(list)) return list;
  return active;
}

/**
 * Stable-identity (key/path/routing_key/tmp: handle) verdict between a record and the
 * active object. Returns `true` on a positive match, `false` only when the two expose a
 * COMPARABLE field (both non-empty) that DISAGREES, and `undefined` when they share no
 * comparable field at all (so the caller cannot conclude "background" — stay lenient).
 * Filename is never used (it collides across tabs).
 */
function identityVerdict(rec: OpenWorkflowRecord, activeObj: unknown): boolean | undefined {
  if (!activeObj || typeof activeObj !== "object") return undefined;
  const a = activeObj as {
    path?: unknown;
    key?: unknown;
    routing_key?: unknown;
    workflow_uuid?: unknown;
  };
  const r = rec as {
    path?: unknown;
    key?: unknown;
    routing_key?: unknown;
    workflow_uuid?: unknown;
  };
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const pairs: Array<[unknown, unknown]> = [
    [r.key, a.key],
    [r.path, a.path],
    [r.routing_key, a.routing_key],
    [r.key, a.routing_key],
    [r.routing_key, a.key],
    // #1650 — a tmp: handle is a per-tab identity, not a saved path. Pair it
    // the same way key↔routing_key is paired so an unsaved canvas is not
    // treated as "no comparable field" when one side published `key` and the
    // other published `routing_key` (or vice versa).
    [recordTmpHandle(r), recordTmpHandle(a)],
    [r.workflow_uuid, a.workflow_uuid],
  ];
  // A CONTRADICTION OUTRANKS AN AGREEMENT (codex gate P0). Returning `true` on
  // the first equal pair meant a mixed reply — matching `key`, conflicting
  // `path` — was adopted as a positive identity without the disagreeing field
  // ever being read. That is not merely an unverified positive; it is a
  // contradicted one, and it could mint the very instance-mismatch wedge this
  // recovery exists to clear.
  //
  // Only SAME-FIELD pairs can contradict DECISIVELY here. The cross pairs below
  // (key↔routing_key) are alias attempts: their agreement is evidence, but their
  // disagreement means only "these two namespaces differ", which is ordinary.
  //
  // Note what the tail of this function still does: when the ONLY comparable
  // pairs were cross ones and none agreed, it returns `false` rather than
  // `undefined`. That is deliberately conservative — `false` refuses the
  // adoption, and refusing to replace a command fence on an uncorroborated
  // reading is the safe direction. It is not a claim that the two identities
  // were proven different, and nothing downstream may read it as one.
  // Compared through the SAME canonicalizer the rest of this file uses, not as
  // raw strings (codex gate). `./workflows/a.json` and `workflows/a.json` are one
  // saved identity; declaring them a contradiction would refuse a legitimate
  // recovery — this defect class pointed the other way, which is exactly what the
  // contradiction check was added to avoid committing.
  //
  // `key` is compared raw because it is an opaque panel handle with no path
  // syntax to normalize; the other two are paths and are normalized as such.
  const sameField: Array<[unknown, unknown, (v: unknown) => string | null]> = [
    [r.key, a.key, (v) => (nonEmpty(v) ? v : null)],
    [r.path, a.path, canonicalSavedWorkflowPath],
    [r.routing_key, a.routing_key, canonicalSavedWorkflowRoutingIdentity],
    [recordTmpHandle(r), recordTmpHandle(a), (v) => (nonEmpty(v) ? v : null)],
    [
      r.workflow_uuid,
      a.workflow_uuid,
      (v) => (typeof v === "string" && WORKFLOW_UUID_RE.test(v) ? v : null),
    ],
  ];
  for (const [x, y, canon] of sameField) {
    if (!nonEmpty(x) || !nonEmpty(y)) continue;
    const cx = canon(x);
    const cy = canon(y);
    // If either side does not canonicalize, we could not compare them — which is
    // not the same as finding them different. Leave it to the pair loop below.
    if (cx === null || cy === null) continue;
    if (cx !== cy) return false;
  }

  let comparable = false;
  for (const [x, y] of pairs) {
    if (nonEmpty(x) && nonEmpty(y)) {
      comparable = true;
      if (x === y) return true;
    }
  }
  return comparable ? false : undefined;
}

/**
 * Exact saved-workflow identity required before an active-list UUID can refresh
 * a command fence. `activeMatchesTarget()` and an item's `active:true` are
 * intentionally alias/compatibility-friendly for pin resolution; neither can
 * prove that the record carrying the pin and top-level `active` name the same
 * saved canvas. Reject contradictory path/routing pairs and never fall back to
 * filename, basename, or key aliases here.
 */
function activeRecordMatchesExactSavedIdentity(rec: OpenWorkflowRecord, activeObj: unknown): boolean {
  if (!activeObj || typeof activeObj !== "object") return false;
  const recordIdentity = canonicalSavedRecordIdentity(rec);
  const activeIdentity = canonicalSavedRecordIdentity(activeObj);
  return !!recordIdentity && recordIdentity === activeIdentity;
}

/** Canonical `wf:<path>` identity for a caller's literal saved-workflow path. */
function canonicalRequestedSavedIdentity(path: unknown): string | null {
  const canonicalPath = canonicalSavedWorkflowPath(path);
  // A bare basename is an alias selector, not the canonical saved path the
  // command fence must bind. It may still resolve a legacy pin, but must never
  // authorize replacing its existing UUID stamp.
  return canonicalPath && canonicalPath.includes("/") ? `wf:${canonicalPath}` : null;
}

/**
 * Canonical `wf:<path>` identity, but only for a complete corroborating record.
 * Command-fence replacement is stricter than pin routing: a same-path record
 * with a missing/malformed route may be partial or replayed, and must not let a
 * new UUID replace the existing fail-closed stamp.
 */
function canonicalSavedRecordIdentity(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { path?: unknown; routing_key?: unknown };
  const path = canonicalSavedWorkflowPath(record.path);
  const routing = canonicalSavedWorkflowRoutingIdentity(record.routing_key);
  // Both fields must be present and corroborate. A mixed, partial, or replayed
  // snapshot is not a safe source of a command-fence replacement.
  if (!path || !routing || routing !== `wf:${path}`) return null;
  return routing;
}

function canonicalSavedWorkflowRoutingIdentity(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("wf:")) return null;
  const path = canonicalSavedWorkflowPath(value.slice(3));
  return path ? `wf:${path}` : null;
}

/**
 * #812 — an UNSAVED workflow has no saved path, so `canonicalRequestedSavedIdentity`
 * always returns null for it, and `refreshOpenWorkflowUuid` bails out before ever
 * consulting the reply. `panel_open_workflow(tmp:<uuid>)` on the panel's OWN
 * routing_key succeeded (`opened:true`) but never refreshed the fence — the ONLY
 * documented recovery for a just-created blank tab, reported as leaving the tool
 * "effectively unusable whenever this fires."
 *
 * A `tmp:<uuid>` token is not an alias needing corroboration the way a saved path's
 * basename is (#716 P1's concern) — it is the per-tab routing id itself, unique by
 * construction. So the identity check here is a single exact-string equality, not a
 * lookup: does the caller's literal request match the panel's own proven routing_key
 * for the tab it just opened? No resolution happens on either side.
 *
 * Strict RFC-uuid suffix (same `WORKFLOW_UUID_RE` the command-fence stamp itself is
 * validated against) so a malformed or truncated token is never treated as a match.
 */
function canonicalUnsavedWorkflowIdentity(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("tmp:")) return null;
  return WORKFLOW_UUID_RE.test(value.slice(4)) ? value : null;
}

/** Stable-identity match (positive only) — used to prefer the active record among matches. */
function recMatchesActive(rec: OpenWorkflowRecord, activeObj: unknown): boolean {
  return identityVerdict(rec, activeObj) === true;
}

/** Best-effort human label for a workflow_list record/active object. */
function workflowRecordLabel(rec: unknown): string | undefined {
  if (!rec || typeof rec !== "object") return undefined;
  const r = rec as { filename?: unknown; title?: unknown; path?: unknown; key?: unknown };
  for (const v of [r.filename, r.title, r.path, r.key]) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/** Outcome of validating + canonicalizing a pin target. */
export type PinTargetResolution =
  | { ok: true; pinPath: string; pinFilename?: string; workflowUuid?: string }
  | { ok: false; error: string };

/**
 * Validate and canonicalize a pin `path` to a routable target, SHARED by every entry
 * point that writes a pinned workflow target (the MCP tool AND the panel-driven
 * set_workflow_target event) so none can bypass the guarantees:
 *  - FAIL CLOSED when the workflow isn't open (#259) — never route the pin to another tab;
 *  - FAIL AT PIN TIME when it is open but NOT the active canvas (#556/#571) — the panel can
 *    only read/edit the in-view workflow (panel #349/#186), so a background pin would only
 *    defer a "workflow mismatch"; reject it honestly and immediately;
 *  - otherwise canonicalize to the stable `key` (survives rename/reconnect);
 *  - INDETERMINATE lists (older/partial panel — no `workflows` array, or no comparable
 *    active identity) stay LENIENT: pin the raw path rather than fail a valid pin.
 */
export async function resolvePinTarget(
  ctx: PanelToolCtx,
  path: string,
  filename: string | undefined,
): Promise<PinTargetResolution> {
  const resolved = await resolveOpenWorkflow(ctx, path);
  if (resolved === NOT_OPEN) {
    return {
      ok: false,
      error:
        `Cannot pin to "${path}" — it is not open in ComfyUI. Open it first ` +
        `(panel_open_workflow) or pick an open workflow from panel_list_workflows, ` +
        `then pin. (Refusing to pin to a workflow that isn't open so graph edits ` +
        `never land on the wrong tab.)`,
    };
  }
  if (resolved && resolved.isActive === false) {
    const activeName = resolved.activeLabel ? ` (currently "${resolved.activeLabel}")` : "";
    return {
      ok: false,
      error:
        `Cannot pin to "${filename ?? path}" — it is open but not the active canvas${activeName}. ` +
        `The panel can only read or edit the workflow that is currently in view, so a background ` +
        `pin would fail on your next panel_* graph call. To work on it, switch to it first with ` +
        `panel_open_workflow (that makes it the active canvas), then pin — or, if you meant to ` +
        `edit the workflow already in view, pin that one instead. (Pinning does not switch the ` +
        `user's view and cannot route edits to a background tab.)`,
    };
  }
  if (resolved) {
    // Canonicalize to the stable key so routing survives rename/reconnect.
    const rec = resolved.record;
    // `resolveOpenWorkflow()` establishes whether rec and top-level active are
    // exact two-field peers. That is still insufficient to replace a command
    // fence when the caller supplied a basename/key/routing alias: retain the
    // legacy pin resolution, but adopt its UUID only for the caller's own exact
    // canonical saved path.
    const callerIdentity = canonicalRequestedSavedIdentity(path);
    const workflowUuid =
      callerIdentity && callerIdentity === canonicalSavedRecordIdentity(rec)
        ? resolved.workflowUuid
        : undefined;
    return {
      ok: true,
      pinPath: rec.key ?? rec.path ?? path,
      pinFilename: filename ?? rec.filename ?? rec.path,
      workflowUuid,
    };
  }
  // Indeterminate list — stay lenient (older/partial panel).
  return { ok: true, pinPath: path, pinFilename: filename };
}

export const __openWorkflowTestHooks = {
  /** Inject fast open-verify timing so tests don't wait the real ~6s budget. */
  setOpenVerifyTiming(timing: OpenVerifyTiming | null): void {
    openVerifyTimingOverride = timing;
  },
  isAckTimeout,
  activeMatchesTarget,
  activeMatchesOpenRefreshTarget,
  activeRecordMatchesExactSavedIdentity,
  resolveOpenWorkflow,
};

const slotRef = z.union([z.string(), z.number().int().min(0)]);

// CivitAI browsing-level bitmask values: PG=1, PG-13=2, R=4, X=8, XXX=16.
const KNOWN_BROWSING_LEVELS = [1, 2, 4, 8, 16];
// R/X/XXX are adult and gated behind the persistent NSFW consent (getNsfwConsent()).
const ADULT_BROWSING_LEVELS = [4, 8, 16];

/**
 * SERVER-SIDE enforcement of the persistent NSFW consent gate on any
 * agent-supplied browsing levels. The agent can pass arbitrary bitmask values;
 * this walls them before they reach the panel so adult content is never
 * surfaced without consent (matching panel_get_content_mode / the consent gate).
 *
 * - Rejects unknown levels (not in the PG..XXX enum).
 * - Rejects a supplied-but-empty array.
 * - When consent is NOT granted, strips R/X/XXX (4/8/16); if that leaves nothing,
 *   THROWS so the agent gets an honest, actionable error instead of silent SFW.
 * - Returns the sanitized, de-duped levels, or undefined when none were supplied
 *   (preserving the panel's own default, currently [1] = PG).
 */
function sanitizeBrowsingLevels(levels: unknown): number[] | undefined {
  if (levels === undefined || levels === null) return undefined;
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new Error(
      "browsingLevels must be a non-empty array of level values (PG=1, PG-13=2, R=4, X=8, XXX=16).",
    );
  }
  const nums = levels.map((l) => Number(l));
  for (const n of nums) {
    if (!KNOWN_BROWSING_LEVELS.includes(n)) {
      throw new Error(
        `Unknown browsing level ${String(n)}. Allowed: 1 (PG), 2 (PG-13), 4 (R), 8 (X), 16 (XXX).`,
      );
    }
  }
  if (getNsfwConsent().allowed) return [...new Set(nums)];
  const safe = [...new Set(nums.filter((n) => !ADULT_BROWSING_LEVELS.includes(n)))];
  if (safe.length === 0) {
    throw new Error(
      "Adult content (R/X/XXX) requires consent, which the user hasn't granted. Call panel_request_adult_consent first, or request SFW levels only (PG=1, PG-13=2).",
    );
  }
  return safe;
}

/** Normalize an agent-supplied CivitAI creator username: trim, strip a leading
 *  @, drop surrounding whitespace. Returns "" when nothing usable was supplied
 *  (so callers can treat it as "no creator filter"). */
function normalizeCreator(creator: unknown): string {
  if (typeof creator !== "string") return "";
  return creator.trim().replace(/^@+/, "").trim();
}

// ---- server-side pack workflow resolution (for panel_load_workflow) --------
// Read a bundled pack's UI workflow.json on the SERVER so the (large) graph
// never has to shuttle through the agent's conversation. Mirrors the package-
// root resolution in src/tools/skills-access.ts: this file compiles to
// dist/orchestrator/panel-tools.js, so the package root (shipping packs/) is two
// levels up.

/** A safe single path segment — a pack directory name, no traversal/separators. */
const SAFE_PACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** packs/ dir: dist/orchestrator/panel-tools.js → ../../packs */
function packsDir(): string {
  return fileURLToPath(new URL("../../packs", import.meta.url));
}

/** Read + parse a bundled pack's UI workflow.json. Name-guarded and must exist. */
function readPackWorkflow(packName: string): Record<string, unknown> {
  const name = packName.trim();
  if (!SAFE_PACK_NAME.test(name)) {
    throw new Error(`Invalid pack name "${packName}". Use a plain pack directory name from list_packs.`);
  }
  const root = packsDir();
  const packDir = join(root, name);
  if (!packDir.startsWith(root) || !existsSync(packDir) || !statSync(packDir).isDirectory()) {
    throw new Error(`No pack named "${name}". Discover valid packs with list_packs.`);
  }
  // Resolve the workflow filename from pack.yaml (default workflow.json).
  let workflowName = "workflow.json";
  const metaFile = join(packDir, "pack.yaml");
  if (existsSync(metaFile)) {
    try {
      const meta = parseYaml(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
      if (meta && typeof meta.workflow === "string") workflowName = meta.workflow;
    } catch {
      // keep default
    }
  }
  if (!SAFE_PACK_NAME.test(workflowName) && workflowName !== "workflow.json") {
    workflowName = "workflow.json";
  }
  const wfFile = join(packDir, workflowName);
  if (!wfFile.startsWith(packDir) || !existsSync(wfFile)) {
    throw new Error(`Pack "${name}" has no ready workflow (${workflowName} not found).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(wfFile, "utf8"));
  } catch (err) {
    throw new Error(`Pack "${name}" workflow.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Pack "${name}" workflow.json did not parse to an object.`);
  }
  return parsed as Record<string, unknown>;
}

// ---- server-side ARBITRARY workflow.json resolution (for panel_load_workflow path) ----
// Read a workflow JSON file off the ORCHESTRATOR's local disk so a large graph
// (e.g. a 159KB staged example) never has to shuttle through the agent's chat
// context. The agent passes a path; we read+parse here, then load via graph_load —
// the same server-side-read pattern as the `pack` option.
//
// REMOTE-COMFYUI CAVEAT: this reads the ORCHESTRATOR's filesystem. For the panel
// the orchestrator runs LOCAL to ComfyUI (same machine), so a path under the
// ComfyUI workflows dir always resolves. It does NOT work against a remote
// ComfyUI whose files the orchestrator can't see — use the inline `graph` option
// for that.

/**
 * Candidate ComfyUI workflows directories, RECONSTRUCTED from COMFYUI_PATH.
 *
 * These are GUESSES at the DEFAULT layout. ComfyUI's `--user-directory` moves the
 * whole user tree somewhere unguessable, so a hit under one of these dirs is only
 * ever the file the caller meant when the server happens to run the default
 * layout. They are therefore a LAST resort, used only when the connected ComfyUI
 * could not be asked at all (#202).
 *
 * `process.cwd()` is deliberately NOT in this list: resolving a library name
 * against whatever directory the orchestrator happened to be launched from can
 * only ever produce a file that is not the named library workflow — the
 * load-the-wrong-graph hazard. Callers who mean a file outside the library pass
 * an absolute path.
 */
function comfyWorkflowsDirs(): string[] {
  // #1512 — a trailing space here does not fail loudly: it silently builds
  // `<path> /user/default/workflows`, a directory that does not exist, so the
  // workflow library simply appears empty and every lookup misses.
  const base = normalizeInstallPathEnv(process.env.COMFYUI_PATH).path;
  if (!base) return [];
  return [
    join(base, "user", "default", "workflows"),
    join(base, "user", "workflows"),
  ];
}

// The raw-Response userdata GET (why it bypasses `fetchApi`, and what a thrown error
// vs a returned Response each prove) now lives in services/userdata-library.ts, shared
// with get_workflow (action:"list") — see #810: the two callers had drifted, one recursing into
// subfolders and one not.

/**
 * Drop the one leading "workflows/" segment from CALLER input, leaving a key that
 * is relative to the workflow store root.
 *
 * This exists only because panel_list_workflows reports store keys that already
 * carry the prefix (#414), so a caller may legitimately paste either spelling. It
 * is applied EXACTLY ONCE, to the caller's `path`, and NEVER to an entry from the
 * server's listing — those are already store-relative and stripping them again is
 * what let a nested folder named `workflows` impersonate the store root (gate
 * MAJOR); see matchName.
 *
 * Exactly one separator is consumed (codex MAJOR). "workflows//foo.json" keeps its
 * second slash and stays "/foo.json" — collapsing runs of slashes would make it an
 * alias for the different key "foo.json". A leading "/" is not removed either;
 * caller input can never reach here with one (that is an absolute path, handled
 * earlier).
 *
 * Only the literal lowercase FORWARD-slash spelling counts (codex MAJOR). ComfyUI
 * store keys are always "/"-separated and lowercase here, so `workflows\foo.json`
 * and `WORKFLOWS/foo.json` are ordinary names — a real subfolder on a
 * case-sensitive host, or a legal literal filename on POSIX — and stripping either
 * would rewrite a request into one for a different graph.
 */
const stripLibraryPrefix = (key: string): string => key.replace(/^workflows\//, "");

/**
 * The form two store-relative names are compared in when deciding they are the
 * SAME NAME. Unicode normalization is the only equivalence applied: NFD "é" and
 * NFC "é" are one character sequence written two ways, so a name pasted from a
 * listing (or produced on another OS) can be byte-different yet denote the same
 * file, and a raw byte comparison 404s on a workflow that visibly exists.
 *
 * Nothing is STRIPPED here, which is what keeps request depth matched to entry
 * depth (gate MAJOR). A recursive listing reports the root file "x.json" bare and
 * the nested file workflows/workflows/x.json as "workflows/x.json"; stripping a
 * prefix from the entry made those two collide, so a bare request could match the
 * nested entry and then fetch the DIFFERENT root file. Compared verbatim, a
 * depth-0 request can only ever match a depth-0 entry, and a request naming a
 * subfolder matches only that exact path.
 *
 * Path separators are deliberately NOT folded (codex MAJOR): on POSIX a file
 * literally named `dir\foo.json` is a DIFFERENT file from `dir/foo.json`. Case is
 * not folded either, for the same reason. Both are reported as near misses instead.
 */
const matchName = (name: string): string => name.normalize("NFC");

/** The looser form used ONLY to describe a near miss in an error message — never
 *  to select a file to load. Folds the equivalences that hold on some filesystems
 *  and not others: separator flavour, letter case and normalization. Like matchName
 *  it strips nothing, so it cannot report a nested entry as a near miss for a root
 *  name. */
const looseName = (name: string): string =>
  name.replace(/\\/g, "/").normalize("NFC").toLowerCase();
/**
 * The connected ComfyUI's OWN list of saved workflow store keys, or null when the
 * listing could not be read. This is the same source get_workflow (action:"list") reports (the
 * SAVED library, not the open tabs), so it reflects the server's runtime
 * `--user-directory` — it is asked, never reconstructed. Used only to turn an
 * authoritative "no such name" into either the server's EXACT key or an explicit
 * refusal. Never throws: an unreadable listing simply means "no extra
 * information", and the refusal says the listing could not be read.
 *
 * `recurse=true` is VERIFIED against the installed ComfyUI (0.29.2): a workflow in
 * a SUBFOLDER is absent from the plain listing and present as "sub/name.json"
 * under recurse, while root entries stay bare. Without it, a nested name that
 * differs only by Unicode normalization has no listing entry to match and is
 * refused. The parameter is safe on builds that do not implement it — an unknown
 * query arg is ignored and the flat list comes back, which is exactly the
 * pre-existing behaviour (over-refusal of nested near-misses, never a wrong file),
 * so this needs no version gate.
 */
async function listUserdataWorkflowKeys(): Promise<string[] | null> {
  // ONE listing read for the whole server (#810): the recursive route, the entry-shape
  // tolerance and the status classification all live in services/userdata-library.ts.
  // This resolver only needs "keys, or nothing", so every unreadable flavour collapses
  // to null here — which is exactly what its refusal path already means.
  const listing = await listWorkflowLibraryKeys();
  return listing.ok ? listing.keys : null;
}

/** Validate a parsed value is a UI/litegraph workflow (a top-level `nodes`
 *  array), throwing a source-labelled error otherwise. */
function assertUiWorkflow(parsed: unknown, sourceLabel: string): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${sourceLabel} did not parse to a workflow object.`);
  }
  if (!Array.isArray((parsed as Record<string, unknown>).nodes)) {
    throw new Error(
      `${sourceLabel} is not a UI workflow (missing a top-level \`nodes\` array). ` +
        `Provide a UI/litegraph workflow JSON, not API/prompt format.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Read + parse a UI workflow JSON by path.
 *
 * An ABSOLUTE path is read off the orchestrator's own disk, unchanged.
 *
 * A RELATIVE name is resolved AUTHORITATIVELY by the CONNECTED ComfyUI's userdata
 * API — the same source get_workflow (action:"list") / panel_open_workflow read. That
 * server resolves the name under its RUNTIME `--user-directory`, so a custom user
 * directory just works and a same-named file under a reconstructed default-layout
 * path can never shadow it (#202).
 *
 * The governing rule is that loading the WRONG graph is worse than loading none,
 * so the resolver never guesses:
 *   - server serves the file            → load it
 *   - server refuses (401/403/5xx)      → error, no local fallback
 *   - server says it has no such name   → retry the server's OWN exact key if its
 *                                         listing has a single UNICODE-NORMALIZATION
 *                                         match (case and separator differences are
 *                                         named, never substituted), otherwise
 *                                         REFUSE — an absence from the authority
 *                                         means any local hit is a DIFFERENT file
 *   - name matches several library keys → REFUSE as ambiguous, naming them
 *   - NO HTTP RESPONSE AT ALL           → best-effort reconstructed local dirs,
 *                                         and REFUSE if more than one file matches
 *
 * That last line is the only branch that guesses, and it is deliberately narrow: a
 * reply that ARRIVED but could not be decoded is a refusal, not an absence of
 * authority. See userdataFetch for why the request bypasses the client's
 * throw-on-non-2xx wrapper to make that distinction sound.
 *
 * Guards: must be .json and must parse to a UI workflow (a top-level `nodes`
 * array). Every failure names exactly what was tried.
 */
async function readWorkflowFromPath(rawPath: string): Promise<Record<string, unknown>> {
  const p = (rawPath ?? "").trim();
  if (!p) throw new Error("Provide a non-empty `path` to a workflow .json file.");
  if (!/\.json$/i.test(p)) {
    throw new Error(`"${p}" is not a .json file — pass the path to a ComfyUI workflow JSON.`);
  }

  const readLocal = (resolved: string): Record<string, unknown> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(resolved, "utf8"));
    } catch (err) {
      throw new Error(`"${resolved}" is not valid JSON: ${(err as Error).message}`);
    }
    return assertUiWorkflow(parsed, `"${resolved}"`);
  };

  // ABSOLUTE path → the orchestrator's own disk, unchanged.
  if (isAbsolute(p)) {
    const resolved = resolve(p);
    if (existsSync(resolved) && statSync(resolved).isFile()) return readLocal(resolved);
    throw new Error(
      `No workflow file at "${p}". Looked under ${resolved}. ` +
        `Pass an absolute path, or a name relative to the ComfyUI workflows folder.`,
    );
  }

  // RELATIVE name → the AUTHORITATIVE source is the connected ComfyUI's userdata
  // API (the SAME source get_workflow (action:"list") / panel_open_workflow read): it resolves
  // under the runtime `--user-directory`, so a CUSTOM user-dir loads the correct
  // file and a stale same-named file under the orchestrator's guessed default
  // dir can't shadow it (#202). Try it FIRST; fall back to local disk ONLY when
  // the server genuinely lacks the name (404) or can't be reached — NOT when it
  // refuses (401/403/5xx) or returns a malformed file, which must surface their
  // own honest error rather than silently loading a possibly-stale local file.
  type Outcome =
    | { kind: "found"; parsed: unknown }
    | { kind: "malformed"; detail: string } // 2xx but bad JSON → error, no guessing
    | { kind: "refused"; detail: string } // non-404 HTTP status → error, no guessing
    | { kind: "absent"; detail: string } // server ANSWERED "no such name" → authoritative
    | { kind: "unreachable"; detail: string }; // no answer at all → no authority
  // #414: panel_list_workflows reports each workflow's userdata STORE KEY, which
  // already carries the "workflows/" prefix (e.g. "workflows/Daily Anime.json").
  // Feeding that exact value back here double-prefixed it to
  // "workflows/workflows/Daily Anime.json" → a 404 → the local fallback missed too
  // → "No workflow file at …", even though it is the documented list output. Strip
  // one leading "workflows/" segment so the list key, a bare name, and a subfolder
  // path all normalize to the same store-relative name. (A genuinely absolute path
  // — including a Windows leading-slash path — was already handled and returned
  // above, so it never reaches this relative-name normalization.)
  const rel = stripLibraryPrefix(p);
  // Refuse traversal / drive-relative escapes (codex): a real workflow name is a
  // plain relative path whose segments are filenames/subfolders. Stripping the
  // "workflows/" prefix must never turn the input into something that ESCAPES the
  // workflows root — both in the userdata key sent to the server and in the local
  // resolve(dir, rel) fallback. Reject a ".." segment ("workflows/../secret.json")
  // and a Windows DRIVE-RELATIVE segment ("C:..", "C:foo", which resolve()
  // canonicalizes with drive semantics past a plain ".."-segment check). A colon
  // ELSEWHERE is a legal POSIX filename char (e.g. "style:anime.json"), so match
  // only a leading drive-letter form — not every colon. The realpath containment
  // check below is the authoritative backstop for the local read regardless.
  const relSegs = rel.split(/[\\/]+/);
  if (relSegs.includes("..") || relSegs.some((s) => /^[A-Za-z]:/.test(s))) {
    throw new Error(
      `"${p}" is not a valid workflow name — pass a name relative to the ComfyUI ` +
        `workflows folder (no "..", drive letters, or absolute paths), or an absolute path.`,
    );
  }
  // One userdata GET, classified. `key` is the STORE key (already "workflows/…").
  //
  // The request goes through userdataFetch, which returns the raw Response instead
  // of the client's throw-on-non-2xx wrapper. That is what makes this split sound
  // (gate MAJOR): the ONLY way to land in the catch is for no Response to exist at
  // all, so "the server refused with a body we could not decode" can never be
  // mistaken for "the server was never reached" and re-open the local fallback.
  const fetchUserdataKey = async (key: string): Promise<Outcome> => {
    let res: Response;
    try {
      res = await userdataFetch(`/api/userdata/${encodeURIComponent(key)}`);
    } catch (err) {
      // No Response object exists — the request never received an answer
      // (connection refused, DNS, TLS, timeout), or no client could be built at
      // all. This is the ONLY outcome that leaves the orchestrator without an
      // authority to defer to.
      return {
        kind: "unreachable",
        detail: `the connected ComfyUI's workflow library could not be reached (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    // From here the server ANSWERED. Every remaining outcome is authoritative, and
    // none of them may fall back to a reconstructed local path.
    if (!res.ok) {
      if (res.status === 404) {
        return { kind: "absent", detail: `is not in the connected ComfyUI's workflow library (HTTP 404 for "${key}")` };
      }
      return { kind: "refused", detail: `ComfyUI userdata library returned HTTP ${res.status} for "${key}"` };
    }
    // Read the body as TEXT and classify HERE so a malformed 2xx surfaces its OWN
    // error, while ComfyUI's "200 + EMPTY body = file does not exist" convention
    // (some builds; see parseWorkflowLock) is an ABSENCE — an authoritative "no
    // such name", not a malformed file. A body that cannot be read is a REFUSAL:
    // the server answered, we simply could not decode it.
    let body: string;
    try {
      body = (await res.text()).trim();
    } catch (err) {
      return {
        kind: "refused",
        detail:
          `ComfyUI answered ${res.status} for "${key}" but the response body could not be read ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      };
    }
    if (body === "") {
      return { kind: "absent", detail: `is not in the connected ComfyUI's workflow library (empty 200 response for "${key}")` };
    }
    try {
      return { kind: "found", parsed: JSON.parse(body) };
    } catch (err) {
      return { kind: "malformed", detail: err instanceof Error ? err.message : String(err) };
    }
  };

  const requestedKey = `workflows/${rel}`;
  let outcome = await fetchUserdataKey(requestedKey);
  let resolvedKey = requestedKey;
  // Every store key this call asked for, in order, so a refusal can name them all.
  const attempted: string[] = [requestedKey];

  /** Re-ask the server under a different spelling of the SAME name, without letting
   *  the follow-up weaken what the server already told us. Returns true when the
   *  retry settled the outcome (i.e. produced something other than another
   *  authoritative absence). */
  const reask = async (key: string, onUnreachable: (detail: string) => string): Promise<boolean> => {
    attempted.push(key);
    const retry = await fetchUserdataKey(key);
    if (retry.kind === "unreachable") {
      // The server ALREADY answered. A transport blip on the follow-up does not
      // un-answer that (codex MAJOR): letting it become "unreachable" would re-open
      // the reconstructed-local-dir fallback after the authority had spoken.
      outcome = { kind: "refused", detail: onUnreachable(retry.detail) };
      return true;
    }
    outcome = retry;
    if (retry.kind !== "absent") {
      // Remember which key was actually read, so a malformed / non-UI file names the
      // file that was consulted rather than the caller's spelling.
      resolvedKey = key;
      return true;
    }
    return false;
  };

  // SEPARATOR SPELLING, asked SERVER-FIRST (gate MEDIUM). The store key space is
  // "/"-separated, so a backslash in the name is ONE literal character to the server
  // — and on POSIX that is a legal filename — so the literal spelling must be asked
  // for FIRST. Only once the server has authoritatively said it has no such file is
  // the Windows-style reading tried, and both attempts are named in any refusal.
  //
  // That keeps a Windows caller's "recipes\name.json" working: it used to resolve
  // through the local fallback, so refusing it outright was a regression on a path
  // that worked, for panel_strip_workflow as much as panel_load_workflow. And it
  // never substitutes a file while the literally-named one might still exist,
  // because the literal key is disproved by the authority before the retry happens.
  let matchRel = rel;
  if (outcome.kind === "absent" && rel.includes("\\")) {
    const slashRel = rel.replace(/\\/g, "/");
    const slashKey = `workflows/${slashRel}`;
    if (slashKey !== requestedKey) {
      const settled = await reask(
        slashKey,
        (d) => `"${rel}" is not in the library, and re-reading it as "${slashRel}" failed: ${d}`,
      );
      // Absent under BOTH spellings: the literal reading is disproved, so the
      // forward-slash reading is the only one left for the listing lookup below.
      if (!settled) matchRel = slashRel;
    }
  }

  // The server ANSWERED "no such name". Before giving up, ask it for its OWN listing
  // and look for the same name in a different Unicode normal form — a name pasted
  // from a listing (or produced on another OS) can be byte-different yet denote the
  // same file, which is how a workflow that get_workflow (action:"list") plainly shows still 404s
  // here. Only the SERVER's own entry is retried, so this resolves the name the
  // connected ComfyUI itself reports; it never reconstructs a path. More than one
  // match is AMBIGUOUS and is refused rather than guessed at.
  //
  // Listing entries are store-RELATIVE and carry NO prefix — verified on 0.29.2,
  // where root files come back bare and nested ones as "sub/name.json" — so the
  // store key is simply the entry under the library root, and nothing about the
  // entry is rewritten (gate MAJOR). Stripping a "workflows/" prefix from an entry
  // was how a subfolder literally named `workflows` came to impersonate the store
  // root: its file lists as "workflows/x.json", which stripped to "x.json" and
  // collided with the ROOT file of that name, so a bare request matched the nested
  // entry and then fetched the different root file.
  const storeKeyForListed = (listedKey: string): string => `workflows/${listedKey}`;

  let listedButUnserved: string | null = null;
  let nearMisses: string[] = [];
  let listingUnreadable = false;
  if (outcome.kind === "absent") {
    const rawListed = await listUserdataWorkflowKeys();
    listingUnreadable = rawListed === null;
    // A listing entry is server-supplied data, so it gets the SAME escape guard as
    // caller input before it is echoed back as a request key. The split is
    // deliberately liberal about separators — that is a REJECTION rule, where being
    // over-inclusive can only refuse more, never resolve to another file.
    const listed = rawListed?.filter((k) => {
      const segs = k.split(/[\\/]+/);
      return !segs.includes("..") && !segs.some((s) => /^[A-Za-z]:/.test(s));
    });
    if (listed) {
      // Compared VERBATIM apart from Unicode normalization, which is what keeps
      // request depth matched to entry depth: a name with no separator can only
      // equal a depth-0 entry, and a name that includes a subfolder can only equal
      // that exact path. Letter case and separator flavour are deliberately not
      // folded — on a case-sensitive host "Foo.json" and "foo.json" are two
      // different files — so those are NAMED as near misses below, never served.
      const want = matchName(matchRel);
      const matches = listed.filter((k) => matchName(k) === want);
      if (matches.length > 1) {
        throw new Error(
          `"${p}" is ambiguous in the connected ComfyUI's workflow library — it matches ` +
            `${matches.length} saved workflows (${matches.map((k) => `"${k}"`).join(", ")}). ` +
            `Refusing to guess which one you meant: pass the exact name from get_workflow (action:"list"), ` +
            `or an absolute path.`,
        );
      }
      if (matches.length === 1) {
        const retryKey = storeKeyForListed(matches[0]);
        // Only re-ask when the server's spelling actually differs from every key
        // already sent — otherwise this repeats a request that just failed.
        if (!attempted.includes(retryKey)) {
          await reask(
            retryKey,
            (d) => `the library lists "${matches[0]}", but re-reading it failed: ${d}`,
          );
        }
        // Still absent after retrying the server's OWN entry: the library lists the
        // name but will not serve it. Say so — that is a server-side condition the
        // user must see, not a cue to go hunting for a local file.
        if (outcome.kind === "absent") listedButUnserved = matches[0];
      } else {
        // Reported only. A key that differs by separator flavour, letter case or
        // normalization is a DIFFERENT file on some filesystems, so it is never
        // substituted.
        nearMisses = listed.filter((k) => looseName(k) === looseName(matchRel));
      }
    }
  }

  if (outcome.kind === "found") {
    // A found-but-non-UI file must surface its own honest error, not silence.
    return assertUiWorkflow(
      outcome.parsed,
      `The workflow "${p}" from the ComfyUI userdata library (read as "${resolvedKey}")`,
    );
  }
  if (outcome.kind === "malformed") {
    throw new Error(
      `The workflow "${p}" in the ComfyUI userdata library (read as "${resolvedKey}") is not ` +
        `valid JSON: ${outcome.detail}`,
    );
  }
  if (outcome.kind === "refused") {
    // Server is reachable but did not serve the file — do NOT fall back to a
    // possibly-different local file; report the status honestly.
    throw new Error(
      `Could not read "${p}" from the connected ComfyUI: ${outcome.detail}. ` +
        `Pass an absolute path, or a name shown by get_workflow (action:"list").`,
    );
  }
  if (outcome.kind === "absent") {
    // AUTHORITATIVE absence. The connected ComfyUI resolved the name under its own
    // runtime `--user-directory` and said it has no such workflow — so any file the
    // orchestrator could still find by RECONSTRUCTING a default-layout path is, by
    // construction, a DIFFERENT file from the one the caller named. Loading it
    // would hand the agent the wrong graph to edit, which is worse than failing
    // (#202). Refuse, naming exactly what was tried.
    throw new Error(
      `No workflow named "${p}" — it ${outcome.detail}.` +
        (attempted.length > 1
          ? ` Asked for ${attempted.map((k) => `"${k}"`).join(" and then ")}.`
          : "") +
        (listingUnreadable
          ? ` Its workflow listing could not be read either, so no close match could be checked.`
          : "") +
        (listedButUnserved
          ? ` Its library DOES list "${listedButUnserved}", but the server would not serve that key —` +
            ` the file may have been removed or be unreadable on the ComfyUI machine.`
          : "") +
        (nearMisses.length
          ? ` The library does list ${nearMisses.map((k) => `"${k}"`).join(", ")}, which differs only` +
            ` in letter case, path separator, or Unicode normalization — a DIFFERENT file on some` +
            ` filesystems, so it was NOT substituted. Retype the name exactly if that is the one` +
            ` you meant.`
          : "") +
        ` The connected ComfyUI is the authority on its own user directory (it may have been started` +
        ` with --user-directory), so the orchestrator will NOT guess at a local path that could be a` +
        ` different file. Use a name exactly as shown by get_workflow action:"list", which reads the same library,` +
        ` or pass an absolute path.`,
    );
  }

  // outcome.kind is "unreachable": the connected ComfyUI gave no answer at all, so
  // there is no authority to defer to. Only here does the orchestrator fall back to
  // the RECONSTRUCTED default-layout workflows dirs — best-effort, and only when
  // the name resolves to exactly ONE file (two hits mean two different candidate
  // graphs, which is refused rather than guessed at).
  // Each candidate is the store-relative name resolved UNDER a base dir. Only the
  // NORMALIZED `rel` is used (never the raw `workflows/…` key), so nothing nests a
  // second workflows/ (codex P1/P2). Belt-and-suspenders containment: an existing
  // candidate is only accepted if its REAL path (symlinks/junctions resolved)
  // stays beneath the base's REAL path — so a link under the workflows dir that
  // targets an external directory can't be read on the fallback (codex).
  // Canonicalizing BOTH sides keeps a legitimately-symlinked workflows dir working
  // (its base resolves too), while blocking a per-file escape.
  //
  // KNOWN AND ACCEPTED: this check is check-then-open, so it does not survive a
  // concurrent swap of the checked file for a symlink between the realpath and the
  // read (codex MAJOR). Closing that needs an fd-based open + fstat, and the threat
  // it defends against is another process on the user's OWN machine racing their
  // own workflow load — outside this project's trust model, where the orchestrator,
  // the panel and the user are one trust domain. The check remains as a guard
  // against a statically mis-linked workflows dir, which is the accidental case
  // that actually happens.
  const realBaseUnder = (base: string, candidate: string): boolean => {
    try {
      const rb = realpathSync(base);
      const rc = realpathSync(candidate);
      return rc === rb || rc.startsWith(rb + sep);
    } catch {
      return false;
    }
  };
  /**
   * Is `name` the name the file on disk ACTUALLY has, segment for segment? When it
   * is not, report the on-disk spelling that came closest so the refusal can name
   * it.
   *
   * `resolve(dir, name)` answers in the FILESYSTEM's terms, not the store's (codex
   * MAJOR). It collapses repeated separators, so "recipes//foo.json" — a distinct
   * key everywhere else in this resolver — silently opens recipes/foo.json; and on
   * a case-insensitive volume `foo.json` opens an on-disk `Foo.json`, the very
   * substitution the server path refuses. That left the two branches applying
   * different rules to the same input depending only on whether ComfyUI answered.
   *
   * Walking the directory entries restores one rule: every segment must appear
   * VERBATIM in its parent listing. An empty segment (from a repeated separator)
   * can never match, and a case- or normalization-different on-disk name is refused
   * exactly as it would be against the server.
   *
   * The segmentation follows the PLATFORM, matching whatever `resolve()` just did
   * (codex MAJOR). On Windows a backslash is a separator — and a file literally
   * named `recipes\foo.json` cannot exist — so the folder reading is the only
   * reading. On POSIX a backslash is an ordinary filename character, `resolve()`
   * produces the LITERAL path, and this must too: splitting it there would bless a
   * folder reading that the server-first rule never authorised, letting an
   * unreachable server's `recipes/foo.json` stand in for a literal
   * `recipes\foo.json` that may well exist.
   */
  const platformSegments = (name: string): string[] =>
    name.split(sep === "\\" ? /[\\/]/ : /\//);
  const localSpelling = (
    base: string,
    name: string,
  ): { exact: true } | { exact: false; onDisk?: string } => {
    let dir = base;
    const segs = platformSegments(name);
    for (let i = 0; i < segs.length; i++) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return { exact: false };
      }
      if (entries.includes(segs[i])) {
        dir = join(dir, segs[i]);
        continue;
      }
      // Not spelled the way it was asked for. Name the entry it would have been, so
      // the caller can retype it — reported only, never loaded.
      const near = entries.find((e) => looseName(e) === looseName(segs[i]));
      return { exact: false, onDisk: near ? join(dir, near, ...segs.slice(i + 1)) : undefined };
    }
    return { exact: true };
  };
  // Spellings that exist on disk but are NOT what was asked for — reported so the
  // refusal is actionable, never loaded.
  const misspelled: string[] = [];
  const hits = comfyWorkflowsDirs()
    .map((dir) => ({ dir, path: resolve(dir, rel) }))
    .filter(({ path }) => existsSync(path) && statSync(path).isFile())
    .filter(({ dir, path }) => realBaseUnder(dir, path))
    .filter(({ dir }) => {
      const spelling = localSpelling(dir, rel);
      if (spelling.exact) return true;
      if (spelling.onDisk) misspelled.push(spelling.onDisk);
      return false;
    })
    .map(({ path }) => path);
  // De-duplicate by REAL path: the two guessed layouts can be the same directory
  // (a symlink/junction), which is one candidate, not an ambiguity.
  const distinct = [...new Set(hits.map((h) => { try { return realpathSync(h); } catch { return h; } }))];
  if (distinct.length > 1) {
    throw new Error(
      `"${p}" is ambiguous: the connected ComfyUI could not be reached, and the name matches ` +
        `${distinct.length} different local files (${distinct.map((f) => `"${f}"`).join(", ")}). ` +
        `Refusing to guess which one you meant — pass an absolute path.`,
    );
  }
  if (distinct.length === 1) return readLocal(distinct[0]);

  throw new Error(
    `No workflow file at "${p}". It ${outcome.detail}, and it is not under the orchestrator's ` +
      `reconstructed workflows dir (${comfyWorkflowsDirs().join(" or ") || "COMFYUI_PATH not set"}).` +
      (misspelled.length
        ? ` A file exists on disk as ${misspelled.map((f) => `"${f}"`).join(", ")}, which is` +
          ` not how you spelled it (letter case, repeated separator, or Unicode` +
          ` normalization), and with ComfyUI unreachable there is no authority to confirm they are` +
          ` the same file — so it was NOT loaded. Retype the name exactly, or pass an absolute path.`
        : "") +
      ` Pass an absolute path, or a name shown by get_workflow (action:"list").`,
  );
}

// IMPORTANT (Codex parity): use `z.array(z.number())` — NOT `z.tuple([...])` — for
// fixed-length coordinate vectors. zod's `.tuple()` emits JSON-Schema draft-04
// "tuple validation" (`items` as an ARRAY of schemas), which Codex's strict
// function-schema validator REJECTS — it silently DROPS any MCP tool whose schema
// uses array-form `items` (so panel_add_node etc. vanished from Codex's tool
// list). A plain number array (single-object `items` + minItems/maxItems) is
// accepted by both Codex and the Claude SDK, and is behaviorally identical
// (the panel executors already read pos/bounds as [x, y] / [x, y, w, h] arrays).
const xy = () =>
  z.array(z.number()).min(2).max(2).describe("[x, y] (two numbers).");
const rect = () =>
  z.array(z.number()).min(4).max(4).describe("[x, y, width, height] (four numbers).");
const nodeSize = () =>
  z.array(z.number().positive()).min(2).max(2).describe("[width, height] (two positive numbers).");

/**
 * Outcome of a human-in-the-loop confirm card (#360). A tri-state so callers can
 * tell a deliberate DECLINE ("no") apart from the user simply not answering in
 * time ("timeout") — the latter must be reported honestly ("timed out waiting for
 * confirmation"), never silently treated as a decline. Any non-timeout failure
 * (no panel, transport error) maps to "no" so the destructive op is SKIPPED.
 */
/**
 * #1332 — FOUR outcomes, because there are four facts.
 *
 * `no` used to carry two of them: the user said no, AND the question could not be put
 * to them at all (no panel, dropped transport). Skipping the destructive operation is
 * correct for both — that part does not change — but the SENTENCE built on it is not:
 * `panel_restart_comfyui` answered "Cancelled — ComfyUI was not restarted" to a
 * reporter whose ComfyUI had demonstrably restarted, because the restart itself dropped
 * the socket the answer had to come back on.
 *
 * `unreachable` is that second fact, separated. It is deliberately NOT a failure state:
 * every caller already branches `!== "yes"`, so the safe path is preserved by
 * construction, and only what we CLAIM about it changes (#796's defect class — "could
 * not determine X" reported as "determined X is not the case").
 */
export type ConfirmOutcome = "yes" | "no" | "timeout" | "unreachable";

/**
 * The execution context every tool handler receives. Both transports (Anthropic
 * SDK in-process, MCP-SDK over HTTP) build the SAME context bound to a tab, so a
 * handler is transport-agnostic — it only ever talks to the bridge via `call` /
 * `confirm` / `bridge` and never knows which server invoked it.
 */
export interface PanelToolCtx {
  /** Forward a command to the panel and wrap the reply as a tool result. An
   *  optional observer receives the bridge request id after the frame is written,
   *  for commands that can later be proven only by a panel-side receipt. */
  call: (
    cmd: Record<string, unknown>,
    timeoutMs?: number,
    onDispatchedRid?: (rid: string) => void,
  ) => Promise<ToolResult>;
  /** Human-in-the-loop yes/no confirm card. Tri-state (#360): "yes" on an explicit
   *  affirmative, "no" on a decline / no-panel / transport error, "timeout" when the
   *  user never answered in time. `timeoutMs` (optional, #536) caps the WHOLE confirm
   *  wait (card deadline + late-answer grace) for a caller with a tighter
   *  whole-handler budget (e.g. panel_restart) — always clamped under the ask ceiling. */
  confirm: (question: string, header: string, timeoutMs?: number) => Promise<ConfirmOutcome>;
  /** The raw bridge + tab id, for the handful of tools that need bespoke wiring
   *  (image screenshots, secret collection). */
  bridge: UiBridge;
  tabId: string;
  /** Per-tab workflow pin store (optional for tests). */
  workflowTarget?: WorkflowTargetStore;
  /**
   * EXPLICIT self-heal: re-point THIS session at the currently active/sole
   * connected tab. The tabId captured at session creation is frozen; a full
   * ComfyUI reconnect (#332), a frontend reload (#322), or switching to a
   * different workflow FILE (#331) can surface a brand-NEW browser socket under
   * a NEW tab id with no migration alias, orphaning the session so every
   * panel_* call throws `no connected tab`. This rebinds `ctx.tabId` (which
   * `call`/`confirm` read LIVE) to the active tab — but ONLY when the current
   * tabId no longer reaches a live tab, so a healthy (possibly multi-tab)
   * session is never disturbed. It is the deliberate consent signal wired into
   * panel_set_workflow_target({mode:"current"}) and panel_reload — NOT baked
   * into resolveTarget. Throws (clear message) when a single active tab can't be
   * determined. Optional so lightweight test contexts can omit it.
   */
  rebindToActiveTab?: (opts?: {
    /** EXPLICIT scope-recovery consent — passed ONLY by
     *  panel_set_workflow_target({mode:"current"}), the documented recovery
     *  signal. Without it a SCOPE-bound ctx is never repinned at all, and even
     *  with it the repin fires only when the current pin does NOT reach a live
     *  tab (a healthy shared turn is never displaced — confirming gate 3, P0:
     *  panel_reload's unconditional call was silently repinning healthy turns
     *  onto whichever tab was last active). Real-tab ctxs ignore this flag. */
    scopeRecoveryConsent?: boolean;
  }) => { previous: string; current: string; rebound: boolean; repinRefusal?: string };
  /**
   * Best-effort in-place self-heal for the handful of tools that call the bridge
   * DIRECTLY (not via `ctx.call`) — e.g. panel_request_adult_consent's ask_user
   * (#372) and the live-canvas graph_serialize. Silently rebinds an orphaned,
   * current-mode session onto the sole active tab (identical conservative guard
   * to rebindToActiveTab: only when the current tab is unreachable AND a single
   * active tab is unambiguous; pinned sessions untouched). Never throws. `call`
   * and `confirm` already invoke it internally, so most handlers need not. Optional
   * so lightweight test contexts can omit it.
   */
  ensureReachable?: () => void;
  /**
   * Bounded pre-send wait for a browser tab to (re)connect after a full ComfyUI
   * restart or soft-reload, then rebind a current-mode session onto it. Resolves
   * true once the session's tab is reachable (already, or after a tab reconnected
   * and ensureReachable rebound onto it), false if the budget elapses with nothing
   * connected. Returns immediately when the tab is already reachable (healthy
   * session → zero overhead). Waits ONLY in the "Connected: none" window (zero live
   * tabs): a multi-tab / strict-single situation is left to the existing synchronous
   * ensureReachable so this never changes healthy multi-tab routing. Safe to await
   * BEFORE a mutating command (nothing is dispatched), which is why it fixes
   * open/save firing into a dead binding (#402) without any double-apply risk.
   * Optional so lightweight test contexts can omit it.
   */
  awaitReachable?: (budgetMs?: number) => Promise<boolean>;
  /** Snapshot of the current panel registration. The browser-tab session id is
   * separate from the workflow-derived routing tab id, which another browser
   * tab may reuse for the same saved workflow. */
  panelConnectionIdentity?: () => { generation: number; tabSessionId: string } | undefined;
  /**
   * Wait for a panel hello that is strictly newer than `before`, from the SAME
   * browser-tab session that received the restart dispatch. This is distinct
   * from awaitReachable: an old tab can still be reachable while ComfyUI is
   * rebooting, and a different browser tab can reuse the same saved-workflow id.
   */
  awaitPostRestartReachable?: (
    before: { generation: number; tabSessionId: string } | undefined,
    budgetMs?: number,
  ) => Promise<boolean>;
  /**
   * Whether the currently bound, live panel tab can safely perform active
   * workflow graph mutations. A reconnect proves only transport reachability:
   * the browser may still be serving a cached pre-workflow-stamp panel bundle.
   * Optional only for lightweight legacy test contexts.
   */
  tabCanMutateGraph?: () => boolean;
  /**
   * The same question TRI-STATE, for code that must REPORT the answer rather than
   * gate on it. `tabCanMutateGraph` fails closed (an unreadable probe becomes
   * `false`), which is right for gating and wrong for prose: it made the recovery
   * tell users their panel lacked a capability when we had merely failed to look.
   * Optional so lightweight test contexts can omit it.
   */
  tabGraphMutationCapability?: () =>
    | { known: true; canMutate: true }
    | {
        known: true;
        canMutate: false;
        because: "unroutable" | "disconnected" | "no_identity" | "capability";
      }
    | { known: false; reason: string };
}

/** Build a tab-bound execution context shared by both transports. */
export function makePanelToolCtx(
  bridge: UiBridge,
  tabId: string,
  workflowTargets?: WorkflowTargetStore,
): PanelToolCtx {
  // The routing tab id is held on the returned ctx object (NOT captured by
  // value) so an explicit rebind can re-point this session in place: call/
  // confirm and every handler read `ctx.tabId` LIVE. See rebindToActiveTab.
  const ctx = {
    bridge,
    tabId,
    workflowTarget: workflowTargets,
  } as PanelToolCtx;

  // AUTO-HEAL an orphaned session in place. When THIS session's captured tabId no
  // longer reaches a live tab (a full ComfyUI restart/reconnect #178/#170, a
  // frontend reload #322, or a switch to a different workflow FILE #331/#372
  // surfaces a NEW socket under a NEW tab id with no migration alias), silently
  // rebind onto the sole active tab BEFORE the command is sent — so a session that
  // was merely orphaned by a reconnect recovers on its own instead of throwing
  // `no connected tab` on every call and forcing the agent to hand-call
  // panel_set_workflow_target({mode:"current"}).
  //
  // CONSERVATIVE by construction (must not weaken multi-tab routing):
  //  - fires ONLY when the current tab is genuinely unreachable (canReach false);
  //    a healthy session — including a healthy MULTI-tab one — is never touched;
  //  - STRICT-SINGLE: only silently rebinds when there is EXACTLY ONE connected
  //    tab. With 2+ live tabs the bridge's no-tabId resolution would fall back to
  //    `lastActiveTabId` — which can be an UNRELATED workflow (codex) — so the
  //    silent path refuses to guess and instead lets the command surface the
  //    bridge's clear `no connected tab` error. The user then re-binds with the
  //    EXPLICIT panel_set_workflow_target({mode:"current"}) signal, which DOES
  //    accept the last-active tab because it is a deliberate "use what's live now"
  //    consent — silent auto-heal must be stricter than an explicit rebind;
  //  - PINNED sessions are left strict: a session pinned to a specific workflow
  //    keeps requiring the explicit rebind consent signal. Only "current"-mode
  //    (follow-the-active-tab) sessions self-heal, which is faithful to what that
  //    mode already means.
  // It routes through makePanelToolCtx only — bridge.resolveTarget itself is
  // untouched, so the dead-alias security invariant (ui-bridge.test.ts:459) holds.
  // The tab ids ELIGIBLE to host a graph/workflow session: connected AND canvas-owning.
  // A headless client (mobile mirror / remote / exec viewer — ui-bridge Conn.headless)
  // is canvas-less and can never run graph tools, so it must never be a rebind target
  // (codex). Returns null when the bridge can't enumerate tabs/headlessness (older or
  // lightweight ctx) — callers then fall back to bridge.resolveActiveTabId (legacy).
  const isHeadlessTab = (id: string): boolean =>
    typeof bridge.isHeadless === "function" && bridge.isHeadless(id);
  const interactiveTabIds = (): string[] | null => {
    if (typeof bridge.tabs !== "function") return null;
    const live = bridge.tabs();
    if (!Array.isArray(live)) return null;
    return live.filter((t) => !isHeadlessTab(t.tab_id)).map((t) => t.tab_id);
  };

  const ensureReachable = (): void => {
    // #884 P0 — a SCOPE-bound ctx is never rebound onto a real tab id: its
    // routing is the turn-target pin (or active-tab fallback), and when the
    // pinned tab is gone the resolution THROWS loudly by design. Silently
    // picking another tab here would be exactly the mid-turn re-target the pin
    // forbids — and it would PERMANENTLY unbind this shared ctx.
    if (isScopeAddress(ctx.tabId)) return;
    if (typeof bridge.canReach !== "function") return; // lightweight test ctx
    if (bridge.canReach(ctx.tabId)) return; // healthy binding — leave untouched
    if (workflowTargets?.get(ctx.tabId)?.mode === "pinned") return; // stay strict
    // Strict-single: never silently pick among multiple live tabs (would risk the
    // real bridge's last-active fallback routing to an unrelated workflow). Count only
    // INTERACTIVE tabs — a lone canvas tab alongside headless viewers still binds, and
    // a headless-only state is treated as "nothing bindable" (rebindToActiveTab throws).
    const eligible = interactiveTabIds();
    if (eligible) {
      if (eligible.length > 1) return; // 2+ INTERACTIVE tabs → strict, don't guess
    } else if (typeof bridge.tabs === "function") {
      const live = bridge.tabs(); // legacy path (no headless info)
      if (Array.isArray(live) && live.length > 1) return;
    }
    try {
      rebindToActiveTab();
    } catch {
      // Ambiguous (2+ tabs) or nothing bindable — leave tabId as-is and let the
      // command surface the bridge's own clear, tab-listing error.
    }
  };

  // Bounded pre-send wait for a tab to (re)connect after a restart/reload — see
  // PanelToolCtx.awaitReachable. Complements ensureReachable (which acts INSTANTLY
  // on an already-present sole tab): this waits out the "Connected: none" window a
  // fresh ComfyUI restart opens, in which the browser's own socket hasn't re-hello'd
  // yet. Conservative by construction: returns at once for a healthy session, and
  // only waits while ZERO tabs are connected (a 1+/multi-tab case is left untouched
  // for the existing strict-single ensureReachable to resolve or refuse).
  const awaitReachable = async (budgetMs?: number): Promise<boolean> => {
    if (typeof bridge.canReach !== "function") return true; // lightweight test ctx
    if (bridge.canReach(ctx.tabId)) return true; // healthy binding
    // We can only meaningfully WAIT for a reconnect when the bridge can enumerate its
    // live tabs. Without that (older/lightweight bridge), never loop — do a single
    // synchronous heal and report reachability, exactly as before this primitive.
    if (typeof bridge.tabs !== "function") {
      ensureReachable();
      return bridge.canReach(ctx.tabId);
    }
    const timing = reconnectWaitTiming();
    // The configured reconnect budget is the intended MAX; an explicit budgetMs (e.g.
    // a caller's remaining deadline) only ever TIGHTENS it — never extends the wait.
    const budget = Math.max(0, budgetMs != null ? Math.min(budgetMs, timing.budgetMs) : timing.budgetMs);
    const intervalMs = Math.max(1, timing.intervalMs);
    const deadline = Date.now() + budget;
    for (;;) {
      // Only an INTERACTIVE (canvas-owning) tab is a valid graph/workflow binding — a
      // headless viewer is canvas-less, so awaiting/rebinding onto one and reporting
      // "ready" would route open/save at a client with no canvas (codex).
      const interactive = interactiveTabIds() ?? [];
      if (interactive.length > 0) {
        // A canvas tab is present → the reconnect window is OVER. Try the strict-single
        // synchronous heal (binds a sole reconnected tab). Then return IMMEDIATELY,
        // bound or not: if we still can't reach ctx.tabId (2+ interactive tabs, or a
        // pinned stale target ensureReachable leaves strict), waiting longer can't help —
        // report now so open/save refuse promptly and panel_set_workflow_target proceeds
        // to its explicit last-active rebind instead of stalling the whole budget (codex).
        ensureReachable();
        return bridge.canReach(ctx.tabId);
      }
      // ZERO interactive tabs — the genuine "Connected: none" post-restart window (a lone
      // headless viewer counts as none). Keep waiting for a canvas tab to re-register.
      const left = deadline - Date.now();
      if (left <= 0) return bridge.canReach(ctx.tabId);
      await sleep(Math.min(intervalMs, left));
    }
  };

  const panelConnectionIdentity = (): { generation: number; tabSessionId: string } | undefined =>
    typeof bridge.tabConnectionIdentity === "function"
      ? bridge.tabConnectionIdentity(ctx.tabId)
      : undefined;

  // A restart report must NEVER count the panel socket that existed before the
  // reboot command. Unlike awaitReachable(), which intentionally returns at once
  // for a healthy binding, this waits for a strictly newer hello generation. The
  // fresh hello can keep the same tab/socket id or arrive under a new one; in the
  // latter case only rebind after the old target is gone, preserving strict
  // multi-tab routing and never guessing away from a still-live pre-restart tab.
  const awaitPostRestartReachable = async (
    before: { generation: number; tabSessionId: string } | undefined,
    budgetMs?: number,
  ): Promise<boolean> => {
    // The actual UiBridge exposes a tab-session binding. Preserve historical
    // lightweight/mock-context behavior only when that capability does not exist
    // at all; a real bridge missing the pre-dispatch identity fails closed.
    if (typeof bridge.tabConnectionIdentity !== "function") return awaitReachable(budgetMs);
    if (before == null) return false;
    const timing = reconnectWaitTiming();
    const budget = Math.max(0, budgetMs != null ? Math.min(budgetMs, timing.budgetMs) : timing.budgetMs);
    const deadline = Date.now() + budget;
    const isOriginalTabReconnected = (): boolean => {
      const current = panelConnectionIdentity();
      return (
        current != null &&
        current.generation > before.generation &&
        current.tabSessionId === before.tabSessionId
      );
    };
    for (;;) {
      if (isOriginalTabReconnected()) return true;
      // A new tab id cannot resolve through the retired binding. Once that binding is
      // actually gone, the existing conservative rebind can follow the sole new tab.
      if (!bridge.canReach(ctx.tabId)) {
        const interactive = interactiveTabIds() ?? [];
        if (interactive.length > 0) ensureReachable();
        if (isOriginalTabReconnected()) return true;
      }
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(Math.max(1, timing.intervalMs), left));
    }
  };

  const sendRouted = async (
    cmd: Record<string, unknown>,
    timeoutMs?: number,
    onDispatchedRid?: (rid: string) => void,
  ): Promise<unknown> => {
    const target = workflowTargets?.get(ctx.tabId);
    const routed = target ? withWorkflowTarget(cmd, target) : cmd;
    return bridge.send(routed as { cmd: string }, { tabId: ctx.tabId, timeoutMs, onDispatchedRid });
  };

  const callOnce = async (
    cmd: Record<string, unknown>,
    timeoutMs?: number,
    onDispatchedRid?: (rid: string) => void,
    // #1560 — reports the error each attempt failed on, so the wrapper below can
    // stamp the bridge's structural marks onto the ToolResult from ONE place. The
    // catch has more than a dozen `fail(...)` exits, each shaping its own message;
    // decorating them individually is the shape that goes stale the moment a
    // fourteenth is added, and the fact being carried belongs to the ERROR rather
    // than to any one of those wordings.
    onFailure?: (err: unknown) => void,
  ): Promise<ToolResult> => {
    // #694: capture the rid of THIS call's dispatched attempt so an OUTCOME-UNKNOWN
    // mutating failure can name it as the caller's explicit retry token (see the
    // catch below). The bridge fires the observer post-write (per attempt); chain
    // to any caller-supplied observer (workflow_open's receipt correlation).
    let dispatchedRid: string | undefined;
    const observeRid = (rid: string): void => {
      dispatchedRid = rid;
      onDispatchedRid?.(rid);
    };
    try {
      // #436: a MUTATING graph edit must not fire into the "Connected: none"
      // window a ComfyUI restart/reload opens. A read survives that window (it is
      // parked mid-command and is retry-safe), but a mutating edit is NEITHER — so
      // panel_graph_outline succeeds while the very next panel_add_node hits
      // resolveTarget's momentarily-empty registry and fails with
      // "no connected tab … Connected: none" (the flap). Await a stable binding
      // BEFORE dispatch — nothing is sent during the wait, so there is no
      // double-apply risk — exactly as workflow_open/save already do. This returns
      // INSTANTLY for a healthy session and only waits in the zero-tab window; the
      // read path (parking + retry-once below) is left exactly as-is. A wait that
      // times out unreached still falls through to sendRouted, whose authoritative
      // dispatched:false surfaces the actionable "nothing applied — rebind" message.
      if (isMutatingGraphCmd(cmd)) {
        await awaitReachable();
      }
      ensureReachable();
      // #1639 — a running prompt freezes the tab's graph_* channel. Refuse
      // BEFORE dispatch so a mutation is known-not-applied rather than
      // delivered-into-a-frozen-tab with a 20/30s unknown-outcome timeout.
      const blocked = graphCmdBlockedByRunningPrompt(cmd);
      if (blocked) return fail(blocked);
      const firstTry = ok(await sendRouted(cmd, timeoutMs, observeRid));
      // panel#1097 — a guard-domain command that SUCCEEDS is the evidence that the
      // switch is over, whichever attempt lands it. Without this an ordinary
      // first-attempt success left the old run in place, and a later unrelated
      // switch inherited its age and was announced as stuck at once (codex r4).
      if (successProvesSwitchCleared(cmd.cmd)) clearSwitchHold(ctx.tabId);
      return firstTry;
    } catch (err) {
      onFailure?.(err); // #1560 — the error this attempt failed on (see the wrapper).
      // Post-reconnect retry-once: a reboot/free_vram/reconnect can drop the tab's
      // transport (or replace it under a new tab id) the instant after we dispatch.
      // For idempotent commands, settle briefly, rebind onto the now-live tab, and
      // retry ONE time before surfacing an error (#278/#310/#332/#481). Mutating
      // edits are excluded from RETRY_SAFE_CMDS, so they never double-apply.
      // #1027 — the workflow-switch critical section is retried on the same path.
      // The panel refuses during it, states that nothing was applied, and asks
      // for a retry in a moment; the section lasts a fraction of a second, which
      // is what retrySettleMs already waits. Still gated on RETRY-SAFE commands,
      // so a mutation is never re-issued on our own initiative.
      // #1529 — a PRE-EXECUTOR refusal is retryable even for a MUTATION.
      //
      // Every other branch here is gated on RETRY_SAFE_CMDS precisely because a
      // mutation might have landed before the failure, and re-issuing it would
      // double-apply. That reasoning does not hold for this one: the panel's
      // reconnect gate runs BEFORE its executor, and says so in a structured field
      // (`applied:false, stage:"pre-executor"`) rather than in prose. Nothing ran,
      // so there is nothing to double-apply — which is the entire point of the
      // channel, and why it is keyed on the FIELD and never on the message text.
      //
      // The refusal is the panel's own claim about its own execution, validated on
      // arrival; an older panel sends no field, `preExecutorRefusal` is null, and
      // this branch simply never fires.
      const preExecutorRefusal = isPreExecutorRefusal(err);
      if (
        preExecutorRefusal ||
        (isRetrySafeCmd(cmd) && (isTransientReconnectError(err) || isWorkflowSwitchGuardRefusal(err)))
      ) {
        // panel#1097 — declared out here so the refusal branch below can see it,
        // and REASSIGNED after ensureReachable so it names the tab the command is
        // actually dispatched on. Reading it before the rebind attributed a refusal
        // from B to A; reading it after the await let a later rebind move it again
        // (codex rounds 1 and 2).
        let holdTab = ctx.tabId;
        try {
          await sleep(retrySettleMs());
          ensureReachable(); // rebinds a current-mode session onto the reconnected tab
          holdTab = ctx.tabId;
          const retried = ok(await sendRouted(cmd, timeoutMs, observeRid));
          // Cleared HERE and nowhere else, and only when the failure this retried
          // was a SWITCH refusal. Clearing on every routed success let an unguarded
          // status read wipe the evidence while graph commands stayed refused
          // (codex round 2); clearing after a transient-reconnect retry does the
          // same thing one step removed, because reconnecting proves nothing about
          // whether the switch cleared (codex round 3).
          // Same rule on the retry path. A transient-RECONNECT retry that succeeds
          // proves nothing about the switch (codex r3), so the command still has to
          // be one the guard would have refused.
          if (isWorkflowSwitchGuardRefusal(err) && successProvesSwitchCleared(cmd.cmd)) {
            clearSwitchHold(holdTab);
          }
          return retried;
        } catch (err2) {
          // #1560 — the RETRY's failure is the one every exit below describes, so it
          // supersedes the first. A retried read that comes back refused is a panel
          // that answered, whatever the flap that provoked the retry looked like.
          onFailure?.(err2);
          // #1027 — a switch STILL in progress is not a reconnect, and saying so
          // would be the #1001 mistake again: the tab is connected and healthy,
          // it is simply mid-switch. Name the actual state and the actual wait.
          if (isWorkflowSwitchGuardRefusal(err2)) {
            const name = typeof cmd.cmd === "string" ? cmd.cmd : "panel command";
            // panel#1097 — time the RUN of these refusals. "Simply retry" is right
            // for the fraction of a second this normally lasts and wrong for a
            // switch held open by a dialog, and the two were indistinguishable.
            const held = describeSwitchHold(recordSwitchHold(holdTab));
            return fail(
              `${name} was NOT applied — nothing changed. The panel is still switching or ` +
                `reloading the workflow on the canvas, which it refuses commands during so a ` +
                `command cannot land on the wrong graph. The tab is connected and this is not a ` +
                `reconnect: it normally clears in well under a second, so simply retry. If a ` +
                `switch appears stuck, check the canvas — a load dialog or an unsaved-changes ` +
                `prompt can hold it open awaiting the user. ` +
                `(${err2 instanceof Error ? err2.message : String(err2)})` +
                held,
            );
          }
          // The retry also failed — surface an actionable reconnecting status rather
          // than a bare transport error (#332), while still failing honestly.
          if (isTransientReconnectError(err2)) {
            const name = typeof cmd.cmd === "string" ? cmd.cmd : "panel command";
            return fail(
              `${name} could not reach the ComfyUI panel — it is still reconnecting after a ` +
                `restart/reload. Wait a moment and retry; if it persists, rebind with ` +
                `panel_set_workflow_target({mode:"current"}). (${err2 instanceof Error ? err2.message : String(err2)})`,
            );
          }
          // #1468 — the RETRY's own failure can be a reply timeout too: this branch
          // is only entered when the FIRST error was a reconnect flap or a switch
          // refusal, so a tagged no-reply lands here rather than on the outer path.
          // Leaving it unmarked fails closed (nothing is settled, no false success)
          // but silently switches the settle off for a real sequence, which is the
          // kind of gap that reads as "the fix does not work" much later.
          return carryReplyTimeoutMark(err2, fail(`${err2 instanceof Error ? err2.message : String(err2)}${queueBusyTimeoutNote()}`));
        }
      }
      // #442 defect 4: a MUTATING command (deliberately excluded from RETRY_SAFE_CMDS)
      // that the bridge refused BEFORE any socket write surfaced the bare routing error
      // ("no connected tab … Connected: none") with no recovery path — whereas a
      // retry-safe read like graph_get_errors, via the branch above, names the rebind.
      // That asymmetry made a brief post-reconnect read/edit-channel disagreement look
      // like a dead agent (panel_list_workflows kept answering while panel_set_widget
      // failed, in a multi-tab session the strict-single silent auto-heal won't touch).
      // We must NOT retry the mutating command (double-apply risk), but the bridge's
      // AUTHORITATIVE typed flag proves nothing was dispatched (dispatchOutcomeOf ===
      // false) — so it is safe to state nothing was applied and name the rebind recovery,
      // preserving the raw cause. Keying on the TYPED flag (not error text) means a
      // POST-dispatch executor ok:false reply that merely quotes "no connected tab" is
      // never mis-wrapped as "nothing applied".
      // #709: a CAPABILITY refusal (the tab's panel does not enforce the workflow-stamp
      // contract) shares the dispatched:false flag with transient routing failures, but
      // the generic recovery below — "retry in a moment / rebind with
      // panel_set_workflow_target({mode:"current"})" — can NEVER clear it (the refusal's
      // own text says so: rebinding cannot add the missing capability). Appending it
      // sent agents into a futile retry/rebind loop that contradicted the embedded
      // guidance. Key on the TYPED marker and surface the cause verbatim instead; it
      // already names the real recovery (update + restart + browser hard-refresh).
      // #1331 — DECIDE WHICH "no trusted identity" THIS IS, instead of asserting one.
      //
      // The reporter was told to "retry in a moment, or rebind with
      // panel_set_workflow_target({mode:"current"})", followed it, and it did not work:
      // recovery took panel_open_workflow on the workflow that was ALREADY active —
      // four calls to reach a state the panel already believed it was in.
      //
      // But that advice is NOT always wrong, and my first attempt at this deleted it
      // outright — which #709's test caught. Two different states produce the identical
      // bridge message, and they need opposite remedies:
      //
      //   session bound to a STALE tab, live canvas HAS an identity
      //        → rebinding genuinely re-resolves it (#709). The advice is correct.
      //   the LIVE canvas itself has no identity
      //        → the rebind READS an identity to adopt and finds none, so it reports
      //          success while every mutation keeps failing (#1331).
      //
      // The bridge cannot tell them apart — from its side both are "no identity". The
      // orchestrator can, with the same read-only re-derivation the documented recovery
      // performs. So it is measured, once, and the answer names the remedy that fits.
      // panel#1339 — `refreshed` AND `already_current` ARE NOT THE SAME ANSWER.
      //
      // The branch below used to return ONE sentence for both: "the live canvas DOES
      // carry an identity (<uuid>) and this session's fence has been re-derived onto
      // it. RETRY THIS EXACT CALL ONCE". The reporter read that as a contradiction —
      // told the identity had *already* been re-derived, yet refused anyway — and the
      // two states it covers want opposite next moves:
      //
      //   refreshed        the tab had NO fence and THIS CALL installed one, derived
      //                    from the live canvas. The refusal you are holding is the
      //                    repair. A bare retry is the right move and works because
      //                    of it — which is why it looked "transient": the first call
      //                    did the work and reported failure.
      //   already_current  the fence read back as ALREADY PRESENT AND EQUAL. It cannot
      //                    have been that at dispatch — the refusal is proof the stamp
      //                    was empty, and currentWorkflowFence reads the same resolver
      //                    the bridge consulted — so a fence appeared between the two
      //                    reads, and NOT because of this call: `already_current`
      //                    returns BEFORE any adoption. Two things produce it and this
      //                    code cannot tell them apart, which is why it asserts
      //                    neither: the session was moved onto a DIFFERENT tab while
      //                    the check ran (rebindWorkflowFence's workflow_list round
      //                    trip is retry-safe, its retry runs ensureReachable, and
      //                    `before` is then re-read for the new tab), or a fence for
      //                    THIS tab was installed in that window by something else (a
      //                    concurrent rebind, or the panel's own mismatch re-hello,
      //                    #1043/#932). Either way NOTHING WAS REPAIRED for the caller
      //                    and the uuid quoted may not be the one they were refused
      //                    against — so the remedy is to confirm the target, not to
      //                    name a mechanism nobody measured.
      //
      // Splitting the sentence is half the fix. The other half is that the answer must
      // be readable WITHOUT parsing the sentence: an agent deciding to re-run a
      // mutation off matched error prose is how a write gets double-applied. See
      // FenceRepairDiagnosis — the verdict, and the bridge-owned dispatch flag the
      // "nothing was applied" claim rests on, ride in structuredContent.
      //
      // What does NOT change: every branch still REFUSES. The call really did not
      // perform the widget write — it performed the repair — and a refusal that
      // repairs and REPORTS is a different risk from one that repairs and PROCEEDS
      // (#1646 removed exactly that from the neighbouring branch). Nothing here
      // auto-continues the mutation.
      if (isNoTrustedIdentityRefusal(err) && isMutatingGraphCmd(cmd)) {
        const raw = err instanceof Error ? err.message : String(err);
        // The TYPED flag, not the text predicate above: `isNoTrustedIdentityRefusal`
        // is a phrase match and would fire on anything that merely quotes the phrase.
        // Only the bridge can say whether the frame reached the socket.
        const dispatchFlag = dispatchOutcomeOf(err);
        const dispatched: FenceRepairDiagnosis["dispatched"] =
          dispatchFlag === false ? "no" : dispatchFlag === true ? "yes" : "unknown";
        const retrySafe: FenceRepairDiagnosis["retry_safe"] =
          dispatched === "no" ? "yes" : dispatched === "yes" ? "no" : "unknown";
        // THREE-WAY, because the flag is three-way. A two-way ternary here printed
        // "this refusal carries no dispatch flag" for a refusal whose flag was
        // present and said `true` — the same collapse this whole branch exists to
        // remove, reintroduced one level up (review of this PR). Each arm states the
        // observation it actually has.
        const nothingApplied =
          dispatched === "no"
            ? ` Nothing was applied (the bridge reports this frame was never written to the ` +
              `socket), so re-issuing cannot double-apply.`
            : dispatched === "yes"
              ? ` CAUTION — the bridge reports this frame WAS written to the socket, so the ` +
                `mutation may ALREADY have been applied. Do not re-issue it blindly; establish ` +
                `what landed first (read the node back with panel_query_graph).`
              : ` Whether anything was applied is NOT established here — this refusal carries no ` +
                `dispatch flag — so do not re-issue on the strength of this message alone.`;
        // A retry may only be ORDERED when the bridge proved nothing was written.
        // Otherwise the instruction contradicts `retry_safe`, which is exactly what a
        // caller keys on: "RETRY THIS EXACT CALL ONCE" beside `retry_safe:"no"` is a
        // self-contradictory verdict, and the prose is the half an agent obeys.
        const mayOrderRetry = dispatched === "no";
        const retryOrder = mayOrderRetry
          ? `RETRY THIS EXACT CALL ONCE.`
          : `The fence is repaired, so the same call should now pass it — but re-issue only ` +
            `after settling the question below.`;
        // …and the machine-readable step follows the same rule.
        const retryAction = (fallback: FenceRepairDiagnosis["next_action"]) =>
          mayOrderRetry ? fallback : ("verify_applied_then_decide" as const);
        const tabBefore = ctx.tabId;
        try {
          const rebind = await rebindWorkflowFence(ctx);
          // WHAT WAS THERE BEFORE, reported as the tri-state it is rather than folded
          // into an absence. `refreshed` is returned for every `before` that is not a
          // known-equal fence, which is THREE different priors: definitively none, a
          // read that FAILED, and a fence naming a DIFFERENT workflow that was then
          // replaced. FenceRead's own contract forbids collapsing the second into the
          // first ("an absence nobody observed"), and a first draft of this message did
          // exactly that by saying "this session had NO fence for it" on all three.
          const priorFence: FenceRepairDiagnosis["prior_fence"] = !rebind.before.known
            ? "unreadable"
            : rebind.before.uuid
              ? "present"
              : "absent";
          const base = {
            dispatched,
            retry_safe: retrySafe,
            rebind_status: rebind.status,
            prior_fence: priorFence,
            ...(rebind.before.known && rebind.before.uuid
              ? { prior_fence_uuid: rebind.before.uuid }
              : {}),
            tab_before: tabBefore,
            tab_after: ctx.tabId,
          } as const;
          if (rebind.status === "no_identity") {
            return failWithFenceDiagnosis(
              `${raw}\n\nCHECKED, so this is not a guess: the live canvas was re-read and it ` +
                `carries no workflow identity either (${rebind.why}). ` +
                `panel_set_workflow_target({mode:"current"}) will NOT clear this — it chooses ` +
                `WHICH workflow to fence against and cannot mint an identity for one that has ` +
                `none, so it reports success while every mutation keeps failing. RECOVERY: ` +
                `panel_open_workflow(<path>) on this same workflow; re-opening it is what gives ` +
                `it an identity. If it has never been saved there is no path to re-open — save ` +
                `it first with panel_save_workflow, which also gives it a stable identity.`,
              {
                ...base,
                fence_repaired_by_this_call: "no",
                retry_clears_refusal: "no",
                next_action: "open_or_save_workflow",
              },
            );
          }
          if (rebind.status === "refreshed") {
            // Only what was OBSERVED about the prior fence. Each arm is a different
            // fact with a different implication, and "no fence" is true for exactly
            // one of them.
            const wasBefore =
              priorFence === "absent"
                ? `this session had NO fence for it`
                : priorFence === "present"
                  ? `this session's fence named a DIFFERENT workflow (${
                      rebind.before.known ? rebind.before.uuid : ""
                    }), which has been REPLACED`
                  : `this session's prior fence could not be read, so whether there was one is ` +
                    `not claimed here`;
            return failWithFenceDiagnosis(
              `${raw}\n\nCHECKED: the live canvas DOES carry an identity (${rebind.uuid}), ` +
                `${wasBefore}, and THIS CALL installed one derived from that canvas — the ` +
                `refusal you are reading is what repaired it, which is why the same call ` +
                `refused now and passes the fence next. ${retryOrder}${nothingApplied}`,
              {
                ...base,
                workflow_uuid: rebind.uuid,
                fence_repaired_by_this_call: "yes",
                retry_clears_refusal: "yes",
                next_action: retryAction("retry_same_call"),
              },
            );
          }
          if (rebind.status === "already_current") {
            return failWithFenceDiagnosis(
              `${raw}\n\nCHECKED, and THIS CALL REPAIRED NOTHING: the re-read found a fence that ` +
                `was ALREADY present and already named the live canvas (${rebind.uuid}). That ` +
                `cannot be the fence your command was refused against — the refusal is proof ` +
                `that one was missing — so a fence appeared between the two reads, and not ` +
                `through this call. It is EITHER a fence for a different tab this session was ` +
                `moved onto while the check ran, OR one installed for this tab by something ` +
                `else in that window; nothing here can tell which, so ${rebind.uuid} is not ` +
                `claimed to be the identity you asked for. CONFIRM THE TARGET BEFORE RETRYING: ` +
                `panel_set_workflow_target({mode:"current"}) if you mean the canvas that is live ` +
                `now, or panel_open_workflow(<path>) for the workflow you actually meant; then ` +
                `re-issue.${nothingApplied} A bare retry is not refused by this message — it is ` +
                `simply not aimed at anything this check verified.`,
              {
                ...base,
                workflow_uuid: rebind.uuid,
                fence_repaired_by_this_call: "no",
                // NOT "yes". A retry would carry the fence this read saw, but nothing
                // here establishes that it belongs to the tab the caller addressed.
                retry_clears_refusal: "unknown",
                next_action: retryAction("confirm_target_then_retry"),
              },
            );
          }
          // unreadable / uncorroborated — say so rather than picking a remedy.
          return failWithFenceDiagnosis(
            `${raw}\n\nCHECKED, and the answer is UNKNOWN: the live canvas could not be re-read ` +
              `well enough to say whether it has an identity. Try ` +
              `panel_open_workflow(<path>) on the workflow you mean — it is the only recovery ` +
              `that works in BOTH states, because it gives the workflow an identity rather than ` +
              `adopting one that may not exist.`,
            {
              ...base,
              ...(("uuid" in rebind) ? { workflow_uuid: rebind.uuid } : {}),
              // `adopt_error` is the one status that cannot say which side of the write
              // it threw on, so it is the one that may not claim "nothing was repaired".
              fence_repaired_by_this_call: rebind.status === "adopt_error" ? "unknown" : "no",
              retry_clears_refusal: "unknown",
              next_action: "open_workflow",
            },
          );
        } catch {
          // The diagnosis must never change how the call failed — so the TEXT is the
          // bare cause, exactly as before. The field is still emitted, saying unknown:
          // a caller that has to distinguish "no field" from "field says unknown" is
          // back to inferring, which is the defect this fix is about.
          return failWithFenceDiagnosis(raw, {
            dispatched,
            retry_safe: retrySafe,
            rebind_status: "check_threw",
            // The check threw, so it never reported a `before` — that is not an
            // absence, it is an unmade observation.
            prior_fence: "unreadable",
            tab_before: tabBefore,
            tab_after: ctx.tabId,
            fence_repaired_by_this_call: "unknown",
            retry_clears_refusal: "unknown",
            next_action: "unknown",
          });
        }
      }
      // #1330 — CORROBORATE A FENCE MISMATCH INSTEAD OF LETTING IT REPEAT.
      //
      // The reporter built 12 nodes successfully, then EVERY panel_connect was refused
      // on an instance mismatch. Calling panel_set_workflow_target({mode:"current"})
      // straight afterwards reported `already_current` naming the SAME uuid the command
      // had been issued for, and the retried connects all succeeded. So the mismatch was
      // transient and self-correcting, and the caller paid 14 refusals to find that out —
      // because nothing in the refusal distinguishes "the canvas really is a different
      // workflow" from "the identity flipped for a moment while you were building".
      //
      // The fence is NOT weakened, nothing is auto-applied, and — #1646 — the
      // probe is READ-ONLY. The first version of this check re-derived the fence
      // onto the live canvas when the two genuinely differed ("AUTO-REBIND"), so
      // every later mutation in the caller's sequence was silently re-pointed at
      // the very canvas the refusal had just named as the wrong one — the exact
      // corruption the fence exists to prevent, delivered as recovery. Now the
      // check says which of the two states it found and the fence moves ONLY on
      // an explicit rebind: panel_set_workflow_target({mode:"current"}) or a
      // successful open. Until then every write stays refused against the target
      // the caller actually named. One informed retry replaces fourteen blind ones.
      //
      // Safe to recommend a retry because a fence refusal is checked BEFORE the handler
      // runs — "Nothing was applied" is structural here, not an echoed claim.
      if (isWorkflowInstanceMismatch(err) && isMutatingGraphCmd(cmd)) {
        const name = typeof cmd.cmd === "string" ? cmd.cmd : "panel command";
        const raw = err instanceof Error ? err.message : String(err);
        // The uuid the command CARRIED, read from the panel's own refusal rather than
        // from `cmd`: the stamp is applied downstream of here, so `cmd.workflow_uuid`
        // is undefined at this point and keying on it silently disabled the transient
        // branch — the one case this whole block exists for. The panel states both
        // sides of the comparison it performed, which is the authoritative record of
        // what was compared.
        const stamped = /issued for workflow instance ([0-9a-f-]{36})/i.exec(
          err instanceof Error ? err.message : String(err),
        )?.[1] ?? null;
        let verdict: string;
        try {
          const probe = await rebindWorkflowFence(ctx, { adopt: false });
          verdict =
            probe.status === "already_current" && stamped && probe.uuid === stamped
              ? `\n\nCHECKED: the live canvas now reports the SAME workflow instance this ` +
                `command carried (${stamped}), so the mismatch was TRANSIENT: the identity ` +
                `flipped and settled back, which happens while a new unsaved workflow is still ` +
                `materialising. RETRY THIS EXACT CALL ONCE. Nothing was applied, so a retry ` +
                `cannot double-apply, and re-issuing the whole build would duplicate the work ` +
                `that already succeeded.`
              : probe.status === "already_current"
                ? `\n\nCHECKED: the session's fence already names the live canvas ` +
                  `(${probe.uuid}), so it was not the stale side. Retry once — if it refuses ` +
                  `again with the same pair, the two identities are genuinely disagreeing and ` +
                  `panel_open_workflow is the way to settle which one you mean.`
                : probe.status === "diverged"
                  ? `\n\nCHECKED, and this session was NOT re-pointed: the live canvas is a ` +
                    `DIFFERENT workflow (${probe.uuid}) than the one this command was issued ` +
                    `for${stamped ? ` (${stamped})` : ""}. The fence is unchanged, so later ` +
                    `edits in this sequence keep being refused rather than landing on the ` +
                    `wrong canvas. WHAT TO DO: to edit the workflow you issued for, bring it ` +
                    `back with panel_open_workflow; to follow the live canvas instead, ` +
                    `re-target deliberately with panel_set_workflow_target({mode:"current"}). ` +
                    `Either way the move is explicit — it is never made for you off a refused ` +
                    `mutation.`
                  : probe.status === "healed_by_panel"
                    ? `\n\nCHECKED, and the answer CHANGED while it was being read: the panel ` +
                      `re-advertised its identity and this session's fence moved to the live ` +
                      `canvas (${probe.uuid}) — through the panel's own repair, not this ` +
                      `check. If you meant the EARLIER workflow, re-select it with ` +
                      `panel_open_workflow before any further edits; they now target the live one.`
                    : `\n\nCHECKED, but the live canvas could not be established ` +
                      `(${probe.status}), so the fence is unchanged and a bare retry will fail ` +
                      `the same way. Re-select the workflow you mean with panel_open_workflow, ` +
                      `then retry.`;
        } catch (probeErr) {
          // Never let the diagnosis fail the call differently than it already failed.
          verdict =
            `\n\nCHECKED, and the check itself threw, so the live canvas is UNKNOWN — this ` +
            `refusal stands on its own terms and the fence is unchanged. ` +
            `(${probeErr instanceof Error ? probeErr.message : String(probeErr)})`;
        }
        return fail(`${name} was NOT applied — nothing changed. ${raw}${verdict}`);
      }
      // #1519 — THE SAME REFUSAL ON A READ, AND AN ABSENT STAMP IS NOT A WRONG ONE.
      //
      // The reporter's session resumed onto a different workflow and the very first
      // live-canvas read came back
      //
      //   workflow instance mismatch: this command carries no workflow-instance
      //   stamp, and the active canvas reports 2b3f4684-…. Nothing was applied.
      //
      // Measured on current main before this branch existed: the panel's refusal IS
      // the entire tool result. The corroboration above is gated on
      // `isMutatingGraphCmd`, so a READ refused by the very same fence fell through
      // every branch here and this side added nothing at all. #1480's guard already
      // extends its diagnosis to reads "on purpose: `panel_graph_outline` refusing
      // was half of the reported dead end"; this is the same reasoning for the stamp
      // fence.
      //
      // What the panel says on its own is NOT nothing, and the difference is the
      // point. Since panel 0.11.83 its refusal ends "Re-target with
      // panel_set_workflow_target({mode:"current"}), or re-select the intended
      // workflow with panel_open_workflow, then retry" — both exits, offered as
      // interchangeable, with nothing said about which one this refusal calls for.
      // That is right for the panel, which by design "observed only that the two
      // identities differ" and refuses to infer a cause; it is not enough for the
      // caller, and in the #1331 state the first of the two cannot work at all — it
      // reports success while the read keeps failing. Only this side can take the
      // read that decides, so this side takes it.
      //
      // TWO REFUSALS, NOT ONE. `isWorkflowInstanceMismatch` matches both of the
      // panel's states, and they are different facts with OPPOSITE remedies:
      //
      //   "carries no workflow-instance stamp"  → this session has NO workflow
      //       identity. Nothing was compared; the command was refused for arriving
      //       bare. Deriving a fence from the live canvas is what fixes it.
      //   "issued for workflow instance <uuid>" → this session HAS an identity and
      //       the canvas disagrees with it. Deriving a fence from the live canvas
      //       ABANDONS the workflow the caller named — the right move only if that
      //       is what they meant.
      //
      // Collapsing them would hand the second case the first case's remedy, which is
      // the retarget #1646 removed for cause. So the shape is read from the panel's
      // own words and, when it matches NEITHER wording, the answer is UNKNOWN and is
      // said to be — never guessed into one of the two.
      //
      // Read from the REFUSAL, never from `cmd.workflow_uuid`: the stamp is applied
      // downstream of here, so that field is undefined at this point for BOTH states
      // (the trap that silently disabled #1330's transient branch one block up).
      //
      // NOTHING IS ADOPTED. The probe is the same read-only one (`adopt:false`), so
      // this reports which state it found and the fence moves only on an explicit
      // rebind. The refusal itself is preserved verbatim and the call still fails.
      if (isWorkflowInstanceMismatch(err) && isFencedGraphRead(cmd)) {
        const name = typeof cmd.cmd === "string" ? cmd.cmd : "panel command";
        const raw = err instanceof Error ? err.message : String(err);
        const stamped = /issued for workflow instance ([0-9a-f-]{36})/i.exec(raw)?.[1] ?? null;
        const unstamped = /carries no workflow-instance stamp/i.test(raw);
        // Three-valued on purpose. A panel whose wording matches neither is not
        // evidence for either state, and this branch must not manufacture one.
        const shape: "unstamped" | "stamped" | "unstated" = unstamped
          ? "unstamped"
          : stamped
            ? "stamped"
            : "unstated";
        // Naming `mode:"current"` to a PINNED session is naming something that also
        // RELEASES the pin. Say so where it applies rather than letting the caller
        // discover it by losing their target.
        const pin = ctx.workflowTarget?.get(ctx.tabId);
        const pinNote =
          pin?.mode === "pinned" && pin.path
            ? ` NOTE: this session is PINNED to ${pin.filename ?? pin.path}, and mode:"current" ` +
              `RELEASES that pin. To keep it, bring that workflow back to the canvas with ` +
              `panel_open_workflow(${JSON.stringify(pin.path)}) and retry instead.`
            : "";
        const RETRY_IS_FREE =
          `RETRY THIS EXACT CALL ONCE — this is a read, so re-issuing it cannot double-apply ` +
          `anything.`;
        let verdict: string;
        try {
          const probe = await rebindWorkflowFence(ctx, { adopt: false });
          const live = "uuid" in probe ? probe.uuid : null;
          verdict =
            probe.status === "no_identity"
              // Worded without reference to the session's own side, because this
              // state is reachable from BOTH shapes: an unstamped session and a
              // stamped one can each face a canvas with no readable identity, and
              // "no identity EITHER" would be false for the second.
              ? `\n\nCHECKED, so this is not a guess: the live canvas was re-read and it carries ` +
                `no workflow identity of its own (${probe.why}). ` +
                `panel_set_workflow_target({mode:"current"}) will NOT clear this — it chooses ` +
                `WHICH workflow to fence against and cannot mint an identity for one that has ` +
                `none, so it reports success while this read keeps being refused. RECOVERY: ` +
                `panel_open_workflow(<path>) on this same workflow; re-opening it is what gives ` +
                `it an identity. If it has never been saved there is no path to re-open — save ` +
                `it first with panel_save_workflow, which also gives it a stable identity.`
              : probe.status === "healed_by_panel"
                ? `\n\nCHECKED, and the answer CHANGED while it was being read: the panel ` +
                  `re-advertised its identity and this session's fence moved to the live canvas ` +
                  `(${live}) — through the panel's own repair, not this check. ${RETRY_IS_FREE}`
                : probe.status === "already_current"
                  ? shape === "unstamped"
                    ? // The COMPARISON, not a cause — the panel's own discipline. An
                      // identity established between dispatch and this read explains
                      // it, and so does this session having been re-bound onto another
                      // tab in between; neither was witnessed, so neither is asserted.
                      `\n\nCHECKED, and the two readings disagree: this session's fence NOW ` +
                      `names the live canvas (${live}), yet this command reached the panel ` +
                      `carrying no stamp at all. What produced that gap was not observed from ` +
                      `here. ${RETRY_IS_FREE}`
                    : `\n\nCHECKED: this session's fence already names the live canvas ` +
                      `(${live}), so it was not the stale side and the disagreement is gone by ` +
                      `the time it was looked at. ${RETRY_IS_FREE} If it refuses again with the ` +
                      `same pair, the two identities are genuinely disagreeing and ` +
                      `panel_open_workflow is the way to settle which one you mean.`
                  : probe.status === "diverged"
                    ? shape === "unstamped"
                      ? // Says only what the panel reported and what the probe read. It
                        // does NOT assert that this session holds no fence right now:
                        // `diverged` is also reached with a fence naming some third
                        // workflow, and that reading was never taken.
                        `\n\nCHECKED, and this is a MISSING stamp rather than a wrong one: the ` +
                        `panel refused it for arriving with NO stamp, so no two identities were ` +
                        `compared — this is not the case where you are pointed at another ` +
                        `workflow. The live canvas DOES have an identity ` +
                        `(${live}). Nothing was adopted here; this check is read-only and the ` +
                        `fence is unchanged. RECOVERY: ` +
                        `panel_set_workflow_target({mode:"current"}) derives this session's ` +
                        `fence from the live canvas, after which this read carries a stamp and ` +
                        `runs.${pinNote}`
                      : shape === "stamped"
                        ? // "was issued for", not "is fenced to": the uuid comes from the
                          // panel's account of what the COMMAND carried, and the session's
                          // fence may have moved since. The mutation branch above words
                          // it the same way for the same reason.
                          `\n\nCHECKED, and this session was NOT re-pointed: this command was ` +
                          `issued for ${stamped} and the live canvas is a DIFFERENT workflow ` +
                          `(${live}). ` +
                          `This is a WRONG stamp, not a missing one, so the two exits are not ` +
                          `interchangeable: to read the workflow you issued for, bring it back ` +
                          `with panel_open_workflow; to read the live canvas instead, re-target ` +
                          `deliberately with panel_set_workflow_target({mode:"current"}) — that ` +
                          `also re-points every later EDIT in this session, which is why it is ` +
                          `never done for you off a refusal.${pinNote}`
                        : `\n\nCHECKED, and the live canvas reports ${live}. Which side is ` +
                          `stale is NOT known from here: this panel's refusal states neither ` +
                          `that the command was unstamped nor which instance it was issued ` +
                          `for, so no remedy is named for it — read panel_list_workflows (the ` +
                          `panel exempts it from this fence) and decide which workflow you mean.`
                    : `\n\nCHECKED, but the live canvas could not be established ` +
                      `(${probe.status}), so the answer is UNKNOWN and the fence is unchanged. ` +
                      `Try panel_list_workflows — the panel exempts that read from this fence ` +
                      `(it is the recovery probe) — and re-select the workflow you mean with ` +
                      `panel_open_workflow.`;
        } catch (probeErr) {
          // A diagnosis must never change how the call failed.
          verdict =
            `\n\nCHECKED, and the check itself threw, so the live canvas is UNKNOWN — this ` +
            `refusal stands on its own terms and the fence is unchanged. ` +
            `(${probeErr instanceof Error ? probeErr.message : String(probeErr)})`;
        }
        return fail(`${name} was refused before it ran — no graph data was read. ${raw}${verdict}`);
      }
      // #1480 — NAME A REMEDY THE TAB CAN ACTUALLY ACCEPT.
      //
      // The panel's own remedy for this verdict is `panel_open_workflow(<path>)`, which
      // is right for a saved tab and unfollowable for a never-saved one: that tab has no
      // path, and its title is not a selector. The reporter tried the title, was told
      // "no workflow matching", and found every other exit closed as well — reload
      // refuses while unsaved, save refuses under this same guard (#708). Canvas
      // readable, canvas unedittable, and the only way out was a human pressing Ctrl+S.
      //
      // Nothing here is auto-applied and the guard is NOT weakened. One read-only
      // `workflow_list` (exempt from this fence) establishes the single fact that decides
      // which remedy is reachable, and the refusal then names THAT one. Applied to reads
      // as well as mutations on purpose: `panel_graph_outline` refusing was half of the
      // reported dead end, and this verdict is raised before every executor, so the
      // "NOT applied" claim it rides on is equally true either way.
      if (isRootWorkflowUuidMismatch(err)) {
        const raw = err instanceof Error ? err.message : String(err);
        try {
          const tab = await readActiveTabRebindSelector(ctx);
          if (tab.status === "unsaved" && tab.selector) {
            return fail(
              `${raw}\n\nCHECKED, so this is not a guess: the active tab has NEVER BEEN SAVED ` +
                `(the workflow list reports path: null, filename: null${
                  tab.title ? `, title: ${JSON.stringify(tab.title)}` : ""
                }). The remedy above names a <path> that DOES NOT EXIST for this tab, and its ` +
                `title is not a selector — passing either fails with "no workflow matching". ` +
                `USE ITS ROUTING KEY, which is the only selector an unsaved tab has and needs ` +
                `no file on disk: panel_open_workflow({path: ${JSON.stringify(tab.selector)}}). ` +
                `Do NOT reach for panel_save_workflow first — under this same guard it refuses ` +
                `too (#708) — and do NOT reload while the tab is unsaved. If re-opening by ` +
                `routing key still refuses, the two identities genuinely disagree and the user ` +
                `has to save or reload the tab by hand.`,
            );
          }
          if (tab.status === "saved" && tab.selector) {
            return fail(
              `${raw}\n\nCHECKED: the active tab IS saved, so the remedy above is reachable as ` +
                `written — panel_open_workflow({path: ${JSON.stringify(tab.selector)}}).`,
            );
          }
          return fail(
            `${raw}\n\nCHECKED, and the answer is UNKNOWN: which panel_open_workflow selector ` +
              `this tab accepts could not be established (${tab.why}). If it turns out to have ` +
              `never been saved, <path> will not name it — read panel_list_workflows and pass ` +
              `the active record's routing_key instead.`,
          );
        } catch {
          // The diagnosis must never change how the call failed.
          return fail(raw);
        }
      }
      if (isCapabilityRefusal(err)) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      // #1001 — same shape, opposite cause: a ROUTING-AMBIGUITY refusal already
      // knows exactly why it refused AND names both recoveries in its own text
      // (target a workflow explicitly, or wait for the next single-origin
      // message). The generic wrapper below would bury that under a differential
      // — "disconnected, still reconnecting, or the binding is stale" — of which
      // all three are FALSE here, plus a "retry in a moment" that can never
      // work. That speculation reads as observation: the reporter of #1001 filed
      // "reconnect readiness is reported before the route is usable" as a second
      // root cause, citing this wrapper's guess as their evidence. Surface the
      // cause verbatim; add only the fact the flag actually proves.
      if (isRoutingAmbiguity(err)) {
        return fail(
          `${typeof cmd.cmd === "string" ? cmd.cmd : "panel command"} was not dispatched — ` +
            `nothing was applied. ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (dispatchOutcomeOf(err) === false) {
        const name = typeof cmd.cmd === "string" ? cmd.cmd : "panel command";
        // Neutral wording: a dispatched:false flag proves only that the command was NOT
        // dispatched — it can be a routing refusal (the bound tab is gone / reconnecting),
        // an ambiguous-or-multiple-tab resolver refusal (other tabs DO exist), or a socket
        // write failure. All share the same TRUE facts (nothing applied) and the same
        // recovery (rebind onto the tab that's live now); the raw cause carries the
        // specifics. Do NOT overstate "disconnected", which is false for the ambiguity case.
        return fail(
          `${name} could not be dispatched to this session's panel tab — nothing was applied. ` +
            `The tab may be disconnected, still reconnecting after a restart/reload, or the ` +
            `session's binding is stale (e.g. another workflow tab is now active). Retry in a ` +
            `moment, or rebind with panel_set_workflow_target({mode:"current"}) to follow the ` +
            `tab that's live now. (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      // #694 — EXPLICIT caller retry identity. A MUTATING command whose outcome is
      // UNKNOWN — a post-write reply timeout or a mid-command disconnect (the only
      // two dispatched:true rejections the bridge mints) — may already have been
      // applied by the panel, so a blind retry can double-apply. Name the dispatched
      // attempt's rid as the caller's retry token: re-issuing identical args plus
      // retry_of:"<rid>" lets the panel recognize and dedupe that exact mutation.
      // Pre-write refusals (dispatched:false, handled above) mint NO token — nothing
      // was sent, so there is nothing to dedupe.
      //
      // Minting is gated on RETRY_TOKEN_CMDS — the map's own membership, which is
      // the question being asked ("does the panel dedupe a retry of this?"). It
      // used to be gated on requiresWorkflowStampEnforcement AS WELL, as a second
      // guard against a read sneaking into the map. That guard read as a free
      // extra until #778 gave the fence its own effect ledger and the two
      // predicates diverged: the four idempotent UI-state commands the map admits
      // on purpose (select_nodes, enter/exit_subgraph, copy_nodes) are `inert`,
      // so keeping it would have silently changed which commands mint a token —
      // an unrelated behaviour change smuggled in by a classification fix. The
      // "no read in the retry map" property it was standing in for is now
      // asserted directly in panel-retry-identity.test.ts, where it belongs.
      if (
        dispatchedRid &&
        RETRY_TOKEN_CMDS.has(typeof cmd.cmd === "string" ? cmd.cmd : "") &&
        (dispatchOutcomeOf(err) === true || isReplyTimeoutTagged(err))
      ) {
        const cause = err instanceof Error ? err.message : String(err);
        return carryReplyTimeoutMark(
          err,
          fail(
            `${cause}\n\nTo retry this exact mutation, re-issue identical args plus retry_of:"${dispatchedRid}"; otherwise call normally.` +
              queueBusyTimeoutNote(),
          ),
        );
      }
      const timeoutCause = err instanceof Error ? err.message : String(err);
      return carryReplyTimeoutMark(err, fail(`${timeoutCause}${queueBusyTimeoutNote()}`));
    }
  };
  /**
   * #1560 — ONE exit, so a structural fact about the failure survives the trip into a
   * ToolResult no matter which of `callOnce`'s exits produced it.
   *
   * `carryReplyTimeoutMark` is applied at three of those exits by hand, which is fine
   * for a fact only those three can carry. "The panel answered" is not like that: an
   * acknowledged `ok:false` reply can leave through the capability branch, the
   * root-uuid branch, the mismatch branch or the bare tail, and a caller reading the
   * mark has to be able to trust its ABSENCE. Stamping it here means a new `fail(...)`
   * exit added later inherits the mark instead of quietly losing it.
   *
   * The failure is captured per invocation (a closure local, not shared state), so
   * concurrent `ctx.call`s — including the `rebindWorkflowFence` round trip that
   * `callOnce`'s own catch makes — cannot read each other's.
   */
  const call = async (
    cmd: Record<string, unknown>,
    timeoutMs?: number,
    onDispatchedRid?: (rid: string) => void,
  ): Promise<ToolResult> => {
    let failure: unknown;
    const res = await callOnce(cmd, timeoutMs, onDispatchedRid, (err) => {
      failure = err;
    });
    return carryPanelAnsweredMark(failure, res);
  };
  // Human-in-the-loop confirmation for a DESTRUCTIVE op: render a yes/no card in
  // the panel and block on the user's pick. Returns false on decline, timeout, or
  // no panel — so the op is SKIPPED, never performed without an explicit yes.
  // (We gate inside the tool because the SDK's canUseTool is bypassed under
  // bypassPermissions, which the panel agent runs in; the Codex HTTP path runs
  // approvalPolicy "never", so the same in-tool gate is the only safeguard.)
  const confirm = async (
    question: string,
    header: string,
    timeoutMs?: number,
  ): Promise<ConfirmOutcome> => {
    // #360: the enclosing MCP `tools/call` is killed at ~300s. A hardcoded 300s
    // card wait had ZERO margin below that budget — so an unanswered confirm blew
    // the whole tool call (a transport timeout) instead of returning cleanly, and
    // any late answer was lost. CLAMP the card deadline under the budget (the same
    // getAskTiming() ceiling panel_ask uses for #486) and, on a reply-timeout,
    // poll the bridge's late-reply buffer for a bounded grace so a slow-but-valid
    // yes/no is still HONORED. A genuine no-answer returns "timeout" (reported
    // honestly by the caller), never a silent decline.
    const base = getAskTiming();
    // A caller may pass a tighter WHOLE-confirm budget (#536: panel_restart bounds
    // confirm+dispatch+readiness under the outer limit). Treat timeoutMs as the HARD
    // ceiling on deadline+grace so we never overrun the caller's budget, while still
    // never exceeding the ask clamp. Absent → the full clamp (deadline+grace).
    const total =
      typeof timeoutMs === "number"
        ? Math.max(1, Math.min(timeoutMs, base.deadlineMs + base.graceMs))
        : base.deadlineMs + base.graceMs;
    const deadlineMs = Math.max(1, Math.min(base.deadlineMs, total));
    const graceMs = Math.max(0, total - deadlineMs);
    const timing = { deadlineMs, graceMs, pollMs: base.pollMs };
    // ONE absolute ceiling for card wait + grace, anchored before any work — see
    // pollLateAskReply's `hardDeadline`. Without it the two budgets are additive
    // on top of everything else the handler does, which is how a bounded confirm
    // still overran the enclosing tools/call budget.
    const budgetEnd = Date.now() + total;
    const askId = randomUUID();
    try {
      ensureReachable();
      const reply = await bridge.send(
        {
          cmd: "ask_user",
          ask_id: askId,
          question,
          header,
          options: [
            { label: "Yes, go ahead", description: "" },
            { label: "No, cancel", description: "" },
          ],
        } as { cmd: string },
        { tabId: ctx.tabId, timeoutMs: timing.deadlineMs },
      );
      return isAffirmative(reply) ? "yes" : "no";
    } catch (err) {
      // Only a card-reply TIMEOUT is recoverable/honest-as-timeout: poll the late
      // buffer, then report "timeout" if still unanswered. Any other error (no
      // panel, transport failure) still SKIPS the destructive op — but it is reported
      // as `unreachable`, not `no` (#1332). The user did not decline; we never got to
      // ask them, and a caller that says "cancelled" on this is describing a decision
      // nobody made.
      if (isReplyTimeoutError(err)) {
        const late = await pollLateAskReply(bridge, askId, timing, budgetEnd);
        if (late !== undefined) return isAffirmative(late) ? "yes" : "no";
        return "timeout";
      }
      return "unreachable";
    }
  };

  // EXPLICIT self-heal — see PanelToolCtx.rebindToActiveTab. Only rebinds when
  // the current tabId is genuinely orphaned (no live tab reachable); a healthy
  // session is left untouched so this never hijacks routing on a multi-tab
  // deployment. Throws (clear message, via resolveActiveTabId) when a single
  // active tab can't be picked.
  const rebindToActiveTab = (opts?: {
    scopeRecoveryConsent?: boolean;
  }): { previous: string; current: string; rebound: boolean; repinRefusal?: string } => {
    const previous = ctx.tabId;
    // #884 P0 — a SCOPE-bound ctx must never be REPLACED by a real tab id (that
    // would permanently narrow the shared conversation's routing to one tab).
    // The ctx therefore stays scope-bound. Its ONE recovery is the explicit
    // repin — and it is DOUBLE-gated (confirming gate 3, P0):
    //  1. CONSENT: only panel_set_workflow_target({mode:"current"}) passes
    //     scopeRecoveryConsent. panel_reload and every implicit self-heal call
    //     this without it, and for them the scope branch is a strict no-op —
    //     the previous round's unconditional repin let panel_reload silently
    //     re-aim a HEALTHY turn at whichever tab a queued message had just
    //     made last-active, the exact P0 this PR exists to prevent.
    //  2. RECOVERY-ONLY: even with consent, a pin that still reaches a live
    //     tab is healthy and stays. Only a dead or ambiguous pin (canReach
    //     false — the state whose refusal names this tool as the way out,
    //     confirming gate 2, P1) is escaped, via the bridge repin handler
    //     (which re-checks both conditions itself, so no future caller can
    //     bypass this gate).
    if (isScopeAddress(previous)) {
      // Provably dead/ambiguous ONLY: a bridge that cannot answer canReach
      // cannot prove the pin is dead, so it must not be moved (conservative;
      // every real bridge answers).
      const pinProvenDead =
        typeof bridge.canReach === "function" && !bridge.canReach(previous);
      if (!opts?.scopeRecoveryConsent || !pinProvenDead) {
        return { previous, current: previous, rebound: false };
      }
      // #1077 Finding 2 — carry the REASON out when nothing was repinned. This
      // collapsed to `Boolean(repinned)`, so four different refusals arrived at
      // the caller as one bare `false` and the user was told only that the
      // adoption was refused. One of those refusals repeats forever (an active
      // tab on another backend's conversation while this one has several), and
      // nothing in the reply hinted that naming a workflow is the way out.
      const outcome = bridge.repinScopeToActive?.(previous);
      const repinned = typeof outcome === "string" ? outcome : undefined;
      const repinRefusal =
        outcome && typeof outcome === "object" ? outcome.reason : undefined;
      return {
        previous,
        current: previous,
        rebound: Boolean(repinned),
        ...(repinRefusal ? { repinRefusal } : {}),
      };
    }
    // A healthy binding is left untouched (never disturb a live session). Recovery only
    // fires for an orphaned/stale tab id.
    if (bridge.canReach(previous)) return { previous, current: previous, rebound: false };
    // Pick the target tab EXCLUDING headless (canvas-less) viewers, which can't host a
    // graph session (codex). Prefer the sole interactive tab; with 2+ interactive tabs
    // fall back to the bridge's last-active resolution (the explicit-rebind "use what's
    // live now" consent); with none, throw. A resolution that still lands on a headless
    // tab is rejected as "nothing bindable" so no graph session is ever bound canvas-less.
    const eligible = interactiveTabIds();
    let current: string;
    if (eligible) {
      if (eligible.length === 1) current = eligible[0];
      else if (eligible.length === 0) throw new Error("Panel not reachable: no panel connected");
      else current = bridge.resolveActiveTabId(); // 2+ interactive → last-active (or throws)
    } else {
      current = bridge.resolveActiveTabId(); // legacy bridge (no headless info)
    }
    if (typeof bridge.isHeadless === "function" && bridge.isHeadless(current)) {
      throw new Error("Panel not reachable: no panel connected");
    }
    // Carry a pinned workflow target across to the new tab id so a pinned
    // session keeps its pin after self-healing.
    const pinned = workflowTargets?.get(previous);
    if (workflowTargets && pinned && pinned.mode === "pinned") {
      workflowTargets.clear(previous);
      workflowTargets.set(current, pinned);
    }
    ctx.tabId = current;
    return { previous, current, rebound: true };
  };

  ctx.call = call;
  ctx.confirm = confirm;
  ctx.rebindToActiveTab = rebindToActiveTab;
  ctx.ensureReachable = ensureReachable;
  ctx.awaitReachable = awaitReachable;
  ctx.panelConnectionIdentity = panelConnectionIdentity;
  ctx.awaitPostRestartReachable = awaitPostRestartReachable;
  ctx.tabCanMutateGraph = () => bridge.tabCanMutateGraph(ctx.tabId);
  ctx.tabGraphMutationCapability = () => bridge.tabGraphMutationCapability(ctx.tabId);
  return ctx;
}

/**
 * Resolve a workflow source for the strip/slice tools: an explicit `pack`,
 * `path`, or inline `graph` — or, when none is given, the LIVE CANVAS via the
 * panel's graph_serialize command. The canvas default exists because "flatten
 * what I have open" is the common ask, and requiring a save-to-disk round trip
 * first derailed real sessions (deleted placeholder files, 404 tabs).
 */
/**
 * Rebuild a UI-format workflow ({ nodes, links }) from the panel's back-compat
 * `graph_get_state` reply (the #384 fallback). Each summarized node carries its
 * widget values keyed BY NAME (`widgets`) and its inputs' upstream source
 * (`connected_from`), so we materialize:
 *   - nodes with `widgets_values` as the name→value OBJECT — convertUiToApi maps
 *     those by name, which also sidesteps the positional widget-order pitfalls,
 *   - a synthetic links array + per-input `link` ids from `connected_from`.
 * Returns null when the reply has no usable nodes.
 */
function reconstructUiFromState(reply: unknown): Record<string, unknown> | null {
  const r = reply as { nodes?: unknown[]; truncated?: boolean; node_count?: number } | null;
  const nodesIn = r?.nodes;
  if (!Array.isArray(nodesIn) || nodesIn.length === 0) return null;
  // graph_get_state caps at MAX_STATE_NODES (100) and flags the overflow. A
  // truncated capture would silently yield an INCOMPLETE executable graph, so
  // refuse it — the caller then surfaces the actionable "pass pack/path/graph"
  // error rather than stripping a partial workflow.
  if (r?.truncated === true) return null;
  if (typeof r?.node_count === "number" && r.node_count > nodesIn.length) return null;

  type StateNode = {
    id: number;
    type: string;
    title?: string;
    mode?: string;
    widgets?: Record<string, unknown>;
    inputs?: {
      name: string;
      type?: string;
      connected_from?: { node_id: number; output_slot?: number } | null;
    }[];
    outputs?: { name: string; type?: string }[];
  };

  const uiNodes = nodesIn.map((raw) => {
    const n = raw as StateNode;
    const mode = n.mode === "mute" ? 2 : n.mode === "bypass" ? 4 : 0;
    return {
      id: n.id,
      type: n.type,
      mode,
      pos: [0, 0] as [number, number],
      inputs: (n.inputs ?? []).map((inp) => ({
        name: inp.name,
        type: inp.type ?? "*",
        link: null as number | null,
      })),
      outputs: (n.outputs ?? []).map((o) => ({
        name: o.name,
        type: o.type ?? "*",
        links: [] as number[],
      })),
      widgets_values:
        n.widgets && typeof n.widgets === "object"
          ? (n.widgets as unknown as unknown[])
          : ([] as unknown[]),
      properties: {} as Record<string, unknown>,
      ...(n.title ? { title: n.title } : {}),
    };
  });

  const byId = new Map(uiNodes.map((n) => [n.id, n]));
  const links: [number, number, number, number, number, string][] = [];
  let linkId = 0;
  nodesIn.forEach((raw, idx) => {
    const inputs = (raw as StateNode).inputs ?? [];
    const tgt = uiNodes[idx];
    inputs.forEach((inp, slot) => {
      const from = inp.connected_from;
      if (!from || from.node_id == null || !byId.has(from.node_id)) return;
      const id = ++linkId;
      tgt.inputs[slot].link = id;
      const srcNode = byId.get(from.node_id)!;
      const srcSlot = from.output_slot ?? 0;
      while (srcNode.outputs.length <= srcSlot) {
        srcNode.outputs.push({ name: `out_${srcNode.outputs.length}`, type: "*", links: [] });
      }
      srcNode.outputs[srcSlot].links.push(id);
      links.push([id, from.node_id, srcSlot, tgt.id, slot, inp.type ?? "*"]);
    });
  });

  return { nodes: uiNodes, links } as unknown as Record<string, unknown>;
}

/**
 * Core ComfyUI node types whose PRIMARY content is drawn by a DOM OVERLAY widget
 * positioned over the LiteGraph canvas — NOT painted onto the canvas itself. A
 * canvas capture (panel_screenshot / graph_screenshot) therefore shows their body
 * EMPTY even though the content is present in the graph. Flagging them in the tool
 * result stops an agent from concluding the node is blank and "fixing" a
 * non-existent problem (#567).
 *
 * Kept deliberately narrow (the confirmed reproducer) to avoid false positives.
 * Custom DOM widgets contributed by node packs (preview/image/video/HTML widgets)
 * are NOT enumerable from the orchestrator, and the faithful fix — compositing the
 * live DOM overlay into the capture — is a browser/panel-side change. This
 * annotation is the cheap, always-correct half that protects the agent's reasoning.
 */
const DOM_OVERLAY_NODE_TYPES = new Set<string>(["MarkdownNote"]);

/** Best-effort: serialize the live graph and return the nodes whose content a
 *  canvas capture misses (DOM-overlay widgets, per DOM_OVERLAY_NODE_TYPES). Never
 *  throws and never rejects — returns [] on any failure so panel_screenshot still
 *  returns its image; the note is a bonus, not a dependency. */
async function domOverlayNodesInView(
  ctx: PanelToolCtx,
): Promise<Array<{ id: unknown; type: string }>> {
  try {
    const target = ctx.workflowTarget?.get(ctx.tabId);
    const cmd = target
      ? withWorkflowTarget({ cmd: "graph_serialize" }, target)
      : { cmd: "graph_serialize" };
    const reply = (await ctx.bridge.send(cmd as { cmd: string }, {
      tabId: ctx.tabId,
      timeoutMs: 5000,
    })) as { nodes?: unknown[] } | null;
    const nodes = reply?.nodes;
    if (!Array.isArray(nodes)) return [];
    const hits: Array<{ id: unknown; type: string }> = [];
    for (const raw of nodes) {
      const n = raw as { id?: unknown; type?: unknown };
      if (typeof n?.type === "string" && DOM_OVERLAY_NODE_TYPES.has(n.type)) {
        hits.push({ id: n.id, type: n.type });
      }
    }
    return hits;
  } catch {
    return [];
  }
}

/** Compose the "these nodes appear empty in the capture" note (#567), or "" when
 *  no DOM-overlay nodes are in view. Exported for tests. */
export function domOverlayScreenshotNote(nodes: Array<{ id: unknown; type: string }>): string {
  if (!nodes.length) return "";
  const list = nodes
    .map((n) => `${n.type}${n.id != null ? ` #${n.id}` : ""}`)
    .join(", ");
  const ids = nodes
    .map((n) => n.id)
    .filter((id): id is number => typeof id === "number");
  const readHint = ids.length
    ? ` Read their text with panel_query_graph {ids:[${ids.join(", ")}], fields:'detail'}.`
    : " Read their text with panel_query_graph (fields:'detail').";
  return (
    `note: this workflow contains ${nodes.length} node(s) (${list}) whose content is drawn by a ` +
    `DOM overlay widget that a canvas capture like this screenshot cannot render — such a node shows ` +
    `an EMPTY body in the PNG even though its content IS present in the graph.${readHint} If a node ` +
    `looks blank here, do NOT treat it as missing content or "fix" it.`
  );
}

async function resolveWorkflowInput(
  args: Record<string, unknown>,
  ctx: PanelToolCtx,
  // The live-canvas graph_get_state fallback (#384) is LOSSY: it reconstructs
  // only nodes/links/widgets (name-keyed) — no layout, groups, properties, or
  // subgraph definitions. That's fine for panel_strip_workflow (API/prompt output
  // for inspection/execution), but panel_flatten_workflow LOADS its result back
  // ONTO the canvas and panel_slice_workflow needs groups to find its seeds, so
  // they must NOT take this fallback — they keep the actionable "update your
  // panel" error instead. Only strip opts in.
  allowStateFallback = false,
  // Collects disclosure lines about the live widget capture (#959). Only the
  // live-canvas path writes here, and only when something was left mapped by
  // POSITION — the caller surfaces these alongside the converter's warnings so an
  // unverified widget mapping is never presented as a verified one.
  notes?: string[],
): Promise<Record<string, unknown>> {
  // panel#775 — every caller here (strip / flatten / slice) needs a UI
  // /litegraph graph, and NONE of them validated the shape. A pack or file
  // holding API/prompt format therefore reached them raw:
  //   • panel_strip_workflow CRASHED on ".map of undefined" (no `nodes`);
  //   • panel_flatten_workflow(apply:true) reported SUCCESS and loaded a
  //     0-node graph — a false success on a canvas-replacing operation;
  //   • panel_slice_workflow shares the path and had the same latent bug.
  // panel_load_workflow already refused this correctly via assertUiWorkflow;
  // routing the other three through the SAME check makes all four agree
  // instead of one refusing, one crashing and one lying.
  //
  // The LIVE-CANVAS path below is deliberately NOT validated here: it is
  // built by graph_serialize/graph_get_state and already carries its own
  // shape handling plus the #384 lossy-fallback notes. Only CALLER-SUPPLIED
  // sources — which are the ones that can be the wrong format — are checked.
  if (args.pack) {
    return assertUiWorkflow(
      readPackWorkflow(args.pack as string),
      `Pack "${String(args.pack)}" workflow.json`,
    );
  }
  if (args.path) {
    return assertUiWorkflow(
      await readWorkflowFromPath(args.path as string),
      `Workflow file "${String(args.path)}"`,
    );
  }
  if (args.graph != null) {
    return assertUiWorkflow(
      typeof args.graph === "string" ? JSON.parse(args.graph as string) : args.graph,
      "The supplied `graph`",
    );
  }
  let reply: unknown;
  try {
    ctx.ensureReachable?.();
    // Route to the SAME authoritative target as ctx.call: when the session is
    // pinned, inject the pinned workflow_path so the live-canvas capture serializes
    // the PINNED workflow, not whatever tab is visible (codex — this direct send
    // otherwise bypasses withWorkflowTarget and reads the wrong graph).
    const target = ctx.workflowTarget?.get(ctx.tabId);
    const cmd = target
      ? withWorkflowTarget({ cmd: "graph_serialize" }, target)
      : { cmd: "graph_serialize" };
    reply = await ctx.bridge.send(cmd as { cmd: string }, {
      tabId: ctx.tabId,
      timeoutMs: 30000,
    });
  } catch (err) {
    // #384: a panel too old to register graph_serialize (added at 0.8.2) still
    // answers the back-compat `graph_get_state`. On an unsupported-command
    // rejection ONLY (a genuine transport/timeout error must surface as-is), fall
    // back to it and reconstruct the graph so "strip the live canvas" works
    // without a save-to-disk round trip.
    // #413: the bridge REWRITES the panel's raw "Unknown command" into a "too old
    // for graph_serialize" message (reactive) or throws it proactively (#236) —
    // both stripped the literal "unknown command" text, so the old
    // /unknown command/ regex here NEVER matched and the fallback was silently
    // skipped, surfacing the actionable error even though graph_get_state would
    // have worked. Detect the condition structurally instead.
    const msg = err instanceof Error ? err.message : String(err);
    if (allowStateFallback && isPanelCmdUnsupportedError(err, "graph_serialize")) {
      try {
        const target = ctx.workflowTarget?.get(ctx.tabId);
        const stateCmd = target
          ? withWorkflowTarget({ cmd: "graph_get_state" }, target)
          : { cmd: "graph_get_state" };
        const stateReply = await ctx.bridge.send(stateCmd as { cmd: string }, {
          tabId: ctx.tabId,
          timeoutMs: 30000,
        });
        const rebuilt = reconstructUiFromState(stateReply);
        if (rebuilt) return rebuilt;
      } catch {
        /* fall through to the actionable error below */
      }
    }
    // #721: only blame an old panel when the error actually IS an
    // unsupported-command rejection. Anything else (e.g. the panel's graph
    // desync guard, whose remedy is rebinding/opening the workflow) already
    // carries its own remedy in the message — appending the version hint
    // there misdirects the agent to pack/path/graph instead.
    if (isPanelCmdUnsupportedError(err, "graph_serialize")) {
      throw new Error(
        `Couldn't capture the live canvas (${msg}). ` +
          `An older panel version may not support graph_serialize — pass pack, path, or graph instead.`,
      );
    }
    throw new Error(`Couldn't capture the live canvas (${msg}).`);
  }
  const wf = (reply as { workflow?: unknown } | null)?.workflow;
  if (!wf || typeof wf !== "object") {
    throw new Error("The live canvas returned no graph — pass pack, path, or graph explicitly.");
  }

  // #959: the serialized graph's widget values are POSITIONAL, and their order is
  // the frontend's — which object_info's input order does not reproduce for custom
  // nodes that add or reorder widgets in JS. Take a second, name-keyed read of the
  // same canvas so the converter can map by NAME instead of by index. Structure
  // still comes from graph_serialize (this adds values only, never nodes or links),
  // so a panel too old to answer, a slow read, or a mismatched scope costs nothing
  // but the disclosure that the mapping stayed positional and is UNVERIFIED.
  if (allowStateFallback && notes) {
    let stateReply: unknown;
    try {
      const target = ctx.workflowTarget?.get(ctx.tabId);
      const stateCmd = target
        ? withWorkflowTarget({ cmd: "graph_get_state" }, target)
        : { cmd: "graph_get_state" };
      stateReply = await ctx.bridge.send(stateCmd as { cmd: string }, {
        tabId: ctx.tabId,
        timeoutMs: 30000,
      });
    } catch (err) {
      // Never fatal: strip already HAS a usable graph. Losing the cross-check
      // degrades fidelity, and that degradation is what gets reported.
      stateReply = null;
      notes.push(
        `note: the live widget cross-check could not be read (${err instanceof Error ? err.message : String(err)}); ` +
          `an older panel may not support it. Widget values were mapped by position and MAY be attributed to the ` +
          `wrong widget on custom nodes — verify with panel_query_graph {fields:'detail'} if one looks off.`,
      );
    }
    if (stateReply) {
      notes.push(...applyCapturedWidgetValues(wf, stateReply).notes);
    }
  }
  return wf as Record<string, unknown>;
}

// ---- panel_ask surface + late-answer resilience (#300/#486) ----------------
// panel_ask renders an interactive choice card in the panel and BLOCKS on the
// user's pick. Two failure modes are handled here, localized to the ask path:
//
//  • #300 — NO INTERACTIVE SURFACE: when the only reachable client is canvas-less
//    (a mobile mirror / remote/headless viewer, or an exec/headless run), the card
//    can't render, so the ask would block for the whole deadline with no way to
//    answer. We DETECT that up front (bridge.isHeadless on the tab the ask would
//    target) and FAIL FAST with an actionable error telling the agent to ask in
//    plain text or call panel_ask from an interactive tab — never an indefinite
//    block.
//
//  • #486 — LATE-BUT-VALID ANSWER: the enclosing MCP `tools/call` has its own
//    budget (~300s). A card wait longer than that guarantees the tool is killed
//    before a slow user answers, DISCARDING a validated pick. We (a) CLAMP the card
//    deadline safely under the MCP budget, and (b) after a card-reply timeout, poll
//    the bridge's short-lived late-reply buffer for a bounded grace so an answer
//    that validated slightly after the deadline is HONORED, not lost.

interface AskTiming {
  /** bridge.send reply timeout for the ask card — clamped under the MCP budget. */
  deadlineMs: number;
  /** How long to keep polling the late-reply buffer after a card-reply timeout. */
  graceMs: number;
  /** Interval between late-reply buffer polls. */
  pollMs: number;
}

let askTimingOverride: AskTiming | null = null;

// The enclosing MCP `tools/call` is killed at ~300s. The card deadline PLUS the
// late-answer grace poll must finish UNDER that, or a slow-but-valid pick is lost
// to the framework before we can honor it (#486). This is the HARD ceiling on the
// total ask budget — applied even when env overrides ask for more, so a
// misconfigured COMFYUI_PANEL_ASK_DEADLINE_S/GRACE_S can never recreate #486.
const ASK_TOTAL_BUDGET_CAP_MS = 285_000;

/**
 * Headroom kept back from a SECRET card's grace so a recovered token can still be written,
 * read back and reported before the enclosing tools/call is killed (#1352, codex P1).
 *
 * The write is a small local file plus a read-back — milliseconds when nothing is in the
 * way. This is sized for when something IS: a locked store, antivirus inspecting the
 * write, a slow rewrite. Accepting a credential and then losing it to the framework
 * deadline is worse than declining it a few seconds earlier, because the user believes
 * they supplied it.
 */
const SECRET_PERSIST_RESERVE_MS = 10_000;

/**
 * The per-request timeout an INTERNAL MCP client must use when calling panel_*
 * tools (#325). Several panel tools are DESIGNED to block on a human well past
 * the MCP SDK's 60s default request timeout: panel_ask / the confirm / consent
 * cards wait up to ASK_TOTAL_BUDGET_CAP_MS (285s), and panel_request_secret
 * waits up to 300s on its masked input. A client that calls them with the SDK
 * default (the ollama-family backends' loopback panel client did) kills the
 * request at 60s with `MCP error -32001: Request timed out` — the user picks an
 * option minutes later, the server delivers it, and the model never sees it.
 * Sized above the LONGEST blocking card (the 300s secret card) with margin for
 * loopback transport + processing. Fast tools are unaffected: this is only an
 * upper bound, never a wait. */
export const PANEL_TOOL_MCP_TIMEOUT_MS = 315_000;

function getAskTiming(): AskTiming {
  if (askTimingOverride) return askTimingOverride;
  const pollMs = Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_ASK_POLL_S", 0.5) * 1000);
  // Defaults keep deadline + grace comfortably under the budget (240 + up to 45 =
  // 285s). Env overrides are HARD-clamped: the deadline is capped first (leaving at
  // least a 1s slice), then the grace gets only whatever budget remains, so
  // deadline + grace is guaranteed ≤ ASK_TOTAL_BUDGET_CAP_MS regardless of input.
  let deadlineMs = Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_ASK_DEADLINE_S", 240) * 1000);
  let graceMs = Math.round(parsePositiveNumberEnv("COMFYUI_PANEL_ASK_GRACE_S", 45) * 1000);
  deadlineMs = Math.min(deadlineMs, ASK_TOTAL_BUDGET_CAP_MS - 1000);
  graceMs = Math.min(graceMs, Math.max(0, ASK_TOTAL_BUDGET_CAP_MS - deadlineMs));
  return { deadlineMs, graceMs, pollMs };
}

/** True when an error is the bridge's reply-TIMEOUT for a card (the tab never
 *  replied within the window), NOT a genuine transport/command error. Only a
 *  timeout warrants polling the late-reply buffer for a slow-but-valid answer.
 *
 *  Anchored (`^…$`) on the bridge's CANONICAL no-reply message — the WHOLE message
 *  ui-bridge `dispatch()` emits: `Panel tab <id> did not reply to "<cmd>" within <N>
 *  ms — the ComfyUI tab may be backgrounded or frozen`. Whole-message anchoring is
 *  deliberate: a genuine transport error that merely WRAPS or embeds the phrase —
 *  e.g. `relay failed: Panel tab abcd did not reply to "ask_user" within 500 ms;
 *  reconnecting`, or `upstream service did not reply to us within 500 ms` — must NOT
 *  be mis-handled as a recoverable card-reply timeout. It mirrors the same canonical
 *  distinction the panel_open_workflow ack-timeout path draws. Crucial for the
 *  consent gate: a real transport failure must reach fail(), never be quietly
 *  reported as an unchanged-state success. */
function isReplyTimeoutError(err: unknown): boolean {
  // AUTHORITATIVE: the bridge tags every reply-timeout with a typed marker
  // (markReplyTimeout). Keying on it makes the recoverable-timeout decision robust to
  // ANY tab_id — including one containing spaces, which the text form below can't
  // segment (ui-bridge accepts an arbitrary-string tab_id).
  if (isReplyTimeoutTagged(err)) return true;
  // FALLBACK (test-injected plain errors / any untagged error): an EXACT whole-message
  // match of the bridge's canonical no-reply. Literal single space before "ms" (the
  // bridge always emits "within <N> ms"), no `.trim()`, `^` at true start (no /m flag)
  // and a HARD end-of-input `(?![\s\S])` — NOT `$`, which in JS also matches just
  // before a final "\n" and would let `canonical + "\n"` slip through. The tab-id
  // segment is `.+?` (lazy, bounded by the fixed ` did not reply to "` that follows —
  // an ≤8-char id slice can't contain that 19-char delimiter) so a spaced tab_id still
  // matches here too. So a prefixed/suffixed wrapper, whitespace/newline-wrapped text,
  // or noncanonical spacing ("within 500ms") does NOT match and is surfaced as a real
  // error. Case-sensitive: the message is a fixed literal template.
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /^Panel tab .+? did not reply to "[^"]*" within \d+ ms — the ComfyUI tab may be backgrounded or frozen(?![\s\S])/.test(
    msg,
  );
}

/**
 * Actionable error string when THIS session has no interactive surface able to
 * render an ask card (so the ask would block with no way to answer), or `null`
 * when a card can render. Uses the bridge's `isHeadless` on the tab the ask would
 * target (the current tab if reachable, else the resolved active tab). Defensive:
 * an unknown/lightweight bridge, or an ambiguous active-tab resolution, returns
 * null so the normal send path surfaces its own clear error instead.
 */
function askSurfaceError(ctx: PanelToolCtx): string | null {
  const b = ctx.bridge as unknown as {
    isHeadless?: (id: string) => boolean;
    canReach?: (id: string) => boolean;
    resolveActiveTabId?: () => string;
  };
  if (typeof b.isHeadless !== "function") return null; // lightweight/unknown bridge
  let targetId = ctx.tabId;
  if (typeof b.canReach === "function" && !b.canReach(targetId)) {
    if (typeof b.resolveActiveTabId !== "function") return null;
    try {
      targetId = b.resolveActiveTabId();
    } catch {
      return null; // no single active tab — let the send path report it clearly
    }
  }
  if (!b.isHeadless(targetId)) return null;
  return (
    "No interactive panel surface can render a choice card in this session — the " +
    "connected client is canvas-less (a mobile mirror, a remote/headless viewer, or " +
    "an exec/headless run), so panel_ask can't be answered here and would block. Ask " +
    "the user directly in plain chat text, or invoke panel_ask from an interactive " +
    "ComfyUI browser tab (not nested inside an exec/headless call)."
  );
}

/**
 * Route a canvas-requiring panel UI command (set_todo, open_civitai) onto the live
 * DESKTOP canvas tab when THIS session's bound tab is a headless (mobile/remote)
 * client (#624). The mobile / remote pseudo-panel accepts ONLY show_media and
 * rejects every other ServerCommand with the (client-authored) string "mobile
 * client has no open canvas" — a misleading, mobile-specific error even when a real
 * desktop ComfyUI canvas is open in the same session. These commands render on the
 * desktop panel surface (the footer TODO tray, the in-panel CivitAI browser), so
 * when the bound tab is canvas-less we resolve the SAME interactive desktop tab the
 * graph/workflow tools bind to instead of blasting the command at the headless
 * client. This is the desktop fall-through; genuine tab-mirror sessions are bound to
 * the desktop tab already (non-headless) and are therefore untouched.
 *
 * Returns:
 *  - `{ tabId }`  → REDIRECT the dispatch onto the interactive (canvas-owning)
 *    desktop tab (the sole one, else the last-active one when it is itself a canvas);
 *  - `{ error }`  → the ONLY connected client is canvas-less, so fail with the REAL
 *    reason (named honestly) rather than surfacing the raw mobile "no open canvas";
 *  - `null`       → the bound tab is already a reachable canvas, the choice among 2+
 *    desktop tabs is ambiguous, or the bridge can't enumerate headlessness — in every
 *    such case the normal `ctx.call` path (unchanged) runs.
 */
function desktopCanvasRedirect(
  ctx: PanelToolCtx,
  label: string,
): { tabId?: string; error?: string } | null {
  const b = ctx.bridge as unknown as {
    isHeadless?: (id: string) => boolean;
    tabs?: () => Array<{ tab_id: string }>;
    resolveActiveTabId?: () => string;
    resolveSharedTabId?: (scopeId?: string) => string | undefined;
  };
  // Older / lightweight bridges can't classify tabs — leave routing exactly as-is.
  if (typeof b.isHeadless !== "function" || typeof b.tabs !== "function") return null;
  // Only intervene when THIS session is bound to a canvas-less (mobile/remote) client.
  // A desktop-bound session — healthy, or merely orphaned by a reconnect — is left to
  // the normal ctx.call path and its reconnect/rebind machinery untouched.
  // #884 — a SHARED-SCOPE session is bound to whatever the scope resolves to right
  // now; when that is a canvas-less client (only a phone is connected), the same
  // redirect / honest canvas-less error applies instead of blasting the command
  // at the phone.
  const boundTab = isScopeAddress(ctx.tabId) ? b.resolveSharedTabId?.(ctx.tabId) : ctx.tabId;
  if (!boundTab || !b.isHeadless(boundTab)) return null;
  // Bound to a headless client: find the interactive (canvas-owning) DESKTOP tabs, the
  // SAME filter rebindToActiveTab/ensureReachable use for graph/workflow bindings.
  const live = b.tabs();
  const interactive = Array.isArray(live)
    ? live.filter((t) => !b.isHeadless!(t.tab_id))
    : [];
  if (interactive.length === 1) return { tabId: interactive[0].tab_id };
  if (interactive.length === 0) {
    return {
      error:
        `${label} needs an open ComfyUI desktop panel canvas to render, but this session ` +
        `is attached to a canvas-less client (a mobile/remote viewer or a headless run) ` +
        `and no desktop ComfyUI panel tab is connected. Open the ComfyUI browser tab with ` +
        `the comfyui-mcp-panel pack installed, then retry.`,
    };
  }
  // 2+ interactive desktop tabs: prefer the last-active one when it is itself a canvas.
  // The bound tab is headless, so we must NOT fall through to ctx.call here — that would
  // dispatch right back at the canvas-less client and reproduce "mobile client has no
  // open canvas". When we can't single out one canvas tab, fail with the REAL reason.
  if (typeof b.resolveActiveTabId === "function") {
    try {
      const active = b.resolveActiveTabId();
      if (active && !b.isHeadless(active)) return { tabId: active };
    } catch {
      /* ambiguous active-tab resolution — fall through to the ambiguity error below */
    }
  }
  return {
    error:
      `${label} needs an open ComfyUI desktop panel canvas, but this session is bound to ` +
      `a canvas-less (mobile/remote) client and multiple desktop tabs are open — it can't ` +
      `pick one automatically. Ask the user to send a message from the Agent panel in the ` +
      `ComfyUI tab they want (that — not focusing the tab — is what marks it active), ` +
      `rebind with panel_set_workflow_target({mode:"current"}), then retry.`,
  };
}

/** Dispatch a command to a SPECIFIC tab id (the #624 desktop-canvas redirect target)
 *  and wrap the reply in the SAME ok()/fail() envelope ctx.call uses. The redirect
 *  target came straight from a live `bridge.tabs()` enumeration, so it is already
 *  reachable — this is a thin send that does NOT mutate ctx.tabId (the session's own
 *  binding is left intact). For a retry-safe (idempotent full-replace) command it
 *  mirrors ctx.call's single post-drop retry: on a transient reconnect error it settles
 *  briefly, RE-RESOLVES the desktop tab (it may have reconnected under a new id), and
 *  re-sends once before surfacing the error. `reResolve` returns the fresh desktop tab
 *  id (or undefined to reuse `tabId`). */
async function dispatchToTab(
  ctx: PanelToolCtx,
  tabId: string,
  cmd: Record<string, unknown>,
  timeoutMs: number,
  reResolve?: () => string | undefined,
): Promise<ToolResult> {
  try {
    return ok(await ctx.bridge.send(cmd as { cmd: string }, { tabId, timeoutMs }));
  } catch (err) {
    if (isRetrySafeCmd(cmd) && isTransientReconnectError(err)) {
      try {
        await sleep(retrySettleMs());
        const fresh = reResolve?.() ?? tabId;
        return ok(await ctx.bridge.send(cmd as { cmd: string }, { tabId: fresh, timeoutMs }));
      } catch (err2) {
        return fail(err2);
      }
    }
    return fail(err);
  }
}

/** Re-resolve the desktop redirect target after a transient drop — returns the fresh
 *  interactive desktop tab id, or undefined when it can't be re-picked (so the caller
 *  falls back to the original id for its single retry). */
function reResolveDesktopTab(ctx: PanelToolCtx, label: string): string | undefined {
  const r = desktopCanvasRedirect(ctx, label);
  return r?.tabId;
}

/** Poll the bridge's late-reply buffer for a validated ask answer that arrived
 *  after the card-reply timeout, up to the grace budget. undefined if none.
 *
 *  `hardDeadline` is an ABSOLUTE wall-clock ceiling (a timestamp), so the total
 *  ask cannot creep past the enclosing MCP `tools/call` budget by accumulating
 *  the pre-send work, the send itself and then a fresh full grace on top: the
 *  grace only ever gets what is LEFT of the budget measured from the moment the
 *  handler started. Without it the observed worst case is deadline + grace +
 *  everything else, which is how an ask still ended in a raw transport timeout
 *  instead of a clean result. */
// ---- panel_run late-acknowledgement reconcile (#1175) ----------------------
//
// `panel_run({to_node_id:8})` returned OUTCOME UNKNOWN on the 20 000 ms reply
// bound; the panel acknowledged that same run 5.3 s later, having queued it. The
// caller was then sent to `queue (action:"list")`, which came back EMPTY — during
// the propagation window an accepted prompt is not visible there yet, so the one
// check the disclosure offers reads as "nothing was queued" for a run that was.
// Only the #694 retry token eventually recovered it, and that costs a whole extra
// agent round trip to learn something the orchestrator was already holding.
//
// THE BOUND IS NOT WHAT IS BEING FIXED, and it is worth saying why. `graph_run`
// is bounded at the shared 20 000 ms default, which was chosen for commands whose
// panel-side work is one synchronous canvas edit. A SCOPED run's is not: the panel
// serialises the prompt for its pre-flight, serialises it again for the scoped
// run's content hash, then makes up to four `app.queuePrompt` attempts (each of
// which serialises AGAIN and POSTs /prompt), and holds a 5 000 ms verification
// budget it can only enter AFTER queuePrompt returns — i.e. work that begins near
// the end of our window and runs past it. None of that is bounded from out here,
// so any literal we pick is a number that happens to fit the rigs we measured.
// Raising it would have made this reporter's run fit and the next one's not.
//
// So: keep the bound, and stop declaring the outcome unknown while the answer is
// still arriving. This is the deadline+grace shape `confirm()` already uses for a
// slow `ask_user` card, over the retention #694 already installs for exactly these
// commands. Nothing is re-dispatched, and a run that never acknowledges is
// reported exactly as it is today.

/** How long panel_run waits for a `graph_run` acknowledgement that missed its
 *  reply bound (#1175).
 *
 *  Derived from the panel's own post-queue budget rather than from the reporter's
 *  5.3 s: `dispatchScopedRun`'s verification wait is 5 000 ms and it is entered
 *  AFTER `app.queuePrompt` resolves, so the panel can legitimately still be
 *  working 5 s past our bound, plus the reply's own trip. 10 s covers that with
 *  headroom and stays far inside the ~300 s tools/call ceiling.
 *
 *  Paid ONLY on a path that has already spent its full bound and is otherwise
 *  about to hand the caller an unknown outcome — so the worst case is 10 s added
 *  to a call that already failed, in exchange for not re-rendering. */
export const RUN_LATE_ACK_GRACE_MS = 10_000;
/** Poll interval for the grace above. Matches pollLateAskReply's granularity. */
const RUN_LATE_ACK_POLL_MS = 200;
let runLateAckGraceMsOverride: number | null = null;
/** The grace actually applied. Test-overridable on the same terms as
 *  retrySettleMs: a suite proving the RECONCILE must not also pay for the real
 *  wall clock, and the duration is not what any of them assert. */
function runLateAckGraceMs(): number {
  return runLateAckGraceMsOverride ?? RUN_LATE_ACK_GRACE_MS;
}

/**
 * Wait, bounded, for the panel to acknowledge a `graph_run` we stopped waiting
 * for — and hand back the reply it would have produced on time (#1175).
 *
 * Returns null when there is nothing to reconcile, which is every case except a
 * retained `graph_run` success WITH its body. The negatives are deliberate:
 *
 *  - NOT a reply timeout ⇒ nothing to wait for. Gated on the bridge's own typed
 *    mark, never on message text: an acked panel error can quote our timeout
 *    sentence verbatim (#1468 round 2), and the difference between the two is
 *    whether the tab answered, which only the bridge knows.
 *  - NO retained body ⇒ leave the entry ALONE. The retry-token layer drains this
 *    same rid to tell the caller their earlier attempt landed; consuming it here
 *    to answer a question we then could not act on would delete the recovery the
 *    caller still had. Hence peek-then-take.
 *  - A DIFFERENT command's entry ⇒ leave it alone for the same reason. The rid is
 *    ours, so this should not happen; if it ever does, the safe reading of a
 *    surprise is not to spend someone else's notice on it.
 */
async function reconcileLateRunAck(
  ctx: PanelToolCtx,
  res: ToolResult,
  rid: string | undefined,
): Promise<{ result: unknown; lateByMs: number } | null> {
  if (!rid || !isReplyTimeoutResult(res)) return null;
  const bridge = ctx.bridge;
  if (typeof bridge?.peekLateMutation !== "function") return null;
  if (typeof bridge?.takeLateMutation !== "function") return null;
  const deadline = Date.now() + runLateAckGraceMs();
  for (;;) {
    const seen = bridge.peekLateMutation(rid);
    if (seen) {
      if (seen.cmd !== "graph_run" || !("result" in seen)) return null;
      // Only now is it certain this entry will be USED, so draining it costs the
      // caller nothing: they are about to be handed its contents.
      const taken = bridge.takeLateMutation(rid);
      if (!taken || !("result" in taken)) return null;
      return { result: taken.result, lateByMs: taken.lateByMs };
    }
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await sleep(Math.max(1, Math.min(RUN_LATE_ACK_POLL_MS, left)));
  }
}

/** The disclosure that rides on a run recovered by the grace above. Says what was
 *  observed and nothing more: the panel answered late, this is THAT answer, and
 *  no second dispatch was made. */
function lateRunAckNote(lateByMs: number): string {
  const secs = (lateByMs / 1000).toFixed(1);
  return (
    `\n\n[RECOVERED] This run's acknowledgement arrived ${secs}s AFTER its reply window closed, ` +
    `and the result above IS that acknowledgement — the panel's own reply, read verbatim, not a ` +
    `state inferred afterwards. Nothing was dispatched a second time, so nothing here is a ` +
    `duplicate render. You may see the earlier attempt described as outcome-unknown in a log; ` +
    `this is its outcome. (A queue listing taken in the moments after a run is accepted can still ` +
    `be empty, so an empty queue would not have settled this either way.)`
  );
}

async function pollLateAskReply(
  bridge: PanelToolCtx["bridge"],
  askId: string,
  timing: AskTiming,
  hardDeadline?: number,
): Promise<unknown | undefined> {
  const take = (bridge as unknown as { takeLateAskReply?: (id: string) => unknown })
    .takeLateAskReply;
  if (typeof take !== "function") return undefined;
  const deadline = Math.min(
    Date.now() + timing.graceMs,
    hardDeadline ?? Number.POSITIVE_INFINITY,
  );
  for (;;) {
    const late = take.call(bridge, askId);
    if (late !== undefined) return late;
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    await sleep(Math.max(1, Math.min(timing.pollMs, left)));
  }
}

/** The tool result for an answer the user gave to THIS EXACT question earlier,
 *  which no tool call was alive to receive (#486). Always says so, always quotes
 *  the question it belongs to, and always says how old it is — a recovered
 *  answer must never be readable as a fresh one, nor as an answer to anything
 *  else. */
function recoveredAskResult(entry: AskEntry): ToolResult {
  const ageS = Math.max(0, Math.round((Date.now() - entry.answeredAt) / 1000));
  return ok(
    (entry.replayHint
      ? `[NOTE] This answer has been handed to you before — it is being surfaced again because ` +
        `the earlier hand-off could not be confirmed. Do not act on it twice.\n\n`
      : ``) +
      `[RECOVERED ANSWER] The user already answered this EXACT question ${ageS}s ago, but that ` +
      `answer could not be handed back — the tool call that asked had already timed out, so ` +
      `it was journaled instead of being lost (#486).\n\n` +
      `QUESTION IT ANSWERS: ${entry.question ?? "(unrecorded)"}\n` +
      `THE USER'S ANSWER: ${entry.answer}\n\n` +
      `This is their answer to THAT question and to nothing else. It was given ${ageS}s ago, ` +
      `not just now — do not re-ask it, but if something relevant has changed since, confirm ` +
      `before acting on it.`,
  );
}

/**
 * The honest failure for an ask nobody answered — plus every validated answer
 * for this tab that could NOT be attributed to the question just asked.
 *
 * Those answers are quoted WITH their own question, never on their own: an
 * unattributed answer that is merely mentioned invites the agent to use it for
 * the question at hand, which is the misattribution this whole path exists to
 * prevent. Reporting them beats swallowing them — the user did answer something.
 */
export function askTimeoutResult(
  tabId: string,
  fingerprint: string,
  recovery: AskRecovery,
  /**
   * #1243 — did a reachability check actually run before the wait? When it did, the
   * "maybe nothing rendered the card" alternative has ALREADY been ruled out, and
   * offering it anyway sends the agent to re-invoke from "an interactive tab" it was
   * demonstrably already on. `ctx.ensureReachable` is optional-chained at the call
   * site, so this is threaded rather than assumed — an absent check means the
   * alternative is still live and is still named.
   */
  surfaceConfirmed: boolean,
): ToolResult {
  const waited = `${Math.round(ASK_TOTAL_BUDGET_CAP_MS / 1000)}s`;
  let text = surfaceConfirmed
    ? `The question card was delivered to the panel and went unanswered for ${waited}, ` +
      "so nothing was selected — this is a timeout, not a delivery failure. The user " +
      "may simply not have been at the screen. If you still need the decision, ask them " +
      "directly in plain chat text, or re-invoke panel_ask when they are present."
    : `The question card was not answered within ${waited} — either it went unanswered, ` +
      "or no interactive panel surface rendered it (e.g. an exec/headless run), and this " +
      "call could not establish which. If you still need the decision, ask the user " +
      "directly in plain chat text, or re-invoke panel_ask from an interactive ComfyUI tab.";
  // What is surfaced, and why each:
  //  • an answer that reached NO tool call — nobody has it, so it must be told;
  //  • an answer to THIS EXACT question that DID reach a tool call but could not
  //    be returned now (too old to present as a fresh decision, or its
  //    conversation was replaced). "It went into a ToolResult" is precisely the
  //    thing this file says is not proof of receipt (that IS #486), so it is
  //    reported rather than quietly forgotten — the agent is told the user
  //    answered this before and can decide whether to re-ask.
  // The fingerprint match is what makes the second bullet safe AND what makes it
  // reachable: revoking recoverability must not also revoke the disclosure, so
  // an entry that is no longer allowed to ANSWER keeps its fingerprint and is
  // still recognised here as being about the question at hand.
  // An answer that reached a caller and belongs to a DIFFERENT question is not
  // news and stays quiet.
  // `recovery.others` has ALREADY been gated by the journal to what this
  // conversation may see; this only narrows it further to what is NEWS.
  const orphans =
    recovery.status === "unattributed"
      ? recovery.others.filter((e) => !e.returned || e.fingerprint === fingerprint)
      : [];
  const withheld = recovery.status === "unattributed" ? recovery.withheld : 0;
  if (orphans.length > 0) {
    text +=
      `\n\nHOWEVER — the user DID validate ${orphans.length} answer(s) on this tab that could NOT be ` +
      `attributed to the question you just asked. They are reported here rather than discarded. ` +
      `Each answers ONLY its own question below; do NOT use any of them as the answer to the ` +
      `question you just asked:\n` +
      orphans
        .map(
          (e) =>
            `  • QUESTION: ${e.question ?? "(UNRECORDED — this answer cannot be tied to any question this session asked; its meaning is UNDETERMINED)"}\n` +
            `    ANSWER: ${e.answer}`,
        )
        .join("\n");
  }
  if (withheld > 0) {
    // Said, never shown. These belong to a different browser tab on this
    // recurring key, or to a conversation that has been replaced — rendering
    // their chosen option here would leak exactly what the boundary contains, so
    // the count is the disclosure and the text stays in the durable log.
    text +=
      `\n\nAlso: ${withheld} validated answer(s) on this tab belong to a DIFFERENT conversation ` +
      `or browser tab (a new chat, a rewind, a provider switch, or another tab holding this ` +
      `workflow). They are not shown here and are not yours to act on — if you need this ` +
      `decision, ask again.`;
  }
  return fail(text);
}

/** The tab's undisclosed eviction debt, appended to whatever is being reported.
 *  Every exit from the ask path runs through this — an eviction the journal
 *  promised to report must not go unsaid just because THIS ask happened to
 *  succeed. Reading it also SPENDS it (droppedFor is drained by the journal only
 *  when a push carries it), so it is said once. */
function withDroppedText(tabId: string, text: string): string {
  const dropped = AskAnswers.reportDropped(tabId);
  if (dropped <= 0) return text;
  return (
    `${text}\n\n⚠️ ${dropped} further validated answer(s) for this tab were dropped before they ` +
    `could be delivered — their content is UNDETERMINED and cannot be recovered. Ask the user ` +
    `again for anything you were waiting on.`
  );
}

/** Same, for a ToolResult that is already built (the success/recovery paths). */
function withDroppedAnswerWarning(tabId: string, res: ToolResult): ToolResult {
  const first = res.content[0];
  if (!first || first.type !== "text") return res;
  const text = withDroppedText(tabId, first.text);
  if (text === first.text) return res;
  return { ...res, content: [{ type: "text", text }, ...res.content.slice(1)] };
}

/**
 * Run a panel_ask: render the choice card and return the user's pick.
 *
 * Sent DIRECTLY over the bridge (like the confirm/consent cards) so a stable
 * `ask_id` keys both the bridge's late-reply buffer and the durable ask journal.
 *
 * #486, in three layers:
 *  1. CLAMP the card deadline under the MCP `tools/call` budget, and hold the
 *     whole handler (card wait + grace poll) to ONE absolute wall-clock ceiling
 *     anchored at entry, so the ask always resolves as a clean tool result
 *     rather than dying as a raw transport timeout.
 *  2. JOURNAL every validated answer at the moment it validates — including one
 *     that arrives with no caller left (via the bridge's late-answer sink). An
 *     answer that reaches a ToolResult is journaled too, because a ToolResult is
 *     a hand-off and not proof: the request may already have been abandoned.
 *  3. On a card timeout, RECOVER the answer the user already gave to THIS EXACT
 *     question — matched on the frozen question fingerprint, never on recency —
 *     and if there is none, REPORT any unattributed answers instead of letting
 *     them disappear.
 */
async function askUserWithGrace(
  ctx: PanelToolCtx,
  ask: { question: string; options: unknown; header?: unknown; multi_select?: unknown },
): Promise<ToolResult> {
  const timing = getAskTiming();
  // ONE ceiling for the whole handler, anchored before any work is done.
  const budgetEnd = Date.now() + ASK_TOTAL_BUDGET_CAP_MS;
  // PREFIXED so the bridge's late-answer sink can tell a panel_ask card from the
  // other `ask_user` cards (confirm / 18+ consent / secret) purely from the id —
  // see PANEL_ASK_ID_PREFIX. Ownership must not depend on any bounded store.
  const askId = `${PANEL_ASK_ID_PREFIX}${randomUUID()}`;
  // Self-heal FIRST: the tab this resolves to is the tab the card renders on, and
  // it is the journal key every later match is made against. It throws when no
  // tab is bindable at all — surfaced as the tool's error exactly as before,
  // without opening a ticket for a card that was never dispatched.
  try {
    ctx.ensureReachable?.();
  } catch (err) {
    return fail(err);
  }
  // #884 — the journal key is the REAL tab the card renders on (the bridge's
  // late-answer sink records answers under it), never the scope address.
  const tabId = journalTabFor(ctx);
  const fingerprint = askFingerprint(ask);
  // Open the ticket BEFORE dispatching: the answer can validate the instant the
  // card renders, and an answer that arrives with no ticket is unattributable.
  AskAnswers.openAsk(askId, { tabId, fingerprint, question: ask.question });
  const cmd = {
    cmd: "ask_user",
    ask_id: askId,
    question: ask.question,
    options: ask.options,
    header: ask.header,
    multi_select: ask.multi_select,
  };
  /** Journal an answer we are about to hand back. `markReturned` records that a
   *  ToolResult carried it — a hand-off, NOT proof it was received — so it is not
   *  ALSO pushed to the agent, while a re-ask can still recover it if the caller
   *  was already gone. */
  /**
   * THE ONE EXIT for anything this handler learned from the journal.
   *
   * Every outlet that can put journal state in front of a live turn goes through
   * here — the verbatim answer, the recovered answer, the timeout report, and the
   * eviction-debt footnote. That is deliberate and structural: the last three
   * defects on this path were each a NEW outlet (a rid-exempt hand-back, the
   * `others` list, the debt footnote) that reached a live turn without passing
   * the boundary check, and auditing outlets one at a time is what let each of
   * them ship. A single exit means a new outlet cannot be added without either
   * routing through this gate or deleting it.
   *
   * The gate is: an answer belonging to a REPLACED conversation never has its
   * CONTENT rendered, and a result that is not the live conversation's own never
   * carries that conversation's debt footnote.
   */
  const deliver = (
    outcome:
      | { kind: "answer"; entry: AskEntry; raw: unknown; ridCorrelated: boolean }
      | { kind: "recovered"; entry: AskEntry }
      | { kind: "timeout"; recovery: AskRecovery },
  ): ToolResult => {
    // RETIRED — the conversation that asked is gone. Say so WITHOUT the pick: the
    // replacement turn reading the old choice is the leak, and a label on it is
    // not a fence. The text itself stays in the journal and in the durable log,
    // for the disclosure paths that belong to the conversation it was given to.
    if (outcome.kind !== "timeout" && outcome.entry.retired === true) {
      return fail(
        `The user answered this question card, but the conversation that asked it has been ` +
          `replaced since (a new chat, a rewind, a provider switch, or a different browser tab ` +
          `taking over this workflow). Their choice is NOT shown here and is not yours to act ` +
          `on — it was given to a conversation that no longer exists. Ask again if you still ` +
          `need this decision.`,
      );
    }
    if (outcome.kind === "timeout") {
      // The debt footnote rides ONLY a result the LIVE conversation will receive.
      // `reportDropped` selects the current occupant's debt and attaches its
      // token to the turn running now, so putting it on a result that belongs to
      // a conversation replaced mid-ask would let the live turn's ack settle a
      // warning that conversation never saw — the debt path reaching a live turn
      // through a helper, which is how it slipped the gate before.
      // #1243 — derive this rather than hardcoding `true`. The reachability call above
      // is optional-chained (`ctx.ensureReachable?.()`), so on a ctx that does not
      // provide it NO check ran and the no-surface alternative is still live. Passing a
      // literal would have made the false branch unreachable in production — dead code
      // justified by a hypothetical, and a test exercising a path nothing takes.
      const surfaceConfirmed = typeof ctx.ensureReachable === "function";
      const body = askTimeoutResult(tabId, fingerprint, outcome.recovery, surfaceConfirmed);
      return AskAnswers.askBelongsToLiveConversation(askId)
        ? withDroppedAnswerWarning(tabId, body)
        : body;
    }
    if (outcome.kind === "recovered") {
      const body =
        outcome.entry.askId === askId
          ? ok(outcome.entry.answer)
          : recoveredAskResult(outcome.entry);
      AskAnswers.markSurfaced(outcome.entry.token);
      return withDroppedAnswerWarning(tabId, body);
    }
    // A LATE answer is claimed from a buffer keyed by `ask_id` ALONE, so if that
    // id ever stood for two cards the buffer cannot say which one this reply came
    // from — and returning it here would hand card B the answer the user gave to
    // card A. The rid-correlated path is exempt and deliberately so: a reply that
    // came back on THIS send's own request id is this card's reply by
    // construction, whatever the ask id has meant elsewhere.
    if (!outcome.ridCorrelated && outcome.entry.correlation.status !== "matched") {
      // NOT marked returned: nobody has been given this as an answer, so it stays
      // an orphan — pushed and disclosed — rather than quietly counting as
      // delivered. Its own content IS shown: it is not retired, so it belongs to
      // this conversation; only its QUESTION is undetermined.
      return fail(
        withDroppedText(
          tabId,
          `A validated answer came back for this question card, but its ask id no longer identifies ` +
            `a single card, so it CANNOT be attributed to the question you just asked — it may be the ` +
            `user's answer to a different card. It is NOT being returned as your answer.\n\n` +
            `WHAT THE USER PICKED (question UNDETERMINED): ${outcome.entry.answer}\n\n` +
            `Ask again if you still need this decision.`,
        ),
      );
    }
    AskAnswers.markReturned(outcome.entry.token);
    // Even a clean answer carries out any eviction debt this tab is still owed —
    // an answer the journal admits it dropped must not go unmentioned merely
    // because the NEXT ask happened to succeed.
    return withDroppedAnswerWarning(tabId, ok(outcome.raw));
  };

  const handBack = (reply: unknown, opts: { ridCorrelated: boolean }): ToolResult =>
    deliver({
      kind: "answer",
      entry: AskAnswers.record(askId, reply, { tabId }),
      raw: reply,
      ridCorrelated: opts.ridCorrelated,
    });
  try {
    const reply = await ctx.bridge.send(cmd as unknown as { cmd: string }, {
      tabId,
      timeoutMs: Math.max(1, Math.min(timing.deadlineMs, budgetEnd - Date.now())),
    });
    return handBack(reply, { ridCorrelated: true });
  } catch (err) {
    if (!isReplyTimeoutError(err)) return fail(err);
    const late = await pollLateAskReply(ctx.bridge, askId, timing, budgetEnd);
    if (late !== undefined) return handBack(late, { ridCorrelated: false });
    // Nothing came back on this card's own wire. An answer the user gave to this
    // EXACT question may still be journaled — from THIS card (the sink beat the
    // last poll) or from an earlier ask whose tool call died before it could
    // return one. Matched on the frozen fingerprint only.
    const recovery = AskAnswers.recover(tabId, fingerprint);
    return recovery.status === "recovered"
      ? deliver({ kind: "recovered", entry: recovery.entry })
      : deliver({ kind: "timeout", recovery });
  } finally {
    // This handler is gone. Anything already journaled for this ask that we did
    // NOT hand back is now provably orphaned — arm it for the durable push so
    // the agent is told even if panel_ask is never called again.
    AskAnswers.closeAsk(askId);
  }
}

export const __panelAskTestHooks = {
  /** Inject fast ask timing so tests don't wait the real deadline/grace. */
  setAskTiming(timing: AskTiming | null): void {
    askTimingOverride = timing;
  },
  /** The env-derived (hard-clamped) ask timing, for the budget-cap test. */
  getAskTiming,
  ASK_TOTAL_BUDGET_CAP_MS,
  askSurfaceError,
  isReplyTimeoutError,
  askFingerprint,
};

/** One shared tool definition: name, description, zod raw-shape schema, and a
 *  transport-agnostic handler that receives parsed args + the tab-bound context. */
export interface PanelToolDef {
  name: string;
  description: string;
  // A zod raw shape (object map of zod schemas), as accepted by BOTH the Anthropic
  // SDK `tool()` and the MCP SDK `registerTool({ inputSchema })`.
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: PanelToolCtx) => Promise<ToolResult>;
}

/**
 * #754 — an unrecognized argument key was silently DROPPED, not rejected. Measured:
 * a real call and one with an extra `utterly_bogus_param` key returned byte-identical
 * replies. Zod's default `z.object()` is "strip" mode: unknown keys vanish before the
 * handler ever sees them, so a caller with a misspelled or hallucinated field name gets
 * no signal that anything was wrong — the call just quietly does less than asked.
 *
 * `.strict()` turns that into a validation error the caller can see and correct,
 * which is the whole value for an LLM caller: a loud, specific failure ("Unrecognized
 * key: X") is something a model can read and fix on the next attempt; a silent no-op
 * is not distinguishable from "it worked but had no effect".
 *
 * BOTH transports' registration functions accept this directly in place of the raw
 * shape (verified against each SDK's actual runtime behavior, not assumed from the
 * TypeScript types — see the cast note at the Anthropic SDK call site):
 *   - `@modelcontextprotocol/sdk`'s `registerTool({ inputSchema })` types `inputSchema`
 *     as `AnySchema | ZodRawShapeCompat`, so a full ZodObject is accepted as-is by the
 *     TYPE, and at runtime `normalizeObjectSchema` detects an already-built schema
 *     (it carries `_def`/`_zod`) and passes it through unwrapped rather than
 *     re-wrapping it — so the `.strict()` marker survives into validation.
 *   - The Anthropic Agent SDK's `tool()` stores whatever is passed as `inputSchema`
 *     verbatim; a `.safeParse()` probe against the returned tool definition confirmed
 *     an unrecognized key is rejected with `Unrecognized key: "..."`.
 */
function strictPanelSchema(shape: z.ZodRawShape) {
  return z.object(shape).strict();
}

const PANEL_EDIT_NODE_FIELDS = ["pos", "size", "title", "preset", "color", "bgcolor", "shape", "collapsed", "pinned", "mode"] as const;
const NODE_COLOR_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Cross-field rules that a flat ZodRawShape cannot express. Keep these at the
 * MCP boundary as well as in the panel executor: malformed direct tool calls
 * must never become a no-op or an ambiguous graph edit. */
function validatePanelEditNodeArgs(args: Record<string, unknown>): string | null {
  const hasNodeId = args.node_id !== undefined;
  const hasNodeIds = args.node_ids !== undefined;
  if (hasNodeId === hasNodeIds) return "panel_edit_node requires exactly one of node_id or node_ids.";
  if (hasNodeIds && (!Array.isArray(args.node_ids) || args.node_ids.length === 0)) return "panel_edit_node node_ids must be a non-empty array.";
  if (!PANEL_EDIT_NODE_FIELDS.some((field) => args[field] !== undefined)) return "panel_edit_node requires at least one editable field.";
  if (args.preset !== undefined && (args.color !== undefined || args.bgcolor !== undefined)) {
    return "panel_edit_node preset cannot be combined with color or bgcolor.";
  }
  return null;
}

/**
 * #694 — `retry_of`: an EXPLICIT caller retry identity for MUTATING panel
 * commands. When a mutating call fails OUTCOME-UNKNOWN (a post-write reply
 * timeout or a mid-command disconnect), the error text names the dispatched
 * attempt's rid and tells the caller to re-issue identical args plus
 * retry_of:"<rid>"; the panel dedupes the retried mutation on that token so the
 * retry can never double-apply. The token is OPAQUE caller data to the bridge —
 * forwarded to the wire UNTOUCHED (contrast workflow_uuid, which is bridge-owned
 * and always overwritten). Optional everywhere; never required.
 */
/**
 * #845 — a node id the tools THEMSELVES printed must be accepted back.
 *
 * Every panel tool took `z.number().int()` for a node id, while the graph
 * readers return ids as STRINGS (`"id": "42"`). So the obvious move — copy an id
 * out of panel_query_graph, paste it into panel_select_nodes — failed on the
 * first attempt, every time, with a raw zod `expected number, received string`.
 * The reporter hit it doing exactly that.
 *
 * Nothing about `"42"` is ambiguous. Accept both spellings and normalize to the
 * number the wire has always carried, so the round trip closes.
 *
 * STRICT about what counts as a node id: an integer, a string that is exactly an
 * integer, or a subgraph-qualified id (`"120:104"`). `"42px"`, `"4.5"` and `""`
 * are still rejected.
 *
 * #1425 added the qualified shape — the "separate, deliberate change to the wire
 * contract" this comment used to defer. Unpacking a subgraph leaves genuine ROOT
 * nodes carrying those ids, the readers hand them out, and every write tool
 * refused them. Crucially the qualified form is NOT parsed to a number: see
 * node-id.ts, where truncating `"263:78"` to `263` would edit the wrong node.
 */
const nodeId = () =>
  z
    .union([
      z.number().int(),
      z.string().regex(NODE_ID_PATTERN, NODE_ID_MESSAGE),
    ])
    .transform(normalizeNodeId);

/**
 * #845 — which `panel_canvas` arguments the chosen action actually consumes.
 *
 * The tool accepted node_id/dx/dy/scale for every action and forwarded them all,
 * so an argument the action ignores vanished without a word. The reporter passed
 * `zoom: 0.55` alongside `center_on_node` and got `scale: 0.067` back — which
 * reads as "your zoom was applied and then overridden", when in truth it was
 * never applied at all. The panel's center_on_node case sets the offset and
 * touches the scale not at all.
 *
 * Naming what an action ignores is the whole fix. It is NOT an error — passing a
 * harmless extra argument should not fail a viewport move — but it must not be
 * silent either.
 */
const CANVAS_ACTION_ARGS: Record<string, string[]> = {
  fit: [], // computes its own framing from the graph bounds
  center_on_node: ["node_id"],
  pan: ["dx", "dy"],
  zoom: ["scale"],
};

/** Supplied-but-unused argument names for `action`, in a caller-facing spelling. */
export function ignoredCanvasArgs(
  action: string,
  supplied: { node_id?: unknown; dx?: unknown; dy?: unknown; scale?: unknown },
): string[] {
  const used = CANVAS_ACTION_ARGS[action];
  if (!used) return []; // unknown action — the enum rejects it; never guess here
  const label: Record<string, string> = { scale: "scale/zoom" };
  return (["node_id", "dx", "dy", "scale"] as const)
    .filter((k) => supplied[k] !== undefined && !used.includes(k))
    .map((k) => label[k] ?? k);
}

/** Append a disclosure line to a successful text result, leaving errors alone. */
function appendNote(res: ToolResult, note: string): ToolResult {
  const first = res.content[0];
  if (!first || first.type !== "text") return res;
  return {
    ...res,
    content: [{ ...first, text: `${first.text}\n\n${note}` }, ...res.content.slice(1)],
  };
}

const RETRY_OF_ARG = {
  retry_of: z
    .string()
    .optional()
    .describe(
      "Retry token (#694): pass the retry_of rid from a previous outcome-unknown failure of this identical call to retry that exact mutation; omit otherwise.",
    ),
} satisfies z.ZodRawShape;

/**
 * #694 — the MUTATING panel tools that accept retry_of, keyed to the bridge
 * command each dispatches. Covers every command the bridge fences to a workflow
 * (GRAPH_CMD_EFFECT "targeted" — see requiresWorkflowStampEnforcement) plus the
 * four workflow mutators (workflow_save / workflow_save_as / workflow_rename /
 * workflow_close). Navigation/creation (workflow_open / workflow_new) and the
 * tools whose descriptions declare them view/read-only (panel_find_nodes,
 * panel_canvas, panel_screenshot, panel_list_subgraphs) are excluded: a read must
 * never mint or carry a retry token — its retry could be answered from the ledger
 * with a STALE outcome (codex gate).
 *
 * Four UI-STATE commands are admitted on purpose (graph_select_nodes,
 * graph_enter/exit_subgraph, graph_copy_nodes): they change selection, subgraph
 * scope or clipboard idempotently, so a deduped retry is a no-op. THIS MAP — not
 * the workflow fence — is what decides whether a token is minted and whether a
 * caller-supplied one reaches the wire, so those four keep behaving exactly as
 * they did before #778 reclassified them as `inert` for the fence. The two
 * questions are related but not the same, and answering one with the other is
 * the defect #778 is about.
 *
 * EXPLICIT MAP, mirroring the RETRY_SAFE_CMDS / MUTATING_GRAPH_EDIT_CMDS
 * maintenance model — keep in sync when mutating tools are added. Exported for
 * the #694 surface-integrity test.
 */
export const RETRY_TOKEN_CMD_BY_TOOL: Readonly<Record<string, string>> = {
  panel_add_node: "graph_add_node",
  panel_edit_node: "graph_edit_node",
  panel_remove_node: "graph_remove_node",
  panel_clear: "graph_clear",
  panel_flatten_workflow: "graph_load",
  panel_load_workflow: "graph_load",
  panel_connect: "graph_connect",
  panel_disconnect: "graph_disconnect",
  panel_set_widget: "graph_set_widget",
  panel_remove_widget: "graph_remove_widget",
  panel_set_property: "graph_set_node_property",
  panel_move_node: "graph_move_node",
  panel_resize_node: "graph_resize_node",
  panel_auto_layout: "graph_auto_layout",
  panel_run: "graph_run",
  panel_save_workflow: "workflow_save", // workflow_save_as when `name` is given
  panel_rename_workflow: "workflow_rename",
  panel_close_workflow: "workflow_close",
  panel_select_nodes: "graph_select_nodes",
  panel_create_subgraph: "graph_create_subgraph",
  panel_subgraph_group: "graph_subgraph_group",
  panel_copy_nodes: "graph_copy_nodes",
  panel_paste_nodes: "graph_paste_nodes",
  panel_save_subgraph: "graph_save_subgraph",
  panel_add_subgraph: "graph_add_subgraph",
  panel_create_group: "graph_create_group",
  panel_move_group: "graph_move_group",
  panel_edit_group: "graph_edit_group",
  panel_remove_group: "graph_remove_group",
  panel_set_node_title: "graph_set_title",
  panel_set_node_collapsed: "graph_set_node_collapsed",
  panel_set_node_mode: "graph_set_node_mode",
  panel_set_node_color: "graph_set_node_color",
  panel_enter_subgraph: "graph_enter_subgraph",
  panel_exit_subgraph: "graph_exit_subgraph",
  panel_move_rail: "graph_move_rail",
  panel_promote_widget: "graph_promote_widget",
  panel_expose_subgraph_output: "graph_expose_subgraph_output",
  panel_expose_subgraph_input: "graph_expose_subgraph_input",
  panel_unpack_subgraph: "graph_unpack_subgraph",
  panel_update_node: "graph_update_node",
};

/** #694 — the bridge commands the retry map admits, for the mint gate: a
 *  dispatched timeout/drop only mints a retry token when the command is in
 *  this set (bridge classification alone would include read/view-only
 *  commands that sit outside BRIDGE_READONLY_CMDS). */
export const RETRY_TOKEN_CMDS: ReadonlySet<string> = new Set(
  Object.values(RETRY_TOKEN_CMD_BY_TOOL).concat(["workflow_save_as"]),
);

/** #694 — augment one MUTATING tool def: accept retry_of and attach it, UNTOUCHED,
 *  to every mutating command the handler dispatches (per-command gated so a read
 *  probe inside the same handler — e.g. panel_flatten_workflow's live-canvas
 *  graph_serialize — stays clean). `call` is overridden on a prototype-delegating
 *  wrapper (Object.create(ctx)) so LIVE properties — e.g. ctx.tabId rebinding —
 *  keep reading through to the real ctx; only `call` shadows. */
function withRetryToken(d: PanelToolDef): PanelToolDef {
  return {
    ...d,
    schema: { ...d.schema, ...RETRY_OF_ARG },
    handler: async (args: Record<string, unknown>, ctx: PanelToolCtx): Promise<ToolResult> => {
      const retryOf =
        typeof args.retry_of === "string" && args.retry_of !== "" ? args.retry_of : undefined;
      if (!retryOf) return d.handler(args, ctx);
      // #694 — the retried attempt may have ALREADY LANDED. The bridge keeps a
      // late completion when a mutation replies after its reply timeout, and
      // this is the one moment we know the caller cares about that exact rid:
      // they just named it. Drained here (once) and reported alongside the
      // retry's own outcome.
      //
      // Deliberately NOT a short-circuit. Skipping the dispatch would be wrong
      // whenever the token is stale or pasted onto different args -- the bridge
      // stores the rid, not a fingerprint of what it carried, so "the write for
      // this rid landed" does not prove "the write you are asking for now is
      // that same write". Suppressing a real mutation on that inference is the
      // #683 mistake with the arrow reversed, and #687 reverted it for cause.
      // Double-apply is already the #521 panel ledger's job; this only makes the
      // outcome VISIBLE, which is the half of #694 nothing else does.
      const wrapped = Object.create(ctx) as PanelToolCtx;
      wrapped.call = (
        cmd: Record<string, unknown>,
        timeoutMs?: number,
        onDispatchedRid?: (rid: string) => void,
      ) =>
        ctx.call(
          // Ask the RETRY MAP's question, not the workflow fence's (codex gate).
          // These were the same answer only while isMutatingGraphCommand
          // over-classified — the #778 defect. Once the fence got its own effect
          // ledger they diverged, and gating on the fence would have SILENTLY
          // DROPPED a caller-supplied retry_of for the four UI-state commands the
          // map admits on purpose: the schema accepts the token, the description
          // promises dedupe, and nothing would reach the wire. A caller who
          // believes their retry is deduped and is wrong is exactly the failure
          // the token exists to prevent.
          //
          // A read probe inside a mutating handler (panel_flatten_workflow's
          // graph_serialize) is still excluded — RETRY_TOKEN_CMDS contains no
          // reads, which is asserted in panel-retry-identity.test.ts.
          RETRY_TOKEN_CMDS.has(typeof cmd.cmd === "string" ? cmd.cmd : "")
            ? { ...cmd, retry_of: retryOf }
            : cmd,
          timeoutMs,
          onDispatchedRid,
        );
      const out = await d.handler(args, wrapped);
      // Drained AFTER the handler, deliberately, for two measured reasons.
      //
      // (1) The drain is destructive. Draining first meant a handler that threw
      //     consumed the notice permanently: the retry failed, no new token was
      //     minted, and a later successful retry reported nothing.
      // (2) It widens the window. A late reply that lands WHILE the retry is in
      //     flight is now caught; draining first stranded it in the map until
      //     TTL, which is the common case when an agent retries promptly.
      //
      // Matched on COMMAND, not rid alone. A token names an attempt, and the
      // sentence below claims "the attempt you are retrying" completed -- which
      // is only true if the retained completion is for the command this tool
      // actually dispatches. Without the check, pasting a stale token onto a
      // different tool prints a confident notice about an unrelated write.
      // …and not at all if the retry FAILED. `ctx.call` converts almost every
      // dispatch failure into an isError result rather than throwing, so gating
      // on a thrown exception alone still drained on a failed retry -- the same
      // permanent loss, one layer over. The caller gets no new token from a
      // failed retry, so a consumed notice here is unrecoverable.
      if (out.isError) return out;
      const expectedCmd = RETRY_TOKEN_CMD_BY_TOOL[d.name];
      const landed = ctx.bridge?.takeLateMutation?.(retryOf);
      if (!landed || (expectedCmd !== undefined && landed.cmd !== expectedCmd)) return out;
      const secs = (landed.lateByMs / 1000).toFixed(1);
      return {
        ...out,
        content: [
          {
            type: "text" as const,
            text:
              `NOTE — the attempt you are retrying DID complete. "${landed.cmd}" on tab ` +
              `${landed.tabId} was acknowledged by the panel ${secs}s after its reply ` +
              `timeout, so the earlier outcome-unknown warning has been resolved: it ` +
              `applied. Read the retry's own result below to see the final state (a ` +
              `panel that recognised the retry token will have answered it with the ` +
              `original outcome rather than applying anything a second time).`,
          },
          ...out.content,
        ],
      };
    },
  };
}

/**
 * The SINGLE source of truth for the panel_* tool surface. Both transports
 * register these exact definitions, so the Claude (in-process) and Codex (HTTP)
 * backends expose an identical panel toolset.
 */
export function buildPanelToolDefs(): PanelToolDef[] {
  // Local helper so each def reads like the original `tool(...)` call.
  const def = (
    name: string,
    description: string,
    schema: z.ZodRawShape,
    handler: (args: Record<string, unknown>, ctx: PanelToolCtx) => Promise<ToolResult>,
  ): PanelToolDef => ({ name, description, schema, handler });

  // Args are validated by zod before the handler runs (both transports parse with
  // the same shape), so handlers read fields off a loosely-typed bag.
  type A = Record<string, unknown>;

  const defs: PanelToolDef[] = [
    def(
      "panel_query_graph",
      "FILTER or TRAVERSE a SUBSET of the live canvas, for when you ALREADY KNOW what you're looking for. NOT for 'show me the canvas' or any whole-graph overview — call panel_graph_outline FIRST for that. NOT get_workflow's query action (that queries a saved file or JSON you provide, not the live canvas). Filters, traverses, projects and aggregates over the workflow the user is CURRENTLY VIEWING without dumping the whole graph (replaces the old panel_get_graph full-JSON dump; output is TOKEN-BOUNDED with an explicit truncation marker, so a big graph can never flood your context). Combine: `types` (node type contains any), `title` (contains), `where` widget predicates ANDed ('cfg>7', 'steps<=20', 'sampler_name=euler', 'text~sunset' — ops = != >= <= > < ~contains), `ids` (exact nodes — THE way to read ONE node's exact slot/widget detail: {ids:[42], fields:'detail'}), `upstream_of`/`downstream_of` + `depth` (dependency traversal: upstream = what FEEDS that node, downstream = what CONSUMES it; seed at depth 0), `fields` ('compact' one line per node [default], 'ids', 'detail' = the full node summary with slots + connections + mode), `group_by:'type'` (counts only), `limit` (default 40). detail rows include each node's MODE — a 'bypass' node is skipped and a 'mute' node kills everything downstream, so check modes on the path you care about before running (fix with panel_set_node_mode). Every result also carries `groups` (id, title, member node_ids — groups are geometric, trust this list) and, when viewing a SUBGRAPH (after panel_enter_subgraph), `rails` (boundary rail ids/slots). `max_chars` bounds the WHOLE result, those riders included, and the rows you asked for are spent first: on a big graph the riders lose their member ids, then drop out entirely, rather than starving your query — and each says in-band that it did, with the true counts. Typical flow: panel_graph_outline to orient → panel_query_graph to pinpoint/inspect → edit. Read-only.",
      {
        types: z.array(z.string()).optional().describe("Node type contains ANY of these (case-insensitive)."),
        title: z.string().optional().describe("Node title contains this."),
        where: z
          .array(z.string())
          .optional()
          .describe("Widget predicates, ANDed: 'cfg>7', 'sampler_name=euler', 'text~sunset'."),
        ids: z
          .array(z.union([z.string(), z.number()]))
          .optional()
          .describe("Exact node ids — with fields:'detail' this reads one node's full slot/widget detail."),
        upstream_of: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Scope to the dependency closure FEEDING this node id."),
        downstream_of: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Scope to the nodes CONSUMING this node id's outputs."),
        depth: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Max hops from the traversal seed (seed=0). Absent = full closure."),
        fields: z
          .enum(["ids", "compact", "detail"])
          .optional()
          .describe("Projection: compact one-liners (default), bare ids, or full node summaries."),
        group_by: z.enum(["type"]).optional().describe("Aggregate: counts per node type instead of listing."),
        limit: z.number().int().min(1).max(200).optional().describe("Max nodes listed (default 40)."),
        max_chars: z
          .number()
          .int()
          .min(QUERY_GRAPH_MAX_CHARS_FLOOR)
          .max(QUERY_GRAPH_MAX_CHARS_CEILING)
          .optional()
          .describe(
            `Character bound for the WHOLE result, not just its rows (default ${QUERY_GRAPH_MAX_CHARS_DEFAULT}, max ${QUERY_GRAPH_MAX_CHARS_CEILING}). Raise only for deliberate full reads, e.g. layout passes needing every node's geometry. ` +
              "The rows answering your query are spent FIRST and are never dropped to fit the contextual groups/rails riders; those are spent from what is left and say in-band when they were reduced or omitted (#807).",
          ),
      },
      // #807: the reply is fitted to `max_chars` as a WHOLE here — see fitQueryGraphReply.
      // The panel bounds `text`; the `groups`/`rails` riders were never in that
      // accounting, so on a large graph the reply could be many times the budget it
      // announced. Nothing is shed while the whole reply fits.
      async (args: A, ctx) =>
        fitQueryGraphReply(
          await ctx.call({
            cmd: "graph_query",
            types: args.types,
            title: args.title,
            where: args.where,
            ids: args.ids,
            upstream_of: args.upstream_of,
            downstream_of: args.downstream_of,
            depth: args.depth,
            fields: args.fields,
            group_by: args.group_by,
            limit: args.limit,
            max_chars: args.max_chars,
          }),
          args.max_chars,
        ),
    ),
    def(
      "panel_graph_outline",
      "READ THE LIVE CANVAS the user is looking at, as text. 'Show me what's on the canvas' / 'what's on the graph right now' / 'read the current workflow' / 'describe the open graph' -> THIS TOOL, with no arguments. NOT visualize_workflow (it DRAWS A DIAGRAM of a workflow you PASS IN — a saved file or JSON — and never sees the live canvas). NOT panel_query_graph (that FILTERS a SUBSET, for when you already know what you're looking for). Returns one `outline` string covering the WHOLE open graph, topologically sorted (sources first, sinks last): each node as `id Type \"title\" [bypass/mute] [OUTPUT] · group:X  widget=value …` with `← inputs` (source_node.output_name) and `→ outputs` (target_node.input_name), after a GROUPS index (title → member node ids). It gives you the WIRING you would otherwise reconstruct by hand — read it FIRST to get oriented, then panel_query_graph to inspect one node ({ids:[42], fields:'detail'}) or panel_find_nodes for free-text search. Over `max_chars` it never cuts the graph short: it sheds per-node detail, or refuses with a reason — never a partial outline. Read-only.",
      {
        max_chars: z
          .number()
          .int()
          .min(OUTLINE_MAX_CHARS_FLOOR)
          .max(OUTLINE_MAX_CHARS_CEILING)
          .optional()
          .describe(
            `Output character bound for the outline (default ${OUTLINE_MAX_CHARS_DEFAULT}, max ${OUTLINE_MAX_CHARS_CEILING}) — the SAME budget concept as panel_query_graph's max_chars. ` +
              `COVERAGE IS NEVER TRADED AWAY: over budget the outline sheds RESOLUTION, not nodes — first per-node widget values, then titles, and at the floor a per-group summary — so any outline it DOES return describes the whole graph, with real node/group counts. ` +
              `If even the group-level floor will not fit, it returns NO outline and says so (detail_level:"refused") rather than a partial one that would read as complete. ` +
              `detail_level names the rung used and degraded_reason says why. Panel builds older than this budget ignore it and return the full outline; the result carries a max_chars field when the budget was actually applied.`,
          ),
      },
      async (args: A, ctx) =>
        withTruncationHints(
          // The synthetic `__budget_ignored` flag below is derived from the reply, not
          // sent by the panel: a build that supports the budget echoes `max_chars` back.
          markBudgetIgnored(
            // #1203 — and ENFORCE it here when the panel could not, before the
            // unbounded outline reaches the caller who asked for a bound.
            enforceOutlineBudget(
              // #1184 — an empty outline is re-verified before it is believed.
              await confirmEmptyOutline(
                ctx,
                await ctx.call({ cmd: "graph_outline", max_chars: args.max_chars }),
                () => ctx.call({ cmd: "graph_outline", max_chars: args.max_chars }),
              ),
              args.max_chars,
            ),
            args.max_chars,
          ),
          [
            {
              // #809 (codex gate): a panel older than this budget IGNORES `max_chars` and
              // returns the full outline, so the bound this tool advertises silently did
              // not apply. A current panel echoes `max_chars` back; its absence is the
              // tell. Saying so is the whole point — the caller must not read an
              // unbounded reply as "this fitted".
              flag: "__budget_ignored",
              key: "max_chars_hint",
              text: (p) => {
                const asked =
                  typeof args.max_chars === "number" ? args.max_chars : OUTLINE_MAX_CHARS_DEFAULT;
                const nodes = typeof p.node_count === "number" ? p.node_count : "all";
                // #1203 — three different situations used to share one sentence
                // that described only the worst of them. Saying "the outline
                // below is the full, unbounded one" when it was withheld, or
                // when it fitted anyway, is its own false report.
                if (p.budget_applied_by === "orchestrator") {
                  const unbounded =
                    typeof p.unbounded_chars === "number" ? p.unbounded_chars : null;
                  return (
                    `This panel build does not support \`max_chars\`, so it returned the FULL outline for all ${nodes} node(s)` +
                    `${unbounded != null ? ` (${unbounded} chars)` : ""} against your bound of ${asked}. ` +
                    `NO outline is included: it is withheld rather than cut, because a truncated outline would read as a complete one. ` +
                    outlineBudgetRemedies(unbounded)
                  );
                }
                return (
                  `This panel build does not support \`max_chars\`, so the budget you set (${asked}) was not applied by the panel — ` +
                  `the outline below is its full, unbounded reply for all ${nodes} node(s), which happens to fit within your bound. ` +
                  `Update the ComfyUI Agent Panel to have the budget applied properly; on a larger graph an unbounded reply will not fit.`
                );
              },
            },
            {
              // On an older panel this is never set either, so the rider is inert there.
              flag: "degraded",
              key: "truncation_hint",
              text: (p) => {
                const inForce =
                  typeof args.max_chars === "number" ? args.max_chars : OUTLINE_MAX_CHARS_DEFAULT;
                // At the ceiling "raise max_chars" is a dead retry (codex gate).
                const more =
                  inForce >= OUTLINE_MAX_CHARS_CEILING
                    ? `\`max_chars\` is already at its ceiling of ${OUTLINE_MAX_CHARS_CEILING}, so this is the most one outline can carry — read specific nodes with panel_query_graph {ids:[…], fields:'detail'}.`
                    : `Raise \`max_chars\` (up to ${OUTLINE_MAX_CHARS_CEILING}) for more detail, or read specific nodes with panel_query_graph {ids:[…], fields:'detail'}.`;
                const nodes = typeof p.node_count === "number" ? p.node_count : "the";
                const groups = typeof p.group_count === "number" ? p.group_count : "all";
                // `degraded` covers TWO different outcomes and they say opposite things
                // (codex gate). "refused" means NO outline was produced at all — claiming
                // it "still covers ALL nodes" would describe content the reader cannot
                // see, which is the same lie as a silent cut.
                if (p.detail_level === "refused") {
                  // #1203 — an ORCHESTRATOR refusal is a different situation and
                  // needs different advice. The panel refuses because even its
                  // smallest whole-graph form did not fit, so the question is
                  // whether raising the bound can ever help. Here the panel never
                  // applied the bound at all: the full outline's size is known
                  // exactly, updating the panel unlocks the shed ladder, and the
                  // generic text's "this build does not report how large the
                  // smallest form would be" would send the reader chasing a
                  // capability the reply is already explaining is absent.
                  if (p.budget_applied_by === "orchestrator") {
                    const unbounded =
                      typeof p.unbounded_chars === "number" ? p.unbounded_chars : null;
                    return (
                      `NO outline was returned: this panel build ignores \`max_chars\`, so its reply${unbounded != null ? ` (${unbounded} chars)` : ""} exceeded \`max_chars\`=${inForce} and a PARTIAL outline is deliberately withheld because it would read as complete. ` +
                      `The graph has ${nodes} node(s) and ${groups} group(s). ` +
                      outlineBudgetRemedies(unbounded)
                    );
                  }
                  // And if the floor exceeds the CEILING, raising is a guaranteed second
                  // refusal — a dead retry inside the message explaining the first.
                  //
                  // A panel that refuses WITHOUT reporting `floor_chars` (the revision
                  // just before that field existed) leaves this unknowable, and treating
                  // unknown as reachable is what produced the dead retry (codex gate). So
                  // hedge: offer the raise as something to TRY, and name the fallback in
                  // the same breath, instead of asserting it will work.
                  const floor = typeof p.floor_chars === "number" ? p.floor_chars : null;
                  const next =
                    floor != null && floor > OUTLINE_MAX_CHARS_CEILING
                      ? `Its smallest whole-graph form needs ~${floor} chars, past \`max_chars\`'s ceiling of ${OUTLINE_MAX_CHARS_CEILING}, so raising it will NOT produce an outline for this graph — read it in parts with panel_query_graph.`
                      : floor != null || inForce >= OUTLINE_MAX_CHARS_CEILING
                        ? more
                        : `This panel build does not report how large the smallest form would be, so raising \`max_chars\` (up to ${OUTLINE_MAX_CHARS_CEILING}) MAY still refuse — if it does, the graph cannot be outlined in one call; read it in parts with panel_query_graph.`;
                  return (
                    `NO outline was returned: even the smallest whole-graph form did not fit \`max_chars\`=${inForce}, and a PARTIAL outline is deliberately withheld because it would read as complete. ` +
                    `The graph has ${nodes} node(s) and ${groups} group(s). ${next}`
                  );
                }
                return (
                  `The outline still covers ALL ${nodes} node(s) and ${groups} group(s), but at reduced detail (detail_level ${JSON.stringify(p.detail_level ?? "reduced")}) to fit \`max_chars\`=${inForce}. ` +
                  more
                );
              },
            },
          ],
        ),
    ),
    def(
      "panel_view_selected",
      "What the user has SELECTED on the canvas right now. Call this FIRST whenever they say \"this node\", \"the selected one\", \"the highlighted node\", \"where did I get this from\", or otherwise point at something without giving an id — the selection IS the answer, and reading it costs one call instead of scanning the graph. Returns the full detail summary (id, type, title, widgets, inputs with sources, outputs, mode) for each selected node, plus `selected_count` and any selected groups/reroutes. If `selected_count` is 0, nothing is selected — ask the user to click the node rather than guessing. NEVER dump the whole graph to work out which node they mean. Read-only.",
      {},
      async (_args, ctx) =>
        withTruncationHints(await ctx.call({ cmd: "graph_view_selected" }), [
          {
            flag: "truncated",
            key: "truncation_hint",
            text: (p) =>
              fixedCapHint(
                "selected node(s)",
                replyCount(p, "nodes"),
                p.selected_count,
                "Ask the user to select fewer nodes, or read the ones you need by id with panel_query_graph {ids:[…], fields:'detail'}, which DOES take limit and max_chars.",
              ),
          },
        ]),
    ),
    def(
      "panel_view_nodes_in_viewport",
      "ONLY the nodes inside the current VIEWPORT (pan+zoom) — a screen-region subset, NOT the whole open graph (that is panel_graph_outline, which is what 'show me what's on the canvas' means). Use this to SCOPE your work to what's on their screen: when they say \"these nodes\", \"the ones here\", \"what am I looking at right now\", or when a graph is large and you only need the region in front of them. Returns the viewport rect in graph coordinates (x, y, width, height, zoom), `node_count` (whole graph) vs `in_view_count`, and the detail summary of each visible node. A node counts as visible if any part of it overlaps the viewport. On a big canvas this is dramatically cheaper than reading everything. This tool does NOT filter to specific nodes — to read one node's exact slot/widget detail use panel_query_graph {ids:[…], fields:'detail'}. Read-only.",
      {
        // #845/#754 — the panel has enforced a CHARACTER budget here since the
        // 135k-character reply that motivated it, but the budget was unreachable:
        // this schema was `{}` and the call below passed no arguments, so the
        // default applied and no caller could raise or lower it. Its sibling
        // panel_query_graph has always exposed the lever. An enforced-but-hidden
        // knob is the worst of both — callers hit a cap they cannot see or move.
        //
        // The range described here is the PANEL's own clamp (viewport-char-bound.js),
        // not panel_graph_outline's 500–60000. Two different clamps already exist;
        // describing the one that is not enforced would make this text false, and a
        // schema that lies about its bounds is worse than one that omits them.
        max_chars: z
          .number()
          .int()
          .positive()
          // Declared so the #809 gate can check the ceiling this tool STATES
          // against the one it enforces. Only the ceiling: the floor stays
          // undeclared so a small value clamps up panel-side rather than being
          // refused — a caller asking for 1000 wants less, not an error.
          .max(200000)
          .optional()
          .describe(
            "Character budget for the whole reply (default 24000, clamped 2000–200000). Nodes are taken in view order until it is spent, never partially serialized. `in_view_count` keeps describing the SCREEN, so compare it to nodes.length to see what was withheld.",
          ),
      },
      async (args: A, ctx) =>
        withTruncationHints(
          await ctx.call({
            cmd: "graph_view_nodes_in_viewport",
            // Forwarded only when supplied: an explicit `undefined` on the wire
            // would reach the panel's normalizer as a nonsense value, and it
            // deliberately falls back to the default rather than to zero — but
            // sending it at all would misreport this caller as having asked.
            ...(args.max_chars === undefined ? {} : { max_chars: args.max_chars }),
          }),
          [
          {
            flag: "truncated",
            key: "truncation_hint",
            text: (p) =>
              fixedCapHint(
                "visible node(s)",
                replyCount(p, "nodes"),
                p.in_view_count,
                // #754 — this remedy used to send the caller to panel_query_graph
                // "which DOES take limit and max_chars", because this tool did not.
                // It does now, so the first move is the lever in your own hand.
                "Raise `max_chars` up to 200000 to see more of the same screen, or ask the user to zoom in so fewer nodes are on it. To read SPECIFIC nodes instead, panel_query_graph {ids:[…], fields:'detail'}; for the whole graph, panel_graph_outline.",
              ),
          },
        ]),
    ),
    def(
      "panel_audit_prompt_director",
      "Audit Prompt Director on the LIVE canvas without changing it. Correlates Prompt Director/Producer/Auto/Context/Reference/Critic widget values and wiring with detected model-loader filenames, every LoRA loader's actual model/CLIP strengths, and Prompt Director's latest sanitized runtime edit plan, resolved Model Explorer metadata, warnings, exact final prompt, and critic verdict. Returns observations plus proposed panel_set_widget changes with requires_confirmation=true. Call this when Prompt Director nodes are present, before saying the model/LoRA setup is correct, or when an edit prompt is ignored. READ-ONLY: present useful findings to the user and ask before applying any recommendation unless they already explicitly asked you to fix it.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_prompt_director_audit" }),
    ),
    def(
      "panel_get_subgraph",
      "Read INSIDE a subgraph node on the user's open graph: ids, types, widget values, and connections of its inner nodes. Use after panel_graph_outline / panel_query_graph shows a node with is_subgraph=true. Read-only.",
      { node_id: nodeId().describe("Subgraph node id (is_subgraph=true).") },
      async (args: A, ctx) =>
        withTruncationHints(await ctx.call({ cmd: "graph_get_subgraph", node_id: args.node_id }), [
          {
            flag: "truncated",
            key: "truncation_hint",
            text: (p) =>
              fixedCapHint(
                "inner node(s)",
                replyCount(p, "nodes"),
                p.node_count,
                // Honest about the follow-up's OWN ceiling (codex gate): panel_query_graph
                // clamps limit at 200 and has no cursor, so on a >200-node subgraph it is
                // a way to read MORE, not a way to read all.
                "panel_enter_subgraph into it, then panel_query_graph — which takes limit (max 200) and max_chars. It has no cursor, so beyond 200 inner nodes use its types/where filters to work through them.",
              ),
          },
        ]),
    ),
    def(
      "panel_find_nodes",
      "SEARCH the live canvas for nodes matching a term you supply — the right way to PINPOINT a node (a specific loader, sampler, save, switch) in a LARGE graph. Supply a free-text `query` and/or targeted filters; with nothing specific in mind, read the whole graph with panel_graph_outline instead. This searches the LIVE graph ON THE CANVAS — NOT the installable node registry (that's panel_search_nodes). It scans the graph in the canvas's own node order and STOPS once it has `limit` matches (default 40, max 200) — so a capped result is neither exhaustive nor a count of all matches: the result's count field is what was returned, total is the graph's node count, and truncated:true means the scan REACHED the cap — on current panels that proves more matches exist, on older panel builds it can also fire on an exactly-`limit` result that dropped nothing, so read it as 'may be incomplete'. Either way the result carries a truncation_hint naming the fix (raise `limit`, up to 200, or add a filter) — retry, do not conclude the node isn't there. Give a free-text `query` (matched case-insensitively across node type, title, description, widget NAMES, widget VALUES, and input/output port names+types — a node hits if ANY of those contain it) and/or targeted filters: type, title, input, output, widget (name), widget_value (contents), is_output, is_subgraph, mode. Targeted filters are ANDed together; the free `query` ORs across fields. Each match is the SAME rich summary as panel_query_graph's detail rows (id, type, title, widgets, inputs WITH their connected_from sources, outputs, mode, is_output, …) PLUS the node's description and a `matched_on` list saying WHY it matched. Read-only. Examples — the video loader: {query:'tiktok'} or {type:'LoadVideo'} or {input:'video'}; every output node: {is_output:true}; the node whose widget holds a file: {widget_value:'.png'}; a bypassed switch: {type:'Switch', mode:'bypass'}.",
      {
        query: z
          .string()
          .optional()
          .describe(
            "Free text matched (case-insensitive substring) across type, title, description, widget names, widget values, and port names/types. A node matches if ANY field contains it.",
          ),
        type: z
          .string()
          .optional()
          .describe("Node class_type contains this (e.g. 'KSampler', 'LoadImage')."),
        title: z.string().optional().describe("Node title contains this."),
        input: z
          .string()
          .optional()
          .describe("Has an INPUT port whose name or type contains this (e.g. 'image', 'LATENT')."),
        output: z
          .string()
          .optional()
          .describe("Has an OUTPUT port whose name or type contains this."),
        widget: z
          .string()
          .optional()
          .describe("Has a widget whose NAME contains this (e.g. 'seed', 'ckpt_name')."),
        widget_value: z
          .string()
          .optional()
          .describe("Has a widget whose VALUE contains this (e.g. a filename or prompt fragment)."),
        is_output: z
          .boolean()
          .optional()
          .describe("true = only output nodes (SaveImage/PreviewImage/…); false = exclude them."),
        is_subgraph: z.boolean().optional().describe("true = only subgraph nodes."),
        mode: z
          .enum(["active", "bypass", "mute"])
          .optional()
          .describe("Only nodes in this execution mode."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(FIND_NODES_LIMIT_CEILING)
          .optional()
          .describe(
            `Max matches to return (default ${FIND_NODES_DEFAULT_LIMIT}, max ${FIND_NODES_LIMIT_CEILING}). The scan STOPS once this many match, so a capped result is not a complete match set.`,
          ),
      },
      async (args: A, ctx) =>
        withTruncationHints(
          await ctx.call({
            cmd: "graph_find_nodes",
            query: args.query,
            type: args.type,
            title: args.title,
            input: args.input,
            output: args.output,
            widget: args.widget,
            widget_value: args.widget_value,
            is_output: args.is_output,
            is_subgraph: args.is_subgraph,
            mode: args.mode,
            limit: args.limit,
          }),
          [
            {
              flag: "truncated",
              key: "truncation_hint",
              // #809 (defect 2): the scan STOPS at the cap, so `count` is not a match
              // total and the absent matches are not "no more matches".
              //
              // The wording is deliberately "may be incomplete", not "there ARE more"
              // (codex gate): this orchestrator ships ahead of the panel, and a panel
              // build older than the matching panel PR sets `truncated` on an EXACT-cap
              // result that dropped nothing. Asserting more exist would manufacture the
              // very false alarm this issue is removing. A current panel supplies its own
              // precise hint and the rider defers to it.
              text: (p) => {
                const inForce =
                  typeof args.limit === "number" ? args.limit : FIND_NODES_DEFAULT_LIMIT;
                const raise =
                  inForce >= FIND_NODES_LIMIT_CEILING
                    ? `\`limit\` is already at its ceiling of ${FIND_NODES_LIMIT_CEILING}, so narrow with \`type\`/\`title\`/\`widget_value\` instead`
                    : `Raise \`limit\` up to ${FIND_NODES_LIMIT_CEILING}, or narrow with \`type\`/\`title\`/\`widget_value\``;
                return (
                  `The scan reached \`limit\`=${inForce} at ${replyCount(p, "matches") ?? "the cap"} match(es), so this result MAY be incomplete — ` +
                  `treat it as "not proof a node is absent" rather than as the full match set. ${raise}.`
                );
              },
            },
          ],
        ),
    ),
    def(
      "panel_add_node",
      "Add a node to the user's OPEN ComfyUI graph by class_type (e.g. 'KSampler', 'CheckpointLoaderSimple'). The user sees it appear live; Ctrl+Z undoes it. Returns the created node's id, slots, and default widget values. Frontend-only virtual types are addable too: 'Note' and 'MarkdownNote' — the supported way to ANNOTATE a workflow with on-canvas instructions (add the node, then put the text in its 'text' widget via panel_set_widget) — plus 'Reroute' and 'PrimitiveNode'. These are LiteGraph-native and never appear in the backend node registry, so they legitimately bypass the backend class_type check. ADD NODES ONE AT A TIME, not as a parallel batch: each add carries a fresh /object_info payload and those register SERIALLY, so N concurrent adds become N sequential refresh cycles. On a large install that outruns the 30s per-command deadline and the later adds time out WHILE STILL QUEUED — they then apply when their turn arrives, leaving nodes you were told had failed (panel#767). Sequential adds each get the refresh to themselves and stay well inside the deadline.",
      {
        class_type: z.string().describe("Exact ComfyUI node class_type to create."),
        pos: xy()
          .optional()
          .describe("Canvas [x, y] (two numbers). Auto-placed beside existing nodes when omitted."),
        title: z.string().optional().describe("Optional custom node title."),
      },
      async (args: A, ctx) => {
        // #599: the frontend gates the add on a FRESH /object_info (assertAddNode-
        // ResolvableRefreshing) so an uninstalled class can't be added as a
        // placeholder — that fetch can outlast the 6000 ms default on a large
        // install. Give it the bounded refresh ack budget.
        const add = (): Promise<ToolResult> =>
          ctx.call(
            { cmd: "graph_add_node", class_type: args.class_type, pos: args.pos, title: args.title },
            OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS,
          );
        const first = await add();
        if (!isStaleNodeSchemaRefusal(first)) return first;

        // #1329 — DO THE REFRESH THE REFUSAL ASKS FOR, instead of billing the caller.
        //
        // The reporter uploaded two images, and both LoadImage adds were refused with
        // "call panel_refresh_nodes and retry". Doing exactly that worked, both times.
        // That is a round trip and an agent-visible error for something with one
        // correct response and no decision in it.
        //
        // Safe to automate for a checkable reason, not a hopeful one: the panel's guard
        // throws BEFORE it creates anything ("Refuse before creating anything"), so the
        // retry cannot leave two nodes behind. Mutations are otherwise never re-issued
        // on our own initiative, and that rule is intact — this is not a transport
        // failure with an unknown outcome, it is a refusal that states its own.
        const refreshed = await ctx.call({ cmd: "refresh_nodes" }, OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS);
        if (refreshed.isError) {
          // The refusal is the better error: it names what is wrong with the SCHEMA and
          // what clears it. Carry the refresh failure alongside so the caller knows the
          // automatic attempt happened and why it did not help.
          return appendToolResultText(
            first,
            `\n\n(Tried to clear this automatically: panel_refresh_nodes was dispatched and FAILED, ` +
              `so the schema is unchanged and retrying the add will refuse again. ` +
              `${textOfToolResult(refreshed)})`,
          );
        }
        const second = await add();
        if (!isStaleNodeSchemaRefusal(second)) return second;
        // Still stale after a successful refresh: report THAT, because it means the
        // remedy the refusal prescribes does not fix this instance and a caller
        // following it by hand would loop.
        return appendToolResultText(
          second,
          `\n\n(This was already retried ONCE automatically: panel_refresh_nodes reported success ` +
            `and the add still refuses, so repeating panel_refresh_nodes will not clear it. ` +
            `Reload the ComfyUI browser tab, which rebuilds the page's node registry from scratch.)`,
        );
      },
    ),
    def(
      "panel_remove_node",
      "Remove a node (and its connections) from the user's open graph by id. Undoable with Ctrl+Z.",
      { node_id: nodeId().describe("Node id from panel_graph_outline / panel_query_graph.") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_remove_node", node_id: args.node_id }),
    ),
    def(
      "panel_clear",
      "Remove EVERY node from the user's open graph — only for an explicit 'clear/reset the canvas'. Just CALL THIS DIRECTLY when they ask to clear: the tool itself pops a confirm card and only wipes on a yes (don't ask separately first). The wipe is a single Ctrl+Z undo. NEVER use this for a 'new workflow' — that's panel_new_workflow (a new tab, leaves this graph intact).",
      {},
      async (_args, ctx) => {
        const decision = await ctx.confirm(
          "Clear the canvas? This removes every node from the open workflow. (One Ctrl+Z undoes it.)",
          "Clear canvas",
        );
        if (decision === "timeout") {
          return ok(
            "Timed out waiting for your confirmation, so I left the canvas as-is. " +
              "Tell me to clear it again when you're ready.",
          );
        }
        if (decision === "unreachable") {
          // #1332 — the canvas is still untouched, which is the part that matters, but
          // the user never saw the question. Saying "cancelled" would credit them with
          // a decision they were never offered.
          return ok(
            "The canvas was left as-is — but NOT because it was declined: the panel could " +
              "not be reached to ask, so the question never appeared. Nothing was cleared. " +
              "Check the panel tab is connected, then ask again.",
          );
        }
        if (decision !== "yes") {
          return ok("Cancelled — the canvas was left as-is.");
        }
        return ctx.call({ cmd: "graph_clear" });
      },
    ),
    def(
      "panel_strip_workflow",
      "Strip a workflow to a clean, flat, RESOLVED graph — Get/Set buses, Reroutes, subgraph " +
        "definitions, and bypassed/muted nodes all collapsed into real connections (the " +
        "'de-getter-setter' pass). With NO arguments it reads the LIVE CANVAS directly (no need to save " +
        "to a file first); or pass a `pack`, a server-side `path` (absolute or relative to the ComfyUI " +
        "workflows folder), or an inline `graph`. RETURNS the de-virtualized graph (API/prompt format) " +
        "plus a node-type summary for INSPECTION / EXECUTION / REBUILD — it does NOT and CANNOT load the " +
        "result back onto the canvas (the canvas only loads UI-format graphs). Use it to understand an " +
        "expert workflow's real wiring, run the resolved graph headless, or rebuild connections with the " +
        "graph edit tools. The resolved graph is much smaller than the raw UI JSON. The reply is TWO " +
        "blocks — the summary and any conversion notes first, then the graph alone as a whole JSON " +
        "document — and the same graph is returned as structuredContent.graph, so nothing has to be " +
        "sliced out of prose to parse it.",
      {
        pack: z
          .string()
          .optional()
          .describe("Bundled pack name (from list_packs) — its UI workflow.json is read server-side."),
        path: z
          .string()
          .optional()
          .describe(
            "Path to a workflow .json on the ComfyUI machine's disk — absolute, or relative to the ComfyUI workflows folder (user/default/workflows). Local ComfyUI only.",
          ),
        graph: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("Inline UI workflow (object or JSON string) to strip instead of a pack/path."),
      },
      async (args: A, ctx) => {
        // strip opts into the lossy live-canvas fallback (#384) — its API/prompt
        // output is for inspection/execution, never reloaded onto the canvas.
        // `captureNotes` collects the #959 widget-capture disclosures: they say
        // which nodes' widget values are UNVERIFIED, so they belong with the
        // conversion notes rather than being dropped.
        const captureNotes: string[] = [];
        const raw = await resolveWorkflowInput(args, ctx, true, captureNotes);
        const ui = raw as unknown as UiWorkflow;
        // #1359 — the graph came from the PANEL; the node definitions come from
        // COMFYUI_URL. Those are the same machine for a local session and different
        // ones for a connected REMOTE panel, and when they differ this fails with a
        // bare `ECONNREFUSED 127.0.0.1:8188` that never mentions the canvas host. The
        // reporter had to read dist/ to discover that the two halves have different
        // authorities.
        //
        // Only the live-canvas source is affected: a pack/path/inline graph is
        // deliberately tied to COMFYUI_URL, so its definitions belong there.
        const liveCanvasSource = args.pack == null && args.path == null && args.graph == null;
        let bulk: Awaited<ReturnType<typeof getObjectInfo>>;
        if (liveCanvasSource) {
          // THE DEFINITIONS NOW COME FROM THE SAME PLACE AS THE GRAPH (#1359).
          //
          // The panel has served its own /object_info since 0.13.0 (#1006) and nothing
          // here called it. Asking the browser is not a workaround for the remote case —
          // it is the only correct source for ANY case, because the tab that drew this
          // canvas is by definition able to reach the ComfyUI that defines its nodes. In a
          // tunnel or loopback-only topology the browser is the sole thing that can.
          //
          // FAIL CLOSED. If the panel cannot serve definitions we surface that; we do NOT
          // fall back to COMFYUI_URL. A fallback would convert the live canvas against a
          // DIFFERENT ComfyUI's schema and return a confident, wrong workflow — silently,
          // since the two hosts can both answer and disagree. That is strictly worse than
          // the ECONNREFUSED this issue was filed about, which at least failed loudly.
          const reply = await panelObjectInfo(ctx, collectNodeTypes(ui));
          if (!reply.ok) return fail(reply.message);
          bulk = reply.objectInfo;
        } else {
          try {
            bulk = await getObjectInfo();
          } catch (err) {
            // Returned as a tool ERROR rather than thrown: a throw here escapes the
            // handler and reaches the caller as a transport-shaped failure, which is how
            // the bare ECONNREFUSED got to the reporter in the first place.
            return fail(objectInfoHostMismatchMessage(err));
          }
        }
        // THE FAIL-CLOSED GUARANTEE LEAKED ONE LINE LATER, so this branches too.
        //
        // `backfillObjectInfo` fetches each type it is missing from
        // `${getComfyUIBaseUrl()}/object_info/<Type>` — COMFYUI_URL, the exact authority
        // the live-canvas path just refused to consult. Refusing the bulk fetch and then
        // backfilling from that host would merge a DIFFERENT ComfyUI's definitions into
        // the panel's map, silently, which is the outcome the branch above exists to
        // prevent. It fails soft (each miss is swallowed), so on an unreachable
        // COMFYUI_URL it degrades to "type absent" — but when that host IS reachable and
        // is a different server, the schema is quietly wrong.
        //
        // For a panel-sourced map a miss is not something to repair from elsewhere: the
        // panel returned that ComfyUI's WHOLE /object_info, so a type absent from it is
        // absent from the server that will run the workflow. convertUiToApi already
        // reports unknown types as warnings, which is the honest outcome.
        const objectInfo = liveCanvasSource
          ? bulk
          : await backfillObjectInfo(bulk, collectNodeTypes(ui));
        const converted = convertUiToApi(ui, objectInfo);
        const workflow = converted.workflow;
        const warnings = [...captureNotes, ...converted.warnings];

        const hist: Record<string, number> = {};
        for (const node of Object.values(workflow)) {
          const t = (node as { class_type?: string }).class_type ?? "?";
          hist[t] = (hist[t] ?? 0) + 1;
        }
        const summary = Object.entries(hist)
          .sort((a, b) => b[1] - a[1])
          .map(([t, c]) => `${c}× ${t}`)
          .join(", ");

        // #1589 — THE GRAPH IS NOW ITS OWN CONTENT BLOCK, and its own
        // `structuredContent.graph`.
        //
        // It used to be string-concatenated onto the end of the summary, so the
        // single text block began "Stripped to N nodes" and `JSON.parse` of it
        // failed on the first character. Every programmatic caller had to find the
        // first `{` and slice — a heuristic that is wrong the moment a conversion
        // note quotes a brace, which the warning lines can and do (they name
        // widget values).
        //
        // The PROSE ORDER IS UNCHANGED on purpose. #361 put the conversion notes
        // ahead of the graph so a model reads "this differs from the source"
        // before the thing it differs from; moving the JSON first to make
        // `content[0]` parse would have traded a script's convenience for the
        // reader's warning. Splitting instead keeps both: block 0 is the same
        // sentence it always was, block 1 is a whole JSON document with nothing
        // before or after it, and `structuredContent` is the parsed form for
        // callers that read it.
        const proseSummary =
          `Stripped to ${Object.keys(workflow).length} nodes` +
          (warnings.length ? ` · ⚠ ${warnings.length} conversion note(s)` : "") +
          `\nNode types: ${summary}` +
          // #361: a strip that quietly loses a Set/Get link or substitutes a
          // widget value produces a graph that LOOKS fine and renders
          // differently. Say plainly that these are places the stripped graph
          // does NOT match the source, so they are not skimmed as noise.
          (warnings.length
            ? `\nThe stripped graph DIFFERS from the source workflow where listed below — read these before running or rebuilding from it:\n${warnings
                .map((w) => `- ${w}`)
                .join("\n")}`
            : "");
        // Annotated, not inferred. `def()`'s handler type is enough for TS to accept
        // this object but NOT to reject a key ToolResult does not declare — excess-
        // property checking does not survive the inferred return type (measured: with
        // `structuredContent` deleted from ToolResult, `tsc --noEmit` still exited 0).
        // A typed local restores it, so the field is a contract the compiler enforces
        // rather than a comment.
        const reply: ToolResult = {
          content: [
            { type: "text", text: proseSummary },
            { type: "text", text: JSON.stringify(workflow, null, 2) },
          ],
          structuredContent: {
            graph: workflow,
            node_count: Object.keys(workflow).length,
            node_types: hist,
            warnings,
          },
        };
        return reply;
      },
    ),
    def(
      "panel_flatten_workflow",
      "Flatten the user's workflow IN PLACE, preserving their layout: every Get/Set bus, Reroute, and " +
        "cg-use-everywhere (UE) broadcast is resolved into a direct real link, and the virtual nodes are " +
        "deleted — kept nodes never move, so groups/positions/colors/titles survive exactly (unlike " +
        "panel_strip_workflow, whose API-format output can't go back on the canvas). With no source it " +
        "flattens the LIVE CANVAS and reloads the result onto it (one undo restores); pass a `pack`, " +
        "server-side `path`, or inline `graph` to flatten that instead (still loads onto the canvas " +
        "unless `apply:false`). UE broadcasts materialize from the pack's own computed extra.ue_links; " +
        "if senders exist without it, they're left in place with a warning (save/queue once, retry). " +
        "Real executable nodes (rgthree Context/Context Switch, Seed Everywhere) are KEPT — they run.",
      {
        pack: z.string().optional().describe("Bundled pack name — its UI workflow.json is read server-side."),
        path: z
          .string()
          .optional()
          .describe("Workflow .json on the ComfyUI machine's disk — absolute or relative to user/default/workflows."),
        graph: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("Inline UI workflow (object or JSON string) to flatten instead of the live canvas."),
        include_ue: z.boolean().optional().describe("Materialize Use-Everywhere broadcasts (default true)."),
        include_getset: z.boolean().optional().describe("Resolve Get/Set buses + Reroutes (default true)."),
        apply: z
          .boolean()
          .optional()
          .describe("Load the flattened graph onto the canvas (default true). false = return the graph JSON only."),
        summary_only: z
          .boolean()
          .optional()
          .describe(
            "With apply:false, return ONLY the flatten report (what was removed/rewired, plus the size of the result) and omit the graph JSON. Use this when you want to know WHAT flattening did rather than to consume the graph — a flattened workflow's JSON is often tens of thousands of tokens. Ignored when the graph is being applied to the canvas.",
          ),
      },
      async (args: A, ctx) => {
        const raw = await resolveWorkflowInput(args, ctx);
        const { graph, report } = flattenUiWorkflow(raw as never, {
          includeUe: args.include_ue !== false,
          includeGetSet: args.include_getset !== false,
        });
        const summary =
          `Flattened: removed ${report.removed.getset} Get/Set, ${report.removed.reroute} Reroute, ` +
          `${report.removed.ue} UE sender(s); added ${report.added_links} direct link(s) ` +
          `(${report.rewired_inputs} inputs rewired); ${report.kept_nodes} nodes kept in place.` +
          (report.warnings.length
            ? `\nWarnings:\n${report.warnings.map((w) => `- ${w}`).join("\n")}`
            : "");
        if (args.apply === false) {
          // panel#690(5) — `apply:false` returned the entire flattened graph JSON with
          // no way to ask for less, so a caller who only wanted to know WHAT flattening
          // did paid tens of thousands of tokens to find out.
          //
          // The graph is NOT clipped when it is returned. A truncated JSON document is
          // not a smaller answer, it is an invalid one — it cannot be parsed, loaded or
          // diffed, so clipping would turn a large correct result into a small useless
          // one. The choice is therefore whole-or-not-at-all, and `summary_only` is how
          // the caller makes it.
          const json = JSON.stringify(graph);
          if (args.summary_only) {
            const nodes = Array.isArray((graph as { nodes?: unknown[] }).nodes)
              ? (graph as { nodes: unknown[] }).nodes.length
              : 0;
            const links = Array.isArray((graph as { links?: unknown[] }).links)
              ? (graph as { links: unknown[] }).links.length
              : 0;
            // State the size that was withheld, so "summary only" never reads as "that
            // is all there was" — the same rule the bounded reads follow.
            return ok(
              `${summary}\n\nGraph JSON omitted (summary_only): ${nodes} node(s), ${links} link(s), ` +
                `~${Math.round(json.length / 1024)} KB. Re-run without summary_only to get it, ` +
                `or with apply:true to load it onto the canvas.`,
            );
          }
          return ok(`${summary}\n\n${json}`);
        }
        const loaded = await ctx.call({ cmd: "graph_load", graph: graph as never }, 30000);
        // ctx.call returns an error ToolResult for an outcome-unknown graph_load
        // (rather than throwing). Preserve it verbatim: wrapping it as a successful
        // "Loaded" result would fabricate success and hide its retry_of token.
        if (loaded.isError) return loaded;
        const loadText = (loaded as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
        return ok(`${summary}\nLoaded onto the canvas (one undo restores the original). ${loadText.slice(0, 120)}`);
      },
    ),
    def(
      "panel_slice_workflow",
      "Slice ONE pipeline out of a toggle-template workflow (built with rgthree 'Fast Groups " +
        "Bypasser/Muter' — one graph holding many pipelines, only one active at a time). Seeds from the " +
        "output nodes in the named `groups`, takes their backward closure (real links + virtual Set/Get " +
        "buses), un-bypasses the kept nodes and their subgraph internals, and RETURNS a standalone, " +
        "activated UI graph (only the subgraph defs it uses). With NO source argument it reads the LIVE " +
        "CANVAS directly; or pass a `pack`, server-side `path`, or inline `graph`. Pair with " +
        "panel_strip_workflow to then flatten the Set/Get buses. This returns " +
        "the sliced graph for inspection — it does NOT load it onto the canvas (feed the result to " +
        "panel_load_workflow if you want that; unlike the strip tool's API-format output, the slice IS a " +
        "loadable UI graph).",
      {
        pack: z.string().optional().describe("Bundled pack name (its UI workflow.json is read server-side)."),
        path: z
          .string()
          .optional()
          .describe("Path to a workflow .json on the ComfyUI machine's disk — absolute or relative to user/default/workflows."),
        graph: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("Inline UI workflow (object or JSON string) to slice instead of a pack/path."),
        groups: z
          .union([z.string(), z.array(z.string())])
          .describe(
            "Group-title substrings (case-insensitive) whose output nodes seed the slice — CSV string or array, e.g. 'TEXT TO IMAGE' or ['extend','sampler'].",
          ),
      },
      async (args: A, ctx) => {
        const raw = await resolveWorkflowInput(args, ctx);
        const groupList = Array.isArray(args.groups)
          ? (args.groups as string[])
          : String(args.groups ?? "").split(",");
        const { workflow, stats } = sliceWorkflow(raw as unknown as UiWorkflow, groupList);

        const flags =
          stats.badLinks || stats.orphanGets
            ? ` · ⚠ bad_links=${stats.badLinks} orphan_gets=${stats.orphanGets}`
            : "";
        return ok(
          `Sliced ${stats.nodes} nodes (un-bypassed ${stats.unbypassed}), ${stats.links} links, ` +
            `${stats.subgraphs} subgraph def(s) · seeds=${stats.seeds}${flags}` +
            `\n\n${JSON.stringify(workflow, null, 2)}`,
        );
      },
    ),
    def(
      "panel_load_workflow",
      "Load a full ComfyUI workflow onto the live canvas in one shot (replaces the current graph). Three ways to specify it: `pack:<name>` for a bundled installer pack's local-GPU workflow; `path:<file>` to read an arbitrary workflow .json off DISK server-side (absolute, or relative to the ComfyUI workflows folder) — use this to open a staged/downloaded example without shuttling its JSON through chat; or an inline `graph` object/JSON string. `pack` and `path` are read SERVER-SIDE so a large graph never enters your context. The replaced graph is captured as an undo point (double-Esc / revert). Pack workflows are LOCAL/free; for a `path`/`graph` that may use API nodes, check the runtime first (list_packs action:\"check_runtime\") and ASK the user before spending paid api credits.",
      {
        pack: z
          .string()
          .optional()
          .describe("Bundled pack name (from list_packs, e.g. 'krea2-txt2img-manual'). Its UI workflow.json is read server-side and loaded onto the canvas. These are local-GPU/free."),
        path: z
          .string()
          .optional()
          .describe("Path to a workflow .json — an ABSOLUTE path on the ComfyUI machine's disk, or a name from get_workflow (action:\"list\"), which is looked up in the connected ComfyUI's own saved-workflow library (so a custom --user-directory resolves correctly). Read + parsed server-side and loaded onto the canvas (keeps a large JSON out of chat). A name the library does not have is REFUSED rather than guessed at from a local path."),
        graph: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("A UI workflow graph (object or JSON string) to load instead of a pack/path. Must be UI/litegraph format (a `nodes` array), NOT API/prompt format."),
      },
      async (args: A, ctx) => {
        try {
          let data: unknown;
          if (args.pack) {
            // Read the (large) pack graph SERVER-SIDE so it never enters the agent's context.
            data = readPackWorkflow(args.pack as string);
          } else if (args.path) {
            // Read an arbitrary workflow JSON server-side — a local disk path, or
            // (for a relative name under a custom --user-directory) the connected
            // ComfyUI's userdata API — keeping the big JSON out of chat (#202).
            data = await readWorkflowFromPath(args.path as string);
          } else if (args.graph != null) {
            data = typeof args.graph === "string" ? JSON.parse(args.graph as string) : args.graph;
          } else {
            throw new Error("Provide one of `pack` (a bundled pack name), `path` (a workflow .json on disk), or `graph` (a UI workflow).");
          }
          // Generous timeout — loading a large graph onto the live canvas can take a moment.
          const loaded = await ctx.call({ cmd: "graph_load", graph: data }, 30000);
          if (loaded.isError) return loaded;
          // Keyed on the reply SAYING the graph was replaced, not merely on the call not
          // erroring (codex r2). A non-error envelope that reports `loaded:false` did not
          // replace anything, and telling that caller their fence is stale would be a
          // fabricated consequence of a load that never happened — the same
          // unmeasured-claim defect this note exists to remove.
          // ONLY THE API-FORMAT LOAD MINTS A NEW INSTANCE (codex r3, checked in the panel).
          // The UI-format path passes `__cmcpKeepInstance: true` whenever a workflow is
          // active, deliberately PRESERVING the instance so the agent's own follow-up
          // commands are not rejected — so a note claiming the fence went stale would be
          // false for the commonest load. The API path (`app.loadApiJson`) passes no such
          // option and does re-mint, and it is the path the reporter hit: their reply reads
          // `format:"api"`. That field is present only on this branch, which makes it the
          // signal rather than an inference.
          const reply = parseToolResultJson(loaded);
          const remintedInstance = reply?.loaded === true && reply?.format === "api";
          if (!remintedInstance) return loaded;
          // #1478 — ADOPT the instance this load just proved, rather than warning about it.
          //
          // The note below is the right answer only while we cannot know the new uuid. Panel
          // 0.14.39+ publishes `workflow_uuid` on this very reply
          // (comfyui-mcp-panel#1225), which is the same race-proof shape
          // `refreshFenceFromOwnReply` already trusts for workflow_save / workflow_save_as /
          // workflow_new (#1161): read from the command's OWN reply, never re-derived from
          // whatever is active now — a re-derivation rejected as a P1 here more than once,
          // because the active workflow can move during the await.
          //
          // It validates before adopting (canonical uuid or nothing), so a malformed or
          // absent field leaves the fence alone and falls through to the warning. That
          // matters: anyone on a panel below 0.14.39 still has the original bug, and
          // withdrawing the note for them would make it silent.
          const refreshed = refreshFenceFromOwnReply(ctx, loaded);
          return refreshed ? loaded : appendNote(loaded, noteStaleFenceAfterLoad());
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_connect",
      "Connect an output slot of one node to an input slot of another in the user's open graph. Slots accept a name ('MODEL', 'samples') or numeric index. If both slot args are omitted the panel picks the first type-compatible pairing. On failure the error lists every slot with its type and [connected] flag — re-check with panel_query_graph ({ids:[node_id], fields:'detail'}). Undoable.",
      {
        from_node_id: nodeId().describe("Source node id."),
        from_output: slotRef
          .optional()
          .describe("Source output slot name or index; omit to auto-match by type (prefers an unconnected, exact-type input; `*` wildcards match last)."),
        to_node_id: nodeId().describe("Target node id."),
        to_input: slotRef
          .optional()
          .describe("Target input slot name or index; omit to auto-match by type (prefers an unconnected, exact-type input; `*` wildcards match last)."),
        auto_match: z
          .boolean()
          .optional()
          .describe("Default true. Set false to force legacy exact resolution (omitted slot = index 0)."),
        // ALIASES small models actually emit (live panel finding): zod silently
        // STRIPPED from_slot_name/to_slot_name, both slots fell to "auto", and
        // auto-match wired something the model never asked for — reported as
        // success, scrambling the graph. Accept the aliases so intent survives.
        from_slot_name: slotRef.optional().describe("Alias for from_output."),
        to_slot_name: slotRef.optional().describe("Alias for to_input."),
        from_slot: slotRef.optional().describe("Alias for from_output."),
        to_slot: slotRef.optional().describe("Alias for to_input."),
        output: slotRef.optional().describe("Alias for from_output."),
        input: slotRef.optional().describe("Alias for to_input."),
      },
      async (args: A, ctx) =>
        ctx.call({
          cmd: "graph_connect",
          from_node_id: args.from_node_id,
          from_output: args.from_output ?? args.from_slot_name ?? args.from_slot ?? args.output,
          to_node_id: args.to_node_id,
          to_input: args.to_input ?? args.to_slot_name ?? args.to_slot ?? args.input,
          auto_match: args.auto_match,
        }),
    ),
    def(
      "panel_disconnect",
      "Disconnect an input slot of a node in the user's open graph. Undoable with Ctrl+Z.",
      {
        node_id: nodeId().describe("Node id whose input to disconnect."),
        input: slotRef.optional().describe("Input slot name or index (default 0)."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_disconnect", node_id: args.node_id, input: args.input }),
    ),
    def(
      "panel_set_widget",
      "Set a widget value on a node in the user's open graph (steps, cfg, seed, ckpt_name, text prompts, …). Returns the previous and new value (a string longer than 1000 chars is echoed as {chars, sha256, preview} so batched calls stay inside the outer tool-result budget — pass `echo: \"full\"` for the verbatim string). Undoable with Ctrl+Z. To CLEAR a text widget to an empty string, pass `clear: true` (some MCP clients drop an empty-string `value` from the serialized payload, so `value: \"\"` may not arrive — `clear: true` always works). For the LTXDirector timeline node (WhatDreamsCost CSGlide), set `timeline_data` with the FULL timeline JSON (segments + global_prompt) to drive its custom timeline UI — this re-syncs the editor and regenerates its derived `local_prompts`/`segment_lengths`/`guide_strength` widgets; setting those derived widgets directly is refused (they are silently reverted).",
      {
        node_id: nodeId().describe("Node id from panel_graph_outline / panel_query_graph."),
        widget: z.string().describe("Widget name (e.g. 'steps', 'cfg', 'text')."),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe("New value. Must match the widget's expected type. Optional only when `clear: true` is set (which forces an empty string)."),
        clear: z
          .boolean()
          .optional()
          .describe("Set true to clear the widget to an empty string (\"\"). Escape hatch for when a client cannot carry an empty-string `value` through tool-arg JSON. Overrides `value`."),
        echo: z
          .enum(["summary", "full"])
          .optional()
          .describe(
            "How to echo the previous/new values back. 'summary' (default) replaces a string longer than 1000 chars with {chars, sha256, preview} — the mutation is applied either way. 'full' returns the verbatim strings.",
          ),
      },
      async (args: A, ctx) => {
        // Distinguish "value present but empty" from "value absent" by key
        // presence, NOT a truthiness check — an empty string is a legitimate
        // value. `clear: true` is the transport-independent way to set "".
        const value = args.clear === true ? "" : args.value;
        if (value === undefined) {
          return fail(
            "panel_set_widget needs a `value`. To set an empty string, pass `clear: true` (some clients drop an empty-string `value`).",
          );
        }
        // #599: the frontend runs refresh-before-validate here (pulls a fresh
        // /object_info so a just-staged/-downloaded/-installed value is accepted on
        // a single revalidation, #338/#458) — that authoritative fetch can outlast
        // the 6000 ms default ack on a large install and return a FALSE timeout.
        // Give the guarded write the bounded refresh ack budget.
        // #1695: summarize the previous/new echo of every successful write
        // (direct, remapped, or inner-subgraph) before anything else touches
        // it — long prompts batched in one code-mode script otherwise overflow
        // the outer tool result even though the mutations succeeded. Applied
        // to the raw success reply so a later appendToolResultText disclosure
        // (which makes the text no longer parse as JSON) cannot dodge it.
        const echoFull = args.echo === "full";
        const write = async (nodeId: unknown, widget: string): Promise<ToolResult> =>
          summarizeSetWidgetEcho(
            await ctx.call(
              { cmd: "graph_set_widget", node_id: nodeId, widget, value },
              OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS,
            ),
            echoFull,
          );
        const first = await write(args.node_id, args.widget as string);
        if (!first.isError) return first;

        // #1655 — the panel listed this widget as promoted while refusing it as
        // not promoted. The listing is node.widgets; the write looks up host
        // inputs. When those disagree, resolve the displayed name to the unique
        // inner mapping and set it there (the issue's own workaround), then
        // leave the subgraph so the caller's scope is unchanged.
        const refusal = parseContradictoryPromotedWidgetRefusal(
          textOfToolResult(first),
          args.widget as string,
        );
        if (!refusal || String(refusal.nodeId) !== String(args.node_id)) return first;

        if (refusal.widget !== args.widget) {
          const remapped = await write(args.node_id, refusal.widget);
          if (!remapped.isError) return remapped;
          if (
            !parseContradictoryPromotedWidgetRefusal(
              textOfToolResult(remapped),
              refusal.widget,
            )
          ) {
            return remapped;
          }
        }

        const sub = await ctx.call({ cmd: "graph_get_subgraph", node_id: args.node_id });
        if (sub.isError) {
          return appendToolResultText(
            first,
            `\n\n(The panel listed "${refusal.widget}" as promoted while refusing it. ` +
              `Tried to resolve that name to the inner widget and graph_get_subgraph FAILED: ` +
              `${textOfToolResult(sub)})`,
          );
        }
        const inner = resolveInnerPromotedTarget(parseToolResultJson(sub), refusal.widget);
        if (!inner) {
          return appendToolResultText(
            first,
            `\n\n(The panel listed "${refusal.widget}" as promoted while refusing it. ` +
              `graph_get_subgraph did not uniquely identify an inner node that owns that widget, ` +
              `so the write was not retried — guessing among several inners, or acting on a ` +
              `truncated inner list, would target the wrong node.)`,
          );
        }

        const entered = await ctx.call(
          { cmd: "graph_enter_subgraph", node_id: args.node_id },
          15000,
        );
        if (entered.isError) {
          return appendToolResultText(
            first,
            `\n\n(The panel listed "${refusal.widget}" as promoted while refusing it. ` +
              `Resolved it to inner node ${inner.innerNodeId} but panel_enter_subgraph FAILED: ` +
              `${textOfToolResult(entered)})`,
          );
        }

        const written = await write(inner.innerNodeId, inner.widget);
        const exited = await ctx.call({ cmd: "graph_exit_subgraph" }, 15000);
        if (!written.isError) {
          const via =
            `\n\n(Applied via the inner widget this promotion lists: node ${inner.innerNodeId} ` +
            `"${inner.widget}". The panel listed "${refusal.widget}" as promoted while refusing ` +
            `it as not promoted; the displayed name was resolved to that inner mapping.)`;
          if (exited.isError) {
            return appendToolResultText(
              written,
              `${via} panel_exit_subgraph then FAILED — the canvas may still be inside the ` +
                `subgraph. Call panel_exit_subgraph. (${textOfToolResult(exited)})`,
            );
          }
          return appendToolResultText(written, via);
        }
        if (exited.isError) {
          return appendToolResultText(
            first,
            `\n\n(Tried the inner mapping node ${inner.innerNodeId} "${inner.widget}" and it ` +
              `FAILED: ${textOfToolResult(written)} panel_exit_subgraph also FAILED — the ` +
              `canvas may still be inside the subgraph. Call panel_exit_subgraph. ` +
              `(${textOfToolResult(exited)}))`,
          );
        }
        return appendToolResultText(
          first,
          `\n\n(Tried the inner mapping node ${inner.innerNodeId} "${inner.widget}" and it ` +
            `FAILED: ${textOfToolResult(written)})`,
        );
      },
    ),
    def(
      "panel_remove_widget",
      "Remove ONE dynamic widget row from a node — the rows custom nodes add themselves, like the rgthree Power Lora Loader's `lora_1`, `lora_2`, … or an Impact/Inspire list node's entries. Their add/remove affordance is a canvas-drawn button you cannot click, so this is the only way to delete a row; panel_set_widget can only overwrite a row's value, and panel_remove_node deletes the whole node. REFUSES, with the reason, when the widget is an input the BACKEND declares (removing it would change what is sent at queue time — set it with panel_set_widget instead), when it is a frontend-generated control widget (control_after_generate, which the frontend re-creates), when its input slot currently has a link (disconnect it first), and when the node definitions cannot be read at all — an unreadable definition is reported as unknown, never treated as 'not declared'. The remaining rows are deliberately NOT renumbered: `lora_N` is a monotonic id, not a position, and the backend matches rows by name prefix, so gaps are harmless — the reply lists the remaining widget names, and those are the names to use next. Undoable with Ctrl+Z.",
      {
        node_id: nodeId().describe("Node id from panel_graph_outline / panel_query_graph."),
        widget: z
          .string()
          .describe(
            "Exact widget name to remove, as shown by panel_query_graph {fields:'detail'} (e.g. 'lora_2').",
          ),
      },
      async (args: A, ctx) =>
        // Same bounded budget panel_set_widget uses: the panel pulls a fresh /object_info
        // to decide whether this widget is a declared input, and that fetch outlasts the
        // 6000 ms default ack on a large install (#599) — a false timeout here would read
        // as "the removal failed" for a removal that succeeded.
        ctx.call(
          { cmd: "graph_remove_widget", node_id: args.node_id, widget: args.widget },
          OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS,
        ),
    ),
    def(
      "panel_set_property",
      "Set a node's LiteGraph PROPERTY (the right-click → Properties panel), NOT a widget — the counterpart to panel_set_widget, which only reaches `widgets`. Many custom nodes are configured entirely through node properties: e.g. the rgthree Fast Groups Bypasser's filters `matchTitle`, `matchColors`, `sort`, and `toggleRestriction` are node properties, and without `matchTitle` the node enumerates EVERY group in the workflow (a footgun). Sets node.properties[name] and, when the node defines an onPropertyChanged callback (rgthree and many LiteGraph nodes do), invokes it so the change takes effect LIVE (e.g. rgthree re-filters its group list). Returns the previous and new value. Undoable with Ctrl+Z.",
      {
        node_id: nodeId().describe("Node id from panel_graph_outline / panel_query_graph."),
        name: z
          .string()
          .describe("Property name from the node's right-click → Properties panel (e.g. 'matchTitle', 'matchColors', 'sort', 'toggleRestriction')."),
        value: z
          .union([z.string(), z.number(), z.boolean(), z.null()])
          .describe("New property value (string/number/boolean/null). For the rgthree Fast Groups Bypasser, matchTitle is a title substring/regex filter."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_set_node_property", node_id: args.node_id, name: args.name, value: args.value }),
    ),
    def(
      "panel_edit_node",
      "Atomically edit one node, or apply the same edit to several nodes. Pass exactly one of node_id or node_ids, plus at least one field. In one Ctrl+Z step you can move (pos), resize (size — including Note/MarkdownNote), retitle, recolor, change shape, collapse, pin, or set execution mode. Widget values, LiteGraph properties, links, and slot order stay on their dedicated tools. For a multi-node call, position/size/title/mode apply the same value to every target. Color fields accept #RGB, #RGBA, #RRGGBB, or #RRGGBBAA; null clears a color. Bypassing a subgraph retains panel_set_node_mode's unsafe-boundary guard; force:true is required to override it. Undoable with Ctrl+Z.",
      {
        node_id: nodeId().optional().describe("One node id from panel_graph_outline / panel_query_graph. Provide this OR node_ids, not both."),
        node_ids: z.array(nodeId()).min(1).optional().describe("Several node ids that receive the same presentation edit. Provide this OR node_id, not both."),
        pos: xy().optional().describe("New canvas [x, y]."),
        size: nodeSize().optional().describe("New [width, height] in canvas px. Uses the node's setSize so DOM-widget nodes reflow and minimum sizes are honored."),
        title: z.string().optional().describe("New header title."),
        preset: z.enum(["red", "brown", "green", "blue", "pale_blue", "cyan", "purple", "yellow", "black"]).optional().describe("Named LiteGraph palette color (sets both title and body). Cannot be combined with color/bgcolor."),
        color: z.string().regex(NODE_COLOR_HEX).nullable().optional().describe("Title-bar color hex, or null to clear."),
        bgcolor: z.string().regex(NODE_COLOR_HEX).nullable().optional().describe("Body color hex, or null to clear."),
        shape: z.enum(["default", "box", "round", "card"]).optional().describe("Node outline shape; default restores the theme default."),
        collapsed: z.boolean().optional().describe("true collapses to a title chip; false expands."),
        pinned: z.boolean().optional().describe("Whether LiteGraph marks this node pinned for presentation/layout."),
        mode: z.enum(["active", "bypass", "mute"]).optional().describe("Execution mode. Bypass/mute change what renders; inspect the graph first."),
        force: z.boolean().optional().describe("Required only to bypass a subgraph whose positional I/O boundary mapping is unsafe."),
      },
      async (args: A, ctx) => {
        const error = validatePanelEditNodeArgs(args);
        if (error) return fail(error);
        return ctx.call({
          cmd: "graph_edit_node",
          node_id: args.node_id,
          node_ids: args.node_ids,
          pos: args.pos,
          size: args.size,
          title: args.title,
          preset: args.preset,
          color: args.color,
          bgcolor: args.bgcolor,
          shape: args.shape,
          collapsed: args.collapsed,
          pinned: args.pinned,
          mode: args.mode,
          force: args.force,
        });
      },
    ),
    // Keep legacy bridge commands behind compatibility tool names. graph_edit_node
    // is newer than several installed panels, while current panels adapt these
    // commands into the same atomic implementation.
    def("panel_move_node", "Compatibility wrapper for panel_edit_node(pos).", { node_id: nodeId(), pos: xy() }, async (args: A, ctx) => ctx.call({ cmd: "graph_move_node", node_id: args.node_id, pos: args.pos })),
    def("panel_resize_node", "Compatibility wrapper for panel_edit_node(size).", { node_id: nodeId(), size: nodeSize() }, async (args: A, ctx) => ctx.call({ cmd: "graph_resize_node", node_id: args.node_id, size: args.size })),
    def(
      "panel_auto_layout",
      "Automatically arrange the user's open graph (or a subset of nodes) into a clean left-to-right / top-to-bottom / grid layout based on the real link topology. Group boxes move with their members and are re-fit. Use dry_run:true to preview proposed positions without touching the canvas. Undoable (one Ctrl+Z).",
      {
        node_ids: z
          .array(z.number().int())
          .optional()
          .describe("Node ids to arrange (default: every node in the active graph)."),
        mode: z
          .enum(["flow_horizontal", "flow_vertical", "grid"])
          .optional()
          .describe("Layout strategy (default flow_horizontal — left-to-right by dependency depth)."),
        spacing: z
          .number()
          .min(0.25)
          .max(4)
          .optional()
          .describe("Gap multiplier (1 = compact default, 1.5 = 50% roomier)."),
        groups: z.enum(["preserve", "cluster", "ignore"]).optional(),
        dry_run: z
          .boolean()
          .optional()
          .describe("Compute and return proposed positions without moving anything."),
      },
      async (args: A, ctx) =>
        ctx.call(
          {
            cmd: "graph_auto_layout",
            node_ids: args.node_ids,
            mode: args.mode,
            spacing: args.spacing,
            groups: args.groups,
            dry_run: args.dry_run,
          },
          15000,
        ),
    ),
    def(
      "panel_canvas",
      "MOVE the user's viewport: 'fit' frames the whole graph, 'center_on_node' jumps to a node (give node_id), 'pan' shifts by dx/dy, 'zoom' sets an absolute scale. It changes what they are looking AT and returns nothing about the graph — to find out what is ON the canvas, use panel_graph_outline. View-only.",
      {
        action: z.enum(["fit", "center_on_node", "pan", "zoom"]),
        node_id: nodeId().optional().describe("Required for center_on_node."),
        dx: z.number().optional().describe("Pan delta x."),
        dy: z.number().optional().describe("Pan delta y."),
        scale: z.number().optional().describe("Absolute zoom for 'zoom' (0.05–4, 1 = 100%)."),
        // #845 — the tool used two names for one concept: `action:"zoom"` requires
        // `scale`, and a `zoom` argument was simply not in the schema, so passing
        // it was dropped without a word. Accept it as the alias it obviously is.
        zoom: z.number().optional().describe("Alias for `scale`."),
      },
      async (args: A, ctx) => {
        const scale = args.scale ?? args.zoom;
        const res = await ctx.call({
          cmd: "graph_canvas",
          action: args.action,
          node_id: args.node_id,
          dx: args.dx,
          dy: args.dy,
          scale,
        });
        // #845 — an argument this action does not consume was SILENTLY dropped.
        // The reporter passed zoom:0.55 to center_on_node, got scale 0.067 back,
        // and had no way to tell the zoom had been ignored rather than applied
        // and overridden. Only `zoom` applies a scale — the panel's
        // center_on_node sets the offset alone — so say which arguments this
        // action actually used.
        const ignored = ignoredCanvasArgs(String(args.action), {
          node_id: args.node_id,
          dx: args.dx,
          dy: args.dy,
          scale,
        });
        if (!ignored.length || res.isError) return res;
        return appendNote(
          res,
          `Note: action:"${args.action}" does not use ${ignored.join(", ")} — ` +
            `${ignored.length === 1 ? "it was" : "they were"} ignored, not applied. ` +
            (ignored.includes("scale/zoom")
              ? `To change the zoom, call panel_canvas again with action:"zoom" and scale. `
              : "") +
            `Any values in this result are the canvas's actual state.`,
        );
      },
    ),
    def(
      "panel_run",
      "Queue the workflow the user has OPEN — exactly like them pressing Queue Prompt (current widget values, the live graph they can see). On success it confirms the run was queued; if ComfyUI REFUSES the prompt (validation failure on either channel — per-node node_errors OR a top-level error like a missing node type) it returns a FAILURE with that rejection detail, never a false 'queued'. Pass to_node_id to RUN ONLY ONE BRANCH ('run to node'): ComfyUI renders just that output node plus everything upstream of it and SKIPS every other output branch — handy for previewing or debugging part of a big graph without rendering the whole thing. to_node_id MUST be an OUTPUT node (SaveImage, PreviewImage, SaveVideo, …) — pick the one at the END of the branch you want; nodes are tagged is_output:true in panel_query_graph's detail rows. The output node may be NESTED inside a subgraph — just pass its id (resolved in the scope you're currently viewing, then anywhere in the workflow); the tool builds the nested execution path for you. Omit it to run the whole graph. DUPLICATE FENCE (#862): if a render this session cannot account for is already in flight (after a reconnect this is usually YOUR earlier render still running — the queue record does not survive a restart), the run is REFUSED before anything is queued and the in-flight prompt is named; inspect queue (action:'list') first, then pass allow_duplicate:true once you have decided it is fine to run behind what is there — a scoped to_node_id preview after a reconnect is the ordinary case for it, a deliberate sweep/batch the other. Use this so the render runs on THEIR canvas and they see the result.",
      {
        batch_count: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Times to queue (default 1)."),
        to_node_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Output node id to render UP TO (partial execution). Omit to run the whole graph. Must be an OUTPUT node — one with is_output:true in panel_query_graph's detail rows. May be nested inside a subgraph (pass the node's own id).",
          ),
        allow_duplicate: z
          .boolean()
          .optional()
          .describe(
            "Queue even when a render this session cannot account for is already in flight (default false). When work is in flight that this session has no record of queueing — e.g. YOUR OWN earlier render still running after a reconnect, whose record does not survive the restart — panel_run REFUSES to stack a duplicate and names the in-flight prompt instead. Pass true once you have LOOKED at what is in flight (queue action:'list') and decided it is fine to run behind it. After a reconnect that is the ordinary case, not an exotic one: you confirmed the in-flight job is your own earlier render or the user's, and you still want the next run — a scoped to_node_id preview, the next step of the task. Deliberately stacking a sweep/batch uses the same override.",
          ),
      },
      async (args: A, ctx) => {
        // BACKPRESSURE: the agent can't see ComfyUI's queue, so re-queuing while a
        // render is already running silently stacks behind it (this is how a stuck
        // job once let three more pile up). Snapshot the watchdog BEFORE we queue.
        const pre = QueueMonitor.snapshot();
        // #862 — the fence fires BEFORE the queue call, not after. After a
        // reconnect the resumed agent has no running-state signal, and the old
        // order queued first and only THEN appended the "[QUEUE] already running"
        // note — a duplicate the agent then had to find and cancel. When in-flight
        // work is not PROVABLY this session's own, refuse to enqueue: name what
        // is in flight and require an explicit allow_duplicate to stack behind
        // it. "Not provably ours" is the honest phrasing, not "foreign": the
        // self-queue ledger is in-memory and prompt-id-based, so after an
        // orchestrator restart — or whenever the panel's queue reply carried no
        // prompt id — the agent's OWN earlier render reads as unproven, which is
        // exactly the duplicate this fence exists to stop. The fence therefore
        // keys on selfAttributedProven, the strict id-matched form; the coarse
        // recent-self-queue fallback that softens the #559 backlog warning would
        // also wave an unrelated render through (codex gate). The deliberate cost:
        // a fast self-queued burst whose ids the 1 Hz poll has not captured yet
        // is refused too, with the override named — a false refusal with an
        // actionable remedy, never a silent duplicate. A provably self-attributed
        // in-flight batch (a sweep whose ids are recorded and accounted for)
        // still queues, exactly as before; an unconnected watchdog proves nothing
        // either way, so the call proceeds and the post-queue note remains the
        // disclosure of last resort (and the TOCTOU net: work can start between
        // this snapshot and the dispatch). This composes with #694's retry_of
        // rather than duplicating it: that token dedupes an EXPLICIT retry of an
        // outcome-unknown dispatch at the panel; this fence stops a BLIND
        // re-issue before any dispatch.
        // #1011 — an EXPLICIT retry is not a blind re-issue, and this fence was
        // stopping the one mechanism that can settle it.
        //
        // The comment above says this "composes with #694's retry_of". It does
        // not, in the order they actually run: the fence refuses BEFORE dispatch,
        // so a caller who was handed a retry_of rid by an outcome-unknown timeout
        // can never get that token to the panel, where the dedupe lives. After a
        // reconnect the in-flight render is exactly the one they are unsure
        // about, `selfAttributedProven` is false (the ledger is in-memory and did
        // not survive), and the fence fires every time — leaving them unable to
        // discover whether their timed-out dispatch created the pending job, with
        // the token that exists for that purpose inert in their hand.
        //
        // A supplied retry_of is a caller ASSERTION of the same weight as
        // allow_duplicate: "this is a retry of that dispatch, dedupe it." It is
        // only ever obtained FROM an outcome-unknown failure of this identical
        // call, so it is not a blanket bypass. Honour it, and let the panel do
        // the reconciliation it is designed for.
        const explicitRetry = typeof args.retry_of === "string" && args.retry_of !== "";
        if (
          args.allow_duplicate !== true &&
          !explicitRetry &&
          pre.connected &&
          (pre.running || pre.queueDepth > 0) &&
          !pre.selfAttributedProven
        ) {
          const pending = Math.max(0, pre.queueDepth - (pre.running ? 1 : 0));
          const pendingTxt = pending > 0 ? ` + ${pending} pending` : "";
          return fail(
            `panel_run refused to queue: a render is already in flight on ComfyUI` +
              (pre.runningPromptId
                ? ` (running prompt ${pre.runningPromptId}${pre.currentNode ? `, currently at node ${pre.currentNode}` : ""}${pendingTxt})`
                : ` (${pre.queueDepth} job(s) in the queue)`) +
              `, and this session cannot confirm it as its own — the queue record is in-memory and ` +
              `prompt-id-based, so after a reconnect/restart (or when an earlier queue reply carried ` +
              `no prompt id) even YOUR OWN earlier render reads as unconfirmable, and queueing now ` +
              `would stack a DUPLICATE behind it (#862). Nothing was queued. Inspect with queue ` +
              `(action:"list"): if the in-flight job is the render you already started, wait for it ` +
              `and confirm the outcome with get_history instead of re-running it. Once you HAVE ` +
              `looked and decided it is fine to run behind what is there, re-call panel_run with ` +
              `allow_duplicate:true — after a reconnect that is the ORDINARY case, not an exotic ` +
              `one: the in-flight job is your own earlier render or the user's, and you still want ` +
              `the next run (a scoped to_node_id preview, the next step of the task). Deliberately ` +
              `stacking a sweep/batch uses the same override. If the in-flight job is actually wedged, queue ` +
              `(action:"cancel") with clear_pending:true interrupts it AND drops everything pending.`,
          );
        }
        const runCmd = { cmd: "graph_run", batch_count: args.batch_count, to_node_id: args.to_node_id };
        // #884 — capture the journal tab BEFORE dispatch: this is the tab the
        // bridge is about to route the run to (both read the same active-tab
        // resolution), so the #468 ticket keys the tab whose panel will report
        // the completion. Resolving AFTER the (seconds-long) queue round-trip
        // could key a tab the user has since moved to (codex r3/r4 timing).
        const runTicketTab = journalTabFor(ctx);
        // #704 — the OWNER of the run. Unlike the tab, this cannot drift between
        // the queue and the completion: it is this tool session's own binding.
        const runTicketConversation = journalConversationFor(ctx);
        // #1327 — stamped BEFORE the dispatch, because the ticket cannot be opened
        // until ComfyUI mints the prompt id and a cached render can finish before that
        // reply gets back here. Any completion for that id which arrived after this
        // instant belongs to this run: the id did not exist before this call created
        // it. Without the timestamp the journal has no way to tell the agent's own
        // 0.1s render from a stranger's, and reported it as UNDETERMINED.
        const runDispatchedAt = Date.now();
        // #1175 — the rid of the dispatch we are about to make, so an unanswered
        // one can be reconciled against the panel's late acknowledgement. Rebound
        // by the re-issue below, deliberately: the entry that matters is always
        // the LAST dispatch, which is the only one whose outcome is still open.
        let runRid: string | undefined;
        const observeRunRid = (rid: string): void => {
          runRid = rid;
        };
        let lateAckNote = "";
        let res = await ctx.call(runCmd, 20000, observeRunRid);
        // #1175 — fold a late acknowledgement into `res` BEFORE anything reads it,
        // so a recovered run takes the identical path an on-time one takes: the same
        // rejection detection, the same prompt-id ticketing, the same anti-poll
        // guidance. Rebuilding the reply here (rather than describing it) is what
        // makes that possible — `ok()` is exactly what ctx.call would have produced.
        const reconcileRun = async (): Promise<void> => {
          const recovered = await reconcileLateRunAck(ctx, res, runRid);
          if (!recovered) return;
          res = ok(recovered.result);
          lateAckNote = lateRunAckNote(recovered.lateByMs);
        };
        await reconcileRun();
        // Derive the verdict from the AUTHORITATIVE reply, not a bare `queued`
        // flag. A rejection — a no-connected-tab / thrown-queuePrompt error
        // (#331/#248), or a ComfyUI /prompt refusal on EITHER channel
        // (top-level `error` with empty node_errors #213, or per-node
        // node_errors) — is surfaced as a failure WITHOUT the success-only
        // "you'll be notified automatically" guidance. Only a genuine queue
        // gets the anti-poll note below.
        let rejection = detectRunRejection(res);
        // #772 — ONE re-issue, and only for the scoped-run stamp race the panel
        // explicitly certifies as not-queued. Gated on OUR OWN args (this really was a
        // scoped run) and on the panel having ANSWERED, so an unknown outcome is never
        // retried. Exactly once: a second race is surfaced, never re-raced.
        let scopeRebuilt = false;
        if (
          rejection &&
          typeof args.to_node_id === "number" &&
          isRetryableRunToNodeStampRace(res, rejection)
        ) {
          scopeRebuilt = true;
          try {
            // #1050 — SETTLE before re-issuing. The panel refuses this race when the
            // graph changed between dispatch and apply, and re-dispatching in the
            // same tick lands in the SAME window: a reporter's retry raced
            // identically and instantly, so the one re-issue was spent for nothing
            // and the run was refused twice with nothing queued.
            //
            // This is a SETTLE PAUSE, not the mutation-quiescence barrier the report
            // asked for. The panel exposes no such signal, and inventing a
            // graph-is-quiet reading from out here would be guessing at the
            // frontend's state. It buys pending edits a moment to land — exactly
            // what the reconnect retry already does for a dropped socket — and
            // nothing more. A graph still moving after it (a user actively editing)
            // races again and is SURFACED, never re-raced.
            await sleep(retrySettleMs());
            res = await ctx.call(runCmd, 20000, observeRunRid);
            // #1175 — the re-issue can miss its window exactly as the first
            // dispatch can, and this is the one whose outcome is genuinely open
            // (the first was CERTIFIED to have queued nothing). Reconcile it on
            // the same terms; observeRunRid has already rebound to this attempt.
            await reconcileRun();
            rejection = detectRunRejection(res);
          } catch (err) {
            // ctx.call settles every panel/transport failure into a ToolResult and does
            // not throw today — but this await is the one point where a throw would
            // DESTROY evidence we already hold: that the first dispatch was certified
            // not-queued, and that a second dispatch went out whose outcome is now
            // unknown. Propagating the raw throw would lose both and invite a third
            // dispatch. Report what we observed, claim nothing we did not.
            return fail(
              `panel_run re-issued the scoped run after the panel's certified run-to-node ` +
                `stamp race, and that SECOND dispatch failed before any reply could be read — ` +
                `its outcome is UNKNOWN and it may have queued a render. The FIRST dispatch was ` +
                `certified by the panel to have queued nothing. Do NOT re-run blindly: check the ` +
                `queue (action:"list") or get_history before deciding. (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        }
        if (rejection) {
          // Disclose the re-issue on the failure path too: the caller must know a SECOND
          // dispatch went out. The disclosure states only what is CERTIFIED — that the
          // FIRST dispatch queued nothing — and leaves the second attempt's outcome to be
          // read from the rejection itself, which may be a post-write timeout whose
          // outcome nobody can honestly claim to know.
          // #1175 — a recovered acknowledgement can carry the panel's own REFUSAL
          // (the bridge retains `ok:true`, which means the executor answered, not
          // that it queued anything). That verdict is authoritative and is surfaced
          // as the failure it is — but it still has to say it arrived late, or the
          // caller reads a refusal for a dispatch they were told was unknown and
          // cannot tell whether these are one event or two.
          if (!scopeRebuilt)
            return lateAckNote ? appendToolResultText(rejection, lateAckNote) : rejection;
          return appendToolResultText(
            rejection,
            `\n\n(Dispatch history: the first graph_run was refused by the panel's run-to-node ` +
              `graph-stamp race, which CERTIFIED that nothing was queued, so the scoped run was ` +
              `re-issued exactly once — after a short pause to let pending graph edits land ` +
              `(#1050). The failure above is that SECOND dispatch; it was not retried again. ` +
              `Judge whether anything was queued from that message alone — the first dispatch ` +
              `definitely queued nothing. Racing AGAIN after the pause means the graph is still ` +
              `changing under the run: let the canvas settle, then re-run.)` +
              lateAckNote,
          );
        }
        // Attribute this genuine queue to ourselves so a later panel_run in the
        // same batch recognizes the in-flight job as our own and doesn't false-warn
        // (#559). The panel forwards ComfyUI's /prompt reply, which carries the
        // prompt_id; when it doesn't, the timestamp still marks a recent self-queue.
        const runReply = parseToolResultJson(res);
        // #949 — batch_count > 1 makes the panel report `prompt_ids` for EVERY
        // queued render alongside `prompt_id` for the first. Only the first was
        // ever ticketed, so completions 2..N came back as
        // "does NOT match any run you queued … its origin is UNDETERMINED" — for
        // runs the agent had just queued itself. Ticket all of them.
        const queuedIds = acceptedPromptIds(runReply);
        const queuedId = queuedIds[0];
        // #944: a run ComfyUI accepted while dropping some outputs reaches here
        // (a minted prompt id outranks the rejection signals). Say which outputs
        // were dropped, or the caller waits for files that will never be written.
        const droppedNote = describeDroppedOutputs(runReply);
        // #1011 — a retry that rode PAST the duplicate fence must say so. The
        // fence exists to stop a second render stacking behind an unaccountable
        // one; skipping it on the caller's assertion is right, but silently
        // skipping it would hide the one risk the caller took. The panel dedupes
        // on the token, so the expected outcome is reconciliation rather than a
        // new render — expected, not guaranteed, which is exactly why it is said.
        const retryBypassNote =
          explicitRetry && pre.connected && (pre.running || pre.queueDepth > 0) && !pre.selfAttributedProven
            ? `\n\n[RETRY] You passed retry_of, so the duplicate fence was SKIPPED — a render this session ` +
              `could not account for was already in flight` +
              (pre.runningPromptId ? ` (running prompt ${pre.runningPromptId})` : "") +
              `. The panel dedupes on that token, so a matching earlier dispatch should have been ` +
              `reconciled rather than re-queued. VERIFY that before assuming: check queue (action:"list") ` +
              `and get_history — if you now see one MORE job than you intended, the token did not match ` +
              `and this dispatch stacked a duplicate.`
            : "";
        // markSelfQueued with NO id still stamps the recent-self-queue timestamp,
        // so the id-less case must still call it exactly once (#559).
        if (queuedIds.length === 0) QueueMonitor.markSelfQueued(null);
        for (const id of queuedIds) QueueMonitor.markSelfQueued(id);
        // #468 — open a run ticket so the render's completion can be CORRELATED
        // to this exact call by prompt id. This is what lets the orchestrator
        // journal an undelivered completion and replay it into the right run
        // instead of losing it while the agent works through a goal.
        const ticketOpts = {
          // #884 — the REAL routed tab, captured at dispatch (see runTicketTab):
          // the panel's `executed` event arrives under that id.
          tabId: runTicketTab,
          // #704 — …and WHOSE run it is. The tab is where the completion is
          // expected FROM; this is the conversation that gets to call it its own,
          // which is what still holds after the panel reconnects under a new id.
          ...(runTicketConversation !== undefined ? { conversation: runTicketConversation } : {}),
          ...(typeof args.to_node_id === "number" ? { toNodeId: args.to_node_id } : {}),
          // #1327 — lets the journal claim a completion that beat its own ticket.
          dispatchedAt: runDispatchedAt,
        };
        // Every id gets its own ticket. `correlatable` stays the promise the
        // anti-poll note is allowed to make — true only if at least one run can
        // actually be correlated back.
        const correlatable =
          queuedIds.length === 0
            ? RunCompletions.openRun(undefined, ticketOpts)
            : queuedIds.map((id) => RunCompletions.openRun(id, ticketOpts)).some(Boolean);
        // Append anti-poll guidance: the agent should go idle after queuing so the
        // executed event auto-injects the output image, rather than busy-polling.
        //
        // HONEST WHEN WE CAN'T PROMISE IT (#468): the anti-poll instruction is only
        // safe because the completion is correlated by prompt id. Without one — the
        // panel forwarded no `prompt_id` — a later completion can only be reported as
        // UNDETERMINED, so telling the agent to idle and wait would park it on a
        // promise we can't keep. Say so and point at the verification path instead.
        const note = correlatable
          ? "\n\n[IMPORTANT] You will be notified automatically with the output image(s)/video when the render finishes — do NOT poll queue (action:\"list\"), get_history, or get_image (action:\"list_outputs\"). Just end your turn now and wait for the result to be delivered to you."
          : "\n\n[IMPORTANT] The run was queued, but the panel reported NO prompt id for it, so a completion event CANNOT be correlated back to this run — its outcome will be reported to you as UNDETERMINED. Do NOT simply idle and wait indefinitely: end your turn, and if nothing arrives, confirm the outcome with get_history (action:\"list\") before acting on it.";
        // Backpressure note. A backlog is only alarming when it's a job we did NOT
        // queue (possibly foreign/stuck). Deliberately batching renders — a sweep,
        // a multi-variant comparison — is a NORMAL workflow, so a queue made of our
        // own recent jobs is reported NEUTRALLY, never paired with the destructive
        // clear_pending remedy that would wipe the user's whole batch (#559). A
        // genuinely stalled render is caught by the turn-start stall notice, which
        // does the staleness gating and keeps the interrupt guidance.
        // #772 — never report a dispatch history the caller did not see. When the scoped
        // run only queued on the SECOND dispatch, say so, so the agent does not read the
        // earlier refusal (if it surfaces in a log) as a separate queued job.
        //
        // It says only what was OBSERVED (codex gate). An earlier draft said "exactly one
        // render was queued" — but `batch_count` is "times to queue", so a successful
        // dispatch can enqueue several, and the panel reports one prompt id, not a count.
        // The certified fact is about DISPATCHES, not renders: the first queued nothing,
        // so everything in the queue came from the second. State that and stop.
        const retryNote = scopeRebuilt
          ? "\n\n[NOTE] The first dispatch of this scoped run was refused by the panel's run-to-node " +
            "graph-stamp race (the graph changed between dispatch and apply); the panel certified that " +
            "nothing was queued, so the scope was rebuilt and re-issued once, and THAT is the run above. " +
            "The first dispatch contributed NOTHING to the queue, so whatever this run queued was " +
            "queued once, not twice."
          : "";
        let warn = "";
        if (pre.connected && pre.running) {
          const pending = Math.max(0, pre.queueDepth - 1);
          const pendingTxt = pending > 0 ? ` + ${pending} pending` : "";
          if (pre.selfAttributed) {
            warn =
              `\n\n[QUEUE] Queued behind your own in-flight render(s) (1 running${pendingTxt}). ` +
              `This is normal when batching a sweep or comparison — they drain in order and nothing is stuck; ` +
              `each result is delivered to you as it finishes. To drop a single pending item, use queue (action:"cancel_queued"). ` +
              `Only use queue (action:"cancel") with clear_pending:true if a render is ACTUALLY wedged — it kills the running job AND your entire queue.`;
          } else {
            warn =
              `\n\n[QUEUE] A render is already running${pre.runningPromptId ? ` (prompt ${pre.runningPromptId})` : ""}${pendingTxt}, ` +
              `and the queue includes work this session didn't queue — your run is queued behind it. Inspect with queue (action:"list") before acting. ` +
              `If the running job is genuinely stuck, queue (action:"cancel") with clear_pending:true interrupts it AND drops pending, then escalate to restart_comfyui if it reports the job wedged.`;
          }
        }
        if (res.content?.[0]?.type === "text") {
          return {
            ...res,
            content: [
              // droppedNote sits FIRST among the appendices: "some outputs were
              // dropped" changes what the caller should expect from this run, so
              // it must not trail behind the anti-poll boilerplate (#944).
              //
              // lateAckNote sits second, ahead of the anti-poll guidance, for the
              // same reason: a caller who has already been handed an
              // outcome-unknown for this dispatch needs to know THIS is its
              // resolution before being told to idle and wait (#1175).
              {
                type: "text",
                text:
                  res.content[0].text +
                  droppedNote +
                  lateAckNote +
                  retryBypassNote +
                  retryNote +
                  warn +
                  note,
              },
              ...res.content.slice(1),
            ],
          };
        }
        // A recovered run must never lose its disclosure to a non-text reply
        // shape. `ok()` always produces text, so this is unreachable for the
        // #1175 path today — but "unreachable today" is why the branch above was
        // the only one carrying the appendices in the first place.
        if (lateAckNote) return appendToolResultText(res, lateAckNote);
        return res;
      },
    ),
    def(
      "panel_get_errors",
      "WHY IS THAT NODE RED / WHY DID THE RUN FAIL? The single error surface for the user's open tab: every errored node JOINED TO ITS CAUSE, which ComfyUI itself does not show — LiteGraph only paints a red outline and stores no reason, which is why users report \"red node, no error message\". Call this whenever the user mentions a red/highlighted/erroring node, a failed run, or \"required models are missing\" — instead of guessing from widget values. Each entry in `nodes[]` is the node's full detail summary plus `red_outline` and `reasons[]`, drawn from every source: `missing_model` (exact file, its models directory, the widget holding it, and a download URL when known), `missing_media` (a referenced input image/video that isn't on disk — the usual cause of a red LoadImage), `validation` (per-input errors from the last queue attempt: message, details, offending input), and `execution` (runtime failure with `exception_type`, e.g. PIL.UnidentifiedImageError). TWO THINGS THAT MAKE THIS ESSENTIAL: (1) missing model/media assets paint nodes red AS SOON AS THE WORKFLOW LOADS, long before any queue attempt — so the raw validation map is still EMPTY while the user is staring at red nodes; (2) a node that throws AT RUNTIME is never painted red at all, so it can't be spotted on the canvas — it appears here with red_outline:false. Also returns graph-level `missing_models`, `missing_media`, `missing_node_types` (or `missing_node_count`), plus the raw `node_errors` map and `last_execution_error` for reference. A ⚠️ GRAPH VALIDATION block is auto-injected at your turn start when this state changes; call this to re-check on demand (e.g. after you edit widgets/links). Read-only.",
      {},
      async (_args, ctx) =>
        withTruncationHints(await ctx.call({ cmd: "graph_get_errors" }), [
          {
            flag: "truncated",
            key: "truncation_hint",
            text: (p) =>
              fixedCapHint(
                "errored node(s)",
                replyCount(p, "nodes"),
                p.errored_count,
                "Fix these first and re-check, or inspect specific ids with panel_query_graph {ids:[…], fields:'detail'}.",
              ),
          },
          {
            flag: "stale_flags_truncated",
            key: "stale_flags_truncation_hint",
            // Older panels send no total for this list, so the rider says so rather than
            // implying the shown count is the whole of it (codex gate). A current panel
            // supplies its own hint WITH the total, and the rider defers to it.
            text: (p) =>
              fixedCapHint(
                "stale red-outline node(s)",
                replyCount(p, "stale_flags"),
                undefined,
                "An unknown number more were cut (this panel build reports no total). They are cosmetic leftovers, not errors; the cap is fixed and there is no parameter to page it.",
              ),
          },
        ]),
    ),
    def(
      "panel_refresh_nodes",
      "Re-pull the live ComfyUI server's /object_info and rebuild every combo/loader option list in the user's open tab, so an asset that appeared server-side AFTER the tab loaded becomes SELECTABLE without a manual reload (the 'press R' step) or a restart. Use this right after upload_image (action:\"stage\") (chaining a stage's output into a LoadImage / VHS_LoadVideo / LoadAudio loader — the returned filename won't be in the loader's dropdown until you refresh), after downloading a model / LoRA / VAE (a freshly downloaded file is otherwise 'not a valid option' in its loader), or after installing a node pack. Then panel_set_widget / panel_add_node will accept the new value. Non-destructive: it only re-registers node defs and refreshes combo option lists — it does NOT change your graph and is undo-neutral. Idempotent (safe to call repeatedly). Returns whether the refresh authoritatively fetched fresh defs.",
      {},
      async (_args, ctx) =>
        // Same bounded ack budget as the refresh-before-validate writes (#599): a
        // fresh /object_info on a large install routinely exceeds the 6000 ms
        // default, and this command's WHOLE purpose is to await that fetch.
        ctx.call({ cmd: "refresh_nodes" }, OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS),
    ),
    def(
      "panel_reload",
      "Soft-reload yourself to pick up code changes WITHOUT restarting ComfyUI — your chat session resumes automatically and you'll be nudged to continue. This ENDS the current turn. What each scope actually reloads: 'orchestrator' (default) respawns your agent and its comfyui tool server, so agent config, MCP servers (panel_add_mcp/panel_remove_mcp), the system prompt, and the code behind the comfyui server's tools all reload from the comfyui-mcp build on disk; 'frontend' re-fetches the panel UI (web JS/CSS). What it does NOT reload: the long-lived orchestrator process that serves every panel_* tool (including this one) and the services those tools use — that process keeps the code it started with, and only the user can restart it (the panel prints the exact restart command when this runs). So after editing orchestrator/panel-tool code, do NOT claim the change is live after this call — say the orchestrator process must be restarted. For custom-node or model changes that need a full ComfyUI restart, use panel_restart_comfyui instead. Only call this when code has actually changed and needs to take effect now.",
      {
        scope: z
          .enum(["orchestrator", "frontend"])
          .optional()
          .describe("'orchestrator' (default): respawn the agent and its comfyui tool server (agent config, MCP servers, system prompt, comfyui tool code). Does NOT restart the long-lived orchestrator process behind the panel_* tools. 'frontend': reload the panel UI for new web code."),
      },
      async (args: A, ctx) => {
        // panel_reload self-heals an orphaned REAL-tab binding onto the active
        // tab (so the soft_reload frame reaches a live tab), but it is NOT a
        // scope-repin consent path (confirming gate 3, P0): a SCOPE-bound
        // session's in-flight turn pin is only ever moved by the explicit
        // panel_set_workflow_target({mode:"current"}) recovery. A scope ctx
        // whose pin is dead therefore FAILS here, naming that recovery —
        // instead of silently re-aiming the turn (and every mutation that
        // follows it) at whichever tab happens to be last-active.
        if (isScopeAddress(ctx.tabId)) {
          const reachable =
            typeof ctx.bridge.canReach === "function" ? ctx.bridge.canReach(ctx.tabId) : true;
          if (!reachable) {
            return fail(
              "This conversation's current turn is pinned to a tab that is no longer " +
                "reachable (it disconnected or its origin is ambiguous), so the reload " +
                "frame has nowhere safe to go. Ask the user to send a message from the Agent " +
                "panel in the ComfyUI tab they want (that — not focusing the tab — is what " +
                'marks it active), call panel_set_workflow_target({mode:"current"}) to ' +
                "re-bind this session onto it, then retry panel_reload.",
            );
          }
        } else if (ctx.rebindToActiveTab) {
          // Strict-single: if this session's tab is orphaned AND 2+ tabs are live,
          // do NOT guess (the bridge would fall back to last-active, possibly an
          // unrelated tab) — surface a clear error so the user picks, honoring the
          // documented "ambiguous multi-tab surfaces a clear error" promise (codex).
          const orphaned =
            typeof ctx.bridge.canReach === "function" && !ctx.bridge.canReach(ctx.tabId);
          const live = typeof ctx.bridge.tabs === "function" ? ctx.bridge.tabs() : undefined;
          // Count only INTERACTIVE (canvas-owning) tabs for the ambiguity guard: one
          // desktop canvas alongside headless viewers is NOT ambiguous — rebindToActiveTab
          // binds the sole desktop tab. Only 2+ real canvas tabs are unpickable here.
          // Call isHeadless THROUGH the bridge (not an extracted reference): it is a
          // plain method that reads `this.conns` — invoking a detached `const headless
          // = ctx.bridge.isHeadless` loses `this`, so `this.conns` throws "Cannot read
          // properties of undefined (reading 'conns')" and panel_reload fails outright
          // (panel #478). Mirror the bound `isHeadlessTab` helper used elsewhere here.
          const isHeadlessTab = (id: string): boolean =>
            typeof ctx.bridge.isHeadless === "function" && ctx.bridge.isHeadless(id);
          const interactive = Array.isArray(live)
            ? live.filter((t) => !isHeadlessTab(t.tab_id))
            : live;
          if (orphaned && Array.isArray(interactive) && interactive.length > 1) {
            return fail(
              "This session's ComfyUI tab was replaced and multiple tabs are now open — " +
                "can't safely pick one. Ask the user to send a message from the Agent panel " +
                "in the tab they want (that — not focusing the tab — is what marks it " +
                'active), then call panel_set_workflow_target({mode:"current"}) before ' +
                "panel_reload.",
            );
          }
          try {
            ctx.rebindToActiveTab();
          } catch (err) {
            return fail(err);
          }
        }
        const scope = (args.scope as string) ?? "orchestrator";
        // #1700 — the frontend soft_reload only drops the websocket (this pack's
        // /reload is a 503). The live agent keeps the MCP set it was spawned
        // with, and a plain resume restores the session-recorded set anyway.
        // Schedule a forked in-process respawn so makeMcpServers() re-reads
        // ~/.claude.json and the replacement session is NOT the old MCP set.
        if (scope === "orchestrator") applyMcpReload?.(ctx.tabId);
        const res = await ctx.call({ cmd: "soft_reload", scope }, 15000);
        // #765 — the agent reads this result as its last context before the
        // reload, and again after the resume, so it is the place to state what
        // the reload could NOT have refreshed: the panel_* tools run inside the
        // long-lived orchestrator process, which a soft reload never restarts.
        // Without this the agent resumes believing an orchestrator/service code
        // change took effect when it did not.
        if (scope === "orchestrator" && !res.isError) {
          const text = res.content?.find((c) => c.type === "text");
          if (text && "text" in text) {
            text.text +=
              "\n\nReminder of what this reloads: you and your comfyui tool server " +
              "restart fresh from the comfyui-mcp build on disk. What it does NOT " +
              "reload: the long-lived orchestrator process that serves every " +
              "panel_* tool and the services behind them — it keeps the code it " +
              "started with. If the change you were picking up touched " +
              "orchestrator/panel-tool code (e.g. a service a panel_* tool " +
              "imports), it is NOT in effect: tell the user the orchestrator " +
              "process must be restarted (the panel shows the exact restart " +
              "command).";
          }
        }
        return res;
      },
    ),
    def(
      "panel_list_mcp",
      "List the MCP servers available to you. Returns the user's inherited servers (from their Claude config) plus your always-present built-ins (comfyui, the live-graph panel server). Use this to check whether a capability (e.g. CivitAI model search) is already connected before offering to add it.",
      {},
      async () => {
        try {
          const inherited = Object.keys(readUserMcpServers());
          return ok({
            inherited,
            builtin: ["comfyui", "panel"],
            note: "After panel_add_mcp / panel_remove_mcp, call panel_reload to apply the change to this session.",
          });
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_add_mcp",
      "Connect a new MCP server by writing it to the user's Claude config (~/.claude.json) — it then loads into THIS session after you call panel_reload, and also becomes available to the user's normal Claude session. Use for capabilities you don't have yet, e.g. the official CivitAI MCP: name 'civitai', transport 'http', url 'https://mcp.civitai.com/mcp'. ALWAYS ask the user before connecting a remote (http/sse) MCP — it's an external service connection. Some servers need an auth token: pass it via headers (http/sse) or env (stdio).",
      {
        name: z.string().describe("Server name/key, e.g. 'civitai'. Letters, digits, dot, dash, underscore."),
        transport: z.enum(["http", "sse", "stdio"]).describe("'http'/'sse' for a hosted URL server; 'stdio' for a local command."),
        url: z.string().optional().describe("Server URL (required for http/sse), e.g. 'https://mcp.civitai.com/mcp'."),
        command: z.string().optional().describe("Executable (required for stdio), e.g. 'npx'."),
        args: z.array(z.string()).optional().describe("Args for the stdio command."),
        headers: z.record(z.string(), z.string()).optional().describe("HTTP headers for http/sse (e.g. an Authorization token)."),
        env: z.record(z.string(), z.string()).optional().describe("Environment variables for a stdio server."),
      },
      async (args: A) => {
        try {
          const transport = args.transport as string;
          let config: Record<string, unknown>;
          if (transport === "stdio") {
            if (!args.command) throw new Error("stdio transport requires `command`.");
            config = {
              type: "stdio",
              command: args.command,
              ...(args.args ? { args: args.args } : {}),
              ...(args.env ? { env: args.env } : {}),
            };
          } else {
            if (!args.url) throw new Error(`${transport} transport requires \`url\`.`);
            config = {
              type: transport,
              url: args.url,
              ...(args.headers ? { headers: args.headers } : {}),
            };
          }
          addUserMcpServer(args.name as string, config);
          return ok(
            `Connected MCP server "${args.name}" (written to your Claude config). Call panel_reload to load it into this session — then its tools become available.`,
          );
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_remove_mcp",
      "Remove an MCP server from the user's Claude config by name. Call panel_reload afterward to drop it from this session. Cannot remove the built-in comfyui/panel servers.",
      { name: z.string().describe("Server name to remove (from panel_list_mcp).") },
      async (args: A) => {
        try {
          const removed = removeUserMcpServer(args.name as string);
          return ok(
            removed
              ? `Removed MCP server "${args.name}". Call panel_reload to apply.`
              : `No MCP server named "${args.name}" in the user config.`,
          );
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_request_secret",
      "Securely collect an API token / secret from the user and write it straight to config — you NEVER see the value and it is never saved to chat history. The panel shows a masked input; the pasted value goes directly to the orchestrator, which stores it on the target MCP server, then applies it. Returns only a redacted confirmation.\n\nTWO targets:\n• The BUILT-IN comfyui server (mcp_server 'comfyui', target_kind 'env') — for tokens YOUR OWN comfyui tools need. The env key MUST be one of a fixed allowlist: CIVITAI_API_TOKEN (download_model action:\"download_civitai\"), HUGGINGFACE_TOKEN or HF_TOKEN (HuggingFace downloads). Any other key is rejected. The secret is written to the canonical credential file, which the comfyui tools re-read each time they use a credential — so the running tools pick it up with NO panel_reload. The tool result states what was actually verified (that the file now carries the key) and what the live tool sessions did; if it reports the save could NOT be confirmed, treat it as unconfigured rather than retrying blindly. THIS is what fixes a download that returned HTTP 401.\n• A user-added MCP server (e.g. the 'civitai' http server you added with panel_add_mcp) — use target_kind 'header' (e.g. Authorization, value_prefix 'Bearer ') for http/sse, or 'env' for stdio; then call panel_reload to load it.\n\nFor a CivitAI DOWNLOAD 401, target 'comfyui' env CIVITAI_API_TOKEN — NOT the 'civitai' MCP server (that's only the search MCP).",
      {
        label: z.string().describe("Prompt shown above the masked input, e.g. 'Paste your CivitAI API token'."),
        target_kind: z.enum(["header", "env"]).describe("'header' for http/sse servers (e.g. Authorization); 'env' for stdio servers and the built-in comfyui server."),
        mcp_server: z.string().describe("MCP server to attach the secret to: 'comfyui' for the built-in tools (download_model action:\"download_civitai\" etc.), 'orchestrator' for orchestrator-level provider keys (OPENROUTER_API_KEY), or a user-added server name like 'civitai'."),
        key: z.string().describe("For 'comfyui': one of CIVITAI_API_TOKEN, HUGGINGFACE_TOKEN, HF_TOKEN (others rejected). For a user-added server: env var name or header name (e.g. 'Authorization')."),
        value_prefix: z.string().optional().describe("Optional string prepended to the token, e.g. 'Bearer '. Usually empty for env vars."),
        hint: z.string().optional().describe("Optional reassurance/help text shown under the input."),
      },
      async (args: A, ctx) => {
        // #1352 — A HUMAN FETCHING A CREDENTIAL IS NOT A STALLED OPERATION, and a flat
        // 300s treated it as one.
        //
        // Waiting longer is NOT available: the enclosing MCP `tools/call` is killed at
        // ~300s (see ASK_TOTAL_BUDGET_CAP_MS), so this card already sat at the framework
        // ceiling. A bigger number only moves the kill from our timer to theirs, where the
        // answer is lost instead of handled — the #360 lesson the confirm cards learned and
        // this one did not.
        //
        // So it gets the STRUCTURE the ask path has: a deadline clamped under the budget,
        // then a bounded grace poll of the late-answer buffer. Someone who finishes typing
        // a second after the deadline now has their token APPLIED rather than discarded.
        // RESERVE TIME TO ACTUALLY SAVE IT (codex P1). The card wait plus the grace fill
        // the whole 285s ask budget, and the enclosing tools/call is killed at ~300s — so
        // a token recovered at the very end of the grace had only the leftover framework
        // margin in which to be written, read back, and reported. A slow store (a locked
        // file, antivirus on the write, a config rewrite) could then lose a credential the
        // user DID supply in time: precisely the loss this whole change exists to prevent,
        // moved one step later.
        //
        // So the grace stops early enough that anything accepted has room to persist. The
        // cost is a slightly shorter window to type in; the alternative is accepting a
        // token and then dropping it, which is worse than never having taken it.
        const timing = getAskTiming();
        const budgetEnd = Date.now() + timing.deadlineMs + timing.graceMs;
        const pollUntil = budgetEnd - SECRET_PERSIST_RESERVE_MS;
        // The ask_id is what makes a late answer recoverable at all (#486) — the bridge
        // only buffers a reply whose command carried one, and this card never sent one.
        //
        // The bridge treats a `request_secret` card as SENSITIVE from the command name: it
        // buffers the late value in memory but never hands it to the DURABLE late-answer
        // journal. A credential must not be written down, which is why this tool exists.
        const askId = randomUUID();
        let arrivedLate = false;
        /** A recovered answer must never read as an ordinary one (#486's rule, here). */
        const lateAware = (r: ToolResult): ToolResult => {
          if (!arrivedLate) return r;
          // ARRIVAL ONLY — never "and was applied". This prefixes EVERY outcome, failures
          // included: a token that lands during the grace and then fails to persist
          // (`secretNotPersisted`, a damaged store, an unconfirmed write) would otherwise
          // be announced as applied by the very message explaining that it was not. The
          // rest of the result already says what happened; this says only WHEN it arrived.
          const note =
            `(This token arrived AFTER the ${Math.round(timing.deadlineMs / 1000)}s card ` +
            `deadline, within the grace period that follows it.) `;
          const [first, ...rest] = r.content;
          return first && first.type === "text"
            ? { ...r, content: [{ ...first, text: note + first.text }, ...rest] }
            : r;
        };
        const run = async (): Promise<ToolResult> => {
        try {
          let secret: unknown;
          try {
            secret = await ctx.bridge.send(
              { cmd: "request_secret", ask_id: askId, label: args.label, hint: args.hint },
              { tabId: ctx.tabId, timeoutMs: timing.deadlineMs },
            );
          } catch (err) {
            // ONLY a reply timeout is recoverable. Any other failure — no panel, transport
            // down — is not "they are still typing" and must not be waited out.
            if (!isReplyTimeoutError(err)) throw err;
            const late = await pollLateAskReply(ctx.bridge, askId, timing, pollUntil);
            if (late === undefined) throw err;
            secret = late;
            arrivedLate = true;
          }
          // A whitespace-only paste must be treated as "nothing entered": it
          // would write and read back cleanly (so the save would be CONFIRMED)
          // while every reader treats a blank as absent, leaving the credential
          // unset behind a success message (codex gate, round 2, finding 1).
          if (typeof secret !== "string" || secret.trim().length === 0) {
            return ok("No token entered — nothing was saved.");
          }
          const server = (args.mcp_server as string) ?? "";
          // An ORCHESTRATOR provider secret (OpenRouter API key) — stored in the
          // agent-secret slice of the 0600 config and hydrated into the
          // orchestrator's OWN env, which flips the OpenRouter provider to ready
          // and lists its models. NOT injected into the comfyui child.
          if (server.toLowerCase() === "orchestrator" || isAllowedAgentSecretKey(args.key as string)) {
            const receipt = setAgentSecret(args.key as string, secret);
            // EXHAUSTIVE on the three-valued verdict. Handling only "no" left
            // "unknown" rendering as saved-and-enabled — a definite configured
            // state asserted from a failed read-back, which is the #826 defect
            // in the very vocabulary introduced to prevent it (coordinator
            // finding). Provider keys are read IN this process, so a PROVEN save
            // does take effect immediately — but say which provider the KEY
            // enables rather than naming OpenRouter for every key.
            switch (receipt.persisted) {
              case "no":
                return fail(secretNotPersisted(receipt));
              case "damaged":
                // The write HAPPENED and cost the user other credentials. That
                // is a disclosure about a completed operation, never a refusal
                // that invites a retry — and it can never be narrated as a save.
                return ok(
                  `${storeDamageNote(receipt)} (The key itself did land, so do not set it again before restoring the file — a second write is one more rewrite of a damaged store.)`,
                );
              case "unknown":
                return ok(
                  `⚠️ ${receipt.key} was written to ${receipt.path}, but the save is NOT confirmed — treat it as UNKNOWN: ` +
                    `${receipt.uncertainty ?? `the file could not be re-read to confirm it`}. ` +
                    `Do not treat the provider as configured: check ${receipt.path} carries the key, and set it again if the provider still reads as unconfigured.`,
                );
              case "yes": {
                // A SHADOWED save is stored but not in use, so it must not be
                // followed by "the provider is enabled now" — it leads instead.
                const shadow = shadowedNote(receipt);
                const headline =
                  shadow ??
                  `🔒 ${receipt.key} saved to ${receipt.path} (confirmed by reading the file back; the value is never shown or logged). ` +
                    `The orchestrator reads provider keys in-process, so the provider this key belongs to is enabled now — pick it in the provider list.`;
                return ok(
                  [headline, ...receiptDisclosures(receipt).filter((n) => n !== shadow)].join(" "),
                );
              }
              default: {
                // Exhaustiveness: a new verdict added to the receipt is a COMPILE
                // error here rather than a silent fall-through past this whole
                // block into the user-MCP-server branch below.
                const unhandled: never = receipt.persisted;
                return fail(
                  new Error(
                    `${receipt.key}: the store returned a save verdict this build does not know how to report (${String(unhandled)}). ` +
                      `Nothing about the save can be asserted — check ${receipt.path} directly.`,
                  ),
                );
              }
            }
          }
          // The BUILT-IN comfyui server is NOT in the user's ~/.claude.json — the
          // orchestrator spawns it with its own env. Route its secrets to the
          // dedicated store, which injects them into that env and RESPAWNS the
          // server (no reload needed). Anything else is a user-config MCP server.
          if (server.toLowerCase() === "comfyui") {
            if ((args.target_kind as string) !== "env") {
              return ok(
                "The built-in comfyui server takes secrets as env vars — use target_kind 'env' (e.g. key 'CIVITAI_API_TOKEN').",
              );
            }
            const receipt = setComfyuiSecret(
              args.key as string,
              `${(args.value_prefix as string) ?? ""}${secret}`,
              {
                // This save ANSWERS an outstanding agent secret request — mark it so
                // the orchestrator injects the "retry the action" nudge, and carry
                // the requesting tab so ONLY that tab's agent is nudged (never a
                // broadcast to unrelated tabs). A Settings-panel slot save omits
                // both and never nudges (#164).
                requested: true,
                tabId: ctx.tabId,
              },
            );
            // The save either took effect or it did not — REFUSE when a read-back
            // proves it did not, rather than returning a success the tools cannot
            // act on (#826: a token that reports configured but is invisible is
            // worse than an honest failure, because every later 401 then
            // misdirects the caller).
            if (receipt.persisted === "no") return fail(secretNotPersisted(receipt));
            // Redacted ack ONLY — the secret never enters the agent's context.
            return ok(describeComfyuiSecretSave(receipt));
          }
          setUserMcpServerSecret(
            {
              kind: args.target_kind as "header" | "env",
              server,
              key: args.key as string,
              prefix: args.value_prefix as string | undefined,
            },
            secret,
          );
          // Redacted ack ONLY — the secret never enters the agent's context.
          return ok(
            `🔒 Token saved to MCP server "${server}" (${args.target_kind} "${args.key}"). Call panel_reload to load it.`,
          );
        } catch (err) {
          // #1352 — A TIMED-OUT SECRET CARD IS NOT A FROZEN TAB.
          //
          // The bridge's generic no-reply message ("the ComfyUI tab may be backgrounded
          // or frozen") is right for every other command and wrong here. This card
          // blocks up to 300s on a MASKED INPUT, and the overwhelmingly likely reason it
          // went unanswered is that a human is still typing — off finding the key in a
          // password manager or a billing console. Nothing is wrong with the tab, and
          // sending someone to fix one is the #1332 defect in a new place.
          //
          // It also has to say what happens to a value entered LATE, because that is the
          // question the caller will actually have. That answer CHANGED in #1352, and this
          // comment changes with it: the card now carries an ask_id and this handler polls
          // the late-answer buffer for a bounded grace, so a value typed shortly after the
          // deadline IS applied. Reaching this branch means the grace elapsed too, and only
          // then is it true that nothing more can reach this call.
          //
          // The previous text asserted the discard as a MEASURED fact, correctly at the
          // time. A message that outlives the behaviour it describes is worse than none —
          // someone stops waiting for a save that now works.
          if (isReplyTimeoutError(err)) {
            return fail(
              `The secret card went unanswered — through its ` +
                `${Math.round(timing.deadlineMs / 1000)}s deadline AND the ` +
                `${Math.round(timing.graceMs / 1000)}s grace after it — so NOTHING was saved and ` +
                `no credential was read. That is very likely just time: the card asks for a ` +
                `token, and finding one in a password manager or a billing console can take ` +
                `longer than that. It does NOT mean the tab is frozen, and it does NOT mean ` +
                `the user declined.\n\n` +
                `A value typed into that card DURING the grace WOULD have been applied — that is ` +
                `what the grace is for. Past it there is no path back to this call, so ask ` +
                `whether they still want to set it and call panel_request_secret ` +
                `again when they are ready to paste — the value goes straight from the masked ` +
                `field into storage, and must never be typed into the conversation.`,
            );
          }
          return fail(err);
        }
        };
        return lateAware(await run());
      },
    ),
    def(
      "panel_get_content_mode",
      "Query the persistent adult-content (NSFW) consent state for this user. Returns { nsfw_allowed, decided_at }. ALWAYS check this before surfacing any adult/NSFW models, prompts, workflows, or imagery. It defaults to FALSE (SFW-only) until the user passes the consent gate (panel_request_adult_consent). Read-only.",
      {},
      async () => {
        try {
          const c = getNsfwConsent();
          return ok({ nsfw_allowed: c.allowed, decided_at: c.decidedAt ?? null });
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_request_adult_consent",
      "Show the user the adult-content consent gate and persist their decision. Call this ONLY when a request clearly intends NSFW/adult work AND panel_get_content_mode shows it's not already allowed. It renders a card asking the user to confirm they are 18+ AND that adult content is legal in their region; an affirmative answer turns the mode ON persistently (across reloads), a negative keeps it SFW. Returns the resulting { nsfw_allowed } state. Never assume consent — this tool is the only way to enable it.",
      {
        reason: z
          .string()
          .optional()
          .describe("Optional one-line context shown to the user about why you're asking (e.g. 'to search Civitai for mature LoRAs')."),
      },
      async (args: A, ctx) => {
        try {
          const question =
            "Adult-content gate — to enable NSFW work in this session, please confirm BOTH that you are at least 18 years old AND that creating/viewing adult content is legal in your country/region." +
            (args.reason ? `\n\nContext: ${args.reason}` : "") +
            "\n\nThis is recorded as your consent and can be turned off anytime.";
          // #372: the consent card goes over the bridge DIRECTLY (not ctx.call), so
          // self-heal an orphaned current-mode session first — otherwise a session
          // that lost its live binding (reconnect/reload/workflow-switch) throws a
          // false `no connected tab` here even though graph tools just worked.
          ctx.ensureReachable?.();
          // #390: the enclosing MCP `tools/call` is killed at ~300s. A hardcoded 300s
          // card wait raced that budget with ZERO margin, so an idle user who never
          // clicked blew the whole tool call as a transport timeout ("timed out
          // awaiting tools/call after 300s") instead of resolving cleanly. CLAMP the
          // card deadline under the budget (the same getAskTiming() ceiling panel_ask
          // and confirm use) with a stable ask_id, and on a reply-timeout poll the
          // bridge's late-reply buffer for a bounded grace so a slow-but-VALID pick is
          // still honored. If the user is simply away, resolve cleanly with
          // { nsfw_allowed:false, timed_out:true } WITHOUT touching consent — a timeout
          // NEVER grants the gate; the persistent decision is unchanged and can be read
          // back with panel_get_content_mode, or the user re-asked, on the next turn.
          const timing = getAskTiming();
          const askId = randomUUID();
          const askCard = {
            cmd: "ask_user",
            ask_id: askId,
            question,
            header: "18+ consent",
            options: [
              { label: CONSENT_YES_LABEL, description: "Enable adult content for this session" },
              { label: CONSENT_NO_LABEL, description: "Stay in safe-for-work mode" },
            ],
          } as { cmd: string };
          let reply: unknown;
          let timedOut = false;
          try {
            reply = await ctx.bridge.send(askCard, { tabId: ctx.tabId, timeoutMs: timing.deadlineMs });
          } catch (err) {
            // Only a card-reply TIMEOUT is recoverable here: poll the late buffer for a
            // slow-but-valid answer. Any other error (no panel, transport failure)
            // propagates to the outer catch → fail(), exactly as before.
            if (!isReplyTimeoutError(err)) throw err;
            timedOut = true;
            reply = await pollLateAskReply(ctx.bridge, askId, timing);
          }
          // STRICT gate: adult mode turns ON only on the EXACT affirmative option (or a
          // strict whole-string yes token) — never via the loose isAffirmative() prefix
          // match, so a free-text late reply like "adult content is illegal here" or "On
          // second thought, no" can't grant. An UNCLEAR reply (incl. a no-answer timeout,
          // where reply is undefined) changes NOTHING: it neither grants nor revokes a
          // prior genuine grant. Only an EXACT decline explicitly reverts to SFW.
          const decision = classifyConsentReply(reply);
          if (decision === "unclear") {
            const current = getNsfwConsent();
            return ok({
              nsfw_allowed: current.allowed,
              decided_at: current.decidedAt ?? null,
              ...(timedOut ? { timed_out: true } : {}),
              note: timedOut
                ? "The 18+ consent card wasn't answered in time, so nothing changed — adult content stays gated by the existing state. " +
                  "Ask again when the user is back, or read the current state with panel_get_content_mode."
                : "The 18+ consent card wasn't answered with a clear yes/no, so nothing changed — the existing content-mode state is unchanged. " +
                  "Ask again with a clear choice, or read the current state with panel_get_content_mode.",
            });
          }
          const allowed = decision === "grant";
          const state = setNsfwConsent(allowed);
          return ok({
            nsfw_allowed: state.allowed,
            decided_at: state.decidedAt,
            note: allowed
              ? "Adult mode enabled. Hard limits still apply: no minors, no sexual deepfakes of real people, no depictions of actual non-consensual acts."
              : "Kept SFW. Don't surface adult content.",
          });
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_disable_adult_mode",
      "Turn the adult-content (NSFW) consent OFF — revert to SFW-only. Use when the user asks to disable it. No gate needed to turn it off.",
      {},
      async () => {
        try {
          const state = setNsfwConsent(false);
          return ok({ nsfw_allowed: state.allowed, note: "Adult mode disabled — back to SFW-only." });
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_set_todo",
      "Show/update a live TODO checklist in the panel's footer tray — a running view of your plan that the user watches as you work a multi-step task. Pass the FULL ordered list each call (it replaces the tray); update each step's status as you progress (pending → active → done). Pass an empty array to clear it. Use for genuinely multi-step work (3+ steps); skip it for quick one-shot replies. Mark exactly one step 'active' at a time.",
      {
        items: z
          .array(
            z.object({
              text: z.string().describe("Short step description (a few words)."),
              // #1018 — accept the synonyms agents actually produce (in_progress,
              // completed, …) and normalize them in the handler. The DESCRIPTION
              // still teaches only the canonical trio: one vocabulary to learn,
              // and no round trip lost to a rejected first call over a spelling
              // whose intent was never in doubt.
              status: z
                .enum(TODO_STATUS_INPUTS as [string, ...string[]])
                .optional()
                .describe("Step state (default 'pending'). Mark the one you're on 'active'."),
            }),
          )
          .describe("The full ordered checklist (replaces the current one). Empty array clears the tray."),
      },
      // #322: a 5s ack deadline false-timed-out a responsive session whose tab was
      // momentarily backgrounded. set_todo is a non-destructive, idempotent full-
      // replace UI write (already in RETRY_SAFE_CMDS), so give it the same sane 15s
      // bound as the other UI-state writes (workflow_save) instead of a tight 5s.
      async (args: A, ctx) => {
        // #624: the footer TODO tray is a DESKTOP panel surface. When this session's
        // bound tab is a headless (mobile/remote) client, resolve the live desktop
        // canvas tab instead of dispatching at the headless client — which would
        // reject with the misleading "mobile client has no open canvas".
        // #1018 — canonicalize ONCE, here, before anything reads the list. The
        // panel, recordTodo's snapshot (#977) and the completion-directive logic
        // all keep seeing only pending/active/done.
        const items = normalizeTodoItems(args.items as Array<{ text?: unknown; status?: unknown }>);
        const redirect = desktopCanvasRedirect(ctx, "panel_set_todo");
        if (redirect?.error) return fail(redirect.error);
        if (redirect?.tabId) {
          // #977 — the desktop redirect writes the checklist to ANOTHER tab, so
          // record it against that one. Keying it on ctx.tabId would leave the
          // tab that actually holds the plan looking planless.
          recordTodo(redirect.tabId, items);
          return dispatchToTab(
            ctx,
            redirect.tabId,
            { cmd: "set_todo", items },
            15000,
            () => reResolveDesktopTab(ctx, "panel_set_todo"),
          );
        }
        // #977 — retain what the agent DECLARED, so a later render completion can
        // tell "you are mid-sweep" from "that was the last thing you were doing".
        // The panel keeps the UI copy; this is the orchestrator's own record.
        recordTodo(ctx.tabId, items);
        return ctx.call({ cmd: "set_todo", items }, 15000);
      },
    ),
    def(
      "panel_open_civitai",
      "Open the in-panel CivitAI browser for the user, pre-seeded with a search term and suggested filters, so they can VISUALLY browse and pick a model / LoRA / checkpoint / workflow / image. When the user asks about — or you're recommending — specific CivitAI models/LoRAs/checkpoints (e.g. 'what's a good relight LoRA?'), PREFER opening this docked browser and highlighting your picks over a text-only answer: it docks beside the chat (dock defaults true) so chat and results stay visible together, and it lets the user SEE the actual cards instead of reading a table. Typical show-don't-tell flow: panel_open_civitai (docked) → panel_civitai_search to refine → panel_civitai_results to READ the metadata + URLs → panel_civitai_highlight the one(s) you recommend, with a brief text summary of why. Set a helpful query + filters matched to their goal (including the browsing level). Their selection comes back to you as a normal chat message — UNLESS the panel is muted, in which case they download it directly themselves. Prefer this over guessing a specific model or asking them to paste a URL.",
      {
        query: z
          .string()
          .optional()
          .describe("Search term to pre-fill (e.g. 'anime lineart', 'Flux photoreal'). Omit for a plain browse."),
        creator: z
          .string()
          .optional()
          .describe("Pre-scope the browse to one CivitAI username (with or without a leading @). Folded into the query as an @creator token. Note: a media-only creator (images/videos, no published models) may not resolve on the model tabs, and account-gated content needs an authenticated session."),
        tab: z
          .enum(["images", "videos", "checkpoints", "loras", "workflows", "favorites"])
          .optional()
          .describe("Which tab to open. Default 'images'. Use 'loras'/'checkpoints'/'workflows' when they want a downloadable resource."),
        browsingLevels: z
          .array(z.number())
          .optional()
          .describe("Content levels to show, as a set of bitmask values: PG=1, PG-13=2, R=4, X=8, XXX=16. e.g. [1,2] for SFW only, [1,2,4,8,16] for everything. Default [1]. Match the user's stated comfort. Adult levels (R/X/XXX = 4/8/16) are enforced server-side against the persistent NSFW consent gate and stripped/rejected unless the user has consented (panel_request_adult_consent)."),
        filters: z
          .object({
            period: z.string().optional(),
            modelSort: z.string().optional(),
            imageSort: z.string().optional(),
            baseModels: z.array(z.string()).optional(),
          })
          .optional()
          .describe("Optional filter hints: period, a sort, and base-model names (e.g. ['Flux.1 D'])."),
        dock: z
          .boolean()
          .optional()
          .describe(
            "Side-dock the browser beside the chat instead of a centered overlay, so chat and results stay visible together while you drive it. Default true (agent-opened browsers dock). Set false to force the old full-screen centered overlay.",
          ),
      },
      async (args: A, ctx) => {
        try {
          const browsingLevels = sanitizeBrowsingLevels(args.browsingLevels);
          const creator = normalizeCreator(args.creator);
          const rawQuery = typeof args.query === "string" ? args.query : "";
          const query = creator
            ? `@${creator}${rawQuery ? " " + rawQuery : " "}`
            : args.query;
          const cmd = {
            cmd: "open_civitai",
            query,
            tab: args.tab,
            browsingLevels,
            filters: args.filters,
            dock: args.dock,
          };
          // #624: the in-panel CivitAI browser is a DESKTOP panel surface. When this
          // session's bound tab is a headless (mobile/remote) client, resolve the live
          // desktop canvas tab instead of dispatching at the headless client — which
          // would reject with the misleading "mobile client has no open canvas".
          const redirect = desktopCanvasRedirect(ctx, "panel_open_civitai");
          if (redirect?.error) return fail(redirect.error);
          if (redirect?.tabId) {
            return await dispatchToTab(ctx, redirect.tabId, cmd, 10000, () =>
              reResolveDesktopTab(ctx, "panel_open_civitai"),
            );
          }
          return await ctx.call(cmd, 10000);
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_civitai_results",
      "READ the CivitAI browser's CURRENT results — metadata AND the actual SAMPLE IMAGES. This is the READ step of the show-don't-tell flow: rather than answering a 'good X model/LoRA?' question from a text table, open the docked browser, read the real results here, then panel_civitai_highlight your picks so the user SEES the cards. You ARE shown pixels now: the top few NON-GATED results' sample thumbnails are fetched and returned as inline IMAGE blocks after the JSON, each preceded by a line naming its result id — so you can actually JUDGE whether a LoRA's samples match the user's request (a visual medium) instead of reasoning from titles + download counts alone. Content gating is preserved: any result the panel would BLUR (a rating outside the user's enabled browsing levels, e.g. on the favorites tab) is WITHHELD — its pixels are never fetched — so this never bypasses the NSFW/consent gate. Control the image budget with `images` (default 4, max 8, 0 = metadata only). Open the browser first with panel_open_civitai. Returns { items, total, loading } as text, then the sample images. Each item carries these fields — a MEDIA item is { id, kind:'image'|'video', title:null, creator, baseModel, type, stats:{ reactions }, prompt (length-capped ~600 chars), urls:[], gated }; a MODEL item is { id, kind:'model', title (the model's name), creator, baseModel, type, stats:{ downloadCount, thumbsUp }, prompt:null, urls:[], gated }. Note: stats is a NESTED object (reactions for media; downloadCount+thumbsUp for models), urls is an ARRAY of media URL(s), and media items have title:null while models have prompt:null. `gated:true` marks a result the panel BLURS (rating outside the enabled browsing levels) — its sample image is withheld from the inline pixels above. Only results explicitly flagged `gated:false` get pixels; an older panel that doesn't send `gated` returns metadata only (no inline samples), never a blurred one. Model descriptions are NOT included (they require a separate detail fetch) — do not expect them. Use this to see what's on screen before you highlight, switch tabs, or open the lightbox. `loading:true` means a fetch is still in flight and the panel is reporting what it has so far. The browser must be open — otherwise the panel replies with an honest error.\n\nDISAMBIGUATING AN EMPTY GRID: a `total:0` result is NOT automatically 'no matches'. Newer panels attach status fields you MUST check before concluding anything from an empty set: `error` (e.g. { status:503, message:'CivitAI API 503: Service Unavailable' } — an UPSTREAM failure, retry rather than narrowing filters), and on the favorites tab a `favoritesStatus` (e.g. 'ok' | 'signed_out' | 'no_likes_collection' | 'filtered_out') plus `authenticated`. If `error` is present the grid is empty because the request FAILED, not because nothing matched; if `favoritesStatus` is 'signed_out'/'no_likes_collection' the favorites couldn't be located at all. Only treat total:0 as a true empty result when `error` is null and (off the favorites tab, or favoritesStatus is 'ok').",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results to serialize (1–50, default 20). The grid is ordered as shown to the user."),
        images: z
          .number()
          .int()
          .min(0)
          .max(CIVITAI_SAMPLE_MAX)
          .optional()
          .describe(
            `How many top NON-GATED sample thumbnails to fetch and return as inline IMAGE blocks (0–${CIVITAI_SAMPLE_MAX}, default ${CIVITAI_SAMPLE_DEFAULT}). Set 0 for metadata only (e.g. a quick scan where you don't need pixels). Gated/blurred results are always skipped regardless of this count.`,
          ),
      },
      async (args: A, ctx) => {
        const res = await ctx.call(
          { cmd: "civitai_results", limit: args.limit },
          CIVITAI_COUPLED_READ_TIMEOUT_MS,
        );
        // Enrich with inline sample pixels (#623). Best-effort + additive: on any
        // problem we return the untouched text results, so the read path can never
        // regress to an error just because a thumbnail fetch failed.
        if (res.isError) return res;
        const want =
          args.images === undefined
            ? CIVITAI_SAMPLE_DEFAULT
            : Math.max(0, Math.min(Math.floor(Number(args.images) || 0), CIVITAI_SAMPLE_MAX));
        if (want <= 0) return res;
        const parsed = parseToolResultJson(res);
        if (!parsed) return res;
        let samples: Awaited<ReturnType<typeof fetchCivitaiSampleImages>> = [];
        try {
          samples = await fetchCivitaiSampleImages(parsed, want);
        } catch {
          samples = [];
        }
        if (samples.length === 0) return res;
        const content: ToolResult["content"] = [...res.content];
        content.push({
          type: "text",
          text:
            `Sample images for the top ${samples.length} non-gated result(s) below, ` +
            `each labelled with its result id (map it to the items array). Blurred/gated ` +
            `results are omitted. Judge the VISUAL match from these pixels, not just the metadata.`,
        });
        for (const s of samples) {
          content.push({ type: "text", text: `— sample for result id ${String(s.id)}:` });
          content.push(s.image);
        }
        return { content };
      },
    ),
    def(
      "panel_civitai_highlight",
      "Draw the user's attention to specific results by wrapping their cards in a glowing green outline (and scrolling the first into view) — this is how you say 'these are the ones I mean.' This is the PAYOFF of the show-don't-tell flow: when you recommend a CivitAI model/LoRA/checkpoint, highlight it here (plus a short text note on why) instead of only describing it in prose — the user then sees exactly which cards you mean. Call panel_civitai_results FIRST to get the ids. Pass a LIST of ids to light up several at once ('these three'). The browser must be open — otherwise the panel replies with an honest error. Non-destructive; it only changes what's highlighted, never downloads or selects.",
      {
        ids: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .describe("Result ids to glow green (from panel_civitai_results). Pass several to highlight a set."),
        kind: z
          .enum(["media", "model"])
          .optional()
          .describe("Which result kind these ids refer to (media = images/videos, model = checkpoints/loras/workflows). Match the active tab if omitted."),
      },
      async (args: A, ctx) =>
        ctx.call(
          { cmd: "civitai_highlight", ids: args.ids, kind: args.kind },
          CIVITAI_COUPLED_READ_TIMEOUT_MS,
        ),
    ),
    def(
      "panel_civitai_clear_highlight",
      "Remove any green highlight glow from the CivitAI results — clears what panel_civitai_highlight set. The browser must be open — otherwise the panel replies with an honest error.",
      {},
      async (_args: A, ctx) => ctx.call({ cmd: "civitai_clear_highlight" }, 10000),
    ),
    def(
      "panel_civitai_switch_tab",
      "Switch the OPEN CivitAI browser to a different tab (crossfades and re-fetches that tab's results). Use to move between images, videos, checkpoints, loras, workflows, or the user's favorites while driving the browse. Follow with panel_civitai_results to read what loaded. The browser must be open — otherwise the panel replies with an honest error.",
      {
        tab: z
          .enum(["images", "videos", "checkpoints", "loras", "workflows", "favorites"])
          .describe("The tab to switch to."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "civitai_switch_tab", tab: args.tab }, 10000),
    ),
    def(
      "panel_civitai_search",
      "Run a NEW search inside the already-open CivitAI browser (re-queries the current tab with a fresh term and optional filters). Use this to refine or pivot the browse after reading results — e.g. narrow by base model or change the sort — while keeping the recommendation VISUAL: this is a step in the show-don't-tell flow, so drive the docked browser toward the models/LoRAs you'll recommend rather than dropping back to a text-only list. Follow with panel_civitai_results to read the new results, then panel_civitai_highlight your picks. To open the browser in the first place, use panel_open_civitai instead. The browser must be open — otherwise the panel replies with an honest error.\n\nCreator filter: pass `creator` to scope results to one CivitAI username (it is folded into the query as an `@creator` token and echoed back in the reply's `creator` field). IMPORTANT caveats that make an empty result EXPLAINABLE rather than mysterious: (1) if the reply comes back with `creator:null` or a `warning`, the filter was NOT honored — do not report the empty grid as 'this creator has no content'. (2) A creator who posts ONLY images/videos (no published models) may not be resolvable by username on the model tabs. (3) On the image/video tabs the username filter only sees content the CivitAI session is authorized to see — if the user set an XXX/NSFW filter on their own civitai account, an UNAUTHENTICATED session won't apply it. Check the reply's `warning`/`creator` fields before concluding anything from a zero-result set.",
      {
        query: z.string().describe("The new search term (e.g. 'ghibli background', 'Flux portrait'). Pass \"\" to browse a creator with no keyword."),
        creator: z
          .string()
          .optional()
          .describe("Scope results to one CivitAI username (with or without a leading @). Folded into the query as an @creator token and echoed back as `creator`; a `warning` is returned if it could not be applied."),
        filters: z
          .object({
            period: z.string().optional().describe("Time window filter (e.g. 'Week', 'Month', 'AllTime')."),
            modelSort: z.string().optional().describe("Sort for model tabs (e.g. 'Most Downloaded')."),
            imageSort: z.string().optional().describe("Sort for image/video tabs (e.g. 'Most Reactions')."),
            baseModels: z.array(z.string()).optional().describe("Base-model names to filter to (e.g. ['Flux.1 D'])."),
          })
          .optional()
          .describe("Optional filters applied to this search."),
        browsingLevels: z
          .array(z.number())
          .optional()
          .describe("Content levels for this search, as bitmask values: PG=1, PG-13=2, R=4, X=8, XXX=16. Omit to keep the browser's current levels. Adult levels (R/X/XXX = 4/8/16) are enforced server-side against the persistent NSFW consent gate and stripped/rejected unless the user has consented (panel_request_adult_consent)."),
      },
      async (args: A, ctx) => {
        try {
          const browsingLevels = sanitizeBrowsingLevels(args.browsingLevels);
          const creator = normalizeCreator(args.creator);
          const rawQuery = typeof args.query === "string" ? args.query : "";
          // Fold the creator into the query as an @creator token so the panel's
          // existing parseCreatorQuery path applies it (issue #374 — the tool used
          // to drop `creator` silently, echoing creator:null with zero results).
          const query = creator ? `@${creator}${rawQuery ? " " + rawQuery : " "}` : rawQuery;
          // Self-heal an orphaned session before a raw bridge.send (matches every
          // other direct-bridge call site) — without this an orphaned session
          // wrongly returns "no connected tab" even when a live tab exists (#381).
          ctx.ensureReachable?.();
          // #1468 — was a hardcoded 10_000, HALF this codebase's own default, and
          // the tight bound is the entire bug: `civitai_search` kept timing out
          // while the search demonstrably applied (renderRev advanced,
          // civitai_results reported loading:true), so an applied mutation was
          // reported to the caller as a failure.
          //
          // The tight bound was there to fence a wait on CivitAI's HTTP. That wait
          // is GONE: panel #282 made `driveSearch` resolve on DISPATCH — it fires
          // `void reload(...)` and returns `{dispatched:true, renderRev}` with no
          // await anywhere in the handler. That shipped at panel 0.11.0; #1468 was
          // filed from 0.11.44, so the reporter already had it. Measured, not
          // assumed — my own first reading of this issue asserted the coupling was
          // still there and argued AGAINST raising the bound on that basis.
          //
          // With nothing external left to wait on, what remains between the panel's
          // return and the caller's error is only whether the reply gets back in
          // time — the #357/#694 shape, a busy-but-alive main thread missing a
          // tighter-than-default bound and succeeding moments later. So this takes
          // the shared default like every other panel command, rather than keeping
          // a fence around a wait that no longer exists.
          const reply = await ctx.bridge.send(
            { cmd: "civitai_search", query, filters: args.filters, browsingLevels } as { cmd: string },
            { tabId: ctx.tabId, timeoutMs: BRIDGE_DEFAULT_TIMEOUT_MS },
          );
          // Do NOT let a supplied-but-unapplied creator filter masquerade as a
          // legitimate empty result: if the panel echoes back a different (or null)
          // creator, surface an explicit warning so the caller can tell "filter
          // never applied" from "this creator has no content".
          if (creator && reply && typeof reply === "object") {
            const applied = (reply as { creator?: unknown }).creator;
            const appliedStr = typeof applied === "string" ? applied : "";
            if (appliedStr.toLowerCase() !== creator.toLowerCase()) {
              return ok({
                ...(reply as Record<string, unknown>),
                warning:
                  `The creator filter "${creator}" was NOT applied (the browser reports creator: ` +
                  `${appliedStr ? `"${appliedStr}"` : "null"}). Any empty/other results below are NOT ` +
                  `evidence that this creator has no content. Likely causes: the creator publishes only ` +
                  `images/videos (no models, so username lookup on model tabs can miss them), the username ` +
                  `is misspelled, or the CivitAI session is unauthenticated (a signed-out session can't see ` +
                  `account-gated content). Verify the exact username with download_model action:"search_creators", or drive ` +
                  `the logged-in browser session directly.`,
              });
            }
          }
          // #935 — the #374 guard above covers `creator` and NOTHING else, so
          // modelSort / baseModels / period could be supplied, silently ignored,
          // and answered with a full, plausible result set. An agent asked for
          // "most-downloaded Flux LoRAs" then presents whatever came back, and
          // neither it nor the user can tell the sort never applied. Same failure
          // as #374, one parameter over.
          const filterWarning = describeUnappliedFilters(args.filters, reply);
          if (filterWarning) {
            return ok({
              ...(reply as Record<string, unknown>),
              warning: filterWarning,
            });
          }
          return ok(reply);
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_civitai_open_lightbox",
      "Open the full-size lightbox viewer for one result by id, so the user gets a big look at that specific image/video. Get the id from panel_civitai_results. Use sparingly — as the finishing flourish after you've highlighted your pick. The browser must be open — otherwise the panel replies with an honest error.",
      {
        id: z
          .union([z.string(), z.number()])
          .describe("The result id to open in the lightbox (from panel_civitai_results)."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "civitai_open_lightbox", id: args.id }, 10000),
    ),
    def(
      "panel_training_open",
      "Open the in-panel LoRA/model TRAINING wizard for the user, so they can configure a training run visually while you guide them. Opens side-docked beside the chat by default so the wizard and chat stay visible together. After it's open, read it with panel_training_get_state and drive it with panel_training_set_field, panel_training_goto_step, panel_training_set_target, and panel_training_highlight. This only OPENS and configures the wizard — you have NO command to start a run; the user reviews the setup and launches training themselves from the wizard's Launch control.",
      {
        dock: z
          .boolean()
          .optional()
          .describe("Side-dock the wizard beside chat (default true). Set false for the centered overlay."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "open_training", dock: args.dock }, 10000),
    ),
    def(
      "panel_training_get_state",
      "READ the OPEN training wizard's current state so you can drive it SAFELY. Returns the current view/step, which transitions are allowed right now (so you know if a step's prerequisites are met), the current field values, target availability (e.g. whether a remote pod is SSH-ready), and any async/loading status. Call this BEFORE panel_training_goto_step or panel_training_set_target — the wizard enforces the same gates as its own buttons and will reject a premature move, so check readiness here first. Open the wizard first with panel_training_open. The wizard must be open — otherwise the panel replies with an honest error.",
      {},
      async (_args: A, ctx) => ctx.call({ cmd: "training_get_state" }, 10000),
    ),
    def(
      "panel_training_set_field",
      "Set one field in the OPEN training wizard. The panel applies a strict per-field ALLOWLIST — the ONLY accepted `name` values are: 'datasetName' (string — the LoRA/dataset name), 'trigger' (string — the trigger word), 'preset' (one of 'smoke' | 'standard' | 'custom'), and 'target' (one of 'local' | 'pod', same as panel_training_set_target). Any other name is rejected server-side. There is NO learning-rate/step-count/base-model/dataset-path field here — those come from the chosen preset. Open the wizard first with panel_training_open. This configures only — you have no command to launch training. The wizard must be open — otherwise the panel replies with an honest error.",
      {
        name: z
          .enum(["datasetName", "trigger", "preset", "target"])
          .describe("The wizard field to set. Only these four are accepted; anything else is rejected."),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .describe("The value: datasetName/trigger are strings; preset is 'smoke'|'standard'|'custom'; target is 'local'|'pod'."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "training_set_field", name: args.name, value: args.value }, 10000),
    ),
    def(
      "panel_training_goto_step",
      "Navigate the OPEN training wizard to one of its four steps (1-based): 1 = dataset (gather images), 2 = label (caption them), 3 = launch (choose target + start), 4 = monitor (watch progress). Move the user forward/back as you explain each stage. This enforces the SAME gates as the wizard's Next button (backend capability, a valid name, uploads settled, images present); if the step's prerequisites aren't met the panel rejects it and throws honestly, so call panel_training_get_state first to check readiness. Open the wizard first with panel_training_open. The wizard must be open — otherwise the panel replies with an honest error.",
      {
        step: z.number().int().min(1).max(4).describe("The step to jump to: 1=dataset, 2=label, 3=launch, 4=monitor."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "training_goto_step", step: args.step }, 10000),
    ),
    def(
      "panel_training_set_target",
      "Set WHERE the training run will execute — 'local' (this machine) or 'pod' (a remote GPU pod). Use this in the wizard to steer the user toward the right compute for their job. Choosing 'pod' runs the same preflight as the wizard's own button (a train_doctor check) and is REJECTED if there is no SSH-ready pod — call panel_training_get_state first to confirm pod availability. Open the wizard first with panel_training_open. This only configures the target; you have no command to launch the run. The wizard must be open — otherwise the panel replies with an honest error.",
      {
        target: z.enum(["local", "pod"]).describe("Execution target: 'local' machine or remote 'pod'."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "training_set_target", target: args.target }, 10000),
    ),
    def(
      "panel_training_highlight",
      "Draw the user's attention to specific parts of the OPEN training wizard (steps or fields) with a glowing green outline — this is how you point at 'set this here.' Pass a LIST of refs to light up several. Open the wizard first with panel_training_open. Non-destructive. The wizard must be open — otherwise the panel replies with an honest error.",
      {
        refs: z
          .array(z.string())
          .min(1)
          .describe("Wizard step/field refs to glow green (as the wizard labels them). Pass several to highlight a set."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "training_highlight", refs: args.refs }, 10000),
    ),
    def(
      "panel_ask",
      "Ask the user to choose between options — renders an interactive question card in the panel chat and BLOCKS until they pick, returning their choice as text. It does NOT block forever: if nobody answers within ~285s the call returns an error saying so, and you must then ask in plain chat text or re-invoke when the user is present. Budget for that — a question asked while the user is away costs the better part of five minutes before you learn anything. Use this (NOT the AskUserQuestion tool, which never renders here) whenever you need the user to decide between options. Each option may carry a short description. The card always includes an 'Other…' free-text field, so the returned string may be a listed label or whatever the user typed (comma-joined for multi_select). Ask only when the answer genuinely changes what you do.",
      {
        question: z.string().describe("The question to ask, e.g. 'Which sampler should I use?'"),
        options: z
          .array(
            z.object({
              label: z.string().describe("Short choice text shown on the button."),
              description: z.string().optional().describe("Optional one-line explanation of this choice."),
            }),
          )
          .min(2)
          .describe("The choices (at least 2). An 'Other' free-text field is added automatically."),
        header: z.string().optional().describe("Very short label/chip for the card (e.g. 'Sampler')."),
        multi_select: z.boolean().optional().describe("Allow selecting multiple options (default false)."),
      },
      async (args: A, ctx) => {
        // #300: fail FAST with an actionable error when there is no interactive
        // surface to render the card (a canvas-less/headless client, or an exec/
        // headless run), rather than blocking with no way to answer.
        const surfaceErr = askSurfaceError(ctx);
        if (surfaceErr) return fail(surfaceErr);
        // #486: clamp the card deadline under the MCP tools/call budget and honor a
        // late-but-valid answer via the bridge's late-reply buffer.
        return askUserWithGrace(ctx, {
          question: args.question as string,
          options: args.options,
          header: args.header,
          multi_select: args.multi_select,
        });
      },
    ),
    def(
      "panel_save_workflow",
      "Save the user's open workflow PROGRAMMATICALLY — no Save/Rename dialog ever pops. With no `name`: saves in place (or auto-names + persists a never-saved workflow). With `name`: if the workflow is ALREADY saved under a different name this is a SAVE-AS — it writes a NEW file and leaves the original untouched on disk (it NEVER renames/moves/destroys the original); for a never-saved workflow it is simply the first save. The result reports what happened: `saved_as`+`copied_from`+`original_on_disk` (a disk-verified check that the original file still exists) for a Save-As copy, or `first_save` for a brand-new workflow. Use this freely (e.g. after building a graph) — it won't interrupt the user.",
      { name: z.string().optional().describe("Name for the workflow (no .json needed). If the workflow is already saved under a different name, this writes a NEW file (Save-As COPY) and leaves the original in place — it never renames/moves/destroys it. Omit to save in place / auto-name an unsaved workflow.") },
      async (args: A, ctx) => {
        // #402: await a stable tab binding before dispatching the (mutating) save, so
        // a save issued in the post-restart "Connected: none" window reaches a live
        // tab instead of failing with a bare "Failed to fetch"/OUTCOME UNKNOWN. Pre-
        // send only (nothing dispatched yet) → no risk of writing the file twice; and
        // if no tab reconnects within budget we REFUSE rather than fire into a dead
        // binding.
        if (ctx.awaitReachable && !(await ctx.awaitReachable())) {
          return noReachableTabFail(args.name ? "workflow_save_as" : "workflow_save", ctx);
        }
        const saveOnce = () =>
          args.name
            ? ctx.call({ cmd: "workflow_save_as", name: args.name }, 15000)
            : ctx.call({ cmd: "workflow_save" }, 15000);
        let res = await saveOnce();
        // #1710 — dest tab + dest nodes, extra still stamped as the save-as SOURCE.
        // Rebind extra to the confirmed dest, then retry the same save once.
        if (res.isError && isStampMismatchSaveRefusal(toolResultText(res))) {
          const destPath = await activeSavedPath(ctx);
          if (destPath) {
            const rebound = await tryRebindConfirmedOpenIdentity(ctx, destPath);
            if (rebound.status === "rebound") {
              const retried = await saveOnce();
              if (!retried.isError) res = retried;
            }
          }
        }
        if (res.isError) return res;
        // #1045 — a SAVE-AS replaces the active workflow instance: the canvas is
        // now the NEW file, with its own identity, while this session's command
        // fence still names the pre-save one. Every graph call afterwards fails
        // with "workflow instance mismatch" — a reporter lost the session right
        // after a successful save of ~40 nodes' work.
        //
        // Same shape as #932 (panel_new_workflow), and the same fix: re-derive
        // the fence from the panel's live active record. I closed that path and
        // missed this one; workflow_new and workflow_save_as both re-point the
        // active workflow, so both have to re-anchor.
        //
        // A plain in-place save is included deliberately. Its identity normally
        // FOLLOWS the workflow across the save (tmp: -> wf:), so the refresh
        // re-derives the same value and changes nothing — but "normally" is the
        // whole problem here, and re-reading costs one round trip against a
        // session that is otherwise silently unusable.
        //
        // NEVER fails the call: the file WAS written. Retracting a completed save
        // would be the worse lie, so a fence that could not be re-established is
        // DISCLOSED instead.
        //
        // #814 — trust THIS reply's own proven uuid first (#800), before ever
        // attempting rebindWorkflowFence's independent workflow_list round trip,
        // which can be refused by the exact fence this repairs.
        const fenceRebind = refreshFenceFromOwnReply(ctx, res) ?? (await rebindWorkflowFence(ctx));
        let canMutateNow: boolean | undefined;
        let refusalCause: "unroutable" | "disconnected" | "no_identity" | "capability" | undefined;
        try {
          if (ctx.tabGraphMutationCapability) {
            const cap = ctx.tabGraphMutationCapability();
            canMutateNow = cap.known ? cap.canMutate : undefined;
            if (cap.known && !cap.canMutate) refusalCause = cap.because;
          } else {
            canMutateNow = ctx.tabCanMutateGraph?.();
          }
        } catch {
          canMutateNow = undefined;
          refusalCause = undefined;
        }
        const fence = describeFenceRebind(fenceRebind, canMutateNow, refusalCause, panelTooOldNote(ctx));
        if (!fence || fence.binding === "bound") return res;
        return appendNote(res, `The workflow WAS saved.${fence.note}`);
      },
    ),
    def(
      "panel_list_workflows",
      "List the user's OPEN workflow tabs and which one is active (path, filename, modified, persisted). Use this to know what's open before switching/renaming/closing. Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "workflow_list" }),
    ),
    def(
      "panel_get_workflow_target",
      "Read which workflow this agent is bound to edit. mode 'current' means graph tools follow whatever tab the user is viewing; mode 'pinned' means edits are bound to the pinned workflow (which was the active canvas at pin time) — if the user later switches to another tab, your next graph call FAILS LOUDLY rather than silently editing the wrong graph. Call this when unsure which workflow your panel_* edits will affect.",
      {},
      async (_args, ctx) => {
        const target = ctx.workflowTarget?.get(ctx.tabId) ?? { mode: "current" as const };
        return ok(target);
      },
    ),
    def(
      "panel_set_workflow_target",
      "Pin the agent to a specific open workflow tab (it must be the ACTIVE/in-view workflow at pin time), or release the pin to follow the user's current tab. The panel can only read or edit the workflow currently in view, so pinning to a background tab is REJECTED at pin time — to work on a different open workflow, switch to it first with panel_open_workflow (that makes it active), then pin. Pinning does NOT change the user's view; it binds your panel_* graph edits to that workflow and makes a later mismatch (e.g. the user switches away) fail loudly instead of silently editing the wrong graph. Set mode:'pinned' with path from panel_list_workflows; set mode:'current' (or omit path) to follow the active tab again. mode:'current' is ALSO the explicit RECOVERY signal: if your panel_* calls started failing with `no connected tab`, or with a `workflow instance mismatch` / out-of-sync-graph error, after ComfyUI reconnected, the panel reloaded, or the workflow on the canvas was switched or replaced, call this with mode:'current'. It rebinds this session onto the tab that's live now AND re-derives the workflow-instance fence your graph commands are stamped with from the panel's live active canvas — that second half is what clears an instance mismatch. It reports whether that actually worked: `graph_binding:\"bound\"` means graph tools are usable again, `\"reads_only\"` means reads work but mutations stay refused, `\"unverified\"` means the fence is set but readiness could not be confirmed (treat the next graph call as the test), and it FAILS (rather than reporting a hollow success) when the binding could not be restored, naming what to do instead.",
      {
        mode: z
          .enum(["current", "pinned"])
          .describe("'current' = follow the user's active workflow tab; 'pinned' = always edit the given path."),
        path: z
          .string()
          .optional()
          .describe("Workflow path/filename/key from panel_list_workflows — required when mode is 'pinned'."),
        filename: z.string().optional().describe("Optional display label for the pinned workflow."),
      },
      async (args: A, ctx) => {
        if (!ctx.workflowTarget) {
          return fail("Workflow targeting is not available in this session.");
        }
        const mode = args.mode === "pinned" ? "pinned" : "current";
        const path = typeof args.path === "string" ? args.path : undefined;
        const filename = typeof args.filename === "string" ? args.filename : undefined;
        if (mode === "pinned" && !(path ?? "").trim()) {
          return fail("Provide path when pinning — use panel_list_workflows to list open workflows.");
        }
        // mode:'current' is the explicit, user/agent-initiated "rebind me to the
        // tab that's live now" consent signal. Self-heal a session whose captured
        // tab id was orphaned (reconnect/reload/workflow-switch) BEFORE writing the
        // pin store, so subsequent panel_* calls route to the live tab. Surfaces a
        // clear error if a single active tab can't be determined.
        let rebindNote = "";
        let deferredBind = false;
        let fenceRebind: WorkflowFenceRebind | undefined;
        // panel#1292 — a scope ctx stays scope-bound, so ctx.tabId never changes
        // on a successful turn-pin recovery. Track that separately from the
        // real-tab rebind note below.
        let currentModeTurnRepinned = false;
        if (mode === "current" && ctx.rebindToActiveTab) {
          const before = ctx.tabId;
          const recoveringScope = isScopeAddress(before);
          // Hold the send() wait BEFORE the first await so a same-batch sibling
          // that already hit the null pin waits instead of minting #884.
          if (recoveringScope) ctx.bridge.beginScopeRecovery?.(before);
          const tryRebind = (deferIfNoTabs: boolean): ToolResult | undefined => {
            try {
              // mode:"current" is THE explicit scope-recovery consent (#884 gate 3)
              // — the only caller that may escape a DEAD scope pin (a healthy pin
              // still stays put; see rebindToActiveTab's double gate).
              const rebind = ctx.rebindToActiveTab!({ scopeRecoveryConsent: true });
              // #1077 Finding 2 — a scope repin that declined now says WHY.
              if (rebind?.repinRefusal && !/pin was NOT moved/.test(rebindNote)) {
                rebindNote += ` The session pin was NOT moved: ${rebind.repinRefusal}.`;
              }
              if (rebind?.rebound) currentModeTurnRepinned = true;
            } catch (err) {
              // #474: with 2+ live tabs the rebind is AMBIGUOUS — fail so the user picks.
              // But with ZERO tabs connected (the "Connected: none" window right after a
              // restart/reload where the old tmp: tab is gone) the recovery call must NOT
              // hard-fail: clear the stale binding and record the current-mode intent so
              // the session binds onto the tab the moment one reconnects, instead of
              // stranding the agent with no way to recover.
              const live = typeof ctx.bridge.tabs === "function" ? ctx.bridge.tabs() : undefined;
              let noTabsConnected: boolean;
              if (Array.isArray(live)) {
                // Count only INTERACTIVE (canvas-owning) tabs: a headless-only reconnect is
                // NOT a usable graph binding, so it defers (binds once a real canvas tab
                // connects) rather than failing as if a tab were pickable. Call isHeadless
                // THROUGH the bridge (it reads `this.conns`) — a detached reference would
                // lose `this` and throw "reading 'conns'" (the same #478 unbound-method bug).
                const isHeadlessTab = (id: string): boolean =>
                  typeof ctx.bridge.isHeadless === "function" && ctx.bridge.isHeadless(id);
                const interactive = live.filter((t) => !isHeadlessTab(t.tab_id));
                noTabsConnected = interactive.length === 0;
              } else {
                // No tab enumeration — classify by the resolve error: only "nothing
                // connected" defers; an AMBIGUOUS multi-tab error must still fail so the
                // user picks (never silently defer a routable-but-ambiguous session).
                const msg = err instanceof Error ? err.message : String(err ?? "");
                noTabsConnected =
                  /no panel connected|not reachable|connected:\s*none|no connected tab/i.test(msg) &&
                  !/multiple|last active|pass tab_id/i.test(msg);
              }
              if (!noTabsConnected) return fail(ambiguousRebindGuidance(ctx, err));
              // The first pass is BEFORE awaitReachable. Deferring here skipped the
              // wait, so a tab that reconnects mid-call (#474) was never adopted.
              if (!deferIfNoTabs) return undefined;
              deferredBind = true;
              rebindNote =
                " No panel tab is connected yet — cleared the stale binding; this session will " +
                "follow (bind onto) the tab as soon as one reconnects. Retry your graph tool in a " +
                "moment; if nothing reconnects shortly, ask the user to refresh (reload) the ComfyUI " +
                "browser tab, which reconnects the Agent panel after a restart (not an install issue).";
            }
            return undefined;
          };
          try {
            // panel#1292 hole 1 — recover the turn pin SYNCHRONOUSLY, before
            // awaitReachable yields to same-batch siblings.
            const failed = tryRebind(false);
            if (failed) return failed;
            // Give an in-flight reconnect (a ComfyUI restart / panel reload still
            // settling) a brief chance to bind immediately, since this IS the recovery
            // signal the agent reaches for in exactly that window (#474). awaitReachable
            // rebinds via ensureReachable when a tab is (re)connected.
            if (ctx.awaitReachable) await ctx.awaitReachable();
            // A first attempt that found no canvas (or a dead pin that is still
            // dead after the wait) gets one more recovery now that a tab may exist.
            const pinStillDead =
              typeof ctx.bridge.canReach === "function" && !ctx.bridge.canReach(ctx.tabId);
            if (!currentModeTurnRepinned && pinStillDead) {
              const failed2 = tryRebind(true);
              if (failed2) return failed2;
            }
          } finally {
            if (recoveringScope) ctx.bridge.endScopeRecovery?.(before);
          }
          // Detect the rebind regardless of whether awaitReachable or rebindToActiveTab
          // performed it (either mutates ctx.tabId), so the note is never swallowed.
          if (!deferredBind && ctx.tabId !== before) {
            // #934 — `.slice(0, 8)` renders EVERY `wf:workflows/…` tab as the
            // literal "wf:workf", so this note read "Rebound this session from
            // tab wf:workf onto the active tab wf:workf" for a rebind between two
            // DIFFERENT workflows. In the middle of a wedge whose entire question
            // was whether the retarget did anything, it read as a no-op.
            rebindNote = ` Rebound this session from tab ${shortTabId(before)} onto the active tab ${shortTabId(ctx.tabId)}.`;
          }
          if (currentModeTurnRepinned) {
            rebindNote +=
              ` This session's turn routing was AMBIGUOUS (a reconnect delivered messages from ` +
              `several workflows at once) and is now pinned to the active tab, so graph tools ` +
              `will resolve deterministically.`;
          }
        }
        // PIN: bind to the EXACT open-workflow identity from the authoritative
        // workflow_list, canonicalizing to its stable `key`, FAILING CLOSED when the
        // requested workflow isn't open (#259), and FAILING AT PIN TIME when it is open
        // but not the active canvas (#556/#571). Shared with the panel-driven event path
        // so both entry points validate identically.
        let pinPath = path;
        let pinFilename = filename;
        let pinnedWorkflowUuid: string | undefined;
        if (mode === "pinned" && path) {
          const res = await resolvePinTarget(ctx, path, filename);
          if (!res.ok) return fail(res.error);
          pinPath = res.pinPath;
          pinFilename = res.pinFilename;
          pinnedWorkflowUuid = res.workflowUuid;
        }
        const target = ctx.workflowTarget.set(ctx.tabId, {
          mode,
          path: pinPath,
          filename: pinFilename,
        });
        // #716 — a successful, positively-active re-pin is an explicit recovery
        // boundary after reconnect/open. Its UUID came from the same fresh
        // workflow_list result that validated the pin. Missing, malformed, or
        // indeterminate values leave the old command stamp intact (fail closed).
        if (mode === "pinned" && pinnedWorkflowUuid) {
          refreshWorkflowUuid(ctx, { workflow_uuid: pinnedWorkflowUuid });
        }
        // #888 — make the SCOPE PIN follow the named workflow.
        //
        // Pinning wrote the workflow-target store above and, until now, nothing
        // else. But after a mixed-origin turn the thing refusing every subsequent
        // scope-addressed command is a DIFFERENT piece of state — the turn-origin
        // pin, left ambiguous (`null`) by the #884 fence. So this tool reported
        // success truthfully while the actual blocker went untouched, and the next
        // `panel_graph_outline` returned the identical ambiguity error.
        //
        // The advice to do this is already in the code: the repin handler's own
        // refusal says "Name the workflow instead — panel_set_workflow_target with
        // a path, or panel_open_workflow — and the pin follows it." It did not
        // follow, because only `mode:"current"` ever reached that handler.
        //
        // Routed through the SAME handler, so the P0 safety gate is shared rather
        // than re-implemented: a pin that still reaches a live tab of this
        // conversation is never displaced, however explicit the request. This can
        // only ever recover a pin that is dead or ambiguous.
        //
        // Best-effort by construction: the pin store write above has already
        // succeeded and is what the caller asked for. A repin that cannot happen
        // must not retract it, so the outcome is reported, never thrown.
        let scopeRepin: ScopeRepinOutcome | undefined;
        if (mode === "pinned" && pinPath && isScopeAddress(ctx.tabId)) {
          // The PATH, never a tab id derived from it. `wf:<path>` is the saved
          // workflow HANDLE; a real tab id is a bridge ROUTE, `wf:<route>:<path>`
          // (panel #640). The first cut of this fix compared the handle against
          // routes, so it never matched and refused every time — inert, while a
          // source-text "wiring" assertion passed, because grepping for a call
          // cannot tell reachable code from dead code. The handler now does the
          // matching against the routes the bridge actually holds.
          try {
            scopeRepin = ctx.bridge.repinScopeToWorkflow?.(ctx.tabId, pinPath);
          } catch {
            scopeRepin = undefined; // never worse than the pre-#888 silence
          }
        }
        ctx.bridge.push({ type: "workflow_target", target }, ctx.tabId);
        // #770/#803/#716 — ROUTING is only half of "follow the tab that's live now".
        // rebindToActiveTab is a NO-OP whenever the bound tab is still REACHABLE, which
        // is the dominant wedge: the socket is fine, the canvas was replaced (or
        // re-registered) under it, and the command fence still names the workflow
        // instance that is gone. Re-derive the fence from the panel's live active record
        // so this call delivers the recovery its own documentation promises. Deferred
        // (zero-tab) sessions are skipped: there is nothing to read from yet, and their
        // note already says exactly that.
        //
        // ORDER MATTERS (codex gate): this round trip runs AFTER the target store write
        // and the panel push, never between the decision and the write. The store is
        // shared by every session bound to this tab (panel-mcp-http mounts one per
        // connection), so an await placed BEFORE the write would widen the window in
        // which a concurrent agent's later, successful pin can be clobbered by this
        // call's staler `current` — and that agent would have been told its edits were
        // pinned. The pre-existing awaitReachable/resolvePinTarget awaits already sit
        // ahead of the write; this change must not add another. It is also what makes
        // the failure text's "APPLIED (do not repeat this part)" literally true: the
        // target write is already committed and pushed by the time we can fail.
        if (mode === "current" && ctx.rebindToActiveTab && !deferredBind) {
          const tabBeforeProbe = ctx.tabId;
          fenceRebind = await rebindWorkflowFence(ctx);
          // The probe itself can MOVE this session (codex gate). `workflow_list` is
          // retry-safe, so a transient reconnect inside ctx.call sleeps, calls
          // ensureReachable — which may rebind ctx.tabId onto a different tab — and
          // retries there. The fence we just adopted then belongs to the NEW tab,
          // while the `mode:"current"` record we wrote belongs to the OLD one. If the
          // new tab already carries a PIN (ordinary with two agents on one machine),
          // the next graph command routes through that pin, and reporting "following
          // the user's current workflow tab" would name a state that is not the case.
          //
          // Do NOT silently overwrite the new tab's pin — that is someone else's
          // binding, and clobbering it is the very failure the ordering fix above
          // exists to prevent. Adopt the target onto the new tab only when doing so
          // takes nothing away (no entry, or already current); otherwise say plainly
          // what happened and hand back a call the caller can actually make.
          if (ctx.tabId !== tabBeforeProbe) {
            const onNewTab = ctx.workflowTarget.get(ctx.tabId);
            if (onNewTab?.mode === "pinned") {
              const pinLabel = onNewTab.filename ?? onNewTab.path;
              // Report the fence outcome from the actual status, never as a flat
              // "it was refreshed" (codex gate): the probe that moved us may also
              // have come back unreadable, identity-less, refused, or already
              // matching, and only one of those is a refresh.
              const fenceLine =
                fenceRebind.status === "refreshed"
                  ? `The graph command fence WAS refreshed onto this tab's live canvas (workflow instance ${fenceRebind.uuid}), which is correct for it either way.`
                  : fenceRebind.status === "already_current"
                    ? `The graph command fence already named this tab's live canvas, so it needed no change.`
                    : `The graph command fence was NOT established on this tab (${fenceRebind.status}) — so graph tools may also fail here with a workflow-instance mismatch, independently of the pin below.`;
              return fail(
                `panel_set_workflow_target({mode:"current"}) did NOT take effect on the tab this ` +
                  `session is now bound to.\n\nWHAT HAPPENED: the panel dropped mid-call, so this ` +
                  `session was rebound from tab ${tabBeforeProbe} onto tab ${ctx.tabId} while the ` +
                  `request was in flight. Your mode:"current" was recorded against the PREVIOUS ` +
                  `tab. The tab you are on now is PINNED to "${pinLabel}", and that pin was left ` +
                  `untouched — the workflow-target store is shared, so another session may own ` +
                  `it. ${fenceLine}\n\nWHAT TO DO — read this before retrying: graph tools will ` +
                  `currently target "${pinLabel}". If that is what you want, try one graph call ` +
                  `and let its outcome tell you whether the binding is usable. If you need to ` +
                  `follow the tab the user is viewing instead, calling ` +
                  `panel_set_workflow_target({mode:"current"}) again WILL REPLACE that pin — do ` +
                  `that only if the pin is yours. If it is not, or you cannot tell, ask the user ` +
                  `which workflow they want this session on rather than overwriting another ` +
                  `session's binding.`,
              );
            }
            // Nothing to take away — re-apply the caller's request where it now counts.
            const moved = ctx.workflowTarget.set(ctx.tabId, { mode: "current" });
            ctx.bridge.push({ type: "workflow_target", target: moved }, ctx.tabId);
            rebindNote += ` The panel dropped mid-call: this session moved from tab ${tabBeforeProbe} onto tab ${ctx.tabId}, and mode:"current" was applied there too.`;
          }
        }
        const hint =
          target.mode === "pinned"
            ? `Pinned to "${target.filename ?? target.path}". Graph tools will target that workflow without switching the user's view.`
            : "Following the user's current workflow tab.";
        // #803 — this used to END here for every mode:"current" call, with the
        // unconditional "Following the user's current workflow tab." Reporters followed
        // that as the documented recovery, read it as success, and stayed wedged. The
        // target write DID happen, so the outcome is DISCLOSED either way — never
        // retracted as if nothing had been applied — but when the graph binding was NOT
        // restored the result is an ERROR, because "your recovery worked" is the one
        // thing it must never say when it did not. The single exception is measured,
        // not inferred (panel#980, below): a fence the panel just ACCEPTED a stamped
        // read against, on a tab whose write capability is confirmed, was never
        // unrestored. `graph_binding` carries the same
        // verdict machine-readably, and `graph_binding_status` the specific cause, so a
        // caller never has to infer four different remedies from one sentence.
        // A stamp is necessary but not sufficient for a graph EDIT — the panel build
        // must also advertise the write-boundary fence. Ask that question separately
        // (codex gate) so `bound` never overstates a read-only panel. A ctx that
        // cannot answer leaves it undefined: an unknown, which downgrades nothing.
        // Prefer the TRI-STATE probe: the boolean one fails closed, so an
        // unreadable capability would be RENDERED as "your panel lacks the write
        // fence" — a claim about the panel built from our own failure to look
        // (codex gate). Only an OBSERVED negative may say that.
        let canMutateNow: boolean | undefined;
        let refusalCause: "unroutable" | "disconnected" | "no_identity" | "capability" | undefined;
        try {
          if (ctx.tabGraphMutationCapability) {
            const cap = ctx.tabGraphMutationCapability();
            canMutateNow = cap.known ? cap.canMutate : undefined;
            if (cap.known && !cap.canMutate) refusalCause = cap.because;
          } else {
            // The legacy boolean probe cannot say WHY, and guessing would put us
            // back where the tri-state started. Leave the cause undefined so the
            // narration falls back to the generic wording rather than inventing one.
            canMutateNow = ctx.tabCanMutateGraph?.();
          }
        } catch {
          canMutateNow = undefined; // a guard that can throw is not a guard
          refusalCause = undefined;
        }
        // #1043 (codex review) — NO version note on THIS path, deliberately.
        //
        // The note claims that on 0.11.45+ "the command that re-pointed the canvas
        // repairs the fence from its own reply and never makes this read". That is
        // true of panel_save_workflow and panel_new_workflow, which DO carry a
        // workflow_uuid on their reply. panel_set_workflow_target does not — it has
        // no own-reply uuid to gain, so updating the panel would NOT remove this
        // failure, and saying it would is a confident wrong remedy.
        //
        // A user may well have arrived here recovering from a save/new that hit the
        // gap — but arriving here does not establish that, and guessing which of
        // the two it was is exactly the kind of unearned claim this file exists to
        // avoid. The save/new paths say it at the moment it is provable.
        const fence = fenceRebind
          ? describeFenceRebind(fenceRebind, canMutateNow, refusalCause)
          : undefined;
        // panel#1292 hole 2 — `graph_binding:"bound"` is a fence verdict, not a
        // statement that the turn-origin pin was recovered. A null pin still
        // mints the #884 refusal on the next scope-addressed graph call.
        const turnPinStillAmbiguous = (): boolean =>
          isScopeAddress(ctx.tabId) &&
          typeof ctx.bridge.resolveFailure === "function" &&
          ctx.bridge.resolveFailure(ctx.tabId) === "ambiguous";
        const refuseBoundWhileAmbiguous = (): ToolResult =>
          fail(
            `panel_set_workflow_target({mode:"current"}) did NOT restore this session's turn ` +
              `routing.\n\nAPPLIED (do not repeat this part): the workflow target is now ` +
              `mode:"current"${rebindNote ? `.${rebindNote}` : "."}\n\nNOT APPLIED: the ` +
              `workflow-instance fence could be described as bound, but the turn-origin pin ` +
              `is still ambiguous, so the next graph call would fail with "issued from ` +
              `multiple workflows at once". Name a workflow with ` +
              `panel_set_workflow_target({mode:"pinned", path:...}) or wait for the next ` +
              `single-origin message.`,
          );
        // #1473 — TAKE THE ADVICE THIS MESSAGE GIVES, instead of assigning it as homework.
        //
        // The reporter restarted ComfyUI, called this, was told the binding was NOT
        // restored — and their very next `panel_graph_outline` succeeded with the expected
        // graph. #1401 already made the message right for this shape: when the panel's
        // reported identity MATCHES the fence this session already holds, it says so, says
        // it is NOT a claim that graph tools work, and prescribes a cheap graph read to
        // settle it. All true. It just left the caller to run that read themselves.
        //
        // So the read is taken here, on the matching-uuid path ONLY, and its ANSWER is put
        // in the message.
        //
        // THE RESULT below is decided by what the probe OBSERVED. #1401's call —
        // "softening the DIAGNOSIS must not soften the RESULT" — still holds for every
        // outcome but one: panel#980's recurrence showed that a settling read the fence
        // ACCEPTED, on a session whose write capability is likewise confirmed, is a
        // false negative wearing #1401's caution (the reporters' mutations succeeded
        // immediately after the error). That one shape flips to BOUND below, on the
        // exact gate #1473's discussion scoped — probe passed AND writes accepted.
        // Every other outcome keeps the failure, with the probe's answer inside it.
        let settledNote = "";
        let probePassed = false;
        if (fence && fence.binding === "not_recovered" && fence.settleByRead) {
          // WHAT THE PROBE PROVES, AND ONLY THAT (codex).
          //
          // Two ways to overclaim here, and the first version did both:
          //
          //  • EVERY error read as "refused". `ctx.call` turns a transport failure into an
          //    error result too, so a `graph_query` that merely TIMED OUT on a backgrounded
          //    tab would have been reported as a confirmed fence refusal — inventing a wedge
          //    out of a slow tab, and contradicting this block's own "unknown says nothing"
          //    rule. Only an actual instance-mismatch refusal proves the fence rejected it.
          //  • A passing READ read as "graph tools work". The write fence is a SEPARATE
          //    capability: a panel can serve reads while refusing every mutation, and the
          //    capability probe above already knows. So the claim is scoped to reads, and the
          //    known-negative write case is stated rather than papered over.
          let probeRefused: boolean | undefined;
          let probeOk = false;
          try {
            // The cheapest fenced read there is: ids only, one row. It is refused by the
            // same instance fence every graph command carries, which is exactly the
            // question — a full outline would answer it no better and would cost the caller
            // a page of graph on a recovery path.
            const probe = await ctx.call({ cmd: "graph_query", fields: "ids", limit: 1 }, 8000);
            if (!probe.isError) probeOk = true;
            else probeRefused = isWorkflowInstanceMismatch(toolResultText(probe));
          } catch (err) {
            probeRefused = isWorkflowInstanceMismatch(err);
          }
          if (probeOk) {
            probePassed = true;
            settledNote =
              // ONE OBSERVATION, STATED AS ONE (codex r2). A passing graph_query proves that
              // read passed this fence just now — not that every command will, and not that
              // the cause "was" a race. The earlier wording generalised to "READS work" and
              // asserted the cause outright, which is the same overclaim this reply exists to
              // stop making.
              `

CHECKED FOR YOU: the graph read this message prescribes was just run — a ` +
              `graph_query against this fence — and it SUCCEEDED. So the fence did not reject ` +
              `THAT command a moment ago, which is the single fact this settles: it is evidence ` +
              `of a reconciliation race after the reconnect rather than a broken binding, not a ` +
              `guarantee about the next command.` +
              (canMutateNow === false
                ? ` MUTATIONS are a separate matter and remain refused on this tab — that is the ` +
                  `write-fence capability above, not the binding, and re-running this will not ` +
                  `change it.`
                : ` Nothing suggests a recovery step is needed for the binding; the next graph ` +
                  `command is still the authority.`) +
              ` (The rebind itself still did not happen, and with graph EDITS not confirmed ` +
              `on this tab the result stays a failure.)`;
          } else if (probeRefused === true) {
            settledNote =
              `

CHECKED FOR YOU: the graph read this message prescribes was just run, and it ` +
              `was REFUSED by the instance fence — so the reply was stale after all and graph ` +
              `commands really are being rejected. The remedy above applies.`;
          }
          // Anything else — a timeout, a dropped tab, an error that is not a fence refusal —
          // settles NOTHING and says nothing. An inconclusive probe must not become evidence
          // in either direction.
        }
        if (fence && fence.binding === "not_recovered") {
          // panel#980 — the flip #1473 left open, on the gate its discussion scoped.
          // The rebind genuinely did not happen — but on this shape nothing NEEDED
          // to: the fence this session already holds was just proven live twice over.
          // The identity the panel reported equals it, and a read stamped with it was
          // ACCEPTED by the panel — the binding-health question itself, measured
          // rather than inferred. Reporting that as "did NOT restore the graph
          // binding" is the false negative the recurrences kept hitting. The write
          // half is not waved through on the read: BOUND requires canMutateNow ===
          // true, so a read-only or unknown-capability panel keeps the failure below.
          if (probePassed && canMutateNow === true) {
            // fenceStillMatches guarantees a held uuid, but read it defensively: a
            // missing value must degrade to an unnamed fence, never print "undefined".
            const heldUuid =
              fenceRebind && fenceRebind.status === "no_identity" && fenceRebind.before.known
                ? fenceRebind.before.uuid
                : undefined;
            if (turnPinStillAmbiguous()) return refuseBoundWhileAmbiguous();
            return ok({
              ...target,
              graph_binding: "bound",
              ...(fenceRebind ? { graph_binding_status: fenceRebind.status } : {}),
              ...(currentModeTurnRepinned ? { turn_routing: "repinned" } : {}),
              note:
                hint +
                rebindNote +
                ` The graph binding was NOT re-derived (the panel's active reply could ` +
                `not be corroborated, so nothing was adopted) — and it did not need to ` +
                `be: the identity the panel reported equals the fence this session ` +
                `already holds${heldUuid ? ` (${heldUuid})` : ""}, and a graph read ` +
                `stamped with that fence was just run ` +
                `and ACCEPTED by the panel. That acceptance is the binding-health ` +
                `question itself, so this session is reported BOUND: graph reads pass ` +
                `this fence, and the write-fence capability probe reports this tab ` +
                `accepting edits. The proof is one read a moment ago — if the user ` +
                `switched tabs in the instant since, the next graph command fails ` +
                `closed with a fresh instance mismatch, safe and cleared by calling ` +
                `this again.`,
            });
          }
          return fail(
            `panel_set_workflow_target({mode:"current"}) did NOT restore this session's graph ` +
              `binding.\n\nAPPLIED (do not repeat this part): the workflow target is now ` +
              `mode:"current"${rebindNote ? `.${rebindNote}` : "."}\n\nNOT APPLIED:${fence.note}${settledNote}`,
          );
        }
        // #888 — SAY what the scope repin did. A silent success is as unhelpful
        // here as the silent refusal #1077 fixed: the whole complaint is that
        // pinning reported success while routing stayed ambiguous, so "the routing
        // ambiguity is cleared" is the one fact that makes this reply actionable.
        // A refusal carries its own reason out for the same reason.
        const scopeRepinNote =
          typeof scopeRepin === "string"
            ? ` This session's turn routing was AMBIGUOUS (a reconnect delivered messages from several workflows at once) and is now pinned to this workflow, so graph tools will resolve deterministically.`
            : scopeRepin && typeof scopeRepin === "object" && scopeRepin.reason
              ? ` NOTE — the workflow target was set, but this session's turn routing was NOT re-pinned: ${scopeRepin.reason}.`
              : "";
        if (fence?.binding === "bound" && turnPinStillAmbiguous()) {
          return refuseBoundWhileAmbiguous();
        }
        return ok({
          ...target,
          ...(deferredBind ? { deferred: true } : {}),
          ...(fence ? { graph_binding: fence.binding } : {}),
          ...(fenceRebind ? { graph_binding_status: fenceRebind.status } : {}),
          ...(typeof scopeRepin === "string" || currentModeTurnRepinned
            ? { turn_routing: "repinned" }
            : {}),
          note: hint + rebindNote + (fence?.note ?? "") + scopeRepinNote,
        });
      },
    ),
    def(
      "panel_new_workflow",
      "Open a brand-new BLANK workflow in a NEW TAB. Use this whenever the user wants a 'new workflow' / 'fresh canvas' / 'start over for a new project'. This does NOT touch their current workflow — it opens a separate tab. NEVER use panel_clear for a new workflow (panel_clear wipes the CURRENT graph and is only for 'clear/reset this canvas').",
      {},
      async (_args, ctx) => {
        const res = await ctx.call({ cmd: "workflow_new" }, 15000);
        if (res.isError) return res;
        // #932 (recurrence on 0.50.6) — a NEW canvas needs a NEW fence.
        //
        // workflow_new authoritatively re-points the active workflow, exactly as
        // workflow_open does — but only the open path re-derived the command
        // fence afterwards (openWorkflowWithVerify). So this session kept the
        // PREVIOUS workflow's instance stamp while the user was now looking at a
        // brand-new blank canvas, and every stamped command after it failed with
        // "workflow instance mismatch". The reporter created a workflow and could
        // not add a single node to it.
        //
        // Refresh from the panel's own live active record, the same way the open
        // path does. The panel mints the new canvas's identity EAGERLY at
        // creation ("so the key exists BEFORE the first edit").
        //
        // #814/#812 — this reply DOES carry workflow_uuid directly (#762), and the
        // stale comment that used to stand here said otherwise. Trust it first,
        // before ever attempting rebindWorkflowFence's independent workflow_list
        // round trip, which can be refused by the exact fence being repaired
        // (#1071) — the same trap a reporter hit via panel_new_workflow's own
        // recovery attempt.
        //
        // NEVER fails the call on a rebind miss: the workflow WAS created, and
        // retracting that would be the worse lie. Disclose instead, so the agent
        // learns the graph tools are not yet usable here rather than discovering
        // it one confusing mismatch at a time.
        const fenceRebind = refreshFenceFromOwnReply(ctx, res) ?? (await rebindWorkflowFence(ctx));
        let canMutateNow: boolean | undefined;
        let refusalCause: "unroutable" | "disconnected" | "no_identity" | "capability" | undefined;
        try {
          if (ctx.tabGraphMutationCapability) {
            const cap = ctx.tabGraphMutationCapability();
            canMutateNow = cap.known ? cap.canMutate : undefined;
            if (cap.known && !cap.canMutate) refusalCause = cap.because;
          } else {
            canMutateNow = ctx.tabCanMutateGraph?.();
          }
        } catch {
          canMutateNow = undefined; // a guard that can throw is not a guard
          refusalCause = undefined;
        }
        const fence = describeFenceRebind(fenceRebind, canMutateNow, refusalCause, panelTooOldNote(ctx));
        if (!fence || fence.binding === "bound") return res;
        return appendNote(
          res,
          `The blank workflow WAS created.${fence.note}`,
        );
      },
    ),
    def(
      "panel_open_workflow",
      "Open / switch to a workflow by path or filename (from panel_list_workflows). Switches the active tab to it. If the workflow was ALREADY open and its .json changed on disk out-of-band, the result carries stale:true (or stale:\"unknown\" when staleness couldn't be verified) with a stale_hint — the canvas still shows the version this tab loaded (it is NOT auto-reloaded); call panel_load_workflow to load the on-disk version.",
      { path: z.string().describe("Workflow path, filename, or key from panel_list_workflows.") },
      // Verify-after-timeout (#215/#319/#496): a backgrounded/frozen or already-open
      // tab can be slow to ack workflow_open even though the switch succeeded. On an
      // ack-timeout, confirm via the authoritative workflow_list active identity
      // before reporting failure — see openWorkflowWithVerify.
      async (args: A, ctx) => openWorkflowWithVerify(args.path as string, ctx),
    ),
    def(
      "panel_rename_workflow",
      "Rename a workflow (the active one, or the one matching `path`).",
      {
        name: z.string().describe("New name (no .json needed)."),
        path: z.string().optional().describe("Which workflow to rename; omit for the active one."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "workflow_rename", name: args.name, path: args.path }, 15000),
    ),
    def(
      "panel_close_workflow",
      "Close a workflow tab (the active one, or the one matching `path`). Refuses if it has unsaved changes unless force:true — save first to avoid losing the user's work.",
      {
        path: z.string().optional().describe("Which workflow to close; omit for the active one."),
        force: z.boolean().optional().describe("Close even with unsaved changes (discards them). Default false."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "workflow_close", path: args.path, force: args.force }, 15000),
    ),
    def(
      "panel_select_nodes",
      "Select nodes on the user's canvas by id (highlights them, sets the multi-selection). Useful before panel_create_subgraph.",
      { node_ids: z.array(nodeId()).describe("Node ids to select.") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_select_nodes", node_ids: args.node_ids }),
    ),
    def(
      "panel_create_subgraph",
      "Group the given nodes into a SUBGRAPH (ComfyUI 'Convert to Subgraph') on the user's canvas — collapses them into one subgraph node. Returns the new subgraph node id. Undoable with Ctrl+Z. To wrap an existing GROUP, prefer panel_subgraph_group (you don't have to list the node_ids yourself).",
      { node_ids: z.array(nodeId()).describe("Node ids to group into a subgraph.") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_create_subgraph", node_ids: args.node_ids }, 15000),
    ),
    def(
      "panel_subgraph_group",
      "Wrap an existing GROUP's nodes into ONE subgraph node in a single step — the clean way to refactor a big graph into readable, TOGGLEABLE units. Pass the group by `group` (its title, e.g. 'REPLACEMENT MODE', or its numeric id from panel_query_graph's groups[]). LiteGraph groups don't own nodes — membership is geometric — so this computes which nodes sit inside the group box, selects them, and collapses them via ComfyUI 'Convert to Subgraph', returning the new subgraph node id + the wrapped node ids. After this you can toggle that whole region as ONE unit: panel_set_node_mode(node_id, 'bypass'/'active') on the subgraph node, then panel_run — e.g. queue one run with the region ON and one with it OFF. Undoable with Ctrl+Z. (For an arbitrary set of nodes that isn't a group, use panel_create_subgraph with explicit node_ids.)",
      {
        group: z
          .union([z.string(), z.number()])
          .describe(
            "Group to wrap: its title (case-insensitive substring, e.g. 'replacement mode') or its numeric id from panel_query_graph groups[].id.",
          ),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_subgraph_group", group: args.group }, 15000),
    ),
    def(
      "panel_copy_nodes",
      "Copy nodes from the user's open graph to the clipboard. Pass node_ids to copy those nodes (they're selected first), or omit to copy the current canvas selection. The clipboard PERSISTS across workflow switches, so this is how you MERGE one workflow into another: copy here, then panel_open_workflow/panel_new_workflow to the destination, then panel_paste_nodes. Returns {copied: count}.",
      {
        node_ids: z
          .array(z.number().int())
          .optional()
          .describe("Node ids to copy. Omit to copy the current selection."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_copy_nodes", node_ids: args.node_ids }, 15000),
    ),
    def(
      "panel_paste_nodes",
      "Paste the clipboard (from a prior panel_copy_nodes) onto the user's CURRENTLY OPEN graph — including a graph in a DIFFERENT workflow, which is how you merge/compose workflows. Returns the NEW node ids so you can wire or organize them. connect_inputs:false (default) pastes a disconnected copy; pos sets where the paste lands. Undoable with Ctrl+Z.",
      {
        pos: xy().optional().describe("Canvas [x, y] anchor for the paste. Auto-placed when omitted."),
        connect_inputs: z
          .boolean()
          .optional()
          .describe("Reconnect pasted nodes' inputs to existing nodes where they line up (default false)."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_paste_nodes", pos: args.pos, connect_inputs: args.connect_inputs }, 15000),
    ),
    def(
      "panel_save_subgraph",
      "Save a SUBGRAPH node to the user's reusable blueprint LIBRARY (publish), so it can be dropped into any workflow later. Pass node_id to pick the subgraph node (else a single selected subgraph node is used) and name to title the blueprint (defaults to the node's title). Runs programmatically — NO save dialog pops. The blueprint becomes the addable type 'SubgraphBlueprint.<name>' (use panel_add_subgraph or panel_list_subgraphs). Returns {saved: {name, type}}.",
      {
        node_id: nodeId().optional().describe("Subgraph node id to publish (is_subgraph=true). Omit to use the selected subgraph node."),
        name: z.string().optional().describe("Blueprint name. Defaults to the subgraph node's title."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_save_subgraph", node_id: args.node_id, name: args.name }, 20000),
    ),
    def(
      "panel_list_subgraphs",
      "List the saved subgraph BLUEPRINTS in the user's library (from panel_save_subgraph, plus any global/bundled ones). Each entry has {name, type, display_name, description, is_global} — use name/type with panel_add_subgraph to drop it onto the canvas. Read-only.\n\nTOKEN-BOUNDED like the other reads (panel#690). The reply's count field is always the LIBRARY TOTAL, so compare it against the returned array. When entries are withheld the reply carries truncated:true, a returned field, and a note — an absent entry in a TRUNCATED list is NOT evidence the blueprint does not exist, so narrow with `filter` (or raise `limit`, up to 500) before concluding anything. When a filter is applied the reply's matched field reports how many the filter selected, distinct from the count field, so matched:0 against a non-zero count means the filter missed, not that the library is empty.",
      {
        filter: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring matched against the blueprint's name, display name AND description. Use this rather than a bigger limit when you know roughly what you want.",
          ),
        limit: z
          .number()
          .optional()
          .describe(
            "Maximum entries to return (default 40, max 500). A value <= 0 or non-numeric falls back to the default rather than returning nothing.",
          ),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_list_subgraphs", filter: args.filter, limit: args.limit }, 15000),
    ),
    def(
      "panel_add_subgraph",
      "Add a saved subgraph blueprint (from panel_list_subgraphs) onto the user's open graph by name (or full 'SubgraphBlueprint.<name>' type). This is how you REUSE a built subgraph in another workflow. pos places it; auto-placed when omitted. Returns the added subgraph node. Undoable with Ctrl+Z.",
      {
        name: z.string().describe("Blueprint name or type from panel_list_subgraphs."),
        pos: xy().optional().describe("Canvas [x, y]. Auto-placed beside existing nodes when omitted."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_add_subgraph", name: args.name, pos: args.pos }, 20000),
    ),
    def(
      "panel_create_group",
      "Create a labeled GROUP box (the colored rectangle that visually frames a region) on the user's open graph. This is the lightweight organizer, DISTINCT from a subgraph (which nests/hides nodes) — a group just draws a titled box around nodes, leaving them in place. Pass node_ids to auto-size the box around those nodes, or bounds [x, y, width, height] for an explicit box. Optional color (hex like '#3f789e') and title. Returns the new group's id. Undoable with Ctrl+Z.",
      {
        title: z.string().optional().describe("Group label shown on the box header."),
        node_ids: z
          .array(z.number().int())
          .optional()
          .describe("Wrap these nodes — the box is auto-sized (with padding) around them."),
        bounds: rect()
          .optional()
          .describe("Explicit [x, y, width, height] (four numbers). Ignored if node_ids is given."),
        color: z.string().optional().describe("Box/header color, e.g. '#3f789e'."),
        font_size: z.number().optional().describe("Title font size (default 24)."),
      },
      async (args: A, ctx) =>
        ctx.call(
          {
            cmd: "graph_create_group",
            title: args.title,
            node_ids: args.node_ids,
            bounds: args.bounds,
            color: args.color,
            font_size: args.font_size,
          },
          15000,
        ),
    ),
    def(
      "panel_move_group",
      "Move a group box to a new top-left [x, y] on the user's open graph. By default the nodes inside the group move with it (like dragging the group header); pass move_nodes:false to move only the box. Group id comes from panel_query_graph (the `groups` array on every result) or panel_create_group. Undoable.",
      {
        group_id: z.number().int().describe("Group id from panel_query_graph's groups[] / panel_create_group."),
        pos: xy().describe("New top-left [x, y] (two numbers)."),
        move_nodes: z.boolean().optional().describe("Move the contained nodes too (default true)."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_move_group", group_id: args.group_id, pos: args.pos, move_nodes: args.move_nodes }),
    ),
    def(
      "panel_edit_group",
      "Edit a group box: its title, color, font_size, and/or bounds [x, y, width, height]. Only the fields you pass are changed. Undoable.",
      {
        group_id: z.number().int().describe("Group id from panel_query_graph's groups[] / panel_create_group."),
        title: z.string().optional().describe("New label."),
        color: z.string().optional().describe("New box/header color, e.g. '#3f789e'."),
        font_size: z.number().optional().describe("New title font size."),
        bounds: rect()
          .optional()
          .describe("Resize/reposition the box: [x, y, width, height] (four numbers)."),
      },
      async (args: A, ctx) =>
        ctx.call(
          {
            cmd: "graph_edit_group",
            group_id: args.group_id,
            title: args.title,
            color: args.color,
            font_size: args.font_size,
            bounds: args.bounds,
          },
          15000,
        ),
    ),
    def(
      "panel_remove_group",
      "Remove a group box from the user's open graph. The nodes inside the group are NOT deleted — only the box. Undoable.",
      { group_id: z.number().int().describe("Group id from panel_query_graph's groups[] / panel_create_group.") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_remove_group", group_id: args.group_id }, 15000),
    ),
    def(
      "panel_set_node_title",
      "Compatibility wrapper for panel_edit_node(title).",
      { node_id: nodeId(), title: z.string() },
      async (args: A, ctx) => ctx.call({ cmd: "graph_set_title", node_id: args.node_id, title: args.title }, 15000),
    ),
    def(
      "panel_set_node_collapsed",
      "Compatibility wrapper for panel_edit_node(collapsed).",
      { node_id: nodeId(), collapsed: z.boolean().optional() },
      async (args: A, ctx) => ctx.call({ cmd: "graph_set_node_collapsed", node_id: args.node_id, collapsed: args.collapsed ?? true }),
    ),
    def(
      "panel_set_node_mode",
      "Set a node's EXECUTION MODE on the user's open graph — active, bypass, or mute — and return { node_id, mode, previous_mode }. This is how you turn a node ON or OFF without deleting it. Modes:\n" +
        "• 'active' — normal: the node executes.\n" +
        "• 'bypass' — the node is SKIPPED and PASSES ITS INPUT THROUGH to its output (downstream still runs, just as if this node weren't there). Use to disable a single processing node (an upscaler, a LoRA, a detailer) while keeping the pipeline connected.\n" +
        "• 'mute' — the node AND everything DOWNSTREAM of it do NOT execute (no pass-through). Use to fully switch off a branch/output.\n" +
        "CRITICAL — modes silently change what a render produces, so they are a top cause of 'wrong output'. A BYPASSED node contributes nothing of its own and a MUTED node kills its branch. Use this tool to ENABLE the path you actually want and DISABLE the one you don't — e.g. to drive a workflow from its Ideogram/JSON prompt builder you must set the manual-prompt node to 'bypass' and the JSON-builder path to 'active' (or vice-versa); likewise to pick one branch of an rgthree 'Fast Groups Bypasser'/Muter or a prompt-source switch. ALWAYS read modes first (panel_graph_outline marks [bypass]/[mute]; panel_query_graph detail rows carry mode): if the intended path is bypassed/muted, fix it HERE before running, and never assume a switch/route is already active. UNSAFE-BYPASS GUARD: bypassing a SUBGRAPH node whose boundary inputs are ordered differently from its outputs is REJECTED — ComfyUI forwards each output from the input at the SAME index, so e.g. an IMAGE output backed by a BBOX_DETECTOR input would silently feed the wrong type downstream. Re-order the boundary inputs or add an explicit ImpactSwitch to choose the passthrough; pass force:true only if you truly intend the positional forward. Undoable with Ctrl+Z.",
      {
        node_id: nodeId().describe("Node id from panel_graph_outline / panel_query_graph."),
        mode: z
          .enum(["active", "bypass", "mute"])
          .describe(
            "'active' = runs normally; 'bypass' = skipped, passes input through (downstream still runs); 'mute' = node and everything downstream do not execute.",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Override the unsafe-bypass guard on a subgraph node (proceed with a positional boundary forward even when input/output types don't line up by index). Omit for normal safe behaviour.",
          ),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_set_node_mode", node_id: args.node_id, mode: args.mode, force: args.force }),
    ),
    def(
      "panel_set_node_color",
      "Legacy color compatibility wrapper. Unlike panel_edit_node, color and bgcolor accept any CSS color string; when preset is supplied it wins over explicit colors, preserving the historical bridge behavior.",
      {
        node_id: nodeId(),
        preset: z.enum(["red", "brown", "green", "blue", "pale_blue", "cyan", "purple", "yellow", "black"]).nullable().optional(),
        color: z.string().nullable().optional(),
        bgcolor: z.string().nullable().optional(),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_set_node_color", node_id: args.node_id, preset: args.preset, color: args.color, bgcolor: args.bgcolor }),
    ),
    def(
      "panel_screenshot",
      "SCREENSHOT the canvas to a PNG IMAGE — pixels, for when the question is VISUAL: overlaps, alignment, rails, colors, group bands. To READ what is on the canvas as text (ids, types, widget values, wiring) use panel_graph_outline instead; an image cannot be searched or quoted. Renders the workflow the user is currently viewing (root graph, or the open subgraph): frames the whole graph (nodes + groups), captures, then restores the user's view. Use it to verify a layout you just built instead of reasoning from coordinates alone.",
      { padding: z.number().optional().describe("Margin around the graph in px (default 60).") },
      async (args: A, ctx) => {
        try {
          ctx.ensureReachable?.();
          // Route to the same authoritative target as ctx.call: a pinned session
          // screenshots the PINNED workflow (via injected workflow_path), not just
          // whatever tab is visible (codex — graph_* must carry the pin).
          const target = ctx.workflowTarget?.get(ctx.tabId);
          const cmd = withWorkflowTarget(
            // #694: panel_screenshot is view-only — OUTSIDE the retry map — so it
            // never carries the token (a ledger answer for a read is a STALE
            // outcome), and the withRetryToken wrapper can't reach this direct send.
            { cmd: "graph_screenshot", padding: args.padding },
            target ?? { mode: "current" },
          );
          const res = (await ctx.bridge.send(cmd as { cmd: string }, {
            tabId: ctx.tabId,
          })) as {
            image?: string;
            mimeType?: string;
          };
          if (!res?.image) return fail("screenshot returned no image");
          const content: Array<
            | { type: "image"; data: string; mimeType: string }
            | { type: "text"; text: string }
          > = [{ type: "image", data: res.image, mimeType: res.mimeType ?? "image/png" }];
          // A canvas capture cannot show DOM-overlay widget content (MarkdownNote
          // text renders as an empty body) — flag any such node in view so the
          // agent doesn't read the blank body as missing content (#567). Best-effort:
          // the note is skipped silently if the graph can't be serialized.
          const overlayNodes = await domOverlayNodesInView(ctx);
          const overlayNote = domOverlayScreenshotNote(overlayNodes);
          if (overlayNote) content.push({ type: "text", text: overlayNote });
          return { content };
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_enter_subgraph",
      "Navigate INTO a subgraph node so you can read and EDIT its inner nodes — after this, panel_query_graph / panel_graph_outline and all panel_* edit tools target the subgraph's inner graph (the user sees the canvas drill in). This is how you edit inside a subgraph (e.g. tweak a widget on an inner node). Call panel_exit_subgraph when done. Returns the new viewing scope.",
      { node_id: nodeId().describe("Subgraph node id (is_subgraph=true).") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_enter_subgraph", node_id: args.node_id }, 15000),
    ),
    def(
      "panel_exit_subgraph",
      "Leave the current subgraph and return to the root graph (undo a panel_enter_subgraph). After this, panel_* tools target the root graph again.",
      {},
      async (_args, ctx) => {
        const res = await ctx.call({ cmd: "graph_exit_subgraph" }, 15000);
        // #1468 — ONLY a no-reply is settled by a read. A genuine executor error
        // (the panel's own "could not confirm … no observation ever saw the canvas
        // there") is an ACKED reply the bridge received and relayed; it already
        // reasoned about this exact uncertainty and prescribes its own next step,
        // so re-deciding it from out here would overwrite a better-informed verdict
        // with a worse-informed one.
        if (!isReplyTimeoutResult(res)) return res;
        return settleExitSubgraphAfterAckTimeout(ctx, res);
      },
    ),
    def(
      "panel_move_rail",
      "Reposition a subgraph's input or output RAIL (the boundary I/O node that the inner wires connect to). You MUST be INSIDE the subgraph first (panel_enter_subgraph). Read current rail positions from panel_query_graph's `rails` field (present when viewing a subgraph). Use this to place the input rail just left of the first node column and the output rail just right of the last one, so a tidy interior layout doesn't leave the rails stranded. rail is 'input' or 'output'.",
      {
        rail: z.enum(["input", "output"]).describe("Which boundary rail to move."),
        pos: xy().describe("New top-left [x, y] (two numbers)."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_move_rail", rail: args.rail, pos: args.pos }),
    ),
    def(
      "panel_promote_widget",
      "Expose (promote) an INNER subgraph widget on the PARENT subgraph node, so it can be set from outside without opening the subgraph — e.g. surface an inner KSampler's `seed`/`steps` on the subgraph node. You MUST be inside the subgraph first (call panel_enter_subgraph): `node_id` is an inner node (from panel_query_graph while inside) and `widget` is one of its widget names. Pass demote:true to un-promote. Undoable with Ctrl+Z.",
      {
        node_id: nodeId().describe("Inner node id (from panel_query_graph while inside the subgraph)."),
        widget: z.string().describe("Name of the widget on that node to promote (e.g. 'seed', 'steps', 'text')."),
        demote: z.boolean().optional().describe("Set true to UN-promote (remove the widget from the parent node)."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_promote_widget", node_id: args.node_id, widget: args.widget, demote: args.demote }, 15000),
    ),
    def(
      "panel_expose_subgraph_output",
      "Wire an interior node's OUTPUT to the subgraph's OUTPUT RAIL — i.e. expose it as a SUBGRAPH OUTPUT on the boundary so the PARENT graph can connect to the subgraph node's new output slot. You MUST be INSIDE the subgraph first (panel_enter_subgraph). This is the correct way to \"wire an internal output to the subgraph's output rail\": do NOT panel_connect to a guessed rail node id — call this with the interior node + the output you want exposed. Read panel_query_graph's `rails` to see the resulting boundary slots. `from_output` is an output slot NAME ('IMAGE', 'LATENT') or numeric index. Optional `name` titles the new boundary output (defaults from the source slot) — but it is IGNORED when this slot is ALREADY exposed: the call then returns the existing boundary output unchanged, with `reused:true` and its ORIGINAL `name`. Check `reused` before relying on the name you asked for — there is currently NO tool that renames an existing boundary slot, so a name is only applied on FIRST exposure. Undoable with Ctrl+Z.",
      {
        from_node_id: nodeId().describe("Interior (inner) node id whose output to expose (from panel_query_graph while inside the subgraph)."),
        from_output: slotRef.describe("Output slot name (e.g. 'IMAGE', 'LATENT') or numeric index on that node."),
        name: z.string().optional().describe("Optional name for the new subgraph output (boundary slot). Defaults from the source slot. IGNORED when the slot is already exposed — the reply carries reused:true and the existing name."),
      },
      async (args: A, ctx) =>
        ctx.call(
          {
            cmd: "graph_expose_subgraph_output",
            from_node_id: args.from_node_id,
            from_output: args.from_output,
            name: args.name,
          },
          15000,
        ),
    ),
    def(
      "panel_expose_subgraph_input",
      "Wire an interior node's INPUT to the subgraph's INPUT RAIL — i.e. expose it as a SUBGRAPH INPUT on the boundary so the PARENT graph can feed the subgraph node's new input slot. You MUST be INSIDE the subgraph first (panel_enter_subgraph). This is the correct way to wire an internal input to the subgraph's input rail: do NOT panel_connect to a guessed rail node id — call this with the interior node + the input you want exposed. Read panel_query_graph's `rails` to see the resulting boundary slots. `to_input` is an input slot NAME ('model', 'pixels') or numeric index. Optional `name` titles the new boundary input (defaults from the target slot) — but it is IGNORED when this slot is ALREADY exposed: the call then returns the existing boundary input unchanged, with `reused:true` and its ORIGINAL `name`. Check `reused` before relying on the name you asked for — there is currently NO tool that renames an existing boundary slot, so a name is only applied on FIRST exposure. Undoable with Ctrl+Z.",
      {
        to_node_id: nodeId().describe("Interior (inner) node id whose input to expose (from panel_query_graph while inside the subgraph)."),
        to_input: slotRef.describe("Input slot name (e.g. 'model', 'pixels') or numeric index on that node."),
        name: z.string().optional().describe("Optional name for the new subgraph input (boundary slot). Defaults from the target slot. IGNORED when the slot is already exposed — the reply carries reused:true and the existing name."),
      },
      async (args: A, ctx) =>
        ctx.call(
          {
            cmd: "graph_expose_subgraph_input",
            to_node_id: args.to_node_id,
            to_input: args.to_input,
            name: args.name,
          },
          15000,
        ),
    ),
    def(
      "panel_unpack_subgraph",
      "EXPAND / DISSOLVE a subgraph node on the user's open graph — inline its interior nodes back into the PARENT graph, rewire all external links to those now-inlined nodes, and remove the subgraph wrapper. This is the frontend's \"Unpack Subgraph\" (litegraph LGraph.unpackSubgraph) and the exact INVERSE of panel_create_subgraph. Use it to flatten a stage that was over-nested, or to edit interior nodes directly at the parent level. The interior nodes reappear on the parent canvas with their connections preserved. Undoable with Ctrl+Z.",
      { node_id: nodeId().describe("Subgraph node id to unpack/dissolve (is_subgraph=true, from panel_graph_outline / panel_query_graph).") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_unpack_subgraph", node_id: args.node_id }, 15000),
    ),
    def(
      "panel_search_nodes",
      "Search installable custom-node packs via the user's BUILT-IN ComfyUI Manager (the same source the Manager UI uses). Returns matching packs {id, title, description}. Use the `id` with panel_install_node. Prefer this over the headless search_custom_nodes tool — it works against the user's actual (Desktop) Manager. If Manager's cache mappings endpoint returns HTTP 5xx, this retries remote/local and still searches; a remaining 5xx is a Manager outage, not proof the pack is missing.",
      { query: z.string().describe("Search text, e.g. 'kjnodes', 'controlnet', 'ipadapter'."), limit: z.number().int().min(1).max(40).optional().describe("Max results to return, 1-40 (default 15). Requests above 40 are refused; the panel also clamps to 40 and discloses limit_cap.") },
      async (args: A, ctx) => {
        // #1669 — the panel asks getmappings?mode=cache and used to fail the
        // whole search on HTTP 500. Degrade: retry remote/local, or name the
        // 500 as a Manager outage (not a missing pack).
        const query = String(args.query ?? "");
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const out = await searchPanelNodes({
          panelSearch: () => ctx.call({ cmd: "nodes_search", query, limit }, 20000),
          query,
          limit,
        });
        return out.via === "panel" ? (out.value as ToolResult) : ok(out.value);
      },
    ),
    def(
      "panel_list_nodes",
      "List the custom-node packs currently installed in the user's ComfyUI (via the built-in Manager). Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "nodes_list" }, 20000),
    ),
    def(
      "panel_install_node",
      "Install a custom-node pack into the user's ComfyUI via the BUILT-IN Manager (queues the install). Pass `id` (registry id like 'comfyui-kjnodes' or 'author/repo') from panel_search_nodes, or `repository` (git URL) to request a nightly/from-source install — see the v4 limit below before relying on it. A search result whose `id` IS a git URL (legacy/repository-style entries) is auto-routed to a from-source 'nightly' install — 'latest' cannot resolve for those. " +
        "⚠️ ON MANAGER v4, `repository` IS NOT THE URL THAT GETS CLONED (#1539). Read out of ComfyUI-Manager V4.2.2's own source and confirmed on a live V4.2.2: a 'nightly' install resolves the pack by its BARE REPO NAME against the CHANNEL's custom-node-list, then clones the URL recorded in THAT entry; the `repository` you pass is stored in the task params and never read. So what decides success is whether the repo is listed in the channel this call asks for — and a miss does NOT simply stop: on 'nightly' v4 falls back to the COMFY REGISTRY entry whose id is that same bare name and clones whatever repository it is registered to, so an unlisted name can still install someone else's code. Only when the registry lacks the id too do you get \"Node '<name>@nightly' not found in [ManagerChannel.<channel>, ManagerDatabaseSource.<mode>]\", naming that channel. " +
        "RESOLVING BY NAME MEANS A SUCCESS CAN ALSO BE THE WRONG REPO, and for the names where that is MEASURED rather than hypothetical this tool now REFUSES instead of picking (#1616). 111 bare names resolve to different repositories depending on the channel — 60 of them disagree between 'default' and 'dev', and 28 are ambiguous inside ONE channel (two entries under one name collapse onto a single key and the survivor is upstream list order). If you pass a git URL whose bare name is one of those and you name no `channel`, the call is refused before dispatch and both candidate repositories are named for you. Naming a `channel` dispatches instead, with the concrete collision quoted — but read what it quotes before trusting it: for the 28 intra-channel names that argument selects NOTHING (both entries are in the one list, and v4 keeps whichever its order keeps), and no `channel` value can separate them. The bypass exists because Manager 3.x carries the URL in `files` and clones it as passed, which this check cannot distinguish since the panel picks the dialect after the request leaves the orchestrator; on v4, install_custom_node (source:'git') is what clones the URL you typed. Outside that measured set the hazard stands: if the channel lists your pack's name under someone else, THAT author's repository installs and the call still reports success — the queued reply names the owner you passed, so confirm with panel_list_nodes that it is what landed. " +
        "WHAT WAS OURS: this call used to ask the 'dev' channel, a ~1200-pack side list sharing 3 entries with the ~5900-pack 'default' list — so it could miss a pack panel_search_nodes had just returned to you (that search reads a channel-INDEPENDENT map, measured). It now asks 'default', the channel the registry-id path already used; pass `channel` to override. " +
        "STILL NOT GUARANTEED, and do not read the fix as one: it depends on HOW Manager was installed. A Manager cloned into custom_nodes fetches the channel's real list, where 'default' carries ~5900 packs — there this works. A PIP/Desktop Manager (`is_manager_pip_package()` is just 'not inside a custom_nodes tree') never fetches: it reads a per-channel-URL cache or, failing that, the ~3600-pack snapshot bundled in the package, so `mode` is inert and packs added since that snapshot resolve on NEITHER channel. Measured: the only cache a stock host writes at startup is for a DIFFERENT URL than the name 'default' resolves to, so a pip host serves the bundled list. The fix is an improvement there only in the sense of doing no harm — old 'dev' and new 'default' both land on that same file. Whether a listed repo then always installs was not measured either. " +
        "A NOT-FOUND RULES OUT ONE CHANNEL, NOT THE PACK. The channels are near-disjoint (default ~5900 packs, dev ~1200, sharing 3), so a miss says the pack is absent from the channel THIS CALL ASKED and nothing more — try an explicit `channel` (e.g. 'dev') before concluding it does not exist. This tool will NOT retry another channel for you: v4 resolves by BARE REPO NAME and clones the URL in the channel's entry rather than the one you passed, and 60 names sit in 'default' and 'dev' under DIFFERENT repositories, so a silent retry could install a repo you never named. (That is also why you should confirm with panel_list_nodes that what landed is the repo you meant.) Once the channels that could plausibly carry it are ruled out, clone it into custom_nodes yourself and restart, or use install_custom_node (source:'git'), which needs a LOCAL ComfyUI because it clones onto THIS machine's filesystem — not necessarily the one the panel drives. On Manager 3.x we send a DIFFERENT request shape that carries the URL directly (that much is our own code); whether 3.x then installs an unlisted repo was NOT measured here, so treat 'it worked before on 3.x' as unverified rather than as a regression on our side. " +
        "A ComfyUI restart (panel_restart_comfyui) is usually required afterward to load the nodes — poll panel_node_queue_status first. Prefer this over the headless install_custom_node tool. " +
        "⚠️ QUEUE-DONE IS NOT INSTALLED: Manager marks a task 'done' (queue drained) even when the git clone produced NOTHING — an empty dir, a transient git failure, or a repo not in its registry. So after the queue is idle you MUST VERIFY with panel_list_nodes that each pack actually appears before you restart or report success; a pack you installed that is absent from that list did NOT install (retry it, or install it from its git `repository` URL — but see the v4 note above: on Manager v4 that retry resolves against ONE channel's list, so re-running the identical call fails identically every time — change the `channel` first, and clone it yourself only once the plausible channels are ruled out). " +
        "Install packs ONE AT A TIME and confirm each populated before the next — batching several installs then restarting is exactly how you end up with empty dirs and a broken restart.",
      {
        id: z.string().optional().describe("Registry id or 'author/repo'."),
        repository: z
          .string()
          .optional()
          .describe(
            "Git URL, to REQUEST a nightly/from-source install. On Manager v4 this URL is recorded but never cloned: the pack is resolved by its bare repo name against the CHANNEL's node list and the URL in that entry is what gets cloned, so an install only proceeds for a repo the asked-for channel lists (#1539, measured on V4.2.2). This call asks the 'default' channel unless you pass `channel`.",
          ),
        version: z.string().optional().describe("Specific version; default 'latest' (or 'nightly' with repository)."),
        channel: z.string().optional().describe("Manager channel (default 'default'). On a git-URL install this picks WHICH node list the repo is looked up in — pass 'dev' only for a pack that genuinely lives on that channel (#1539)."),
        mode: z.enum(["remote", "local", "cache"]).optional().describe("DB source (default 'remote'). Inert on a pip Manager v4, which reads its cached/bundled list either way."),
      },
      async (args: A, ctx) => {
        // The panel pack is installable like any other, and this path has NO
        // on-disk verification and never saw the version pin. Refuse both
        // spellings (registry id and git URL) — see panel-pin-guard.
        assertPanelNotTargetedUnverifiable("panel_install_node", args.id);
        assertPanelNotTargetedUnverifiable("panel_install_node", args.repository);
        // #789 — a search result whose `id` is a repository URL (the Manager's
        // legacy/repository-style entries) cannot install as id+"latest": the
        // Manager resolves that as a registry version and rejects it ("not
        // available node: <repo>@<version>"). Route it as the from-source
        // repository install that works, and disclose the rewrite.
        const { conflict, note, ...cmdArgs } = nodesInstallCommandArgs(args);
        if (conflict) return fail(conflict);
        // #1129 — the panel identity is captured BEFORE dispatch, because a
        // takeover during the install is exactly what the follow-up read must not
        // be attributed to.
        const dispatch = {
          tab: ctx.tabId,
          incarnation: panelIncarnation(ctx, ctx.tabId),
        };
        const res = await ctx.call(
          { cmd: "nodes_install", ...cmdArgs },
          30000,
        );
        // #1129 — settle BEFORE the note is appended. The note is glued on after
        // the JSON body, which makes the payload unparseable as JSON, so a probe
        // running afterwards reads `null`, concludes the panel never claimed a
        // queue, and silently does nothing. Found by printing the real reply
        // rather than by reasoning about it: the first version of this shipped
        // the check and the check never ran.
        const settled = await settleDroppedEnqueue(ctx, res, dispatch);
        if (note) {
          const text = settled.content.find((c) => c.type === "text");
          if (text && text.type === "text") {
            text.text += `\n\nNOTE: ${note}`;
          }
        }
        return settled;
      },
    ),
    def(
      "panel_update_node",
      "Update an ALREADY-INSTALLED custom-node pack to its latest (or nightly) code via the BUILT-IN Manager — the first thing to try when a node is broken or CRASHED ComfyUI (e.g. from a crash dump injected on resume). Pass `id` = the installed pack's name/dir (e.g. 'ComfyUI-WanVideoWrapper' from the crash culprit, or an id from panel_list_nodes). Use version 'nightly' to pull the very latest commit (good when a fix just landed upstream), else 'latest' for the newest release. Queues the update; poll panel_node_queue_status, then panel_restart_comfyui to load it. If updating doesn't fix the crash, escalate (git pull / source patch) per your steering.",
      {
        id: z.string().describe("Installed pack name or dir (e.g. 'ComfyUI-WanVideoWrapper'), or a registry id from panel_list_nodes."),
        version: z.string().optional().describe("'latest' (default) or 'nightly' to pull the newest commit."),
        channel: z.string().optional().describe("Manager channel (default 'default')."),
        mode: z.enum(["remote", "local", "cache"]).optional().describe("DB source (default 'remote')."),
      },
      async (args: A, ctx) => {
        assertPanelNotTargetedUnverifiable("panel_update_node", args.id);
        return ctx.call(
          { cmd: "graph_update_node", id: args.id, version: args.version, channel: args.channel, mode: args.mode },
          30000,
        );
      },
    ),
    def(
      "panel_node_queue_status",
      "Check the built-in Manager's install/update queue status (to see if a queued install finished). Read-only. " +
        "A drained queue (total_count: 0, is_processing: false) only means THIS queue is idle — " +
        "it does not include apply_manifest custom_nodes that were never submitted (#1699). " +
        "When apply_manifest returned a PARTIAL INSTALL, this tool names the leftover entries and " +
        "sets queue_complete_for_apply_manifest:false; do not restart ComfyUI until those are " +
        "submitted (re-run apply_manifest).",
      {},
      async (_args, ctx) => {
        const res = await ctx.call({ cmd: "nodes_queue_status" }, 20000);
        return annotateQueueStatusWithManifestPartial(res);
      },
    ),
    def(
      "panel_restart_comfyui",
      "Restart the user's ComfyUI server via the built-in Manager — needed to load newly installed/updated custom nodes. CALL THIS DIRECTLY when a restart is needed: it pops a confirm card and only restarts on a yes (don't ask separately first). ComfyUI and this agent go down briefly, then the panel auto-reconnects and you resume. ⚠️ BUSY GUARD: a restart ABORTS any in-progress or queued generation — if ComfyUI is generating, this tool REFUSES and tells you (it does NOT restart). When that happens, tell the user a render is running and WAIT for it (poll panel_node_queue_status), or pass force:true ONLY if the user explicitly confirms they want to kill the running generation. Best practice: before restarting after an install, check the queue is idle first. Only call when a restart is actually needed. If a crash takes the panel bridge offline so the confirmation card cannot be shown, this tool falls back to a headless restart of the configured local process (or COMFYUI_RESTART_COMMAND) instead of depending on the dead bridge — it still refuses a readable busy queue without force:true, and still refuses when a relaunch cannot be proven. On an externally-managed install whose relaunch can't be proven from here (e.g. Pinokio), the restart is REFUSED before anything is stopped — restart from the launcher that owns the server instead, or set COMFYUI_RESTART_COMMAND to the exact command that restarts the instance (e.g. `docker restart <container>`): the restart then runs through that command (the busy guard above still applies) instead of needing the launch path.",
      { force: z.boolean().optional() },
      async ({ force }, ctx) => {
        // Whole-handler budget (#536): confirm + dispatch + readiness — INCLUDING
        // the legacy path's UNPREEMPTIBLE synchronous execSync blocks — must ALL finish
        // under the outer ~300s tools/call limit. 255s + the legacy admission rule below
        // (kill+relaunch starts only with >=130s left, its ~40s of sync work FRONT-LOADED)
        // means the handler PROVABLY returns well under 300s. The confirm wait is bound
        // to the remaining budget (its deadline+grace can't overrun it — see confirm).
        const OVERALL_MAX_MS = 255_000;
        const overallDeadline = Date.now() + OVERALL_MAX_MS;
        // #404: if the ONLY reachable client is canvas-less (a mobile mirror / remote /
        // headless viewer), a yes/no card can't render, so the confirm would block with
        // no way to answer. Detect that up front — exactly as panel_ask does — and fail
        // fast with an actionable message instead of dispatching a card into the void and
        // waiting out the whole budget. Points at the headless restart_comfyui fallback,
        // which needs no panel card. (A normal interactive tab returns null → proceed.)
        const surfaceErr = askSurfaceError(ctx);
        if (surfaceErr) {
          return fail(
            surfaceErr +
              " To restart the server without a panel confirmation card, use restart_comfyui.",
          );
        }
        // #404: BOUND the confirmation wait. It previously inherited the full remaining
        // ~255s budget, so an unanswered/undelivered card (the panel tab backgrounded or
        // still reconnecting after a PRIOR restart — the second-restart-in-one-turn repro)
        // blocked for ~4 minutes and read as an indefinite hang. Cap it at
        // RESTART_CONFIRM_TIMEOUT_MS (still clamped under the outer budget). This bounds
        // only the WAIT — it never auto-confirms; on timeout we fail fast, below.
        const confirmBudget = Math.max(
          1,
          Math.min(RESTART_CONFIRM_TIMEOUT_MS, overallDeadline - Date.now()),
        );
        const decision = await ctx.confirm(
          "Restart ComfyUI now? It (and this agent) will go down briefly, then reconnect and resume automatically.",
          "Restart ComfyUI",
          confirmBudget,
        );
        if (decision === "timeout") {
          // #851 — the fallback used to be recommended unconditionally, and
          // `restart_comfyui` targets COMFYUI_URL, NOT the ComfyUI the panel is
          // running inside. A reporter followed this advice against a panel driving a
          // different server and got `No ComfyUI process found on port 8188` while the
          // panel was working fine on the live canvas — a restart aimed at the wrong
          // machine, recommended by a call that never checked which machine that was.
          //
          // The information was already here and simply not consulted on this branch:
          // captureRebootHealthBase() is the origin the PANEL answers on, and the
          // adjacent decline branch already reads it. Only recommend the headless tool
          // when it provably points at the same server; otherwise name both and say
          // plainly that this call did not verify the other one.
          const fallback = restartTimeoutFallbackAdvice({
            headlessBase: getComfyUIBaseUrl(),
            panelBase: captureRebootHealthBase(ctx),
            // #1233 — the raw observed origin, so a CONFIRMED mismatch is not lost inside
            // the proof's null. Server-observed on the WS upgrade; page JS cannot forge it.
            observedOrigin: ctx.bridge?.tabServerOrigin?.(ctx.tabId) ?? null,
          });
          return ok(
            `No confirmation received within ${Math.round(confirmBudget / 1000)}s, so I did NOT ` +
              "restart ComfyUI. The panel tab may be backgrounded or still reconnecting after a " +
              "previous restart, so the confirmation card wasn't answered. Tell me to restart it " +
              `and I'll re-ask. ${fallback}`,
          );
        }
        // #1671 — set when the confirmation card was UNREACHABLE and ComfyUI is
        // not healthy: the crash took the panel bridge offline, so recovery
        // must not depend on asking that bridge. The headless path below runs
        // instead. An explicit decline, a still-healthy server, and remote/
        // cloud keep the existing reports (confirmation + busy-queue stay).
        let recoverWithoutPanel = false;
        if (decision !== "yes") {
          // #742: NEVER claim "not restarted" while the server is actually DOWN —
          // and NEVER declare a loss from ONE probe (codex gate): a genuinely
          // restarting server is refused during its normal down window, and a
          // transport/card error mapping to "no" is exactly how a tab dying
          // during a healthy prior reboot lands here. So recheck over a short,
          // bounded window and report DOWN only when the endpoint is STILL
          // refused at the end of it; a recovery inside the window is reported
          // as such (bound instance) or keeps the plain cancel line (unbound).
          // CAUSATION ("a restart took it down") is named ONLY when the probed
          // target is PROVABLY the same boot instance the restart would have
          // stopped — the same binding the refuse-safe preflight uses; an
          // unbound configured endpoint gets a generic unreachable report that
          // never claims "we stopped it".
          const declineBootBase = captureRebootHealthBase(ctx);
          const boundToRestartTarget =
            declineBootBase != null && sameHttpBase(getComfyUIBaseUrl(), declineBootBase);
          const declineProbeBase = boundToRestartTarget
            ? declineBootBase
            : getComfyUIBaseUrl();
          // r15: capture the session's held dispatch TOKEN before the probe
          // awaits — the exoneration clear (r13) and the recovery claim (r14)
          // must key on the token VALIDATED HERE, never whichever token is
          // current after the awaits: a concurrent accepted restart stamping a
          // fresh token mid-probe keeps its record (clear-if-same below), so a
          // later persistent DOWN can still attribute to it.
          const declineHeldToken = sessionRestartDispatchToken(ctx);
          const declineTiming = declineProbeTimingOverride ?? {
            windowMs: DECLINE_PROBE_WINDOW_MS,
            intervalMs: DECLINE_PROBE_INTERVAL_MS,
            probeTimeoutMs: DECLINE_PROBE_TIMEOUT_MS,
          };
          const outcome = await probeDeclineRecovery(
            declineProbeBase,
            declineTiming.windowMs,
            declineTiming.intervalMs,
            declineTiming.probeTimeoutMs,
            overallDeadline,
          );
          // The VALIDATED token's record (null when it was superseded by a
          // newer stamp during the probe — the conservative outcome: neither
          // claim nor clear keys on a record this probe didn't validate).
          const declineHeldRecord = declineHeldToken
            ? getRestartDispatchRecord(declineHeldToken)
            : null;
          // r13: a HEALTHY/RECOVERED observation exonerates any dispatch THIS
          // session has on record — the restart explained itself, so its token
          // must never ground causation for a LATER, independent failure.
          // Base-matched: a healthy observation only exonerates the instance
          // it was taken on (an unbound healthy endpoint says nothing about a
          // boot-instance record). The 10-minute causation window stays as the
          // backstop for records never observed back.
          // r14: the record is captured BEFORE the clear — the recovery CLAIM
          // below ("a restart initiated earlier appears to have completed")
          // requires the token to have been present at this moment.
          // r15: CLEAR-IF-SAME — the clear fires only when the session still
          // holds the SAME token validated before the probe; a newer dispatch
          // stamped mid-probe keeps its record.
          if (outcome.status === "healthy" || outcome.status === "recovered") {
            if (
              declineHeldToken != null &&
              declineHeldRecord != null &&
              (declineHeldRecord.base == null ||
                sameHttpBase(declineHeldRecord.base, declineProbeBase))
            ) {
              clearSessionRestartDispatchIfSame(ctx, declineHeldToken);
            }
          }
          // #1671: the recovery command must not depend on the component a crash
          // takes offline. UNREACHABLE + not-healthy (down, or ambiguous — the
          // reporter's empty-body HTTP 502) on a LOCAL target falls through to
          // the headless restart. An explicit decline still reports and does
          // NOT restart (confirmation). A still-healthy server still does not
          // auto-restart (#1332). Remote/cloud have no local process to cycle.
          const crashTookBridgeOffline =
            decision === "unreachable" &&
            (outcome.status === "down" || outcome.status === "ambiguous") &&
            !isRemoteMode() &&
            !isCloudMode();
          if (crashTookBridgeOffline) {
            recoverWithoutPanel = true;
          } else if (outcome.status === "down") {
            const secs = Math.max(1, Math.round(outcome.waited_ms / 1000));
            if (boundToRestartTarget) {
              // r4: causation may be named ONLY against a RECORDED restart
              // dispatch — recent enough to plausibly be the cause, and
              // targeting THIS instance. r5: the record must be one THIS
              // SESSION dispatched (holds the token of) — another session's
              // failed restart never grounds causation here. An unrelated
              // crash / manual stop (no record, a stale record, another
              // instance's record, or another session's record) gets the
              // causation-free report.
              const dispatch = sessionRestartDispatch(ctx);
              const causative =
                dispatch != null &&
                Date.now() - dispatch.at <= RESTART_DISPATCH_CAUSATION_WINDOW_MS &&
                (dispatch.base == null || sameHttpBase(dispatch.base, declineBootBase));
              if (causative) {
                return ok(
                  "⚠️ ComfyUI is DOWN — it was STOPPED and did not come back (still " +
                    `unreachable after a ${secs}s recheck window), so do NOT treat this as ` +
                    "\"nothing happened\". The restart just declined was NOT what stopped " +
                    "it (nothing was dispatched after the decline), but a restart initiated " +
                    "earlier already took the server down and it never returned. Start " +
                    "ComfyUI manually from whatever launches it (e.g. Pinokio, the Desktop " +
                    "app, or your terminal), then reload the panel tab so it reconnects. " +
                    "restart_comfyui can attempt the relaunch for you when the install's " +
                    "launch path is resolvable.",
                );
              }
              return ok(
                "⚠️ ComfyUI is DOWN — still unreachable after " +
                  `a ${secs}s recheck window — and no restart was dispatched through me ` +
                  "that would explain it (the restart just declined was NOT dispatched, " +
                  "and none is on record recently for this instance). Something else " +
                  "stopped it (a crash, a manual stop, or its launcher). Start ComfyUI " +
                  "manually from whatever launches it (e.g. Pinokio, the Desktop app, or " +
                  "your terminal), then reload the panel tab so it reconnects.",
              );
            }
            return ok(
              "⚠️ ComfyUI appears to be DOWN — the configured endpoint was still " +
                `unreachable after a ${secs}s recheck window. The restart just declined ` +
                "was NOT dispatched, and I can't confirm from here whether the server " +
                "was actually stopped — this endpoint isn't provably the instance the " +
                "restart would have cycled. Check ComfyUI on its host and start it " +
                "manually if it is down, then reload the panel tab so it reconnects.",
            );
          }
          if (recoverWithoutPanel) {
            // Fall through to the headless path once runHeadlessManagedRestart
            // is defined. Do not claim the server is reachable, and do not ask
            // the dead panel to reboot it.
          } else if (outcome.status === "recovered" && boundToRestartTarget) {
            // r14: the recovery CLAIM ("a restart initiated earlier appears to
            // have completed") passes the SAME causation gate as the DOWN
            // report — a session-held, bound-confirmed record, recent, and
            // base-matched, captured BEFORE the r13 exoneration clear (which
            // fires either way). Without it, the down→healthy cycle alone
            // proves nothing about what caused the down: report the recovery
            // causation-free.
            const recoveryCausative =
              declineHeldRecord != null &&
              Date.now() - declineHeldRecord.at <= RESTART_DISPATCH_CAUSATION_WINDOW_MS &&
              (declineHeldRecord.base == null ||
                sameHttpBase(declineHeldRecord.base, declineBootBase));
            return ok(
              recoveryCausative
                ? "Cancelled — no new restart was dispatched. Note: ComfyUI was briefly " +
                    "unreachable but is healthy again — a restart initiated earlier " +
                    "appears to have completed."
                : "Cancelled — no new restart was dispatched. ComfyUI was briefly " +
                    "unreachable but is healthy again.",
            );
          } else {
            // #1332 — the reporter's exact string, and it was FALSE. They accepted the
            // restart, ComfyUI restarted (a fresh startup in the server log), and this
            // said it had not — because the restart dropped the socket the answer had to
            // travel back on, and a transport failure used to arrive here as "no".
            //
            // The probes above already refuse to claim "not restarted" while the server
            // is DOWN. This is the remaining case: the server is HEALTHY, which is
            // equally true of "nothing happened" and of "it restarted and came back".
            // With an explicit decline we know which; without one we do not, and the
            // sentence must stop asserting it.
            const fallback =
              decision === "unreachable"
                ? " " +
                  restartTimeoutFallbackAdvice({
                    headlessBase: getComfyUIBaseUrl(),
                    panelBase: declineBootBase,
                    observedOrigin: ctx.bridge?.tabServerOrigin?.(ctx.tabId) ?? null,
                  })
                : "";
            return ok(
              decision === "unreachable"
                ? "This call did NOT dispatch a restart. Whether ComfyUI restarted for some " +
                    "other reason cannot be told from here: the panel could not be reached to " +
                    "ask for confirmation — the question never appeared — so no decision was " +
                    "made either way, and the server is reachable now, which looks the same " +
                    "whether it never went down or went down and came back. If you asked for a " +
                    "restart and one has already happened, this is that transport loss, not a " +
                    "cancellation. Check the ComfyUI log for a fresh startup line before " +
                    "restarting again." +
                    fallback
                : "Cancelled — ComfyUI was not restarted.",
            );
          }
        }
        // Heal an orphaned session onto the live tab FIRST, then bind the reboot dispatch
        // to that ONE tab id (no await between capture and dispatch, so JS run-to-
        // completion prevents any rebind in between). The boot-endpoint probe target is
        // server-authorized + immutable, bound to the exact host FAMILY the reboot goes
        // to (null unless the bound tab provably fronts our boot instance).
        ctx.ensureReachable?.();
        // Run the HEADLESS managed restart (restartComfyUI) from inside this tool and
        // report its outcome against OUR OWN independent boot-endpoint observation
        // (never restartComfyUI's self-reported readiness, which a first-healthy
        // no-op would flunk). Shared by three call sites that must not dispatch the
        // tab reboot: the legacy no-endpoint fallback below (#425), a configured
        // COMFYUI_RESTART_COMMAND (panel#1262), and #1671 crash recovery when the
        // panel bridge is already gone. restartComfyUI acts on the orchestrator's
        // GLOBAL config target, so the first two require a BOUND-CONFIRMED local
        // tab; #1671 may also use the configured boot instance when the tab is gone.
        const runHeadlessManagedRestart = async (args: {
          healthBase: string;
          preRestartPanelIdentity: { generation: number; tabSessionId: string } | undefined;
          /** Lead sentence naming WHY the headless path is running (error paths). */
          why: string;
          /** Noun phrase for the mechanism ("the headless managed restart (kill + relaunch)"). */
          mechanism: string;
          /** Lead for the came-back-healthy-but-tab-not-ready note. */
          noteHealthyLead: string;
          /** Lead for the final outcome note (ready and not-ready shapes). */
          noteRanLead: string;
        }): Promise<ToolResult> => {
          const { healthBase, preRestartPanelIdentity, why, mechanism, noteHealthyLead, noteRanLead } = args;
          // The managed kill+relaunch does UNPREEMPTIBLE synchronous execSync work — PID
          // discovery (~5+8s) + termination (~10s) + first port-free lookup (~13s) ≈ 40s
          // worst case (Windows) — that a Promise.race CANNOT interrupt, and it BLOCKS the
          // observer during that window. Admit it ONLY with enough budget for that sync
          // work AND a full cold-start observation AFTER it, and give the observer a
          // deadline that spans BOTH (coordinator P1: the proof deadline must start after,
          // not before, the restart's synchronous work — otherwise a genuine cold start
          // that finishes at sync+coldStart false-times-out).
          const LEGACY_SYNC_WORST_CASE_MS = 40_000; // execSync PID lookup + kill + port-free
          const LEGACY_COLD_START_OBS_MS = 100_000; // cold-start observation AFTER the sync
          const LEGACY_RESTART_MIN_BUDGET_MS = LEGACY_SYNC_WORST_CASE_MS + LEGACY_COLD_START_OBS_MS;
          if (overallDeadline - Date.now() < LEGACY_RESTART_MIN_BUDGET_MS) {
            return ok({
              rebooting: false,
              ready: false,
              confirmed_cycle: false,
              note:
                `${why}, and there isn't enough remaining time to safely run ${mechanism}. ` +
                "ComfyUI was NOT restarted — retry panel_restart_comfyui " +
                "(a fresh call gets the full budget).",
            });
          }
          // A managed kill+relaunch restarts ComfyUI out-of-band, so drop the memoized
          // caches. The observer watches the boot endpoint itself with a deadline spanning
          // the ~40s blocking sync + a full cold-start window, and certifies ONLY on an
          // OBSERVED down→up — a never-restarted healthy endpoint (a Desktop first-healthy
          // Manager-reboot / preflight no-op) is honestly couldn't-confirm (coordinator P1).
          resetClient();
          resetObjectInfoCache();
          resetManagerApiCache("panel managed restart");
          const headlessTiming = getPanelRebootTiming();
          // The observation window spans the ~40s blocking sync + a full cold-start
          // window. (Under a test timing override, use the injected budget instead so the
          // never-certify cases don't wait the real ~140s.)
          const legacyProofWindow = panelRebootTimingOverride
            ? headlessTiming.settleMs + headlessTiming.budgetMs
            : LEGACY_RESTART_MIN_BUDGET_MS;
          const proofDeadline = Math.min(Date.now() + legacyProofWindow, overallDeadline);
          const proofPromise = observeRecovery(headlessTiming, proofDeadline, { healthBase });
          const restartBudget = Math.max(1, overallDeadline - Date.now());
          let restart: Awaited<ReturnType<typeof restartComfyUI>> | undefined;
          let restartTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            restart = await Promise.race([
              restartComfyUI(),
              new Promise<undefined>((resolve) => {
                restartTimer = setTimeout(() => resolve(undefined), restartBudget);
                restartTimer.unref?.();
              }),
            ]);
          } catch (err) {
            clearTimeout(restartTimer);
            void proofPromise.catch(() => {}); // self-terminates at proofDeadline
            return fail(
              `${why}, and ${mechanism} also failed: ` +
                (err instanceof Error ? err.message : String(err)) +
                " — restart ComfyUI on the host, then reconnect.",
            );
          }
          clearTimeout(restartTimer);
          // #742 r5/r6: the managed restart stopped the process — record the
          // dispatch with THIS session holding the token, stamped with the
          // BOUND-CONFIRMED base (this path only runs when the instance
          // binding held, so healthBase is non-null here). restartComfyUI
          // also stamped its own process-wide record, which never grounds
          // causation. Only a PROVEN stop is recorded; a refusal/timeout
          // (restart undefined, or stopped!==true) records nothing. The
          // token is kept so the recovery clear below is CLEAR-IF-SAME (r15).
          let headlessDispatchToken: string | undefined;
          if (restart?.stopped === true) {
            headlessDispatchToken = stampSessionRestartDispatch(ctx, healthBase);
          }
          // DEFINITIVE no-restart: a spawn failure, OR restartComfyUI refused before
          // stopping anything (no process found / unsafe relaunch → stopped:false &&
          // started:false). The process was NOT cycled, so the still-healthy endpoint is
          // the OLD one — fail clearly rather than certify a no-op (coordinator P1).
          if (
            restart?.spawn_error ||
            (restart != null && restart.stopped !== true && restart.started !== true)
          ) {
            void proofPromise.catch(() => {});
            return fail(
              `${why}. Tried ${mechanism}, but it did not restart ` +
                `ComfyUI: ${restart?.message ?? "unknown error"} ` +
                "Restart ComfyUI on the host, then reconnect.",
            );
          }
          // Otherwise (the process WAS stopped/started, or restartComfyUI's own readiness
          // poll merely expired — neither terminal) DEFER to OUR OWN observed DOWN→UP.
          const recovery = await proofPromise;
          // #742 r4/r5/r15: the managed restart was observed back — clear THIS
          // session's record, CLEAR-IF-SAME: only when the session still holds
          // the token THIS restart stamped (a concurrent dispatch's newer
          // record survives). restartComfyUI also clears its own process-wide
          // record on success; this covers only-observer-saw-it recoveries.
          if (recovery.ready && headlessDispatchToken != null) {
            clearSessionRestartDispatchIfSame(ctx, headlessDispatchToken);
          }
          const observed = recovery.via === "observed-cycle";
          // The headless path restarts ComfyUI out-of-band too. Server recovery alone
          // is not graph-tool readiness: wait for the browser tab to reconnect, then verify
          // the same workflow-stamp capability the bridge requires before it dispatches a
          // mutation. Without this, updating the panel pack followed by a headless restart can
          // falsely report ready while the browser is still running stale panel JS (#709).
          const tabBack = recovery.ready
            ? ctx.awaitPostRestartReachable
              ? await ctx.awaitPostRestartReachable(
                  preRestartPanelIdentity,
                  Math.max(0, overallDeadline - Date.now()),
                )
              : ctx.awaitReachable
                ? await ctx.awaitReachable(Math.max(0, overallDeadline - Date.now()))
                : true
            : false;
          const graphToolsReady = tabBack && (ctx.tabCanMutateGraph ? ctx.tabCanMutateGraph() : true);
          // #654 — `ready`/`graph_tools_ready` still come from the BOOLEAN, so an
          // undetermined reconnect withholds graph tools exactly as before. Only
          // the reported observation changes.
          const tabReconnect = classifyTabReconnect({
            serverReady: recovery.ready,
            baselineCaptured: preRestartPanelIdentity != null,
            tabBack,
          });
          return ok({
            rebooting: true,
            ready: graphToolsReady,
            graph_tools_ready: graphToolsReady,
            server_ready: recovery.ready,
            panel_tab_reconnected: tabReconnect,
            confirmed_cycle: observed, // true = we directly observed the down→up cycle
            recovered_ms: recovery.waited_ms,
            probes: recovery.attempts,
            saw_down: recovery.sawDown,
            via: recovery.ready ? recovery.via : undefined,
            note:
              recovery.ready && !graphToolsReady
                ? `${noteHealthyLead} came back healthy in ${(recovery.waited_ms / 1000).toFixed(1)}s, but ` +
                  (!tabBack
                    ? tabReconnect === "unknown"
                      ? "whether the panel tab reconnected could NOT be determined — no pre-restart " +
                        "baseline was captured for it, so nothing was watched. WHY is not established " +
                        "here, and it is one of: the tab's socket was not open at the instant the " +
                        "restart was dispatched; the panel advertised no tab session id (an older " +
                        "build, or its browser-tab lease was refused because a duplicate tab holds " +
                        "it); or the tab did not resolve at all. The tab may well be back. Graph " +
                        "tools are withheld (ready:false) because that is unproven, NOT because the " +
                        'tab is known to be gone: call panel_list_workflows or panel_set_workflow_target({mode:"current"}) ' +
                        "to find out, and only refresh the browser if those also fail. If this " +
                        "repeats on every restart, the panel is probably too old to advertise a tab " +
                        "session id — update it."
                      : "the panel tab has NOT reconnected yet (ready:false). Wait a moment then retry, or " +
                        'rebind with panel_set_workflow_target({mode:"current"}) before issuing graph tools.'
                    : "the panel tab reconnected but cannot safely run graph mutations (ready:false), usually " +
                      "because it is still running a stale panel bundle. Hard-refresh the ComfyUI browser tab " +
                      "(Ctrl+Shift+R) before issuing graph tools; if that does not restore it, update the panel " +
                      "and open/reload a saved workflow with a stable identity.")
                : `${noteRanLead} ` +
                  (recovery.ready
                    ? `and it came back healthy in ${(recovery.waited_ms / 1000).toFixed(1)}s` +
                      (observed ? " (observed it go down then come back)." : " (cycle not directly observed).")
                    : `but it did NOT become healthy within ${Math.round(recovery.waited_ms / 1000)}s — verify with get_system_stats (action:"health") / panel_node_queue_status before assuming it restarted.`),
          });
        };
        // #1671: panel-offline crash recovery. The confirmation card could not
        // be shown because the bridge is gone, and ComfyUI is not healthy
        // (down, or an empty-body 502). Restart the configured local process
        // through the same headless path the Manager-missing and
        // COMFYUI_RESTART_COMMAND cases already use. Do NOT send comfy_reboot
        // — that is the dead bridge. A readable busy queue still refuses
        // without force:true; an unreadable queue on an already-unhealthy
        // server is the crash, not "idle", and is not a reason to refuse.
        // A proven-different panel origin, or a process we cannot relaunch,
        // fails with the true cause instead of claiming success.
        if (recoverWithoutPanel) {
          const healthBase = offlineRestartHealthBase(ctx);
          if (healthBase == null || !sameHttpBase(getComfyUIBaseUrl(), healthBase)) {
            return ok({
              rebooting: false,
              ready: false,
              confirmed_cycle: false,
              refused: true,
              note:
                "This call did NOT dispatch a restart. The panel could not be reached to " +
                "ask for confirmation (the crash took the panel bridge offline) and I " +
                "cannot identify a local ComfyUI process I can account for, so I will " +
                "not stop a server I cannot prove I can bring back. Nothing was " +
                "stopped. " +
                restartRefusalHandoffAdvice({
                  headlessBase: getComfyUIBaseUrl(),
                  panelBase: captureRebootHealthBase(ctx),
                  observedOrigin: ctx.bridge?.tabServerOrigin?.(ctx.tabId) ?? null,
                }),
            });
          }
          if (force !== true) {
            let busyCount: number | null = null;
            try {
              const queue = await getQueueVerified();
              busyCount = queue.queue_running.length + queue.queue_pending.length;
            } catch {
              // Unreadable queue + already-unhealthy server is the crash itself.
              // Unlike the configured-command YES path, "cannot check" is not a
              // reason to refuse: the generation that might have been running
              // is the one that took the bridge down.
              busyCount = null;
            }
            if (busyCount != null && busyCount !== 0) {
              return ok({
                rebooting: false,
                ready: false,
                confirmed_cycle: false,
                refused: true,
                note:
                  `Refusing to restart ComfyUI: ${busyCount} generation(s) are in progress ` +
                  "or queued, and a restart ABORTS them. The panel could not be reached " +
                  "to ask, so nothing was stopped. Wait for the queue to drain, or retry " +
                  "with force:true ONLY if the user explicitly confirms they want to kill " +
                  "the running generation.",
              });
            }
          }
          const configuredCmd = config.comfyuiRestartCommand;
          if (!configuredCmd) {
            const preflight = await (localRestartPreflightOverride ?? preflightLocalRestart)();
            if (!preflight.ok) {
              return ok({
                rebooting: false,
                ready: false,
                confirmed_cycle: false,
                refused: true,
                note:
                  "The panel could not be reached to ask for confirmation (the crash " +
                  "took the panel bridge offline). Refusing to restart ComfyUI: " +
                  `${preflight.reason} A restart from here would STOP ComfyUI and ` +
                  "nothing would bring it back automatically, so it was refused " +
                  "BEFORE anything was stopped. Restart it from whatever launches it, " +
                  "or set COMFYUI_RESTART_COMMAND to the exact command that restarts " +
                  "the instance.",
              });
            }
          }
          const postHealthBase = offlineRestartHealthBase(ctx);
          if (postHealthBase == null || !sameHttpBase(healthBase, postHealthBase)) {
            return ok({
              rebooting: false,
              ready: false,
              confirmed_cycle: false,
              refused: true,
              note:
                "Refusing to restart ComfyUI: the ComfyUI target changed while the " +
                "offline recovery was being prepared, so I can no longer confirm the " +
                "headless restart would act on the instance this session accounts for. " +
                "Nothing was stopped.",
            });
          }
          return runHeadlessManagedRestart({
            healthBase,
            preRestartPanelIdentity: ctx.panelConnectionIdentity?.(),
            why:
              "The panel could not be reached to ask for confirmation (the crash took " +
              "the panel bridge offline)",
            mechanism: configuredCmd
              ? "the configured restart command"
              : "the headless managed restart (kill + relaunch)",
            noteHealthyLead: configuredCmd
              ? "The panel bridge was offline after the crash, so the restart ran " +
                "through COMFYUI_RESTART_COMMAND; ComfyUI"
              : "The panel bridge was offline after the crash, so the restart ran " +
                "through the headless managed restart; ComfyUI",
            noteRanLead: configuredCmd
              ? "The panel bridge was offline after the crash, so the restart ran " +
                "through COMFYUI_RESTART_COMMAND (not a panel confirmation card)"
              : "The panel bridge was offline after the crash, so the restart ran " +
                "through the headless managed restart (not a panel confirmation card)",
          });
        }
        // panel#1262: A CONFIGURED RESTART COMMAND REPLACES THE TAB REBOOT.
        //
        // On an externally-managed local install (a container, a systemd unit, a
        // launcher) the tab reboot is the WRONG mechanism twice over: the
        // refuse-safe preflight below cannot prove a relaunch from a bare
        // `main.py` argv that anchors only inside the instance's own namespace
        // (so it refuses and the wedge wins), and a wedged server answers no
        // Manager reboot anyway. COMFYUI_RESTART_COMMAND is the user's explicit
        // statement of what cycles the instance, so when it is set the restart
        // runs through it (headless restartComfyUI honors it) instead of the
        // tab dispatch. The BUSY GUARD the server-side reboot would have
        // enforced is re-implemented here against a VERIFIED queue read, with
        // the same force:true contract; a queue that cannot be read at all (the
        // wedge itself) refuses without force, because "cannot check" is not
        // "idle" and a restart aborts whatever is running.
        const configuredRestartCommand = config.comfyuiRestartCommand;
        if (configuredRestartCommand && !isRemoteMode() && !isCloudMode()) {
          const commandHealthBase = captureRebootHealthBase(ctx);
          if (commandHealthBase != null && sameHttpBase(getComfyUIBaseUrl(), commandHealthBase)) {
            if (force !== true) {
              let busyCount: number | null = null;
              try {
                const queue = await getQueueVerified();
                busyCount = queue.queue_running.length + queue.queue_pending.length;
              } catch {
                // unknown-ok: an UNREADABLE queue is the wedge case itself — null
                // below refuses without force (fail closed), it never reads as idle.
                busyCount = null;
              }
              if (busyCount !== 0) {
                return ok({
                  rebooting: false,
                  ready: false,
                  confirmed_cycle: false,
                  refused: true,
                  note:
                    busyCount === null
                      ? "Refusing to restart ComfyUI: COMFYUI_RESTART_COMMAND is set, so the " +
                        "restart runs the configured command — which ABORTS any in-progress or " +
                        "queued generation — and the queue could not be read to confirm it is " +
                        "idle (the server is not answering, which may be the very wedge you are " +
                        "restarting to escape). Nothing was stopped. If the user confirms any " +
                        "running render may be killed, retry with force:true."
                      : `Refusing to restart ComfyUI: ${busyCount} generation(s) are in progress ` +
                        "or queued, and the configured restart command ABORTS them. Nothing was " +
                        "stopped. Wait for the queue to drain (poll panel_node_queue_status), or " +
                        "retry with force:true ONLY if the user explicitly confirms they want to " +
                        "kill the running generation.",
                });
              }
            }
            // The busy-check AWAIT makes the pre-await binding capture stale (r7's
            // own rule): a retarget or tab rebind landing during it would run the
            // command against an instance this tab no longer provably fronts.
            // Re-heal and re-verify at the point of action, exactly as the
            // dispatch path below does.
            ctx.ensureReachable?.();
            const postCheckHealthBase = captureRebootHealthBase(ctx);
            if (
              postCheckHealthBase == null ||
              !sameHttpBase(commandHealthBase, postCheckHealthBase)
            ) {
              return ok({
                rebooting: false,
                ready: false,
                confirmed_cycle: false,
                refused: true,
                note:
                  "Refusing to restart ComfyUI: the panel connection or target changed " +
                  "while the queue was being checked, so I can no longer confirm the " +
                  "configured restart command would act on the instance this tab fronts. " +
                  "Nothing was stopped. Retry once the panel has settled.",
              });
            }
            return runHeadlessManagedRestart({
              healthBase: commandHealthBase,
              preRestartPanelIdentity: ctx.panelConnectionIdentity?.(),
              why: "COMFYUI_RESTART_COMMAND is set",
              mechanism: "the configured restart command",
              noteHealthyLead:
                "COMFYUI_RESTART_COMMAND is set, so the restart ran through the configured " +
                "command; ComfyUI",
              noteRanLead:
                "COMFYUI_RESTART_COMMAND is set, so the restart ran through the configured " +
                "command (not the Manager reboot)",
            });
          }
          // UNBOUND local target: the configured command acts on the orchestrator's
          // CONFIGURED target, which is not provably the instance this tab fronts —
          // fall through to the normal preflight/refusal machinery below (its refusal
          // names restart_comfyui, the non-tab-scoped entry point that CAN use it).
        }
        // #742 REFUSE-SAFE PREFLIGHT: a Manager reboot stops ComfyUI OUT-OF-BAND —
        // it never goes through our validated kill+relaunch — so before dispatching
        // anything, the stop must be provable survivable (#368/#370: losing a restart
        // is cheap, losing the server is not). On a Pinokio-style install (externally
        // supervised; no main.py/interpreter resolvable from here) a plain Manager
        // restart kills the process and the supervisor does NOT re-launch it — the
        // exact #742 lost-server. When the reboot would target OUR local boot
        // instance (the same instance binding the legacy fallback uses), prove a
        // relaunch is possible FIRST and refuse BEFORE any stop when it isn't. Only
        // the PROVEN-dangerous shape refuses (a reachable local non-Desktop process
        // with an unbuildable/unvalidatable relaunch); every other shape — Desktop
        // (Electron-supervised, #400), unverifiable, or remote — proceeds exactly as
        // before. The binding for this DECISION is captured pre-await; nothing
        // downstream may reuse it (r7).
        //
        // #814: AN UNIDENTIFIED LOCAL TARGET IS NOT SENT AN IRREVERSIBLE STOP.
        //
        // `captureRebootHealthBase` answers "is the instance this tab fronts provably
        // our own local boot ComfyUI?" — loopback base, server-observed handshake
        // Origin, pathless mount. When it cannot say yes, we do not know WHICH
        // ComfyUI the reboot will reach: the command goes to the bound TAB, not to
        // the orchestrator's configured target.
        //
        // The original code dispatched anyway and reported honestly that it could not
        // confirm the return — a verdict computed after a stop it should not have
        // made, and the #814 lost server. A first attempt at this ran the local
        // preflight in that case and let a PASS proceed, which was worse in a subtle
        // way: the assessment describes the CONFIGURED instance while the reboot hits
        // the TAB's, so a safe local install could authorize stopping an orphaned
        // Desktop backend in some other tab (codex gate round 11). A pass for one
        // instance is not permission to stop another.
        //
        // So: BOUND, assess the instance the reboot will reach and decide on it.
        // UNBOUND and local, REFUSE — the assessment describes the orchestrator's
        // CONFIGURED target, which is not shown to be what the reboot reaches, and a
        // finding about one instance may not be spent on another IN EITHER DIRECTION.
        //
        // An asymmetric version was tried (a pass authorizes nothing, a fail still
        // refuses) and is incoherent: if the configured target is a good enough proxy
        // to refuse on, it is good enough to proceed on, and if it is not, the refusal
        // is as unfounded as the permission. Keeping only the refusal would also break
        // a working tab-fronted instance whenever the unrelated configured one is
        // stale — while still leaving the dispatch unproven.
        //
        // The cost is real and is the point: `captureRebootHealthBase` also returns
        // null for ordinary local setups (an ambiguous `localhost` origin, a basePath
        // mount, an older panel), and those lose the panel restart until the binding
        // can be proven. They keep restart_comfyui, and the note says so. Weighed
        // against #814 — where exactly such a user's server was stopped and never came
        // back — declining is the recoverable side.
        const preflightHealthBase = captureRebootHealthBase(ctx);
        const preflightBound =
          preflightHealthBase != null &&
          sameHttpBase(getComfyUIBaseUrl(), preflightHealthBase);
        // #848: what the instance was OBSERVED running with, taken from the preflight
        // that already had to resolve it. Nothing new is probed before the dispatch —
        // the no-await invariant between the binding capture and the reboot stands.
        let preflightArgv: string[] | undefined;
        let preflightIsDesktop = false;
        // #1647: set when the preflight passed on INFERRED Desktop supervision (the
        // process tree was unreadable, so the launch signatures stood in). Appended
        // to the outcome note below — a dispatch allowed on an inference says so.
        let preflightNote: string | undefined;
        // The target generation as of BEFORE the preflight resolved that argv, so the
        // whole span up to the post-restart reading sits inside one instance fence.
        let preflightArgvGeneration = -1;
        // Remote and cloud are excluded for the reason they always were: there is no
        // local process to assess, and the Manager reboot is their ONLY restart path —
        // a supervised remote (the tunnelled Desktop app) restarts through it by
        // design, so refusing there would remove a path that works.
        if (!preflightBound && !isRemoteMode() && !isCloudMode()) {
          return ok({
            rebooting: false,
            ready: false,
            confirmed_cycle: false,
            refused: true,
            note:
              "Refusing to restart ComfyUI: I could not confirm that this panel's ComfyUI is " +
              "the local instance I can account for, so I cannot tell which server the restart " +
              "would stop — and it STOPS it, relying on whatever supervises it to start it " +
              // A claim about what I DID, not about a server I have just said I cannot
              // identify: "it is still running" would be exactly the unvalidated
              // assertion the stale-target rule forbids (r8).
              "again. Nothing was dispatched, so nothing was stopped. " +
              // The alternative is NAMED and the difference EXPLAINED (coordinator
              // ruling): this tool restarts whatever the calling TAB fronts, which is
              // exactly the thing that could not be identified here. restart_comfyui is
              // not tab-scoped — it acts on the ComfyUI this server is configured for,
              // which it can identify and assess — so it remains available. A user who
              // loses one entry point must be told the other one works, and why.
              //
              // #1593 — but only when it is actually the other one. This line used to
              // recommend restart_comfyui unconditionally, which is #851's defect
              // exactly: it targets COMFYUI_URL, not the ComfyUI the panel is inside,
              // and this branch fires precisely when those are most likely to differ.
              // The discriminator #851 built has been next door ever since and was
              // never consulted here; now it is, and both addresses are named.
              restartRefusalHandoffAdvice({
                headlessBase: getComfyUIBaseUrl(),
                panelBase: preflightHealthBase,
                observedOrigin: ctx.bridge?.tabServerOrigin?.(ctx.tabId) ?? null,
              }) +
              // artokun/comfyui-mcp-panel#769 — a REMOTE ComfyUI reached over a
              // tunnel or port-forward has a LOOPBACK host, and remoteUrlActive is
              // derived from exactly that (`forceRemote || !isLoopbackHost(host)`).
              // So a cloud pod fronted at 127.0.0.1:<port> classifies as LOCAL, this
              // branch runs, and it correctly reports it cannot find a local process
              // to account for — because there isn't one. The refusal is right about
              // what it observed and useless about what to do, since the reader is
              // looking for a local install that does not exist. Name the one setting
              // that re-classifies it; it is a config fix, not a workaround.
              " NOTE: if this ComfyUI is actually REMOTE but reached through a tunnel " +
              "or port-forward (a 127.0.0.1 address that is not this machine), it is " +
              "being classified as local because that classification reads the HOST — " +
              "which proves the route is local, not the instance. Set " +
              "COMFYUI_MCP_FORCE_REMOTE=1 (or pass --force-remote) and this tool takes " +
              "the remote path, which restarts through ComfyUI-Manager and does not " +
              "need a local process to account for.",
          });
        }
        if (preflightBound) {
          // Snapshot the target GENERATION at the decision (r11): a final-state
          // base comparison (A vs A) cannot detect an intervening A→B→A
          // retarget, so stability is judged by the monotonic epoch bumped on
          // EVERY retarget — any mutation, including a round trip back to the
          // same base, is caught.
          const preflightTargetGeneration = getComfyuiTargetGeneration();
          const preflight = await (localRestartPreflightOverride ?? preflightLocalRestart)();
          // #848: keep the observed launch arguments. Recorded here and spent ONLY on
          // the success path far below, where the reboot has been proven to have
          // cycled THIS instance — it never influences any decision above.
          // preflightTargetGeneration was captured before the preflight ran, so it is
          // exactly the fence this reading needs.
          preflightArgv = preflight.observedArgv;
          preflightIsDesktop = preflight.isDesktopApp === true;
          preflightNote = preflight.note;
          preflightArgvGeneration = preflightTargetGeneration;
          // r8/r9/r10: the preflight AWAIT makes the pre-decision captures
          // STALE — and the preflight itself reads MUTABLE config (target URL,
          // port, COMFYUI_PATH) throughout, so a config retarget during the
          // await can re-point the whole assessment at a DIFFERENT install
          // while the tab still fronts the original one. Re-heal and
          // re-capture BEFORE trusting the result either way. The guarantee
          // that must hold: a stop/reboot is only ever sent when the preflight
          // validated THE instance the dispatch will cycle.
          ctx.ensureReachable?.();
          const postPreflightHealthBase = captureRebootHealthBase(ctx);
          const tabFrontsSameInstance =
            postPreflightHealthBase != null &&
            sameHttpBase(preflightHealthBase, postPreflightHealthBase);
          const configStable =
            getComfyuiTargetGeneration() === preflightTargetGeneration;
          if (!configStable && tabFrontsSameInstance) {
            // r10: the target config moved MID-CHECK, so the preflight result
            // — pass OR fail — cannot vouch for the tab-fronted instance (a
            // PASS may have validated a different, safe install; it must never
            // bless a stop of this one). Its relaunch is UNPROVEN → refuse; an
            // instance with an unproven relaunch is never sent a stop.
            return ok({
              rebooting: false,
              ready: false,
              confirmed_cycle: false,
              refused: true,
              note:
                "Refusing to restart ComfyUI: the ComfyUI target configuration changed " +
                "while the restart safety check was running, so the check cannot vouch " +
                "for a safe relaunch of the instance this panel fronts. A stop is never " +
                "sent to an instance whose relaunch is unproven — ComfyUI was NOT " +
                "stopped (it is still running). Let the target settle, then retry " +
                "panel_restart_comfyui.",
            });
          }
          // r9: the danger proof follows the INSTANCE the tab fronts, not the mutable
          // runtime config — a config-only retarget mid-await must not wash out the
          // proof that the tab-fronted boot instance is unrelaunchable.
          if (!preflight.ok && tabFrontsSameInstance) {
            // r9: the danger proof follows the INSTANCE the tab fronts, NOT the
            // mutable runtime config — a config-only retarget mid-await must
            // not wash out the proof that the tab-fronted boot instance is
            // unrelaunchable. The tab STILL fronts that same instance, so the
            // proof is still valid and the refusal stands: an instance proven
            // unrelaunchable is NEVER sent a stop/reboot, regardless of
            // config/tab shuffling mid-flight. Only a genuinely different,
            // unconfirmable target falls through to the honest-unconfirmed
            // dispatch (nothing was ever proved dangerous for it — and nothing
            // was ever stopped, the preflight never stops anything).
            return ok({
              rebooting: false,
              ready: false,
              confirmed_cycle: false,
              refused: true,
              note:
                // The REASON leads, because there is now more than one shape that
                // reaches here — an externally-managed install whose launch command
                // cannot be rebuilt (Pinokio, #742) and a Desktop instance whose
                // supervisor has gone (#814) — and telling a Desktop user to check
                // Pinokio would send them somewhere they have never been.
                `Refusing to restart ComfyUI: ${preflight.reason}` +
                " A restart from here would " +
                "STOP ComfyUI and nothing would bring it back automatically, so it was " +
                "refused BEFORE anything was stopped — ComfyUI is still running. Restart it " +
                "from whatever launches it (its own launcher — e.g. Pinokio's own controls — " +
                "the Desktop app, or your terminal); for an externally-managed install you " +
                "can also point COMFYUI_PATH " +
                "at the live install so a relaunch can be proven and use restart_comfyui, " +
                "or set COMFYUI_RESTART_COMMAND to the exact command that restarts the " +
                "instance (e.g. `docker restart <container>`) — both restart tools then run " +
                "that command instead of needing the launch path resolvable from here.",
            });
          }
          // Otherwise: a PASS with a stable config (proven safe for THE
          // tab-fronted instance — proceed), or the tab now fronts a genuinely
          // different, unconfirmable target (nothing provable about it — the
          // dispatch path below treats that honestly, r6/r7). Nothing was
          // stopped in any case — the preflight never stops anything.
        }
        // r7: the preflight AWAIT sits between the binding capture and the dispatch,
        // breaking the no-await invariant above — a tab/connection rebind during
        // that await would make every pre-await capture stale (the dispatch would
        // go to an unconfirmable/different target while the causation stamp, the
        // recovery observer, and the legacy-fallback gate all read the STALE bound
        // base). Re-heal and re-capture the tab id, panel identity, and health base
        // AT THE DISPATCH POINT; everything below uses ONLY these fresh captures.
        ctx.ensureReachable?.();
        const boundTabId = ctx.tabId;
        // Snapshot the exact browser-tab registration that is about to receive the
        // reboot. A post-restart success must observe a strictly newer hello from
        // this SAME browser tab; a different tab can reuse the same saved-workflow
        // routing id while the original is still reconnecting.
        const preRestartPanelIdentity = ctx.panelConnectionIdentity?.();
        const healthBase = captureRebootHealthBase(ctx);
        // THE BINDING RULE APPLIES AT THE DISPATCH POINT, NOT ONLY BEFORE THE AWAIT.
        //
        // The check above happens before the preflight; a tab or connection rebind
        // DURING that await lands here with a target that is no longer bound, and
        // `tabFrontsSameInstance` being false meant neither post-await refusal fired
        // — so both a passing and a failing preflight fell through and the fresh,
        // unidentified tab received the reboot (codex gate round 12). The pre-await
        // check is kept because it avoids assessing an instance we already know we
        // may not act on; this one is what actually holds the line.
        //
        // Same rule, same exclusions: only a LOCAL target we cannot tie to the
        // instance this server accounts for is refused.
        const dispatchBound =
          healthBase != null && sameHttpBase(getComfyUIBaseUrl(), healthBase);
        if (!dispatchBound && !isRemoteMode() && !isCloudMode()) {
          return ok({
            rebooting: false,
            ready: false,
            confirmed_cycle: false,
            refused: true,
            note:
              "Refusing to restart ComfyUI: the panel connection changed while the restart " +
              "was being prepared, and I can no longer confirm which ComfyUI this tab " +
              "fronts — a restart STOPS a server, so it is never sent to one I cannot " +
              // Again: what I did, not what an unidentified instance is doing.
              "identify. Nothing was dispatched, so nothing was stopped. Retry once the " +
              // #1593 — the SAME unconditional recommendation, in the second refusal.
              // Fixing only the first would leave half the door open, and this branch
              // fires on a connection that just CHANGED, which is if anything a
              // stronger reason to check which server the other tool would hit.
              "panel has settled. " +
              restartRefusalHandoffAdvice({
                headlessBase: getComfyUIBaseUrl(),
                panelBase: healthBase,
                observedOrigin: ctx.bridge?.tabServerOrigin?.(ctx.tabId) ?? null,
              }),
          });
        }
        const timing = getPanelRebootTiming();
        const dispatchTimeout = Math.max(1, Math.min(15000, overallDeadline - Date.now()));
        // CONCURRENT OBSERVATION (coordinator): start probing the fixed boot endpoint NOW,
        // in parallel with the dispatch, so a FAST reboot whose down→up completes entirely
        // inside the ack/drop/timeout window is still captured (the reopened #509 fast-reboot
        // false-timeout). COUNTING stays post-write via the gate: the observer neither probes
        // nor counts until gate.dispatched flips (the instant AFTER the socket write), so a
        // pre-dispatch down never contributes. gate.deadline starts at the whole-handler cap
        // (probing spans the ack window) and is tightened to ack-completion + budget below.
        //
        // INHERENT TRADEOFF (coordinator, verified: no early-accept signal exists — the bridge
        // resolves send() only with the single rid-correlated {rebooting} reply, so accept vs
        // REFUSE is known only IN that reply). To catch a fast reboot we MUST probe DURING the
        // ack window, i.e. before we know accept/refuse. The residual is BENIGN and bounded:
        //   • the probe targets ONLY the orchestrator's OWN immutable, server-authorized boot
        //     ComfyUI (captureRebootHealthBase → getBootLocalComfyUIBaseUrl) with the correct
        //     configured auth — never a client-advertised, cross-family, or wrong instance, so
        //     it is NOT an auth leak or a wrong-instance probe (handshake-Origin gated above);
        //   • a genuinely REFUSED reboot does NOT restart ComfyUI, so no REAL ECONNREFUSED→
        //     healthy cycle occurs to certify; and even a CONTRIVED one is explicitly discarded
        //     (the refusal branch below returns the refusal verbatim and never reads the
        //     observer — a refusal can NEVER certify).
        // Eliminating even this harmless own-endpoint read would require probing only AFTER the
        // reply, which reopens the #509 fast-reboot false-timeout — an unacceptable regression.
        let signalDispatched!: () => void;
        const gate: DispatchObservationGate = {
          dispatched: false,
          dispatchedAt: Number.POSITIVE_INFINITY,
          cancelled: false,
          deadline: overallDeadline,
          waitDispatched: new Promise<void>((r) => {
            signalDispatched = r;
          }),
        };
        // #742 — A REMOTE TARGET HAS NO LOOPBACK BOOT ENDPOINT, BUT IT DOES HAVE AN ADDRESS.
        //
        // `captureRebootHealthBase` is loopback-only, so on the remote path nothing was ever
        // probed and the dispatch returned "it is restarting out-of-band … check in a few
        // seconds". For a Pinokio install nothing restarts it — its launcher only re-launches
        // on the Manager's dependency-install message — so the reporter's server stopped and
        // stayed stopped while the result described a restart in progress.
        //
        // The base this session already talks to for every other call is probeable, with the
        // same configured auth, so it is watched here too. What it may CONCLUDE is deliberately
        // one-directional (see the await below): a healthy answer proves the ADDRESS responds,
        // never that this instance cycled — a tab can front a different instance than the
        // orchestrator is configured for, which is the whole reason the loopback path demands a
        // handshake-Origin match before it certifies anything. So this can report a failure to
        // come back; it can never manufacture readiness.
        const remoteProbeBase =
          healthBase == null && isRemoteMode()
            ? (getComfyUIBaseUrl() || "").replace(/\/+$/, "") || null
            : null;
        const recoveryPromise =
          healthBase != null
            ? observeRecovery(timing, gate.deadline, { healthBase, gate })
            : remoteProbeBase != null
              ? observeRecovery(timing, gate.deadline, { healthBase: remoteProbeBase, gate })
              : null;
        // The AUTHORITATIVE, TYPED dispatch outcome from the bridge rejection (if any):
        // false = a PRE-write send failure (nothing transmitted), true = a POST-write
        // mid-command OUTCOME-UNKNOWN drop / reply-timeout. Captured from the RAW error —
        // text can't defeat it — so a pre-write failure whose detail happens to quote
        // "OUTCOME UNKNOWN" is still categorically NOT-dispatched (coordinator P1).
        let res: ToolResult;
        let dispatchOutcome: boolean | undefined;
        // ctx.bridge.send()'s Promise executor writes to the socket SYNCHRONOUSLY, so by the
        // time it returns the promise the command has been written (or synchronously pre-write
        // failed). Open the counting gate right here — this is the POST-write instant — then
        // await the ack. Probing (already running) begins the moment this flips.
        const sendPromise = ctx.bridge.send(
          { cmd: "comfy_reboot", force: force === true } as { cmd: string },
          { tabId: boundTabId, timeoutMs: dispatchTimeout },
        );
        gate.dispatched = true;
        gate.dispatchedAt = Date.now();
        // Wake the observer's FIRST probe IMMEDIATELY (microtask — no timer window) now that
        // the command has been written. Resolved on EVERY path (accept / drop / refuse /
        // pre-write failure), so the observer never hangs on gate.waitDispatched.
        signalDispatched();
        try {
          res = ok(await sendPromise);
        } catch (err) {
          res = fail(err);
          dispatchOutcome = dispatchOutcomeOf(err);
        }
        // A PRE-write send failure means nothing was transmitted — the reboot never happened,
        // so NOTHING may certify: abort the concurrent observer immediately (coordinator P1).
        if (dispatchOutcome === false) gate.cancelled = true;

        // Classify the reboot dispatch:
        //  - CONFIRMED (rebooting:true): the panel acked before it went down.
        //  - EXPECTED DROP: the reboot handler exits the instant it accepts the request,
        //    so ComfyUI (and the tab it serves) goes down before it can ack — a bridge
        //    mid-command "OUTCOME UNKNOWN"/disconnect. That drop IS the accept + went-down
        //    signal (#493, panel #222/#263/#266/#306/#307).
        //  - REFUSAL: a busy-guard / Manager-forbidden / no-endpoint refusal — the server
        //    is still up and was NOT restarted; return it verbatim and touch nothing.
        const fired = rebootConfirmed(res);
        // A pre-write send failure (typed dispatchOutcome === false) is categorically NOT an
        // accepted drop — never enter the probing path for a command that never left. The
        // text check (rebootDropped) is a defense-in-depth fallback for older bridges that
        // don't carry the typed flag.
        const dropped =
          !fired && dispatchOutcome !== false && (dispatchOutcome === true || rebootDropped(res));
        if (!fired && !dropped) {
          // NOT accepted (e.g. a rebooting:false busy-guard/security REFUSAL). BELT-AND-
          // SUSPENDERS (coordinator): EXPLICITLY DISCARD any cycle the concurrent observer may
          // have sampled during the sub-ack window — a refusal must NEVER certify. We cancel
          // the observer and, crucially, never read recoveryPromise on this path: whatever it
          // resolved to (even a contrived ready:true) is dropped, and we return the refusal
          // verbatim. (The legacy no-endpoint fallback below starts its OWN fresh observation
          // after the restart's synchronous work; it does not reuse this observer.)
          gate.cancelled = true;
          void recoveryPromise; // discarded — a refused reboot can never yield ready:true
          // If the SOLE reason is NO Manager reboot endpoint (legacy Manager
          // 3.x — #425, panel #253/#266) AND the target is a LOCAL, process-controllable
          // ComfyUI, fall back to the headless managed restart (kill + relaunch). A
          // busy-guard / security refusal is NOT eligible (rebootNoEndpoint excludes them).
          // #425 RECURRENCE (remote RunPod, 0.50.27). The managed fallback below is
          // LOCAL-ONLY and correctly does nothing here — there is no process on this
          // machine to restart. But falling through returned the bare "no reboot
          // endpoint … was NOT restarted", which is where the owner's report ended:
          // freshly installed custom nodes stayed unavailable "until a provider/host
          // restart", and nothing had told them a host restart was the requirement.
          //
          // Say what this target actually needs. We do NOT cycle the pod ourselves:
          // stop/resume bills, interrupts everything else on the box, and on a spot
          // instance may not come back — that is the user's call, not a side effect
          // of asking to restart ComfyUI.
          if (isRemoteMode() && rebootNoEndpoint(res)) {
            return ok({
              rebooting: false,
              ready: false,
              confirmed_cycle: false,
              note:
                `${toolResultText(res)}\n\n` +
                `This ComfyUI is REMOTE, so the managed restart that covers a local install ` +
                `does not apply — there is no process on this machine to cycle. A 405 from a ` +
                `Manager reboot route means that route is not registered on the running ` +
                `Manager (the frontend catchall answers every unregistered POST with 405), so ` +
                `it is a Manager version/dialect that exposes no reboot API rather than an ` +
                `auth failure.\n\n` +
                `WHAT WILL WORK: restart the HOST. Anything you just installed — custom nodes ` +
                `especially — stays unavailable until the ComfyUI process itself restarts, and ` +
                `nothing this MCP can reach will load it. On RunPod, runpod (action:"stop") ` +
                `then runpod (action:"start") with the pod_id cycles the box (stop ends ` +
                `billing; start bills again). Otherwise restart the container or provider ` +
                `however you normally would.\n\n` +
                `Do NOT report the newly installed nodes as ready: they are not loaded.`,
            });
          }
          if (
            !isRemoteMode() &&
            rebootNoEndpoint(res) &&
            // ENDPOINT BINDING: restartComfyUI() acts on the orchestrator's GLOBAL config
            // target (a hello can retarget it). Only run it when the bound tab fronts our
            // OWN boot URL AND that URL is the CURRENT global target — so the relaunch
            // cycles the endpoint this tab TARGETED, not one it was retargeted away from.
            // Targeted, not rebooted: this branch runs only when `rebootNoEndpoint`
            // says the Manager reboot was refused for want of an endpoint, so nothing
            // was rebooted here at all.
            //
            // "Endpoint", not "instance": `sameHttpBase` compares URLs, which cannot see a
            // server replaced at the same URL between the reboot and here. That gap is real
            // and tracked in #871; this gate narrows the window, it does not close it.
            healthBase != null &&
            sameHttpBase(getComfyUIBaseUrl(), healthBase)
          ) {
            return runHeadlessManagedRestart({
              healthBase,
              preRestartPanelIdentity,
              why: "The built-in Manager exposed no reboot endpoint (legacy Manager 3.x)",
              mechanism: "the headless managed restart (kill + relaunch)",
              noteHealthyLead:
                "ComfyUI-Manager (legacy 3.x) had no reboot endpoint; the headless managed restart",
              noteRanLead:
                "ComfyUI-Manager (legacy 3.x) had no reboot endpoint; ran the headless managed " +
                "restart (kill + relaunch)",
            });
          }
          // Genuine refusal (busy guard / security / no eligible fallback) — return
          // verbatim; do NOT reset caches (that would close the shared client mid-render).
          return res;
        }

        // ACCEPTED. A reboot restarts ComfyUI out-of-band, so the orchestrator's cached WS
        // client + /object_info go stale (#353/#357/#378/#394) — drop both caches. The
        // detected ComfyUI-Manager dialect is live-derived too and a reboot can bring back
        // a different Manager generation on the same URL (#646), so drop that as well.
        resetClient();
        resetObjectInfoCache();
        resetManagerApiCache("panel Manager reboot");
        // #742 r4/r5/r6: record the ACTUAL dispatch (acceptance proven — a refusal
        // never reaches here). ONLY a BOUND-CONFIRMED target (the same binding
        // the r1 causation scoping and the refuse-safe preflight use) may stamp a
        // causation-capable record — held on THIS session with the BOUND base at
        // stamp time, never the mutable configured one. An unbound/unconfirmable
        // target (r6) stamps only the shared PROCESS-WIDE slot, which never
        // grounds causation: the dispatch can't be proven to have hit the
        // instance a later decline would probe, and a session that rebinds to
        // the boot tab afterward can't claim it either (a re-targeted session
        // can't prove the earlier dispatch hit its current instance — no claim
        // is the truthful answer). It is cleared below if observed back —
        // CLEAR-IF-SAME on the token stamped here (r15).
        let acceptedDispatchToken: string | undefined;
        if (healthBase != null && sameHttpBase(getComfyUIBaseUrl(), healthBase)) {
          acceptedDispatchToken = stampSessionRestartDispatch(ctx, healthBase);
        } else {
          recordRestartDispatch(getComfyUIBaseUrl(), PROCESS_WIDE_RESTART_DISPATCH_TOKEN);
        }

        // Observe recovery. There is exactly ONE sound proof that THIS ComfyUI instance
        // actually cycled: a directly OBSERVED down→up on the server-authorized, immutable,
        // family-bound boot endpoint (observeRecovery). We do NOT fabricate a second proof
        // from a weaker proxy. In particular a panel tab disconnecting→reconnecting proves
        // only that a panel↔orchestrator socket churned — NOT that the (possibly remote)
        // ComfyUI cycled; `tab_id` is client-supplied and a different same-kind socket can
        // take that id over with a fresh nonce, so a tab reconnect can never certify a
        // same-instance restart (codex gate). So when there is NO probeable boot endpoint
        // (remote / cloud / older / untrusted-locality panel), we HONESTLY report the reboot
        // as dispatched-and-accepted but NOT server-confirmable — a non-error result that
        // tells the caller to verify, NOT the #509 false-TIMEOUT *error* (the real #509 local
        // case is a probeable boot endpoint and is certified by observeRecovery below).
        if (healthBase == null) {
          // #742 — REPORT A SERVER THAT NEVER CAME BACK, instead of describing a restart.
          //
          // Only the NEGATIVE direction is read from this observation, and only when the
          // window closed with the address still down. `sawDown` alone is not enough: a
          // successful fast restart also goes down, so treating it as failure would call
          // every healthy remote reboot a death. And a healthy answer is never upgraded to
          // readiness — `ready`/`confirmed_cycle` stay false on every branch here, exactly
          // as before, because this probe cannot prove WHICH instance answered.
          // Measure the readiness budget from ACK COMPLETION, exactly as the bound path
          // below does — without this the observer would run to the whole-handler cap and a
          // remote dispatch could sit here far longer than a local one.
          gate.deadline = Math.min(Date.now() + timing.budgetMs, overallDeadline);
          const remote = remoteProbeBase != null ? await recoveryPromise : null;
          // The trigger reads the LAST observation, not the latched `sawDown` (codex r2):
          // a remote tunnel/NAT can refuse one connection and then answer — 401, 503, a
          // timeout, all of which classify "unknown" — leaving `sawDown` true for the rest
          // of the window while the endpoint was responding the whole time. Reporting a
          // dead server from that is a false alarm about someone's live install. Requiring
          // the final sample to still be "down" means the claim describes where the window
          // actually ENDED, which is the only thing this note asserts.
          if (
            remote != null &&
            remote.sawDown &&
            !remote.ready &&
            remote.lastStatus === "down"
          ) {
            const waited = Math.round(remote.waited_ms / 1000);
            // SAY WHAT WAS MEASURED, AND NOT ONE STEP FURTHER (codex P1).
            //
            // A first version told the reader "do not wait for it — it will stay down". That
            // is a claim about the FUTURE built from a bounded window: a remote host can take
            // longer than this budget to boot, and it would have sent someone off to hand-start
            // a server that was seconds from coming back. Unmeasured advice stated confidently
            // is the exact defect #742 is about; making it point the other way is not a fix.
            //
            // What IS established: this address went down and did not answer again inside the
            // window. Both explanations are named, and so is the one cheap check that separates
            // them — which is all the caller needs to pick a next step.
            //
            // (A second probe after the window was tried and dropped: it added a call that
            // could start past the handler's own deadline (codex P2) to support a "still not
            // answering RIGHT NOW" phrasing that this wording no longer needs.)
            return ok({
              rebooting: true,
              ready: false,
              confirmed_cycle: false,
              dispatched: true,
              saw_down: true,
              probes: remote.attempts,
              note:
                `ComfyUI restart was dispatched and accepted, and ${remoteProbeBase} WENT DOWN — ` +
                `it has NOT come back within ${waited}s and was still not answering on the last ` +
                `check. That does NOT prove it is gone for good: a remote host can take longer ` +
                `than this to boot. It is also what a restart that nothing relaunches looks like, ` +
                `which is common for an externally-managed install (e.g. Pinokio, whose launcher ` +
                `only re-launches on the Manager's dependency-install signal). Check ` +
                `get_system_stats (action:"health") in a moment. If it is still unreachable then, ` +
                `start ComfyUI from its own launcher (Pinokio, the Desktop app, your terminal) ` +
                `and reload the browser tab so the panel reconnects.`,
            });
          }
          // Unchanged for every other case — including "it answered", which is NOT promoted
          // to a confirmed cycle.
          return ok({
            rebooting: true,
            ready: false,
            confirmed_cycle: false,
            dispatched: true,
            ...(remote != null ? { saw_down: remote.sawDown, probes: remote.attempts } : {}),
            note:
              "ComfyUI restart was dispatched and accepted; it is restarting out-of-band. " +
              "There is no local boot endpoint I can safely probe from here, so I can't " +
              "confirm it finished coming back — a panel reconnect wouldn't prove this " +
              'instance actually cycled. Check get_system_stats (action:"health") / panel_node_queue_status in a ' +
              "few seconds to confirm it's back." +
              (preflightNote ? ` ${preflightNote}` : ""),
          });
        }
        // The concurrent observer has been probing since dispatch (catching a fast down→up
        // inside the ack window). Now measure the readiness budget from ACK COMPLETION — so a
        // slow ack doesn't eat it — by tightening the live deadline, then await the verdict.
        // Both fired and dropped are AMBIGUOUS (the panel emits rebooting:true even when it
        // only INFERS a reboot from a dropped fetch), so certification requires an OBSERVED
        // down→up, which the observer has been (and continues) watching for.
        gate.deadline = Math.min(Date.now() + timing.budgetMs, overallDeadline);
        const recovery = await recoveryPromise!;
        // #742 r4/r5/r15: the dispatched restart was observed back — clear the
        // record, CLEAR-IF-SAME: only when the session still holds the token
        // THIS dispatch stamped (a concurrent dispatch's newer record survives).
        if (recovery.ready && acceptedDispatchToken != null) {
          clearSessionRestartDispatchIfSame(ctx, acceptedDispatchToken);
        }
        if (!recovery.ready) {
          const waited = Math.round(recovery.waited_ms / 1000);
          return ok({
            rebooting: true,
            ready: false,
            confirmed_cycle: false,
            recovered_ms: recovery.waited_ms,
            probes: recovery.attempts,
            saw_down: recovery.sawDown,
            note:
              (recovery.sawDown
                ? `Reboot was dispatched and ComfyUI went down, but it has not become healthy within ${waited}s — it may still be starting or the restart failed. Verify with get_system_stats (action:"health") / panel_node_queue_status before retrying; do NOT assume it is back.`
                : `The reboot command was sent but I could NOT confirm ComfyUI actually cycled within ${waited}s (it never went down — the panel may have merely disconnected/inferred a reboot without one). Verify with get_system_stats (action:"health") / panel_node_queue_status; do NOT assume it restarted.`) +
              (preflightNote ? ` ${preflightNote}` : ""),
          });
        }
        // #400/#709: ComfyUI is healthy, but the panel's browser tab re-registers its own
        // socket a moment later. The old socket can still be reachable after dispatch, so
        // the generation waiter below requires a fresh hello before reporting readiness.
        // hits "no connected tab … Connected: none" and the agent is told to hand-rebind.
        // Wait (bounded, clamped to THIS handler's deadline) for the tab to reconnect and
        // rebind this session onto it. `ready` reflects GRAPH-TOOL readiness (a bound tab),
        // NOT just server health — a caller keying off `ready` must not be led into the
        // Connected:none window (codex). `server_ready` carries the certified cycle either
        // way. A production PanelToolCtx supplies the generation waiter; an explicitly
        // lightweight context retains the historical reachability-only test contract.
        const tabBack = ctx.awaitPostRestartReachable
          ? await ctx.awaitPostRestartReachable(
              preRestartPanelIdentity,
              Math.max(0, overallDeadline - Date.now()),
            )
          : ctx.awaitReachable
            ? await ctx.awaitReachable(Math.max(0, overallDeadline - Date.now()))
            : true;
        // A recovered socket does NOT mean graph mutations are usable: an already-open
        // browser tab can reconnect after ComfyUI restarts while still serving stale panel
        // JS, which lacks the #570 workflow-stamp fence. Report the same capability the
        // bridge enforces before dispatch so this success path never fabricates readiness.
        // Old/lightweight contexts have no capability accessor, so preserve their historical
        // contract rather than claiming a production tab passed a check it never ran.
        const graphToolsReady = tabBack && (ctx.tabCanMutateGraph ? ctx.tabCanMutateGraph() : true);
        // #654 — same split as the legacy path above. The gate is unchanged:
        // `ready`/`graph_tools_ready` still key off the boolean, so an undetermined
        // reconnect still withholds graph tools. Only the reported observation changes.
        const tabReconnect = classifyTabReconnect({
          serverReady: true, // this branch only runs on a confirmed healthy cycle
          baselineCaptured: preRestartPanelIdentity != null,
          tabBack,
        });
        // #848: WHAT THIS RESTART DID NOT DO. "It came back healthy" answers a
        // different question from "did it come back with the launch arguments I just
        // configured?", and a user who had edited ComfyUI Desktop's saved launch args
        // read the first as the second — their new flag was silently absent. Compare
        // the two readings and report only what was observed.
        //
        // Gated because a wrong-instance reading would be worse than no reading: the
        // preflight must have OBSERVED a before-argv (it only runs on the bound path),
        // and the target must STILL be the instance that preflight described — a
        // retarget would point getSystemStats at some other ComfyUI. Read after
        // recovery, so a slow or missing answer costs only detail; describeArgvDrift
        // says nothing without both readings.
        //
        // The generation is re-checked AFTER the await, not only before it (codex gate
        // round 2): a base comparison taken before the read cannot see a retarget that
        // lands DURING it, and an A→B→A round trip leaves the base equal either way.
        // preflightArgvGeneration is captured at the preflight, so the whole span from
        // the "before" reading to the "after" one is inside one fence.
        let argvNote = "";
        if (preflightArgv?.length) {
          const afterArgv = await readServingArgv(2000);
          if (
            getComfyuiTargetGeneration() === preflightArgvGeneration &&
            sameHttpBase(getComfyUIBaseUrl(), healthBase)
          ) {
            argvNote = describeArgvDrift(
              preflightArgv,
              afterArgv,
              preflightIsDesktop,
              // #848: BOTH restart paths, or the answer depends on which one the user
              // happened to take. This is the panel tool's own path; the service's
              // Manager-reboot path passes the same finding.
              preflightIsDesktop
                ? describeSavedLaunchArgDrift(
                    desktopSavedLaunchArgs(config.comfyuiPath ?? undefined),
                    afterArgv,
                  )
                : "",
            );
          }
        }
        return ok({
          rebooting: true,
          ready: graphToolsReady, // graph tools require a bound AND workflow-stamp-capable tab
          graph_tools_ready: graphToolsReady,
          server_ready: true, // ComfyUI itself cycled and is healthy
          confirmed_cycle: true, // we directly observed the down→up cycle on the boot endpoint
          recovered_ms: recovery.waited_ms,
          probes: recovery.attempts,
          saw_down: recovery.sawDown,
          via: recovery.via,
          panel_tab_reconnected: tabReconnect,
          note:
            (tabBack && !graphToolsReady
              ? `ComfyUI restart accepted and it is healthy again in ${(recovery.waited_ms / 1000).toFixed(1)}s` +
                " (observed it go down then come back); the panel tab reconnected but cannot safely run " +
                "graph mutations (ready:false), usually because it is still running a stale panel bundle. " +
                "Hard-refresh the ComfyUI browser tab (Ctrl+Shift+R) before issuing graph tools; if that " +
                "does not restore it, update the panel and open/reload a saved workflow with a stable identity"
              : `ComfyUI restart accepted and it is healthy again in ${(recovery.waited_ms / 1000).toFixed(1)}s` +
            " (observed it go down then come back)" +
            (dropped ? "; connection dropped as expected while it went down" : "") +
            (tabBack
              ? "; the panel tab reconnected — graph tools are ready."
              : tabReconnect === "unknown"
                ? "; ComfyUI is back, but whether the panel tab reconnected could NOT be determined — no " +
                  "pre-restart baseline was captured for it, so nothing was watched. WHY is not " +
                  "established here, and it is one of: its socket was not open at the instant the " +
                  "restart was dispatched; the panel advertised no tab session id (an older build, or " +
                  "a refused browser-tab lease); or the tab did not resolve at all. The tab may well " +
                  "be back. Graph tools are withheld (ready:false) because that is UNPROVEN, not " +
                  "because the tab is known to be gone: call panel_list_workflows or " +
                  'panel_set_workflow_target({mode:"current"}) to find out, and refresh the browser only ' +
                  "if those also fail. If this repeats on every restart, the panel is probably too old " +
                  "to advertise a tab session id — update it."
                : "; ComfyUI is back but the panel tab has NOT reconnected yet (ready:false) — " +
                  'wait a moment then retry, or rebind with panel_set_workflow_target({mode:"current"}) ' +
                  "before issuing graph tools.") +
            ".") + argvNote + (preflightNote ? ` ${preflightNote}` : ""),
        });
      },
    ),
    def(
      "panel_free_vram",
      "Unload all loaded models and free VRAM (ComfyUI /free). Use to unwedge a stuck/OOM ComfyUI when a cancel didn't free memory — before retrying or, last resort, restarting (panel_restart_comfyui). Does NOT restart ComfyUI; it just drops resident models and frees cached memory. If the panel tab is frozen and cannot acknowledge, the free is instead issued DIRECTLY to the ComfyUI server and verified there (same /free, idempotent) whenever the tab provably fronts the local server — otherwise the outcome is reported unknown rather than claimed.",
      {},
      async (_args, ctx) => {
        const res = await ctx.call({ cmd: "free_vram" }, 15000);
        // #1249 — ONLY a no-reply is settled server-side. An acked executor error
        // (the panel's own "Failed to free VRAM: …") is a reply the bridge
        // received and relayed; it already says what failed, and re-issuing from
        // out here would fire a second mutation behind a verdict the caller was
        // given. A tagged reply-timeout is the one case where nothing answered.
        if (!isReplyTimeoutResult(res)) return res;
        return settleFreeVramAfterAckTimeout(ctx, res);
      },
    ),
    def(
      "panel_show_media",
      "Display one or more images or videos directly in the panel chat. Use this whenever the user asks to SEE or SHOW a file — a disk path you composited/downloaded/generated (absolute path on the orchestrator host) OR a ComfyUI output ref ({ filename, subfolder?, type? }). Items are rendered as media cards in the agent chat area; supply optional captions. Max 8 items per call. NEVER describe an image with emoji or text placeholders — call this tool instead.",
      {
        items: z
          .array(
            z.object({
              source: z.union([
                // Absolute file path on the orchestrator host
                z.object({ path: z.string().min(1) }),
                // ComfyUI /view ref
                z.object({
                  filename: z.string().min(1),
                  subfolder: z.string().optional(),
                  type: z.string().optional(),
                }),
              ]),
              caption: z.string().optional(),
            }),
          )
          .min(1)
          .max(8),
      },
      async (args: A, ctx) => {
        const items = args.items as Array<{
          source:
            | { path: string }
            | { filename: string; subfolder?: string; type?: string };
          caption?: string;
        }>;

        const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
        // #811 — this used to be just {.mp4, .webm}, narrower than what this
        // codebase ALREADY treats as video elsewhere: get_image's
        // action:"list_outputs" documents ".mp4/.webm/.mov/.mkv/.m4v/.avi", and
        // upload_image's action:"video" accepts the identical set. A ProRes
        // .mov produced by VHS/standard ComfyUI video nodes was refused here
        // even though every other tool in this codebase already calls it a
        // valid video output. Aligned to the same set both of those already use.
        //
        // This widens the CONTAINER-extension gate only — it does not and
        // cannot guarantee browser-side codec decode (a ProRes stream inside
        // that .mov may still not play natively outside Safari). That is a
        // downstream browser limitation, not a reason to refuse the file
        // upfront: the panel's video path already degrades gracefully when a
        // codec can't be decoded (falls back to a native <video> element,
        // which surfaces the browser's own playback error, rather than
        // silently failing) — an honest browser failure is a strictly better
        // outcome than a blanket refusal at this gate for every .mov file,
        // most of which (H.264/H.265-encoded) play back completely fine.
        const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi"]);
        // Real IANA subtypes. The old code built video MIME by naive
        // `"video/" + ext.slice(1)`, which only ever worked for .mp4/.webm by
        // COINCIDENCE (their extension equals their MIME subtype) — extended to
        // .mov/.mkv/.avi it would have produced invalid types (`video/mov`
        // instead of `video/quicktime`), and a wrong MIME can make a browser
        // refuse to even ATTEMPT playback before the codec is ever considered.
        const VIDEO_MIME: Record<string, string> = {
          ".mp4": "video/mp4",
          ".webm": "video/webm",
          ".mov": "video/quicktime",
          ".mkv": "video/x-matroska",
          ".m4v": "video/x-m4v",
          ".avi": "video/x-msvideo",
        };
        const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

        const resolved: Array<Record<string, unknown>> = [];
        /** Oversized items that took the /view reference route instead (#648). */
        const forwarded: ForwardedByReference[] = [];
        // #941 — /view references handed to a BROWSER panel, whose rendering this
        // process never observes. Collected so the reply can say what "painted"
        // does and does not establish.
        const unverifiedRefs: UnverifiedViewRef[] = [];
        for (const item of items) {
          const src = item.source;
          if ("path" in src) {
            // Absolute disk path — orchestrator reads + base64-encodes it.
            const p = src.path;
            if (!isAbsolute(p)) {
              return fail("path must be absolute: " + p);
            }
            // ONE stat, three distinct outcomes. existsSync + statSync split the
            // question across two syscalls and left the third case unhandled: a
            // file that EXISTS but cannot be stat'ed (permissions, a broken
            // symlink, an unreachable share) threw straight out of the handler
            // as an opaque transport error. "Could not read it" is neither "not
            // found" nor "too large", and reporting it as either sends the
            // caller to fix the wrong thing.
            let stat: Stats;
            try {
              stat = statSync(p);
            } catch (err) {
              const code = (err as NodeJS.ErrnoException)?.code;
              if (code === "ENOENT") {
                return fail("file not found: " + p);
              }
              return fail(
                "could not read file metadata for " +
                  p +
                  ": " +
                  (err instanceof Error ? err.message : String(err)) +
                  " — that is not the same as the file being absent, and it is not a size limit; " +
                  "check permissions and that the path is reachable, then retry",
              );
            }
            if (!stat.isFile()) {
              return fail("not a regular file: " + p);
            }
            // Type BEFORE size: a file this tool can never display is refused for
            // what is actually wrong with it, and only real media is considered
            // for the reference route.
            const ext = extname(p).toLowerCase();
            let mime: string;
            let kind: "image" | "video";
            if (IMAGE_EXTS.has(ext)) {
              mime = ext === ".jpg" ? "image/jpeg" : "image/" + ext.slice(1);
              kind = "image";
            } else if (VIDEO_EXTS.has(ext)) {
              mime = VIDEO_MIME[ext];
              kind = "video";
            } else {
              return fail(
                "unsupported file type \"" + ext + "\" (allowed: " + [...IMAGE_EXTS, ...VIDEO_EXTS].join(", ") + "): " + p,
              );
            }
            if (stat.size > MAX_BYTES) {
              // Too big to INLINE is not the same as too big to SHOW. When the
              // file already sits under a directory ComfyUI serves, the panel
              // can fetch it same-origin with no cap at all — so forward a ref
              // rather than dead-ending the caller at a ceiling it cannot pass.
              // MAX_BYTES stays exactly where it is; it guards the inline path,
              // which this route does not use.
              const servable = await resolveServableViewRef(p);
              if (servable.status === "servable") {
                resolved.push({
                  kind: "viewRef",
                  viewRef: servable.ref,
                  filename: servable.ref.filename,
                  caption: item.caption,
                });
                forwarded.push({ path: p, sizeBytes: stat.size, kind, ref: servable.ref });
                continue;
              }
              return fail(
                oversizedInlineRefusal({
                  path: p,
                  sizeBytes: stat.size,
                  capBytes: MAX_BYTES,
                  kind,
                  resolution: servable,
                }),
              );
            }
            let buf: Buffer;
            try {
              buf = readFileSync(p);
            } catch (err) {
              // statSync proves METADATA access, not read access — a mode/ACL
              // can permit one and deny the other — so "it was readable a moment
              // ago" would assert something never observed. State only what the
              // stat established, and keep ENOENT (a delete that raced this
              // read) distinct from a permission wall.
              const code = (err as NodeJS.ErrnoException)?.code;
              const detail = err instanceof Error ? err.message : String(err);
              if (code === "ENOENT") {
                return fail(
                  "the file disappeared between being measured and being read: " +
                    p +
                    " — it existed a moment ago; re-check the path and retry",
                );
              }
              return fail(
                "could not read file contents for " +
                  p +
                  ": " +
                  detail +
                  " — its metadata was readable but its contents were not, which is a permissions or device problem, not a size limit",
              );
            }
            const dataUrl = "data:" + mime + ";base64," + buf.toString("base64");
            const filename = p.replace(/.*[\/]/, "");
            resolved.push({ kind, dataUrl, filename, caption: item.caption });
          } else {
            // ComfyUI /view ref. A browser panel fetches it same-origin — but a
            // HEADLESS (mobile/remote) client can't reach ComfyUI, so resolve the
            // bytes HERE and inline them as a data URL. Best-effort: any failure
            // (fetch error, non-media, too big) falls back to forwarding the ref,
            // which the client renders as a caption card.
            let inlined = false;
            if (ctx.bridge.isHeadless(ctx.tabId)) {
              try {
                const base = (process.env.COMFYUI_URL ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
                const qs = new URLSearchParams({ filename: src.filename, type: src.type ?? "output" });
                if (src.subfolder) qs.set("subfolder", src.subfolder);
                const resp = await comfyuiFetch(`${base}/view?${qs.toString()}`);
                if (resp.ok) {
                  const mime = resp.headers.get("content-type") ?? "";
                  const buf = Buffer.from(await resp.arrayBuffer());
                  if ((mime.startsWith("image/") || mime.startsWith("video/")) && buf.length <= MAX_BYTES) {
                    resolved.push({
                      kind: mime.startsWith("video/") ? "video" : "image",
                      dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
                      filename: src.filename,
                      caption: item.caption,
                    });
                    inlined = true;
                  }
                }
              } catch {
                // fall through to the viewRef path
              }
            }
            if (!inlined) {
              resolved.push({
                kind: "viewRef",
                viewRef: {
                  filename: src.filename,
                  subfolder: src.subfolder,
                  type: src.type,
                },
                filename: src.filename,
                caption: item.caption,
              });
              // #941 — the panel will report this as painted, meaning it made a
              // card. Whether the IMAGE loads is decided later, by the browser's
              // own /view fetch, and a proxied ComfyUI answering HTML breaks it
              // with no error anywhere. Remember the ref so the reply can say so.
              unverifiedRefs.push({
                filename: src.filename,
                subfolder: src.subfolder,
                type: src.type,
              });
            }
          }
        }

        const res = await ctx.call({ cmd: "show_media", items: resolved }, 60000);
        // Why an item the caller passed as a PATH came back described as a
        // reference — the panel cannot say, because it never saw the path or the
        // size. Appended as a separate block so the panel's own reply (which is
        // the only thing that knows what was actually painted) is left intact.
        if (forwarded.length > 0 && !res.isError) {
          res.content.push({
            type: "text",
            text: forwardedByReferenceNote(forwarded, MAX_BYTES),
          });
        }
        // #941 — a forwarded /view reference is DISPATCHED, not displayed. Probe a
        // bounded sample from here so the note can carry evidence instead of only
        // a caveat; the probe is best-effort and never affects the result.
        if (unverifiedRefs.length > 0 && !res.isError) {
          const probe: ViewRefProbe = { checked: 0, nonMedia: [] };
          const base = (process.env.COMFYUI_URL ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
          for (const ref of unverifiedRefs.slice(0, 3)) {
            try {
              const qs = new URLSearchParams({ filename: ref.filename, type: ref.type ?? "output" });
              if (ref.subfolder) qs.set("subfolder", ref.subfolder);
              const resp = await comfyuiFetch(`${base}/view?${qs.toString()}`, {
                method: "HEAD",
                signal: AbortSignal.timeout(4000),
              });
              probe.checked++;
              const mime = resp.headers.get("content-type") ?? "";
              if (!resp.ok) {
                probe.nonMedia.push({ filename: ref.filename, detail: `HTTP ${resp.status}` });
              } else if (!mime.startsWith("image/") && !mime.startsWith("video/")) {
                probe.nonMedia.push({
                  filename: ref.filename,
                  detail: `content-type "${mime || "unset"}"`,
                });
              }
            } catch {
              // An unreachable /view from HERE says nothing reliable about the
              // browser's origin, so it is simply not counted as checked.
            }
          }
          res.content.push({
            type: "text",
            text: unverifiedViewRefNote(unverifiedRefs, probe),
          });
        }
        return res;
      },
    ),
    def(
      "panel_ui_render",
      "Render an INTERACTIVE UI CARD in the panel chat from an A2UI-subset JSON spec — choice buttons, forms (TextField/Select/Checkbox + a submit Button), node-wiring diagrams (comfy:graph), and bar/line charts (comfy:chart). Use a card whenever the user must pick between options, confirm a plan, fill in parameters, or would understand a wiring explanation better as a diagram. The card is non-blocking: this returns { card_id } immediately; when the user clicks a button (or submits a form) their choice arrives as a NORMAL chat message (the button's `reply` text; submit buttons append 'name: value' lines) — so after rendering a card that asks a question, END YOUR TURN and wait. Set surface:'wide' for diagram-heavy cards (the panel widens and restores automatically). Spec shape: { surface?, title?, root: '<id>', components: [ {id, type, ...} ] } with children referenced by id. Types: Text{text}, Heading{text,level?}, Button{label,reply?,submit?,style?:'primary'|'secondary'}, Row/Column/Card{children:[ids]}, Divider, Image{src:/view-URL,caption?}, TextField{label,name,value?,placeholder?}, Select{label,name,options:[{label,value?}],value?}, Checkbox{label,name,checked?}, 'comfy:graph'{nodes:[{id,label,color?}],edges:[{from,to,label?}],direction?:'lr'|'tb'}, 'comfy:chart'{kind:'bar'|'line',series:[{label,values:[num]}],x?:[labels]}. Caps: ≤64 components, ≤30 graph nodes, ≤8×256 chart points. On a validation error, FIX the spec and retry.",
      {
        spec: z
          .record(z.string(), z.unknown())
          .describe("The A2UI-subset card spec object (see tool description for the exact shape)."),
      },
      async (args: A, ctx) => {
        const v = validateA2UISpecServer(args.spec);
        if (!v.ok) return fail(`invalid a2ui spec: ${v.errors.join("; ")}`);
        return ctx.call({ cmd: "ui_render", spec: v.spec }, 15000);
      },
    ),
    def(
      "panel_ui_update",
      "Re-render a LIVE card previously created with panel_ui_render, in place (progress updates, revised options, reactive forms). Pass the card_id you received and a complete NEW spec (same shape/caps as panel_ui_render — this replaces the card's content, it does not merge). Fails once the user has already clicked/resolved or dismissed the card, or after the view was switched away — on 'no live card', just render a fresh card instead.",
      {
        card_id: z.string().describe("The card_id returned by panel_ui_render."),
        spec: z.record(z.string(), z.unknown()).describe("The complete replacement spec."),
      },
      async (args: A, ctx) => {
        const v = validateA2UISpecServer(args.spec);
        if (!v.ok) return fail(`invalid a2ui spec: ${v.errors.join("; ")}`);
        return ctx.call({ cmd: "ui_update", card_id: args.card_id, spec: v.spec }, 15000);
      },
    ),
  ];
  // #694: every MUTATING panel tool (RETRY_TOKEN_CMD_BY_TOOL) accepts the explicit
  // retry token in its schema and forwards it, untouched, on its command frames.
  return defs.map((d) => (d.name in RETRY_TOKEN_CMD_BY_TOOL ? withRetryToken(d) : d));
}

/**
 * Build the per-tab live-graph MCP server for the Claude (in-process Agent SDK)
 * backend. `tabId` binds every command to the panel tab this agent serves.
 *
 * Behaviorally identical to before the parity refactor — it now just wires the
 * SHARED tool defs (buildPanelToolDefs) onto the Anthropic SDK server instead of
 * inlining them, so the Codex HTTP path reuses the exact same surface.
 */
export function createPanelMcpServer(
  bridge: UiBridge,
  tabId: string,
  workflowTargets?: WorkflowTargetStore,
): McpSdkServerConfigWithInstance {
  const ctx = makePanelToolCtx(bridge, tabId, workflowTargets);
  // #873 — THE SECOND PANEL REGISTRATION PATH. This one serves the Anthropic Agent SDK
  // (Claude backend, in-process transport); registerPanelTools serves the MCP SDK. They
  // build from the SAME buildPanelToolDefs(), so filtering only the other one left
  // `panel_run` queueing renders under PRESET=readonly for every Claude-backend tab — the
  // exact hole the previous round closed on the sibling path and, by fixing only one of
  // two, left open. Filtering at the shared def list would be tidier and is deliberately
  // not done here: both call sites are then trivially greppable, and the wiring tests
  // assert on each by name.
  const policy = resolveToolSurfacePolicy();
  const withheldSdk: string[] = [];
  const defs = buildPanelToolDefs().filter((d) => {
    if (policy.active && !toolAllowed(d.name, policy)) {
      withheldSdk.push(d.name);
      return false;
    }
    return true;
  });
  if (withheldSdk.length || policy.actionAllow.length) {
    toolPolicyLogger.info(
      `[panel-tools] surface restricted by policy${policy.preset ? ` (preset "${policy.preset}")` : ""} — ` +
        `${withheldSdk.length} panel tool(s) withheld from the in-process server` +
        (policy.actionAllow.length
          ? `; ${policy.actionAllow.length} exact tool action(s) allowed`
          : ""),
    );
  }
  // The Anthropic SDK's tool() accepts (name, description, zodRawShape, cb). The
  // shared handler is transport-agnostic — bind it to this tab's ctx. Each def's
  // schema is a distinct zod shape, so the produced tool generics differ; widen
  // to the SDK's tool-list element type so the heterogeneous array type-checks.
  type SdkTool = ReturnType<typeof tool>;
  const tools = defs.map((d) =>
    tool(
      d.name,
      d.description,
      // #754 — strict() so an unrecognized arg key is a loud validation error,
      // not a silent drop. tool()'s TS signature requires a bare ZodRawShape
      // (`Schema extends AnyZodRawShape`), which a strict ZodObject instance does
      // NOT structurally satisfy (it has methods like `.parse`, not just field
      // schemas) — but at RUNTIME the SDK stores whatever is passed as
      // `inputSchema` verbatim (confirmed by constructing a tool this way and
      // calling `.safeParse` on the returned definition: unknown keys are
      // rejected). The cast documents that the type is being widened past what
      // TS can express here, not past what the SDK actually accepts.
      strictPanelSchema(d.schema) as unknown as typeof d.schema,
      async (args: Record<string, unknown>) =>
        toolActionPolicyError(d.name, args, policy) ?? (await d.handler(args, ctx)),
    ),
  ) as unknown as SdkTool[];
  const server = createSdkMcpServer({
    name: "comfyui-panel",
    version: "1.0.0",
    tools,
  }) as McpSdkServerConfigWithInstance & { rebindTab?: (newTabId: string) => void };
  // Re-point this server's bound tab after a panel tab-id migration (#568 Defect
  // 1). ctx.tabId is read LIVE by every handler (and by call/confirm), so updating
  // it in place moves ALL panel_* routing onto the migrated tab — no stale id that
  // makes the tools throw `no connected tab`. PanelAgent.rebindTabId() calls this.
  server.rebindTab = (newTabId: string) => {
    ctx.tabId = newTabId;
  };
  return server;
}

/**
 * Register the SHARED panel_* tools onto a `@modelcontextprotocol/sdk` McpServer
 * for the HTTP transport (Codex backend). `ctx` is tab-bound, so this server's
 * tools forward to the bridge for THAT tab — same surface as the Claude path.
 */
export function registerPanelTools(server: McpServer, ctx: PanelToolCtx): void {
  // #873 — the operator's policy applies HERE too. This path registers through
  // `registerTool` on a separate MCP server, so it bypassed the headless filter
  // entirely: with COMFYUI_MCP_TOOL_PRESET=readonly set, `panel_run` still queued
  // renders. A filter with a hole is worse than no filter, because the operator has been
  // told the surface is restricted.
  const policy = resolveToolSurfacePolicy();
  const withheld: string[] = [];
  for (const d of buildPanelToolDefs()) {
    if (policy.active && !toolAllowed(d.name, policy)) {
      withheld.push(d.name);
      continue;
    }
    server.registerTool(
      d.name,
      {
        description: d.description,
        // #754 — strict() so an unrecognized arg key is a loud validation error,
        // not silently stripped. The MCP SDK types `inputSchema` as a full zod
        // schema OR a raw shape (`AnySchema | ZodRawShapeCompat`), so passing the
        // already-built ZodObject needs no cast here — unlike the Anthropic SDK
        // call site, which types inputSchema as a bare raw shape only.
        inputSchema: strictPanelSchema(d.schema),
      },
      (async (args: Record<string, unknown>) => {
        const policyError = toolActionPolicyError(d.name, args, policy);
        if (policyError) return policyError as never;
        const res = await d.handler(args ?? {}, ctx);
        // ToolResult is already the MCP CallToolResult shape (content[] + isError).
        return res as never;
      }) as never,
    );
  }
  if (withheld.length || policy.actionAllow.length) {
    // Logged for the OPERATOR, never surfaced to the model — the point is that it does
    // not learn these exist. Silence here is how a policy that withholds the whole panel
    // becomes an afternoon of "why can't it see my canvas".
    toolPolicyLogger.info(
      `[panel-tools] surface restricted by policy${policy.preset ? ` (preset "${policy.preset}")` : ""} — ` +
        `${withheld.length} panel tool(s) withheld` +
        (policy.actionAllow.length
          ? `; ${policy.actionAllow.length} exact tool action(s) allowed`
          : ""),
    );
  }
}
