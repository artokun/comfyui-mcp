---
description: Convert between ComfyUI UI format and API format workflows
argument-hint: Path to a workflow JSON file
---

# /comfy-convert — Convert Workflow Format

The user wants to convert a ComfyUI workflow between the web UI format and the API format.

## Instructions

1. **Read the workflow file.** The argument is: $ARGUMENTS
   - If a file path is provided, read it with the Read tool
   - If no argument is provided, ask the user for a file path or to paste the JSON

2. **Detect the format.** Examine the JSON structure:
   - **UI format**: has top-level `"nodes"` array and `"links"` array (this is what "Save" in the web UI produces)
   - **API format**: has string keys (node IDs like `"1"`, `"2"`) where each value has `"class_type"` and `"inputs"` (this is what "Save (API Format)" produces)

   Tell the user which format was detected and which format it will be converted to.

3. **If converting UI format to API format:**

   a. Iterate over each node in the `"nodes"` array. Each node has:
      - `id` (integer) — becomes the string key in API format
      - `type` — becomes `class_type`
      - `widgets_values` — ordered list of widget values
      - `inputs` — array of input slots with `name`, `type`, and optional `link`
      - `outputs` — array of output slots

   b. For each node, call `get_node_info` with the node's `type` to get the input schema. This tells you:
      - The order and names of widget inputs (to map `widgets_values` correctly)
      - Which inputs are required vs optional
      - Expected types for each input

   c. Build the API node's `inputs` object:
      - Map `widgets_values` to named inputs using the order from `get_node_info`
      - For linked inputs (where `link` is not null), find the connection in the `"links"` array. Each link is `[link_id, source_node_id, source_slot, target_node_id, target_slot, type]`. Set the input value to `["{source_node_id}", source_slot]`

   d. Assemble the API workflow: `{ "{node_id}": { "class_type": type, "inputs": {...} }, ... }`

4. **If converting API format to UI format:**

   Warn the user that API-to-UI conversion is lossy — layout positions, colors, groups, and notes will not be preserved. The converted workflow will load in ComfyUI but nodes will need to be manually arranged.

   a. For each API node, create a UI node object with:
      - `id`: integer version of the string key
      - `type`: from `class_type`
      - `pos`: auto-generated grid position (space nodes out evenly)
      - `widgets_values`: extract non-link values from `inputs` in schema order (use `get_node_info`)
      - `inputs`/`outputs`: slot definitions from `get_node_info`

   b. Build the `links` array from input connections. Each input value that is an array `[source_id, slot]` becomes a link entry.

   c. Assemble the UI workflow with `nodes`, `links`, and `version` fields.

5. **Output the result.** Pretty-print the converted JSON. Ask the user if they'd like to save it to a file, and if so, write it using the Write tool.

6. **Validate.** Optionally use `validate_workflow` to check the converted API workflow is valid before saving.

## Example

User: `/comfy-convert ~/workflows/my-ui-workflow.json`

Steps:
- Read the file
- Detect UI format (has "nodes" and "links" arrays)
- For each node, query `get_node_info` to map widget values
- Build API format JSON
- Present the result and offer to save

## Notes

- UI-to-API conversion is the more common and reliable direction
- Some widget values may be tricky to map if the node has dynamic inputs — flag these for the user
- If `get_node_info` fails for a node type, it may be a custom node that isn't installed — warn the user
- Large workflows (50+ nodes) may require many `get_node_info` calls; batch them efficiently
- The `"extra"` and `"config"` fields in UI format can be preserved but aren't needed for API format
