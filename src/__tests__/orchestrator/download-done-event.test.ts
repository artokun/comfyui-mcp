// #547: a finished download must wake the agent, mirroring the render-finished
// path (manager.injectEvent kind:"executed"). This locks the manager+agent side
// of the wiring: injectEvent(kind:"download_done") enqueues a NON-urgent turn
// whose text names the settled downloads and points at download_model action:"status", and a
// coalesced batch of several files produces ONE turn (not N). liveKeys() exposes
// the single-live-agent fallback the orchestrator uses for un-stamped rows.

import { beforeAll, describe, expect, it } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

/** Records the text of every turn the agent runs, and auto-completes each. */
class TurnRecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-dl" };
    for await (const turn of opts.channel) {
      this.turns.push((turn as { text?: string }).text ?? "");
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeManager(backend: AgentBackend) {
  return new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => backend,
  } as never);
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("download-completion agent event (#547)", () => {
  it("injectEvent(download_done) wakes the agent with a turn naming the download and download_model action:\"status\"", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    const tab = "tab-dl";

    manager.send(tab, "hi");
    await waitFor(() => backend.turns.length >= 1);

    const delivered = manager.injectEvent(tab, {
      kind: "download_done",
      downloads: [{ name: "z_image_turbo_bf16.safetensors", status: "done" }],
    });
    expect(delivered).toBe(true);

    await waitFor(() => backend.turns.length >= 2);
    const evText = backend.turns[1];
    expect(evText).toContain("z_image_turbo_bf16.safetensors");
    expect(evText).toContain("finished");
    expect(evText).toContain('download_model action:"status"');
  });

  it("a coalesced batch (many files) produces ONE turn listing all of them", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    const tab = "tab-batch";

    manager.send(tab, "hi");
    await waitFor(() => backend.turns.length >= 1);

    manager.injectEvent(tab, {
      kind: "download_done",
      downloads: [
        { name: "a.safetensors", status: "done" },
        { name: "b.safetensors", status: "done" },
        { name: "c.safetensors", status: "error" },
      ],
    });

    await waitFor(() => backend.turns.length >= 2);
    // Only ONE new turn for the whole batch.
    await new Promise((r) => setTimeout(r, 60));
    expect(backend.turns.length).toBe(2);
    const evText = backend.turns[1];
    expect(evText).toContain("a.safetensors");
    expect(evText).toContain("b.safetensors");
    expect(evText).toContain("c.safetensors");
    expect(evText).toContain("FAILED");
  });

  it("liveKeys() reports the single live agent (the un-stamped-row fallback)", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    expect(manager.liveKeys()).toEqual([]);
    manager.send("only-tab", "hi");
    await waitFor(() => backend.turns.length >= 1);
    expect(manager.liveKeys()).toEqual(["only-tab"]);
  });

  it("injectEvent into a nonexistent agent is a no-op returning false", () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    const delivered = manager.injectEvent("ghost", {
      kind: "download_done",
      downloads: [{ name: "x", status: "done" }],
    });
    expect(delivered).toBe(false);
  });
});

