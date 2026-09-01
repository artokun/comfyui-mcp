// #2692 — nine `get_image action:"view"` results were forwarded in ONE code-mode IPC frame
// and came to 108,765,829 bytes against a 67,108,864-byte limit, losing the whole response.
// The #1495 per-image budget cannot see a batch; this ledger can, because the members of a
// batch are in flight together.
//
// The claim these tests defend is narrow and has two halves, and BOTH have to hold or the
// change is not worth shipping: a batch is charged in proportion to its width, and a call
// that overlaps nothing is charged nothing at all.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGGREGATE_INLINE_BYTES,
  acquireInlineImageSlot,
  aggregateInlineBudgetBytes,
  budgetShortfallNote,
  openInlineImageSlots,
  resetInlineImageSlots,
} from "../../services/inline-frame-budget.js";
import { DEFAULT_INLINE_BUDGET_BYTES } from "../../services/inline-preview.js";

describe("the inline frame budget shares one transport frame between a batch (#2692)", () => {
  beforeEach(() => {
    resetInlineImageSlots();
    delete process.env.COMFYUI_MCP_AGGREGATE_INLINE_BYTES;
  });
  afterEach(() => {
    resetInlineImageSlots();
    delete process.env.COMFYUI_MCP_AGGREGATE_INLINE_BYTES;
  });

  it("a LONE call at the default budget is charged nothing at all", () => {
    // The regression this guards against is the one that would make the fix worse than the
    // bug: an ordinary single fetch getting a smaller preview than it used to. `share` must
    // be the identity on the requested budget whenever there is no batch and the request
    // fits the frame — which is every default call, since 16 MB is a third of the aggregate.
    const slot = acquireInlineImageSlot();
    expect(slot.peak()).toBe(1);
    expect(slot.share(DEFAULT_INLINE_BUDGET_BYTES)).toBe(DEFAULT_INLINE_BUDGET_BYTES);
    expect(DEFAULT_INLINE_BUDGET_BYTES).toBeLessThan(DEFAULT_AGGREGATE_INLINE_BYTES);
    slot.release();
  });

  it("a LONE call asking for MORE than the frame can carry is lowered, and told why", () => {
    // 64 MB of base64 plus its text block does not fit a 64 MiB frame, so honouring the
    // request would produce the very failure #2692 reports. It is clamped — and because a
    // silent clamp is the thing inline-preview.ts exists to prevent, it is also explained.
    const slot = acquireInlineImageSlot();
    const requested = 64 * 1024 * 1024;
    const granted = slot.share(requested);
    expect(granted).toBe(DEFAULT_AGGREGATE_INLINE_BYTES);
    const note = budgetShortfallNote(slot.peak(), requested, granted);
    expect(note).toContain("INLINE LIMIT");
    expect(note).toContain("max_preview_bytes");
    // Not the batch wording: there is no batch, and "fetch fewer at a time" is not a remedy
    // a caller of a single image can act on.
    expect(note).not.toContain("in flight");
    slot.release();
  });

  it("nine overlapping calls divide the aggregate, and their TOTAL fits the frame", () => {
    // The reporter's exact shape: nine assets, each individually legal under #1495, each
    // asking for the full per-image budget.
    const slots = Array.from({ length: 9 }, () => acquireInlineImageSlot());
    const granted = slots.map((s) => s.share(DEFAULT_INLINE_BUDGET_BYTES));

    for (const g of granted) {
      expect(g).toBeLessThan(DEFAULT_INLINE_BUDGET_BYTES);
    }
    // The whole point. Nine unshared budgets come to 150,994,944 bytes, which is what blew
    // the frame; nine shared ones must fit inside the aggregate.
    const total = granted.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(DEFAULT_AGGREGATE_INLINE_BYTES);
    expect(9 * DEFAULT_INLINE_BUDGET_BYTES).toBeGreaterThan(67_108_864);

    for (const s of slots) s.release();
  });

  it("a call already open when the batch widens is re-charged, not grandfathered", () => {
    // The failure this catches is silent and costs exactly one image's worth of overshoot:
    // the first arrival reads peak=1, spends a full budget, and the batch is over the frame
    // by that image no matter how tightly the other eight are squeezed.
    const first = acquireInlineImageSlot();
    expect(first.peak()).toBe(1);

    const rest = Array.from({ length: 8 }, () => acquireInlineImageSlot());
    expect(first.peak()).toBe(9);
    expect(first.share(DEFAULT_INLINE_BUDGET_BYTES)).toBe(
      Math.floor(DEFAULT_AGGREGATE_INLINE_BYTES / 9),
    );

    first.release();
    for (const s of rest) s.release();
  });

  it("the peak is a HIGH-WATER mark — releases do not refund an already-charged call", () => {
    // A member that reads its budget after its siblings have finished must still price
    // itself for the batch it shipped in: every one of those results is already on its way
    // into the same frame.
    const a = acquireInlineImageSlot();
    const b = acquireInlineImageSlot();
    const c = acquireInlineImageSlot();
    expect(a.peak()).toBe(3);
    b.release();
    c.release();
    expect(a.peak()).toBe(3);
    a.release();
  });

  it("sequential calls do not accumulate — a released slot is gone", () => {
    for (let i = 0; i < 20; i++) {
      const s = acquireInlineImageSlot();
      expect(s.peak()).toBe(1);
      expect(s.share(DEFAULT_INLINE_BUDGET_BYTES)).toBe(DEFAULT_INLINE_BUDGET_BYTES);
      s.release();
    }
    expect(openInlineImageSlots()).toBe(0);
  });

  it("release is idempotent and frees only its own slot", () => {
    const a = acquireInlineImageSlot();
    const b = acquireInlineImageSlot();
    a.release();
    a.release();
    expect(openInlineImageSlots()).toBe(1);
    b.release();
    expect(openInlineImageSlots()).toBe(0);
  });

  it("the aggregate is read per call, so an override takes effect without a reimport", () => {
    expect(aggregateInlineBudgetBytes()).toBe(DEFAULT_AGGREGATE_INLINE_BYTES);
    process.env.COMFYUI_MCP_AGGREGATE_INLINE_BYTES = "1048576";
    expect(aggregateInlineBudgetBytes()).toBe(1_048_576);

    const slots = Array.from({ length: 4 }, () => acquireInlineImageSlot());
    expect(slots[0].share(DEFAULT_INLINE_BUDGET_BYTES)).toBe(262_144);
    for (const s of slots) s.release();
  });

  it.each([["", DEFAULT_AGGREGATE_INLINE_BYTES], ["nonsense", DEFAULT_AGGREGATE_INLINE_BYTES], ["0", DEFAULT_AGGREGATE_INLINE_BYTES], ["-5", DEFAULT_AGGREGATE_INLINE_BYTES]])(
    "an unusable override (%o) falls back to the default rather than to zero",
    (raw, expected) => {
      // A zero budget would not read as "no limit" — it would refuse every image — so the
      // fallback direction matters more than the parse.
      process.env.COMFYUI_MCP_AGGREGATE_INLINE_BYTES = raw;
      expect(aggregateInlineBudgetBytes()).toBe(expected);
    },
  );

  it("an absurdly small aggregate still grants at least one byte, never zero", () => {
    process.env.COMFYUI_MCP_AGGREGATE_INLINE_BYTES = "1";
    const slots = Array.from({ length: 5 }, () => acquireInlineImageSlot());
    expect(slots[0].share(DEFAULT_INLINE_BUDGET_BYTES)).toBe(1);
    for (const s of slots) s.release();
  });

  it("the note is SILENT when nothing was taken away, and names the remedy when it was", () => {
    // Granted == requested in both arms: no ceiling bit, so there is nothing to explain,
    // and that holds even for a call that WAS part of a wide batch.
    expect(budgetShortfallNote(1, 1000, 1000)).toBe("");
    expect(budgetShortfallNote(9, 1000, 1000)).toBe("");
    const note = budgetShortfallNote(9, DEFAULT_INLINE_BUDGET_BYTES, 5_592_405);
    expect(note).toContain("9 image fetches were in flight");
    // The consequence is the part an agent cannot infer: the frame takes the whole response
    // with it, so retrying the biggest image alone is not the fix.
    expect(note).toContain("WHOLE response");
    expect(note).toContain("Fetch fewer at a time");
  });
});

