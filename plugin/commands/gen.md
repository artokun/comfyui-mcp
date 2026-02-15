---
description: Generate an image with ComfyUI from a text prompt
argument-hint: A text description of the image to generate
---

# /comfy-gen — Generate an Image

The user wants to generate an image using ComfyUI. Their prompt is provided as the argument to this command.

## Instructions

1. **Parse the user's prompt.** The argument after `/comfy-gen` is the image description: $ARGUMENTS

   If no argument was provided, ask the user what they'd like to generate.

2. **Check available models.** Use the `list_local_models` tool with `model_type: "checkpoints"` to see what checkpoints are installed.

3. **If no checkpoints are installed — acquire one automatically.**

   Do NOT ask the user to download a model. Instead, find and download one yourself:

   **Option A — CivitAI (preferred if CIVITAI_API_TOKEN is set):**
   - Use WebFetch to search CivitAI's REST API: `https://civitai.com/api/v1/models?query=SDXL&types=Checkpoint&sort=Most+Downloaded&limit=5`
   - Pick the top result that matches the user's needs (SDXL for general, Flux for quality, etc.)
   - Get the download URL from the model version: `https://civitai.com/api/download/models/{modelVersionId}?token={CIVITAI_API_TOKEN}`
   - Use `download_model` with `target_subfolder: "checkpoints"` to download it

   **Option B — HuggingFace (default):**
   - Use `search_models` to find a suitable checkpoint (e.g., query "SDXL" or "stable diffusion xl")
   - Find the direct `.safetensors` download URL from the model page (typically `https://huggingface.co/{repo}/resolve/main/{filename}`)
   - Use `download_model` with `target_subfolder: "checkpoints"` to download it

   **Sensible defaults by category:**
   - General purpose: SDXL base (`stabilityai/stable-diffusion-xl-base-1.0`)
   - Fast generation: SDXL Turbo or Lightning
   - High quality: Flux.1 schnell or dev (if user has enough VRAM)
   - Anime: Anything-XL or similar

   Tell the user what you're downloading and why. Large checkpoints can be 2-7 GB.

4. **Create the workflow.** Use the `create_workflow` tool with:
   - `template`: `"txt2img"`
   - `params`: Include `positive_prompt` from the user's input. Set `checkpoint` to the model filename. Use sensible defaults (1024x1024 for SDXL, 20 steps, cfg 8).

5. **Run the workflow.** Pass the workflow JSON from step 3 directly to `run_workflow`.

6. **Show the result.** The response will include base64 images. Present them to the user. If the generation failed, show the error and suggest fixes.

7. **Open the image.** After generation, open the image so the user can see it immediately without navigating to the output folder. Use the Bash tool with the appropriate command for the OS:
   - **macOS**: `open /path/to/image.png`
   - **Linux**: `xdg-open /path/to/image.png`
   - **Windows**: `start "" "/path/to/image.png"`

   The image will be saved to ComfyUI's output directory (check `get_system_stats` for the `--output-directory` arg, or default to `~/Documents/ComfyUI/output/`). Find the most recently created file there after the workflow completes.

## Model Selection Logic

When choosing a checkpoint, consider:
- **User's prompt**: Photorealistic → SDXL or Juggernaut XL. Anime/illustration → Anything-XL. Abstract → Flux.
- **Available VRAM**: Check `get_system_stats`. Flux needs ~12GB. SDXL needs ~6GB. SD 1.5 works on ~4GB.
- **Speed vs quality**: For quick tests, prefer turbo/lightning models (4-8 steps). For quality, use full models (20+ steps).

## CivitAI Integration

If the environment variable `CIVITAI_API_TOKEN` is available, prefer CivitAI for model discovery because it has:
- A larger selection of fine-tuned models
- Community ratings and reviews
- Better categorization (photorealistic, anime, illustration, etc.)

CivitAI REST API endpoints:
- **Search**: `GET https://civitai.com/api/v1/models?query={query}&types=Checkpoint&sort=Most+Downloaded&limit=5`
- **Model details**: `GET https://civitai.com/api/v1/models/{modelId}`
- **Download**: `GET https://civitai.com/api/download/models/{modelVersionId}?token={token}`

Always include the `token` query parameter when downloading.

## Example

User: `/comfy-gen a beautiful sunset over mountains with golden light`

Steps:
- List checkpoints → none found
- Search HuggingFace for "SDXL" → find `stabilityai/stable-diffusion-xl-base-1.0`
- Download `sd_xl_base_1.0.safetensors` to checkpoints folder
- Create txt2img workflow with the prompt and downloaded model
- Run the workflow
- Return the generated image

## Notes

- Always randomize the seed (let the template handle it) unless the user requests a specific seed
- If the user specifies dimensions, aspect ratio, steps, or other parameters, pass them through to `create_workflow`
- For negative prompts, use a sensible default like "blurry, low quality, deformed" unless the user specifies one
- If ComfyUI is not reachable, tell the user to check that it's running
- After downloading a model, it's immediately available — no restart needed
