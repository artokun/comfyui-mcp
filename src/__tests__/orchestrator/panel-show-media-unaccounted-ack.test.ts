// #2010 — a headless (mobile/remote) client renders audio as a broken image card
// and reports it as SHOWN.
//
// REPRODUCED against the unmodified origin/main handler, via the /view-ref
// branch (which was never extension-gated, so this needs none of PR #2002):
// a headless session dispatching `{filename:"voice.wav"}` got back, as the whole
// of the tool's answer,
//
//     { "shown": true }
//
// which is the mobile client's literal reply — `bridge_client.dart`:
// `replyOk(frame.rid, {'shown': true})` for ANY show_media, items unread. Its
// `MediaCard.build` is `if (item.isVideo) _video(context) else _still(context)`;
// `MediaItem.isVideo` is false for `audio/wav` and `.wav`, so the take becomes a
// `MemoryImage`/`NetworkImage` that cannot decode and degrades to a caption row
// with an image icon. (That client half is READ, not executed — Dart/Flutter is
// not installed on this rig.)
//
// The correction here asks NOTHING about the destination. Three previous
// attempts guarded on `isHeadless(ctx.tabId)` before dispatch and each drew a
// fresh P1 of one class — judging an ADDRESS and predicting a destination
// (#2012), across an await (stale), with "unroutable" wrongly read as safe
// (#2013: show_media is the one BUFFERED command). This runs after the reply,
// on the reply: there is no address to resolve, no await to be stale across and
// no mailbox to mis-classify.
//
// Every test below names the mutation it exists to kill.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  showMediaReplyAccountsForItems,
  unaccountedShowMediaNote,
} from "../../services/comfy-view-ref.js";

const { annotateShowMediaAck } = __panelToolsTestHooks;

/** The mobile / remote pseudo-panel's literal reply (bridge_client.dart:206). */
const MOBILE_REPLY = { shown: true } as const;

/** The sidebar panel's real #710 reply — composeShowMediaReply's return
 *  (comfyui-mcp-panel `web/js/lib/media-preview.js`), copied field for field. */
const PANEL_REPLY = {
  ok: true,
  count: 1,
  painted: 1,
  unconfirmed: 0,
  unrenderable: [] as unknown[],
  previews: [] as unknown[],
  note: "1 audio player was placed in the panel chat for the USER. You cannot hear the audio.",
};

const okResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const textOf = (res: ToolResult): string =>
  res.content.map((c) => ("text" in c ? c.text : "")).join("\n");

const doc = (res: ToolResult): Record<string, unknown> =>
  JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;

const ITEM = [{ filename: "voice.wav", kind: "viewRef" }];

// -- the reply predicate ----------------------------------------------------
describe("#2010 which replies ACCOUNT for the items they were given", () => {
  it("the sidebar panel's #710 reply accounts for them", () => {
    // Kills: making showMediaReplyAccountsForItems always false.
    expect(showMediaReplyAccountsForItems(PANEL_REPLY)).toBe(true);
  });

  it("the mobile client's bare {shown:true} does not", () => {
    // Kills: making showMediaReplyAccountsForItems always true.
    expect(showMediaReplyAccountsForItems(MOBILE_REPLY)).toBe(false);
  });

  it("count+painted with no `unrenderable` does NOT account — that is the pre-#710 panel (#2017)", () => {
    // Kills: dropping the Array.isArray(unrenderable) clause. A panel older than
    // #710 has no `unrenderable` field BECAUSE it cannot tell "I presented this"
    // from "I was handed a kind I have no player for" — it paints audio as a
    // broken <img> and counts it as painted. Its count+painted are therefore
    // exactly as unearned as {shown:true}.
    expect(showMediaReplyAccountsForItems({ ok: true, count: 1, painted: 1, unconfirmed: 0 })).toBe(
      false,
    );
  });

  it.each([
    ["a bare ok", { ok: true }],
    ["a mailboxed receipt", { ok: true, mailboxed: true }],
    ["a bare boolean", true],
    ["an array", [{ count: 1, painted: 1, unrenderable: [] }]],
    ["a string", "shown"],
    ["null", null],
    ["painted as a string", { count: 1, painted: "1", unrenderable: [] }],
    ["count missing", { painted: 1, unrenderable: [] }],
  ])("%s does not account", (_label, reply) => {
    expect(showMediaReplyAccountsForItems(reply)).toBe(false);
  });
});

