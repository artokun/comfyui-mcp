---
description: Generate a Claude skill for a ComfyUI custom node pack
argument-hint: Registry ID or GitHub URL of the node pack
---

# /comfy-skill — Generate a Node Pack Skill

The user wants to generate a Claude Code skill file for a ComfyUI custom node pack.

## Instructions

1. **Parse the argument.** The argument is: $ARGUMENTS
   - A ComfyUI Registry ID (e.g., `comfyui-impact-pack`)
   - A GitHub repository URL (e.g., `https://github.com/ltdrdata/ComfyUI-Impact-Pack`)
   - Nothing — ask the user which node pack they want to generate a skill for

2. **Generate the skill.** Use the `list_packs` tool with:
   - `action`: `"generate_skill"`
   - `source`: the registry ID or GitHub URL
   - `install_in`: save to `skills/<pack-name>/` inside the plugin directory

3. **Report the result.** Tell the user:
   - Where the skill file was saved
   - A brief summary of what nodes are covered
   - That they may need to restart Claude Code for the skill to take effect

## Example

User: `/comfy-skill comfyui-impact-pack`

Steps:
- Call `list_packs` with `action: "generate_skill"`, source `"comfyui-impact-pack"` and `install_in` set to the skills directory
- Show the user where the file was saved and what it covers

## Notes

- The generated skill includes node class types, input/output specs, usage examples, and a `## Sources` section (official repo README vs empirically-tuned composition patterns)
- Skills are saved as `SKILL.md` files in subdirectories under the plugin's `skills/` folder
- If the node pack isn't found in the registry, suggest the user provide a GitHub URL instead
- If nodes from the pack are installed locally, the skill will include live `/object_info` data
