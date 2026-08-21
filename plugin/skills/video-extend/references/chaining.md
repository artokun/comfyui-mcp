# Video extension — chaining multiple extensions into a long video

Split out of [`../SKILL.md`](../SKILL.md). Read that first for the extension
pipeline itself and its five traps; come here when one extension is not long enough.

## Contents

- [Chaining multiple extensions (making a long video)](#chaining-multiple-extensions-making-a-long-video): the repeat loop, drift control and per-hop settings

## Chaining multiple extensions (making a long video)

Pusa adds a bounded window (~4 s) per run. To go longer, feed the output back
in:

0. **Confirm the prior clip actually rendered, via the filesystem, not
   /history.** `VHS_VideoCombine` writes the .mp4 but often does NOT
   register the output in ComfyUI's `/history` (the prompt shows done with no
   output and no error). Do NOT decide the render "silently dropped" from
   `get_history` / `queue` (action:"status") alone. Confirm the file with
   `get_image (action:"list_outputs")` (it now lists videos, each tagged `kind: "video"`):
   match the `filename_prefix` and check the mtime is fresh, then stage it.
0. **Stage the output clip as the next run's input** with
   `upload_image (action:"stage")` (pass the rendered clip's
   `{ filename, subfolder?, type? }`); use the returned input filename in
   `VHS_LoadVideo`. NEVER copy the output .mp4 into, or guess, a filesystem
   `input/` path. ComfyUI's input/output dirs may be CUSTOM
   (`--input-directory` / `--output-directory`), so a guessed path makes
   `VHS_LoadVideo` fail to find or decode the file and wastes the run. The tool
   routes through the server API (`/view` → `/upload/image`), which resolves the
   real dirs correctly. (For a clip already on local disk, `upload_image (action:"video")`.)
1. Run the extension → decode → save (or keep the frames in-graph).
2. Take the tail of the NEW output (the last ~13 frames) as the next
   `WanVideoEncode` input.
3. Re-run with the same graph; the fresh tail becomes the new conditioning head.
4. Repeat. `ImageConcatMulti` / `ImageBatchMulti` (KJNodes, used in the example's
   preview) stitch the segments into one continuous clip.

Practical chaining tips:

- Always condition on the newest frames, not the original clip, or you'll
  "rewind."
- Drift compounds across hops (color/identity slowly wander). Keep
  `noise_multipliers` modest and re-state the subject in the prompt each hop.
- Overlap a few frames between segments and drop duplicates at concat to hide
  the seam.
- Keep the same seed discipline (fixed or deliberately varied) so motion
  cadence stays consistent.
- Each hop is an independent generation. `clear_vram` is not needed between
  hops, but decode and cache long chains to disk so you don't hold every segment
  in VRAM.

---
