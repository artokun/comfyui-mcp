// #952 (panel) — an interactive question card was told to go and check the
// render queue.
//
// `panel_ask` was interrupted by a tab disconnect, and the OUTCOME UNKNOWN error
// ended with the only remedy this path has ever offered:
//
//   Verify before retrying (e.g. check queue action:"list" /
//   get_image (action:"list_outputs")) instead of re-issuing it blindly.
//
// The reporter's objection is exact: "The suggested verification examples concern
// render queues/media and do not apply to an ask card." Neither of those tools
// can tell you whether a question is currently on a human's screen.
//
// WHY THIS IS NOT COSMETIC. The panel-side trace on that issue established that
// for THIS trigger a blind retry really does duplicate the card: the dedupe
// ledger is keyed by the socket's bridge epoch, a reconnect mints a new one, so
// the retry lands in a different scope, `lookupRetry` misses, and it fails open
// and re-executes. Failing open is right for a read or an idempotent write —
// re-running one is cheaper than refusing. It is wrong for a question, because
// the cost is a second card in front of a person and there is no way to withdraw
// the first.
//
// So the remedy has to say what actually applies. What it must NOT do is invent
// a recovery: there is no pending-card query today, and `retry_of` does not help
// across a reconnect for the reason above. Both of those are open design
// questions on the issue and this does not pre-empt them.

/** Panel commands that put something in front of a HUMAN and wait. */
const INTERACTIVE_COMMANDS = new Set(["ask_user", "request_secret"]);

export function isInteractiveCommand(cmd: string): boolean {
  return INTERACTIVE_COMMANDS.has(String(cmd ?? "").trim());
}

/**
 * The "verify before retrying" clause, chosen by what the command actually did.
 *
 * The point of OUTCOME UNKNOWN is that the caller checks instead of retrying blind.
 * That only works if the check named can actually hold the answer — and for a graph
 * write it did not. Every non-interactive command got the same sentence:
 *
 *     Verify before retrying (e.g. check queue action:"list" /
 *     get_image (action:"list_outputs"))
 *
 * which is RENDER evidence. panel#646's interrupted command was `graph_set_widget`.
 * Neither the queue nor the output list can say whether a widget edit landed, so an
 * agent following that advice looks somewhere structurally incapable of answering,
 * learns nothing, and ends up exactly where the message was trying to keep it from:
 * retry blindly or give up. The old doc here asserted the queue check was "real
 * evidence for a run or a write". It is evidence for a run.
 *
 * So the kinds are separated by WHAT CAN BE OBSERVED:
 *
 *  • an INTERACTIVE card — nothing in the tool surface can observe it, the answer
 *    will NEVER arrive, and a retry duplicates the card in front of a human.
 *  • a RUN — the queue and the output list are exactly right, and stay.
 *  • a GRAPH WRITE — read the graph back. A graph read is idempotent and safe to
 *    run the instant a tab is connected, which makes it a better check than
 *    anything the run path offers. This branch is LAST among the graph_* kinds:
 *    the prefix alone does not mean the effect is on the canvas, and the two cases
 *    above are the ones where it is not.
 *  • a WORKFLOW mutator — the workflow list, not the graph: these change which
 *    workflows exist or are open, which a canvas read does not see.
 *  • a LIBRARY write (`graph_save_subgraph`) — panel_list_subgraphs. The graph is
 *    identical after a blueprint save, so both graph readers show what they showed
 *    before and prove nothing (codex review).
 *  • a CLIPBOARD write (`graph_copy_nodes`) — nothing can read the clipboard, and
 *    the graph is unchanged. Re-issuing is the right answer: a second copy of the
 *    same nodes is the same clipboard.
 *  • a MEDIA display (`show_media`) — nothing can read the chat back either, but
 *    re-issuing is safe in a different way: a duplicate media card costs the user
 *    nothing, so the retry IS the settlement (panel#1217).
 *  • anything else — say to verify without naming tools that may not apply.
 *    Naming a plausible-but-wrong check is what this fix exists to remove; doing
 *    it again in the default branch would be the same defect with a different tool.
 *
 * Classified by NAME here rather than by importing GRAPH_CMD_EFFECT, for two
 * reasons: ui-bridge.ts imports this module, so reading its table would be a cycle;
 * and that table answers a different question (does this need the workflow fence),
 * which is not the same as what evidence exists for it afterwards.
 */
/** The one command whose evidence really is the render queue (panel#646). */
const RUN_COMMAND = "graph_run";

/** Writes to the user's blueprint LIBRARY, not to the canvas (codex review, P1).
 *  `graph_save_subgraph` publishes a subgraph as a reusable blueprint; the graph is
 *  unchanged afterwards, so both graph readers show exactly what they showed before
 *  and cannot tell a save that landed from one that did not. `panel_list_subgraphs`
 *  is the reader that can. */
