// #2411 — SHARP'S NATIVE LIBRARY CAN BE UNLOADABLE, AND NOTHING SAID SO.
//
// `sharp` was imported at module top level by three services:
//
//     src/services/color-analysis.ts
//     src/services/image-convert.ts
//     src/services/inline-preview.ts
//
// All three are reached, statically, from `src/tools/index.ts` — which registers
// EVERY tool. So a `sharp` that throws while it evaluates does not disable image
// features; it takes the whole orchestrator down before any of our code runs.
// Measured on this machine by moving `libvips-cpp-8.18.3.dll` aside and booting
// `dist/index.js`:
//
//     Error: Could not load the "sharp" module using the win32-x64 runtime
//     ERR_DLOPEN_FAILED: The specified module could not be found.
//         at …/dist/index.js:17:5
//
// No tool registers, the server never starts, and the message names neither
// comfyui-mcp nor the feature the user lost. This is the same defect class as
// #1318 (a half-extracted dependency reported as a resolver path), and it gets
// the same treatment: load it where the failure can be CAUGHT, and translate the
// observable state into a sentence naming the library and the remedy.
//
// WHAT THIS DOES NOT CLAIM. #2411 was reported alongside a Windows Smart App
// Control toast blocking `libvips-cpp-8.18.6.dll`, and SAC is a plausible cause
// on that machine — but `ERR_DLOPEN_FAILED` is equally what an antivirus
// quarantine, a partial extraction, or a genuinely absent optional dependency
// produces. Following #1318's rule, the message states what was OBSERVED (the
// native library would not load, plus the loader's own words) and lists the
// causes worth checking. It does not assert which one happened.
//
// The reporter's own correlation — that this produced their undeliverable
// completions ("no prompt id … origin is UNDETERMINED") — is NOT supported by
// the measurement above: a blocked sharp yields no server at all, so a session
// whose renders succeeded and whose panel displayed outputs was not running a
// blocked sharp. Naming the failure is still the right fix; the symptom it will
// actually prevent is a dead orchestrator, not a missing contact sheet.

/**
 * The callable `sharp` factory, typed without importing it.
 *
 * A type-only reference is erased at compile time, so naming the module here
 * cannot reintroduce the load this file exists to defer.
 */
export type SharpModule = typeof import("sharp").default;

/**
 * Opt out of every sharp-backed feature without uninstalling anything.
 *
 * Set when the native library cannot be made loadable and the noise is worse
 * than the missing feature: the services below then refuse with the same worded
 * message instead of attempting a load that is known to fail.
 */
export const SHARP_DISABLE_ENV = "COMFYUI_MCP_NO_SHARP";

/** Marks "the user turned it off", so the message says that and not a fake load error. */
const DISABLED_SENTINEL = Symbol("sharp disabled by env");

/** Is the escape hatch set to something meaning "yes"? */
function disabledByEnv(): boolean {
  const raw = process.env[SHARP_DISABLE_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  // An empty value is how a shell spells "unset it", and "0"/"false" are how a
  // config file spells "no". Treating either as ON would disable image features
  // for anyone who wrote `COMFYUI_MCP_NO_SHARP=0` to mean the opposite.
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/**
 * Did this failure come from the NATIVE library, rather than from sharp's
 * JavaScript being absent?
 *
 * The two want different remedies — a dlopen failure is a blocked or damaged
 * binary, while a resolution failure is a dependency that was never installed
 * (`--omit=optional` does exactly this, which is why #1447 parked it). Detection
 * is deliberately loose: it only picks WHICH paragraph of advice to print, and
 * both paragraphs name sharp, so a misclassification costs a line of irrelevant
 * advice rather than a wrong diagnosis.
 */
function isNativeLoadFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ERR_DLOPEN_FAILED") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /ERR_DLOPEN_FAILED|Could not load the "sharp" module|\.node\b/.test(msg);
}

/** The first line of whatever the loader said, for quoting back verbatim. */
function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const line = msg
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "no error message";
}

/**
 * The dlopen detail line, when sharp's help text carries one.
 *
 * sharp concatenates its own headline, then each underlying error as
 * `${code}: ${message}`, then a "Possible solutions:" block that is about
 * INSTALLING sharp — advice which is actively misleading when the package is
 * installed correctly and the binary is being refused. Lifting just the cause
 * line keeps what diagnoses and drops what misdirects.
 */
function dlopenDetail(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  for (const raw of msg.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("ERR_DLOPEN_FAILED:")) return line;
  }
  return null;
}

/**
 * What to tell a user whose sharp will not load, for the feature they asked for.
 *
 * `feature` names the thing that is unavailable in the caller's own vocabulary
 * ("Colour analysis", "Image conversion"), because a message that says only
 * "sharp is unavailable" leaves the reader to work out which of their requests
 * died — which is the gap #2411 is about.
 */
