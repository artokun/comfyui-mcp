/**
 * KNOWN server-side media/upload SELECTORS, keyed by (class_type → input name).
 *
 * These are the loader inputs whose value is a FILE that must exist on the
 * *connected* ComfyUI — resolved inside that server's input directory — rather
 * than a free string or a member of a true enum.
 *
 * Deliberately an ALLOWLIST, not a name or extension heuristic: a combo merely
 * *named* `image`/`audio`/`video` on some other node, or a media-looking value
 * (`.bmp`, `.mp4`, …) on a true enum, is NOT an asset selector. Two callers rely
 * on that distinction in opposite directions, which is why the list lives here
 * rather than in either of them:
 *
 *  - the UI→API converter (#504) PRESERVES an out-of-list value on these inputs
 *    (so a staged file surfaces as an honest missing-asset error) while
 *    substituting on a true enum;
 *  - the enqueue error path (#2673) reads a ComfyUI rejection on one of these
 *    inputs as "the server does not have this file" and says how to put it there.
 *
 * A false positive on a true enum would make the second caller advise an upload
 * for a bad sampler name, so the list stays narrow: unknown loaders simply get
 * no note, which is the pre-#2673 behaviour.
 */
export const LOADER_ASSET_INPUTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["LoadImage", new Set(["image"])],
  ["LoadImageMask", new Set(["image"])],
  ["LoadImageOutput", new Set(["image"])],
  ["VHS_LoadVideo", new Set(["video"])],
  ["VHS_LoadVideoPath", new Set(["video"])],
  ["VHS_LoadVideoFFmpeg", new Set(["video"])],
  ["VHS_LoadVideoFFmpegPath", new Set(["video"])],
  ["LoadAudio", new Set(["audio"])],
  ["VHS_LoadAudio", new Set(["audio"])],
  ["VHS_LoadAudioUpload", new Set(["audio"])],
]);

/** Whether (classType, name) is one of the media-file selectors above. */
export function isKnownLoaderInput(classType: string, name: string): boolean {
  return LOADER_ASSET_INPUTS.get(classType)?.has(name) ?? false;
}