const LIBRARY_COMMANDS = new Set<string>(["graph_save_subgraph"]);

/** Writes the CLIPBOARD, which nothing in the tool surface can read (codex review).
 *  Copying leaves the graph identical, so a canvas read is no evidence at all —
 *  but re-issuing is harmless: a second copy of the
 *  same nodes produces the same clipboard. That makes "just do it again" the
 *  correct advice rather than a dangerous one. */
const CLIPBOARD_COMMANDS = new Set<string>(["graph_copy_nodes"]);

/** Media display into the panel's chat (`show_media`, panel#1217). Like the
 *  interactive branch, nothing in the tool surface can READ BACK whether the
 *  card painted — the chat has no reader — so the interrupted command is
 *  unverifiable. Unlike the interactive branch, a blind retry is not dangerous:
 *  the source file is unchanged, so re-issuing either paints the card that
 *  never landed or shows the same media twice, and a duplicate media card asks
 *  nothing of the user — no GPU time (a run), no answer owed (a question).
 *  That makes "re-issue, and say the repeat may appear" the honest settlement
 *  rather than the generic "verify first", which names a check that cannot
 *  exist. */
const MEDIA_COMMANDS = new Set<string>(["show_media"]);

/** The four active-workflow mutators. A canvas read cannot see these — they change
 *  which workflows exist or are open, not what is on the current graph. Mirrors
 *  ACTIVE_WORKFLOW_MUTATORS in ui-bridge.ts, which cannot be imported here (it
 *  imports this module). Duplicated deliberately and kept honest by a test that
 *  reads the ui-bridge source and compares the two. */
const WORKFLOW_MUTATORS = new Set<string>([
  "workflow_save",
  "workflow_save_as",
  "workflow_rename",
  "workflow_close",
]);

/** Workflow NAVIGATION/creation. Deliberately not in ACTIVE_WORKFLOW_MUTATORS — they
 *  carry their own explicit or new target rather than mutating active content, so the
 *  fence treats them differently. The question HERE is evidence, not fencing — and the
 *  evidence for these is NOT the workflow list itself, which is where the first attempt
 *  went wrong.
 *
 *  Found by running the LIVE panel's registered command names through this classifier
 *  after the fix merged — these two fell to the default branch, which names no tool.
 *
 *  The first attempt sent them to `panel_list_workflows` on the reasoning that an opened
 *  workflow appears there. Codex caught it, and the panel had already written the
 *  rebuttal: `active` matching your target is NOT proof your open ran, because after a
 *  backend reconnect the frontend restores a tab BY ITSELF (#433). Naming that reader
 *  would have been the exact defect this module exists to remove — a confident check
 *  that cannot answer — for the one command class that already has a purpose-built
 *  correct mechanism.
 *
 *  That mechanism is the panel's OPEN RECEIPTS (#402): every workflow_open/workflow_new
 *  that RAN is journaled with the selector it was asked for, the identity it resolved
 *  to, and whether it applied. The latest one rides in the workflow-list reply as
 *  `last_open` — that is the reply KEY; the panel's local variable is `lastOpenReceipt`,
 *  and naming THAT is how the first version of this shipped a field no reply carries
 *  (codex round 2), which is the very defect this module exists to remove. It answers
 *  ONLY for the command whose id equals its `rid` —
 *  so an EARLIER successful open of the same file is not evidence about a later dropped
 *  one. The message says both halves, because the receipt is over-readable without the
 *  rule that comes with it. */
const WORKFLOW_NAVIGATION = new Set<string>(["workflow_open", "workflow_new"]);

