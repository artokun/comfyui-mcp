// set_options ack correlation (`cid` echo + `requested_model`) and the
// per-tab model override surfaced as the models frame's `current`.
//
// BUG CONTEXT: each set_options is handled in a detached async task, so acks
// can arrive out of order AND carried no request identity — a client with more
// than one attempt outstanding (a timed-out pick + a retry) could not tell
// which ack answered which request (found by the mobile client, PR
// comfyui-mcp-mobile#1). Clients now stamp requests with an opaque `cid`,
// echoed verbatim, plus `requested_model` (pre-guard). The field is `cid`, NOT
// `rid`: the ui-bridge consumes any inbound `rid` as a canvas-command reply
// before it reaches the orchestrator handler (verified live — a rid-stamped
// set_options is silently dropped). Backward compatible: cid-less requests
// produce the pre-existing ack shape, and the failure path only ADDS an
// ok:false ack for cid-stamped requests (old panels keep seeing just the
// `say`).

import { describe, expect, it, beforeAll } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import {
  optionsAckFrame,
  optionsErrorAckFrame,
  optionsRequestMeta,
} from "../../orchestrator/options-ack.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

class NoopBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-noop" };
    for await (const turn of opts.channel) {
      void turn;
      yield { type: "result", ok: true, subtype: "success" };
    }
  }
  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeManager() {
  return new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-default",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => new NoopBackend(),
  } as never);
}

describe("optionsRequestMeta", () => {
  it("lifts cid + requested model off the raw event", () => {
    expect(optionsRequestMeta({ cid: "opt-0-1", model: "sonnet" })).toEqual({
      cid: "opt-0-1",
      requestedModel: "sonnet",
    });
  });

  it("omits absent/non-string fields (legacy panels send neither)", () => {
    expect(optionsRequestMeta({})).toEqual({});
    expect(optionsRequestMeta({ cid: 42, model: null })).toEqual({});
    expect(optionsRequestMeta({ cid: "", model: "" })).toEqual({});
  });
});

describe("optionsAckFrame", () => {
  const applied = { model: "sonnet", effort: null, restarted: false, deferred: false };

  it("echoes cid verbatim and reports the PRE-guard requested model", () => {
    const frame = optionsAckFrame(applied, {
      cid: "mobile-7",
      requestedModel: "not-a-real-model",
    });
    expect(frame).toMatchObject({
      type: "ack",
      ok: true,
      kind: "options",
      model: "sonnet",
      cid: "mobile-7",
      requested_model: "not-a-real-model",
    });
  });

  it("without cid the ack keeps the exact legacy shape (no new keys)", () => {
    const frame = optionsAckFrame(applied, {});
    expect(frame).toEqual({
      type: "ack",
      ok: true,
      kind: "options",
      model: "sonnet",
      effort: null,
      restarted: false,
      deferred: false,
    });
    expect("cid" in frame).toBe(false);
    expect("requested_model" in frame).toBe(false);
  });

  it("effort-only requests (no model field) omit requested_model", () => {
    const frame = optionsAckFrame(applied, { cid: "opt-0-2" });
    expect(frame).toMatchObject({ cid: "opt-0-2" });
    expect("requested_model" in frame).toBe(false);
  });
});

describe("optionsErrorAckFrame", () => {
  it("is suppressed for cid-less (legacy) requests — say-only contract kept", () => {
    expect(optionsErrorAckFrame("boom", {})).toBeNull();
    expect(optionsErrorAckFrame("boom", { requestedModel: "sonnet" })).toBeNull();
  });

  it("cid-stamped requests get an ok:false options ack with the cid echoed", () => {
    expect(
      optionsErrorAckFrame("boom", { cid: "opt-0-9", requestedModel: "sonnet" }),
    ).toEqual({
      type: "ack",
      ok: false,
      kind: "options",
      message: "boom",
      cid: "opt-0-9",
      requested_model: "sonnet",
    });
  });
});

describe("PanelAgentManager.modelOverrideFor (models frame `current`)", () => {
  it("returns the picker override for the key, undefined otherwise", async () => {
    const manager = makeManager();
    expect(manager.modelOverrideFor("tab-a::claude")).toBeUndefined();

    const applied = await manager.setOptions("tab-a::claude", { model: "sonnet" });
    expect(applied.model).toBe("sonnet");
    expect(manager.modelOverrideFor("tab-a::claude")).toBe("sonnet");
    // Scoped to the composite key — no bleed into another tab/backend.
    expect(manager.modelOverrideFor("tab-b::claude")).toBeUndefined();
    expect(manager.modelOverrideFor("tab-a::codex")).toBeUndefined();
  });

  it("reset() KEEPS the override — a New chat is not a provider switch (#2759)", async () => {
    // This assertion was the other way round, under the title "new chat / provider
    // switch semantics", and that conflation is the whole bug: the two cases were
    // pinned as one and only the provider half was true. reset()'s only callers are
    // `new_session` and `resume_session`, and neither changes provider. Dropping the
    // pick there spawned the global default while the picker still showed the user's
    // choice, so a subscription user burned Opus limits believing they were on Sonnet.
    //
    // Provider isolation is unaffected and is not this line's to defend — the test
    // above proves it comes from the composite key, whose last segment is the backend.
    const manager = makeManager();
    await manager.setOptions("tab-r::claude", { model: "sonnet" });
    expect(manager.modelOverrideFor("tab-r::claude")).toBe("sonnet");

    manager.reset("tab-r::claude");
    expect(manager.modelOverrideFor("tab-r::claude")).toBe("sonnet");
  });

  it("rebindAgent (live agent) carries the override to the migrated key", async () => {
    const manager = makeManager();
    // rebindAgent only migrates when a LIVE agent exists under the old key.
    manager.send("tab-old::claude", "spawn");
    await new Promise((r) => setTimeout(r, 50));
    await manager.setOptions("tab-old::claude", { model: "sonnet" });

    expect(manager.rebindAgent("tab-old::claude", "tab-new::claude")).toBe(true);
    expect(manager.modelOverrideFor("tab-old::claude")).toBeUndefined();
    expect(manager.modelOverrideFor("tab-new::claude")).toBe("sonnet");
  });
});
