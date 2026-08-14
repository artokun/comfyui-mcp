/**
 * #873 — OPERATOR-LEVEL RESTRICTION OF THE TOOL SURFACE.
 *
 * Reported from a Docker Compose + Open WebUI deployment behind llama-swap, where the
 * operator is NOT the person prompting. That is a different trust model from the one the
 * rest of this codebase assumes: locally, operator and prompter are the same person and a
 * tool filter would be theatre. In a shared frontend the operator needs to guarantee the
 * model cannot reach install/delete/restart tools whatever a user types.
 *
 * WHAT THIS IS AND IS NOT. It is a boundary against the MODEL and the people prompting
 * it. It is not a boundary against whoever sets the environment — they can unset it — and
 * it is not a substitute for not handing an untrusted party the ComfyUI host. Saying that
 * plainly matters, because an operator who believes this is more than it is will deploy
 * something they should not.
 *
 * Compact mode narrows DISCOVERY and is explicitly not a boundary: `call_tool` dispatches
 * by name, so a filter applied only to the registered list leaves the facade as a bypass.
 * This is applied as a registrar decorator, in the same position as the blind-image gate,
 * which both `registerAllTools` and `collectToolCatalog` already run — and `call_tool`
 * dispatches through that catalog. So both routes are covered by construction rather than
 * by remembering to cover them.
 */

/**
 * Tools that change the machine, the model library, or the running server.
 *
 * A NAME NO LONGER TELLS YOU WHAT A TOOL CAN DO (codex, P1). The 0.50.0 consolidation
 * folded destructive actions into tools that read as inspection:
 *
 *   list_local_models   action:"remove" deletes a model file; add_path/remove_path
 *                       rewrite extra_model_paths.yaml
 *   search_custom_nodes action:"install" installs a node pack
 *   get_defaults        action:"set" writes persistent config
 *   queue               action:"clear"/"cancel" destroys work — someone else's, in the
 *                       shared deployment this feature exists for
 *
 * My first list was written from the names and missed every one of those. Since the
 * filter is per-TOOL and cannot see actions, the rule is: deny the whole tool when ANY of
 * its actions violates the preset. That costs `safe` some genuinely useful reads, and
 * that is the correct trade — an operator who thinks deletion is impossible and is wrong
 * is worse off than one who has to allow a tool back explicitly.
 *
 * Per-action policy is the real answer and is deliberately not attempted here; it needs a
 * vocabulary these tools do not yet expose uniformly.
 */
export const MUTATING_TOOLS = [
  "apply_manifest",
  // action:"import" installs an app from the public registry and creates it locally.
  "apps",
  "bisect",
  "clear_vram",
  "comfy_cli",
  "create_workflow",
  "download_model",
  // action:"set" writes persistent config.
  "get_defaults",
  "install_comfyui",
  "install_custom_node",
  // action:"remove" deletes a model FILE; add_path/remove_path rewrite
  // extra_model_paths.yaml.
  "list_local_models",
  // action:"install_deps" resolves and INSTALLS custom-node packs through
  // ComfyUI-Manager — it downloads and RUNS third-party code on the ComfyUI host.
  // Missed by every earlier version of this list, including the pattern-matching
  // completeness test, because the verb is `install_deps` and the pattern was `^install$`.
  "list_packs",
  "node_pack",
  "node_snapshot",
  // action:"clear"/"cancel" destroys work — someone ELSE's, in the shared deployment
  // this feature exists for.
  "queue",
  "restart_comfyui",
  "runpod",
  "runpod_watch",
  "save_workflow",
  // Sets up the trainer itself: docker, GPU passthrough, venv.
  "train_doctor",
  "train_prepare_dataset",
  "train_start",
  "upload_image",
  "workspace",
];

/**
 * Queues work, spends money, writes a file, or publishes something. `safe` allows these
 * — rendering is the point of the product — and only `readonly` withholds them.
 */