// -- the correction itself --------------------------------------------------
describe("#2010 an unaccounted reply no longer answers with the client's claim", () => {
  it("the top-level document does NOT assert shown/painted for a bare {shown:true}", () => {
    // Kills: returning `res` untouched for an unaccounted reply — i.e. the bug.
    const out = annotateShowMediaAck(okResult(MOBILE_REPLY), ITEM);
    const d = doc(out);
    expect(d.shown).toBeUndefined();
    expect(d.painted).toBeUndefined();
    expect(d.dispatched).toBe(true);
  });

  it("`presented_confirmed` is null, never 0 — nothing either way was observed", () => {
    // Kills: presented_confirmed: 0. Zero is a measurement ("I looked and found
    // none"); this call did not look.
    const d = doc(annotateShowMediaAck(okResult(MOBILE_REPLY), ITEM));
    expect(d.presented_confirmed).toBeNull();
    expect(d.presented_confirmed).not.toBe(0);
  });

  it("the client's own words are preserved verbatim under client_reply", () => {
    // Kills: dropping client_reply. Deleting what the client said would be its
    // own dishonesty; it is demoted, not discarded.
    const d = doc(annotateShowMediaAck(okResult(MOBILE_REPLY), ITEM));
    expect(d.client_reply).toEqual({ shown: true });
  });

  it("names every dispatched item and the kind it went out as", () => {
    // Kills: emitting a bare count with no item list.
    const d = doc(
      annotateShowMediaAck(okResult(MOBILE_REPLY), [
        { filename: "voice.wav", kind: "viewRef" },
        { filename: "take2.wav", kind: "audio" },
      ]),
    );
    expect(d.unaccounted).toEqual([
      { filename: "voice.wav", kind: "viewRef" },
      { filename: "take2.wav", kind: "audio" },
    ]);
    expect(d.count).toBe(2);
  });

  it("the note tells the agent not to narrate it, and not to re-send", () => {
    // Kills: weakening the note to a neutral caveat. "Unconfirmed" read as
    // "failed" makes an agent loop on a delivery that already happened.
    const t = textOf(annotateShowMediaAck(okResult(MOBILE_REPLY), ITEM));
    expect(t).toMatch(/did NOT establish/);
    expect(t).toMatch(/do not tell the user what they saw or heard/);
    expect(t).toMatch(/NOT a failure report and re-sending is the wrong next step/);
    expect(t).toMatch(/voice\.wav/);
  });

  it("a MAILBOXED reply is described as queued-for-nobody, not as a silent client (#2013)", () => {
    // Kills: deleting the mailboxed branch. show_media is the ONE command the
    // bridge buffers instead of refusing, so "a client took it and said nothing"
    // would be a false description of a command no client has seen.
    const t = textOf(annotateShowMediaAck(okResult({ ok: true, mailboxed: true }), ITEM));
    expect(t).toMatch(/QUEUED, not delivered/);
    expect(t).not.toMatch(/The client acknowledged the command/);
  });

  it("a non-JSON reply is still corrected, and is kept as text", () => {
    const out = annotateShowMediaAck({ content: [{ type: "text", text: "shown" }] }, ITEM);
    expect(doc(out).client_reply).toBe("shown");
  });
});

describe("#2010 the honest client is left ALONE — the correction does not over-fire", () => {
  it("the panel's #710 reply is returned byte-identical", () => {
    // Kills: applying the correction unconditionally. The panel already reports
    // painted/unrenderable per item; rewriting it would delete the only honest
    // account in the system.
    const original = okResult(PANEL_REPLY);
    const out = annotateShowMediaAck(original, ITEM);
    expect(out).toBe(original);
    expect(doc(out)).toEqual(PANEL_REPLY);
  });

  it("an errored dispatch is left alone — it has no claim to correct", () => {
    const errored: ToolResult = {
      content: [{ type: "text", text: "Error: no connected tab" }],
      isError: true,
    };
    expect(annotateShowMediaAck(errored, ITEM)).toBe(errored);
  });

  it("nothing dispatched -> nothing to say", () => {
    const original = okResult(MOBILE_REPLY);
    expect(annotateShowMediaAck(original, [])).toBe(original);
  });
});

