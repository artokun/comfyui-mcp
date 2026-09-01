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
   * `progressOf` of a reading taken BEFORE the mutation. Supply it and
   * stillness stops being read as "settled": the release is only proven once
   * the counters move away from this value.
   *
   * Omit it (or pass null) when no pre-mutation sample exists, or when the card
   * was idle enough that no release is expected. The loop then accepts any
   * reading that holds steady past the min wait — which cannot tell "released"
   * from "not started yet", so `settled` is the only honest thing separating
   * the two cases.
   */
  baseline?: string | null;
  /**
   * The projection whose movement PROVES the release landed, defaulting to
   * `signatureOf`.
   *
   * #2704 — these must be allowed to differ. `signatureOf` covers everything
   * the caller reports, so it includes the torch pool; but the torch pool
   * releases in ~400ms while the driver number lags seconds behind it. Testing
   * movement against the combined signature would let that torch movement stand
   * in as proof the DRIVER released — which is the original bug wearing a
   * baseline. Narrow this to the counter that actually lags.
   */
  progressOf?: (value: T) => string;
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
  const progressOf = options.progressOf ?? signatureOf;
  const started = Date.now();
  const deadline = started + VRAM_SETTLE_TIMEOUT_MS;
  let lastSig: string | null = null;
  // Latched: a reading that moves off `baseline` proves the release landed even
  // if a later sample happens to match `baseline` again.
  let releaseSeen = false;

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
    if (baseline !== null && progressOf(current) !== baseline) releaseSeen = true;
    const stable = lastSig !== null && sig === lastSig;
    lastSig = sig;

    // With a baseline, stillness counts only AFTER the release is observed.
    // Without one, keep the pre-#2704 rule — a reading that is stable past the
    // min wait is accepted, because there is nothing available to prove it is
    // anything better than a guess. `sawChange` no longer SHORTENS that wait:
    // on the #2704 card the torch pool moving was enough to satisfy it, which
    // is precisely how a frozen driver number got returned at ~780ms.
    const releaseObserved = baseline !== null ? releaseSeen : true;

    if (stable && releaseObserved && elapsed >= VRAM_SETTLE_MIN_MS) {
      return { value: current, settled: true };
    }
    if (elapsed >= VRAM_SETTLE_TIMEOUT_MS) {
      return { value: current, settled: false };
    }

    const wait = Math.min(VRAM_SETTLE_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (wait <= 0) return { value: current, settled: false };
    await sleep(wait);
  }
}
