---
description: Run a multi-step generation recipe (portrait, hires-fix, style-transfer, etc.)
argument-hint: "Recipe name and prompt (e.g. 'portrait a woman with red hair')"
---

# /comfy-recipe — Multi-Step Generation Recipes

The user wants to run a predefined multi-step image generation pipeline. Each recipe chains multiple workflows together, passing the output of one step as input to the next.

## Instructions

1. **Parse the arguments.** The argument is: $ARGUMENTS

   If no argument was provided, list the available recipes and ask the user to choose one.

   Extract:
   - **Recipe name**: the first word (e.g., `portrait`, `hires-fix`, `product-shot`, `style-transfer`)
   - **Prompt**: everything after the recipe name

2. **Available recipes:**

   - **`portrait`** — Generate a portrait and upscale it
   - **`product-shot`** — Generate a product image with clean background
   - **`hires-fix`** — Generate at low resolution, then upscale with img2img for more detail
   - **`style-transfer`** — Apply a style prompt to an existing image via img2img
   - **`morph`** — Generate two frames and create a smooth morph video between them

3. **Check available models.** Call `list_local_models` with `model_type: "checkpoints"` to find a checkpoint. Also check `model_type: "upscale_models"` for upscale recipes. If models are missing, download appropriate ones before proceeding.

4. **Execute the recipe.** For each step, create the workflow, run it, and chain the output.

### Portrait Recipe
   - **Step 1 — Generate**: `create_workflow` with `txt2img`, prompt from user, 1024x1024, 25 steps, cfg 7
   - **Step 2 — Upscale**: `create_workflow` with `upscale`, using the output image from Step 1, 2x upscale
   - Final output: 2048x2048 upscaled portrait

### Product-Shot Recipe
   - **Step 1 — Generate**: `create_workflow` with `txt2img`, prompt from user (append "product photography, clean white background, studio lighting" to the prompt), 1024x1024, 25 steps, cfg 7
   - **Step 2 — Remove background**: If a background removal node is available, create a workflow to remove the background. Otherwise, skip this step and note it for the user.
   - Final output: product image (with or without background removal)

### Hires-Fix Recipe
   - **Step 1 — Low-res generation**: `create_workflow` with `txt2img`, prompt from user, 512x768 (or 768x512 for landscape), 20 steps, cfg 7
   - **Step 2 — Upscale with img2img**: `create_workflow` with `img2img`, using Step 1 output, target 1024x1536 (or 1536x1024), denoise 0.4-0.5, same prompt, 20 steps
   - Final output: high-resolution image with more detail than direct high-res generation

### Style-Transfer Recipe
   - **Step 1 — Load source image**: Ask the user for a source image path. Use `upload_image` to make it available.
   - **Step 2 — img2img with style**: `create_workflow` with `img2img`, source image from Step 1, style prompt from user, denoise 0.5-0.7 (higher = more stylized, lower = more faithful to original), 25 steps
   - Final output: source image with the requested style applied

