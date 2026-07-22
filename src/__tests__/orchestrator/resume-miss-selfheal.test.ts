// #277 — PanelAgent self-heals a missing resume target. Current Codex reports a
// pruned/missing resume session as EITHER "No conversation found with session
// ID: <id>" OR "no rollout found for thread id <uuid>". Both must clear the dead
// resume target, start a FRESH session, and replay the queued message — instead
// of retrying the same dead resume until the give-up threshold self-exits the
// orchestrator.

import { describe, expect, it, beforeAll } from "vitest";
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

/** A backend that FAILS any run resuming a session (simulating a pruned rollout)
 *  and succeeds on a fresh (resume-less) session. */
class ResumeMissBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  runCount = 0;
  resumes: Array<string | undefined> = [];
  turnTexts: string[] = [];
  constructor(private readonly errorText: string) {}

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.runCount += 1;
    this.resumes.push(opts.resume);
    if (opts.resume) {
      // The resume target is gone — Codex surfaces this as a stream error.
      throw new Error(this.errorText);
    }
    yield { type: "session", sessionId: "fresh-sess" };
    for await (const turn of opts.channel) {
      this.turnTexts.push(turn.text);
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

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("resume-miss self-heal (#277)", () => {
  for (const errorText of [
    "No conversation found with session ID: dead-sess",
    "no rollout found for thread id 00000000-0000-4000-8000-000000000000",
  ]) {
    it(`clears the dead resume + replays the queued message: "${errorText.slice(0, 24)}…"`, async () => {
      const backend = new ResumeMissBackend(errorText);
      const manager = makeManager(backend);
      const tab = "tab-resume-miss";
      // Seed a resume target so the FIRST run resumes (and fails).
      manager.setResume(tab, "dead-sess");
      manager.send(tab, "hello");

      // The agent must recover: a SECOND run with NO resume that processes "hello".
      await waitFor(() => backend.turnTexts.includes("hello"));
      expect(backend.resumes[0]).toBe("dead-sess"); // first run tried the dead resume
      expect(backend.resumes[1]).toBeUndefined(); // recovery dropped it → fresh session
      // Did NOT spin to the give-up threshold (would be many runs).
      expect(backend.runCount).toBeLessThanOrEqual(3);
    });
  }
});
