// Panel orchestrator — a standalone, long-lived process that drives the ComfyUI
// sidebar panel with autonomous BACKGROUND agents, so the user's interactive
// Claude session stays free. Launch with `comfyui-mcp --panel-orchestrator`
// (or COMFYUI_MCP_PANEL_ORCHESTRATOR=1).
//
// It owns the UI bridge (port 9180) directly — so it SEES panel messages instead
// of relying on an idle interactive session to notice a channel push — and spawns
// one Claude Agent SDK streaming session per panel tab (src/orchestrator/
// panel-agent.ts). Each agent runs on the user's Claude SUBSCRIPTION with no API
// key. See design/panel-orchestrator.md.

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
import { stripBlindCompletion } from "./blind-completion.js";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import readline from "node:readline";
import {
  startUiBridge,
  isLoopbackBindHost,
  isMirrorSafeFrameType,
  isUnknownCommandReply,
  isPanelCmdUnsupportedError,
  SESSION_EPOCH,
  type UiBridge,
} from "../services/ui-bridge.js";
import { canonicalOrigin } from "../utils/origin.js";
import {
  publishFrontendVirtualTypes,
  type FrontendVirtualTypesEntry,
} from "../services/frontend-virtual-types.js";
import { setupSecureBridge, resolveComfyuiPathForTarget, type SecureBridge } from "../services/secure-bridge.js";
import { judgeHelloRetarget, canonComfyuiTargetUrl } from "../services/hello-retarget.js";
import { startQuickTunnel } from "../services/tunnel.js";
import { detectInstallMode } from "../services/self-update.js";
import { performPanelSync, reassessPanelAfterSyncFailure } from "../services/panel-sync.js";
import { resolveBlindTabGate } from "./blind-tab-gate.js";
import { clearPanelDiskObservation } from "../services/panel-workspace.js";
import { panelRecoveryContext } from "../services/panel-recovery.js";
import { isPanelAutoInstallDisabled } from "../services/panel-installer.js";
import { releaseOwnedPanelLock } from "../services/panel-pin-guard.js";
import { SelfRestarter, canSelfRestart } from "../services/self-restart.js";
import { tickPanelAutoUpdate } from "../services/panel-auto-update.js";
import { pairUrlDurability } from "./pair-durability.js";
import { loadOrCreatePairToken } from "./pair-token-store.js";
import {
  autoUpdateApplyAllowed,
  pairAutoUpdateDisclosure,
  pairingActiveOf,
  pairingTransportOf,
  type AutoUpdateApplyInput,
} from "../services/auto-update-gate.js";
import { loadPairUpdatePrefs, savePairUpdatePrefs } from "./pair-update-prefs.js";
import { SessionStore, workflowIdentityParts, carryWorkflowCommandStamp } from "./session-store.js";
import { unreachableReason, noPanelTabReason, identityReason } from "./fence-refusal.js";
import {
  SHARED_SESSION_SCOPE,
  isScopeAddress,
  conversationTabs,
  shouldRetireSharedAgent,
  messageOrigin,
  normalizeHelloBackend,
  workflowOriginNote,
} from "../services/session-scope.js";
import {
  TurnOriginTracker,
  makeScopeRepinHandler,
  makeScopeTargetResolver,
} from "./turn-origins.js";
import { listSessions, loadTranscript } from "./history.js";
import { uploadImageHttp, resetClient } from "../comfyui/client.js";
import { setConnectedPanelOrigins } from "../comfyui/fetch.js";
import { publishConnectedPanelOrigins } from "../services/panel-origin-channel.js";
import { logger } from "../utils/logger.js";
import { listDownloadJobs } from "../services/download-jobs.js";
import { completionDisagreesWithRecord } from "./download-done-guard.js";
import { assembleVocabularyHash, describeVocabularySkew } from "../tools/vocabulary.js";
import { buildPanelToolDefs } from "./panel-tools.js";

/** The panel vocabulary hashes whose MISMATCH has already been reported (#236).
 *
 *  Keyed by the HASH ALONE, not by tab. Codex round 2 found that a per-tab key lets a
 *  stale entry suppress a real mismatch: `wf:` ids are reused, so a tab that closes
 *  after warning leaves an entry that silences the NEXT tab opening the same workflow.
 *
 *  Keying by hash is not a patch for that, it is the correct granularity. The fact
 *  being reported — "the vocabulary this panel build vendored disagrees with this
 *  server's" — is a property of the panel BUILD, not of a tab or a workflow. Saying it
 *  once per distinct disagreeing vocabulary is exactly the news there is; saying it
 *  once per tab was always repeating one fact under different labels.
 *
 *  It also bounds itself: a process sees one or two panel builds, so the set holds one
 *  or two entries where the per-tab map grew with every id ever minted. */
const loggedVocabularySkew = new Set<string>();

/** A cap anyway (codex round 1, P2). Nothing legitimate mints hashes — a panel
 *  advertises one per build — but this reads a value off the wire, and a broken or
 *  hand-modified panel that sent a fresh hash every hello would otherwise grow the set
 *  without limit. Oldest-first eviction, and the direction stays safe: an evicted entry
 *  can only cause a mismatch to be reported a SECOND time, never suppress one, because
 *  entries only ever suppress. */
const MAX_LOGGED_VOCABULARY_SKEW = 64;

/** This server's vocabulary hash, computed once.
 *
 *  Memoised because it cannot change without a restart (the tool surface is fixed at
 *  build time) and buildPanelToolDefs() walks every panel tool definition — work that
 *  has no business running on every hello, which is a hot path during a reconnect loop. */
let cachedServerVocabularyHash: string | undefined;
function serverVocabularyHash(): string {
  cachedServerVocabularyHash ??= assembleVocabularyHash(
    buildPanelToolDefs().map((d) => d.name),
  );
  return cachedServerVocabularyHash;
}
import {
  PanelAgentManager,
  fetchSupportedModels,
  fetchSupportedCommands,
  isEffort,
  type Effort,
  type McpEnvRestartOutcome,
  type ModelInfo,
  type SlashCommand,
  type UsageStatus,
} from "./panel-agent.js";
import { promptText } from "./error-text.js";
import { callToolAdmission } from "./call-tool-admission.js";
import {
  DEFERRED_PANEL_TOOLS_STEERING,
  withDeferredPanelToolsNote,
} from "../deferred-panel-tools.js";
import {
  createPanelMcpServer,
  makePanelToolCtx,
  resolvePinTarget,
  secretSavedReply,
  setApplyMcpReload,
  forgetAbandonedConfirmCards,
  RETRY_TOKEN_CMDS,
} from "./panel-tools.js";
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
import { tryInstallRetiredNameRedirect } from "../tools/retired-redirect.js";
import { config, isForceRemoteFlagSet, isLoopbackHost, detectLocalComfyUIPath, setComfyuiTarget, onComfyuiTargetChanged, isTargetingLocal, isTargetingLocalOrLan, isTargetingPod, getComfyUIBaseUrl, getLocalComfyuiUrl, rescopeLocalTargetFile, getComfyUIAuthHeaders } from "../config.js";
import { normalizeInstallPathEnv } from "../utils/install-path-env.js";
import {
  AGENT_IDENTITY_ENV,
  agentIdentityPath,
  publishAgentIdentity,
} from "../services/agent-identity.js";
import {
  buildComfyuiMcpEnv,
  comfyuiSecretKeys,
  onComfyuiSecretsChanged,
  hydrateAgentSecretsIntoEnv,
  onAgentSecretsChanged,
  setAgentSecret,
  setComfyuiSecret,
  isAllowedComfyuiSecretKey,
  changeJustifiesRetryNudge,
  type SecretSaveReceipt,
} from "../services/panel-secrets.js";
import { CodexBackend } from "./codex-backend.js";
import { GeminiBackend, GEMINI_DEFAULT_MODEL } from "./gemini-backend.js";
import { AntigravityBackend } from "./antigravity-backend.js";
import { PiBackend } from "./pi-backend.js";
import { GrokBackend, GROK_DEFAULT_MODEL } from "./grok-backend.js";
import { QwenBackend, QWEN_DEFAULT_MODEL } from "./qwen-backend.js";
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
import {
  allBackendReadiness,
  discoverBackendAvailability,
  piCredentialPresent,
} from "./backend-readiness.js";
import { handleOAuthBegin, handleOAuthStatus, handleOAuthSignout } from "./oauth-bridge.js";
// HUMAN-facing `say` bubbles only — `trFor`, never `tr`: each frame renders inside one
// specific panel tab, in THAT user's language (bridge.tabLocale), not the language of
// whoever launched this process. Everything else this file emits — tool text, system
// prompts, ack `message` fields, log lines — is read by a machine and stays English.
import { trFor } from "../i18n/index.js";
import { buildStartFailureNotice, startFailureSay } from "./start-failure-notice.js";
import { readyBannerText, bannerCorrection } from "./ready-banner.js";
import { OAUTH_PROVIDERS } from "../services/oauth-flow.js";
import { startPanelMcpHttpServer, type PanelMcpHttpServer } from "./panel-mcp-http.js";
import { resolveHttpLaneComfyToolMode } from "./http-backend-tools.js";
import type { ToolMode } from "../transport/cli.js";
import { dedupeAudioRefs, splitAudioAttachments } from "./audio-attachment.js";
import { startPanelConsoleHttpServer, type PanelConsoleHttpServer } from "./panel-console-http.js";
import type { AgentBackend } from "./agent-backend.js";
import { readComfyuiCrashLog, formatCrashNote } from "../services/crash-log.js";
import { QueueMonitor, type StallReport } from "../services/queue-monitor.js";
import {
  RunCompletions,
  describe as describeCorrelation,
  type CompletionPayload,
} from "./run-completion-journal.js";
import {
  createRunCompletionWatchdog,
  resolveHistoryCompletionImages,
  resolveHistoryCompletionStatus,
  type RunCompletionWatchdog,
} from "./run-completion-watchdog.js";
import { AskAnswers, preview as previewQuestion } from "./ask-answer-journal.js";
import { initRunpodWatcher, getRunpodWatcher, type RunpodStatusFrame, type RunpodAlertFrame } from "../services/runpod-watch.js";
import { getPod } from "../services/runpod-client.js";
import { listTargetChangeRequests, consumeTargetChange, ackTargetChange, setProgressDir, CONTROL_PREFIX, newestAttemptEpochs, isSupersededAttempt, downloadAttemptKey, markSupersededByLive, migrateInFlightJobs } from "../services/download-progress.js";
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
import {
  backendSharesRenderGpu,
  isLocalLlamacpp,
  pauseLocalOnGenEnabled,
} from "../services/local-vram.js";
import { getAgentSettings, setAgentSettings, normalizePreferredModels } from "../services/panel-settings.js";
import {
  gatherEnvCapabilities,
  buildPanelSystemAppend,
  resolveBackends,
  type EnvCapabilities,
} from "../services/env-capabilities.js";
import { WorkflowTargetStore } from "../services/workflow-target-store.js";

/**
 * The comfyui-mcp version THIS PROCESS IS RUNNING (#846), read at MODULE LOAD.
 *
 * As early as it can be read: package.json is fetched from disk immediately after
 * these imports resolve, which is the closest observable moment to "the build that
 * was loaded". Reading it later — inside the startup function, after the bridge and
 * workspace awaits — left a window in which an in-place update could rewrite the
 * package and have the NEW number reported as the executing build (codex gate round
 * 9), which is #846's mispinning arriving just before the snapshot meant to prevent
 * it. A running Node process cannot hot-swap its own code, so once taken this value
 * is true for the life of the process; it is `mcpVersionInstalled`, re-read on every
 * env refresh, that moves.
 */
const MCP_VERSION_RUNNING = ((): string | undefined => {
  try {
    return detectInstallMode().currentVersion ?? undefined;
  } catch {
    return undefined;
  }
})();

/** Exported for tests (#1398): the RENDERED persona is the only thing that proves
 *  the deferred-catalog guidance actually reaches an agent — a template literal that
 *  silently failed to interpolate would type-check, build, and ship the placeholder. */
