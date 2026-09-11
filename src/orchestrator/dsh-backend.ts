import { randomUUID } from "node:crypto";
import { requireSharp } from "../services/sharp-loader.js";
import { isAbsolute } from "node:path";
import type {
  ContentBlock,
  McpServer,
  SessionConfigOption,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type {
  AgentBackend,
  AgentCapabilities,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
  NeutralTurn,
} from "./agent-backend.js";
import { discoverDsh, type DshInstallation } from "./dsh-discovery.js";
import { OfficialDshConnection } from "./dsh-transport.js";
import { turnErrorMessage } from "./dsh-errors.js";

const sessionOwners = new Map<string, DshBackend>();

export type DshMcpSpec =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { transport: "http"; url: string; headers?: Record<string, string> };

export function dshMcpServers(
  servers: Record<string, DshMcpSpec> = {},
): McpServer[] {
  return Object.entries(servers).map(([name, spec]) => {
    if (spec.transport === "stdio") {
      if (!isAbsolute(spec.command))
        throw new Error(`DSH MCP command must be absolute: ${name}`);
      return {
        name,
        command: spec.command,
        args: spec.args ?? [],
        env: Object.entries(spec.env ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
      };
    }
    const url = new URL(spec.url);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("Unsupported DSH MCP transport URL");
    if (name === "panel" && !url.searchParams.has("tool_mode"))
      url.searchParams.set("tool_mode", "compact");
    return {
      name,
      type: "http",
      url: url.href,
      headers: Object.entries(spec.headers ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
    };
  });
}

export interface DshBackendDeps {
  cwd?: string;
  comfyuiUrl?: string;
  mcpServers?: Record<string, DshMcpSpec>;
  systemAppend?: string;
  blind?: () => boolean;
  send?: (
    command: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  status?: (status: {
    sessionId: string;
    used: number;
    contextWindow: number;
    contextPct: number;
    source: "dsh-acp";
    model?: string;
  }) => void;
  models?: (models: ModelChoice[], current?: string) => void;
  installation?: DshInstallation;
  connect?: typeof OfficialDshConnection.open;
  catalogProbe?: boolean;
}

/** ComfyUI-owned adapter for the official `dsh --profile acp` process. */
export class DshBackend implements AgentBackend {
  readonly id = "dsh" as const;
  readonly capabilities: AgentCapabilities = {
    persistentChannel: true,
    streamingDeltas: true,
    interruptMidTurn: true,
    forkAtAnchor: false,
    inProcessMcp: false,
    modelEnumeration: true,
    slashCommands: false,
    hooks: false,
    vision: false,
    audio: false,
    turnMarkers: true,
  };
  private connection?: OfficialDshConnection;
  private preparing?: Promise<void>;
  private disposed = false;
  private sessionId?: string;
  private config: SessionConfigOption[] = [];
  private pendingModel?: string;
  private pendingEffort?: string;
  private transportModel?: string;
  private active = false;
  private inTurn = false;
  private selectionTail: Promise<void> = Promise.resolve();
  private metadata?: Promise<void>;
  private firstPrompt = false;
  private retired = false;
  private readonly lifetime = new AbortController();
  private installationHome?: string;
  private leaseKey?: string;
  constructor(private readonly deps: DshBackendDeps = {}) {}
  retire() {
    this.retired = true;
  }

  currentModel() {
    const c = this.config.find((c) => c.id === "model");
    return c?.type === "select" ? c.currentValue : undefined;
  }
  currentEffort() {
    const c = this.config.find((c) => c.id === "reasoning_effort");
    return c?.type === "select" ? c.currentValue : undefined;
  }
  private effortOptions(): string[] {
    const c = this.config.find((c) => c.id === "reasoning_effort");
    if (c?.type !== "select") return [];
    return c.options.flatMap((o) =>
      "options" in o ? o.options.map((v) => v.value) : [o.value],
    );
  }
  private modelsFromConfig(): ModelChoice[] {
    const c = this.config.find((c) => c.id === "model");
    if (c?.type !== "select") return [];
    const levels = this.effortOptions();
    return c.options
      .flatMap((group) =>
        "options" in group
          ? group.options.map((o) => ({
              id: o.value,
              label: `${group.name} · ${o.name}`,
            }))
          : [{ id: group.value, label: group.name }],
      )
      .map((m) => ({
        ...m,
        ...(m.id === c.currentValue
          ? { supportsEffort: levels.length > 0, supportedEffortLevels: levels }
          : {}),
      }));
  }
  private publishModels() {
    this.deps.models?.(this.modelsFromConfig(), this.currentModel());
  }

  async prepare(): Promise<void> {
    if (this.disposed) throw new Error("DSH backend is closed");
    return (this.preparing ??= (async () => {
      const installation = this.deps.installation ?? discoverDsh();
      if (!installation)
        throw new Error(
          "DSH CLI was not found on the ComfyUI MCP host. Install DSH or configure COMFYUI_MCP_DSH_BIN.",
        );
      const c = await (this.deps.connect ?? OfficialDshConnection.open)(
        installation,
        this.pendingModel,
        this.permission.bind(this),
        this.lifetime.signal,
        this.deps.catalogProbe === true,
      );
      if (this.disposed) {
        await c.close();
        throw new Error("DSH backend closed during startup");
      }
      this.connection = c;
      this.transportModel = this.pendingModel ?? installation.defaultModel;
      this.installationHome = installation.home;
      this.pendingEffort ??= installation.defaultEffort;
      this.capabilities.vision =
        c.info?.agentCapabilities?.promptCapabilities?.image === true;
    })().catch((error) => {
      this.preparing = undefined;
      throw error;
    }));
  }

  async listModels(): Promise<ModelChoice[]> {
    if (this.config.length) return this.modelsFromConfig();
    await (this.metadata ??= (async () => {
      await this.prepare();
      // ACP exposes configuration through a session, unlike Codex model/list.
      // This empty discovery session is reused by this adapter and never prompted.
      const result = await this.connection!.rpc.newSession({
        cwd: this.deps.cwd ?? process.cwd(),
        mcpServers: [],
      });
      this.sessionId = result.sessionId;
      this.config = result.configOptions ?? [];
      await this.connection!.rpc.closeSession({ sessionId: this.sessionId });
      this.sessionId = undefined;
    })().catch((error) => {
      this.metadata = undefined;
      throw error;
    }));
    return this.modelsFromConfig();
  }

  setModel(model: string): Promise<void> {
    this.pendingModel = model;
    return this.serializeSelection(async () => {
      if (!this.sessionId || !this.connection || this.inTurn) return;
      await this.reconnectForModel();
      this.publishModels();
    });
  }
  setEffort(effort: string): Promise<void> {
    this.pendingEffort = effort;
    return this.serializeSelection(async () => {
      if (!this.sessionId || !this.connection || this.inTurn) return;
      await this.applyEffort();
      this.publishModels();
    });
  }
  private serializeSelection(task: () => Promise<void>) {
    const next = this.selectionTail.then(task);
    // unknown-ok: only reset the serialization tail; the caller receives the original rejecting promise below.
    this.selectionTail = next.catch(() => {});
    return next;
  }
  private async applyEffort() {
    if (
      this.pendingEffort &&
      this.effortOptions().includes(this.pendingEffort)
    ) {
      const result = await this.connection!.rpc.setSessionConfigOption({
        sessionId: this.sessionId!,
        configId: "reasoning_effort",
        value: this.pendingEffort,
      });
      this.config = result.configOptions;
    }
  }
  private async reconnectForModel() {
    const selected = this.pendingModel ?? this.currentModel();
    if (!selected || selected === this.transportModel || this.inTurn) return;
    const sid = this.sessionId!;
    await this.connection!.rpc.closeSession({ sessionId: sid });
    await this.connection!.close();
    this.connection = undefined;
    this.preparing = undefined;
    this.pendingModel = selected;
    await this.prepare();
    const resumed = await this.connection!.rpc.resumeSession({
      sessionId: sid,
      cwd: this.deps.cwd ?? process.cwd(),
      mcpServers: dshMcpServers(this.deps.mcpServers),
    });
    this.config = resumed.configOptions ?? [];
    const result = await this.connection!.rpc.setSessionConfigOption({
      sessionId: sid,
      configId: "model",
      value: selected,
    });
    this.config = result.configOptions;
    await this.applyEffort();
  }

  async *run(options: BackendStartOptions): AsyncGenerator<AgentEvent> {
    if (this.active) throw new Error("DSH session is already running");
    if (options.rewindAnchor)
      throw new Error("Installed DSH ACP does not support rewind");
    const requestedResume = options.resume ?? options.sessionId ?? undefined;
    if (requestedResume && this.deps.blind?.())
      throw new Error(
        "Blind mode requires a fresh DSH session; existing history may contain images",
      );
    if (
      options.model &&
      !(
        requestedResume &&
        (options as BackendStartOptions & { modelExplicit?: boolean })
          .modelExplicit === false
      )
    )
      this.pendingModel = options.model;
    this.pendingEffort = options.effort ?? this.pendingEffort;
    if (options.cwd) this.deps.cwd = options.cwd;
    const cwd = this.deps.cwd ?? process.cwd();
    if (!isAbsolute(cwd)) throw new Error("DSH workspace must be absolute");
    this.active = true;
    try {
      await this.metadata;
      await this.prepare();
      // A catalog probe is not the user's conversation. Close it before opening
      // the requested identity, and never turn a failed resume into a new session.
      if (this.sessionId) {
        await this.connection!.rpc.closeSession({ sessionId: this.sessionId });
        this.sessionId = undefined;
      }
      const resume = options.resume ?? options.sessionId ?? undefined;
      if (resume) this.claimSession(resume);
      const params = { cwd, mcpServers: dshMcpServers(this.deps.mcpServers) };
      const response = resume
        ? await this.connection!.rpc.resumeSession({
            ...params,
            sessionId: resume,
          })
        : await this.connection!.rpc.newSession(params);
      this.sessionId =
        resume ??
        ("sessionId" in response ? (response.sessionId as string) : undefined);
      if (!this.sessionId) throw new Error("DSH returned no session identity");
      this.claimSession(this.sessionId);
      this.config = response.configOptions ?? [];
      this.firstPrompt = !resume;
      if (this.pendingModel) {
        const result = await this.connection!.rpc.setSessionConfigOption({
          sessionId: this.sessionId,
          configId: "model",
          value: this.pendingModel,
        });
        this.config = result.configOptions;
      }
      await this.reconnectForModel();
      await this.applyEffort();
      this.publishModels();
      yield {
        type: "session",
        sessionId: this.sessionId,
        model: this.currentModel(),
      };
      let sequence = 0;
      for await (const turn of options.channel) {
        await this.selectionTail;
        await this.reconnectForModel();
        await this.applyEffort();
        this.inTurn = true;
        const marker = ++sequence;
        try {
          for await (const event of this.runTurn(turn, options.onActivity))
            yield { ...event, turn: marker };
        } finally {
          this.inTurn = false;
        }
        if (this.connection!.rpc.signal.aborted) break;
      }
    } finally {
      this.active = false;
    }
  }

  private async *runTurn(
    turn: NeutralTurn,
    onActivity?: () => void,
  ): AsyncGenerator<AgentEvent> {
    const connection = this.connection!,
      sid = this.sessionId!;
    const events: AgentEvent[] = [];
    let wake: (() => void) | undefined,
      done = false,
      reply = "",
      started = false,
      id = "",
      hasThought = false;
    const calls = new Map<string, { name: string; started: number }>();
    let media = Promise.resolve();
    const push = (event: AgentEvent) => {
      events.push(event);
      wake?.();
      wake = undefined;
    };
    const start = () => {
      if (!started) {
        id = `dsh-${randomUUID()}`;
        started = true;
        push({ type: "stream_start", id });
      }
    };
    // A tool starts a new transcript segment. Reusing the first thought bubble's
    // id would fill that earlier bubble with a summary produced AFTER the tools.
    const finishSegment = (intermediate = false) => {
      if (!started) return;
      push({ type: "stream_end" });
      if (reply) {
        push({ type: "assistant", text: reply, id });
        if (intermediate) push({ type: "dsh_process", id });
      } else if (hasThought) push({ type: "dsh_thought_end", id });
      reply = "";
      started = false;
      id = "";
      hasThought = false;
    };
    connection.onUpdate = (notice: SessionNotification) => {
      if (notice.sessionId !== sid || done || this.retired || this.disposed)
        return;
      onActivity?.();
      const update = notice.update;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        start();
        reply += update.content.text;
        push({ type: "assistant_delta", text: update.content.text });
      } else if (
        update.sessionUpdate === "agent_thought_chunk" &&
        update.content.type === "text"
      ) {
        start();
        hasThought = true;
        push({
          type: "assistant_delta",
          text: update.content.text,
          thinking: true,
        });
      } else if (update.sessionUpdate === "config_option_update") {
        this.config = update.configOptions;
        this.publishModels();
      } else if (update.sessionUpdate === "usage_update") {
        if (
          Number.isFinite(update.used) &&
          update.used >= 0 &&
          Number.isFinite(update.size) &&
          update.size > 0
        ) {
          this.deps.status?.({
            sessionId: sid,
            used: update.used,
            contextWindow: update.size,
            contextPct: Math.min(1, update.used / update.size),
            source: "dsh-acp",
            model: this.currentModel(),
          });
        }
      } else if (update.sessionUpdate === "tool_call") {
        finishSegment(true);
        const name = update.title ?? update.toolCallId;
        calls.set(update.toolCallId, { name, started: Date.now() });
        push({
          type: "tool_call",
          name,
          phase: "start",
          callId: update.toolCallId,
          detail: update,
        });
      } else if (update.sessionUpdate === "tool_call_update") {
        if (update.status === "completed" || update.status === "failed") {
          const call = calls.get(update.toolCallId);
          push({
            type: "tool_call",
            name: call?.name ?? update.toolCallId,
            phase: "end",
            callId: update.toolCallId,
            elapsedMs: call ? Date.now() - call.started : undefined,
            ok: update.status === "completed",
            detail: update,
          });
          calls.delete(update.toolCallId);
        }
        for (const part of update.content ?? []) {
          if (
            part.type === "content" &&
            part.content.type === "image" &&
            this.deps.send
          ) {
            const image = part.content;
            media = media.then(async () => {
              if (!this.retired && !this.disposed)
                await this.deps.send!(
                  {
                    cmd: "show_media",
                    items: [
                      {
                        kind: "image",
                        dataUrl: `data:${image.mimeType};base64,${image.data}`,
                        caption: "DSH 工具输出",
                      },
                    ],
                  },
                  60000,
                );
            });
          }
        }
      }
    };
    const operation = (async () => {
      try {
        if (turn.audio?.length)
          throw new Error("DSH ACP does not support audio input");
        const text =
          this.firstPrompt && this.deps.systemAppend
            ? `${this.deps.systemAppend}\n\n${turn.text}`
            : turn.text;
        const prompt: ContentBlock[] = [{ type: "text", text }];
        if (turn.images?.length) {
          if (this.deps.blind?.())
            throw new Error("Blind mode prevents image delivery to DSH");
          if (!this.capabilities.vision)
            throw new Error(
              "The selected DSH route does not advertise image input",
            );
          for (const ref of turn.images) {
            if (!this.deps.comfyuiUrl)
              throw new Error("ComfyUI image endpoint is unavailable");
            const url = new URL("/view", this.deps.comfyuiUrl);
            url.searchParams.set("filename", ref.filename);
            url.searchParams.set("type", ref.type ?? "input");
            if (ref.subfolder) url.searchParams.set("subfolder", ref.subfolder);
            const response = await fetch(url, {
              signal: AbortSignal.timeout(60000),
            });
            if (!response.ok)
              throw new Error(
                `ComfyUI image read failed: HTTP ${response.status}`,
              );
            const bytes = Buffer.from(await response.arrayBuffer());
            const sharp = await requireSharp("DSH image input");
            const image = await sharp(bytes)
              .resize({
                width: 1024,
                height: 1024,
                fit: "inside",
                withoutEnlargement: true,
              })
              .jpeg({ quality: 82 })
              .toBuffer();
            prompt.push({
              type: "image",
              mimeType: "image/jpeg",
              data: image.toString("base64"),
            });
          }
        }
        if (Buffer.byteLength(JSON.stringify(prompt)) > 4 * 1024 * 1024)
          throw new Error(
            "DSH request exceeds the 4 MiB transport budget; reduce attached content",
          );
        this.firstPrompt = false;
        const result = await connection.rpc.prompt({ sessionId: sid, prompt });
        await media;
        finishSegment();
        push({
          type: "result",
          ok: result.stopReason === "end_turn",
          subtype: result.stopReason,
        });
      } catch (error) {
        finishSegment();
        push({
          type: "error",
          message: turnErrorMessage(error),
          outcomeUnknown: true,
        });
        push({ type: "result", ok: false, subtype: "error" });
      } finally {
        done = true;
        connection.onUpdate = undefined;
        wake?.();
      }
    })();
    while (!done || events.length) {
      if (events.length) yield events.shift()!;
      else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    await operation;
  }

  private async permission(
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (!this.deps.send || signal.aborted)
      return { outcome: { outcome: "cancelled" } };
    const choices = request.options.map((o, i) => ({
      label: `${i + 1}. ${o.name}`,
      description: o.kind,
    }));
    let abort: (() => void) | undefined;
    try {
      const answer = await Promise.race([
        this.deps.send(
          {
            cmd: "ask_user",
            ask_id: `dsh-${randomUUID()}`,
            header: "DSH 操作审批",
            question: request.toolCall.title ?? "DSH 请求执行操作",
            options: choices,
          },
          285000,
        ),
        new Promise<null>((resolve) => {
          abort = () => resolve(null);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
      const index = choices.findIndex((o) => o.label === answer);
      return !signal.aborted && index >= 0
        ? {
            outcome: {
              outcome: "selected",
              optionId: request.options[index].optionId,
            },
          }
        : { outcome: { outcome: "cancelled" } };
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
  async interrupt() {
    if (
      this.connection &&
      this.sessionId &&
      !this.connection.rpc.signal.aborted
    )
      await this.connection.rpc.cancel({ sessionId: this.sessionId });
  }
  private claimSession(sid: string) {
    const key = JSON.stringify([this.installationHome, sid]);
    const owner = sessionOwners.get(key);
    if (owner && owner !== this)
      throw new Error(
        "DSH session is already owned by another ComfyUI connection",
      );
    if (
      this.leaseKey &&
      this.leaseKey !== key &&
      sessionOwners.get(this.leaseKey) === this
    )
      sessionOwners.delete(this.leaseKey);
    sessionOwners.set(key, this);
    this.leaseKey = key;
  }
  async close() {
    this.disposed = true;
    this.lifetime.abort();
    await this.preparing?.catch(() => {});
    await this.connection?.close();
    if (this.leaseKey && sessionOwners.get(this.leaseKey) === this)
      sessionOwners.delete(this.leaseKey);
  }
}

export { DshBackend as DshPanelBackend };
export { discoverDsh } from "./dsh-discovery.js";
