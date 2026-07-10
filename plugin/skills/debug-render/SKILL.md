---
name: debug-render
description: Debug a WRONG or imperfect render (not a hard error) by inspecting inputs and intermediate steps with run-to-node — render one branch up to an output, preview-tap latents/masks/preprocessor maps, localize the first bad stage, then fix. Use when a final image/video comes out wrong — artifacts, wrong subject/pose/composition/color, blur, a ControlNet/IPAdapter/mask/LoRA not taking, a two-stage refiner or upscale degrading the result — rather than the run failing with an error (for errors/OOM/missing nodes use the troubleshooting skill).
---

# Debugging renders with run-to-node

When a final asset looks **wrong** (not when it errors), don't re-roll the whole
graph and hope. **Localize the fault**: render only as far as one stage and LOOK
at what that stage actually produces. The wrong-looking output is downstream of a
*first* bad step — find that step, fix it there, and everything after it follows.

The tool for this is **`panel_run` with `to_node_id`** ("run to node"), which uses
ComfyUI's native **partial execution**: only the target output node plus
everything upstream of it renders; every other branch is skipped. That makes each
probe **fast and cheap**, and the output is delivered to you automatically (same
as any run — don't poll).

## When to reach for this

- A final image/video is wrong: artifacts, wrong subject/pose/composition, off
  color, soft/blurry, melted hands, wrong style.
- A conditioner isn't "taking": ControlNet, IPAdapter, a mask, an inpaint, a
  LoRA — and you can't tell if the *input* to it is wrong or the *node* is wrong.
- A multi-stage pipeline (base → refiner, txt2img → upscale, decode → post)
  degrades: you need to see which stage introduces the problem.
- You only want to test **one** branch of a multi-output graph without paying for
  the others.

If instead the run **fails** (red error, OOM, missing node, black image from a
crash) → use the **troubleshooting** skill; this skill is for outputs that
*complete* but look wrong.

## The one hard rule: `to_node_id` must be an OUTPUT node

ComfyUI can only run *to* an **output node** — SaveImage, PreviewImage, SaveVideo,
SaveAudio, etc. (these show `is_output: true` in `panel_query_graph` detail rows). A bare
KSampler / VAEDecode / preprocessor is **not** an output node, so you can't target
it directly. To inspect a point that isn't already an output, **add a preview
tap** there:

| You want to see… | Wire type | Tap to add | Wiring |
|---|---|---|---|
| An intermediate image (post-process, refiner stage, composite) | IMAGE | `PreviewImage` | image → `PreviewImage.images` |
| A latent (after a sampler, before/after upscale) | LATENT | `VAEDecode` → `PreviewImage` | latent → `VAEDecode.samples`; reuse the graph's VAE → `VAEDecode.vae`; then → `PreviewImage` |
| A mask (inpaint, segmentation, attention) | MASK | `MaskToImage` → `PreviewImage` | mask → `MaskToImage.mask` → `PreviewImage` |
| A ControlNet/preprocessor map (depth/pose/canny) | usually IMAGE already | `PreviewImage` | the preprocessor's IMAGE output → `PreviewImage.images` |
| The actual prompt/conditioning | CONDITIONING | (can't preview as an image) | inspect widget values / the text node feeding it instead |

Build a tap with `panel_add_node` + `panel_connect`, run to it, inspect, then
`panel_remove_node` the tap when you're done (unless the user wants to keep it).

## The loop

1. **Read the graph.** `panel_graph_outline` (then `panel_query_graph` for specifics) — note node ids, the output nodes
   (`is_output: true`), and every node's **mode**. A node in `bypass`/`mute` on
   the path is OFF and is a top cause of wrong renders — fix modes first with
   `panel_set_node_mode` before you blame anything else.
2. **Pick a probe point** roughly in the middle of the suspect chain (bisect).
3. **Get an output there** — target an existing output node, or add a preview tap
   (table above).
4. **`panel_run(to_node_id = that output node)`.** Only that branch renders.
5. **Look at what's delivered.** Is *this* stage already wrong, or still fine?
   - Still fine → move the probe **downstream**; the fault is later.
   - Already wrong → move the probe **upstream**; the fault is earlier.
6. Repeat until you find the **first** stage whose output is bad. That node (or
   its inputs/widgets) is what to fix — `panel_set_widget`, `panel_set_node_mode`,
   a rewire, a different model — then run-to-node there again to confirm the fix
   **before** running the full graph.
7. **Clean up** temporary preview taps (`panel_remove_node`) and do a final full
   `panel_run` to produce the real saved asset.

## Symptom → where to probe first

- **Whole image wrong subject/style** → preview the conditioning's source (the
  text/prompt node, the sampler's positive input via a decode of its latent).
- **ControlNet ignored / wrong structure** → preview the **preprocessor map**
  (the depth/pose/canny IMAGE going into the ControlNet). A blank or wrong map =
  the problem is the preprocessor or its input, not the sampler.
- **IPAdapter/reference not taking** → preview the reference image after any
  resize/crop the IPAdapter chain applies.
- **Inpaint/outpaint bleeding** → `MaskToImage`-preview the mask actually reaching
  the sampler (mask misalignment is the usual culprit).
- **Refiner/upscale degrades it** → preview the base latent (VAEDecode tap)
  *before* the refiner vs after: if the base is good and the result is bad, the
  refiner/upscale stage is at fault.
- **Right content, bad quality only** → it's late (sampler steps/cfg, VAE,
  post) — probe near the end first.

## Gotchas

- **Output-node only.** If you target a non-output node, the run is rejected with
  a message saying so — add a preview tap instead.
- **Modes matter.** A bypassed/muted node on the probed path silently changes what
  renders. Check modes in step 1.
- **Auto-delivery.** The probe's output node fires an `executed` event and the
  image is delivered to you inline — including PreviewImage taps, which arrive
  labeled as a *preview* (temporary, not a saved file). Don't poll; just end the
  turn and read the delivered image. A preview tap with no SaveImage means "no
  saved output ran" — that's expected for a probe.
- **Shared queue.** Each run-to-node queues a real (small) job; don't stack
  probes — run one, read it, then the next.
- **Subgraphs.** Output nodes nested inside a subgraph can't be targeted yet;
  probe at the root graph (add the tap outside the subgraph, fed by an exposed
  output rail).