export const EXECUTION_TOOLS = [
  "batch",
  "enqueue_workflow",
  "generate_image",
  // action:"convert" writes a converted file, and video/audio outputs are SAVED to a
  // model-chosen directory. Fetching is a read; this tool does not only fetch.
  "get_image",
  // Runs hosted partner nodes that spend PAID credits.
  "list_api_nodes",
  // Files a PUBLIC GitHub issue. Nothing on the machine changes, so `safe` permits it;
  // `readonly` promises "nothing written", and a public issue written by whoever is
  // prompting a shared frontend is squarely a write.
  //
  // My first note here said "under the operator's token", which is wrong: the GitHub
  // token is server-side in the intake Worker and the client key is a soft anti-spam gate
  // (report-issue.ts:18-23). The classification is unaffected — the issue is still public
  // and still attributable to this deployment — but a wrong premise in this ledger is
  // exactly what produced the `search_custom_nodes` inversion one round ago, so it gets
  // corrected rather than left as harmless-sounding filler.
  "report_issue",
];

/**
 * Neither mutates nor spends. Allowed by every preset.
 *
 * `search_custom_nodes` IS ON THIS LIST, AND USED TO BE ON THE MUTATING ONE. I denied it
 * claiming `action:"install"` installs a node pack. It has exactly two actions, `search`
 * and `details`, and is read-only and network-only; the installing tool is
 * `install_custom_node`, already denied. The claim came from its description MENTIONING
 * `install_custom_node (action:"install")` — the same cross-reference confusion that
 * `declaredActions()` below exists to strip, made by me while reading rather than by the
 * scanner. The net effect was an inversion worth stating plainly: `safe` withheld a pure
 * registry read while allowing `list_packs`, which genuinely installs.
 */
export const READONLY_TOOLS = [
  "calculate",
  "get_history",
  "get_system_stats",
  "get_workflow",
  // action:"propose" says so itself: "This does NOT write". Read + network only.
  "model_metadata",
  "search_custom_nodes",
  "visualize_workflow",
];

/**
 * Action names that mean a tool can change something. A SECONDARY cross-check, and it is
 * important to be honest about how little it is worth on its own.
 *
 * The first version of this feature relied on a scan like this AS the completeness
 * guarantee, with the pattern anchored to whole verbs — `^install$`. `list_packs` declares
 * `action:"install_deps"`, so the scan did not match it, and `list_packs` INSTALLS AND RUNS
 * third-party code on the ComfyUI host. The test passed 17/17 with that hole wide open,
 * which is the worst possible outcome for a check whose entire job is to notice holes: it
 * was read as coverage.
 *
 * A pattern over tool descriptions can only ever catch the cases someone already thought
 * of. So the real guarantee is now the LEDGER — every live tool must appear in exactly one
 * of MUTATING/EXECUTION/READONLY, and a new tool in none of them fails a test. That cannot
 * silently rot, because the failure mode is "unclassified", not "assumed harmless".
 *
 * What this pattern is still good for: catching a tool someone classified READONLY that
 * advertises a mutating action — a wrong hand-classification rather than a missing one.
 * The prefix form (`install_deps`, `add_path`, `generate_skill`) is deliberate.
 */
export const MUTATING_ACTION_NAMES =
  /^(remove|delete|clear|cancel|uninstall|install|reset|kill|stop|restart|purge|prune|apply|create|upload|train|add|set|save|write|switch|update|fix|disable|enable|import|convert|generate|prepare|download|move|rename)(_|$)/i;

/**
 * Verbs that mean "queue work / spend", which `safe` deliberately ALLOWS — rendering is
 * the point of the product — and only `readonly` withholds. Kept separate so the
 * completeness check does not flag `enqueue_workflow` as a hole in `safe`.
 */
export const EXECUTION_ACTION_NAMES = /^(enqueue|start|submit|run)$/i;

/**
 * Extract the actions a tool declares for ITSELF, from its description.
 *
 * Cross-references are excluded, and that is not a detail: `generate_image`'s description
 * mentions `get_defaults (action:"set")` while explaining where defaults come from. A
 * naive scan reads that as generate_image having a `set` action and reports a hole that
 * does not exist. A completeness check that cries wolf gets muted, and then it is not a
 * check.
 */
