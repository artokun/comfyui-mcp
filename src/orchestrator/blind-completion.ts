/**
 * Blind, applied to a run completion.
 *
 * Blind is conversation-wide (#884) and must fail CLOSED (`blind-tab-gate.ts`). A run
 * completion reaches the agent through more than one door: the panel's own `executed`
 * frame arrives at the orchestrator's agent-event ingress, and the #1789 watchdog
 * SYNTHESISES one when that frame never comes.
 *
 * #1861 — the watchdog door recorded the raw payload. That was inert only while its
 * `images` was always empty; #1853 filled it from `/history` and the bypass became live:
 * Blind ON plus a dropped `executed` frame attached the render's pixels to the agent turn
 * ~45 s later. The strip lived inline at one door, so nothing carried it to the next one.
 *
 * It is a pure function here so both doors call the SAME implementation and it can be
 * tested without standing up the orchestrator.
 */

/** The note appended when pixels are withheld. Also overrides a sighted "review this"
 *  instruction that must not be obeyed — the composer renders it verbatim. */
function blindDisclosure(existing: unknown, withheld: number): string {
  const prefix = typeof existing === "string" && existing.trim() ? `${existing.trim()} ` : "";
  return (
    `${prefix}⚠️ Blind mode is ON: ${withheld} image(s) from this run were withheld ` +
    `from you and are NOT attached — they ARE shown to the user in the panel. Do NOT ` +
    `comment on motion, sharpness, composition or any other visual quality, and do not ` +
    `claim you reviewed them; ask the user to describe what they see, or to turn Blind off.`
  );
}

/**
 * Return `ev` with its pixels removed when `blind`, otherwise unchanged.
 *
 * The disclosure is only added when something was actually withheld: a completion that
 * carried no images has nothing to disclose, and saying otherwise would report a
 * withholding that did not happen.
 */
export function stripBlindCompletion<T extends { images?: unknown; note?: unknown }>(
  ev: T,
  blind: boolean,
): T {
  if (!blind) return ev;
  const withheld = Array.isArray(ev.images) ? ev.images.length : 0;
  return {
    ...ev,
    images: [],
    ...(withheld > 0 ? { note: blindDisclosure(ev.note, withheld) } : {}),
  };
}
