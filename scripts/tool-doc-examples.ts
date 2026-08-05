/**
 * Curated, human-facing examples for the generated Tool Reference.
 *
 * WHY THIS FILE EXISTS. Every page under docs/tools/ is generated from the live
 * zod schemas by scripts/gen-tool-docs.ts, and for a long time every single one
 * of them ended in "Example coming soon — the call below is a generated
 * skeleton" followed by `{"filename": "<filename>"}`. That skeleton is derived
 * mechanically from the required fields, so it is never WRONG — it is just never
 * useful either. A reader learns the parameter exists, which the parameter table
 * already told them, and nothing about what a real value looks like.
 *
 * Hand-editing the .mdx is not an option: the next `npm run docs:gen` overwrites
 * it, and CI runs docs:gen and fails if the tree changes. So the examples live
 * HERE, as data, and the generator renders them.
 *
 * THE RULE FOR ADDING ONE: every `args` object is validated against the tool's
 * real zod schema at generation time (see validateExamples in gen-tool-docs.ts).
 * A field that does not exist, or has the wrong type, fails the build rather
 * than shipping. Do not disable that check to make an example fit — if the
 * example does not typecheck, the example is wrong. A confidently wrong example
 * is worse than the skeleton it replaced, because a reader will copy it.
 *
 * WHAT MAKES A GOOD ENTRY:
 *  - `ask` is what a PERSON says out loud, not a restatement of the tool name.
 *    Nobody says "call list_workflows"; they say "what have I got saved?".
 *  - `args` uses plausible real values — a real filename, a real prompt, a real
 *    HuggingFace URL — not `<placeholder>` echoes of the field name.
 *  - `returns` says what lands back in the conversation, in a sentence.
 *  - `caution` is REQUIRED wherever the call deletes, overwrites, costs money,
 *    or interrupts work someone else may be waiting on.
 *
 * WHAT THIS FILE MUST NOT DO: rewrite the tool DESCRIPTIONS. Those are tuned for
 * model dispatch and a readability edit there is a regression in tool-choice
 * accuracy, not an improvement (#557/#654). When a description reads badly to a
 * human, add a `gloss` here — it renders ALONGSIDE the description, leaving the
 * model-facing text untouched.
 *
 * COVERAGE IS DELIBERATELY PARTIAL. The beginner path is covered end to end;
 * expert surfaces (training, RunPod, comfy-cli's 26 actions, node authoring) are
 * left on the skeleton until someone writes examples worth reading. A missing
 * example is an honest gap; a made-up one is a bug.
 */

export interface ToolDocExample {
  /** What a person actually says to the agent, in plain English. */
  ask: string;
  /**
   * The call the agent then makes. Validated against the tool's real zod schema
   * at generation time — an unknown or mistyped field fails `npm run docs:gen`.
   */
  args: Record<string, unknown>;
  /** What comes back, in a sentence or two. */
  returns: string;
  /**
   * Rendered under the JSON when the arguments are shown in shortened form —
   * used for the graph-shaped parameters, where pasting a complete 40-node
   * workflow would bury the point. Say plainly what was left out.
   */
  argsNote?: string;
  /** Rendered as a warning. Required when the call destroys or costs something. */
  caution?: string;
}

export interface ToolDocEntry {
  /**
   * A plain-language gloss shown ALONGSIDE (never instead of) the model-facing
   * description. For tools whose description is written in terms a human reader
   * has no reason to care about — context budgets, dispatch disambiguation.
   */
  gloss?: string;
  examples: ToolDocExample[];
}

/**
 * An abbreviated but structurally REAL API-format graph, for the tools that take
 * a whole workflow. Two genuine nodes rather than a fake one-liner: a reader
 * should come away knowing that API format is an object keyed by node id, each
 * value having `class_type` and `inputs`, and that a link is `[nodeId, slot]`.
 * Every entry that uses it also carries an `argsNote` saying it is shortened.
 */
const WORKFLOW_FRAGMENT = {
  "4": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" },
  },
  "9": {
    class_type: "SaveImage",
    inputs: { filename_prefix: "portrait", images: ["8", 0] },
  },
} as const;

const FRAGMENT_NOTE =
  "Shortened for readability — two nodes of a real API-format graph are shown. " +
  "In practice the agent passes the whole thing: the graph it just loaded with " +
  "get_workflow, or the one it built for you.";

