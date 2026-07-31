// generate_audio tool originally contributed by @x-yahya997 in
// `x-yahya997/comfyui-mcp@c2ff7a9` and merged here with thanks.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateAudio as generateAudioService } from "../services/generate-audio.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { listLocalModels } from "../services/model-resolver.js";
import { errorToToolResult } from "../utils/errors.js";

async function resolveFirstModel(type: string): Promise<string | undefined> {
  try {
    const models = await listLocalModels(type);
    return models[0]?.name;
  } catch {
    return undefined;
  }
}

const deps = {
  resolveFirstModel,
  enqueue: (workflow: Parameters<typeof enqueueWorkflow>[0]) => enqueueWorkflow(workflow),
};

export function registerGenerateAudioTool(server: McpServer): void {
  server.tool(
    "generate_audio",
    "Generate audio from a text prompt — supports ACE Step 1.5 and Stable Audio 3 model families. " +
      "Builds the appropriate workflow graph, filling unspecified parameters from your configured defaults " +
      "(set_defaults / COMFYUI_DEFAULT_* / config file), auto-selecting local models when needed. " +
      "Returns the prompt_id immediately; the resulting audio asset_id arrives in the completion notification. " +
      "Requires a running ComfyUI with the corresponding model files installed.",
    {
      model_family: z
        .enum(["ace_step_1.5", "stable_audio_3"])
        .describe("Audio model family — determines which workflow template and model loaders to use"),
      prompt: z.string().describe("Text description of the audio to generate (genre, mood, instruments, etc.)"),
      duration: z
        .number()
        .positive()
        .describe("Audio duration in seconds"),
      seed: z.number().int().optional().describe("Seed (omit to randomize)"),
      steps: z.number().int().positive().optional().describe("Sampling steps"),
      cfg: z.number().positive().optional().describe("CFG scale"),
      sampler: z.string().optional().describe("Sampler name (e.g. euler, lcm, dpmpp_2m)"),
      scheduler: z.string().optional().describe("Scheduler (e.g. normal, simple, karras)"),
      filename_prefix: z
        .string()
        .optional()
        .describe("Output filename prefix (default: audio/ace_step or audio/stable_audio_3)"),

      // ACE Step 1.5 specific
      unet: z
        .string()
        .optional()
        .describe("ACE UNet model filename (in models/diffusion_models/); auto-selected if omitted"),
      vae: z.string().optional().describe("ACE VAE model filename (in models/vae/); auto-selected if omitted"),
      clip_a: z
        .string()
        .optional()
        .describe("Primary text encoder filename (in models/text_encoders/); auto-selected if omitted"),
      clip_b: z
        .string()
        .optional()
        .describe("Secondary text encoder filename (in models/text_encoders/); auto-selected if omitted"),
      lyrics: z
        .string()
        .optional()
        .describe("Lyrics or song structure description (ACE only — section-by-section breakdown)"),
      language: z
        .string()
        .optional()
        .describe("Language code for prompt (ACE only, default: 'en')"),
      musical_key: z
        .string()
        .optional()
        .describe("Target musical key (ACE only, e.g. 'C major', 'E minor'; default: 'C major')"),
      shift: z
        .number()
        .optional()
        .describe("ModelSamplingAuraFlow shift parameter (ACE only, default: 3)"),
      guidance_scale: z
        .number()
        .optional()
        .describe(
          "TextEncodeAceStepAudio1.5 cfg_scale — text encoder guidance scale (ACE only, default: 2)",
        ),
      bpm: z
        .number()
        .int()
        .min(10)
        .max(300)
        .optional()
        .describe("TextEncodeAceStepAudio1.5 tempo in beats per minute (ACE only, 10-300, default: 120)"),
      timesignature: z
        .enum(["2", "3", "4", "6"])
        .optional()
        .describe("TextEncodeAceStepAudio1.5 time signature (ACE only, one of '2'/'3'/'4'/'6', default: '4')"),
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe("TextEncodeAceStepAudio1.5 LLM sampling temperature (ACE only, 0-2, default: 0.85)"),
      top_p: z
        .number()
        .min(0)
        .max(2000)
        .optional()
        .describe("TextEncodeAceStepAudio1.5 LLM top-p nucleus sampling (ACE only, 0-2000, default: 0.9)"),
      top_k: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("TextEncodeAceStepAudio1.5 LLM top-k sampling (ACE only, 0-100, default: 0 = disabled)"),
      min_p: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("TextEncodeAceStepAudio1.5 LLM min-p sampling (ACE only, 0-1, default: 0)"),
      generate_audio_codes: z
        .boolean()
        .optional()
        .describe("TextEncodeAceStepAudio1.5 — generate audio codes via the LLM (ACE only, default: true)"),
      audio_quality: z
        .enum(["V0", "128k", "320k"])
        .optional()
        .describe("SaveAudioMP3 bitrate/quality (ACE only, one of 'V0'/'128k'/'320k', default: '320k')"),

      // Stable Audio 3 specific
      checkpoint: z
        .string()
        .optional()
        .describe("Stable Audio 3 checkpoint filename (in models/checkpoints/); auto-selected if omitted"),
      clip: z
        .string()
        .optional()
        .describe("Stable Audio CLIP encoder filename (in models/text_encoders/); auto-selected if omitted"),
      negative_prompt: z
        .string()
        .optional()
        .describe("Negative prompt (Stable Audio 3 only; default: empty)"),
    },
    async (args) => {
      try {
        const result = await generateAudioService(args, deps);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  model_family: result.model_family,
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  note: "asset_id will be available in the completion notification; the SaveAudioMP3 node writes the output file to ComfyUI's output directory.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
