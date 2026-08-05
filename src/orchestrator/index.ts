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

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import readline from "node:readline";
import { startUiBridge, isLoopbackBindHost, SESSION_EPOCH, type UiBridge } from "../services/ui-bridge.js";
import { setupSecureBridge, resolveComfyuiPathForTarget, type SecureBridge } from "../services/secure-bridge.js";
import { judgeHelloRetarget, canonComfyuiTargetUrl } from "../services/hello-retarget.js";
import { startQuickTunnel } from "../services/tunnel.js";
import { detectInstallMode } from "../services/self-update.js";
import { performPanelSync } from "../services/panel-sync.js";
import { clearPanelDiskObservation } from "../services/panel-workspace.js";
import { panelRecoveryContext } from "../services/panel-recovery.js";
import { isPanelAutoInstallDisabled } from "../services/panel-installer.js";
import { SelfRestarter } from "../services/self-restart.js";
import {
  SessionStore,
  armableResume,
  carryWorkflowCommandStamp,
  deriveStableKey,
  destinationHasCollisionState,
  keepsBackendState,
  siblingOwnsStableKey,
  workflowIdentityParts,
} from "./session-store.js";
import { listSessions, loadTranscript } from "./history.js";
import { uploadImageHttp, resetClient } from "../comfyui/client.js";
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
import { promptText } from "./error-text.js";
import { callToolAdmission } from "./call-tool-admission.js";
import { createPanelMcpServer, makePanelToolCtx, resolvePinTarget } from "./panel-tools.js";
import {
  optionsAckFrame,
  optionsErrorAckFrame,
  optionsRequestMeta,
} from "./options-ack.js";
import { readUserMcpServers } from "../services/user-mcp-config.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../tools/index.js";
import { isForceRemoteFlagSet, isLoopbackHost, detectLocalComfyUIPath, setComfyuiTarget, onComfyuiTargetChanged, isTargetingLocal, isTargetingLocalOrLan, isTargetingPod, getComfyUIBaseUrl, getLocalComfyuiUrl, rescopeLocalTargetFile, getComfyUIAuthHeaders } from "../config.js";
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
import { AntigravityBackend } from "./antigravity-backend.js";
import { PiBackend } from "./pi-backend.js";
import { GrokBackend, GROK_DEFAULT_MODEL } from "./grok-backend.js";
import { OllamaBackend, OLLAMA_SYSTEM_PROMPT, type OllamaBackendDeps } from "./ollama-backend.js";
import { ChatGptOAuthBackend, CHATGPT_DEFAULT_MODEL } from "./chatgpt-oauth-backend.js";
import { KimiBackend } from "./kimi-backend.js";
import {
  OPENAI_KEY_PROVIDER_IDS,
  openAiKeyProvider,
  simpleKeyProvider,
  openAiKeyProviderModel,
  type OpenAiKeyProvider,
} from "../services/openai-provider-registry.js";
import { resolveOpenAiKeyCredentials } from "../services/code-provider-auth.js";
import { CopilotBackend, COPILOT_DEFAULT_MODEL } from "./copilot-backend.js";
import { SYSTEM as MODEL_CARD_SYSTEM } from "./ai-proposer.js";
import { resolvePrompt, registerPrompt, onPromptsChanged } from "../services/prompt-overrides.js";
import { allBackendReadiness, piCredentialPresent } from "./backend-readiness.js";
import { handleOAuthBegin, handleOAuthStatus, handleOAuthSignout } from "./oauth-bridge.js";
import { buildStartFailureNotice } from "./start-failure-notice.js";
import { readyBannerText, bannerCorrection } from "./ready-banner.js";
import { OAUTH_PROVIDERS } from "../services/oauth-flow.js";
import { startPanelMcpHttpServer, type PanelMcpHttpServer } from "./panel-mcp-http.js";
import { resolveHttpLaneComfyToolMode } from "./http-backend-tools.js";
import { startPanelConsoleHttpServer, type PanelConsoleHttpServer } from "./panel-console-http.js";
import type { AgentBackend } from "./agent-backend.js";
import { readComfyuiCrashLog, formatCrashNote } from "../services/crash-log.js";
import { QueueMonitor, type StallReport } from "../services/queue-monitor.js";
import {
  RunCompletions,
  describe as describeCorrelation,
  type CompletionPayload,
} from "./run-completion-journal.js";
import { AskAnswers, preview as previewQuestion } from "./ask-answer-journal.js";
import { initRunpodWatcher, getRunpodWatcher, type RunpodStatusFrame, type RunpodAlertFrame } from "../services/runpod-watch.js";
import { getPod } from "../services/runpod-client.js";
import { listTargetChangeRequests, consumeTargetChange, ackTargetChange, setProgressDir, CONTROL_PREFIX, newestAttemptEpochs, isSupersededAttempt, downloadAttemptKey } from "../services/download-progress.js";
import { hasActiveTrainingJob, reconcileStaleTrainingJobs } from "../services/training-jobs.js";
import {
  buildQueueStatusFrame,
  createQueueStatusBroadcaster,
} from "../services/queue-status-broadcast.js";
import { unloadAllOllama, warmOllama, resolveOllamaHost } from "../services/ollama-vram.js";
import {
  isLocalLmstudio,
  startLmstudioServer,
  unloadAllLmstudio,
  warmLmstudio,
} from "../services/lmstudio-lifecycle.js";
import { llamacppProps, llamacppToolsReady } from "../services/llamacpp-probe.js";
import { getAgentSettings, setAgentSettings, normalizePreferredModels } from "../services/panel-settings.js";
import {
  gatherEnvCapabilities,
  buildPanelSystemAppend,
  resolveBackends,
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

REPORT OUR OWN BUGS (we're in beta — bias HARD toward filing) — distinct from the third-party case above. Whenever YOU hit a defect in comfyui-mcp or the sidebar panel ITSELF — a tool/panel/orchestrator call that errors, crashes ComfyUI, returns wrong/misleading/empty output, fails silently, or a limitation that forced you into an awkward workaround/retry — invoke the report-bug skill (read_skill "report-bug") to autonomously file a via-panel report, EVEN IF you already recovered or worked around it. You do NOT need to be blocked, and it does NOT need to be fatal — the workaround itself is the signal. AND report the FIX, not just the failure: any time a defect in comfyui-mcp or the panel gets fixed or patched during the session — you edited/worked around the code, changed a setting, or otherwise made a broken thing work — and the user confirms it's working (they're happy with the fix), file the report RIGHT THEN, capturing BOTH the original bug AND the fix that worked, so it can be fixed upstream at the source (a confirmed working fix is the most valuable thing to send upstream). File it immediately and autonomously — do NOT wait, and do NOT ask. The skill scrubs secrets and files through our intake Worker (which dedupes server-side, so over-reporting is cheap); then just drop the user a one-line note. Do NOT ask permission for OUR bugs — file them autonomously (unlike third-party/custom-node bugs above, where you OFFER and ask first). Ordinary generation errors (OOM, missing model, bad params, user mistakes) are NOT bug reports — those stay troubleshooting.

WEDGED RENDER / OOM / VRAM PINNED — when a generation is stuck or hits CUDA out-of-memory, or a cancel didn't actually free GPU memory (models still resident, VRAM pinned, the next run still OOMs), call panel_free_vram to UNLOAD all models and free VRAM before retrying — it does NOT restart ComfyUI, so it's the cheap first move. Escalation ladder: cancel the run → panel_free_vram (unload + free) → retry; only as a LAST RESORT panel_restart_comfyui (which refuses mid-render and guards the running generation). Reach for panel_free_vram before a restart whenever a cancel left memory pinned.

WORKFLOW TARGETING — by default your panel_* graph edits follow whichever workflow tab the user is currently viewing. The panel can only read or edit the workflow currently IN VIEW, so to work on a specific open workflow, make it the active canvas first with panel_open_workflow, then call panel_set_workflow_target(mode:"pinned", path:<from panel_list_workflows>) to bind your edits to it; panel_get_workflow_target shows the current binding. Pinning to a background (open but not active) workflow is REJECTED at pin time — it cannot route edits to a tab that isn't in view. A pin does NOT switch what the user sees; it binds your edits to that workflow so that if the user later switches away, your next graph call fails loudly instead of silently editing the wrong graph. Set mode:"current" to follow the user's active tab again.

CRITICAL — never destroy the user's work. When they ask for a "new workflow", a "fresh canvas", or to "start over for a new project", call panel_new_workflow (it opens a NEW TAB and leaves their current workflow intact). NEVER use panel_clear for that — panel_clear wipes the CURRENTLY OPEN graph and is ONLY for an explicit "clear/reset this canvas". You can manage tabs with panel_list_workflows / panel_open_workflow / panel_rename_workflow / panel_close_workflow, and group nodes with panel_select_nodes / panel_create_subgraph. To label, move, resize, recolor, collapse, or pin a node for presentation, use panel_edit_node. To read or edit nodes INSIDE a subgraph, call panel_enter_subgraph(node_id) first — then panel_query_graph / panel_graph_outline and the panel_* edit tools operate on the subgraph's inner nodes — and panel_exit_subgraph when you're done.

SUBGRAPH I/O — exposing interior nodes to the boundary. To wire an interior node to the subgraph's boundary from INSIDE a subgraph, do NOT panel_connect to a guessed rail node id — that's the rail and you'll get it wrong. Use panel_expose_subgraph_output(from_node_id, from_output) to expose an interior OUTPUT on the output rail (so the parent graph can wire the subgraph node's new output), and panel_expose_subgraph_input(to_node_id, to_input) to expose an interior INPUT on the input rail. Read panel_query_graph's \`rails\` field (present when viewing a subgraph) to see the current boundary slots — what's already exposed and what still needs it. To EXPAND/DISSOLVE a subgraph back into the parent graph (inline its inner nodes and rewire external links, removing the wrapper — the inverse of panel_create_subgraph), use panel_unpack_subgraph(node_id). All three are undoable with Ctrl+Z.

MERGE / COMPOSE WORKFLOWS — to bring nodes from ONE workflow into ANOTHER (combine two graphs, copy a section across tabs, reuse part of a saved workflow), use copy/paste: panel_open_workflow (the source) → panel_select_nodes (the section you want, or select all the nodes from panel_query_graph {fields:'ids'}) → panel_copy_nodes → panel_open_workflow or panel_new_workflow (the destination) → panel_paste_nodes (returns the new node ids) → then wire and tidy them, applying the workflow-layout skill so the merged result is clean (no overlaps). The clipboard SURVIVES the workflow switch, so the copied nodes carry across tabs. Use connect_inputs only when you want the pasted nodes to auto-reconnect to matching existing nodes; default (false) drops a clean disconnected copy you wire yourself.

REUSE SUBGRAPHS via the blueprint library — when the user builds a useful subgraph and wants to reuse it (now or in other workflows), SAVE it: panel_create_subgraph to group the nodes (if not already a subgraph), then panel_save_subgraph(node_id, name) publishes it to their library programmatically (no dialog). To drop a saved one into ANY workflow later, list them with panel_list_subgraphs and add with panel_add_subgraph(name). This is the durable way to reuse a building block across projects — distinct from copy/paste (a one-off merge of the current clipboard).

PREFER READY EXPERTISE OVER HAND-BUILDING. When the user asks you to "set up", "build", or "make" a workflow for a specific model FAMILY (krea2, wan, flux, qwen, ltx, z-image, ideogram, anima, ernie, etc.), do NOT immediately hand-build a generic graph from scratch. FIRST, in order: (a) consult the matching SKILL for that family. If you already have a skill for it loaded in your context, use it. If you do NOT have its full guidance in front of you, do NOT guess from memory — actually CALL the comfyui MCP's list_skills to see what's bundled, then read_skill(name) to load the real family expertise (model slots, the node graph, settings, gotchas) before you build; (b) check the installer PACKS by CALLING list_packs (each packs/<name>/ has a ready manifest.yaml AND a ready workflow.json). If a pack matches the family, PREFER it: apply_manifest --path <its manifest_path> installs the right custom nodes + model weights, and the pack's workflow.json is the expert graph — CALL read_pack_workflow(name) to get that ready graph and recreate it on the live canvas via panel_add_node/panel_connect/panel_set_widget so the user watches it build (or enqueue it headlessly when they don't need it on-canvas), instead of inventing your own. Don't claim a skill or pack exists unless a tool result confirmed it; (c) check the ComfyUI workflow Templates — call list_workflow_templates (it lists CUSTOM-NODE-contributed templates from the server's /api/workflow_templates index; it does NOT enumerate ComfyUI's own core bundled templates, which are served separately) for a matching starter, and ALSO point the user at the frontend's Templates browser directly, since core templates only appear there. Only build from scratch if NOTHING matches — and when you do, briefly say what you checked (skill, packs, templates) so the user knows you didn't reinvent the wheel. And never wipe the user's current canvas (no panel_clear) until the replacement is actually ready to drop in. To load a ready pack graph onto the live canvas in one shot (instead of recreating it node-by-node), use panel_load_workflow(pack:<name>) — the pack's UI workflow.json is read server-side and dropped onto the canvas, undoable.

OPENING A STAGED / DOWNLOADED WORKFLOW. When you've saved or downloaded a workflow .json into the user's ComfyUI workflows folder (e.g. an example you fetched), open it with panel_open_workflow(path:<name-or-path>) — it now REFRESHES the frontend's (cached) workflow list before searching, so a just-staged file is found and opened natively in its own tab. For a workflow .json that lives OUTSIDE the workflows folder (any absolute path on the ComfyUI machine, or a downloaded example you didn't move into workflows/), load it directly onto the live canvas with panel_load_workflow(path:<file>) — the orchestrator reads + parses the JSON server-side and drops it on the canvas in one shot, so even a large (100KB+) workflow never has to shuttle through this chat. Prefer panel_load_workflow(path:<file>) over pasting a big workflow JSON inline as the graph arg.

RESOLVING A TANGLED / TOGGLE-HEAVY WORKFLOW (Get/Set buses + rgthree-bypassed pipelines). Expert and community graphs are often thick with VIRTUAL WIRING — GetNode/SetNode buses and Reroutes that hide the real connections — and rgthree "Fast Groups Bypasser/Muter" TOGGLED PIPELINES (one graph holding several pipelines, only one active at a time). Do NOT hand-trace GetNode→SetNode links or guess which branches are live. To get the REAL wiring: call panel_strip_workflow(path:<file> | pack:<name> | graph:<json>) — it resolves Get/Set buses, Reroutes, subgraph definitions, and bypassed/muted nodes into REAL connections and returns the flat, runnable graph (read server-side, never shuttled through chat). If the file is a MULTI-PIPELINE monolith and you only want ONE pipeline, FIRST panel_slice_workflow(path:<file>, groups:[<group-title substrings>]) to carve that pipeline into a standalone activated graph (it seeds from the output nodes in those groups, takes their backward closure through links + Set/Get buses, and un-bypasses the kept nodes), THEN panel_strip_workflow to flatten the buses. Reach for panel_strip_workflow whenever a graph is too tangled to read directly or you need to UNDERSTAND or REBUILD its actual wiring (e.g. a staged expert example full of GetNode/SetNode/Reroute); reach for panel_slice_workflow when an ULTRA-style monolith bundles several toggled pipelines and you want just one. (The same two tools exist as the MCP strip_workflow / slice_workflow for non-panel sessions.)

RECOMMENDING CIVITAI MODELS — SHOW, DON'T JUST TELL. When the user asks about or you're recommending specific CivitAI resources (a "good relight LoRA?", "which Flux checkpoint?", "find me an anime style"), LEAN TOWARD opening the docked CivitAI browser and highlighting your picks rather than answering with only a text table. Flow: panel_open_civitai (docked, matched query/tab/filters) → panel_civitai_search to refine → panel_civitai_results to read the metadata + URLs → panel_civitai_highlight the one(s) you recommend, with a BRIEF text summary of why each fits. This docks beside the chat so both stay visible, and lets the user SEE the actual cards. (Note: you read metadata + URLs only, not the images.) It's a nudge, not a mandate — a quick factual answer or a resource the user already named is fine as text; reach for the browser when they're choosing between options or exploring.

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

AFTER PANEL_RUN — once you call panel_run to queue a render, you will be notified automatically with the output image(s)/video when it finishes. Do not poll queue (action:"list"), get_history, or list_output_images waiting for the result — just end your turn and the finished render will be delivered to you.

DEBUG WRONG RENDERS BY INSPECTING INTERMEDIATE STEPS (run-to-node). When a final asset comes out WRONG — artifacts, wrong subject/pose/composition/color, blur, a ControlNet/IPAdapter/mask/LoRA not taking, a refiner or upscale stage degrading it — do NOT just re-roll the whole graph. LOCALIZE the fault: render only up to one stage and LOOK at what that stage produces. panel_run takes to_node_id to run ONE output branch (ComfyUI partial execution) — only that output node plus everything upstream of it renders, the rest is skipped, so it's fast and cheap, and the result is delivered to you automatically like any run. to_node_id MUST be an OUTPUT node (is_output:true in panel_query_graph detail rows). To inspect a point that ISN'T an output — a latent, a preprocessor/depth/pose map, a mask, an intermediate image — TAP it: add a PreviewImage on an IMAGE wire (or VAEDecode→PreviewImage on a LATENT, MaskToImage→PreviewImage on a MASK), panel_run(to_node_id=that preview), read the delivered image, then panel_remove_node the tap when done. Bisect upstream→downstream until you find the FIRST stage whose output is bad — that node (or its inputs/widgets) is what to fix, then run-to-node there again to confirm before a full run. For the full method (probe recipes, symptom→probe map) read the debug-render skill via read_skill. This is for renders that COMPLETE but look wrong; for runs that fail with an error/OOM/missing node, use the troubleshooting skill instead.

CHAIN A STAGE'S OUTPUT INTO THE NEXT STAGE'S LOADER — when a multi-stage pipeline (e.g. Krea2 image → LTX video → WAN extend) needs one stage's OUTPUT fed into the next stage's loader (LoadImage / VHS_LoadVideo / LoadAudio), call stage_output_as_input with the output's { filename, subfolder?, type? } and drop the returned input filename into the loader's image/video/audio widget. (Or, for a file already on disk, upload_image / upload_video / upload_audio.) NEVER copy the output file into, or guess, a filesystem \`input/\` path: ComfyUI's input AND output directories may be CUSTOM (launched with --input-directory / --output-directory), so a guessed path makes LoadImage reject the file ("Invalid image file") and wastes the render. stage_output_as_input goes through the server API (/view → /upload/image), which resolves the real dirs correctly every time. VERIFY A VIDEO RENDER VIA THE FILESYSTEM, NOT /history — VHS_VideoCombine and similar video nodes write the .mp4 but frequently do NOT register an output in ComfyUI's /history (the prompt shows done with no output and no error), so do NOT conclude a clip "silently dropped" from get_history or queue (action:"status"); confirm it with list_output_images (which now lists videos, each tagged kind:"video") by filename/prefix + fresh mtime, then chain it forward with stage_output_as_input.

BYPASS COMPLETED STAGES BEFORE QUEUING THE NEXT ONE. When you build a multi-stage pipeline on one canvas (e.g. Krea2 → LTX → WAN), once a stage has RUN and you've captured/staged its output, BYPASS that stage's nodes with panel_set_node_mode(mode:"bypass") BEFORE you queue the next stage — so panel_run doesn't re-execute (and make the user pay for / wait on) work that's already done. Re-running the whole graph because an earlier stage was left active is a real, costly failure mode: explicitly bypass each finished stage and keep only the ACTIVE stage live. (This complements stage_output_as_input, which feeds the prior stage's output forward into the next stage's loader — bypass the producer, feed its captured output to the consumer.)

## Interactive UI cards
When the user must choose between options, confirm a plan, fill in parameters, or would grasp a wiring explanation faster as a diagram, render a CARD instead of a wall of text: call panel_ui_render with an A2UI-subset spec (choice Buttons; forms from TextField/Select/Checkbox plus one submit Button; 'comfy:graph' for node-wiring diagrams — give nodes and edges, the panel draws it; 'comfy:chart' for bar/line comparisons). After rendering a card that asks a question, END YOUR TURN — the user's click arrives as their next chat message. Use panel_ui_update(card_id, spec) to update a live card in place (progress, revised options). Set surface:"wide" only for diagram-heavy cards. Keep cards small: one decision per card, ≤5 buttons, plain language labels.
If you do NOT have panel_ui_render (no panel tools), you may emit the same JSON spec in a fenced block instead:
\`\`\`a2ui
{ "root": "c", "components": [ ... ] }
\`\`\`
Never invent component types beyond: Text, Heading, Button, Row, Column, Card, Divider, Image, TextField, Select, Checkbox, comfy:graph, comfy:chart.`;

