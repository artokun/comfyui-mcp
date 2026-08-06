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
 *    Nobody says "call the library listing"; they say "what have I got saved?".
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
 * expert surfaces (training, comfy-cli's 26 actions) are left on the skeleton
 * until someone writes examples worth reading. A missing example is an honest
 * gap; a made-up one is a bug. RunPod left that list in 0.50.0, and node
 * authoring left it in the same release — see the notes above their entries for
 * why a skeleton stopped being adequate for a tool whose only required field is
 * `action`.
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
      "The one-line way to get a picture — and, through `action`, the same " +
      "one-line way to get audio, a video clip, a 3D model, a re-run of an " +
      "earlier image, an upscale, or a background removed. You do not need a " +
      "workflow open, or any workflow at all: describe what you want and this " +
      "builds and runs a sensible graph for you. Everything except `action` " +
      "and the one or two fields that action needs is optional and falls back " +
      "to your saved defaults.",
    examples: [
      {
        ask: "Make me a picture of a red fox in the snow.",
        args: { action: "image", prompt: "a red fox in deep snow, golden hour, sharp focus" },
        returns:
          "The finished image, inline in the conversation, plus the seed and " +
          "settings that produced it so you can ask for the same thing again.",
      },
      {
        ask: "Same fox, but widescreen, more detail, and keep it repeatable.",
        args: {
          action: "image",
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
      {
        ask: "Turn that fox picture into a short clip of it walking.",
        args: {
          action: "video",
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
      {
        ask: "That one was nearly right — run it again with more steps.",
        args: {
          action: "regenerate",
          asset_id: "a3f9c1",
          overrides: { steps: 40 },
        },
        returns:
          "A new render from the EXACT graph that produced that asset, with " +
          "only the fields you named changed. The seed is re-rolled unless you " +
          "pass one, so this gives you a fresh take rather than the same image.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Workflow Execution
  // -------------------------------------------------------------------------
  get_system_stats: {
    gloss:
      'Three read-only views of the connected ComfyUI: action:"stats" for what ' +
      'it is running on, action:"logs" for what it has said, and ' +
      'action:"health" for whether it is fit to dispatch work to. Nothing here ' +
      "changes anything — freeing VRAM is clear_vram, and filing a bug is " +
      "report_issue.",
    examples: [
      {
        ask: "How much VRAM have I got left?",
        args: { action: "stats" },
        returns:
          "The GPU, its total and free VRAM, system RAM, and the ComfyUI and " +
          "Python versions.",
      },
      {
        ask: "Is everything working?",
        args: { action: "health" },
        returns:
          "Whether the server is reachable, what it is running on, and whether " +
          "the model folders have anything in them.",
      },
      {
        ask: "Check the setup, and tell me if any recent runs blew up.",
        args: { action: "health", model_categories: ["checkpoints", "loras"], recent_errors: 5 },
        returns:
          "The same report, narrowed to the two model folders you asked about, " +
          "with the last five errors from history attached.",
      },
      {
        ask: "Show me the last errors from the server log.",
        args: { action: "logs", keyword: "error", max_lines: 50 },
        returns: "The last fifty log lines that mention 'error', ANSI codes stripped.",
      },
    ],
  },
  enqueue_workflow: {
    gloss:
      "Starts a render. `action` says where the graph comes from: one the " +
      "agent is holding in the conversation, an earlier run, a URL someone " +
      "shared, or a bundled template. If you want to run the graph you are " +
      "LOOKING at in ComfyUI, that is the panel's run tool instead, and if you " +
      "just want a picture, use generate_image.",
    examples: [
      {
        ask: "Run it.",
        args: { action: "enqueue", workflow: WORKFLOW_FRAGMENT },
        argsNote: FRAGMENT_NOTE,
        returns:
          "A prompt_id straight away, then the finished images once the render " +
          "completes.",
      },
      {
        ask: "What can I change about the anima text-to-image pack?",
        args: { action: "template_schema", template: "anima-txt2img" },
        returns:
          "The knobs that template exposes — prompt, size, steps, which model " +
          "file — with their current values, and the exact keys to pass as " +
          "`overrides` when you run it. Read-only.",
      },
      {
        ask: "Run the anima pack with my prompt and wait for it.",
        args: {
          action: "run_template",
          template: "anima-txt2img",
          overrides: { "45.text": "a lighthouse in a storm, dramatic sky" },
          wait: true,
        },
        argsNote:
          "Override keys are `\"<nodeId>.<widget_name>\"`, not bare parameter names — " +
          "a plain `\"prompt\"` is rejected. 45 is the positive CLIPTextEncode in THIS " +
          "pack; every template numbers its nodes differently, so read the keys off " +
          "the schema call above rather than copying this one.",
        returns:
          "With `wait: true`, the finished result in one go. Leave it off and " +
          "you get a prompt_id immediately and check back later.",
      },
      {
        ask: "Someone posted this workflow — what is in it?",
        args: {
          action: "run_url",
          url: "https://raw.githubusercontent.com/comfyanonymous/ComfyUI_examples/master/flux/flux_dev_example.json",
        },
        returns:
          "A summary of the graph and a validation report, WITHOUT running it. " +
          "Add `run: true` to enqueue it once you have read what it does.",
        caution:
          "`run: true` executes a graph you did not write on your own GPU. " +
          "Read the summary first — a shared workflow can pull in models and " +
          "custom nodes you do not have, and will fail late if so.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Workflow Library
  // -------------------------------------------------------------------------
  get_workflow: {
    gloss:
      "Everything you can READ about a saved workflow FILE, chosen with " +
      "`action` — the library listing, the raw JSON, a plain-English summary, a " +
      "targeted query. Never the graph currently open on your canvas. If you " +
      "only want to know what a workflow does, `action: \"analyze\"` is a far " +
      "shorter answer than the full JSON.",
    examples: [
      {
        ask: "What workflows have I got saved?",
        args: { action: "list" },
        returns:
          "A numbered list of names, each relative to the library root — one filed " +
          "in a folder shows as VIDEO/MiniMaxH3/clip.json. Pick one and hand the " +
          "whole name back as `filename`.",
      },
      {
        ask: "Open my portrait workflow so we can change the prompt.",
        args: { action: "get", filename: "portrait-flux.json" },
        returns:
          "The full workflow as runnable API-format JSON. This is a big " +
          "response — it is meant for the agent to work on, not for you to read.",
      },
      {
        ask: "Give me the raw file exactly as ComfyUI saved it.",
        args: { action: "get", filename: "portrait-flux.json", format: "ui" },
        returns:
          "The on-disk UI format, including node positions and colours — what " +
          "you want if the file is going to be loaded back into the canvas " +
          "rather than executed.",
      },
      {
        ask: "What does my portrait workflow actually do?",
        args: { action: "analyze", filename: "portrait-flux.json" },
        returns:
          "A short summary: the model it loads, the prompts, the sampler " +
          "settings, and what it saves.",
      },
      {
        ask: "Is that workflow going to run, or is something missing?",
        args: { action: "analyze", filename: "portrait-flux.json", view: "health" },
        returns:
          "Problems only — missing models, unconnected inputs, nodes whose " +
          "packs are not installed.",
      },
      {
        ask: "Which samplers in that graph are running above cfg 7?",
        args: {
          action: "query",
          filename: "portrait-flux.json",
          types: ["KSampler"],
          where: ["cfg>7"],
        },
        returns:
          "One line per matching node instead of the whole file — the only " +
          "context-safe way to ask a question of a 100-node graph.",
      },
      {
        ask: "How was this picture made?",
        args: {
          action: "from_image",
          image_path: "C:/ComfyUI/output/ComfyUI_00042_.png",
        },
        returns:
          "The workflow ComfyUI embedded in the PNG when it saved it, in both " +
          "API and UI form — the way to reverse-engineer someone else's image.",
      },
      {
        ask: "This graph is a mess of Get/Set nodes. What is actually wired to what?",
        args: { action: "strip", path: "C:/ComfyUI/user/default/workflows/expert.json" },
        returns:
          "The same graph with the virtual wiring resolved into real " +
          "connections, plus a note wherever the stripped form DIFFERS from the " +
          "source. Read those notes before running it.",
      },
    ],
  },
  save_workflow: {
    gloss:
      "The WRITE half of the library: store a workflow, or record/check the " +
      "exact models and node-pack commits it ran against so it can be " +
      "reproduced later.",
    examples: [
      {
        ask: "Save that as a new file so I don't lose the original.",
        args: {
          action: "save",
          filename: "portrait-flux-v2.json",
          workflow: WORKFLOW_FRAGMENT,
        },
        argsNote: FRAGMENT_NOTE,
        returns: "Confirmation and the path it was written to.",
        caution:
          "Writing to a filename that already exists replaces that file. Ask " +
          "for a new name — as above — when you want to keep the original.",
      },
      {
        ask: "Pin this one down so it renders the same in six months.",
        args: { action: "lock", filename: "portrait-flux-v2.json" },
        returns:
          "A lock file written alongside the workflow, recording a SHA-256 for " +
          "every model it loads and the git commit of every custom node pack it " +
          "uses. Needs a local install — hashing reads the model files.",
        caution:
          "This writes a second file (<filename>.lock.json) and hashes every " +
          "referenced model, which on a large install is minutes of disk work.",
      },
      {
        ask: "Has anything changed since I locked that workflow?",
        args: { action: "verify_lock", filename: "portrait-flux-v2.json" },
        returns:
          "A drift report: which models now hash differently, which node packs " +
          "moved to a new commit, whether ComfyUI itself was updated. Empty " +
          "everywhere means it will behave exactly as it did. Read-only.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Workflow Authoring
  // -------------------------------------------------------------------------
  create_workflow: {
    gloss:
      "Building a graph, and the schema lookup you make while building it — " +
      "start one from a template, patch an existing one, check it before you " +
      "queue it, or ask what a node's inputs are. Chosen with `action`.",
    examples: [
      {
        ask: "Give me a basic text-to-image workflow to start from.",
        args: {
          action: "create",
          template: "txt2img",
          params: { positive_prompt: "a snow leopard on a rooftop at dusk", steps: 25 },
        },
        returns:
          "A complete, runnable API-format workflow. Anything you left out uses " +
          "the template default, so check the checkpoint it picked actually " +
          "exists on your server before running it.",
      },
      {
        ask: "Turn the steps up to 40 on node 3.",
        args: {
          action: "modify",
          workflow: WORKFLOW_FRAGMENT,
          operations: [{ op: "set_input", node_id: "3", input_name: "steps", value: 40 }],
        },
        argsNote: FRAGMENT_NOTE,
        returns:
          "The modified workflow plus the ids of any nodes the operations added. " +
          "Nothing is written to disk and nothing is queued.",
      },
      {
        ask: "Will this run?",
        args: { action: "validate", workflow: WORKFLOW_FRAGMENT },
        argsNote: FRAGMENT_NOTE,
        returns:
          "Either a clean bill of health or the specific problems, without " +
          "queuing anything.",
      },
      {
        ask: "What settings does the KSampler node have?",
        args: { action: "node_info", node_type: "KSampler" },
        returns:
          "That node's inputs and outputs with their types. Dropdown options are " +
          "summarised as a count by default, because a model-loader dropdown can " +
          "be hundreds of kilobytes on its own.",
      },
    ],
  },
  visualize_workflow: {
    gloss:
      "Turn a workflow you PASS IN into something readable — a Mermaid diagram " +
      "or the compact DSL — and back again. It never looks at the graph open on " +
      "your canvas.",
    examples: [
      {
        ask: "Draw me a diagram of this workflow.",
        args: { action: "render", workflow: WORKFLOW_FRAGMENT },
        argsNote: FRAGMENT_NOTE,
        returns:
          "Mermaid flowchart syntax, nodes grouped by role and every connection " +
          "labelled with the data type flowing along it.",
      },
      {
        ask: "That chart is unreadable, it's a 60-node graph.",
        args: { action: "render_hierarchical", workflow: WORKFLOW_FRAGMENT, view: "overview" },
        argsNote: FRAGMENT_NOTE,
        returns:
          "The same graph collapsed to one box per section with the data flow " +
          "between them. `view: \"list\"` names the sections; `view: \"detail\"` " +
          "with a `section` opens one of them up.",
      },
      {
        ask: "Show me this workflow in a form I can actually edit by hand.",
        args: { action: "to_dsl", workflow: WORKFLOW_FRAGMENT },
        argsNote: FRAGMENT_NOTE,
        returns:
          "The compact DSL: one block per node, connections as " +
          "`key <- nodeId.outputIndex`. `action: \"from_dsl\"` converts it back " +
          "to runnable JSON when you are done editing.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Assets & Images
  // -------------------------------------------------------------------------
  // The three read-side image tools are ONE tool since 0.50.0 slice 15, chosen
  // with `action`. The skeleton the generator would otherwise emit is
  // `{"action": "get"}` — a call that returns the handler's missing-`filename`
  // error — so, as with runpod below, real calls are worth more than a skeleton
  // here. Every `args` object is validated against the live zod schema at
  // generation time.
  get_image: {
    gloss:
      "Everything the agent does to LOOK at what ComfyUI made: browse what has " +
      "been written to disk, fetch one file, put a picture in front of the " +
      "agent, re-encode it, or measure its colour. Worth knowing: video nodes " +
      "often finish without registering in ComfyUI's history, so " +
      "`action: \"list_outputs\"` is the reliable way to confirm a video really " +
      "rendered.",
    examples: [
      {
        ask: "Show me the last few things I generated.",
        args: { action: "list_outputs", limit: 10 },
        returns:
          "The ten newest files, newest first, each with whether it is an image " +
          "or a video, its folder, size and time. Not the pictures themselves — " +
          "ask to see one and the agent fetches it.",
      },
      {
        ask: "Did that fox render ever come out?",
        args: { action: "list_outputs", pattern: "fox", limit: 5 },
        returns: "Only files whose names contain \"fox\".",
      },
      {
        ask: "Show me that one.",
        args: { action: "view", asset_id: "asset_01HQ8Z3K7V" },
        returns:
          "The image inline, visible to both of you. The asset id comes from " +
          "the completion message of the run that made it. Images only — for " +
          "video and audio use `action: \"get\"`, which saves to disk.",
      },
      {
        ask: "Save that render onto my desktop.",
        args: {
          action: "get",
          filename: "portrait_00042_.png",
          type: "output",
          save_dir: "C:/Users/me/Desktop",
        },
        returns:
          "The file copied to that folder, and the path it landed at. Use this " +
          "rather than `action: \"view\"` for video and audio, which cannot be " +
          "shown inline.",
      },
      {
        ask: "Why does this render look so washed out?",
        args: { action: "analyze_color", filename: "portrait_00042_.png" },
        returns:
          "Measured numbers rather than an opinion: black and white points, " +
          "contrast, saturation, per-channel colour cast and clipping, plus " +
          "flags like washedOut/liftedBlacks and a one-line verdict. Read-only.",
      },
      {
        ask: "Make me a smaller JPEG of that so I can email it.",
        args: {
          action: "convert",
          path: "portrait_00042_.png",
          format: "jpeg",
          quality: 85,
        },
        returns:
          "The re-encoded image inline, with the source and output sizes and how " +
          "many bytes were saved.",
        caution:
          "Passing `out_path` also WRITES the converted file under the ComfyUI " +
          "output directory, overwriting whatever is already at that path.",
      },
      {
        ask: "What have I made recently?",
        args: { action: "list_assets", limit: 5 },
        returns:
          "The five newest registered assets with their asset ids, prompt ids, " +
          "filenames and when they were made — including renders this session " +
          "never watched, which are reconciled from ComfyUI's history on the " +
          "way. Feed an asset id to `action: \"view\"` to actually see one.",
      },
      {
        ask: "What settings produced that image?",
        args: { action: "asset_metadata", asset_id: "asset_01HQ8Z3K7V" },
        returns:
          "Full provenance for the asset, including the entire workflow that " +
          "produced it — the prompt, sampler, steps, seed and so on. Read this " +
          'before generate_image (action:"regenerate") with overrides.',
      },
    ],
  },

  upload_image: {
    gloss:
      "The other direction: putting a file where ComfyUI can read it. A local " +
      "file goes into ComfyUI's input/ folder (`image`/`video`/`audio`), an " +
      "existing render is re-registered as an input without touching the disk " +
      "(`stage` — the correct way to chain one stage into the next), and " +
      "`output` is the only action that sends anything OFF this machine.",
    examples: [
      {
        ask: "Use this photo as the starting image.",
        args: { action: "image", source_path: "C:/Users/me/Pictures/cat.png" },
        returns:
          "The filename it was stored under in ComfyUI's input/ directory — drop " +
          "that into a LoadImage node's `image` widget.",
      },
      {
        ask: "Now feed that render into the video stage.",
        args: { action: "stage", filename: "portrait_00042_.png" },
        returns:
          "The same file registered as an INPUT, with the filename to put in the " +
          "next stage's loader. Goes through the server API, so it works even " +
          "when ComfyUI was launched with custom input/output directories — " +
          "never guess a filesystem `input/` path.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------
  download_model: {
    gloss:
      "Everything to do with GETTING a model: searching HuggingFace or CivitAI, " +
      "fetching the file, and watching or stopping the transfer. " +
      'The `action:"resolve_missing"` one is the answer to "this workflow says a ' +
      'model is missing" — it works out what is actually absent and finds ' +
      "downloadable candidates, including smaller quantised versions when the " +
      "full file will not fit your GPU.",
    examples: [
      {
        ask: "Find me a Flux model I can actually run.",
        args: { action: "search", query: "flux schnell", limit: 5 },
        returns:
          "Matching models with their download URLs and file sizes. Nothing is " +
          "downloaded — this is a search.",
      },
      {
        ask: "Get that one.",
        args: {
          action: "download",
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
      {
        ask: "Is that download still going?",
        args: { action: "status" },
        returns:
          "Every tracked download with its state and byte progress. Pass an " +
          "`id` to ask about just one.",
      },
      {
        ask: "This workflow won't run, it says something's missing. Find it for me.",
        args: { action: "resolve_missing", workflow: WORKFLOW_FRAGMENT },
        argsNote: FRAGMENT_NOTE,
        returns:
          "Each missing file with candidate downloads, their sizes and " +
          "precision, and whether each one fits your VRAM. It downloads nothing " +
          "— you pick, then it fetches.",
      },
    ],
  },
  list_local_models: {
    gloss:
      "Everything to do with what you ALREADY have: the installed model files, " +
      "the embeddings, and the extra folders ComfyUI searches. It also has the " +
      'one delete: `action:"remove"` unlinks a model file.',
    examples: [
      {
        ask: "Which checkpoints do I already have?",
        args: { action: "list", model_type: "checkpoints" },
        returns:
          "The model filenames in that folder — the exact strings a workflow " +
          "needs. Omit `model_type` to see every folder at once.",
      },
      {
        ask: "Delete that old LoRA, I'm out of disk space.",
        args: { action: "remove", path: "loras/old-character-v1.safetensors" },
        returns: "Confirmation, and how much space came back.",
        caution:
          "This deletes the file. There is no undo and no recycle bin — you " +
          "would have to download it again. Check the path is the one you mean. " +
          'Note that `action:"remove_path"` is a different thing entirely: it ' +
          "edits the search-path config and deletes nothing.",
      },
      {
        ask: "Also look for models on my E: drive.",
        args: { action: "add_path", category: "checkpoints", path: "E:/Models/checkpoints" },
        returns:
          "The updated extra-search-path config. ComfyUI needs a restart before " +
          "it picks the folder up.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Custom Nodes
  // -------------------------------------------------------------------------
  search_custom_nodes: {
    gloss:
      "Finding a node pack in the public registry, before you install anything. " +
      "Read-only and network-only — it does not need a running ComfyUI. " +
      "Installing what you find is a different tool: `install_custom_node`.",
    examples: [
      {
        ask: "Is there a node pack for face detailing?",
        args: { action: "search", query: "face detailer", limit: 5 },
        returns:
          "Matching packs from the registry with their ids, authors and " +
          "descriptions. The id is what install_custom_node wants.",
      },
      {
        ask: "Tell me more about that Impact Pack before I install it.",
        args: { action: "details", id: "comfyui-impact-pack" },
        returns:
          "The pack's description, author, license, repository, install count, " +
          "the node types it provides, and its recent version changelogs.",
      },
    ],
  },
  install_custom_node: {
    // Same reason RunPod stopped being adequate on the skeleton (see the header):
    // 0.50.0 slice 12 made `action` the only REQUIRED field, so the generated
    // skeleton collapses to {"action": "install"} and the documented call
    // deterministically hits the handler's missing-`id` error. For a surface that
    // runs third-party code and can REMOVE an installed pack, "the documented
    // call does not work" is not an acceptable gap.
    gloss:
      "Everything you do to someone ELSE'S node pack once you have found it: " +
      "install it, keep it working, turn it off, remove it. One tool for the " +
      "whole pack lifecycle, chosen with `action`. FINDING a pack is " +
      "`search_custom_nodes`; writing your own is `node_pack`.",
    examples: [
      {
        ask: "Install the Impact Pack.",
        args: { action: "install", id: "comfyui-impact-pack" },
        returns:
          "Progress, then confirmation. New nodes do not appear until ComfyUI " +
          "restarts — the agent will normally offer to do that for you.",
        caution:
          "A custom node pack is third-party code that runs inside your " +
          "ComfyUI. Install packs you have reason to trust, the same as any " +
          "other plugin.",
      },
      {
        ask: "What node packs have I got installed?",
        args: { action: "list" },
        returns:
          "Every installed pack with its version and whether it is enabled or " +
          "disabled. Read-only.",
      },
      {
        ask: "That pack has been broken since the last update — repair it.",
        args: { action: "fix", id: "comfyui-impact-pack" },
        returns:
          "What the repair did to the pack's install and Python dependencies. A " +
          "restart is usually needed before the result is visible.",
        caution:
          "Repairing re-runs the pack's own install step, which is third-party " +
          "code. Pass id \"all\" only if you mean every installed pack.",
      },
      {
        ask: "Turn that pack off but don't delete it — I want to see if it's the culprit.",
        args: { action: "disable", id: "comfyui-impact-pack" },
        returns:
          "Confirmation, re-read from the installed-pack list so a Manager no-op " +
          "is reported as NOT disabled rather than as success. Restart ComfyUI " +
          "for it to take effect; action \"enable\" puts it back.",
      },
      {
        ask: "Get rid of that pack for good.",
        args: { action: "uninstall", id: "comfyui-impact-pack" },
        returns:
          "Confirmation, but only after the installed-pack list is re-read and " +
          "the pack is provably GONE. An id that resolves nowhere is refused " +
          "before anything is queued.",
        caution:
          "This REMOVES the pack and is irreversible through this tool — any " +
          "workflow using its nodes will go red. For a cleanup audit use action " +
          "\"disable\" first, which is reversible.",
      },
    ],
  },
  node_pack: {
    // Same reasoning as install_custom_node above: `action` is the only required
    // field, so the skeleton documents a call that cannot work. This tool also
    // WRITES files and runs git, so the examples carry the cautions.
    gloss:
      "The loop for authoring YOUR OWN node pack: scaffold it, read and edit its " +
      "source, check it actually loads, commit it, publish it. Everything is " +
      "local and jailed to `custom_nodes/`. Installing someone else's pack is " +
      "`install_custom_node`.",
    examples: [
      {
        ask: "Start me a new node pack called my-cool-nodes.",
        args: {
          action: "scaffold",
          name: "my-cool-nodes",
          display_name: "My Cool Nodes",
        },
        returns:
          "The files it wrote under custom_nodes/my-cool-nodes/ — pyproject.toml, " +
          "__init__.py and a runnable sample node. Restart ComfyUI to load it.",
      },
      {
        ask: "Where is that pack's sampler class defined?",
        args: { action: "search", query: "class .*Sampler", glob: "**/*.py" },
        returns:
          "File/line/text matches under custom_nodes/, capped so a broad regex " +
          "cannot flood the reply. Read-only.",
      },
      {
        ask: "Show me the top of that file.",
        args: { action: "read", path: "my-cool-nodes/src/nodes.py", line_count: 60 },
        returns:
          "The requested line range, with a truncation notice if it was clipped.",
      },
      {
        ask: "Replace that file with the fixed version.",
        args: {
          action: "write",
          path: "my-cool-nodes/src/nodes.py",
          content: "# ...the full new contents of the file...",
          overwrite: true,
        },
        argsNote:
          "`content` is the COMPLETE new file, shortened to one line here. For a " +
          "small edit prefer action \"patch\", which applies a unified diff.",
        returns: "The path written and its byte count.",
        caution:
          "With overwrite true this replaces the whole file. There is no undo " +
          "here — commit first with action \"git\" if the pack is a repo.",
      },
      {
        ask: "Does my pack actually load?",
        args: { action: "verify", name: "my-cool-nodes" },
        returns:
          "Whether each of the pack's node classes appeared in /object_info. A " +
          "class that is missing failed to import — that is your bug.",
        caution:
          "By default this RESTARTS your local ComfyUI, which aborts anything " +
          "rendering. Pass restart false to check the live server as-is.",
      },
      {
        ask: "Commit what I changed in that pack.",
        args: {
          action: "git",
          pack: "my-cool-nodes",
          git_action: "commit",
          message: "fix: sampler returns the right latent",
        },
        returns:
          "The git output, capped. status/diff/log always work; commit and push " +
          "need COMFYUI_MCP_ALLOW_GIT_WRITES=1 and otherwise return a structured " +
          "refusal naming that flag.",
      },
      {
        ask: "Publish it to the registry.",
        args: { action: "publish", name: "my-cool-nodes" },
        returns:
          "What comfy-cli published, after pyproject.toml is validated for a real " +
          "name, version and PublisherId.",
        caution:
          "IRREVERSIBLE and PUBLIC: this creates or updates a version on " +
          "registry.comfy.org that this tool cannot take back. Needs comfy-cli " +
          "and REGISTRY_ACCESS_TOKEN.",
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
  install_comfyui: {
    gloss:
      "One tool for everything that INSTALLS or UPDATES: ComfyUI itself, every " +
      "custom node pack, the Agent sidebar panel, this MCP server, and " +
      "ComfyUI-Manager's own settings. `action` picks which — and nothing here " +
      'is read-only except action:"environment" and the two "status" ' +
      "sub-actions.",
    examples: [
      {
        ask: "Tell me about my setup — useful when I'm reporting a bug.",
        args: { action: "environment" },
        returns:
          "Where ComfyUI is installed, the Python and torch versions, the GPU, " +
          "and which settings are in force. The first thing to paste into an " +
          "issue.",
      },
      {
        ask: "What version of the panel have I got?",
        args: { action: "panel", panel_action: "status" },
        returns:
          "The installed panel version, where it lives, and whether it is " +
          "pinned. This changes nothing.",
      },
      {
        ask: "It says my panel is too old — update it.",
        args: { action: "panel", panel_action: "update" },
        returns:
          "The update result. Two more steps are yours: restart ComfyUI, then " +
          "hard-refresh the ComfyUI browser tab (Ctrl+Shift+R). Without that " +
          "refresh the tab keeps running the old cached panel code and the same " +
          "refusal comes back.",
      },
      {
        ask: "Am I on the latest comfyui-mcp?",
        args: { action: "self_update", self_update_action: "status" },
        returns: "Your version, the latest published version, and whether they differ.",
      },
      {
        ask: "Update comfyui-mcp itself.",
        args: { action: "self_update", self_update_action: "update" },
        returns:
          "The upgrade result. Your MCP client has to be restarted afterwards " +
          "to pick up the new server.",
        caution:
          "This updates THIS server, not ComfyUI and not the sidebar panel — " +
          'those are action:"update" and action:"panel".',
      },
      {
        ask: "Update every custom node I have installed.",
        args: { action: "update_all" },
        returns:
          "Confirmation that the bulk update was queued with ComfyUI-Manager. " +
          "It runs asynchronously and ComfyUI usually needs a restart after.",
        caution:
          "This moves EVERY installed pack, not just the one that is broken. " +
          "It is refused while the sidebar panel is version-pinned.",
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
  restart_comfyui: {
    gloss:
      "Starting, stopping and restarting ComfyUI, chosen with `action`. " +
      "Restarting is the standard next step after installing a node pack — new " +
      "nodes are not loaded until ComfyUI starts again.",
    examples: [
      {
        ask: "Restart it so the new nodes load.",
        args: { action: "restart" },
        returns:
          "The server stops and comes back up, and you are told when it is " +
          "answering again.",
        caution:
          "Anything queued or rendering is lost. Check the queue is empty first " +
          "if a long job is in flight.",
      },
      {
        ask: "Shut ComfyUI down, I need the VRAM.",
        args: { action: "stop" },
        returns: "Confirmation that the process stopped.",
        caution: "Any running or queued render is lost.",
      },
      {
        ask: "Start ComfyUI again.",
        args: { action: "start" },
        returns:
          "It launches the server and waits until it is answering, then tells " +
          "you the URL. Only works for a ComfyUI on this machine.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------
  get_defaults: {
    gloss:
      "Two separate sets of settings behind one tool, told apart by `action`. " +
      "`get`/`set` are the values the agent falls back to when you do not say " +
      "one — stop repeating yourself and set them once. `get_ui`/`set_ui` are " +
      "ComfyUI's OWN interface settings, the ones its Settings panel writes; " +
      "changing those changes the ComfyUI web UI, not what the agent renders.",
    examples: [
      {
        ask: "What settings do you use when I don't say?",
        args: { action: "get" },
        returns:
          "The current fallback size, steps, cfg, sampler and checkpoint, and " +
          "where each came from.",
      },
      {
        ask: "Always use 1024 by 1024 and 30 steps, permanently.",
        args: { action: "set", values: { width: 1024, height: 1024, steps: 30 }, persist: true },
        returns:
          "Confirmation of the new defaults. `persist: true` writes them to your " +
          "config file so they survive a restart; without it they last only for " +
          "this session.",
      },
      {
        ask: "ComfyUI keeps refusing to open this workflow — loosen its validation.",
        args: { action: "set_ui", id: "Comfy.Validation.Workflows", value: false },
        returns:
          "The old and new value of that ComfyUI interface setting, so you can " +
          "put it back. Reload the ComfyUI tab for it to take effect — an " +
          "already-open tab keeps the old value.",
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

  // -------------------------------------------------------------------------
  // RunPod (cloud GPU)
  //
  // The header above calls RunPod an expert surface left on the skeleton. It is
  // no longer left there, and the reason is specific to the 0.50.0 fold: while
  // each pod action was its own tool, `pod_id` was schema-REQUIRED, so the
  // generated skeleton included it and copying the skeleton at least addressed a
  // pod. Folding eleven tools into two makes `action` the only required field,
  // so the skeleton collapses to `{"action": "watch"}` — a call that
  // deterministically returns the handler's missing-field error. For a surface
  // that rents billed hardware, "the documented call does not work" is not an
  // acceptable gap, so these are real calls. Every `args` object below is
  // validated against the live zod schema at generation time.
  // -------------------------------------------------------------------------
  runpod: {
    gloss:
      "Rent a GPU in the cloud and render on it when your own card cannot fit " +
      "the job, then switch back. One tool for the whole pod lifecycle, chosen " +
      "with `action`. Pods bill by the hour from the moment they boot, so the " +
      "two actions that start one — `create` and `start` — are the ones to be " +
      "deliberate about, and `stop` is how the meter stops.",
    examples: [
      {
        ask: "What pods have I got out there?",
        args: { action: "list" },
        returns:
          "Every pod on your RunPod account with its id, name, state, GPU and " +
          "hourly cost — including any you forgot was running. Read-only.",
      },
      {
        ask: "My 8 GB card can't do this video. Rent me a 4090.",
        args: { action: "create", gpu_type: "NVIDIA GeForce RTX 4090" },
        returns:
          "A new pod deploying from this project's template, with its id and " +
          "hourly rate. It takes 1-3 minutes to boot; connect to it after that.",
        caution:
          "This spends real money and starts billing as soon as the pod boots. " +
          "Stop it with `action: \"stop\"` when you are done — a forgotten pod " +
          "bills all night.",
      },
      {
        ask: "Point everything at that pod.",
        args: { action: "connect", pod_id: "qk29vt4mzx8lb3" },
        returns:
          "Confirmation that the pod's ComfyUI answered and that this session " +
          "now renders there — every other tool follows it until you switch back.",
      },
      {
        ask: "I'm done with the cloud, go back to my own machine.",
        args: { action: "use_local" },
        returns:
          "Confirmation that rendering is back on the local ComfyUI. If a pod " +
          "was in use it says so — it is still running, and still billing.",
        caution:
          "This does NOT stop the pod. Switching back to local leaves the pod " +
          "running and charging; use `action: \"stop\"` to end billing.",
      },
      {
        ask: "Shut the pod down, I don't want to pay for it overnight.",
        args: { action: "stop", pod_id: "qk29vt4mzx8lb3" },
        returns:
          "Confirmation that the GPU was released and GPU-time billing ended. The " +
          "pod and its disk are KEPT so you can start it again later — which is " +
          "the point, but note that retained storage can still be charged for. " +
          "Deleting the pod outright is a RunPod console action, not this tool.",
        caution:
          "Anything rendering on that pod dies with it. Check nothing is in " +
          "flight first — `action: \"status\"` shows what the pod is doing.",
      },
    ],
  },

  runpod_watch: {
    gloss:
      "The live readout for a rented pod — what it is doing, what it is costing " +
      "— plus the \"why won't it connect?\" check. These do not deploy or resume " +
      "a pod; that is the `runpod` tool. Watching a pod DOES arm its idle " +
      "auto-stop, which is a cost guard, not a surprise: an idle watched pod " +
      "stops itself rather than billing for nothing.",
    examples: [
      {
        ask: "Keep an eye on that pod while it boots.",
        args: { action: "watch", pod_id: "qk29vt4mzx8lb3" },
        returns:
          "Live status starts appearing in the control panel — state, GPU and " +
          "VRAM use, uptime, hourly cost — refreshed every ~15 seconds.",
        caution:
          "Watching also arms the idle auto-stop: if that pod's ComfyUI sits " +
          "idle past the configured timeout it is stopped to save money.",
      },
      {
        ask: "It says the pod is running but nothing connects. Why?",
        args: { action: "troubleshoot", pod_id: "qk29vt4mzx8lb3" },
        returns:
          "The specific blocker and what to do about it, in the order it checks: " +
          "no such pod, pod not RUNNING, still booting (no runtime yet — GPU " +
          "attaching / container starting), ComfyUI's port not exposed, or the " +
          "port exposed but ComfyUI not answering. Read-only.",
      },
      {
        ask: "Stop showing me that pod, it's cluttering the panel.",
        args: { action: "unwatch" },
        returns:
          "Confirmation that the broadcast stopped. Unwatching never stops the " +
          "pod, so whatever state it was in, it stays in.",
        caution:
          "This turns the idle auto-stop OFF as well: if the pod is still " +
          "running it now bills until you stop it yourself, with nothing " +
          "watching for it going idle.",
      },
    ],
  },
};
