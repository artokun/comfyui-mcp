---
description: Visualize a ComfyUI workflow as a mermaid diagram
argument-hint: Path to workflow JSON file, or paste JSON inline
---

# /comfy-viz — Visualize a Workflow

The user wants to visualize a ComfyUI workflow as a mermaid flowchart diagram.

## Instructions

1. **Get the workflow JSON.** The argument may be: $ARGUMENTS
   - A file path to a workflow JSON file — read it with the Read tool
   - Inline JSON pasted directly as the argument
   - Nothing — ask the user to provide a workflow file path or paste the JSON

2. **Validate the input.** The workflow must be in ComfyUI's API format: an object where keys are node IDs and values have `class_type` and `inputs`. If it looks like the web UI format (has `nodes` and `links` arrays), tell the user it needs to be in API format and suggest they export it via "Save (API Format)" in ComfyUI.

3. **Visualize.** Use the `visualize_workflow` tool with:
   - `workflow`: the parsed workflow JSON
   - `show_values`: `true` (to include parameter values in node labels)
   - `direction`: `"LR"` (left-to-right, easiest to read)

4. **Present the diagram.** Show the mermaid output to the user. The mermaid code block will render as a flowchart showing nodes grouped by category with labeled connections.

## Example

User: `/comfy-viz ~/workflows/my-workflow.json`

Steps:
- Read the file at `~/workflows/my-workflow.json`
- Pass contents to `visualize_workflow`
- Display the mermaid diagram

## Notes

- If the workflow is very large (50+ nodes), suggest using `direction: "TB"` (top-to-bottom) for better readability
- The diagram groups nodes into subgraphs by category: loading, conditioning, sampling, image, output
- Connection edges are labeled with data types (MODEL, CLIP, CONDITIONING, LATENT, IMAGE, VAE, etc.)
