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
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { parse as parseYaml } from "yaml";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UiBridge } from "../services/ui-bridge.js";
import {
  dispatchOutcomeOf,
  isPanelCmdUnsupportedError,
  isReplyTimeoutTagged,
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
import { setComfyuiSecret, setAgentSecret, isAllowedAgentSecretKey } from "../services/panel-secrets.js";
import { flattenUiWorkflow } from "../services/flatten-workflow.js";
import { getNsfwConsent, setNsfwConsent } from "../services/panel-settings.js";
import { QueueMonitor } from "../services/queue-monitor.js";
import {
  getClient,
  getObjectInfo,
  backfillObjectInfo,
  resetClient,
  resetObjectInfoCache,
} from "../comfyui/client.js";
import { convertUiToApi, collectNodeTypes } from "../services/workflow-converter.js";
import { restartComfyUI } from "../services/process-control.js";
import {
  isRemoteMode,
  isCloudMode,
  getBootLocalComfyUIBaseUrl,
  getComfyUIBaseUrl,
} from "../config.js";
import { sliceWorkflow } from "../services/workflow-slicer.js";
import { validateA2UISpecServer } from "../services/a2ui-spec.js";
import type { UiWorkflow } from "../comfyui/types.js";

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
  /** Zero out the post-drop retry settle so retry-once tests don't sleep. */
  setRetrySettleMs(ms: number | null): void {
    retrySettleMsOverride = ms;
  },
  /** Inject fast reconnect-wait timing so #400/#402 tests don't wait the real ~20s. */
  setReconnectWaitTiming(timing: { budgetMs: number; intervalMs: number } | null): void {
    reconnectWaitTimingOverride = timing;
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
  "graph_move_node",
  "graph_resize_node",
  "graph_set_title",
  "graph_set_node_mode",
  "graph_set_node_color",
  "graph_set_node_collapsed",
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

/** True when an error is a TRANSIENT transport/reconnect drop (the tab went away
 *  or was replaced), NOT a genuine command error or a live-but-frozen reply
 *  timeout. Deliberately EXCLUDES "did not reply within N ms" (a backgrounded/
 *  frozen tab — retrying just double-waits, #334) and "OUTCOME UNKNOWN" (a
 *  mutating command that may already have applied). */
function isTransientReconnectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /no connected tab|genuinely gone|is not open|Failed to fetch|Panel not reachable|ECONNRESET|socket hang up|premature close|other side closed|ECONNABORTED|EPIPE/i.test(
    msg,
  );
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
}

/** True when a decoded /system_stats body has the recognizable ComfyUI shape (a
 *  `system` object and/or a `devices` array) — the same fields health_check /
 *  get_environment read. A bare 2xx from a reverse-proxy login page, an SPA
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
 *  v6 → ::1) — so localhost/127.0.0.1/0.0.0.0 compare equal, and ::1/:: compare equal,
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

let healthProbeOverride:
  | ((base: string | null, timeoutMs: number) => Promise<boolean | ProbeStatus>)
  | null = null;

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
      if (status === "down") {
        sawDown = true;
      } else if (status === "healthy" && sawDown) {
        return { ready: true, waited_ms: Date.now() - start, attempts, via: "observed-cycle", sawDown };
      }
      // "healthy" without a prior down, and "unknown", are ignored — keep looking.
    }
    // Sleep BETWEEN probes (both modes).
    const left = currentDeadline() - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }
  return { ready: false, waited_ms: Date.now() - start, attempts, sawDown };
}

// ---- workflow_open verify-after-timeout (#215/#319/#496) --------------------
// `panel_open_workflow` forwards `workflow_open` over the UI bridge and waits for
// the tab to ACK. When the target tab is BACKGROUNDED/FROZEN, or the workflow is
// already the active one, the tab can be slow to ack and the bridge surfaces a
// `did not reply to "workflow_open" within N ms` TIMEOUT — yet the switch itself
// genuinely happened (the executor ran; the ack just didn't make it back in the
// window). Reporting that as a failure is a FALSE FAILURE: a follow-up
// `workflow_list` shows the target IS the active tab, and it invites unsafe
// retries. Mirroring the reboot-readiness pattern (observeRecovery / #497), on
// an ack-timeout we do NOT immediately fail — we VERIFY the AUTHORITATIVE active
// workflow by polling `workflow_list` (a fresh bridge round-trip, never a stale
// cache) and return SUCCESS with a `recovered` note if the target became active,
// only failing when it genuinely never did.

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
  return /Panel tab \S+ did not reply to "workflow_open" within \d+\s*ms/i.test(text);
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

// ---- panel_civitai_results inline sample thumbnails (#623) -------------------
// The agent recommends CivitAI models/LoRAs for a VISUAL medium, so it must be
// able to SEE the sample images — not just read titles + download counts. The
// civitai_results reply already carries the panel's same-origin proxy media URLs
// (/comfyui_mcp_panel/civitai/media?… served by the ComfyUI server the
// orchestrator is connected to), so we fetch the top-N NON-GATED thumbnails here
// and hand them back as MCP image content blocks — the same {type:"image"} bytes
// mechanism panel_show_media / view_image use.
//
// NSFW/consent gate preservation is the load-bearing invariant: a result the
// panel would render as a BLURRED/gated placeholder (rating outside the user's
// enabled browsing levels) is NEVER fetched, so this vision path can never leak a
// sample the human-facing UI withholds. See civitaiSampleEligible for the
// fail-CLOSED gating rule and fetchCivitaiSampleImages for the same-origin lock.
const CIVITAI_SAMPLE_MAX_BYTES = 4 * 1024 * 1024; // per-thumbnail cap (450px jpeg ≈ tens of KB)
const CIVITAI_SAMPLE_DEFAULT = 4; // thumbnails delivered by default — bounds context
const CIVITAI_SAMPLE_MAX = 8; // hard ceiling even if the agent asks for more
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

  return fail(formatRunRejection({ error: topError, node_errors: nodeErrors }));
}

export const __panelRunTestHooks = {
  detectRunRejection,
  formatRunRejection,
};

/** Drop a trailing .json (case-insensitive) so filename/path forms compare equal. */
function stripJsonExt(s: unknown): string | null {
  return typeof s === "string" ? s.replace(/\.json$/i, "") : null;
}

/**
 * Does the AUTHORITATIVE active workflow (the `active` object from a fresh
 * `workflow_list`) correspond to the `path` the caller asked to open? Mirrors the
 * panel executor's own matcher: exact path/filename/key, or filename/path with a
 * trailing `.json` stripped (callers pass any of those forms). Null-active (no
 * open workflow) never matches.
 */
function activeMatchesTarget(active: unknown, path: string): boolean {
  if (!active || typeof active !== "object") return false;
  const a = active as { path?: unknown; filename?: unknown; key?: unknown };
  if (a.path === path || a.filename === path || a.key === path) return true;
  const want = stripJsonExt(path);
  if (want == null) return false;
  return stripJsonExt(a.filename) === want || stripJsonExt(a.path) === want;
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
  active: boolean;
  waited_ms: number;
  attempts: number;
}

/**
 * Poll `workflow_list` until the target `path` is the active workflow, or the
 * bounded budget elapses. Each probe is a fresh bridge round-trip via ctx.call
 * (never throws; returns the AUTHORITATIVE live active identity, not a cache).
 */
async function waitForWorkflowActive(
  ctx: PanelToolCtx,
  path: string,
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
    if (parsed && activeMatchesTarget(parsed.active, path)) {
      return { active: true, waited_ms: Date.now() - start, attempts };
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }
  return { active: false, waited_ms: Date.now() - start, attempts };
}

/**
 * `panel_open_workflow` body, shared across transports. Forwards `workflow_open`
 * and returns its reply verbatim on success or on a GENUINE failure (a normal
 * error reply, e.g. "no workflow matching"). Only on an ACK-TIMEOUT does it
 * verify the authoritative active workflow: SUCCESS (with a `recovered` note) if
 * the target became active despite the slow ack, otherwise the original timeout
 * failure. Never masks a genuine open-failure as success.
 */
/** Terminal error for a MUTATING panel command when the pre-send reachability wait
 *  gave up (no tab reconnected within budget / an ambiguous multi-tab session). We
 *  must NOT dispatch — firing into a dead binding is exactly the OUTCOME-UNKNOWN /
 *  double-apply risk the pre-send wait exists to prevent (codex). */
function noReachableTabFail(cmd: string): ToolResult {
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
    return noReachableTabFail("workflow_open");
  }
  const res = await ctx.call({ cmd: "workflow_open", path }, 15000);
  // Success, or a genuine acked error (missing file / real executor error) — the
  // caller must see it as-is. A slow-ack TIMEOUT or a mid-command reconnect DROP
  // ("OUTCOME UNKNOWN", #402) both warrant verification: re-reading the active
  // workflow is idempotent, so we can turn an UNKNOWN into a definite outcome.
  if (!isAckTimeout(res) && !isReconnectDrop(res)) return res;

  const timing = getOpenVerifyTiming();
  const verify = await waitForWorkflowActive(ctx, path, timing);
  if (verify.active) {
    return ok({
      opened: { path },
      recovered: true,
      note:
        `"${path}" is now the active workflow — the switch succeeded, but the tab was slow ` +
        `to acknowledge (backgrounded/frozen or already open) or briefly disconnected while ` +
        `reconnecting after a restart, so the initial ack was inconclusive. ` +
        `Confirmed active via workflow_list after ${(verify.waited_ms / 1000).toFixed(1)}s ` +
        `(${verify.attempts} probe${verify.attempts === 1 ? "" : "s"}). Do NOT retry.`,
    });
  }
  // The ack was inconclusive AND the target never became active within the budget —
  // this is a REAL failure. Return the original bridge error unchanged.
  return res;
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
    return { record: rec, isActive: computeIsActive(rec, activeObj), activeLabel };
  }
  // The active object is authoritative too, in case it isn't mirrored in the array.
  if (activeMatchesTarget(activeObj, path)) {
    return { record: activeObj as OpenWorkflowRecord, isActive: true, activeLabel };
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
 * Stable-identity (key/path/routing_key) verdict between a record and the active object.
 * Returns `true` on a positive match, `false` only when the two expose a COMPARABLE field
 * (both non-empty) that DISAGREES, and `undefined` when they share no comparable field at
 * all (so the caller cannot conclude "background" — stay lenient). Filename is never used
 * (it collides across tabs).
 */
function identityVerdict(rec: OpenWorkflowRecord, activeObj: unknown): boolean | undefined {
  if (!activeObj || typeof activeObj !== "object") return undefined;
  const a = activeObj as { path?: unknown; key?: unknown; routing_key?: unknown };
  const r = rec as { path?: unknown; key?: unknown; routing_key?: unknown };
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const pairs: Array<[unknown, unknown]> = [
    [r.key, a.key],
    [r.path, a.path],
    [r.routing_key, a.routing_key],
    [r.key, a.routing_key],
    [r.routing_key, a.key],
  ];
  let comparable = false;
  for (const [x, y] of pairs) {
    if (nonEmpty(x) && nonEmpty(y)) {
      comparable = true;
      if (x === y) return true;
    }
  }
  return comparable ? false : undefined;
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
  | { ok: true; pinPath: string; pinFilename?: string }
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
    return {
      ok: true,
      pinPath: rec.key ?? rec.path ?? path,
      pinFilename: filename ?? rec.filename ?? rec.path,
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

/** Candidate ComfyUI workflows directories (where the frontend saves/stages files). */
function comfyWorkflowsDirs(): string[] {
  const base = process.env.COMFYUI_PATH;
  if (!base) return [];
  return [
    join(base, "user", "default", "workflows"),
    join(base, "user", "workflows"),
  ];
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

/** Read + parse a UI workflow JSON by path. Resolves an ABSOLUTE path off the
 *  orchestrator's disk, or a RELATIVE name authoritatively through the CONNECTED
 *  ComfyUI's userdata API — which resolves under the server's RUNTIME
 *  `--user-directory` (custom or default), so the RIGHT file always wins and a
 *  stale same-named file under the guessed default dir can never shadow it
 *  (#202). Only when the server can't serve the name (404 / unreachable) does it
 *  fall back to the orchestrator's guessed local workflows dirs, so a
 *  disk-staged file still opens. Guards: must be .json and must parse to a UI
 *  workflow (a top-level `nodes` array). Fails loudly (never loads the wrong
 *  file) when the name resolves nowhere. */
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
  // API (the SAME source list_workflows / panel_open_workflow read): it resolves
  // under the runtime `--user-directory`, so a CUSTOM user-dir loads the correct
  // file and a stale same-named file under the orchestrator's guessed default
  // dir can't shadow it (#202). Try it FIRST; fall back to local disk ONLY when
  // the server genuinely lacks the name (404) or can't be reached — NOT when it
  // refuses (401/403/5xx) or returns a malformed file, which must surface their
  // own honest error rather than silently loading a possibly-stale local file.
  type Outcome =
    | { kind: "found"; parsed: unknown }
    | { kind: "malformed"; detail: string } // 2xx but bad JSON → error, no fallback
    | { kind: "refused"; detail: string } // non-404 HTTP error → error, no fallback
    | { kind: "absent"; detail: string } // 404 → local fallback allowed
    | { kind: "unreachable"; detail: string }; // transport failure → local fallback allowed
  // #414: panel_list_workflows reports each workflow's userdata STORE KEY, which
  // already carries the "workflows/" prefix (e.g. "workflows/Daily Anime.json").
  // Feeding that exact value back here double-prefixed it to
  // "workflows/workflows/Daily Anime.json" → a 404 → the local fallback missed too
  // → "No workflow file at …", even though it is the documented list output. Strip
  // one leading "workflows/" segment so the list key, a bare name, and a subfolder
  // path all normalize to the same store-relative name. (A genuinely absolute path
  // — including a Windows leading-slash path — was already handled and returned
  // above, so it never reaches this relative-name normalization.)
  const rel = p.replace(/^[\\/]+/, "").replace(/^workflows[\\/]+/i, "");
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
  let outcome: Outcome;
  try {
    const client = getClient();
    const encoded = encodeURIComponent(`workflows/${rel}`);
    const res = await client.fetchApi(`/api/userdata/${encoded}`);
    if (res.ok) {
      // Read the body as TEXT and classify HERE so a malformed 2xx surfaces its
      // OWN error (no fallback), while ComfyUI's "200 + EMPTY body = file does
      // not exist" convention (some builds; see parseWorkflowLock) is treated as
      // an ABSENCE that DOES allow the local fallback — not a malformed error.
      const body = (await res.text()).trim();
      if (body === "") {
        outcome = { kind: "absent", detail: "was not in the ComfyUI userdata library (empty 200 response)" };
      } else {
        try {
          outcome = { kind: "found", parsed: JSON.parse(body) };
        } catch (err) {
          outcome = { kind: "malformed", detail: err instanceof Error ? err.message : String(err) };
        }
      }
    } else if (res.status === 404) {
      outcome = { kind: "absent", detail: "was not in the ComfyUI userdata library (HTTP 404)" };
    } else {
      outcome = { kind: "refused", detail: `ComfyUI userdata library returned HTTP ${res.status}` };
    }
  } catch (err) {
    outcome = {
      kind: "unreachable",
      detail: `ComfyUI userdata library was unreachable (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  if (outcome.kind === "found") {
    // A found-but-non-UI file must surface its own honest error, not silence.
    return assertUiWorkflow(outcome.parsed, `The workflow "${p}" from the ComfyUI userdata library`);
  }
  if (outcome.kind === "malformed") {
    throw new Error(`The workflow "${p}" in the ComfyUI userdata library is not valid JSON: ${outcome.detail}`);
  }
  if (outcome.kind === "refused") {
    // Server is reachable but did not serve the file — do NOT fall back to a
    // possibly-stale local file; report the status honestly.
    throw new Error(
      `Could not read "${p}" from the connected ComfyUI: ${outcome.detail}. ` +
        `Pass an absolute path, or a name shown by panel_list_workflows.`,
    );
  }

  // outcome.kind is "absent" (404) or "unreachable" — fall back to the
  // orchestrator's guessed local workflows dirs (best-effort; only meaningful on
  // a same-machine ComfyUI whose user-dir matches the default layout, or a file
  // staged straight to disk).
  // Each candidate is the store-relative name resolved UNDER a base dir. Only the
  // NORMALIZED `rel` is used (never the raw `workflows/…` key), so nothing nests a
  // second workflows/ (codex P1/P2). Belt-and-suspenders containment: an existing
  // candidate is only accepted if its REAL path (symlinks/junctions resolved)
  // stays beneath the base's REAL path — so a link under the workflows dir that
  // targets an external directory can't be read on the 404/unreachable fallback
  // (codex). Canonicalizing BOTH sides keeps a legitimately-symlinked workflows
  // dir working (its base resolves too), while blocking a per-file escape.
  const realBaseUnder = (base: string, candidate: string): boolean => {
    try {
      const rb = realpathSync(base);
      const rc = realpathSync(candidate);
      return rc === rb || rc.startsWith(rb + sep);
    } catch {
      return false;
    }
  };
  const localBases = [...comfyWorkflowsDirs(), process.cwd()];
  const local = localBases
    .map((dir) => ({ dir, path: resolve(dir, rel) }))
    .filter(({ path }) => existsSync(path) && statSync(path).isFile())
    .filter(({ dir, path }) => realBaseUnder(dir, path))
    .map(({ path }) => path)[0];
  if (local) return readLocal(local);

  throw new Error(
    `No workflow file at "${p}". It ${outcome.detail}, and it is not under the orchestrator's workflows ` +
      `dir (${comfyWorkflowsDirs().join(" or ") || "COMFYUI_PATH not set"}). ` +
      `Pass an absolute path, or a name shown by panel_list_workflows.`,
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

/**
 * Outcome of a human-in-the-loop confirm card (#360). A tri-state so callers can
 * tell a deliberate DECLINE ("no") apart from the user simply not answering in
 * time ("timeout") — the latter must be reported honestly ("timed out waiting for
 * confirmation"), never silently treated as a decline. Any non-timeout failure
 * (no panel, transport error) maps to "no" so the destructive op is SKIPPED.
 */
export type ConfirmOutcome = "yes" | "no" | "timeout";

/**
 * The execution context every tool handler receives. Both transports (Anthropic
 * SDK in-process, MCP-SDK over HTTP) build the SAME context bound to a tab, so a
 * handler is transport-agnostic — it only ever talks to the bridge via `call` /
 * `confirm` / `bridge` and never knows which server invoked it.
 */
export interface PanelToolCtx {
  /** Forward a command to the panel and wrap the reply as a tool result. */
  call: (cmd: Record<string, unknown>, timeoutMs?: number) => Promise<ToolResult>;
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
  rebindToActiveTab?: () => { previous: string; current: string; rebound: boolean };
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

  const sendRouted = async (
    cmd: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> => {
    const target = workflowTargets?.get(ctx.tabId);
    const routed = target ? withWorkflowTarget(cmd, target) : cmd;
    return bridge.send(routed as { cmd: string }, { tabId: ctx.tabId, timeoutMs });
  };

  const call = async (cmd: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult> => {
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
      return ok(await sendRouted(cmd, timeoutMs));
    } catch (err) {
      // Post-reconnect retry-once: a reboot/free_vram/reconnect can drop the tab's
      // transport (or replace it under a new tab id) the instant after we dispatch.
      // For idempotent commands, settle briefly, rebind onto the now-live tab, and
      // retry ONE time before surfacing an error (#278/#310/#332/#481). Mutating
      // edits are excluded from RETRY_SAFE_CMDS, so they never double-apply.
      if (isRetrySafeCmd(cmd) && isTransientReconnectError(err)) {
        try {
          await sleep(retrySettleMs());
          ensureReachable(); // rebinds a current-mode session onto the reconnected tab
          return ok(await sendRouted(cmd, timeoutMs));
        } catch (err2) {
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
          return fail(err2);
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
      return fail(err);
    }
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
      // panel, transport failure) → "no" so the destructive op is SKIPPED, exactly
      // as the previous catch-all did.
      if (isReplyTimeoutError(err)) {
        const late = await pollLateAskReply(bridge, askId, timing);
        if (late !== undefined) return isAffirmative(late) ? "yes" : "no";
        return "timeout";
      }
      return "no";
    }
  };

  // EXPLICIT self-heal — see PanelToolCtx.rebindToActiveTab. Only rebinds when
  // the current tabId is genuinely orphaned (no live tab reachable); a healthy
  // session is left untouched so this never hijacks routing on a multi-tab
  // deployment. Throws (clear message, via resolveActiveTabId) when a single
  // active tab can't be picked.
  const rebindToActiveTab = (): { previous: string; current: string; rebound: boolean } => {
    const previous = ctx.tabId;
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
): Promise<Record<string, unknown>> {
  if (args.pack) return readPackWorkflow(args.pack as string);
  if (args.path) return await readWorkflowFromPath(args.path as string);
  if (args.graph != null) {
    return (typeof args.graph === "string"
      ? JSON.parse(args.graph as string)
      : args.graph) as Record<string, unknown>;
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
    throw new Error(
      `Couldn't capture the live canvas (${msg}). ` +
        `An older panel version may not support graph_serialize — pass pack, path, or graph instead.`,
    );
  }
  const wf = (reply as { workflow?: unknown } | null)?.workflow;
  if (!wf || typeof wf !== "object") {
    throw new Error("The live canvas returned no graph — pass pack, path, or graph explicitly.");
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

/** Poll the bridge's late-reply buffer for a validated ask answer that arrived
 *  after the card-reply timeout, up to the grace budget. undefined if none. */
async function pollLateAskReply(
  bridge: PanelToolCtx["bridge"],
  askId: string,
  timing: AskTiming,
): Promise<unknown | undefined> {
  const take = (bridge as unknown as { takeLateAskReply?: (id: string) => unknown })
    .takeLateAskReply;
  if (typeof take !== "function") return undefined;
  const deadline = Date.now() + timing.graceMs;
  for (;;) {
    const late = take.call(bridge, askId);
    if (late !== undefined) return late;
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    await sleep(Math.max(1, Math.min(timing.pollMs, left)));
  }
}

/**
 * Run a panel_ask: render the choice card and return the user's pick. Clamps the
 * card deadline under the MCP tools/call budget and, on a reply-timeout, honors a
 * late-but-valid answer from the bridge's late-reply buffer before failing (#486).
 * Sent DIRECTLY over the bridge (like the confirm/consent cards) so a stable
 * `ask_id` can key the late-reply buffer.
 */
async function askUserWithGrace(
  ctx: PanelToolCtx,
  ask: { question: string; options: unknown; header?: unknown; multi_select?: unknown },
): Promise<ToolResult> {
  const timing = getAskTiming();
  const askId = randomUUID();
  const cmd = {
    cmd: "ask_user",
    ask_id: askId,
    question: ask.question,
    options: ask.options,
    header: ask.header,
    multi_select: ask.multi_select,
  };
  try {
    ctx.ensureReachable?.();
    const reply = await ctx.bridge.send(cmd as unknown as { cmd: string }, {
      tabId: ctx.tabId,
      timeoutMs: timing.deadlineMs,
    });
    return ok(reply);
  } catch (err) {
    if (isReplyTimeoutError(err)) {
      const late = await pollLateAskReply(ctx.bridge, askId, timing);
      if (late !== undefined) return ok(late);
      return fail(
        "The question card was not answered in time (or no interactive panel surface " +
          "rendered it — e.g. an exec/headless run), so nothing was selected. If you " +
          "still need the decision, ask the user directly in plain chat text, or " +
          "re-invoke panel_ask from an interactive ComfyUI tab.",
      );
    }
    return fail(err);
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

  return [
    def(
      "panel_query_graph",
      "FILTER/traverse a SUBSET of the live graph once you already know what you're looking for — NOT the tool for 'show me the canvas' / a full overview (use panel_graph_outline FIRST for that). QUERY the workflow the user is CURRENTLY VIEWING — filter, traverse, project, and aggregate over the live canvas WITHOUT dumping the whole graph (replaces the old panel_get_graph full-JSON dump; output is TOKEN-BOUNDED with an explicit truncation marker, so a big graph can never flood your context). Combine: `types` (node type contains any), `title` (contains), `where` widget predicates ANDed ('cfg>7', 'steps<=20', 'sampler_name=euler', 'text~sunset' — ops = != >= <= > < ~contains), `ids` (exact nodes — THE way to read ONE node's exact slot/widget detail: {ids:[42], fields:'detail'}), `upstream_of`/`downstream_of` + `depth` (dependency traversal: upstream = what FEEDS that node, downstream = what CONSUMES it; seed at depth 0), `fields` ('compact' one line per node [default], 'ids', 'detail' = the full node summary with slots + connections + mode), `group_by:'type'` (counts only), `limit` (default 40). detail rows include each node's MODE — a 'bypass' node is skipped and a 'mute' node kills everything downstream, so check modes on the path you care about before running (fix with panel_set_node_mode). Every result also carries `groups` (id, title, member node_ids — groups are geometric, trust this list) and, when viewing a SUBGRAPH (after panel_enter_subgraph), `rails` (boundary rail ids/slots). Typical flow: panel_graph_outline to orient → panel_query_graph to pinpoint/inspect → edit. Read-only.",
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
          .min(500)
          .max(60000)
          .optional()
          .describe("Output character bound (default 12000). Raise only for deliberate full reads, e.g. layout passes needing every node's geometry."),
      },
      async (args: A, ctx) =>
        ctx.call({
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
    ),
    def(
      "panel_graph_outline",
      "'Show me what's on the canvas' / 'what's on the graph right now' / 'read the current workflow' / 'describe the open graph' -> THIS TOOL. It reads the LIVE canvas the user is looking at. NOT visualize_workflow (that renders a workflow you PASS IN — a saved file/JSON — into a Mermaid diagram, and does NOT read the live canvas) and NOT panel_query_graph (use that only to FILTER/traverse a SUBSET once you already know what you're looking for). Returns a COMPACT, dependency-ordered TEXT MAP of the whole open graph — the FASTEST way to UNDERSTAND it (especially a big loaded pack/template) before you touch it. One `outline` string, read top→down: nodes topologically sorted (sources first, sinks last), each on its own block as `id Type \"title\" [bypass/mute] [OUTPUT] · group:X  widget=value …` with `← inputs` (as source_node.output_name) and `→ outputs` (as target_node.input_name), preceded by a GROUPS index (title → member node ids). It shows the WIRING you'd otherwise have to reconstruct. Use this FIRST to get oriented; then panel_query_graph to filter/traverse/inspect (e.g. {ids:[42], fields:'detail'} for one node's exact slot/widget detail), or panel_find_nodes for free-text search. Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_outline" }),
    ),
    def(
      "panel_view_selected",
      "What the user has SELECTED on the canvas right now. Call this FIRST whenever they say \"this node\", \"the selected one\", \"the highlighted node\", \"where did I get this from\", or otherwise point at something without giving an id — the selection IS the answer, and reading it costs one call instead of scanning the graph. Returns the full detail summary (id, type, title, widgets, inputs with sources, outputs, mode) for each selected node, plus `selected_count` and any selected groups/reroutes. If `selected_count` is 0, nothing is selected — ask the user to click the node rather than guessing. NEVER dump the whole graph to work out which node they mean. Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_view_selected" }),
    ),
    def(
      "panel_view_nodes_in_viewport",
      "The nodes the user can actually SEE — everything intersecting the current viewport (pan+zoom) of the canvas they're looking at. Use this to SCOPE your work to what's on their screen instead of reading a whole graph: when they say \"these nodes\", \"the ones here\", \"what am I looking at\", or when a graph is large and you only need the region in front of them. Returns the viewport rect in graph coordinates (x, y, width, height, zoom), `node_count` (whole graph) vs `in_view_count`, and the detail summary of each visible node. A node counts as visible if any part of it overlaps the viewport. On a big canvas this is dramatically cheaper than panel_graph_outline / panel_query_graph — prefer it when the user's framing is visual. Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_view_nodes_in_viewport" }),
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
      { node_id: z.number().int().describe("Subgraph node id (is_subgraph=true).") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_get_subgraph", node_id: args.node_id }),
    ),
    def(
      "panel_find_nodes",
      "SEARCH the workflow the user is CURRENTLY VIEWING for nodes matching filters — the right way to PINPOINT a node (a specific loader, sampler, save, switch) in a LARGE graph instead of dumping the whole graph and scanning it. This searches the LIVE graph ON THE CANVAS — NOT the installable node registry (that's panel_search_nodes). It scans EVERY node (no truncation). Give a free-text `query` (matched case-insensitively across node type, title, description, widget NAMES, widget VALUES, and input/output port names+types — a node hits if ANY of those contain it) and/or targeted filters: type, title, input, output, widget (name), widget_value (contents), is_output, is_subgraph, mode. Targeted filters are ANDed together; the free `query` ORs across fields. Each match is the SAME rich summary as panel_query_graph's detail rows (id, type, title, widgets, inputs WITH their connected_from sources, outputs, mode, is_output, …) PLUS the node's description and a `matched_on` list saying WHY it matched. Read-only. Examples — the video loader: {query:'tiktok'} or {type:'LoadVideo'} or {input:'video'}; every output node: {is_output:true}; the node whose widget holds a file: {widget_value:'.png'}; a bypassed switch: {type:'Switch', mode:'bypass'}.",
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
          .max(200)
          .optional()
          .describe("Max matches to return (default 40)."),
      },
      async (args: A, ctx) =>
        ctx.call({
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
    ),
    def(
      "panel_add_node",
      "Add a node to the user's OPEN ComfyUI graph by class_type (e.g. 'KSampler', 'CheckpointLoaderSimple'). The user sees it appear live; Ctrl+Z undoes it. Returns the created node's id, slots, and default widget values.",
      {
        class_type: z.string().describe("Exact ComfyUI node class_type to create."),
        pos: xy()
          .optional()
          .describe("Canvas [x, y] (two numbers). Auto-placed beside existing nodes when omitted."),
        title: z.string().optional().describe("Optional custom node title."),
      },
      async (args: A, ctx) =>
        // #599: the frontend gates the add on a FRESH /object_info (assertAddNode-
        // ResolvableRefreshing) so an uninstalled class can't be added as a
        // placeholder — that fetch can outlast the 6000 ms default on a large
        // install. Give it the bounded refresh ack budget.
        ctx.call(
          { cmd: "graph_add_node", class_type: args.class_type, pos: args.pos, title: args.title },
          OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS,
        ),
    ),
    def(
      "panel_remove_node",
      "Remove a node (and its connections) from the user's open graph by id. Undoable with Ctrl+Z.",
      { node_id: z.number().int().describe("Node id from panel_graph_outline / panel_query_graph.") },
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
        "graph edit tools. The resolved graph is much smaller than the raw UI JSON.",
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
        const raw = await resolveWorkflowInput(args, ctx, true);
        const ui = raw as unknown as UiWorkflow;
        const bulk = await getObjectInfo();
        const objectInfo = await backfillObjectInfo(bulk, collectNodeTypes(ui));
        const { workflow, warnings } = convertUiToApi(ui, objectInfo);

        const hist: Record<string, number> = {};
        for (const node of Object.values(workflow)) {
          const t = (node as { class_type?: string }).class_type ?? "?";
          hist[t] = (hist[t] ?? 0) + 1;
        }
        const summary = Object.entries(hist)
          .sort((a, b) => b[1] - a[1])
          .map(([t, c]) => `${c}× ${t}`)
          .join(", ");

        return ok(
          `Stripped to ${Object.keys(workflow).length} nodes` +
            (warnings.length ? ` · ${warnings.length} warning(s)` : "") +
            `\nNode types: ${summary}` +
            (warnings.length
              ? `\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`
              : "") +
            `\n\n${JSON.stringify(workflow, null, 2)}`,
        );
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
          return ok(`${summary}\n\n${JSON.stringify(graph)}`);
        }
        const loaded = await ctx.call({ cmd: "graph_load", graph: graph as never }, 30000);
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
      "Load a full ComfyUI workflow onto the live canvas in one shot (replaces the current graph). Three ways to specify it: `pack:<name>` for a bundled installer pack's local-GPU workflow; `path:<file>` to read an arbitrary workflow .json off DISK server-side (absolute, or relative to the ComfyUI workflows folder) — use this to open a staged/downloaded example without shuttling its JSON through chat; or an inline `graph` object/JSON string. `pack` and `path` are read SERVER-SIDE so a large graph never enters your context. The replaced graph is captured as an undo point (double-Esc / revert). Pack workflows are LOCAL/free; for a `path`/`graph` that may use API nodes, check the runtime first (check_workflow_runtime) and ASK the user before spending paid api credits.",
      {
        pack: z
          .string()
          .optional()
          .describe("Bundled pack name (from list_packs, e.g. 'krea2-txt2img-manual'). Its UI workflow.json is read server-side and loaded onto the canvas. These are local-GPU/free."),
        path: z
          .string()
          .optional()
          .describe("Path to a workflow .json on the ComfyUI machine's disk — absolute, or relative to the ComfyUI workflows folder (user/default/workflows). Read + parsed server-side and loaded onto the canvas (keeps a large JSON out of chat). Local ComfyUI only."),
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
          return await ctx.call({ cmd: "graph_load", graph: data }, 30000);
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_connect",
      "Connect an output slot of one node to an input slot of another in the user's open graph. Slots accept a name ('MODEL', 'samples') or numeric index. If both slot args are omitted the panel picks the first type-compatible pairing. On failure the error lists every slot with its type and [connected] flag — re-check with panel_query_graph ({ids:[node_id], fields:'detail'}). Undoable.",
      {
        from_node_id: z.number().int().describe("Source node id."),
        from_output: slotRef
          .optional()
          .describe("Source output slot name or index; omit to auto-match by type (prefers an unconnected, exact-type input; `*` wildcards match last)."),
        to_node_id: z.number().int().describe("Target node id."),
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
        node_id: z.number().int().describe("Node id whose input to disconnect."),
        input: slotRef.optional().describe("Input slot name or index (default 0)."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_disconnect", node_id: args.node_id, input: args.input }),
    ),
    def(
      "panel_set_widget",
      "Set a widget value on a node in the user's open graph (steps, cfg, seed, ckpt_name, text prompts, …). Returns the previous and new value. Undoable with Ctrl+Z. To CLEAR a text widget to an empty string, pass `clear: true` (some MCP clients drop an empty-string `value` from the serialized payload, so `value: \"\"` may not arrive — `clear: true` always works). For the LTXDirector timeline node (WhatDreamsCost CSGlide), set `timeline_data` with the FULL timeline JSON (segments + global_prompt) to drive its custom timeline UI — this re-syncs the editor and regenerates its derived `local_prompts`/`segment_lengths`/`guide_strength` widgets; setting those derived widgets directly is refused (they are silently reverted).",
      {
        node_id: z.number().int().describe("Node id from panel_graph_outline / panel_query_graph."),
        widget: z.string().describe("Widget name (e.g. 'steps', 'cfg', 'text')."),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe("New value. Must match the widget's expected type. Optional only when `clear: true` is set (which forces an empty string)."),
        clear: z
          .boolean()
          .optional()
          .describe("Set true to clear the widget to an empty string (\"\"). Escape hatch for when a client cannot carry an empty-string `value` through tool-arg JSON. Overrides `value`."),
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
        return ctx.call(
          { cmd: "graph_set_widget", node_id: args.node_id, widget: args.widget, value },
          OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS,
        );
      },
    ),
    def(
      "panel_move_node",
      "Move a node to a new canvas position [x, y] in the user's open graph. Undoable.",
      {
        node_id: z.number().int().describe("Node id from panel_graph_outline / panel_query_graph."),
        pos: xy().describe("New canvas [x, y] (two numbers)."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_move_node", node_id: args.node_id, pos: args.pos }),
    ),
    def(
      "panel_resize_node",
      "Resize a node to [width, height] (canvas px) on the user's open graph. Essential for Note / MarkdownNote nodes, which are created tiny (140×60) and are unreadable until enlarged — panel_move_node only repositions, it cannot resize. Uses the node's own setSize so DOM-widget nodes (MarkdownNote) and nodes that clamp to a computed minimum reflow correctly. Undoable with Ctrl+Z.",
      {
        node_id: z.number().int().describe("Node id from panel_graph_outline / panel_query_graph."),
        size: z
          .array(z.number())
          .min(2)
          .max(2)
          .describe("New [width, height] in canvas px (both > 0)."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_resize_node", node_id: args.node_id, size: args.size }),
    ),
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
      "Control the user's canvas view: 'fit' frames the whole graph, 'center_on_node' jumps to a node (give node_id), 'pan' shifts by dx/dy, 'zoom' sets an absolute scale. View-only.",
      {
        action: z.enum(["fit", "center_on_node", "pan", "zoom"]),
        node_id: z.number().int().optional().describe("Required for center_on_node."),
        dx: z.number().optional().describe("Pan delta x."),
        dy: z.number().optional().describe("Pan delta y."),
        scale: z.number().optional().describe("Absolute zoom for 'zoom' (0.05–4, 1 = 100%)."),
      },
      async (args: A, ctx) =>
        ctx.call({
          cmd: "graph_canvas",
          action: args.action,
          node_id: args.node_id,
          dx: args.dx,
          dy: args.dy,
          scale: args.scale,
        }),
    ),
    def(
      "panel_run",
      "Queue the workflow the user has OPEN — exactly like them pressing Queue Prompt (current widget values, the live graph they can see). On success it confirms the run was queued; if ComfyUI REFUSES the prompt (validation failure on either channel — per-node node_errors OR a top-level error like a missing node type) it returns a FAILURE with that rejection detail, never a false 'queued'. Pass to_node_id to RUN ONLY ONE BRANCH ('run to node'): ComfyUI renders just that output node plus everything upstream of it and SKIPS every other output branch — handy for previewing or debugging part of a big graph without rendering the whole thing. to_node_id MUST be an OUTPUT node (SaveImage, PreviewImage, SaveVideo, …) — pick the one at the END of the branch you want; nodes are tagged is_output:true in panel_query_graph's detail rows. The output node may be NESTED inside a subgraph — just pass its id (resolved in the scope you're currently viewing, then anywhere in the workflow); the tool builds the nested execution path for you. Omit it to run the whole graph. Use this so the render runs on THEIR canvas and they see the result.",
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
      },
      async (args: A, ctx) => {
        // BACKPRESSURE: the agent can't see ComfyUI's queue, so re-queuing while a
        // render is already running silently stacks behind it (this is how a stuck
        // job once let three more pile up). Snapshot the watchdog BEFORE we queue.
        const pre = QueueMonitor.snapshot();
        const res = await ctx.call(
          { cmd: "graph_run", batch_count: args.batch_count, to_node_id: args.to_node_id },
          20000,
        );
        // Derive the verdict from the AUTHORITATIVE reply, not a bare `queued`
        // flag. A rejection — a no-connected-tab / thrown-queuePrompt error
        // (#331/#248), or a ComfyUI /prompt refusal on EITHER channel
        // (top-level `error` with empty node_errors #213, or per-node
        // node_errors) — is surfaced as a failure WITHOUT the success-only
        // "you'll be notified automatically" guidance. Only a genuine queue
        // gets the anti-poll note below.
        const rejection = detectRunRejection(res);
        if (rejection) return rejection;
        // Attribute this genuine queue to ourselves so a later panel_run in the
        // same batch recognizes the in-flight job as our own and doesn't false-warn
        // (#559). The panel forwards ComfyUI's /prompt reply, which carries the
        // prompt_id; when it doesn't, the timestamp still marks a recent self-queue.
        const queuedId = ((): string | null => {
          const parsed = parseToolResultJson(res);
          const pid = parsed?.prompt_id;
          return typeof pid === "string" && pid ? pid : null;
        })();
        QueueMonitor.markSelfQueued(queuedId);
        // Append anti-poll guidance: the agent should go idle after queuing so the
        // executed event auto-injects the output image, rather than busy-polling.
        const note =
          "\n\n[IMPORTANT] You will be notified automatically with the output image(s)/video when the render finishes — do NOT poll get_queue, get_history, or list_output_images. Just end your turn now and wait for the result to be delivered to you.";
        // Backpressure note. A backlog is only alarming when it's a job we did NOT
        // queue (possibly foreign/stuck). Deliberately batching renders — a sweep,
        // a multi-variant comparison — is a NORMAL workflow, so a queue made of our
        // own recent jobs is reported NEUTRALLY, never paired with the destructive
        // clear_pending remedy that would wipe the user's whole batch (#559). A
        // genuinely stalled render is caught by the turn-start stall notice, which
        // does the staleness gating and keeps the interrupt guidance.
        let warn = "";
        if (pre.connected && pre.running) {
          const pending = Math.max(0, pre.queueDepth - 1);
          const pendingTxt = pending > 0 ? ` + ${pending} pending` : "";
          if (pre.selfAttributed) {
            warn =
              `\n\n[QUEUE] Queued behind your own in-flight render(s) (1 running${pendingTxt}). ` +
              `This is normal when batching a sweep or comparison — they drain in order and nothing is stuck; ` +
              `each result is delivered to you as it finishes. To drop a single pending item, use cancel_queued_job. ` +
              `Only use cancel_job with clear_pending:true if a render is ACTUALLY wedged — it kills the running job AND your entire queue.`;
          } else {
            warn =
              `\n\n[QUEUE] A render is already running${pre.runningPromptId ? ` (prompt ${pre.runningPromptId})` : ""}${pendingTxt}, ` +
              `and the queue includes work this session didn't queue — your run is queued behind it. Inspect with get_queue before acting. ` +
              `If the running job is genuinely stuck, cancel_job with clear_pending:true interrupts it AND drops pending, then escalate to restart_comfyui if it reports the job wedged.`;
          }
        }
        if (res.content?.[0]?.type === "text") {
          return {
            ...res,
            content: [{ type: "text", text: res.content[0].text + warn + note }, ...res.content.slice(1)],
          };
        }
        return res;
      },
    ),
    def(
      "panel_get_errors",
      "WHY IS THAT NODE RED / WHY DID THE RUN FAIL? The single error surface for the user's open tab: every errored node JOINED TO ITS CAUSE, which ComfyUI itself does not show — LiteGraph only paints a red outline and stores no reason, which is why users report \"red node, no error message\". Call this whenever the user mentions a red/highlighted/erroring node, a failed run, or \"required models are missing\" — instead of guessing from widget values. Each entry in `nodes[]` is the node's full detail summary plus `red_outline` and `reasons[]`, drawn from every source: `missing_model` (exact file, its models directory, the widget holding it, and a download URL when known), `missing_media` (a referenced input image/video that isn't on disk — the usual cause of a red LoadImage), `validation` (per-input errors from the last queue attempt: message, details, offending input), and `execution` (runtime failure with `exception_type`, e.g. PIL.UnidentifiedImageError). TWO THINGS THAT MAKE THIS ESSENTIAL: (1) missing model/media assets paint nodes red AS SOON AS THE WORKFLOW LOADS, long before any queue attempt — so the raw validation map is still EMPTY while the user is staring at red nodes; (2) a node that throws AT RUNTIME is never painted red at all, so it can't be spotted on the canvas — it appears here with red_outline:false. Also returns graph-level `missing_models`, `missing_media`, `missing_node_types` (or `missing_node_count`), plus the raw `node_errors` map and `last_execution_error` for reference. A ⚠️ GRAPH VALIDATION block is auto-injected at your turn start when this state changes; call this to re-check on demand (e.g. after you edit widgets/links). Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_get_errors" }),
    ),
    def(
      "panel_refresh_nodes",
      "Re-pull the live ComfyUI server's /object_info and rebuild every combo/loader option list in the user's open tab, so an asset that appeared server-side AFTER the tab loaded becomes SELECTABLE without a manual reload (the 'press R' step) or a restart. Use this right after stage_output_as_input (chaining a stage's output into a LoadImage / VHS_LoadVideo / LoadAudio loader — the returned filename won't be in the loader's dropdown until you refresh), after downloading a model / LoRA / VAE (a freshly downloaded file is otherwise 'not a valid option' in its loader), or after installing a node pack. Then panel_set_widget / panel_add_node will accept the new value. Non-destructive: it only re-registers node defs and refreshes combo option lists — it does NOT change your graph and is undo-neutral. Idempotent (safe to call repeatedly). Returns whether the refresh authoritatively fetched fresh defs.",
      {},
      async (_args, ctx) =>
        // Same bounded ack budget as the refresh-before-validate writes (#599): a
        // fresh /object_info on a large install routinely exceeds the 6000 ms
        // default, and this command's WHOLE purpose is to await that fetch.
        ctx.call({ cmd: "refresh_nodes" }, OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS),
    ),
    def(
      "panel_reload",
      "Soft-reload yourself to pick up code changes WITHOUT restarting ComfyUI — your chat session resumes automatically and you'll be nudged to continue. Use scope 'orchestrator' (default) after backend/orchestrator code changed (new tools, system prompt, services); use scope 'frontend' after the panel UI (web JS/CSS) changed. This ENDS the current turn — your tools/prompt are reloaded and you continue fresh. For custom-node or model changes that need a full ComfyUI restart, use panel_restart_comfyui instead. Only call this when code has actually changed and needs to take effect now.",
      {
        scope: z
          .enum(["orchestrator", "frontend"])
          .optional()
          .describe("'orchestrator' (default): respawn the agent for new backend code. 'frontend': reload the panel UI for new web code."),
      },
      async (args: A, ctx) => {
        // panel_reload is an explicit "recover me now" signal — if THIS session's
        // tab id was orphaned by a reconnect/reload/workflow-switch, self-heal it
        // onto the active tab first so a stuck session can recover by calling this
        // (and so the soft_reload frame actually reaches a live tab). A healthy
        // session is left untouched; an ambiguous multi-tab case surfaces a clear
        // error rather than guessing.
        if (ctx.rebindToActiveTab) {
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
                "can't safely pick one. Switch to the tab you want, then call " +
                'panel_set_workflow_target({mode:"current"}) before panel_reload.',
            );
          }
          try {
            ctx.rebindToActiveTab();
          } catch (err) {
            return fail(err);
          }
        }
        return ctx.call({ cmd: "soft_reload", scope: (args.scope as string) ?? "orchestrator" }, 15000);
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
      "Securely collect an API token / secret from the user and write it straight to config — you NEVER see the value and it is never saved to chat history. The panel shows a masked input; the pasted value goes directly to the orchestrator, which stores it on the target MCP server, then applies it. Returns only a redacted confirmation.\n\nTWO targets:\n• The BUILT-IN comfyui server (mcp_server 'comfyui', target_kind 'env') — for tokens YOUR OWN comfyui tools need. The env key MUST be one of a fixed allowlist: CIVITAI_API_TOKEN (download_civitai_model), HUGGINGFACE_TOKEN or HF_TOKEN (HuggingFace downloads). Any other key is rejected. The secret is injected into the comfyui server's env and the server is RESPAWNED automatically — NO panel_reload needed; after this turn ends the tools restart with it and you'll be nudged to retry. THIS is what fixes a download that returned HTTP 401.\n• A user-added MCP server (e.g. the 'civitai' http server you added with panel_add_mcp) — use target_kind 'header' (e.g. Authorization, value_prefix 'Bearer ') for http/sse, or 'env' for stdio; then call panel_reload to load it.\n\nFor a CivitAI DOWNLOAD 401, target 'comfyui' env CIVITAI_API_TOKEN — NOT the 'civitai' MCP server (that's only the search MCP).",
      {
        label: z.string().describe("Prompt shown above the masked input, e.g. 'Paste your CivitAI API token'."),
        target_kind: z.enum(["header", "env"]).describe("'header' for http/sse servers (e.g. Authorization); 'env' for stdio servers and the built-in comfyui server."),
        mcp_server: z.string().describe("MCP server to attach the secret to: 'comfyui' for the built-in tools (download_civitai_model etc.), 'orchestrator' for orchestrator-level provider keys (OPENROUTER_API_KEY), or a user-added server name like 'civitai'."),
        key: z.string().describe("For 'comfyui': one of CIVITAI_API_TOKEN, HUGGINGFACE_TOKEN, HF_TOKEN (others rejected). For a user-added server: env var name or header name (e.g. 'Authorization')."),
        value_prefix: z.string().optional().describe("Optional string prepended to the token, e.g. 'Bearer '. Usually empty for env vars."),
        hint: z.string().optional().describe("Optional reassurance/help text shown under the input."),
      },
      async (args: A, ctx) => {
        try {
          const secret = await ctx.bridge.send(
            { cmd: "request_secret", label: args.label, hint: args.hint },
            { tabId: ctx.tabId, timeoutMs: 300000 },
          );
          if (typeof secret !== "string" || secret.length === 0) {
            return ok("No token entered — nothing was saved.");
          }
          const server = (args.mcp_server as string) ?? "";
          // An ORCHESTRATOR provider secret (OpenRouter API key) — stored in the
          // agent-secret slice of the 0600 config and hydrated into the
          // orchestrator's OWN env, which flips the OpenRouter provider to ready
          // and lists its models. NOT injected into the comfyui child.
          if (server.toLowerCase() === "orchestrator" || isAllowedAgentSecretKey(args.key as string)) {
            setAgentSecret(args.key as string, secret);
            return ok(
              `🔒 ${args.key} saved to your ~/.comfyui-mcp config. The OpenRouter provider is now enabled — pick it in the provider list.`,
            );
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
            setComfyuiSecret(args.key as string, `${(args.value_prefix as string) ?? ""}${secret}`, {
              // This save ANSWERS an outstanding agent secret request — mark it so
              // the orchestrator injects the "retry the action" nudge, and carry
              // the requesting tab so ONLY that tab's agent is nudged (never a
              // broadcast to unrelated tabs). A Settings-panel slot save omits
              // both and never nudges (#164).
              requested: true,
              tabId: ctx.tabId,
            });
            // Redacted ack ONLY — the secret never enters the agent's context. The
            // respawn is deferred to this turn's end, so this is accurate.
            return ok(
              `🔒 Token saved for the built-in comfyui tools (env "${args.key}"). It's being applied now — the comfyui tools respawn with it as soon as this turn ends, then I'll retry. No reload needed.`,
            );
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
          return fail(err);
        }
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
              status: z
                .enum(["pending", "active", "done"])
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
      async (args: A, ctx) => ctx.call({ cmd: "set_todo", items: args.items }, 15000),
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
          return await ctx.call(
            {
              cmd: "open_civitai",
              query,
              tab: args.tab,
              browsingLevels,
              filters: args.filters,
              dock: args.dock,
            },
            10000,
          );
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
        const res = await ctx.call({ cmd: "civitai_results", limit: args.limit }, 10000);
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
      async (args: A, ctx) => ctx.call({ cmd: "civitai_highlight", ids: args.ids, kind: args.kind }, 10000),
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
          const reply = await ctx.bridge.send(
            { cmd: "civitai_search", query, filters: args.filters, browsingLevels } as { cmd: string },
            { tabId: ctx.tabId, timeoutMs: 10000 },
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
                  `account-gated content). Verify the exact username with search_civitai_creators, or drive ` +
                  `the logged-in browser session directly.`,
              });
            }
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
      "Ask the user to choose between options — renders an interactive question card in the panel chat and BLOCKS until they pick, returning their choice as text. Use this (NOT the AskUserQuestion tool, which never renders here) whenever you need the user to decide between options. Each option may carry a short description. The card always includes an 'Other…' free-text field, so the returned string may be a listed label or whatever the user typed (comma-joined for multi_select). Ask only when the answer genuinely changes what you do.",
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
          return noReachableTabFail(args.name ? "workflow_save_as" : "workflow_save");
        }
        return args.name
          ? ctx.call({ cmd: "workflow_save_as", name: args.name }, 15000)
          : ctx.call({ cmd: "workflow_save" }, 15000);
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
      "Pin the agent to a specific open workflow tab (it must be the ACTIVE/in-view workflow at pin time), or release the pin to follow the user's current tab. The panel can only read or edit the workflow currently in view, so pinning to a background tab is REJECTED at pin time — to work on a different open workflow, switch to it first with panel_open_workflow (that makes it active), then pin. Pinning does NOT change the user's view; it binds your panel_* graph edits to that workflow and makes a later mismatch (e.g. the user switches away) fail loudly instead of silently editing the wrong graph. Set mode:'pinned' with path from panel_list_workflows; set mode:'current' (or omit path) to follow the active tab again. mode:'current' is ALSO the explicit RECOVERY signal: if your panel_* calls started failing with `no connected tab` after ComfyUI reconnected, the panel reloaded, or the user switched to a different workflow FILE, call this with mode:'current' to rebind this session onto the tab that's live now.",
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
        if (mode === "current" && ctx.rebindToActiveTab) {
          const before = ctx.tabId;
          // Give an in-flight reconnect (a ComfyUI restart / panel reload still
          // settling) a brief chance to bind immediately, since this IS the recovery
          // signal the agent reaches for in exactly that window (#474). awaitReachable
          // rebinds via ensureReachable when a tab is (re)connected.
          if (ctx.awaitReachable) await ctx.awaitReachable();
          try {
            ctx.rebindToActiveTab(); // completes the rebind if awaitReachable didn't
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
            if (!noTabsConnected) return fail(err);
            deferredBind = true;
            rebindNote =
              " No panel tab is connected yet — cleared the stale binding; this session will " +
              "follow (bind onto) the tab as soon as one reconnects. Retry your graph tool in a " +
              "moment; if nothing reconnects shortly, ask the user to refresh (reload) the ComfyUI " +
              "browser tab, which reconnects the Agent panel after a restart (not an install issue).";
          }
          // Detect the rebind regardless of whether awaitReachable or rebindToActiveTab
          // performed it (either mutates ctx.tabId), so the note is never swallowed.
          if (!deferredBind && ctx.tabId !== before) {
            rebindNote = ` Rebound this session from tab ${before.slice(0, 8)} onto the active tab ${ctx.tabId.slice(0, 8)}.`;
          }
        }
        // PIN: bind to the EXACT open-workflow identity from the authoritative
        // workflow_list, canonicalizing to its stable `key`, FAILING CLOSED when the
        // requested workflow isn't open (#259), and FAILING AT PIN TIME when it is open
        // but not the active canvas (#556/#571). Shared with the panel-driven event path
        // so both entry points validate identically.
        let pinPath = path;
        let pinFilename = filename;
        if (mode === "pinned" && path) {
          const res = await resolvePinTarget(ctx, path, filename);
          if (!res.ok) return fail(res.error);
          pinPath = res.pinPath;
          pinFilename = res.pinFilename;
        }
        const target = ctx.workflowTarget.set(ctx.tabId, {
          mode,
          path: pinPath,
          filename: pinFilename,
        });
        ctx.bridge.push({ type: "workflow_target", target }, ctx.tabId);
        const hint =
          target.mode === "pinned"
            ? `Pinned to "${target.filename ?? target.path}". Graph tools will target that workflow without switching the user's view.`
            : "Following the user's current workflow tab.";
        return ok({ ...target, ...(deferredBind ? { deferred: true } : {}), note: hint + rebindNote });
      },
    ),
    def(
      "panel_new_workflow",
      "Open a brand-new BLANK workflow in a NEW TAB. Use this whenever the user wants a 'new workflow' / 'fresh canvas' / 'start over for a new project'. This does NOT touch their current workflow — it opens a separate tab. NEVER use panel_clear for a new workflow (panel_clear wipes the CURRENT graph and is only for 'clear/reset this canvas').",
      {},
      async (_args, ctx) => ctx.call({ cmd: "workflow_new" }, 15000),
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
      { node_ids: z.array(z.number().int()).describe("Node ids to select.") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_select_nodes", node_ids: args.node_ids }),
    ),
    def(
      "panel_create_subgraph",
      "Group the given nodes into a SUBGRAPH (ComfyUI 'Convert to Subgraph') on the user's canvas — collapses them into one subgraph node. Returns the new subgraph node id. Undoable with Ctrl+Z. To wrap an existing GROUP, prefer panel_subgraph_group (you don't have to list the node_ids yourself).",
      { node_ids: z.array(z.number().int()).describe("Node ids to group into a subgraph.") },
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
        node_id: z.number().int().optional().describe("Subgraph node id to publish (is_subgraph=true). Omit to use the selected subgraph node."),
        name: z.string().optional().describe("Blueprint name. Defaults to the subgraph node's title."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_save_subgraph", node_id: args.node_id, name: args.name }, 20000),
    ),
    def(
      "panel_list_subgraphs",
      "List the saved subgraph BLUEPRINTS in the user's library (from panel_save_subgraph, plus any global/bundled ones). Each entry has {name, type, display_name, description, is_global} — use name/type with panel_add_subgraph to drop it onto the canvas. Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_list_subgraphs" }, 15000),
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
      "Rename a node's TITLE (the label on its header) — e.g. to label a node by its purpose. Different from panel_set_widget (which changes a value). Undoable with Ctrl+Z.",
      {
        node_id: z.number().int().describe("Node id from panel_graph_outline / panel_query_graph."),
        title: z.string().describe("New title text."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_set_title", node_id: args.node_id, title: args.title }, 15000),
    ),
    def(
      "panel_set_node_collapsed",
      "Collapse (minimize) or expand a node on the user's open graph. Collapsed nodes shrink to just their title bar — handy for tidying loaders or rarely-touched nodes. Undoable.",
      {
        node_id: z.number().int().describe("Node id from panel_graph_outline / panel_query_graph."),
        collapsed: z.boolean().optional().describe("true = collapse/minimize (default), false = expand."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_set_node_collapsed", node_id: args.node_id, collapsed: args.collapsed }),
    ),
    def(
      "panel_set_node_mode",
      "Set a node's EXECUTION MODE on the user's open graph — active, bypass, or mute — and return { node_id, mode, previous_mode }. This is how you turn a node ON or OFF without deleting it. Modes:\n" +
        "• 'active' — normal: the node executes.\n" +
        "• 'bypass' — the node is SKIPPED and PASSES ITS INPUT THROUGH to its output (downstream still runs, just as if this node weren't there). Use to disable a single processing node (an upscaler, a LoRA, a detailer) while keeping the pipeline connected.\n" +
        "• 'mute' — the node AND everything DOWNSTREAM of it do NOT execute (no pass-through). Use to fully switch off a branch/output.\n" +
        "CRITICAL — modes silently change what a render produces, so they are a top cause of 'wrong output'. A BYPASSED node contributes nothing of its own and a MUTED node kills its branch. Use this tool to ENABLE the path you actually want and DISABLE the one you don't — e.g. to drive a workflow from its Ideogram/JSON prompt builder you must set the manual-prompt node to 'bypass' and the JSON-builder path to 'active' (or vice-versa); likewise to pick one branch of an rgthree 'Fast Groups Bypasser'/Muter or a prompt-source switch. ALWAYS read modes first (panel_graph_outline marks [bypass]/[mute]; panel_query_graph detail rows carry mode): if the intended path is bypassed/muted, fix it HERE before running, and never assume a switch/route is already active. UNSAFE-BYPASS GUARD: bypassing a SUBGRAPH node whose boundary inputs are ordered differently from its outputs is REJECTED — ComfyUI forwards each output from the input at the SAME index, so e.g. an IMAGE output backed by a BBOX_DETECTOR input would silently feed the wrong type downstream. Re-order the boundary inputs or add an explicit ImpactSwitch to choose the passthrough; pass force:true only if you truly intend the positional forward. Undoable with Ctrl+Z.",
      {
        node_id: z.number().int().describe("Node id from panel_graph_outline / panel_query_graph."),
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
      "Set a node's title-bar and/or body color on the user's open graph. Easiest: pass a `preset` from ComfyUI's palette (red, brown, green, blue, pale_blue, cyan, purple, yellow, black) for matched colors. Or set explicit `color` (title bar) and/or `bgcolor` (body) as hex like '#3f789e'. Pass null for a field to reset it to the theme default. Great for colour-coding stages. Undoable.",
      {
        node_id: z.number().int().describe("Node id from panel_graph_outline / panel_query_graph."),
        preset: z
          .enum(["red", "brown", "green", "blue", "pale_blue", "cyan", "purple", "yellow", "black"])
          .optional()
          .describe("Named LiteGraph color preset (sets both title + body)."),
        color: z.string().nullable().optional().describe("Title-bar color hex, or null to clear. Ignored if preset given."),
        bgcolor: z.string().nullable().optional().describe("Body color hex, or null to clear. Ignored if preset given."),
      },
      async (args: A, ctx) =>
        ctx.call({
          cmd: "graph_set_node_color",
          node_id: args.node_id,
          preset: args.preset,
          color: args.color,
          bgcolor: args.bgcolor,
        }),
    ),
    def(
      "panel_screenshot",
      "Render the workflow the user is currently viewing (root graph, or the open subgraph) to a PNG and return it as an IMAGE so you can SEE the layout. It frames the whole graph (nodes + groups), captures, then restores the user's view. Use this to visually verify a layout you just built — overlaps, alignment, rails, colors, group bands — instead of reasoning from coordinates alone.",
      { padding: z.number().optional().describe("Margin around the graph in px (default 60).") },
      async (args: A, ctx) => {
        try {
          ctx.ensureReachable?.();
          // Route to the same authoritative target as ctx.call: a pinned session
          // screenshots the PINNED workflow (via injected workflow_path), not just
          // whatever tab is visible (codex — graph_* must carry the pin).
          const target = ctx.workflowTarget?.get(ctx.tabId);
          const cmd = withWorkflowTarget(
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
      { node_id: z.number().int().describe("Subgraph node id (is_subgraph=true).") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_enter_subgraph", node_id: args.node_id }, 15000),
    ),
    def(
      "panel_exit_subgraph",
      "Leave the current subgraph and return to the root graph (undo a panel_enter_subgraph). After this, panel_* tools target the root graph again.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_exit_subgraph" }, 15000),
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
        node_id: z.number().int().describe("Inner node id (from panel_query_graph while inside the subgraph)."),
        widget: z.string().describe("Name of the widget on that node to promote (e.g. 'seed', 'steps', 'text')."),
        demote: z.boolean().optional().describe("Set true to UN-promote (remove the widget from the parent node)."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_promote_widget", node_id: args.node_id, widget: args.widget, demote: args.demote }, 15000),
    ),
    def(
      "panel_expose_subgraph_output",
      "Wire an interior node's OUTPUT to the subgraph's OUTPUT RAIL — i.e. expose it as a SUBGRAPH OUTPUT on the boundary so the PARENT graph can connect to the subgraph node's new output slot. You MUST be INSIDE the subgraph first (panel_enter_subgraph). This is the correct way to \"wire an internal output to the subgraph's output rail\": do NOT panel_connect to a guessed rail node id — call this with the interior node + the output you want exposed. Read panel_query_graph's `rails` to see the resulting boundary slots. `from_output` is an output slot NAME ('IMAGE', 'LATENT') or numeric index. Optional `name` titles the new boundary output (defaults from the source slot). Undoable with Ctrl+Z.",
      {
        from_node_id: z.number().int().describe("Interior (inner) node id whose output to expose (from panel_query_graph while inside the subgraph)."),
        from_output: slotRef.describe("Output slot name (e.g. 'IMAGE', 'LATENT') or numeric index on that node."),
        name: z.string().optional().describe("Optional name for the new subgraph output (boundary slot). Defaults from the source slot."),
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
      "Wire an interior node's INPUT to the subgraph's INPUT RAIL — i.e. expose it as a SUBGRAPH INPUT on the boundary so the PARENT graph can feed the subgraph node's new input slot. You MUST be INSIDE the subgraph first (panel_enter_subgraph). This is the correct way to wire an internal input to the subgraph's input rail: do NOT panel_connect to a guessed rail node id — call this with the interior node + the input you want exposed. Read panel_query_graph's `rails` to see the resulting boundary slots. `to_input` is an input slot NAME ('model', 'pixels') or numeric index. Optional `name` titles the new boundary input (defaults from the target slot). Undoable with Ctrl+Z.",
      {
        to_node_id: z.number().int().describe("Interior (inner) node id whose input to expose (from panel_query_graph while inside the subgraph)."),
        to_input: slotRef.describe("Input slot name (e.g. 'model', 'pixels') or numeric index on that node."),
        name: z.string().optional().describe("Optional name for the new subgraph input (boundary slot). Defaults from the target slot."),
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
      { node_id: z.number().int().describe("Subgraph node id to unpack/dissolve (is_subgraph=true, from panel_graph_outline / panel_query_graph).") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_unpack_subgraph", node_id: args.node_id }, 15000),
    ),
    def(
      "panel_search_nodes",
      "Search installable custom-node packs via the user's BUILT-IN ComfyUI Manager (the same source the Manager UI uses). Returns matching packs {id, title, description}. Use the `id` with panel_install_node. Prefer this over the headless search_custom_nodes tool — it works against the user's actual (Desktop) Manager.",
      { query: z.string().describe("Search text, e.g. 'kjnodes', 'controlnet', 'ipadapter'."), limit: z.number().int().min(1).max(40).optional() },
      async (args: A, ctx) => ctx.call({ cmd: "nodes_search", query: args.query, limit: args.limit }, 20000),
    ),
    def(
      "panel_list_nodes",
      "List the custom-node packs currently installed in the user's ComfyUI (via the built-in Manager). Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "nodes_list" }, 20000),
    ),
    def(
      "panel_install_node",
      "Install a custom-node pack into the user's ComfyUI via the BUILT-IN Manager (queues the install). Pass `id` (registry id like 'comfyui-kjnodes' or 'author/repo') from panel_search_nodes, or `repository` (git URL) for a nightly install. A ComfyUI restart (panel_restart_comfyui) is usually required afterward to load the nodes — poll panel_node_queue_status first. Prefer this over the headless install_custom_node tool. " +
        "⚠️ QUEUE-DONE IS NOT INSTALLED: Manager marks a task 'done' (queue drained) even when the git clone produced NOTHING — an empty dir, a transient git failure, or a repo not in its registry. So after the queue is idle you MUST VERIFY with panel_list_nodes that each pack actually appears before you restart or report success; a pack you installed that is absent from that list did NOT install (retry it, or install it from its git `repository` URL). " +
        "Install packs ONE AT A TIME and confirm each populated before the next — batching several installs then restarting is exactly how you end up with empty dirs and a broken restart.",
      {
        id: z.string().optional().describe("Registry id or 'author/repo'."),
        repository: z.string().optional().describe("Git URL (for a nightly/from-source install)."),
        version: z.string().optional().describe("Specific version; default 'latest' (or 'nightly' with repository)."),
        channel: z.string().optional().describe("Manager channel (default 'default')."),
        mode: z.enum(["remote", "local", "cache"]).optional().describe("DB source (default 'remote')."),
      },
      async (args: A, ctx) =>
        ctx.call(
          { cmd: "nodes_install", id: args.id, repository: args.repository, version: args.version, channel: args.channel, mode: args.mode },
          30000,
        ),
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
      async (args: A, ctx) =>
        ctx.call(
          { cmd: "graph_update_node", id: args.id, version: args.version, channel: args.channel, mode: args.mode },
          30000,
        ),
    ),
    def(
      "panel_node_queue_status",
      "Check the built-in Manager's install/update queue status (to see if a queued install finished). Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "nodes_queue_status" }, 20000),
    ),
    def(
      "panel_restart_comfyui",
      "Restart the user's ComfyUI server via the built-in Manager — needed to load newly installed/updated custom nodes. CALL THIS DIRECTLY when a restart is needed: it pops a confirm card and only restarts on a yes (don't ask separately first). ComfyUI and this agent go down briefly, then the panel auto-reconnects and you resume. ⚠️ BUSY GUARD: a restart ABORTS any in-progress or queued generation — if ComfyUI is generating, this tool REFUSES and tells you (it does NOT restart). When that happens, tell the user a render is running and WAIT for it (poll panel_node_queue_status), or pass force:true ONLY if the user explicitly confirms they want to kill the running generation. Best practice: before restarting after an install, check the queue is idle first. Only call when a restart is actually needed.",
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
        const decision = await ctx.confirm(
          "Restart ComfyUI now? It (and this agent) will go down briefly, then reconnect and resume automatically.",
          "Restart ComfyUI",
          Math.max(1, overallDeadline - Date.now()),
        );
        if (decision === "timeout") {
          return ok(
            "Timed out waiting for your confirmation, so I did NOT restart ComfyUI. " +
              "Tell me to restart it and I'll go ahead.",
          );
        }
        if (decision !== "yes") {
          return ok("Cancelled — ComfyUI was not restarted.");
        }
        // Heal an orphaned session onto the live tab FIRST, then bind the reboot dispatch
        // to that ONE tab id (no await between capture and dispatch, so JS run-to-
        // completion prevents any rebind in between). The boot-endpoint probe target is
        // server-authorized + immutable, bound to the exact host FAMILY the reboot goes
        // to (null unless the bound tab provably fronts our boot instance).
        ctx.ensureReachable?.();
        const boundTabId = ctx.tabId;
        const healthBase = captureRebootHealthBase(ctx);
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
        const recoveryPromise =
          healthBase != null
            ? observeRecovery(timing, gate.deadline, { healthBase, gate })
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
          if (
            !isRemoteMode() &&
            rebootNoEndpoint(res) &&
            // INSTANCE BINDING: restartComfyUI() acts on the orchestrator's GLOBAL config
            // target (a hello can retarget it). Only run it when the bound tab provably
            // fronts our OWN boot instance AND that boot instance is the CURRENT global
            // target — so the relaunch cycles the SAME instance this tab rebooted.
            healthBase != null &&
            sameHttpBase(getComfyUIBaseUrl(), healthBase)
          ) {
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
                  "The built-in Manager exposed no reboot endpoint (legacy Manager 3.x), and " +
                  "there isn't enough remaining time to safely run the headless managed restart " +
                  "(kill + relaunch). ComfyUI was NOT restarted — retry panel_restart_comfyui " +
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
            // The observation window spans the ~40s blocking sync + a full cold-start
            // window. (Under a test timing override, use the injected budget instead so the
            // never-certify cases don't wait the real ~140s.)
            const legacyProofWindow = panelRebootTimingOverride
              ? timing.settleMs + timing.budgetMs
              : LEGACY_RESTART_MIN_BUDGET_MS;
            const proofDeadline = Math.min(Date.now() + legacyProofWindow, overallDeadline);
            const proofPromise = observeRecovery(timing, proofDeadline, { healthBase });
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
                "The built-in Manager exposed no reboot endpoint (legacy Manager 3.x), " +
                  "and the headless managed restart also failed: " +
                  (err instanceof Error ? err.message : String(err)) +
                  " — restart ComfyUI on the host, then reconnect.",
              );
            }
            clearTimeout(restartTimer);
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
                "The built-in Manager exposed no reboot endpoint (legacy Manager 3.x). " +
                  "Tried the headless managed restart (kill + relaunch), but it did not restart " +
                  `ComfyUI: ${restart?.message ?? "unknown error"} ` +
                  "Restart ComfyUI on the host, then reconnect.",
              );
            }
            // Otherwise (the process WAS stopped/started, or restartComfyUI's own readiness
            // poll merely expired — neither terminal) DEFER to OUR OWN observed DOWN→UP.
            const recovery = await proofPromise;
            const observed = recovery.via === "observed-cycle";
            return ok({
              rebooting: true,
              ready: recovery.ready,
              confirmed_cycle: observed, // true = we directly observed the down→up cycle
              recovered_ms: recovery.waited_ms,
              probes: recovery.attempts,
              saw_down: recovery.sawDown,
              via: recovery.ready ? recovery.via : undefined,
              note:
                "ComfyUI-Manager (legacy 3.x) had no reboot endpoint; ran the headless managed " +
                "restart (kill + relaunch) " +
                (recovery.ready
                  ? `and it came back healthy in ${(recovery.waited_ms / 1000).toFixed(1)}s` +
                    (observed ? " (observed it go down then come back)." : " (cycle not directly observed).")
                  : `but it did NOT become healthy within ${Math.round(recovery.waited_ms / 1000)}s — verify with health_check / panel_node_queue_status before assuming it restarted.`),
            });
          }
          // Genuine refusal (busy guard / security / no eligible fallback) — return
          // verbatim; do NOT reset caches (that would close the shared client mid-render).
          return res;
        }

        // ACCEPTED. A reboot restarts ComfyUI out-of-band, so the orchestrator's cached WS
        // client + /object_info go stale (#353/#357/#378/#394) — drop both caches.
        resetClient();
        resetObjectInfoCache();

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
          // No probeable boot endpoint — the concurrent observer was never started.
          return ok({
            rebooting: true,
            ready: false,
            confirmed_cycle: false,
            dispatched: true,
            note:
              "ComfyUI restart was dispatched and accepted; it is restarting out-of-band. " +
              "There is no local boot endpoint I can safely probe from here, so I can't " +
              "confirm it finished coming back — a panel reconnect wouldn't prove this " +
              "instance actually cycled. Check health_check / panel_node_queue_status in a " +
              "few seconds to confirm it's back.",
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
        if (!recovery.ready) {
          const waited = Math.round(recovery.waited_ms / 1000);
          return ok({
            rebooting: true,
            ready: false,
            confirmed_cycle: false,
            recovered_ms: recovery.waited_ms,
            probes: recovery.attempts,
            saw_down: recovery.sawDown,
            note: recovery.sawDown
              ? `Reboot was dispatched and ComfyUI went down, but it has not become healthy within ${waited}s — it may still be starting or the restart failed. Verify with health_check / panel_node_queue_status before retrying; do NOT assume it is back.`
              : `The reboot command was sent but I could NOT confirm ComfyUI actually cycled within ${waited}s (it never went down — the panel may have merely disconnected/inferred a reboot without one). Verify with health_check / panel_node_queue_status; do NOT assume it restarted.`,
          });
        }
        // #400: ComfyUI is healthy, but the panel's browser tab re-registers its own
        // socket a moment later. If we return NOW, the very next graph tool in this turn
        // hits "no connected tab … Connected: none" and the agent is told to hand-rebind.
        // Wait (bounded, clamped to THIS handler's deadline) for the tab to reconnect and
        // rebind this session onto it. `ready` reflects GRAPH-TOOL readiness (a bound tab),
        // NOT just server health — a caller keying off `ready` must not be led into the
        // Connected:none window (codex). `server_ready` carries the certified cycle either
        // way. When ctx has no awaitReachable (older/lightweight ctx) tabBack is true, so
        // the historical ready:true-on-healthy-restart contract is preserved.
        const tabBack = ctx.awaitReachable
          ? await ctx.awaitReachable(Math.max(0, overallDeadline - Date.now()))
          : true;
        return ok({
          rebooting: true,
          ready: tabBack, // graph tools are usable only once a panel tab is bound
          server_ready: true, // ComfyUI itself cycled and is healthy
          confirmed_cycle: true, // we directly observed the down→up cycle on the boot endpoint
          recovered_ms: recovery.waited_ms,
          probes: recovery.attempts,
          saw_down: recovery.sawDown,
          via: recovery.via,
          panel_tab_reconnected: tabBack,
          note:
            `ComfyUI restart accepted and it is healthy again in ${(recovery.waited_ms / 1000).toFixed(1)}s` +
            " (observed it go down then come back)" +
            (dropped ? "; connection dropped as expected while it went down" : "") +
            (tabBack
              ? "; the panel tab reconnected — graph tools are ready."
              : "; ComfyUI is back but the panel tab has NOT reconnected yet (ready:false) — " +
                'wait a moment then retry, or rebind with panel_set_workflow_target({mode:"current"}) ' +
                "before issuing graph tools.") +
            ".",
        });
      },
    ),
    def(
      "panel_free_vram",
      "Unload all loaded models and free VRAM (ComfyUI /free). Use to unwedge a stuck/OOM ComfyUI when a cancel didn't free memory — before retrying or, last resort, restarting (panel_restart_comfyui). Does NOT restart ComfyUI; it just drops resident models and frees cached memory.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "free_vram" }, 15000),
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
        const VIDEO_EXTS = new Set([".mp4", ".webm"]);
        const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

        const resolved: Array<Record<string, unknown>> = [];
        for (const item of items) {
          const src = item.source;
          if ("path" in src) {
            // Absolute disk path — orchestrator reads + base64-encodes it.
            const p = src.path;
            if (!isAbsolute(p)) {
              return fail("path must be absolute: " + p);
            }
            if (!existsSync(p)) {
              return fail("file not found: " + p);
            }
            const stat = statSync(p);
            if (!stat.isFile()) {
              return fail("not a regular file: " + p);
            }
            if (stat.size > MAX_BYTES) {
              return fail(
                "file too large (" + (stat.size / 1024 / 1024).toFixed(1) + " MB > 20 MB): " + p,
              );
            }
            const ext = extname(p).toLowerCase();
            let mime: string;
            if (IMAGE_EXTS.has(ext)) {
              mime = ext === ".jpg" ? "image/jpeg" : "image/" + ext.slice(1);
            } else if (VIDEO_EXTS.has(ext)) {
              mime = "video/" + ext.slice(1);
            } else {
              return fail(
                "unsupported file type \"" + ext + "\" (allowed: " + [...IMAGE_EXTS, ...VIDEO_EXTS].join(", ") + "): " + p,
              );
            }
            const buf = readFileSync(p);
            const dataUrl = "data:" + mime + ";base64," + buf.toString("base64");
            const kind = IMAGE_EXTS.has(ext) ? "image" : "video";
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
            }
          }
        }

        return ctx.call({ cmd: "show_media", items: resolved }, 60000);
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
  const defs = buildPanelToolDefs();
  // The Anthropic SDK's tool() accepts (name, description, zodRawShape, cb). The
  // shared handler is transport-agnostic — bind it to this tab's ctx. Each def's
  // schema is a distinct zod shape, so the produced tool generics differ; widen
  // to the SDK's tool-list element type so the heterogeneous array type-checks.
  type SdkTool = ReturnType<typeof tool>;
  const tools = defs.map((d) =>
    tool(d.name, d.description, d.schema, (args: Record<string, unknown>) => d.handler(args, ctx)),
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
  for (const d of buildPanelToolDefs()) {
    server.registerTool(
      d.name,
      {
        description: d.description,
        // The MCP SDK accepts a zod raw shape as inputSchema (same shape the
        // Anthropic SDK tool() takes), so the shared schema drops straight in.
        inputSchema: d.schema,
      },
      (async (args: Record<string, unknown>) => {
        const res = await d.handler(args ?? {}, ctx);
        // ToolResult is already the MCP CallToolResult shape (content[] + isError).
        return res as never;
      }) as never,
    );
  }
}