export const PANEL_SYSTEM_APPEND = `You are the autonomous assistant embedded directly in a ComfyUI sidebar panel. The person is working in ComfyUI and talks to you through that panel: their messages arrive as your prompts, and everything you write is shown to them in the panel chat. Write for that reader — lead with the result, keep replies short and concrete, and don't narrate routine internal steps.

You can SEE and EDIT the workflow the user currently has open, via the panel_* tools (panel_graph_outline, panel_query_graph, panel_add_node, panel_connect, panel_set_widget, panel_run, panel_get_errors, panel_save_workflow, …). STRONGLY PREFER building on their live canvas: read it first (panel_graph_outline, then panel_query_graph for specifics), add/wire/configure nodes with the panel_* tools, then panel_run to queue it — so the user watches the work happen and the result loads in their own workflow with full Ctrl+Z undo. Only fall back to the headless generate_image/enqueue_workflow tools when the user explicitly wants a one-off they don't need on their canvas, or when no panel tab is connected (a panel_* call will error if so). On a LARGE graph (a loaded pack/template with dozens of nodes), do NOT dump the whole thing and scan it — and NEVER shell out to grep/jq/python over a saved workflow file. To UNDERSTAND the graph, call panel_graph_outline FIRST: a compact, dependency-ordered TEXT map (nodes topologically sorted source→sink, each with its key widgets and ← inputs / → outputs wiring, plus a groups index) made for you to read top-to-bottom. To PINPOINT and INSPECT specific nodes, use panel_query_graph: filter by types/title/widget predicates ('cfg>7'), traverse upstream_of/downstream_of a node, aggregate with group_by:'type', and read ONE node's exact slot/widget detail with {ids:[id], fields:'detail'} — output is token-bounded so it can never flood your context. panel_find_nodes remains for free-text search across all fields.

${DEFERRED_PANEL_TOOLS_STEERING}

PROMPT DIRECTOR AWARENESS. When the graph contains PromptDirector, PromptDirectorAuto, PromptDirectorContext, PromptProducer, or PromptDirectorResultCritic nodes, call panel_audit_prompt_director before declaring that the prompt/model/LoRA setup is correct or diagnosing a failed edit. The audit correlates live wiring and loader widgets with the nodes' resolved Model Explorer metadata, edit plan, LoRA compatibility/strengths, exact final prompt, warnings, and critic verdict. Surface concise, useful observations proactively (including when the configuration is coherent). Its recommendations are READ-ONLY proposals: ask before applying panel_set_widget/panel_connect changes unless the user already explicitly asked you to fix the workflow.

TRUST REPORTED MANUAL CHANGES. The user can edit the canvas BY HAND between your turns (bypass/mute a node, change a widget, rewire, add/remove nodes). When that happens, your turn opens with a "⟳ MANUAL CANVAS CHANGES since your last turn" block listing exactly what they changed. Treat that block as GROUND TRUTH about the current graph — it overrides what you remember from earlier in the conversation. Do NOT assume the graph still matches your last edit or your earlier reading; if the listed changes are substantial (or contradict a plan you were mid-execution on), re-read with panel_graph_outline before you act or draw conclusions. This is also how you learn the user already tried something (e.g. they bypassed a node and it worked) — believe it over your own prior reasoning.

REFACTOR BIG GRAPHS INTO TOGGLEABLE SUBGRAPHS — don't reconstruct group membership by hand. panel_query_graph reports every group with its member node_ids on each result's 'groups' (groups are geometric — they don't own nodes, so trust this list, not coordinates). To make a region readable and switchable as a UNIT (e.g. a "REPLACEMENT MODE" group), call panel_subgraph_group(group:<title or id>) — it wraps that group's nodes into one subgraph node in a single step (no need to gather node_ids yourself). Then toggle the whole region with panel_set_node_mode(<subgraph node id>, 'bypass' to turn it OFF / 'active' to turn it ON), and to compare variants queue it twice — panel_run with the subgraph active, then panel_set_node_mode to bypass and panel_run again. For an arbitrary node set that isn't a group, use panel_create_subgraph with explicit node_ids.

If a workflow needs a custom node the user doesn't have, don't silently skip it — offer to install it. Use the BUILT-IN Manager tools: panel_search_nodes to find the pack, panel_install_node to install it, panel_node_queue_status to confirm it finished, then panel_restart_comfyui (tell the user first) to load it. NEVER restart while a generation is running or queued — a restart ABORTS the in-progress render (the tool refuses if ComfyUI is busy and tells you; wait for the queue to drain, or only force a restart if the user explicitly agrees to kill the running render). After the restart the panel reconnects and you resume automatically, so you can carry on with what you were building. Prefer these panel_* Manager tools over the headless install_custom_node (action:"install"/"search"), which needs a separate Manager setup.

CRASH RECOVERY — when a custom node BREAKS or CRASHED ComfyUI, fix it before giving up. If your turn begins with a "⚠️ ComfyUI crashed …" note (it names the fatal log block and the most likely culprit custom node + file:line), or a run dies with a node-level error you can pin to one pack, do NOT just re-run the same graph — ESCALATE to actually fix that node, narrating each step to the user as you go: (a) UPDATE it to the latest code — call panel_update_node with the culprit's id (or the comfyui MCP install_custom_node with action:"update" / action:"fix"). Try version 'nightly' to grab a just-landed upstream fix. Poll panel_node_queue_status, then panel_restart_comfyui → you resume and RETRY the action to see if the crash is gone. (b) If updating doesn't fix it, reach into COMFYUI_PATH/custom_nodes/<NodeDir> with your shell (Bash): if it's a git repo (a .git dir), run git fetch && git pull (or check out the nightly branch) to force the latest, reinstall its requirements if needed, then restart + retry. (c) If there's no git or it's still broken, attempt a TARGETED source patch of the crashing file:line, then VERIFY the fix actually resolves the crash (restart + retry the same action — confirm it no longer faults). Once verified, OFFER to suggest the fix upstream to the repo owner (open an issue or PR describing the crash + your patch) — describe it and ask the user first; do NOT auto-file anything. Combine this cleanly with the normal install→restart→continue flow above: a fresh install that crashes on first use is the same loop (update/patch the just-installed node, don't abandon it).

REPORT OUR OWN BUGS (we're in beta — bias HARD toward filing) — distinct from the third-party case above. Whenever YOU hit a defect in comfyui-mcp or the sidebar panel ITSELF — a tool/panel/orchestrator call that errors, crashes ComfyUI, returns wrong/misleading/empty output, fails silently, or a limitation that forced you into an awkward workaround/retry — invoke the report-bug skill (list_packs action:"skill_read", name:"report-bug") to autonomously file a via-panel report, EVEN IF you already recovered or worked around it. You do NOT need to be blocked, and it does NOT need to be fatal — the workaround itself is the signal. AND report the FIX, not just the failure: any time a defect in comfyui-mcp or the panel gets fixed or patched during the session — you edited/worked around the code, changed a setting, or otherwise made a broken thing work — and the user confirms it's working (they're happy with the fix), file the report RIGHT THEN, capturing BOTH the original bug AND the fix that worked, so it can be fixed upstream at the source (a confirmed working fix is the most valuable thing to send upstream). File it immediately and autonomously — do NOT wait, and do NOT ask. The skill scrubs secrets and files through our intake Worker (which dedupes server-side, so over-reporting is cheap); then just drop the user a one-line note. Do NOT ask permission for OUR bugs — file them autonomously (unlike third-party/custom-node bugs above, where you OFFER and ask first). Ordinary generation errors (OOM, missing model, bad params, user mistakes) are NOT bug reports — those stay troubleshooting.

WEDGED RENDER / OOM / VRAM PINNED — when a generation is stuck or hits CUDA out-of-memory, or a cancel didn't actually free GPU memory (models still resident, VRAM pinned, the next run still OOMs), call panel_free_vram to UNLOAD all models and free VRAM before retrying — it does NOT restart ComfyUI, so it's the cheap first move. Escalation ladder: cancel the run → panel_free_vram (unload + free) → retry; only as a LAST RESORT panel_restart_comfyui (which refuses mid-render and guards the running generation). Reach for panel_free_vram before a restart whenever a cancel left memory pinned.

WORKFLOW TARGETING — by default your panel_* graph edits follow whichever workflow tab the user is currently viewing. The panel can only read or edit the workflow currently IN VIEW, so to work on a specific open workflow, make it the active canvas first with panel_open_workflow, then call panel_set_workflow_target(mode:"pinned", path:<from panel_list_workflows>) to bind your edits to it; panel_get_workflow_target shows the current binding. Pinning to a background (open but not active) workflow is REJECTED at pin time — it cannot route edits to a tab that isn't in view. A pin does NOT switch what the user sees; it binds your edits to that workflow so that if the user later switches away, your next graph call fails loudly instead of silently editing the wrong graph. Set mode:"current" to follow the user's active tab again.

CRITICAL — never destroy the user's work. When they ask for a "new workflow", a "fresh canvas", or to "start over for a new project", call panel_new_workflow (it opens a NEW TAB and leaves their current workflow intact). NEVER use panel_clear for that — panel_clear wipes the CURRENTLY OPEN graph and is ONLY for an explicit "clear/reset this canvas". You can manage tabs with panel_list_workflows / panel_open_workflow / panel_rename_workflow / panel_close_workflow, and group nodes with panel_select_nodes / panel_create_subgraph. To label, move, resize, recolor, collapse, or pin a node for presentation, use panel_edit_node. To read or edit nodes INSIDE a subgraph, call panel_enter_subgraph(node_id) first — then panel_query_graph / panel_graph_outline and the panel_* edit tools operate on the subgraph's inner nodes — and panel_exit_subgraph when you're done.

SUBGRAPH I/O — exposing interior nodes to the boundary. To wire an interior node to the subgraph's boundary from INSIDE a subgraph, do NOT panel_connect to a guessed rail node id — that's the rail and you'll get it wrong. Use panel_expose_subgraph_output(from_node_id, from_output) to expose an interior OUTPUT on the output rail (so the parent graph can wire the subgraph node's new output), and panel_expose_subgraph_input(to_node_id, to_input) to expose an interior INPUT on the input rail. Read panel_query_graph's \`rails\` field (present when viewing a subgraph) to see the current boundary slots — what's already exposed and what still needs it. To EXPAND/DISSOLVE a subgraph back into the parent graph (inline its inner nodes and rewire external links, removing the wrapper — the inverse of panel_create_subgraph), use panel_unpack_subgraph(node_id). All three are undoable with Ctrl+Z.

MERGE / COMPOSE WORKFLOWS — to bring nodes from ONE workflow into ANOTHER (combine two graphs, copy a section across tabs, reuse part of a saved workflow), use copy/paste: panel_open_workflow (the source) → panel_select_nodes (the section you want, or select all the nodes from panel_query_graph {fields:'ids'}) → panel_copy_nodes → panel_open_workflow or panel_new_workflow (the destination) → panel_paste_nodes (returns the new node ids) → then wire and tidy them, applying the workflow-layout skill so the merged result is clean (no overlaps). The clipboard SURVIVES the workflow switch, so the copied nodes carry across tabs. Use connect_inputs only when you want the pasted nodes to auto-reconnect to matching existing nodes; default (false) drops a clean disconnected copy you wire yourself.

REUSE SUBGRAPHS via the blueprint library — when the user builds a useful subgraph and wants to reuse it (now or in other workflows), SAVE it: panel_create_subgraph to group the nodes (if not already a subgraph), then panel_save_subgraph(node_id, name) publishes it to their library programmatically (no dialog). To drop a saved one into ANY workflow later, list them with panel_list_subgraphs and add with panel_add_subgraph(name). This is the durable way to reuse a building block across projects — distinct from copy/paste (a one-off merge of the current clipboard).

PREFER READY EXPERTISE OVER HAND-BUILDING. When the user asks you to "set up", "build", or "make" a workflow for a specific model FAMILY (krea2, wan, flux, qwen, ltx, z-image, ideogram, anima, ernie, etc.), do NOT immediately hand-build a generic graph from scratch. FIRST, in order: (a) consult the matching SKILL for that family. If you already have a skill for it loaded in your context, use it. If you do NOT have its full guidance in front of you, do NOT guess from memory — actually CALL the comfyui MCP's list_packs(action:"skill_list") to see what's bundled, then list_packs(action:"skill_read", name:<name>) to load the real family expertise (model slots, the node graph, settings, gotchas) before you build; (b) check the installer PACKS by CALLING list_packs(action:"list") (each packs/<name>/ has a ready manifest.yaml AND a ready workflow.json). If a pack matches the family, PREFER it: apply_manifest --path <its manifest_path> installs the right custom nodes + model weights, and the pack's workflow.json is the expert graph — CALL list_packs(action:"read_workflow", name:<name>) to get that ready graph and recreate it on the live canvas via panel_add_node/panel_connect/panel_set_widget so the user watches it build (or enqueue it headlessly when they don't need it on-canvas), instead of inventing your own. Don't claim a skill or pack exists unless a tool result confirmed it; (c) check the ComfyUI workflow Templates — call list_packs(action:"list_templates") (it lists CUSTOM-NODE-contributed templates from the server's /api/workflow_templates index; it does NOT enumerate ComfyUI's own core bundled templates, which are served separately) for a matching starter, and ALSO point the user at the frontend's Templates browser directly, since core templates only appear there. Only build from scratch if NOTHING matches — and when you do, briefly say what you checked (skill, packs, templates) so the user knows you didn't reinvent the wheel. And never wipe the user's current canvas (no panel_clear) until the replacement is actually ready to drop in. To load a ready pack graph onto the live canvas in one shot (instead of recreating it node-by-node), use panel_load_workflow(pack:<name>) — the pack's UI workflow.json is read server-side and dropped onto the canvas, undoable.

OPENING A STAGED / DOWNLOADED WORKFLOW. When you've saved or downloaded a workflow .json into the user's ComfyUI workflows folder (e.g. an example you fetched), open it with panel_open_workflow(path:<name-or-path>) — it now REFRESHES the frontend's (cached) workflow list before searching, so a just-staged file is found and opened natively in its own tab. For a workflow .json that lives OUTSIDE the workflows folder (any absolute path on the ComfyUI machine, or a downloaded example you didn't move into workflows/), load it directly onto the live canvas with panel_load_workflow(path:<file>) — the orchestrator reads + parses the JSON server-side and drops it on the canvas in one shot, so even a large (100KB+) workflow never has to shuttle through this chat. Prefer panel_load_workflow(path:<file>) over pasting a big workflow JSON inline as the graph arg.

RESOLVING A TANGLED / TOGGLE-HEAVY WORKFLOW (Get/Set buses + rgthree-bypassed pipelines). Expert and community graphs are often thick with VIRTUAL WIRING — GetNode/SetNode buses and Reroutes that hide the real connections — and rgthree "Fast Groups Bypasser/Muter" TOGGLED PIPELINES (one graph holding several pipelines, only one active at a time). Do NOT hand-trace GetNode→SetNode links or guess which branches are live. To get the REAL wiring: call panel_strip_workflow(path:<file> | pack:<name> | graph:<json>) — it resolves Get/Set buses, Reroutes, subgraph definitions, and bypassed/muted nodes into REAL connections and returns the flat, runnable graph (read server-side, never shuttled through chat). If the file is a MULTI-PIPELINE monolith and you only want ONE pipeline, FIRST panel_slice_workflow(path:<file>, groups:[<group-title substrings>]) to carve that pipeline into a standalone activated graph (it seeds from the output nodes in those groups, takes their backward closure through links + Set/Get buses, and un-bypasses the kept nodes), THEN panel_strip_workflow to flatten the buses. Reach for panel_strip_workflow whenever a graph is too tangled to read directly or you need to UNDERSTAND or REBUILD its actual wiring (e.g. a staged expert example full of GetNode/SetNode/Reroute); reach for panel_slice_workflow when an ULTRA-style monolith bundles several toggled pipelines and you want just one. (The same two tools exist as the MCP get_workflow (action:"strip") / get_workflow (action:"slice") for non-panel sessions.)

AUTHORING rgthree TOGGLES (the counterpart to reading them, above). Fast Groups Bypasser/Muter are FRONTEND-ONLY — registered by the pack's JS and absent from /object_info BY DESIGN, so their absence there is NOT evidence they're unavailable; panel_add_node adds them (it exempts a small allowlist of genuinely frontend-only types, which covers the Fast (Groups) Bypasser/Muter, Label, Reroute and Node Collector — but NOT Bookmark, the Mute/Bypass Relay/Repeater, Fast Actions Button or Random Unmuter, which it refuses fail-closed). They are configured with panel_set_property, NOT panel_set_widget (matchTitle/matchColors/sort/toggleRestriction are node PROPERTIES; panel_set_widget refuses them). They take no wiring and enumerate GROUPS by title, so create and NAME the groups FIRST, and always set matchTitle or the node lists every group in the workflow. Set matchTitle immediately after add_node, then re-read the node: Fast Groups do NOT implement onPropertyChanged, so the first write stores the filter but may leave leftover Enable rows or widgets:{} (unbuilt, not 'no matches'). If the list is wrong, set matchTitle again — do NOT delete and re-add the node. Group membership is GEOMETRIC (any node whose centre lands in the box) — when panel_create_group returns extra_node_ids/missing_node_ids and a warning, FIX IT before toggling, or a toggle disables part of the wrong stage. Load the rgthree skill (list_packs action:"skill_read", name:"rgthree") before configuring these.

LORA MANAGER AUTOCOMPLETE NODES. panel_add_node cannot add "Lora Loader (LoraManager)", "Lora Stacker (LoraManager)", or other LoRA Manager nodes whose required input is AUTOCOMPLETE_TEXT_LORAS / AUTOCOMPLETE_TEXT_PROMPT — the add waits 5s and refuses even when the pack and its UI are healthy. That is not a missing extension: reload, panel_refresh_nodes, and retry will keep failing. Use "LoRA Text Loader (LoraManager)" (lora_syntax is a STRING socket you can drive) or core LoraLoader. Load the lora-manager skill (list_packs action:"skill_read", name:"lora-manager") before authoring these.

RECOMMENDING CIVITAI MODELS — SHOW, DON'T JUST TELL. When the user asks about or you're recommending specific CivitAI resources (a "good relight LoRA?", "which Flux checkpoint?", "find me an anime style"), LEAN TOWARD opening the docked CivitAI browser and highlighting your picks rather than answering with only a text table. Flow: panel_open_civitai (docked, matched query/tab/filters) → panel_civitai_search to refine → panel_civitai_results to read the metadata + URLs → panel_civitai_highlight the one(s) you recommend, with a BRIEF text summary of why each fits. This docks beside the chat so both stay visible, and lets the user SEE the actual cards. (Note: you read metadata + URLs only, not the images.) It's a nudge, not a mandate — a quick factual answer or a resource the user already named is fine as text; reach for the browser when they're choosing between options or exploring.

DOWNLOADING MODELS — use the download_model tool, NOT a raw shell download. When a workflow needs model weights you don't have (checkpoints, LoRAs, VAEs, text encoders, etc.), download them with the comfyui MCP download_model tool, action:"download" (or action:"download_civitai" for CivitAI): it streams the file into the correct ComfyUI models/ subfolder AND surfaces live progress in the panel's download tray so the user can watch it. Pass target_subfolder to land the file exactly where it belongs (e.g. 'loras', 'checkpoints', 'vae', 'text_encoders', or a nested path like 'loras/<subdir>'). Do NOT shell out to curl/wget/aria2 for model files — a raw shell download has no progress in the panel and can drop the file in the wrong place. Reserve the shell for things download_model can't do.

HARDWARE & RUNTIME STATS — use the MCP tools, NOT the shell. For GPU / VRAM / CPU / RAM, CUDA/torch/python versions, and ComfyUI runtime stats, call the comfyui MCP get_system_stats (raw /system_stats) or install_comfyui (action:"environment") (a summarized snapshot) — they read the CONNECTED ComfyUI's /system_stats and work for LOCAL and REMOTE targets alike. Do NOT shell out (nvidia-smi, PowerShell, wmic, python) for hardware info: the managed shell is sandboxed/read-only and rejects multi-line scripts, so those probes fail and only reach the orchestrator host anyway, not a remote ComfyUI. The startup ENVIRONMENT line already summarizes the machine; when you need current or more detail, get_system_stats / install_comfyui (action:"environment") are the source of truth.

LOCAL-GPU (FREE) vs API NODES (PAID CREDITS) — and ASK before spending. ComfyUI workflows are either LOCAL — they run on the user's OWN GPU, which is free — or they use API NODES (hosted/partner services) that consume the user's PAID api credits. The bundled installer packs (list_packs action:"list") are ALL local/free; ComfyUI's official templates and any ad-hoc or generated workflow MAY use API nodes. BEFORE you build OR load any workflow that uses API nodes, you MUST ASK the user whether to use the free local GPU or paid api credits, and NEVER silently spend credits. To tell the difference reliably, call list_packs(action:"check_runtime", pack:<name> or graph:<json>) — it returns { runtime: 'local'|'api'|'mixed'|'unknown', usesApiNodes, apiNodes[] } by scanning the graph's nodes against the server's API-node set; treat 'api'/'mixed' (usesApiNodes:true) AND 'unknown' (unclassifiable nodes that could be paid) as POSSIBLY PAID and stop to ask — only 'local' is confirmed free. DEFAULT TO / PREFER the local pack unless the user explicitly opts into API nodes. Packs are always safe to load without asking; check ad-hoc/template workflows first.

You also have the comfyui MCP tools to generate images, video, and audio and to inspect, download models for, and manage their ComfyUI instance. Use them to actually do what's asked, then tell them what you did and name or link any output. If a request is ambiguous, make a sensible choice and say what you chose rather than stalling.

You are running in the background on the user's own machine. For routine, reversible actions that follow from the request, act without asking permission.

You can extend your own capabilities by connecting MCP servers: panel_list_mcp shows what's connected, panel_add_mcp writes a new server to the user's Claude config, and panel_remove_mcp removes one — then call panel_reload to load the change into this session (it restarts you and resumes automatically). For example, if a task needs Civitai model search and it isn't connected, offer to add the official CivitAI MCP (transport 'http', url 'https://mcp.civitai.com/mcp'), then reload. ALWAYS ask the user before connecting a remote MCP — it's an external service connection. After panel frontend or comfyui-tool code changes, you can also call panel_reload to pick them up without a ComfyUI restart — but changes to the orchestrator process itself (the panel_* tools and the services they use) only take effect when the user restarts that process, so never claim such a change is live after a panel_reload.

When you genuinely need the user to choose between options, use the panel_ask tool — it renders an interactive question card in the panel chat and returns their pick (the card always includes an 'Other…' free-text field, so they can answer freely too). Reserve it for decisions that actually change what you do; for a simple yes/no or quick confirmation a plain-text question in your reply is fine. Do NOT use the built-in AskUserQuestion tool — it does not render in this panel and gets auto-dismissed, which makes you think the user declined.

For any genuinely multi-step task, set a plan with panel_set_todo and then WORK THROUGH IT LIKE A LOOP: do each step, mark it done and the next one active as you go, and keep going autonomously all the way to the end. Do NOT stop between steps to ask "should I continue?", to report routine progress, or to seek permission for steps that plainly follow from the plan — the todo list is your commitment to FINISH, not a menu to re-confirm. Clear it (panel_set_todo with an empty array) once every item is done. The ONLY reason to pause the loop is a decision you genuinely cannot make yourself or a true blocker — then use panel_ask to get the answer and immediately resume the loop. When the user hands you a list of things to do, default to executing the WHOLE list before yielding the turn.

Adult / NSFW content is gated behind an explicit, persistent consent mode — query it with panel_get_content_mode (it defaults to OFF). ComfyUI has a large community of legitimate adult artists, so adult requests are valid creative work — but only for verified consenting adults. BY DEFAULT (mode OFF) keep everything safe-for-work: don't surface NSFW models, LoRAs, prompts, workflows, or imagery, and prefer SFW results. When a request clearly intends adult/NSFW work and the mode is OFF, call panel_request_adult_consent — it shows a card confirming the user is 18+ and that adult content is legal in their region; only once they affirm does the mode turn on (it persists across reloads, and panel_disable_adult_mode reverts it). When the mode is ON, help with legal adult art for consenting adults and don't over-refuse — stylized/fantasy themes between clearly-adult fictional characters are in scope. ABSOLUTE limits that NO mode, setting, or request ever relaxes: never sexual content involving minors or anyone depicted as underage; never sexual deepfakes of real, identifiable people; never depictions of actual non-consensual sexual acts (rape). If a request crosses these, refuse regardless of the mode.

SHOW / DISPLAY IMAGES AND VIDEOS — whenever the user asks to see, show, or display an image or video that you generated, composited, downloaded, or found — whether it is a file on disk (absolute path on the orchestrator host) or a ComfyUI output ref ({ filename, subfolder?, type? }) — call panel_show_media to render it as a media card directly in this chat. NEVER substitute emoji, text descriptions, or placeholder bullets for actual media; always call panel_show_media.

INSPECT NODE MODES BEFORE YOU RUN. After loading a pack/template/workflow — and before any panel_run — check node modes (panel_graph_outline marks [bypass]/[mute]; panel_query_graph detail rows carry mode). A node in 'bypass' is skipped (it just passes input through); a node in 'mute' does not execute and kills everything downstream. Packs and expert graphs ship with switches (a manual-prompt vs JSON/builder node, an rgthree Fast-Groups Bypasser/Muter, a prompt-source toggle) where the path you want is often BYPASSED/MUTED by default. NEVER assume a switch or route is active: if the path you intend to drive is bypassed/muted, enable it with panel_set_node_mode (set the wanted node 'active' and the unwanted one 'bypass'/'mute') BEFORE running. A wrong/stale mode is a top cause of renders that come out wrong.

VERIFY THE OUTPUT MATCHES THE REQUEST. After a render completes, actually LOOK at the image/video the panel delivers and confirm it matches what was asked BEFORE you declare success or move to the next step. If it doesn't match, do NOT report progress — diagnose (wrong prompt path? a bypassed/muted builder or switch? wrong widget value?), fix it (often panel_set_node_mode or panel_set_widget), and rerun. Only claim something works once you've SEEN that it does — never report progress you haven't verified.

AFTER PANEL_RUN — once you call panel_run to queue a render, you will be notified automatically with the output image(s)/video when it finishes. Do not poll queue (action:"list"), get_history, or get_image (action:"list_outputs") waiting for the result — just end your turn and the finished render will be delivered to you.

DEBUG WRONG RENDERS BY INSPECTING INTERMEDIATE STEPS (run-to-node). When a final asset comes out WRONG — artifacts, wrong subject/pose/composition/color, blur, a ControlNet/IPAdapter/mask/LoRA not taking, a refiner or upscale stage degrading it — do NOT just re-roll the whole graph. LOCALIZE the fault: render only up to one stage and LOOK at what that stage produces. panel_run takes to_node_id to run ONE output branch (ComfyUI partial execution) — only that output node plus everything upstream of it renders, the rest is skipped, so it's fast and cheap, and the result is delivered to you automatically like any run. to_node_id MUST be an OUTPUT node (is_output:true in panel_query_graph detail rows). To inspect a point that ISN'T an output — a latent, a preprocessor/depth/pose map, a mask, an intermediate image — TAP it: add a PreviewImage on an IMAGE wire (or VAEDecode→PreviewImage on a LATENT, MaskToImage→PreviewImage on a MASK), panel_run(to_node_id=that preview), read the delivered image, then panel_remove_node the tap when done. Bisect upstream→downstream until you find the FIRST stage whose output is bad — that node (or its inputs/widgets) is what to fix, then run-to-node there again to confirm before a full run. For the full method (probe recipes, symptom→probe map) read the debug-render skill via list_packs (action:"skill_read"). This is for renders that COMPLETE but look wrong; for runs that fail with an error/OOM/missing node, use the troubleshooting skill instead.

CHAIN A STAGE'S OUTPUT INTO THE NEXT STAGE'S LOADER — when a multi-stage pipeline (e.g. Krea2 image → LTX video → WAN extend) needs one stage's OUTPUT fed into the next stage's loader (LoadImage / VHS_LoadVideo / LoadAudio), call upload_image (action:"stage") with the output's { filename, subfolder?, type? } and drop the returned input filename into the loader's image/video/audio widget. (Or, for a file already on disk, upload_image (action:"image") / upload_image (action:"video") / upload_image (action:"audio").) NEVER copy the output file into, or guess, a filesystem \`input/\` path: ComfyUI's input AND output directories may be CUSTOM (launched with --input-directory / --output-directory), so a guessed path makes LoadImage reject the file ("Invalid image file") and wastes the render. upload_image (action:"stage") goes through the server API (/view → /upload/image), which resolves the real dirs correctly every time. VERIFY A VIDEO RENDER VIA THE FILESYSTEM, NOT /history — VHS_VideoCombine and similar video nodes write the .mp4 but frequently do NOT register an output in ComfyUI's /history (the prompt shows done with no output and no error), so do NOT conclude a clip "silently dropped" from get_history or queue (action:"status"); confirm it with get_image (action:"list_outputs") (which now lists videos, each tagged kind:"video") by filename/prefix + fresh mtime, then chain it forward with upload_image (action:"stage").

BYPASS COMPLETED STAGES BEFORE QUEUING THE NEXT ONE. When you build a multi-stage pipeline on one canvas (e.g. Krea2 → LTX → WAN), once a stage has RUN and you've captured/staged its output, BYPASS that stage's nodes with panel_set_node_mode(mode:"bypass") BEFORE you queue the next stage — so panel_run doesn't re-execute (and make the user pay for / wait on) work that's already done. Re-running the whole graph because an earlier stage was left active is a real, costly failure mode: explicitly bypass each finished stage and keep only the ACTIVE stage live. (This complements upload_image (action:"stage"), which feeds the prior stage's output forward into the next stage's loader — bypass the producer, feed its captured output to the consumer.)

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
You are running on the pi (pi.dev) backend, which has NO ComfyUI tools. Disregard every instruction above about panel_* tools (panel_graph_outline, panel_query_graph, panel_add_node, panel_connect, panel_set_widget, panel_run, panel_save_workflow, panel_install_node, panel_free_vram, …) and the headless comfyui tools (generate_image, enqueue_workflow, list_packs, apply_manifest, …): NONE of them exist in your runtime. You cannot see, read, or edit the user's ComfyUI canvas, cannot queue renders, cannot install nodes, and cannot call any panel_*/comfyui tool — attempting one is impossible, and you must never claim to, pretend to, or narrate doing so. You have ONLY your own built-in tools (shell, file read/write/edit, search) operating on the local filesystem. If the user asks for canvas/workflow work (build/inspect/run a graph, install a node, fix a render), say plainly that the pi backend has no ComfyUI tools and they should switch to the Claude, Codex, Gemini, or Antigravity backend for canvas work — you can still help with local files, code, and shell tasks.`;

/**
 * Appended when the loopback panel HTTP MCP FAILED TO BIND, for every backend that
 * would otherwise have been handed it.
 *
 * PANEL_SYSTEM_APPEND tells the agent it can see and edit the canvas through
 * panel_* tools. That is true only when `panelMcpHttp` came up: those tools reach
 * an HTTP-lane backend through exactly one server, and when the bind fails
 * makeHttpBackendMcpServers() simply omits it. The prompt was left claiming them
 * anyway, so the model was told it held a toolset it demonstrably did not — and
 * models improvise, which the user reads as the panel being broken.
 *
 * This is #804's shape (a capability we cannot deliver, asserted as available) with
 * one crucial difference that makes it worth fixing here rather than documenting:
 * **we observed it**. Most of that cluster is hard because a client-side permission
 * block never reaches us. A failed bind is our own return value. Saying so is a
 * claim we are entitled to make.
 *
 * Narrower than PI_CAPABILITY_OVERRIDE, and deliberately so: pi has no MCP client at
 * all, whereas a failed panel bind removes only the live-canvas surface. Telling the
 * agent it had lost the rest would be the same defect pointing the other way.
 *
 * But narrow is not the same as making the OPPOSITE claim, which two earlier drafts
 * did. They said the headless tools were "UNAFFECTED and still work" and that
 * restarting the orchestrator "restores" the canvas ones. A failed panel bind
 * establishes neither: the stdio child is a separate connection that can fail on its
 * own, and a bind failure whose cause persists (the port simply stays occupied)
 * survives a restart. So this says what was observed — the panel server did not
 * start — and then explicitly declines to speak for the other server or for the
 * future. Retracting one false capability claim while attaching two new ones is the
 * defect this whole change exists to remove, wearing the fix's clothes.
 */
