// #952 (panel) — an interactive question card was told to go and check the
// render queue.
//
// `panel_ask` was interrupted by a tab disconnect and the OUTCOME UNKNOWN error
// ended with the only remedy this path had: check `queue action:"list"` /
// `get_image (action:"list_outputs")`. Neither can observe whether a question is
// on a human's screen. The reporter said so plainly, and they were right.
//
// The panel-side trace on that issue supplies the fact that makes this more than
// wording: for THIS trigger a blind retry really does duplicate the card. The
// dedupe ledger is keyed by the socket's bridge epoch; a reconnect mints a new
// one; the retry lands in a different scope, `lookupRetry` misses, and it fails
// open and re-executes. Failing open is correct for a read or an idempotent
// write. For a question it means a second card in front of a person, and there
// is no way to withdraw the first.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isInteractiveCommand,
  midCommandDisconnectMessage,
  midCommandVerifyClause,
} from "../../services/mid-command-remedy.js";

const ASK = { short: "wf:728f6", cmd: "ask_user" };
const RUN = { short: "wf:728f6", cmd: "graph_run" };

describe("the disconnect remedy fits what was interrupted (#952)", () => {
  it("an ask card is NOT sent to the render queue — the reporter's complaint", () => {
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).not.toMatch(/queue action:"list"/);
    expect(msg).not.toMatch(/list_outputs/);
  });

  it("…and says the thing that is actually true of it", () => {
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).toMatch(/card may already be on screen/);
    // The fact from the panel trace: a retry is not merely unverifiable, it
    // duplicates after a reconnect because suppression is keyed to the dead
    // socket. Stated as the consequence the user sees.
    expect(msg).toMatch(/retry\s+suppression is keyed to the socket that dropped/);
    expect(msg).toMatch(/user may see two/);
  });

  it("does NOT promise the answer will arrive — it will not (codex)", () => {
    // An earlier draft said "if the user answers the card already up, the answer
    // still arrives". Checked against the panel: `redactSensitiveReply` replaces
    // an ask_user/request_secret reply that cannot cross the dropped connection
    // with a payload-free failure, deliberately, and tells the caller to ask
    // again on the current connection. Waiting is not a recovery, and advising it
    // would have parked the agent forever.
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).toMatch(/will NOT reach you/);
    expect(msg).not.toMatch(/Prefer to wait/);
    expect(msg).not.toMatch(/still arrives/);
  });

  it("names a route that works, since it forbids the obvious move", () => {
    // A refusal with no alternative is how an agent ends up retrying anyway.
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).toMatch(/Re-issue the question on the current connection/);
    expect(msg).toMatch(/ask it in conversation/);
    // …and warns about the consequence the panel trace established.
    expect(msg).toMatch(/user may see two/);
  });

  it("a SECRET is never routed through the conversation (codex)", () => {
    // The card exists so the value reaches the panel through a masked input,
    // unseen by the agent and unrecorded in chat. "Just ask them for it" would
    // defeat exactly that, and this message is read by an agent that will act
    // on it.
    const msg = midCommandDisconnectMessage({ short: "wf:1", cmd: "request_secret" });
    expect(msg).toMatch(/Re-issue panel_request_secret on the current connection/);
    expect(msg).toMatch(/never ask the user to paste a secret into the conversation/);
    expect(msg).not.toMatch(/ask it in conversation/);
  });

  it("does NOT invent a recovery that does not exist", () => {
    // There is no pending-card query, and `retry_of` does not survive the
    // reconnect this message is about. Both are open design questions on the
    // issue; promising either would send the caller to something that fails.
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).toMatch(/there is no pending-card query/);
    expect(msg).not.toMatch(/retry_of/);
  });

  it("request_secret is interactive too — same human, same duplicate", () => {
    expect(isInteractiveCommand("request_secret")).toBe(true);
    expect(midCommandDisconnectMessage({ short: "wf:1", cmd: "request_secret" })).toMatch(
      /card may already be on screen/,
    );
    // …and says it ONCE. The lead sentence and the clause both used to open with
    // it, which read as though two separate facts were being reported.
    const msg = midCommandDisconnectMessage({ short: "wf:1", cmd: "request_secret" });
    expect(msg.match(/may already be (on screen|SHOWING)/g)?.length).toBe(1);
  });

  it("the two interactive commands differ ONLY in the route they are given", () => {
    // Same facts, different safe action. If these ever collapse to one string,
    // one of them is being given the other's advice.
    const ask = midCommandDisconnectMessage(ASK);
    const secret = midCommandDisconnectMessage({ short: ASK.short, cmd: "request_secret" });
    expect(ask).not.toBe(secret);
    for (const m of [ask, secret]) {
      expect(m).toMatch(/will NOT reach you/);
      expect(m).toMatch(/user may see two/);
    }
  });

  it("every OTHER command keeps the queue/output check — it is real evidence there", () => {
    const msg = midCommandDisconnectMessage(RUN);
    expect(msg).toMatch(/queue action:"list"/);
    expect(msg).toMatch(/list_outputs/);
    expect(msg).toMatch(/ComfyUI may already be rendering/);
    expect(msg).not.toMatch(/card may already be on screen/);
  });

  it("still reports OUTCOME UNKNOWN and the tab, whichever branch it takes", () => {
    // The parts callers and the existing detectors key on must not move: several
    // call sites match /disconnected mid-command|OUTCOME UNKNOWN/.
    for (const ctx of [ASK, RUN]) {
      const msg = midCommandDisconnectMessage(ctx);
      expect(msg, ctx.cmd).toMatch(/disconnected mid-command \("/);
      expect(msg).toMatch(/OUTCOME UNKNOWN/);
      expect(msg).toContain(ctx.short);
      expect(msg).toContain(ctx.cmd);
    }
  });

  it("an unknown or malformed command is treated as NON-interactive", () => {
    // Claiming "a card may be on screen" about a write would be false, so anything
    // not on the interactive list must classify as non-interactive.
    for (const cmd of ["", "   ", "graph_add_node", "ask_user_extra"]) {
      expect(isInteractiveCommand(cmd), cmd).toBe(false);
    }
    // This used to assert that graph_add_node got the queue/output advice, on the
    // rationale that it was "merely unhelpful". #646 is the bill for that: the
    // reporter's interrupted graph_set_widget sent them to the render queue, which
    // cannot see a canvas edit — the same wrong-remedy defect #952 fixed for
    // interactive cards, still live for graph writes. Unhelpful advice that names a
    // specific tool does not read as unhelpful; it reads as the answer.
    expect(midCommandVerifyClause("graph_add_node")).toMatch(/panel_query_graph/);
    expect(midCommandVerifyClause("ask_user_extra")).toMatch(/Verify that it applied/);
  });
});

