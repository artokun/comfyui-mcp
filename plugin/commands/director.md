---
description: Direct a short film from a story — generates scenes, frames, and video clips
argument-hint: "A story or 'resume' to continue a previous project"
---

# /comfy-director — Story-to-Video Production Pipeline

The user wants to create a short film from a story description. This command orchestrates multiple model families (Z-Image, Qwen Edit, WAN FLF) to generate start frames, end frames, and video clips for each scene, then concatenates them into a final video.

**Requires the `director`, `z-image-txt2img`, `qwen-image-edit`, and `wan-flf-video` skills** — load them before executing.

## Instructions

1. **Parse the arguments.** The argument is: $ARGUMENTS

   - If the argument is `resume` or starts with `resume`, look for the most recent `director_state_*.json` file in `~/code/comfyui-mcp/workflows/` and resume from the saved phase. Skip to the **Resumption** section below.
   - If the argument is a story/description, proceed with a new project.
   - If no argument was provided, ask the user for their story.

2. **Create the state file.** Generate a project ID from the current timestamp (e.g., `story_20260216_143022`). Initialize the state file at `~/code/comfyui-mcp/workflows/director_state_{project_id}.json` with the story text and empty scenes array.

3. **Phase 1 — Story Planning.** Break the story into 2-6 scenes. For each scene, craft:
   - **description**: What happens (1-2 sentences)
   - **start_prompt**: Detailed Z-Image prompt for the opening frame (natural language, descriptive, include camera/lighting/style cues)
   - **edit_prompt**: Qwen Edit instruction to transform the start frame into the end frame
   - **video_prompt**: WAN motion description (include motion verbs: "walks", "turns", "reaches", "camera pans")

   **Anchor frame strategy**: For each scene, decide if the start or end frame is the "anchor" (more complex composition). Generate the anchor first, edit to create the other.

   Present the scene plan to the user for approval before proceeding. Update the state file with scene definitions.

4. **Ask orientation.** Ask the user if they prefer portrait (480x720 video, 832x1472 frames) or landscape (832x480 video, 1472x832 frames). Default to portrait for character-focused stories, landscape for environment/action stories.

5. **Phase 2 — Start Frame Generation.**
   - `clear_vram` first
   - For each scene, build and enqueue the Z-Image RedCraft DX1 workflow (see `director` skill, Phase 2 template)
   - Use `filename_prefix: "director_s{N}_start"` for each scene
   - After each generation completes, update the state file with the output filename and seed

6. **Phase 3 — Start Frame Review.**
   - For each scene's start frame:
     - Find the output with `list_output_images(pattern="director_s{N}_start")`
     - Read the image with `Read` to visually inspect it
     - Show the image to the user and describe what was generated
     - If the user approves, mark `start_frame.approved = true` in state
     - If rejected, re-generate with a new seed (or modified prompt if user provides feedback)
   - Update the state file after all reviews complete

7. **Phase 4 — End Frame Generation.**
   - `clear_vram` first
   - For each scene with an approved start frame:
     - `upload_image` the start frame to make it available as `LoadImage` input
     - Build and enqueue the Qwen Edit workflow (see `director` skill, Phase 4 template)
     - Use `filename_prefix: "director_s{N}_end"`
   - After each generation, update state file

8. **Phase 5 — End Frame Review.**
   - Same protocol as Phase 3 but for end frames
   - If an end frame is rejected, the user can:
     - Retry with a new seed
     - Modify the edit prompt
     - Regenerate from a different start frame

9. **Phase 6 — Video Clip Generation.**
   - `clear_vram` first
   - For each scene with approved start AND end frames:
     - `upload_image` both the start and end frames
     - Build and enqueue the WAN 2.2 FLF dual Hi-Lo workflow (see `director` skill, Phase 6 template)
     - Use `filename_prefix: "director_s{N}"`
     - **CRITICAL**: Use dual KSamplerAdvanced (Hi pass steps 0→2, Lo pass steps 2→4). NEVER use single KSampler.
   - After each clip completes, update state file
   - Video generation takes ~140s per scene — inform the user of the wait

10. **Phase 7 — Video Review.**
    - Report each clip's filename and estimated duration
    - User can preview clips externally
    - If rejected, re-generate with new seed or modified video prompt

11. **Phase 8 — Final Assembly.**
    - Collect all approved video clip paths in scene order
    - Determine the ComfyUI output directory path for each clip
    - Create a concat list file and run ffmpeg:
      ```bash
      ffmpeg -f concat -safe 0 -i concat_list.txt -c copy ~/code/comfyui-mcp/workflows/director_final_{project_id}.mp4
      ```
    - Report the final video path to the user
    - Update state file with `final_video` path

12. **Save state after every phase.** Write the updated state JSON after each phase completes. This is critical for surviving context compaction.

## Resumption

When the argument is `resume`:

1. Find the most recent `director_state_*.json` in `~/code/comfyui-mcp/workflows/`
2. Read the state file and report the current status to the user:
   - Project ID, number of scenes, current phase
   - Which scenes have approved start/end frames
   - Which scenes have completed video clips
3. Pick up from `current_phase`. Within a phase, skip scenes whose assets are already approved.
4. `clear_vram` before loading the model family for the current phase.
5. Continue normal execution from that point.

If the user says `resume <project_id>`, look for that specific state file.

## Example

User: `/comfy-director A woman walks through a garden, discovers a mysterious glowing flower, picks it up and is transformed into a fairy`

Steps:
- **Phase 1**: Break into 3 scenes:
  1. Woman walking through garden → she stops and notices something
  2. She kneels to examine the glowing flower → she reaches out to pick it up
  3. She holds the flower and begins to transform → she has fairy wings and is floating
- Present plan, ask portrait/landscape (default portrait for character focus)
- **Phase 2**: Generate 3 start frames with Z-Image RedCraft DX1
- **Phase 3**: Show each frame, get approval
- **Phase 4**: Qwen Edit each start frame into its end frame
- **Phase 5**: Show each end frame, get approval
- **Phase 6**: Generate 3 WAN FLF video clips (~7 min total)
- **Phase 7**: Report clip filenames for preview
- **Phase 8**: ffmpeg concat into final video
- Report final video path

## Notes

- Always update the state file after any generation or approval
- Each video clip is ~5 seconds at 81 frames / 16fps
- A 4-scene production takes roughly 15 minutes of generation time on RTX 4090
- VRAM management is critical: always `clear_vram` between model families
- The Remix NSFW models have lightning baked in — no separate LoRA needed for WAN FLF
- For the WAN FLF phase, both CLIP (via LoRA stacks) and CLIPVision must use the Hi Common stack's clip output
- Negative prompt for WAN FLF is always the standard quality negative (see wan-flf-video skill)
- If ffmpeg is not available, warn the user and provide individual clip paths instead