const NO_PANEL_TOOLS_OVERRIDE = `

=== CAPABILITY CORRECTION — READ THIS, IT SUPERSEDES THE ABOVE ===
The live-canvas tools are NOT available in this session. The loopback panel MCP server failed to start, so no panel_* tool (panel_graph_outline, panel_query_graph, panel_add_node, panel_connect, panel_set_widget, panel_run, panel_save_workflow, …) exists in your runtime this run. Disregard every instruction above about reading or editing the user's open canvas: you cannot see it, cannot change it, and must never claim to, pretend to, or narrate doing so.
That is ALL this tells you. The headless comfyui server is a SEPARATE connection that succeeds or fails on its own, so this says nothing about whether you have its tools — go by the tool list you were actually given. If it is there, the file-based route (get_workflow, whose list/get/analyze/query actions read saved files) is your way to work on a saved workflow; if it is not, say that plainly instead of guessing.
The panel tools cannot come back during this session — the tool set was fixed when it started. If the user asks for work on the graph in front of them, tell them the live-canvas tools failed to start this run and that you cannot reach the canvas until the orchestrator is restarted. Do not promise a restart will fix it: whether it does depends on why the bind failed, and a port still held by something else will fail the same way again.`;

/**
 * Whether this backend's prompt has to retract its panel_* claim, given whether the
 * loopback panel MCP actually came up.
 *
 * Exported and pure so the decision is testable on its own — the alternative is a
 * ternary buried in a 5000-line function that nothing can reach, and "the prompt
 * lies when the bind fails" is precisely the kind of thing that stays broken when
 * only the happy path is exercised.
 */
/**
 * The panel persona as an agent actually receives it (#1398).
 *
 * The deferred-catalog guidance is re-applied AFTER `resolvePrompt`, because a
 * locale translation or a user persona override replaces the WHOLE string and would
 * otherwise take it with them — reproducing #1398 in exactly the deployments least
 * equipped to diagnose it (codex review, P1). Exported so that re-application is a
 * TESTABLE unit: inlining it at the call site made dropping it invisible to every
 * test, which a mutation run confirmed.
 */
export function resolvePanelPersona(): string {
  return withDeferredPanelToolsNote(resolvePrompt("panel.persona", PANEL_SYSTEM_APPEND));
}

export function panelToolsRetraction(backend: string, panelToolsAvailable: boolean): string {
  if (panelToolsAvailable) return "";
  // pi has no MCP client at all; PI_CAPABILITY_OVERRIDE already retracts strictly
  // more than this would, and stacking a second, narrower retraction on top would
  // only muddy it.
  if (backend === "pi") return "";
  // claude drives the canvas through its own IN-PROCESS panel server, so a failed
  // HTTP bind takes nothing away from it. Listed explicitly rather than relying on
  // makeBackend returning undefined for it: this function must be right on its own
  // terms, not only in the one place it happens to be called from today.
  if (backend === "claude") return "";
  return NO_PANEL_TOOLS_OVERRIDE;
}

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
  'it reports completion (this is the ONE case where polling IS correct) — then fetch the output with get_history (action:"list", prompt_id) and ' +
  "show it with panel_show_media. Do NOT end your turn expecting an automatic notification; none will arrive. " +
  'If the run FAILED — or the user asks why a render failed / what\'s missing — call get_history (action:"diagnose") FIRST, and do NOT use ' +
  'action:"list" for that: the diagnose action returns everything the list action would (failed node + exception + traceback) PLUS the ' +
  "missing models (exact file + the widget holding it) and missing node types that the list action omits, in one call. It is " +
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


/**
 * PROBE TIMEOUT. These four inspections run SYNCHRONOUSLY, so a command that
 * hangs blocks the whole event loop — no bridge traffic, no agent turns,
 * nothing — and they run on the startup/takeover path where being stuck is
 * indistinguishable from being broken. `lsof` is the known offender (it stalls
 * on unreachable network mounts), and `netstat` is slow on a busy host.
 *
 * 5s matches what the rest of the codebase already uses for these EXACT
 * commands — port-owner.ts times out its `lsof`/`netstat` and process-control.ts
 * its `tasklist`. These copies simply never got it.
 *
 * Timing out costs nothing in correctness: both callers already fail closed on
 * a throw (null / "unknown"), and both READ that as "could not determine" —
 * pidListeningOnPort's null makes the caller decline to claim a takeover rather
 * than assert the port is free.
 */
const PORT_PROBE_TIMEOUT_MS = 5000;
/** Resolve which pid is LISTENING on a local TCP port (null if none/unknown). */
function pidListeningOnPort(port: number): number | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        timeout: PORT_PROBE_TIMEOUT_MS,
      });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[1]) === port) return Number(m[2]);
      }
      return null;
    }
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-s", "tcp:LISTEN"], {
      encoding: "utf8",
      timeout: PORT_PROBE_TIMEOUT_MS,
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
        timeout: PORT_PROBE_TIMEOUT_MS,
      });
      return /^"([^"]+)"/m.exec(out)?.[1] ?? "unknown";
    }
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
        encoding: "utf8",
        timeout: PORT_PROBE_TIMEOUT_MS,
      }).trim() ||
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
      // The panel's `call_tool` bridge command dispatches through client.callTool()
      // below, i.e. the DIRECT tools/call path — the same gap the MCP server had, and
      // it is not new in 0.50.0: a retired name here has always come back to the panel
      // as `error: "Tool <name> not found"` with nothing to act on. Same one-line fix.
      const redirects = await tryInstallRetiredNameRedirect(server);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "orchestrator-calltool", version: "1.0.0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      logger.info(
        `[panel-orchestrator] call_tool in-process MCP client ready ` +
          `(retired-name redirects: ${redirects ? "active" : "INACTIVE"})`,
      );
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

/**
 * #1524 — a startup that never finishes must not become a silent resident.
 *
 * A respawn was observed alive for hours holding NO listening ports, while an
 * older instance owned 9180/9181/9183. That is not the bind-failure path: that
 * one is bounded (five attempts, then `whenReady()` resolves false), tries to
 * reclaim the port, and exits non-zero with a clear message. A process with no
 * ports at all never got that far — it hung EARLIER, so any guard wrapped around
 * the bind itself would miss it.
 *
 * Hence a deadline armed as early as this function runs and disarmed only once
 * the port is actually held. It does not care WHERE the hang is, which is the
 * point: the failure it prevents is not "bind failed" but "we never found out",
 * and the reporter's framing is that silently staying alive with zero bound ports
 * is the worst of the available outcomes.
 *
 * WHAT IT DOES NOT COVER, because an earlier draft of this comment claimed "the
 * whole of startup" and that was false (codex):
 *
 *   - anything before `boot.ts` finishes dynamically importing this module — the
 *     timer does not exist yet;
 *   - a SYNCHRONOUS stall anywhere, which no timer can interrupt, because the
 *     event loop it would fire on is the one that is blocked.
 *
 * So this closes the async-hang shape of the report and cannot close the
 * synchronous one. If a portless process is ever seen again with this in place,
 * that difference is the first thing to check, and it is written down here so the
 * next reader does not have to rediscover it.
 *
 * Generous by default (90s) because a cold `npx` start on a slow disk is
 * legitimately slow, and env-tunable for pathological machines. Exits non-zero so
 * a supervisor restarts rather than inheriting a half-alive process.
 */
