---
description: Browse and inspect generated ComfyUI outputs
argument-hint: "Optional filter: 'last N', 'today', 'yesterday', or filename pattern"
---

# /comfy-gallery — Browse Generated Outputs

The user wants to browse images that ComfyUI has generated, inspect their metadata, and optionally re-run or modify workflows.

## Instructions

1. **Determine the output directory.** Call `get_system_stats` to check for a custom `--output-directory` argument. If not set, use the default ComfyUI output directory (typically `~/Documents/ComfyUI/output/` or the `output/` folder relative to the ComfyUI installation).

2. **List image files.** Use the Glob tool to find image files in the output directory:
   - Pattern: `**/*.png` (ComfyUI saves as PNG by default)
   - Also check for `**/*.jpg`, `**/*.webp` if needed
   - Sort by modification time, newest first

3. **Apply filters.** The argument is: $ARGUMENTS

   Parse the filter:
   - **`last N`** or **`N`**: show only the N most recent images
   - **`today`**: images created today (compare file dates)
   - **`yesterday`**: images from yesterday
   - **Filename pattern**: glob match against filenames (e.g., `ComfyUI_00123*`)
   - **No filter**: default to showing the last 10 images

4. **Present image details.** For each image, show:
   - Filename
   - File size (human-readable: KB/MB)
   - Creation/modification date and time
   - Use the Read tool to display the image thumbnail if the file is a supported image format

5. **Extract workflow metadata.** When the user selects an image or asks for details:
   - Use `workflow_from_image` to extract the embedded workflow JSON from the PNG metadata
   - Show key parameters: checkpoint used, prompt, negative prompt, seed, steps, CFG, sampler, dimensions
   - Offer to visualize the workflow with `visualize_workflow`

6. **Offer actions.** For any selected image, offer to:
   - **Re-run**: execute the same workflow again (new seed for variation)
   - **Modify and re-run**: let the user change parameters (prompt, seed, steps, etc.) and run a modified version
   - **Upscale**: create an upscale workflow using the image as input

## Example

User: `/comfy-gallery last 5`

Steps:
- Find the output directory
- List all PNG files, sorted by newest
- Show the 5 most recent with filename, size, and date
- Display thumbnails
- Ask if the user wants to inspect any image's workflow

## Notes

- ComfyUI embeds workflow metadata in PNG files by default — this is what `workflow_from_image` reads
- JPEG and WebP files may not have embedded metadata depending on ComfyUI settings
- The output directory may contain subdirectories for different workflows or dates
- If the output directory is empty, tell the user no images have been generated yet
- Large galleries (100+ images) should be filtered to avoid overwhelming output
