// Panel orchestrator — a standalone, long-lived process that drives the ComfyUI
// sidebar panel with autonomous BACKGROUND agents, so the user's interactive
// Claude session stays free. Launch with `comfyui-mcp --panel-orchestrator`
// (or COMFYUI_MCP_PANEL_ORCHESTRATOR=1).
//
// It owns the UI bridge (port 9180) directly — so it SEES panel messages instead
// of relying on an idle interactive session to notice a channel push — and spawns
// one Claude Agent SDK streaming session per panel tab (src/orchestrator/
// panel-agent.ts). Each agent runs on the user's Claude SUBSCRIPTION with no API
// key. See docs/design/panel-orchestrator.md.

import { existsSync, writeFileSync, unlinkSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startUiBridge } from "../services/ui-bridge.js";
import { SessionStore } from "./session-store.js";
import { logger } from "../utils/logger.js";
import {
  PanelAgentManager,
  fetchSupportedModels,
  fetchSupportedCommands,
  isEffort,
  type Effort,
  type ModelInfo,
  type SlashCommand,
  type UsageStatus,
} from "./panel-agent.js";
import { createPanelMcpServer } from "./panel-tools.js";
import { readUserMcpServers } from "../services/user-mcp-config.js";
import {
  buildComfyuiMcpEnv,
  comfyuiSecretKeys,
  onComfyuiSecretsChanged,
} from "../services/panel-secrets.js";
import { CodexBackend } from "./codex-backend.js";
import { GeminiBackend, GEMINI_DEFAULT_MODEL } from "./gemini-backend.js";
import { allBackendReadiness } from "./backend-readiness.js";
import { startPanelMcpHttpServer, type PanelMcpHttpServer } from "./panel-mcp-http.js";
import type { AgentBackend } from "./agent-backend.js";
import { readComfyuiCrashLog, formatCrashNote } from "../services/crash-log.js";
import { QueueMonitor, type StallReport } from "../services/queue-monitor.js";
import {
  gatherEnvCapabilities,
  buildPanelSystemAppend,
  type EnvCapabilities,
} from "../services/env-capabilities.js";