export function declaredActions(
  description: string,
  // REQUIRED, and both fields with it. They read like optional refinements and are the
  // only thing standing between this function and the over-stripping its own comment
  // calls the dangerous direction: with the guards defaulted off, every `name action:"x"`
  // is deleted, so `install_comfyui` loses its own pin/unpin/unlock and
  // `list_local_models` loses `download`. A caller that forgets them gets a silently
  // blinded result and a check that reports no holes. Make it impossible to forget.
  opts: { selfName: string; knownTools: ReadonlySet<string> },
): string[] {
  const { selfName, knownTools } = opts;
  // Both spellings occur in the real descriptions: `get_defaults (action:"set")` and
  // `download_model action:"download_civitai"`. Only the first was stripped, so
  // model_metadata — which is read-only and merely mentions where a sidecar comes from —
  // was reported as advertising a download.
  const withoutCrossRefs = description.replace(
    /\b([a-z_0-9]+)\s*(?:\(\s*)?action:"[a-z_0-9]+"\s*\)?/gi,
    (match, refName: string) => {
      // OVER-STRIPPING IS THE DANGEROUS DIRECTION: a tool whose own declaration got eaten
      // looks action-free, and a check that sees nothing reports no hole. So a reference
      // is removed ONLY when it names a tool that is not this one — a self-reference
      // ("model_metadata action:\"read\"") is kept, and so is a name nobody recognises.
      if (selfName && refName === selfName) return match;
      if (knownTools && !knownTools.has(refName)) return match;
      return "";
    },
  );
  return [...new Set([...withoutCrossRefs.matchAll(/action:"([a-z_0-9]+)"/g)].map((m) => m[1]))];
}

/**
 * Named presets, so an operator is not hand-maintaining a list against a surface that
 * grows every release — the reason a hand-written denylist rots.
 *
 * `safe`     — everything except tools that change the machine or the model library.
 *              Rendering still works; installing, deleting and restarting do not.
 * `readonly` — inspection only. No renders queued, nothing written, nothing spent.
 */
/**
 * THE PANEL SURFACE IS DENIED WHOLESALE BY BOTH PRESETS (codex, P0).
 *
 * `registerPanelTools` registers 91 `panel_*` tools through a different method
 * (`registerTool`) on a separate server, so they bypassed the filter entirely: under
 * `readonly`, `panel_run` still queued renders. That is the "a filter with a hole is
 * worse than none" case — the operator is told the surface is restricted and it is not.
 *
 * Denied as a FAMILY rather than tool-by-tool, deliberately. I classified those 91 by
 * name first and got several wrong in both directions (`panel_set_property`,
 * `panel_move_node`, `panel_add_subgraph` and `panel_update_node` all mutate and none
 * match an obvious write-ish pattern). A hand list over a surface that grows every
 * release is the rot this feature already tripped over once. `panel_*` is also exactly
 * what a hosted operator would withhold: it drives a live canvas their users share.
 *
 * Opt back in explicitly — `COMFYUI_MCP_TOOL_ALLOW=panel_graph_outline,panel_query_graph`
 * — which is the direction that fails safe when someone forgets one.
 */
const PANEL_SURFACE = ["panel_*"];

export const TOOL_PRESETS: Record<string, string[]> = {
  safe: [...MUTATING_TOOLS, ...PANEL_SURFACE],
  readonly: [...MUTATING_TOOLS, ...EXECUTION_TOOLS, ...PANEL_SURFACE],
};

export interface ToolSurfacePolicy {
  /** Explicit allow list. When non-empty, ONLY these may register. */
  allow: string[];
  /**
   * Explicit COMFYUI_MCP_TOOL_DENY entries. Kept SEPARATE from the preset's, because the
   * two lose to an allow list differently: a preset is a broad default an allow list is
   * entitled to refine (that is how you opt two `panel_*` tools back in), while an
   * explicit deny is the operator naming a tool to withhold — as explicit as the allow
   * list, and the tie goes to the smaller surface.
   */
  deny: string[];
  /** The preset's deny patterns, if a preset was named. */
  presetDeny: string[];
  /**
   * Exact `tool:action` pairs permitted when action-level restriction is active.
   * An empty list means action-level restriction is inactive. When non-empty,
   * every call carrying a string `action` must match one of these pairs.
   */
  actionAllow: ToolActionRule[];
  /** True when the operator configured anything at all. */
  active: boolean;
  /** The preset name, when one was named — for disclosure in logs. */
  preset?: string;
}

export interface ToolActionRule {
  tool: string;
  action: string;
}

