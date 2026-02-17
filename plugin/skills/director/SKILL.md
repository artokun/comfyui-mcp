---
name: director
description: Full production pipeline — story to scenes, Z-Image start frames, Qwen Edit end frames, WAN FLF video clips, ffmpeg concatenation
globs:
  - "**/*.json"
---

# Director — Story-to-Video Production Pipeline

## Overview

The Director skill orchestrates a complete short film production from a text story. It breaks the story into scenes, generates start/end frames for each, creates video clips from frame pairs, and concatenates everything into a final video.

**Pipeline**: Story Planning → Z-Image Hero + Character Refs → Qwen Edit Chain (all frames) → WAN 2.2 FLF Video Clips → ffmpeg Concatenation

**Key architectural decisions**:
- **1 hero frame + edit chain** for character consistency (NEVER independent Z-Image per scene)
- **Inter-scene frame continuity**: Scene N's end frame IS Scene N+1's start frame (same image file, no edit gap)
- Character reference images fed into Qwen Edit's extra image slots
- State file persists to disk for context compaction survival
- Each scene is independently retryable without affecting others
- `clear_vram` between every model family switch

## CRITICAL: Character Consistency

**Independent Z-Image generations per scene produce different-looking characters.** This was the #1 problem discovered during testing. The solution:

1. Generate **ONE hero frame** with Z-Image — establishes the main character, setting, and lighting
2. Generate **character reference images** — close-up portraits of each character, key props, and the background
3. **ALL other scene frames** are created via Qwen Edit chain from the hero, with character refs in extra image slots
4. This ensures the same face, clothing, and environment across every frame

## 8-Phase Pipeline

```
Phase 1: Story Planning       → Break story into scenes (Claude reasoning, no ComfyUI)
Phase 2: Hero + Refs          → Z-Image: 1 hero frame + character ref portraits + background ref
Phase 3: Hero Review          → Visual verify hero and refs, user approves
Phase 4: Edit Chain           → Qwen Edit: chain ALL scene frames from hero (with char refs in slots 2-3)
Phase 5: Frame Review         → Visual verify all frames, approve/reject/retry
Phase 6: Video Clips          → WAN 2.2 FLF dual Hi-Lo (one clip per scene)
Phase 7: Video Review         → Preview each clip
Phase 8: Final Assembly       → ffmpeg concat all clips into one MP4
```

## State File Format

Saved at `~/code/comfyui-mcp/workflows/director_state_{project_id}.json`. Updated after every edit or phase completion.

```json
{
  "project_id": "story_20260216_143022",
  "created": "2026-02-16T14:30:22Z",
  "story": "Original user story text",
  "current_phase": 4,
  "orientation": "portrait",
  "hero_frame": { "file": "director_hero_00001_.png", "seed": 428571, "approved": true },
  "character_refs": {
    "man": "director_ref_man.png",
    "cat": "director_ref_cat.png",
    "woman": "director_ref_woman.png",
    "background": "director_ref_bedroom.png"
  },
  "scenes": [
    {
      "id": 1,
      "description": "Brief scene description",
      "edit_prompt_start": "Qwen Edit instruction to create start frame from source",
      "edit_prompt_end": "Qwen Edit instruction to create end frame from source",
      "edit_source_start": "hero",
      "edit_source_end": "hero",
      "video_prompt": "WAN motion description",
      "start_frame": { "file": "director_s1_start_00001_.png", "seed": 12345, "approved": true },
      "end_frame": { "file": "director_hero_00001_.png", "seed": null, "approved": true },
      "video_clip": { "file": "director_s1_00001.mp4", "seed": 11111, "approved": false },
      "status": "video_pending"
    }
  ],
  "final_video": null,
  "settings": {
    "start_frame_resolution": [832, 1472],
    "video_resolution": [480, 720],
    "video_frames": 81,
    "video_fps": 16
  }
}
```

## Models Used Per Phase

| Phase | Model Family | Key Models | VRAM |
|-------|-------------|------------|------|
| 2: Hero + Refs | Z-Image | `redcraftRedzimageUpdatedJAN30_redzibDX1.safetensors` | ~17GB |
| 4: Edit Chain | Qwen Edit | `qwen_image_edit_2511_bf16.safetensors` + Lightning LoRA | ~17-18GB |
| 6: Video Clips | WAN 2.2 I2V | Remix NSFW Hi+Lo (built-in lightning) | ~22-24GB |

**CRITICAL**: `clear_vram` between every model family switch.

## Phase 1: Story Planning

Break the story into 2-6 scenes. For each scene, identify:
- **description**: What happens (1-2 sentences)
- **start frame**: What the opening frame looks like
- **end frame**: What the closing frame looks like
- **video_prompt**: Motion description for FLF transition

Identify a **hero frame** — the single most representative scene image that establishes the main character and setting. This hero will anchor all other frames via Qwen Edit.

Also identify which **character reference images** are needed (portraits of each character, key props, background).

