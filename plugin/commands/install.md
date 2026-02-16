---
description: Install a ComfyUI custom node pack
argument-hint: Pack name, registry ID, or GitHub URL
---

# /comfy-install — Install a Custom Node Pack

The user wants to install a ComfyUI custom node pack from the registry or a GitHub repository.

## Instructions

1. **Parse the argument.** The argument is: $ARGUMENTS

   If no argument was provided, ask the user what node pack they want to install.

   Determine the source type:
   - **GitHub URL**: starts with `https://github.com/` — use directly
   - **Registry ID**: a slug like `comfyui-impact-pack` — search for it
   - **Descriptive name**: like "Impact Pack" or "ControlNet" — search for it

2. **Find the pack.** If not a direct GitHub URL:
   - Call `search_custom_nodes` with the argument as the query
   - Present the top results: name, description, author, star count
   - If multiple matches, ask the user to confirm which one they want
   - Call `get_node_pack_details` with the selected pack ID for full info including the repository URL

3. **Confirm with the user.** Before installing, show:
   - Pack name and description
   - Author and repository URL
   - Number of nodes included (if available)
   - Ask for explicit confirmation to proceed

4. **Determine the custom_nodes directory.** The custom nodes directory is typically at the ComfyUI base path under `custom_nodes/`. Check `get_system_stats` if needed to find the ComfyUI installation path. Verify the directory exists.

5. **Clone the repository.** Use the Bash tool to:
   ```
   git clone {repo_url} {custom_nodes_dir}/{pack_name}
   ```
   If the directory already exists, inform the user and ask if they want to update it (`git pull`) instead.

6. **Install dependencies.** Check for dependency files in the cloned directory:
   - If `requirements.txt` exists: run `pip install -r requirements.txt` using ComfyUI's Python venv
   - If `install.py` exists: run it with ComfyUI's Python interpreter
   - Use the venv Python path (e.g., `.venv/Scripts/python.exe` on Windows or `.venv/bin/python` on Linux/macOS)

7. **Restart ComfyUI.** Tell the user that new nodes require a restart to be loaded. Offer to call `restart_comfyui` to restart automatically.

8. **Generate a skill file (optional).** Ask the user if they'd like to generate a Claude Code skill for the new pack. If yes, call `generate_node_skill` with the pack source to create a skill file that helps Claude understand the new nodes.

## Example

User: `/comfy-install comfyui-impact-pack`

Steps:
- Search custom nodes for "comfyui-impact-pack"
- Show pack info and confirm with user
- Clone `https://github.com/ltdrdata/ComfyUI-Impact-Pack` into custom_nodes/
- Install requirements.txt with venv pip
- Suggest restarting ComfyUI
- Offer to generate a node skill

## Notes

- Always use the ComfyUI venv Python for dependency installation, never the system Python
- Some packs have complex dependencies (e.g., GroundingDINO, SAM) — if pip install fails, show the error and suggest manual intervention
- If `git clone` fails due to the directory already existing, offer `git pull` to update instead
- Some packs require additional model downloads after installation — check the pack README for post-install steps
- After installation and restart, verify the nodes loaded by calling `get_node_info` with one of the pack's node names