describe("WIRING: the bridge uses it (#952)", () => {
  it("the mid-command disconnect path builds its message here", async () => {
    // The helper is worthless if the bridge keeps its own hardcoded string, and
    // the branch is inside a long method that no unit test constructs.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../services/ui-bridge.ts", import.meta.url), "utf-8");
    expect(src).toContain('import { midCommandDisconnectMessage } from "./mid-command-remedy.js"');
    expect(src).toContain("midCommandDisconnectMessage({ short, cmd })");
    // …and the old hardcoded remedy is gone from the mutating branch.
    expect(src).not.toMatch(
      /OUTCOME UNKNOWN: the command was already sent, so the panel may have applied it/,
    );
  });
});


// ===========================================================================
// panel#646 — the check named has to be able to hold the answer.
//
// Every non-interactive command got the same sentence: check queue action:"list"
// / get_image list_outputs. That is RENDER evidence. The reporter's interrupted
// command was graph_set_widget, and neither of those can say whether a widget
// edit landed — so an agent following the advice looks somewhere structurally
// incapable of answering and ends up retrying blindly anyway, which is the exact
// thing OUTCOME UNKNOWN exists to prevent.
// ===========================================================================
describe("#646 the verify clause names evidence that exists for the command", () => {
  const GRAPH_WRITES = [
    "graph_set_widget", // the reported one
    "graph_edit_node",
    "graph_connect",
    "graph_add_node",
    "graph_remove_node",
    "graph_paste_nodes",
    "graph_create_subgraph",
  ];

  it.each(GRAPH_WRITES)("%s is verified with a graph READ, not the render queue", (cmd) => {
    const text = midCommandVerifyClause(cmd);
    expect(text).toMatch(/panel_query_graph/);
    expect(text).toMatch(/graph READ/);
    // The render tools must NOT be offered here — that is the defect.
    expect(text).not.toMatch(/queue action:"list"/);
    expect(text).not.toMatch(/list_outputs/);
  });

  it("says why the read is safe to run immediately", () => {
    // A caller who has just lost a socket needs to know the check itself is not
    // another risky write. Idempotence is the reason it is a better check than
    // anything the run path offers.
    expect(midCommandVerifyClause("graph_set_widget")).toMatch(/idempotent/);
  });

  it("tells the caller NOT to re-issue when the read shows it applied", () => {
    // Verifying and then retrying anyway is the double-apply this whole message
    // exists to avoid, and the old text never closed that loop.
    expect(midCommandVerifyClause("graph_edit_node")).toMatch(/do\s+NOT re-issue/i);
  });

  it("graph_run KEEPS the queue/output check — it was right for exactly one command", () => {
    const text = midCommandVerifyClause("graph_run");
    expect(text).toMatch(/queue action:"list"/);
    expect(text).toMatch(/list_outputs/);
    // And it says what a blind retry costs, which is the reason to check.
    expect(text).toMatch(/GPU time|duplicate output/);
    expect(text).not.toMatch(/panel_query_graph/);
  });

  it("a workflow mutator is verified with the workflow list, not a canvas read", () => {
    // These change which workflows exist or are open — a graph read cannot see it.
    for (const cmd of ["workflow_save", "workflow_save_as", "workflow_rename", "workflow_close"]) {
      const text = midCommandVerifyClause(cmd);
      expect(text).toMatch(/panel_list_workflows/);
      expect(text).not.toMatch(/panel_query_graph/);
      expect(text).not.toMatch(/queue action:"list"/);
    }
  });

  it("an UNRECOGNISED command names no tool at all", () => {
    // The defect was a confidently wrong check. The default branch is exactly
    // where a guess would be wrong again, so it says to verify and stops.
    const text = midCommandVerifyClause("some_future_command");
    expect(text).toMatch(/Verify that it applied/);
    expect(text).not.toMatch(/panel_query_graph|queue action:"list"|list_outputs|panel_list_workflows/);
    // It still explains WHY, so "verify" is not a bare instruction.
    expect(text).toMatch(/reached the panel/);
  });

  it("an interactive card is untouched by all of this", () => {
    const text = midCommandVerifyClause("ask_user");
    expect(text).toMatch(/will NOT reach you/);
    expect(text).not.toMatch(/panel_query_graph/);
  });

  it("the full message still carries the OUTCOME UNKNOWN framing", () => {
    const msg = midCommandDisconnectMessage({ short: "wf:12345", cmd: "graph_set_widget" });
    expect(msg).toMatch(/OUTCOME UNKNOWN/);
    expect(msg).toMatch(/panel_query_graph/);
  });

  it("the duplicated workflow-mutator list still matches ui-bridge's", () => {
    // WORKFLOW_MUTATORS is duplicated because ui-bridge.ts imports this module, so
    // importing its ACTIVE_WORKFLOW_MUTATORS back would be a cycle. A duplicate is
    // only honest with a check on it: if ui-bridge gains a fifth mutator, this
    // module would silently send it to the default branch.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../services/ui-bridge.ts"),
      "utf8",
    );
    const block = src.slice(src.indexOf("const ACTIVE_WORKFLOW_MUTATORS"));
    const names = (block.slice(0, block.indexOf("]")).match(/"(\w+)"/g) ?? []).map((s) =>
      s.replace(/"/g, ""),
    );
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(midCommandVerifyClause(n)).toMatch(/panel_list_workflows/);
    }
  });
});

