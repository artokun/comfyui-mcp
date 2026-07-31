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
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { parse as parseYaml } from "yaml";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UiBridge } from "../services/ui-bridge.js";
import { dispatchOutcomeOf } from "../services/ui-bridge.js";
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

/** Treat these as an affirmative answer to the adult-content consent card. */
function isAffirmative(reply: unknown): boolean {
  if (typeof reply !== "string") return false;
  return /^(yes|allow|allowed|true|on|ok(ay)?|sure|agree|confirm|enable|i'?m? ?18|18\+?|adult)/i.test(
    reply.trim(),
  );
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
  isRetrySafeCmd,
  isTransientReconnectError,
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
]);

/** A command whose result is unchanged by being re-issued after a reconnect —
 *  so it is safe to transparently retry once when the transport dropped. */
function isRetrySafeCmd(cmd: Record<string, unknown>): boolean {
  const name = typeof cmd.cmd === "string" ? cmd.cmd : "";
  return RETRY_SAFE_CMDS.has(name);
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
async function openWorkflowWithVerify(path: string, ctx: PanelToolCtx): Promise<ToolResult> {
  const res = await ctx.call({ cmd: "workflow_open", path }, 15000);
  // Success, or a genuine acked error (missing file / real executor error) — the
  // caller must see it as-is. Only a slow-ack TIMEOUT warrants verification.
  if (!isAckTimeout(res)) return res;

  const timing = getOpenVerifyTiming();
  const verify = await waitForWorkflowActive(ctx, path, timing);
  if (verify.active) {
    return ok({
      opened: { path },
      recovered: true,
      note:
        `"${path}" is now the active workflow — the switch succeeded, but the tab was slow ` +
        `to acknowledge (backgrounded/frozen or already open), so the initial ack timed out. ` +
        `Confirmed active via workflow_list after ${(verify.waited_ms / 1000).toFixed(1)}s ` +
        `(${verify.attempts} probe${verify.attempts === 1 ? "" : "s"}). Do NOT retry.`,
    });
  }
  // The ack timed out AND the target never became active within the budget — this
  // is a REAL failure. Return the original bridge timeout error unchanged.
  return res;
}

/** An open-workflow record as reported by `workflow_list` (path/filename/key). */
interface OpenWorkflowRecord {
  path?: string;
  filename?: string;
  key?: string;
}

/**
 * Resolve a caller-supplied pin `path` (path / filename / key, any form) to the
 * AUTHORITATIVE open-workflow record from a fresh `workflow_list` — the single
 * source of truth for which tabs exist and their canonical `key` (#259). Returns:
 *  - the matched record when the workflow IS open (so the pin can be canonicalized
 *    to its stable key and bound to the exact frontend tab identity);
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
): Promise<OpenWorkflowRecord | null | typeof NOT_OPEN> {
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
  for (const wf of rawList) {
    if (activeMatchesTarget(wf, path)) return wf as OpenWorkflowRecord;
  }
  // The active object is authoritative too, in case it isn't mirrored in the array.
  if (activeMatchesTarget((parsed as { active?: unknown }).active, path)) {
    return (parsed as { active: OpenWorkflowRecord }).active;
  }
  return NOT_OPEN;
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
  let outcome: Outcome;
  try {
    const client = getClient();
    const encoded = encodeURIComponent(`workflows/${p.replace(/^[\\/]+/, "")}`);
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
  const localCandidates = [
    ...comfyWorkflowsDirs().map((dir) => resolve(dir, p)),
    resolve(process.cwd(), p), // orchestrator CWD as a last local resort
  ];
  const local = localCandidates.find((c) => existsSync(c) && statSync(c).isFile());
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
 * The execution context every tool handler receives. Both transports (Anthropic
 * SDK in-process, MCP-SDK over HTTP) build the SAME context bound to a tab, so a
 * handler is transport-agnostic — it only ever talks to the bridge via `call` /
 * `confirm` / `bridge` and never knows which server invoked it.
 */
export interface PanelToolCtx {
  /** Forward a command to the panel and wrap the reply as a tool result. */
  call: (cmd: Record<string, unknown>, timeoutMs?: number) => Promise<ToolResult>;
  /** Human-in-the-loop yes/no confirm card (false on decline/timeout/no-panel). */
  confirm: (question: string, header: string, timeoutMs?: number) => Promise<boolean>;
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
  const ensureReachable = (): void => {
    if (typeof bridge.canReach !== "function") return; // lightweight test ctx
    if (bridge.canReach(ctx.tabId)) return;
    if (workflowTargets?.get(ctx.tabId)?.mode === "pinned") return; // stay strict
    // Strict-single: never silently pick among multiple live tabs (would risk the
    // real bridge's last-active fallback routing to an unrelated workflow). When
    // the bridge can enumerate its tabs and there is more than one, do NOT rebind.
    if (typeof bridge.tabs === "function") {
      const live = bridge.tabs();
      if (Array.isArray(live) && live.length > 1) return;
    }
    try {
      rebindToActiveTab();
    } catch {
      // Ambiguous (2+ tabs) or nothing connected — leave tabId as-is and let the
      // command surface the bridge's own clear, tab-listing error.
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
    timeoutMs = 300000,
  ): Promise<boolean> => {
    try {
      ensureReachable();
      const reply = await bridge.send(
        {
          cmd: "ask_user",
          question,
          header,
          options: [
            { label: "Yes, go ahead", description: "" },
            { label: "No, cancel", description: "" },
          ],
        } as { cmd: string },
        { tabId: ctx.tabId, timeoutMs: Math.max(1, timeoutMs) },
      );
      return isAffirmative(reply);
    } catch {
      return false;
    }
  };

  // EXPLICIT self-heal — see PanelToolCtx.rebindToActiveTab. Only rebinds when
  // the current tabId is genuinely orphaned (no live tab reachable); a healthy
  // session is left untouched so this never hijacks routing on a multi-tab
  // deployment. Throws (clear message, via resolveActiveTabId) when a single
  // active tab can't be picked.
  const rebindToActiveTab = (): { previous: string; current: string; rebound: boolean } => {
    const previous = ctx.tabId;
    if (bridge.canReach(previous)) return { previous, current: previous, rebound: false };
    const current = bridge.resolveActiveTabId(); // throws if no single active tab
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
    // #384: a panel too old to register graph_serialize (added at 0.11.4) still
    // answers the back-compat `graph_get_state`. On an "Unknown command" rejection
    // ONLY (a genuine transport/timeout error must surface as-is), fall back to it
    // and reconstruct the graph so "strip the live canvas" works without a
    // save-to-disk round trip.
    const msg = err instanceof Error ? err.message : String(err);
    if (allowStateFallback && /unknown command/i.test(msg)) {
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
 *  timeout warrants polling the late-reply buffer for a slow-but-valid answer. */
function isReplyTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /did not reply to .* within \d+\s*ms|backgrounded or frozen/i.test(msg);
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
      "QUERY the workflow the user is CURRENTLY VIEWING — filter, traverse, project, and aggregate over the live canvas WITHOUT dumping the whole graph (replaces the old panel_get_graph full-JSON dump; output is TOKEN-BOUNDED with an explicit truncation marker, so a big graph can never flood your context). Combine: `types` (node type contains any), `title` (contains), `where` widget predicates ANDed ('cfg>7', 'steps<=20', 'sampler_name=euler', 'text~sunset' — ops = != >= <= > < ~contains), `ids` (exact nodes — THE way to read ONE node's exact slot/widget detail: {ids:[42], fields:'detail'}), `upstream_of`/`downstream_of` + `depth` (dependency traversal: upstream = what FEEDS that node, downstream = what CONSUMES it; seed at depth 0), `fields` ('compact' one line per node [default], 'ids', 'detail' = the full node summary with slots + connections + mode), `group_by:'type'` (counts only), `limit` (default 40). detail rows include each node's MODE — a 'bypass' node is skipped and a 'mute' node kills everything downstream, so check modes on the path you care about before running (fix with panel_set_node_mode). Every result also carries `groups` (id, title, member node_ids — groups are geometric, trust this list) and, when viewing a SUBGRAPH (after panel_enter_subgraph), `rails` (boundary rail ids/slots). Typical flow: panel_graph_outline to orient → panel_query_graph to pinpoint/inspect → edit. Read-only.",
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
      "Read a COMPACT, dependency-ordered TEXT MAP of the workflow the user is viewing — the FASTEST way to UNDERSTAND a graph (especially a big loaded pack/template) before you touch it. Returns one `outline` string built for you to read top→down: nodes are topologically sorted (sources first, sinks last), each shown on its own block as `id Type \"title\" [bypass/mute] [OUTPUT] · group:X  widget=value …` with `← inputs` (as source_node.output_name) and `→ outputs` (as target_node.input_name), preceded by a GROUPS index (title → member node ids). It shows the WIRING you'd otherwise have to reconstruct. Use this FIRST to get oriented; then panel_query_graph to filter/traverse/inspect (e.g. {ids:[42], fields:'detail'} for one node's exact slot/widget detail), or panel_find_nodes for free-text search. Read-only.",
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
        ctx.call({ cmd: "graph_add_node", class_type: args.class_type, pos: args.pos, title: args.title }),
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
        if (
          !(await ctx.confirm(
            "Clear the canvas? This removes every node from the open workflow. (One Ctrl+Z undoes it.)",
            "Clear canvas",
          ))
        ) {
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
      "Set a widget value on a node in the user's open graph (steps, cfg, seed, ckpt_name, text prompts, …). Returns the previous and new value. Undoable with Ctrl+Z. To CLEAR a text widget to an empty string, pass `clear: true` (some MCP clients drop an empty-string `value` from the serialized payload, so `value: \"\"` may not arrive — `clear: true` always works).",
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
        return ctx.call({ cmd: "graph_set_widget", node_id: args.node_id, widget: args.widget, value });
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
      "Queue the workflow the user has OPEN — exactly like them pressing Queue Prompt (current widget values, the live graph they can see). On success it confirms the run was queued; if ComfyUI REFUSES the prompt (validation failure on either channel — per-node node_errors OR a top-level error like a missing node type) it returns a FAILURE with that rejection detail, never a false 'queued'. Pass to_node_id to RUN ONLY ONE BRANCH ('run to node'): ComfyUI renders just that output node plus everything upstream of it and SKIPS every other output branch — handy for previewing or debugging part of a big graph without rendering the whole thing. to_node_id MUST be an OUTPUT node (SaveImage, PreviewImage, SaveVideo, …) — pick the one at the END of the branch you want; nodes are tagged is_output:true in panel_query_graph's detail rows. Omit it to run the whole graph. Use this so the render runs on THEIR canvas and they see the result.",
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
            "Output node id to render UP TO (partial execution). Omit to run the whole graph. Must be an OUTPUT node — one with is_output:true in panel_query_graph's detail rows.",
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
        // Append anti-poll guidance: the agent should go idle after queuing so the
        // executed event auto-injects the output image, rather than busy-polling.
        const note =
          "\n\n[IMPORTANT] You will be notified automatically with the output image(s)/video when the render finishes — do NOT poll get_queue, get_history, or list_output_images. Just end your turn now and wait for the result to be delivered to you.";
        let warn = "";
        if (pre.connected && pre.running) {
          const morePending = pre.queueDepth > 1 ? ` plus ${pre.queueDepth - 1} already pending` : "";
          warn =
            `\n\n[QUEUE WARNING] A render is ALREADY RUNNING${pre.runningPromptId ? ` (prompt ${pre.runningPromptId})` : ""}${morePending} — ` +
            `this new run is QUEUED BEHIND it and will not start until that finishes. If the running one looks stuck, do NOT keep queuing: ` +
            `call cancel_job with clear_pending:true (it interrupts the running job AND drops pending), then escalate to restart_comfyui if it reports the job wedged.`;
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
          if (orphaned && Array.isArray(live) && live.length > 1) {
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
          const reply = await ctx.bridge.send(
            {
              cmd: "ask_user",
              question,
              header: "18+ consent",
              options: [
                { label: "Yes — I'm 18+ and it's legal in my region", description: "Enable adult content for this session" },
                { label: "No — keep it SFW", description: "Stay in safe-for-work mode" },
              ],
            },
            { tabId: ctx.tabId, timeoutMs: 300000 },
          );
          const allowed = isAffirmative(reply);
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
      "READ the CivitAI browser's CURRENT results as text (metadata + media URLs only — you will NOT be shown the images; you reason from the text and pick which URLs matter). This is the READ step of the show-don't-tell flow: rather than answering a 'good X model/LoRA?' question purely in a text table, open the docked browser, read the real results here, then panel_civitai_highlight your picks so the user SEES the cards. Open the browser first with panel_open_civitai. Returns { items, total, loading }. Each item carries EXACTLY these fields and nothing else — a MEDIA item is { id, kind:'image'|'video', title:null, creator, baseModel, type, stats:{ reactions }, prompt (length-capped ~600 chars), urls:[] }; a MODEL item is { id, kind:'model', title (the model's name), creator, baseModel, type, stats:{ downloadCount, thumbsUp }, prompt:null, urls:[] }. Note: stats is a NESTED object (reactions for media; downloadCount+thumbsUp for models), urls is an ARRAY of media URL(s), and media items have title:null while models have prompt:null. Model descriptions are NOT included (they require a separate detail fetch) — do not expect them. Use this to see what's on screen before you highlight, switch tabs, or open the lightbox. `loading:true` means a fetch is still in flight and the panel is reporting what it has so far. The browser must be open — otherwise the panel replies with an honest error.\n\nDISAMBIGUATING AN EMPTY GRID: a `total:0` result is NOT automatically 'no matches'. Newer panels attach status fields you MUST check before concluding anything from an empty set: `error` (e.g. { status:503, message:'CivitAI API 503: Service Unavailable' } — an UPSTREAM failure, retry rather than narrowing filters), and on the favorites tab a `favoritesStatus` (e.g. 'ok' | 'signed_out' | 'no_likes_collection' | 'filtered_out') plus `authenticated`. If `error` is present the grid is empty because the request FAILED, not because nothing matched; if `favoritesStatus` is 'signed_out'/'no_likes_collection' the favorites couldn't be located at all. Only treat total:0 as a true empty result when `error` is null and (off the favorites tab, or favoritesStatus is 'ok').",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results to serialize (1–50, default 20). The grid is ordered as shown to the user."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "civitai_results", limit: args.limit }, 10000),
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
      "Save the user's open workflow PROGRAMMATICALLY — no Save/Rename dialog ever pops. A never-saved workflow is auto-named and persisted; pass `name` to give it (or rename it to) a specific name. Use this freely (e.g. after building a graph) — it won't interrupt the user.",
      { name: z.string().optional().describe("Name to save/rename to (no .json needed). Omit to save in place / auto-name an unsaved workflow.") },
      async (args: A, ctx) =>
        args.name
          ? ctx.call({ cmd: "workflow_save_as", name: args.name }, 15000)
          : ctx.call({ cmd: "workflow_save" }, 15000),
    ),
    def(
      "panel_list_workflows",
      "List the user's OPEN workflow tabs and which one is active (path, filename, modified, persisted). Use this to know what's open before switching/renaming/closing. Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "workflow_list" }),
    ),
    def(
      "panel_get_workflow_target",
      "Read which workflow this agent is bound to edit. mode 'current' means graph tools follow whatever tab the user is viewing; mode 'pinned' means edits go to the pinned workflow even if the user switched to another tab. Call this when unsure which workflow your panel_* edits will affect.",
      {},
      async (_args, ctx) => {
        const target = ctx.workflowTarget?.get(ctx.tabId) ?? { mode: "current" as const };
        return ok(target);
      },
    ),
    def(
      "panel_set_workflow_target",
      "Pin the agent to a specific open workflow tab, or release the pin to follow the user's current tab. Use pinned when the user asks you to work on workflow A while they browse workflow B — set mode:'pinned' and path from panel_list_workflows. Set mode:'current' (or omit path) to follow the active tab again. Does NOT switch what the user sees; it only routes your panel_* graph edits. mode:'current' is ALSO the explicit RECOVERY signal: if your panel_* calls started failing with `no connected tab` after ComfyUI reconnected, the panel reloaded, or the user switched to a different workflow FILE, call this with mode:'current' to rebind this session onto the tab that's live now.",
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
        if (mode === "current" && ctx.rebindToActiveTab) {
          try {
            const { previous, current, rebound } = ctx.rebindToActiveTab();
            if (rebound) {
              rebindNote = ` Rebound this session from tab ${previous.slice(0, 8)} onto the active tab ${current.slice(0, 8)}.`;
            }
          } catch (err) {
            return fail(err);
          }
        }
        // PIN: bind to the EXACT open-workflow identity from the authoritative
        // workflow_list, canonicalizing to its stable `key` and FAILING CLOSED when
        // the requested workflow isn't actually open — instead of letting the panel
        // silently route the pin to another tab (#259). Indeterminate lists (older
        // panel / no `workflows` array) fall back to the raw path (unchanged).
        let pinPath = path;
        let pinFilename = filename;
        if (mode === "pinned" && path) {
          const resolved = await resolveOpenWorkflow(ctx, path);
          if (resolved === NOT_OPEN) {
            return fail(
              `Cannot pin to "${path}" — it is not open in ComfyUI. Open it first ` +
                `(panel_open_workflow) or pick an open workflow from panel_list_workflows, ` +
                `then pin. (Refusing to pin to a workflow that isn't open so graph edits ` +
                `never land on the wrong tab.)`,
            );
          }
          if (resolved) {
            // Canonicalize to the stable key so routing survives rename/reconnect.
            pinPath = resolved.key ?? resolved.path ?? path;
            pinFilename = filename ?? resolved.filename ?? resolved.path;
          }
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
        return ok({ ...target, note: hint + rebindNote });
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
      "Open / switch to a workflow by path or filename (from panel_list_workflows). Switches the active tab to it.",
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
        "CRITICAL — modes silently change what a render produces, so they are a top cause of 'wrong output'. A BYPASSED node contributes nothing of its own and a MUTED node kills its branch. Use this tool to ENABLE the path you actually want and DISABLE the one you don't — e.g. to drive a workflow from its Ideogram/JSON prompt builder you must set the manual-prompt node to 'bypass' and the JSON-builder path to 'active' (or vice-versa); likewise to pick one branch of an rgthree 'Fast Groups Bypasser'/Muter or a prompt-source switch. ALWAYS read modes first (panel_graph_outline marks [bypass]/[mute]; panel_query_graph detail rows carry mode): if the intended path is bypassed/muted, fix it HERE before running, and never assume a switch/route is already active. Undoable with Ctrl+Z.",
      {
        node_id: z.number().int().describe("Node id from panel_graph_outline / panel_query_graph."),
        mode: z
          .enum(["active", "bypass", "mute"])
          .describe(
            "'active' = runs normally; 'bypass' = skipped, passes input through (downstream still runs); 'mute' = node and everything downstream do not execute.",
          ),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_set_node_mode", node_id: args.node_id, mode: args.mode }),
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
          return { content: [{ type: "image", data: res.image, mimeType: res.mimeType ?? "image/png" }] };
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
        // Whole-handler budget (coordinator): confirm + dispatch + readiness — INCLUDING
        // the legacy path's UNPREEMPTIBLE synchronous execSync blocks — must ALL finish
        // under the outer ~300s tools/call limit. 255s + the legacy admission rule below
        // (kill+relaunch starts only with >=130s left, its ~40s of sync work FRONT-LOADED)
        // means the handler PROVABLY returns well under 300s.
        const OVERALL_MAX_MS = 255_000;
        const overallDeadline = Date.now() + OVERALL_MAX_MS;
        if (
          !(await ctx.confirm(
            "Restart ComfyUI now? It (and this agent) will go down briefly, then reconnect and resume automatically.",
            "Restart ComfyUI",
            Math.max(1, overallDeadline - Date.now()),
          ))
        ) {
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
        return ok({
          rebooting: true,
          ready: true,
          confirmed_cycle: true, // we directly observed the down→up cycle on the boot endpoint
          recovered_ms: recovery.waited_ms,
          probes: recovery.attempts,
          saw_down: recovery.sawDown,
          via: recovery.via,
          note:
            `ComfyUI restart accepted and it is healthy again in ${(recovery.waited_ms / 1000).toFixed(1)}s` +
            " (observed it go down then come back)" +
            (dropped ? "; connection dropped as expected while it went down" : "") +
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
  return createSdkMcpServer({
    name: "comfyui-panel",
    version: "1.0.0",
    tools,
  });
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