describe("slots track real overlapping async work, not just synchronous acquisition", () => {
  beforeEach(() => resetInlineImageSlots());
  afterEach(() => resetInlineImageSlots());

  it("nine concurrent handlers each price themselves for nine", async () => {
    // Measured against a real spawned stdio MCP server before this was built: nine parallel
    // `tools/call` requests for a 150 ms handler completed in 166 ms and every handler
    // observed nine slots open. This reproduces that overlap in-process, which is what the
    // production wiring depends on.
    const granted = await Promise.all(
      Array.from({ length: 9 }, async () => {
        const slot = acquireInlineImageSlot();
        try {
          await new Promise((r) => setTimeout(r, 10));
          return slot.share(DEFAULT_INLINE_BUDGET_BYTES);
        } finally {
          slot.release();
        }
      }),
    );
    expect(granted.every((g) => g === Math.floor(DEFAULT_AGGREGATE_INLINE_BYTES / 9))).toBe(true);
    expect(granted.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(DEFAULT_AGGREGATE_INLINE_BYTES);
    expect(openInlineImageSlots()).toBe(0);
  });

  it("a THROWING handler does not leak its slot into the next batch", async () => {
    // A leaked slot fails silently: it narrows every later preview in the process on behalf
    // of a batch that finished long ago, and nothing about that symptom points here.
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const slot = acquireInlineImageSlot();
        try {
          await Promise.reject(new Error("fetch blew up"));
        } catch {
          // swallowed, as the tool handler's own catch does
        } finally {
          slot.release();
        }
      }),
    );
    expect(openInlineImageSlots()).toBe(0);
    const after = acquireInlineImageSlot();
    expect(after.share(DEFAULT_INLINE_BUDGET_BYTES)).toBe(DEFAULT_INLINE_BUDGET_BYTES);
    after.release();
  });
});
