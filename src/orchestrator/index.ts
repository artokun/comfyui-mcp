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
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import readline from "node:readline";
import { startUiBridge, isLoopbackBindHost, type UiBridge } from "../services/ui-bridge.js";
import { setupSecureBridge, type SecureBridge } from "../services/secure-bridge.js";
import { startQuickTunnel } from "../services/tunnel.js";
import { detectInstallMode } from "../services/self-update.js";
import { SessionStore } from "./session-store.js";
import { listSessions, loadTranscript } from "./history.js";
import { uploadImageHttp } from "../comfyui/client.js";
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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../tools/index.js";
import { isForceRemoteFlagSet, isLoopbackHost, detectLocalComfyUIPath } from "../config.js";
import {
  buildComfyuiMcpEnv,
  comfyuiSecretKeys,
  onComfyuiSecretsChanged,
  hydrateAgentSecretsIntoEnv,
  onAgentSecretsChanged,
  setAgentSecret,
  setComfyuiSecret,
  isAllowedComfyuiSecretKey,
} from "../services/panel-secrets.js";
import { CodexBackend } from "./codex-backend.js";
import { GeminiBackend, GEMINI_DEFAULT_MODEL } from "./gemini-backend.js";
import { GrokBackend, GROK_DEFAULT_MODEL } from "./grok-backend.js";
import { OllamaBackend, OLLAMA_SYSTEM_PROMPT } from "./ollama-backend.js";
import { ChatGptOAuthBackend, CHATGPT_DEFAULT_MODEL } from "./chatgpt-oauth-backend.js";
import { GlmBackend, GLM_DEFAULT_MODEL } from "./glm-backend.js";
import { KimiBackend, KIMI_DEFAULT_MODEL } from "./kimi-backend.js";
import { CopilotBackend, COPILOT_DEFAULT_MODEL } from "./copilot-backend.js";
import { SYSTEM as MODEL_CARD_SYSTEM } from "./ai-proposer.js";
import { resolvePrompt, registerPrompt, onPromptsChanged } from "../services/prompt-overrides.js";
import { allBackendReadiness } from "./backend-readiness.js";
import { handleOAuthBegin, handleOAuthStatus, handleOAuthSignout } from "./oauth-bridge.js";
import { OAUTH_PROVIDERS } from "../services/oauth-flow.js";
import { startPanelMcpHttpServer, type PanelMcpHttpServer } from "./panel-mcp-http.js";
import { startPanelConsoleHttpServer, type PanelConsoleHttpServer } from "./panel-console-http.js";
import type { AgentBackend } from "./agent-backend.js";
import { readComfyuiCrashLog, formatCrashNote } from "../services/crash-log.js";
import { QueueMonitor, type StallReport } from "../services/queue-monitor.js";
import { unloadAllOllama, warmOllama, resolveOllamaHost } from "../services/ollama-vram.js";
import {
  isLocalLmstudio,
  startLmstudioServer,
  unloadAllLmstudio,
  warmLmstudio,
} from "../services/lmstudio-lifecycle.js";
import { llamacppProps, llamacppToolsReady } from "../services/llamacpp-probe.js";
import { getAgentSettings, setAgentSettings } from "../services/panel-settings.js";
import {
  gatherEnvCapabilities,
  buildPanelSystemAppend,
  type EnvCapabilities,
} from "../services/env-capabilities.js";
import { WorkflowTargetStore } from "../services/workflow-target-store.js";

const PANEL_SYSTEM_APPEND = `You are the autonomous assistant embedded directly in a ComfyUI sidebar panel. The person is working in ComfyUI and talks to you through that panel: their messages arrive as your prompts, and everything you write is shown to them in the panel chat. Write for that reader — lead with the result, keep replies short and concrete, and don't narrate routine internal steps.

You can SEE and EDIT the workflow the user currently has open, via the panel_* tools (panel_graph_outline, panel_query_graph, panel_add_node, panel_connect, panel_set_widget, panel_run, panel_get_errors, panel_save_workflow, …). STRONGLY PREFER building on their live canvas: read it first (panel_graph_outline, then panel_query_graph for specifics), add/wire/configure nodes with the panel_* tools, then panel_run to queue it — so the user watches the work happen and the result loads in their own workflow with full Ctrl+Z undo. Only fall back to the headless generate_image/enqueue_workflow tools when the user explicitly wants a one-off they don't need on their canvas, or when no panel tab is connected (a panel_* call will error if so). On a LARGE graph (a loaded pack/template with dozens of nodes), do NOT dump the whole thing and scan it — and NEVER shell out to grep/jq/python over a saved workflow file. To UNDERSTAND the graph, call panel_graph_outline FIRST: a compact, dependency-ordered TEXT map (nodes topologically sorted source→sink, each with its key widgets and ← inputs / → outputs wiring, plus a groups index) made for you to read top-to-bottom. To PINPOINT and INSPECT specific nodes, use panel_query_graph: filter by types/title/widget predicates ('cfg>7'), traverse upstream_of/downstream_of a node, aggregate with group_by:'type', and read ONE node's exact slot/widget detail with {ids:[id], fields:'detail'} — output is token-bounded so it can never flood your context. panel_find_nodes remains for free-text search across all fields.

PROMPT DIRECTOR AWARENESS. When the graph contains PromptDirector, PromptDirectorAuto, PromptDirectorContext, PromptProducer, or PromptDirectorResultCritic nodes, call panel_audit_prompt_director before declaring that the prompt/model/LoRA setup is correct or diagnosing a failed edit. The audit correlates live wiring and loader widgets with the nodes' resolved Model Explorer metadata, edit plan, LoRA compatibility/strengths, exact final prompt, warnings, and critic verdict. Surface concise, useful observations proactively (including when the configuration is coherent). Its recommendations are READ-ONLY proposals: ask before applying panel_set_widget/panel_connect changes unless the user already explicitly asked you to fix the workflow.

TRUST REPORTED MANUAL CHANGES. The user can edit the canvas BY HAND between your turns (bypass/mute a node, change a widget, rewire, add/remove nodes). When that happens, your turn opens with a "⟳ MANUAL CANVAS CHANGES since your last turn" block listing exactly what they changed. Treat that block as GROUND TRUTH about the current graph — it overrides what you remember from earlier in the conversation. Do NOT assume the graph still matches your last edit or your earlier reading; if the listed changes are substantial (or contradict a plan you were mid-execution on), re-read with panel_graph_outline before you act or draw conclusions. This is also how you learn the user already tried something (e.g. they bypassed a node and it worked) — believe it over your own prior reasoning.

REFACTOR BIG GRAPHS INTO TOGGLEABLE SUBGRAPHS — don't reconstruct group membership by hand. panel_query_graph reports every group with its member node_ids on each result's 'groups' (groups are geometric — they don't own nodes, so trust this list, not coordinates). To make a region readable and switchable as a UNIT (e.g. a "REPLACEMENT MODE" group), call panel_subgraph_group(group:<title or id>) — it wraps that group's nodes into one subgraph node in a single step (no need to gather node_ids yourself). Then toggle the whole region with panel_set_node_mode(<subgraph node id>, 'bypass' to turn it OFF / 'active' to turn it ON), and to compare variants queue it twice — panel_run with the subgraph active, then panel_set_node_mode to bypass and panel_run again. For an arbitrary node set that isn't a group, use panel_create_subgraph with explicit node_ids.

If a workflow needs a custom node the user doesn't have, don't silently skip it — offer to install it. Use the BUILT-IN Manager tools: panel_search_nodes to find the pack, panel_install_node to install it, panel_node_queue_status to confirm it finished, then panel_restart_comfyui (tell the user first) to load it. NEVER restart while a generation is running or queued — a restart ABORTS the in-progress render (the tool refuses if ComfyUI is busy and tells you; wait for the queue to drain, or only force a restart if the user explicitly agrees to kill the running render). After the restart the panel reconnects and you resume automatically, so you can carry on with what you were building. Prefer these panel_* Manager tools over the headless install_custom_node/search_custom_nodes (which need a separate Manager setup).

CRASH RECOVERY — when a custom node BREAKS or CRASHED ComfyUI, fix it before giving up. If your turn begins with a "⚠️ ComfyUI crashed …" note (it names the fatal log block and the most likely culprit custom node + file:line), or a run dies with a node-level error you can pin to one pack, do NOT just re-run the same graph — ESCALATE to actually fix that node, narrating each step to the user as you go: (a) UPDATE it to the latest code — call panel_update_node with the culprit's id (or the comfyui MCP update_custom_node / fix_custom_node). Try version 'nightly' to grab a just-landed upstream fix. Poll panel_node_queue_status, then panel_restart_comfyui → you resume and RETRY the action to see if the crash is gone. (b) If updating doesn't fix it, reach into COMFYUI_PATH/custom_nodes/<NodeDir> with your shell (Bash): if it's a git repo (a .git dir), run git fetch && git pull (or check out the nightly branch) to force the latest, reinstall its requirements if needed, then restart + retry. (c) If there's no git or it's still broken, attempt a TARGETED source patch of the crashing file:line, then VERIFY the fix actually resolves the crash (restart + retry the same action — confirm it no longer faults). Once verified, OFFER to suggest the fix upstream to the repo owner (open an issue or PR describing the crash + your patch) — describe it and ask the user first; do NOT auto-file anything. Combine this cleanly with the normal install→restart→continue flow above: a fresh install that crashes on first use is the same loop (update/patch the just-installed node, don't abandon it).

WEDGED RENDER / OOM / VRAM PINNED — when a generation is stuck or hits CUDA out-of-memory, or a cancel didn't actually free GPU memory (models still resident, VRAM pinned, the next run still OOMs), call panel_free_vram to UNLOAD all models and free VRAM before retrying — it does NOT restart ComfyUI, so it's the cheap first move. Escalation ladder: cancel the run → panel_free_vram (unload + free) → retry; only as a LAST RESORT panel_restart_comfyui (which refuses mid-render and guards the running generation). Reach for panel_free_vram before a restart whenever a cancel left memory pinned.

WORKFLOW TARGETING — by default your panel_* graph edits follow whichever workflow tab the user is currently viewing. If the user wants you to work on a DIFFERENT open workflow while they browse another tab, call panel_set_workflow_target(mode:"pinned", path:<from panel_list_workflows>) to pin edits to that workflow; panel_get_workflow_target shows the current binding. Set mode:"current" to follow the user's active tab again. Pinning does NOT switch what the user sees — it only routes your graph tools. When pinned, still use panel_open_workflow only when you intentionally want to switch the user's view.

CRITICAL — never destroy the user's work. When they ask for a "new workflow", a "fresh canvas", or to "start over for a new project", call panel_new_workflow (it opens a NEW TAB and leaves their current workflow intact). NEVER use panel_clear for that — panel_clear wipes the CURRENTLY OPEN graph and is ONLY for an explicit "clear/reset this canvas". You can manage tabs with panel_list_workflows / panel_open_workflow / panel_rename_workflow / panel_close_workflow, and group nodes with panel_select_nodes / panel_create_subgraph. To label a node by its purpose, use panel_set_node_title. To read or edit nodes INSIDE a subgraph, call panel_enter_subgraph(node_id) first — then panel_query_graph / panel_graph_outline and the panel_* edit tools operate on the subgraph's inner nodes — and panel_exit_subgraph when you're done.

SUBGRAPH I/O — exposing interior nodes to the boundary. To wire an interior node to the subgraph's boundary from INSIDE a subgraph, do NOT panel_connect to a guessed rail node id — that's the rail and you'll get it wrong. Use panel_expose_subgraph_output(from_node_id, from_output) to expose an interior OUTPUT on the output rail (so the parent graph can wire the subgraph node's new output), and panel_expose_subgraph_input(to_node_id, to_input) to expose an interior INPUT on the input rail. Read panel_query_graph's \`rails\` field (present when viewing a subgraph) to see the current boundary slots — what's already exposed and what still needs it. To EXPAND/DISSOLVE a subgraph back into the parent graph (inline its inner nodes and rewire external links, removing the wrapper — the inverse of panel_create_subgraph), use panel_unpack_subgraph(node_id). All three are undoable with Ctrl+Z.

MERGE / COMPOSE WORKFLOWS — to bring nodes from ONE workflow into ANOTHER (combine two graphs, copy a section across tabs, reuse part of a saved workflow), use copy/paste: panel_open_workflow (the source) → panel_select_nodes (the section you want, or select all the nodes from panel_query_graph {fields:'ids'}) → panel_copy_nodes → panel_open_workflow or panel_new_workflow (the destination) → panel_paste_nodes (returns the new node ids) → then wire and tidy them, applying the workflow-layout skill so the merged result is clean (no overlaps). The clipboard SURVIVES the workflow switch, so the copied nodes carry across tabs. Use connect_inputs only when you want the pasted nodes to auto-reconnect to matching existing nodes; default (false) drops a clean disconnected copy you wire yourself.

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

INSPECT NODE MODES BEFORE YOU RUN. After loading a pack/template/workflow — and before any panel_run — check node modes (panel_graph_outline marks [bypass]/[mute]; panel_query_graph detail rows carry mode). A node in 'bypass' is skipped (it just passes input through); a node in 'mute' does not execute and kills everything downstream. Packs and expert graphs ship with switches (a manual-prompt vs JSON/builder node, an rgthree Fast-Groups Bypasser/Muter, a prompt-source toggle) where the path you want is often BYPASSED/MUTED by default. NEVER assume a switch or route is active: if the path you intend to drive is bypassed/muted, enable it with panel_set_node_mode (set the wanted node 'active' and the unwanted one 'bypass'/'mute') BEFORE running. A wrong/stale mode is a top cause of renders that come out wrong.

VERIFY THE OUTPUT MATCHES THE REQUEST. After a render completes, actually LOOK at the image/video the panel delivers and confirm it matches what was asked BEFORE you declare success or move to the next step. If it doesn't match, do NOT report progress — diagnose (wrong prompt path? a bypassed/muted builder or switch? wrong widget value?), fix it (often panel_set_node_mode or panel_set_widget), and rerun. Only claim something works once you've SEEN that it does — never report progress you haven't verified.

AFTER PANEL_RUN — once you call panel_run to queue a render, you will be notified automatically with the output image(s)/video when it finishes. Do not poll get_queue, get_history, or list_output_images waiting for the result — just end your turn and the finished render will be delivered to you.

DEBUG WRONG RENDERS BY INSPECTING INTERMEDIATE STEPS (run-to-node). When a final asset comes out WRONG — artifacts, wrong subject/pose/composition/color, blur, a ControlNet/IPAdapter/mask/LoRA not taking, a refiner or upscale stage degrading it — do NOT just re-roll the whole graph. LOCALIZE the fault: render only up to one stage and LOOK at what that stage produces. panel_run takes to_node_id to run ONE output branch (ComfyUI partial execution) — only that output node plus everything upstream of it renders, the rest is skipped, so it's fast and cheap, and the result is delivered to you automatically like any run. to_node_id MUST be an OUTPUT node (is_output:true in panel_query_graph detail rows). To inspect a point that ISN'T an output — a latent, a preprocessor/depth/pose map, a mask, an intermediate image — TAP it: add a PreviewImage on an IMAGE wire (or VAEDecode→PreviewImage on a LATENT, MaskToImage→PreviewImage on a MASK), panel_run(to_node_id=that preview), read the delivered image, then panel_remove_node the tap when done. Bisect upstream→downstream until you find the FIRST stage whose output is bad — that node (or its inputs/widgets) is what to fix, then run-to-node there again to confirm before a full run. For the full method (probe recipes, symptom→probe map) read the debug-render skill via read_skill. This is for renders that COMPLETE but look wrong; for runs that fail with an error/OOM/missing node, use the troubleshooting skill instead.

CHAIN A STAGE'S OUTPUT INTO THE NEXT STAGE'S LOADER — when a multi-stage pipeline (e.g. Krea2 image → LTX video → WAN extend) needs one stage's OUTPUT fed into the next stage's loader (LoadImage / VHS_LoadVideo / LoadAudio), call stage_output_as_input with the output's { filename, subfolder?, type? } and drop the returned input filename into the loader's image/video/audio widget. (Or, for a file already on disk, upload_image / upload_video / upload_audio.) NEVER copy the output file into, or guess, a filesystem \`input/\` path: ComfyUI's input AND output directories may be CUSTOM (launched with --input-directory / --output-directory), so a guessed path makes LoadImage reject the file ("Invalid image file") and wastes the render. stage_output_as_input goes through the server API (/view → /upload/image), which resolves the real dirs correctly every time. VERIFY A VIDEO RENDER VIA THE FILESYSTEM, NOT /history — VHS_VideoCombine and similar video nodes write the .mp4 but frequently do NOT register an output in ComfyUI's /history (the prompt shows done with no output and no error), so do NOT conclude a clip "silently dropped" from get_history/get_job_status; confirm it with list_output_images (which now lists videos, each tagged kind:"video") by filename/prefix + fresh mtime, then chain it forward with stage_output_as_input.

BYPASS COMPLETED STAGES BEFORE QUEUING THE NEXT ONE. When you build a multi-stage pipeline on one canvas (e.g. Krea2 → LTX → WAN), once a stage has RUN and you've captured/staged its output, BYPASS that stage's nodes with panel_set_node_mode(mode:"bypass") BEFORE you queue the next stage — so panel_run doesn't re-execute (and make the user pay for / wait on) work that's already done. Re-running the whole graph because an earlier stage was left active is a real, costly failure mode: explicitly bypass each finished stage and keep only the ACTIVE stage live. (This complements stage_output_as_input, which feeds the prior stage's output forward into the next stage's loader — bypass the producer, feed its captured output to the consumer.)

## Interactive UI cards
When the user must choose between options, confirm a plan, fill in parameters, or would grasp a wiring explanation faster as a diagram, render a CARD instead of a wall of text: call panel_ui_render with an A2UI-subset spec (choice Buttons; forms from TextField/Select/Checkbox plus one submit Button; 'comfy:graph' for node-wiring diagrams — give nodes and edges, the panel draws it; 'comfy:chart' for bar/line comparisons). After rendering a card that asks a question, END YOUR TURN — the user's click arrives as their next chat message. Use panel_ui_update(card_id, spec) to update a live card in place (progress, revised options). Set surface:"wide" only for diagram-heavy cards. Keep cards small: one decision per card, ≤5 buttons, plain language labels.
If you do NOT have panel_ui_render (no panel tools), you may emit the same JSON spec in a fenced block instead:
\`\`\`a2ui
{ "root": "c", "components": [ ... ] }
\`\`\`
Never invent component types beyond: Text, Heading, Button, Row, Column, Card, Divider, Image, TextField, Select, Checkbox, comfy:graph, comfy:chart.`;

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