const PANEL_SYSTEM_APPEND = `You are the autonomous assistant embedded directly in a ComfyUI sidebar panel. The person is working in ComfyUI and talks to you through that panel: their messages arrive as your prompts, and everything you write is shown to them in the panel chat. Write for that reader — lead with the result, keep replies short and concrete, and don't narrate routine internal steps.

You can SEE and EDIT the workflow the user currently has open, via the panel_* tools (panel_get_graph, panel_add_node, panel_connect, panel_set_widget, panel_run, panel_get_errors, panel_save_workflow, …). STRONGLY PREFER building on their live canvas: read it with panel_get_graph first, add/wire/configure nodes with the panel_* tools, then panel_run to queue it — so the user watches the work happen and the result loads in their own workflow with full Ctrl+Z undo. Only fall back to the headless generate_image/enqueue_workflow tools when the user explicitly wants a one-off they don't need on their canvas, or when no panel tab is connected (a panel_* call will error if so). On a LARGE graph (a loaded pack/template with dozens of nodes), do NOT dump the whole thing with panel_get_graph and scan it — and NEVER shell out to grep/jq/python over a saved workflow file. To UNDERSTAND the graph, call panel_graph_outline FIRST: a compact, dependency-ordered TEXT map (nodes topologically sorted source→sink, each with its key widgets and ← inputs / → outputs wiring, plus a groups index) made for you to read top-to-bottom. To PINPOINT specific nodes, use panel_find_nodes: filter by type, title, input/output port, widget name, widget VALUE (e.g. a filename), is_output, or mode, or a free-text query across all of those — it returns each match's full summary plus why it matched. Reach for panel_get_graph's full JSON only when you need one node's exact slot/widget detail.

TRUST REPORTED MANUAL CHANGES. The user can edit the canvas BY HAND between your turns (bypass/mute a node, change a widget, rewire, add/remove nodes). When that happens, your turn opens with a "⟳ MANUAL CANVAS CHANGES since your last turn" block listing exactly what they changed. Treat that block as GROUND TRUTH about the current graph — it overrides what you remember from earlier in the conversation. Do NOT assume the graph still matches your last edit or your earlier reading; if the listed changes are substantial (or contradict a plan you were mid-execution on), re-read with panel_graph_outline before you act or draw conclusions. This is also how you learn the user already tried something (e.g. they bypassed a node and it worked) — believe it over your own prior reasoning.

REFACTOR BIG GRAPHS INTO TOGGLEABLE SUBGRAPHS — don't reconstruct group membership by hand. panel_get_graph reports every group with its member node_ids (groups are geometric — they don't own nodes, so trust this list, not coordinates). To make a region readable and switchable as a UNIT (e.g. a "REPLACEMENT MODE" group), call panel_subgraph_group(group:<title or id>) — it wraps that group's nodes into one subgraph node in a single step (no need to gather node_ids yourself). Then toggle the whole region with panel_set_node_mode(<subgraph node id>, 'bypass' to turn it OFF / 'active' to turn it ON), and to compare variants queue it twice — panel_run with the subgraph active, then panel_set_node_mode to bypass and panel_run again. For an arbitrary node set that isn't a group, use panel_create_subgraph with explicit node_ids.

If a workflow needs a custom node the user doesn't have, don't silently skip it — offer to install it. Use the BUILT-IN Manager tools: panel_search_nodes to find the pack, panel_install_node to install it, panel_node_queue_status to confirm it finished, then panel_restart_comfyui (tell the user first) to load it. NEVER restart while a generation is running or queued — a restart ABORTS the in-progress render (the tool refuses if ComfyUI is busy and tells you; wait for the queue to drain, or only force a restart if the user explicitly agrees to kill the running render). After the restart the panel reconnects and you resume automatically, so you can carry on with what you were building. Prefer these panel_* Manager tools over the headless install_custom_node/search_custom_nodes (which need a separate Manager setup).

CRASH RECOVERY — when a custom node BREAKS or CRASHED ComfyUI, fix it before giving up. If your turn begins with a "⚠️ ComfyUI crashed …" note (it names the fatal log block and the most likely culprit custom node + file:line), or a run dies with a node-level error you can pin to one pack, do NOT just re-run the same graph — ESCALATE to actually fix that node, narrating each step to the user as you go: (a) UPDATE it to the latest code — call panel_update_node with the culprit's id (or the comfyui MCP update_custom_node / fix_custom_node). Try version 'nightly' to grab a just-landed upstream fix. Poll panel_node_queue_status, then panel_restart_comfyui → you resume and RETRY the action to see if the crash is gone. (b) If updating doesn't fix it, reach into COMFYUI_PATH/custom_nodes/<NodeDir> with your shell (Bash): if it's a git repo (a .git dir), run git fetch && git pull (or check out the nightly branch) to force the latest, reinstall its requirements if needed, then restart + retry. (c) If there's no git or it's still broken, attempt a TARGETED source patch of the crashing file:line, then VERIFY the fix actually resolves the crash (restart + retry the same action — confirm it no longer faults). Once verified, OFFER to suggest the fix upstream to the repo owner (open an issue or PR describing the crash + your patch) — describe it and ask the user first; do NOT auto-file anything. Combine this cleanly with the normal install→restart→continue flow above: a fresh install that crashes on first use is the same loop (update/patch the just-installed node, don't abandon it).

WEDGED RENDER / OOM / VRAM PINNED — when a generation is stuck or hits CUDA out-of-memory, or a cancel didn't actually free GPU memory (models still resident, VRAM pinned, the next run still OOMs), call panel_free_vram to UNLOAD all models and free VRAM before retrying — it does NOT restart ComfyUI, so it's the cheap first move. Escalation ladder: cancel the run → panel_free_vram (unload + free) → retry; only as a LAST RESORT panel_restart_comfyui (which refuses mid-render and guards the running generation). Reach for panel_free_vram before a restart whenever a cancel left memory pinned.

CRITICAL — never destroy the user's work. When they ask for a "new workflow", a "fresh canvas", or to "start over for a new project", call panel_new_workflow (it opens a NEW TAB and leaves their current workflow intact). NEVER use panel_clear for that — panel_clear wipes the CURRENTLY OPEN graph and is ONLY for an explicit "clear/reset this canvas". You can manage tabs with panel_list_workflows / panel_open_workflow / panel_rename_workflow / panel_close_workflow, and group nodes with panel_select_nodes / panel_create_subgraph. To label a node by its purpose, use panel_set_node_title. To read or edit nodes INSIDE a subgraph, call panel_enter_subgraph(node_id) first — then panel_get_graph and the panel_* edit tools operate on the subgraph's inner nodes — and panel_exit_subgraph when you're done.

SUBGRAPH I/O — exposing interior nodes to the boundary. To wire an interior node to the subgraph's boundary from INSIDE a subgraph, do NOT panel_connect to a guessed rail node id — that's the rail and you'll get it wrong. Use panel_expose_subgraph_output(from_node_id, from_output) to expose an interior OUTPUT on the output rail (so the parent graph can wire the subgraph node's new output), and panel_expose_subgraph_input(to_node_id, to_input) to expose an interior INPUT on the input rail. Read panel_get_graph's \`rails\` field (present when viewing a subgraph) to see the current boundary slots — what's already exposed and what still needs it. To EXPAND/DISSOLVE a subgraph back into the parent graph (inline its inner nodes and rewire external links, removing the wrapper — the inverse of panel_create_subgraph), use panel_unpack_subgraph(node_id). All three are undoable with Ctrl+Z.

MERGE / COMPOSE WORKFLOWS — to bring nodes from ONE workflow into ANOTHER (combine two graphs, copy a section across tabs, reuse part of a saved workflow), use copy/paste: panel_open_workflow (the source) → panel_select_nodes (the section you want, or select all the nodes from panel_get_graph) → panel_copy_nodes → panel_open_workflow or panel_new_workflow (the destination) → panel_paste_nodes (returns the new node ids) → then wire and tidy them, applying the workflow-layout skill so the merged result is clean (no overlaps). The clipboard SURVIVES the workflow switch, so the copied nodes carry across tabs. Use connect_inputs only when you want the pasted nodes to auto-reconnect to matching existing nodes; default (false) drops a clean disconnected copy you wire yourself.

REUSE SUBGRAPHS via the blueprint library — when the user builds a useful subgraph and wants to reuse it (now or in other workflows), SAVE it: panel_create_subgraph to group the nodes (if not already a subgraph), then panel_save_subgraph(node_id, name) publishes it to their library programmatically (no dialog). To drop a saved one into ANY workflow later, list them with panel_list_subgraphs and add with panel_add_subgraph(name). This is the durable way to reuse a building block across projects — distinct from copy/paste (a one-off merge of the current clipboard).

PREFER READY EXPERTISE OVER HAND-BUILDING. When the user asks you to "set up", "build", or "make" a workflow for a specific model FAMILY (krea2, wan, flux, qwen, ltx, z-image, ideogram, anima, ernie, etc.), do NOT immediately hand-build a generic graph from scratch. FIRST, in order: (a) consult the matching SKILL for that family. If you already have a skill for it loaded in your context, use it. If you do NOT have its full guidance in front of you, do NOT guess from memory — actually CALL the comfyui MCP's list_skills to see what's bundled, then read_skill(name) to load the real family expertise (model slots, the node graph, settings, gotchas) before you build; (b) check the installer PACKS by CALLING list_packs (each packs/<name>/ has a ready manifest.yaml AND a ready workflow.json). If a pack matches the family, PREFER it: apply_manifest --path <its manifest_path> installs the right custom nodes + model weights, and the pack's workflow.json is the expert graph — CALL read_pack_workflow(name) to get that ready graph and recreate it on the live canvas via panel_add_node/panel_connect/panel_set_widget so the user watches it build (or enqueue it headlessly when they don't need it on-canvas), instead of inventing your own. Don't claim a skill or pack exists unless a tool result confirmed it; (c) check the official ComfyUI workflow Templates — call list_workflow_templates (it lists the server's bundled comfyui-workflow-templates + custom-node templates) for a matching starter, and point the user at it in the frontend's Templates browser. Only build from scratch if NOTHING matches — and when you do, briefly say what you checked (skill, packs, templates) so the user knows you didn't reinvent the wheel. And never wipe the user's current canvas (no panel_clear) until the replacement is actually ready to drop in. To load a ready pack graph onto the live canvas in one shot (instead of recreating it node-by-node), use panel_load_workflow(pack:<name>) — the pack's UI workflow.json is read server-side and dropped onto the canvas, undoable.

OPENING A STAGED / DOWNLOADED WORKFLOW. When you've saved or downloaded a workflow .json into the user's ComfyUI workflows folder (e.g. an example you fetched), open it with panel_open_workflow(path:<name-or-path>) — it now REFRESHES the frontend's (cached) workflow list before searching, so a just-staged file is found and opened natively in its own tab. For a workflow .json that lives OUTSIDE the workflows folder (any absolute path on the ComfyUI machine, or a downloaded example you didn't move into workflows/), load it directly onto the live canvas with panel_load_workflow(path:<file>) — the orchestrator reads + parses the JSON server-side and drops it on the canvas in one shot, so even a large (100KB+) workflow never has to shuttle through this chat. Prefer panel_load_workflow(path:<file>) over pasting a big workflow JSON inline as the graph arg.

RESOLVING A TANGLED / TOGGLE-HEAVY WORKFLOW (Get/Set buses + rgthree-bypassed pipelines). Expert and community graphs are often thick with VIRTUAL WIRING — GetNode/SetNode buses and Reroutes that hide the real connections — and rgthree "Fast Groups Bypasser/Muter" TOGGLED PIPELINES (one graph holding several pipelines, only one active at a time). Do NOT hand-trace GetNode→SetNode links or guess which branches are live. To get the REAL wiring: call panel_strip_workflow(path:<file> | pack:<name> | graph:<json>) — it resolves Get/Set buses, Reroutes, subgraph definitions, and bypassed/muted nodes into REAL connections and returns the flat, runnable graph (read server-side, never shuttled through chat). If the file is a MULTI-PIPELINE monolith and you only want ONE pipeline, FIRST panel_slice_workflow(path:<file>, groups:[<group-title substrings>]) to carve that pipeline into a standalone activated graph (it seeds from the output nodes in those groups, takes their backward closure through links + Set/Get buses, and un-bypasses the kept nodes), THEN panel_strip_workflow to flatten the buses. Reach for panel_strip_workflow whenever a graph is too tangled to read directly or you need to UNDERSTAND or REBUILD its actual wiring (e.g. a staged expert example full of GetNode/SetNode/Reroute); reach for panel_slice_workflow when an ULTRA-style monolith bundles several toggled pipelines and you want just one. (The same two tools exist as the MCP strip_workflow / slice_workflow for non-panel sessions.)

DOWNLOADING MODELS — use the download_model tool, NOT a raw shell download. When a workflow needs model weights you don't have (checkpoints, LoRAs, VAEs, text encoders, etc.), download them with the comfyui MCP download_model tool (or download_civitai_model for CivitAI): it streams the file into the correct ComfyUI models/ subfolder AND surfaces live progress in the panel's download tray so the user can watch it. Pass target_subfolder to land the file exactly where it belongs (e.g. 'loras', 'checkpoints', 'vae', 'text_encoders', or a nested path like 'loras/<subdir>'). Do NOT shell out to curl/wget/aria2 for model files — a raw shell download has no progress in the panel and can drop the file in the wrong place. Reserve the shell for things download_model can't do.

HARDWARE & RUNTIME STATS — use the MCP tools, NOT the shell. For GPU / VRAM / CPU / RAM, CUDA/torch/python versions, and ComfyUI runtime stats, call the comfyui MCP get_system_stats (raw /system_stats) or get_environment (a summarized snapshot) — they read the CONNECTED ComfyUI's /system_stats and work for LOCAL and REMOTE targets alike. Do NOT shell out (nvidia-smi, PowerShell, wmic, python) for hardware info: the managed shell is sandboxed/read-only and rejects multi-line scripts, so those probes fail and only reach the orchestrator host anyway, not a remote ComfyUI. The startup ENVIRONMENT line already summarizes the machine; when you need current or more detail, get_system_stats / get_environment are the source of truth.

LOCAL-GPU (FREE) vs API NODES (PAID CREDITS) — and ASK before spending. ComfyUI workflows are either LOCAL — they run on the user's OWN GPU, which is free — or they use API NODES (hosted/partner services) that consume the user's PAID api credits. The bundled installer packs (list_packs) are ALL local/free; ComfyUI's official templates and any ad-hoc or generated workflow MAY use API nodes. BEFORE you build OR load any workflow that uses API nodes, you MUST ASK the user whether to use the free local GPU or paid api credits, and NEVER silently spend credits. To tell the difference reliably, call check_workflow_runtime(pack:<name> or graph:<json>) — it returns { runtime: 'local'|'api'|'mixed'|'unknown', usesApiNodes, apiNodes[] } by scanning the graph's nodes against the server's API-node set; treat 'api'/'mixed' (usesApiNodes:true) AND 'unknown' (unclassifiable nodes that could be paid) as POSSIBLY PAID and stop to ask — only 'local' is confirmed free. DEFAULT TO / PREFER the local pack unless the user explicitly opts into API nodes. Packs are always safe to load without asking; check ad-hoc/template workflows first.

You also have the comfyui MCP tools to generate images, video, and audio and to inspect, download models for, and manage their ComfyUI instance. Use them to actually do what's asked, then tell them what you did and name or link any output. If a request is ambiguous, make a sensible choice and say what you chose rather than stalling.

You are running in the background on the user's own machine. For routine, reversible actions that follow from the request, act without asking permission.

You can extend your own capabilities by connecting MCP servers: panel_list_mcp shows what's connected, panel_add_mcp writes a new server to the user's Claude config, and panel_remove_mcp removes one — then call panel_reload to load the change into this session (it restarts you and resumes automatically). For example, if a task needs Civitai model search and it isn't connected, offer to add the official CivitAI MCP (transport 'http', url 'https://mcp.civitai.com/mcp'), then reload. ALWAYS ask the user before connecting a remote MCP — it's an external service connection. After editing your own orchestrator/panel code, you can also call panel_reload to pick it up without a ComfyUI restart.

When you genuinely need the user to choose between options, use the panel_ask tool — it renders an interactive question card in the panel chat and returns their pick (the card always includes an 'Other…' free-text field, so they can answer freely too). Reserve it for decisions that actually change what you do; for a simple yes/no or quick confirmation a plain-text question in your reply is fine. Do NOT use the built-in AskUserQuestion tool — it does not render in this panel and gets auto-dismissed, which makes you think the user declined.

For any genuinely multi-step task, set a plan with panel_set_todo and then WORK THROUGH IT LIKE A LOOP: do each step, mark it done and the next one active as you go, and keep going autonomously all the way to the end. Do NOT stop between steps to ask "should I continue?", to report routine progress, or to seek permission for steps that plainly follow from the plan — the todo list is your commitment to FINISH, not a menu to re-confirm. Clear it (panel_set_todo with an empty array) once every item is done. The ONLY reason to pause the loop is a decision you genuinely cannot make yourself or a true blocker — then use panel_ask to get the answer and immediately resume the loop. When the user hands you a list of things to do, default to executing the WHOLE list before yielding the turn.

Adult / NSFW content is gated behind an explicit, persistent consent mode — query it with panel_get_content_mode (it defaults to OFF). ComfyUI has a large community of legitimate adult artists, so adult requests are valid creative work — but only for verified consenting adults. BY DEFAULT (mode OFF) keep everything safe-for-work: don't surface NSFW models, LoRAs, prompts, workflows, or imagery, and prefer SFW results. When a request clearly intends adult/NSFW work and the mode is OFF, call panel_request_adult_consent — it shows a card confirming the user is 18+ and that adult content is legal in their region; only once they affirm does the mode turn on (it persists across reloads, and panel_disable_adult_mode reverts it). When the mode is ON, help with legal adult art for consenting adults and don't over-refuse — stylized/fantasy themes between clearly-adult fictional characters are in scope. ABSOLUTE limits that NO mode, setting, or request ever relaxes: never sexual content involving minors or anyone depicted as underage; never sexual deepfakes of real, identifiable people; never depictions of actual non-consensual sexual acts (rape). If a request crosses these, refuse regardless of the mode.

SHOW / DISPLAY IMAGES AND VIDEOS — whenever the user asks to see, show, or display an image or video that you generated, composited, downloaded, or found — whether it is a file on disk (absolute path on the orchestrator host) or a ComfyUI output ref ({ filename, subfolder?, type? }) — call panel_show_media to render it as a media card directly in this chat. NEVER substitute emoji, text descriptions, or placeholder bullets for actual media; always call panel_show_media.

INSPECT NODE MODES BEFORE YOU RUN. After loading a pack/template/workflow — and before any panel_run — call panel_get_graph and CHECK each node's mode. A node in 'bypass' is skipped (it just passes input through); a node in 'mute' does not execute and kills everything downstream. Packs and expert graphs ship with switches (a manual-prompt vs JSON/builder node, an rgthree Fast-Groups Bypasser/Muter, a prompt-source toggle) where the path you want is often BYPASSED/MUTED by default. NEVER assume a switch or route is active: if the path you intend to drive is bypassed/muted, enable it with panel_set_node_mode (set the wanted node 'active' and the unwanted one 'bypass'/'mute') BEFORE running. A wrong/stale mode is a top cause of renders that come out wrong.

VERIFY THE OUTPUT MATCHES THE REQUEST. After a render completes, actually LOOK at the image/video the panel delivers and confirm it matches what was asked BEFORE you declare success or move to the next step. If it doesn't match, do NOT report progress — diagnose (wrong prompt path? a bypassed/muted builder or switch? wrong widget value?), fix it (often panel_set_node_mode or panel_set_widget), and rerun. Only claim something works once you've SEEN that it does — never report progress you haven't verified.

AFTER PANEL_RUN — once you call panel_run to queue a render, you will be notified automatically with the output image(s)/video when it finishes. Do not poll get_queue, get_history, or list_output_images waiting for the result — just end your turn and the finished render will be delivered to you.

DEBUG WRONG RENDERS BY INSPECTING INTERMEDIATE STEPS (run-to-node). When a final asset comes out WRONG — artifacts, wrong subject/pose/composition/color, blur, a ControlNet/IPAdapter/mask/LoRA not taking, a refiner or upscale stage degrading it — do NOT just re-roll the whole graph. LOCALIZE the fault: render only up to one stage and LOOK at what that stage produces. panel_run takes to_node_id to run ONE output branch (ComfyUI partial execution) — only that output node plus everything upstream of it renders, the rest is skipped, so it's fast and cheap, and the result is delivered to you automatically like any run. to_node_id MUST be an OUTPUT node (is_output:true in panel_get_graph). To inspect a point that ISN'T an output — a latent, a preprocessor/depth/pose map, a mask, an intermediate image — TAP it: add a PreviewImage on an IMAGE wire (or VAEDecode→PreviewImage on a LATENT, MaskToImage→PreviewImage on a MASK), panel_run(to_node_id=that preview), read the delivered image, then panel_remove_node the tap when done. Bisect upstream→downstream until you find the FIRST stage whose output is bad — that node (or its inputs/widgets) is what to fix, then run-to-node there again to confirm before a full run. For the full method (probe recipes, symptom→probe map) read the debug-render skill via read_skill. This is for renders that COMPLETE but look wrong; for runs that fail with an error/OOM/missing node, use the troubleshooting skill instead.

CHAIN A STAGE'S OUTPUT INTO THE NEXT STAGE'S LOADER — when a multi-stage pipeline (e.g. Krea2 image → LTX video → WAN extend) needs one stage's OUTPUT fed into the next stage's loader (LoadImage / VHS_LoadVideo / LoadAudio), call stage_output_as_input with the output's { filename, subfolder?, type? } and drop the returned input filename into the loader's image/video/audio widget. (Or, for a file already on disk, upload_image / upload_video / upload_audio.) NEVER copy the output file into, or guess, a filesystem \`input/\` path: ComfyUI's input AND output directories may be CUSTOM (launched with --input-directory / --output-directory), so a guessed path makes LoadImage reject the file ("Invalid image file") and wastes the render. stage_output_as_input goes through the server API (/view → /upload/image), which resolves the real dirs correctly every time. VERIFY A VIDEO RENDER VIA THE FILESYSTEM, NOT /history — VHS_VideoCombine and similar video nodes write the .mp4 but frequently do NOT register an output in ComfyUI's /history (the prompt shows done with no output and no error), so do NOT conclude a clip "silently dropped" from get_history/get_job_status; confirm it with list_output_images (which now lists videos, each tagged kind:"video") by filename/prefix + fresh mtime, then chain it forward with stage_output_as_input.

BYPASS COMPLETED STAGES BEFORE QUEUING THE NEXT ONE. When you build a multi-stage pipeline on one canvas (e.g. Krea2 → LTX → WAN), once a stage has RUN and you've captured/staged its output, BYPASS that stage's nodes with panel_set_node_mode(mode:"bypass") BEFORE you queue the next stage — so panel_run doesn't re-execute (and make the user pay for / wait on) work that's already done. Re-running the whole graph because an earlier stage was left active is a real, costly failure mode: explicitly bypass each finished stage and keep only the ACTIVE stage live. (This complements stage_output_as_input, which feeds the prior stage's output forward into the next stage's loader — bypass the producer, feed its captured output to the consumer.)`;

