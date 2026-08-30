import { logger } from "../utils/logger.js";
import type { AgentEvent, BackendStartOptions, NeutralTurn } from "./agent-backend.js";
import { KIMI_CAPABILITIES } from "./agent-backend.js";
import { OllamaBackend, type OllamaBackendDeps } from "./ollama-backend.js";
import {
  KIMI_CODE_DEFAULT_BASE,
  resolveKimiCodeOAuth,
} from "../services/code-provider-auth.js";

export const KIMI_DEFAULT_MODEL =
  process.env.COMFYUI_MCP_KIMI_MODEL?.trim() || "kimi-for-coding";

/** Kimi Code subscription OAuth (or KIMI_API_KEY) — OpenAI-compatible coding API. */
export class KimiBackend extends OllamaBackend {
  readonly capabilities = KIMI_CAPABILITIES;

  constructor(deps: Omit<OllamaBackendDeps, "api" | "host" | "apiKey" | "backendId"> = {}) {
    const apiKey = process.env.KIMI_API_KEY?.trim() || "pending-oauth";
    super({
      ...deps,
      backendId: "kimi",
      api: "openai",
      host:
        process.env.COMFYUI_MCP_KIMI_BASE_URL?.trim().replace(/\/$/, "") ||
        KIMI_CODE_DEFAULT_BASE,
      apiKey,
      model: deps.model ?? KIMI_DEFAULT_MODEL,
    });
  }

  /**
   * K3 refuses the inherited `temperature: 0` outright —
   * `400 invalid temperature: only 1 is allowed for this model` — which made
   * this backend unusable on every turn (#2535).
   *
   * Sends NO temperature rather than pinning 1: the field is only refused by
   * some models on this host (`kimi-for-coding` accepts a value), so letting the
   * endpoint apply its own per-model default is the one choice that is correct
   * for all of them. An explicit COMFYUI_MCP_OLLAMA_TEMPERATURE still overrides.
   */
  protected override defaultTemperature(): number | undefined {
    return undefined;
  }

  /**
   * Re-resolve the OAuth token, at session start AND before every turn (#2546).
   *
   * Kimi Code access tokens carry `expires_in: 900` — fifteen minutes. Resolving
   * once in prepare() meant any session that idled longer than that 401'd on
   * every subsequent turn until the user hit Disconnect → Connect, while the
   * CLI's credential file on disk held a perfectly good token.
   *
   * Cheap to call per turn: resolveKimiCodeOAuth re-READS the credential file
   * each time and only reaches the network inside the refresh skew. Re-reading
   * is also what makes this correct rather than merely fresh — the Kimi Code CLI
   * rotates that same file on its own schedule, so any in-memory cache here
   * would go stale behind our back. Mirrors CopilotBackend's
   * ensureFreshCopilotToken, which exists for the same short-bearer reason.
   */
  private async ensureFreshKimiAuth(): Promise<void> {
    const creds = await resolveKimiCodeOAuth();
    this.setOpenAiAuth(creds.baseUrl, creds.accessToken);
  }

  override async prepare(): Promise<void> {
    await this.ensureFreshKimiAuth();
    return super.prepare();
  }

  /**
   * Best-effort, exactly as CopilotBackend's wrapper is: a refresh failure is
   * logged and the turn proceeds on the existing token. If that token really is
   * stale the call 401s and surfaces through OllamaBackend's normal turn-error
   * path — a `result:false` the user sees — rather than an unhandled rejection
   * that could park the panel's turn gate.
   */
  private async *wrapChannel(channel: AsyncIterable<NeutralTurn>): AsyncGenerator<NeutralTurn> {
    for await (const turn of channel) {
      try {
        await this.ensureFreshKimiAuth();
      } catch (err) {
        logger.warn(
          `[kimi-backend] token refresh before turn failed (${err instanceof Error ? err.message : String(err)}) — attempting the turn with the existing token.`,
        );
      }
      yield turn;
    }
  }

  override async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
    yield* super.run({ ...opts, channel: this.wrapChannel(opts.channel) });
  }
}