/** HEADLESS clients (the mobile / remote pseudo-panel) connect with NO ComfyUI
 *  browser panel. Two consequences: the live-canvas panel_* tools can't run, AND
 *  — critically — nothing observes a render finishing to auto-deliver its output
 *  back to the agent (that path is browser-driven; see the `agent_event` handler).
 *  generate_image / enqueue_workflow return a prompt_id immediately, so a headless
 *  agent that "ends its turn and waits" never surfaces the image. This directive,
 *  prepended to each headless-tab turn like the crash/queue notes, tells it to run
 *  headless and deliver the result ITSELF, in-turn. */
const HEADLESS_DIRECTIVE =
  "[HEADLESS SESSION — no ComfyUI panel/canvas is connected] The panel_* live-canvas tools " +
  "(panel_run, panel_query_graph, panel_set_widget, panel_add_node, …) are UNAVAILABLE here and will fail — " +
  "do everything through the comfyui MCP tools (generate_image, or create_workflow + enqueue_workflow). " +
  "There is NO panel to auto-deliver a finished render, so you MUST deliver the result YOURSELF IN THIS SAME TURN: " +
  "enqueuing returns a prompt_id immediately, so wait for it with get_job_status(prompt_id) — poll it briefly until " +
  "it reports completion (this is the ONE case where polling IS correct) — then fetch the output with get_history and " +
  "show it with panel_show_media. Do NOT end your turn expecting an automatic notification; none will arrive.";

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

interface OrchestratorLock {
  pid?: unknown;
  startedAt?: unknown;
  version?: unknown;
  comfyuiUrl?: unknown;
}

/**
 * Kill a process AND ITS TREE. A bare signal to the holder's pid leaves its
 * children (cloudflared tunnel, spawned agent MCP subprocesses) alive — the
 * field report "it doesn't fully terminate" (2026-07-08): Ctrl+C/kill of the
 * node process orphaned cloudflared, and stale children kept state around.
 * Windows: taskkill /T /F (tree + force). POSIX: best-effort children sweep
 * (pkill -P) around the usual TERM → KILL escalation.
 */
function killProcessTreeCrossPlatform(pid: number, mode: "term" | "kill"): void {
  if (process.platform === "win32") {
    // No graceful tree-signal exists on Windows; /T /F is the reliable path.
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  const sig = mode === "term" ? "SIGTERM" : "SIGKILL";
  try {
    execFileSync("pkill", [`-${sig.replace("SIG", "")}`, "-P", String(pid)], { stdio: "ignore" });
  } catch {
    // no children / pkill absent — the direct signal below still applies
  }
  process.kill(pid, sig);
}

/** Copy-paste "free this port" commands — LAST RESORT only (non-interactive
 *  shells where we cannot prompt, or a kill that failed): the interactive path
 *  resolves the owner from the port and kills it itself after consent. */
function portKillHint(port: number): string {
  const ps = `Get-NetTCPConnection -LocalPort ${port} -State Listen | % { taskkill /PID $_.OwningProcess /T /F }`;
  const sh = `lsof -ti tcp:${port} -s tcp:listen | xargs -r kill -9`;
  return process.platform === "win32"
    ? `To free the port manually:\n  PowerShell:  ${ps}\n  bash/zsh:    ${sh}`
    : `To free the port manually:\n  bash/zsh:    ${sh}\n  PowerShell:  ${ps}`;
}

/** Resolve which pid is LISTENING on a local TCP port (null if none/unknown). */
function pidListeningOnPort(port: number): number | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[1]) === port) return Number(m[2]);
      }
      return null;
    }
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-s", "tcp:LISTEN"], {
      encoding: "utf8",
    });
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Best-effort executable name for a pid ("unknown" when unreadable). */
function processNameOf(pid: number): string {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
      });
      return /^"([^"]+)"/m.exec(out)?.[1] ?? "unknown";
    }
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim() ||
      "unknown"
    );
  } catch {
    return "unknown";
  }
}

/** Can the target ComfyUI answer /system_stats within timeoutMs? */
async function probeComfyUi(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(new URL("system_stats", url.endsWith("/") ? url : `${url}/`), {
      signal: ctl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function readOrchestratorLock(lockPath: string): OrchestratorLock | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as OrchestratorLock) : null;
  } catch {
    return null; // missing / unreadable / not JSON — nothing to reclaim from.
  }
}

/** A single y/n question on the real terminal. Resolves false on anything but
 *  an explicit y/yes (a closed stdin, EOF, or a stray keypress all count as no). */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * The bridge port is almost always held by a PREVIOUS comfyui-mcp orchestrator
 * that never exited — a stale panel session, one orphaned by a ComfyUI crash,
 * or simply an older version still running while the user upgraded — not some
 * unrelated process. Rather than leave the user to go hunt down and kill a PID
 * themselves (the old behavior: log a warning and stay degraded), read the
 * lockfile the holder wrote at its own startup (see below) and, ONLY when
 * stdin is a real terminal — `--panel-orchestrator` / `connect` run standalone
 * in the user's own shell and are mutually exclusive with the stdio MCP server,
 * so stdin is never claimed by the MCP JSON-RPC protocol here — interactively
 * offer to stop it and retry the bind.
 *
 * Returns false (falls back to the existing hard-fail message) whenever it
 * can't confidently identify a reclaimable holder, isn't running
 * interactively, or the user declines.
 */
