// panel#1554 — the reporter's restart confirmation was ACCEPTED by the panel and
// DISCARDED by the orchestrator.
//
// `panel_restart_comfyui` bounds its confirmation card at 90s (#404) so an undelivered
// card fails fast instead of reading as a 4-minute hang. What #404 did not account for
// is the ANSWER. The panel retires a card only when the connection that painted it is
// REPLACED (#952) — never on a caller's timeout — so the card stays painted and stays
// clickable. A click after the deadline still reaches the bridge, which buffers the
// validated answer under its `ask_id` for LATE_ASK_TTL_MS.
//
// Nothing ever read it back. #486's durable journal accepts only `pa-`-prefixed
// panel_ask ids, and confirm's own grace poll is ZERO-WIDTH here: `timeoutMs` 90s is
// spent entirely on the card deadline, so `graceMs` computes to 0 and #360's
// late-honour poll takes one look and gives up. The answer was TTL-pruned unread while
// the tool reported "No confirmation received within 90s, so I did NOT restart
// ComfyUI" — to a user who had clicked "Yes, go ahead" and watched the card collapse to
// "✓ Yes, go ahead". They went and found the headless `restart_comfyui` instead.
//
// THE FIX READS IT rather than waiting longer, so #404's 90s is untouched: the
// abandoned card's id is remembered, and the NEXT attempt at the same confirmation
// drains it before dispatching a second card.
//
// These tests drive the REAL `ctx.confirm`. An earlier draft stubbed it and proved
// nothing: every stub returns whatever it was told to, so the one line that decides
// whether a buffered answer is claimed was never executed.

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import {
  appendReplyNote,
  buildPanelToolDefs,
  confirmAnswerRecoveryWindowMs,
  forgetAbandonedConfirmCards,
  makePanelToolCtx,
  resetAbandonedConfirmCards,
  __panelToolsTestHooks,
  type ConfirmOptions,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { LATE_ASK_TTL_MS } from "../../services/ui-bridge.js";
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const OTHER_TAB = "wf:workflows/b.json";
const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

const QUESTION =
  "Restart ComfyUI now? It (and this agent) will go down briefly, then reconnect and resume automatically.";
const HEADER = "Restart ComfyUI";

/** The bridge's canonical no-reply text — the ONLY shape isReplyTimeoutError accepts
 *  from an untagged error, so a fixture that gets it wrong would be surfaced as a real
 *  error ("unreachable") and would silently stop testing the timeout branch. */
const replyTimeout = (tabId: string) =>
  new Error(
    `Panel tab ${tabId.slice(0, 8)} did not reply to "ask_user" within 500 ms — ` +
      "the ComfyUI tab may be backgrounded or frozen",
  );

interface Harness {
  ctx: PanelToolCtx;
  /** ask_user frames the orchestrator actually put on the wire. */
  cards: Array<Record<string, unknown>>;
  /** The bridge's late-answer buffer (ask_id → what the user clicked). */
  late: Map<string, unknown>;
  /** Every takeLateAskReply(id) this run made — proves WHICH id was claimed. */
  drained: string[];
}

function harness(tabId = TAB, opts: { answerCards?: boolean } = {}): Harness {
  const cards: Array<Record<string, unknown>> = [];
  const late = new Map<string, unknown>();
  const drained: string[] = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "ask_user") {
        cards.push(cmd);
        // The reporter's case: the card is dispatched and painted, and no answer comes
        // back inside the caller's budget.
        if (!opts.answerCards) throw replyTimeout(tabId);
        // bridge.send resolves with the REPLY'S RESULT — for a card, the label the
        // user picked — which is what isAffirmative is handed.
        return "Yes, go ahead";
      }
      return { ok: true };
    },
    takeLateAskReply: (askId: string) => {
      drained.push(askId);
      if (!late.has(askId)) return undefined;
      const v = late.get(askId);
      late.delete(askId); // the real buffer is one-shot too
      return v;
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: tabId, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => tabId,
    tabIsLocal: () => true,
    tabServerOrigin: () => BOOT_BASE,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return {
    ctx: makePanelToolCtx(bridge, tabId, new WorkflowTargetStore()),
    cards,
    late,
    drained,
  };
}

