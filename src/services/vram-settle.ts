/** Poll interval between /system_stats reads after /free (#2050). */
export const VRAM_SETTLE_INTERVAL_MS = 250;
/** Do not treat an unchanged first reading as settled — CUDA may not have started releasing yet. */
export const VRAM_SETTLE_MIN_MS = 1_000;
/**
 * Hard cap so a card that never plateaus still returns a number.
 *
 * #2704 raised this from 5s. An RTX 5090 on cudaMallocAsync took ~8s for a
 * ~29 GB unload to become visible in /system_stats, so 5s could not cover it.
 * The cap is only ever REACHED when a `baseline` was supplied and the release
 * never landed — a card that releases promptly returns as soon as it plateaus,
 * so this costs nothing on hardware that already worked.
 */
export const VRAM_SETTLE_TIMEOUT_MS = 12_000;

/**
 * "This card is holding memory" — free/total at or below this ratio, on a card
 * big enough for the ratio to mean anything. Mirrors the pin thresholds
 * `panel-tools.ts` already applies to the same counters (#1895), so callers
 * decide whether to wait for a release using one definition of occupied.
 */
export const VRAM_OCCUPIED_FREE_RATIO = 0.2;
export const VRAM_OCCUPIED_MIN_TOTAL_BYTES = 1024 * 1024 * 1024;

export interface SettledRead<T> {
  /** The last reading taken, or null when the source never answered. */
  value: T | null;
  /**
   * True only when the loop could JUSTIFY the plateau it returned: it saw the
   * counters move off `baseline` and then hold. False means the value is
   * returned unconfirmed (the cap was reached, or nothing was read) and the
   * caller must not present it as a measured post-release figure.
   */
  settled: boolean;
}

export interface SettleOptions<T> {
  /**
   * Identity -> pre-mutation value, one entry per unit expected to release.
   * Supply it and stillness stops being read as "settled": the release is
   * proven only once EVERY entry has moved.
   *
   * Per-unit rather than one combined string because a joined signature changes
   * as soon as ANY unit moves. On a two-GPU box that lets card 0 releasing
   * certify card 1, whose driver counter never moved at all — the same
   * substitution the torch pool was making, one level up.
   *
   * Keyed by identity rather than position because a device list can REORDER
   * between samples. Matching by index would then compare card 0's value
   * against card 1's, read every watched card as moved, and certify a wholly
   * unreleased box.
   *
   * Only include units a release is actually expected from: a card that was
   * already free will never move, and demanding movement from it would spend
   * the whole cap waiting for something that is not coming.
   *
   * Omit it (or pass null) when nothing needs proving.
   */
  baseline?: ReadonlyMap<string, string> | null;
  /**
   * Identity -> current value, using the same identities as `baseline`.
   * Defaults to `signatureOf`'s value under a single fixed key.
   *
   * #2704 — this must be allowed to differ from `signatureOf`. `signatureOf`
   * covers everything the caller reports, so it includes the torch pool; but
   * the torch pool releases in ~400ms while the driver number lags seconds
   * behind it. Testing movement against the combined signature would let that
   * torch movement stand in as proof the DRIVER released — which is the
   * original bug wearing a baseline. Narrow this to the counters that lag.
   */
  progressOf?: (value: T) => ReadonlyMap<string, string>;
  /**
   * False when the caller could not establish a baseline it TRUSTS — typically
   * the pre-mutation read failed. The loop still returns on a plateau (there is
   * nothing to be gained by waiting out the cap), but never reports it as
   * confirmed.
   *
   * This is the difference between "idle card, nothing to release, the reading
   * is good" and "we have no idea whether this released" — both arrive with no
   * baseline, and collapsing them would let an unprovable reading be published
   * as a measured one, which is the bug this whole change is about.
   */
  confirmable?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * /free answers when ComfyUI drops model refs; CUDA/driver release can lag.
 * Poll `read` until `signatureOf` stops changing (or the cap) so the value
 * matches a follow-up get_system_stats (action:"stats") (#2050).
 *
 * A failed or null read returns null rather than the previous sample: /free
 * may have released memory between the two, so returning the prior sample
 * would report a known-stale VRAM figure as if it were current.
 *
 * #2704 — WHY A `baseline` IS THE LOAD-BEARING PART, and not the cap.
 * Waiting for the counters to "stop changing" cannot distinguish a plateau
 * from a release that has not started, because both are perfectly still. On
 * the reported RTX 5090 the torch pool released in ~400ms while the DRIVER
 * number stayed frozen at its pre-/free value for ~8s; the torch movement
 * satisfied the change-then-plateau test, so the loop returned the frozen
 * driver number after ~780ms and never came close to the 5s cap. Raising the
 * cap alone changes nothing — measured: both 5s and 12s returned the same
 * stale 2805 MB at ~775ms. Comparing against a pre-mutation sample is what
 * turns the unanswerable "is this still?" into the answerable "has anything
 * been released yet?".
 */
export async function settleUntilStable<T>(
  read: () => Promise<T | null>,
  signatureOf: (value: T) => string,
  options: SettleOptions<T> = {},
): Promise<SettledRead<T>> {
  const baseline = options.baseline ?? null;
  const progressOf =
    options.progressOf ?? ((value: T) => new Map([["", signatureOf(value)]]));
  const confirmable = options.confirmable ?? true;
  const started = Date.now();
  const deadline = started + VRAM_SETTLE_TIMEOUT_MS;
  let lastSig: string | null = null;
  // Identities still sitting on their pre-mutation value. Emptying is LATCHED
  // per identity: a unit that moves has demonstrably released, even if a later
  // sample happens to land back on the baseline value.
  const unmoved = new Set<string>(baseline ? baseline.keys() : []);

  for (;;) {
    let current: T | null;
    try {
      current = await read();
    } catch {
      return { value: null, settled: false };
    }
    if (current == null) return { value: null, settled: false };

    const sig = signatureOf(current);
    const elapsed = Date.now() - started;
    if (baseline !== null && unmoved.size > 0) {
      const now = progressOf(current);
      for (const id of [...unmoved]) {
        const seen = now.get(id);
        // A device that VANISHED from the sample proves nothing — absence is
        // not a release. Leave it unmoved and let the cap expire into an
        // honest "unconfirmed" rather than certifying a value we cannot see.
        if (seen !== undefined && seen !== baseline.get(id)) unmoved.delete(id);
      }
    }
    const stable = lastSig !== null && sig === lastSig;
    lastSig = sig;

    // With a baseline, stillness counts only AFTER every unit has released.
    // Without one there is nothing available to prove, so a plateau past the
    // min wait is accepted — and `confirmable` says whether that plateau may be
    // reported as a measured result. The old rule let ANY change shorten the
    // min wait, which is how the torch pool moving returned a frozen driver
    // number at ~780ms.
    const releaseObserved = baseline === null || unmoved.size === 0;

    if (stable && releaseObserved && elapsed >= VRAM_SETTLE_MIN_MS) {
      return { value: current, settled: baseline !== null ? true : confirmable };
    }
    if (elapsed >= VRAM_SETTLE_TIMEOUT_MS) {
      return { value: current, settled: false };
    }

    const wait = Math.min(VRAM_SETTLE_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (wait <= 0) return { value: current, settled: false };
    await sleep(wait);
  }
}
