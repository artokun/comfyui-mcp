/**
 * Admission for the orchestrator's direct tool channel (call_tool frames from a
 * mobile/canvas-less client). Extracted from src/orchestrator/index.ts so the
 * decision is a pure, unit-testable function — the dispatcher is a one-line
 * call site.
 */

import { retiredToolMessage } from "../tools/vocabulary.js";

/** The direct tool channel: a mobile client can invoke these READ/DOWNLOAD backend
 *  tools without an agent turn (structured nav data + rig downloads). The
 *  bridge is already token-gated; this whitelist keeps call_tool to non-destructive
 *  tools (no restart/remove/clear/install).
 *
 *  Exported for the tests only — nothing outside this module reads it, and no
 *  package entry point re-exports it. The tests need it to assert two properties
 *  over the WHOLE set rather than over a handful of spelled names that the 0.50.0
 *  consolidation would rot within hours: that every whitelisted name is still a
 *  LIVE tool, and that every live tool it does NOT carry is refused with the
 *  byte-identical legacy string. */
export const CALL_TOOL_WHITELIST = new Set<string>([
  // The canvas-less client's whole read side of the saved-workflow library.
  // FIVE separate entries lived here — the library listing, the file read, the
  // summary, the graph query and the PNG-metadata extractor — until 0.50.0
  // slice 14 folded EIGHT names into this one. The three it also folded that
  // were NOT whitelisted (strip, slice, prompt_director) would have been
  // admitted for free by the swap, so admission is ACTION-scoped below to
  // exactly the five that were already reachable — see CALL_TOOL_ACTION_WHITELIST.
  "get_workflow",
  // The image browsing surface a canvas-less/mobile client actually uses: the
  // output listing and the fetch-by-filename. Both names were whitelisted
  // individually until 0.50.0 slice 15 folded twelve image/asset tools into
  // `get_image` (7 actions) + `upload_image` (5). One entry now stands where
  // two did, so admission is ACTION-scoped below to exactly the two actions the
  // two retired entries covered — see CALL_TOOL_ACTION_WHITELIST.
  //
  // NOTE: `upload_image` was NOT whitelisted before the fold and is deliberately
  // still absent. Every one of its actions WRITES — a local file into ComfyUI's
  // input/ directory, a server-side output back into that directory, or a
  // generated output off the machine into an S3/Azure/HTTP/HuggingFace
  // destination the caller names. None of that was reachable from a canvas-less
  // client and none of it becomes reachable here.
  "get_image",
  // Inventory listing only. 0.50.0 slice 11 folded six model tools into this
  // name — including `remove`, which UNLINKS a model file — so admission is
  // ACTION-scoped below to exactly what the retired read-only entry covered.
  "list_local_models",
  // Read-only CivitAI lookups (creator-search feature) + the two download
  // starters: let a client browse models/creators through the rig, and fetch
  // one, without an agent turn. 0.50.0 slice 11 folded eight model tools into
  // `download_model`, so this entry is ACTION-scoped below to the union of the
  // FIVE retired per-tool entries it replaces (the two CivitAI searches, the
  // CivitAI download, the URL download, and the app-panel's missing-model
  // resolver) and nothing else.
  "download_model",
  // Queue a render the user explicitly tapped. 0.50.0 slice 16 folded FOUR more
  // enqueue entry points into this name — re-run from history, run-from-URL,
  // template-schema and template-run — and NOT ONE of their standalone names
  // was whitelisted here.
  // The dispatcher authorizes by tool NAME and then forwards arbitrary action
  // arguments, so leaving this entry unscoped would silently admit all four, and
  // action:"run_url" in particular FETCHES A WORKFLOW FROM AN ARBITRARY URL AND
  // EXECUTES IT. A confirmation-less mirrored/foreign tab must not be able to do
  // that, so this name is ACTION-scoped below to exactly ["enqueue"] — the
  // ground its pre-fold entry actually covered. See
  // CALL_TOOL_ACTION_WHITELIST.
  "enqueue_workflow",
  // Persist a workflow to the ComfyUI library (mobile "pull workflow from a
  // CivitAI example" → save_workflow). Writes a workflow file (auto-converts
  // API-format graphs to canvas-openable UI format); overwrites same-filename,
  // so the client generates a unique name. No model/system mutation.
  //
  // 0.50.0 slice 14 folded the two provenance-lock tools onto this name,
  // NEITHER of which was whitelisted, so it is ACTION-scoped below to
  // exactly "save" — see CALL_TOOL_ACTION_WHITELIST.
  "save_workflow",
  // One-tap cancel of the RUNNING render (the mobile queue monitor's stop
  // button). User-initiated and narrowly scoped: the client passes the
  // prompt_id it saw in `queue_status`, and action:"cancel" only interrupts
  // when the running job still matches — it can never kill a job that started
  // after the tap, and (without clear_pending, which the mobile client never
  // sends) it never touches other pending jobs in a shared queue. 0.49.0
  // slice 4 folded the eight queue/jobs tools into this one name, so admission
  // is ACTION-scoped below to exactly what its retired single-purpose
  // predecessor entry covered — see CALL_TOOL_ACTION_WHITELIST.
  "queue",
  // "Why did my render fail?" for canvas-less clients. The panel answers this from
  // live canvas state (panel_get_errors); a phone has no canvas, so it reads
  // the same story server-side from history + re-validating the graph that ran.
  // Read-only.
  //
  // 0.50.0 slice 16 retired that standalone diagnosis name into `get_history`
  // (action:"diagnose"), and `get_history` was NOT on this whitelist — so the
  // fold cuts the OTHER way from enqueue_workflow above. Doing nothing would
  // have left the panel calling a name that no longer exists, admission
  // refusing the name that replaced it, and the feature breaking with a FALSE
  // REFUSAL — a regression no vocabulary gate can see, because it hunts prose,
  // not allowlist entries. The name is therefore ADDED here and ACTION-scoped
  // below to exactly ["diagnose"], which is precisely the capability the
  // retired entry admitted: list/stats/suggest were never reachable from this
  // channel and still are not.
  "get_history",
  // The training surface for the panel/mobile Training tab: flow/model
  // discovery, progress polling, dataset curation, job introspection and
  // cleanup, plus the user-initiated ops (stage a dataset, launch a run, cancel
  // one). All validation lives in the tools themselves (dataset checks,
  // docker/image preflight, liveness-verified cancel); the whitelist only gates
  // reachability.
  //
  // 0.50.0 slice 10 folded eighteen train_* tools into these three names. Every
  // action `train_prepare_dataset` and `train_start` now carry already had its
  // own whitelist entry before the fold, so those two are admitted whole. The
  // third is NOT: `train_doctor` also swallowed the two SETUP tools, which were
  // deliberately absent from this list — hence the action scoping below.
  "train_prepare_dataset",
  "train_start",
  "train_doctor",
  // RunPod control panel (desktop + mobile): the one-tap pod lifecycle + the
  // local⇄pod host switch. Read-only status/list/troubleshoot, the COST-SAVING
  // actions (stop/use_local), connect (retarget only — a pod must already be
  // RUNNING, so it neither spins nor keeps one billing), watch/unwatch, and the
  // referral deploy link. Each action validates its own pod state; the whitelist
  // only gates reachability from a canvas-less client.
  // NOTE: the create AND start actions are deliberately EXCLUDED (#269/#278) —
  // both put a pod into a BILLING state (create deploys; start RESUMES billing
  // on a stopped pod). A confirmation-less mirrored/foreign tab must not be able
  // to spend money, so both go through an agent turn / explicit UI action. stop
  // is kept (it SAVES money).
  //
  // 0.50.0 slice 8 folded eleven runpod_* names into these two, so the exclusion
  // can no longer be expressed by simply omitting a name: `runpod` carries
  // create and start as ACTIONS. It is therefore ACTION-scoped below to exactly
  // the six actions whose retired standalone names were whitelisted — see
  // CALL_TOOL_ACTION_WHITELIST.
  "runpod",
  // `runpod_watch` is NOT action-scoped: all three of its actions (watch,
  // unwatch, troubleshoot) map 1:1 onto three names that were each already
  // whitelisted here, and none of them starts, stops or bills a pod — they only
  // change what the control panel DISPLAYS, plus a read-only diagnosis. Its
  // whitelist entry therefore covers the same ground it always did.
  "runpod_watch",
  // Micro-Apps (panel "Apps" feature): the canvas-less client's list/run/poll
  // surface, plus registry install. One tool since 0.49.0 slice 2, so the
  // whitelist can no longer distinguish the actions — the risk posture is judged
  // over the whole tool. Run queues a job the user explicitly tapped (same as
  // enqueue_workflow, already whitelisted); list/get/run_status are read-only;
  // import (mobile Explore) has the rig fetch a bundle from the public registry
  // and write it locally, the same risk as save_workflow + download_model
  // (already whitelisted) — no model/system mutation, and deps install stays a
  // separate consented action.
  "apps",
  // App dependency side-panel (Explore/detail): the ✓/download panel reads what
  // an app needs vs what's installed and offers per-item fetches. Reads are safe
  // (missing-model detection + candidate resolution, node-pack presence); model
  // downloads reuse the already-whitelisted download_model download/download_civitai
  // actions, and the missing-model detection is that same tool's
  // action:"resolve_missing".
  // install_custom_node is a MUTATION that runs the pack's code on install —
  // reachable for the panel's "install missing node" button, gated behind an
  // explicit themed confirm client-side. (Revisit if a canvas-less/foreign tab
  // must not be able to trigger a node install.)
  // 0.50.0 slice 9 folded the nine knowledge tools into this one name, and the
  // entry it replaces was the READ-ONLY dependency EXTRACTOR (see DEAD_NAMES).
  // The fold brings install_deps — which installs custom node packs through
  // ComfyUI-Manager, i.e. downloads and runs third-party code — under the same
  // name, so admission is ACTION-scoped below to exactly what the retired entry
  // covered. Whitelisting the bare name would turn a read into an install.
  "list_packs",
  //
  // 0.50.0 slice 12 folded NINE custom-node lifecycle names into
  // `install_custom_node`, and only TWO of them were ever whitelisted here:
  // install_custom_node itself and the installed-pack LIST tool (whose own
  // entry sat right here until this slice retired the name). The other seven
  // arrived as ACTIONS on a name that was already admitted, which is a
  // broadening created purely by the fold — so the entry is ACTION-scoped below
  // to exactly install + list. See CALL_TOOL_ACTION_WHITELIST.
  "install_custom_node",
  // The other two thirds of slice 12 are deliberately ABSENT and must stay so:
  //
  //   `search_custom_nodes` (registry search + pack details) is read-only and
  //   network-only, but neither of the two names it now covers was EVER
  //   whitelisted here, and adding it would be inventing reachability rather
  //   than preserving it. The dependency side-panel reads what a workflow needs
  //   through download_model (action:"resolve_missing") and list_packs
  //   (action:"extract_deps"), which are whitelisted above; nothing asks a
  //   canvas-less client to browse the public registry.
  //
  //   `node_pack` (scaffold/verify/publish/read/write/patch/git on the user's
  //   own source) has three actions that are arbitrary file writes and git
  //   operations under custom_nodes/, and not one of the nine names it replaces
  //   was ever reachable from a canvas-less client either.
]);