const RECOVER: ConfirmOptions = { recoverAbandonedAnswer: true };

/** One abandoned attempt: dispatch a card, get no answer inside the budget. */
async function abandonOnce(h: Harness, question = QUESTION, header = HEADER): Promise<string> {
  const outcome = await h.ctx.confirm(question, header, 500, RECOVER);
  expect(outcome).toBe("timeout");
  return String(h.cards[h.cards.length - 1].ask_id);
}

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join("\n");

const restartDef = () => {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui is not registered");
  return def;
};

describe("panel#1554 a late confirmation is claimed, not discarded", () => {
  beforeEach(() => resetAbandonedConfirmCards());

  it("the abandoned card's YES is honoured by the next attempt, with no second card", async () => {
    const h = harness();
    const askId = await abandonOnce(h);
    expect(h.cards).toHaveLength(1);

    // The user clicks "Yes, go ahead" after the tool gave up. The panel delivers it;
    // the bridge buffers it under the card's own id (this is real bridge behaviour —
    // see UiBridge's late-reply branch — not something this fix introduces).
    h.late.set(askId, "Yes, go ahead");

    const outcome = await h.ctx.confirm(QUESTION, HEADER, 500, RECOVER);

    expect(outcome).toBe("yes");
    // …and nothing was painted over the card the user already answered.
    expect(h.cards).toHaveLength(1);
    // Claimed by EXACT id — not "the most recent answer".
    expect(h.drained).toContain(askId);
  });

  it("a late DECLINE is honoured too — it is lost the same way today", async () => {
    const h = harness();
    const askId = await abandonOnce(h);
    h.late.set(askId, "No, cancel");

    expect(await h.ctx.confirm(QUESTION, HEADER, 500, RECOVER)).toBe("no");
    expect(h.cards).toHaveLength(1);
  });

  it("an unanswered card is not an answer: the next attempt asks again", async () => {
    const h = harness();
    await abandonOnce(h);
    // Nothing buffered — the user genuinely never answered.
    expect(await h.ctx.confirm(QUESTION, HEADER, 500, RECOVER)).toBe("timeout");
    expect(h.cards).toHaveLength(2);
  });

  it("ONE-SHOT: a recovered answer satisfies exactly one call", async () => {
    const h = harness();
    const askId = await abandonOnce(h);
    h.late.set(askId, "Yes, go ahead");

    expect(await h.ctx.confirm(QUESTION, HEADER, 500, RECOVER)).toBe("yes");
    // A third call must not re-serve the same click as a fresh confirmation.
    expect(await h.ctx.confirm(QUESTION, HEADER, 500, RECOVER)).toBe("timeout");
    expect(h.cards).toHaveLength(2);
  });

  it("a DIFFERENT question on the same tab cannot claim it", async () => {
    const h = harness();
    const askId = await abandonOnce(h);
    h.late.set(askId, "Yes, go ahead");

    // Same tab, same header, different words: not the question that was answered.
    const outcome = await h.ctx.confirm("Clear the canvas?", HEADER, 500, RECOVER);

    expect(outcome).toBe("timeout");
    expect(h.cards).toHaveLength(2);
    // The yes is still sitting in the buffer — untouched, not mis-served.
    expect(h.late.get(askId)).toBe("Yes, go ahead");
  });

  it("a DIFFERENT tab cannot claim it — an answer given on one tab is not another's", async () => {
    const a = harness(TAB);
    const askId = await abandonOnce(a);
    a.late.set(askId, "Yes, go ahead");

    const b = harness(OTHER_TAB);
    // Same words, same header, other tab. (b's own buffer is empty by construction;
    // the point is that b does not even LOOK at the card a left behind.)
    expect(await b.ctx.confirm(QUESTION, HEADER, 500, RECOVER)).toBe("timeout");
    expect(b.drained).not.toContain(askId);
    expect(a.late.get(askId)).toBe("Yes, go ahead");
  });

  it("opting OUT keeps the old behaviour: nothing is remembered and nothing is claimed", async () => {
    // The mutation that matters most — if `recoverAbandonedAnswer` stopped gating this,
    // panel_clear would inherit a mechanism nobody reviewed for a canvas wipe.
    const h = harness();
    expect(await h.ctx.confirm(QUESTION, HEADER, 500)).toBe("timeout");
    const askId = String(h.cards[0].ask_id);
    h.late.set(askId, "Yes, go ahead");

    expect(await h.ctx.confirm(QUESTION, HEADER, 500)).toBe("timeout");
    expect(h.cards).toHaveLength(2);
    expect(h.late.get(askId)).toBe("Yes, go ahead");
  });

  it("an ANSWERED card is not remembered — only an abandoned one is", async () => {
    const h = harness(TAB, { answerCards: true });
    expect(await h.ctx.confirm(QUESTION, HEADER, 500, RECOVER)).toBe("yes");
    expect(h.drained).toHaveLength(0);
  });

  it("NEW CHAT: the next restart on the same wf: tab paints a FRESH card", async () => {
    // The pin the review asked for, by name and at the TOOL level rather than at
    // confirm's: "next restart on the same `wf:` tab must paint a fresh card". New chat
    // blanks the feed (`newChat()` → `resetFeed()`), so the card the answer belongs to is
    // no longer on screen; claiming it would restart the server showing the user nothing.
    const h = harness();

    // A real first attempt: card dispatched, nobody answers inside the budget.
    expect(textOf(await restartDef().handler({} as never, h.ctx))).toContain(
      "No confirmation received within",
    );
    expect(h.cards).toHaveLength(1);
    // …then they click it.
    h.late.set(String(h.cards[0].ask_id), "Yes, go ahead");

    // New chat: exactly what the `new_session` handler does for each member tab.
    forgetAbandonedConfirmCards(TAB);

    // A SECOND CARD, not a silent restart on the strength of the first one.
    const second = textOf(await restartDef().handler({} as never, h.ctx));
    expect(h.cards).toHaveLength(2);
    expect(second).toContain("No confirmation received within");
    expect(second).not.toContain("NO NEW CONFIRMATION CARD WAS SHOWN");
    // The click is left where it was rather than consumed by a conversation that
    // never showed it.
    expect(h.late.get(String(h.cards[0].ask_id))).toBe("Yes, go ahead");
  });

  it("a TAKEOVER of the route key drops it — the newcomer never answered that card", async () => {
    // `wf:` keys recur: close the browser tab, open the same workflow elsewhere, and the
    // newcomer inherits the address. #486 calls that a conversation boundary and retires
    // the departing occupant's asks on it; a confirmation card is no different.
    const h = harness();
    const askId = await abandonOnce(h);
    h.late.set(askId, "Yes, go ahead");

    forgetAbandonedConfirmCards(TAB);

    expect(await h.ctx.confirm(QUESTION, HEADER, 500, RECOVER)).toBe("timeout");
    expect(h.cards).toHaveLength(2);
    // The departed occupant's answer is left where it was — not served to the newcomer.
    // (Asserted on the BUFFER, not on `drained`: confirm's own zero-width grace poll
    // looks that id up once on the way to reporting the timeout, so a "never looked"
    // assertion would be false for a reason that has nothing to do with this rule.)
    expect(h.late.get(askId)).toBe("Yes, go ahead");
  });

  it("a takeover of ANOTHER key leaves this one alone", async () => {
    const h = harness();
    const askId = await abandonOnce(h);
    h.late.set(askId, "Yes, go ahead");

    forgetAbandonedConfirmCards(OTHER_TAB);

    expect(await h.ctx.confirm(QUESTION, HEADER, 500, RECOVER)).toBe("yes");
  });

  it("WIRING: every boundary that BLANKS THE FEED retires the confirmation too", () => {
    // A review found the boundary I originally chose (takeover only) was too narrow, and
    // for a reason my own argument had missed. The leak is not attribution — a restart
    // consent is not conversation content — it is VISIBILITY. New chat blanks the feed
    // (the panel's newChat() calls resetFeed()), a rewind discards everything after the
    // anchor, and resume_session repaints the log from another thread. In all three the
    // card is gone from the screen, so acting on its answer afterwards restarts the
    // server on a surface showing nothing the user can point at.
    //
    // Behavioural tests cannot see WHICH handlers call it, and this is a set that is
    // easy to silently shrink back to one, so the call sites are what is pinned.
    const src = readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");
    for (const event of ["new_session", "rewind", "resume_session"]) {
      const at = src.indexOf(`event.type === "${event}"`);
      expect(at, `${event} handler not found`).toBeGreaterThan(-1);
      // Bounded to the handler: the next one starts at the following `event.type ===`.
      const next = src.indexOf("event.type === ", at + 20);
      const block = src.slice(at, next > at ? next : at + 4000);
      expect(block, `${event} must retire the abandoned confirmation`).toMatch(
        /^\s*forgetAbandonedConfirmCards\(t\);\s*$/m,
      );
      // …and it stays alongside #486's retirement, not instead of it.
      expect(block, `${event} must still retire ask state`).toContain("AskAnswers.closeAsks(t)");
    }
    // A PROVIDER SWITCH is deliberately absent: it leaves the card painted, so the
    // consent is still on screen and still answerable. Asserted so that adding it later
    // is a deliberate act rather than a copy-paste.
    const providerAt = src.indexOf("if (providerSwitched) AskAnswers.closeAsks(panelTab);");
    expect(providerAt).toBeGreaterThan(-1);
    expect(src.slice(providerAt, providerAt + 200)).not.toContain("forgetAbandonedConfirmCards");
  });

  it("WIRING: the takeover listener retires confirmations as well as asks", () => {
    // The bridge takes ONE takeover listener (a setter, not an adder), so this fix had
    // to join the existing call rather than add a second one — a second
    // setTabTakenOverListener would have silently replaced #486's and un-shipped it.
    // Behavioural tests above cannot see that; this is the shape of the call site.
    // Resolved from THIS module, not from the cwd — a cwd-relative read passes or fails
    // on where vitest was launched rather than on what the source says.
    const src = readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");
    const at = src.indexOf("bridge.setTabTakenOverListener(");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, at + 200);
    expect(call).toContain("AskAnswers.closeAsks(tabId)");
    expect(call).toContain("forgetAbandonedConfirmCards(tabId)");
    // Exactly one listener is installed — the whole hazard.
    expect(src.split("bridge.setTabTakenOverListener(").length - 1).toBe(1);
  });

  it("the staleness bound IS the bridge's buffer TTL, not a second copy of it", () => {
    // A private "5 minutes" over in panel-tools would be a bound deciding a correctness
    // question in two places, free to drift. Pin that it is the same value.
    expect(confirmAnswerRecoveryWindowMs()).toBe(LATE_ASK_TTL_MS);
  });
});

