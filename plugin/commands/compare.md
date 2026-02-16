---
description: Diff two ComfyUI workflows to see what changed
argument-hint: "Two file paths or workflow names separated by 'vs' (e.g. workflow_a.json vs workflow_b.json)"
---

# /comfy-compare — Compare Two Workflows

The user wants to see the differences between two ComfyUI workflows — what nodes were added, removed, or changed.

## Instructions

1. **Parse the arguments.** The argument is: $ARGUMENTS

   If no argument was provided, ask the user for two workflow sources.

   Split the argument on `" vs "` or `" VS "` to get two sources. Each source can be:
   - **File path**: a path to a workflow JSON file — read it with the Read tool
   - **Saved workflow name**: a name from ComfyUI's library — load with `get_workflow`
   - **`last`**: the most recent execution — load from `get_history`
   - **Prompt ID**: a specific execution ID — load from `get_history` with that ID

2. **Load both workflows.** Read/fetch both workflow sources. Label them **Workflow A** (first) and **Workflow B** (second).

3. **Normalize to API format.** If either workflow is in UI format (has `"nodes"` and `"links"` arrays), note this and work with the node data. For consistent comparison, map both to a common structure:
   - Node identifier: use `class_type` + node ID
   - Inputs: named input keys with their values

4. **Compare the workflows.** Perform a structural diff:

   a. **Nodes only in A**: nodes present in A but not in B (matched by node ID, then by class_type if IDs differ)
   b. **Nodes only in B**: nodes present in B but not in A
   c. **Nodes in both**: matched by node ID and class_type

   For matched nodes, diff the inputs:
   - **Changed values**: same input name but different value (e.g., steps: 20 vs 30)
   - **Changed connections**: same input name but different source node or slot
   - **Added inputs**: input present in B but not in A
   - **Removed inputs**: input present in A but not in B

5. **Present the diff.** Format the comparison clearly:

   ```
   === Workflow Comparison ===

   Nodes only in A (removed):
   - Node 5: CLIPTextEncode (negative prompt encoder)

   Nodes only in B (added):
   - Node 12: UpscaleLatent

   Changed parameters:
   - Node 3 (KSampler):
       steps: 20 → 30
       cfg: 7.0 → 8.5
       sampler_name: euler → dpmpp_2m
   - Node 1 (CheckpointLoaderSimple):
       ckpt_name: sd_xl_base.safetensors → juggernaut_xl.safetensors
   ```

6. **Visual comparison (optional).** Offer to visualize both workflows side by side:
   - Call `visualize_workflow` for Workflow A
   - Call `visualize_workflow` for Workflow B
   - Present both diagrams so the user can see the structural differences

## Example

User: `/comfy-compare ~/workflows/v1.json vs ~/workflows/v2.json`

Steps:
- Read both files
- Detect both are API format
- Match nodes by ID and class_type
- Find: v2 added an upscale node, changed KSampler steps from 20 to 30, switched checkpoint
- Present the diff summary
- Offer to visualize both

## Notes

- Node matching is done first by node ID, then by class_type as a fallback if IDs were renumbered
- If both workflows have completely different node IDs but similar structure, attempt to match by class_type and position in the graph
- Connection changes are shown as "Node X slot Y" references for clarity
- This is a structural diff, not a visual/pixel diff of outputs
- For workflows from `get_history`, the workflow is embedded in the history response under the output data