/**
 * ACTION-scoped admission, layered on top of the name whitelist.
 *
 * The whitelist predates the 0.49.0 consolidation, which folds tool FAMILIES
 * into single action-parameterized names — and the call_tool dispatcher
 * authorizes by tool NAME only, then forwards arbitrary action arguments.
 * Whitelisting a consolidated name would therefore silently admit EVERY action
 * the family folds, including ones the retired per-tool entry never covered. A
 * tool listed here is admitted only when args.action names one of these
 * actions; a tool NOT listed here keeps plain name-level admission (its
 * whitelist entry was already judged over the whole tool).
 *
 * Wired ONLY where a slice's whitelist swap would otherwise broaden admission.
 *
 * Exported for the tests only, on the same terms as CALL_TOOL_WHITELIST above:
 * the money guard has to be asserted over every entry in this map, not over the
 * one or two a test happened to spell.
 */
export const CALL_TOOL_ACTION_WHITELIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // The `queue` entry above replaces the retired standalone cancel entry
  // (0.49.0 slice 4), which admitted CANCEL semantics only: interrupt the
  // running job, optionally prompt_id-matched, optionally with clear_pending —
  // and that is exactly action:"cancel", clear_pending included (its
  // wipe-all-pending effect the old entry already admitted). Every other
  // action stays refused, because none was reachable before:
  // move/edit/cancel_queued mutate pending
  // jobs the old entry couldn't touch individually; clear drops pending while
  // SPARING the running job, a combination the old entry could not express;
  // and list/status/get_workflow, though read-only, were never whitelisted.
  ["queue", new Set(["cancel"])],
  // The `runpod` entry above replaces NINE standalone entries (0.50.0 slice 8),
  // of which SIX were whitelisted: status, list, stop, connect, use_local and
  // deploy_link. The two that were not — create and start — are the two that
  // SPEND MONEY, and they are the whole reason this scope exists: without it,
  // swapping the nine names for the folded one would hand a canvas-less client
  // the ability to deploy a pod and start billing with no agent turn and no
  // confirmation. That is a money regression, not a permissions nicety.
  //
  // troubleshoot is absent here because it now lives on `runpod_watch`, whose
  // own (unscoped) whitelist entry covers it.
  ["runpod", new Set(["status", "list", "stop", "connect", "use_local", "deploy_link"])],
  // NOT scoped, because they are not admitted AT ALL: 0.50.0 slice 13 folded
  // ten names into `install_comfyui` and `get_system_stats`, and neither
  // survivor is in the whitelist above — nor was any of the eight names they
  // absorbed (the slice 13 block in DEAD_NAMES lists them). So that fold could
  // not broaden this channel the way `runpod`'s would have, and there is
  // nothing to scope. Recorded here because the ABSENCE is the finding: the
  // next reader should not have to re-derive it, and a later whitelist edit
  // that admits either survivor has to delete this comment to do it.
  // call-tool-admission.test.ts pins the refusal for every action of both.
  // The `list_packs` entry above replaces the retired standalone
  // dependency-extractor entry (0.50.0 slice 9), which admitted exactly
  // one thing: READ which custom node packs a workflow needs and which are
  // missing. That is action:"extract_deps" and nothing else. In particular
  // action:"install_deps" stays REFUSED — it queues ComfyUI-Manager installs,
  // which download and execute third-party code on the rig, and no
  // confirmation-less call_tool frame ever had that reach. The remaining actions
  // (list/read_workflow/list_templates/check_runtime/skill_list/skill_read),
  // though read-only, were never whitelisted either, and generate_skill writes a
  // file when `install_in` is set.
  ["list_packs", new Set(["extract_deps"])],
  // `train_doctor` above kept the retired standalone train_doctor entry's
  // admission — a READ-ONLY preflight (docker daemon reachable? GPU passthrough?
  // image built?). 0.50.0 slice 10 folded the two SETUP tools into the same
  // name, and NEITHER was ever whitelisted: action:"bootstrap" runs a ~10 minute
  // git clone + torch/pip install on this machine or on a billed pod, and
  // action:"build_image" runs a multi-GB CUDA docker build. Admitting them by name alone
  // would let a canvas-less client start either without an agent turn — a false
  // ACCEPTANCE created by the fold, which is exactly what this map exists to
  // prevent (#839). Both stay reachable through an agent turn / explicit UI
  // action, as before.
  ["train_doctor", new Set(["doctor"])],
  // 0.50.0 slice 11 folded the six inventory tools into `list_local_models`.
  // The old entry admitted ONE read-only listing and nothing else, so that is
  // all this admits. Every other action is refused because none was reachable
  // before — and one of them, `remove`, DELETES a model file off the user's
  // disk with no undo. Admitting the folded name unscoped would have handed a
  // confirmation-less mobile/mirrored client a delete button it never had; that
  // is the #839 shape exactly, a fold turning a refusal into an acceptance.
  // (`embeddings` and `list_paths` are read-only and still refused: they were
  // never whitelisted either, and this map restores the old surface, not a
  // judgement about what would be safe.)
  ["list_local_models", new Set(["list"])],
  // Same treatment for `download_model`, admitting exactly the five actions
  // whose retired single-purpose tools were whitelisted: the URL download, the
  // CivitAI download, the CivitAI model search, the CivitAI creator search, and
  // the missing-model resolver. The three remaining actions were never
  // whitelisted and stay refused: "search" (HuggingFace) and "status" are
  // read-only but were not reachable, and "cancel" ABORTS a transfer — a wrong
  // id from a canvas-less client would stop a download the user is watching,
  // which no retired entry ever permitted.
  [
    "download_model",
    new Set(["download", "download_civitai", "search_civitai", "search_creators", "resolve_missing"]),
  ],
  // The `get_workflow` entry above replaces FIVE standalone entries (0.50.0
  // slice 14) — the ones that became actions get, list, analyze, query and
  // from_image — out of the EIGHT names the tool now folds. The three that were
  // never whitelisted stay out:
  //
  //   strip / slice        — authoring TRANSFORMS, not library reads. Nothing on
  //                          a canvas-less client asks for them, and the standing
  //                          rule for this list is that a fold admits exactly what
  //                          the retired entries covered, not everything that
  //                          merely looks equally safe.
  //   prompt_director      — reaches a THIRD-PARTY custom node's HTTP endpoint
  //                          (ComfyUI-PromptDirector's /prompt_director/inspection),
  //                          which is a different server surface from the userdata
  //                          API the admitted actions read. Its posture was never
  //                          judged for this channel; it is not being judged here.
  //
  // All eight are read-only, so this scope is not a data-loss guard — it is the
  // same "admit what was admitted" discipline the queue and runpod entries set,
  // and it keeps the channel's surface a reviewed list rather than a side effect
  // of which tools happened to be folded together.
  ["get_workflow", new Set(["get", "list", "analyze", "query", "from_image"])],
  // The `save_workflow` entry above is the one WRITE on this channel's workflow
  // surface, and 0.50.0 slice 14 gave that name two more actions. Only "save"
  // was ever admitted:
  //
  //   lock         — WRITES a second file (`<filename>.lock.json`) into the user
  //                  library, and to build it SHA-256s every model the workflow
  //                  references, which on a real install is minutes of disk I/O a
  //                  confirmation-less tap must not be able to start.
  //   verify_lock  — read-only, but a local-install diagnostic that was never
  //                  whitelisted; admitting it now would be a new decision, not
  //                  the preservation of an old one.
  //
  // Without this scope the swap would have handed a mirrored/foreign tab both.
  ["save_workflow", new Set(["save"])],
  // The `install_custom_node` entry above replaces NINE standalone names
  // (0.50.0 slice 12), of which exactly TWO were whitelisted: install_custom_node
  // (the panel's "install missing node" button, behind a client-side confirm) and
  // the installed-pack list (read-only, the dependency side-panel's ✓ column).
  //
  // The seven that were NOT whitelisted are the reason this scope exists. Four of
  // them RUN THIRD-PARTY PACK CODE on the user's machine — update, reinstall and
  // fix all re-run a pack's install/dependency step, and sync_deps reinstalls
  // EVERY pack's Python requirements. uninstall REMOVES an installed pack
  // (irreversibly through this tool). disable/enable change what loads at the
  // next ComfyUI start.
  //
  // Without this scope, swapping the two names for the folded one would hand a
  // confirmation-less mirrored/foreign tab the ability to uninstall a pack or
  // re-run arbitrary pack code — a privilege broadening manufactured by a pure
  // surface change. Same failure shape as slice 8's billing actions.
  //
  // The registry lookups are NOT missing from this set — they are on a different
  // tool entirely (`search_custom_nodes`), which is not whitelisted, so no
  // action-level scope is needed to keep them out.
  ["install_custom_node", new Set(["install", "list"])],
  // The `get_image` entry above replaces TWO standalone entries (0.50.0 slice
  // 15): the fetch-an-output-by-filename tool and the output listing. Those are
  // exactly action:"get" and action:"list_outputs", and they are all this scope
  // admits. The other five actions the fold brought onto this name were never
  // whitelisted, and each is refused for a concrete reason rather than by
  // default:
  //
  //   action:"convert"       WRITES. With `out_path` it encodes a new file under
  //                          the ComfyUI output directory. A canvas-less client
  //                          could not create a file there before and must not
  //                          start now.
  //   action:"view"          Read-only, but it reads the ASSET REGISTRY, a
  //                          surface no whitelisted entry ever exposed.
  //   action:"asset_metadata" Same registry, and it additionally returns the full
  //                          WORKFLOW SNAPSHOT (prompts and all) of a past render.
  //   action:"list_assets"   Read-only, and it also triggers a /history reconcile.
  //   action:"analyze_color" Read-only, but it decodes an arbitrary
  //                          `reference_path` through sharp.
  //
  // Admitting a read-only action merely because it is read-only is how a
  // whitelist stops meaning anything: the strict rule this file already applies
  // to `queue` (its read-only actions were never whitelisted either) applies here
  // unchanged. Broadening a canvas-less client's reach to the asset registry is a
  // product decision with its own UI, not a side effect of a surface
  // consolidation. Add actions here deliberately, with a reason, if that decision
  // is ever made.
  ["get_image", new Set(["get", "list_outputs"])],
  // The `enqueue_workflow` entry above absorbed four MORE entry points in
  // 0.50.0 slice 16, and NOT ONE of their standalone names appeared on this
  // whitelist. Only the bare submit-this-graph capability was ever admitted, so
  // that is all this scope permits.
  //
  // action:"run_url" is the reason this is not a formality. It fetches a
  // workflow from a URL THE CALLER CHOOSES and, with run:true, executes it —
  // arbitrary graph execution on the user's GPU, from a channel that requires
  // no agent turn and shows no confirmation. Admitting it because the name it
  // now shares happened to be whitelisted would be the single widest
  // broadening in the consolidation. (The fetch's own SSRF guard bounds WHERE
  // it can reach; it says nothing about WHO may ask.)
  //
  // The other three are refused for the ordinary reason: their standalone names
  // were never on this list, so nothing regresses by keeping them off it.
  ["enqueue_workflow", new Set(["enqueue"])],
  // The `get_history` entry above is NEW in 0.50.0 slice 16, added to replace
  // the retired standalone diagnosis entry rather than to grant anything: scoped
  // to action:"diagnose" it admits exactly what that entry admitted, and no more.
  // list/stats/suggest stay refused — they were not reachable from this channel
  // before the fold, and a canvas-less client that needs them can ask an agent.
  ["get_history", new Set(["diagnose"])],
]);

