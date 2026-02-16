---
description: Parameter sweep generation across multiple values
argument-hint: "prompt, param:range (e.g. a cat, cfg:5-10, sampler:euler,dpmpp_2m)"
---

# /comfy-batch — Parameter Sweep Generation

The user wants to generate multiple images while sweeping across different parameter values to compare results.

## Instructions

1. **Parse the arguments.** The argument is: $ARGUMENTS

   If no argument was provided, ask the user for a prompt and which parameters to sweep.

   Extract:
   - **Prompt text**: everything that isn't a parameter range specifier
   - **Parameter ranges**: identified by `param_name:values` syntax

2. **Parse parameter range syntax.** Supported formats:
   - `param:min-max` — integer range with step 1 (e.g., `cfg:5-10` produces 5, 6, 7, 8, 9, 10)
   - `param:min-max:step` — range with explicit step (e.g., `cfg:4-12:2` produces 4, 6, 8, 10, 12)
   - `param:val1,val2,val3` — explicit list (e.g., `sampler:euler,dpmpp_2m,dpmpp_sde`)
   - `seed:N` — special: generate N different random seeds (e.g., `seed:4` produces 4 random seeds)

3. **Supported sweep parameters:**
   - `cfg` — CFG scale (float)
   - `steps` — sampling steps (integer)
   - `sampler` or `sampler_name` — sampler algorithm name
   - `scheduler` — scheduler name
   - `seed` — random seed count or explicit seeds
   - `denoise` — denoising strength (float, 0.0-1.0)
   - `width` — image width in pixels
   - `height` — image height in pixels

4. **Calculate total combinations.** Multiply the count of values for each swept parameter. If the total exceeds 20, warn the user:
   - Show the total count and estimated time
   - Ask for confirmation before proceeding
   - Suggest reducing ranges if the count is very high

5. **Check available models.** Call `list_local_models` with `model_type: "checkpoints"` to find a checkpoint. If none are available, follow the model acquisition steps from the gen command.

6. **Generate each combination.** For each parameter combination:
   - Call `create_workflow` with template `"txt2img"` and the current parameter set including `positive_prompt`
   - Call `enqueue_workflow` with the created workflow, then poll `get_job_status` until done
   - Track: parameter values used, success/failure, output filename

7. **Present results.** After all runs complete, show a summary table:
   - Each row: parameter values used, status (success/error), output file
   - Highlight which combinations succeeded and which failed
   - If any failed, briefly note the error

8. **Suggest best result.** Based on which runs completed without errors, note the successful combinations. If all succeeded, suggest the user compare the outputs visually.

## Example

User: `/comfy-batch a majestic eagle in flight, cfg:5-9:2, sampler:euler,dpmpp_2m`

Parsed:
- Prompt: "a majestic eagle in flight"
- cfg: [5, 7, 9]
- sampler: ["euler", "dpmpp_2m"]
- Total: 3 x 2 = 6 images

Steps:
- List checkpoints, select one
- Generate 6 workflows with all combinations
- Run each workflow
- Present a 3x2 grid of results

## Notes

- Always randomize seeds unless `seed` is explicitly specified in the sweep
- Use sensible defaults for non-swept parameters (1024x1024 for SDXL, 20 steps, cfg 7)
- Run workflows sequentially, not in parallel — ComfyUI processes one at a time anyway
- If a single run fails, continue with the remaining combinations rather than stopping entirely
- For large sweeps, suggest the user start with a smaller subset to test