describe("#646 a graph_ prefix does not mean the effect is on the canvas", () => {
  it("graph_save_subgraph is verified with panel_list_subgraphs (codex review, P1)", () => {
    // It writes to the blueprint LIBRARY. The graph is identical afterwards, so both
    // graph readers show exactly what they showed before and cannot tell a save that
    // landed from one that did not — the same shape of wrong answer this fix exists
    // to remove, one branch further in.
    const text = midCommandVerifyClause("graph_save_subgraph");
    expect(text).toMatch(/panel_list_subgraphs/);
    expect(text).not.toMatch(/panel_query_graph/);
    expect(text).not.toMatch(/queue action:"list"/);
    // And the reason a blind retry is bad here is specific: a name collision.
    expect(text).toMatch(/collides on the name/);
  });

  it("graph_copy_nodes says nothing can check it — and to just re-issue", () => {
    // The clipboard is not readable and the graph is unchanged, so no reader is
    // evidence. This is the ONE interrupted write where retrying is correct: a second
    // copy of the same nodes is the same clipboard.
    const text = midCommandVerifyClause("graph_copy_nodes");
    expect(text).toMatch(/clipboard is not readable/);
    expect(text).toMatch(/Just re-issue it/);
    expect(text).not.toMatch(/panel_query_graph/);
    expect(text).not.toMatch(/panel_list_subgraphs/);
  });

  it("the two carve-outs are checked BEFORE the generic graph_ branch", () => {
    // Ordering is the whole mechanism — both names start with "graph_", so a branch
    // placed after the prefix test would never be reached.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../services/mid-command-remedy.ts"),
      "utf8",
    );
    const lib = src.indexOf("LIBRARY_COMMANDS.has(cmd)");
    const clip = src.indexOf("CLIPBOARD_COMMANDS.has(cmd)");
    const generic = src.indexOf('cmd.startsWith("graph_")');
    expect(lib).toBeGreaterThan(-1);
    expect(clip).toBeGreaterThan(-1);
    expect(lib).toBeLessThan(generic);
    expect(clip).toBeLessThan(generic);
  });

  it("an ordinary content edit is unaffected by the carve-outs", () => {
    expect(midCommandVerifyClause("graph_set_widget")).toMatch(/panel_query_graph/);
    expect(midCommandVerifyClause("graph_add_subgraph")).toMatch(/panel_query_graph/);
  });
});