describe("panel#1554 the recovered decision is disclosed, not slipped in", () => {
  beforeEach(() => resetAbandonedConfirmCards());

  it("THE CALL SITE opts in — the helper alone proves nothing about production", async () => {
    // Verified by mutation: dropping the options object from the ctx.confirm(...) call
    // in panel_restart_comfyui leaves every test above green, because they call confirm
    // directly. This is the assertion that goes red.
    const h = harness();
    let seen: ConfirmOptions | undefined;
    h.ctx.confirm = async (_q, _hd, _t, opts) => {
      seen = opts;
      return "timeout";
    };

    await restartDef().handler({} as never, h.ctx);

    expect(seen?.recoverAbandonedAnswer).toBe(true);
    expect(typeof seen?.onRecoveredAnswer).toBe("function");
  });

  it("a note raised anywhere in the handler rides the reply it returns", async () => {
    // The handler has ~25 return points after its confirmation card, and the disclosure
    // has to ride all of them — one that only survives the happy path reads as a FRESH
    // confirmation on every other branch. withReplyNote is what makes that true for all
    // of them at once; the timeout branch is simply the cheapest reply to reach
    // deterministically (the decline branch probes ComfyUI's health for seconds, and
    // the accept branch dispatches a real reboot).
    const h = harness();
    h.ctx.confirm = async (_q, _hd, _t, opts) => {
      opts?.onRecoveredAnswer?.({ outcome: "yes", ageMs: 132_000 });
      return "timeout";
    };

    const out = textOf(await restartDef().handler({} as never, h.ctx));

    expect(out).toContain("NO NEW CONFIRMATION CARD WAS SHOWN");
    expect(out).toContain("Yes, go ahead");
    expect(out).toContain("132s ago");
  });

  it("no recovery, no note — an ordinary reply is left exactly as the handler built it", async () => {
    const h = harness();
    h.ctx.confirm = async () => "timeout";

    const res = await restartDef().handler({} as never, h.ctx);

    expect(res.content).toHaveLength(1);
    expect(textOf(res)).not.toContain("NO NEW CONFIRMATION CARD WAS SHOWN");
  });

  it("the timeout wording stops calling the live card dead", async () => {
    // "Tell me to restart it and I'll re-ask" described a card that was finished and a
    // decision that had to be made again. It was neither — and believing it is what
    // sent the reporter looking for the headless tool.
    const h = harness();
    h.ctx.confirm = async () => "timeout";

    const out = textOf(await restartDef().handler({} as never, h.ctx));

    expect(out).toContain("That card is still live");
    expect(out).not.toContain("and I'll re-ask");
  });

  it("END TO END: two real tool calls, real confirm, and the second one claims the click", async () => {
    // Everything above either drives `confirm` directly or stubs it. This drives NEITHER:
    // the REAL handler, twice, through the REAL confirm, with the recovery reached the
    // way production reaches it. Without it the chain call site → opts → confirm →
    // recovery is only proven by composition.
    //
    // The recovered answer is the DECLINE, because it is the one post-confirm branch
    // that settles deterministically without dispatching a reboot or waiting out a
    // readiness budget — the probe is stubbed healthy and its recheck window shrunk.
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");
    __panelToolsTestHooks.setDeclineProbeTiming({
      windowMs: 20,
      intervalMs: 5,
      probeTimeoutMs: 5,
    });
    try {
      const h = harness();

      // Call 1: the card is dispatched and nobody answers inside the 90s budget.
      const first = textOf(await restartDef().handler({} as never, h.ctx));
      expect(first).toContain("No confirmation received within");
      expect(h.cards).toHaveLength(1);

      // The user answers it afterwards. The bridge buffers it under the card's own id.
      h.late.set(String(h.cards[0].ask_id), "No, cancel");

      // Call 2: no second card, and the reply carries the disclosure.
      const second = textOf(await restartDef().handler({} as never, h.ctx));

      expect(h.cards).toHaveLength(1);
      expect(second).toContain("NO NEW CONFIRMATION CARD WAS SHOWN");
      expect(second).toContain("No, cancel");
      // …and it is the DECLINE branch's own reply, not the timeout's.
      expect(second).not.toContain("No confirmation received within");
      // Nothing was restarted on a decline — the safe path is untouched.
      expect(h.cards.every((c) => c.cmd === "ask_user")).toBe(true);
    } finally {
      __panelToolsTestHooks.setHealthProbe(null);
      __panelToolsTestHooks.setDeclineProbeTiming(null);
    }
  });

  it("the note is its OWN block: a structured reply stays parseable at index 0", () => {
    // Splicing it into the first block would corrupt the JSON document the agent (and
    // this repo's tests) parse from there; pushing it in FRONT would move that document
    // to index 1 and break every reader that takes index 0.
    const doc = { restarted: true, confirmed_cycle: false };
    const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(doc) }] };

    const noted = appendReplyNote(res, "[NOTE] recovered");

    expect(JSON.parse((noted.content[0] as { text: string }).text)).toEqual(doc);
    expect((noted.content[1] as { text: string }).text).toBe("[NOTE] recovered");
    // An empty note adds nothing at all.
    expect(appendReplyNote(res, "")).toBe(res);
  });
});
