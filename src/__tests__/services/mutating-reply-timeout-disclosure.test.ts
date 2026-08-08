// A reply-timeout on a MUTATING command must not read as "nothing happened".
//
// Two failure paths carry the same risk — the request was already written to the
// socket — but only one said so. handleMidCommandDisconnect spells it out:
//
//   panel tab a1b2 disconnected mid-command ("graph_add_node") — OUTCOME UNKNOWN:
//   the command was already sent, so the panel may have applied it … Verify before
//   retrying … instead of re-issuing it blindly.
//
// The reply-timeout ended at "the ComfyUI tab may be backgrounded or frozen",
// which reads as an explanation for why nothing happened. If anything the timeout
// is the LIKELIER of the two to have applied: its write SUCCEEDED on a live socket
// and the tab merely failed to answer in time, whereas a drop may have killed the
// socket before the bytes landed.
//
// The bridge deliberately does not auto-retry a reply-timeout for exactly this
// reason (isTransientReconnectError excludes it, #334) — the message just never
// told the caller why, so the caller supplies the retry the bridge refused to, and
// the node is added twice.
//
// This is the #796 defect class in its plainest form: "could not determine whether
// it applied" delivered in the words of "it did not apply".
//
// THE TRAP THIS TEST GUARDS. The fix must NOT reuse the literal words "OUTCOME
// UNKNOWN". That string is a sentinel: rebootDropped() and isReconnectDrop() both
// identify a POST-WRITE drop with /disconnected mid-command|OUTCOME UNKNOWN/i.
// Putting it in a timeout message would silently reclassify every frozen-tab
// timeout as a drop — and rebootDropped's contract explicitly EXCLUDES "did not
// reply within N ms", because treating a live-but-frozen tab as an accepted reboot
// would let readiness certify a cycle that was never requested. So the assertions
// below pin both halves: the disclosure is present, and the sentinel is absent.

import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";
import { rebootDropped, __openWorkflowTestHooks } from "../../orchestrator/panel-tools.js";

const { isAckTimeout } = __openWorkflowTestHooks;

let bridge: UiBridge;
let sock: WebSocket;

/** Same free-port strategy as ui-bridge.test.ts — a fixed range flakes on loaded
 *  Windows CI, and a lost bind race there surfaces as a misattributed failure. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

/** A tab that connects, advertises the stamp contract, and then answers NOTHING —
 *  a live-but-frozen tab, which is exactly the state these messages describe. */
beforeEach(async () => {
  let port = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    port = await freePort();
    bridge = new UiBridge(port);
    bridge.start();
    if (await bridge.whenReady()) break;
    await bridge.stop();
  }
  sock = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    sock.on("open", () => resolve());
    sock.on("error", reject);
  });
  sock.send(
    JSON.stringify({
      type: "hello",
      tab_id: "tab-frozen",
      title: "frozen",
      enforces_workflow_stamp: true,
      enforces_workflow_stamp_at_write: true,
    }),
  );
  // Let the hello register before dispatching. The socket never replies after this.
  await new Promise((r) => setTimeout(r, 60));
});

afterEach(async () => {
  try {
    sock?.close();
  } catch {
    /* already closed */
  }
  await bridge?.stop();
});

/** The message text of the rejection `cmd` produces against the frozen tab. */
async function timeoutMessage(cmd: string): Promise<string> {
  try {
    await bridge.send({ cmd }, { timeoutMs: 120 });
    return "<resolved — expected a reply timeout>";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// `workflow_open` rather than `graph_add_node` is the mutating fixture throughout.
// A graph_* write against this tab never reaches dispatch at all: the #570 write
// gate refuses it pre-dispatch because the fixture workflow carries no trusted
// identity to fence against. Using it here would assert against a REFUSAL and pass
// without the timeout path ever running — which is exactly what the first draft of
// this file did, green on three of four cases while proving nothing. workflow_open
// is mutating, ungated, and the command whose double-apply the receipt machinery in
// openWorkflowWithVerify was built for.
describe("a reply-timeout on a mutating command discloses that it may have applied", () => {
  it("tells the caller it was delivered and warns against a blind retry", async () => {
    const msg = await timeoutMessage("workflow_open");

    expect(msg).toMatch(/did not reply to "workflow_open"/);
    expect(msg).toMatch(/MUTATES/);
    expect(msg).toMatch(/already delivered/i);
    expect(msg).toMatch(/may have been applied/i);
    // The actionable half: what to do instead of retrying.
    expect(msg).toMatch(/check the current state before re-issuing/i);
    expect(msg).toMatch(/apply it twice/i);
  });

  it("says none of that for a READ, which cannot double-apply", async () => {
    // In BRIDGE_READONLY_CMDS.
    const msg = await timeoutMessage("graph_serialize");

    expect(msg).toMatch(/did not reply to "graph_serialize"/);
    expect(msg).toMatch(/backgrounded or frozen/);
    expect(msg).not.toMatch(/MUTATES/);
    expect(msg).not.toMatch(/apply it twice/i);
  });

  // The disclosure is tied to DELIVERY, not merely to "this command mutates".
  // A pre-dispatch refusal never reached the socket, so claiming it "was already
  // delivered … may have been applied" would be the very inversion this file
  // exists to prevent, pointed the other way.
  it("claims no delivery for a mutation refused BEFORE dispatch", async () => {
    const msg = await timeoutMessage("graph_add_node");

    expect(msg).toMatch(/cannot be safely targeted|no trusted identity/i);
    expect(msg).not.toMatch(/already delivered/i);
    expect(msg).not.toMatch(/may have been applied/i);
    expect(msg).not.toMatch(/apply it twice/i);
  });

  // The sentinel guard. If a future edit "simplifies" the disclosure to the
  // familiar OUTCOME UNKNOWN wording, this fails — before reboot readiness starts
  // certifying frozen tabs as completed reboot cycles.
  it("does NOT use the OUTCOME UNKNOWN sentinel, which means post-write drop", async () => {
    const msg = await timeoutMessage("workflow_open");

    // Guard the guard: this must be a real timeout, not a refusal that would make
    // the absence assertions below true for the wrong reason.
    expect(msg).toMatch(/did not reply to "workflow_open"/);
    expect(msg).toMatch(/MUTATES/);

    expect(msg).not.toMatch(/OUTCOME UNKNOWN/i);
    expect(msg).not.toMatch(/disconnected mid-command/i);
    // The predicates that read that sentinel must still say "not a drop".
    const asResult = { isError: true, content: [{ type: "text" as const, text: msg }] };
    expect(rebootDropped(asResult)).toBe(false);
  });

  // The recovery path must survive the longer message: openWorkflowWithVerify only
  // runs its receipt lookup when isAckTimeout() recognises the timeout, and that
  // matcher anchors on the bridge preamble plus the exact command name.
  it("is still recognised as an ack-timeout, so verify-after-timeout still fires", async () => {
    const msg = await timeoutMessage("workflow_open");

    expect(msg).toMatch(/MUTATES/); // the appended text is present…
    expect(isAckTimeout({ isError: true, content: [{ type: "text", text: msg }] })).toBe(true); // …and did not break the matcher
  });
});