/**
 * A variable that is SET BUT EMPTY throws, rather than silently meaning "no rules".
 *
 * `COMFYUI_MCP_TOOL_ALLOW=${ALLOWED_TOOLS}` in a docker-compose file with `ALLOWED_TOOLS`
 * unset expands to an empty string. Treating that as "no rules configured" produces the
 * full tool surface with no log — the identical fail-open the unknown-preset throw was
 * added to eliminate, reached by a different route. Setting the variable is the operator
 * stating an intent; an empty value cannot satisfy it either way, so neither answer is
 * safe to assume.
 */
function splitList(raw: string | undefined, varName: string): string[] {
  if (raw === undefined) return [];
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(
      `${varName} is set but empty. Refusing to start: this is usually an unexpanded ` +
        `shell variable (e.g. \`${varName}=\${ALLOWED_TOOLS}\` with ALLOWED_TOOLS unset), and ` +
        `treating it as "no rules" would expose the FULL tool surface while you believe it is ` +
        `restricted. Give it a value, or remove the variable entirely.`,
    );
  }
  return items;
}

/**
 * Parse a fail-closed action allow list.
 *
 * Rules are exact `tool:action` pairs. Globs are deliberately unsupported: allowing
 * `queue:*` would silently admit a newly-added destructive action after an upgrade,
 * which is exactly the release-drift problem an allow list is meant to prevent.
 */