### Morph Recipe
   - This recipe generates two frames and creates a smooth morph video transitioning between them using WAN 2.2 First-Last-Frame with dual Hi-Lo architecture.
   - **Requires the `wan-flf-video` and `qwen-image-edit` skills** — load them before executing.

   **Frame Preparation — Anchor Frame Strategy:**
   - Identify which frame is the "anchor" — the one with more complex composition (e.g., a person standing vs. a small animal). Generate the anchor first, then use Qwen Edit to create the second frame from it. This preserves proportions and scene consistency.
   - If the user provides two existing images, skip generation and go straight to Step 3.

   - **Step 1 — Generate anchor frame**: Use Z-Image Turbo (or user's preferred model) to generate the primary frame. Use portrait orientation (832x1472) for standing subjects, landscape (1664x928) for wide scenes. Clear VRAM after.
   - **Step 2 — Edit to create second frame**: Upload the anchor frame with `upload_image`. Use Qwen Image Edit (lightning 4-step) to transform it into the second frame. Prompt should describe the desired change while specifying relative size/position (e.g., "Replace the woman with a small cat sitting at the bottom of the image"). Clear VRAM after.
   - **Step 3 — Generate morph video**: Upload both frames with `upload_image`. Build the WAN 2.2 dual Hi-Lo FLF workflow per the `wan-flf-video` skill:
     - Two UNETs (Remix NSFW Hi+Lo with built-in lightning, or GGUF Q8 with lightning LoRAs)
     - `ModelSamplingSD3` shift=5 on both
     - `ImageResizeKJv2` to 480x720 (portrait) or 832x480 (landscape)
     - `WanFirstLastFrameToVideo` → dual `KSamplerAdvanced` (Hi: steps 0→2, Lo: steps 2→4, uni_pc/beta)
     - Optional: Apply morph LoRA (`wan2.2_i2v_magical_morph_{highnoise,lownoise}.safetensors`) to Hi/Lo Common stacks at strength 0.7-1.0 for smooth morphing instead of dissolve
     - `VHS_VideoCombine` at 16fps, h264-mp4
   - **Step 4 (Optional) — Upscale**: Use `VRAM_Debug` to free VRAM, then `SeedVR2VideoUpscaler` to upscale to 1080p.

   **Prompt tips for morph videos:**
   - Describe the motion/transformation, not just start and end states
   - **AVOID** "magical", "enchanted", "mystical" — causes literal sparkle effects
   - **USE** clean motion language: "smoothly transforms", "seamlessly reshapes", "gradually morphs"
   - Include scale cues when subjects differ in size: "grows into", "expands upward"
   - Always include a full negative prompt (see `wan-flf-video` skill)

   **Timing reference** (RTX 4090): Z-Image ~35s → Qwen Edit ~78s → WAN FLF 81 frames ~139s = ~4 minutes total

5. **Show progress.** After each step completes:
   - Report what was done and whether it succeeded
   - Show the intermediate image if available
   - Proceed to the next step

6. **Present the final result.** Show the final output image and a summary of all steps taken, including parameters used at each stage.

7. **Offer tweaks.** Ask the user if they'd like to:
   - Adjust any step's parameters and re-run from that point
   - Change the denoise strength (for hires-fix or style-transfer)
   - Try a different checkpoint or upscale model
   - Save the chained workflow for future use

## Example

User: `/comfy-recipe portrait a cyberpunk woman with neon hair and chrome implants`

Steps:
- Parse recipe: "portrait", prompt: "a cyberpunk woman with neon hair and chrome implants"
- Check checkpoints and upscale models
- Step 1: txt2img at 1024x1024 with the prompt
- Step 2: upscale the result 2x
- Present final 2048x2048 image
- Offer to tweak parameters

## Morph Example

User: `/comfy-recipe morph a black cat sitting in front of a barn morphs into a woman standing tall`

Steps:
- Parse recipe: "morph", prompt: "a black cat sitting in front of a barn morphs into a woman standing tall"
- Identify anchor frame: the woman (more complex, fills the frame)
- Step 1: Z-Image Turbo txt2img — "Full body portrait of a woman standing in front of a rustic barn..." at 832x1472
- Step 2: Qwen Edit — "Replace the woman with a small cat sitting at the bottom of the image, keep the barn background"
- Step 3: Clear VRAM, upload both frames, build WAN 2.2 dual Hi-Lo FLF workflow with morph LoRA
- Present final morph video
- Offer to adjust morph LoRA strength, frame count, or re-run with different seed

## Notes

- Each step is a separate `enqueue_workflow` call — use a background monitor (`node "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-progress.mjs" <prompt_id>` with `run_in_background: true`) to track completion. If a step fails, report the error and ask if the user wants to retry or skip
- For the portrait recipe, if no upscale model is installed, search for and download one (e.g., RealESRGAN_x2plus or 4x-UltraSharp)
- The hires-fix denoise value is critical: too high (>0.6) loses the original composition, too low (<0.3) adds little detail. Default to 0.45.
- For style-transfer, the user must provide a source image — if they don't, ask for one
- Seed is randomized for Step 1 but preserved across subsequent steps for consistency (unless the user requests otherwise)
- Always open the final image for the user using the OS-appropriate command (start/open/xdg-open)