// -- the CALL SITE, not just the helper -------------------------------------
// A helper-level suite survives deleting the one line that installs it. These
// drive panel_show_media's real handler.
type Cmd = Record<string, unknown>;

function makeCtx(reply: unknown, headless: boolean): { ctx: PanelToolCtx; calls: Cmd[] } {
  const calls: Cmd[] = [];
  const ctx = {
    // Exactly what makePanelToolCtx does: `ok(await sendRouted(...))`.
    call: async (cmd: Cmd) => {
      calls.push(cmd);
      return okResult(reply);
    },
    confirm: async () => "yes" as const,
    bridge: { isHeadless: () => headless } as unknown as PanelToolCtx["bridge"],
    tabId: "phone-tab",
  } as PanelToolCtx;
  return { ctx, calls };
}

async function showMedia(
  items: Array<Record<string, unknown>>,
  reply: unknown,
  headless = true,
): Promise<{ res: ToolResult; calls: Cmd[] }> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media");
  if (!def) throw new Error("panel_show_media not found");
  const { ctx, calls } = makeCtx(reply, headless);
  const res = (await def.handler({ items }, ctx)) as ToolResult;
  return { res, calls };
}

describe("#2010 panel_show_media's handler INSTALLS the correction", () => {
  it("the reported repro — a .wav to a headless client no longer answers {shown:true}", async () => {
    // Kills: removing the annotateShowMediaAck(...) wrapper at the ctx.call site.
    // This is the one-line wiring mutation; every helper test above survives it.
    const { res } = await showMedia(
      [{ source: { filename: "voice.wav", type: "output" }, caption: "take 3" }],
      MOBILE_REPLY,
    );
    expect(res.isError).toBeFalsy();
    const d = doc(res);
    expect(d.shown).toBeUndefined();
    expect(d.presented_confirmed).toBeNull();
    expect(d.client_reply).toEqual({ shown: true });
    expect(textOf(res)).toMatch(/did NOT establish/);
  });

  it("the item was still DISPATCHED — this corrects a claim, it does not refuse", async () => {
    // Kills: turning the correction into a pre-dispatch refusal (what main does
    // today for a `{path}` .wav, and what this issue exists NOT to re-create).
    const { res, calls } = await showMedia(
      [{ source: { filename: "voice.wav", type: "output" } }],
      MOBILE_REPLY,
    );
    expect(calls).toHaveLength(1);
    expect((calls[0] as { items: unknown[] }).items).toHaveLength(1);
    expect(res.isError).toBeFalsy();
  });

  it("the #941 view-ref note still lands AFTER the corrected document", async () => {
    // Kills: prepending the correction, or replacing the whole content array —
    // either would drop the notes the handler appends afterwards.
    const { res } = await showMedia(
      [{ source: { filename: "voice.wav", type: "output" } }],
      MOBILE_REPLY,
    );
    const blocks = res.content.map((c) => ("text" in c ? c.text : ""));
    expect(blocks[0]).toMatch(/"dispatched": true/);
    expect(blocks.slice(1).join("\n")).toMatch(/sent to the panel as a ComfyUI \/view REFERENCE/);
  });

  it("a sidebar panel session is unaffected end to end", async () => {
    const { res } = await showMedia(
      [{ source: { filename: "voice.wav", type: "output" } }],
      PANEL_REPLY,
      false,
    );
    expect(doc(res)).toEqual(PANEL_REPLY);
    expect(textOf(res)).not.toMatch(/did NOT establish/);
  });
});

describe("#2010 the note builder", () => {
  it("says nothing when nothing was dispatched", () => {
    expect(unaccountedShowMediaNote([], MOBILE_REPLY)).toBe("");
  });

  it("caps the item list and says how many it left out", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ filename: `t${i}.wav`, kind: "audio" }));
    const t = unaccountedShowMediaNote(many, MOBILE_REPLY);
    expect(t).toMatch(/and 2 more/);
    expect(t).not.toMatch(/t9\.wav/);
  });
});