function splitActionAllow(raw: string | undefined): ToolActionRule[] {
  const items = splitList(raw, "COMFYUI_MCP_TOOL_ACTION_ALLOW");
  const rules: ToolActionRule[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const match = /^([a-z_][a-z0-9_]*):([a-z_][a-z0-9_]*)$/.exec(item);
    if (!match) {
      throw new Error(
        `COMFYUI_MCP_TOOL_ACTION_ALLOW contains invalid rule "${item}". ` +
          `Expected exact tool:action pairs such as "queue:list"; wildcards and empty ` +
          `names are not allowed. Refusing to start because ignoring a malformed rule ` +
          `could expose an action the operator meant to withhold.`,
      );
    }
    const key = `${match[1]}:${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ tool: match[1], action: match[2] });
  }
  return rules;
}

/**
 * Does `name` match `pattern`? Exact, or a trailing `*` glob (`train_*`).
 *
 * Deliberately not a full glob: an operator writing a denylist is naming tools, and a
 * richer syntax buys expressiveness at the cost of a rule that quietly matches more than
 * it reads like. Prefix globs cover the real grouping in this surface (`train_*`,
 * `runpod*`) and cannot surprise anyone.
 */
export function toolMatches(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return false;
}

/**
 * Read the policy from the environment.
 *
 * AN UNKNOWN PRESET THROWS (codex, P0). The first version resolved a typo — `saef` for
 * `safe` — to no rules at all, which made `active` false, which meant the decorator
 * returned the registrar unwrapped AND the "surface restricted" log never fired. The
 * server came up with its complete tool surface and said nothing, while the operator
 * believed they had locked it down. Worse, I had written a test asserting exactly that
 * and called it correct, on the reasoning that "the log will tell them" — the log is
 * gated on the same flag.
 *
 * For a control whose whole purpose is a guarantee, silence on a misconfiguration is the
 * one unacceptable outcome. Refusing to start is loud, immediate, and cannot be mistaken
 * for success.
 */
export function resolveToolSurfacePolicy(env: NodeJS.ProcessEnv = process.env): ToolSurfacePolicy {
  const allow = splitList(env.COMFYUI_MCP_TOOL_ALLOW, "COMFYUI_MCP_TOOL_ALLOW");
  const denyRaw = splitList(env.COMFYUI_MCP_TOOL_DENY, "COMFYUI_MCP_TOOL_DENY");
  const actionAllow = splitActionAllow(env.COMFYUI_MCP_TOOL_ACTION_ALLOW);
  const presetName = (env.COMFYUI_MCP_TOOL_PRESET ?? "").trim();
  if (env.COMFYUI_MCP_TOOL_PRESET !== undefined && presetName === "") {
    throw new Error(
      `COMFYUI_MCP_TOOL_PRESET is set but empty. Refusing to start: this is usually an ` +
        `unexpanded shell variable, and treating it as "no preset" would expose the FULL tool ` +
        `surface while you believe it is restricted. Valid presets: ` +
        `${Object.keys(TOOL_PRESETS).join(", ")}. Give it a value, or remove the variable.`,
    );
  }
  if (presetName && !Object.prototype.hasOwnProperty.call(TOOL_PRESETS, presetName)) {
    throw new Error(
      `COMFYUI_MCP_TOOL_PRESET="${presetName}" is not a known preset. ` +
        `Valid presets: ${Object.keys(TOOL_PRESETS).join(", ")}. ` +
        `Refusing to start: continuing would expose the FULL tool surface while you believe ` +
        `it is restricted, which is worse than no filter at all. Fix the value, or drop the ` +
        `variable and use COMFYUI_MCP_TOOL_DENY / COMFYUI_MCP_TOOL_ALLOW directly.`,
    );
  }
  const preset = presetName ? TOOL_PRESETS[presetName] : undefined;
  return {
    allow,
    deny: denyRaw,
    presetDeny: preset ?? [],
    actionAllow,
    active:
      allow.length > 0 ||
      denyRaw.length > 0 ||
      actionAllow.length > 0 ||
      preset !== undefined,
    ...(preset ? { preset: presetName } : {}),
  };
}

/**
 * Decide whether one parsed tool invocation may dispatch.
 *
 * The policy is absolute for calls that carry `action`: once configured, an action on
 * ANY tool must be named. Calls without an action field are unchanged and remain governed
 * by the tool-level surface policy. This makes a partial list fail closed: forgetting
 * `enqueue_workflow:rerun` disables reruns instead of leaving every rerun variant open.
 */
export function toolActionAllowed(
  name: string,
  args: unknown,
  policy: ToolSurfacePolicy,
): boolean {
  if (policy.actionAllow.length === 0) return true;
  if (!args || typeof args !== "object" || Array.isArray(args)) return true;
  const action = (args as Record<string, unknown>).action;
  // ABSENT is not an action call. Those stay governed by the tool-level surface policy,
  // which is the documented composition: bound the tools with ALLOW/PRESET, bound the
  // actions with this list.
  if (action === undefined || action === null) return true;
  // PRESENT BUT NOT A STRING IS REFUSED, not waved through. Every one of the 34 live
  // `action` fields is a REQUIRED `z.enum([...])` and both dispatch routes validate
  // before the handler runs (the SDK on the direct route, an explicit safeParse in
  // compact.ts), so nothing real reaches here with a non-string action — which is
  // exactly why the branch has to be decided rather than defaulted. "Not a string" was
  // returning ALLOWED, so the one shape this function cannot classify was resolved in
  // the permissive direction, and it would stay that way if a future tool ever widened
  // an action field or a caller reused this helper somewhere the schema is looser. An
  // unclassifiable call is not an allowed call.
  if (typeof action !== "string") return false;
  // EXACT on BOTH halves, and both halves of the SAME rule. Matching `tool` against one
  // rule and `action` against another would let `ALLOW=queue:list,download_model:download`
  // admit `queue:download`; a prefix or case-insensitive compare would let `list_all`,
  // `LIST` or `queue_admin` through. See the over-permissive tests, which are the only
  // thing that can see any of those.
  return policy.actionAllow.some((rule) => rule.tool === name && rule.action === action);
}

export function toolActionPolicyError(
  name: string,
  args: unknown,
  policy: ToolSurfacePolicy,
): { content: Array<{ type: "text"; text: string }>; isError: true } | undefined {
  if (toolActionAllowed(name, args, policy)) return undefined;
  const action =
    args && typeof args === "object"
      ? String((args as Record<string, unknown>).action)
      : "unknown";
  return {
    content: [
      {
        type: "text",
        text:
          `Action "${name}:${action}" is withheld by ` +
          "COMFYUI_MCP_TOOL_ACTION_ALLOW.",
      },
    ],
    isError: true,
  };
}

/**
 * Is this tool permitted?
 *
 * ALLOW BOUNDS THE SURFACE, and is absolute when present: naming an allow list is a
 * statement that the surface is exactly those tools, so a name absent from it is denied
 * even if no deny rule mentions it. That is the safer reading of an operator's intent —
 * the alternative (allow as a mere exemption from deny) turns an incomplete list into a
 * wide-open surface, which is the failure mode nobody notices until it matters.
 *
 * DENY THEN APPLIES ON TOP, rather than being switched off by the presence of an allow
 * list. The first version returned early on the allow match, so
 * `ALLOW=list_local_models,get_history` plus `DENY=list_local_models` allowed
 * `list_local_models` — a tool whose `action:"remove"` deletes a model file — because the
 * allow list won outright. Both variables are the operator saying "not this"; the
 * intersection is the only reading where neither statement is silently discarded, and it
 * is the one that errs toward a smaller surface.
 */
export function toolAllowed(name: string, policy: ToolSurfacePolicy): boolean {
  const allowed = policy.allow.length === 0 || policy.allow.some((p) => toolMatches(name, p));
  if (!allowed) return false;
  // An EXPLICIT deny beats an allow list — both are the operator speaking, and the
  // smaller surface wins the tie.
  if (policy.deny.some((p) => toolMatches(name, p))) return false;
  // A PRESET is a broad default, so NAMING a tool in the allow list is how you refine it
  // (`PRESET=safe` + `ALLOW=panel_graph_outline,panel_query_graph`). Without this, the
  // documented opt-back-in would silently do nothing.
  //
  // AN EXACT NAME REFINES A PRESET; A GLOB DOES NOT. Measured on the first version, which
  // let any allow match override: `PRESET=safe` + `ALLOW=list_*` re-admitted `list_packs`
  // — the tool whose action:"install_deps" downloads and runs third-party code, and the
  // headline finding of the round that added the preset. `ALLOW=*` made every preset
  // entirely inert while reporting itself active.
  //
  // The difference is what the operator actually asserted. Writing `panel_graph_outline`
  // is a decision about one tool, made with it in mind. Writing `list_*` is a decision
  // about a shape, and it sweeps in whatever the next release happens to name that way —
  // which is precisely what a preset exists to protect against. So a glob narrows the
  // surface like any allow entry, and cannot re-open what the preset closed.
  if (policy.allow.includes(name)) return true;
  return !policy.presetDeny.some((p) => toolMatches(name, p));
}

/**
 * The three facade tools are NEVER filtered.
 *
 * Removing `call_tool` from a compact-mode surface leaves a client with no way to reach
 * ANY tool — the filter would read as "restrict the surface" and behave as "break the
 * server". The facade is a router; what it can route to is already governed by the same
 * policy through the shared catalog, so exempting it grants nothing.
 */
const FACADE_TOOLS = new Set(["list_tools", "describe_tool", "call_tool"]);

/**
 * Wrap a registrar so denied tools are never registered.
 *
 * Denied names are ABSENT rather than erroring on call: a tool that refuses is still a
 * tool the model can see, reason about and keep retrying. Absent means it never learns
 * the capability exists, which is what the reporter asked for and also the cheaper
 * outcome in tokens.
 */
export function withToolSurfaceFilter<T extends object>(
  server: T,
  policy: ToolSurfacePolicy,
  onFiltered?: (name: string) => void,
): T {
  if (!policy.active) return server;
  const orig = (server as unknown as { tool: (...args: unknown[]) => unknown }).tool.bind(server);
  const tool = (...args: unknown[]): unknown => {
    const name = typeof args[0] === "string" ? args[0] : undefined;
    if (name && !FACADE_TOOLS.has(name) && !toolAllowed(name, policy)) {
      onFiltered?.(name);
      // Registration is skipped entirely. The SDK's `tool()` returns a handle some
      // callers chain on, so hand back something inert rather than undefined.
      return { name, disabled: true } as unknown;
    }
    const handler = args[args.length - 1];
    if (name && typeof handler === "function" && policy.actionAllow.length > 0) {
      const wrapped = async (...handlerArgs: unknown[]) => {
        const policyError = toolActionPolicyError(name, handlerArgs[0], policy);
        if (policyError) return policyError;
        return await (handler as (...handlerArgs: unknown[]) => unknown)(...handlerArgs);
      };
      return orig(...args.slice(0, -1), wrapped);
    }
    return orig(...args);
  };
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") return tool;
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}
