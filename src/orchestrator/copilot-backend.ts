// GitHub Copilot chat backend — Task 5b of the in-panel OAuth plan.
// EXPERIMENTAL, ISOLATED, ToS-risk (the user explicitly accepted this when
// asking for it): a failure anywhere in this module must surface only as a
// normal turn/prepare error on THIS backend — it can never affect
// Grok/Codex/Claude/other backends. See OAUTH_PROVIDERS.copilot
// (experimental: true, in oauth-flow.ts) and oauth-bridge.ts's
// allow_experimental gate, which is what makes a `~/.comfyui-mcp/copilot-
// auth.json` ghu_ token exist in the first place.
//
// REUSE vs COPILOT-SPECIFIC:
// Copilot's chat endpoint is OpenAI chat-completions compatible, so this
// backend is a THIN subclass of OllamaBackend's "openai" dialect — the same
// pattern as KimiBackend (kimi-backend.ts) and the generic api-key factory
// (services/openai-provider-registry + makeOpenAiKeyBackend), NOT the
// Grok/Codex Responses-API adapter (grok-backend.ts's GrokDirectBackend),
// because Copilot is a real /chat/completions endpoint, not /responses. The
// inherited chatStream/readOpenAiSse/run/runTurn/dispatch/buildModelTools all
// apply unchanged. The ONLY Copilot-specific parts, all isolated to this file:
//   1. the ghu_ → short-lived Copilot bearer exchange
//      (GET https://api.github.com/copilot_internal/v2/token)
//   2. the "editor identity" headers GitHub requires on BOTH the exchange and
//      every chat/completions call (Editor-Version / Editor-Plugin-Version /
//      User-Agent / Copilot-Integration-Id) — GitHub 403s the exchange
//      WITHOUT them even on a fully licensed Copilot account (this is the
//      documented `github-copilot-token-exchange-needs-editor-headers` gotcha)
//   3. the token source: ~/.comfyui-mcp/copilot-auth.json via
//      `resolveCopilotOAuth` (code-provider-auth.ts), mirroring
//      `resolveGrokOAuth` but WITHOUT refresh — ghu_ has no refresh_token; a
//      dead/revoked one can only be fixed by re-running Copilot sign-in.
//
// UNVERIFIED AGAINST THE LIVE api.githubcopilot.com CONTRACT (flagged per the
// task brief — Task 8 validates live with a real, licensed account):
//   - the exact exchange response shape ({token, expires_at, endpoints:{api}})
//   - the chat/completions and /models paths and their exact request/response
//     shapes
//   - whether the signed-in account is Copilot-licensed at all (a 403 from the
//     exchange is ambiguous between "no license" and "bad/stale editor
//     headers" — see the skill note above)
//   - the default model slug (Copilot's catalog changes over time; utility
//     models share a rate-limit bucket per the `copilot-utility-models-
//     shared-rate-limit` gotcha, so a busy account may 429 even with a
//     correct slug — this backend does not special-case that; it surfaces the
//     429 like any other HTTP error)
// Both base URLs AND the default model are overridable via env so a live
// mismatch is a config flip, not a code change.

import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { AgentEvent, BackendStartOptions, NeutralTurn } from "./agent-backend.js";
import { COPILOT_CAPABILITIES } from "./agent-backend.js";
import { OllamaBackend, type OllamaBackendDeps } from "./ollama-backend.js";
import {
  resolveCopilotOAuth,
  type CodeProviderAuthDeps,
  type CopilotOAuthCredentials,
} from "../services/code-provider-auth.js";
import { assertAllowedTokenHost, OAUTH_PROVIDERS, redactTokens } from "../services/oauth-flow.js";

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** GET endpoint that exchanges the long-lived `ghu_` token for a short-lived
 *  Copilot API bearer. Overridable — the exact host/path is UNVERIFIED
 *  offline (see the module doc above). */
export const COPILOT_TOKEN_EXCHANGE_URL =
  process.env.COMFYUI_MCP_COPILOT_TOKEN_URL?.trim() ||
  "https://api.github.com/copilot_internal/v2/token";

/** Base URL for Copilot's OpenAI-compatible chat/completions + /models.
 *  Overridable — a live exchange response's `endpoints.api` (when present)
 *  wins over this default for the REST of that token's lifetime (individual
 *  vs. business accounts may route to different hosts per the exchange
 *  response, per research). */
export const COPILOT_API_BASE =
  process.env.COMFYUI_MCP_COPILOT_API_BASE?.trim().replace(/\/+$/, "") ||
  "https://api.githubcopilot.com";

/** UNVERIFIED against the live Copilot model catalog (slugs change — see the
 *  module doc). Override with COMFYUI_MCP_COPILOT_MODEL, or rely on the
 *  inherited listModels() (a live GET /models probe) to surface the account's
 *  real, currently-provisioned slugs. */
export const COPILOT_DEFAULT_MODEL = process.env.COMFYUI_MCP_COPILOT_MODEL?.trim() || "gpt-4.1";

