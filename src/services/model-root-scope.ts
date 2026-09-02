/**
 * #1474 — `remove` searched one root while `list_paths` displayed several.
 *
 * On a normal Comfy Desktop launch the reporter saw:
 *
 *   list        -> lists a model served from M:\\Comfy-Desktop\\ComfyUI-Shared\\models
 *   list_paths  -> shows that shared root, read from the live --extra-model-paths-config
 *   remove      -> "Model file not found ... Searched 1 root(s): <primary install>"
 *
 * Two tools disagreeing about which roots exist, with nothing to explain it. The
 * reporter had to diagnose the asymmetry themselves and then delete the files by hand.
 *
 * ## Why the asymmetry is DELIBERATE, and stays
 *
 * `resolveExistingModelFile` enumerates only roots it can PROVE, because it is the
 * resolver behind DELETION. `list_paths` may display a root from the current config;
 * deletion may act on it only when the connected server named that config at launch
 * and the file is still provably unchanged. The #764 display-only fallback is refused
 * here on purpose, and this module does not relax that — the reporter said it plainly:
 * this is a filesystem authorisation boundary and loosening it locally would be risky.
 * They are right.
 *
 * ## What was actually wrong
 *
 * Not the rule — the SILENCE about it. "Searched 1 root(s)" reads as "there is one
 * root", when the truth is "there is one root I can prove". A caller looking at
 * `list_paths` sees a contradiction and no way to tell which tool is lying.
 *
 * So the refusal now says which roots were searched, that PROVABILITY is the reason
 * others were not, and how to proceed — without widening what deletion may touch.
 */

/**
 * The not-found refusal for a model the resolver could not locate.
 *
 * States the PROVABILITY rule unconditionally rather than trying to diff against what
 * a listing tool would show: that would need the live snapshot plumbed into this
 * resolver, and a parameter nothing passes is an inert fix. The rule is true on every
 * call — only provable roots are ever searched — so saying it always is both simpler
 * and never wrong.
 */
export function modelNotFoundMessage(opts: {
  relativePath: string;
  searched: readonly string[];
}): string {
  const { relativePath, searched } = opts;
  return (
    `Model file not found: ${relativePath}. Searched ${searched.length} root(s): ` +
    `${searched.join(", ")}. That may not be every root you can SEE: this operation ` +
    `searches only roots it can PROVE from the running ComfyUI's own launch state ` +
    `(including its launch arguments), ` +
    `while list_local_models (action:"list_paths") also displays roots read from a ` +
    `config file. On a Comfy Desktop install those differ, so a shared model root can ` +
    `be listed there and absent here (#1474). The restriction is deliberate — this ` +
    `resolver backs DELETION, and a mutable current config is not proof of what the ` +
    `server loaded — so "not found" here does NOT mean "not on disk". Compare against ` +
    `list_paths: if the file lives under a root missing from the list above, launch ` +
    `ComfyUI so its main.py appears in its arguments and the config launch state can be proven, ` +
    `or act on the file directly on the host after checking it is inside the intended root.`
  );
}