export const TOOL_DOC_EXAMPLES: Readonly<Record<string, ToolDocEntry>> = {
  // -------------------------------------------------------------------------
  // Image & Audio Generation
  // -------------------------------------------------------------------------
  generate_image: {
    gloss:
      "The one-line way to get a picture. You do not need a workflow open, or " +
      "any workflow at all — describe the image and this builds and runs a " +
      "sensible graph for you. Everything except the prompt is optional and " +
      "falls back to your saved defaults.",
    examples: [
      {
        ask: "Make me a picture of a red fox in the snow.",
        args: { prompt: "a red fox in deep snow, golden hour, sharp focus" },
        returns:
          "The finished image, inline in the conversation, plus the seed and " +
          "settings that produced it so you can ask for the same thing again.",
      },
      {
        ask: "Same fox, but widescreen, more detail, and keep it repeatable.",
        args: {
          prompt: "a red fox in deep snow, golden hour, sharp focus",
          negative_prompt: "blurry, watermark, text",
          width: 1344,
          height: 768,
          steps: 30,
          cfg: 4.5,
          seed: 12345,
        },
        returns:
          "The same fields plus the image. Because `seed` was pinned, running " +
          "this again with the same settings gives the same picture — that is " +
          "how you iterate on one image instead of rolling a new one each time.",
      },
    ],
  },
  generate_video: {
    examples: [
      {
        ask: "Turn that fox picture into a short clip of it walking.",
        args: {
          prompt: "a red fox walking through deep snow, camera slowly pushing in",
          seconds: 5,
          resolution: "832x480",
          fps: 16,
        },
        returns:
          "A path to the rendered video file plus the settings used. Video takes " +
          "far longer than a still — minutes, not seconds — so the agent will " +
          "usually tell you it has started and then report back.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Workflow Execution
  // -------------------------------------------------------------------------
  health_check: {
    gloss:
      "The first thing to try when something is not working. It answers \"is " +
      "ComfyUI actually up, and can it see my models?\" in one call.",
    examples: [
      {
        ask: "Is everything working?",
        args: {},
        returns:
          "Whether the server is reachable, what it is running on, and whether " +
          "the model folders have anything in them.",
      },
      {
        ask: "Check the setup, and tell me if any recent runs blew up.",
        args: { model_categories: ["checkpoints", "loras"], recent_errors: 5 },
        returns:
          "The same report, narrowed to the two model folders you asked about, " +
          "with the last five errors from history attached.",
      },
    ],
  },
  queue: {
    gloss:
      "One tool for everything to do with the job queue — see what is waiting, " +
      "reorder it, cancel something. Which job it does is set by `action`. This " +
      "is the shape most of the newer tools have; see " +
      "[Using the tools](/using-tools) for why.",
    examples: [
      {
        ask: "What's still running?",
        args: { action: "list" },
        returns:
          "The job currently rendering and everything queued behind it, each " +
          "with its prompt_id — the receipt you use to ask about one job later.",
      },
      {
        ask: "Kill the one that's running, it's wrong.",
        args: { action: "cancel", prompt_id: "8f3c1a02-6d4e-4b9a-9f21-77c0be5d1e44" },
        returns: "Confirmation that the job was interrupted.",
        caution:
          "This stops work in progress and you do not get the partial result. " +
          "If you share this ComfyUI with anyone else, make sure the job is yours.",
      },
      {
        ask: "Clear the whole queue, I want to start over.",
        args: { action: "clear", clear_pending: true },
        returns: "Confirmation of how many jobs were dropped.",
        caution:
          "Destructive and not undoable — every waiting job is discarded, " +
          "including any that someone else queued.",
      },
    ],
  },
  get_history: {
    examples: [
      {
        ask: "Did that finish? What did it produce?",
        args: { prompt_id: "8f3c1a02-6d4e-4b9a-9f21-77c0be5d1e44" },
        returns:
          "That run's outcome and the files it wrote. Omit `prompt_id` to get " +
          "recent runs instead of one specific one.",
      },
    ],
  },
  diagnose_run: {
    gloss:
      "For when a run failed and the error text does not mean anything to you. " +
      "This reads the failure and tells you what to do about it.",
    examples: [
      {
        ask: "That render failed and I don't understand the error.",
        args: { prompt_id: "8f3c1a02-6d4e-4b9a-9f21-77c0be5d1e44" },
        returns:
          "A plain reading of what went wrong — a missing model, a bad " +
          "connection, not enough VRAM — and the suggested fix. Omit " +
          "`prompt_id` and it looks at the most recent failure.",
      },
    ],
  },
  get_system_stats: {
    examples: [
      {
        ask: "How much VRAM have I got left?",
        args: {},
        returns:
          "The GPU, its total and free VRAM, system RAM, and the ComfyUI and " +
          "Python versions.",
      },
    ],
  },
  enqueue_workflow: {
    gloss:
      "Runs a workflow that the agent is holding in the conversation — one it " +
      "just built or loaded from a file. If you want to run the graph you are " +
      "LOOKING at in ComfyUI, that is the panel's run tool instead, and if you " +
      "just want a picture, use generate_image.",
    examples: [
      {
        ask: "Run it.",
        args: { workflow: WORKFLOW_FRAGMENT },
        argsNote: FRAGMENT_NOTE,
        returns:
          "A prompt_id straight away, then the finished images once the render " +
          "completes.",
      },
    ],
  },
  get_template_schema: {
    examples: [
      {
        ask: "What can I change about the Flux template?",
        args: { template: "flux_dev_full_text_to_image" },
        returns:
          "The knobs that template exposes — prompt, size, steps, which model " +
          "file — with their current values, so you know what to pass to " +
          "run_template.",
      },
    ],
  },
  run_template: {
    examples: [
      {
        ask: "Run the Flux template with my prompt and wait for it.",
        args: {
          template: "flux_dev_full_text_to_image",
          overrides: { prompt: "a lighthouse in a storm, dramatic sky" },
          wait: true,
        },
        returns:
          "With `wait: true`, the finished result in one go. Leave it off and " +
          "you get a prompt_id immediately and check back later.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Workflow Library
  // -------------------------------------------------------------------------
  list_workflows: {
    gloss:
      "The saved workflow FILES in your ComfyUI — the same list you see in the " +
      "ComfyUI sidebar, folders and all. Usually the first call in any " +
      "\"open my…\" request.",
    examples: [
      {
        ask: "What workflows have I got saved?",
        args: {},
        returns:
          "A numbered list of names, each relative to the library root — one filed " +
          "in a folder shows as VIDEO/MiniMaxH3/clip.json. Pick one and hand the " +
          "whole name to analyze_workflow or get_workflow.",
      },
    ],
  },
  get_workflow: {
    gloss:
      "Reads a saved FILE, not the graph currently open on your canvas. Ask for " +
      "this when the agent needs the actual JSON to change or run; if you only " +
      "want to know what a workflow does, analyze_workflow is the shorter answer.",
    examples: [
      {
        ask: "Open my portrait workflow so we can change the prompt.",
        args: { filename: "portrait-flux.json" },
        returns:
          "The full workflow as runnable API-format JSON. This is a big " +
          "response — it is meant for the agent to work on, not for you to read.",
      },
      {
        ask: "Give me the raw file exactly as ComfyUI saved it.",
        args: { filename: "portrait-flux.json", format: "ui" },
        returns:
          "The on-disk UI format, including node positions and colours — what " +
          "you want if the file is going to be loaded back into the canvas " +
          "rather than executed.",
      },
    ],
  },
  analyze_workflow: {
    gloss:
      "\"Explain this workflow to me.\" Cheaper and far more readable than " +
      "get_workflow when you just want to understand what a file does.",
    examples: [
      {
        ask: "What does my portrait workflow actually do?",
        args: { filename: "portrait-flux.json" },
        returns:
          "A short summary: the model it loads, the prompts, the sampler " +
          "settings, and what it saves.",
      },
      {
        ask: "Is that workflow going to run, or is something missing?",
        args: { filename: "portrait-flux.json", view: "health" },
        returns:
          "Problems only — missing models, unconnected inputs, nodes whose " +
          "packs are not installed.",
      },
    ],
  },
  save_workflow: {
    examples: [
      {
        ask: "Save that as a new file so I don't lose the original.",
        args: { filename: "portrait-flux-v2.json", workflow: WORKFLOW_FRAGMENT },
        argsNote: FRAGMENT_NOTE,
        returns: "Confirmation and the path it was written to.",
        caution:
          "Writing to a filename that already exists replaces that file. Ask " +
          "for a new name — as above — when you want to keep the original.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Workflow Authoring
  // -------------------------------------------------------------------------
  get_node_info: {
    examples: [
      {
        ask: "What settings does the KSampler node have?",
        args: { node_type: "KSampler" },
        returns:
          "That node's inputs and outputs with their types. Dropdown options are " +
          "summarised as a count by default, because a model-loader dropdown can " +
          "be hundreds of kilobytes on its own.",
      },
    ],
  },
  validate_workflow: {
    examples: [
      {
        ask: "Will this run?",
        args: { workflow: WORKFLOW_FRAGMENT },
        argsNote: FRAGMENT_NOTE,
        returns:
          "Either a clean bill of health or the specific problems, without " +
          "queuing anything.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Assets & Images
  // -------------------------------------------------------------------------
  list_output_images: {
    gloss:
      "What has ComfyUI actually written to disk lately. Worth knowing: video " +
      "nodes often finish without registering in ComfyUI's history, so this is " +
      "the reliable way to confirm a video really rendered.",
    examples: [
      {
        ask: "Show me the last few things I generated.",
        args: { limit: 10 },
        returns:
          "The ten newest files, newest first, each with whether it is an image " +
          "or a video, its folder, size and time. Not the pictures themselves — " +
          "ask to see one and the agent fetches it.",
      },
      {
        ask: "Did that fox render ever come out?",
        args: { pattern: "fox", limit: 5 },
        returns: "Only files whose names contain \"fox\".",
      },
    ],
  },
  view_image: {
    gloss:
      "Puts an image in front of the agent so it can actually look at it — for " +
      "\"is this any good?\", \"compare these two\", \"what is wrong with the hands\".",
    examples: [
      {
        ask: "Show me that one.",
        args: { asset_id: "asset_01HQ8Z3K7V" },
        returns:
          "The image inline, visible to both of you. The asset id comes from " +
          "the completion message of the run that made it.",
      },
    ],
  },
  get_image: {
    examples: [
      {
        ask: "Save that render onto my desktop.",
        args: {
          filename: "portrait_00042_.png",
          type: "output",
          save_dir: "C:/Users/me/Desktop",
        },
        returns:
          "The file copied to that folder, and the path it landed at. Use this " +
          "rather than view_image for video and audio, which cannot be shown " +
          "inline.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------
  search_models: {
    examples: [
      {
        ask: "Find me a Flux model I can actually run.",
        args: { query: "flux schnell", limit: 5 },
        returns:
          "Matching models with their download URLs and file sizes. Nothing is " +
          "downloaded — this is a search.",
      },
    ],
  },
  download_model: {
    examples: [
      {
        ask: "Get that one.",
        args: {
          url: "https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/flux1-schnell.safetensors",
          target_subfolder: "checkpoints",
        },
        returns:
          "Live progress in the panel's download tray, and the path the file " +
          "landed at. `target_subfolder` decides which ComfyUI dropdown it shows " +
          "up in — checkpoints, loras, vae and so on.",
        caution:
          "Model files are large — many are 5-25 GB. Check you have the disk " +
          "space before agreeing to a few of these.",
      },
    ],
  },
  list_local_models: {
    examples: [
      {
        ask: "Which checkpoints do I already have?",
        args: { model_type: "checkpoints" },
        returns:
          "The model filenames in that folder — the exact strings a workflow " +
          "needs. Omit `model_type` to see every folder at once.",
      },
    ],
  },
  resolve_missing_models: {
    gloss:
      "The answer to \"this workflow says a model is missing\". It works out " +
      "what is actually absent and finds downloadable candidates, including " +
      "smaller quantised versions when the full file will not fit your GPU.",
    examples: [
      {
        ask: "This workflow won't run, it says something's missing. Find it for me.",
        args: { workflow: WORKFLOW_FRAGMENT },
        argsNote: FRAGMENT_NOTE,
        returns:
          "Each missing file with candidate downloads, their sizes and " +
          "precision, and whether each one fits your VRAM. It downloads nothing " +
          "— you pick, then it fetches.",
      },
    ],
  },
  remove_model: {
    examples: [
      {
        ask: "Delete that old LoRA, I'm out of disk space.",
        args: { path: "loras/old-character-v1.safetensors" },
        returns: "Confirmation, and how much space came back.",
        caution:
          "This deletes the file. There is no undo and no recycle bin — you " +
          "would have to download it again. Check the path is the one you mean.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Custom Nodes
  // -------------------------------------------------------------------------
  search_custom_nodes: {
    examples: [
      {
        ask: "Is there a node pack for face detailing?",
        args: { query: "face detailer", limit: 5 },
        returns:
          "Matching packs from the registry with their ids, authors and " +
          "descriptions. The id is what install_custom_node wants.",
      },
    ],
  },
  install_custom_node: {
    examples: [
      {
        ask: "Install the Impact Pack.",
        args: { id: "comfyui-impact-pack" },
        returns:
          "Progress, then confirmation. New nodes do not appear until ComfyUI " +
          "restarts — the agent will normally offer to do that for you.",
        caution:
          "A custom node pack is third-party code that runs inside your " +
          "ComfyUI. Install packs you have reason to trust, the same as any " +
          "other plugin.",
      },
    ],
  },
  install_workflow_dependencies: {
    gloss:
      "For a workflow someone sent you that is full of red nodes: this installs " +
      "the node PACKS it needs. Missing model files are a different problem — " +
      "that is resolve_missing_models.",
    examples: [
      {
        ask: "Someone sent me this workflow and half the nodes are red. Fix it.",
        args: { workflow: WORKFLOW_FRAGMENT },
        argsNote: FRAGMENT_NOTE,
        returns:
          "What it installed, what was already there, and anything it could not " +
          "find. A restart is normally needed before the nodes load.",
      },
    ],
  },
  node_snapshot: {
    gloss:
      "A restore point for your installed node packs. Take one before a round " +
      "of installing, and you have a way back if something breaks.",
    examples: [
      {
        ask: "Save where my nodes are at before I start installing things.",
        args: { action: "save", name: "before-impact-pack" },
        returns: "Confirmation that the snapshot was recorded.",
      },
      {
        ask: "That broke everything. Put it back how it was.",
        args: { action: "restore", name: "before-impact-pack" },
        returns: "What it added, removed or re-pinned to match the snapshot.",
        caution:
          "Restoring rewrites your installed node packs to match the snapshot — " +
          "anything installed since is uninstalled or downgraded.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Install & Environment
  // -------------------------------------------------------------------------
  workspace: {
    gloss:
      "Which ComfyUI installation everything else is talking about. One tool, " +
      "three jobs, chosen with `action` — this is the tool the " +
      "[consolidation note](/using-tools#one-tool-several-jobs) uses as its " +
      "worked example.",
    examples: [
      {
        ask: "Which ComfyUI am I actually using?",
        args: { action: "get" },
        returns:
          "The active install's path and how it was chosen — a flag, an " +
          "environment variable, or the saved default.",
      },
      {
        ask: "Always use the one on my big drive from now on.",
        args: { action: "set_default", path: "D:/AI/ComfyUI" },
        returns:
          "Confirmation, and it sticks across restarts. Later sessions target " +
          "this install unless something overrides it.",
      },
    ],
  },
  install_panel: {
    gloss:
      "Installs and updates the Agent sidebar inside ComfyUI. This is the fix " +
      "when a tool refuses with \"this panel is too old\".",
    examples: [
      {
        ask: "What version of the panel have I got?",
        args: { action: "status" },
        returns:
          "The installed panel version, where it lives, and whether it is " +
          "pinned. This action changes nothing.",
      },
      {
        ask: "It says my panel is too old — update it.",
        args: { action: "update" },
        returns:
          "The update result. Two more steps are yours: restart ComfyUI, then " +
          "hard-refresh the ComfyUI browser tab (Ctrl+Shift+R). Without that " +
          "refresh the tab keeps running the old cached panel code and the same " +
          "refusal comes back.",
      },
    ],
  },
  get_environment: {
    examples: [
      {
        ask: "Tell me about my setup — useful when I'm reporting a bug.",
        args: {},
        returns:
          "Where ComfyUI is installed, the Python and torch versions, the GPU, " +
          "and which settings are in force. The first thing to paste into an " +
          "issue.",
      },
    ],
  },
  self_update: {
    examples: [
      {
        ask: "Am I on the latest version?",
        args: { action: "status" },
        returns: "Your version, the latest published version, and whether they differ.",
      },
      {
        ask: "Update it.",
        args: { action: "update" },
        returns:
          "The upgrade result. Your MCP client has to be restarted afterwards " +
          "to pick up the new server.",
      },
    ],
  },
  report_issue: {
    examples: [
      {
        ask: "This keeps crashing. File a bug about it.",
        args: {
          title: "Video render finishes but no file appears in outputs",
          body:
            "Running the WAN template completes and history shows success, but " +
            "output/video/ is empty. Happens every time on 0.49.3.",
        },
        returns:
          "A GitHub issue on the project, with your environment details " +
          "attached automatically, and a link to it.",
        caution:
          "This posts publicly. The environment block it attaches includes " +
          "paths and versions from your machine — glance at what it drafted " +
          "before agreeing to send it.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Process Control
  // -------------------------------------------------------------------------
  start_comfyui: {
    examples: [
      {
        ask: "Start ComfyUI.",
        args: {},
        returns:
          "It launches the server and waits until it is answering, then tells " +
          "you the URL. Only works for a ComfyUI on this machine.",
      },
    ],
  },
  restart_comfyui: {
    gloss:
      "The standard next step after installing a node pack — new nodes are not " +
      "loaded until ComfyUI starts again.",
    examples: [
      {
        ask: "Restart it so the new nodes load.",
        args: {},
        returns:
          "The server stops and comes back up, and you are told when it is " +
          "answering again.",
        caution:
          "Anything queued or rendering is lost. Check the queue is empty first " +
          "if a long job is in flight.",
      },
    ],
  },
  stop_comfyui: {
    examples: [
      {
        ask: "Shut ComfyUI down, I need the VRAM.",
        args: {},
        returns: "Confirmation that the process stopped.",
        caution: "Any running or queued render is lost.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------
  get_defaults: {
    examples: [
      {
        ask: "What settings do you use when I don't say?",
        args: {},
        returns:
          "The current fallback size, steps, cfg, sampler and checkpoint, and " +
          "where each came from.",
      },
    ],
  },
  set_defaults: {
    gloss:
      "Stop repeating yourself. Set the values you always want once, and leave " +
      "them out of every later request.",
    examples: [
      {
        ask: "Always use 1024 by 1024 and 30 steps, permanently.",
        args: { values: { width: 1024, height: 1024, steps: 30 }, persist: true },
        returns:
          "Confirmation of the new defaults. `persist: true` writes them to your " +
          "config file so they survive a restart; without it they last only for " +
          "this session.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Apps (micro-apps)
  // -------------------------------------------------------------------------
  apps: {
    gloss:
      "Micro-apps are workflows someone has already wired up and reduced to a " +
      "few boxes to fill in — the closest thing here to a normal app. Handy on " +
      "mobile, where there is no canvas to edit. One tool, several jobs, chosen " +
      "with `action`.",
    examples: [
      {
        ask: "What one-click apps do I have?",
        args: { action: "list" },
        returns:
          "Every installed app with its id, name and description. Read-only.",
      },
      {
        ask: "What do I need to fill in for the portrait one?",
        args: { action: "get", app_id: "b1f4c2de-90a7-4c3e-9d21-5c8e2f7a13bb" },
        returns:
          "That app's input form — each box with its label, type and default, " +
          "and the key you set it by.",
      },
      {
        ask: "Run it with \"a snow leopard on a rooftop\".",
        args: {
          action: "run",
          app_id: "b1f4c2de-90a7-4c3e-9d21-5c8e2f7a13bb",
          values: { "6.text": "a snow leopard on a rooftop at dusk" },
        },
        returns:
          "A prompt_id immediately; the app renders in the background. Check on " +
          "it with `action: \"run_status\"` and the same app_id plus that " +
          "prompt_id. The odd-looking `\"6.text\"` key is nodeId.widget — the " +
          "form from `action: \"get\"` tells you which keys exist.",
      },
    ],
  },
};