/**
 * GitHub's VS Code Copilot Chat "editor identity" — REQUIRED on both the
 * token exchange and every chat/completions call, or GitHub 403s even a fully
 * licensed account (see the `github-copilot-token-exchange-needs-editor-
 * headers` gotcha). Exact version numbers are not strictly validated by
 * GitHub — kept as a plausible, recognizable VS Code Copilot Chat identity
 * rather than an app-branded User-Agent (which IS rejected).
 */
const EDITOR_IDENTITY_HEADERS: Record<string, string> = {
  "Editor-Version": "vscode/1.95.0",
  "Editor-Plugin-Version": "copilot-chat/0.22.0",
  "User-Agent": "GitHubCopilotChat/0.22.0",
  "Copilot-Integration-Id": "vscode-chat",
};

// Uses the shared `redactTokens` from oauth-flow.ts (single source of truth —
// this file used to carry a local `redactCopilotTokens` copy; its extra
// ghp_/`token\s+` rules were folded into the exported superset, no coverage
// lost) to strip token-shaped material from provider error text before it
// can reach a thrown message or a log line. Never logs/throws the raw ghu_ or
// the exchanged short-lived bearer.

/** `github.com` / `githubcopilot.com` — the same allowlist the OAuth engine
 *  already enforces for Copilot's device-code flow (oauth-flow.ts), reused
 *  here for the token-exchange + chat/completions DATA calls. */
function copilotApiHostAllowlist(): string[] {
  return OAUTH_PROVIDERS.copilot?.apiHostAllowlist ?? ["github.com", "githubcopilot.com"];
}

/** Append a "re-run Copilot sign-in" hint to a 401/403 error message exactly
 *  once (idempotent — never double-appends if the message already carries a
 *  hint, e.g. from `exchangeCopilotToken` below). */
function withCopilotAuthHint(err: unknown): Error {
  const message = msgOf(err);
  if (/\b(401|403)\b/.test(message) && !/re-run copilot sign-in/i.test(message)) {
    return new Error(`${message} Re-run Copilot sign-in from the panel.`);
  }
  return err instanceof Error ? err : new Error(message);
}

interface CopilotTokenExchangeResult {
  token: string;
  expiresAtMs: number;
  apiBase: string;
}

/**
 * Step 1 of the two-step Copilot contract: exchange the long-lived `ghu_`
 * token for a short-lived Copilot API bearer. Host-allowlisted before any
 * network call; any error body is redacted before it can reach a thrown
 * message. A 401/403 here is the PRIMARY "you're not signed in / not
 * licensed" failure mode, so it gets the explicit re-sign-in hint.
 */