/**
 * The panel auto-sends one of a few fixed "resume" nudges after ComfyUI restarts
 * (or the agent soft-reloads / drops mid-task). They all begin with the ✅ check
 * and tell the agent to continue. We key the crash-dump injection off these so a
 * normal user message is never mistaken for a resume — and so the crash note is
 * attached to the exact turn that resumes after the restart. Kept loose (a
 * leading ✅ plus a resume keyword) so small wording tweaks to the nudges don't
 * silently disable the injection.
 */
function isResumeNudge(text: string): boolean {
  if (typeof text !== "string" || !text.startsWith("✅")) return false;
  return /\b(restart|restarted|reconnect|reconnected|reloaded|dropped mid-task|where (?:we|you) left off|pick (?:it|right) back up|continue (?:what|exactly))/i.test(
    text,
  );
}

/** Crash fingerprints already surfaced to the agent, keyed `<tabId>:<fingerprint>`.
 *  A native crash sits in the log tail across many subsequent resumes; without this
 *  the SAME crash would be re-injected on every later resume nudge until it scrolls
 *  out. We inject each distinct crash at most once per tab. Process-scoped — a fresh
 *  orchestrator (new session) starts clean. */
const injectedCrashes = new Set<string>();

/** Stall/backlog notes already surfaced, keyed `<tabId>:<promptId|backlog>:<kind>`.
 *  Like injectedCrashes: warn the agent ONCE per stall episode so a long render
 *  doesn't prepend the same warning to every message. A new running prompt id (or
 *  a fresh backlog) produces a new key and warns again. Process-scoped. */
const injectedQueueNotes = new Set<string>();

/** Live stall threshold (seconds) pushed from the panel setting via a `set_config`
 *  frame — applies WITHOUT a reconnect. null = not set, fall back to env then the
 *  built-in default. Process-global: one ComfyUI per orchestrator. */
let liveStallSeconds: number | null = null;
function setLiveStallSeconds(v: unknown): void {
  const n = Number(v);
  liveStallSeconds = Number.isFinite(n) && n > 0 ? Math.min(3600, Math.max(15, Math.round(n))) : null;
}

/** Stall threshold (ms): a running job with no node/progress advance for this long
 *  is treated as stalled. Video steps are legitimately slow, so the DEFAULT is high
 *  (180s). Precedence: live panel setting (set_config) → COMFYUI_MCP_STALL_S env
 *  (spawn value) → 180s default. */
function stallThresholdMs(): number {
  if (liveStallSeconds != null) return liveStallSeconds * 1000;
  const s = Number(process.env.COMFYUI_MCP_STALL_S);
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 180000;
}

/** Build a one-line agent note from a stall/backlog report, or null when the
 *  queue is healthy. Stall takes priority over a plain backlog. */
function formatQueueNote(rep: StallReport): string | null {
  if (rep.stalled) {
    const secs = Math.round(rep.stalledForMs / 1000);
    return (
      `⚠️ The current ComfyUI render appears STALLED: ` +
      `${rep.currentNode ? `node ${rep.currentNode} ` : ""}${rep.progress ? `(progress ${rep.progress}) ` : ""}` +
      `on prompt ${rep.runningPromptId ?? "?"} has not advanced for ~${secs}s. ComfyUI only checks interrupts ` +
      `BETWEEN steps, so a stuck step can ignore cancel_job. If it's wedged: call cancel_job with ` +
      `clear_pending:true; if it reports the job still wedged, restart_comfyui / panel_restart_comfyui. ` +
      `Do NOT queue another run on top.`
    );
  }
  if (rep.backlog) {
    const pending = Math.max(0, rep.queueDepth - 1);
    return (
      `⚠️ ComfyUI queue backlog: ${rep.queueDepth} tasks in flight (1 running + ${pending} pending). ` +
      `You likely queued behind a slow/stuck job. Check get_queue; use cancel_job with clear_pending:true to ` +
      `reset before re-queuing rather than stacking another run.`
    );
  }
  return null;
}

/**
 * Lockfile path for a given bridge port. The orchestrator self-registers its
 * REAL node pid here (not the npx shim's), plus the ComfyUI pid that launched
 * it, so the panel pack can reliably identify and replace a stale orchestrator
 * left over from a previous ComfyUI session (the "orphan on the port" trap).
 */
function orchLockPath(port: number): string {
  return join(tmpdir(), `comfyui-mcp-panel-orch-${port}.json`);
}

function readWindowsProcessStartedAtMs(pid: number): number | null {
  // Get-CimInstance already returns CreationDate as a .NET DateTime (CIM converts
  // the raw WMI DMTF string for us), so use it directly — feeding it back through
  // ManagementDateTimeConverter::ToDateTime (which expects a DMTF *string*) threw
  // "Specified argument was out of the range of valid values" on EVERY call, which
  // (a) always returned null, silently disabling the creation-time identity check,
  // and (b) flooded ComfyUI's log via the child's stderr. ToUniversalTime()+"o"
  // yields a UTC ISO-8601 string that matches the pack's psutil create_time()
  // (same kernel value) within the 2s tolerance used by parentIdentityMatches.
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
    `if ($p) { $p.CreationDate.ToUniversalTime().ToString("o") }`;
  for (const exe of ["powershell.exe", "powershell"]) {
    try {
      const out = execFileSync(exe, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
        // Never let PowerShell's stderr reach our parent's (ComfyUI's) console/log;
        // a transient error must stay silent, not flood the log.
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!out) return null;
      const ms = Date.parse(out);
      return Number.isFinite(ms) ? ms : null;
    } catch {
      // Try the next PowerShell executable name.
    }
  }
  return null;
}

function readProcessStartedAtMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return readWindowsProcessStartedAtMs(pid);
  return null;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence probe, doesn't actually signal
    return true;
  } catch (err) {
    // EPERM = exists but not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parentIdentityMatches(pid: number, expectedStartedAtMs: number | null): boolean {
  if (!pidExists(pid)) return false;
  if (!expectedStartedAtMs) return true; // legacy/manual launch: PID liveness only.
  const actualStartedAtMs = readProcessStartedAtMs(pid);
  // Couldn't read the start time (transient PowerShell failure / no reader): the
  // pid IS alive, so DON'T false-positive "parent gone" and suicide — fall back
  // to liveness. The pack's Connect-time orphan check is the backstop for reuse.
  if (!actualStartedAtMs) return true;
  return Math.abs(actualStartedAtMs - expectedStartedAtMs) <= 2000;
}

/**
 * Tie the orchestrator's lifetime to ComfyUI's. The launcher (the panel pack)
 * passes its own PID as COMFYUI_MCP_PARENT_PID; we poll whether that process is
 * still alive and shut down when it's gone. Unlike an atexit/signal handler on
 * the parent, this also covers a ComfyUI crash or hard kill — the child notices
 * the parent disappeared and exits on its own. No-op when no parent PID is set
 * (e.g. when run manually from a terminal).
 */
