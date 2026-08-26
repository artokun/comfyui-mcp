import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  completionFenceIdentity,
  RunCompletionIdempotencyFence,
  scheduleRunCompletion,
} from "../../orchestrator/run-completion-idempotency.js";
import {
  RunCompletionJournalImpl,
  type CompletionPayload,
} from "../../orchestrator/run-completion-journal.js";

const tempDirs: string[] = [];

function fencePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmcp-2341-"));
  tempDirs.push(dir);
  return join(dir, "run-completion-fence.json");
}

function stablePayload(promptId = "prompt-a", completionKey = `completion/${promptId}`) {
  return { kind: "executed", prompt_id: promptId, completion_key: completionKey };
}

/** The real production ordering: deliverPending → scheduler → queue acceptance,
 * then a later onEventDelivered/onEventUndelivered callback settles the fence. */
function productionHarness(path = fencePath()) {
  const journal = new RunCompletionJournalImpl();
  const fence = new RunCompletionIdempotencyFence({ path, now: () => 100_000 });
  const accepted = new Map<string, string>();
  const injected: CompletionPayload[] = [];
  const suppressed: string[] = [];
  let accepts = true;

  const deliver = () =>
    journal.deliverPending("route/session", (payload, token) =>
      scheduleRunCompletion({
        route: "route/session",
        payload,
        token,
        fence,
        inject: () => {
          injected.push(payload);
          return accepts;
        },
        onAccepted: (identity) => accepted.set(token, identity),
        suppress: (duplicateToken) => {
          suppressed.push(duplicateToken);
          journal.suppress(duplicateToken);
        },
      }),
    );

  const ack = (token: string) => {
    const identity = accepted.get(token);
    if (identity) fence.markDelivered(identity);
    accepted.delete(token);
    journal.ack(token);
  };

  const release = (token: string) => {
    const identity = accepted.get(token);
    if (identity) fence.release(identity);
    accepted.delete(token);
    journal.release(token);
  };

  return {
    journal,
    fence,
    injected,
    suppressed,
    deliver,
    ack,
    release,
    setAccepts: (value: boolean) => {
      accepts = value;
    },
  };
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("run completion scheduling idempotency (#2341)", () => {
  it("uses only a stable completion key as a durable identity", () => {
    const keyed = completionFenceIdentity("orchestrator::claude", {
      prompt_id: "prompt-a",
      completion_key: "route-session/prompt-a/generation-1",
    });
    expect(keyed).toBe(
      JSON.stringify(["panel_run", "orchestrator::claude", "completion_key", "route-session/prompt-a/generation-1"]),
    );
    expect(completionFenceIdentity("orchestrator::claude", { prompt_id: "prompt-a" })).toBeNull();
  });

  it("does not suppress a prompt id after restart because journal proof is process-local", () => {
    const path = fencePath();
    const payload = { kind: "executed", prompt_id: "reused-after-restart", possible_repeat: true };
    let injections = 0;

    const first = new RunCompletionIdempotencyFence({ path, now: () => 10_000 });
    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload,
        token: "before-restart",
        fence: first,
        inject: () => {
          injections += 1;
          return true;
        },
        suppress: () => undefined,
      }),
    ).toBe(true);

    const afterRestart = new RunCompletionIdempotencyFence({ path, now: () => 10_000 });
    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload,
        token: "after-restart",
        fence: afterRestart,
        inject: () => {
          injections += 1;
          return true;
        },
        suppress: () => undefined,
      }),
    ).toBe(true);
    expect(injections).toBe(2);
  });

  it("persists a delivered stable-key fence across a new orchestrator instance", () => {
    let now = 20_000;
    const path = fencePath();
    const first = new RunCompletionIdempotencyFence({ path, now: () => now });
    const identity = completionFenceIdentity("orchestrator::claude", stablePayload())!;

    expect(first.claim(identity)).toBe(true);
    expect(first.markAccepted(identity)).toBe(true);
    expect(first.markDelivered(identity)).toBe(true);
    expect(first.state(identity)).toBe("delivered");
    expect(JSON.parse(readFileSync(path, "utf8")).entries[identity].state).toBe("delivered");

    const afterReconnect = new RunCompletionIdempotencyFence({ path, now: () => now });
    expect(afterReconnect.claim(identity)).toBe(false);
    expect(afterReconnect.state(identity)).toBe("delivered");

    now += 6 * 60 * 60_000;
    expect(afterReconnect.claim(identity)).toBe(true);
    expect(afterReconnect.state(identity)).toBe("seen");
  });

  it("keeps accepted-but-unacked work reclaimable after a crash/restart", () => {
    const path = fencePath();
    const first = productionHarness(path);
    const entry = first.journal.record(
      "route/session",
      { ...stablePayload("crash-before-ack", "completion/crash-before-ack"), possible_repeat: true },
    );

    expect(first.deliver().delivered).toBe(1);
    const identity = completionFenceIdentity("route/session", entry.payload)!;
    expect(first.fence.state(identity)).toBe("accepted");
    expect(first.injected).toHaveLength(1);

    // The accepted queue item was never read/acked before the orchestrator died.
    const afterRestart = new RunCompletionIdempotencyFence({ path, now: () => 100_000 });
    let reinjected = 0;
    let suppressed = 0;
    expect(
      scheduleRunCompletion({
        route: "route/session",
        payload: entry.payload,
        token: "recovered-after-crash",
        fence: afterRestart,
        inject: () => {
          reinjected += 1;
          return true;
        },
        suppress: () => {
          suppressed += 1;
        },
      }),
    ).toBe(true);
    expect(reinjected).toBe(1);
    expect(suppressed).toBe(0);
  });

  it("keeps the fence through refusal, replayed retry, stale frame, and actual ack", () => {
    const harness = productionHarness();
    const payload = { ...stablePayload("refusal-retry", "completion/refusal-retry"), possible_repeat: true };
    const entry = harness.journal.record("route/session", payload);

    harness.setAccepts(false);
    expect(harness.deliver().blockedOn?.token).toBe(entry.token);
    expect(harness.fence.state(completionFenceIdentity("route/session", payload)!)).toBeUndefined();

    harness.setAccepts(true);
    harness.release(entry.token);
    expect(harness.deliver().delivered).toBe(1);
    expect(harness.injected).toHaveLength(2);
    expect(harness.injected[1].replayed).toBe(true);
    const identity = completionFenceIdentity("route/session", payload)!;
    expect(harness.fence.state(identity)).toBe("accepted");

    // A stale panel frame must not mint a second turn while the retried item is
    // accepted but not yet read/acked.
    expect(
      scheduleRunCompletion({
        route: "route/session",
        payload,
        token: "stale-before-ack",
        fence: harness.fence,
        inject: () => {
          harness.injected.push(payload);
          return true;
        },
        suppress: (token) => harness.suppressed.push(token),
      }),
    ).toBe(true);
    expect(harness.injected).toHaveLength(2);
    expect(harness.suppressed).toEqual(["stale-before-ack"]);

    harness.ack(entry.token);
    expect(harness.fence.state(identity)).toBe("delivered");
    expect(
      scheduleRunCompletion({
        route: "route/session",
        payload,
        token: "stale-after-ack",
        fence: harness.fence,
        inject: () => {
          harness.injected.push(payload);
          return true;
        },
        suppress: (token) => harness.suppressed.push(token),
      }),
    ).toBe(true);
    expect(harness.injected).toHaveLength(2);
    expect(harness.suppressed).toEqual(["stale-before-ack", "stale-after-ack"]);
  });

  it("bounds retained identities and keeps distinct stable completions separate", () => {
    let now = 30_000;
    const path = fencePath();
    const fence = new RunCompletionIdempotencyFence({ path, now: () => now, maxEntries: 2 });
    const a = completionFenceIdentity("route-a", stablePayload("a", "a"))!;
    const b = completionFenceIdentity("route-a", stablePayload("b", "b"))!;
    const c = completionFenceIdentity("route-b", stablePayload("a", "a"))!;

    expect(fence.claim(a)).toBe(true);
    now += 1;
    expect(fence.claim(b)).toBe(true);
    now += 1;
    expect(fence.claim(c)).toBe(true);
    expect(fence.state(a)).toBeUndefined();
    expect(fence.state(b)).toBe("seen");
    expect(fence.state(c)).toBe("seen");
  });

  it("injects POSSIBLE_REPEAT when there is no stable identity", () => {
    const fence = new RunCompletionIdempotencyFence({ path: fencePath(), now: () => 40_000 });
    let injections = 0;
    let suppressed = 0;
    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload: { kind: "executed", possible_repeat: true },
        token: "unkeyed-repeat",
        fence,
        inject: () => {
          injections += 1;
          return true;
        },
        suppress: () => {
          suppressed += 1;
        },
      }),
    ).toBe(true);
    expect(injections).toBe(1);
    expect(suppressed).toBe(0);
  });

  it("keeps a possible repeat pending when the fence cannot become durable", () => {
    const fenceFileDirectory = mkdtempSync(join(tmpdir(), "cmcp-2341-unwritable-"));
    tempDirs.push(fenceFileDirectory);
    const fence = new RunCompletionIdempotencyFence({ path: fenceFileDirectory, now: () => 50_000 });
    let injections = 0;
    let suppressed = 0;

    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload: { ...stablePayload("no-durable", "completion/no-durable"), possible_repeat: true },
        token: "no-durable-fence",
        fence,
        inject: () => {
          injections += 1;
          return true;
        },
        suppress: () => {
          suppressed += 1;
        },
      }),
    ).toBe(false);
    expect(injections).toBe(0);
    expect(suppressed).toBe(0);
  });

  it("retains dropped-completion disclosure when its carrier is fence-suppressed", () => {
    const journal = new RunCompletionJournalImpl();
    const fence = new RunCompletionIdempotencyFence({ path: fencePath(), now: () => 60_000 });
    for (let i = 0; i < 40; i += 1) {
      journal.record("route/session", stablePayload(`overflow-${i}`, `completion/overflow-${i}`));
    }
    const lost = journal.droppedFor("route/session");
    expect(lost).toBeGreaterThan(0);
    const carrier = journal.outstanding("route/session").find((entry) => (entry.disclose ?? 0) > 0);
    expect(carrier).toBeDefined();
    const carrierIdentity = completionFenceIdentity("route/session", carrier!.payload)!;
    expect(fence.claim(carrierIdentity)).toBe(true);
    expect(fence.markAccepted(carrierIdentity)).toBe(true);
    expect(fence.markDelivered(carrierIdentity)).toBe(true);

    const seen: Array<{ payload: CompletionPayload; token: string }> = [];
    const suppressed = new Set<string>();
    journal.deliverPending("route/session", (payload, token) => {
      seen.push({ payload, token });
      return scheduleRunCompletion({
        route: "route/session",
        payload,
        token,
        fence,
        inject: () => true,
        suppress: (duplicateToken) => {
          suppressed.add(duplicateToken);
          journal.suppress(duplicateToken);
        },
      });
    });

    const disclosed = seen.find(
      ({ payload, token }) => payload.dropped_completions === lost && !suppressed.has(token),
    );
    expect(disclosed).toBeDefined();
    expect(journal.droppedFor("route/session")).toBe(lost);
    journal.ack(disclosed!.token);
    expect(journal.droppedFor("route/session")).toBe(0);
  });
});