export function sharpUnavailableMessage(feature: string, err: unknown): string {
  if (err === DISABLED_SENTINEL) {
    return (
      `${feature} is unavailable: image processing is switched off by ` +
      `${SHARP_DISABLE_ENV}. Unset it to re-enable sharp-backed features.`
    );
  }
  const native = isNativeLoadFailure(err);
  const detail = dlopenDetail(err) ?? firstLine(err);
  const cause = native
    ? "its native library (libvips, loaded through `sharp`) could not be loaded"
    : "the `sharp` module could not be loaded";
  const advice = native
    ? process.platform === "win32"
      ? "On Windows this is usually the binary being REFUSED rather than missing. Check, in order: " +
        'Windows Security > App & browser control for a "Part of this app has been blocked" entry ' +
        "naming libvips-cpp-<version>.dll (Smart App Control refuses binaries it cannot attribute to " +
        "a known publisher); then your antivirus quarantine; then reinstall with " +
        "`npm install -g comfyui-mcp@latest` in case the extraction was interrupted. " +
        "Do NOT disable Smart App Control to work around this — on Windows that is a one-way switch " +
        "you cannot turn back on without reinstalling the OS."
      : "Reinstall sharp's platform binaries with `npm install --include=optional sharp`, or " +
        "reinstall with `npm install -g comfyui-mcp@latest`."
    : "sharp's optional platform package is probably absent — `--omit=optional` removes it. " +
      "Reinstall with `npm install -g comfyui-mcp@latest`.";
  return (
    `${feature} is unavailable: ${cause}.\n` +
    `  ${detail}\n` +
    `${advice}\n` +
    "Everything that does not resize or re-encode images is unaffected, and files already written " +
    `to disk are intact. Set ${SHARP_DISABLE_ENV}=1 to skip these features quietly instead.`
  );
}

/**
 * The same diagnosis as {@link sharpUnavailableMessage}, sized to be dropped
 * into the MIDDLE of someone else's sentence.
 *
 * `boundInlineImage` hands its reason to a caller that wraps it as
 * `NOT rendered inline: ${reason}. The full-resolution file is on disk…`, so the
 * standalone form — several lines, its own remedy paragraph, a closing full stop
 * — would read as two collided messages and push the caller's own remedy off the
 * end. This starts lower-case and carries no terminal punctuation.
 */
export function sharpUnavailableReason(err: unknown): string {
  if (err === DISABLED_SENTINEL) {
    return `image processing is switched off by ${SHARP_DISABLE_ENV}, so no preview could be built`;
  }
  const detail = dlopenDetail(err) ?? firstLine(err);
  const what = isNativeLoadFailure(err)
    ? "sharp's native library (libvips) could not be loaded"
    : "the sharp module could not be loaded";
  return (
    `${what} (${detail}), so the image could not be resized to fit — ` +
    "this is an install/permissions problem with that binary, not a problem with the render"
  );
}

/**
 * Cached outcome of the one load attempt.
 *
 * Caching the FAILURE matches Node's own ESM semantics — a module that throws
 * while evaluating stays errored in the module map and re-throws the identical
 * error on every later `import()` — so this adds no constraint that was not
 * already there. It only avoids re-deriving the wrapped message per call.
 *
 * The env check is NOT cached with it: reading `process.env` each time keeps the
 * switch honest for tests that set and clear it around a case.
 */
let cached: { ok: true; sharp: SharpModule } | { ok: false; err: unknown } | null = null;

/** Drop the memoised outcome. Exists for tests; production loads once. */
export function resetSharpLoaderForTests(): void {
  cached = null;
}

/**
 * The sharp factory, or the reason it is unavailable.
 *
 * For paths that DEGRADE — an inline preview that can be skipped while the
 * underlying file is still delivered. Callers that cannot proceed at all should
 * use {@link requireSharp}, which throws the same worded message.
 */
export async function tryLoadSharp(): Promise<
  { ok: true; sharp: SharpModule } | { ok: false; err: unknown }
> {
  if (disabledByEnv()) return { ok: false, err: DISABLED_SENTINEL };
  if (cached) return cached;
  try {
    const mod = await import("sharp");
    cached = { ok: true, sharp: mod.default };
  } catch (err) {
    cached = { ok: false, err };
  }
  return cached;
}

/**
 * The sharp factory, or a thrown Error naming the library and the remedy.
 *
 * The throw is what a caller that cannot degrade wants: `get_image
 * action:"convert"` has nothing to hand back if it cannot re-encode, and an
 * empty success would be worse than a refusal that says why.
 */
export async function requireSharp(feature: string): Promise<SharpModule> {
  const result = await tryLoadSharp();
  if (result.ok) return result.sharp;
  throw new Error(sharpUnavailableMessage(feature, result.err));
}

/**
 * One line for the startup log when sharp cannot load, or `null` when it can.
 *
 * A probe exists because the alternative is finding out during the first render
 * of a long session, which is exactly how #2411 cost an hour. It deliberately
 * returns the line instead of logging it, so the caller owns the level and the
 * tests do not have to capture a logger.
 */
export async function probeSharp(): Promise<string | null> {
  const result = await tryLoadSharp();
  if (result.ok) return null;
  return sharpUnavailableMessage("Image resizing, conversion and colour analysis", result.err);
}
