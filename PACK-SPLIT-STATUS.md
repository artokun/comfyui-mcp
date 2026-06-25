# Pack Split — Validation Status

Checkpoint of the effort to split each monolithic "ULTRA" toggle-template pack
(one ComfyUI graph with many pipeline groups, toggled via rgthree Fast Groups
Bypassers) into **standalone single-pipeline packs** that load and run with no
group-toggling.

## The recipe (proven, mechanical)

1. **Slice** one pipeline out of the monolith — backward closure from its output
   node (`SaveImage` / `VHS_VideoCombine`) through links + Set/Get buses.
   `scripts/slice-pipeline.mjs <src> <out> "<group substrs>"`
2. **Strip bypass** — un-bypass the kept nodes (top-level + subgraph-definition
   internals), leaving the opt-in prompt-enhancer LLM (`TextGenerate`) off.
3. **Convert + verify** — `scripts/verify-render.mjs <workflow.json>` converts
   UI→API via the MCP's `convertUiToApi`, POSTs to a live ComfyUI `/prompt`, and
   confirms a real render. `--convert-only` does the static check without a GPU.
4. **Scaffold** — manifest (model subset + custom_nodes + pip), pack.yaml,
   generated installers; gate with `validate-manifests` + `check-pack-models`.

### Converter / dep fixes this required (all committed + tested)
- `convertUiToApi` honors **bypass/mute** like ComfyUI `graphToPrompt` (exclude +
  passthrough), not the old `_meta.mode` annotation.
- Resolves virtual **Get/Set bus** nodes (KJNodes) — they're not real `/prompt` nodes.
- Fills **missing required widget** inputs from object_info defaults (fixed the
  `use_gpu` / `sampling_mode` rejections).
- `slice-pipeline` un-bypasses **subgraph-definition internals** (else the inner
  VAEDecode stays bypassed and the output drops).
- Pin **librosa** so comfyui-vrgamedevgirl's grain/sharpen nodes register.

## Status legend
- ✅ **render-verified** — produced a real image/video on the live ComfyUI `/prompt`.
- 🟡 **static-validated** — slices clean, converts (0 warnings), manifest validators
  pass; **not yet live-rendered** (waiting on its custom nodes and/or model weights).
- 🔴 **blocked** — a known issue to fix before it can render.

## Packs