// Capability override appended to the pi (pi.dev) backend's system prompt ONLY.
// The shared PANEL_SYSTEM_APPEND above tells the agent it can SEE/EDIT the canvas
// via panel_* (and headless comfyui) tools — TRUE for every other CLI backend,
// which are handed those MCP servers. But pi has NO MCP client at all, so it gets
// none of those tools; without this override pi would attempt or hallucinate
// panel_*/comfyui_* calls it cannot make (issue #491 codex P0a). This is appended
// LAST so it overrides the claims above.
const PI_CAPABILITY_OVERRIDE = `

=== IMPORTANT CAPABILITY OVERRIDE — READ THIS, IT SUPERSEDES THE ABOVE ===
You are running on the pi (pi.dev) backend, which has NO ComfyUI tools. Disregard every instruction above about panel_* tools (panel_graph_outline, panel_query_graph, panel_add_node, panel_connect, panel_set_widget, panel_run, panel_save_workflow, panel_install_node, panel_free_vram, …) and the headless comfyui tools (generate_image, enqueue_workflow, list_packs, apply_manifest, read_skill, …): NONE of them exist in your runtime. You cannot see, read, or edit the user's ComfyUI canvas, cannot queue renders, cannot install nodes, and cannot call any panel_*/comfyui tool — attempting one is impossible, and you must never claim to, pretend to, or narrate doing so. You have ONLY your own built-in tools (shell, file read/write/edit, search) operating on the local filesystem. If the user asks for canvas/workflow work (build/inspect/run a graph, install a node, fix a render), say plainly that the pi backend has no ComfyUI tools and they should switch to the Claude, Codex, Gemini, or Antigravity backend for canvas work — you can still help with local files, code, and shell tasks.`;

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
  "enqueuing returns a prompt_id immediately, so wait for it with queue (action:\"status\", prompt_id) — poll it briefly until " +
  "it reports completion (this is the ONE case where polling IS correct) — then fetch the output with get_history and " +
  "show it with panel_show_media. Do NOT end your turn expecting an automatic notification; none will arrive. " +
  "If the run FAILED — or the user asks why a render failed / what's missing — call diagnose_run FIRST, and do NOT use " +
  "get_history for that: diagnose_run returns everything get_history would (failed node + exception + traceback) PLUS the " +
  "missing models (exact file + the widget holding it) and missing node types that get_history omits, in one call. It is " +
  "the canvas-less equivalent of the panel's \"why is this red?\", so also do NOT try panel_get_errors here.";

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
      `BETWEEN steps, so a stuck step can ignore a cancel. If it's wedged: call queue (action:"cancel") with ` +
      `clear_pending:true; if it reports the job still wedged, restart_comfyui / panel_restart_comfyui. ` +
      `Do NOT queue another run on top.`
    );
  }
  // A plain backlog (depth > 1) is NOT evidence of a wedge — deliberately queuing
  // a batch is a normal workflow. Suppress the note entirely when the in-flight
  // work is this session's own recent jobs, and when it isn't, report it NEUTRALLY
  // (no false "you likely queued behind a stuck job" diagnosis, no destructive
  // clear_pending as the headline). A genuinely stalled job is handled above (#559).
  if (rep.backlog && !rep.selfAttributed) {
    const pending = Math.max(0, rep.queueDepth - 1);
    return (
      `ℹ️ ComfyUI queue: ${rep.queueDepth} tasks in flight (1 running + ${pending} pending) that this session ` +
      `didn't queue. This is only a problem if the running one is stuck — inspect with queue (action:"list"). ` +
      `queue (action:"cancel_queued") drops a single pending item; queue (action:"cancel") with clear_pending:true resets everything.`
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

/**
 * #694 — the `models` push frame is the ONE frame stamped with the bridge's
 * per-process SESSION_EPOCH (no per-command stamping): the panel scopes its
 * retry_of dedupe cache to the process that minted the rids, so a restarted
 * orchestrator's tokens never collide with a prior process's. Exported (pure)
 * so the epoch-stability test can build two frames without booting the
 * orchestrator.
 */
export function buildModelsPushFrame(
  models: ModelInfo[],
  current: string | undefined,
  backend: string,
): Record<string, unknown> {
  return { type: "models", epoch: SESSION_EPOCH, models, current, backend };
}

/** #694 (epoch-first) — the tiny immediate frame a hello gets before any async
 *  work: advances the session epoch without waiting for model discovery, so a
 *  command arriving in the gap can never resolve retry_of against the prior
 *  process's epoch. Exported (pure) for the shape test. Type is "session_epoch"
 *  — NEVER "session": that frame name is taken (session_id lifecycle). */
export function buildSessionEpochFrame(): Record<string, unknown> {
  return { type: "session_epoch", epoch: SESSION_EPOCH };
}

/**
 * Send the model handshake even when discovery returned no choices. The models
 * frame is also the process-epoch handshake that scopes panel retry tokens, so
 * suppressing an empty catalog would leave a reconnecting panel on the prior
 * process's epoch and allow stale tokens to resolve there.
 */
export function pushModelsFrame(
  bridge: Pick<UiBridge, "push">,
  panelTabId: string,
  models: ModelInfo[],
  current: string | undefined,
  backend: string,
): number {
  return bridge.push(buildModelsPushFrame(models, current, backend), panelTabId);
}

/**
 * Keeps download-tray reconciliation state separate from the progress-file
 * lifecycle. `record` only decides whether a changed snapshot needs a global
 * broadcast; `forPanel` is the current (possibly empty) state sent to every
 * hello/re-hello so a reconnect cannot retain rows from an old process.
 */
export class DownloadProgressSnapshots {
  private lastSnapshot: string | null = null;
  private rows: Array<Record<string, unknown>> = [];

  record(rows: Array<Record<string, unknown>>): boolean {
    const snapshot = JSON.stringify(rows);
    if (snapshot === this.lastSnapshot) return false;
    this.lastSnapshot = snapshot;
    this.rows = rows;
    return true;
  }

  forPanel(): Array<Record<string, unknown>> {
    return this.rows;
  }
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
    // #468 — this path exits without any teardown, so record whatever run
    // completions die with it. Log-only by construction (see the function): a
    // crash is no time to await a bridge write.
    reportLostCompletionsOnExit();
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
    // #468 — a fatal self-exit deliberately BYPASSES the idle gate (the whole
    // point is to collapse a wedged orchestrator), and the journal is in-memory,
    // so any undelivered run completion dies here. It must not die SILENTLY:
    // tell each affected tab, in the panel chat, exactly which runs it will never
    // be told about, so the user (and the agent that resumes after the respawn)
    // treats them as UNDETERMINED instead of still-pending.
    reportLostCompletionsOnExit();
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
  // Provisioned eagerly for secure/LAN boots, LAZILY on the first remote
  // retarget (a loopback boot must not permanently rule out the secure bridge
  // the pod's HTTPS panel needs — codex finding).
  let bridgeToken =
    envBridgeToken ?? (wantSecureBridge || lanBridge ? randomBytes(24).toString("hex") : null);

  // Dedicated PANEL bridge port (default 9180). Token-gated in secure/LAN mode.
  const lockPort = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180;
  const lockPath = orchLockPath(lockPort);
  const bridge = startUiBridge(lockPort, bridgeToken, bridgeHost);
  // Starts empty intentionally: a newly connected panel must be able to clear
  // rows left by an older process before this process sees any progress files.
  const downloadSnapshots = new DownloadProgressSnapshots();
  // The LISTENER'S auth was fixed at construction: a null boot token means a
  // tokenless listener FOREVER — lazily provisioning a token later would
  // advertise a tunnel whose token is not enforced (codex finding). The lazy
  // secure-bridge path must refuse in that case, not expose it publicly.
  const bridgeListenerTokenless = bridgeToken === null;

  // On-demand phone pairing (the panel "Remote control" button). Off by default:
  // the FIRST pair request lazily binds a SECOND, token-gated listener on all
  // interfaces (so a phone can reach it), while the primary loopback bridge stays
  // token-less. LAN mode returns a same-wifi ws:// URL; tunnel mode fronts the same
  // token-gated listener with a cloudflared wss:// for anywhere access.
  const pairPort = lockPort + 2; // avoid the panel_* HTTP-MCP port (lockPort + 1)
  // A stable pairing token can be pinned via COMFYUI_MCP_PAIR_TOKEN. Without it,
  // the token is generated per session, so a phone's saved bridge URL dies on the
  // next orchestrator restart and the user must re-pair. With it pinned, the token
  // is stable AND the LAN pairing listener is auto-started at boot (below), so the
  // phone silently reconnects across restarts with no panel interaction.
  const envPairToken = process.env.COMFYUI_MCP_PAIR_TOKEN?.trim() || null;
  let pairToken: string | null = envPairToken;
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

  // With a pinned pair token, bring the LAN pairing listener up now so a phone's
  // saved URL reconnects across restarts without ever touching the panel. This is
  // strictly opt-in (COMFYUI_MCP_PAIR_TOKEN unset → the on-demand behavior above is
  // unchanged). Tunnel pairing stays on-demand: cloudflared quick-tunnel hostnames
  // rotate per run, so a stable token alone can't make a tunnel URL persist.
  if (envPairToken) {
    try {
      await ensurePairListener();
      const ip = firstLanIPv4();
      const pairUrl = `ws://${ip ?? "<this-machine-ip>"}:${pairPort}/?token=${envPairToken}`;
      process.stderr.write(
        [
          "",
          "════════════════════════════════════════════════════════════════════",
          " ComfyUI MCP — phone pairing listener AUTO-STARTED (stable token)",
          "════════════════════════════════════════════════════════════════════",
          ` Pair URL : ${pairUrl}`,
          "",
          " Paste this into the mobile app once — it survives restarts because",
          " COMFYUI_MCP_PAIR_TOKEN is pinned. Anyone with this URL can drive the",
          " agent — treat it like a password. Unset the env var to disable.",
          "════════════════════════════════════════════════════════════════════",
          "",
        ].join("\n") + "\n",
      );
    } catch (err) {
      logger.warn(
        `[panel-orchestrator] could not auto-start the phone pairing listener on ${pairPort}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  // #296: an embedded LOCAL sidebar session with NO CLI-configured workspace
  // (COMFYUI_PATH unset AND auto-detect empty) would otherwise spawn path-less —
  // its comfyui MCP stuck in a degraded "local but path-less" state (no
  // download_model/apply_manifest/model-scan LOCAL surface, panel_load_workflow's
  // local fallback blind). The panel already KNOWS where ComfyUI lives and serves
  // it at GET /comfyui_mcp_panel/status (base_path). resolveComfyuiPathForTarget
  // consumes it as a last-resort fallback for a loopback, non-force-remote target
  // (adopting only a path that actually exists on THIS machine). Awaited here so
  // the recovered path is in place BEFORE the MCP-env builders / manager below
  // capture it. Best-effort — a failed/absent status route leaves us path-less.
  let comfyuiPath = await resolveComfyuiPathForTarget({
    target: comfyuiUrl,
    localPath: localComfyuiPath,
    forceRemote: isForceRemoteFlagSet(),
    isLoopback: isLoopbackUrl(comfyuiUrl),
  });
  if (comfyuiPath && comfyuiPath !== localPathForTarget(comfyuiUrl)) {
    logger.info(
      `[panel-orchestrator] no COMFYUI_PATH/default workspace; adopted ComfyUI ` +
        `base_path from the panel status route: ${comfyuiPath} (#296).`,
    );
  }
  // Force the child remote only when opted in (--force-remote) or the target is
  // non-loopback; a default loopback panel user with no COMFYUI_PATH is left to
  // auto-detect its local install (keeps download_model/apply_manifest/scans).
  const forceRemoteEnv = (): Record<string, string> =>
    isForceRemoteFlagSet() || !isLoopbackUrl(comfyuiUrl)
      ? { COMFYUI_MCP_FORCE_REMOTE: "1" }
      : {};
  const model = process.env.COMFYUI_MCP_PANEL_MODEL ?? "claude-opus-5";
  const envEffort = process.env.COMFYUI_MCP_PANEL_EFFORT;
  const effort: Effort | undefined = isEffort(envEffort) ? envEffort : undefined;
  // Single-port multi-provider: ONE orchestrator on ONE bridge port (default
  // 9180) serves ALL providers — the panel picks a provider per tab via the
  // hello/set_backend handshake (see "Per-tab backend" below). +1 is the panel_*
  // HTTP-MCP port, +2 the phone-pairing listener. COMFYUI_MCP_BRIDGE_PORT overrides.
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

  // Cross-process download-progress + control channel: each tab's comfyui MCP
  // subprocess writes per-download JSON (and runpod_* target requests) here;
  // the watcher below broadcasts downloads to the panel tray and applies
  // control requests. Port-scoped so parallel orchestrators don't cross
  // streams, NONCED + mode-0700 so another local user can't pre-create the
  // predictable path and inject a hostile retarget (codex finding — the
  // applied URL receives configured auth headers on later requests).
  const progressNonce = randomBytes(12).toString("hex");
  const progressDir = join(tmpdir(), `comfyui-mcp-progress-${bridgePort}-${progressNonce}`);
  // Reap dirs from dead processes on this port (auto-restarts would otherwise
  // accumulate them forever — codex finding). Same port ⇒ same orchestrator,
  // so any other dir with the prefix belongs to a previous life.
  try {
    for (const d of readdirSync(tmpdir())) {
      if (d.startsWith(`comfyui-mcp-progress-${bridgePort}-`) && join(tmpdir(), d) !== progressDir) {
        rmSync(join(tmpdir(), d), { recursive: true, force: true });
      }
    }
  } catch {
    /* best-effort */
  }
  mkdirSync(progressDir, { recursive: true, mode: 0o700 });
  // Late-bind the channel dir so the control channel works IN-PROCESS too
  // (direct/mobile tool calls — codex finding: it was dead without the env var).
  setProgressDir(progressDir);

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
  // The panel's `model` is a Claude id (e.g. claude-opus-5) and is NOT a valid
  // Codex model — so for codex we only pass a model when COMFYUI_MCP_CODEX_MODEL
  // is set explicitly; otherwise Codex uses the account's default (e.g. gpt-5.5).
  const codexModel = process.env.COMFYUI_MCP_CODEX_MODEL;
  // Gemini likewise: the panel model is a Claude id, so the Gemini model comes from
  // COMFYUI_MCP_GEMINI_MODEL (default gemini-2.5-pro). The model is applied at spawn
  // via the CLI `--model` flag (ACP exposes no per-session model setter).
  const geminiModel = process.env.COMFYUI_MCP_GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL;
  // Antigravity (`agy`, issue #262): no default on purpose — unset means the
  // account's own default model; the live catalog comes from `agy models`.
  const antigravityModel = process.env.COMFYUI_MCP_ANTIGRAVITY_MODEL;
  // pi.dev (`pi`, issue #491): no default on purpose — unset means pi's own
  // configured default provider/model. When set, COMFYUI_MCP_PI_MODEL accepts a
  // bare model id or pi's "provider/model" form; COMFYUI_MCP_PI_PROVIDER pins the
  // provider (--provider). The live catalog comes from `pi --list-models`.
  const piModel = process.env.COMFYUI_MCP_PI_MODEL;
  const piProvider = process.env.COMFYUI_MCP_PI_PROVIDER;
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
  // Boot diagnostic for the recurring "I set the key but the panel says not
  // ready" reports (Discord #help): state which keyed providers have a key and
  // where it came from — env (shell/system var) vs store (API Keys card) vs
  // none. Presence + source ONLY, never values. This turns the next report
  // from a mystery into a one-line answer.
  {
    const hydrated = new Set(hydratedSecrets);
    const src = (k: string) => (process.env[k] ? (hydrated.has(k) ? "store" : "env") : "none");
    const registryKeyed = OPENAI_KEY_PROVIDER_IDS.map(
      (id) => `${id}=${src(openAiKeyProvider(id)!.envKeys[0]!)}`,
    ).join(", ");
    logger.info(
      `[panel-orchestrator] keyed providers: openrouter=${src("OPENROUTER_API_KEY")}, ${registryKeyed}`,
    );
  }
  const persistedAgent = getAgentSettings();
  let ollamaModel =
    process.env.COMFYUI_MCP_OLLAMA_MODEL ?? persistedAgent.ollama?.model ?? "artokun/gemma4-comfyui-mcp:e4b";
  const chatgptModel = process.env.COMFYUI_MCP_CHATGPT_MODEL ?? CHATGPT_DEFAULT_MODEL;
  // kimi keeps a local model var (its bespoke KimiBackend takes it). glm/moonshot
  // read their model straight from the registry via the shared factory, so no
  // per-provider model var is needed for them anymore. All three still resolve to
  // the exact value the old <provider>Model consts held
  // (process.env.COMFYUI_MCP_<X>_MODEL ?? <X>_DEFAULT_MODEL).
  const kimiModel = openAiKeyProviderModel(openAiKeyProvider("kimi")!);
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
    "antigravity",
    "pi",
    "grok",
    // Simple api-key providers (glm/kimi/moonshot) come from the registry.
    ...OPENAI_KEY_PROVIDER_IDS,
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
  // #376: the model label advertised in a tab's ready banner (sent at hello, before
  // the SDK reports the real model). onSession re-sends a corrected banner when the
  // resolved model differs from what's stored here. A tab with NO entry never got a
  // greeting (a resume/reconnect), so it must never be "corrected".
  const advertisedBannerModel = new Map<string, string>();
  // The SDK-resolved model per tab, learned from the session/init event. Kept so a
  // greeting emitted AFTER the model is already known (the onSession-before-greeting
  // race) can label itself correctly instead of showing the pre-init default.
  const resolvedModelByTab = new Map<string, string>();
  const headlessTabs = new Set<string>(); // tabs with no ComfyUI canvas (mobile/remote) — deliver renders in-turn
  // #570: for an UNSAVED workflow the panel tab id is an ephemeral tmp:<uuid>,
  // regenerated on every reload, so the tab-keyed session store can't survive an
  // orchestrator restart that also reloads the panel. Map each such tab to a STABLE
  // resume key (wfid::origin::uuid::backend, see deriveStableKey) computed at hello, so
  // onSession can also persist under it and a reloaded tab can resume it. tmp: tabs only.
  const tabStableKey = new Map<string, string>();
  // Each tab's TRUSTED, backend-independent workflow identity (server-observed origin +
  // durable per-instance uuid). Two uses (#570): (1) the migration discriminator — tell a
  // same-socket tab-id migration of ONE workflow (identity unchanged) from a SWITCH to a
  // different workflow (identity changed), so we never rebind one workflow's agent onto
  // another (P0a); (2) the set_backend recompute — a provider switch never re-hellos, so
  // the stable key (which encodes the backend) is recomputed from this identity, else the
  // new provider's onSession would persist under the old backend's key. Tracked for every
  // tab with a valid identity; cleared when the identity is absent/untrusted.
  const tabStableIdentity = new Map<string, { origin: string; uuid: string }>();
  // The UUID stamped on the NEXT panel command. Normally this exactly mirrors
  // tabStableIdentity from hello. #716 intentionally lets a successful explicit
  // open/re-pin refresh only this command fence before the next hello arrives;
  // session ownership remains hello-bound so a command reply can never silently
  // retarget durable conversation state.
  const tabCommandWorkflowUuid = new Map<string, string>();
  const workflowTargets = new WorkflowTargetStore();
  // Monotonic per-tab sequence for set_workflow_target events. A pinned target is
  // validated asynchronously (resolvePinTarget queries workflow_list), so a later event
  // (another pin, or a synchronous mode:"current") can arrive before the async pin
  // commits. Each event bumps the tab's sequence; a pinned resolution only commits/acks if
  // its captured sequence is still the latest — otherwise a stale pin would clobber the
  // user's newer selection (codex race).
  const workflowTargetSeq = new Map<string, number>();
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
  // Our own build versions, auto-stamped into the agent's ENV block so bug
  // reports are version-pinned without the agent digging. mcp version is a local
  // fact; panel version is learned from the panel's `hello` frame (below) and, on
  // first sight, triggers an env refresh so the block picks it up.
  const mcpVersion = detectInstallMode().currentVersion ?? undefined;
  let latestPanelVersion: string | undefined;
  let panelSystemAppend = resolvePrompt("panel.persona", PANEL_SYSTEM_APPEND);
  // Set once the manager exists so a later refresh (after a ComfyUI restart) feeds
  // the freshly-gathered env into newly-spawned agents too — Claude reads
  // manager.opts.systemAppend at each spawn; Codex reads the closed-over
  // panelSystemAppend at each makeBackend(). Updating both keeps the providers in
  // sync without rebuilding the manager.
  let liveManager: PanelAgentManager | undefined;
  // Generation guard: refreshes can overlap (ComfyUI reconnect + a panel hello
  // carrying a new panel_version). Without this, an OLDER gather finishing LAST
  // would clobber envCaps with stale values — and since latestPanelVersion has
  // already advanced, later identical hellos dedupe and never repair it. So each
  // call takes a ticket and only the newest-started refresh may publish its result.
  let envRefreshGen = 0;
  async function refreshEnvCapabilities(): Promise<void> {
    const gen = ++envRefreshGen;
    try {
      const caps = await gatherEnvCapabilities({ comfyuiUrl, comfyuiPath, backendId, mcpVersion, panelVersion: latestPanelVersion });
      if (gen !== envRefreshGen) return; // a newer refresh superseded us — drop this stale result
      envCaps = caps;
      panelSystemAppend = buildPanelSystemAppend(resolvePrompt("panel.persona", PANEL_SYSTEM_APPEND), envCaps);
      if (liveManager) liveManager.setSystemAppend(panelSystemAppend);
    } catch (err) {
      if (gen !== envRefreshGen) return; // superseded — let the newer refresh own the prompt
      // Belt-and-suspenders: gather is internally guarded, but never let a stray
      // throw break the prompt — fall back to the static append. Also DROP any
      // previously-gathered envCaps so systemAppendForBackend() falls back to the
      // same static append for EVERY backend (not just the default) — otherwise a
      // non-default backend would rebuild a stale env block off the old caps,
      // disagreeing with the reset panelSystemAppend (#358 wiring).
      envCaps = undefined;
      panelSystemAppend = resolvePrompt("panel.persona", PANEL_SYSTEM_APPEND);
      logger.debug(
        `[panel-orchestrator] env-capabilities probe failed (using static prompt): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // The ENVIRONMENT block's `Backend:` line must name the provider running THIS
  // tab's turn, not the process default (#358). Backends are per-tab now, so the
  // single `panelSystemAppend` (built with the default backend id) would tell a
  // Grok tab it's Claude. Rebuild the block per-tab-backend: same env facts, but
  // the backend label recomputed from the tab's actual backend id. Falls back to
  // the shared append when the env probe produced nothing (envCaps undefined).
  const systemAppendForBackend = (bId: string): string => {
    if (!envCaps) return panelSystemAppend;
    const { backend, otherBackendAvailable } = resolveBackends(bId);
    // Already the default's label → reuse the shared string (no rebuild).
    if (envCaps.backend === backend && envCaps.otherBackendAvailable === otherBackendAvailable) {
      return panelSystemAppend;
    }
    return buildPanelSystemAppend(
      resolvePrompt("panel.persona", PANEL_SYSTEM_APPEND),
      { ...envCaps, backend, otherBackendAvailable },
    );
  };

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
      `[panel-orchestrator] env: OS=${envCaps.os ?? "?"} GPU=${envCaps.gpu ?? "?"}${typeof envCaps.vramTotalGb === "number" ? ` ${envCaps.vramTotalGb}GB` : ""} torch=${envCaps.torch ?? "?"} cuda=${envCaps.cuda ?? "?"} py=${envCaps.python ?? "?"} comfyui=${envCaps.comfyui ?? "?"} (${envCaps.location ?? "?"}) triton=${envCaps.triton ?? "?"} sage=${envCaps.sageattention ?? "?"} backend=${envCaps.backend ?? "?"} mcp=${envCaps.mcpVersion ?? "?"} panel=${envCaps.panelVersion ?? "?"}`,
    );
  }

  // The BASE comfyui stdio MCP env both providers declare — COMFYUI_URL + progress
  // dir + local mode + pass-through credentials from the orchestrator's own env.
  // A panel-saved tool secret (CIVITAI_API_TOKEN, HF_TOKEN, …) is layered on top
  // by buildComfyuiMcpEnv() at SPAWN time, so the same headless tool surface — and
  // the same secrets — reach either provider.
  // A FUNCTION (not a frozen object) so it always reflects the CURRENT retargeted
  // comfyuiUrl/comfyuiPath — makeHttpBackendMcpServers calls it per (re)spawn.
  // Tabs whose panel Blind toggle is ON (issue #90): their comfyui tool-server
  // spawns get COMFYUI_MCP_BLIND=1 so image-returning tools withhold pixels
  // mechanically. Seeded from `blind` on hello; toggled live via the
  // set_content_mode frame (which respawns the tab's agent at idle so the new
  // env applies). Keyed by tab id (the spawn is per tab, not per backend).
  const blindTabs = new Set<string>();

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
  // #291: spawn comfyui COMPACT for these non-Claude HTTP backends so its ~250
  // tools don't saturate the backend's tool budget and make codex silently drop
  // the panel_* HTTP-MCP tools (overridable via COMFYUI_MCP_TOOL_MODE=full).
  const httpLaneComfyToolMode = resolveHttpLaneComfyToolMode();
  const makeHttpBackendMcpServers = (tabId: string) => ({
    // Headless comfyui MCP (this build) over stdio — same as Claude.
    comfyui: {
      transport: "stdio" as const,
      command: process.execPath, // node
      args: [mcpEntry], // dist/index.js
      // Merge persisted tool secrets at SPAWN time so a respawn picks up a
      // just-saved CIVITAI_API_TOKEN / HF_TOKEN without a process restart.
      // Blind tabs (issue #90) add COMFYUI_MCP_BLIND=1 so the tool server
      // withholds image pixels from the model.
      env: buildComfyuiMcpEnv({
        ...comfyuiBaseEnv(),
        COMFYUI_MCP_TOOL_MODE: httpLaneComfyToolMode,
        ...(blindTabs.has(tabId) ? { COMFYUI_MCP_BLIND: "1" } : {}),
      }),
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

  // ONE code path for the simple OpenAI-compatible api-key providers (glm,
  // moonshot, …): resolve the provider's key + base URL (throws if absent), then
  // build the shared OllamaBackend openai driver pinned to that host/key/model.
  // Collapses the near-identical GlmBackend/MoonshotBackend classes. `kimi` is
  // excluded (simpleKeyProvider filters it) — its OAuth prepare() keeps KimiBackend.
  const makeOpenAiKeyBackend = (
    reg: OpenAiKeyProvider,
    extra: Partial<OllamaBackendDeps> = {},
  ): OllamaBackend => {
    const creds = resolveOpenAiKeyCredentials(reg.id);
    return new OllamaBackend({
      ...extra,
      cwd: comfyuiPath ?? process.cwd(),
      backendId: reg.id,
      model: openAiKeyProviderModel(reg),
      api: "openai",
      host: creds.baseUrl,
      apiKey: creds.apiKey,
    });
  };

  const makeBackend = (key: string): AgentBackend | undefined => {
    const backend = backendOf(key);
    const panelTabId = panelTabOf(key);
    // The ENVIRONMENT block's `Backend:` line must name THIS backend (#358).
    const sysAppend = systemAppendForBackend(backend);
    try {
    if (backend === "codex") {
      return new CodexBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: codexModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    if (backend === "gemini") {
      return new GeminiBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: geminiModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    if (backend === "antigravity") {
      return new AntigravityBackend({
        cwd: comfyuiPath ?? process.cwd(),
        ...(antigravityModel ? { model: antigravityModel } : {}),
        systemAppend: sysAppend,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    if (backend === "pi") {
      // pi has NO MCP client, so it gets NO mcpServers (comfyui/panel tools are
      // unavailable to pi turns — see pi-backend.ts). It runs as a coding/chat
      // agent on the user's own provider. The panel prompt claims panel_*/comfyui
      // tools it can't run, so PI_CAPABILITY_OVERRIDE is passed as capabilityNote
      // — re-asserted on EVERY turn (incl. resume), not folded into the
      // first-turn-only systemAppend (#491 codex P0a-resume).
      return new PiBackend({
        cwd: comfyuiPath ?? process.cwd(),
        ...(piModel ? { model: piModel } : {}),
        ...(piProvider ? { provider: piProvider } : {}),
        systemAppend: sysAppend,
        capabilityNote: PI_CAPABILITY_OVERRIDE,
      });
    }
    if (backend === "grok") {
      return new GrokBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: grokModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    if (backend === "ollama") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: ollamaModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
        ...ollamaDeps(),
      });
    }
    if (backend === "openrouter") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: openrouterModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
        ...openrouterDeps(),
      });
    }
    if (backend === "lmstudio") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: lmstudioModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
        ...lmstudioDeps(),
      });
    }
    if (backend === "llamacpp") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: llamacppModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
        ...llamacppDeps(),
      });
    }
    if (backend === "custom") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: customModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
        ...customDeps(),
      });
    }
    if (backend === "chatgpt") {
      return new ChatGptOAuthBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: chatgptModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    const simpleKeyReg = simpleKeyProvider(backend);
    if (simpleKeyReg) {
      // glm/moonshot (and any future simple api-key provider) share one factory.
      return makeOpenAiKeyBackend(simpleKeyReg, {
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(panelTabId),
      });
    }
    if (backend === "kimi") {
      return new KimiBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: kimiModel,
        systemAppend: sysAppend,
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
        systemAppend: sysAppend,
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
      const simpleKeyReg = simpleKeyProvider(backend);
      pb = simpleKeyReg
        ? makeOpenAiKeyBackend(simpleKeyReg)
        : backend === "codex"
          ? new CodexBackend({ cwd: comfyuiPath ?? process.cwd(), model: codexModel })
          : backend === "chatgpt"
            ? new ChatGptOAuthBackend({ cwd: comfyuiPath ?? process.cwd(), model: chatgptModel })
          : backend === "kimi"
            ? new KimiBackend({ cwd: comfyuiPath ?? process.cwd(), model: kimiModel })
          : backend === "ollama"
            ? new OllamaBackend({ cwd: comfyuiPath ?? process.cwd(), model: ollamaModel, ...ollamaDeps() })
            : backend === "antigravity"
            ? new AntigravityBackend({
                cwd: comfyuiPath ?? process.cwd(),
                ...(antigravityModel ? { model: antigravityModel } : {}),
              })
          : backend === "pi"
            ? new PiBackend({
                cwd: comfyuiPath ?? process.cwd(),
                ...(piModel ? { model: piModel } : {}),
                ...(piProvider ? { provider: piProvider } : {}),
              })
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
  // `panelTab` (when given) layers per-tab spawn env — the Blind content gate
  // (panel issue #90). The tab-less form remains for the static fallback.
  const buildMcpServers = (panelTab?: string) => ({
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
        // Self-scope this tab's downloads so the orchestrator can wake EXACTLY
        // this tab's agent when a download settles (#547) — the child stamps its
        // own COMFYUI_MCP_TAB into each progress row, mirroring COMFYUI_MCP_BLIND.
        ...(panelTab ? { COMFYUI_MCP_TAB: panelTab } : {}),
        // Local mode → enables download_model, apply_manifest (installer packs),
        // and model scans so the agent installs the right way instead of curl.
        ...(comfyuiPath ? { COMFYUI_PATH: comfyuiPath } : forceRemoteEnv()),
        // Blind tab (issue #90): this tab's tool server withholds image pixels.
        ...(panelTab && blindTabs.has(panelTab) ? { COMFYUI_MCP_BLIND: "1" } : {}),
      }),
    },
  });
  const manager = new PanelAgentManager({
    model,
    effort,
    makeBackend,
    comfyuiUrl, // for fetching image bytes to inline into agent turns
    systemAppend: panelSystemAppend,
    // Per-KEY env block so the CLAUDE path (makeBackend returns undefined) still
    // gets the tab's actual backend on its `Backend:` line (#358). Non-claude
    // tabs get it via makeBackend's sysAppend; this covers the built-in default.
    makeSystemAppend: (key) => systemAppendForBackend(backendOf(key)),
    pluginPath: pluginAvailable ? pluginPath : undefined,
    // In-process live-graph MCP for CLAUDE keys only (codex/gemini drive the
    // canvas through the loopback HTTP MCP instead). Bound to the PANEL tab so
    // panel_* tools reach the user's canvas regardless of the composite key.
    makePanelServer: (key) =>
      backendOf(key) === "claude"
        ? createPanelMcpServer(bridge, panelTabOf(key), workflowTargets)
        : undefined,
    mcpServers: buildMcpServers(),
    // Per-KEY factory — the CLAUDE path's spawns must also reflect per-tab state
    // (the Blind gate); the static set above stays as the fallback. Codex-review
    // F1 on issue #90: without this, the default backend bypassed the gate.
    makeMcpServers: (key) => buildMcpServers(panelTabOf(key)),
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
    onSession: (key, sessionId, model) => {
      const panelTab = panelTabOf(key);
      // #570: also persist under the tab's STABLE resume key (unsaved workflows),
      // so a panel reload that regenerates the tmp:<uuid> can still resume this
      // conversation. The manager already persisted under the exact tab key.
      //
      // BACKEND-MATCH GUARD: tabStableKey is tab-wide but encodes the CURRENT backend.
      // A provider switch (set_backend) resets the old agent fire-and-forget, so a
      // late/queued onSession from that retired agent could otherwise write the OLD
      // provider's session under the NEW provider's stable key — a cross-provider
      // wrong-resume. Only persist when this callback's backend is still the tab's
      // current one (the exact-tab store, keyed by the composite key, is unaffected).
      const skey = tabStableKey.get(panelTab);
      if (skey && backendOf(key) === backendForTab(panelTab)) {
        sessionStore.setStable(skey, sessionId, panelTab);
      }
      bridge.push({ type: "session", session_id: sessionId }, panelTab);
      bridge.broadcastTabList(); // a session started/changed → refresh mirror pickers
      // #376: the ready banner was sent at hello with the PRE-init default model.
      // Now the SDK reports the ACTUALLY-resolved model — remember it, then re-send
      // a corrected banner IFF a banner was actually advertised for this tab AND the
      // resolved model differs (bannerCorrection returns null otherwise, so a resume
      // with no prior greeting is never "corrected" and a correct banner never
      // duplicates).
      if (typeof model === "string" && model.trim()) resolvedModelByTab.set(panelTab, model);
      const corrected = bannerCorrection({
        backend: backendForTab(panelTab),
        advertisedLabel: advertisedBannerModel.get(panelTab),
        resolvedModel: model,
        customBaseUrl,
      });
      if (corrected) {
        advertisedBannerModel.set(panelTab, model as string);
        bridge.push({ type: "say", text: corrected }, panelTab);
      }
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
    // PER-TAB start failure (issue #250): a backend that rejects at
    // prepare()/first-connect — an invalid API key 401ing on an OpenAI-dialect
    // provider (moonshot/glm/custom/openrouter), an unreachable endpoint — is a
    // tab-local configuration error, the same class as the keyless ctor path
    // (#209), one step later. Degrade THAT tab only: an honest say naming the
    // provider with check-your-key guidance, plus a degraded ack so the panel
    // shows the real state. The manager already dropped the dead agent, so
    // fixing the key and Disconnect → Connect (or just re-sending) retries
    // cleanly. This must NOT self-exit — a bad moonshot key on one tab was
    // killing healthy sessions on every other tab.
    onStartFailure: (key, message) => {
      // Frame construction (hint selection via the key-provider registry,
      // composite-key → panel-tab split, say + degraded ack + turn:done) lives
      // in start-failure-notice.ts so it is unit-testable (issue #255).
      const { panelTab, backend, frames } = buildStartFailureNotice(key, message, defaultBackend);
      for (const frame of frames) bridge.push(frame, panelTab);
      logger.warn(
        `[panel-orchestrator] tab ${panelTab.slice(0, 8)} (${backend}) agent failed to start — degraded THIS tab only, other tabs unaffected (${message})`,
      );
    },
    // ROOT-CAUSE self-exit (the "bridge open but no panel agent responded" wedge):
    // a tab's agent died fatally — its bounded self-restart loop gave up (the
    // session kept dropping immediately). The orchestrator is alive and the
    // bridge is up, but no agent will ever handshake — exactly the wedge. Exit
    // cleanly so the panel pack's bridge-death → reclaim + sticky-reconnect
    // respawns a FRESH orchestrator, instead of leaving the user staring at the
    // manual "fully restart ComfyUI" warning. Mirrors the uncaughtException exit
    // above (Node's own default on a fatal). Start failures no longer route here
    // (issue #250) — they degrade per-tab via onStartFailure above.
    onAgentFatal: (tabId, reason) => {
      requestSelfExit(`tab ${tabId.slice(0, 8)} ${reason}`);
    },
    // #468 — run-completion journal acks. `key` is the composite agent key; the
    // journal is keyed by the PANEL TAB, so a provider switch (which retires
    // `tab::old` and spawns `tab::new`) can never strand a completion.
    onEventDelivered: (_key, tokens, from) => {
      for (const token of tokens) ackEventToken(token, from);
    },
    onEventUndelivered: (key, tokens, opts) => {
      for (const token of tokens) releaseEventToken(token, opts?.carried === true);
      const panelTab = panelTabOf(key);
      logger.warn(
        `[panel-orchestrator] tab ${panelTab.slice(0, 8)} handed back ${tokens.length} undelivered event(s) — journaled for replay (#468/#486)`,
      );
      // Try again immediately. When the agent is still alive (a stall-abandoned
      // turn, a plain Stop) this re-queues the completion into its next turn;
      // when it is going away, injectEvent refuses and the entry simply stays
      // pending for the next spawn. The refusal path returns false WITHOUT
      // calling back here, so this cannot recurse.
      flushRunCompletions(panelTab);
      flushAskAnswers(panelTab);
    },
    // A fresh agent for this key can take mail now — replay whatever the
    // previous one never delivered.
    onAgentReady: (key) => {
      flushRunCompletions(panelTabOf(key));
      flushAskAnswers(panelTabOf(key));
    },
    sessionStore,
    // #570 P0 — bind each persisted exact session to its tab's FULL trusted workflow
    // identity (server-observed origin + per-instance uuid), so a saved workflow
    // overwritten in place (same tab id, new uuid) OR a copied uuid replayed from a
    // DIFFERENT origin on the same bridge port is detectable. Canonical `origin::uuid`
    // (equality-compared only, so the IPv6-`::` ambiguity is harmless).
    identityForKey: (k: string) => {
      const id = tabStableIdentity.get(panelTabOf(k));
      return id ? `${id.origin}::${id.uuid}` : undefined;
    },
  });
  // Let refreshEnvCapabilities() feed a freshly-gathered env block into agents
  // spawned after a ComfyUI restart/reconnect.
  liveManager = manager;

  // #468 — let the journal pull a still-unread completion back off an agent's
  // queue when it has to WEAKEN that completion's correlation (a reused prompt
  // id, a replaced conversation). The wording is baked in at queue time, so
  // without this the stale copy would still reach the agent claiming to be the
  // run it queued. Only ever removes an injected `completionOnly` item.
  RunCompletions.setRevoker(
    (panelTabId, token) => manager.revokeEvent(agentKeyFor(panelTabId), token),
    (panelTabId) => flushRunCompletions(panelTabId),
  );

  // #486 — capture a VALIDATED ask answer the moment it lands, even when no tool
  // call is left to receive it. This is the whole durability hinge: the bridge's
  // late-reply buffer is only reachable by a caller still polling it, and the
  // failure being fixed is precisely the one where there is none. Only answers to
  // cards THIS journal ticketed are taken — confirm / 18+ consent / secret cards
  // keep their own, deliberately NON-recoverable paths, because a recovered "Yes,
  // go ahead" must never be able to authorise a different destructive operation.
  // The journal itself decides WHEN an answer has become an orphan (the moment it
  // lands with no handler waiting, or the moment the asking handler unwinds
  // without having returned it) and drives the push from there, so no caller has
  // to remember to flush.
  AskAnswers.setFlusher((panelTabId) => flushAskAnswers(panelTabId));
  // …and let it UNSEND a queued answer whose conversation was replaced before the
  // agent read it. The wording ("a question card YOU put up") is baked in at
  // queue time, so without this the fork reads a sentence that is false of it.
  AskAnswers.setRevoker((panelTabId, token) =>
    manager.revokeEvent(agentKeyFor(panelTabId), token),
  );
  // …and let a TOOL-RESULT answer ride the turn its tool call is running inside,
  // so #468's ack-on-carry settles it. Without this the journal has no proof of
  // receipt for the ordinary path and must treat every answer as possibly lost;
  // with it, "the model read this" is a fact and only the genuinely unconfirmed
  // ones are held open (#486).
  // #486 — a `wf:<hash>` tab id names a WORKFLOW, so a second browser tab can
  // take it over. The journal scopes every per-tab debt to whoever is actually
  // holding the key, so the newcomer can neither be told nor settle the
  // departed tab's owed disclosure.
  AskAnswers.setIncarnationResolver((panelTabId) => bridge.tabIncarnation(panelTabId));
  AskAnswers.setTurnAttacher((panelTabId, token) =>
    manager.attachTurnToken(agentKeyFor(panelTabId), token),
  );
  // #486 — the debt map has no ceiling (a bounded store must not decide whether a
  // warning is owed), so it needs a LIFECYCLE end instead: a tab leaving the
  // bridge's connection map surfaces whatever it is still owed and retires it.
  // Journal entries survive — a disconnect is usually a reload.
  // #486 — a DIFFERENT browser tab taking over a recurring `wf:<hash>` key is a
  // CONVERSATION BOUNDARY, exactly like New chat or a provider switch: the
  // newcomer never asked the previous occupant's questions, so its answers must
  // stop being recoverable and stop being pushed. closeAsks downgrades and
  // unsends; it never deletes, so those answers are still reported.
  bridge.setTabTakenOverListener((tabId) => AskAnswers.closeAsks(tabId));
  bridge.setTabGoneListener((tabId, incarnation) => AskAnswers.retireDebt(tabId, incarnation));
  bridge.setLateAskReplySink((askId, result, tabId) => {
    if (!AskAnswers.tracks(askId)) return;
    const entry = AskAnswers.record(askId, result, { tabId });
    logger.info(
      `[panel-orchestrator] tab ${entry.key.slice(0, 8)} — a validated ask answer landed for "${previewQuestion(entry.question)}"; journaled so it survives the tool call that asked (#486)`,
    );
  });

  /**
   * Deliver every journaled run completion for a panel tab (#468).
   *
   * Called on arrival, and again at every later delivery opportunity (a fresh
   * agent spawn). Order is preserved and the loop STOPS at the first refusal, so
   * a completion can never overtake an older one that is still stuck.
   *
   * Nothing here re-correlates: each entry carries the verdict computed when it
   * ARRIVED, so a replay can never be re-attributed to a run that started after
   * it landed. `injectEvent` returning true means only that the agent took it
   * onto its queue — the entry stays in the journal until the turn that carried
   * it ends (onEventDelivered), which is what makes it survive a restart.
   */
  /**
   * Last-ditch disclosure before the process dies (#468).
   *
   * The self-exit paths (agent-fatal, a never-handshaking probe) skip the idle
   * gate on purpose, and the journal does not survive the process — so a
   * completion still journaled here is genuinely lost. Say so, per tab, naming
   * the run: an UNDETERMINED outcome the user can act on beats a promise that
   * silently evaporates. Best-effort and never throws — this runs on the way out.
   */
  let lostCompletionsReported = false;
  function reportLostCompletionsOnExit(): void {
    if (lostCompletionsReported) return; // every exit path calls this; report once
    lostCompletionsReported = true;
    // RENDERS and ANSWERS are kept APART, all the way to the wording. They are
    // lost the same way but they are not the same loss, and their remedies are
    // not interchangeable: a render can be looked up in ComfyUI's history, an
    // answer NEVER can — it only ever existed in this journal, so the only thing
    // the user can do is give it again. Telling someone to check `get_history`
    // for a lost answer names a lever that cannot work, in the one moment they
    // are already dealing with a failure.
    // Three buckets per tab, because the DURABLE RECORD and the CHAT NOTICE are
    // not the same audience. The log is the record of last resort and gets
    // everything, including answers that belong to a conversation that has since
    // been replaced. The notice goes to whoever holds the tab NOW, so a retired
    // conversation's pick may only be COUNTED there — rendering it would make the
    // exit path the last outlet that carries content across a boundary.
    const byTab = new Map<
      string,
      { runs: string[]; answers: string[]; sealed: string[]; withheld: number }
    >();
    const slot = (
      key: string,
    ): { runs: string[]; answers: string[]; sealed: string[]; withheld: number } => {
      const cur = byTab.get(key) ?? { runs: [], answers: [], sealed: [], withheld: 0 };
      byTab.set(key, cur);
      return cur;
    };
    try {
      for (const entry of RunCompletions.allOutstanding()) {
        slot(entry.key).runs.push(describeCorrelation(entry.correlation));
      }
      // #486 — an ask answer the user actually gave that never reached the agent
      // dies with this process exactly as a completion does, and is at least as
      // costly to lose. Carry the ANSWER TEXT, not just the question: it is the
      // one copy left anywhere, and quoting it back is what lets the user confirm
      // it rather than be asked from scratch.
      for (const entry of AskAnswers.allOutstanding()) {
        const line = `“${entry.answer}” (to “${previewQuestion(entry.question)}”)${entry.returned ? " — it went into a tool call whose receipt was never confirmed" : ""}`;
        const bucket = slot(entry.key);
        // The log always gets the text…
        bucket.sealed.push(line);
        // …the notice only when this tab's current holder is the one it was given
        // to. Otherwise it is counted, and the text survives only in the log.
        if (AskAnswers.mayDisclose(entry)) bucket.answers.push(line);
        else bucket.withheld += 1;
      }
      // …and the answers whose only surviving record is a COUNTER, because the
      // journal's bound already destroyed the text. Naming the count is the last
      // thing that keeps that promise; without it the eviction path's "the next
      // delivery will report it" quietly becomes never.
      for (const { key, count } of AskAnswers.outstandingDebt()) {
        slot(key).answers.push(`${count} further answer(s) whose text is already lost`);
      }
    } catch {
      return; // nothing readable — nothing to report
    }
    // LOG FIRST, unconditionally, and SYNCHRONOUSLY. This is the durable half of
    // the disclosure: the chat push below can only reach a CONNECTED tab (an
    // offline one's frame lands in the bridge's missedFrames buffer, which dies
    // with the process moments later), and `bridge` may not even exist yet on a
    // very early fatal.
    //
    // `writeSync` on fd 2, not the logger: `process.stderr.write` is async when
    // stderr is a pipe (the normal case under the ComfyUI launcher), so a
    // `process.exit()` immediately after can terminate with the record still
    // queued and never written. Since the whole in-memory-journal tradeoff rests
    // on "the disclosure always happens", the write it rests on must block.
    // ONE write for every tab, not one per tab: a synchronous write to a full
    // pipe blocks until its reader drains, so the smallest possible number of
    // bytes is the right shape. (Blocking here is the deliberate cost of a
    // guaranteed record — a stderr reader that has stopped consuming is a broken
    // environment, and losing the disclosure would undercut the whole
    // in-memory-journal tradeoff.)
    const record = [...byTab]
      .map(([panelTab, { runs, sealed }]) =>
        [
          `[panel-orchestrator] tab ${panelTab.slice(0, 8)} — exiting with`,
          runs.length
            ? ` ${runs.length} undelivered render result(s), outcome UNDETERMINED: ${runs.join("; ")}.`
            : "",
          sealed.length
            ? ` ${sealed.length} validated user ANSWER(S) that never reached the agent and cannot be looked up anywhere: ${sealed.join("; ")}.`
            : "",
        ].join(""),
      )
      .join("\n");
    // A FILE is the ONLY synchronous sink. A sync write to a PIPE can block
    // indefinitely when its reader has stalled, and blocking here blocks the
    // event loop — so Node can never dispatch the repeated SIGTERM that is
    // supposed to force the exit, and the process becomes unkillable through its
    // handled signals. A regular file always makes progress.
    //
    // There is deliberately NO synchronous fallback. Ranking the two outcomes:
    // an unkillable process is worse than a missing log line, and a stderr
    // `writeSync` in the fallback would reintroduce exactly the hang the file
    // sink exists to avoid. If the file write fails we accept losing the durable
    // record and fall back to the async logger, which can never wedge the exit.
    let recorded = false;
    try {
      appendFileSync(`${lockPath}.lost-completions.log`, `${new Date().toISOString()} ${record}\n`);
      recorded = true;
    } catch {
      // No usable file (a very early fatal, a read-only dir) — console only.
    }
    // Console visibility, always, and always non-blocking.
    logger.error(record);
    if (!recorded) {
      logger.error("[panel-orchestrator] …and no durable sink accepted that record (it may not survive)");
    }
    try {
      for (const [panelTab, { runs, answers, withheld }] of byTab) {
        // Two different losses, two different remedies — never merged.
        const parts: string[] = ["⚠️ The agent backend is being restarted."];
        if (runs.length) {
          parts.push(
            `${runs.length} finished render result(s) could not be delivered (${runs.join("; ")}). ` +
              `Their outcome is UNDETERMINED from the agent's point of view — ask it to check \`get_history\` ` +
              `for those runs once it reconnects rather than assuming it saw them.`,
          );
        }
        if (answers.length) {
          parts.push(
            `${answers.length} answer(s) you gave on a question card never reached the agent: ${answers.join("; ")}. ` +
              `An answer is not a render — there is NO history to look it up in, and the agent has no way to ` +
              `recover it once this restart completes. Please tell it your choice again (or paste the text above) ` +
              `when it comes back.`,
          );
        }
        if (withheld > 0) {
          // Counted, not quoted: these were given to a conversation that has been
          // replaced (a new chat, a rewind, a provider switch, another tab taking
          // this workflow). Their text is in the log, not on this screen.
          parts.push(
            `${withheld} further answer(s) on this tab belong to an earlier conversation that has ` +
              `since been replaced; they were never delivered either, but they are not shown here ` +
              `because they were not given to the conversation you are in now.`,
          );
        }
        bridge.push({ type: "say", text: parts.join(" ") }, panelTab);
      }
    } catch (err) {
      logger.warn(
        `[panel-orchestrator] could not push the lost-completion notice (the log above is the record): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function flushRunCompletions(panelTabId: string): void {
    const key = agentKeyFor(panelTabId);
    const { blockedOn } = RunCompletions.deliverPending(panelTabId, (payload, token) =>
      manager.injectEvent(key, payload, { eventToken: token }),
    );
    if (blockedOn) {
      logger.warn(
        `[panel-orchestrator] tab ${panelTabId.slice(0, 8)} has no live agent for ${describeCorrelation(blockedOn.correlation)} — journaled, replayed when one comes back (#468)`,
      );
    }
  }

  /**
   * Deliver every ORPHANED `panel_ask` answer for a panel tab (#486).
   *
   * An orphan is an answer the user genuinely gave that NO tool call was alive to
   * receive — the `tools/call` that asked had already timed out or been
   * abandoned. Its only remaining channel is the agent's event queue, so it goes
   * through the same durable path a run completion does: correlated once at
   * arrival, replayed at every later delivery opportunity, and cleared only when
   * the turn that carried it ended.
   *
   * Answers that DID reach a tool result are never pushed here — that would
   * double-report every ordinary ask. They stay journaled only so a re-ask of the
   * identical question can recover one whose caller turned out to be dead.
   */
  function flushAskAnswers(panelTabId: string): void {
    const key = agentKeyFor(panelTabId);
    const { blockedOn } = AskAnswers.deliverPending(panelTabId, (payload, token) =>
      manager.injectEvent(key, payload, { eventToken: token }),
    );
    if (blockedOn) {
      logger.warn(
        `[panel-orchestrator] tab ${panelTabId.slice(0, 8)} has no live agent for the user's answer to "${previewQuestion(blockedOn.question)}" — journaled, replayed when one comes back (#486)`,
      );
    }
  }

  /**
   * Route an event token back to the journal that minted it.
   *
   * Two journals now share the agent's one event-token channel (#468 run
   * completions, #486 ask answers), so the prefix is the discriminator: `rc…`
   * and `aa…` respectively. A token from either is safe to hand to the other —
   * both ignore an unknown token — but routing it correctly is what keeps an ack
   * from leaving the real entry outstanding forever.
   */
  function ackEventToken(token: string, from?: { carrier?: string }): void {
    // #486 — the ask journal verifies WHICH agent instance is acking, so a
    // provider switch cannot let the new conversation certify the old one's
    // answer. Run completions have their own turn-marker gate and need none.
    if (token.startsWith("aa")) AskAnswers.ack(token, from);
    else RunCompletions.ack(token);
  }
  function releaseEventToken(token: string, carried: boolean): void {
    if (token.startsWith("aa")) AskAnswers.release(token, { carried });
    else RunCompletions.release(token, { carried });
  }

  // Flag the mobile mirror picker's "session attached" (green) dot from live agents.
  bridge.setHasSessionPredicate((tabId) => manager.hasLiveAgent(agentKeyFor(tabId)));
  // #570 — stamp each dispatched command with the tab's trusted per-instance workflow uuid so
  // the panel declines to APPLY a command it receives after switching to a different workflow
  // (the generation-bound-command leak). Resolved from the CALLER's tab id: during the switch
  // race the retiring tab still maps to its own uuid, so a late command stamps the ORIGIN
  // workflow's uuid and the panel (now showing the new one) fails it closed.
  bridge.setTabWorkflowUuidResolver(
    (tabId) => tabCommandWorkflowUuid.get(panelTabOf(tabId)),
    (tabId, workflowUuid) => {
      // A command reply is useful only while its routed tab still exists, and
      // only when its UUID has the same strict shape/origin binding as hello.
      // Invalid/missing panel data leaves the old stamp in place, causing the
      // existing fail-closed fence to reject a subsequent mutation.
      try {
        if (!bridge.canReach(tabId)) return false;
      } catch {
        return false;
      }
      const panelTab = panelTabOf(tabId);
      const identity = workflowIdentityParts({
        workflowUuid,
        origin: bridge.tabServerOrigin(tabId),
      });
      if (!identity) return false;
      tabCommandWorkflowUuid.set(panelTab, identity.uuid);
      return true;
    },
  );

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
  // Same-URL canonicalization, DEFAULT-PORT-INSENSITIVE but SCHEME-AWARE:
  // strip only the scheme's actual default (:443 for https, :80 for http) —
  // http://h:443 and http://h are NOT the same endpoint (codex finding).
  // Shared by applyComfyuiUrl's dedupe and the control-channel ack check
  // (runpodProxyUrl omits :443 while getComfyUIBaseUrl includes it — codex).
  // ONE implementation with the hello-retarget judge's same-target check so
  // the dedupe and the veto can never disagree (canonComfyuiTargetUrl).
  const canonTargetUrl = (u: string): string => canonComfyuiTargetUrl(u);
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
    if (!host || canonTargetUrl(next) === canonTargetUrl(comfyuiUrl)) return false;
    const prev = comfyuiUrl;
    comfyuiUrl = next;
    comfyuiPath = localPathForTarget(next);
    // Retarget the orchestrator's OWN in-process ComfyUI client too — the direct
    // call_tool path the mobile app uses (list_workflows, get_image, …) goes through
    // getClient(), which caches against the process-start host. Without this, a
    // retargeted orchestrator keeps that client pinned to the old ComfyUI, so mobile
    // list_workflows silently reads the wrong (often empty) library. resetClient()
    // forces getClient() to rebuild against the new host on its next use.
    setComfyuiTarget(next);
    resetClient();
    // The heavy retarget work (QueueMonitor restart, agent MCP-env respawn,
    // env-capability re-probe) runs in the onComfyuiTargetChanged listener
    // fired by setComfyuiTarget above — ONE fan-out for every retarget path
    // (hello, runpod tools, watcher auto-stop/vanish), so they can't drift
    // split-brained again (#269).
    logger.info(
      `[panel-orchestrator] retargeted ComfyUI ${prev} → ${comfyuiUrl} (${isLoopbackUrl(next) ? "local" : "remote"} mode) from panel hello`,
    );
    // #296: the synchronous `localPathForTarget(next)` above can't see the NEWLY
    // targeted panel's base_path, so a retarget to a loopback ComfyUI with no
    // env/auto-detected path lands path-less even though that panel serves it. Kick
    // off a best-effort recovery from the NEW target's status route (fire-and-forget
    // so the retarget stays synchronous). On success — and only if a newer retarget
    // hasn't superseded us mid-fetch — adopt the path and rebuild the comfyui MCP
    // spawn env so each tab's child respawns in LOCAL mode. Skipped entirely when a
    // local path is already set (the common case does no I/O).
    if (!comfyuiPath) {
      void (async () => {
        const recovered = await resolveComfyuiPathForTarget({
          target: next,
          localPath: localComfyuiPath,
          forceRemote: isForceRemoteFlagSet(),
          isLoopback: isLoopbackUrl(next),
        });
        if (!recovered) return;
        // Superseded by a newer retarget while we fetched — do nothing.
        if (canonTargetUrl(comfyuiUrl) !== canonTargetUrl(next)) return;
        if (comfyuiPath === recovered) return;
        comfyuiPath = recovered;
        logger.info(
          `[panel-orchestrator] recovered ComfyUI base_path from panel status route ` +
            `after retarget: ${recovered} (#296).`,
        );
        // Rebuild the comfyui MCP spawn env (now carrying COMFYUI_PATH) and respawn
        // each tab's agent at its next idle so the LIVE child runs in LOCAL mode.
        manager.setMcpServers(buildMcpServers());
        manager.restartAllForMcpEnv();
      })();
    }
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
  const SECRET_RETRY_NUDGE =
    "🔑 The API token you just provided is now active for the comfyui tools — retry the action that needed it (e.g. the download that returned 401).";
  const unsubscribeSecrets = onComfyuiSecretsChanged((change) => {
    manager.setMcpServers(buildMcpServers());
    // EVERY tab's comfyui child needs the new/removed env, so respawn each at its
    // next idle — but SILENTLY (no nudge). The env rebuild is shared; the "retry
    // the action" nudge is not, so it must never broadcast to unrelated tabs.
    // restartAllForMcpEnv() is nudge-preserving, so this can't erase a per-request
    // nudge already queued on another tab (#164).
    manager.restartAllForMcpEnv();
    // NUDGE only the tab whose panel_request_secret this change answers — a
    // Settings slot save, a background token (re)load, or a revoke leaves
    // `requested` false and nudges nothing. The per-tab pending-restart map
    // coalesces, so a repeat event for the same tab can't double-inject (#164).
    const nudgedTab = change.requested && change.tabId ? change.tabId : null;
    if (nudgedTab) manager.restartForMcpEnv(agentKeyFor(nudgedTab), SECRET_RETRY_NUDGE);
    logger.info(
      `[panel-orchestrator] tool secret ${change.requested ? "saved (requested)" : "changed"} → comfyui MCP env updated + agents respawn on idle${nudgedTab ? ` + retry nudge → tab ${nudgedTab.slice(0, 8)}` : ""} (keys: ${comfyuiSecretKeys().join(", ") || "none"})`,
    );
  });

  // An agent-provider secret changed (e.g. the OpenRouter API key set from the
  // panel). Hydrate it into env, drop the cached openrouter probe/model list so
  // the next probe uses the new key, and re-push readiness + models to every
  // live tab so the OpenRouter provider flips to "ready" and lists its models
  // without a reconnect.
  const KEYED_PROVIDERS = ["openrouter", "custom", "glm", "kimi", "moonshot", "minimax"];
  const unsubscribeAgentSecrets = onAgentSecretsChanged(() => {
    hydrateAgentSecretsIntoEnv();
    // A key change can affect ANY keyed provider (OpenRouter/Custom endpoints and
    // the hosted API-key backends GLM / Kimi / Moonshot / MiniMax) — drop each one's cached
    // probe backend + model list so the next probe carries the fresh credentials
    // (and a revoked key immediately stops reading as "ready" from a stale cache).
    for (const b of KEYED_PROVIDERS) {
      modelsByBackend.delete(b);
      const pb = probeBackends.get(b);
      if (pb?.close) void pb.close().catch(() => {});
      probeBackends.delete(b);
    }
    // Cache-drop alone does NOT rotate the key on a LIVE agent: keyed backends
    // capture the credential at construction and keep using the OLD key until
    // rebuilt (#278). So a live tab running a keyed provider must be restarted
    // for the new/revoked key to take effect — a SILENT rebuild at idle (no
    // download-retry nudge; the guard's job was only to stop the spurious nudge
    // + unrelated Claude/Codex restarts, not to stop key rotation).
    for (const [tabId, backend] of tabBackends.entries()) {
      if (KEYED_PROVIDERS.includes(backend)) {
        manager.restartForProviderKey(agentKeyFor(tabId));
      }
    }
    for (const tabId of tabBackends.keys()) {
      pushReadiness(tabId);
      pushModels(tabId);
    }
    logger.info("[panel-orchestrator] provider key saved → readiness + models refreshed + keyed agents rebuilt");
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
    if (backend === "antigravity") return antigravityModel;
    if (backend === "pi") return piModel;
    if (backend === "grok") return grokModel;
    if (backend === "ollama") return ollamaModel;
    if (backend === "openrouter") return openrouterModel;
    if (backend === "lmstudio") return lmstudioModel || undefined;
    if (backend === "llamacpp") return llamacppModel || undefined;
    if (backend === "custom") return customModel || undefined;
    if (backend === "chatgpt") return chatgptModel;
    const reg = openAiKeyProvider(backend);
    if (reg) return openAiKeyProviderModel(reg); // glm / kimi / moonshot
    if (backend === "copilot") return copilotModel;
    return model;
  }
  function pushModels(panelTabId: string): void {
    const backend = backendForTab(panelTabId);
    void ensureModels(backend)
      .then((models) => {
        // `backend` rides on the models frame so the panel's picker reflects the
        // provider THIS tab selected (single-port multi-provider). `current`
        // reports the model this tab will ACTUALLY spawn with: the picker's
        // per-tab override when one is set (set_options survives reconnects
        // of the same tab id), else the backend's configured default —
        // previously the default was always reported, so a reconnecting
        // client's picker showed the wrong current model after a switch. Send
        // even an empty list: the frame advances the #694 session epoch.
        pushModelsFrame(
          bridge,
          panelTabId,
          models,
          manager.modelOverrideFor(agentKeyFor(panelTabId)) ?? currentModelFor(backend),
          backend,
        );
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
      // #694 (epoch-first) — restamp the session epoch IMMEDIATELY on hello,
      // before any async work (model discovery, panel sync, retarget probe).
      // The models frame carries the epoch too, but it awaits async discovery,
      // so a command arriving in the gap could resolve retry_of against the
      // PRIOR process's epoch/journal. This tiny "session_epoch" frame (NEVER
      // "session" — that name is the session_id lifecycle frame) advances the
      // epoch first thing; the panel stamps on any epoch-carrying frame.
      bridge.push(buildSessionEpochFrame(), panelTab);
      // Learn the sidebar panel's version from its hello and, the first time we
      // see it (or when it changes on a panel update), refresh the env block so
      // the agent's ENVIRONMENT line carries the panel version — bug reports get
      // both our versions auto-stamped, no digging.
      const helloPanelVer = (event as { panel_version?: unknown }).panel_version;
      if (typeof helloPanelVer === "string" && helloPanelVer && helloPanelVer !== latestPanelVersion) {
        latestPanelVersion = helloPanelVer;
        void refreshEnvCapabilities();
      }
      // #706 — an npm-orchestrator update can require a newer Registry panel.
      // The panel-sync service owns the ENTIRE safety decision: it re-reads the
      // local install under the panel-op lock, refuses pins/dev installs/shadows
      // and unverifiable scans, and only reports a version it verified on disk.
      // A desktop hello is the first point at which we can both repair an
      // unpinned skew and tell the affected user that ComfyUI must restart. The
      // bridge pins each CURRENT socket's kind on its FIRST hello, so query that
      // trusted session state rather than this raw (and replayable) hello's
      // `headless`. A headless mirror cannot load the desktop extension.
      // #771/#784 — a hello means this tab (and possibly ComfyUI itself) just
      // came back, and the retarget below may still change which server we are
      // talking to. Any earlier on-disk reading could therefore describe a
      // different install, so drop it SYNCHRONOUSLY here, before anything can
      // read it again. During that gap a write refusal falls back to ordinary
      // update guidance instead of certifying a stale reading as "your install
      // is fine, just hard-refresh".
      //
      // UNCONDITIONAL, and deliberately outside the auto-sync branch below: a
      // user who disabled auto-sync still gets write refusals, and a same-URL
      // restart onto a different --base-directory would otherwise leave the
      // previous tree's reading standing with nothing to replace it.
      clearPanelDiskObservation();
      if (
        !bridge.isCurrentHeadless(panelTab) &&
        !isPanelAutoInstallDisabled()
      ) {
        void performPanelSync()
          .then((sync) => {
            // A panel that clears the floor needs no chat noise on every hello.
            // Every other outcome is actionable: synced => restart, pinned =>
            // unpin first, blocked/unknown/dev => its truthful recovery guidance.
            // (#806 renamed this decision from `up-to-date` — the suppression is
            // unchanged, but the value now says what it actually proved: the
            // floor was cleared, NOT that a newer panel does not exist.)
            if (sync.decision === "meets-floor" || sync.decision === "not-applicable") return;
            bridge.push({ type: "say", text: `⚠️ ${sync.message}` }, panelTab);
            logger.info(
              `[panel-orchestrator] panel sync on hello for ${panelTab.slice(0, 8)}: ` +
                `${sync.decision}${sync.synced ? ` (verified ${sync.verifiedVersion ?? "unknown"})` : ""}`,
            );
          })
          .catch((err) => {
            // Never translate a Manager queue/verification failure into success.
            // The explicit tool remains available for diagnosis and retry.
            const detail = err instanceof Error ? err.message : String(err);
            logger.warn(`[panel-orchestrator] panel auto-sync on hello failed: ${detail}`);
            bridge.push(
              {
                type: "say",
                text:
                  `⚠️ Could not automatically sync the ComfyUI-MCP panel; no update was claimed. ` +
                  // #784 — this is pushed to the embedded panel chat, whose
                  // tool set does not include install_panel. Name it only where
                  // it can be invoked.
                  `${
                    panelRecoveryContext().installPanelUsable
                      ? "Run install_panel(action:'status') to inspect it, then retry install_panel(action:'sync') if appropriate."
                      : "Inspect and update the panel pack on the ComfyUI host itself — no tool in this session can do it."
                  } (${detail})`,
              },
              panelTab,
            );
          });
      }
      // Retarget ComfyUI to the URL the browser was served from (window.location),
      // BEFORE the readiness probe so the "ready" ack reflects the right instance —
      // but a hello can arrive from a STALE browser tab on a DEAD instance (E2E
      // finding: a zombie :8189 tab kept retargeting the orchestrator to a corpse
      // and silently breaking every tool that probes the target). The veto
      // (judgeHelloRetarget, #303) protects only a HEALTHY current target: when the
      // current target reads dead too — the ComfyUI restart window — the live
      // tab's hello is trusted instead, so the reconnect correction back to a
      // LOCAL target can never be vetoed into keeping a stale REMOTE one (#756).
      // TRUST: hello.comfyui_url is page-JS-writable, so every apply path is
      // gated on the SERVER-OBSERVED handshake origin (tabServerOrigin — the
      // browser sets it, page JS can't forge it; #509's trusted source, codex
      // gate). Only a corroborated claim gets the no-probe shortcuts and the
      // both-dead recovery; an uncorroborated claim must earn its retarget by
      // answering its probe, and a dead one fails closed. RunPod proxies still
      // skip the probe for corroborated claims (booting pods answer late —
      // readiness is the connector's job).
      const helloUrl = (event as { comfyui_url?: unknown }).comfyui_url;
      void (async () => {
        const verdict = await judgeHelloRetarget({
          helloUrl,
          currentUrl: comfyuiUrl,
          observedOrigin: bridge.tabServerOrigin(panelTab),
          probe: (u) => probeOk(u, 3_000),
        });
        if (!verdict.apply) {
          logger.warn(
            verdict.reason === "vetoed-untrusted"
              ? `[panel-orchestrator] refusing hello retarget to ${verdict.base}: the tab's handshake origin does not ` +
                `corroborate the claimed URL and the claimed instance is unreachable — NOT retargeting on an ` +
                `unverifiable claim (keeping ${comfyuiUrl})`
              : `[panel-orchestrator] ignoring hello retarget to unreachable ${verdict.base} (stale tab on a dead instance?) — keeping ${comfyuiUrl}`,
          );
          return;
        }
        if (verdict.reason === "current-also-unreachable") {
          logger.info(
            `[panel-orchestrator] hello target ${verdict.base} and current target ${comfyuiUrl} are BOTH unreachable ` +
              `(ComfyUI restart window?) — trusting the live tab's origin-corroborated hello rather than pinning a stale target (#756)`,
          );
        }
        applyComfyuiUrl(helloUrl);
      })();
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
      // Tab-id migration (issue #210): the BRIDGE stamps `migrated_from` on a
      // hello when the SAME socket re-helloed under a new tab id (panel update
      // changed the id scheme, e.g. random UUID → tmp:/wf:). That same-socket
      // signal is the only safe rebind trigger — a workflow-title heuristic
      // would steal agents across identically-titled tabs (two "Unsaved
      // Workflow" tabs are routine). Rebind the old id's agent so the
      // conversation survives instead of orphaning on a dead tab id.
      const migratedFrom =
        typeof (event as { migrated_from?: unknown }).migrated_from === "string"
          ? ((event as { migrated_from?: string }).migrated_from as string)
          : undefined;
      // #570 P0a: compute this hello's TRUSTED, backend-independent workflow identity
      // up front — the discriminator for the migration decision below AND (for tmp:
      // tabs) the resume-key seed further down. serverOrigin is the unspoofable
      // handshake origin; helloUuid is the panel's durable per-instance uuid.
      const serverOrigin = bridge.tabServerOrigin(panelTab);
      const helloUuid =
        typeof (event as { workflow_uuid?: unknown }).workflow_uuid === "string"
          ? ((event as { workflow_uuid?: string }).workflow_uuid as string)
          : undefined;
      const newIdentity = workflowIdentityParts({ workflowUuid: helloUuid, origin: serverOrigin });
      // #570 P0 — the tab's identity from its PRIOR hello, captured BEFORE the migration
      // block / post-block overwrite of tabStableIdentity. For an IN-PLACE workflow
      // replacement (same tab id, new uuid) this is the identity the tab's still-LIVE agent
      // and queued work belong to — needed to reset them even before any durable session
      // record exists (the spawn→first-session window). For a PROVEN same-workflow tab-id
      // migration (tmp:→wf: save/rename) it is REASSIGNED below to the proven source identity:
      // the migrated tab id is brand new (no prior identity) and the rebound agent may still be
      // in its spawn→first-session window (no durable record), so without this the ownership
      // gate would reset the just-rebound agent and drop its queued turn (codex).
      let priorTabIdentity = tabStableIdentity.get(panelTab);

      if (migratedFrom && migratedFrom !== panelTab) {
        const prevBackend = tabBackends.get(migratedFrom) ?? backend;
        const prevIdentity = tabStableIdentity.get(migratedFrom);
        // The bridge stamps migrated_from on ANY same-socket re-hello under a new tab
        // id — it sees SOCKET continuity, not WORKFLOW continuity. That covers a
        // genuine tab-id migration of ONE workflow (tmp:→wf: save, rename, a panel
        // id-scheme upgrade — the durable uuid is UNCHANGED) AND a SWITCH to a
        // DIFFERENT workflow on the same browser tab (a DIFFERENT uuid). #570 P0a:
        // blindly rebinding the old agent onto the new id handed the switched-to
        // workflow the PREVIOUS one's conversation (setResume refuses the new tab's own
        // resume while a rebound agent is live) and persisted it under the new key.
        //
        // FAIL CLOSED: rebind ONLY when BOTH the prior and the new trusted identity
        // exist AND are EQUAL (proven same workflow). Anything else — a different
        // identity (a workflow switch), OR a missing/untrusted identity on either side
        // (an old/degraded panel, a malformed hello) — is treated as a switch: RETIRE
        // the old agent (keeping its durable session for when it's reopened) rather than
        // risk rebinding a different workflow's conversation. A modern panel sends a
        // stable uuid for every workflow, so all its legitimate migrations (save/rename)
        // have equal identity and still rebind; only unprovable cases lose the rebind
        // (a lost resume — hello.resume still covers the common reload — never a wrong
        // one).
        const sameWorkflow =
          prevIdentity !== undefined &&
          newIdentity !== undefined &&
          prevIdentity.uuid === newIdentity.uuid &&
          prevIdentity.origin === newIdentity.origin;
        if (!sameWorkflow) {
          // FENCE the bridge route FIRST: the bridge already installed a fromId→newId
          // alias for this same-socket re-hello, and each panel MCP server stays bound
          // to its original tab id. Revoke it before retiring so a stale / in-flight
          // panel_* call from the old workflow can't resolve through the alias and mutate
          // the newly-selected canvas (codex review) — it fails to route instead, and
          // the retired agent ignores the error.
          bridge.revokeTabMigration(migratedFrom);
          // Complete bridge reset for the OLD id too: its pending in-flight commands, parked
          // reads, and buffered deliveries must be cancelled — the identity-boundary block
          // below runs for panelTab (the NEW id), so without this a reply to a command sent
          // under migratedFrom would still resolve the retired workflow's tool call after the
          // switch (#570 P0). The socket is unchanged, so only queued WORK is dropped.
          bridge.dropQueuedDeliveries(migratedFrom);
          // #468 — the old id's journaled run completions belong to the workflow
          // being switched AWAY from. Carrying them onto an unproven-different
          // workflow would deliver one workflow's render as another's, which is
          // exactly the misattribution the journal exists to prevent. Drop them
          // (logged per entry) rather than migrate them.
          RunCompletions.forget(migratedFrom);
          // #486 — same reasoning for the user's ANSWERS: an answer given to a
          // question the OLD workflow's agent asked must never be recoverable by,
          // or pushed at, the new workflow's conversation. forget() logs every
          // undelivered one, so the loss is disclosed rather than silent.
          AskAnswers.forget(migratedFrom);
          manager.retire(migratedFrom + AGENT_KEY_SEP + prevBackend);
          logger.info(
            `[panel-orchestrator] same-socket re-hello ${migratedFrom.slice(0, 12)} → ${panelTab.slice(0, 12)} without proven workflow continuity — old agent retired (NOT rebound); each workflow keeps its own conversation`,
          );
          // Retire the old id's routing/prefs — do NOT carry them to a different
          // (or unprovable) workflow. The old workflow's durable session stays on disk
          // (retire() preserved it); its stable identity is dropped from the live maps.
          // Messages the user QUEUED during the previous workflow's local render can't
          // be delivered to it now (it's no longer the active socket) without leaking
          // into THIS workflow via the bridge migration alias — so surface an explicit
          // cancellation rather than silently dropping accepted work (codex review).
          // heldDuringGen is keyed by the COMPOSITE tab::backend, and the retired tab may
          // hold queued work under MULTIPLE providers (queued on A, switched provider,
          // then switched workflow) — sweep EVERY backend for migratedFrom, or the
          // onRunEnd flush would later respawn stale work for the switched-away workflow.
          let retiredHeldCount = 0;
          for (const hk of [...heldDuringGen.keys()]) {
            if (panelTabOf(hk) !== migratedFrom) continue;
            retiredHeldCount += heldDuringGen.get(hk)?.length ?? 0;
            heldDuringGen.delete(hk);
          }
          if (retiredHeldCount > 0) {
            bridge.push(
              {
                type: "say",
                text: `⚠️ ${retiredHeldCount} message(s) you queued during the previous workflow's render were cancelled by switching workflows before it finished. Re-send them in that workflow if you still need them.`,
              },
              panelTab,
            );
          }
          tabBackends.delete(migratedFrom);
          headlessTabs.delete(migratedFrom);
          workflowTargets.clear(migratedFrom);
          workflowTargetSeq.delete(migratedFrom);
          tabStableKey.delete(migratedFrom);
          tabStableIdentity.delete(migratedFrom);
          tabCommandWorkflowUuid.delete(migratedFrom);
        } else {
          // #570 — migrate per-backend state for EVERY provider, not only the currently-selected
          // one. A saved workflow can hold a DORMANT session on another backend (used Claude,
          // switched to Codex, then a save/rename changed its wf: tab id while Codex was current):
          // rebindAgent moves the exact durable session (+ pending resume + held mail) even when
          // no live agent exists, so switching back to that provider later still resumes instead
          // of orphaning the old composite key and starting fresh (codex). Only prevBackend can
          // have a LIVE agent (a provider switch retires the others), so at most one rebind is a
          // live-agent move; the rest are durable-only.
          let destinationCollision = false;
          // #468 — the journal purge must happen BEFORE the loop, not after it.
          // manager.reset() inside the loop hands back any run-completion tokens
          // parked in that provider's held mail, and the hand-back callback
          // flushes immediately — into whatever agent currently owns panelTab,
          // which on a collision is the SUPERSEDED destination tab's agent on a
          // different provider. Purging first means there is nothing to hand
          // back. Read-only pre-pass over the same predicate the loop uses, so
          // the two can't disagree about what counts as a collision.
          // #468 CRITICAL — a tab holding ONLY a journal entry is NOT empty. Its
          // agent and durable session may both be gone (New chat) while an
          // undelivered completion for its render is still addressed to it;
          // without counting that the destination reads as unoccupied, the source
          // is rebound onto its id, and the next flush hands the DESTINATION
          // tab's render to the SOURCE tab's conversation.
          // #486 — the ask journal counts too, for exactly the same reason and
          // with a worse failure if it doesn't: a destination whose only state is
          // the user's ANSWER to a question its (now-gone) conversation asked
          // would read as unoccupied, the source would be rebound onto its id,
          // and the next flush would announce the DESTINATION tab's answer to the
          // SOURCE tab's conversation — an answer delivered to a conversation
          // that never asked the question.
          // The eviction DEBT counts as state too: a destination holding only
          // "we dropped N of your answers" is not empty — moveKey would carry
          // that debt under the destination id and the incoming source's agent
          // would be told the DESTINATION tab's answers were lost.
          const destinationJournaled =
            RunCompletions.outstanding(panelTab).length +
            AskAnswers.entriesFor(panelTab).length +
            AskAnswers.droppedFor(panelTab);
          const destinationHadState = [...KNOWN_BACKENDS].some((b) =>
            destinationHasCollisionState({
              hasManagerState: manager.hasAnyState(panelTab + AGENT_KEY_SEP + b),
              hasDurableSession: sessionStore.get(panelTab + AGENT_KEY_SEP + b) !== undefined,
              renderHeldCount: heldDuringGen.get(panelTab + AGENT_KEY_SEP + b)?.length ?? 0,
              journaledCompletionCount: destinationJournaled,
            }),
          );
          // PURGE, never inherit: the destination's completions belong to the tab
          // being superseded, and there is no agent left to deliver them to.
          // forget() logs each one, so the loss is disclosed, not silent.
          if (destinationHadState) {
            RunCompletions.forget(panelTab);
            AskAnswers.forget(panelTab); // #486 — same purge for the superseded tab's answers
          }
          for (const b of KNOWN_BACKENDS) {
            const srcKey = migratedFrom + AGENT_KEY_SEP + b;
            const newKey = panelTab + AGENT_KEY_SEP + b;
            // COLLISION: the destination id already has state for this provider — the same
            // workflow was open in (or previously occupied) TWO tabs, and the incoming socket is
            // migrating onto the other's id. Reset the superseded destination's state for this
            // backend BEFORE moving the source in, so the incoming tab can NEVER inherit it. Cover
            // EVERY kind of destination state, not just a live agent (codex): a LIVE agent
            // (orphaned onto the incoming socket → renders into it), a DORMANT durable session
            // (rebindAgent PRESERVES it when the source has none → the incoming tab resumes the
            // OTHER tab's conversation on a later provider switch), failed-start held mail
            // (rebindAgent APPENDS it to the migrated source mail → delivered into the incoming
            // tab), OR a RENDER-HELD queue (heldDuringGen — orchestrator-level, which manager.reset
            // does NOT clear, and which the source-held re-key below would APPEND to → the
            // superseded tab's queued message would flush into the incoming tab's agent/canvas on
            // render completion). Its socket is already superseded, so its conversation is a lost
            // resume — never a cross-tab leak. Then rebind the incoming source into the freed id.
            if (
              destinationHasCollisionState({
                hasManagerState: manager.hasAnyState(newKey),
                hasDurableSession: sessionStore.get(newKey) !== undefined,
                renderHeldCount: heldDuringGen.get(newKey)?.length ?? 0,
                // #468 — journal state is per PANEL TAB, not per backend, so the
                // same count applies to every provider's key. Counted BEFORE the
                // pre-pass purge above so a journal-only destination still drives
                // the per-backend reset + the bridge-queue drop below.
                journaledCompletionCount: destinationJournaled,
              })
            ) {
              destinationCollision = true;
              manager.reset(newKey);
              heldDuringGen.delete(newKey); // destination's render-held queue — clear BEFORE the source re-key appends to it
              logger.warn(
                `[panel-orchestrator] tab-id migration ${migratedFrom.slice(0, 12)} → ${panelTab.slice(0, 12)} (${b}): destination id already had state (same workflow in two tabs) — reset the superseded destination so the incoming tab can't inherit it (no cross-tab leak)`,
              );
            }
            if (manager.rebindAgent(srcKey, newKey)) {
              logger.info(
                `[panel-orchestrator] tab-id migration: ${migratedFrom.slice(0, 12)} → ${panelTab.slice(0, 12)} (${b}) — agent rebound, conversation preserved`,
              );
            }
          }
          // On a collision the superseded destination tab (panelTab) may also have BRIDGE-buffered
          // frames/renders (missedFrames/mailbox/pending) that the bridge would replay to the
          // incoming socket right after this handler — leaking the destination's activity into the
          // incoming tab. Drop them now (raw tab id). Only the destination's queues live under
          // panelTab; the incoming source's in-flight work is under migratedFrom (its canonical id
          // at send time) and is untouched, so the proven migration's own continuity is preserved.
          if (destinationCollision) bridge.dropQueuedDeliveries(panelTab);
          // #468 — the superseded destination's journal state was already purged
          // above (before anything could hand tokens back); now re-address the
          // INCOMING tab's own completions + run tickets onto the new id.
          RunCompletions.moveKey(migratedFrom, panelTab);
          AskAnswers.moveKey(migratedFrom, panelTab);
          // rebindAgent MOVES the agent rather than spawning one, so onAgentReady
          // never fires for the new id — flush explicitly or the re-addressed
          // entries would sit pending until some unrelated later trigger.
          flushRunCompletions(panelTab);
          flushAskAnswers(panelTab);
          // #570 — carry the PROVEN source identity forward as the tab's prior identity. The
          // rebound agent belongs to it (prevIdentity === newIdentity by sameWorkflow), but the
          // new tab id has no prior identity and the agent may have no durable record yet
          // (spawn→first-session window), so the ownership gate below would otherwise treat it as
          // unproven and reset the just-rebound agent, cancelling its in-flight turn and dropping
          // its queued message. prevIdentity is guaranteed defined here (sameWorkflow requires it).
          priorTabIdentity = prevIdentity;
          // Carry the old tab's runtime prefs to the new id regardless of whether
          // an agent was live (backend pick, headless flag, pinned workflow
          // target, held-during-render queue), then retire the old id.
          if (!tabBackends.has(panelTab) && tabBackends.has(migratedFrom)) {
            tabBackends.set(panelTab, tabBackends.get(migratedFrom)!);
          }
          if (headlessTabs.has(migratedFrom)) headlessTabs.add(panelTab);
          // MOVE the pinned workflow target, don't discard it (codex review).
          const pinned = workflowTargets.get(migratedFrom);
          if (pinned.mode === "pinned") workflowTargets.set(panelTab, pinned);
          // Re-key messages held during a render so the flush reaches the REBOUND agent
          // instead of respawning one under the retired key — for EVERY provider, not just
          // the current one: a message queued while a LOCAL provider was active, then a
          // provider switch, then this (proven same-workflow) migration, would otherwise
          // stay under `migratedFrom::<old provider>` and onRunEnd would `manager.send` it
          // on that retired tab/provider key (a deferred delivery under the wrong key).
          for (const hk of [...heldDuringGen.keys()]) {
            if (panelTabOf(hk) !== migratedFrom) continue;
            const heldOld = heldDuringGen.get(hk)!;
            const heldNewKey = panelTab + AGENT_KEY_SEP + backendOf(hk);
            heldDuringGen.set(heldNewKey, [...(heldDuringGen.get(heldNewKey) ?? []), ...heldOld]);
            heldDuringGen.delete(hk);
          }
          tabBackends.delete(migratedFrom);
          headlessTabs.delete(migratedFrom);
          workflowTargets.clear(migratedFrom);
          // Invalidate any in-flight set_workflow_target(pinned) resolution captured under
          // the retired id: dropping its sequence makes isCurrent() false, so a late async
          // pin can no longer write a stale target / emit a late ack that the bridge's
          // migration map would deliver to the new tab (codex race, tab-id migration edge).
          workflowTargetSeq.delete(migratedFrom);
          // #570: CARRY the stable-key mapping onto the new id — same workflow (identity
          // unchanged), so its resume must survive the tab-id change. For a still-unsaved
          // (tmp:) target the seed block below OVERWRITES it (recomputed for the new
          // backend); for a SAVED (wf:) target the exact key owns resume, so the old
          // unsaved stable session is retired outright.
          const carriedStable = tabStableKey.get(migratedFrom);
          tabStableKey.delete(migratedFrom);
          tabStableIdentity.delete(migratedFrom);
          // #436 — the command stamp is the ONE per-tab map that must NOT be retired
          // here: carry it onto the old id (same uuid — sameWorkflow proved it). See
          // carryWorkflowCommandStamp for why deleting it flapped sessions still
          // bound to the pre-migration id into read-ok / write-refused.
          carryWorkflowCommandStamp(tabCommandWorkflowUuid, migratedFrom, newIdentity!);
          if (carriedStable !== undefined) {
            if (panelTab.startsWith("tmp:")) tabStableKey.set(panelTab, carriedStable);
            else sessionStore.clearStable(carriedStable);
          }
        }
      }

      // #570: record this tab's TRUSTED identity (every tab) for the migration
      // discriminator above and the set_backend recompute below. Absent/untrusted →
      // cleared (fail closed: no proof of continuity → a future migration won't rebind).
      if (newIdentity) {
        tabStableIdentity.set(panelTab, newIdentity);
        tabCommandWorkflowUuid.set(panelTab, newIdentity.uuid);
      } else {
        tabStableIdentity.delete(panelTab);
        tabCommandWorkflowUuid.delete(panelTab);
      }
      // Blind content mode rides the hello (issue #90) so the FIRST agent spawn
      // already carries the right tool-server env. A CHANGE against a live
      // agent also respawns it (codex-review F2: the set_content_mode frame is
      // lost when toggled during a socket drop — the re-hello is the recovery
      // path, so it must enforce, not just record). Runs AFTER the migrated_from
      // rebind so a simultaneous lost-toggle + tab-id migration still finds the
      // (rebound) live agent (review note). Absence = no-op (old panels
      // never send the field; it must not clear a prior state).
      {
        const helloBlind = (event as { blind?: unknown }).blind;
        if (helloBlind === true || helloBlind === false) {
          const changed = helloBlind !== blindTabs.has(panelTab);
          if (helloBlind) blindTabs.add(panelTab);
          else blindTabs.delete(panelTab);
          if (changed && manager.hasLiveAgent(agentKeyFor(panelTab))) {
            manager.restartForMcpEnv(agentKeyFor(panelTab));
            logger.info(
              `[panel-orchestrator] tab ${panelTab.slice(0, 8)} blind=${String(helloBlind)} via hello — live agent respawn queued`,
            );
          }
        }
      }
      const prev = tabBackends.get(panelTab);
      let providerSwitched = false;
      if (prev && prev !== backend) {
        // #570 — Provider switch via re-hello: RETIRE (not reset) the previous provider's
        // agent so it stops lingering but its identity-bound durable session is PRESERVED. A
        // provider switch stays on the SAME workflow, so reset() here would irreversibly lose
        // the prior provider's conversation on an A→B→A re-hello switch (a SAVED wf: workflow
        // has no stable-key fallback) — matching the set_backend path (codex). The NEW provider
        // still starts fresh (the panel replays the transcript as context on its first message).
        manager.retire(panelTab + AGENT_KEY_SEP + prev);
        bridge.broadcastTabList(); // live agent dropped on backend switch → refresh dot
        providerSwitched = true;
      }
      tabBackends.set(panelTab, backend);
      // #468 — retire() handed back any run completion the OLD provider held, but
      // the flush it triggered ran while agentKeyFor() still resolved the OLD
      // backend, so it could only re-journal it. Re-address it now that the tab
      // points at the NEW provider, so the completion reaches the conversation
      // the user actually switched to instead of waiting for their next message.
      if (providerSwitched) flushRunCompletions(panelTab);
      // #486 — a provider switch IS a conversation boundary for QUESTIONS, even
      // though it is deliberately NOT one for renders. A finished render is
      // independently useful to whoever is on the tab now (the images are on the
      // user's canvas either way), which is why #468 re-addresses it here. An
      // ANSWER is not: the incoming provider's fresh conversation never put that
      // card up, so announcing it as "a question card YOU put up" — or letting an
      // identical re-ask recover it — hands one conversation a decision made in
      // another. Retire the asks instead; closeAsks downgrades and unsends, it
      // never deletes, so the answer is still reported.
      if (providerSwitched) AskAnswers.closeAsks(panelTab);
      // A headless client (mobile/remote pseudo-panel, no browser canvas) advertises
      // itself in the hello frame so its agent gets the in-turn-delivery directive.
      if ((event as { headless?: unknown }).headless === true) headlessTabs.add(panelTab);
      else headlessTabs.delete(panelTab);
      const key = panelTab + AGENT_KEY_SEP + backend;

      // #570 P0 — IN-PLACE workflow replacement. The tab-id migration path (above) only
      // fires when the tab id CHANGES. A SAVED workflow keeps its `wf:<path>` tab id when
      // its file is OVERWRITTEN with a DIFFERENT workflow (new embedded uuid) — so the
      // tab-id-keyed exact session record would resume the PRIOR workflow's chat (via
      // spawn's exact-store hit AND an unowned hello.resume). Detect it by the DURABLE
      // identity bound to the exact record: if it names a DIFFERENT trusted uuid than this
      // hello's, the workflow was replaced — clear the stale exact session (and any stale
      // stable entry) so the new workflow starts fresh. Durable, so it holds across an
      // orchestrator restart too.
      {
        // FAIL CLOSED at the identity boundary (#570 P0). ALL of a tab's per-tab state —
        // the LIVE agent, its pending resume + held mail, the durable session, AND the
        // external render-held queue (heldDuringGen) — is trusted (kept) ONLY when the
        // identity it belongs to PROVABLY matches this hello's identity. Otherwise it is a
        // workflow REPLACED in place (same tab id, new uuid), a degraded/unbound record, or
        // a copied uuid from a different origin — TEAR IT ALL DOWN so the new workflow can't
        // inherit the old one's private conversation.
        //
        // Gate on STATE, not on a durable record: a LIVE agent exists in the spawn→first-
        // session window BEFORE any durable session is written (P0a), and render-held work
        // can be queued with no session at all (P0b) — both would otherwise leak into the
        // replacement. The identity the state belongs to is the durable binding (Entry.u),
        // else the tab's identity from its PRIOR hello (captured before we overwrote it) —
        // which is how the no-durable-record live-agent window is covered.
        //
        // INVERTED GATE (#570 P0): decide only whether to KEEP the tab's state, on POSITIVE
        // identity proof — the state's identity AND this hello's identity both present AND
        // equal (origin::uuid). When NOT positively proven (a workflow replaced in place, a
        // cross-origin copied uuid, an unbound pre-`u`/legacy record, OR an identity-less
        // client that can't prove continuity), tear down EVERYTHING for this tab id
        // UNCONDITIONALLY — never gate the teardown on state-presence, because a channel we
        // don't "see" here (a bridge-buffered frame/mailbox item with no manager state) still
        // leaks. The teardown is idempotent (a no-op per empty channel) and covers the COMPLETE
        // channel list so a future channel is swept automatically. This kills the whole
        // "gate missed a channel" class (rebind / cold import / hello.resume / spawn-window /
        // held-gen / bridge buffers were all the same bug). A browser panel always carries a
        // trusted handshake origin so it proves out; only genuinely identity-less (non-browser)
        // or pre-`u`/legacy clients pay a lost resume (never a cross-workflow leak).
        const helloIdentity = newIdentity ? `${newIdentity.origin}::${newIdentity.uuid}` : undefined;
        const priorTabIdentityStr = priorTabIdentity
          ? `${priorTabIdentity.origin}::${priorTabIdentity.uuid}`
          : undefined;
        const stateIdentity = sessionStore.identityOf(key) ?? priorTabIdentityStr;
        const provenOwn =
          stateIdentity !== undefined && helloIdentity !== undefined && stateIdentity === helloIdentity;
        if (!provenOwn) {
          // Tear down every channel for panelTab whose state is NOT provably this workflow's.
          // manager.reset() stops the agent + clears pending resume + held mail + durable
          // session, PER PROVIDER; heldDuringGen is the render-held queue; dropQueuedDeliveries
          // is the bridge's missed frames + mailbox (the bridge defers its on-hello replay until
          // AFTER this handler so this lands first).
          //
          // PER-BACKEND ownership (#570 — codex): the reset must be evaluated per provider, NOT
          // globally off the SELECTED backend. After an orchestrator restart tabStableIdentity is
          // empty, so if the workflow has a persisted Claude session but this first hello selects
          // Codex, a global reset would ERASE Claude's still-valid same-workflow session
          // (irreversible loss on a normal restart + provider switch). A DORMANT backend is KEPT
          // when its DURABLE identity (Entry.u) matches this hello's workflow identity — provider-
          // switch continuity for the SAME workflow survives cold start. The CURRENT backend
          // additionally trusts the tab's PRIOR-hello identity so its spawn-window live agent
          // (no durable record yet) is covered. Everything unmatched/unbound is torn down.
          for (const b of KNOWN_BACKENDS) {
            const bKey = panelTab + AGENT_KEY_SEP + b;
            if (
              keepsBackendState({
                storedIdentity: sessionStore.identityOf(bKey),
                priorIdentity: priorTabIdentityStr,
                isCurrentBackend: b === backend,
                helloIdentity,
              })
            ) {
              continue; // same-workflow session on this provider — keep it resumable
            }
            manager.reset(bKey);
            heldDuringGen.delete(bKey); // render-held work belonging to the torn-down provider
          }
          bridge.dropQueuedDeliveries(panelTab);
          // #468 — this tab id is no longer provably serving the workflow that
          // queued its outstanding runs (replaced in place). Close those tickets
          // so a late completion is reported to whoever holds the tab now as
          // UNDETERMINED instead of "the run YOU queued". Journal ENTRIES are
          // kept: a completion that already arrived is still real news and is
          // still delivered — just no longer as this conversation's own.
          RunCompletions.closeRuns(panelTab);
          // #486 — and the QUESTIONS it asked, for the same reason but with a
          // sharper failure: a card the replaced workflow's agent put up can
          // still be clicked, and without this its answer stays `matched` and
          // gets announced to whoever holds the tab now as "a question card YOU
          // put up" — or recovered as the answer to a byte-identical question the
          // new workflow asks. Retiring the epoch keeps the answer (it is still
          // reported) while revoking its right to answer for anyone else.
          AskAnswers.closeAsks(panelTab);
        }
      }

      // Reload restore: the panel re-sends the last session id it saw. HONOR IT ONLY
      // when it names a session THIS tab's TRUSTED identity already OWNS (#570 P0) — its
      // exact-tab store entry OR its trusted stable-key entry. The panel's DEFAULT
      // panel-scoped chat keeps ONE global session id and re-sends it for EVERY workflow,
      // so a fresh/copied workflow (paste/duplicate/new) would otherwise resume the
      // PREVIOUS workflow's private conversation — the untrusted hello.resume bypasses the
      // uuid boundary. An unowned/unrecognized resume is DROPPED (never armed), so it can
      // NOT short-circuit the stable-key fallback below, which then decides by identity
      // (fresh for a new workflow; the legit same-workflow session for a real reload —
      // that session is stable-key-owned, so it is honored HERE too, including the
      // orchestrator-restart belt-and-suspenders case). Same-provider only. This binds
      // resume to identity: a persistent panel-global chat across workflows would be a
      // separate, separately-authorized feature, not this untrusted path.
      // #570 — does any OTHER connected tab OWN the session behind `candidateKey`? A stable key
      // encodes (workflow identity, backend); a sibling OWNS it when it has the SAME workflow
      // identity AND a RETAINED session on that backend. Ownership is a SET, not a single
      // current-backend mapping: a provider switch RETIRES (preserves) the old provider's session,
      // so a tab keeps owning EVERY backend key whose session it still holds — its CURRENT provider
      // is irrelevant. So derive ownership from the authoritative retained-session state
      // (tabStableIdentity + the durable/live session), per sibling, per backend — the single
      // tabStableKey (current-backend) mapping would MISS a retained old-backend session and let a
      // second honest tab resume it (codex). `candidateBackend` is the backend `candidateKey` was
      // derived for.
      const connectedSiblingOwnsStableKey = (
        candidateKey: string,
        candidateBackend: string,
      ): boolean => {
        for (const t of bridge.tabs()) {
          if (t.tab_id === panelTab) continue;
          const siblingAgentKey = t.tab_id + AGENT_KEY_SEP + candidateBackend;
          // A retained session lives in the durable store (survives a provider-switch retire), in
          // the manager's live/pending/held state (spawn window, failed-start mail), OR in the
          // orchestrator-level render-held queue (heldDuringGen) — the full durable/live/pending/
          // held/render-held owned-set definition.
          const siblingRetainsSession =
            sessionStore.get(siblingAgentKey) !== undefined ||
            manager.hasAnyState(siblingAgentKey) ||
            (heldDuringGen.get(siblingAgentKey)?.length ?? 0) > 0;
          if (
            siblingOwnsStableKey({
              siblingIdentity: tabStableIdentity.get(t.tab_id),
              candidateKey,
              candidateBackend,
              siblingRetainsSession,
            })
          ) {
            return true;
          }
        }
        return false;
      };

      const resumeHint = typeof event.resume === "string" ? event.resume : undefined;
      let armedResume: string | undefined;
      if (resumeHint && (!prev || prev === backend)) {
        const trustedStableKey = newIdentity
          ? deriveStableKey({ workflowUuid: newIdentity.uuid, origin: newIdentity.origin, backend })
          : undefined;
        // The EXACT tab-id session is unique to THIS tab id, so a hello.resume that matches it is
        // always this tab's own — safe to arm. The STABLE-key session is SHARED by every tab of
        // the same workflow identity, so a second tab's panel-scoped hello.resume matching it would
        // attach that tab to — and contend for — a sibling's conversation (codex). Permit a
        // stable-key resume ONLY when no OTHER connected tab OWNS that key's session (current OR
        // retained on any backend). Mirrors the seed-fallback guard below.
        const exactOwned = sessionStore.get(key) === resumeHint;
        const stableOwned =
          trustedStableKey !== undefined && sessionStore.getStable(trustedStableKey) === resumeHint;
        let otherTabHoldsStableKey = false;
        if (stableOwned && !exactOwned && trustedStableKey !== undefined) {
          otherTabHoldsStableKey = connectedSiblingOwnsStableKey(trustedStableKey, backend);
          if (otherTabHoldsStableKey) {
            logger.info(
              `[panel-orchestrator] tab ${panelTab.slice(0, 8)} hello.resume ${resumeHint.slice(0, 8)} matches a stable key ANOTHER connected tab owns (current or retained provider) — dropping (a sibling must start fresh, not join/steal the conversation)`,
            );
          }
        }
        const owned = armableResume({ exactOwned, stableOwned, otherTabHoldsStableKey });
        if (owned) {
          armedResume = resumeHint;
          manager.setResume(key, resumeHint);
        } else {
          logger.info(
            `[panel-orchestrator] tab ${panelTab.slice(0, 8)} hello.resume ${resumeHint.slice(0, 8)} is not owned by this workflow's trusted identity — dropping (won't cross-resume another workflow's chat)`,
          );
        }
      }

      // #570: an UNSAVED workflow's tab id is an ephemeral tmp:<uuid>, regenerated
      // on every panel reload — so on an orchestrator restart that also reloads the
      // panel, the tab returns under a never-stored id and forgets everything
      // (neither our tab-keyed store nor the panel's tab-keyed hello.resume can hit).
      // Anchor a STABLE resume key on an identity that DOES survive that tab's reload:
      // the panel's durable, globally-unique per-instance workflow uuid (see
      // deriveStableKey). Absent a valid uuid we FAIL CLOSED — no disk fallback rather
      // than the collision-prone origin+title key. Saved workflows (wf:<path>) already
      // key stably, so this is tmp:-only.
      if (panelTab.startsWith("tmp:")) {
        // #570 REOPEN: origin+title is NOT unique (unsaved tabs share the default
        // "Unsaved Workflow" title), so it cross-resumed an unrelated same-title
        // workflow. deriveStableKey keys on the panel's durable per-instance uuid +
        // TRUSTED server-observed origin (newIdentity, computed above) — two distinct
        // unsaved workflows can never share it — and yields undefined when no valid
        // uuid / trusted origin, so we skip the disk fallback entirely rather than
        // reuse the buggy legacy key. (tabStableIdentity is already set above.)
        const skey = newIdentity ? deriveStableKey({ workflowUuid: helloUuid, origin: serverOrigin, backend }) : undefined;
        if (skey) {
          tabStableKey.set(panelTab, skey);
          // Seed the resume fallback ONLY when the panel supplied none and no live
          // agent owns the key. spawn() prefers the exact-tab store hit over this
          // pendingResume, so the precise path is never overridden — this only
          // rescues the churned tmp: id. setResume() no-ops if a live agent exists.
          //
          // COLLISION GUARD: with the durable per-instance uuid the key is globally
          // unique, so the ONLY way two tabs share it is the SAME workflow open in two
          // browser tabs. Seed only when NO OTHER connected tab OWNS the key's session —
          // current OR retained on any backend — so a fresh sibling can never resume
          // another tab's conversation (a provider switch RETAINS the old-backend session,
          // so the owned-set check, not a current-backend mapping, is what catches it).
          // When ambiguous we surface fresh — a lost resume is a mild miss; resuming the
          // WRONG conversation is not.
          if (!armedResume && !manager.hasLiveAgent(key) && sessionStore.get(key) === undefined) {
            if (!connectedSiblingOwnsStableKey(skey, backend)) {
              const stableSid = sessionStore.getStable(skey);
              if (stableSid) manager.setResume(key, stableSid);
            }
          }
        } else {
          // No durable identity (old/pre-capability panel or a malformed uuid). This
          // is an identity REGRESSION if the tab previously had a valid uuid: we must
          // RETIRE the session it persisted under that key, not just forget the
          // mapping. Otherwise a later `new_session` (which resolves the stable key via
          // this now-absent mapping) can't clear it, and a subsequent valid-uuid hello
          // would getStable() it back — resurrecting a conversation the user reset (a
          // wrong-resume). Clearing it degrades that to a lost resume instead. Then
          // drop the mapping and take no disk fallback — the panel's hello.resume still
          // covers the common reload; a miss starts fresh.
          const prior = tabStableKey.get(panelTab);
          if (prior) sessionStore.clearStable(prior);
          tabStableKey.delete(panelTab);
          tabStableIdentity.delete(panelTab);
          tabCommandWorkflowUuid.delete(panelTab);
        }
      }

      // Live model list for the picker; SDK slash commands are Claude-only.
      pushModels(panelTab);
      // Truthful provider readiness (this machine runs the agents), so the
      // switcher stops falsely showing "CLI not installed" behind a remote pod.
      pushReadiness(panelTab);
      if (backend === "claude") pushCommands(panelTab);
      bridge.push({ type: "workflow_target", target: workflowTargets.get(panelTab) }, panelTab);
      // #717: panel tray rows belong to the bridge session, while progress files
      // are process-private. Reconcile THIS hello/re-hello directly, including
      // an empty snapshot, rather than waiting for an unrelated future change.
      // This frame is state only: it does not create terminal rows or signal any
      // download outcome.
      bridge.push({ type: "download_progress", downloads: downloadSnapshots.forPanel() }, panelTab);
      // Seed this tab's live queue monitor right away: queue_status broadcasts
      // are change-only, so a tab connecting MID-render would otherwise wait for
      // the next state transition to learn a job is already running.
      bridge.push(buildQueueStatusFrame(QueueMonitor.snapshot()), panelTab);
      // Seed the RunPod control panel too — a tab that just connected gets the
      // current pod-status frame (or a cleared one when nothing is watched).
      const rpFrame = getRunpodWatcher()?.current();
      if (rpFrame) bridge.push(rpFrame, panelTab);
      // Seed any failed auto-connect warnings too — they live SEPARATELY from
      // the watched frame so this tab sees every still-billing failure (codex).
      for (const f of getRunpodWatcher()?.failedFrames() ?? []) bridge.push(f, panelTab);
      // Seed the honest host indicator: tell this tab where renders run now.
      bridge.push({ type: "comfyui_target", url: getComfyUIBaseUrl(), is_local: isTargetingLocalOrLan() }, panelTab);
      // Re-push the last usage so the context meter isn't blank after a reload.
      const lastStatus = manager.lastStatusFor(key);
      if (lastStatus) pushStatus(panelTab, lastStatus);
      const now = Date.now();
      if (now - (lastAckAt.get(panelTab) ?? 0) < ACK_DEBOUNCE_MS) return;
      lastAckAt.set(panelTab, now);
      const isCx = backend === "codex";
      const isCg = backend === "chatgpt";
      const isGm = backend === "gemini";
      const isAg = backend === "antigravity";
      const isPi = backend === "pi";
      const isGk = backend === "grok";
      // glm/kimi/moonshot share one registry-driven ack (label + ready + degraded).
      const reg = openAiKeyProvider(backend);
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
      // pi with no verifiable provider credential: `pi --list-models` prints the
      // built-in catalog with NO key, so the model probe below would "succeed"
      // and greet green-ready — then the first real turn fails. Degrade up front
      // (mirrors the OpenRouter keyless guard) so pi is never falsely ready
      // (#491 codex P1a).
      if (isPi && !piCredentialPresent()) {
        bridge.push(
          {
            type: "say",
            text:
              "⚠️ pi has no usable provider credential — the connection would greet ready and then fail on your first message. " +
              "Configure a provider: set a provider API key (e.g. ANTHROPIC_API_KEY / OPENAI_API_KEY / CEREBRAS_API_KEY) and restart the orchestrator, " +
              "or run `pi` once and `/login` (stored in ~/.pi/agent/auth.json), then Disconnect → Connect. " +
              "If you already did one of those, check the entry is complete — an ~/.pi/agent/auth.json record with no `key`, " +
              "a models.json provider with no `apiKey`, or GOOGLE_APPLICATION_CREDENTIALS pointing at a missing file cannot authenticate. https://pi.dev",
          },
          panelTab,
        );
        bridge.push({ type: "ack", ok: false, kind: "degraded" }, panelTab);
        logger.warn(`[panel-orchestrator] tab ${panelTab.slice(0, 8)} connected (pi) but no verifiable provider credential — degraded ack`);
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
            const agentLabel = reg
              ? (openAiKeyProviderModel(reg) ?? (models[0] as { value?: string }).value ?? reg.ackFallbackLabel)
              : isCx
              ? (codexModel ?? (models[0] as { value?: string }).value ?? "Codex")
              : isCg
                ? (chatgptModel ?? (models[0] as { value?: string }).value ?? "ChatGPT")
              : isGm
                ? (geminiModel ?? (models[0] as { value?: string }).value ?? "Gemini")
                : isAg
                  ? (antigravityModel ?? (models[0] as { value?: string }).value ?? "Antigravity")
                : isPi
                  ? (piModel ?? (models[0] as { value?: string }).value ?? "Pi")
                : isGk
                  ? (grokModel ?? (models[0] as { value?: string }).value ?? "Grok")
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
            // Keyed on the panel's raw hint (whether it BELIEVES it has a thread), not on
            // whether we armed it — an unowned-and-dropped hint still means the panel is
            // showing prior content, so a greeting atop it would be redundant.
            if (!resumeHint) {
              // Prefer an ALREADY-resolved model if the SDK init raced ahead of this
              // greeting (#376) — otherwise the pre-init label. Remember what we
              // advertised so the onSession correction re-sends only on a real
              // mismatch.
              const bannerLabel = resolvedModelByTab.get(panelTab) ?? agentLabel;
              advertisedBannerModel.set(panelTab, bannerLabel);
              bridge.push(
                { type: "say", text: readyBannerText(backend, bannerLabel, customBaseUrl) },
                panelTab,
              );
            }
            bridge.push({ type: "ack", ok: true, kind: "ready", agent: agentLabel, backend }, panelTab);
            logger.debug(`[panel-orchestrator] tab ${panelTab.slice(0, 8)} connected (${backend}) — agent healthy, ready ack`);
          } else {
            const degradedText = reg
              ? reg.degradedMessage
              : isCx
              ? "⚠️ The background agent isn't responding — the Codex app-server couldn't start. Make sure Codex is installed and signed in (run `codex login`), then Disconnect → Connect to retry."
              : isCg
                ? "⚠️ The background agent isn't responding — ChatGPT direct OAuth couldn't start. Make sure ~/.codex/auth.json exists (run `codex login`), then Disconnect → Connect to retry."
              : isGm
                ? "⚠️ The background agent isn't responding — the Gemini CLI couldn't start. Make sure the Gemini CLI is installed and signed in (run `gemini` once and complete the Google sign-in), then Disconnect → Connect to retry."
                : isAg
                  ? "⚠️ The background agent isn't responding — the Antigravity CLI couldn't answer `agy models`. Install it from https://antigravity.google, run `agy` once and complete the Google Sign-In, then Disconnect → Connect to retry."
                : isPi
                  ? "⚠️ The background agent isn't responding — the pi CLI couldn't run `pi --list-models`. Install it from https://pi.dev (`curl -fsSL https://pi.dev/install.sh | sh`), configure a provider (set a provider API key or run `pi` once and `/login`), then Disconnect → Connect to retry."
                : isGk
                  ? "⚠️ The background agent isn't responding — the Grok CLI couldn't start. Make sure Grok is installed and signed in (run `grok` once and complete the xAI sign-in), then Disconnect → Connect to retry."
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
      if (prev !== reqBackend) {
        // #570 — RETIRE, never reset: a provider switch stays on the SAME workflow, so the old
        // provider's session must be PRESERVED (stop its live agent, keep its durable exact
        // record) — otherwise switching back can't resume it. A SAVED (wf:) workflow has NO
        // stable-key fallback (stable keys are tmp:-only), so reset() here would irreversibly
        // destroy its prior-provider conversation on a normal A→B→A switch (codex). retire()
        // stops the agent (so it can't push into the new provider's view) while leaving the
        // identity-bound session on disk, exactly as the same-socket workflow-switch path does.
        manager.retire(panelTab + AGENT_KEY_SEP + prev);
        bridge.broadcastTabList(); // live agent dropped on backend switch → refresh dot
        // #570: the stable resume key ENCODES the backend. This switch never re-hellos,
        // so RECOMPUTE the key for the new provider from the tab's stored identity —
        // otherwise the new backend's onSession would persist its session under the OLD
        // backend's key, and a later reconnect on the old backend would resume the wrong
        // provider's session. No stored identity (old panel / saved tab) → clear the
        // mapping and fail closed until the next hello re-establishes it. The prior
        // backend's own stable entry stays on disk (a legit per-provider session) and is
        // correctly re-derivable if the user switches back.
        // Only tmp: tabs carry a stable RESUME key (saved workflows key on the exact
        // wf: path); tabStableIdentity is tracked for every tab (migration discriminator)
        // so gate the recompute on tmp: to avoid seeding a stable key for a saved tab.
        const ident = panelTab.startsWith("tmp:") ? tabStableIdentity.get(panelTab) : undefined;
        const reBackendKey = ident
          ? deriveStableKey({ workflowUuid: ident.uuid, origin: ident.origin, backend: reqBackend })
          : undefined;
        if (reBackendKey) tabStableKey.set(panelTab, reBackendKey);
        else tabStableKey.delete(panelTab);
      }
      tabBackends.set(panelTab, reqBackend);
      // #468 — the retire() above handed back any run completion the outgoing
      // provider's agent held, but that flush ran while agentKeyFor() still
      // resolved the OLD backend. Re-address it now that the tab points at the
      // new one, so the completion reaches the conversation the user switched to
      // instead of sitting journaled until their next message.
      if (prev !== reqBackend) flushRunCompletions(panelTab);
      // #486 — a provider switch IS a conversation boundary for QUESTIONS, even
      // though it is deliberately NOT one for renders. A finished render is
      // independently useful to whoever is on the tab now (the images are on the
      // user's canvas either way), which is why #468 re-addresses it here. An
      // ANSWER is not: the incoming provider's fresh conversation never put that
      // card up, so announcing it as "a question card YOU put up" — or letting an
      // identical re-ask recover it — hands one conversation a decision made in
      // another. Retire the asks instead; closeAsks downgrades and unsends, it
      // never deletes, so the answer is still reported.
      if (prev !== reqBackend) AskAnswers.closeAsks(panelTab);
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
      // Every target event bumps the tab's sequence so a later selection always wins over
      // an in-flight (async) pin resolution.
      const seq = (workflowTargetSeq.get(panelTab) ?? 0) + 1;
      workflowTargetSeq.set(panelTab, seq);
      const isCurrent = () => workflowTargetSeq.get(panelTab) === seq;
      const ackTarget = (t: ReturnType<typeof workflowTargets.set>) => {
        bridge.push({ type: "ack", ok: true, kind: "workflow_target", target: t }, panelTab);
        bridge.push({ type: "workflow_target", target: t }, panelTab);
        logger.info(
          `[panel-orchestrator] tab ${panelTab.slice(0, 8)} workflow target → ${t.mode}${t.path ? ` (${t.path})` : ""}`,
        );
      };
      // A PINNED target must clear the SAME validation as the MCP tool
      // (panel_set_workflow_target) — otherwise this panel-driven event path would be a
      // bypass that re-admits #556/#571 (background pin) and #259 (not-open pin). Resolve
      // async through the shared helper, failing at pin time before the store is written.
      if (mode === "pinned") {
        void (async () => {
          const ctx = makePanelToolCtx(bridge, panelTab, workflowTargets);
          const res = await resolvePinTarget(ctx, String(path), filename);
          // Superseded by a newer target event while we were validating — drop silently
          // (no write, no late ack) so the newer selection is never clobbered.
          if (!isCurrent()) return;
          if (!res.ok) {
            bridge.push(
              { type: "ack", ok: false, kind: "workflow_target", message: res.error },
              panelTab,
            );
            return;
          }
          ackTarget(
            workflowTargets.set(panelTab, { mode: "pinned", path: res.pinPath, filename: res.pinFilename }),
          );
        })().catch((err) => {
          if (!isCurrent()) return;
          bridge.push(
            {
              type: "ack",
              ok: false,
              kind: "workflow_target",
              message: `Could not pin workflow: ${err instanceof Error ? err.message : String(err)}`,
            },
            panelTab,
          );
        });
        return;
      }
      // mode === "current" — no target to validate; follow the active tab. Writes
      // synchronously and is the latest sequence, so it wins over any in-flight pin.
      ackTarget(workflowTargets.set(panelTab, { mode, path, filename }));
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
        // The panel re-sends set_config on EVERY heartbeat. Only apply + re-push on
        // an ACTUAL change — otherwise re-pushing models makes the panel re-send,
        // which re-pushes… a tight ~150/s feedback loop that wedges the orchestrator
        // (a multi-provider user hit exactly this). Mirror the stall_seconds guard.
        // NORMALIZE the incoming list the SAME way persistence does before comparing,
        // else a payload with whitespace/dupes never equals the stored (normalized)
        // list and re-pushes forever, reviving the loop (#393 follow-up).
        const ids = normalizePreferredModels(
          cfg.preferred_models.filter((m): m is string => typeof m === "string"),
        );
        const prevIds = getAgentSettings().preferredModels ?? [];
        if (ids.length !== prevIds.length || ids.some((v, i) => v !== prevIds[i])) {
          setAgentSettings({ preferredModels: ids });
          ollamaChanged = true;
          logger.info(`[panel-orchestrator] preferred models → [${ids.join(", ")}]`);
        }
      }
      if (cfg.ollama && typeof cfg.ollama === "object") {
        const o = cfg.ollama as { model?: unknown; api?: unknown; base_url?: unknown };
        const patch: { model?: string; api?: "ollama" | "openai"; baseUrl?: string } = {};
        // Only count a field as changed when it's env-unset AND the value actually
        // differs from the current one — so a repeated identical heartbeat config is
        // a no-op (no re-push, no loop). An env override wins and never "changes".
        let changed = false;
        if (typeof o.model === "string" && o.model.trim()) {
          patch.model = o.model.trim();
          if (!process.env.COMFYUI_MCP_OLLAMA_MODEL && patch.model !== ollamaModel) { changed = true; ollamaModel = patch.model; }
        }
        if (o.api === "openai" || o.api === "ollama") {
          patch.api = o.api;
          if (!process.env.COMFYUI_MCP_OLLAMA_API && o.api !== ollamaApi) { changed = true; ollamaApi = o.api; }
        }
        if (typeof o.base_url === "string") {
          patch.baseUrl = o.base_url.trim();
          const nb = patch.baseUrl || undefined;
          if (!process.env.COMFYUI_MCP_OLLAMA_BASE_URL && nb !== ollamaBaseUrl) { changed = true; ollamaBaseUrl = nb; }
        }
        if (Object.keys(patch).length && changed) {
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
        // Change-guard (see preferred_models above): pushReadiness on every heartbeat
        // config is what drives the panel↔orchestrator feedback loop, so only fire on
        // an actual change; an env override wins and never counts as changed.
        let changed = false;
        if (typeof o.model === "string" && o.model.trim()) {
          patch.model = o.model.trim();
          if (!process.env.COMFYUI_MCP_CUSTOM_MODEL && patch.model !== customModel) { changed = true; customModel = patch.model; }
        }
        if (typeof o.base_url === "string") {
          patch.baseUrl = o.base_url.trim().replace(/[/]$/, "");
          if (!process.env.COMFYUI_MCP_CUSTOM_BASE_URL && patch.baseUrl !== customBaseUrl) { changed = true; customBaseUrl = patch.baseUrl; }
        }
        if (Object.keys(patch).length && changed) {
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
        // Name-level whitelist plus, for consolidated tools, action-level scope
        // (see call-tool-admission.ts). The name-refusal string is unchanged.
        const denied = callToolAdmission(tool, toolArgs);
        if (denied !== null) {
          bridge.push({ type: "tool_result", cid, tool, ok: false, error: denied }, tabId);
          logger.warn(`[panel-orchestrator] call_tool rejected: ${denied} (tab ${tabId.slice(0, 8)})`);
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
    //
    // CORRELATION: this handler runs as a detached async task (model discovery
    // + setOptions are awaited), so with several requests outstanding the acks
    // can complete OUT OF ORDER — and used to carry no request identity. A
    // client may stamp the request with an opaque `cid` (NOT `rid` — the
    // ui-bridge consumes any inbound `rid` as a canvas-command reply before it
    // reaches this handler); the ack echoes it verbatim (plus
    // `requested_model`, the pre-guard id) so the client can resolve exactly
    // the attempt each ack answers. See options-ack.ts.
    // Blind toggle (issue #90): record the tab's content mode and, when an
    // agent is live, respawn it at idle so the comfyui tool server restarts
    // with the new COMFYUI_MCP_BLIND env — the same coalesced restart path a
    // saved secret uses. The session resumes; only the tool subprocess env
    // changes.
    if (event.type === "set_content_mode" && event.tab_id) {
      const tabId = event.tab_id;
      const nextBlind = (event as { blind?: unknown }).blind === true;
      const changed = nextBlind !== blindTabs.has(tabId);
      if (nextBlind) blindTabs.add(tabId);
      else blindTabs.delete(tabId);
      const key = agentKeyFor(tabId);
      if (changed && manager.hasLiveAgent(key)) {
        manager.restartForMcpEnv(key);
        bridge.push(
          {
            type: "say",
            text: nextBlind
              ? "🕶️ Blind mode ON — the agent's image tools now withhold pixels (applies after the current turn; the session resumes automatically)."
              : "👁️ Blind mode OFF — the agent's image tools deliver pixels again (applies after the current turn).",
          },
          tabId,
        );
      }
      bridge.push({ type: "ack", ok: true, kind: "set_content_mode", blind: nextBlind }, tabId);
      return;
    }

    if (event.type === "set_options" && event.tab_id) {
      const tabId = event.tab_id;
      const meta = optionsRequestMeta(event as { cid?: unknown; model?: unknown });
      const reqModel = meta.requestedModel;
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
        bridge.push(optionsAckFrame(applied, meta), tabId);
      })().catch((err) => {
        const message = `${err?.message ?? err}`;
        // Legacy contract: old clients only understand the say. A rid-stamped
        // request ALSO gets an ok:false options ack so the correlating client
        // resolves the exact failed attempt instead of waiting out a timeout.
        bridge.push({ type: "say", text: `⚠️ Could not change model/effort: ${message}` }, tabId);
        const errorAck = optionsErrorAckFrame(message, meta);
        if (errorAck) bridge.push(errorAck, tabId);
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
      // Blind tab (issue #90, codex-review F3): strip render pixels at the
      // SERVER boundary too — the desktop panel already drops them client-side,
      // but a mirror viewer (mobile has no Blind concept) can inject
      // agent_event frames with images onto a blinded desktop tab.
      const evForTab = blindTabs.has(event.tab_id) ? { ...ev, images: [] } : ev;
      // #468 — a RUN COMPLETION is a promise `panel_run` made ("end your turn,
      // you WILL be notified"), so it goes through the journal: correlated by
      // exact prompt id ONCE, here, and replayed until the turn that carries it
      // ends. Other agent_event kinds (download_done) keep the old best-effort
      // path — nothing is waiting on them the way a render is.
      if (ev.kind === "executed") {
        // Journal the BLIND-STRIPPED copy: a replay must not resurrect pixels
        // the blind gate removed on arrival. `null` = the panel re-sent a
        // completion this tab was already given; suppressed, never duplicated.
        const entry = RunCompletions.record(event.tab_id, evForTab as CompletionPayload);
        logger.info(
          `[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} run completion for ${describeCorrelation(entry.correlation)}${entry.possibleRepeat ? " (flagged as a possible repeat)" : ""}`,
        );
        flushRunCompletions(event.tab_id);
        return;
      }
      const delivered = manager.injectEvent(agentKeyFor(event.tab_id), evForTab);
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
      // #568 — report what actually happened. An interrupt addressed to a key with no
      // live agent (the tab's agent was retired by an unprovable workflow switch, or the
      // panel is still driving a pre-migration id) reaches nothing: no turn gate is held
      // for it and no release fallback is armed, so nothing will ever "finish". Acking it
      // as a plain success is exactly the could-not/did-not conflation that made the wedge
      // unreadable — the user keeps pressing "send now" against a tab that has no agent.
      // `ok` stays true (the orchestrator DID handle the frame); `interrupted` carries the
      // outcome, and a miss is logged loudly rather than silently.
      // Read the outcome SYNCHRONOUSLY (the manager resolves the key before its first
      // await), so the ack still goes out immediately — a hung backend.interrupt() must
      // never be able to withhold it.
      const reached = manager.hasLiveAgent(agentKeyFor(tabId));
      void manager.interrupt(agentKeyFor(tabId), { requeueInFlight });
      bridge.push({ type: "ack", ok: true, kind: "interrupt", interrupted: reached }, tabId);
      if (reached) {
        logger.info(
          `[panel-orchestrator] tab ${tabId.slice(0, 8)} interrupted${requeueInFlight ? " (send-now: re-queue)" : ""}`,
        );
      } else {
        logger.warn(
          `[panel-orchestrator] tab ${tabId.slice(0, 8)} interrupt reached NO live agent — nothing was cancelled and no recovery is armed (the tab's agent was retired, or the panel is still driving a pre-migration tab id); the next message will spawn a fresh agent`,
        );
      }
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
      // #468 — the conversation that queued this tab's outstanding renders is
      // gone. Close its run tickets so a render it queued, finishing after the
      // New chat, is reported to the replacement agent as UNDETERMINED rather
      // than as "the run YOU queued". Already-arrived completions keep the
      // verdict frozen at their arrival and are still delivered.
      RunCompletions.closeRuns(tabId);
      // #486 — and the questions it asked. The user's answers stay journaled and
      // are still reported, but they lose the fingerprint that let them satisfy a
      // re-ask: an answer given to the previous conversation must never come back
      // to the replacement one as "the answer to the question YOU just asked".
      AskAnswers.closeAsks(tabId);
      // reset() clears the exact-tab store; the stable resume index (#570) is the
      // manager's blind spot, so drop it here too — a deliberate NEW chat must not
      // be resurrected by the unsaved-workflow fallback on the next reload.
      const sk = tabStableKey.get(tabId);
      if (sk) sessionStore.clearStable(sk);
      bridge.push({ type: "session", session_id: null }, tabId);
      bridge.push({ type: "ack", ok: true, kind: "new_session" }, tabId);
      bridge.broadcastTabList(); // session cleared → mirror pickers' green dot off
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
      // #486 — a REWIND is a conversation boundary too, not just New chat and
      // resume: everything after the anchor is discarded, so a question card the
      // dropped branch put up was never asked by the conversation that now
      // exists. Retire this tab's asks so a late click on such a card can neither
      // be announced as "a question card YOU put up" nor recovered as the answer
      // to an identical question the fork asks afresh. The answers themselves are
      // kept and still reported — closeAsks downgrades, it does not delete.
      if (ok) AskAnswers.closeAsks(tabId);
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
      // #468 — same as New chat: the conversation being replaced owns the open
      // runs, so a completion landing after the switch is UNDETERMINED, not the
      // historical session's own render.
      RunCompletions.closeRuns(tabId);
      // #486 — and the questions it asked. The user's answers stay journaled and
      // are still reported, but they lose the fingerprint that let them satisfy a
      // re-ask: an answer given to the previous conversation must never come back
      // to the replacement one as "the answer to the question YOU just asked".
      AskAnswers.closeAsks(tabId);
      if (sid) manager.setResume(key, sid);
      bridge.push({ type: "ack", ok: true, kind: "resume_session" }, tabId);
      bridge.broadcastTabList(); // live agent dropped → refresh mirror pickers
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

    if (event.type !== "user_message" || !event.tab_id) {
      return;
    }
    // A well-behaved panel sends a string `text`, but a structured / multi-part
    // payload must be COERCED here rather than silently dropped: dropping loses
    // the whole turn, and letting a non-string flow downstream interpolates as
    // "[object Object]" in the model prompt (#175). Coerce at ingress so every
    // consumer (echo, batching join, backend preamble) sees a real string.
    if (typeof event.text !== "string") {
      const rawText = (event as { text?: unknown }).text;
      if (rawText == null) return; // nothing to say (image-only turns were never accepted here)
      (event as { text: string }).text = promptText(rawText);
    }
    if (typeof event.text !== "string") return; // coerced above — narrows the type for downstream use
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
    // Blind tab (issue #90): the toggle promises the agent NEVER receives
    // pixels — that includes composer attachments. Withhold them with an
    // honest note (the user can toggle Blind off to share an image).
    const attachedImages = (event as { images?: Array<{ filename: string; subfolder?: string; type?: string }> })
      .images;
    const tabIsBlind = blindTabs.has(event.tab_id);
    if (tabIsBlind && attachedImages?.length) {
      outText += `\n\n[panel note: ${attachedImages.length} image attachment(s) withheld — Blind mode is ON. You cannot see them; ask the user to describe the content or turn Blind off.]`;
    }
    const sendOpts = {
      title: event.title,
      images: tabIsBlind ? undefined : attachedImages,
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
      // Clear the working spinner — the panel's turn handler only recognizes
      // "working" and "done", so the old "idle" frame never cleared it and the
      // spinner ran until the 120s safety timeout (issue #257). But ONLY when no
      // agent turn is actually in flight for this tab: a tab-wide "done" during
      // an ACTIVE earlier turn would hide THAT turn's spinner and disarm its
      // resume nudge (the idle frame was a load-bearing no-op in that case —
      // #260 review). When a turn IS active we push nothing: the live turn's own
      // turn:"done" clears the spinner at the right moment.
      if (!manager.isTurnActive(key)) {
        bridge.push({ type: "turn", state: "done" }, event.tab_id);
      }
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
  // Download-completion agent events (#547). A finished render already wakes the
  // agent (manager.injectEvent kind:"executed"); a finished DOWNLOAD had no
  // equivalent, so a "download then use the model" task stalled until the user
  // poked it. We observe the SAME first-terminal transition the tray-prune timer
  // uses and inject a completion event to the tab's agent — but COALESCED: an
  // apply_manifest that pulls many files would otherwise fire one turn per file,
  // so completions accumulate per agent for a short window and flush as ONE event.
  const DOWNLOAD_DONE_DEBOUNCE_MS = 1500;
  // agentKey → { download identity → {name, terminal status} } accumulated since
  // the last flush, plus the epoch-ms deadline (extended by each new completion)
  // at which we emit. Keyed by download IDENTITY (row.id), not display name, so
  // two distinct downloads sharing a filename in one batch don't overwrite each
  // other and hide a failure (codex).
  // Each pending terminal carries its attempt epoch + (id,target) supersession key so a
  // newer live attempt for the SAME logical download can evict a queued FAILED/done
  // before it fires (panel#489).
  const downloadDonePending = new Map<
    string,
    {
      downloads: Map<string, { name: string; status: string; attempt?: number; supKey: string }>;
      flushAt: number;
    }
  >();
  // Resolve which agent to wake for a settled download row: the stamped tab's
  // agent when it's still live; else the SINGLE live agent (pre-fix/in-process
  // rows carry no tab, AND a tab-id migration/backend change can leave the
  // stamped tab's key no longer resolving to the live agent — codex); else none —
  // never fan out to unrelated tabs (#547).
  const resolveDownloadAgentKey = (row: Record<string, unknown>): string | null => {
    const tab = typeof row.tab === "string" ? row.tab.trim() : "";
    if (tab) {
      const key = agentKeyFor(tab);
      if (manager.hasLiveAgent(key)) return key;
      // Stamped tab's agent is gone (migration/backend switch) — fall through to
      // the single-live-agent fallback rather than silently dropping the event.
    }
    const live = manager.liveKeys();
    return live.length === 1 ? live[0] : null;
  };
  /** Boolean URL probe with a timeout — readiness checks for pending pod connects. */
  const probeOk = async (url: string, timeoutMs = 8_000): Promise<boolean> => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // Carry configured auth (COMFYUI_AUTH_TOKEN / custom header) — a
      // protected pod's ComfyUI 401s otherwise and connect:true always times
      // out (codex finding).
      const res = await fetch(url, { signal: ctl.signal, headers: getComfyUIAuthHeaders() });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };
  // Genuinely-in-flight download rows (set by pollDownloads) — read by the pod
  // idle-stop veto, SCOPED per pod via each row's stamped target (#269).
  let downloadingRows: Array<Record<string, unknown>> = [];
  // create-with-connect pending boot: per-pod pending connects (a second
  // create(connect:true) must not silently displace the first's promise —
  // codex finding: the displaced pod kept billing with no deadline, no
  // notification, and no auto-stop). Any deliberate target event clears ALL
  // of them (the user chose something else) — EXCEPT a readiness-driven
  // completion, which would otherwise wipe its siblings' promises (codex):
  // machineRetargetInFlight distinguishes machine- from user-driven retargets.
  // PERSISTED (user-private config dir): an orchestrator self-restart mid-boot
  // must not strand a promised auto-connect (codex finding — the replacement
  // process gets a fresh progress dir, so in-memory state alone is lost).
  const pendingPodConnects = new Map<string, { url: string; deadline: number; lastProbe: number }>();
  let machineRetargetInFlight = false;
  const pendingConnectsFile = join(homedir(), ".comfyui-mcp", `runpod-pending-connects-${bridgePort}.json`);
  // Port-scope the saved-target file too, and re-restore for a pod boot (the
  // module-init read ran unscoped at import — codex finding).
  rescopeLocalTargetFile(join(homedir(), ".comfyui-mcp", `local-target-${bridgePort}.json`));
  const persistPendingConnects = () => {
    try {
      if (pendingPodConnects.size === 0) {
        unlinkSync(pendingConnectsFile);
        return;
      }
      mkdirSync(dirname(pendingConnectsFile), { recursive: true });
      writeFileSync(pendingConnectsFile, JSON.stringify(Object.fromEntries([...pendingPodConnects].map(([k, v]) => [k, { url: v.url, deadline: v.deadline }]))));
    } catch {
      /* best-effort */
    }
  };
  // Restore promises made before a restart; an already-past deadline fires the
  // honest timeout on the first poll tick. RESTORE on a pod boot OR any
  // self-restart generation (the common create(connect:true) case restarts
  // with the target still LOCAL mid-wait — codex finding: requiring a pod
  // target deleted the promise on the normal self-restart). A deliberate
  // fresh non-pod boot (gen 0) invalidates old pendings instead.
  try {
    const restartGen = Number(process.env.COMFYUI_MCP_RESTART_GEN ?? "0");
    if (!isTargetingPod() && !(restartGen > 0)) {
      if (existsSync(pendingConnectsFile)) {
        logger.info("[panel-orchestrator] discarding saved pending pod auto-connect(s) — this boot selected a non-pod target explicitly");
        unlinkSync(pendingConnectsFile);
      }
    } else {
      const saved = JSON.parse(readFileSync(pendingConnectsFile, "utf-8")) as Record<string, { url: string; deadline: number }>;
      for (const [podId, v] of Object.entries(saved)) {
        if (typeof v?.url === "string" && typeof v?.deadline === "number") {
          pendingPodConnects.set(podId, { url: v.url, deadline: v.deadline, lastProbe: 0 });
        }
      }
      if (pendingPodConnects.size > 0) logger.info(`[panel-orchestrator] restored ${pendingPodConnects.size} pending pod auto-connect(s) from before the restart`);
    }
  } catch {
    // no saved state
  }
  const pollDownloads = () => {
    let files: string[] = [];
    try {
      files = readdirSync(progressDir).filter((f) => f.endsWith(".json"));
    } catch {
      files = []; // dir not created yet — nothing downloading
    }
    const now = Date.now();
    // Phase 1: parse every tray row up front (skip control-channel + corrupt files),
    // so the attempt-supersession map (panel#489) is computed over the WHOLE tray
    // before any terminal row is acted on.
    const parsed: Array<{ full: string; row: Record<string, unknown>; status: unknown; updated: number }> = [];
    for (const f of files) {
      if (f.startsWith(CONTROL_PREFIX)) continue; // control channel, not a download row
      const full = join(progressDir, f);
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
      } catch {
        continue; // mid-write or corrupt — retry next tick
      }
      if (!row || typeof row !== "object") continue;
      const updated = typeof row.updated === "number" ? row.updated : now;
      parsed.push({ full, row, status: row.status, updated });
    }
    // Phase 2: newest attempt epoch per (id, target) (panel#489). A same-URL retry
    // reuses the deterministic id, so this distinguishes attempt N+1 from attempt N's
    // abandoned transfer — while the (id, target) scope keeps a concurrent LOCAL and
    // POD download of the same URL (#269) independent (neither supersedes the other).
    // Dead "downloading" writers (>60s stale) are excluded so a crashed attempt can't
    // shadow a real terminal; terminal rows are always kept (the newer attempt that
    // supersedes may itself have already finished).
    const freshForAttempts = parsed
      .filter((p) => p.status !== "downloading" || now - p.updated <= 60000)
      .map((p) => p.row);
    const newestAttemptByKey = newestAttemptEpochs(freshForAttempts);
    // A newer attempt for an (id, target) invalidates any terminal event STILL PENDING
    // for that same download from an abandoned attempt (the cross-tick case: attempt N's
    // terminal was observed and queued on an earlier poll, then attempt N+1's row
    // appeared). Evict the superseded entry from every agent's debounce bucket so no
    // "download FAILED" turn fires against a download that is actually still progressing.
    for (const bucket of downloadDonePending.values()) {
      for (const [idKey, entry] of bucket.downloads) {
        if (entry.attempt === undefined) continue;
        const newest = newestAttemptByKey.get(entry.supKey);
        if (newest !== undefined && newest > entry.attempt) bucket.downloads.delete(idKey);
      }
    }
    const downloads: Array<Record<string, unknown>> = [];
    for (const { full, row, status, updated } of parsed) {
      // panel#489: a row from a SUPERSEDED attempt (older `attempt` epoch than the newest
      // attempt for this (id, target)) is a late artifact of the abandoned attempt a retry
      // replaced. Drop it entirely — a superseded TERMINAL fires no FAILED/done agent
      // event, and a superseded "downloading" row is kept off the tray + idle-stop veto so
      // it can't contradict or duplicate the live retry. Re-read before unlinking so a
      // writer that replaced the file between the parse above and here isn't clobbered
      // (only remove a file that STILL belongs to a superseded attempt). Per-attempt files
      // mean the retry writes a DIFFERENT file, so both coexist and this is deterministic
      // — never a shared-file race. A genuinely-current row (no newer attempt) is
      // unaffected and still shows/emits.
      if (isSupersededAttempt(row, newestAttemptByKey)) {
        try {
          const cur = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
          if (isSupersededAttempt(cur, newestAttemptByKey)) {
            unlinkSync(full);
            downloadRemoveAt.delete(full);
          }
        } catch { /* gone or mid-write — nothing to remove */ }
        continue;
      }
      if (status === "done" || status === "error") {
        const due = downloadRemoveAt.get(full);
        if (due == null) {
          downloadRemoveAt.set(full, now + DOWNLOAD_LINGER_MS); // start the linger
          // FIRST terminal observation of this download (due was unset) — the
          // exact once-per-download moment. Wake the tab's agent with the result
          // (#547), coalesced via downloadDonePending so a many-file manifest is
          // one turn, not N.
          const key = resolveDownloadAgentKey(row);
          if (key && manager.hasLiveAgent(key)) {
            const bucket =
              downloadDonePending.get(key) ??
              { downloads: new Map<string, { name: string; status: string; attempt?: number; supKey: string }>(), flushAt: 0 };
            // Identify each pending download by its (id, target) supersession key — NOT
            // the id alone: a concurrent LOCAL + POD transfer of the same URL shares an id
            // but must produce TWO #547 outcomes, and the same key lets a newer attempt
            // evict this entry above. Fall back to the file path when the row has no id.
            const supKey = downloadAttemptKey(row) ?? ` ${full}`;
            bucket.downloads.set(supKey, {
              name: String(row.name ?? row.id ?? "model"),
              status: String(status),
              attempt: typeof row.attempt === "number" ? row.attempt : undefined,
              supKey,
            });
            bucket.flushAt = now + DOWNLOAD_DONE_DEBOUNCE_MS;
            downloadDonePending.set(key, bucket);
          }
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
    // Live-download rows for the idle-stop veto (#269): rows surviving the loop
    // above are fresh (dead writers >60s are already unlinked), so a
    // "downloading" row here is genuinely in flight — and a pod mid-download
    // must not count as idle. Self-healing: a crashed writer's row ages out.
    downloadingRows = downloads.filter((d) => d.status === "downloading");
    downloads.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    if (downloadSnapshots.record(downloads)) {
      bridge.push({ type: "download_progress", downloads }); // broadcast to all tabs
    }
    // Flush any download-completion buckets whose debounce window has elapsed —
    // ONE agent event per tab per batch of settled downloads (#547). Runs every
    // tick (700ms) so a flush always fires shortly after the last file settles.
    for (const [key, bucket] of [...downloadDonePending]) {
      if (now < bucket.flushAt) continue;
      downloadDonePending.delete(key);
      const settled = [...bucket.downloads.values()];
      // The bucket can be emptied by the supersession eviction above (panel#489) —
      // a queued terminal cancelled by a newer live attempt. Don't fire an empty
      // "download_done" turn in that case.
      if (settled.length === 0) continue;
      manager.injectEvent(key, { kind: "download_done", downloads: settled });
    }
    // MCP-child control channel (#269): runpod_* tools that ran in spawned
    // agent children ask the orchestrator to retarget / watch / unwatch /
    // auto-connect here — through the SAME applyComfyuiUrl fan-out as a panel
    // hello. Each request is its own file: consumption deletes exactly the
    // file read, so concurrent children can't clobber each other (codex).
    try {
      for (const { req, file } of listTargetChangeRequests(progressDir)) {
        // Apply EVERY request — per-request files make the old timestamp
        // watermark both unnecessary and wrong (two same-millisecond requests
        // — e.g. create's watch + auto-connect — would drop the second, codex
        // finding). A crash between apply and delete replays an idempotent op
        // once on restart; a dropped auto-connect bills an unwatched pod.
        // A `local` request resolves the fallback HERE — the orchestrator owns
        // the learned-LAN memory; the requesting child (spawned post-connect)
        // may know nothing but loopback (codex finding). `onlyIfTarget` guards
        // it: a stale child's stop-fallback applies only when the CURRENT
        // target really is that pod (codex finding — it dragged the target
        // off a newer pod). The ack below reports the resulting URL either
        // way, so the stale child ALIGNS to it.
        const localGuardOk = !req.onlyIfTarget || getComfyUIBaseUrl().includes(req.onlyIfTarget);
        // Generation guard for URL retargets: drop the retarget when a NEWER
        // direct choice moved the target after the child wrote this (codex
        // finding: a queued pod-A request applied after the user picked pod B).
        const urlGenOk = !req.expectedCurrentUrl || canonTargetUrl(getComfyUIBaseUrl()) === canonTargetUrl(req.expectedCurrentUrl);
        // Only an APPLIED target/unwatch choice supersedes pending auto-connects
        // (watch-ONLY isn't a choice; a guarded-OUT or generation-STALE request
        // applied nothing and must not drop a booting pod's promise — codex
        // findings on both axes).
        const appliedChoice = urlGenOk && (!!req.url || ((!!req.local || !!req.unwatch) && localGuardOk));
        if (!req.connectWhenReady && appliedChoice) { pendingPodConnects.clear(); persistPendingConnects(); }
        if (req.local && localGuardOk && urlGenOk) applyComfyuiUrl(getLocalComfyuiUrl());
        else if (req.url && urlGenOk) applyComfyuiUrl(req.url); // dropped when a newer choice superseded it
        if (req.unwatch && localGuardOk && urlGenOk) {
          // Scoped for stop-fallbacks: only the stopped pod's own watch dies
          // (codex finding: stopping A killed unrelated watched B).
          if (req.unwatchPodId) {
            const w = getRunpodWatcher();
            if (w?.watchedPodId() === req.unwatchPodId) w.unwatch();
          } else {
            getRunpodWatcher()?.unwatch();
          }
        }
        // A confirmed stop clears the pod's recorded auto-connect failure —
        // including the spawned-child case, where the caller had no watcher
        // of its own (codex finding: stopped pods kept "billing" forever).
        // And it CANCELS any pending auto-connect for it — otherwise the
        // readiness loop could still retarget to a just-stopped pod, or warn
        // about a timeout for a pod the user deliberately stopped (codex).
        if (req.stoppedPodId) {
          getRunpodWatcher()?.clearConnectFailed(req.stoppedPodId);
          if (pendingPodConnects.delete(req.stoppedPodId)) persistPendingConnects();
        }
        if (req.watchPodId) {
          // Boot-status arm for a create: never displace the ACTIVE render
          // target's watch — its idle auto-stop / dead-target cleanup is the
          // billing guard (codex finding: creating pod B while rendering on
          // pod A left A unguarded and billing indefinitely). The new pod gets
          // watched when its pending connect completes (it becomes the target).
          const w = getRunpodWatcher();
          const cur = w?.watchedPodId();
          const curIsActiveTarget = !!cur && !isTargetingLocal() && getComfyUIBaseUrl().includes(cur);
          if (!(curIsActiveTarget && cur !== req.watchPodId)) w?.watch(req.watchPodId);
        }
        // Whether the watch request actually LANDED (the guard above may have
        // refused it) — computed AFTER the attempt; the ack carries it so the
        // child's create result can't claim a watch we rejected (codex finding).
        const watchApplied = !!req.watchPodId && getRunpodWatcher()?.watchedPodId() === req.watchPodId;
        // Whether a URL retarget landed (generation-guarded): the ack must
        // confirm the AUTHORITATIVE retarget before the child reports success
        // (codex finding: rejected writes still read "connected").
        const connectApplied = !!req.url && urlGenOk && canonTargetUrl(getComfyUIBaseUrl()) === canonTargetUrl(req.url);
        if (req.connectWhenReady && urlGenOk) {
          // The ORCHESTRATOR waits for boot (the tool call returned inside the
          // MCP 60s lifetime): probe every ~10s, retarget+watch on ready, and
          // report honestly on deadline — never block the MCP child (codex).
          // Per-pod slot: concurrent creates each keep their own deadline.
          // Generation-guarded: a stale registration must not re-arm after the
          // user already chose a newer target (codex finding).
          pendingPodConnects.set(req.connectWhenReady.podId, {
            url: req.connectWhenReady.url,
            deadline: Date.now() + 8 * 60_000,
            lastProbe: 0,
          });
          persistPendingConnects();
        }
        consumeTargetChange(file);
        // Ack with the RESULTING target ONLY when the requester is waiting —
        // fire-and-forget requests would leak ack files (codex finding). The
        // `applied` flag distinguishes an applied local switch from a guarded
        // skip (onlyIfTarget didn't match — codex finding).
        if (req.wantAck) ackTargetChange(file, getComfyUIBaseUrl(), req.onlyIfTarget ? localGuardOk && urlGenOk : req.url ? connectApplied : req.connectWhenReady ? urlGenOk : req.watchPodId ? watchApplied : true);
      }
    } catch {
      /* best-effort — the next tick retries a partially-written file */
    }

    // Pending create-and-connects: probe each until its pod's ComfyUI answers
    // BOTH readiness endpoints, then retarget through the shared fan-out.
    const reportConnectFailed = async (podId: string, supersededBy?: string) => {
      // HONEST failure frame (codex finding: fabricated watching:true/RUNNING
      // read as a healthy pod while it bills unguarded). Fetch the real state;
      // `watching` reflects whether the single watcher actually follows it.
      let status = "UNKNOWN"; // unconfirmed — never present a terminal state we didn't verify (codex)
      let name: string | null = null;
      let gpu: string | null = null;
      let costPerHr: number | null = null;
      let uptime: number | null = null;
      try {
        const pod = await getPod(podId);
        status = pod?.desiredStatus ?? "TERMINATED";
        name = pod?.name ?? null;
        gpu = pod?.machine?.gpuDisplayName ?? null;
        costPerHr = pod?.costPerHr ?? null;
        uptime = pod?.runtime?.uptimeInSeconds ?? null;
      } catch { /* keep fallbacks */ }
      // RECHECK before installing: a manual connect/stop during the getPod
      // await already resolved this — installing now would resurrect a stale
      // alert on a healthy target (codex finding).
      if (!isTargetingLocal() && getComfyUIBaseUrl().includes(podId)) return;
      // Suppress the alert ONLY for proven terminal/gone states — a booting
      // (CREATED/RESTARTING) or unverifiable (UNKNOWN) pod may still be billing
      // and keeps its warning (codex finding).
      if (status === "EXITED" || status === "TERMINATED" || status === "DEAD" || status === "PAUSED") return;
      const frame = {
        type: "runpod_alert",
        pod_id: podId,
        reason: supersededBy ? "superseded" : "timeout",
        status,
        name,
        gpu,
        cost_per_hr: costPerHr,
        uptime_seconds: uptime,
        ...(supersededBy ? { superseded_by: supersededBy } : {}),
      } satisfies RunpodAlertFrame;
      // Route through the watcher so the failure STICKS (seeds to new tabs and
      // rides later frames until the pod exits — codex finding: a one-shot
      // push lets the only warning evaporate on the next routine poll). The
      // alert channel can't clobber the watched pod's status slot (codex).
      const w = getRunpodWatcher();
      if (w) w.markConnectFailed(podId, frame);
      else void bridge.push(frame);
    };
    for (const [podId, p] of pendingPodConnects) {
      if (Date.now() > p.deadline) {
        pendingPodConnects.delete(podId);
        persistPendingConnects();
        logger.warn(`[panel-orchestrator] pod ${podId} was not ready within 8 minutes — NOT auto-connecting (connect manually with runpod_pod_connect)`);
        // The tool call is long gone and idle auto-stop can't fire on a pod we
        // never connected to (renderingOnPod is false) — the failed pod keeps
        // billing with no visible failure unless we say so (codex finding).
        void reportConnectFailed(podId);
        continue;
      }
      if (Date.now() - p.lastProbe >= 10_000) {
        p.lastProbe = Date.now();
        void (async () => {
          const stats = await probeOk(`${p.url}/system_stats`);
          const queue = stats ? await probeOk(`${p.url}/queue`) : false;
          if (!pendingPodConnects.has(podId) || pendingPodConnects.get(podId) !== p) return; // superseded/cleared
          if (stats && queue) {
            pendingPodConnects.delete(podId);
            persistPendingConnects();
            // A readiness-driven retarget — NOT a user override: siblings'
            // pending connects stay alive through the listener (codex).
            machineRetargetInFlight = true;
            try {
              applyComfyuiUrl(p.url);
            } finally {
              machineRetargetInFlight = false;
            }
            // ONE winner: a second readiness would displace this pod's watch
            // (its idle-stop guard), so competing pending connects are resolved
            // as SUPERSEDED — with an HONEST frame: the loser is UNWATCHED
            // (nothing guards its cost) and connect_failed says why (codex).
            for (const [otherId, other] of pendingPodConnects) {
              pendingPodConnects.delete(otherId);
              persistPendingConnects();
              logger.warn(`[panel-orchestrator] pod ${otherId} auto-connect superseded by pod ${podId} (one active target) — it is UNWATCHED and still billing; stop it to end billing if unused`);
              void reportConnectFailed(otherId, podId);
              void other;
            }
            getRunpodWatcher()?.watch(podId);
            logger.info(`[panel-orchestrator] pod ${podId} ready — auto-connected (${p.url})`);
            void bridge.push({ type: "runpod_connected", pod_id: podId, url: p.url });
          }
        })();
      }
    }
  };
  const downloadTimer = setInterval(pollDownloads, 700);
  downloadTimer.unref?.();

  // ---- Queue-status watcher ----
  // Live render/queue state for every connected tab (the mobile app's live
  // queue monitor). Reuses the QueueMonitor watchdog's snapshot — which covers
  // EVERY ComfyUI job, including browser-queued ones — and broadcasts a
  // `queue_status` frame at most once per second, and ONLY when the state
  // changed, so an idle rig costs the tabs nothing (see
  // services/queue-status-broadcast.ts for the frame shape + throttle contract).
  const queueStatusBroadcaster = createQueueStatusBroadcaster(
    () => QueueMonitor.snapshot(),
    (frame) => void bridge.push(frame),
    () => QueueMonitor.drainCompletions(),
  );
  // Each tick first refreshes the monitor over HTTP (GET /queue + /history
  // tail): on modern ComfyUI (0.28+) the passive watchdog WS carries no
  // prompt_id and no completion events for foreign runs, so the poll is what
  // restores run attribution (#258) and catches runs shorter than the tick
  // (#259). poll() never rejects and self-guards against overlap.
  const queueStatusTimer = setInterval(() => {
    void QueueMonitor.poll().finally(() => queueStatusBroadcaster.tick());
  }, 1000);
  queueStatusTimer.unref?.();

  // RunPod live-status broadcast + idle auto-stop (services/runpod-watch.ts).
  // Polls the WATCHED pod (set by runpod_pod_connect / runpod_watch) every ~15s
  // and pushes a `runpod_status` frame to the panel/mobile control panels; when
  // the connected pod's ComfyUI sits idle past RUNPOD_IDLE_STOP_MINUTES (default
  // 15; 0 disables) it auto-stops the pod to save GPU cost (gpu-cli parity). No
  // pod watched → the poller is a no-op, so this costs an idle rig nothing.
  const runpodIdleStopMinutes = (() => {
    const v = Number(process.env.RUNPOD_IDLE_STOP_MINUTES);
    return Number.isFinite(v) && v >= 0 ? v : 15;
  })();
  initRunpodWatcher({
    push: (frame) => void bridge.push(frame),
    // Persist unresolved connect-failure alerts per port (restart-proof — a
    // self-restart must not lose a still-billing warning, codex finding).
    persistPath: join(homedir(), ".comfyui-mcp", `runpod-connect-failures-${bridgePort}.json`),
    comfyuiIdle: (podId) => {
      const s = QueueMonitor.snapshot();
      // NOT idle while a training job is alive on THIS pod: training isn't a
      // ComfyUI queue job, so the queue alone would call an hours-long LoRA
      // run "idle" and auto-stop the pod mid-flight (P4 guard; review finding
      // on the connector). hasActiveTrainingJob is a probe-free file scan,
      // scoped to the watched pod so a run on another pod doesn't suppress
      // this pod's idle-stop (codex #274). Also NOT idle while THIS POD is
      // downloading — rows are target-stamped by their writer (#269; an
      // unstamped pre-fix row errs toward "busy", the cost-safe direction).
      const podDownloading = downloadingRows.some((d) => {
        const t = typeof d.target === "string" ? d.target : "";
        return t === "" || t.includes(podId);
      });
      return s.connected && !s.running && s.queueDepth === 0 && !podDownloading && !hasActiveTrainingJob("pod", podId);
    },
    // Idle auto-stop only applies to a pod we're actually rendering on: the active
    // ComfyUI target is that pod's proxy (its id appears in the URL). A pod we
    // merely watch while it boots stays local-targeted, so this is false and it is
    // never auto-stopped on the local rig's idleness.
    renderingOnPod: (podId) => !isTargetingLocal() && getComfyUIBaseUrl().includes(podId),
    // The watched pod vanished or was auto-stopped (#269 dead-target cleanup):
    // when renders were pointing AT it, fall back to the local target — via
    // setComfyuiTarget, so the shared retarget fan-out (QueueMonitor, agents,
    // frame) runs too. Not every watched pod is the render target, so guard.
    onPodUnavailable: (goneId) => {
      if (isTargetingLocal() || !getComfyUIBaseUrl().includes(goneId)) return;
      const local = getLocalComfyuiUrl();
      logger.warn(`[panel-orchestrator] pod ${goneId} unavailable while targeted — retargeting local ComfyUI (${local})`);
      // A MACHINE-driven fallback (auto-stop/vanish), not a user override:
      // pending create-and-connects on OTHER pods must survive it — otherwise
      // a booting pod silently loses its promised auto-connect (codex finding).
      machineRetargetInFlight = true;
      try {
        setComfyuiTarget(local);
      } finally {
        machineRetargetInFlight = false;
      }
      resetClient();
    },
    idleStopMinutes: runpodIdleStopMinutes,
  });

  // Boot re-watch (#269 r2): a restart rebuilds the watcher EMPTY — a pod that
  // stayed the ACTIVE target across the restart (its proxy URL is still the
  // configured target) would otherwise get no more heartbeats and self-stop
  // ~20min later even though renders keep flowing. Re-watch it immediately:
  // beats + live status resume, and its dead-man watchdog stays fed.
  const bootPodMatch = getComfyUIBaseUrl().match(/^https:\/\/([a-z0-9]+)-\d+\.proxy\.runpod\.net/i);
  if (bootPodMatch) {
    logger.info(`[panel-orchestrator] re-watching active RunPod target ${bootPodMatch[1]} after restart`);
    getRunpodWatcher()?.watch(bootPodMatch[1]);
  }

  // Money guard (codex #263): the idle predicate above trusts persisted
  // training records blindly (hasActiveTrainingJob is a probe-free file scan),
  // and owner-death reconciliation otherwise only runs via getJob/listJobs —
  // so if the harness that launched a pod training run dies and nobody ever
  // calls train_status again, the stale "running" record would suppress the
  // pod auto-stop FOREVER. Periodically reconcile dead-owner records (probes
  // fire only for dead/stale owners, so a healthy run costs nothing here).
  const trainingReconcileTimer = setInterval(() => {
    void reconcileStaleTrainingJobs()
      .then((n) => {
        if (n > 0) logger.info(`[panel-orchestrator] reconciled ${n} dead-owner training job(s) — pod idle auto-stop unblocked`);
      })
      .catch((err) => {
        logger.debug(`[panel-orchestrator] training reconcile: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, 5 * 60_000);
  trainingReconcileTimer.unref?.();

  // Honest host indicator + RETARGET FAN-OUT: whenever the ComfyUI target moves
  // (RunPod connect, pod stop → local fallback, "Local" switch, panel hello),
  // setComfyuiTarget fires this ONE listener — it repoints everything that was
  // previously left split-brained (#269): QueueMonitor (its WS/polls keep
  // talking to the OLD host), the agent subprocesses' MCP env (respawned via
  // restartAllForMcpEnv), and the env-capability probe, then broadcasts the
  // `comfyui_target` frame so every panel truthfully shows where renders run.
  // Same-URL retargets (a repeated connect to the current target) skip the
  // restart storm and only re-broadcast. Seeded per tab on connect (below) so
  // a fresh tab knows the host without waiting for a switch.
  let lastRetargetUrl: string | null = comfyuiUrl; // seeded: a first same-URL event must not restart everything
  onComfyuiTargetChanged((url, isLocal) => {
    // ANY target event — a change OR a reaffirmation of the current target —
    // supersedes ALL pending auto-connects (codex findings: direct
    // setComfyuiTarget callers bypass applyComfyuiUrl, and an explicit
    // Local/Stop at the SAME target must not let a booting pod steal it back
    // later) — EXCEPT a readiness-driven completion, which must leave its
    // siblings' pending promises intact (codex finding).
    if (!machineRetargetInFlight) { pendingPodConnects.clear(); persistPendingConnects(); }
    if (url !== lastRetargetUrl) {
      lastRetargetUrl = url;
      // Sync the shared target closures FIRST: retargets that did NOT come
      // through applyComfyuiUrl (runpod tools, watcher callbacks) leave them
      // holding the OLD host — and buildMcpServers()/refreshEnvCapabilities()
      // below would rebuild/respawn agents against it (codex finding).
      comfyuiUrl = url;
      comfyuiPath = localPathForTarget(url);
      try {
        QueueMonitor.stop();
      } catch {
        /* best-effort */
      }
      QueueMonitor.start(url);
      manager.setMcpServers(buildMcpServers());
      manager.setComfyuiUrl(url);
      manager.restartAllForMcpEnv();
      void refreshEnvCapabilities();
    }
    // The readvertise timer follows the target too (created only at startup
    // before — a local→pod retarget left the pod unable to learn the bridge
    // URL, codex finding). Cheap no-op for same-url events.
    syncReadvertise(url);
    void bridge.push({ type: "comfyui_target", url, is_local: isLocal });
  });

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
  // Only meaningful for a remote https target with a secure bridge. Driven by
  // syncReadvertise at STARTUP and on every retarget (codex finding: a
  // local→pod retarget later left the timer nonexistent, so the pod could
  // never learn the WSS URL/token — the very deadlock it prevents). The
  // bridge itself is created LAZILY on the first remote target too (a local
  // boot has wantSecureBridge=false — codex finding).
  let readvertiseTimer: ReturnType<typeof setInterval> | null = null;
  // One in-flight setup MAX — concurrent ticks must not each start a tunnel
  // (codex finding: a slow first attempt spawned multiple cloudflared clients).
  let secureBridgeSetup: Promise<void> | null = null;
  // A tokenless primary listener does NOT rule out pod panels: the tunnel gets
  // its OWN token-gated listener (same addListener mechanism the phone-pair
  // flow uses) on a dedicated port — never retrofit auth onto the public path
  // and never open a tunnel in front of an unauthenticated one (codex P1).
  // Port map: +0 bridge, +1 panel_* HTTP-MCP, +2 phone-pair, +3 console (line
  // ~1427), +4 tunnel listener (codex finding: +3 was already taken).
  const tunnelPort = lockPort + 4;
  let tunnelToken: string | null = null;
  let tunnelListenerStarted = false;
  const ensureSecureBridge = async (url: string): Promise<void> => {
    if (secureBridge) return;
    if (!secureBridgeSetup) {
      secureBridgeSetup = (async () => {
        try {
          let port = lockPort;
          let token: string;
          if (bridgeListenerTokenless) {
            // Primary listener stays tokenless for local use; the tunnel binds
            // its own token-gated listener (pair-flow precedent) and advertises
            // THAT token — enforced, because this listener was built with it.
            // Bound ONCE: a retried setup must reuse it, not EADDRINUSE (codex).
            tunnelToken ??= randomBytes(24).toString("hex");
            if (!tunnelListenerStarted) {
              await bridge.addListener("0.0.0.0", tunnelPort, tunnelToken);
              tunnelListenerStarted = true;
            }
            port = tunnelPort;
            token = tunnelToken;
          } else if (bridgeToken) {
            token = bridgeToken;
          } else {
            return; // unreachable — the tokenless branch above covers this
          }
          secureBridge = await setupSecureBridge({
            bridgePort: port,
            comfyuiUrl: url,
            token,
            bridge,
            // The setup itself advertises on completion — guard it too: a slow
            // tunnel must not hand the bridge URL to a pod the user already
            // left (codex finding: the post-await guard alone couldn't stop it).
            shouldAdvertise: (t) => comfyuiUrl === t && isRemoteHttpsUrl(t),
          });
        } catch (err) {
          logger.error(
            `[panel-orchestrator] secure bridge (cloudflared) failed: ${err instanceof Error ? err.message : String(err)}. ` +
              `Install cloudflared (npm i -g cloudflared), or re-run with --insecure-bridge and open the pod through an ` +
              `SSH tunnel (ssh -L 3000:localhost:3000 …) at http://localhost:3000.`,
          );
        } finally {
          secureBridgeSetup = null;
        }
      })();
    }
    return secureBridgeSetup;
  };
  const syncReadvertise = (url: string) => {
    const wanted = !insecureBridge && isRemoteHttpsUrl(url);
    if (wanted && !readvertiseTimer) {
      // Immediate first advertise (creating the tunnel on a local→pod
      // transition), then the interval.
      void (async () => {
        await ensureSecureBridge(url);
        // The user may have moved on while the tunnel came up — advertising an
        // OLD pod now would let its panel hello steal the newer target (codex).
        if (secureBridge && comfyuiUrl === url && isRemoteHttpsUrl(url)) void secureBridge.advertise(url);
      })();
      readvertiseTimer = setInterval(() => {
        void (async () => {
          if (isRemoteHttpsUrl(comfyuiUrl)) {
            await ensureSecureBridge(comfyuiUrl);
            if (secureBridge) void secureBridge.advertise(comfyuiUrl);
          }
        })();
      }, 5000);
      readvertiseTimer.unref?.();
    } else if (!wanted && readvertiseTimer) {
      clearInterval(readvertiseTimer);
      readvertiseTimer = null;
    }
  };
  syncReadvertise(comfyuiUrl);

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
  // Forward declaration — assigned right after teardownCore exists; teardownCore
  // stops its timers so no update-check tick can fire mid-teardown.
  let selfRestarter: SelfRestarter | null = null;
  /** Everything shutdown does EXCEPT exiting — shared with the self-restarter,
   *  which spawns its replacement first and exits itself after this settles. */
  const teardownCore = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[panel-orchestrator] shutting down — stopping agents…");
    // #468 — EVERY exit path discloses, not just the fatal self-exit: an ordinary
    // SIGTERM/SIGINT teardown destroys the in-memory journal just as thoroughly.
    // Runs BEFORE stopAll() so the still-live agents' tabs are still routable for
    // the chat notice. Idempotent (reportLostCompletionsOnExit no-ops the second
    // time), so the self-exit path calling it first is harmless.
    reportLostCompletionsOnExit();
    selfRestarter?.stop();
    clearInterval(downloadTimer);
    clearInterval(queueStatusTimer);
    if (readvertiseTimer) clearInterval(readvertiseTimer);
    QueueMonitor.stop();
    // Remove OUR nonced progress dir (startup reaps previous lives') so the
    // auto-restart cycle doesn't accumulate temp dirs (codex finding).
    try {
      rmSync(progressDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
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
  };
  /** The single in-flight teardown, so repeated signals queue behind it. */
  let teardownOnce: Promise<void> | null = null;
  /** How long a REPEATED shutdown signal waits for the in-flight teardown before
   *  forcing the exit. Long enough for a healthy teardown to finish, short enough
   *  that a hung one can't make the process unkillable via SIGINT/SIGTERM. */
  const FORCED_SHUTDOWN_GRACE_MS = 3000;
  const shutdown = async () => {
    // RE-ENTRANT SAFE (#468). teardownCore's `shuttingDown` flag makes a second
    // call return IMMEDIATELY, so a repeated SIGTERM used to race straight past
    // the in-flight teardown to process.exit() — skipping the undelivered-
    // completion disclosure the first one had not reached yet. Memoize the
    // teardown promise so every later signal AWAITS the first one instead.
    const first = teardownOnce === null;
    teardownOnce ??= teardownCore();
    // …but BOUNDED. A repeated signal is a user asking harder, and awaiting an
    // unbounded teardown would make the process unkillable through its handled
    // signals if anything in it hangs. The first signal waits; a later one gives
    // the in-flight teardown a short grace and then forces the exit. The
    // completion disclosure is unaffected either way — it runs at the TOP of
    // teardownCore, before anything that could block.
    if (first) {
      await teardownOnce;
    } else {
      await Promise.race([
        teardownOnce,
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            logger.warn(
              `[panel-orchestrator] shutdown did not finish within ${FORCED_SHUTDOWN_GRACE_MS}ms of a repeated signal — forcing exit`,
            );
            resolve();
          }, FORCED_SHUTDOWN_GRACE_MS);
          t.unref?.();
        }),
      ]);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Self-updater + self-restarter (orchestrator mode only — an MCP stdio server
  // must never replace itself; its client owns that lifecycle). Dev installs
  // restart when a rebuild lands; published installs re-check npm periodically,
  // update, and restart into the new code. A restart only fires with every
  // agent idle, nothing queued or held, and no render in flight — sessions
  // resume from the durable store and the panel reconnects on its own.
  // Default ON; disable with COMFYUI_MCP_AUTO_UPDATE_DISABLE=1 (restart-only
  // opt-out: COMFYUI_MCP_AUTORESTART=0).
  selfRestarter = new SelfRestarter({
    allIdle: () =>
      manager.allIdle() &&
      // Failed-start held mail (issue #256): teardown erases it, so a restart
      // while it's parked would silently drop the messages awaiting re-delivery.
      // (allIdle() already covers this; kept explicit alongside heldDuringGen so
      // the gate reads as the full "nothing queued or held" contract.)
      !manager.hasHeldMail() &&
      ![...heldDuringGen.values()].some((msgs) => msgs.length > 0) &&
      // Undelivered run completions (#468) are in-memory like the held mail
      // above, so teardown erases them too. A restart while one is journaled
      // would silently drop the render result the agent was promised — exactly
      // the failure this whole path exists to prevent. Wait for it to land.
      !RunCompletions.hasOutstanding() &&
      // …and the same for an ask answer the user actually gave that has not
      // reached the agent yet (#486). Restarting would destroy it silently.
      !AskAnswers.hasOutstanding() &&
      !QueueMonitor.isBusy(),
    announce: (text) => void bridge.push({ type: "say", text }),
    teardown: teardownCore,
  });
  selfRestarter.start();
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
