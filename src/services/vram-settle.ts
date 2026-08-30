/** Poll interval between /system_stats reads after /free (#2050). */
export const VRAM_SETTLE_INTERVAL_MS = 250;
/** Do not treat an unchanged first reading as settled — CUDA may not have started releasing yet. */
export const VRAM_SETTLE_MIN_MS = 1_000;
/** Hard cap so a card that never plateaus still returns a number. */
export const VRAM_SETTLE_TIMEOUT_MS = 5_000;

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
 */
export async function settleUntilStable<T>(
  read: () => Promise<T | null>,
  signatureOf: (value: T) => string,
): Promise<T | null> {
  const started = Date.now();
  const deadline = started + VRAM_SETTLE_TIMEOUT_MS;
  let lastSig: string | null = null;
  let sawChange = false;

  for (;;) {
    let current: T | null;
    try {
      current = await read();
    } catch {
      return null;
    }
    if (current == null) return null;

    const sig = signatureOf(current);
    const elapsed = Date.now() - started;
    if (lastSig !== null && sig !== lastSig) sawChange = true;
    const stable = lastSig !== null && sig === lastSig;
    lastSig = sig;

    if (stable && (sawChange || elapsed >= VRAM_SETTLE_MIN_MS)) {
      return current;
    }
    if (elapsed >= VRAM_SETTLE_TIMEOUT_MS) {
      return current;
    }

    const wait = Math.min(VRAM_SETTLE_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (wait <= 0) return current;
    await sleep(wait);
  }
}