async function tryReclaimBridgePort(
  bridge: UiBridge,
  port: number,
  lockPath: string,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const lock = readOrchestratorLock(lockPath);
  const lockPid =
    typeof lock?.pid === "number" && Number.isInteger(lock.pid) && lock.pid > 0 && pidExists(lock.pid)
      ? lock.pid
      : null;
  // The lockfile can be stale/missing while SOMETHING still owns the port (a
  // crashed session's orphaned child, an unrelated app). Resolve the actual
  // listener from the port so a single consent can clear EVERYTHING.
  const portPid = pidListeningOnPort(port);
  const pid = lockPid ?? portPid;
  if (!pid) return false;

  const myUrl = process.env.COMFYUI_URL || "http://127.0.0.1:8188";
  let holderNote: string;
  let detailNote = "";
  if (lockPid) {
    const myVersion = detectInstallMode().currentVersion ?? "unknown";
    const heldVersion = typeof lock?.version === "string" ? lock.version : "unknown";
    const startedAt = typeof lock?.startedAt === "string" ? lock.startedAt : null;
    holderNote =
      heldVersion !== "unknown" && myVersion !== "unknown" && heldVersion !== myVersion
        ? `an older comfyui-mcp v${heldVersion} (this is v${myVersion})`
        : `another comfyui-mcp v${heldVersion} session`;
    // Show WHICH ComfyUI each side is driving — the classic tangle is a stale
    // session recalled from shell history still "driving" a terminated pod
    // while the user tries to connect to the live one; without the URLs both
    // sessions look identical and the takeover choice is a coin flip.
    const heldUrl = typeof lock?.comfyuiUrl === "string" ? lock.comfyuiUrl : null;
    if (startedAt) detailNote += `, started ${startedAt}`;
    if (heldUrl) {
      const alive = await probeComfyUi(heldUrl);
      detailNote += `, driving ${heldUrl}${alive ? "" : " (NOT RESPONDING — likely a terminated pod / stale session)"}`;
    }
  } else {
    holderNote = `an unidentified process ("${processNameOf(pid)}" — no comfyui-mcp lockfile; likely an orphaned session or another app)`;
  }
  logger.warn(
    `[panel-orchestrator] port ${port} is already held by ${holderNote} — pid ${pid}${detailNote}.`,
  );
  const ok = await promptYesNo(
    `Stop it (and its whole process tree) and take over port ${port} for ${myUrl}? [y/N] `,
  );
  if (!ok) {
    logger.info(`[panel-orchestrator] leaving pid ${pid} alone.\n${portKillHint(port)}`);
    return false;
  }

  // One Y = full authority to clear the port: kill the lockfile's holder AND
  // whatever is actually listening (they can differ when the lockfile is
  // stale), whole trees, escalating to a hard kill for anything that survives.
  const targets = [...new Set([lockPid, portPid].filter((p): p is number => p != null))];
  logger.info(
    `[panel-orchestrator] stopping pid${targets.length > 1 ? "s" : ""} ${targets.join(", ")} (and their process trees) to reclaim port ${port}…`,
  );
  for (const t of targets) {
    try {
      killProcessTreeCrossPlatform(t, "term");
    } catch (err) {
      logger.warn(
        `[panel-orchestrator] couldn't stop pid ${t}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Give them a moment to release the port; escalate to a hard tree-kill for
  // survivors, sweep any NEW listener that appeared (a respawned child), then
  // retry the bind once (bridge.start() runs its own EADDRINUSE backoff,
  // covering the OS's brief port-release lag).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && targets.some((t) => pidExists(t))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const t of targets) {
    if (!pidExists(t)) continue;
    try {
      killProcessTreeCrossPlatform(t, "kill");
    } catch {
      // already gone
    }
  }
  const straggler = pidListeningOnPort(port);
  if (straggler && !targets.includes(straggler)) {
    logger.warn(`[panel-orchestrator] a new pid ${straggler} grabbed port ${port} — stopping it too.`);
    try {
      killProcessTreeCrossPlatform(straggler, "kill");
    } catch {
      // best-effort
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  bridge.start();
  return bridge.whenReady();
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
/** A non-loopback ComfyUI target served over https — the case where the pod's
 *  browser panel can't reach a plain ws:// loopback bridge (mixed-content / PNA)
 *  and we auto-upgrade to a token-gated wss:// over a cloudflared tunnel. */
function isRemoteHttpsUrl(u: string): boolean {
  try {
    const url = new URL(u);
    const h = url.hostname.toLowerCase();
    const loopback =
      h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "";
    return !loopback && url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The direct tool channel: a mobile client can invoke these READ/DOWNLOAD backend
 *  tools without an agent turn (structured nav data + rig-side downloads). The
 *  bridge is already token-gated; this whitelist keeps call_tool to non-destructive
 *  tools (no restart/remove/clear/install). */
const CALL_TOOL_WHITELIST = new Set<string>([
  "list_workflows",
  "get_workflow",
  "analyze_workflow",
  "query_workflow",
  "workflow_from_image",
  "list_output_images",
  "get_image",
  "list_local_models",
  "download_civitai_model",
  "download_model",
  "enqueue_workflow",
  // Persist a workflow to the ComfyUI library (mobile "pull workflow from a
  // CivitAI example" → save_workflow). Writes a workflow file (auto-converts
  // API-format graphs to canvas-openable UI format); overwrites same-filename,
  // so the client generates a unique name. No model/system mutation.
  "save_workflow",
]);

/** Lazily build ONE in-process MCP client wired to the full comfyui tool surface,
 *  reused across call_tool requests. Reuses the exact tool implementations (same
 *  getClient()/COMFYUI_URL as the agents) — no logic duplication. */
let callToolClientPromise: Promise<Client> | null = null;
function getCallToolClient(): Promise<Client> {
  if (!callToolClientPromise) {
    callToolClientPromise = (async () => {
      const server = new McpServer({ name: "comfyui-mcp-calltool", version: "1.0.0" });
      await registerAllTools(server);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "orchestrator-calltool", version: "1.0.0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      logger.info("[panel-orchestrator] call_tool in-process MCP client ready");
      return client;
    })().catch((err) => {
      callToolClientPromise = null; // allow retry on next call
      throw err;
    });
  }
  return callToolClientPromise;
}

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

  // The phone-reachable LAN IPv4 for the pairing URL. Naively taking the FIRST
  // non-internal IPv4 breaks on machines with a VPN (NordLynx/Tailscale/…) or a
  // virtual adapter (WSL/Hyper-V/VMware/Docker) enumerated first — the phone
  // can't reach 10.5.0.2 (a VPN tunnel) or 172.x (a WSL switch). Score candidates
  // so a real Wi-Fi/Ethernet 192.168.x address wins and virtual/VPN NICs lose.
  const firstLanIPv4 = (): string | undefined => {
    const cands: Array<{ name: string; addr: string }> = [];
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (!a.internal && a.family === "IPv4") cands.push({ name, addr: a.address });
      }
    }
    if (cands.length === 0) return undefined;
    const isVirtual = (n: string) =>
      /vethernet|hyper-v|\bwsl\b|virtualbox|vmware|\bvmnet\b|docker|nordlynx|tailscale|zerotier|\btun\d*\b|\btap\b|utun|radmin|hamachi|loopback/i.test(
        n,
      );
    const score = (c: { name: string; addr: string }): number => {
      let s = 0;
      if (isVirtual(c.name)) s -= 100;
      if (/wi-?fi|wlan|wireless|ethernet|en0|eth\d/i.test(c.name)) s += 20;
      if (c.addr.startsWith("192.168.")) s += 30;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(c.addr)) s += 10;
      else if (c.addr.startsWith("10.")) s += 5;
      return s;
    };
    cands.sort((a, b) => score(b) - score(a));
    return cands[0].addr;
  };

  // Secure bridge: when driving a REMOTE https ComfyUI (a pod), the pod's HTTPS
  // panel page can't reach a plain ws:// loopback bridge (mixed-content / Private
  // Network Access), so auto-upgrade to a token-gated wss:// exposed via a
  // cloudflared tunnel and advertise it to the pod. Local targets keep the plain
  // loopback ws:// bridge. --insecure-bridge (COMFYUI_MCP_INSECURE_BRIDGE) forces plain.
  const insecureBridge =
    process.env.COMFYUI_MCP_INSECURE_BRIDGE === "1" ||
    process.env.COMFYUI_MCP_INSECURE_BRIDGE === "true";
  const wantSecureBridge = !insecureBridge && isRemoteHttpsUrl(process.env.COMFYUI_URL ?? "");

  // LAN bridge (panel #54 — the 24/7 server / standalone OpenClaw topology):
  // COMFYUI_MCP_BRIDGE_HOST binds the bridge on a non-loopback interface so
  // browsers on OTHER machines can connect. Non-loopback ALWAYS token-gates the
  // WS upgrade — the token comes from COMFYUI_MCP_BRIDGE_TOKEN (pin it for
  // stable reconnects across restarts) or is generated fresh and printed below.
  const bridgeHost = (process.env.COMFYUI_MCP_BRIDGE_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const lanBridge = !isLoopbackBindHost(bridgeHost);
  const envBridgeToken = process.env.COMFYUI_MCP_BRIDGE_TOKEN?.trim() || null;
  const bridgeToken =
    envBridgeToken ?? (wantSecureBridge || lanBridge ? randomBytes(24).toString("hex") : null);

  // Dedicated PANEL bridge port (default 9180). Token-gated in secure/LAN mode.
  const lockPort = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180;
  const lockPath = orchLockPath(lockPort);
  const bridge = startUiBridge(lockPort, bridgeToken, bridgeHost);

  // On-demand phone pairing (the panel "Remote control" button). Off by default:
  // the FIRST pair request lazily binds a SECOND, token-gated listener on all
  // interfaces (so a phone can reach it), while the primary loopback bridge stays
  // token-less. LAN mode returns a same-wifi ws:// URL; tunnel mode fronts the same
  // token-gated listener with a cloudflared wss:// for anywhere access.
  const pairPort = lockPort + 2; // avoid the panel_* HTTP-MCP port (lockPort + 1)
  let pairToken: string | null = null;
  let pairListenerStarted = false;
  let pairTunnel: { url: string; stop: () => void } | null = null;
  const ensurePairListener = async (): Promise<string> => {
    if (!pairToken) pairToken = randomBytes(24).toString("hex");
    if (!pairListenerStarted) {
      await bridge.addListener("0.0.0.0", pairPort, pairToken);
      pairListenerStarted = true;
    }
    return pairToken;
  };

  if (lanBridge) {
    // Ready-to-paste connection info: the panel's Settings → Advanced →
    // Bridge URL takes the full URL incl. ?token= verbatim.
    const displayHost =
      bridgeHost === "0.0.0.0" || bridgeHost === "::"
        ? (firstLanIPv4() ?? "<this-machine-ip>")
        : bridgeHost;
    process.stderr.write(
      [
        "",
        "════════════════════════════════════════════════════════════════════",
        " ComfyUI MCP — panel bridge exposed on the LAN (token-gated)",
        "════════════════════════════════════════════════════════════════════",
        ` Bridge URL : ws://${displayHost}:${lockPort}/?token=${bridgeToken}`,
        "",
        " In the panel: Settings → Advanced → Bridge URL → paste the URL above,",
        " then click Connect. Anyone with this URL can drive the agent — treat",
        " it like a password.",
        envBridgeToken
          ? " Token source: COMFYUI_MCP_BRIDGE_TOKEN (stable across restarts)."
          : " Token was GENERATED for this run — set COMFYUI_MCP_BRIDGE_TOKEN to keep the same URL across restarts.",
        "════════════════════════════════════════════════════════════════════",
        "",
      ].join("\n") + "\n",
    );
  }

  // Owning the bridge port is the orchestrator's whole job — if another process
  // holds it, fail loudly instead of running uselessly. (This also avoids the
  // case where a failed bind leaves the process with no live handles and it
  // exits silently.) First try to reclaim it interactively (see
  // tryReclaimBridgePort) — almost always a stale/older comfyui-mcp session,
  // not some unrelated process — before giving up.
  let bound = await bridge.whenReady();
  if (!bound) bound = await tryReclaimBridgePort(bridge, lockPort, lockPath);
  if (!bound) {
    logger.error(
      `[panel-orchestrator] could not bind the panel bridge port — another process owns it. Free that port and restart the orchestrator. Override the port with COMFYUI_MCP_BRIDGE_PORT.\n${portKillHint(lockPort)}`,
    );
    process.exit(1);
  }

  // We own the port — register our REAL pid + the launching ComfyUI pid so the
  // panel pack can detect and replace us if we're ever orphaned across a Comfy
  // restart. Written only after a successful bind (so the file always names the
  // process that actually holds the port).
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
        // npm package version — read by a NEXT orchestrator's tryReclaimBridgePort
        // to tell the user whose/which version currently holds the port.
        version: detectInstallMode().currentVersion ?? null,
        // The ComfyUI this session drives — shown by a NEXT orchestrator's
        // takeover prompt so a stale session (dead pod URL from shell history)
        // identifies itself instead of looking like a twin.
        comfyuiUrl: process.env.COMFYUI_URL || null,
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
  // Dead-target guard: a `connect` aimed at a TERMINATED pod (an old URL
  // recalled from shell history) otherwise looks perfectly alive — bridge up,
  // tunnel up — while its advertise goes to a dead host, so the panel never
  // receives this session's token and spams "missing/invalid token". Name the
  // real problem up front. Warn-only and fire-and-forget: the target may
  // legitimately still be booting, and a panel `hello` can retarget us later.
  void (async () => {
    const target = comfyuiUrl;
    if (await probeComfyUi(target, 6000)) return;
    logger.warn(
      `[panel-orchestrator] the target ComfyUI at ${target} is NOT responding. ` +
        `If it is a pod that is still starting, this resolves itself — but if the pod was ` +
        `TERMINATED, this is a stale URL (shell history?) and the panel will never be able to ` +
        `connect to this session (it shows up as 'missing/invalid token' rejections). ` +
        `Double-check the pod id in the URL and re-run connect with the current one.`,
    );
  })();
  // ComfyUI install path — when set AND the target is loopback, the spawned agent's
  // MCP runs in LOCAL mode (download_model / apply_manifest / installer-pack /
  // model-scan tools). A REMOTE target (non-loopback) forces remote-only, so we
  // drop the path. `envComfyuiPath` is the orchestrator's own env value; the live
  // `comfyuiPath` is derived from it + the current target.
  // env > auto-detected. The detection (Desktop-recorded installs first, then
  // common directories) is the same one the headless MCP's config uses — the
  // orchestrator previously read ONLY the env var, so a Desktop user without
  // COMFYUI_PATH always landed in "local install/pack tools limited" even with
  // a local install the MCP itself could find.
  const envComfyuiPath = process.env.COMFYUI_PATH;
  // `||` not `??`: a set-but-empty COMFYUI_PATH= means "unset" (the headless
  // MCP's config truthy-checks it the same way) — it must not block detection.
  const localComfyuiPath = envComfyuiPath || detectLocalComfyUIPath();
  const isLoopbackUrl = (u: string): boolean => {
    try {
      return isLoopbackHost(new URL(u).hostname);
    } catch {
      return true;
    }
  };
  // --force-remote drops the local path too: a loopback URL that is really a
  // port-forward to a pod (e.g. RunPod/dstack) must not hand spawned agents a
  // local install — the spawn env builders prefer COMFYUI_PATH over the
  // force-remote flag, so a leaked path would silently defeat --force-remote.
  const localPathForTarget = (url: string): string | undefined =>
    !isForceRemoteFlagSet() && isLoopbackUrl(url) ? localComfyuiPath : undefined;
  let comfyuiPath = localPathForTarget(comfyuiUrl);
  // Force the child remote only when opted in (--force-remote) or the target is
  // non-loopback; a default loopback panel user with no COMFYUI_PATH is left to
  // auto-detect its local install (keeps download_model/apply_manifest/scans).
  const forceRemoteEnv = (): Record<string, string> =>
    isForceRemoteFlagSet() || !isLoopbackUrl(comfyuiUrl)
      ? { COMFYUI_MCP_FORCE_REMOTE: "1" }
      : {};
  const model = process.env.COMFYUI_MCP_PANEL_MODEL ?? "claude-opus-4-8";
  const envEffort = process.env.COMFYUI_MCP_PANEL_EFFORT;
  const effort: Effort | undefined = isEffort(envEffort) ? envEffort : undefined;
  // Each backend runs its OWN orchestrator on its OWN loopback bridge port so the
  // providers never share a session or fight for a port. The launcher (panel pack)
  // sets COMFYUI_MCP_BRIDGE_PORT per the selected backend; the convention is
  // 9180 = claude (default), 9181 = codex, 9182 = gemini.
  const bridgePort = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180;

  // Open the cloudflared tunnel and advertise the wss URL to the pod so its
  // browser panel connects automatically — the user never copies a URL. Best
  // effort: on failure the (token-gated) bridge stays up and we log an actionable
  // fix. Held for re-advertise on retarget + teardown on shutdown.
  let secureBridge: SecureBridge | null = null;
  if (wantSecureBridge && bridgeToken) {
    try {
      secureBridge = await setupSecureBridge({ bridgePort, comfyuiUrl, token: bridgeToken, bridge });
    } catch (err) {
      logger.error(
        `[panel-orchestrator] secure bridge (cloudflared) failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Install cloudflared (npm i -g cloudflared), or re-run with --insecure-bridge and open the pod through an ` +
          `SSH tunnel (ssh -L 3000:localhost:3000 …) at http://localhost:3000.`,
      );
    }
  }

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
  const grokModel = process.env.COMFYUI_MCP_GROK_MODEL ?? GROK_DEFAULT_MODEL;
  // Ollama (local LLMs, issue #97): the model is a local tag applied PER
  // REQUEST — switching live is free. Default = OUR FINE-TUNE,
  // artokun/gemma4-comfyui-mcp:e4b — gemma4 QLoRA-trained on 1055
  // server-verified comfyui-mcp trajectories over the full 178-tool surface
  // (hf.co/artokun/gemma4-comfyui-mcp), so it drives this exact tool suite
  // natively. Supersedes stock gemma4:e4b (the previous arena best, 9/10).
  // Ladder by VRAM at q4: :e2b ~2 GB / :e4b ~3.5 GB / :12b ~8 GB.
  //
  // Config precedence: env (escape hatch, always wins) → persisted user settings
  // (~/.comfyui-mcp/panel-settings.json, edited from the panel Settings dialog
  // via set_config) → built-in default. Mutable (`let`) because set_config can
  // retarget them live; API keys stay env-only and never touch the settings file.
  // Copy any panel-stored provider keys (OPENROUTER_API_KEY) into env BEFORE we
  // read them below, so a key set on a prior run enables its provider on boot.
  const hydratedSecrets = hydrateAgentSecretsIntoEnv();
  if (hydratedSecrets.length) {
    logger.info(`[panel-orchestrator] hydrated agent secrets from store: ${hydratedSecrets.join(", ")}`);
  }
  const persistedAgent = getAgentSettings();
  let ollamaModel =
    process.env.COMFYUI_MCP_OLLAMA_MODEL ?? persistedAgent.ollama?.model ?? "artokun/gemma4-comfyui-mcp:e4b";
  const chatgptModel = process.env.COMFYUI_MCP_CHATGPT_MODEL ?? CHATGPT_DEFAULT_MODEL;
  const glmModel = process.env.COMFYUI_MCP_GLM_MODEL ?? GLM_DEFAULT_MODEL;
  const kimiModel = process.env.COMFYUI_MCP_KIMI_MODEL ?? KIMI_DEFAULT_MODEL;
  // EXPERIMENTAL (ToS risk) — off by default, only reachable once the user has
  // signed in via the panel's experimental row (oauth-bridge.ts's
  // allow_experimental gate); never the defaultBackend/auto-pick.
  const copilotModel = process.env.COMFYUI_MCP_COPILOT_MODEL ?? COPILOT_DEFAULT_MODEL;
  // The same backend also speaks any OpenAI-compatible endpoint (OpenRouter,
  // DeepSeek, vLLM, LM Studio): COMFYUI_MCP_OLLAMA_API=openai +
  // COMFYUI_MCP_OLLAMA_BASE_URL (incl. /v1) + COMFYUI_MCP_OLLAMA_API_KEY
  // (falls back to OPENROUTER_API_KEY). The chip stays "Ollama (local)".
  let ollamaApi: "openai" | "ollama" =
    (process.env.COMFYUI_MCP_OLLAMA_API
      ? process.env.COMFYUI_MCP_OLLAMA_API === "openai"
      : persistedAgent.ollama?.api === "openai")
      ? "openai"
      : "ollama";
  let ollamaBaseUrl = process.env.COMFYUI_MCP_OLLAMA_BASE_URL ?? persistedAgent.ollama?.baseUrl;
  const ollamaApiKey = process.env.COMFYUI_MCP_OLLAMA_API_KEY || process.env.OPENROUTER_API_KEY;
  const ollamaDeps = () => ({
    api: ollamaApi,
    ...(ollamaBaseUrl ? { host: ollamaBaseUrl } : {}),
    ...(ollamaApi === "openai" && ollamaApiKey ? { apiKey: ollamaApiKey } : {}),
  });
  // OpenRouter is a first-class provider = the Ollama backend hard-wired to
  // OpenRouter's OpenAI-compatible endpoint, so its picker leads with the
  // curated arena-winning models (RECOMMENDED_OPENROUTER_MODELS, MiMo/MiniMax
  // tagged 1M · SOTA). Key comes from OPENROUTER_API_KEY (or the shared ollama
  // key). Default model = the arena's top open-weight, MiMo v2.5.
  const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
  let openrouterModel = process.env.COMFYUI_MCP_OPENROUTER_MODEL ?? "xiaomi/mimo-v2.5";
  // Read the key FRESH each call (not a startup const) so a key the user sets
  // later via the panel — setAgentSecret hydrates it into env — takes effect on
  // the next backend build without an orchestrator restart.
  const openrouterApiKey = () => process.env.OPENROUTER_API_KEY || process.env.COMFYUI_MCP_OLLAMA_API_KEY;
  const openrouterDeps = () => {
    const key = openrouterApiKey();
    return {
      api: "openai" as const,
      host: OPENROUTER_BASE_URL,
      ...(key ? { apiKey: key } : {}),
    };
  };
  // LM Studio (issue #160) = the same openai dialect pinned to LM Studio's
  // local server. No API key, no login. Default model is EMPTY on purpose —
  // LM Studio model ids are user-specific, so ensureModels() below fills it
  // with the first id the server actually offers.
  const LMSTUDIO_BASE_URL = (
    process.env.COMFYUI_MCP_LMSTUDIO_HOST ?? "http://127.0.0.1:1234/v1"
  ).replace(/[/]$/, "");
  let lmstudioModel =
    process.env.COMFYUI_MCP_LMSTUDIO_MODEL ?? persistedAgent.lmstudio?.model ?? "";
  const lmstudioDeps = () => ({ api: "openai" as const, host: LMSTUDIO_BASE_URL });
  // llama.cpp (issue #161) — llama-server's OpenAI-compatible /v1. No key, no
  // login, ONE model fixed at launch (-m). Context is a LAUNCH flag (-c), and
  // tool calling needs --jinja — both probed at connect (services/llamacpp-probe).
  const LLAMACPP_BASE_URL = (
    process.env.COMFYUI_MCP_LLAMACPP_HOST ?? "http://127.0.0.1:8080/v1"
  ).replace(/[/]$/, "");
  let llamacppModel =
    process.env.COMFYUI_MCP_LLAMACPP_MODEL ?? persistedAgent.llamacpp?.model ?? "";
  const llamacppDeps = () => ({ api: "openai" as const, host: LLAMACPP_BASE_URL });
  // Custom OpenAI-compatible endpoint (issue #162) — the same openai dialect
  // pointed anywhere the user says: vLLM, DeepSeek, Together, Azure, a box on
  // the LAN… Base URL + model come from panel Settings (persisted) or env; the
  // API key from the 0600 secrets store (COMFYUI_MCP_CUSTOM_API_KEY, set via
  // the panel's masked "Set API key…" — many local endpoints need none). NO
  // default URL on purpose: unconfigured degrades with an actionable ack
  // instead of dialing a guess.
  let customBaseUrl = (
    process.env.COMFYUI_MCP_CUSTOM_BASE_URL ?? persistedAgent.custom?.baseUrl ?? ""
  ).replace(/[/]$/, "");
  let customModel = process.env.COMFYUI_MCP_CUSTOM_MODEL ?? persistedAgent.custom?.model ?? "";
  // Key read FRESH each call (not a startup const) so a key set later via the
  // panel — setAgentSecret hydrates it into env — applies on the next backend
  // build without an orchestrator restart.
  const customApiKey = () => process.env.COMFYUI_MCP_CUSTOM_API_KEY;
  const customDeps = () => {
    const key = customApiKey();
    return {
      api: "openai" as const,
      host: customBaseUrl,
      ...(key ? { apiKey: key } : {}),
    };
  };
  // ── Per-tab backend (single-port multi-provider) ──────────────────────────
  // ONE orchestrator on ONE bridge port serves ALL providers; the panel picks a
  // provider per tab via the `hello`/`set_backend` handshake, instead of the node
  // spawning one process per provider on its own port (9180/9181/9182). Internally
  // each (panel tab, backend) pair is one agent addressed by a composite key
  // `tabId::backend`, so switching provider starts a FRESH session for that
  // provider (the panel replays the transcript to seed it) while a same-provider
  // reconnect RESUMES. `backendId`/`codexModel`/`geminiModel` above are the
  // DEFAULT + per-provider model config; the process is no longer pinned to one.
  const KNOWN_BACKENDS = new Set([
    "claude",
    "codex",
    "chatgpt",
    "gemini",
    "grok",
    "glm",
    "kimi",
    "ollama",
    "openrouter",
    "lmstudio",
    "llamacpp",
    "custom",
    "copilot", // EXPERIMENTAL — see copilotModel's comment above
  ]);
  const defaultBackend = KNOWN_BACKENDS.has(backendId) ? backendId : "claude";
  const AGENT_KEY_SEP = "::";
  const tabBackends = new Map<string, string>(); // panel tabId -> selected backend
  const headlessTabs = new Set<string>(); // tabs with no ComfyUI canvas (mobile/remote) — deliver renders in-turn
  const workflowTargets = new WorkflowTargetStore();
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
  let panelSystemAppend = resolvePrompt("panel.persona", PANEL_SYSTEM_APPEND);
  // Set once the manager exists so a later refresh (after a ComfyUI restart) feeds
  // the freshly-gathered env into newly-spawned agents too — Claude reads
  // manager.opts.systemAppend at each spawn; Codex reads the closed-over
  // panelSystemAppend at each makeBackend(). Updating both keeps the providers in
  // sync without rebuilding the manager.
  let liveManager: PanelAgentManager | undefined;
  async function refreshEnvCapabilities(): Promise<void> {
    try {
      envCaps = await gatherEnvCapabilities({ comfyuiUrl, comfyuiPath, backendId });
      panelSystemAppend = buildPanelSystemAppend(resolvePrompt("panel.persona", PANEL_SYSTEM_APPEND), envCaps);
      if (liveManager) liveManager.setSystemAppend(panelSystemAppend);
    } catch (err) {
      // Belt-and-suspenders: gather is internally guarded, but never let a stray
      // throw break the prompt — fall back to the static append.
      panelSystemAppend = resolvePrompt("panel.persona", PANEL_SYSTEM_APPEND);
      logger.debug(
        `[panel-orchestrator] env-capabilities probe failed (using static prompt): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Build it before any agent could spawn. Guarded so a probe stall can't block
  // orchestrator startup beyond the probes' own (short) timeouts.
  await refreshEnvCapabilities();

  // Register every editable prompt's built-in default so a prompt editor can
  // list + reset each one (overrides persist in ~/.comfyui-mcp/panel-prompts.json).
  // The persona is live-applied here; the other prompts are read fresh at each
  // session/turn, so they take effect on the next spawn without an explicit push.
  registerPrompt("panel.persona", "Panel agent persona (all backends)", PANEL_SYSTEM_APPEND, "Injected into every backend; applies live to running agents.");
  registerPrompt("backend.ollama", "Ollama / OpenRouter base prompt", OLLAMA_SYSTEM_PROMPT, "Applies on the next local/OpenRouter session.");
  registerPrompt("proposer.modelCard", "Model Explorer “Ask AI” curator", MODEL_CARD_SYSTEM, "Applies to the next Ask-AI proposal.");
  onPromptsChanged(() => { void refreshEnvCapabilities(); });

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
    ...(comfyuiPath ? { COMFYUI_PATH: comfyuiPath } : forceRemoteEnv()),
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
      panelMcpHttp = await startPanelMcpHttpServer(bridge, panelMcpPort, "127.0.0.1", workflowTargets);
    } catch (err) {
      logger.error(
        `[panel-orchestrator] could not start the panel HTTP MCP on :${panelMcpPort} — codex/gemini tabs will lack live-graph tools: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Loopback MCP console (control plane): OAuth, MCP mappings, service lifecycle.
  // Default port bridge+3 (9180→9183). NOT +2: bridge+2 is the phone-pairing
  // listener's port (see pairPort above), and the fork this console was ported
  // from predates pairing — on Windows both binds accidentally coexist
  // (specific 127.0.0.1 vs wildcard 0.0.0.0), on Linux whichever comes second
  // dies with EADDRINUSE. The panel never hardcodes this port — it uses the
  // console_url advertised on the `backends` frame.
  let panelConsoleHttp: PanelConsoleHttpServer | null = null;
  const consolePort = Number(process.env.COMFYUI_MCP_CONSOLE_PORT) || bridgePort + 3;
  const consoleToken = randomBytes(24).toString("hex");
  try {
    panelConsoleHttp = await startPanelConsoleHttpServer({
      port: consolePort,
      bridgePort,
      comfyuiUrl,
      token: consoleToken,
    });
  } catch (err) {
    logger.warn(
      `[panel-orchestrator] could not start MCP console on :${consolePort}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const consoleUrl = panelConsoleHttp?.url ?? `http://127.0.0.1:${consolePort}`;

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
  // A backend whose CONSTRUCTOR failed (e.g. GlmBackend throws when
  // ZAI_API_KEY is absent) must never take the orchestrator down — the field
  // failure was: click the GLM chip keyless → uncaught ValidationError → FATAL
  // process exit. This stub satisfies AgentBackend and surfaces the original
  // error as a normal degraded probe / in-chat error instead.
  const brokenBackend = (backend: string, msg: string): AgentBackend =>
    ({
      id: backend,
      capabilities: { modelEnumeration: false },
      async *run() {
        yield { type: "assistant", text: `⚠️ ${msg}` };
        yield { type: "result", ok: false, subtype: "backend_unavailable" };
      },
      interrupt: async () => {},
      listModels: async () => {
        throw new Error(msg);
      },
      close: async () => {},
    }) as unknown as AgentBackend;

  const makeBackend = (key: string): AgentBackend | undefined => {
    const backend = backendOf(key);
    const panelTabId = panelTabOf(key);
    try {
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
    if (backend === "grok") {
      return new GrokBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: grokModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    if (backend === "ollama") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: ollamaModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
        ...ollamaDeps(),
      });
    }
    if (backend === "openrouter") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: openrouterModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
        ...openrouterDeps(),
      });
    }
    if (backend === "lmstudio") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: lmstudioModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
        ...lmstudioDeps(),
      });
    }
    if (backend === "llamacpp") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: llamacppModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
        ...llamacppDeps(),
      });
    }
    if (backend === "custom") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: customModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
        ...customDeps(),
      });
    }
    if (backend === "chatgpt") {
      return new ChatGptOAuthBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: chatgptModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    if (backend === "glm") {
      return new GlmBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: glmModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    if (backend === "kimi") {
      return new KimiBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: kimiModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    if (backend === "copilot") {
      // EXPERIMENTAL (ToS risk) — prepare() throws a clear re-sign-in error if
      // no ~/.comfyui-mcp/copilot-auth.json exists yet (resolveCopilotOAuth),
      // so simply being selectable here does not make it USABLE without the
      // panel's experimental opt-in sign-in flow having already run.
      return new CopilotBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: copilotModel,
        systemAppend: panelSystemAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    return undefined; // claude → built-in ClaudeBackend
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[panel-orchestrator] ${backend} backend construction failed: ${msg}`);
      return brokenBackend(backend, msg);
    }
  };
  logger.info(
    `[panel-orchestrator] single-port multi-provider: default backend=${defaultBackend}; ` +
      `codex/gemini/grok panel_* live-graph tools via loopback HTTP MCP${panelMcpHttp ? ` on :${panelMcpHttp.port}` : " UNAVAILABLE"} + headless comfyui MCP`,
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
      try {
      pb =
        backend === "codex"
          ? new CodexBackend({ cwd: comfyuiPath ?? process.cwd(), model: codexModel })
          : backend === "chatgpt"
            ? new ChatGptOAuthBackend({ cwd: comfyuiPath ?? process.cwd(), model: chatgptModel })
          : backend === "glm"
            ? new GlmBackend({ cwd: comfyuiPath ?? process.cwd(), model: glmModel })
          : backend === "kimi"
            ? new KimiBackend({ cwd: comfyuiPath ?? process.cwd(), model: kimiModel })
          : backend === "ollama"
            ? new OllamaBackend({ cwd: comfyuiPath ?? process.cwd(), model: ollamaModel, ...ollamaDeps() })
            : backend === "grok"
              ? new GrokBackend({ cwd: comfyuiPath ?? process.cwd(), model: grokModel })
              : backend === "openrouter"
                ? new OllamaBackend({ cwd: comfyuiPath ?? process.cwd(), model: openrouterModel, ...openrouterDeps() })
                : backend === "lmstudio"
                  ? new OllamaBackend({ cwd: comfyuiPath ?? process.cwd(), model: lmstudioModel, ...lmstudioDeps() })
                  : backend === "llamacpp"
                    ? new OllamaBackend({ cwd: comfyuiPath ?? process.cwd(), model: llamacppModel, ...llamacppDeps() })
                    : backend === "custom"
                      ? new OllamaBackend({ cwd: comfyuiPath ?? process.cwd(), model: customModel, ...customDeps() })
                      : backend === "copilot"
                        ? new CopilotBackend({ cwd: comfyuiPath ?? process.cwd(), model: copilotModel })
                        : new GeminiBackend({ cwd: comfyuiPath ?? process.cwd(), model: geminiModel });
      probeBackends.set(backend, pb);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[panel-orchestrator] ${backend} probe construction failed: ${msg}`);
        // NOT cached: once the user supplies credentials, the next hello retries.
        return brokenBackend(backend, msg);
      }
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
        ...(comfyuiPath ? { COMFYUI_PATH: comfyuiPath } : forceRemoteEnv()),
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
      backendOf(key) === "claude"
        ? createPanelMcpServer(bridge, panelTabOf(key), workflowTargets)
        : undefined,
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
    // Tool the agent invoked → a compact "activity" line for canvas-less clients
    // (mobile), so watching the agent work isn't just a spinner.
    onToolCall: (key, name) => {
      bridge.push({ type: "action", name }, panelTabOf(key));
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

  // ── Local-agent VRAM pause during generation ────────────────────────────
  // On a single-GPU box the local Ollama chat model and ComfyUI fight for VRAM:
  // a resident model can OOM a render, and a chat sent mid-render reloads the
  // model on top of the running generation. So while a render is in flight we
  // (a) unload the local model to free its VRAM, and (b) HOLD any chat the user
  // sends and answer it once the render finishes (warming the model back). Only
  // for the LOCAL ollama dialect (hosted openai endpoints don't touch local
  // VRAM); default on, opt out with COMFYUI_MCP_OLLAMA_PAUSE_ON_GEN=0.
  const pauseLocalDuringGen = process.env.COMFYUI_MCP_OLLAMA_PAUSE_ON_GEN !== "0";
  const anyLocalOllama = (): boolean =>
    ollamaApi === "ollama" &&
    (defaultBackend === "ollama" || [...tabBackends.values()].includes("ollama"));
  // LM Studio joins the same VRAM handoff (issue #160 follow-up): local server
  // only — a remote COMFYUI_MCP_LMSTUDIO_HOST is someone else's VRAM.
  const anyLocalLmstudio = (): boolean =>
    isLocalLmstudio(LMSTUDIO_BASE_URL) &&
    (defaultBackend === "lmstudio" || [...tabBackends.values()].includes("lmstudio"));
  // agentKey -> messages held while a render runs (flushed on render end).
  const heldDuringGen = new Map<string, Array<{ text: string; opts: Record<string, unknown> }>>();
  let genPauseActive = false;
  if (pauseLocalDuringGen) {
    QueueMonitor.setTransitionHandlers({
      onRunStart: () => {
        const ol = anyLocalOllama();
        const ls = anyLocalLmstudio();
        if (!ol && !ls) return;
        genPauseActive = true;
        // Free the local model's VRAM for the render (best-effort, fire-and-forget).
        if (ol) void unloadAllOllama(resolveOllamaHost());
        if (ls) void unloadAllLmstudio(LMSTUDIO_BASE_URL);
      },
      onRunEnd: () => {
        if (!genPauseActive) return;
        genPauseActive = false;
        const hadHeld = [...heldDuringGen.values()].some((a) => a.length > 0);
        // If nothing was queued, proactively warm the model so the next chat is
        // instant ("ready to chat"). If messages ARE queued, sending them below
        // loads the model itself — no separate warm needed.
        if (anyLocalOllama() && !hadHeld) void warmOllama(resolveOllamaHost(), ollamaModel);
        if (anyLocalLmstudio() && !hadHeld && lmstudioModel) void warmLmstudio(LMSTUDIO_BASE_URL, lmstudioModel);
        for (const [key, msgs] of heldDuringGen) {
          const tabId = panelTabOf(key);
          if (msgs.length > 0) {
            bridge.push(
              { type: "say", text: "✅ Render finished — the local agent is back. Answering your queued message now." },
              tabId,
            );
          }
          for (const m of msgs) {
            bridge.push({ type: "turn", state: "working" }, tabId);
            manager.send(key, m.text, m.opts);
          }
        }
        heldDuringGen.clear();
      },
    });
  }

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
    comfyuiPath = localPathForTarget(next);
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
    // Advertising itself happens unconditionally on every hello (see below) —
    // a retarget doesn't need its own advertise call here.
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

  // An agent-provider secret changed (e.g. the OpenRouter API key set from the
  // panel). Hydrate it into env, drop the cached openrouter probe/model list so
  // the next probe uses the new key, and re-push readiness + models to every
  // live tab so the OpenRouter provider flips to "ready" and lists its models
  // without a reconnect.
  const unsubscribeAgentSecrets = onAgentSecretsChanged(() => {
    hydrateAgentSecretsIntoEnv();
    // A key change can affect either keyed endpoint provider — drop both
    // caches so the next probe carries the fresh credentials.
    for (const b of ["openrouter", "custom"]) {
      modelsByBackend.delete(b);
      const pb = probeBackends.get(b);
      if (pb?.close) void pb.close().catch(() => {});
      probeBackends.delete(b);
    }
    for (const tabId of tabBackends.keys()) {
      pushReadiness(tabId);
      pushModels(tabId);
    }
    logger.info("[panel-orchestrator] provider key saved → readiness + models refreshed");
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
        if (!list.length) modelsByBackend.delete(backend); // don't cache a failed probe
        // LM Studio / llama.cpp ship no sane hardcoded default (the model is
        // whatever the user downloaded/launched) — adopt the server's first
        // offering when unset. llama-server serves exactly one model, so this
        // IS the model.
        if (backend === "lmstudio" && !lmstudioModel && list.length) {
          lmstudioModel = (list[0] as { value?: string }).value ?? "";
          if (lmstudioModel) {
            logger.info(`[panel-orchestrator] lmstudio default model → ${lmstudioModel} (first served)`);
          }
        }
        if (backend === "llamacpp" && !llamacppModel && list.length) {
          llamacppModel = (list[0] as { value?: string }).value ?? "";
          if (llamacppModel) {
            logger.info(`[panel-orchestrator] llamacpp model → ${llamacppModel} (the server's loaded model)`);
          }
        }
        // Custom endpoint: same adoption — many self-hosted servers (vLLM,
        // llama-server, TGI) serve exactly one model, so the first listed id
        // is the sane default when the user hasn't named one.
        if (backend === "custom" && !customModel && list.length) {
          customModel = (list[0] as { value?: string }).value ?? "";
          if (customModel) {
            logger.info(`[panel-orchestrator] custom endpoint model → ${customModel} (first served)`);
          }
        }
        // User-curated preferred models (panel Settings → set_config) pin to the
        // top of the ollama picker, ahead of the discovered catalog. Read fresh
        // on every probe; set_config evicts the cache so edits apply live.
        if (backend === "ollama") {
          const preferred = getAgentSettings().preferredModels ?? [];
          if (preferred.length) {
            const discovered = new Map(list.map((m) => [m.value, m] as const));
            list = [
              ...preferred.map(
                (id) =>
                  (discovered.get(id) ?? {
                    value: id,
                    displayName: `${id} ★`,
                  }) as unknown as ModelInfo,
              ),
              ...list.filter((m) => !preferred.includes(m.value as string)),
            ];
          }
        }
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
    if (backend === "grok") return grokModel;
    if (backend === "ollama") return ollamaModel;
    if (backend === "openrouter") return openrouterModel;
    if (backend === "lmstudio") return lmstudioModel || undefined;
    if (backend === "llamacpp") return llamacppModel || undefined;
    if (backend === "custom") return customModel || undefined;
    if (backend === "chatgpt") return chatgptModel;
    if (backend === "glm") return glmModel;
    if (backend === "kimi") return kimiModel;
    if (backend === "copilot") return copilotModel;
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
      const { backends, any_ready } = allBackendReadiness(KNOWN_BACKENDS, {
        customEndpointConfigured: !!customBaseUrl,
      });
      bridge.push({ type: "backends", backends, any_ready, console_url: consoleUrl, console_token: consoleToken }, tabId);
      // llama.cpp reality check (async re-push): the binary is often unzipped
      // anywhere (not on PATH), so static detection says "not installed" while
      // a server is HAPPILY ANSWERING. A live endpoint beats a missing binary —
      // probe it and, when it answers, re-push the frame with llamacpp ready.
      const lc = backends.find((b) => b.backend === "llamacpp");
      if (lc && !lc.ready) {
        void fetch(`${LLAMACPP_BASE_URL.replace(/\/v1$/, "")}/health`, {
          signal: AbortSignal.timeout(1500),
        })
          .then((r) => {
            if (!r.ok) return;
            lc.cli = true;
            lc.auth = true;
            lc.ready = true;
            bridge.push({ type: "backends", backends, any_ready: true, console_url: consoleUrl, console_token: consoleToken }, tabId);
          })
          .catch(() => {});
      }
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
      // Re-advertise the secure bridge on EVERY hello, not just when the URL
      // changes: advertiseBridge's own retries are short (~3s) and can race a
      // pod-side ComfyUI restart, permanently leaving the pod's stored bridge
      // URL/token stale — the only symptom being a browser refresh that can
      // never reconnect ("rejected a bridge connection with a missing/invalid
      // token"), since a fresh page load re-fetches that stale value. A tab can
      // only say hello once the pod is actually reachable, so retrying here on
      // every connect self-heals a missed advertise with no extra risk — the
      // POST is cheap and idempotent (see advertiseBridge's own docstring).
      if (secureBridge && isRemoteHttpsUrl(comfyuiUrl)) void secureBridge.advertise(comfyuiUrl);
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
      // A headless client (mobile/remote pseudo-panel, no browser canvas) advertises
      // itself in the hello frame so its agent gets the in-turn-delivery directive.
      if ((event as { headless?: unknown }).headless === true) headlessTabs.add(panelTab);
      else headlessTabs.delete(panelTab);
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
      bridge.push({ type: "workflow_target", target: workflowTargets.get(panelTab) }, panelTab);
      // Re-push the last usage so the context meter isn't blank after a reload.
      const lastStatus = manager.lastStatusFor(key);
      if (lastStatus) pushStatus(panelTab, lastStatus);
      const now = Date.now();
      if (now - (lastAckAt.get(panelTab) ?? 0) < ACK_DEBOUNCE_MS) return;
      lastAckAt.set(panelTab, now);
      const isCx = backend === "codex";
      const isCg = backend === "chatgpt";
      const isGm = backend === "gemini";
      const isGk = backend === "grok";
      const isGl = backend === "glm";
      const isKm = backend === "kimi";
      const isOl = backend === "ollama";
      const isOr = backend === "openrouter";
      const isLs = backend === "lmstudio";
      const isLc = backend === "llamacpp";
      const isCu = backend === "custom";
      const isCp = backend === "copilot";
      // TRUTHFUL "connected": only claim ready after PROVING the SELECTED backend
      // can run, by probing its model list. If the probe fails — the "connected
      // but dead" wedge — send a degraded ack so the panel shows the real state.
      // OpenRouter needs an explicit key check FIRST: its /models endpoint is
      // PUBLIC, so the probe "succeeds" keyless and the tab would greet ready —
      // then 401 on the first real message. Degrade up front instead.
      if (isOr && !openrouterApiKey()) {
        bridge.push(
          {
            type: "say",
            text:
              "⚠️ OpenRouter has no API key — the connection would fail on your first message. " +
              "Set it in Settings → OpenRouter → “Set API key…” (masked, stored by the orchestrator — takes effect immediately, no reconnect needed), " +
              "or set the OPENROUTER_API_KEY environment variable and restart the orchestrator. Keys: https://openrouter.ai/keys",
          },
          panelTab,
        );
        bridge.push({ type: "ack", ok: false, kind: "degraded" }, panelTab);
        logger.warn(`[panel-orchestrator] tab ${panelTab.slice(0, 8)} connected (openrouter) but no API key — degraded ack`);
        return;
      }
      // Custom endpoint with no URL: don't dial a guess — degrade up front
      // with the exact fix (mirrors the OpenRouter keyless guard above).
      if (isCu && !customBaseUrl) {
        bridge.push(
          {
            type: "say",
            text:
              "⚠️ No endpoint configured — set the base URL in Settings → Custom endpoint (include the /v1, e.g. http://192.168.1.20:8000/v1 for vLLM, or a hosted provider's OpenAI-compatible URL), " +
              "plus “Set API key…” if the server needs one. Both apply immediately — then Connect again.",
          },
          panelTab,
        );
        bridge.push({ type: "ack", ok: false, kind: "degraded" }, panelTab);
        logger.warn(`[panel-orchestrator] tab ${panelTab.slice(0, 8)} connected (custom) but no base URL — degraded ack`);
        return;
      }
      void (isLs && isLocalLmstudio(LMSTUDIO_BASE_URL)
        ? startLmstudioServer(LMSTUDIO_BASE_URL).then(() => ensureModels(backend))
        : ensureModels(backend)
      )
        .then((models) => {
          if (models.length) {
            const agentLabel = isCx
              ? (codexModel ?? (models[0] as { value?: string }).value ?? "Codex")
              : isCg
                ? (chatgptModel ?? (models[0] as { value?: string }).value ?? "ChatGPT")
              : isGm
                ? (geminiModel ?? (models[0] as { value?: string }).value ?? "Gemini")
                : isGk
                  ? (grokModel ?? (models[0] as { value?: string }).value ?? "Grok")
                : isGl
                  ? (glmModel ?? (models[0] as { value?: string }).value ?? "GLM")
                : isKm
                  ? (kimiModel ?? (models[0] as { value?: string }).value ?? "Kimi")
                : isOl
                  ? (ollamaModel ?? (models[0] as { value?: string }).value ?? "Ollama")
                  : isLs
                    ? (lmstudioModel || ((models[0] as { value?: string }).value ?? "LM Studio"))
                    : isLc
                      ? (llamacppModel || ((models[0] as { value?: string }).value ?? "llama.cpp"))
                      : isCu
                        ? (customModel || ((models[0] as { value?: string }).value ?? "Custom endpoint"))
                        : isOr
                      ? (openrouterModel ?? (models[0] as { value?: string }).value ?? "OpenRouter")
                      : isCp
                        ? (copilotModel ?? (models[0] as { value?: string }).value ?? "Copilot")
                        : model;
            // llama.cpp launch gotchas (issue #161): a reachable server can still
            // be useless for us — tool calling needs --jinja (rejected requests),
            // and a launch-time -c under ~16K silently truncates the tool payload.
            // Probe both and degrade/warn with the exact fix instead of letting
            // the first real message fail cryptically.
            if (isLc) {
              const activeModel = llamacppModel || ((models[0] as { value?: string }).value ?? "");
              void (async () => {
                const [tools, props] = await Promise.all([
                  llamacppToolsReady(LLAMACPP_BASE_URL, activeModel),
                  llamacppProps(LLAMACPP_BASE_URL),
                ]);
                if (tools === "no") {
                  bridge.push(
                    {
                      type: "say",
                      text:
                        "⚠️ Your llama-server is running WITHOUT `--jinja`, so tool calling is disabled — every agent action would fail. " +
                        "Restart it with tool support: `llama-server -m <model>.gguf --jinja -c 16384` (current builds enable jinja by default; older ones need the flag), then Disconnect → Connect.",
                    },
                    panelTab,
                  );
                } else if (props.nCtx && props.nCtx < 16384) {
                  bridge.push(
                    {
                      type: "say",
                      text: `ℹ️ Your llama-server context is ${props.nCtx} tokens (launch flag -c). The agent's tool payload wants ≥16384 — below that, long turns silently truncate. Consider restarting with \`-c 16384\` or higher.`,
                    },
                    panelTab,
                  );
                }
              })();
            }
            // Greet only on a FRESH session (a resume/reconnect already has the thread).
            if (!resume) {
              const readyText = isCx
                ? `🟢 comfyui-mcp agent ready — ${agentLabel} on your Codex (ChatGPT) account. Ask away.`
                : isCg
                  ? `🟢 comfyui-mcp agent ready — ${agentLabel} on your ChatGPT subscription (direct OAuth). Ask away.`
                : isGm
                  ? `🟢 comfyui-mcp agent ready — ${agentLabel} on your Google account (Gemini Code Assist). Ask away.`
                  : isGk
                    ? `🟢 comfyui-mcp agent ready — ${agentLabel} on your Grok (xAI) account. Ask away.`
                  : isGl
                    ? `🟢 comfyui-mcp agent ready — ${agentLabel} on your Z.AI GLM Coding Plan. Ask away.`
                  : isKm
                    ? `🟢 comfyui-mcp agent ready — ${agentLabel} on your Kimi Code subscription. Ask away.`
                  : isOl
                    ? `🟢 comfyui-mcp agent ready — ${agentLabel} running locally via Ollama (no account, no API key). Small local models are slower and simpler than frontier ones — expect fewer frills. Ask away.`
                    : isLs
                      ? `🟢 comfyui-mcp agent ready — ${agentLabel} running locally via LM Studio (no account, no API key). Small local models are slower and simpler than frontier ones — expect fewer frills. Ask away.`
                      : isLc
                        ? `🟢 comfyui-mcp agent ready — ${agentLabel} running locally via llama.cpp (no account, no API key). Small local models are slower and simpler than frontier ones — expect fewer frills. Ask away.`
                        : isCu
                          ? `🟢 comfyui-mcp agent ready — ${agentLabel} via your custom endpoint (${customBaseUrl}). Ask away.`
                          : isOr
                      ? `🟢 comfyui-mcp agent ready — ${agentLabel} via OpenRouter (hosted API, your OPENROUTER_API_KEY). Ask away.`
                      : isCp
                        ? `🟢 comfyui-mcp agent ready — ${agentLabel} on your GitHub Copilot subscription (⚠️ experimental, ToS risk — you opted in). Ask away.`
                      : `🟢 comfyui-mcp agent ready — ${agentLabel} on your Claude subscription. Ask away.`;
              bridge.push({ type: "say", text: readyText }, panelTab);
            }
            bridge.push({ type: "ack", ok: true, kind: "ready", agent: agentLabel, backend }, panelTab);
            logger.debug(`[panel-orchestrator] tab ${panelTab.slice(0, 8)} connected (${backend}) — agent healthy, ready ack`);
          } else {
            const degradedText = isCx
              ? "⚠️ The background agent isn't responding — the Codex app-server couldn't start. Make sure Codex is installed and signed in (run `codex login`), then Disconnect → Connect to retry."
              : isCg
                ? "⚠️ The background agent isn't responding — ChatGPT direct OAuth couldn't start. Make sure ~/.codex/auth.json exists (run `codex login`), then Disconnect → Connect to retry."
              : isGm
                ? "⚠️ The background agent isn't responding — the Gemini CLI couldn't start. Make sure the Gemini CLI is installed and signed in (run `gemini` once and complete the Google sign-in), then Disconnect → Connect to retry."
                : isGk
                  ? "⚠️ The background agent isn't responding — the Grok CLI couldn't start. Make sure Grok is installed and signed in (run `grok` once and complete the xAI sign-in), then Disconnect → Connect to retry."
                : isGl
                  ? "⚠️ The background agent isn't responding — GLM Code API couldn't start. Set ZAI_API_KEY (Z.AI Coding Plan), then Disconnect → Connect to retry."
                : isKm
                  ? "⚠️ The background agent isn't responding — Kimi Code couldn't start. Run Kimi Code login (~/.kimi/credentials/kimi-code.json) or set KIMI_API_KEY, then Disconnect → Connect to retry."
                : isOl
                  ? "⚠️ The background agent isn't responding — Ollama isn't reachable. Start it with `ollama serve` and pull our fine-tuned model (`ollama pull artokun/gemma4-comfyui-mcp:e4b` — gemma4 trained on the comfyui-mcp tool suite — arena-best local model; `:12b` for ~8 GB VRAM), then Disconnect → Connect to retry."
                  : isLs
                    ? `⚠️ The background agent isn't responding — LM Studio isn't reachable at ${LMSTUDIO_BASE_URL}. Open LM Studio → Developer → Start Server and load a tool-calling model (our gemma4-comfyui-mcp GGUFs from Hugging Face work great), or set COMFYUI_MCP_LMSTUDIO_HOST if it serves elsewhere — then Disconnect → Connect to retry.`
                    : isLc
                      ? `⚠️ The background agent isn't responding — llama-server isn't reachable at ${LLAMACPP_BASE_URL}. Start it with \`llama-server -m <model>.gguf -c 16384\` (our gemma4-comfyui-mcp GGUFs work great; add --jinja on older builds — required there for tool calling), or set COMFYUI_MCP_LLAMACPP_HOST — then Disconnect → Connect to retry.`
                      : isCu
                        ? `⚠️ The background agent isn't responding — your custom endpoint isn't answering at ${customBaseUrl}. Check the base URL in Settings → Custom endpoint (it must be OpenAI-compatible and include the /v1) and the API key if the server requires one — then Connect to retry.`
                        : isCp
                          ? "⚠️ The background agent isn't responding — GitHub Copilot (experimental) couldn't start. Sign in from the panel's experimental row, then Disconnect → Connect to retry."
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
      // Leaving a LOCAL provider frees its VRAM (no other tab still on it) —
      // the point of switching to Claude/hosted is usually reclaiming the GPU.
      if (prev !== reqBackend) {
        const stillUsed = (b: string) => [...tabBackends.values()].includes(b) || defaultBackend === b;
        if (prev === "lmstudio" && !stillUsed("lmstudio") && isLocalLmstudio(LMSTUDIO_BASE_URL)) {
          void unloadAllLmstudio(LMSTUDIO_BASE_URL);
        }
        if (prev === "ollama" && !stillUsed("ollama") && ollamaApi === "ollama") {
          void unloadAllOllama(resolveOllamaHost());
        }
        // Switching TO lmstudio: make sure its server is up (auto-start, no
        // manual `lms server start`) so the readiness probe finds it alive.
        if (reqBackend === "lmstudio") void startLmstudioServer(LMSTUDIO_BASE_URL);
      }
      pushModels(panelTab);
      if (reqBackend === "claude") pushCommands(panelTab);
      bridge.push({ type: "ack", ok: true, kind: "set_backend", backend: reqBackend }, panelTab);
      logger.info(`[panel-orchestrator] tab ${panelTab.slice(0, 8)} switched backend ${prev} → ${reqBackend}`);
      return;
    }
    // Workflow target picker: pin agent edits to a specific open workflow tab.
    if (event.type === "set_workflow_target" && event.tab_id) {
      const panelTab = event.tab_id;
      const mode = (event as { mode?: unknown }).mode;
      const path =
        typeof (event as { path?: unknown }).path === "string"
          ? String((event as { path?: unknown }).path)
          : undefined;
      const filename =
        typeof (event as { filename?: unknown }).filename === "string"
          ? String((event as { filename?: unknown }).filename)
          : undefined;
      if (mode !== "current" && mode !== "pinned") {
        bridge.push(
          { type: "ack", ok: false, kind: "workflow_target", message: "mode must be 'current' or 'pinned'" },
          panelTab,
        );
        return;
      }
      if (mode === "pinned" && !(path ?? "").trim()) {
        bridge.push(
          { type: "ack", ok: false, kind: "workflow_target", message: "path required when pinning" },
          panelTab,
        );
        return;
      }
      const target = workflowTargets.set(panelTab, { mode, path, filename });
      bridge.push({ type: "ack", ok: true, kind: "workflow_target", target }, panelTab);
      bridge.push({ type: "workflow_target", target }, panelTab);
      logger.info(
        `[panel-orchestrator] tab ${panelTab.slice(0, 8)} workflow target → ${target.mode}${target.path ? ` (${target.path})` : ""}`,
      );
      return;
    }

    // Live panel config: render-stall threshold, plus the user's agent-model
    // preferences (preferred_models list + ollama endpoint config), persisted to
    // ~/.comfyui-mcp/panel-settings.json. Sent by the panel on connect and
    // whenever a setting changes. Model-list changes apply live (cache evicted,
    // fresh `models` frame pushed); an endpoint change retargets NEW sessions —
    // live ollama sessions keep their connection until restarted.
    if (event.type === "set_config" && event.tab_id) {
      if ("stall_seconds" in event) {
        const _prevStall = liveStallSeconds;
        setLiveStallSeconds((event as { stall_seconds?: unknown }).stall_seconds);
        // The panel re-sends set_config on every heartbeat; only log an ACTUAL change.
        if (liveStallSeconds !== _prevStall) {
          logger.info(
            `[panel-orchestrator] live stall threshold → ${liveStallSeconds ?? "default"}s`,
          );
        }
      }
      const cfg = event as { preferred_models?: unknown; ollama?: unknown };
      let ollamaChanged = false;
      if (Array.isArray(cfg.preferred_models)) {
        const ids = cfg.preferred_models.filter((m): m is string => typeof m === "string");
        setAgentSettings({ preferredModels: ids });
        ollamaChanged = true;
        logger.info(`[panel-orchestrator] preferred models → [${ids.join(", ")}]`);
      }
      if (cfg.ollama && typeof cfg.ollama === "object") {
        const o = cfg.ollama as { model?: unknown; api?: unknown; base_url?: unknown };
        const patch: { model?: string; api?: "ollama" | "openai"; baseUrl?: string } = {};
        if (typeof o.model === "string" && o.model.trim()) {
          patch.model = o.model.trim();
          if (!process.env.COMFYUI_MCP_OLLAMA_MODEL) ollamaModel = patch.model;
        }
        if (o.api === "openai" || o.api === "ollama") {
          patch.api = o.api;
          if (!process.env.COMFYUI_MCP_OLLAMA_API) ollamaApi = o.api;
        }
        if (typeof o.base_url === "string") {
          patch.baseUrl = o.base_url.trim();
          if (!process.env.COMFYUI_MCP_OLLAMA_BASE_URL) ollamaBaseUrl = patch.baseUrl || undefined;
        }
        if (Object.keys(patch).length) {
          setAgentSettings({ ollama: patch });
          ollamaChanged = true;
          // Endpoint may have moved — drop the cached probe backend so the next
          // readiness/model probe hits the NEW host/api with fresh deps.
          const pb = probeBackends.get("ollama");
          if (pb?.close) void pb.close().catch(() => {});
          probeBackends.delete("ollama");
          logger.info(
            `[panel-orchestrator] ollama config → model=${ollamaModel} api=${ollamaApi} host=${ollamaBaseUrl ?? "(default)"}`,
          );
        }
      }
      const lccfg = (event as { llamacpp?: unknown }).llamacpp;
      if (lccfg && typeof lccfg === "object") {
        const o = lccfg as { model?: unknown };
        if (typeof o.model === "string" && o.model.trim()) {
          const m = o.model.trim();
          if (!process.env.COMFYUI_MCP_LLAMACPP_MODEL) llamacppModel = m;
          setAgentSettings({ llamacpp: { model: m } });
          modelsByBackend.delete("llamacpp");
          logger.info(`[panel-orchestrator] llamacpp config → model=${llamacppModel}`);
        }
      }
      const lcfg = (event as { lmstudio?: unknown }).lmstudio;
      if (lcfg && typeof lcfg === "object") {
        const o = lcfg as { model?: unknown };
        if (typeof o.model === "string" && o.model.trim()) {
          const m = o.model.trim();
          if (!process.env.COMFYUI_MCP_LMSTUDIO_MODEL) lmstudioModel = m;
          setAgentSettings({ lmstudio: { model: m } });
          const pb = probeBackends.get("lmstudio");
          if (pb?.close) void pb.close().catch(() => {});
          probeBackends.delete("lmstudio");
          modelsByBackend.delete("lmstudio");
          logger.info(`[panel-orchestrator] lmstudio config → model=${lmstudioModel}`);
        }
      }
      // Custom endpoint (issue #162): base_url + model, both user-supplied.
      // base_url accepts "" (clears the endpoint → provider flips unready);
      // either change evicts the probe/model caches so the next connect dials
      // the new target, and re-pushes readiness so the picker flips live.
      const cucfg = (event as { custom?: unknown }).custom;
      if (cucfg && typeof cucfg === "object") {
        const o = cucfg as { model?: unknown; base_url?: unknown };
        const patch: { model?: string; baseUrl?: string } = {};
        if (typeof o.model === "string" && o.model.trim()) {
          patch.model = o.model.trim();
          if (!process.env.COMFYUI_MCP_CUSTOM_MODEL) customModel = patch.model;
        }
        if (typeof o.base_url === "string") {
          patch.baseUrl = o.base_url.trim().replace(/[/]$/, "");
          if (!process.env.COMFYUI_MCP_CUSTOM_BASE_URL) customBaseUrl = patch.baseUrl;
        }
        if (Object.keys(patch).length) {
          setAgentSettings({ custom: patch });
          const pb = probeBackends.get("custom");
          if (pb?.close) void pb.close().catch(() => {});
          probeBackends.delete("custom");
          modelsByBackend.delete("custom");
          pushReadiness(event.tab_id);
          logger.info(
            `[panel-orchestrator] custom endpoint config → model=${customModel || "(first served)"} host=${customBaseUrl || "(unset)"}`,
          );
        }
      }
      if (ollamaChanged) {
        modelsByBackend.delete("ollama");
        pushModels(event.tab_id);
      }
      bridge.push({ type: "ack", ok: true, kind: "config" }, event.tab_id);
      return;
    }

    // Panel-initiated secret (Settings › "Set API key/token…") — NO agent, no
    // chat: the panel paints its own masked input and ships the value here
    // directly, over the same loopback/token-gated bridge the agent-initiated
    // request_secret reply already rides. Routed by allowlist: PROVIDER keys
    // (OPENROUTER_API_KEY, COMFYUI_MCP_CUSTOM_API_KEY) → setAgentSecret, which
    // persists 0600 and hydrates process.env immediately so the refreshed
    // readiness frame flips the provider picker live; comfyui TOOL tokens
    // (CivitAI/HuggingFace) → setComfyuiSecret, whose change event already
    // re-injects the MCP child env + respawns on idle — so EVERY token button
    // works agent-free with just the bridge connected (no chicken-and-egg).
    if (event.type === "set_secret" && event.tab_id) {
      const rawKey = (event as { key?: unknown }).key;
      const rawValue = (event as { value?: unknown }).value;
      const key = typeof rawKey === "string" ? rawKey : "";
      const value = typeof rawValue === "string" ? rawValue : "";
      let error: string | undefined;
      try {
        if (!value.trim()) throw new Error("No token entered — nothing was saved.");
        if (isAllowedComfyuiSecretKey(key)) setComfyuiSecret(key, value.trim());
        else setAgentSecret(key, value.trim());
        logger.info(`[panel-orchestrator] secret set from panel Settings: ${key} (redacted)`);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      bridge.push(
        { type: "secret_saved", key, ok: !error, ...(error ? { error } : {}) },
        event.tab_id,
      );
      if (!error) pushReadiness(event.tab_id);
      return;
    }

    // Phone pairing: mint a phone-reachable bridge URL for the panel's QR modal.
    // `lan` → ws://<lan-ip>:<pairPort>/?token= (same wifi); `tunnel` → a cloudflared
    // wss://…/?token= (anywhere). Both hit the on-demand token-gated pairing
    // listener; async (tunnel startup can fail), so reply via a typed frame.
    if (event.type === "pair" && event.tab_id) {
      const mode = (event as { mode?: unknown }).mode === "tunnel" ? "tunnel" : "lan";
      const tabId = event.tab_id;
      void (async () => {
        const token = await ensurePairListener();
        let url: string;
        if (mode === "tunnel") {
          if (!pairTunnel) {
            const t = await startQuickTunnel(pairPort, "127.0.0.1");
            pairTunnel = { url: t.url, stop: t.stop };
            process.once("exit", () => {
              try {
                pairTunnel?.stop();
              } catch {
                /* best-effort */
              }
            });
          }
          const u = new URL(pairTunnel.url);
          u.protocol = "wss:";
          u.search = "";
          u.searchParams.set("token", token);
          url = u.toString();
        } else {
          const ip = firstLanIPv4();
          if (!ip) {
            throw new Error(
              "No LAN network found — connect this machine to wifi/ethernet, or use the Internet (tunnel) option.",
            );
          }
          url = `ws://${ip}:${pairPort}/?token=${token}`;
        }
        logger.info(`[panel-orchestrator] pairing URL minted (${mode})`);
        bridge.push({ type: "pair_url", mode, url }, tabId);
      })().catch((err) => {
        bridge.push(
          { type: "pair_error", mode, error: err instanceof Error ? err.message : String(err) },
          tabId,
        );
      });
      return;
    }

    // Direct tool channel: the mobile app invokes a WHITELISTED read/download tool
    // (structured data for nav lists + rig downloads) without an agent turn. Replies
    // with a `tool_result` frame the client correlates by rid.
    if (event.type === "call_tool" && event.tab_id) {
      const tabId = event.tab_id;
      // NOTE: correlate with `cid`, NOT `rid` — the bridge reserves top-level `rid`
      // for orchestrator→panel command replies, so a `rid` frame would be misrouted.
      const ev = event as { cid?: unknown; tool?: unknown; args?: unknown };
      const cid = typeof ev.cid === "string" ? ev.cid : undefined;
      const tool = typeof ev.tool === "string" ? ev.tool : "";
      const toolArgs =
        ev.args && typeof ev.args === "object" ? (ev.args as Record<string, unknown>) : {};
      void (async () => {
        if (!CALL_TOOL_WHITELIST.has(tool)) {
          bridge.push({ type: "tool_result", cid, tool, ok: false, error: `tool "${tool}" is not permitted` }, tabId);
          logger.warn(`[panel-orchestrator] call_tool rejected non-whitelisted "${tool}" (tab ${tabId.slice(0, 8)})`);
          return;
        }
        const client = await getCallToolClient();
        const result = (await client.callTool({ name: tool, arguments: toolArgs })) as {
          content?: unknown;
          isError?: boolean;
        };
        bridge.push(
          {
            type: "tool_result",
            cid,
            tool,
            ok: result.isError !== true,
            result: result.content ?? [],
            ...(result.isError ? { error: "tool returned an error" } : {}),
          },
          tabId,
        );
        logger.info(`[panel-orchestrator] call_tool ${tool} → ${result.isError ? "error" : "ok"} (tab ${tabId.slice(0, 8)})`);
      })().catch((err) => {
        bridge.push(
          { type: "tool_result", cid, tool, ok: false, error: err instanceof Error ? err.message : String(err) },
          tabId,
        );
      });
      return;
    }

    // In-panel OAuth sign-in: kick a loopback (codex/grok) or device-code
    // (copilot, experimental) flow. Reply comes back FAST (loopback: just
    // "browser opened"; device: the user_code to show) — the actual sign-in
    // completes in the background and pushes a refreshed `{type:"backends"}`
    // frame via pushReadiness when it lands. STATUS ONLY ever crosses the
    // bridge here — no token material (see oauth-bridge.ts).
    if (event.type === "oauth_begin" && event.tab_id) {
      const tabId = event.tab_id;
      const provider = typeof (event as { provider?: unknown }).provider === "string"
        ? (event as { provider?: string }).provider
        : undefined;
      const allowExperimental = (event as { allow_experimental?: unknown }).allow_experimental === true;
      handleOAuthBegin(
        { provider, allow_experimental: allowExperimental },
        {
          onAuthChanged: () => pushReadiness(tabId),
          onBackgroundError: (providerId, message) => {
            const label = OAUTH_PROVIDERS[providerId]?.label ?? providerId;
            bridge.push({ type: "say", text: `⚠️ ${label} sign-in failed: ${message}` }, tabId);
          },
        },
      )
        .then((result) => {
          bridge.push({ type: "ack", ok: true, kind: "oauth_begin", ...result }, tabId);
          logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} oauth_begin ${provider} → ${result.mode}`);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          // Echo the requested provider on the failure ack too, so the panel
          // routes the error to the row that asked (correlation) rather than
          // guessing "last-clicked". provider may be undefined for a malformed
          // request; the panel falls back to single-pending in that case.
          bridge.push({ type: "ack", ok: false, kind: "oauth_begin", ...(provider ? { provider } : {}), message }, tabId);
          logger.warn(`[panel-orchestrator] tab ${tabId.slice(0, 8)} oauth_begin ${provider ?? "?"} refused: ${message}`);
        });
      return;
    }

    // In-panel OAuth status: the panel's Connections tab polls this to show
    // "signed in as …" per provider. Status-only mirror — never tokens.
    if (event.type === "oauth_status" && event.tab_id) {
      const tabId = event.tab_id;
      try {
        const result = handleOAuthStatus({});
        bridge.push({ type: "ack", ok: true, kind: "oauth_status", ...result }, tabId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        bridge.push({ type: "ack", ok: false, kind: "oauth_status", message }, tabId);
      }
      return;
    }

    // In-panel OAuth sign-out: clears the native token file + status mirror,
    // then pushes refreshed readiness so the provider picker reflects it live.
    if (event.type === "oauth_signout" && event.tab_id) {
      const tabId = event.tab_id;
      const provider = typeof (event as { provider?: unknown }).provider === "string"
        ? (event as { provider?: string }).provider
        : undefined;
      try {
        const result = handleOAuthSignout({ provider });
        pushReadiness(tabId);
        bridge.push({ type: "ack", kind: "oauth_signout", ...result }, tabId);
        logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} oauth_signout ${provider}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Echo provider on failure too (correlation) — see oauth_begin above.
        bridge.push({ type: "ack", ok: false, kind: "oauth_signout", ...(provider ? { provider } : {}), message }, tabId);
      }
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
        // LM Studio model switch: unload everything EXCEPT the incoming model —
        // the outgoing one would otherwise sit in VRAM next to the JIT-loaded
        // replacement until its TTL expires.
        if (nextModel && backendForTab(tabId) === "lmstudio" && isLocalLmstudio(LMSTUDIO_BASE_URL)) {
          void unloadAllLmstudio(LMSTUDIO_BASE_URL, nextModel);
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

    // Chat-history parity (mobile): list the agent's saved conversations — the
    // SAME transcripts the desktop panel drives, since both share this
    // orchestrator's cwd. cid-correlated request/reply, like call_tool.
    if (event.type === "list_history" && event.tab_id) {
      const tabId = event.tab_id;
      const cid = typeof (event as { cid?: unknown }).cid === "string"
        ? (event as { cid?: string }).cid
        : undefined;
      void listSessions(process.cwd())
        .then((sessions) =>
          bridge.push({ type: "history_list", cid, sessions }, tabId))
        .catch((err) => {
          logger.warn(`[panel-orchestrator] list_history failed: ${err}`);
          bridge.push(
            { type: "history_list", cid, sessions: [], error: String(err) },
            tabId,
          );
        });
      return;
    }

    // Load one saved conversation's transcript for display (does NOT resume it —
    // the client sends resume_session next to continue it).
    if (event.type === "load_history" && event.tab_id) {
      const tabId = event.tab_id;
      const cid = typeof (event as { cid?: unknown }).cid === "string"
        ? (event as { cid?: string }).cid
        : undefined;
      const sid = typeof event.session_id === "string" ? event.session_id : "";
      void loadTranscript(process.cwd(), sid)
        .then((messages) =>
          bridge.push(
            { type: "history_transcript", cid, session_id: sid, messages },
            tabId,
          ))
        .catch((err) => {
          logger.warn(`[panel-orchestrator] load_history failed: ${err}`);
          bridge.push(
            { type: "history_transcript", cid, session_id: sid, messages: [], error: String(err) },
            tabId,
          );
        });
      return;
    }

    // Media upload from the mobile client: the phone sends image/video bytes
    // (base64) to stage as a ComfyUI INPUT (LoadImage / VHS_LoadVideo), since the
    // phone can't reach the rig's filesystem. Decode → POST to ComfyUI's
    // /upload/image → reply with the stored input filename the agent can use.
    if (event.type === "upload_media" && event.tab_id) {
      const tabId = event.tab_id;
      const ev = event as {
        cid?: unknown;
        filename?: unknown;
        mime?: unknown;
        data_base64?: unknown;
      };
      const cid = typeof ev.cid === "string" ? ev.cid : undefined;
      const filename = typeof ev.filename === "string" ? ev.filename : "upload";
      const mime = typeof ev.mime === "string" ? ev.mime : "image/png";
      const b64 = typeof ev.data_base64 === "string" ? ev.data_base64 : "";
      void (async () => {
        try {
          if (!b64) throw new Error("no data");
          const buf = Buffer.from(b64, "base64");
          const res = await uploadImageHttp(filename, buf, mime);
          bridge.push(
            { type: "media_uploaded", cid, ok: true, name: res.name, kind: mime.startsWith("video") ? "video" : "image" },
            tabId,
          );
          logger.info(`[panel-orchestrator] upload_media → ${res.name} (${buf.length}B, tab ${tabId.slice(0, 8)})`);
        } catch (err) {
          logger.warn(`[panel-orchestrator] upload_media failed: ${err}`);
          bridge.push(
            { type: "media_uploaded", cid, ok: false, error: err instanceof Error ? err.message : String(err) },
            tabId,
          );
        }
      })();
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
    // HEADLESS delivery: a mobile/remote tab has no browser panel to auto-deliver a
    // finished render, so remind its agent — every turn, since it must hold for the
    // whole session — to run headless and show the output itself in-turn. The note is
    // short and always-correct, so (unlike the once-per-episode crash/queue notes) it
    // is injected on every headless turn.
    if (headlessTabs.has(event.tab_id)) {
      outText = `${HEADLESS_DIRECTIVE}\n\n${outText}`;
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
    const sendOpts = {
      title: event.title,
      images: (event as { images?: Array<{ filename: string; subfolder?: string; type?: string }> }).images,
      mid: userMid,
    };
    // Local-agent VRAM pause: if this tab runs the local Ollama model AND a
    // render is in flight, DON'T run the turn now — that would reload the model
    // on top of the generation (VRAM contention / OOM). Hold it and answer when
    // the render finishes (onRunEnd flushes the queue + warms the model).
    const tabIsLocalVram =
      (ollamaApi === "ollama" && backendForTab(event.tab_id) === "ollama") ||
      (backendForTab(event.tab_id) === "lmstudio" && isLocalLmstudio(LMSTUDIO_BASE_URL));
    if (pauseLocalDuringGen && tabIsLocalVram && QueueMonitor.isBusy()) {
      const key = agentKeyFor(event.tab_id);
      const arr = heldDuringGen.get(key) ?? [];
      arr.push({ text: outText, opts: sendOpts });
      heldDuringGen.set(key, arr);
      genPauseActive = true; // ensure the end transition flushes even if start was missed
      bridge.push(
        {
          type: "say",
          text: "⏸ A render is running, so I've kept the GPU free for it and queued your message. I'll answer the moment it finishes.",
        },
        event.tab_id,
      );
      bridge.push({ type: "turn", state: "idle" }, event.tab_id); // clear the working spinner
      return;
    }
    manager.send(agentKeyFor(event.tab_id), outText, sendOpts);
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

  // Keep the pod's stored bridge URL fresh so a ComfyUI RESTART self-heals fast.
  // The panel's advertised wss:// URL/token lives in the pod ComfyUI process's
  // MEMORY (the panel __init__'s advertise store). A restart — which the agent
  // does after every custom-node install — WIPES it: the browser reloads,
  // fetches an empty /bridge_url, falls back to the token-less
  // ws://127.0.0.1:9180, and is rejected ("missing/invalid token"). It can't
  // send a hello to trigger the on-hello re-advertise (line ~1452) BECAUSE it
  // never gets a valid connection — a deadlock that only broke when something
  // eventually nudged it, stranding the agent mid-task for minutes. Re-POSTing
  // the advertise on a cheap idempotent timer repopulates the pod's store within
  // one interval of any reboot (from any cause: the agent's restart, a Manager
  // UI restart, a crash), so the browser's reclaim poll reconnects promptly.
  // Only meaningful for a remote https target with a secure bridge.
  let readvertiseTimer: ReturnType<typeof setInterval> | null = null;
  if (secureBridge && isRemoteHttpsUrl(comfyuiUrl)) {
    readvertiseTimer = setInterval(() => {
      if (secureBridge && isRemoteHttpsUrl(comfyuiUrl)) void secureBridge.advertise(comfyuiUrl);
    }, 5000);
    readvertiseTimer.unref?.();
  }

  // The no-path suffix must not read as an error when it is BY DESIGN: for a
  // remote target a local path is the wrong filesystem and is deliberately
  // dropped — installs/downloads run host-side via ComfyUI-Manager (remote
  // parity), so the agent is NOT install-limited there. Only a LOOPBACK target
  // with no resolvable install is a real (and now rare, post-auto-detect) gap.
  const pathNote = comfyuiPath
    ? `, path=${comfyuiPath}`
    : isLoopbackUrl(comfyuiUrl)
      ? " — no local ComfyUI install found (COMFYUI_PATH unset, auto-detect came up empty); node/model installs still run via ComfyUI-Manager"
      : " — remote target: installs/downloads run ON the ComfyUI host via its Manager (a local path would be the wrong filesystem; only local-FS tools like verify_custom_node are unavailable)";
  logger.info(
    `[panel-orchestrator] ready — bridge on ws://127.0.0.1:${bridgePort}, console on ${consoleUrl}; an agent spawns per ComfyUI tab on its first message (model=${model}, comfyui=${comfyuiUrl}${pathNote})`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[panel-orchestrator] shutting down — stopping agents…");
    clearInterval(downloadTimer);
    if (readvertiseTimer) clearInterval(readvertiseTimer);
    QueueMonitor.stop();
    unsubscribeSecrets();
    unsubscribeAgentSecrets();
    await manager.stopAll();
    // Dispose the readiness-probe backends (kills each Codex/Gemini CLI child).
    for (const pb of probeBackends.values()) {
      if (pb.close) await pb.close().catch(() => {});
    }
    // Tear down the loopback panel HTTP MCP (codex/gemini mode only).
    if (panelMcpHttp) await panelMcpHttp.stop().catch(() => {});
    if (panelConsoleHttp) await panelConsoleHttp.stop().catch(() => {});
    secureBridge?.stop();
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
