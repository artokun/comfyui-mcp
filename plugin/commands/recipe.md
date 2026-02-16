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

## Notes

- Each step is a separate `run_workflow` call — if a step fails, report the error and ask if the user wants to retry or skip
- For the portrait recipe, if no upscale model is installed, search for and download one (e.g., RealESRGAN_x2plus or 4x-UltraSharp)
- The hires-fix denoise value is critical: too high (>0.6) loses the original composition, too low (<0.3) adds little detail. Default to 0.45.
- For style-transfer, the user must provide a source image — if they don't, ask for one
- Seed is randomized for Step 1 but preserved across subsequent steps for consistency (unless the user requests otherwise)
- Always open the final image for the user using the OS-appropriate command (start/open/xdg-open)