| Pack | Source | Pipeline | Status | Notes |
|------|--------|----------|:------:|-------|
| `ernie-txt2img` | ernie | text→image | ✅ | 1920×1088 |
| `krea2-txt2img` | krea2 | text->image | ✅ | **NEW** — Krea 2 Turbo (Krea.ai 12B DiT, distilled). Native ComfyUI krea2 support + Qwen3-VL 4B encoder + Qwen image VAE, 8 steps cfg 1. **Render-verified: 5 crisp images (3 prose + 2 Ideogram-JSON)**. ImageSharpenKJ (rcas 0.55) kept active — converter gap: bypass-passthrough does not cross a subgraph IMAGE output. JSON prompting needs ALL builder fields set + empty palettes (else celebrity bleed / swatch-strip). Safety-filter-bypass node included but bypassed |
| `ernie-img2img` | ernie | img→image | ✅ | refines a source image |
| `ernie-combo` | ernie | ERNIE×Z-Image-Turbo | ✅ | 6 images |
| `z-image-turbo-txt2img` | z-image-turbo | text→image | ✅ | |
| `z-image-turbo-img2img` | z-image-turbo | img→image | ✅ | |
| `z-image-turbo-combo` | z-image-turbo | ERNIE×ZIT | ✅ | |
| `z-image-turbo-detail-daemon` | z-image-turbo | detail-daemon | ✅ | needs ComfyUI-Detail-Daemon |
| `z-image-base-txt2img` | z-image-base | text→image | ✅ | |
| `z-image-base-img2img` | z-image-base | img→image | ✅ | |
| `z-image-base-combo` | z-image-base | combo | ✅ | |
| `z-image-base-inpaint` | z-image-base | inpaint | ✅ | |
| `ltx-2.3-txt2vid` | Comfy-Org LTX-2.3 template | text→video | ✅ | **Rebuilt on the official two-stage template** (T2V mode: bypass_i2v + EmptyImage). Render-verified sharp. LTXAVTextEncoderLoader (gemma+ckpt) + gemma abliterated LoRA + dynamic distilled LoRA + ×2 spatial upscale. All-core nodes. See the ltxv2-video skill |
| `ltx-2.3-img2vid` | Comfy-Org LTX-2.3 template | img→video | ✅ | **Rebuilt on the official two-stage template** (I2V). Render-verified sharp at 1280×704 + 48kHz stereo audio (the sample_woman_video). Same model stack as txt2vid |
| `ltx-2.3-flf` | LTX ULTRA | first/mid/last-frame | 🟡 | needs rebuild on the official template (old DualCLIPLoader stack = mush) |
| `ltx-2.3-extender` | LTX ULTRA | video extend (audio) | 🟡 | " |
| `ltx-2.3-extender-no-audio` | LTX EXTENDER | video extend (no audio) | 🟡 | " |
| `ltx-2.3-xy-plot` | LTX XY-PLOT | LoRA xy-plot grid | 🟡 | " |
| `ideogram-txt2img` | ideogram | text→image | ✅ | **render-verified** — the V3 dynamic-combo `<combo>.<nested>` prefix fix (from the LTX work) unblocked the KJNodes (Ideogram4PromptBuilderKJ, ImageSharpenKJ). Sharp Times-Square selfie matching the shipped prompt |
| `ideogram-img2img` | ideogram | img→image | ✅ | same V3 fix — render-verified |
| `anima-txt2img` | anima | text→image | 🟡 | widget misalignment FIXED (steps/denoise now sane). **Render diagnosed (3 root causes):** (1) detector models were flat in models/ultralytics/ — moved to ComfyUI-Shared/models/ultralytics/bbox/+segm/ BUT after reboot UltralyticsDetectorProvider STILL lists [] — ComfyUI scans the install models/ultralytics/ (or extra_model_paths lacks an ultralytics mapping), not the shared dir. **Open: add ultralytics to extra_model_paths or copy weights to the install dir**; (2) EditDetailerPipe phantom combo `Select to add Wildcard` keeps stale value `Select Wildcard Full Cache` -> validation reject (converter widget-map gap on Impact detailer nodes); (3) EditDetailerPipe 642 `bbox_detector` mis-resolves to an UltimateSDUpscale IMAGE output instead of an UltralyticsDetectorProvider (converter wiring bug). #2+#3 are shared-converter work on Impact EditDetailerPipe — focused task. ComfyUI reports success+0 outputs because failed-validation outputs are silently ignored |
| `anima-img2img` | anima | img→image (controlnet) | 🟡 | same env set up; same subgraph-output-remapping converter gap |
| `anima-inpaint` | anima | inpaint (controlnet) | 🟡 | same env set up; same subgraph-output-remapping converter gap |
| `qwen-image-edit-edit` | qwen-image-edit | instruction edit | ✅ | render-verified — two sample-woman inputs hugged in a rainy forest per the shipped instruction. Installed Crystools + downloaded Qwen-Image-Edit Q8 GGUF + Qwen2.5-VL encoders + VAE + Lightning-4step LoRA |
| `wan-longer-videos-t2v` | wan-longer-videos | text→video | ✅ | render-verified **sharp** (1280×720, 9-segment longer-videos chain). GGUF path (Wan2.2 A14B Q8, no WanVideoWrapper). The earlier blur was a converter bug: rgthree Power Lora Loader dropped all loras, so the 4-step lightning ran undistilled. Fixed (lora_N translation) + shift 8→5 to match the official template |
| `wan-longer-videos-i2v` | wan-longer-videos | img→video | ✅ | render-verified sharp (sample_woman input) — same Power Lora Loader + shift fixes |
| `wan-longer-videos-v2v` | wan-longer-videos | video→video | ✅ | **24gb tier needs 832×480** — at 1280×720 the input-video overhead pushes even the Q4 model fully to offload on a 4090 (crawls). Render-verified **sharp** at 832×480 + frame_load_cap 81 (fits 24GB). The -96gb variant keeps 1280×720 fp16 |
| `wan-transparent-img2vid` | wan-transparent | img->transparent video | OK | render-verified RGBA cutout (264 frames, alpha 0-255) via ComfyUI-RMBG BiRefNetRMBG + BiRefNet_toonout. Removed 2 dead empty String-to-Text nodes (was-node-suite) + inlined prompt/filename_prefix. -96gb sibling = fp16 |
| `z-image-turbo-controlnet` | z-image-turbo | controlnet | ✅ | render-verified (DWPose-guided fur-hooded portrait). Two fixes: pinned scikit-image so DWPreprocessor registers (was a silent `skimage` import fail, not an object_info quirk) + top-level PrimitiveNode value resolution so the samplers get steps/step-range (was short-circuiting to a preview) |
| `z-image-base-controlnet` | z-image-base | controlnet | ✅ | render-verified (DWPose-guided portrait) — same scikit-image + PrimitiveNode fixes; downloaded the Z-Image-Fun-Controlnet-Union-2.1 controlnet model |
| `wan-animate-character` | wan-animate | v2v character anim | 🟡 | WanVideo suite now installed. **OOM-tuned for 24GB**: num_frames 501→77, force_offload on, blocks_to_swap 25→30 (the 501-frame default wedged ComfyUI on a 4090). Render-verify pending; for longer clips scale blocks_to_swap toward 40 |
| `z-image-turbo-inpainting` | z-image-turbo | inpaint | 🔴 | corrupt source node `workflow>postiveguid` (no subgraph definition in the monolith) — needs source reconstruction |

## Other notes
- **`ltx-2.3` and `qwen-image` monolith stubs** had `workflow: null` (no graph). LTX
  workflows were since supplied and split (the 6 `ltx-2.3-*` packs); a plain
  `qwen-image` text-to-image graph was never found — that stub stays unprocessed.
- Family **skills** (`plugin/skills/*`) are updated per-family as that family is
  fully render-verified (`ernie-image` done).
- `packs/anima/workflow.json` shows modified in the tree — that's a separate
  concurrent-agent change, not part of this split.

## Next (on the follow-up branch)
1. Live render-verify the 🟡 packs: install each family's nodes (skip-permissions),
   download weights, run `verify-render`, commit the passers, update the family skill.
2. Fix the 🔴 packs: the controlnet `DWPreprocessor`/object_info quirk; install the
   WanVideo suite for the wan packs; reconstruct the inpainting positive-prompt node.
3. Trim the LTX manifests' superset model warnings to each pipeline's real subset.