// #1150 — the event told a user two downloads had FAILED while they were
// actively streaming at 20% and 13%.
//
// Two 404s were retried with corrected URLs and the same target filenames. The
// panel#489 supersession key is (id, target), and a corrected retry has a
// DIFFERENT id, so the eviction never fired and both filenames flushed as
// failures. The event text carried no id, URL, or error — only the name — so
// nothing distinguished the dead attempt from the live one.
//
// And "The bytes finished transferring" was unconditional, so a FAILED-only
// batch asserted that bytes moved. For a 404, zero did — and that sentence
// actively argued against the correct reading.
describe("a failed attempt superseded by a live retry (#1150)", () => {
  it("does NOT present a name that is currently downloading as a plain failure", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    manager.send("tab-retry", "hi");
    await waitFor(() => backend.turns.length >= 1);

    manager.injectEvent("tab-retry", {
      kind: "download_done",
      downloads: [
        { name: "MiniMax-H3.safetensors", status: "error", supersededByLive: true },
      ],
    });

    await waitFor(() => backend.turns.length >= 2);
    const t = backend.turns[1];
    expect(t).toContain("MiniMax-H3.safetensors");
    // The instruction that keeps an agent from reporting the false failure.
    expect(t).toMatch(/do NOT report these as failed/);
    expect(t).toMatch(/IN FLIGHT right now/);
    // It must not read as a settled failure.
    expect(t).not.toMatch(/FAILED: MiniMax-H3\.safetensors/);
  });

  it("claims NOTHING transferred when the whole batch failed", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    manager.send("tab-404", "hi");
    await waitFor(() => backend.turns.length >= 1);

    manager.injectEvent("tab-404", {
      kind: "download_done",
      downloads: [{ name: "gone.safetensors", status: "error" }],
    });

    await waitFor(() => backend.turns.length >= 2);
    const t = backend.turns[1];
    expect(t).toContain("FAILED: gone.safetensors");
    // The sentence that was false for a 404.
    expect(t).not.toMatch(/bytes finished transferring/);
    expect(t).toMatch(/NOTHING is claimed to have transferred/);
  });

  it("still claims the transfer for the entries that ACTUALLY completed", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    manager.send("tab-mixed", "hi");
    await waitFor(() => backend.turns.length >= 1);

    manager.injectEvent("tab-mixed", {
      kind: "download_done",
      downloads: [
        { name: "ok.safetensors", status: "done" },
        { name: "bad.safetensors", status: "error" },
      ],
    });

    await waitFor(() => backend.turns.length >= 2);
    const t = backend.turns[1];
    // Scoped to the completed ones — not withdrawn, and not over-claimed.
    expect(t).toMatch(/bytes finished transferring for the completed one/);
    expect(t).toContain("transfer completed: ok.safetensors");
    expect(t).toContain("FAILED: bad.safetensors");
  });

  it("separates a genuinely dead failure from a retried one in the same batch", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    manager.send("tab-both", "hi");
    await waitFor(() => backend.turns.length >= 1);

    manager.injectEvent("tab-both", {
      kind: "download_done",
      downloads: [
        { name: "dead.safetensors", status: "error" },
        { name: "retried.safetensors", status: "error", supersededByLive: true },
      ],
    });

    await waitFor(() => backend.turns.length >= 2);
    const t = backend.turns[1];
    // The FAILED list itself runs to the next "; " separator — the retried name
    // must not be inside it, however the rest of the sentence reads.
    const failedList = /FAILED: ([^;]*)/.exec(t)?.[1] ?? "";
    expect(failedList).toContain("dead.safetensors");
    expect(failedList).not.toContain("retried.safetensors");
    expect(t).toMatch(/EARLIER attempt failed for retried\.safetensors/);
  });
});

// #2057 — the tray said FAILED (and claimed nothing transferred) while
// download_model action:"status" still showed the SAME id as downloading with
// advancing bytes. #1150's supersededByLive hedge never fired: there was no
// live tray row of that name, because the tray row itself was the error.
describe("a failed tray row whose job record is still downloading (#2057)", () => {
  it("does NOT present the reported filename as FAILED, and does not claim NOTHING transferred", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    manager.send("tab-2057", "hi");
    await waitFor(() => backend.turns.length >= 1);

    manager.injectEvent("tab-2057", {
      kind: "download_done",
      downloads: [
        {
          name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
          status: "error",
          recordDisagrees: true,
        },
      ],
    });

    await waitFor(() => backend.turns.length >= 2);
    const t = backend.turns[1];
    expect(t).toContain("minimax_h3_fl2va_pruned_int8_convrot.safetensors");
    expect(t).toMatch(/do NOT report it as failed/);
    expect(t).toMatch(/still reports this transfer as downloading/);
    expect(t).toContain('download_model action:"status"');
    expect(t).not.toMatch(/FAILED: minimax_h3_fl2va_pruned_int8_convrot\.safetensors/);
    expect(t).not.toMatch(/NOTHING is claimed to have transferred/);
  });

  it("still names a genuinely dead failure FAILED in the same batch", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    manager.send("tab-2057-mix", "hi");
    await waitFor(() => backend.turns.length >= 1);

    manager.injectEvent("tab-2057-mix", {
      kind: "download_done",
      downloads: [
        { name: "gone.safetensors", status: "error" },
        { name: "live.safetensors", status: "error", recordDisagrees: true },
      ],
    });

    await waitFor(() => backend.turns.length >= 2);
    const t = backend.turns[1];
    const failedList = /FAILED: ([^;]*)/.exec(t)?.[1] ?? "";
    expect(failedList).toContain("gone.safetensors");
    expect(failedList).not.toContain("live.safetensors");
    expect(t).toMatch(/tray reported a failure for live\.safetensors/);
    expect(t).not.toMatch(/NOTHING is claimed to have transferred/);
  });
});