function startParentWatchdog(onParentGone: () => void): void {
  const raw = process.env.COMFYUI_MCP_PARENT_PID;
  const ppid = raw ? Number(raw) : NaN;
  if (!Number.isInteger(ppid) || ppid <= 0) return;
  const expectedStartedAtMs = Number(process.env.COMFYUI_MCP_PARENT_STARTED_AT_MS) || null;
  // Cheap pid-liveness probe every 5s; the expensive start-time identity check
  // (which shells out to PowerShell on Windows) only every ~30s — enough to
  // catch pid reuse without spawning a process every 5s for the orchestrator's
  // whole life.
  let polls = 0;
  const timer = setInterval(() => {
    polls += 1;
    if (!pidExists(ppid)) {
      clearInterval(timer);
      onParentGone();
      return;
    }
    if (expectedStartedAtMs && polls % 6 === 0 && !parentIdentityMatches(ppid, expectedStartedAtMs)) {
      clearInterval(timer);
      onParentGone();
    }
  }, 5000);
  // Don't let the watchdog alone keep the process alive — the bridge does that.
  timer.unref?.();
  logger.info(`[panel-orchestrator] watching parent process ${ppid}; will shut down when it exits`);
}

/**
 * Run the panel orchestrator. Never resolves — the bridge and agents keep the
 * process alive until SIGINT/SIGTERM or the parent (ComfyUI) exits.
 */
