/**
 * #2692 — A PER-IMAGE BUDGET CANNOT BOUND A FRAME THAT CARRIES N IMAGES.
 *
 * #1495 capped what ONE inline image may spend (`DEFAULT_INLINE_BUDGET_BYTES`, ~16 MB
 * of base64) against Codex code-mode's hard 64 MiB IPC frame. That cap is correct and
 * it holds — as long as one image rides in one frame.
 *
 * In code-mode it does not. The agent's script awaits several tool calls and forwards
 * every returned image from a single batch, so N results are serialized into ONE frame.
 * The reporter's nine 3648x5472 assets came to 108,765,829 bytes against the
 * 67,108,864-byte limit, and the response was lost whole — including the eight images
 * that were not the problem. Measured here on a synthetic source of the reported
 * dimensions: even WITH the #1495 bound applied, each asset lands at ~11.1 MB of base64
 * and nine of them come to ~99.8 MB. So bounding each image is necessary and is not
 * sufficient; the batch needs a ceiling of its own.
 *
 * WE DO NOT OWN THE FRAME. Chunking it, or yielding several frames, belongs to
 * codex-code-mode-host — both the limit and the wording of the error come out of that
 * binary, not out of this repo. What this server owns is every byte that goes INTO the
 * frame, so the ceiling is enforced at emission.
 *
 * THE SIGNAL IS CONCURRENCY, NOT A CLOCK. A time window would have to guess which calls
 * share a frame, and it would shrink previews for a client that merely fetched several
 * images in a row — a real regression traded for a guess. The calls of a batch that is
 * AWAITED TOGETHER — which is the shape the report describes, and the shape `Promise.all`
 * produces — are in flight together, and that is directly observable from inside a handler.
 *
 * MEASURED, against a real spawned stdio server rather than the in-memory pump, because
 * the whole design rests on it: nine parallel `tools/call` requests for a handler that
 * sleeps 150 ms completed in 166 ms, not 1350 ms, and every one of the nine handlers
 * observed nine slots held at once. Handlers overlap, and they are ADMITTED before any of
 * them completes — a request already written to the pipe is read in microseconds, while the
 * handler holding a slot is waiting on an HTTP fetch of a multi-megabyte image. So a
 * "staggered" arrival in which one parallel call releases before its sibling is admitted is
 * not a shape this transport produces.
 *
 * WHAT THIS DOES NOT COVER, stated plainly because the reservation is per-call and NOT per
 * frame: a script that awaits its fetches ONE AT A TIME and forwards the results together.
 * Each of those sees a peak of one, spends a full per-image budget, and five of them
 * overrun the frame exactly as a parallel batch would.
 *
 * That gap is not closable from here, and the arithmetic says why rather than the intuition.
 * By the time the fifth call runs, the first four have already been serialized and sent;
 * nothing this call does can shrink them. Preventing it would mean charging EVERY call as
 * though a sequence might follow — permanently lowering the single-image budget to
 * aggregate/N for an N nobody knows — which is the regression this whole design refuses. A
 * decaying cumulative cap fares no better in either direction: without a floor the fourth
 * image in any session refuses, and with a floor of aggregate/16 nine sequential images
 * still come to ~66 MB and overrun anyway.
 *
 * Reserving across a whole frame requires seeing the frame, and only the code-mode host
 * does. That is why #2692 asks for chunking THERE, and it remains the complete fix; this
 * bounds the shape that is visible from this side.
 *
 * WHY THE DEFAULT SINGLE-IMAGE PATH IS UNCHANGED. A call that overlaps nothing sees a peak
 * of one, so its share is the whole aggregate — 48 MB, three times the #1495 per-image
 * budget — and `share()` returns the requested budget untouched. Every lone fetch that took
 * the default is byte-for-byte what it was before this file existed.
 *
 * The one lone call that IS clamped is a caller who explicitly asked for MORE than the
 * aggregate. That request could never have been delivered — 64 MB of base64 plus its text
 * block does not fit a 64 MiB frame — so it is lowered rather than honoured, and
 * `budgetShortfallNote` says so instead of leaving the caller to wonder why the preview is
 * smaller than the number they passed. A shrink nobody explains is the failure mode
 * `inline-preview.ts` exists to avoid.
 */

/**
 * The transport ceiling being budgeted against: Codex code-mode's hard IPC frame limit.
 *
 * Quoted, not chosen — this is the 67108864 from the reporter's error, and it lives in
 * `codex-code-mode-host`. It is here so the notice can name the number an agent will see
 * if the budget is bypassed, never as something this repo can change.
 */
export const CODE_MODE_FRAME_BYTES = 67_108_864;

/**
 * How much of that frame inline image payloads may claim in total.
 *
 * 75% of the limit. The remainder is not slack: the same frame also carries the text
 * block that accompanies every image, the JSON-RPC envelope, and the script's own return
 * value, and none of those are measurable from here. A budget set at the limit itself
 * would be a budget that fails at the limit.
 */
export const DEFAULT_AGGREGATE_INLINE_BYTES = 48 * 1024 * 1024;