describe("#646 workflow navigation has a reader too", () => {
  it("workflow_open / workflow_new name the OPEN RECEIPT, not `active`", () => {
    // Found by running the LIVE panel's registered command names through the
    // classifier after the fix merged: these two fell to the default branch, which
    // names no tool. Not wrong — but a reader that can answer exists, and naming it
    // is what this module is for. An opened or newly created workflow appears in
    // panel_list_workflows exactly as a saved or renamed one does; the fence treats
    // navigation differently, but the EVIDENCE is the same.
    for (const cmd of ["workflow_open", "workflow_new"]) {
      const text = midCommandVerifyClause(cmd);
      // The REPLY KEY is `last_open`. codex round 2: the first version said
      // `last_open_receipt`, which is the panel's local VARIABLE name and not a field
      // any reply carries — a confidently named thing that does not exist, which is
      // the defect this module was written to remove. Both directions asserted.
      expect(text, cmd).toMatch(/`last_open`/);
      expect(text, cmd).not.toMatch(/last_open_receipt/);
      // codex review, P1: the first attempt named panel_list_workflows and stopped
      // there, on the reasoning that an opened workflow appears in it. The panel had
      // already written the rebuttal — after a backend reconnect the frontend restores
      // a tab BY ITSELF, so `active` matching your target is not proof your open ran.
      // Naming that as the check would have been this module's own defect, for the one
      // command class that already has a purpose-built correct mechanism.
      expect(text, cmd).toMatch(/Do NOT conclude anything from `active`/);
      // The instruction AND the reason. A mutation that kept "restores a tab by
      // itself" but deleted what it explains survived an earlier version of this —
      // and the causal half is the part that stops an agent reasoning its way back
      // to `active` ("but it matched, so surely…").
      expect(text, cmd).toMatch(/restores a tab by\s+itself/);
      expect(text, cmd).toMatch(/without your command ever running/);
      // A receipt is over-readable without the rule that scopes it.
      expect(text, cmd).toMatch(/answers ONLY for the command whose id equals/);
      expect(text, cmd).not.toMatch(/panel_query_graph/);
      expect(text, cmd).not.toMatch(/queue action:"list"/);
    }
    // All three applied states, because they demand different actions.
    const open = midCommandVerifyClause("workflow_open");
    expect(open).toMatch(/`applied:true`/);
    expect(open).toMatch(/`applied:false`.*safe to re-issue/);
    expect(open).toMatch(/must NOT be blindly retried/);
    // And the specific cost of a blind retry, which differs from the mutators'.
    // Asserted as a PROPERTY — that the cost of a blind retry is stated, and stated
    // for workflow_new specifically. A control mutation swapping "empty" for "blank"
    // killed the literal form, which punishes rewording rather than protecting
    // behaviour.
    const nw = midCommandVerifyClause("workflow_new");
    expect(nw).toMatch(/blind retry costs/);
    expect(nw).toMatch(/second workflow_new/);
  });

  it("navigation is still NOT treated as an active-workflow mutator", () => {
    // The two sets stay separate: ui-bridge deliberately excludes navigation from
    // ACTIVE_WORKFLOW_MUTATORS, and collapsing them here would blur a real
    // distinction even though both happen to share a reader.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../services/mid-command-remedy.ts"),
      "utf8",
    );
    expect(src).toMatch(/const WORKFLOW_NAVIGATION = new Set/);
    const mutators = src.slice(src.indexOf("const WORKFLOW_MUTATORS"));
    const block = mutators.slice(0, mutators.indexOf("]"));
    expect(block).not.toMatch(/workflow_open|workflow_new/);
  });
});


