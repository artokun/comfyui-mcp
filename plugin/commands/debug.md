---
description: Diagnose why a ComfyUI workflow failed
argument-hint: prompt_id or "last" to debug the most recent execution
---

# /comfy-debug — Diagnose a Failed Workflow

The user wants to find out why a ComfyUI workflow execution failed and get a suggested fix.

## Instructions

1. **Get the execution history.** The argument is: $ARGUMENTS
   - If a prompt_id is provided, call `get_history` with that prompt_id
   - If "last" is provided or no argument given, call `get_history` with no prompt_id to get the most recent execution

2. **Extract the error.** From the history response, identify:
   - `node_id`: the node where execution failed
   - `node_type` / `class_type`: what kind of node it was
   - `exception_message`: the error message
   - `traceback`: the full Python traceback

   If the execution succeeded (no error), tell the user it completed normally and show the output summary.

3. **Get relevant logs.** Call `get_logs` with a `keyword` filter matching the error — use the exception class name (e.g., "RuntimeError", "ValueError") or a distinctive phrase from the error message. Request up to 200 lines.

4. **Inspect the failing node.** Call `get_node_info` with the `node_type` of the failing node. Check:
   - What inputs does the node expect?
   - Are there required inputs that might be missing or mistyped?
   - What data types are expected for each input?

5. **Check for missing models.** If the error mentions a missing file, model, or checkpoint:
   - Call `list_local_models` to see what's installed
   - Compare against what the workflow references
   - If a model is missing, suggest using `download_model` or provide a search query for `search_models`

6. **Check for missing nodes.** If the error is a `KeyError` or mentions an unknown node type:
   - The node pack may not be installed
   - Call `search_custom_nodes` with the node class name to find which pack provides it
   - Suggest installing the pack

7. **Present the diagnosis.** Provide a clear summary:
   - **What failed**: node type, node ID, and a one-line description
   - **Why it failed**: root cause explanation in plain language
   - **Suggested fix**: concrete steps the user can take to resolve the issue
   - **Traceback excerpt**: the most relevant lines from the traceback (not the full dump)

## Common Failure Patterns

- **OOM / CUDA out of memory**: Suggest reducing resolution, using FP8 models, or `clear_vram` before retrying
- **Missing checkpoint/model file**: Show what's installed, offer to download the right one
- **Missing custom node**: Identify the pack and suggest installation
- **Shape mismatch**: Usually a resolution or latent size issue — check width/height are multiples of 8 (or 64 for some models)
- **NaN/Inf in tensor**: Model corruption or extreme CFG values — suggest re-downloading the model or lowering CFG
- **Connection type mismatch**: A node is receiving the wrong data type — check the workflow wiring

## Example

User: `/comfy-debug last`

Steps:
- Call `get_history` with no prompt_id
- Find error: node 12 (KSampler) threw RuntimeError "Expected all tensors to be on the same device"
- Call `get_logs` with keyword "RuntimeError"
- Call `get_node_info` for "KSampler"
- Diagnose: model and conditioning are on different devices, likely a VRAM issue
- Suggest: restart ComfyUI or use `clear_vram` before retrying

## Notes

- If multiple nodes errored, focus on the first failure in the execution chain — downstream errors are usually cascading
- The traceback is Python-level; translate it into user-friendly language
- If the error is ambiguous, suggest the user share their workflow JSON for deeper inspection