### CRITICAL: Inter-Scene Frame Continuity

**The end frame of Scene N must be the EXACT same image file as the start frame of Scene N+1.** Do NOT create separate Qwen-edited start frames for subsequent scenes — this causes visible jumps at scene boundaries when the videos are concatenated.

The frame chain for video generation:
```
Scene 1: S1_start (unique)        → hero (end)
Scene 2: hero (= S1 end)          → S2_end
Scene 3: S2_end (= S2 end)        → S3_end
Scene 4: S3_end (= S3 end)        → S4_end
Scene 5: S4_end (= S4 end)        → S5_end
```

Only Scene 1 needs a unique start frame. All other scenes inherit their start from the previous scene's end.

### Edit Chain Planning

The edit chain produces **only end frames** (plus Scene 1's unique start frame). Map which end frame derives from which source:
- Some end frames edit directly from the hero
- Later end frames may chain from earlier end frames
- Keep chains shallow (max 4-5 deep) to minimize drift

Example chain:
```
Hero (man+cat on bed)
  ├─ S1 Start: edit hero → remove cat, man alone
  ├─ S2 End: edit hero → replace cat with woman
  │    └─ S3 End: edit S2End → both sit up, man startled
  │         └─ S4 End: edit S3End → sitting close, warm smiles
  │              └─ S5 End: edit S4End → warm embrace
```

## Phase 2: Hero + Character References — Z-Image

Generate with Z-Image RedCraft DX1 (10 steps, CFG 1, euler/simple):

1. **Hero frame**: The establishing shot with main character + key elements
2. **Character ref portraits**: Close-up of each character (man, woman, animal, etc.)
3. **Background ref**: The setting without characters

Add to negative prompts for character refs to exclude wrong subjects (e.g., "woman, female" when generating man portrait).

### Hero Frame Workflow Template

```json
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "redcraftRedzimageUpdatedJAN30_redzibDX1.safetensors" }},
  "2": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["1", 1], "text": "<hero_prompt>" }, "_meta": { "title": "Positive" }},
  "3": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["1", 1], "text": "3D, ai generated, semi realistic, illustrated, drawing, comic, digital painting, 3D model, blender, video game screenshot, render, smooth textures, CGI, text, writing, subtitle, watermark, logo, blurry, low quality, jpeg artifacts, grainy" }, "_meta": { "title": "Negative" }},
  "4": { "class_type": "EmptyLatentImage", "inputs": { "width": 832, "height": 1472, "batch_size": 1 }},
  "5": { "class_type": "KSampler", "inputs": {
    "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0],
    "seed": 42, "steps": 10, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1
  }},
  "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] }},
  "7": { "class_type": "SaveImage", "inputs": { "images": ["6", 0], "filename_prefix": "director_hero" }}
}
```

Queue hero + all refs while Z-Image checkpoint is loaded (same checkpoint, different prompts).

## Phase 3: Hero Review

Show hero frame and all character refs. User approves or requests regeneration with new seed.

## Phase 4: Edit Chain — Qwen Image Edit

### CRITICAL: Consistency Rules for Edit Prompts

1. **Always explicitly anchor clothing**: "The man wears his grey t-shirt" in EVERY prompt
2. **Always state what doesn't change**: "Same bedroom, same warm lighting, same clothing"
3. **Use strong emotion words**: "extremely shocked and startled" >> "surprised"
4. **Include proportionality**: "Her head and body should be proportional and natural looking"
5. **Prevent head enlargement**: In embrace/close-up poses, Qwen Edit tends to enlarge heads. Add explicit: "do not enlarge her head, keep the same small natural size as in the original image"
6. **Describe the transformation, not just the end state**

### Workflow Template (with Character Reference Slots)

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "qwen_image_edit_2511_bf16.safetensors", "weight_dtype": "default" }},
  "2": { "class_type": "LoraLoaderModelOnly", "inputs": { "model": ["1", 0], "lora_name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", "strength_model": 1 }},
  "3": { "class_type": "CLIPLoader", "inputs": { "clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image" }},
  "4": { "class_type": "VAELoader", "inputs": { "vae_name": "qwen_image_vae.safetensors" }},
  "5": { "class_type": "LoadImage", "inputs": { "image": "<source_scene.png>" }, "_meta": { "title": "Source Scene" }},
  "5b": { "class_type": "LoadImage", "inputs": { "image": "<character_ref.png>" }, "_meta": { "title": "Character Ref" }},
  "5c": { "class_type": "LoadImage", "inputs": { "image": "<background_ref.png>" }, "_meta": { "title": "Background Ref" }},
  "6": { "class_type": "TextEncodeQwenImageEditPlusAdvance_lrzjason", "inputs": {
    "clip": ["3", 0], "prompt": "<edit_prompt>", "vae": ["4", 0],
    "vl_resize_image1": ["5", 0],
    "vl_resize_image2": ["5b", 0],
    "vl_resize_image3": ["5c", 0],
    "target_size": 1024, "target_vl_size": 384,
    "upscale_method": "lanczos", "crop_method": "pad"
  }},
  "7": { "class_type": "ConditioningZeroOut", "inputs": { "conditioning": ["6", 0] }},
  "8": { "class_type": "KSampler", "inputs": {
    "model": ["2", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["6", 1],
    "seed": 42, "steps": 4, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1
  }},
  "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["4", 0] }},
  "10": { "class_type": "SaveImage", "inputs": { "images": ["9", 0], "filename_prefix": "director_s1_start" }}
}
```

**Key: slots 5b and 5c** — feed character reference and background reference into `vl_resize_image2` and `vl_resize_image3`. This helps the vision encoder maintain character appearance across edits.

### Chain Execution

Edits are **sequential** — each depends on the previous output:
1. Run edit, wait for completion
2. `upload_image` the output
3. Use uploaded output as source for next edit
4. Update state file after each edit

Independent edits (both from hero) can run in parallel.

### Timing

- First edit: ~87s (model loading)
- Subsequent edits: ~30-40s each (models cached)

## Phase 5: Frame Review

For each frame, show via `Read` for visual inspection. User approves or provides feedback. Re-run individual edits without redoing the whole chain.

## Phase 6: Video Clip Generation — WAN 2.2 FLF Dual Hi-Lo

### Workflow Template

(Same as wan-flf-video skill — Remix NSFW Hi+Lo, 4-stack LoRA, ImageResizeKJv2, dual KSamplerAdvanced)

Key settings:
- Portrait: width=480, height=720
- 81 frames, 16fps = ~5 seconds per clip
- uni_pc/beta sampler, CFG 1, 4 total steps (Hi: 0→2, Lo: 2→4)
- ModelSamplingSD3 shift=5 on both UNETs

### Morph LoRA

For transformation scenes (e.g., cat→woman), add morph LoRA to Hi/Lo Common stacks:
- `wan2.2_i2v_magical_morph_highnoise.safetensors` → Hi Common slot 1 (strength **1.0**)
- `wan2.2_i2v_magical_morph_lownoise.safetensors` → Lo Common slot 1 (strength **1.0**)

Use **1.0 strength** — tested without sparkle issues. Lower values (0.7-0.85) produce weaker morph effects that may look like a dissolve rather than a true morph.

### Per-Scene Changes

Swap per scene: start/end image filenames, positive prompt text, noise_seed, filename_prefix.

All 5 clips can be queued at once — they run sequentially in ComfyUI, sharing loaded models.

## Phase 7: Video Review

Report each clip's filename. User previews externally.

## Phase 8: Final Assembly — ffmpeg Concat

```bash
cd "<ComfyUI_output_dir>"
printf "file 'director_s1_00001.mp4'\nfile 'director_s2_00001.mp4'\n..." > concat_list.txt
ffmpeg -f concat -safe 0 -i concat_list.txt -c copy director_final_{project_id}.mp4
```

All clips share resolution/codec/framerate — copy-concat works without re-encoding.

## Resumption Protocol

After context compaction:
1. Read state file AND `director_session_notes.md` if it exists
2. Check `current_phase` and per-scene status
3. Skip approved assets, continue from incomplete point
4. `clear_vram` before loading the model family for the current phase

## Timing Estimates (RTX 4090)

| Phase | Per Scene | 5 Scenes |
|-------|-----------|----------|
| Hero + Refs (Z-Image) | ~10s each | ~50s (one-time) |
| Edit Chain (Qwen 4-step) | ~35s each | ~280s (8 edits) |
| Video Clip (WAN FLF 81 frames) | ~140s | ~700s |
| VRAM swaps (3x clear_vram) | ~30s each | ~90s |
| **Total generation** | | **~19 min** |

## Storytelling Props for Continuity

Use distinctive visual elements that transfer between characters/forms to create narrative connections:
- A colored collar on an animal → becomes a choker/necklace on the human form
- Eye color matching between animal and human
- Distinctive clothing or accessories that persist across scenes
- These "continuity props" reinforce the story visually

## Prompt Engineering for Edit Chains

### DO
- "The man wears his grey t-shirt" (anchor clothing every time)
- "Same bedroom, same warm amber lamplight, same white sheets"
- "Extremely shocked, jaw dropped, eyes wide in total disbelief"
- "Her head and body proportional and natural looking"

### DON'T
- Assume clothing/setting will be preserved automatically
- Use mild emotion words ("surprised" → use "extremely shocked" instead)
- Chain more than 5-6 edits deep without branching back to hero
- Assume head proportions stay correct in embrace/hug poses — always add explicit size anchoring

### WAN Video Prompts
- Use motion verbs: "walks", "turns", "reaches", "sits up", "leans in"
- AVOID: "magical", "enchanted", "mystical" (causes sparkle effects)
- USE: "smoothly transforms", "seamlessly reshapes", "gradually"
- Include scale cues: "grows into", "expands upward"