export async function runPanelOrchestrator(): Promise<void> {
  // Crash guard: the orchestrator is a long-lived background process the user
  // can't see. A stray rejection (e.g. a fire-and-forget push to a tab that
  // vanished mid-flight, or an SDK hiccup) must never silently kill it —
  // otherwise the panel goes dead with no explanation. Log and keep running.
  process.on("unhandledRejection", (reason) => {
    // Benign strays are common here (a fire-and-forget push to a tab that vanished
    // mid-flight, an SDK hiccup) and must NOT kill the orchestrator — log + continue.
    logger.error(
      `[panel-orchestrator] unhandled rejection (ignored): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
    );
  });
  process.on("uncaughtException", (err) => {
    // A synchronous uncaught throw leaves the process in an UNDEFINED state. The
    // old "log + continue" here was a zombie root cause — the orchestrator stayed
    // alive but broken, so the panel couldn't reconnect and a ComfyUI restart just
    // reattached to it. Exit so the pack respawns a clean orchestrator (Node's own
    // default is to crash on uncaughtException anyway).
    logger.error(
      `[panel-orchestrator] FATAL uncaught exception — exiting so a fresh orchestrator can take over: ${err.stack ?? err.message}`,
    );
    process.exit(1);
  });

  // Self-exit seam. Wired to the real clean shutdown once it's defined below; until
  // then a fatal just exits the process directly. Idempotent (a flag guards repeat
  // calls). This is how an agent-fatal (onAgentFatal) or a never-handshaking model
  // probe collapses the wedged orchestrator so the pack can respawn a clean one.
  let selfExiting = false;
  let runShutdown: (() => void) | null = null;
  const requestSelfExit = (why: string): void => {
    if (selfExiting) return;
    selfExiting = true;
    logger.error(
      `[panel-orchestrator] self-exit (${why}) — closing the bridge so a fresh orchestrator can take over.`,
    );
    if (runShutdown) {
      runShutdown();
    } else {
      // Shutdown not yet wired (very early failure) — exit hard; the pack reclaims
      // the dead port and respawns.
      process.exit(1);
    }
  };

  // Subscription lane: the background agent must authenticate against the user's
  // claude.ai login, never an API key. Unset the key for the SDK subprocess.
  delete process.env.ANTHROPIC_API_KEY;

  // Dedicated PANEL bridge port (default 9180).
  const bridge = startUiBridge(Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180);

  // Owning the bridge port is the orchestrator's whole job — if another process
  // holds it, fail loudly instead of running uselessly. (This also avoids the
  // case where a failed bind leaves the process with no live handles and it
  // exits silently.)
  const bound = await bridge.whenReady();
  if (!bound) {
    logger.error(
      `[panel-orchestrator] could not bind the panel bridge port — another process owns it. Free that port and restart the orchestrator. Override the port with COMFYUI_MCP_BRIDGE_PORT.`,
    );
    process.exit(1);
  }

  // We own the port — register our REAL pid + the launching ComfyUI pid so the
  // panel pack can detect and replace us if we're ever orphaned across a Comfy
  // restart. Written only after a successful bind (so the file always names the
  // process that actually holds the port).
  const lockPort = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180;
  const lockPath = orchLockPath(lockPort);
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        // Our OWN process creation time, captured now while we KNOW this pid is
        // the real orchestrator. The pack matches a live pid's creation time
        // against this before ever killing it, so a reused pid (a shell, node,
        // anything that inherits our old pid) can't be mistaken for us and
        // terminated — the TOCTOU pid-reuse guard. Null on platforms we can't
        // read it (the pack then falls back to the cmdline identity check).
        pidStartedAt: readProcessStartedAtMs(process.pid),
        parent: Number(process.env.COMFYUI_MCP_PARENT_PID) || null,
        parentStartedAt: Number(process.env.COMFYUI_MCP_PARENT_STARTED_AT_MS) || null,
        port: lockPort,
        // The selected agent backend ("claude" default | "codex"). Lets the panel
        // pack's /backends route report which provider each running orchestrator is
        // without opening the bridge. Mirrors PANEL_AGENT_BACKEND.
        backend: (process.env.PANEL_AGENT_BACKEND ?? "claude").toLowerCase(),
        startedAt: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.debug(`[panel-orchestrator] could not write lockfile ${lockPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The spawned agent runs THIS comfyui-mcp build as its MCP server in normal
  // mode — so it generates against the live ComfyUI over COMFYUI_URL and never
  // tries to bind the bridge port we own here.
  const mcpEntry = fileURLToPath(new URL("../index.js", import.meta.url));
  // Mutable: the panel sends the ComfyUI URL it was SERVED FROM (window.location)
  // in `hello`, and the orchestrator retargets to it (applyComfyuiUrl) — so
  // `--panel-orchestrator` boots on the localhost default and auto-points at
  // whatever ComfyUI (local or a RunPod proxy) the browser is actually on. No
  // `connect <url>` needed.
  let comfyuiUrl = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
  // ComfyUI install path — when set AND the target is loopback, the spawned agent's
  // MCP runs in LOCAL mode (download_model / apply_manifest / installer-pack /
  // model-scan tools). A REMOTE target (non-loopback) forces remote-only, so we
  // drop the path. `envComfyuiPath` is the orchestrator's own env value; the live
  // `comfyuiPath` is derived from it + the current target.
  const envComfyuiPath = process.env.COMFYUI_PATH;
  const isLoopbackUrl = (u: string): boolean => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "";
    } catch {
      return true;
    }
  };
  let comfyuiPath = isLoopbackUrl(comfyuiUrl) ? envComfyuiPath : undefined;
  const model = process.env.COMFYUI_MCP_PANEL_MODEL ?? "claude-opus-4-8";
  const envEffort = process.env.COMFYUI_MCP_PANEL_EFFORT;
  const effort: Effort | undefined = isEffort(envEffort) ? envEffort : undefined;
  // Each backend runs its OWN orchestrator on its OWN loopback bridge port so the
  // providers never share a session or fight for a port. The launcher (panel pack)
  // sets COMFYUI_MCP_BRIDGE_PORT per the selected backend; the convention is
  // 9180 = claude (default), 9181 = codex, 9182 = gemini.
  const bridgePort = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180;

  // Cross-process download-progress channel: each tab's comfyui MCP subprocess
  // writes per-download JSON here; the watcher below broadcasts it to the panel
  // tray. Port-scoped so parallel orchestrators don't cross streams.
  const progressDir = join(tmpdir(), `comfyui-mcp-progress-${bridgePort}`);

  // The bundled plugin (skills) ships alongside dist/ in the package root. Load
  // it so the background agents are ComfyUI experts out of the box.
  const pluginPath = fileURLToPath(new URL("../../plugin", import.meta.url));
  const pluginAvailable = existsSync(pluginPath);
  if (!pluginAvailable) {
    logger.warn(
      `[panel-orchestrator] bundled plugin not found at ${pluginPath} — agents run without model-expertise skills.`,
    );
  }

  // Build an agent_status frame from a usage snapshot — used both live (per
  // assistant response) and to re-push the last value when a tab reconnects.
  function pushStatus(tabId: string, status: UsageStatus): void {
    bridge.push(
      {
        type: "agent_status",
        ...(typeof status.contextPct === "number" ? { context_pct: status.contextPct } : {}),
        ...(typeof status.used === "number" ? { used: status.used } : {}),
        ...(typeof status.contextWindow === "number" ? { context_window: status.contextWindow } : {}),
        ...(status.model ? { model: status.model } : {}),
        ...(typeof status.costUsd === "number" ? { cost_usd: status.costUsd } : {}),
      },
      tabId,
    );
  }

  // Inherit the user's own MCP servers (the same ones their normal `claude`
  // session uses), read from ~/.claude.json. Conflicting comfyui entries are
  // filtered out by the reader so they can't grab our bridge port. This is what
  // makes "add the CivitAI MCP" work: panel_add_mcp writes it here, a reload
  // re-reads it, and the agent gains those tools. Re-read on every (re)start so
  // new servers are picked up on the next soft reload.
  const userMcpServers = readUserMcpServers();
  const userMcpNames = Object.keys(userMcpServers);
  if (userMcpNames.length) {
    logger.info(`[panel-orchestrator] inheriting user MCP servers: ${userMcpNames.join(", ")}`);
  }

  // ---- agent backend toggle ----
  // Select the provider backend from PANEL_AGENT_BACKEND ("claude" default |
  // "codex"). Claude stays the default so existing behavior is 100% unchanged
  // when the env is unset. When "codex" is selected we inject a per-tab
  // CodexBackend (codex app-server JSON-RPC); otherwise makeBackend is omitted
  // and PanelAgent falls back to its built-in ClaudeBackend.
  //
  // FULL PARITY: the Codex backend now drives the live canvas too — it gets the
  // panel_* tools over a loopback HTTP MCP the orchestrator hosts (started below),
  // declared to the app-server alongside the headless comfyui (stdio) MCP. Claude
  // keeps its in-process SDK panel server unchanged.
  const backendId = (process.env.PANEL_AGENT_BACKEND ?? "claude").toLowerCase();
  // The panel's `model` is a Claude id (e.g. claude-opus-4-8) and is NOT a valid
  // Codex model — so for codex we only pass a model when COMFYUI_MCP_CODEX_MODEL
  // is set explicitly; otherwise Codex uses the account's default (e.g. gpt-5.5).
  const codexModel = process.env.COMFYUI_MCP_CODEX_MODEL;
  // Gemini likewise: the panel model is a Claude id, so the Gemini model comes from
  // COMFYUI_MCP_GEMINI_MODEL (default gemini-2.5-pro). The model is applied at spawn
  // via the CLI `--model` flag (ACP exposes no per-session model setter).
  const geminiModel = process.env.COMFYUI_MCP_GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL;
  // ── Per-tab backend (single-port multi-provider) ──────────────────────────
  // ONE orchestrator on ONE bridge port serves ALL providers; the panel picks a
  // provider per tab via the `hello`/`set_backend` handshake, instead of the node
  // spawning one process per provider on its own port (9180/9181/9182). Internally
  // each (panel tab, backend) pair is one agent addressed by a composite key
  // `tabId::backend`, so switching provider starts a FRESH session for that
  // provider (the panel replays the transcript to seed it) while a same-provider
  // reconnect RESUMES. `backendId`/`codexModel`/`geminiModel` above are the
  // DEFAULT + per-provider model config; the process is no longer pinned to one.
  const KNOWN_BACKENDS = new Set(["claude", "codex", "gemini"]);
  const defaultBackend = KNOWN_BACKENDS.has(backendId) ? backendId : "claude";
  const AGENT_KEY_SEP = "::";
  const tabBackends = new Map<string, string>(); // panel tabId -> selected backend
  const backendForTab = (panelTabId: string): string =>
    tabBackends.get(panelTabId) ?? defaultBackend;
  const agentKeyFor = (panelTabId: string): string =>
    panelTabId + AGENT_KEY_SEP + backendForTab(panelTabId);
  // A panel tab id never contains "::"; backend names never do — so split on the
  // LAST separator to recover each half from a composite key.
  const panelTabOf = (key: string): string => {
    const i = key.lastIndexOf(AGENT_KEY_SEP);
    return i >= 0 ? key.slice(0, i) : key;
  };
  const backendOf = (key: string): string => {
    const i = key.lastIndexOf(AGENT_KEY_SEP);
    return i >= 0 ? key.slice(i + AGENT_KEY_SEP.length) : defaultBackend;
  };

  // ---- live ENVIRONMENT-CAPABILITIES block ----
  // Gather the machine's facts ONCE at startup (CACHED) — OS/CPU/RAM from node,
  // GPU/VRAM/CUDA/torch/python/ComfyUI from /system_stats, Triton/SageAttention by
  // import-probing the ComfyUI python, plus active/other backend availability — and
  // PREPEND a compact one-line block to the static panel prompt so the agent knows
  // the machine without probing. Every probe is hard-timed-out and degrades to
  // "unknown", so this can NEVER hang session start: on total failure the prompt is
  // just the static text (no env block). Built once; refreshed after a ComfyUI
  // restart/reconnect via refreshEnvCapabilities() below.
  let envCaps: EnvCapabilities | undefined;
  let panelSystemAppend = PANEL_SYSTEM_APPEND;
  // Set once the manager exists so a later refresh (after a ComfyUI restart) feeds
  // the freshly-gathered env into newly-spawned agents too — Claude reads
  // manager.opts.systemAppend at each spawn; Codex reads the closed-over
  // panelSystemAppend at each makeBackend(). Updating both keeps the providers in
  // sync without rebuilding the manager.
  let liveManager: PanelAgentManager | undefined;
  async function refreshEnvCapabilities(): Promise<void> {
    try {
      envCaps = await gatherEnvCapabilities({ comfyuiUrl, comfyuiPath, backendId });
      panelSystemAppend = buildPanelSystemAppend(PANEL_SYSTEM_APPEND, envCaps);
      if (liveManager) liveManager.setSystemAppend(panelSystemAppend);
    } catch (err) {
      // Belt-and-suspenders: gather is internally guarded, but never let a stray
      // throw break the prompt — fall back to the static append.
      panelSystemAppend = PANEL_SYSTEM_APPEND;
      logger.debug(
        `[panel-orchestrator] env-capabilities probe failed (using static prompt): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Build it before any agent could spawn. Guarded so a probe stall can't block
  // orchestrator startup beyond the probes' own (short) timeouts.
  await refreshEnvCapabilities();

  // Render watchdog: a passive WS to ComfyUI that tracks live run progress so we
  // can warn the agent about a stalled render or a queue backlog it can't see
  // (panel_run queues through the browser). Best-effort — if the socket never
  // opens, the watchdog stays inactive and nothing else changes.
  QueueMonitor.start(comfyuiUrl);
  if (envCaps) {
    logger.info(
      `[panel-orchestrator] env: OS=${envCaps.os ?? "?"} GPU=${envCaps.gpu ?? "?"}${typeof envCaps.vramTotalGb === "number" ? ` ${envCaps.vramTotalGb}GB` : ""} torch=${envCaps.torch ?? "?"} cuda=${envCaps.cuda ?? "?"} py=${envCaps.python ?? "?"} comfyui=${envCaps.comfyui ?? "?"} (${envCaps.location ?? "?"}) triton=${envCaps.triton ?? "?"} sage=${envCaps.sageattention ?? "?"} backend=${envCaps.backend ?? "?"}`,
    );
  }

  // The BASE comfyui stdio MCP env both providers declare — COMFYUI_URL + progress
  // dir + local mode + pass-through credentials from the orchestrator's own env.
  // A panel-saved tool secret (CIVITAI_API_TOKEN, HF_TOKEN, …) is layered on top
  // by buildComfyuiMcpEnv() at SPAWN time, so the same headless tool surface — and
  // the same secrets — reach either provider.
  // A FUNCTION (not a frozen object) so it always reflects the CURRENT retargeted
  // comfyuiUrl/comfyuiPath — makeHttpBackendMcpServers calls it per (re)spawn.
  const comfyuiBaseEnv = (): Record<string, string> => ({
    COMFYUI_URL: comfyuiUrl,
    COMFYUI_MCP_PROGRESS_DIR: progressDir,
    ...(comfyuiPath ? { COMFYUI_PATH: comfyuiPath } : {}),
    // Pass through optional credentials the comfyui MCP honors, when set in the
    // orchestrator's env — so Codex can do everything Claude can (Civitai, HF).
    ...(process.env.CIVITAI_API_TOKEN ? { CIVITAI_API_TOKEN: process.env.CIVITAI_API_TOKEN } : {}),
    ...(process.env.HF_TOKEN ? { HF_TOKEN: process.env.HF_TOKEN } : {}),
    // Test-only tool-call trace (knowledge-parity smoke). No-op unless set.
    ...(process.env.COMFYUI_MCP_TOOL_TRACE ? { COMFYUI_MCP_TOOL_TRACE: process.env.COMFYUI_MCP_TOOL_TRACE } : {}),
  });

  // The orchestrator-hosted loopback HTTP MCP for panel_* tools. Started for the
  // non-Claude backends (Codex + Gemini), which can't host an in-process SDK MCP
  // server the way Claude does. Port: COMFYUI_MCP_PANEL_MCP_PORT, default
  // bridgePort+1 (loopback only).
  // Start the loopback HTTP panel-MCP ALWAYS: with single-port multi-provider any
  // tab may pick codex/gemini at runtime, and those backends drive the canvas
  // through this server (Claude tabs use the in-process SDK server instead). The
  // per-tab session routing (`urlFor(panelTabId)`) already isolates tabs.
  let panelMcpHttp: PanelMcpHttpServer | null = null;
  {
    const panelMcpPort = Number(process.env.COMFYUI_MCP_PANEL_MCP_PORT) || bridgePort + 1;
    try {
      panelMcpHttp = await startPanelMcpHttpServer(bridge, panelMcpPort);
    } catch (err) {
      logger.error(
        `[panel-orchestrator] could not start the panel HTTP MCP on :${panelMcpPort} — codex/gemini tabs will lack live-graph tools: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Shared MCP server config for BOTH the Codex and Gemini backends — they take an
  // identical { transport } spec (the headless comfyui stdio MCP + the panel HTTP
  // MCP for this tab). Claude keeps its own in-process server set unchanged.
  const makeHttpBackendMcpServers = (tabId: string) => ({
    // Headless comfyui MCP (this build) over stdio — same as Claude.
    comfyui: {
      transport: "stdio" as const,
      command: process.execPath, // node
      args: [mcpEntry], // dist/index.js
      // Merge persisted tool secrets at SPAWN time so a respawn picks up a
      // just-saved CIVITAI_API_TOKEN / HF_TOKEN without a process restart.
      env: buildComfyuiMcpEnv(comfyuiBaseEnv()),
    },
    // Live-graph panel_* tools for THIS tab over the loopback HTTP MCP.
    ...(panelMcpHttp
      ? { panel: { transport: "http" as const, url: panelMcpHttp.urlFor(tabId) } }
      : {}),
  });

  // Build the provider backend for a composite agent key `panelTabId::backend`.
  // Claude → undefined (PanelAgent uses its built-in in-process SDK backend);
  // codex/gemini → their CLI-driven backend, wired to the panel_* tools over the
  // loopback HTTP MCP for THIS panel tab's canvas (comfyuiUrl gives vision parity).
  const makeBackend = (key: string): AgentBackend | undefined => {
    const backend = backendOf(key);
    const panelTabId = panelTabOf(key);
    if (backend === "codex") {
      return new CodexBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: codexModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    if (backend === "gemini") {
      return new GeminiBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: geminiModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    return undefined; // claude → built-in ClaudeBackend
  };
  logger.info(
    `[panel-orchestrator] single-port multi-provider: default backend=${defaultBackend}; ` +
      `codex/gemini panel_* live-graph tools via loopback HTTP MCP${panelMcpHttp ? ` on :${panelMcpHttp.port}` : " UNAVAILABLE"} + headless comfyui MCP`,
  );
  // Readiness/model probing routes through the SELECTED backend PER TAB — a
  // codex/gemini tab's "ready" must NOT depend on Claude SDK/login health. Claude
  // uses fetchSupportedModels(); codex/gemini spin up a throwaway probe backend
  // (which also proves the CLI can launch). Cached per backend so repeated hellos
  // don't re-probe.
  const probeBackends = new Map<string, AgentBackend>();
  const getProbeBackend = (backend: string): AgentBackend | null => {
    if (backend === "claude") return null; // claude uses the SDK probe below
    let pb = probeBackends.get(backend);
    if (!pb) {
      pb =
        backend === "codex"
          ? new CodexBackend({ cwd: comfyuiPath ?? process.cwd(), model: codexModel })
          : new GeminiBackend({ cwd: comfyuiPath ?? process.cwd(), model: geminiModel });
      probeBackends.set(backend, pb);
    }
    return pb;
  };

  // Durable per-tab session ids (keyed by our bridge port), so a tab's agent
  // resumes its conversation even after the orchestrator PROCESS is killed and
  // respawned (a wedge auto-restart) — not just a soft reload.
  const sessionStore = new SessionStore(lockPort);
  // The Claude-path MCP server set, REBUILT on demand so a just-saved tool secret
  // (persisted by panel-secrets) lands in the comfyui server's spawn env. The
  // comfyui server is declared LAST so it always wins over any user entry that
  // slipped through (defensive — the reader already filters comfyui-mcp entries).
  const buildMcpServers = () => ({
    // The user's inherited servers first… (re-read so a panel_add_mcp is picked
    // up on the same in-process respawn, mirroring a soft reload).
    ...readUserMcpServers(),
    comfyui: {
      type: "stdio" as const,
      command: process.execPath, // node
      args: [mcpEntry], // dist/index.js
      env: buildComfyuiMcpEnv({
        COMFYUI_URL: comfyuiUrl,
        // Where download_model writes live progress for the panel tray.
        COMFYUI_MCP_PROGRESS_DIR: progressDir,
        // Local mode → enables download_model, apply_manifest (installer packs),
        // and model scans so the agent installs the right way instead of curl.
        ...(comfyuiPath ? { COMFYUI_PATH: comfyuiPath } : {}),
      }),
    },
  });
  const manager = new PanelAgentManager({
    model,
    effort,
    makeBackend,
    comfyuiUrl, // for fetching image bytes to inline into agent turns
    systemAppend: panelSystemAppend,
    pluginPath: pluginAvailable ? pluginPath : undefined,
    // In-process live-graph MCP for CLAUDE keys only (codex/gemini drive the
    // canvas through the loopback HTTP MCP instead). Bound to the PANEL tab so
    // panel_* tools reach the user's canvas regardless of the composite key.
    makePanelServer: (key) =>
      backendOf(key) === "claude" ? createPanelMcpServer(bridge, panelTabOf(key)) : undefined,
    mcpServers: buildMcpServers(),
    // NOTE: manager callbacks fire with the composite agent key `tabId::backend`;
    // panelTabOf() recovers the PANEL tab so every push reaches the right socket.
    onSay: (key, text, meta) => {
      // `id` lets the panel reconcile this committed message with its live
      // streaming preview (same id) instead of rendering a duplicate bubble.
      bridge.push({ type: "say", text, id: meta?.id, streamed: meta?.streamed }, panelTabOf(key));
    },
    // Live streaming deltas → the panel's think-window + streaming reply bubble.
    onStream: (key, ev) => {
      bridge.push({ type: "stream", phase: ev.phase, id: ev.id, delta: ev.delta }, panelTabOf(key));
    },
    // Per-response usage → the panel's context/usage meter (updates live).
    onStatus: (key, status) => pushStatus(panelTabOf(key), status),
    // Report the SDK session id so the panel can persist it and resume on reload.
    onSession: (key, sessionId) => {
      bridge.push({ type: "session", session_id: sessionId }, panelTabOf(key));
    },
    // Per-turn rewind anchor (assistant UUID) → the panel stores it so a later
    // "rewind conversation to here" can fork the session at that point.
    onTurnAnchor: (key, uuid) => {
      bridge.push({ type: "turn_anchor", uuid }, panelTabOf(key));
    },
    // Turn lifecycle → the panel's "working" indicator (stays up through silent
    // tool work; clears on done).
    onTurn: (key, state) => {
      bridge.push({ type: "turn", state }, panelTabOf(key));
    },
    // Live extended-thinking token count → "thinking… (N)" indicator.
    onThinking: (key, tokens) => {
      bridge.push({ type: "thinking", tokens }, panelTabOf(key));
    },
    // The agent dequeued a message (the true "read" moment) → flip that bubble
    // from queued/muted to read.
    onSeen: (key, mid) => {
      bridge.push({ type: "ack", ok: true, kind: "seen", mid }, panelTabOf(key));
    },
    // ROOT-CAUSE self-exit (the "bridge open but no panel agent responded" wedge):
    // a tab's agent died fatally (couldn't start, or its bounded self-restart gave
    // up). The orchestrator is alive and the bridge is up, but no agent will ever
    // handshake — exactly the wedge. Exit cleanly so the panel pack's bridge-death
    // → reclaim + sticky-reconnect respawns a FRESH orchestrator, instead of
    // leaving the user staring at the manual "fully restart ComfyUI" warning.
    // Mirrors the uncaughtException exit above (Node's own default on a fatal).
    onAgentFatal: (tabId, reason) => {
      requestSelfExit(`tab ${tabId.slice(0, 8)} ${reason}`);
    },
    sessionStore,
  });
  // Let refreshEnvCapabilities() feed a freshly-gathered env block into agents
  // spawned after a ComfyUI restart/reconnect.
  liveManager = manager;

  // Retarget the live ComfyUI from the panel's `hello.comfyui_url` (the URL the
  // browser was SERVED FROM — window.location). This is what lets a bare
  // `--panel-orchestrator` (booted on the localhost default) auto-point at whatever
  // ComfyUI the user actually has open — local OR a RunPod proxy — with no
  // `connect <url>`. Loopback → LOCAL mode (keep COMFYUI_PATH); non-loopback →
  // REMOTE mode (drop the path). No-op if unchanged. Returns true if it retargeted.
  const applyComfyuiUrl = (rawUrl: unknown): boolean => {
    if (typeof rawUrl !== "string") return false;
    const next = rawUrl.trim().replace(/\/+$/, "");
    if (!next) return false;
    let host: string;
    try {
      const parsed = new URL(next);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      host = parsed.hostname;
    } catch {
      return false; // not a valid URL — ignore (keep current target)
    }
    if (!host || next === comfyuiUrl) return false;
    const prev = comfyuiUrl;
    comfyuiUrl = next;
    comfyuiPath = isLoopbackUrl(next) ? envComfyuiPath : undefined;
    // Point every provider at the new target: Claude via its rebuilt MCP env, the
    // manager's image-fetch URL, then respawn active agents so the live comfyui MCP
    // subprocess is recreated with the new COMFYUI_URL (no-op if none are running —
    // the next spawn picks it up from the now-updated closures).
    manager.setMcpServers(buildMcpServers());
    manager.setComfyuiUrl(comfyuiUrl);
    manager.restartAllForMcpEnv();
    // Re-point the render watchdog and re-probe the env (remote vs local differs).
    try {
      QueueMonitor.stop();
    } catch {
      /* best-effort */
    }
    QueueMonitor.start(comfyuiUrl);
    void refreshEnvCapabilities();
    logger.info(
      `[panel-orchestrator] retargeted ComfyUI ${prev} → ${comfyuiUrl} (${isLoopbackUrl(next) ? "local" : "remote"} mode) from panel hello`,
    );
    return true;
  };

  // Tool secrets → comfyui MCP env: when the user saves a token via
  // panel_request_secret (e.g. CIVITAI_API_TOKEN for download_civitai_model), the
  // secret store persists it and fires this. We rebuild the comfyui server's spawn
  // env (now carrying the secret) for the Claude path — the Codex path reads the
  // store per-spawn already — then respawn each tab's agent (resume) at its next
  // idle so the LIVE comfyui MCP subprocess is recreated WITH the new env, and
  // nudge it to retry the action the secret unblocked. No process restart, no
  // reload fight. The value is never logged — only the env-var KEYS.
  const unsubscribeSecrets = onComfyuiSecretsChanged(() => {
    manager.setMcpServers(buildMcpServers());
    manager.restartAllForMcpEnv(
      "🔑 The API token you just provided is now active for the comfyui tools — retry the action that needed it (e.g. the download that returned 401).",
    );
    logger.info(
      `[panel-orchestrator] tool secret saved → comfyui MCP env updated + agents respawn on idle (keys: ${comfyuiSecretKeys().join(", ") || "none"})`,
    );
  });

  // Debounce the connect ack: the panel re-sends `hello` on reconnect and on
  // workflow-title changes, which would otherwise stack duplicate greetings.
  const lastAckAt = new Map<string, number>();
  const ACK_DEBOUNCE_MS = 4000;

  // The account's real model list — probed once from the SDK (the only way that
  // works on the subscription lane) and cached. Pushed to each tab so the
  // panel's model/effort picker reflects what's actually available, with each
  // model's supported effort levels, instead of a hardcoded list.
  // Model list PER BACKEND — probed lazily and cached; an empty/failed probe is
  // NOT cached so the next hello retries. Claude uses fetchSupportedModels() (the
  // only path that works on the subscription lane); codex/gemini enumerate via a
  // throwaway probe backend, which also proves the CLI can launch (= readiness).
  // (Gemini's probe proves the CLI + ACP handshake but not Google sign-in, which
  // ACP only reports at session/new — so its "ready" is provisional; a signed-out
  // CLI surfaces a clear one-shot error on the first turn.)
  const modelsByBackend = new Map<string, Promise<ModelInfo[]>>();
  function ensureModels(backend: string): Promise<ModelInfo[]> {
    let p = modelsByBackend.get(backend);
    if (!p) {
      const pb = getProbeBackend(backend);
      const probe: Promise<ModelInfo[]> = pb
        ? Promise.resolve(pb.prepare?.())
            .then(() => pb.listModels())
            .then((list) =>
              list.map(
                (m) =>
                  ({
                    value: m.id,
                    displayName: m.label ?? m.id,
                    ...(m.supportsEffort != null ? { supportsEffort: m.supportsEffort } : {}),
                    ...(m.supportedEffortLevels ? { supportedEffortLevels: m.supportedEffortLevels } : {}),
                  }) as unknown as ModelInfo,
              ),
            )
            .catch((err) => {
              logger.warn(`[panel-orchestrator] ${backend} model probe failed: ${err instanceof Error ? err.message : String(err)}`);
              return [] as ModelInfo[];
            })
        : fetchSupportedModels(model);
      p = probe.then((list) => {
        if (!list.length) modelsByBackend.delete(backend); // don't cache a failure
        return list;
      });
      modelsByBackend.set(backend, p);
    }
    return p;
  }
  // The model to highlight as "current" for a backend: the panel's configured
  // model for claude; the env override (or account default = the list's own
  // current) for codex/gemini.
  function currentModelFor(backend: string): string | undefined {
    if (backend === "codex") return codexModel;
    if (backend === "gemini") return geminiModel;
    return model;
  }
  function pushModels(panelTabId: string): void {
    const backend = backendForTab(panelTabId);
    void ensureModels(backend)
      .then((models) => {
        if (models.length) {
          // `backend` rides on the models frame so the panel's picker reflects the
          // provider THIS tab selected (single-port multi-provider).
          bridge.push(
            { type: "models", models, current: currentModelFor(backend), backend },
            panelTabId,
          );
        }
      })
      .catch(() => {
        /* probe already logged; panel keeps its fallback list */
      });
  }

  // The SDK's slash commands (built-ins like /compact, plus any loaded skills) —
  // probed once and surfaced in the panel composer's completion menu.
  let commandsPromise: Promise<SlashCommand[]> | null = null;
  function ensureCommands(): Promise<SlashCommand[]> {
    if (!commandsPromise) {
      commandsPromise = fetchSupportedCommands(model).then((list) => {
        if (!list.length) commandsPromise = null; // let the next hello retry
        return list;
      });
    }
    return commandsPromise;
  }
  // The SDK reports EVERY command the user's Claude install exposes — including
  // all their unrelated skills/plugins (Cloudflare, codex:*, etc.). Surface only
  // the built-ins that make sense inside the ComfyUI panel chat.
  const PANEL_SLASH_ALLOWLIST = new Set(["compact", "context", "usage", "loop", "goal", "clear"]);
  function pushCommands(tabId: string): void {
    // Claude-only: SDK slash-commands don't exist for codex/gemini. Callers already
    // gate this to claude tabs (single-port multi-provider), so no backend check here.
    void ensureCommands()
      .then((commands) => {
        const useful = commands.filter((c) => PANEL_SLASH_ALLOWLIST.has(c.name));
        if (useful.length) bridge.push({ type: "commands", commands: useful }, tabId);
      })
      .catch(() => {
        /* probe already logged; panel just won't show SDK commands */
      });
  }

  // Real per-provider readiness, computed HERE (the machine running the agents)
  // and pushed over the bridge so the panel's provider switcher reflects the
  // truth — not the ComfyUI host's probe, which is blind to the laptop in the
  // "remote ComfyUI, local agent" model (and never sees Claude's SDK, which has
  // no CLI). The panel prefers this frame over its GET /backends probe.
  function pushReadiness(tabId: string): void {
    try {
      const { backends, any_ready } = allBackendReadiness(KNOWN_BACKENDS);
      bridge.push({ type: "backends", backends, any_ready }, tabId);
    } catch (err) {
      logger.warn(`[panel-orchestrator] readiness probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  bridge.onPanelMessage = (event) => {
    // Connect ack: the instant a panel tab connects, the orchestrator announces
    // itself so "connected" means "a real agent is attending" — not merely "a
    // socket is open." A bare/undriven bridge stays silent, so the panel can
    // tell the difference (and warn if no ack arrives).
    if (event.type === "hello" && event.tab_id) {
      const panelTab = event.tab_id;
      // Retarget ComfyUI to the URL the browser was served from (window.location),
      // BEFORE the readiness probe so the "ready" ack reflects the right instance.
      applyComfyuiUrl((event as { comfyui_url?: unknown }).comfyui_url);
      // Per-tab backend selection (single-port multi-provider). The panel names
      // its chosen provider on connect (and on a switch it re-sends hello / a
      // set_backend); absent or unknown → the default.
      const reqBackend =
        typeof (event as { backend?: unknown }).backend === "string"
          ? ((event as { backend?: string }).backend as string).toLowerCase()
          : undefined;
      const backend = reqBackend && KNOWN_BACKENDS.has(reqBackend) ? reqBackend : defaultBackend;
      const prev = tabBackends.get(panelTab);
      if (prev && prev !== backend) {
        // Provider switch: retire the previous provider's agent for this tab so it
        // doesn't linger. The new provider starts a FRESH session (the panel
        // replays the transcript as context on its first message to seed it).
        manager.reset(panelTab + AGENT_KEY_SEP + prev);
      }
      tabBackends.set(panelTab, backend);
      const key = panelTab + AGENT_KEY_SEP + backend;

      // Reload restore: the panel re-sends the last session id it saw. Honored
      // only for a SAME-provider (re)connect — a switch always starts fresh. The
      // orchestrator's own store stays authoritative on the actual spawn.
      const resume = typeof event.resume === "string" ? event.resume : undefined;
      if (resume && (!prev || prev === backend)) manager.setResume(key, resume);

      // Live model list for the picker; SDK slash commands are Claude-only.
      pushModels(panelTab);
      // Truthful provider readiness (this machine runs the agents), so the
      // switcher stops falsely showing "CLI not installed" behind a remote pod.
      pushReadiness(panelTab);
      if (backend === "claude") pushCommands(panelTab);
      // Re-push the last usage so the context meter isn't blank after a reload.
      const lastStatus = manager.lastStatusFor(key);
      if (lastStatus) pushStatus(panelTab, lastStatus);
      const now = Date.now();
      if (now - (lastAckAt.get(panelTab) ?? 0) < ACK_DEBOUNCE_MS) return;
      lastAckAt.set(panelTab, now);
      const isCx = backend === "codex";
      const isGm = backend === "gemini";
      // TRUTHFUL "connected": only claim ready after PROVING the SELECTED backend
      // can run, by probing its model list. If the probe fails — the "connected
      // but dead" wedge — send a degraded ack so the panel shows the real state.
      void ensureModels(backend)
        .then((models) => {
          if (models.length) {
            const agentLabel = isCx
              ? (codexModel ?? (models[0] as { value?: string }).value ?? "Codex")
              : isGm
                ? (geminiModel ?? (models[0] as { value?: string }).value ?? "Gemini")
                : model;
            // Greet only on a FRESH session (a resume/reconnect already has the thread).
            if (!resume) {
              const readyText = isCx
                ? `🟢 comfyui-mcp agent ready — ${agentLabel} on your Codex (ChatGPT) account. Ask away.`
                : isGm
                  ? `🟢 comfyui-mcp agent ready — ${agentLabel} on your Google account (Gemini Code Assist). Ask away.`
                  : `🟢 comfyui-mcp agent ready — ${agentLabel} on your Claude subscription. Ask away.`;
              bridge.push({ type: "say", text: readyText }, panelTab);
            }
            bridge.push({ type: "ack", ok: true, kind: "ready", agent: agentLabel, backend }, panelTab);
            logger.info(`[panel-orchestrator] tab ${panelTab.slice(0, 8)} connected (${backend}) — agent healthy, ready ack`);
          } else {
            const degradedText = isCx
              ? "⚠️ The background agent isn't responding — the Codex app-server couldn't start. Make sure Codex is installed and signed in (run `codex login`), then Disconnect → Connect to retry."
              : isGm
                ? "⚠️ The background agent isn't responding — the Gemini CLI couldn't start. Make sure the Gemini CLI is installed and signed in (run `gemini` once and complete the Google sign-in), then Disconnect → Connect to retry."
                : "⚠️ The background agent isn't responding — the Claude Agent SDK couldn't start. Make sure you're signed in (run `claude` once), then Disconnect → Connect to retry.";
            bridge.push({ type: "say", text: degradedText }, panelTab);
            bridge.push({ type: "ack", ok: false, kind: "degraded" }, panelTab);
            logger.warn(`[panel-orchestrator] tab ${panelTab.slice(0, 8)} connected (${backend}) but model probe empty — degraded ack`);
          }
        })
        .catch(() => {
          bridge.push({ type: "ack", ok: false, kind: "degraded" }, panelTab);
        });
      return;
    }

    // Provider switch WITHOUT a reconnect (single-port multi-provider): the panel
    // picked a different backend chip. Retire the old provider's agent, remember
    // the new one, and re-advertise its models. The panel replays the transcript
    // as context on its next message so the fresh provider has the conversation.
    if (event.type === "set_backend" && event.tab_id) {
      const panelTab = event.tab_id;
      const reqBackend =
        typeof (event as { backend?: unknown }).backend === "string"
          ? ((event as { backend?: string }).backend as string).toLowerCase()
          : "";
      if (!KNOWN_BACKENDS.has(reqBackend)) {
        bridge.push({ type: "ack", ok: false, kind: "set_backend", message: `unknown backend '${reqBackend}'` }, panelTab);
        return;
      }
      const prev = tabBackends.get(panelTab) ?? defaultBackend;
      if (prev !== reqBackend) manager.reset(panelTab + AGENT_KEY_SEP + prev);
      tabBackends.set(panelTab, reqBackend);
      pushModels(panelTab);
      if (reqBackend === "claude") pushCommands(panelTab);
      bridge.push({ type: "ack", ok: true, kind: "set_backend", backend: reqBackend }, panelTab);
      logger.info(`[panel-orchestrator] tab ${panelTab.slice(0, 8)} switched backend ${prev} → ${reqBackend}`);
      return;
    }
    // Live panel config (currently just the render-stall threshold). Applied
    // immediately, no reconnect — the next turn's watchdog check uses the new
    // value. Sent by the panel on connect and whenever the setting changes.
    if (event.type === "set_config" && event.tab_id) {
      if ("stall_seconds" in event) {
        setLiveStallSeconds((event as { stall_seconds?: unknown }).stall_seconds);
        logger.info(
          `[panel-orchestrator] live stall threshold → ${liveStallSeconds ?? "default"}s`,
        );
      }
      bridge.push({ type: "ack", ok: true, kind: "config" }, event.tab_id);
      return;
    }

    // Model / effort picker: apply and confirm. Model switches live; an effort
    // change restarts the session (resumed) so the conversation carries over.
    if (event.type === "set_options" && event.tab_id) {
      const tabId = event.tab_id;
      const reqModel = typeof event.model === "string" ? event.model : undefined;
      const nextEffort: Effort | null | undefined =
        event.effort === null
          ? null
          : isEffort(event.effort)
            ? event.effort
            : undefined;
      void (async () => {
        let nextModel = reqModel;
        // Guard: never switch to a model the account can't use — an unknown id
        // makes the SDK session hang on init. (Defense in depth; the panel only
        // sends ids from the live catalog.)
        if (nextModel) {
          const known = await ensureModels(backendForTab(tabId)).catch(() => [] as ModelInfo[]);
          if (known.length && !known.some((m) => m.value === nextModel)) {
            logger.warn(`[panel-orchestrator] ignoring unknown model "${nextModel}" — keeping current`);
            nextModel = undefined;
          }
        }
        const applied = await manager.setOptions(agentKeyFor(tabId), { model: nextModel, effort: nextEffort });
        bridge.push(
          {
            type: "ack",
            ok: true,
            kind: "options",
            model: applied.model,
            effort: applied.effort ?? null,
            restarted: applied.restarted,
            // Effort changed mid-turn → it takes effect once the current turn ends
            // (we never interrupt a live reply). The panel can note this.
            deferred: applied.deferred,
          },
          tabId,
        );
      })().catch((err) => {
        bridge.push(
          { type: "say", text: `⚠️ Could not change model/effort: ${err?.message ?? err}` },
          tabId,
        );
      });
      return;
    }

    // Execution event from the panel (run finished / errored). Feed it to the
    // tab's live agent so it knows its render landed and can comment/iterate.
    // Dropped silently if no agent is attending the tab (we don't spawn one).
    if (event.type === "agent_event" && event.tab_id) {
      const ev = event as {
        kind?: string;
        images?: Array<{ filename: string; subfolder?: string; type?: string }>;
        error?: string;
        note?: string;
      };
      // A run error is URGENT: interrupt the live turn + front-queue it ("hey,
      // look at me") so the agent stops and fixes it instead of running blind.
      // Everything else (e.g. a finished render's images) is enqueued normally.
      if (ev.kind === "run_error") {
        void manager.injectRunError(agentKeyFor(event.tab_id), ev.error ?? "unknown error");
        logger.info(`[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} run_error → agent (interrupt)`);
        return;
      }
      const delivered = manager.injectEvent(agentKeyFor(event.tab_id), ev);
      if (delivered) {
        logger.info(`[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} event → agent: ${event.kind}`);
      }
      return;
    }

    // Interrupt: stop the current turn without ending the session (Ctrl+C in
    // the panel). The session stays open for the next message.
    if (event.type === "interrupt" && event.tab_id) {
      const tabId = event.tab_id;
      // Only "send now" (requeue:true from the pending tray) re-queues the
      // interrupted turn so BOTH messages get answered; a plain Stop/Ctrl+C/Esc
      // sends a bare interrupt and must NOT re-run the stopped turn.
      const requeueInFlight = (event as { requeue?: boolean }).requeue === true;
      void manager.interrupt(agentKeyFor(tabId), { requeueInFlight });
      bridge.push({ type: "ack", ok: true, kind: "interrupt" }, tabId);
      logger.info(
        `[panel-orchestrator] tab ${tabId.slice(0, 8)} interrupted${requeueInFlight ? " (send-now: re-queue)" : ""}`,
      );
      return;
    }

    // The user edited/deleted a still-QUEUED message before the agent read it —
    // drop it from the agent's queue so it's never processed.
    if (event.type === "cancel_message" && event.tab_id) {
      const tabId = event.tab_id;
      const mid = typeof (event as { mid?: unknown }).mid === "string" ? (event as { mid?: string }).mid : undefined;
      const removed = mid ? manager.cancelQueued(agentKeyFor(tabId), mid) : false;
      bridge.push({ type: "ack", ok: true, kind: "cancel_message", mid, removed }, tabId);
      return;
    }

    // New chat: forget this tab's session so the next message starts fresh (no
    // memory of the prior conversation). Tell the panel to drop its stored id.
    if (event.type === "new_session" && event.tab_id) {
      const tabId = event.tab_id;
      // reset() is synchronous (map cleared now), so no concurrent send() can
      // spawn an agent before we report the cleared session.
      manager.reset(agentKeyFor(tabId));
      bridge.push({ type: "session", session_id: null }, tabId);
      bridge.push({ type: "ack", ok: true, kind: "new_session" }, tabId);
      return;
    }

    // Rewind the conversation: fork the live session at `anchor` (an assistant
    // UUID the panel stored from onTurnAnchor) so everything after it is dropped,
    // optionally continuing with the user's edited `text`. The panel handles the
    // graph (code) scope locally; this is the conversation scope.
    if (event.type === "rewind" && event.tab_id) {
      const tabId = event.tab_id;
      const anchor = typeof event.anchor === "string" ? event.anchor : null;
      const ok = manager.rewind(agentKeyFor(tabId), anchor);
      bridge.push({ type: "ack", ok, kind: "rewind" }, tabId);
      logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} rewind (anchor=${anchor ? anchor.slice(0, 8) : "fresh"}, ok=${ok})`);
      return;
    }

    // Reorder still-queued messages to the panel's desired flush order.
    if (event.type === "reorder" && event.tab_id) {
      const tabId = event.tab_id;
      const order = Array.isArray((event as { order?: unknown }).order)
        ? ((event as { order?: unknown[] }).order!.filter((m) => typeof m === "string") as string[])
        : [];
      const ok = manager.reorderQueue(agentKeyFor(tabId), order);
      bridge.push({ type: "ack", ok, kind: "reorder" }, tabId);
      logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} reorder queue (${order.length} mids, ok=${ok})`);
      return;
    }

    // Switch to a historical chat: drop the live agent and arm a resume so the
    // next message continues THAT conversation. Both calls are synchronous, so
    // the resume is armed before any later message can spawn a fresh agent.
    if (event.type === "resume_session" && event.tab_id) {
      const tabId = event.tab_id;
      const sid = typeof event.session_id === "string" ? event.session_id : undefined;
      const key = agentKeyFor(tabId);
      manager.reset(key);
      if (sid) manager.setResume(key, sid);
      bridge.push({ type: "ack", ok: true, kind: "resume_session" }, tabId);
      return;
    }

    if (
      event.type !== "user_message" ||
      typeof event.text !== "string" ||
      !event.tab_id
    ) {
      return;
    }
    // Echo so the user immediately sees their own message land in the chat.
    bridge.push({ type: "echo", text: event.text }, event.tab_id);
    // Per-message ack: a live server-side signal that the agent received this
    // turn and is working — distinct from the panel's own optimistic spinner.
    // Echo the client mid so the panel can mark that exact bubble delivered.
    const userMid = typeof (event as { mid?: unknown }).mid === "string" ? (event as { mid?: string }).mid : undefined;
    bridge.push({ type: "ack", ok: true, kind: "working", ...(userMid ? { mid: userMid } : {}) }, event.tab_id);
    // Show the working indicator immediately (before the first assistant token).
    bridge.push({ type: "turn", state: "working" }, event.tab_id);
    logger.info(
      `[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} → agent: ${event.text.slice(0, 80)}`,
    );
    // AUTO CRASH-DUMP (Part A): the panel's post-restart resume nudges are
    // auto-generated "✅ … restarted/reconnected … continue …" messages. When one
    // arrives AND ComfyUI's log shows a native crash near the tail, PREPEND the
    // fatal block + culprit node so the agent sees WHY it restarted and fixes the
    // node instead of blindly re-running the crashing graph. Only fires on a real
    // crash signature (clean restarts inject nothing). The note is capped in size.
    let outText = event.text;
    if (isResumeNudge(event.text)) {
      // A resume nudge is the post-restart/reconnect signal — cheaply re-gather the
      // live env in the background so agents spawned after this restart pick up any
      // changes (e.g. Triton/SageAttention just installed, a new torch). Fire-and-
      // forget; it never blocks the turn and its probes are all timed out.
      void refreshEnvCapabilities();
      try {
        const crash = readComfyuiCrashLog(comfyuiPath);
        const note = formatCrashNote(crash);
        const key = crash.fingerprint ? `${event.tab_id}:${crash.fingerprint}` : null;
        if (note && key && !injectedCrashes.has(key)) {
          injectedCrashes.add(key);
          outText = `${note}\n\n${event.text}`;
          logger.warn(
            `[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} crash-dump injected on resume — culprit=${crash.culpritNode ?? "?"} frame=${crash.culpritFrame ?? "?"} (log=${crash.logPath ?? "?"})`,
          );
        }
      } catch (err) {
        logger.debug(
          `[panel-orchestrator] crash-log read failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // QUEUE WATCHDOG: surface a stalled render or a queue backlog the agent can't
    // see (panel_run queues through the browser; the agent has no live view of
    // ComfyUI's queue). Prepend ONCE per episode, the same way crash dumps inject.
    try {
      const rep = QueueMonitor.report(stallThresholdMs());
      const qnote = formatQueueNote(rep);
      if (qnote) {
        const key = `${event.tab_id}:${rep.runningPromptId ?? "backlog"}:${rep.stalled ? "stall" : "backlog"}`;
        if (!injectedQueueNotes.has(key)) {
          injectedQueueNotes.add(key);
          outText = `${qnote}\n\n${outText}`;
          logger.warn(
            `[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} queue note injected — ${rep.stalled ? "STALL" : "BACKLOG"} depth=${rep.queueDepth} node=${rep.currentNode ?? "?"} prompt=${rep.runningPromptId ?? "?"}`,
          );
        }
      }
    } catch (err) {
      logger.debug(
        `[panel-orchestrator] queue-note check failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Transcript replay (single-port provider switch): the panel sends the prior
    // conversation as `context` on the FIRST message to a freshly-switched
    // provider, so the new backend has the thread (minus internal session data —
    // thinking/tool traces/cache aren't portable across providers). Prepend it the
    // same way crash/queue notes are, so it seeds the fresh session's first turn.
    const replay =
      typeof (event as { context?: unknown }).context === "string"
        ? ((event as { context?: string }).context as string).trim()
        : "";
    if (replay) outText = `${replay}\n\n${outText}`;
    manager.send(agentKeyFor(event.tab_id), outText, {
      title: event.title,
      images: (event as { images?: Array<{ filename: string; subfolder?: string; type?: string }> }).images,
      mid: userMid,
    });
  };

  // ---- Download-progress watcher ----
  // Each tab's comfyui MCP (download_model) writes per-download JSON into
  // progressDir; poll it and broadcast the rows to every panel tab's tray.
  // Done/error rows linger briefly (so completion is visible), then are pruned;
  // a downloading row that stops updating for 60s is treated as a dead writer.
  const DOWNLOAD_LINGER_MS = 8000;
  const downloadRemoveAt = new Map<string, number>();
  let lastDownloadSnapshot = "[]";
  const pollDownloads = () => {
    let files: string[] = [];
    try {
      files = readdirSync(progressDir).filter((f) => f.endsWith(".json"));
    } catch {
      files = []; // dir not created yet — nothing downloading
    }
    const now = Date.now();
    const downloads: Array<Record<string, unknown>> = [];
    for (const f of files) {
      const full = join(progressDir, f);
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
      } catch {
        continue; // mid-write or corrupt — retry next tick
      }
      if (!row || typeof row !== "object") continue;
      const status = row.status;
      const updated = typeof row.updated === "number" ? row.updated : now;
      if (status === "done" || status === "error") {
        const due = downloadRemoveAt.get(full);
        if (due == null) {
          downloadRemoveAt.set(full, now + DOWNLOAD_LINGER_MS); // start the linger
        } else if (now >= due) {
          try { unlinkSync(full); } catch { /* already gone */ }
          downloadRemoveAt.delete(full);
          continue; // pruned from the tray
        }
      } else {
        downloadRemoveAt.delete(full);
        if (now - updated > 60000) {
          try { unlinkSync(full); } catch { /* ignore */ }
          continue; // dead writer (crashed mid-download)
        }
      }
      downloads.push(row);
    }
    downloads.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    const snapshot = JSON.stringify(downloads);
    if (snapshot !== lastDownloadSnapshot) {
      lastDownloadSnapshot = snapshot;
      bridge.push({ type: "download_progress", downloads }); // broadcast to all tabs
    }
  };
  const downloadTimer = setInterval(pollDownloads, 700);
  downloadTimer.unref?.();

  logger.info(
    `[panel-orchestrator] ready — bridge on ws://127.0.0.1:${bridgePort}; an agent spawns per ComfyUI tab on its first message (model=${model}, comfyui=${comfyuiUrl}${comfyuiPath ? `, path=${comfyuiPath}` : " — no COMFYUI_PATH, local install/pack tools limited"})`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[panel-orchestrator] shutting down — stopping agents…");
    clearInterval(downloadTimer);
    QueueMonitor.stop();
    unsubscribeSecrets();
    await manager.stopAll();
    // Dispose the readiness-probe backends (kills each Codex/Gemini CLI child).
    for (const pb of probeBackends.values()) {
      if (pb.close) await pb.close().catch(() => {});
    }
    // Tear down the loopback panel HTTP MCP (codex/gemini mode only).
    if (panelMcpHttp) await panelMcpHttp.stop().catch(() => {});
    await bridge.stop();
    // Only remove the lockfile if it still names us — avoid clobbering a fresh
    // orchestrator that may have replaced us.
    try {
      const cur = JSON.parse(readFileSync(lockPath, "utf8"));
      if (cur?.pid === process.pid) unlinkSync(lockPath);
    } catch {
      // No lockfile / unreadable — nothing to clean up.
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Now that shutdown exists, route self-exit through it (clean teardown: stop
  // agents, drop the lockfile, close the bridge) so the freed port + bridge-death
  // let the pack respawn a clean orchestrator.
  runShutdown = () => {
    void shutdown();
  };

  // Beacon: when ComfyUI (the launcher) exits — cleanly or by crash/kill —
  // shut down rather than linger as an orphan holding the bridge port.
  startParentWatchdog(() => {
    logger.info("[panel-orchestrator] parent (ComfyUI) process exited — shutting down.");
    void shutdown();
  });

  // Keep the process alive; the bridge + agents drive everything from here.
  await new Promise<void>(() => {});
}