// ===========================================================================
// panel#1217 — a media card was told to "verify that it applied", and nothing
// can.
//
// `panel_show_media` was interrupted by a mobile tab disconnect after dispatch
// and got the DEFAULT branch: "Verify that it applied before retrying, rather
// than re-issuing it blindly". That is the same defect shape as #952 and #646 —
// a check named that cannot hold the answer. The panel's chat has no read-back,
// so no tool can say whether the card painted; and the warning against retrying
// is backwards here, because a duplicate media card is the one duplicate that
// costs the user nothing (no GPU time, no answer owed). The honest settlement
// is to re-issue and disclose the possible repeat.
// ===========================================================================
describe("#1217 show_media gets a remedy that can actually settle it", () => {
  const MEDIA = { short: "mobile-c", cmd: "show_media" };

  it("does NOT fall to the generic default — that is the reported defect", () => {
    const msg = midCommandDisconnectMessage(MEDIA);
    expect(msg).not.toMatch(/Verify that it applied/);
    expect(msg).not.toMatch(/a retry may apply it twice/);
    // And none of the other branches' readers — none of them can see the chat.
    expect(msg).not.toMatch(/queue action:"list"/);
    expect(msg).not.toMatch(/panel_query_graph/);
    expect(msg).not.toMatch(/panel_list_workflows/);
  });

  it("says WHY it is unverifiable instead of pretending a check exists", () => {
    // Same honesty as the interactive branch: name the missing reader, so the
    // caller stops looking for one.
    const msg = midCommandDisconnectMessage(MEDIA);
    expect(msg).toMatch(/chat cannot be read back/);
  });

  it("makes re-issuing the settlement, and says what a duplicate costs", () => {
    // The property that distinguishes show_media from ask_user: the retry is
    // safe, not merely unavoidable. The cost comparison is what lets the agent
    // reason instead of memorise — a run would cost GPU time, a question would
    // be owed an answer, a media card asks for neither.
    const msg = midCommandDisconnectMessage(MEDIA);
    expect(msg).toMatch(/Re-issue the same panel_show_media/);
    expect(msg).toMatch(/shows the same media twice|same media twice/);
    expect(msg).toMatch(/GPU time/);
    expect(msg).toMatch(/answer owed/);
  });

  it("discloses the duplicate instead of hiding it — suppression is keyed to the dead socket", () => {
    // The retry runs fresh (the dedupe ledger does not carry across the
    // reconnect), so if the original DID paint, the user sees two. Said plainly,
    // with what to tell the user — the same disclosure the interactive branch
    // makes, inverted: there it is the reason NOT to retry, here it is the
    // price OF the retry.
    const msg = midCommandDisconnectMessage(MEDIA);
    expect(msg).toMatch(/keyed to the socket that dropped/);
    expect(msg).toMatch(/may see two/);
    expect(msg).toMatch(/not new content/);
  });

  it("offers the zero-duplicate route: ask the user first", () => {
    // The one observer of the panel's chat that always exists is the person
    // looking at it.
    expect(midCommandVerifyClause("show_media")).toMatch(/ask the user whether it appeared/);
  });

  it("the applied half names the media, not a generic write", () => {
    // "the panel may have applied it (for a run, ComfyUI may already be
    // rendering)" describes a render; for show_media the thing that may have
    // happened is the card painting.
    const msg = midCommandDisconnectMessage(MEDIA);
    expect(msg).toMatch(/media may already be on screen/);
    expect(msg).not.toMatch(/ComfyUI may already be rendering/);
  });

  it("still reports OUTCOME UNKNOWN and the tab, like every other branch", () => {
    const msg = midCommandDisconnectMessage(MEDIA);
    expect(msg).toMatch(/disconnected mid-command \("show_media"\)/);
    expect(msg).toMatch(/OUTCOME UNKNOWN/);
    expect(msg).toContain("mobile-c");
  });

  it("show_media is NOT classified as interactive — the advice differs for a reason", () => {
    // An ask card and a media card share the missing reader, but the remedies
    // are opposites (retry endangers one, settles the other). If these
    // classifiers ever merge, one of them gets the other's advice.
    expect(isInteractiveCommand("show_media")).toBe(false);
    const media = midCommandVerifyClause("show_media");
    const ask = midCommandVerifyClause("ask_user");
    expect(media).not.toBe(ask);
    expect(media).not.toMatch(/will NOT reach you/);
  });
});