export function midCommandVerifyClause(cmd: string): string {
  if (isInteractiveCommand(cmd)) {
    // WAITING IS NOT A RECOVERY, and an earlier draft of this said it was
    // (codex). Checked against the panel: `redactSensitiveReply` replaces an
    // `ask_user`/`request_secret` reply that cannot cross the dropped connection
    // with a payload-free failure — deliberately, because the content is the
    // user's own input and a replay could land on a different orchestrator. Its
    // own words are "ask again on the current connection". So the answer to the
    // card already on screen will NOT reach you, however long you wait.
    const reissue =
      cmd === "request_secret"
        ? // NEVER route a secret through the conversation (codex). The whole
          // point of this card is a masked input the agent never sees and that
          // is never written to chat history; "just ask them for it" would
          // defeat the guarantee the tool makes.
          `Re-issue panel_request_secret on the current connection — that is what the panel itself ` +
          `advises, and it is the ONLY safe route: never ask the user to paste a secret into the ` +
          `conversation, where you would see it and it would be recorded.`
        : `Re-issue the question on the current connection, or simply ask it in conversation.`;
    return (
      `Nothing in the tool surface can check that — ` +
      `there is no pending-card query — and the answer to it will NOT reach you: the panel ` +
      `deliberately does not replay a reply of this kind across a reconnect (nothing was applied ` +
      `and nothing was stored). ${reissue} Expect the stale card to remain on screen: retry ` +
      `suppression is keyed to the socket that dropped, so this counts as a new command and the ` +
      `user may see two. Tell them which one to answer.`
    );
  }
  if (cmd === RUN_COMMAND) {
    // The one command the original sentence was actually right about.
    return (
      `Verify before retrying (check queue action:"list" / get_image ` +
      `(action:"list_outputs")) instead of re-issuing it blindly — a second run costs ` +
      `GPU time and produces a duplicate output.`
    );
  }
  if (WORKFLOW_NAVIGATION.has(cmd)) {
    return (
      `Verify with panel_list_workflows and read its \`last_open\` — the panel's own ` +
      `execution record for opens (#402). It answers ONLY for the command whose id equals ` +
      `its \`rid\`: \`applied:true\` means it completed, \`applied:false\` means nothing was ` +
      `applied and it is safe to re-issue, \`applied:"unknown"\` means it may have taken ` +
      `effect and must NOT be blindly retried. Do NOT conclude anything from \`active\` ` +
      `matching your target, and do not read an EARLIER receipt for the same file as ` +
      `evidence about this one — after a backend reconnect the frontend restores a tab by ` +
      `itself, which explains a matching \`active\` without your command ever running. A ` +
      `blind retry costs: a second workflow_new leaves the user with two empty tabs.`
    );
  }
  if (WORKFLOW_MUTATORS.has(cmd)) {
    return (
      `Verify with panel_list_workflows before retrying — these change which workflows ` +
      `exist or are open, which a canvas read does not see. Re-issuing blindly can save ` +
      `or close a second time.`
    );
  }
  if (LIBRARY_COMMANDS.has(cmd)) {
    return (
      `Verify with panel_list_subgraphs before retrying — this writes to the blueprint ` +
      `LIBRARY, not to the canvas, so the graph is identical either way and a graph read ` +
      `cannot tell a save that landed from one that did not. If the blueprint is already ` +
      `there, do NOT re-issue it: a second save collides on the name.`
    );
  }
  if (CLIPBOARD_COMMANDS.has(cmd)) {
    return (
      `Nothing in the tool surface can check that — the clipboard is not readable, and the ` +
      `graph is unchanged either way, so neither graph reader is evidence. Just re-issue it: ` +
      `unlike the other interrupted writes, copying the same nodes twice produces the same ` +
      `clipboard, so a retry here costs nothing and settles it.`
    );
  }
  if (MEDIA_COMMANDS.has(cmd)) {
    return (
      `Nothing in the tool surface can check that — the panel's chat cannot be read back, ` +
      `so you cannot see whether the card painted. Re-issue the same panel_show_media on the ` +
      `current connection: the source file is unchanged, so the retry either paints the card ` +
      `that never landed or shows the same media twice — and a duplicate media card asks ` +
      `nothing of the user, unlike a second render (GPU time) or a second question card (an ` +
      `answer owed). Retry suppression is keyed to the socket that dropped, so the retry runs ` +
      `fresh and the user may see two; if it appears twice, tell them the repeat is the retry, ` +
      `not new content. If even that is unwanted, ask the user whether it appeared first.`
    );
  }
  if (cmd.startsWith("graph_")) {
    return (
      `Verify with a graph READ before retrying — panel_query_graph on the node(s) this ` +
      `touched (or panel_graph_outline for a structural change) and compare against what ` +
      `you asked for. A read is idempotent, so it is safe the moment a tab is connected, ` +
      `and it is the only check that can see a canvas edit: the render queue and the ` +
      `output list cannot (panel#646). If the read shows the change already applied, do ` +
      `NOT re-issue it. If the command only moved the view or the selection, it changed ` +
      `no graph content, so there is nothing to verify and nothing worth re-issuing.`
    );
  }
  // Deliberately names no tool. The defect being fixed was a confidently wrong
  // check; an unrecognised command is exactly where a guess would be wrong again.
  return (
    `Verify that it applied before retrying, rather than re-issuing it blindly — the ` +
    `command reached the panel, so a retry may apply it twice.`
  );
}

/** The full OUTCOME UNKNOWN sentence for a mid-command disconnect. */
export function midCommandDisconnectMessage(opts: { short: string; cmd: string }): string {
  const interactive = isInteractiveCommand(opts.cmd);
  const media = MEDIA_COMMANDS.has(opts.cmd);
  const applied = interactive
    ? `the command was already sent, so the card may already be on screen`
    : media
      ? `the command was already sent, so the media may already be on screen in the panel's chat`
      : `the command was already sent, so the panel may have applied it (for a run, ComfyUI may already be rendering)`;
  return (
    `panel tab ${opts.short} disconnected mid-command ("${opts.cmd}") — OUTCOME UNKNOWN: ` +
    `${applied}. ${midCommandVerifyClause(opts.cmd)}`
  );
}