/**
 * The admission decision for one call_tool frame: null when admitted,
 * otherwise the refusal reason (pushed as the tool_result error and logged).
 *
 * The name-level refusal string is byte-identical to what the dispatcher
 * produced before this extraction, so a client that was refused for a
 * non-whitelisted tool sees no change.
 */
export function callToolAdmission(
  tool: string,
  args: Record<string, unknown>,
): string | null {
  // A name the consolidation RETIRED reports as RETIRED — ahead of the whitelist,
  // for ANY retired name, whether or not it was ever whitelisted.
  //
  // Without this, a client calling a folded-away name gets `tool "X" is not
  // permitted`, which is not merely a worse answer than the ledger's — it is a
  // WRONG one. "Not permitted" says *you lack permission*, and sends a developer
  // to check tokens, whitelists and trust boundaries. The truth is *that tool no
  // longer exists under that name*, and the ledger already knows what to call
  // instead. Both the compact `call_tool` facade and the direct MCP `tools/call`
  // path (#895) answer a retired name from the ledger; this channel was the one
  // that overwrote it, and it is exactly the channel the panel's RunPod control
  // panel and the mobile app reach for the eleven runpod_* names 0.50.0 slice 8
  // folded away.
  //
  // Ahead of the whitelist, and not merely for names the whitelist once carried,
  // because a name that no longer exists cannot meaningfully be "permitted": the
  // retirement is the prior fact. A caller who migrates to the surviving name then
  // receives the action-scoped or permission answer below, which is the accurate
  // answer AT THAT POINT. Two truthful steps beat one misleading dead end — and
  // "was it previously whitelisted?" is not even derivable, because a slice SWAPS
  // the retired entry for its survivor, so answering it would need a second
  // append-only artifact whose omissions nothing gates.
  //
  // SAFETY — why this cannot weaken the money guard below (#269/#278). This branch
  // has exactly two outcomes: return a non-empty refusal string, or fall through to
  // the untouched original code. There is no input for which it returns null, so it
  // cannot turn a refusal into an admission — the "false refusal becomes false
  // acceptance" failure the #839 gate was about. Beyond that it is never even
  // REACHED for an action-scoped tool: every key of CALL_TOOL_ACTION_WHITELIST is a
  // live name, so retiredToolMessage() is undefined for it and control reaches the
  // action check unchanged. Both properties are pinned in the tests, the second
  // structurally, so a future slice that retires an action-scoped name (folding
  // `runpod` onward, say) fails loudly here rather than quietly returning early.
  const retired = retiredToolMessage(tool);
  if (retired !== undefined) return retired;

  if (!CALL_TOOL_WHITELIST.has(tool)) return `tool "${tool}" is not permitted`;
  const actions = CALL_TOOL_ACTION_WHITELIST.get(tool);
  if (actions !== undefined) {
    const action = typeof args.action === "string" ? args.action : undefined;
    if (action === undefined || !actions.has(action)) {
      return `tool "${tool}" is not permitted for action "${action ?? "(missing)"}"`;
    }
  }
  return null;
}