/**
 * Read the aggregate budget.
 *
 * Deliberately read PER CALL rather than frozen at module load: a client on a transport
 * with a different frame size needs to be able to set this, and a module-scope constant
 * would bake in whichever value happened to be in the environment when the tool registry
 * was first imported.
 */
export function aggregateInlineBudgetBytes(): number {
  const raw = Number(process.env.COMFYUI_MCP_AGGREGATE_INLINE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_AGGREGATE_INLINE_BYTES;
}

/** One open inline-image tool call, and the widest batch it has been part of. */
interface OpenSlot {
  peak: number;
}

const open = new Set<OpenSlot>();

export interface InlineImageSlot {
  /** The widest batch this call has been part of, at least 1. */
  peak(): number;
  /**
   * The budget this call may actually spend, given the batch it is in: the smaller of
   * what the caller asked for and this call's share of the aggregate.
   */
  share(requested: number): number;
  /**
   * Give the slot back. Idempotent, so a `finally` that also runs on a path that already
   * released cannot narrow an unrelated batch by deleting a stranger's entry.
   */
  release(): void;
}

/**
 * Open one inline-image slot. ALWAYS release it in a `finally`.
 *
 * A leaked slot never fails loudly — it silently narrows every later preview in the process
 * on behalf of a batch that finished long ago, which is the kind of degradation nobody
 * would trace back to this file.
 *
 * Acquire around the WHOLE tool call, fetch included — not just around the encode. A batch
 * member that has finished downloading while its siblings are still in flight must still
 * see them, or it spends a full per-image budget and the batch overshoots by exactly that
 * image.
 *
 * `peak()` and `share()` are read LAZILY on purpose: they are consulted after the fetch has
 * awaited, by which point every sibling has been admitted. A number captured at entry would
 * read the batch at its narrowest, which is the one reading that cannot protect anything.
 */
export function acquireInlineImageSlot(): InlineImageSlot {
  const self: OpenSlot = { peak: 0 };
  open.add(self);
  // Raise the peak on EVERY open slot, not only on the newcomer. The slots already open
  // have just become part of a wider batch, and they are the ones that would otherwise keep
  // a peak of 1 and spend a full per-image budget while their siblings queue up behind
  // them. Set-iteration cost is O(open) per acquisition and `open` is a handful of entries;
  // it is bounded by how many tool calls a client has outstanding at once.
  for (const slot of open) {
    if (open.size > slot.peak) slot.peak = open.size;
  }
  return {
    peak: () => Math.max(1, self.peak),
    share: (requested) => {
      const perCall = Math.floor(aggregateInlineBudgetBytes() / Math.max(1, self.peak));
      // `Math.max(1, …)` keeps the contract with boundInlineImage, which clamps a budget to
      // at least 1 anyway: an absurd COMFYUI_MCP_AGGREGATE_INLINE_BYTES must degrade to a
      // tiny preview, never to a zero-byte budget that reads as "no limit" somewhere.
      return Math.max(1, Math.min(requested, perCall));
    },
    // Closes over its OWN entry, so releasing is exact and idempotent — `Set.delete` of an
    // already-removed entry is a no-op, and no caller can reach or free a stranger's slot.
    release: () => {
      open.delete(self);
    },
  };
}

/** Test hook: how many slots are open. Zero between calls, or something leaked. */
export function openInlineImageSlots(): number {
  return open.size;
}

/** Test hook: drop every slot. Never called in production. */
export function resetInlineImageSlots(): void {
  open.clear();
}

const MB = 1_048_576;

/**
 * The sentence a call owes its caller when THIS file, rather than the image's own size,
 * is what lowered its budget.
 *
 * A preview that is smaller than the caller asked for, with no reason given, is the exact
 * failure mode `inline-preview.ts` refuses to ship: an agent reads fine detail off a
 * downscaled image and reports confidently. So both ways the ceiling can bite are said out
 * loud, and each names the remedy that actually works for it.
 *
 * Empty when nothing was taken away — `granted >= requested`. A "BATCH LIMIT" line on a
 * call that was not limited is how a reader learns to skip the line on the call where it is
 * load-bearing.
 */
export function budgetShortfallNote(peak: number, requested: number, granted: number): string {
  if (granted >= requested) return "";
  const frame = `A code-mode client packs a whole batch into ONE ${Math.round(CODE_MODE_FRAME_BYTES / MB)} MB transport frame, and overrunning it loses the WHOLE response rather than the largest image.`;
  if (peak > 1) {
    return (
      ` BATCH LIMIT: ${peak} image fetches were in flight at once, so this one was allowed ` +
      `~${Math.round(granted / MB)} MB of a shared ${Math.round(aggregateInlineBudgetBytes() / MB)} MB ` +
      `inline budget. ${frame} Fetch fewer at a time for a larger preview.`
    );
  }
  // Lone call, explicit over-ask. There is no batch to blame and no "fetch fewer" remedy —
  // the requested number simply cannot ride the transport, so say which number won.
  return (
    ` INLINE LIMIT: max_preview_bytes was ~${Math.round(requested / MB)} MB but the inline ` +
    `budget is ~${Math.round(aggregateInlineBudgetBytes() / MB)} MB, so ~${Math.round(granted / MB)} MB ` +
    `was used. ${frame} Read the full-resolution file instead of raising the number.`
  );
}