async function exchangeCopilotToken(
  ghuToken: string,
  fetchFn: typeof fetch,
): Promise<CopilotTokenExchangeResult> {
  assertAllowedTokenHost(COPILOT_TOKEN_EXCHANGE_URL, copilotApiHostAllowlist());
  const res = await fetchFn(COPILOT_TOKEN_EXCHANGE_URL, {
    method: "GET",
    headers: {
      Authorization: `token ${ghuToken}`,
      Accept: "application/json",
      ...EDITOR_IDENTITY_HEADERS,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? " Re-run Copilot sign-in from the panel (this also happens if the signed-in account has no active Copilot subscription)."
        : "";
    throw new ValidationError(
      `GitHub Copilot token exchange failed (${res.status}): ${redactTokens(text).slice(0, 300)}.${hint}`,
    );
  }
  let payload: { token?: string; expires_at?: number; endpoints?: { api?: string } };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new ValidationError("GitHub Copilot token exchange returned an unparseable response.");
  }
  const token = payload.token?.trim();
  if (!token) {
    throw new ValidationError("GitHub Copilot token exchange response is missing 'token'.");
  }
  const expiresAtMs =
    typeof payload.expires_at === "number" && Number.isFinite(payload.expires_at)
      ? payload.expires_at * 1000
      : Date.now() + 20 * 60_000; // conservative fallback if the field is absent/renamed
  // The exchange response's endpoints.api can route to a per-account host, but a
  // server-supplied host is UNTRUSTED — if it isn't allowlisted, DROP it and
  // fall back to the default base rather than dialing an off-allowlist host with
  // the live bearer. (The default base itself is re-checked in
  // ensureFreshCopilotToken before setOpenAiAuth, so a bad env override there is
  // rejected outright — see below.)
  const advertised = payload.endpoints?.api?.trim().replace(/\/+$/, "");
  let apiBase = COPILOT_API_BASE;
  if (advertised) {
    try {
      assertAllowedTokenHost(advertised, copilotApiHostAllowlist());
      apiBase = advertised;
    } catch {
      logger.warn(
        `[copilot-backend] token exchange advertised a non-allowlisted api host — ignoring it and using the default base.`,
      );
    }
  }
  return { token, expiresAtMs, apiBase };
}

/** Refresh 60s before the bearer's reported expiry — matches the skew used
 *  elsewhere in code-provider-auth.ts (TOKEN_REFRESH_SKEW_MS-style guard). */
const COPILOT_TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * GitHub Copilot chat — OpenAI-compatible chat/completions + the same 6-tool
 * router as Ollama/GLM/Kimi. See the module doc above for the full contract,
 * the reuse rationale, and the unverified-offline items.
 */
export class CopilotBackend extends OllamaBackend {
  readonly capabilities = COPILOT_CAPABILITIES;

  private ghuToken: string | null = null;
  private copilotBearer: string | null = null;
  private copilotBearerExpiresAtMs = 0;
  private resolveOAuth: (deps?: CodeProviderAuthDeps) => Promise<CopilotOAuthCredentials>;
  private fetchFn: typeof fetch;

  constructor(
    deps: Omit<OllamaBackendDeps, "api" | "host" | "apiKey" | "backendId"> & {
      /** Test seam: override how the ghu_ token is resolved (defaults to
       *  `resolveCopilotOAuth` from code-provider-auth.ts). */
      resolveCopilotOAuth?: (deps?: CodeProviderAuthDeps) => Promise<CopilotOAuthCredentials>;
      /** Test seam: override the fetch used for the token exchange (the chat
       *  calls themselves go through OllamaBackend's own fetch usage, which
       *  already honors a stubbed global fetch in tests). */
      fetch?: typeof fetch;
    } = {},
  ) {
    super({
      ...deps,
      backendId: "copilot",
      api: "openai",
      host: COPILOT_API_BASE, // placeholder until the first exchange resolves endpoints.api
      apiKey: "pending-oauth", // never dialed with this value — ensureFreshCopilotToken() runs first
      model: deps.model ?? COPILOT_DEFAULT_MODEL,
    });
    this.resolveOAuth = deps.resolveCopilotOAuth ?? resolveCopilotOAuth;
    this.fetchFn = deps.fetch ?? fetch;
  }

  /** Adds GitHub's required editor-identity headers on top of the inherited
   *  Bearer-token header — applies to every chat/completions and /models call
   *  (OllamaBackend's "openai" dialect reads authHeaders() for both). */
  protected override authHeaders(): Record<string, string> {
    const base = super.authHeaders();
    if (!base.authorization) return base;
    return { ...base, ...EDITOR_IDENTITY_HEADERS };
  }

  /**
   * Exchange (or reuse a cached, still-fresh) short-lived Copilot bearer.
   * Called from prepare() (session start) AND before EVERY turn (see run()
   * below) so a long-lived panel session survives the token's short,
   * GitHub-controlled lifetime. The short-lived bearer is held ONLY in this
   * instance's memory — never written to disk (only the ghu_ persists, in
   * copilot-auth.json, and this function never rewrites that file).
   */
  private async ensureFreshCopilotToken(): Promise<void> {
    const nowMs = Date.now();
    if (this.copilotBearer && nowMs < this.copilotBearerExpiresAtMs - COPILOT_TOKEN_REFRESH_SKEW_MS) {
      return;
    }
    if (!this.ghuToken) {
      const creds = await this.resolveOAuth();
      this.ghuToken = creds.ghuToken;
    }
    const { token, expiresAtMs, apiBase } = await exchangeCopilotToken(this.ghuToken, this.fetchFn);
    // FINAL GATE before the live bearer is ever attached to a host: apiBase is
    // either the allowlist-checked exchange endpoint or COPILOT_API_BASE (which
    // may be a COMFYUI_MCP_COPILOT_API_BASE env override). An off-allowlist
    // override must be REJECTED here — never silently dialed — so the inherited
    // ollama-backend prepare()/chatStream()/listModels() (which attach the
    // bearer to this.host) can only ever hit an allowlisted host.
    assertAllowedTokenHost(apiBase, copilotApiHostAllowlist());
    this.copilotBearer = token;
    this.copilotBearerExpiresAtMs = expiresAtMs;
    this.setOpenAiAuth(apiBase, token);
  }

  override async prepare(): Promise<void> {
    await this.ensureFreshCopilotToken();
    try {
      await super.prepare(); // GET {apiBase}/models reachability check + connectTools()
    } catch (err) {
      throw withCopilotAuthHint(err);
    }
    logger.info(`[copilot-backend] ready (experimental — see task-5b report for the unverified contract items)`);
  }

  /**
   * Wrap the incoming turn channel so the Copilot bearer is refreshed BEFORE
   * every turn, not just once at session start — a panel session can easily
   * outlive the short-lived exchange token. Best-effort: a refresh failure
   * mid-session is logged and the turn proceeds with whatever token is
   * cached; if that token is actually stale the ensuing chat/completions call
   * 401s and is surfaced through OllamaBackend's own turn-error path (a
   * normal `result:false` + assistant error — never an unhandled rejection
   * that could park the panel's turn-gate).
   */
  private async *wrapChannel(channel: AsyncIterable<NeutralTurn>): AsyncGenerator<NeutralTurn> {
    for await (const turn of channel) {
      try {
        await this.ensureFreshCopilotToken();
      } catch (err) {
        logger.warn(
          `[copilot-backend] token refresh before turn failed (${msgOf(err)}) — attempting the turn with the existing token.`,
        );
      }
      yield turn;
    }
  }

  override async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
    yield* super.run({ ...opts, channel: this.wrapChannel(opts.channel) });
  }
}