export function armStartupDeadline(
  port: number,
  deps: { exit?: (code: number) => never; incumbent?: (p: number) => number | undefined } = {},
): () => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const findIncumbent = deps.incumbent ?? pidListeningOnPort;
  // CLAMPED, not merely "positive and finite" (codex). Node coerces a
  // sub-millisecond delay AND anything past the 32-bit signed limit to 1ms — so
  // `0.5`, or a large number typed by someone trying to RAISE the deadline, would
  // fire almost instantly and kill every healthy startup. A guard whose escape
  // hatch can cause the outage it prevents is worse than no guard, so out-of-range
  // values fall back to the default rather than being honoured literally.
  const raw = Number(process.env.COMFYUI_MCP_STARTUP_DEADLINE_MS);
  const MIN_MS = 1_000;
  const MAX_MS = 2_147_483_647; // Node's setTimeout ceiling
  const ms = Number.isFinite(raw) && raw >= MIN_MS && raw <= MAX_MS ? Math.floor(raw) : 90_000;
  const timer = setTimeout(() => {
    const incumbent = findIncumbent(port);
    logger.error(
      `[panel-orchestrator] startup did not complete within ${Math.round(ms / 1000)}s and this ` +
        `process holds no bridge port — exiting rather than lingering with no way to serve panel_* ` +
        `tools.` +
        (incumbent
          ? ` Port ${port} is held by pid ${incumbent}; if that is an older comfyui-mcp, stop it ` +
            `and start this one again.`
          : ` Nothing is listening on ${port} either, so the hang is before the bind — please ` +
            `report this with the last lines above (#1524).`) +
        ` Raise COMFYUI_MCP_STARTUP_DEADLINE_MS if this machine is legitimately slower than that.`,
    );
    exit(1);
  }, ms);
  // Never hold the event loop open on this timer's account.
  timer.unref?.();
  return () => clearTimeout(timer);
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

  // #1524 — armed HERE, before anything that can block, and disarmed only once
  // the bridge port is actually held. The port is re-derived rather than passed
  // in because the deadline has to exist before the block that computes it.
  const disarmStartupDeadline = armStartupDeadline(
    Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180,
  );
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
  // Forward declaration — assigned after teardownCore exists. Declared here so
  // pair / apply_updates_now handlers can refresh the restarter without hitting
  // the TDZ if a frame arrives before that assignment.
  let selfRestarter: SelfRestarter | null = null;
  /**
   * #1963 — APPLY gate for auto-update. Checking still runs.
   *
   * pairingActive is STICKY on `pairTunnel` (the handle exists from mint until
   * process exit). A live-socket test is the hole a locked-screen phone falls
   * through: the OS has closed the socket, the gate opened, the hostname
   * rotated. The pair-time toggle (default ON) is how a desk session applies
   * anyway; apply_updates_now is the one-shot override.
   */
  const autoUpdateGateInput = (): AutoUpdateApplyInput => ({
    activeTransport: pairingTransportOf(pairTunnel),
    pairingActive: pairingActiveOf(pairTunnel),
    deferWhilePaired: loadPairUpdatePrefs().deferWhilePaired,
  });
  const applyAutoUpdateAllowed = (): boolean => autoUpdateApplyAllowed(autoUpdateGateInput());
  // #875 — the token is PERSISTED, not per-session. It used to be minted fresh on
  // every run, so a self-restart (on by default, hourly npm check) invalidated the
  // URL the phone had saved. The reporter experienced that as "updating the npm
  // version bricks my communication with the agent" and asked to pin the version;
  // the version was never the cause. An explicit COMFYUI_MCP_PAIR_TOKEN still wins.
  let pairTokenPersisted = envPairToken !== null;
  const ensurePairListener = async (): Promise<string> => {
    if (!pairToken) {
      const loaded = loadOrCreatePairToken();
      pairToken = loaded.token;
      pairTokenPersisted = loaded.persisted;
    }
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
  // The port is ours — startup got where it needed to. Everything after this is
  // long-running work the deadline must not police.
  disarmStartupDeadline();

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
  // #1512 — the SECOND ingestion point, and the one a fix confined to
  // resolveComfyUIPath would have missed: this reads the env var directly, and
  // what it produces is handed to the spawn env builders and to
  // resolveComfyuiPathForTarget. A trailing space here does not merely fail a
  // check locally — it is passed on to every agent this orchestrator starts.
  // Same normalizer as config.ts so the two can never drift apart, which is the
  // shape of the original bug (panel stripped it, orchestrator did not).
  const envComfyuiPath = normalizeInstallPathEnv(process.env.COMFYUI_PATH).path;
  // `||` not `??`: a set-but-empty COMFYUI_PATH= means "unset" (the headless
  // MCP's config truthy-checks it the same way) — it must not block detection.
  // normalizeInstallPathEnv already maps a whitespace-only value to undefined,
  // so "   " now reaches detection too instead of being adopted as a path.
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
  // #1845 — panel_load_workflow runs IN this process and reconstructs the
  // workflow library from config.comfyuiPath, not from the spawn env handed to
  // child MCP servers. A recovered path that never reached config left the
  // local fallback claiming "COMFYUI_PATH not set" while install_comfyui
  // environment (the child) reported the same trusted workspace.
  if (comfyuiPath && !config.comfyuiPath) config.comfyuiPath = comfyuiPath;
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
        // #1148 — carry any IN-FLIGHT download records forward before deleting.
        //
        // The persisted store exists so a reconnecting session can still resolve
        // an in-flight download by id (#529), and download_model's status text
        // promises exactly that. This reap deleted the store that promise rests
        // on: a reporter's 12GB transfer answered "No download matching id" and
        // "No downloads are being tracked", with no file, no partial, and no
        // error event — 40 minutes lost invisibly while the documented contract
        // told their agent to wait rather than re-issue.
        //
        // The transfer IS dead (it streamed inside the exited process), so this
        // resurrects nothing. It replaces the silence with a terminal record
        // saying the download was interrupted, which status can find by the id
        // the caller already holds. Runs BEFORE the delete, and its failure is
        // never allowed to skip the delete.
        try {
          mkdirSync(progressDir, { recursive: true, mode: 0o700 });
          const n = migrateInFlightJobs(join(tmpdir(), d), progressDir);
          if (n > 0) logger.info(`Carried ${n} interrupted download record(s) forward`);
        } catch {
          /* best-effort */
        }
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
  // Qwen Code (issue #1417): same spawn-pinned posture as Gemini — the panel
  // model is a Claude id, so the Qwen model comes from COMFYUI_MCP_QWEN_MODEL
  // (default qwen3-coder-plus), applied at spawn via the CLI `--model` flag.
  const qwenModel = process.env.COMFYUI_MCP_QWEN_MODEL ?? QWEN_DEFAULT_MODEL;
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
  // spawning one process per provider on its own port (9180/9181/9182).
  //
  // SESSIONS ARE ORCHESTRATOR-SCOPED (#884, owner-stated invariant): one agent
  // session spans every panel, browser tab and open workflow — a workflow-scoped
  // agent is a bug, never the design. Internally each BACKEND owns one agent
  // addressed by the composite key `orchestrator::<backend>` (session-scope.ts):
  // the backend half survives because switching provider deliberately restarts
  // the agent (the panel replays the transcript to seed the new provider); the
  // per-workflow half was the #884 regression and is gone. The panel `tab_id`
  // (`wf:<path>` / `tmp:<uuid>` — a WORKFLOW identity, not a tab identity) is
  // now purely a ROUTING target: commands from the shared agent resolve to the
  // active tab at dispatch (UiBridge.resolveTarget), and conversation frames fan
  // out to every connected tab on the agent's backend (conversationTargets).
  // `backendId`/`codexModel`/`geminiModel` above are the DEFAULT + per-provider
  // model config; the process is no longer pinned to one.
  const KNOWN_BACKENDS = new Set([
    "claude",
    "codex",
    "chatgpt",
    "gemini",
    "antigravity",
    "pi",
    "grok",
    "qwen",
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
  // The UUID stamped on the NEXT panel command for a tab — the per-workflow
  // COMMAND FENCE (#570 P0c, kept under #884 because it is a ROUTING guard, not
  // session identity): a command dispatched for workflow A after the user
  // switched to workflow B is declined by the panel rather than mutating B.
  // Set from each hello's trusted identity; #716 lets a successful explicit
  // open/re-pin refresh it between hellos.
  const tabCommandWorkflowUuid = new Map<string, string>();
  // #1656 — WHO said so, for the entries above. A tab id in this set holds a stamp that
  // was CARRIED from the tab id a same-socket re-hello retired and has NOT been proven
  // under its current id. The value is still used to stamp frames (#1331 — an absent
  // stamp is the unrecoverable half), but the dispatch-time agreement gate may not read
  // it as this tab's own advertisement: the conversation's issue-time stamp is captured
  // from this very map, so a carry makes that gate's two sides identical by construction
  // in exactly the window where the canvas changed.
  const tabStampCarried = new Set<string>();
  const scopeAgentKeyOf = (scopeId: string): string =>
    scopeId === SHARED_SESSION_SCOPE ? sharedKeyFor(defaultBackend) : scopeId;
  // #884 — each shared conversation's last message origin (tab + workflow uuid),
  // so a message sent from a DIFFERENT workflow than the previous one carries a
  // one-line context note: session-bound agents keep knowledge of which canvas
  // they are operating on without per-workflow sessions.
  const lastMessageOriginByKey = new Map<string, string>();
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
  // #884 — SESSION IDENTITY: the shared scope + the tab's backend. The panel tab
  // id no longer participates in the key, so one conversation spans every tab
  // and workflow; only a provider switch changes which agent a tab talks to.
  const agentKeyFor = (panelTabId: string): string =>
    SHARED_SESSION_SCOPE + AGENT_KEY_SEP + backendForTab(panelTabId);
  const sharedKeyFor = (backend: string): string => SHARED_SESSION_SCOPE + AGENT_KEY_SEP + backend;
  // The scope/backend halves of a composite key. Neither half contains "::", so
  // split on the LAST separator.
  const panelTabOf = (key: string): string => {
    const i = key.lastIndexOf(AGENT_KEY_SEP);
    return i >= 0 ? key.slice(0, i) : key;
  };
  const backendOf = (key: string): string => {
    const i = key.lastIndexOf(AGENT_KEY_SEP);
    return i >= 0 ? key.slice(i + AGENT_KEY_SEP.length) : defaultBackend;
  };
  // #884 — PER-CONVERSATION TURN ORIGINS: the issue-time workflow stamp
  // (#570's rule at conversation level — a scope mutation carries the uuid its
  // turn was ISSUED for, never re-resolved at dispatch; codex round 1, P0),
  // the in-flight turn's routing pin (confirming gate P0), the last
  // established origin that origin-less turns inherit (confirming gate 2,
  // P0), and the backend binding every origin is re-verified against at
  // dequeue (confirming gate 3, P0). The machinery lives in turn-origins.ts —
  // one seam, driven directly by its own tests — and this file only wires it:
  // record at receipt, apply at dequeue (onSeen), release at turn end, forget
  // at conversation boundaries.
  const turnOrigins = new TurnOriginTracker({
    backendForTab,
    backendOfKey: backendOf,
    uuidOfTab: (tab) => tabCommandWorkflowUuid.get(tab),
    // The provider-switch pin invalidation judges a pin by where the BRIDGE
    // routes it (path-compressed migration aliases included) — codex gate 4.
    liveTabOf: (tab) => bridge.liveTabIdFor(tab),
    warn: (msg) => logger.warn(msg),
  });
  // #884 — ROUTING for agent output: every connected tab participating in this
  // key's backend conversation. Fanout goes through bridge.push PER TAB so the
  // mirror allowlist (MIRROR_SAFE_FRAME_TYPES) and canonical-id fanout keep
  // their invariants. When NO participating tab is connected, frames PARK here
  // per agent key — keyed by backend, so a claude turn finishing while only a
  // codex tab is open can never leak into the codex conversation — and flush to
  // the next hello on that backend (bounded; a backgrounded turn survives a
  // panel reload).
  const conversationTabsFor = (key: string): string[] =>
    conversationTabs({
      connected: bridge.tabs().map((t) => t.tab_id),
      backendForTab,
      backend: backendOf(key),
    });
  // An ATTACHED mirror viewer already receives MIRROR-SAFE frames through the
  // mirror fan-out of the desktop tab it drives — delivering those to its own
  // tab id too would double every say/stream/turn frame on the phone (codex
  // round 2). Non-mirrored frames (e.g. the seen-ack for a message the phone
  // itself sent) are still delivered directly, or the phone's bubble would
  // stay "queued" forever (codex round 3).
  const conversationDeliveryTabs = (key: string, frameType: unknown): string[] => {
    const viaMirror = typeof frameType === "string" && isMirrorSafeFrameType(frameType);
    const tabs = conversationTabsFor(key);
    return viaMirror ? tabs.filter((t) => !bridge.isAttachedViewerTab(t)) : tabs;
  };
  const MAX_PARKED_CONVERSATION_FRAMES = 200;
  const parkedConversationFrames = new Map<string, Array<Record<string, unknown>>>();
  const pushToConversation = (key: string, frame: Record<string, unknown>): void => {
    const tabs = conversationDeliveryTabs(key, frame.type);
    if (tabs.length) {
      for (const t of tabs) bridge.push(frame, t);
      return;
    }
    const q = parkedConversationFrames.get(key) ?? [];
    q.push(frame);
    if (q.length > MAX_PARKED_CONVERSATION_FRAMES) {
      q.splice(0, q.length - MAX_PARKED_CONVERSATION_FRAMES);
    }
    parkedConversationFrames.set(key, q);
  };
  /**
   * A HUMAN-facing `say` fanned out to a conversation's tabs, rendered PER TAB.
   *
   * pushToConversation cannot serve this: one conversation can span tabs whose panels are in
   * DIFFERENT languages, and a single pre-rendered string would then be wrong on all but one
   * of them. `build` is called once per recipient with that tab's own locale.
   *
   * With no tab connected the frame parks like any other (replayed on the next hello),
   * rendered in English: the tab that will eventually receive it has not told us its language
   * yet, and English is the honest default rather than a guess.
   */
  const pushSayToConversation = (key: string, build: (locale: string) => string): void => {
    const tabs = conversationDeliveryTabs(key, "say");
    if (!tabs.length) {
      pushToConversation(key, { type: "say", text: build("en") });
      return;
    }
    for (const t of tabs) bridge.push({ type: "say", text: build(bridge.tabLocale(t)) }, t);
  };
  // The REAL tab ids participating in the conversation that `originTab` belongs
  // to — used when a conversation BOUNDARY (New chat / resume switch / rewind)
  // must close every participating tab's journaled tickets, not just the
  // originator's (#884). This must include DISCONNECTED members (codex r2 P1):
  // a tab that queued a render, disconnected, and whose backend maps to this
  // conversation still holds tickets that the boundary replaces — otherwise a
  // later flushAllJournaledEvents sweep injects its completion into the
  // REPLACEMENT conversation as "the run YOU queued". Every tab that ever
  // helloed is in tabBackends, and outstanding journal keys are swept too.
  const conversationMemberTabs = (originTab: string): string[] => {
    const backend = backendForTab(originTab);
    const members = new Set<string>();
    for (const t of bridge.tabs()) {
      if (backendForTab(t.tab_id) === backend) members.add(t.tab_id);
    }
    for (const [t, b] of tabBackends) {
      if (b === backend) members.add(t);
    }
    try {
      for (const e of RunCompletions.allOutstanding()) {
        if (backendForTab(e.key) === backend) members.add(e.key);
      }
      for (const e of AskAnswers.allOutstanding()) {
        if (backendForTab(e.key) === backend) members.add(e.key);
      }
    } catch {
      // journal enumeration is best-effort — connected + known tabs still close
    }
    members.add(originTab);
    return [...members];
  };
  // #884 — Blind mode (issue #90) is a promise that the AGENT never receives
  // pixels. The agent is now shared, so the promise is conversation-wide: pixels
  // are withheld while ANY tab has Blind on (a per-tab gate would leak pixels to
  // the shared agent through the other tabs).
  // #1841 — `blindTabs.size > 0` never retired a tab that WENT AWAY: every
  // delete site needs an explicit blind-off from that same id (or the hello
  // migration path), so one departed blind tab pinned the whole conversation
  // blind for the life of this process while the user's live tab reported Blind
  // OFF. The sweep retires an id only after it has been continuously unreachable
  // past a grace window — unreachability starts a clock, it does not decide —
  // so a routine websocket drop still fails CLOSED. See blind-tab-gate.ts.
  const blindUnreachableSince = new Map<string, number>();
  const anyTabBlind = (): boolean => {
    const { blind, pruned } = resolveBlindTabGate({
      blindTabs,
      unreachableSince: blindUnreachableSince,
      canReach: (tabId) => bridge.canReach(tabId),
      now: Date.now(),
    });
    if (pruned.length) {
      logger.info(
        `[panel-orchestrator] Blind gate: retired ${pruned.length} departed blind tab(s) ` +
          `(${pruned.map((t) => t.slice(0, 8)).join(", ")}) — unreachable past the grace window; ` +
          `conversation blind = ${blind}`,
      );
    }
    return blind;
  };

  /**
   * Blind, applied to a run completion — the SAME implementation at every door.
   *
   * #1861: the panel's `executed` frame arrives at the ingress below; the #1789 watchdog
   * SYNTHESISES one when that frame never comes, and that door recorded the raw payload.
   * Inert while its `images` was always empty, live once #1853 filled it from /history.
   * The logic lives in blind-completion.ts so a new arrival point cannot get a
   * near-copy that drifts, and so it is testable without the orchestrator.
   */
  const blindStrippedCompletion = <T extends { images?: unknown; note?: unknown }>(ev: T): T =>
    stripBlindCompletion(ev, anyTabBlind());

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
  // WHICH MOMENT EACH OF THESE DESCRIBES (#846).
  //
  // The RUNNING version is read once, at module load — see MCP_VERSION_RUNNING. It
  // is the version a bug filed from this session must be pinned to.
  //
  // What was wrong was not the caching — it was that this was the ONLY reading, so
  // a value captured at startup was rendered as the current state of the machine.
  // An in-place upgrade moves the on-disk package while this process keeps running
  // the old one; the ENV line then reported a version that had passed, triage
  // version-matched against the wrong build, and the line offered no way to notice.
  // So the installed version is re-read on EVERY refresh below and the difference
  // is disclosed. Re-reading it into the RUNNING slot instead would have been the
  // mirror-image lie: claiming to be a build we are not running.
  const mcpVersionRunning = MCP_VERSION_RUNNING;
  let latestPanelVersion: string | undefined;

  // #1400 — the frontend VIRTUAL-node registry each connected canvas-owning tab
  // has PROVEN (its `graph_get_virtual_types` answer: the registered classes that
  // set `isVirtualNode === true`, the flag ComfyUI's own serializer reads to keep
  // a node out of the prompt). The headless `check_runtime` in the spawned tool
  // servers cannot see a browser registry, so each hello pulls this and the poll
  // tick republishes it through the progress-dir channel the children read
  // (services/frontend-virtual-types.ts).
  //
  // Keyed by the tab's SERVER-OBSERVED handshake origin (bridge.tabServerOrigin),
  // NEVER the hello's client-supplied comfyui_url claim — page JS can write the
  // claim but cannot forge the browser's Origin header (the #756 trust model), so
  // a tab can only annotate the server it provably fronts. A failed or refused
  // pull keeps the PREVIOUS answer for the origin; only an ok:true reply
  // replaces it, so a transient error never erases known-good proof.
  const frontendVirtualTypesByOrigin = new Map<string, string[]>();
  // Panel versions that PROVED they lack the command (an Unknown-command reply or
  // the proactive too-old refusal), so an old panel is asked once per process,
  // not once per hello. Keyed by version, not tab: a panel UPDATE keeps the tab
  // but moves the version, and must be asked again.
  const virtualTypesUnsupportedPanelVersions = new Set<string>();

  async function pullFrontendVirtualTypes(tabId: string, panelVersion?: string): Promise<void> {
    // A headless (mobile/mirror) client fronts no canvas registry.
    if (bridge.isCurrentHeadless(tabId)) return;
    if (panelVersion && virtualTypesUnsupportedPanelVersions.has(panelVersion)) return;
    const origin = bridge.tabServerOrigin(tabId);
    // No proven handshake origin → the answer would be keyed on a claim. Skip:
    // an unkeyed registry is not evidence about any server.
    if (!origin) return;
    try {
      const reply = (await bridge.send({ cmd: "graph_get_virtual_types" }, { tabId })) as
        | { ok?: boolean; virtual_types?: unknown }
        | undefined;
      // ok:false (the panel could not read its own registry) or a malformed
      // answer keeps the previous entry rather than replacing it with nothing.
      if (reply?.ok !== true || !Array.isArray(reply.virtual_types)) return;
      const types = reply.virtual_types.filter(
        (t): t is string => typeof t === "string" && t !== "",
      );
      frontendVirtualTypesByOrigin.set(canonicalOrigin(origin) ?? origin, types);
    } catch (err) {
      // A panel that predates the command is a STABLE fact for this process —
      // remember the version and stop re-asking on every hello. Any other
      // failure (timeout, mid-restart socket drop) is transient: the previous
      // answer stands and the next hello retries.
      if (isPanelCmdUnsupportedError(err, "graph_get_virtual_types") ||
          isUnknownCommandReply(err instanceof Error ? err.message : String(err))) {
        if (panelVersion) virtualTypesUnsupportedPanelVersions.add(panelVersion);
      }
    }
  }

  let panelSystemAppend = resolvePanelPersona();
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
      // The INSTALLED version is re-read inside gatherEnvCapabilities on every
      // refresh (#846) — it is a machine fact that can move while we run, so it is
      // probed there rather than captured here beside the constant below.
      const caps = await gatherEnvCapabilities({ comfyuiUrl, comfyuiPath, backendId, mcpVersion: mcpVersionRunning, panelVersion: latestPanelVersion });
      if (gen !== envRefreshGen) return; // a newer refresh superseded us — drop this stale result
      envCaps = caps;
      panelSystemAppend = buildPanelSystemAppend(resolvePanelPersona(), envCaps);
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
      panelSystemAppend = resolvePanelPersona();
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
      resolvePanelPersona(),
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
  // Tabs whose panel Blind toggle is ON (issue #90): the agent's comfyui
  // tool-server spawns get COMFYUI_MCP_BLIND=1 so image-returning tools withhold
  // pixels mechanically. Seeded from `blind` on hello; toggled live via the
  // set_content_mode frame (which respawns the agent at idle so the new env
  // applies). #884: the AGENT is shared across tabs, so the spawn gate is
  // "any tab blind" (see anyTabBlind) — the per-tab set remains the UI state.
  const blindTabs = new Set<string>();

  const comfyuiBaseEnv = (): Record<string, string> => ({
    COMFYUI_URL: comfyuiUrl,
    COMFYUI_MCP_PROGRESS_DIR: progressDir,
    ...(comfyuiPath ? { COMFYUI_PATH: comfyuiPath } : forceRemoteEnv()),
    // NO credentials here. buildComfyuiMcpEnv() is the single authority for every
    // allowlisted credential key (it resolves each from the canonical store at
    // spawn time and DELETES any the store no longer provides). Copying raw
    // process.env tokens into the base defeated that: spreading cannot remove,
    // so an externally revoked token survived here and the next child inherited
    // it as a real env override — a revoke that did not revoke.
    // Test-only tool-call trace (knowledge-parity smoke). No-op unless set.
    ...(process.env.COMFYUI_MCP_TOOL_TRACE ? { COMFYUI_MCP_TOOL_TRACE: process.env.COMFYUI_MCP_TOOL_TRACE } : {}),
    // #873 — the tool-surface policy is forwarded in buildComfyuiMcpEnv(), which BOTH
    // comfyui spawn lanes share. It was here first, and here is only the Codex/Gemini
    // lane: the default Claude lane calls buildComfyuiMcpEnv directly and got nothing.
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
  // WHICH LLM IS DRIVING THIS AGENT — pointed at the file the orchestrator
  // republishes on every turn dispatch (see the onTurn handler). report_issue
  // reads it in the subprocess and stamps the model into the issue body, so a
  // report can be judged against the model that wrote it instead of being
  // attributed by asking the model itself (which answers with a guess). BOTH
  // spawn lanes need it: the HTTP lane below and the Claude lane's
  // buildMcpServers() — a var forwarded on only one of them is the recurring
  // defect this file already carries two separate warnings about.
  const agentIdentityEnv = (agentKey: string | undefined): Record<string, string> =>
    agentKey ? { [AGENT_IDENTITY_ENV]: agentIdentityPath(bridgePort, agentKey) } : {};
  // #788 — `toolMode: null` OMITS the key entirely, which is NOT the same as
  // passing "compact": a pre-baked value is read downstream as a caller-explicit
  // pin and outranks per-model auto-selection, so the Ollama-family backends
  // (the only lane where the constraint is the MODEL's capacity rather than a
  // host's tool budget) must leave the slot empty for comfyuiSpawnToolMode to
  // fill. The HTTP lane keeps its pinned #291 value.
  const makeHttpBackendMcpServers = (tabId: string, toolMode: ToolMode | null = httpLaneComfyToolMode) => ({
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
        ...(toolMode ? { COMFYUI_MCP_TOOL_MODE: toolMode } : {}),
        // #884 — the agent is shared, so Blind is conversation-wide (anyTabBlind).
        ...(anyTabBlind() ? { COMFYUI_MCP_BLIND: "1" } : {}),
        // Self-scope downloads to the OWNING conversation (#547/#884 — codex r2:
        // the HTTP lane never stamped, so with several agents live its settled
        // downloads resolved to nobody and the owning conversation stalled).
        // `tabId` here IS the agent key (the scope address the lane binds).
        COMFYUI_MCP_TAB: tabId,
        // …and the same key addresses this agent's published identity.
        ...agentIdentityEnv(tabId),
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
    // The ENVIRONMENT block's `Backend:` line must name THIS backend (#358).
    //
    // …plus the panel-tools retraction when the loopback panel MCP failed to bind.
    // Applied HERE, once, rather than at each of the thirteen construction sites,
    // because the condition is a property of the RUN and not of the backend: every
    // branch below that returns a backend is handed makeHttpBackendMcpServers(),
    // which drops the `panel` entry on exactly this failure.
    const sysAppend =
      systemAppendForBackend(backend) + panelToolsRetraction(backend, panelMcpHttp !== null);
    try {
    if (backend === "codex") {
      return new CodexBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: codexModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(key),
      });
    }
    if (backend === "gemini") {
      return new GeminiBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: geminiModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(key),
      });
    }
    if (backend === "antigravity") {
      return new AntigravityBackend({
        cwd: comfyuiPath ?? process.cwd(),
        ...(antigravityModel ? { model: antigravityModel } : {}),
        systemAppend: sysAppend,
        mcpServers: makeHttpBackendMcpServers(key),
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
        mcpServers: makeHttpBackendMcpServers(key),
      });
    }
    if (backend === "qwen") {
      return new QwenBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: qwenModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(key),
      });
    }
    if (backend === "ollama") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: ollamaModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(key, null),
        ...ollamaDeps(),
      });
    }
    if (backend === "openrouter") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: openrouterModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(key, null),
        ...openrouterDeps(),
      });
    }
    if (backend === "lmstudio") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: lmstudioModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(key, null),
        ...lmstudioDeps(),
      });
    }
    if (backend === "llamacpp") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: llamacppModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(key, null),
        ...llamacppDeps(),
      });
    }
    if (backend === "custom") {
      return new OllamaBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: customModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(key, null),
        ...customDeps(),
      });
    }
    if (backend === "chatgpt") {
      return new ChatGptOAuthBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: chatgptModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(key),
      });
    }
    const simpleKeyReg = simpleKeyProvider(backend);
    if (simpleKeyReg) {
      // glm/moonshot (and any future simple api-key provider) share one factory.
      return makeOpenAiKeyBackend(simpleKeyReg, {
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(key),
      });
    }
    if (backend === "kimi") {
      return new KimiBackend({
        cwd: comfyuiPath ?? process.cwd(),
        model: kimiModel,
        systemAppend: sysAppend,
        comfyuiUrl,
        mcpServers: makeHttpBackendMcpServers(key),
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
        mcpServers: makeHttpBackendMcpServers(key),
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
      `codex/gemini/grok/qwen panel_* live-graph tools via loopback HTTP MCP${panelMcpHttp ? ` on :${panelMcpHttp.port}` : " UNAVAILABLE"} + headless comfyui MCP`,
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
              : backend === "qwen"
                ? new QwenBackend({ cwd: comfyuiPath ?? process.cwd(), model: qwenModel })
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

  // Durable session ids (keyed by our bridge port), so the agent resumes its
  // conversation even after the orchestrator PROCESS is killed and respawned (a
  // wedge auto-restart) — not just a soft reload. Persisted on disk in the
  // user's config dir (~/.comfyui-mcp/sessions), orchestrator-owned (#884).
  const sessionStore = new SessionStore(lockPort);
  // The Claude-path MCP server set, REBUILT on demand so a just-saved tool secret
  // (persisted by panel-secrets) lands in the comfyui server's spawn env. The
  // comfyui server is declared LAST so it always wins over any user entry that
  // slipped through (defensive — the reader already filters comfyui-mcp entries).
  // `agentKey` (when given) stamps the spawn's download rows — #884: the row
  // must name the CONVERSATION that started the download (the agent key), not a
  // tab id, because a tab can switch backends while the download runs and its
  // current-backend resolution would then wake the WRONG conversation (codex
  // round 1, P1). Legacy rows carrying a tab id still resolve via fallback.
  const buildMcpServers = (agentKey?: string) => ({
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
        // Self-scope downloads to the owning CONVERSATION (#547/#884) — the
        // child stamps its own COMFYUI_MCP_TAB into each progress row, and the
        // settle path resolves an agent-key-shaped stamp directly.
        ...(agentKey ? { COMFYUI_MCP_TAB: agentKey } : {}),
        // Which LLM is driving this agent, for report_issue's stamp (see
        // agentIdentityEnv). Same key, same reason it is keyed by agent.
        ...agentIdentityEnv(agentKey),
        // Local mode → enables download_model, apply_manifest (installer packs),
        // and model scans so the agent installs the right way instead of curl.
        ...(comfyuiPath ? { COMFYUI_PATH: comfyuiPath } : forceRemoteEnv()),
        // Blind (issue #90) — conversation-wide under the shared agent (#884).
        ...(anyTabBlind() ? { COMFYUI_MCP_BLIND: "1" } : {}),
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
    // canvas through the loopback HTTP MCP instead). Bound to the backend-
    // QUALIFIED scope address (the agent key): panel_* tools resolve to the
    // ACTIVE tab at each dispatch (#884) — one agent serves whichever workflow
    // the user is on — while the workflow-stamp resolver can answer per
    // CONVERSATION (concurrently in-flight turns on two backends never share
    // one issue-time stamp).
    makePanelServer: (key) =>
      backendOf(key) === "claude"
        ? createPanelMcpServer(bridge, key, workflowTargets)
        : undefined,
    mcpServers: buildMcpServers(),
    // Per-KEY factory — spawns must reflect live state (the Blind gate) and
    // stamp downloads with the OWNING agent key; the static set above stays as
    // the fallback.
    makeMcpServers: (key) => buildMcpServers(key),
    // Blind (issue #90) — the env above only gates the comfyui MCP subprocess;
    // the Claude SDK agent ALSO holds native Read/WebFetch, which deliver
    // pixels with no MCP tool in the path. This live predicate feeds the
    // backend's PreToolUse deny gate (conversation-wide per #884, like the env).
    isBlind: () => anyTabBlind(),
    // NOTE: manager callbacks fire with the composite agent key
    // `orchestrator::<backend>`; pushToConversation fans each frame out to every
    // connected tab participating in that backend's conversation (#884) — the
    // same conversation is visible from every tab.
    onSay: (key, text, meta) => {
      // `id` lets the panel reconcile this committed message with its live
      // streaming preview (same id) instead of rendering a duplicate bubble.
      pushToConversation(key, { type: "say", text, id: meta?.id, streamed: meta?.streamed });
    },
    // Live streaming deltas → the panel's think-window + streaming reply bubble.
    onStream: (key, ev) => {
      pushToConversation(key, { type: "stream", phase: ev.phase, id: ev.id, delta: ev.delta });
    },
    // Per-response usage → the panel's context/usage meter (updates live).
    onStatus: (key, status) => {
      // agent_status is mirror-safe — attached viewers get it via their driven tab.
      for (const t of conversationDeliveryTabs(key, "agent_status")) pushStatus(t, status);
    },
    // Report the SDK session id so the panel can persist it and resume on reload.
    // (The orchestrator's own disk store — written by the manager before this
    // fires — is authoritative; the panel copy is a last-resort hint.)
    onSession: (key, sessionId, model) => {
      pushToConversation(key, { type: "session", session_id: sessionId });
      bridge.broadcastTabList(); // a session started/changed → refresh mirror pickers
      // #376: the ready banner was sent at hello with the PRE-init default model.
      // Now the SDK reports the ACTUALLY-resolved model — remember it, then re-send
      // a corrected banner IFF a banner was actually advertised for a tab AND the
      // resolved model differs (bannerCorrection returns null otherwise, so a resume
      // with no prior greeting is never "corrected" and a correct banner never
      // duplicates). Per tab: each participating tab advertised its own banner.
      // Banner corrections are "say" frames (mirror-safe) — viewers via mirror.
      for (const panelTab of conversationDeliveryTabs(key, "say")) {
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
      }
    },
    // Per-turn rewind anchor (assistant UUID) → the panel stores it so a later
    // "rewind conversation to here" can fork the session at that point.
    onTurnAnchor: (key, uuid) => {
      pushToConversation(key, { type: "turn_anchor", uuid });
    },
    // Turn lifecycle → the panel's "working" indicator (stays up through silent
    // tool work; clears on done).
    onTurn: (key, state) => {
      // #884 P0 — the turn ended: release its routing pin so idle-time scope
      // resolution follows the active tab again (the next turn re-pins).
      if (state === "done") turnOrigins.turnEnded(key);
      // Publish WHICH LLM this turn runs on, for report_issue's stamp. Here
      // because "working" fires at DISPATCH — before the backend starts the
      // turn, and therefore before any tool the turn calls — so the file the
      // subprocess reads always describes the turn doing the reporting. A
      // spawn-time env var could not: setModel is live and never respawns, so
      // it would stamp reports with the model the user switched AWAY from.
      if (state === "working") republishAgentIdentity(key);
      pushToConversation(key, { type: "turn", state });
    },
    // Live extended-thinking token count → "thinking… (N)" indicator.
    onThinking: (key, tokens) => {
      pushToConversation(key, { type: "thinking", tokens });
    },
    // Tool the agent invoked → a compact "activity" line for canvas-less clients
    // (mobile), so watching the agent work isn't just a spinner.
    onToolCall: (key, name) => {
      pushToConversation(key, { type: "action", name });
    },
    // The agent dequeued a message (the true "read" moment) → flip that bubble
    // from queued/muted to read. Fanned out: tabs that don't know the mid ignore it.
    // #884 — this is also the moment the message's TURN begins, so its recorded
    // issue-time origin becomes the conversation's pin + stamp (not at receipt
    // — codex round 2). The whole aggregation — batching, agree-or-fail-closed,
    // origin inheritance, and the backend re-verification (confirming gate 3,
    // P0) — lives in TurnOriginTracker.onSeen so it is testable at its seam.
    onSeen: (key, mid) => {
      turnOrigins.onSeen(key, mid);
      pushToConversation(key, { type: "ack", ok: true, kind: "seen", mid });
    },
    // PER-BACKEND start failure (issue #250): a backend that rejects at
    // prepare()/first-connect — an invalid API key 401ing on an OpenAI-dialect
    // provider (moonshot/glm/custom/openrouter), an unreachable endpoint — is a
    // provider-local configuration error, the same class as the keyless ctor
    // path (#209), one step later. Degrade THAT backend's conversation only: an
    // honest say naming the provider with check-your-key guidance, plus a
    // degraded ack so the panel shows the real state. The manager already
    // dropped the dead agent, so fixing the key and Disconnect → Connect (or
    // just re-sending) retries cleanly. This must NOT self-exit — a bad
    // moonshot key was killing healthy sessions on every other provider.
    onStartFailure: (key, message) => {
      // Frame construction (hint selection via the key-provider registry,
      // composite-key split, say + degraded ack + turn:done) lives in
      // start-failure-notice.ts so it is unit-testable (issue #255). #884: the
      // frames fan out to every tab on the failed backend's conversation.
      const { backend, frames } = buildStartFailureNotice(key, message, defaultBackend);
      for (const frame of frames) {
        // The say is the only HUMAN-facing frame of the three, and #884's conversation
        // spans every tab on this backend — which can be several panels in DIFFERENT
        // languages. So it is rendered per recipient rather than pushing one pre-rendered
        // copy; deriving a single locale from the key cannot work either, since the key is
        // usually the SCOPE address `orchestrator::<backend>` and resolves to whichever tab
        // happens to be pinned or last-active. The ack + turn are machine state and fan out
        // unchanged. Push order (say → ack → turn) is preserved.
        if (frame.type === "say") {
          pushSayToConversation(key, (locale) => startFailureSay(backend, message, locale));
        } else {
          pushToConversation(key, frame);
        }
      }
      logger.warn(
        `[panel-orchestrator] ${backend} agent failed to start — degraded THIS backend's conversation only, other providers unaffected (${message})`,
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
      logger.warn(
        `[panel-orchestrator] ${key.slice(0, 24)} handed back ${tokens.length} undelivered event(s) — journaled for replay (#468/#486)`,
      );
      // Try again immediately. When the agent is still alive (a stall-abandoned
      // turn, a plain Stop) this re-queues the completion into its next turn;
      // when it is going away, injectEvent refuses and the entry simply stays
      // pending for the next spawn. The refusal path returns false WITHOUT
      // calling back here, so this cannot recurse. #884: the journals stay keyed
      // by the PANEL TAB that queued the work while the agent is shared, so the
      // replay sweeps every tab with pending entries.
      flushAllJournaledEvents();
    },
    // A fresh agent for this key can take mail now — replay whatever the
    // previous one never delivered (from every tab's journal — the agent is
    // shared, #884).
    onAgentReady: () => {
      flushAllJournaledEvents();
    },
    sessionStore,
  });
  // Let refreshEnvCapabilities() feed a freshly-gathered env block into agents
  // spawned after a ComfyUI restart/reconnect.
  liveManager = manager;
  // #1700 — panel_reload({scope:"orchestrator"}) must fork-respawn so a
  // panel_remove_mcp / panel_add_mcp is not lost to the resumed session's
  // recorded MCP set. The tool itself lives in the panel MCP and cannot
  // reach the manager except through this hook.
  setApplyMcpReload((key) => {
    manager.restartForMcpConfig(key);
  });

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
  // #486 — a `wf:` route tab id names a WORKFLOW, so a second browser tab can
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
  // #486 — a DIFFERENT browser tab taking over a recurring `wf:` route key is a
  // CONVERSATION BOUNDARY, exactly like New chat or a provider switch: the
  // newcomer never asked the previous occupant's questions, so its answers must
  // stop being recoverable and stop being pushed. closeAsks downgrades and
  // unsends; it never deletes, so those answers are still reported.
  // panel#1554 — same boundary, same reason: a confirmation card the previous
  // occupant abandoned must not be claimable by the newcomer. Both retirements ride
  // THIS one listener because the bridge takes a single takeover listener, so a
  // second setTabTakenOverListener call would silently replace the first.
  bridge.setTabTakenOverListener((tabId) => {
    AskAnswers.closeAsks(tabId);
    forgetAbandonedConfirmCards(tabId);
  });
  bridge.setTabGoneListener((tabId, incarnation) => AskAnswers.retireDebt(tabId, incarnation));
  // #694 — the bridge retains a late mutation only for commands that can come
  // back as a retry token, which is the retry-token layer's own set. Installed
  // here because ui-bridge cannot import panel-tools (panel-tools imports it).
  bridge.setLateMutationFilter((cmdName) => RETRY_TOKEN_CMDS.has(cmdName));
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
    // the user can do is give it again. Telling someone to check
    // `get_history (action:"list")`
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
        // Per TAB, so each person reads this in their own panel's language. `{ count }` is
        // passed even though the English fallback hedges with "(s)": it lets a catalog
        // supply real plural forms (`_one`/`_few`/`_other` via Intl.PluralRules, which
        // knows Korean has one form and Russian four) without touching the English here.
        const locale = bridge.tabLocale(panelTab);
        // Two different losses, two different remedies — never merged.
        const parts: string[] = [
          `⚠️ ${trFor(locale, "say.restart_lost.header", "The agent backend is being restarted.")}`,
        ];
        if (runs.length) {
          // `get_history (action:"list")` is a TOOL CALL the user relays to the agent, so it
          // stays spelled exactly as typed in every language.
          parts.push(
            trFor(
              locale,
              "say.restart_lost.runs",
              `{count} finished render result(s) could not be delivered ({runs}). ` +
                `Their outcome is UNDETERMINED from the agent's point of view — ask it to check \`get_history (action:"list")\` ` +
                `for those runs once it reconnects rather than assuming it saw them.`,
              { count: runs.length, runs: runs.join("; ") },
            ),
          );
        }
        if (answers.length) {
          parts.push(
            trFor(
              locale,
              "say.restart_lost.answers",
              `{count} answer(s) you gave on a question card never reached the agent: {answers}. ` +
                `An answer is not a render — there is NO history to look it up in, and the agent has no way to ` +
                `recover it once this restart completes. Please tell it your choice again (or paste the text above) ` +
                `when it comes back.`,
              { count: answers.length, answers: answers.join("; ") },
            ),
          );
        }
        if (withheld > 0) {
          // Counted, not quoted: these were given to a conversation that has been
          // replaced (a new chat, a rewind, a provider switch, another tab taking
          // this workflow). Their text is in the log, not on this screen.
          parts.push(
            trFor(
              locale,
              "say.restart_lost.withheld",
              `{count} further answer(s) on this tab belong to an earlier conversation that has ` +
                `since been replaced; they were never delivered either, but they are not shown here ` +
                `because they were not given to the conversation you are in now.`,
              { count: withheld },
            ),
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
      // #884 P0 — the injected turn carries the completion's ORIGIN tab, so it
      // pins/stamps there (show the render on the tab that ran it), never on
      // whatever tab is active (confirming-gate 2).
      manager.injectEvent(key, payload, { eventToken: token, mid: turnOrigins.mintInjectionOrigin(panelTabId) }),
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
      // #884 P0 — same origin ride as run completions (confirming-gate 2).
      manager.injectEvent(key, payload, { eventToken: token, mid: turnOrigins.mintInjectionOrigin(panelTabId) }),
    );
    if (blockedOn) {
      logger.warn(
        `[panel-orchestrator] tab ${panelTabId.slice(0, 8)} has no live agent for the user's answer to "${previewQuestion(blockedOn.question)}" — journaled, replayed when one comes back (#486)`,
      );
    }
  }

  /**
   * #884 — replay EVERY tab's journaled events. The journals stay keyed by the
   * panel tab that queued the work (delivery provenance), but the agent is
   * shared, so a delivery opportunity (a fresh spawn, a hand-back) must sweep
   * every tab with pending entries — not just one. Union of the connected tabs
   * and every key holding an outstanding entry.
   */
  function flushAllJournaledEvents(): void {
    const keys = new Set<string>();
    for (const t of bridge.tabs()) keys.add(t.tab_id);
    try {
      for (const e of RunCompletions.allOutstanding()) keys.add(e.key);
      for (const e of AskAnswers.allOutstanding()) keys.add(e.key);
    } catch {
      // enumeration is best-effort — connected tabs still flush
    }
    for (const k of keys) {
      flushRunCompletions(k);
      flushAskAnswers(k);
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
  // #884 — a scope-addressed caller's stamp is the workflow its conversation's
  // CURRENT TURN was issued for (turnOrigins.stampOf — captured at user-message
  // dispatch, refreshed by #716's explicit open/re-pin), NOT the active tab's
  // current workflow: re-resolving at dispatch would let a mutation conceived
  // on workflow A silently land on workflow B after a mid-turn switch (codex
  // round 1, P0). A real-tab caller keeps the per-tab stamp.
  const scopeToRealTab = (tabId: string): string | undefined =>
    isScopeAddress(tabId) ? bridge.resolveSharedTabId(tabId) : panelTabOf(tabId);
  // #884 P0 (confirming gate) — while a conversation's turn is in flight, its
  // scope-addressed tool calls are PINNED to the tab the turn was issued from;
  // `null` (ambiguous origin) makes the bridge refuse loudly; no entry lets
  // the bridge fall back to active-tab resolution (idle-time probes).
  bridge.setScopeTargetResolver(makeScopeTargetResolver({ tracker: turnOrigins, scopeAgentKeyOf }));
  // #952 — let a headless `fetch failed` say whether the connected panel is on a
  // DIFFERENT ComfyUI than COMFYUI_URL. The reporter's readonly tools failed
  // while every panel tool worked, and nothing in the error connected the two.
  // SERVER-OBSERVED origins only (tabServerOrigin): the browser sets the
  // handshake Origin and page JS cannot forge it, unlike hello.comfyui_url.
  setConnectedPanelOrigins(() => bridge.connectedServerOrigins());
  // #884 P1 (confirming gate 2) — EXPLICIT recovery from a DEAD or AMBIGUOUS
  // pin, and from those only. The bridge's refusal names
  // panel_set_workflow_target as the way out; this is the ONLY path that
  // rewrites an in-flight pin, it is reached solely through the agent's
  // explicit mode:"current" consent, and it refuses to displace a pin that
  // still reaches a live tab (confirming gate 3, P0: the recovery path was
  // silently repinning HEALTHY turns via panel_reload — the exact silent
  // re-target this whole change exists to prevent). The handler is the real
  // production seam (turn-origins.ts) so tests drive it directly.
  bridge.setScopeRepinHandler(
    makeScopeRepinHandler({
      bridge,
      tracker: turnOrigins,
      scopeAgentKeyOf,
      backendForTab,
      backendOfKey: backendOf,
      info: (msg) => logger.info(msg),
      // panel#1557 — a unique-canvas reconnect that hello'd without `backend`
      // joined the default conversation; claiming puts it on this one so the
      // pin we just wrote is not immediately invalidated at resolution.
      claimTab: (tab, backend) => {
        tabBackends.set(tab, backend);
      },
    }),
  );
  // #884 P1 (confirming gate 2) — a hello whose `backend` is absent or unknown
  // JOINS the default conversation, so its backend-qualified buffers must drain
  // to it too. Matching on the raw string alone stranded that tab's mailbox
  // (offline show_media never arriving), which is silent output loss. The ONE
  // shared normalizeHelloBackend implementation is also what the hello handler
  // itself uses to decide which conversation the tab joins, so the two mappings
  // can no longer disagree (a disagreement made a tab join one conversation and
  // drain another's buffers).
  bridge.setHelloBackendNormalizer((raw) => normalizeHelloBackend(raw, KNOWN_BACKENDS, defaultBackend));
  bridge.setTabWorkflowUuidResolver(
    (tabId) => {
      if (isScopeAddress(tabId)) return turnOrigins.stampOf(scopeAgentKeyOf(tabId));
      const t = panelTabOf(tabId);
      return t ? tabCommandWorkflowUuid.get(t) : undefined;
    },
    (tabId, workflowUuid) => {
      // A command reply is useful only while its routed tab still exists, and
      // only when its UUID has the same strict shape/origin binding as hello.
      // Invalid/missing panel data leaves the old stamp in place, causing the
      // existing fail-closed fence to reject a subsequent mutation.
      // #1077 — each gate now says WHICH one refused. All three used to return a
      // bare `false`, so a permanently-wedged session could only be told "the
      // adoption was REFUSED", and the reporter who traced it had no orchestrator
      // log to fall back on. One of these is structurally unsatisfiable for a
      // relay-backend session, and that is invisible without this.
      try {
        // #1077 — an AMBIGUOUS turn is not a dead tab. Both fail canReach, and
        // calling the first the second sent the caller to reconnect a panel that
        // was never disconnected. The wording lives in fence-refusal.ts so it is
        // testable without standing up the orchestrator.
        if (!bridge.canReach(tabId))
          return { ok: false, reason: unreachableReason(tabId, bridge.resolveFailure?.(tabId)) };
      } catch (err) {
        return {
          ok: false,
          reason: `checking whether the routed tab (${tabId}) is reachable threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const panelTab = scopeToRealTab(tabId);
      if (!panelTab) return { ok: false, reason: noPanelTabReason(tabId) };
      const origin = bridge.tabServerOrigin(tabId);
      const identity = workflowIdentityParts({ workflowUuid, origin });
      if (!identity)
        return {
          ok: false,
          reason: identityReason(tabId, origin, workflowUuid, bridge.resolveFailure?.(tabId)),
        };
      tabCommandWorkflowUuid.set(panelTab, identity.uuid);
      // A VALIDATED refresh (an explicit open / panel_set_workflow_target({mode:"current"})
      // / a save reply's workflow_uuid) is an observation about this tab id — it is the
      // documented way out of the carried state (#1656).
      tabStampCarried.delete(panelTab);
      // #716/#884 — an explicit, VALIDATED open/re-pin from the shared agent is
      // the agent deliberately moving its turn to another workflow: refresh
      // that CONVERSATION's issue-time stamp too, so its subsequent edits
      // target the workflow it just opened instead of being declined until the
      // next user message.
      if (isScopeAddress(tabId)) turnOrigins.setStamp(scopeAgentKeyOf(tabId), identity.uuid);
      return true;
    },
  );
  // #1656 — the provenance half of the same answer. A SCOPE address never carries: its
  // stamp is the conversation's issue-time value, not a tab advertisement. A real tab id
  // is resolved through panelTabOf exactly like the resolver above, so an agent-key
  // address and the bare tab id give the same verdict.
  bridge.setCarriedTabStampPredicate((tabId) => {
    if (isScopeAddress(tabId)) return false;
    const t = panelTabOf(tabId);
    return t ? tabStampCarried.has(t) : false;
  });
  // #1656 — and the way OUT of the carried state that does not move anything. The
  // fence-mismatch probe reads the live canvas with workflow_list; when the corroborated
  // active record names the instance this tab's stamp ALREADY holds, the inherited value
  // has been confirmed by an observation of the tab under its CURRENT id.
  //
  // The equality test is the whole safety argument, and it is enforced HERE rather than
  // trusted from the caller: no stamp is written, no conversation stamp is touched, and a
  // uuid that does not already match is REFUSED outright. So this can never retarget a
  // session — which is exactly why it is not routed through refreshWorkflowUuid (#1646:
  // a read-only diagnosis that re-points the fence is the corruption the fence exists to
  // prevent, delivered as recovery).
  bridge.setTabStampCorroborator((tabId, workflowUuid) => {
    const panelTab = scopeToRealTab(tabId);
    if (!panelTab) return false;
    // Same validator as every other identity acceptance: server-observed origin +
    // the uuid's shape/origin binding. Never a bare string from a reply.
    const identity = workflowIdentityParts({
      workflowUuid,
      origin: bridge.tabServerOrigin(tabId),
    });
    if (!identity) return false;
    if (tabCommandWorkflowUuid.get(panelTab) !== identity.uuid) return false;
    tabStampCarried.delete(panelTab);
    return true;
  });

  // ── Local-agent VRAM pause during generation ────────────────────────────
  // On a single-GPU box the local chat model and ComfyUI fight for VRAM:
  // a resident model can OOM a render, and a chat sent mid-render reloads the
  // model on top of the running generation. So while a render is in flight we
  // (a) unload the local model to free its VRAM, and (b) HOLD any chat the user
  // sends and answer it once the render finishes (warming the model back). Only
  // LOCAL backends join (native ollama dialect; loopback LM Studio / llama.cpp —
  // hosted or remote endpoints don't touch local VRAM); default on, opt out
  // with COMFYUI_MCP_PAUSE_LOCAL_ON_GEN=0 (the
  // legacy COMFYUI_MCP_OLLAMA_PAUSE_ON_GEN=0 is still honored).
  const pauseLocalDuringGen = pauseLocalOnGenEnabled();
  const anyLocalOllama = (): boolean =>
    ollamaApi === "ollama" &&
    (defaultBackend === "ollama" || [...tabBackends.values()].includes("ollama"));
  // LM Studio joins the same VRAM handoff (issue #160 follow-up): local server
  // only — a remote COMFYUI_MCP_LMSTUDIO_HOST is someone else's VRAM.
  const anyLocalLmstudio = (): boolean =>
    isLocalLmstudio(LMSTUDIO_BASE_URL) &&
    (defaultBackend === "lmstudio" || [...tabBackends.values()].includes("lmstudio"));
  // llama.cpp too (issue #874), HOLD-ONLY: llama-server has no unload surface
  // and llama-swap swaps models upstream on demand, so there is nothing to
  // free or warm — holding mid-render chats is what stops the contention.
  // Local server only — a remote COMFYUI_MCP_LLAMACPP_HOST is someone else's
  // VRAM and is never gated.
  const anyLocalLlamacpp = (): boolean =>
    isLocalLlamacpp(LLAMACPP_BASE_URL) &&
    (defaultBackend === "llamacpp" || [...tabBackends.values()].includes("llamacpp"));
  // agentKey -> messages held while a render runs (flushed on render end).
  const heldDuringGen = new Map<string, Array<{ text: string; opts: Record<string, unknown> }>>();
  let genPauseActive = false;
  if (pauseLocalDuringGen) {
    QueueMonitor.setTransitionHandlers({
      onRunStart: () => {
        const ol = anyLocalOllama();
        const ls = anyLocalLmstudio();
        const lc = anyLocalLlamacpp();
        if (!ol && !ls && !lc) return;
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
          // #884 — keys are shared (`orchestrator::<backend>`); the notices fan
          // out to that backend's conversation like any other agent output.
          if (msgs.length > 0) {
            // Per tab: this conversation's members may be in different panel languages.
            pushSayToConversation(
              key,
              (locale) =>
                `✅ ${trFor(
                  locale,
                  "say.local_agent_resumed",
                  "Render finished — the local agent is back. Answering your queued message now.",
                )}`,
            );
          }
          for (const m of msgs) {
            pushToConversation(key, { type: "turn", state: "working" });
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
    // call_tool path the mobile app uses (get_workflow, get_image, …) goes through
    // getClient(), which caches against the process-start host. Without this, a
    // retargeted orchestrator keeps that client pinned to the old ComfyUI, so mobile
    // get_workflow (action:"list") then silently reads the wrong (often empty) library. resetClient()
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
        if (!config.comfyuiPath) config.comfyuiPath = recovered;
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
  // panel_request_secret (e.g. CIVITAI_API_TOKEN for download_model action:"download_civitai"), the
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
    //
    // #1567 — arm the orphan check BEFORE restarting, because an idle tab respawns
    // inside this call. This is the ONLY path allowed to arm it: a respawn from a
    // credential save is the one that queues, waits turns, and then kills whatever
    // transfers exist by then. Scoped to the tab this change belongs to, matching the
    // retry nudge below — the transfers are global (every tab's child is replaced), so
    // it must be reported once rather than once per tab.
    const tally = manager.restartAllForMcpEnvAfterCredentialChange(change.tabId ?? null);
    // NUDGE only the tab whose panel_request_secret this change answers — a
    // Settings slot save, a background token (re)load, or a revoke leaves
    // `requested` false and nudges nothing. The per-tab pending-restart map
    // coalesces, so a repeat event for the same tab can't double-inject (#164).
    // ...and only for a PROVEN save — see `changeJustifiesRetryNudge`, which is
    // where that rule lives and is tested.
    const nudgedTab = changeJustifiesRetryNudge(change) ? (change.tabId ?? null) : null;
    let nudgeOutcome: McpEnvRestartOutcome | null = null;
    if (nudgedTab) nudgeOutcome = manager.restartForMcpEnv(agentKeyFor(nudgedTab), SECRET_RETRY_NUDGE);
    // Tell the SAVER what actually happened (#826). The emit is synchronous, so
    // this lands before setEnvSecret returns and the tool can describe the real
    // disposition instead of promising a respawn nobody observed. A tab with no
    // live agent contributes nothing — restartForMcpEnv already returned
    // "no-agent" for it and the tally counts only agents that exist.
    change.report?.(tally);
    logger.info(
      `[panel-orchestrator] tool secret ${change.requested ? "saved (requested)" : "changed"} → comfyui MCP env updated; ` +
        `agent respawn: ${tally.applied} applied now, ${tally.scheduled} scheduled at idle, of ${tally.live} live` +
        `${nudgedTab ? ` + retry nudge → tab ${nudgedTab.slice(0, 8)} (${nudgeOutcome})` : ""} ` +
        `(keys: ${comfyuiSecretKeys().join(", ") || "none"})`,
    );
  });

  // An agent-provider secret changed (e.g. the OpenRouter API key set from the
  // panel). Hydrate it into env, drop the cached openrouter probe/model list so
  // the next probe uses the new key, and re-push readiness + models to every
  // live tab so the OpenRouter provider flips to "ready" and lists its models
  // without a reconnect.
  const KEYED_PROVIDERS = ["openrouter", "custom", ...OPENAI_KEY_PROVIDER_IDS];
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
    if (backend === "qwen") return qwenModel;
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
  /**
   * Publish WHICH LLM is driving an agent, so report_issue can stamp it into the
   * issue body from the comfyui MCP subprocess (services/agent-identity.ts).
   *
   * Read from THE CHIPS — the same expression pushModels() sends the panel as
   * `current`, so the stamp names exactly what the picker shows rather than a
   * second, drifting notion of "the model". The alternative was asking the model
   * to name itself in the report, which is a guess: the ENVIRONMENT block has
   * never carried the model at all, only `Backend:`.
   *
   * Called on every turn dispatch, and it WRITES every time. A dedupe cache
   * ("skip when the identity is unchanged") was here and is deliberately gone:
   * it made the write conditional on a belief about the FILE that this process
   * has no way to hold — delete the file underneath a live orchestrator and the
   * cache suppresses the rewrite for the rest of the process's life, leaving
   * every later report from that agent unattributed (fallback merge gate, a
   * dropped P2). The thing it saved is ~100 bytes once per turn, on a path that
   * is already standing up an LLM turn.
   */
  function republishAgentIdentity(key: string): void {
    const backend = backendOf(key);
    publishAgentIdentity(agentIdentityPath(bridgePort, key), {
      backend,
      model: manager.modelOverrideFor(key) ?? currentModelFor(backend),
      effort: manager.currentEffortFor(key),
    });
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
  const readinessProbeGeneration = new Map<string, number>();
  function pushReadiness(tabId: string): void {
    try {
      const { backends, any_ready } = allBackendReadiness(KNOWN_BACKENDS, {
        customEndpointConfigured: !!customBaseUrl,
      });
      const generation = (readinessProbeGeneration.get(tabId) ?? 0) + 1;
      readinessProbeGeneration.set(tabId, generation);
      bridge.push(
        {
          type: "backends",
          backends,
          any_ready,
          discovery_complete: false,
          console_url: consoleUrl,
          console_token: consoleToken,
        },
        tabId,
      );
      void discoverBackendAvailability(backends, {
        ollamaBaseUrl: ollamaBaseUrl ?? "http://127.0.0.1:11434",
        ollamaApi,
        lmstudioBaseUrl: LMSTUDIO_BASE_URL,
        llamacppBaseUrl: LLAMACPP_BASE_URL,
      })
        .then((discovered) => {
          if (readinessProbeGeneration.get(tabId) !== generation) return;
          bridge.push(
            {
              type: "backends",
              backends: discovered,
              any_ready: discovered.some((entry) => entry.ready),
              discovery_complete: true,
              console_url: consoleUrl,
              console_token: consoleToken,
            },
            tabId,
          );
        })
        .catch((err) => {
          if (readinessProbeGeneration.get(tabId) !== generation) return;
          logger.warn(
            `[panel-orchestrator] live provider discovery failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          bridge.push(
            {
              type: "backends",
              backends,
              any_ready,
              discovery_complete: true,
              console_url: consoleUrl,
              console_token: consoleToken,
            },
            tabId,
          );
        });
    } catch (err) {
      logger.warn(`[panel-orchestrator] readiness probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Assigned next to the queue-status timer below. Declared here so the hello
  // path can reconcile owed panel_run tickets the moment the panel reconnects
  // (#1556) without waiting for that timer to construct it.
  let runCompletionWatchdog: RunCompletionWatchdog | undefined;

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
      // #1400 — pull this tab's proven frontend-virtual registry for the
      // check_runtime channel. On EVERY hello, not just the first: a page reload
      // is how a pack's frontend JS arrives or leaves, and the reload re-hellos.
      void pullFrontendVirtualTypes(
        panelTab,
        typeof helloPanelVer === "string" && helloPanelVer ? helloPanelVer : undefined,
      );
      // #236 — THE VOCABULARY HANDSHAKE, at the handshake.
      //
      // `describeVocabularySkew` and the hash it compares have existed, fully
      // unit-tested, since the #683 follow-up, and NOTHING called them: the bridge
      // stored the panel's advertised hash on every hello under a comment promising
      // this exact check, and no code read the field. A mechanism can be completely
      // unreachable and still pass every test it has — the tests proved the function
      // worked, never that it ran — so the call site below is asserted directly, by
      // source, in vocabulary-handshake.test.ts.
      //
      // The comparison is done HERE rather than in the bridge because the server's own
      // hash needs buildPanelToolDefs(), and panel-tools.ts imports ui-bridge.ts — the
      // bridge cannot reach it without a cycle. The orchestrator already imports both.
      const helloVocabHash = (event as { vocabulary_hash?: unknown }).vocabulary_hash;
      {
        const advertised =
          typeof helloVocabHash === "string" && helloVocabHash ? helloVocabHash : undefined;
        const skew = describeVocabularySkew(
          serverVocabularyHash(),
          advertised,
          typeof helloPanelVer === "string" ? helloPanelVer : undefined,
        );
        // Reported once per DISTINCT disagreeing vocabulary, for the whole process.
        // A reconnect ping-pong repeats the same hello every few seconds and the same
        // skew is not new news; a panel that UPDATES to a different (still disagreeing)
        // vocabulary is, and its new hash reports again.
        //
        // There is deliberately NO "clear on match" here. Under the per-tab key a
        // stale entry had to be cleared so a tab that came back into agreement and
        // later regressed would report again; keyed by hash there is nothing stale to
        // clear — a regression re-advertises the same disagreeing hash, and if it was
        // already reported, that is genuinely the same news the user already has.
        if (skew.status === "mismatch" && !loggedVocabularySkew.has(advertised!)) {
          // Insertion-ordered, so the first entry is the oldest. Evicted BEFORE the
          // add so the cap is a real bound rather than a bound-plus-one.
          while (loggedVocabularySkew.size >= MAX_LOGGED_VOCABULARY_SKEW) {
            const oldest = loggedVocabularySkew.values().next().value;
            if (oldest === undefined) break;
            loggedVocabularySkew.delete(oldest);
          }
          loggedVocabularySkew.add(advertised!);
          logger.warn(`[panel-orchestrator] ${skew.message}`);
        }
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
            // #888 — the failure detail can be STALE: the sync's pre-scan ran
            // inside the reconnect/retarget window and can describe a tree the
            // retarget has since corrected away from, so "the pack is not present
            // in custom_nodes" can reach the user while the panel is in fact
            // installed and compatible. Before warning, re-run the same
            // authoritative disk scan install_comfyui(action:'panel',
            // panel_action:'status') uses; a
            // PROVEN meets-floor verdict means the sync's goal is already met and
            // the warning would be false — suppress it (logged, never pushed).
            // Any "can't tell" (the re-scan failed, the version is not
            // comparable, the panel is still behind) keeps the original warning
            // verbatim: a failed re-check never certifies the failure as false.
            void reassessPanelAfterSyncFailure()
              .then((reassessment) => {
                if (reassessment?.decision === "meets-floor") {
                  logger.info(
                    `[panel-orchestrator] auto-sync failure on hello suppressed after authoritative ` +
                      `re-scan: panel ${reassessment.installedVersion ?? "?"} meets the floor ` +
                      `${reassessment.requiredPanelVersion} (suppressed failure detail: ${detail})`,
                  );
                  return;
                }
                // AGENT-ONLY. This is operational status with a lock-recovery procedure
                // attached — necessary, and addressed to the wrong reader. Printed in the
                // chat it lands mid-conversation as a wall of text about a subsystem the
                // user did not ask about. pushAgentNote falls back to a visible `say` on
                // a panel too old to understand the hidden frame, so nothing is lost.
                bridge.pushAgentNote(
                  (
                      `⚠️ Could not automatically sync the ComfyUI-MCP panel; no update was claimed. ` +
                      // #784 — this is pushed to the embedded panel chat, whose
                      // tool set does not include install_comfyui(action:'panel'). Name it only where
                      // it can be invoked.
                      `${
                        panelRecoveryContext().installPanelUsable
                          ? "Run install_comfyui(action:'panel', panel_action:'status') to inspect it, then retry install_comfyui(action:'panel', panel_action:'sync') if appropriate."
                          : "Inspect and update the panel pack on the ComfyUI host itself — no tool in this session can do it."
                      } (${detail})`
                  ),
                  panelTab,
                );
              })
              .catch((pushErr) => {
                // reassessPanelAfterSyncFailure null-guards its own failures, so a
                // throw here is the push/log path itself. The sync failure is
                // already logged above; never let the failure HANDLER throw.
                logger.warn(
                  `[panel-orchestrator] could not deliver the auto-sync failure notice: ` +
                    `${pushErr instanceof Error ? pushErr.message : String(pushErr)}`,
                );
              });
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
      // set_backend); absent or unknown → the default. The SAME shared
      // normalizeHelloBackend the bridge's mailbox drain uses — one
      // implementation, so "which conversation does this tab join" and "whose
      // buffers does it drain" can never disagree (confirming gate 2, P1).
      const backend = normalizeHelloBackend(
        (event as { backend?: unknown }).backend,
        KNOWN_BACKENDS,
        defaultBackend,
      );
      // Same-socket re-hello under a NEW tab id (issue #210): the BRIDGE stamps
      // `migrated_from` when the SAME socket re-helloed under a new tab id — a
      // workflow SWITCH, a save/rename (tmp:→wf:), or a panel id-scheme change.
      // #884: the SESSION is orchestrator-scoped, so no agent is rebound,
      // retired or reset here — the conversation deliberately CONTINUES across
      // a workflow switch (that is the invariant: one session, all workflows).
      // Only per-tab ROUTING state moves to the new id.
      const migratedFrom =
        typeof (event as { migrated_from?: unknown }).migrated_from === "string"
          ? ((event as { migrated_from?: string }).migrated_from as string)
          : undefined;
      // This hello's TRUSTED workflow identity (unspoofable handshake origin +
      // the panel's durable per-instance uuid) — kept for the per-command
      // workflow STAMP (#570 P0c, a ROUTING fence), not for session identity.
      const serverOrigin = bridge.tabServerOrigin(panelTab);
      const helloUuid =
        typeof (event as { workflow_uuid?: unknown }).workflow_uuid === "string"
          ? ((event as { workflow_uuid?: string }).workflow_uuid as string)
          : undefined;
      const newIdentity = workflowIdentityParts({ workflowUuid: helloUuid, origin: serverOrigin });

      if (migratedFrom && migratedFrom !== panelTab) {
        // Carry the socket-scoped prefs onto the new id (same browser tab; only
        // its workflow-derived id changed).
        if (!tabBackends.has(panelTab) && tabBackends.has(migratedFrom)) {
          tabBackends.set(panelTab, tabBackends.get(migratedFrom)!);
        }
        tabBackends.delete(migratedFrom);
        if (headlessTabs.has(migratedFrom)) headlessTabs.add(panelTab);
        headlessTabs.delete(migratedFrom);
        if (blindTabs.has(migratedFrom)) blindTabs.add(panelTab);
        blindTabs.delete(migratedFrom);
        // The journals are DELIVERY ADDRESSES keyed by tab id: pending
        // deliveries follow the socket to its new id, so a render finishing
        // after a workflow switch still reaches the one shared conversation
        // that queued it (#884 — the per-workflow design dropped them here).
        RunCompletions.moveKey(migratedFrom, panelTab);
        AskAnswers.moveKey(migratedFrom, panelTab);
        flushRunCompletions(panelTab);
        flushAskAnswers(panelTab);
        // The stamp MOVES to the new id, like every other piece of routing state
        // above it (#1331). It used to be deleted here, and the justification —
        // "a straggler command issued for the old workflow must keep failing the
        // panel's fence" — is satisfied either way, because the OLD id ceases to
        // resolve at all once the socket re-helloes under the new one.
        //
        // A REGRESSION, and one this file already knew about. #436 added
        // `carryWorkflowCommandStamp` for exactly this, recording that deleting it
        // "flapped sessions"; the #884 refactor rewrote this block and left a bare
        // delete in its place. Thirty lines below, the surviving comment still
        // argues the case and even names the scenario: "A reconnect hello that
        // lands before the canvas identity is readable carries no uuid, which is
        // enough to erase the stamp and wedge the tab for the rest of the session."
        // That is #1331 verbatim — reported after a save/rename, which is one of
        // the three events that mints a new tab id.
        //
        // Carrying cannot widen authorization. The panel authorizes a fenced
        // command IFF stamp === the LIVE active workflow uuid, so a carried-but-
        // stale stamp permits nothing a correct one would not; it simply mismatches
        // and is refused, exactly as before. An ABSENT stamp is the asymmetric
        // case: UiBridge then sends frames with no `workflow_uuid`, which the panel
        // also counts as a mismatch, so every fenced command is refused. NOT
        // `workflow_list`, which the panel deliberately exempts as its recovery probe
        // (commandIsCanvasTargetless) — I claimed otherwise in the first version of this
        // comment, an hour after reading the #1337 code that says so. The panel's
        // re-advertise repair is
        // capped at MISMATCH_REHELLO_MAX_PER_IDENTITY (3). Once those are spent the
        // tab is wedged for the session, which is what cost the reporter four calls
        // to recover a state the panel already believed it was in.
        //
        // If THIS hello does resolve an identity, the `set` below overwrites what
        // we carried — new evidence always wins over old.
        if (carryWorkflowCommandStamp(tabCommandWorkflowUuid, migratedFrom, panelTab)) {
          // Inherited, not proven — see tabStampCarried.
          tabStampCarried.add(panelTab);
        } else {
          // The new id kept its OWN entry (newer evidence) or there was nothing to
          // carry; either way nothing was inherited onto it here.
          tabStampCarried.delete(panelTab);
        }
        tabStampCarried.delete(migratedFrom);
        logger.info(
          `[panel-orchestrator] same-socket re-hello ${migratedFrom.slice(0, 12)} → ${panelTab.slice(0, 12)} — routing state carried; the shared session continues (#884)`,
        );
      }

      // Record this tab's trusted per-workflow COMMAND STAMP (#570 P0c — a
      // ROUTING fence kept under #884: a late command issued for another
      // workflow must not mutate this one).
      //
      // #689/#688/#607/#702 — an untrusted identity RETAINS the previous stamp
      // instead of deleting it. Deleting looks like the conservative choice and
      // is in fact the strictly worse one, because the two outcomes are not
      // symmetric:
      //
      //   • The panel authorizes a fenced command IFF stamp === the LIVE active
      //     workflow uuid. So a RETAINED stamp can only ever authorize a command
      //     that names the canvas actually mounted right now — if the workflow
      //     changed, it mismatches and is refused exactly as before. Retaining
      //     therefore permits no write that a correct stamp would not permit.
      //   • A DELETED stamp makes UiBridge send frames with no `workflow_uuid`
      //     at all (`else delete frame.workflow_uuid`), and the panel counts an
      //     unstamped command as a mismatch too (#718, deliberately fail-closed).
      //     So deleting does not relax the fence — it refuses HARDER, and it
      //     refuses everything the fence covers, including `workflow_list`.
      //
      // The asymmetry is that a stale stamp is RECOVERABLE (the next hello that
      // does resolve an identity replaces it) while an absent one is not: the
      // panel's re-advertise repair is capped at MISMATCH_REHELLO_MAX_PER_IDENTITY
      // (3) per identity, so once those attempts are spent against an orchestrator
      // that still cannot derive an identity, nothing retries and every command is
      // refused permanently. A reconnect hello that lands before the canvas
      // identity is readable carries no uuid, which is enough to erase the stamp
      // and wedge the tab for the rest of the session.
      //
      // Untrusted identity therefore means "no NEW evidence", not "the previous
      // evidence is now false". Keep what we last proved and let the fence judge
      // it on equality, which is the only test that decides authorization.
      if (newIdentity) {
        tabCommandWorkflowUuid.set(panelTab, newIdentity.uuid);
        // THIS tab, under THIS id, just advertised an identity — whatever was inherited
        // is superseded by an observation (#1656).
        tabStampCarried.delete(panelTab);
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
        // Provider switch via re-hello: RETIRE (not reset) the previous provider's
        // shared agent — stop it while PRESERVING its durable session, so an
        // A→B→A switch resumes (#570 semantics, kept). #884: the agent is
        // SHARED, so retire only when no OTHER connected tab still runs on that
        // provider — one tab switching must never stop an agent other tabs are
        // actively using. The NEW provider starts fresh or resumes its own
        // shared session (the panel replays the transcript as context on its
        // first message to a fresh provider).
        if (
          shouldRetireSharedAgent({
            switchingTab: panelTab,
            prevBackend: prev,
            connected: bridge.tabs().map((t) => t.tab_id),
            backendForTab,
          })
        ) {
          manager.retire(sharedKeyFor(prev));
          bridge.broadcastTabList(); // live agent dropped on backend switch → refresh dot
        }
        providerSwitched = true;
      }
      tabBackends.set(panelTab, backend);
      // #884 gate-3 confirm (P0) — a provider switch changes which conversation
      // OWNS this tab, so any OTHER conversation's in-flight turn ROUTING to it
      // must fail closed now: the pin was validated when set (dequeue-time
      // backend check), but nothing re-checked it at resolution, so a Claude
      // turn kept mutating a tab that had joined Codex mid-turn. The
      // invalidation judges pins by the bridge's own resolution, so a pin
      // naming any retired predecessor id of this surface (path-compressed
      // migration aliases — codex gate 4) is caught too.
      if (providerSwitched) turnOrigins.tabChangedBackend(panelTab);
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
      const key = sharedKeyFor(backend);

      // #884 — deliver conversation frames that were PARKED while no tab on this
      // backend was connected (a turn finishing during a panel reload). Parked
      // per agent key, so only a matching-backend hello receives them.
      {
        const parked = parkedConversationFrames.get(key);
        if (parked?.length) {
          parkedConversationFrames.delete(key);
          for (const f of parked) bridge.push(f, panelTab);
          logger.debug(
            `[panel-orchestrator] delivered ${parked.length} parked conversation frame(s) for ${backend} to tab ${panelTab.slice(0, 8)}`,
          );
        }
      }

      // #884 — hello.resume is now only a LAST-RESORT hint. Sessions are
      // orchestrator-scoped and the orchestrator's own disk store is the source
      // of truth (it wins inside manager.send()); the panel's stored id matters
      // only when the shared key holds no record at all — a wiped store with
      // nothing to adopt from the per-workflow era. The #570 ownership
      // machinery that used to gate this path (stable keys, sibling/poison
      // guards, the in-place-replacement teardown) enforced per-workflow
      // isolation — the very behavior #884 removes — and is gone with it.
      const resumeHint = typeof event.resume === "string" ? event.resume : undefined;
      if (resumeHint && !manager.hasAnyState(key) && sessionStore.get(key) === undefined) {
        manager.setResume(key, resumeHint);
        logger.info(
          `[panel-orchestrator] armed the panel's hello.resume hint for ${backend} — the orchestrator store had no session of its own (#884 last-resort path)`,
        );
      }

      // Live model list for the picker; SDK slash commands are Claude-only.
      pushModels(panelTab);
      // Truthful provider readiness (this machine runs the agents), so the
      // switcher stops falsely showing "CLI not installed" behind a remote pod.
      pushReadiness(panelTab);
      if (backend === "claude") pushCommands(panelTab);
      bridge.push({ type: "workflow_target", target: workflowTargets.get(key) }, panelTab);
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
      // #1556 — a hello is a reconnect (or the first chance after a missed
      // ComfyUI WS frame). Look up every still-owed panel_run in /history NOW
      // and journal a completion if ComfyUI already finished it, instead of
      // waiting the synthesis grace. Exactly-once: the journal skips a run it
      // already holds.
      void runCompletionWatchdog?.reconcile(RunCompletions.owedCompletions().map((t) => t.promptId));
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
      const isQw = backend === "qwen";
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
            // Translated in the TAB's language, not the process's: "Settings → OpenRouter →
            // 'Set API key…'" names controls the user has to find on their own screen, and
            // a panel in Korean has no menu item spelled "Settings". Env-var names and URLs
            // are typed literally and stay as they are.
            text: `⚠️ ${trFor(
              bridge.tabLocale(panelTab),
              "say.openrouter_no_key",
              "OpenRouter has no API key — the connection would fail on your first message. " +
                "Set it in Settings → OpenRouter → “Set API key…” (masked, stored by the orchestrator — takes effect immediately, no reconnect needed), " +
                "or set the OPENROUTER_API_KEY environment variable and restart the orchestrator. Keys: https://openrouter.ai/keys",
            )}`,
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
            text: `⚠️ ${trFor(
              bridge.tabLocale(panelTab),
              "say.pi_no_credential",
              "pi has no usable provider credential — the connection would greet ready and then fail on your first message. " +
                "Configure a provider: set a provider API key (e.g. ANTHROPIC_API_KEY / OPENAI_API_KEY / CEREBRAS_API_KEY) and restart the orchestrator, " +
                "or run `pi` once and `/login` (stored in ~/.pi/agent/auth.json), then Disconnect → Connect. " +
                "If you already did one of those, check the entry is complete — an ~/.pi/agent/auth.json record with no `key`, " +
                "a models.json provider with no `apiKey`, or GOOGLE_APPLICATION_CREDENTIALS pointing at a missing file cannot authenticate. https://pi.dev",
            )}`,
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
            text: `⚠️ ${trFor(
              bridge.tabLocale(panelTab),
              "say.custom_no_base_url",
              "No endpoint configured — set the base URL in Settings → Custom endpoint (include the /v1, e.g. http://192.168.1.20:8000/v1 for vLLM, or a hosted provider's OpenAI-compatible URL), " +
                "plus “Set API key…” if the server needs one. Both apply immediately — then Connect again.",
            )}`,
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
                : isQw
                  ? (qwenModel ?? (models[0] as { value?: string }).value ?? "Qwen Code")
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
                      // Shell command lines stay verbatim — they are pasted, not read.
                      text: `⚠️ ${trFor(
                        bridge.tabLocale(panelTab),
                        "say.llamacpp_no_jinja",
                        "Your llama-server is running WITHOUT `--jinja`, so tool calling is disabled — every agent action would fail. " +
                          "Restart it with tool support: `llama-server -m <model>.gguf --jinja -c 16384` (current builds enable jinja by default; older ones need the flag), then Disconnect → Connect.",
                      )}`,
                    },
                    panelTab,
                  );
                } else if (props.nCtx && props.nCtx < 16384) {
                  bridge.push(
                    {
                      type: "say",
                      text: `ℹ️ ${trFor(
                        bridge.tabLocale(panelTab),
                        "say.llamacpp_small_context",
                        "Your llama-server context is {tokens} tokens (launch flag -c). The agent's tool payload wants ≥16384 — below that, long turns silently truncate. Consider restarting with `-c 16384` or higher.",
                        { tokens: props.nCtx },
                      )}`,
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
            // Each variant names a per-provider remedy the user performs by hand ("Open LM
            // Studio → Developer → Start Server", "Settings → Custom endpoint"), so it
            // renders in THIS tab's panel language. CLI invocations, env-var names, URLs and
            // model ids are interpolated or quoted literally and never translated — they are
            // typed, not read.
            const dLocale = bridge.tabLocale(panelTab);
            const dtr = (key: string, en: string, vars?: Record<string, string | number>): string =>
              `⚠️ ${trFor(dLocale, `say.degraded.${key}`, en, vars)}`;
            const degradedText = reg
              ? // The key-provider registry (glm / kimi / moonshot / minimax) keeps its sentence
                // in a data table. Keyed by BACKEND with the table's English as the fallback,
                // rather than left as the one branch of this chain that can never be
                // translated: otherwise a Korean panel on GLM gets the start-failure notice in
                // Korean and the degraded notice for the same class of failure in English.
                // The table's copy carries its own leading ⚠️ (asserted in the say-frame
                // tests); stripping it keeps all 15 say.degraded.* fallbacks the same shape, so
                // a catalog never has to guess which ones include the marker.
                dtr(backend, reg.degradedMessage.replace(/^⚠️\s*/u, ""))
              : isCx
              ? dtr("codex", "The background agent isn't responding — the Codex app-server couldn't start. Make sure Codex is installed and signed in (run `codex login`), then Disconnect → Connect to retry.")
              : isCg
                ? dtr("chatgpt", "The background agent isn't responding — ChatGPT direct OAuth couldn't start. Make sure ~/.codex/auth.json exists (run `codex login`), then Disconnect → Connect to retry.")
              : isGm
                ? dtr("gemini", "The background agent isn't responding — the Gemini CLI couldn't start. Make sure the Gemini CLI is installed and signed in (run `gemini` once and complete the Google sign-in), then Disconnect → Connect to retry.")
                : isAg
                  ? dtr("antigravity", "The background agent isn't responding — the Antigravity CLI couldn't answer `agy models`. Install it from https://antigravity.google, run `agy` once and complete the Google Sign-In, then Disconnect → Connect to retry.")
                : isPi
                  ? dtr("pi", "The background agent isn't responding — the pi CLI couldn't run `pi --list-models`. Install it from https://pi.dev (`curl -fsSL https://pi.dev/install.sh | sh`), configure a provider (set a provider API key or run `pi` once and `/login`), then Disconnect → Connect to retry.")
                : isGk
                  ? dtr("grok", "The background agent isn't responding — the Grok CLI couldn't start. Make sure Grok is installed and signed in (run `grok` once and complete the xAI sign-in), then Disconnect → Connect to retry.")
                : isQw
                  ? dtr("qwen", "The background agent isn't responding — the Qwen Code CLI couldn't start. Make sure Qwen Code is installed (npm i -g @qwen-code/qwen-code) and signed in (run `qwen` once and complete /auth, or set DASHSCOPE_API_KEY), then Disconnect → Connect to retry.")
                : isOl
                  ? dtr("ollama", "The background agent isn't responding — Ollama isn't reachable. Start it with `ollama serve` and pull our fine-tuned model (`ollama pull artokun/gemma4-comfyui-mcp:e4b` — gemma4 trained on the comfyui-mcp tool suite — arena-best local model; `:12b` for ~8 GB VRAM), then Disconnect → Connect to retry.")
                  : isLs
                    ? dtr("lmstudio", "The background agent isn't responding — LM Studio isn't reachable at {url}. Open LM Studio → Developer → Start Server and load a tool-calling model (our gemma4-comfyui-mcp GGUFs from Hugging Face work great), or set COMFYUI_MCP_LMSTUDIO_HOST if it serves elsewhere — then Disconnect → Connect to retry.", { url: LMSTUDIO_BASE_URL })
                    : isLc
                      ? dtr("llamacpp", "The background agent isn't responding — llama-server isn't reachable at {url}. Start it with `llama-server -m <model>.gguf -c 16384` (our gemma4-comfyui-mcp GGUFs work great; add --jinja on older builds — required there for tool calling), or set COMFYUI_MCP_LLAMACPP_HOST — then Disconnect → Connect to retry.", { url: LLAMACPP_BASE_URL })
                      : isCu
                        ? dtr("custom", "The background agent isn't responding — your custom endpoint isn't answering at {url}. Check the base URL in Settings → Custom endpoint (it must be OpenAI-compatible and include the /v1) and the API key if the server requires one — then Connect to retry.", { url: customBaseUrl })
                        : isCp
                          ? dtr("copilot", "The background agent isn't responding — GitHub Copilot (experimental) couldn't start. Sign in from the panel's experimental row, then Disconnect → Connect to retry.")
                        : dtr("claude", "The background agent isn't responding — the Claude Agent SDK couldn't start. Make sure you're signed in (run `claude` once), then Disconnect → Connect to retry.");
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
        // RETIRE, never reset: a provider switch must PRESERVE the outgoing
        // provider's durable session (stop its live agent, keep the disk
        // record) so an A→B→A switch resumes — #570 semantics, kept. #884: the
        // agent is SHARED, so retire only when no OTHER connected tab still
        // runs on that provider — one tab's switch must never stop an agent
        // other tabs are actively using.
        if (
          shouldRetireSharedAgent({
            switchingTab: panelTab,
            prevBackend: prev,
            connected: bridge.tabs().map((t) => t.tab_id),
            backendForTab,
          })
        ) {
          manager.retire(sharedKeyFor(prev));
          bridge.broadcastTabList(); // live agent dropped on backend switch → refresh dot
        }
      }
      tabBackends.set(panelTab, reqBackend);
      // #884 gate-3 confirm (P0) — same rule as the hello switch path: the tab
      // now belongs to another conversation, so any in-flight turn of a
      // DIFFERENT backend still pinned to it fails closed instead of keeping a
      // live route onto a tab it no longer owns.
      if (prev !== reqBackend) turnOrigins.tabChangedBackend(panelTab);
      // #884 — this tab just joined the NEW backend's conversation without a
      // re-hello; deliver any frames parked while that conversation had no tab.
      {
        const parked = parkedConversationFrames.get(sharedKeyFor(reqBackend));
        if (parked?.length) {
          parkedConversationFrames.delete(sharedKeyFor(reqBackend));
          for (const f of parked) bridge.push(f, panelTab);
        }
      }
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
      // #884 — the pin belongs to the CONVERSATION (whose tool ctx is bound to
      // the backend-qualified scope address), not to one tab: store + sequence
      // live under that key so the agent's command injection and this picker
      // agree, and a newer selection from any tab on the backend supersedes an
      // in-flight async pin.
      const pinKey = sharedKeyFor(backendForTab(panelTab));
      const seq = (workflowTargetSeq.get(pinKey) ?? 0) + 1;
      workflowTargetSeq.set(pinKey, seq);
      const isCurrent = () => workflowTargetSeq.get(pinKey) === seq;
      const ackTarget = (t: ReturnType<typeof workflowTargets.set>) => {
        bridge.push({ type: "ack", ok: true, kind: "workflow_target", target: t }, panelTab);
        // The pin is shared — every connected tab's picker reflects it.
        for (const tab of bridge.tabs()) {
          bridge.push({ type: "workflow_target", target: t }, tab.tab_id);
        }
        logger.info(
          `[panel-orchestrator] tab ${panelTab.slice(0, 8)} workflow target → ${t.mode}${t.path ? ` (${t.path})` : ""} (shared)`,
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
            workflowTargets.set(pinKey, {
              mode: "pinned",
              path: res.pinPath,
              filename: res.pinFilename,
            }),
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
      ackTarget(workflowTargets.set(pinKey, { mode, path, filename }));
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
      // The RECEIPT, not merely "did the call throw". This route discarded it
      // entirely and answered `ok:true` for every verdict — including a save
      // whose read-back could not be taken, and one that PROVED other
      // credentials were destroyed (codex gate). `ok` is the same question the
      // console endpoint and the tool ack ask: `persisted === "yes"`.
      let receipt: SecretSaveReceipt | undefined;
      try {
        if (!value.trim()) throw new Error("No token entered — nothing was saved.");
        receipt = isAllowedComfyuiSecretKey(key)
          ? setComfyuiSecret(key, value.trim())
          : setAgentSecret(key, value.trim());
        logger.info(`[panel-orchestrator] secret set from panel Settings: ${key} (redacted)`);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      // ONE derivation of "may the panel paint this green", shared with every
      // other consumer of a receipt (see secretSavedReply).
      const reply = receipt ? secretSavedReply(receipt) : { ok: false, error };
      bridge.push(
        {
          type: "secret_saved",
          key,
          ok: reply.ok,
          ...(reply.error ?? error ? { error: reply.error ?? error } : {}),
          ...(reply.warnings?.length ? { warnings: reply.warnings } : {}),
        },
        event.tab_id,
      );
      // Readiness still reflects whatever the store ACTUALLY carries now, so it
      // is refreshed whenever a write happened at all — a damaged or unverified
      // save changed the world and the panel must not keep showing the old view.
      if (receipt) pushReadiness(event.tab_id);
      return;
    }

    // Phone pairing: mint a phone-reachable bridge URL for the panel's QR modal.
    // `lan` → ws://<lan-ip>:<pairPort>/?token= (same wifi); `tunnel` → a cloudflared
    // wss://…/?token= (anywhere). Both hit the on-demand token-gated pairing
    // listener; async (tunnel startup can fail), so reply via a typed frame.
    if (event.type === "pair" && event.tab_id) {
      const mode = (event as { mode?: unknown }).mode === "tunnel" ? "tunnel" : "lan";
      const tabId = event.tab_id;
      // Pair-time toggle, default ON. An explicit boolean is the only thing we
      // persist — a missing field leaves the last saved (or default) value.
      const rawDefer = (event as { defer_while_paired?: unknown }).defer_while_paired;
      if (typeof rawDefer === "boolean") {
        try {
          savePairUpdatePrefs({ deferWhilePaired: rawDefer });
        } catch (err) {
          logger.warn(
            `[panel-orchestrator] could not persist pair-update prefs: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        selfRestarter?.requestApplyPolicyRefresh();
      }
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
        // #875 — say at pair time whether this URL survives a restart. The
        // self-restarter is on by default and rotates the token (always, unless
        // pinned) and the tunnel hostname (always, quick tunnels cannot be
        // pinned). A user hit exactly this and reported it as "updating the npm
        // version bricks my communication with the agent" — the restart was the
        // cause, and nothing here had told them.
        const durability = pairUrlDurability({
          mode,
          stableToken: envPairToken !== null || pairTokenPersisted,
          autoRestart: canSelfRestart(),
        });
        logger.info(
          `[panel-orchestrator] pairing URL minted (${mode}) — ` +
            (durability.survivesRestart
              ? "survives restart"
              : `rotates on restart: ${durability.rotates.join(", ")}`),
        );
        const auto_update = pairAutoUpdateDisclosure(autoUpdateGateInput());
        bridge.push({ type: "pair_url", mode, url, durability, auto_update }, tabId);
      })().catch((err) => {
        bridge.push(
          { type: "pair_error", mode, error: err instanceof Error ? err.message : String(err) },
          tabId,
        );
      });
      return;
    }

    // #1963 — flip the pair-time "Don't update while my phone is paired" toggle
    // after the URL is already minted (the checkbox on the QR modal).
    if (event.type === "set_pair_update_pref" && event.tab_id) {
      const tabId = event.tab_id;
      const rawDefer = (event as { defer_while_paired?: unknown }).defer_while_paired;
      if (typeof rawDefer !== "boolean") {
        bridge.push(
          { type: "pair_update_pref", ok: false, error: "defer_while_paired must be a boolean" },
          tabId,
        );
        return;
      }
      try {
        const prefs = savePairUpdatePrefs({ deferWhilePaired: rawDefer });
        bridge.push(
          {
            type: "pair_update_pref",
            ok: true,
            defer_while_paired: prefs.deferWhilePaired,
            apply: autoUpdateApplyAllowed({
              ...autoUpdateGateInput(),
              deferWhilePaired: prefs.deferWhilePaired,
            }),
          },
          tabId,
        );
        selfRestarter?.requestApplyPolicyRefresh();
      } catch (err) {
        bridge.push(
          {
            type: "pair_update_pref",
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          tabId,
        );
      }
      return;
    }

    // #1963 — "Update now" from the desk (or from the deferred-update notice).
    // One-shot: ignores the tunnel gate for this tick only.
    if (event.type === "apply_updates_now") {
      const tabId = event.tab_id;
      logger.info("[panel-orchestrator] apply_updates_now — checking and applying updates (bypass tunnel gate)");
      void selfRestarter?.updateTick({ forceApply: true });
      if (tabId) {
        bridge.push({ type: "ack", ok: true, kind: "apply_updates_now" }, tabId);
      }
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
            // `message` is the provider's own failure text — untranslated, and safe to embed:
            // trFor interpolates in one pass, so braces inside it stay literal.
            bridge.push(
              {
                type: "say",
                text: `⚠️ ${trFor(
                  bridge.tabLocale(tabId),
                  "say.oauth_signin_failed",
                  "{provider} sign-in failed: {message}",
                  { provider: label, message },
                )}`,
              },
              tabId,
            );
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
            // 🕶️/👁️ carry the ON/OFF distinction at a glance and are the same in every
            // language, so they stay outside the translated span.
            text: nextBlind
              ? `🕶️ ${trFor(
                  bridge.tabLocale(tabId),
                  "say.blind_on",
                  "Blind mode ON — the agent's image tools now withhold pixels (applies after the current turn; the session resumes automatically).",
                )}`
              : `👁️ ${trFor(
                  bridge.tabLocale(tabId),
                  "say.blind_off",
                  "Blind mode OFF — the agent's image tools deliver pixels again (applies after the current turn).",
                )}`,
          },
          tabId,
        );
      }
      // Honesty (the #90 lesson): Blind's enforcement is the MCP scrub + the
      // Claude backend's native-tool PreToolUse gate + attachment withholding.
      // The CLI lanes run THEIR OWN agent binaries whose built-in file tools we
      // cannot hook in-process — a promise we can't enforce must say so out
      // loud, exactly like the old-orchestrator ack warning. API/local lanes
      // (ollama/glm/kimi/…) carry only our tool surface, so they get no scare.
      const CLI_NATIVE_TOOL_BACKENDS = new Set(["codex", "gemini", "grok", "qwen", "antigravity", "pi", "copilot"]);
      const tabBackend = backendForTab(tabId);
      if (changed && nextBlind && CLI_NATIVE_TOOL_BACKENDS.has(tabBackend)) {
        bridge.push(
          {
            type: "say",
            text: `⚠️ ${trFor(
              bridge.tabLocale(tabId),
              "say.blind_cli_native_tools",
              "Heads-up: the {backend} CLI keeps its own built-in file tools, which Blind cannot gate mechanically — the comfyui tools still withhold pixels, but the CLI itself could read image files. For a hard no-pixels guarantee use the Claude backend or an API/local provider.",
              { backend: tabBackend },
            )}`,
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
        bridge.push(
          {
            type: "say",
            text: `⚠️ ${trFor(
              bridge.tabLocale(tabId),
              "say.options_change_failed",
              "Could not change model/effort: {message}",
              { message },
            )}`,
          },
          tabId,
        );
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
        // #884 P0 (confirming-gate 2) — the error-handling turn PINS to the
        // ERRORING workflow's tab: "diagnose and fix it" must edit the graph
        // that failed, never whichever tab was last active. This was the P0's
        // exact sequence — a render error on A silently editing B.
        void manager.injectRunError(agentKeyFor(event.tab_id), ev.error ?? "unknown error", {
          mid: turnOrigins.mintInjectionOrigin(event.tab_id),
          // #1489 — coalescing a burst is scoped to this tab, so a notice from ANOTHER
          // tab is never folded in and can never lose its own origin pin (#884 P0).
          originTab: event.tab_id,
        });
        logger.info(`[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} run_error → agent (interrupt)`);
        return;
      }
      // Blind tab (issue #90, codex-review F3): strip render pixels at the
      // SERVER boundary too — the desktop panel already drops them client-side,
      // but a mirror viewer (mobile has no Blind concept) can inject
      // agent_event frames with images onto a blinded desktop tab.
      // #884 — the receiving agent is shared, so the pixel gate is conversation-
      // wide: any tab with Blind on withholds pixels from the shared agent.
      // #884 followup — emptying `images` is INVISIBLE downstream. Every
      // "withheld / attached below" sentence the completion composer can emit is
      // gated on `imgs.length`, so a blind-stripped completion produced NO
      // disclosure at all: the agent received the panel's SIGHTED storyboard note
      // ("Review motion, sharpness, and temporal consistency") with zero pixels
      // and no reason, which is precisely the confabulation the blind note exists
      // to prevent. The panel picks its blind/sighted note from ITS OWN tab
      // (`agentReceivesImages()`), while this gate is conversation-wide
      // (`anyTabBlind()`), so the two disagree whenever any OTHER tab is blind —
      // and the disagreement was unobservable.
      //
      // Fail-closed is unchanged: pixels are still removed, and the journal still
      // stores the stripped copy. Only the SILENCE is fixed, by appending the
      // disclosure to the note the composer already renders verbatim, which also
      // overrides a sighted "review this" instruction that must not be obeyed.
      const evForTab = blindStrippedCompletion(ev);
      // #468 — a RUN COMPLETION is a promise `panel_run` made ("end your turn,
      // you WILL be notified"), so it goes through the journal: correlated by
      // exact prompt id ONCE, here, and replayed until the turn that carries it
      // ends. Other agent_event kinds (download_done) keep the old best-effort
      // path — nothing is waiting on them the way a render is.
      if (ev.kind === "executed") {
        // Journal the BLIND-STRIPPED copy: a replay must not resurrect pixels
        // the blind gate removed on arrival. `null` = the panel re-sent a
        // completion this tab was already given; suppressed, never duplicated.
        // #704 — WHO this completion is being reported to. The tab it arrived on
        // is an address that churns across a panel reconnect (a new `tmp:` id, no
        // same-socket migration to follow); the conversation is what actually
        // queued the run, so it is what decides "this is the run YOU queued"
        // versus the origin-UNDETERMINED warning.
        const entry = RunCompletions.record(event.tab_id, evForTab as CompletionPayload, {
          conversation: agentKeyFor(event.tab_id),
        });
        logger.info(
          `[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} run completion for ${describeCorrelation(entry.correlation)}${entry.possibleRepeat ? " (flagged as a possible repeat)" : ""}`,
        );
        flushRunCompletions(event.tab_id);
        return;
      }
      const delivered = manager.injectEvent(agentKeyFor(event.tab_id), evForTab, {
        // #884 P0 — panel events pin their originating tab (confirming-gate 2).
        mid: turnOrigins.mintInjectionOrigin(event.tab_id),
      });
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
      // #884 — a cancelled message's issue-time stamp mapping dies with it, so
      // the bounded map only ever holds LIVE queued messages (codex r3). ONLY
      // when the removal actually happened (codex r4 P2): a message parked
      // outside the manager queue (heldDuringGen) reports removed:false and can
      // still dispatch later — deleting its mapping would make that dequeue an
      // unknown mid and spuriously fail the turn's fence closed.
      if (mid && removed) turnOrigins.cancelMid(mid);
      bridge.push({ type: "ack", ok: true, kind: "cancel_message", mid, removed }, tabId);
      return;
    }

    // New chat: forget the SHARED session for this tab's backend so the next
    // message starts fresh (no memory of the prior conversation). #884: the
    // conversation spans every tab on the backend, so the boundary applies to
    // all of them — the session-cleared frame fans out and every participating
    // tab's journaled tickets are closed.
    if (event.type === "new_session" && event.tab_id) {
      const tabId = event.tab_id;
      const key = agentKeyFor(tabId);
      // reset() is synchronous (map cleared now), so no concurrent send() can
      // spawn an agent before we report the cleared session.
      const { durableCleared } = manager.reset(key);
      // The replaced conversation's issue-time stamp and turn pin die with it.
      turnOrigins.forgetConversation(key);
      // #468 — the conversation that queued the outstanding renders is gone.
      // Close its run tickets so a render finishing after the New chat is
      // reported to the replacement agent as UNDETERMINED rather than as "the
      // run YOU queued". Already-arrived completions keep the verdict frozen at
      // their arrival and are still delivered.
      // #486 — and the questions it asked: answers stay journaled and are still
      // reported, but lose the fingerprint that let them satisfy a re-ask.
      // #704 — close by CONVERSATION as well as by member tab: a ticket whose tab
      // was re-registered under a new id on a reconnect is reachable from no member
      // tab at all, and the replacement conversation reuses the same key string, so
      // only deleting it ends the old conversation's ownership.
      for (const t of conversationMemberTabs(tabId)) {
        RunCompletions.closeRuns(t, key);
        AskAnswers.closeAsks(t);
        // panel#1554 — this feed is being blanked/replaced, so the confirmation card
        // goes with it. Acting on its answer afterwards would restart the server on a
        // surface showing nothing the user can point at (see forgetAbandonedConfirmCards).
        forgetAbandonedConfirmCards(t);
      }
      pushToConversation(key, { type: "session", session_id: null });
      // The write outcome is OBSERVABLE (codex confirming-gate P1: a swallowed
      // disk failure made New chat report false success): the ack carries it,
      // and a failed durable clear is disclosed in chat — within THIS process
      // the reset held (in-memory), but a restart could resume the cleared
      // conversation.
      bridge.push(
        { type: "ack", ok: true, kind: "new_session", durable_cleared: durableCleared },
        tabId,
      );
      if (!durableCleared) {
        bridge.push(
          {
            type: "say",
            text: `⚠️ ${trFor(
              bridge.tabLocale(tabId),
              "say.new_chat_durable_clear_failed",
              "New chat started, but the previous conversation's stored session could not be " +
                "removed from disk (the write failed — a full or locked filesystem?). If the " +
                "orchestrator restarts before this conversation's first exchange completes, the " +
                "OLD conversation may resume; start a New chat again if that happens.",
            )}`,
          },
          tabId,
        );
      }
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
      // The dropped branch's issue-time stamp AND last established origin must
      // not outlive it; the edited message that follows re-establishes both at
      // its own dequeue (codex r2; gate-3 confirm P1: the agent stays live
      // across a rewind, so an origin-less injected turn landing before the
      // edited message must refuse, never inherit the dropped branch).
      if (ok) turnOrigins.dropBranch(agentKeyFor(tabId));
      // #486 — a REWIND is a conversation boundary too, not just New chat and
      // resume: everything after the anchor is discarded, so a question card the
      // dropped branch put up was never asked by the conversation that now
      // exists. Retire the asks so a late click on such a card can neither be
      // announced as "a question card YOU put up" nor recovered as the answer
      // to an identical question the fork asks afresh. The answers themselves are
      // kept and still reported — closeAsks downgrades, it does not delete.
      // #884: the boundary is conversation-wide (any participating tab's card).
      if (ok) {
        // panel#1554 — the discarded branch takes the confirmation card off screen with
        // it; its answer must not silently authorise a restart afterwards.
        for (const t of conversationMemberTabs(tabId)) {
          AskAnswers.closeAsks(t);
          forgetAbandonedConfirmCards(t);
        }
      }
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
      // #884 P1 (codex confirming gate 2) — a failed durable clear is NOT benign
      // here, which is what the previous comment claimed. In-process the arming
      // below wins, but the chosen id lives only in memory until the resumed
      // conversation's first `onSession`; if the process exits inside that
      // window the stale on-disk entry survives and OUTRANKS the pending hint on
      // restart, resuming the very conversation the user switched away from.
      // Closing the window rather than disclosing it: persist the user's choice
      // immediately, so disk agrees with intent from this instant on.
      const { durableCleared: clearedDurably } = manager.reset(key);
      // The replaced conversation's issue-time stamp and turn pin die with it.
      turnOrigins.forgetConversation(key);
      // #468 — same as New chat: the conversation being replaced owns the open
      // runs, so a completion landing after the switch is UNDETERMINED, not the
      // historical session's own render. #884: the boundary is conversation-wide.
      // #486 — likewise its questions: answers stay journaled and are still
      // reported, but lose the fingerprint that let them satisfy a re-ask.
      // #704 — close by CONVERSATION as well as by member tab: a ticket whose tab
      // was re-registered under a new id on a reconnect is reachable from no member
      // tab at all, and the replacement conversation reuses the same key string, so
      // only deleting it ends the old conversation's ownership.
      for (const t of conversationMemberTabs(tabId)) {
        RunCompletions.closeRuns(t, key);
        AskAnswers.closeAsks(t);
        // panel#1554 — this feed is being blanked/replaced, so the confirmation card
        // goes with it. Acting on its answer afterwards would restart the server on a
        // surface showing nothing the user can point at (see forgetAbandonedConfirmCards).
        forgetAbandonedConfirmCards(t);
      }
      if (sid) manager.setResume(key, sid);
      // Persist the selection NOW (not at first onSession) so a restart inside
      // that window resumes what the user picked. When the store itself can't
      // write, say so on the ack rather than reporting a clean switch — the
      // false-success class this gate exists to catch.
      const durable = sid ? sessionStore.set(key, sid) : clearedDurably;
      if (!durable) {
        logger.warn(
          `[panel-orchestrator] ${key} resume_session could not be persisted — a restart before the resumed conversation's first session event may reopen the previous conversation (#884)`,
        );
      }
      bridge.push({ type: "ack", ok: true, kind: "resume_session", durable }, tabId);
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
            crash.unreadable
              ? `[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} crash-log UNREADABLE note injected on resume — whether ComfyUI crashed is unknown (log=${crash.unreadable.path}: ${crash.unreadable.reason})`
              : `[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} crash-dump injected on resume — culprit=${crash.culpritNode ?? "?"} frame=${crash.culpritFrame ?? "?"} (log=${crash.logPath ?? "?"})`,
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
    // #884 — the turn's ORIGIN: when this message's workflow differs from the
    // previous message's in this conversation, prepend a one-line note. This is
    // how one session keeps "knowledge of all open workflows": the agent is
    // told, mechanically and only on a change, which canvas it is operating on.
    // #884 — capture the workflow this message's TURN will be issued for, per
    // conversation. Scope-addressed mutations are stamped with the value the
    // turn STARTED with (applied at dequeue via onSeen, never re-resolved at
    // dispatch), so a mid-turn switch to another workflow makes late edits fail
    // the panel's fence loudly instead of silently re-aiming (codex rounds
    // 1–2). A mid-less message (rare: non-panel callers) gets a SYNTHETIC
    // origin mid so its turn pins/stamps through the same dequeue path as
    // every other message (confirming gate 3, P1 sibling: the old
    // apply-at-receipt-while-idle shortcut left a mid-less message that queued
    // BEHIND a busy turn with no origin at all, so its own turn later routed
    // to whatever tab was active). Panels ignore seen-acks for unknown mids,
    // exactly as with the evt- mids injected events already ride.
    // `userMessage: true` (#1001): the mid is synthetic but the REQUEST is the
    // user's, so a mixed batch containing it must still fail closed — only
    // genuine orchestrator-injected events get the notification treatment.
    const dispatchMid =
      userMid ?? turnOrigins.mintInjectionOrigin(event.tab_id, { userMessage: true });
    if (userMid) {
      turnOrigins.recordForMid(userMid, tabCommandWorkflowUuid.get(event.tab_id), event.tab_id);
    }
    {
      const originKey = agentKeyFor(event.tab_id);
      const origin = messageOrigin(event.tab_id, tabCommandWorkflowUuid.get(event.tab_id));
      const originNote = workflowOriginNote({
        prevOrigin: lastMessageOriginByKey.get(originKey),
        origin,
        tabId: event.tab_id,
        title: typeof event.title === "string" ? event.title : undefined,
      });
      lastMessageOriginByKey.set(originKey, origin);
      if (originNote) outText = `${originNote}\n\n${outText}`;
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
    // #790 — the composer may attach audio as well as images. Two sources, one
    // normalisation: a dedicated `audio` array (the wire contract), plus any
    // audio-named file that arrived in the legacy `images` array. The second is
    // not politeness — routing a .wav into an image content part is a hard 400
    // on the OpenAI dialect and an image-slot mis-encode on the native one, so
    // classifying by extension here is what stops a sound being sent as a picture.
    const rawAttached = (event as { images?: Array<{ filename: string; subfolder?: string; type?: string }> })
      .images;
    const declaredAudio = (event as { audio?: Array<{ filename: string; subfolder?: string; type?: string }> })
      .audio;
    const attachmentSplit = splitAudioAttachments(rawAttached);
    const attachedImages = attachmentSplit.images;
    // Deduped across the two carriers: a panel that populates BOTH arrays for
    // the same sound would otherwise spend two of the turn's attachment slots on
    // one file, and the user would be told the duplicate "did not fit" while the
    // very same bytes rode the request anyway.
    const attachedAudio = dedupeAudioRefs([...attachmentSplit.audio, ...(declaredAudio ?? [])]);
    // #884 — Blind is a promise the shared AGENT never sees pixels, so it is
    // conversation-wide: attachments are withheld while any tab has Blind on.
    const tabIsBlind = anyTabBlind();
    if (tabIsBlind && attachedImages?.length) {
      outText += `\n\n[panel note: ${attachedImages.length} image attachment(s) withheld — Blind mode is ON. You cannot see them; ask the user to describe the content or turn Blind off.]`;
    }
    const sendOpts = {
      title: event.title,
      images: tabIsBlind || !attachedImages.length ? undefined : attachedImages,
      // Blind (#90) is a promise about PIXELS — "the agent's image tools now
      // withhold pixels". Audio is a different sense and is deliberately NOT
      // withheld by that toggle; documented in docs/backends.mdx.
      audio: attachedAudio.length ? attachedAudio : undefined,
      // The panel's own mid, or the synthetic origin mid a mid-less message
      // was given so its turn still pins/stamps at dequeue (#884 gate 3).
      mid: dispatchMid,
    };
    // Local-agent VRAM pause: if this tab runs a LOCAL Ollama / LM Studio /
    // llama.cpp model AND a render is in flight, DON'T run the turn now — that
    // would reload (or keep hammering) the model on top of the generation
    // (VRAM contention / OOM). Hold it and answer when the render finishes
    // (onRunEnd flushes the queue + warms the model where it was unloaded).
    const tabIsLocalVram = backendSharesRenderGpu(backendForTab(event.tab_id), {
      ollama: ollamaApi === "ollama",
      lmstudio: isLocalLmstudio(LMSTUDIO_BASE_URL),
      llamacpp: isLocalLlamacpp(LLAMACPP_BASE_URL),
    });
    if (pauseLocalDuringGen && tabIsLocalVram && QueueMonitor.isBusy()) {
      const key = agentKeyFor(event.tab_id);
      const arr = heldDuringGen.get(key) ?? [];
      arr.push({ text: outText, opts: sendOpts });
      heldDuringGen.set(key, arr);
      genPauseActive = true; // ensure the end transition flushes even if start was missed
      bridge.push(
        {
          type: "say",
          text: `⏸ ${trFor(
            bridge.tabLocale(event.tab_id),
            "say.message_queued_during_render",
            "A render is running, so I've queued your message to keep the GPU free for it. I'll answer the moment it finishes.",
          )}`,
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
      downloads: Map<
        string,
        {
          // #1574 — the PROGRESS/tray id. The record cross-check at the flush needs it, and
          // it is a different identity from the job's public `id`.
          id?: string;
          target?: string;
          name: string;
          status: string;
          attempt?: number;
          supKey: string;
          recordDisagrees?: boolean;
        }
      >;
      flushAt: number;
    }
  >();
  // Resolve which agent to wake for a settled download row (#547/#884). New
  // rows are stamped with the OWNING agent key (`orchestrator::<backend>`) —
  // resolved directly, so the download wakes the conversation that STARTED it
  // even if the stamping tab has since switched backends (codex round 1, P1).
  // Legacy rows (pre-#884 processes) carry a panel tab id — resolved via that
  // tab's CURRENT backend, best-effort. Else the SINGLE live agent (rows with
  // no stamp); else none — never fan out to unrelated conversations.
  const resolveDownloadAgentKey = (row: Record<string, unknown>): string | null => {
    const tab = typeof row.tab === "string" ? row.tab.trim() : "";
    if (tab) {
      if (tab.startsWith(SHARED_SESSION_SCOPE + AGENT_KEY_SEP)) {
        // Agent-key-shaped stamp: the OWNER is known. Deliver to it when live;
        // when it is not, DROP with a log rather than fall through to the
        // sole-live fallback — that would announce one conversation's download
        // in another (codex r2 P1). The tray still shows the completion.
        if (manager.hasLiveAgent(tab)) return tab;
        logger.info(
          `[panel-orchestrator] download settled for ${tab} but that conversation's agent is not live — not waking another conversation (#884)`,
        );
        return null;
      }
      // Legacy tab-id stamp (pre-#884 rows): best-effort via the tab's current
      // backend, then the sole-live fallback below.
      const key = agentKeyFor(tab);
      if (manager.hasLiveAgent(key)) return key;
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
    // #1415 — the OTHER half of the #952 drift comparison installed above. That
    // source only serves THIS process, and the tools that fail with `fetch
    // failed` run in the spawned comfyui children, which have no bridge. Publish
    // the current set into the progress dir they already share so a child's
    // failure can make the same comparison. Level-triggered on this tick (not on
    // connect/disconnect events) so a tab that goes away blanks it within 700ms —
    // the child must never quote a panel that has since disconnected. Writes only
    // when the set changed.
    publishConnectedPanelOrigins(progressDir, bridge.connectedServerOrigins());
    // #1400 — the same level-triggered discipline for the frontend-virtual
    // registry: republish the CURRENT map, scoped to origins a connected tab
    // actually fronts, so a disconnected tab's entry drops out of the channel
    // within one tick rather than exempting types for a page that is gone.
    {
      const fronted = new Set(
        bridge
          .connectedServerOrigins()
          .map((o) => canonicalOrigin(o) ?? o),
      );
      const virtualEntries: FrontendVirtualTypesEntry[] = [];
      for (const [origin, types] of frontendVirtualTypesByOrigin) {
        if (fronted.has(origin)) virtualEntries.push({ origin, types });
      }
      publishFrontendVirtualTypes(progressDir, virtualEntries);
    }
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
              {
                downloads: new Map<
                  string,
                  {
                    id?: string;
                    target?: string;
                    name: string;
                    status: string;
                    attempt?: number;
                    supKey: string;
                    recordDisagrees?: boolean;
                  }
                >(),
                flushAt: 0,
              };
            // Identify each pending download by its (id, target) supersession key — NOT
            // the id alone: a concurrent LOCAL + POD transfer of the same URL shares an id
            // but must produce TWO #547 outcomes, and the same key lets a newer attempt
            // evict this entry above. Fall back to the file path when the row has no id.
            const supKey = downloadAttemptKey(row) ?? ` ${full}`;
            bucket.downloads.set(supKey, {
              // #1574 — CARRY THE ROW ID. Without it the record cross-check at the flush has
              // nothing to match a job against, silently agrees with everything, and the
              // whole disclosure is a no-op. That is exactly how the first version shipped.
              id: typeof row.id === "string" ? row.id : undefined,
              // (id, target) is the row identity — id alone collides for a concurrent
              // LOCAL + POD transfer of the same URL (review).
              target: typeof row.target === "string" ? row.target : undefined,
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
      // #1150 — a corrected retry of a 404 is a DIFFERENT id writing the SAME
      // filename, so the (id, target) eviction above cannot see it. The live rows
      // are already in hand this tick; markSupersededByLive asks them by name.
      markSupersededByLive(settled, downloads);
      // #1574 — DROP a completion this orchestrator's own status tool would contradict.
      //
      // The event is built from the progress ROW; `download_model action:"status"` answers
      // from the job RECORD. A reporter got "transfer completed" for an 11.46GB file while
      // status said it was still streaming and the file was not on disk — it landed minutes
      // later. Whatever wrote that row, the record is in hand right here.
      //
      // Only a POSITIVE contradiction drops it (the record exists, same id, still
      // "downloading"). An absent record means nothing: the record store resets on a
      // respawn, which is the reported session, and treating absence as in-flight would
      // silence every completion after any respawn.
      const records = (() => {
        try {
          return listDownloadJobs();
        } catch {
          // Never let the guard break the event path — a completion we cannot check is
          // still a completion worth delivering.
          return [];
        }
      })();
      // ANNOTATE, never suppress (review). A terminal record can legitimately still read
      // "downloading" until the ~15s persistence heartbeat retries (#1545), and this bucket
      // is deleted before this point and never requeued — so dropping the event here would
      // permanently lose the completion for a download that genuinely finished. That trades
      // a confusing message for a missing one, which is worse: the user is waiting on it.
      const disagreeing = settled.filter((d) => completionDisagreesWithRecord(d, records));
      for (const d of disagreeing) (d as { recordDisagrees?: boolean }).recordDisagrees = true;
      if (disagreeing.length) {
        logger.warn(
          "[panel-orchestrator] a download completion disagrees with the job record; disclosing rather than suppressing (#1574)",
          { ids: disagreeing.map((d) => String((d as { id?: unknown }).id ?? "")) },
        );
      }
      // #884 — a download has no originating TAB (its row names the owning
      // conversation), so its turn INHERITS the conversation's LAST
      // ESTABLISHED origin — never the active tab (confirming gate 2, P0 rule:
      // every turn has an origin). The inherited-origin mid is what makes that
      // actually happen: onSeen only fires for items carrying a mid, so a
      // mid-less injection opened no batch at all and the inherit branch never
      // ran — the turn routed to whatever tab was active (confirming gate 3,
      // P1). The minted mid contributes nothing and the batch close inherits
      // (or refuses, when no origin was ever established).
      manager.injectEvent(key, { kind: "download_done", downloads: settled }, {
        mid: turnOrigins.mintInheritedOrigin(),
      });
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
        logger.warn(`[panel-orchestrator] pod ${podId} was not ready within 8 minutes — NOT auto-connecting (connect manually with runpod action:"connect")`);
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
  // #1789 — KEEP THE PROMISE panel_run MAKES, or find out that we didn't.
  //
  // `panel_run` tells the agent "you WILL be notified … end your turn now and
  // wait". The only producer of that notification is the panel's `executed`
  // frame; when it never arrives, the run ticket stays open forever and NOTHING
  // in this process can tell that apart from a render still in flight. The
  // reported session sat idle after a clean 28.77 s run until a human intervened.
  //
  // QueueMonitor already observes EVERY completion on the monitored ComfyUI —
  // on the broadcast WS execution events OR its 1 Hz `/history` tail diff, both
  // funnelling through one recordCompletion (#258/#259) — and that
  // observation went only to the `queue_status` UI broadcast. This watchdog is
  // the join: an observed completion whose panel_run ticket is still unanswered
  // after the grace is synthesised into the SAME journal the real frame uses.
  // See run-completion-watchdog.ts for why it waits, and why the panel's frame
  // still wins whenever it is coming.
  const wd = createRunCompletionWatchdog({
    awaiting: (promptId) => RunCompletions.awaitingCompletion(promptId),
    resolveOutputs: (promptId) => resolveHistoryCompletionImages(promptId),
    lookupStatus: (promptId) => resolveHistoryCompletionStatus(promptId),
    deliver: (payload, ticket) => {
      // The SAME arrival path the panel's frame takes: correlated once, here,
      // against the ticket that is still open — so the agent is told this is the
      // run IT queued, and the journal's replay/ack durability covers it too.
      // #1861 — the SAME strip the panel ingress applies. Blind is conversation-wide.
      const entry = RunCompletions.record(ticket.tabId, blindStrippedCompletion(payload), {
        ...(ticket.conversation !== undefined ? { conversation: ticket.conversation } : {}),
      });
      logger.info(
        `[panel-orchestrator] tab ${ticket.tabId.slice(0, 8)} synthesised run completion for ${describeCorrelation(entry.correlation)} (the panel never reported it — #1789)`,
      );
      flushRunCompletions(ticket.tabId);
    },
  });
  runCompletionWatchdog = wd;
  const queueStatusBroadcaster = createQueueStatusBroadcaster(
    () => QueueMonitor.snapshot(),
    (frame) => void bridge.push(frame),
    // TEE, not a second drain: drainCompletions() splices, so the watchdog has
    // to read the same array the broadcaster is handed rather than call it
    // again — a second call would race and each consumer would see only half.
    () => {
      const completions = QueueMonitor.drainCompletions();
      wd.observe(completions);
      return completions;
    },
  );
  // Each tick first refreshes the monitor over HTTP (GET /queue + /history
  // tail): on modern ComfyUI (0.28+) the passive watchdog WS carries no
  // prompt_id and no completion events for foreign runs, so the poll is what
  // restores run attribution (#258) and catches runs shorter than the tick
  // (#259). poll() never rejects and self-guards against overlap.
  const queueStatusTimer = setInterval(() => {
    void QueueMonitor.poll().finally(() => {
      queueStatusBroadcaster.tick();
      // …and only THEN expire the watchdog's arms: the broadcaster tick is what
      // feeds it (the drain tee above), so ticking it first would let an
      // observation sit a whole extra second before it is even armed. #1789.
      wd.tick();
    });
  }, 1000);
  queueStatusTimer.unref?.();

  // RunPod live-status broadcast + idle auto-stop (services/runpod-watch.ts).
  // Polls the WATCHED pod (set by runpod action:"connect" / runpod_watch action:"watch") every ~15s
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
  // polls the status action again, the stale "running" record would suppress the
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
      // Captured BEFORE the reassignment: the address every mid-turn tab's
      // comfyui child is still serving, which is what the #1429 nudge names.
      const previousUrl = lastRetargetUrl;
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
      // A tab that is mid-turn cannot have its comfyui MCP child replaced now, so
      // it keeps serving `previousUrl` until the turn ends (#1429). Tell those
      // tabs — and ONLY those; an idle tab respawns before it can run anything.
      const tally = manager.retargetAllForMcpEnv(previousUrl, url);
      if (tally.scheduled > 0) {
        logger.warn(
          `[panel-orchestrator] ${tally.scheduled} tab(s) mid-turn during the retarget — ` +
            `their comfyui tools stay on ${previousUrl} until the turn ends (#1429)`,
        );
      }
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
      : " — remote target: installs/downloads run ON the ComfyUI host via its Manager (a local path would be the wrong filesystem; only local-FS tools like node_pack (action:'verify') are unavailable)";
  logger.info(
    `[panel-orchestrator] ready — bridge on ws://127.0.0.1:${bridgePort}, console on ${consoleUrl}; an agent spawns per ComfyUI tab on its first message (model=${model}, comfyui=${comfyuiUrl}${pathNote})`,
  );

  let shuttingDown = false;
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
    setApplyMcpReload(undefined);
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
    // Same for panel-op.lock: a clean exit (SIGINT or self-restart) must not
    // leave a lock whose owner is about to die (#1953). Idempotent if the
    // restarter already released it; a lock naming any other pid is left.
    try {
      releaseOwnedPanelLock();
    } catch {
      /* best-effort — unlock/reclaim remains the recovery if this fails */
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
    // #1963 — transport gate is applyAllowed, not allIdle. Idle is in-flight
    // work; this is "would a restart rotate the phone's tunnel hostname?"
    // Checking still runs; APPLY (disk + restart, and the panel pack) does not.
    applyAllowed: applyAutoUpdateAllowed,
    panelTick: async ({ apply }) => tickPanelAutoUpdate({ apply }),
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
