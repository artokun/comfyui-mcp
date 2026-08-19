import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The tool vocabulary — the single seam the whole 0.49.0 consolidation keys off.
 *
 * This is a LEDGER, not a derived artefact. It is deliberately hand-maintained
 * and deliberately duplicates what the registry produces, because that is the
 * entire point: `registry-surface.test.ts` asserts the two match EXACTLY, in
 * both directions and in order. A generated list could not catch an unintended
 * change — it would just regenerate to match the mistake.
 *
 * Adding, renaming, or removing a tool is therefore a visible edit to this file
 * in the diff, reviewed on its own terms, rather than a silent side effect of a
 * refactor. During the consolidation, `MAX_TOOLS` ratchets DOWN with each slice
 * and every removed name lands in `DEAD_NAMES`.
 *
 * Order matters: registration order is what `tools/list` returns, and
 * src/tools/index.ts documents it as observable (models read the surface
 * top-down). Nothing enforced it before this file existed.
 */

/**
 * Every tool a client can see, in registration order.
 *
 * The "before" side of the consolidation, re-frozen at the 0.48.32 surface when
 * this branch was rebased onto current main: the 0.48.6 surface plus the tools
 * that shipped in the intervening week — cancel_download (core), and on the panel
 * side panel_refresh_nodes / panel_resize_node / panel_set_property. Appending
 * newly shipped tools to the frozen surface is the intended workflow (see
 * BASELINE_SHA256); the ratchet's guarantee is unchanged, its anchor just moved
 * forward to the surface the consolidation actually starts from.
 */
export const TOOL_NAMES = [
  "comfy_cli",
  "enqueue_workflow",
  "get_system_stats",
  "visualize_workflow",
  "create_workflow",
  "queue",
  "search_custom_nodes",
  "download_model",
  "list_local_models",
  "get_history",
  "runpod",
  "runpod_watch",
  "get_workflow",
  "save_workflow",
  "restart_comfyui",
  "get_image",
  "upload_image",
  "clear_vram",
  "get_defaults",
  "generate_image",
  "node_snapshot",
  "bisect",
  "install_custom_node",
  "report_issue",
  "install_comfyui",
  "model_metadata",
  "workspace",
  "list_api_nodes",
  "node_pack",
  "apply_manifest",
  "list_packs",
  "calculate",
  "train_prepare_dataset",
  "train_start",
  "train_doctor",
  "apps",
  "batch",
] as const;

/** A name that is actually registered today. A typo is a compile error. */
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The consolidation's "before" surface, frozen — re-anchored at 0.48.32 on rebase
 * (0.48.6 plus cancel_download; see the TOOL_NAMES header).
 *
 * This is what makes the guardrails an actual RATCHET rather than a promise.
 * registry-surface.test.ts compares the live registry against TOOL_NAMES, but both
 * are edited in the SAME commit as a removal, so on their own they cannot notice
 * that a name vanished: delete `get_queue`, drop it from TOOL_NAMES, leave it out of
 * DEAD_NAMES, and every gate passes while 21 stale references live on in prose and
 * hints. The dead-name gate only hunts names already IN the ledger, so an omission
 * disarms it silently.
 *
 * Against a frozen baseline the invariant becomes mechanical:
 *
 *     RETIREMENT_BASELINE \ TOOL_NAMES  ⊆  DEAD_NAMES
 *
 * i.e. every name that has ever existed and no longer does must be declared dead.
 * Forgetting is a build failure, not a silent hole, and the baseline never needs
 * updating — it is history, not state.
 *
 * Read from docs/design/tool-surface.txt so there is exactly one copy of the
 * baseline names (194: the 182 frozen at 0.48.32 plus the nine consolidated tools
 * appended as they shipped — `bisect` in 0.49.0 slice 1, then `node_snapshot`,
 * `apps` and `batch` in slice 2, then `comfy_cli` in slice 3, then `queue` in
 * slice 4, then `model_metadata` in slice 5, then `workspace` in slice 6, then
 * `runpod` in 0.50.0 slice 8 — plus
 * `disable_custom_node` / `enable_custom_node` / `uninstall_custom_node`, the
 * #775 cleanup surface), and so the file committed
 * as the P0 evidence is load-bearing rather than
 * decorative.
 */
const BASELINE_URL = new URL("../../docs/design/tool-surface.txt", import.meta.url);

/**
 * SHA-256 of the baseline file, so "frozen" is ENFORCED rather than asserted.
 *
 * Without this the ratchet was bypassable in one step: retire a tool, drop it from
 * TOOL_NAMES, and ALSO delete its line from the baseline — the difference set goes
 * empty and every gate passes. The baseline was an ordinary tracked file that the
 * very same commit could edit.
 *
 * Pinning the hash makes shrinking history require deliberately changing this
 * constant: a visible, reviewable line in the diff instead of a deletion buried in a
 * 200-line rename. APPENDING is legitimate — new tools join the baseline when they
 * ship — so the workflow is: append, update this hash, say why in the message.
 */
export const BASELINE_SHA256 = "984b006e468063be6fb8a5ad5432b21a2246f1510829d30775cfafd06693bc75";

/**
 * LAZY on purpose, and this is not a micro-optimisation.
 *
 * Reading at module scope meant that merely IMPORTING this file opened
 * docs/design/tool-surface.txt — and production imports it (workflow-autoload.ts needs
 * TOOL_NAMES and DEAD_NAMES for its collision guard). docs/ is not in package.json's
 * `files` allowlist, so the PUBLISHED package threw ENOENT on import and the server
 * would not start for any user. scripts/smoke-install.mjs caught it, which is precisely
 * why that gate exists.
 *
 * Only the vocabulary gate and its tests need the baseline, and both run from a
 * checkout where the file is present. The files are shipped anyway (see `files`), so a
 * future production caller degrades to a clear error rather than a missing file.
 */
function readBaseline(url: URL): { names: readonly string[]; text: string } {
  const text = readFileSync(url, "utf8");
  return { names: text.split("\n").map((l) => l.trim()).filter(Boolean), text };
}

export function retirementBaseline(): readonly string[] {
  return readBaseline(BASELINE_URL).names;
}

/** Non-throwing, so callers can report it as one finding among others. */
export function baselineIntegrity(): { ok: boolean; actual: string } {
  const actual = createHash("sha256").update(readBaseline(BASELINE_URL).text).digest("hex");
  return { ok: actual === BASELINE_SHA256, actual };
}

const PANEL_BASELINE_URL = new URL("../../docs/design/panel-surface.txt", import.meta.url);

/**
 * The PANEL surface, frozen, with its own hash — re-anchored at 0.48.32 on rebase
 * (the 0.48.6 panel surface plus panel_refresh_nodes / panel_resize_node /
 * panel_set_property, which shipped in the intervening week).
 *
 * The core ratchet covered the core tools and zero of the (now 90) panel tools,
 * because both TOOL_NAMES and RETIREMENT_BASELINE are core-only while panel names are
 * regenerated live from buildPanelToolDefs(). Renaming panel_add_node and forgetting
 * its DEAD_NAMES entry therefore produced no ratchet error at all — while 14
 * model-facing strings, PANEL_SYSTEM_APPEND among them, went on naming it. Phase 6
 * renames ALL of them to canvas_*, so a core-only ratchet would have been silent
 * through the larger of the two migrations.
 *
 * Sorted rather than in registration order: unlike tools/list, the panel surface has
 * no observable ordering, so sorting keeps the diff readable as names are added.
 */
export const PANEL_BASELINE_SHA256 = "c6f6a85a439d0d893f4ba502837e41de3f791265f398cf833139fddd513edd0d";

/** Lazy for the same reason as the core baseline — see readBaseline(). */
export function panelRetirementBaseline(): readonly string[] {
  return readBaseline(PANEL_BASELINE_URL).names;
}

export function panelBaselineIntegrity(): { ok: boolean; actual: string } {
  const actual = createHash("sha256").update(readBaseline(PANEL_BASELINE_URL).text).digest("hex");
  return { ok: actual === PANEL_BASELINE_SHA256, actual };
}

/**
 * Hard ceiling on the registered tool count.
 *
 * Glama scores "Tool Count" 1/5 at 148+ tools ("most MCP servers operate
 * effectively with 10-30"), so this is a score input, not hygiene. It starts at
 * Asserted EQUAL to TOOL_NAMES.length, not merely >=. As a loose ceiling it did
 * nothing: collapsing ten tools to 172 while leaving this at 181 passed, expanding
 * back to 181 passed, and raising it to 999 passed — so "each slice lowers it and it
 * can never drift back up" was unenforced. Equality makes the count an explicit
 * number that must be edited, and therefore reviewed, in the same diff as any change
 * to the surface. That is the ratchet: not that it cannot rise, but that it cannot
 * rise silently.
 */
export const MAX_TOOLS = 37;

/** Where this is headed, for reference in review. A goal, not enforced. */
export const TOOL_BUDGET_TARGET = 30;

/**
 * A name that no longer exists, and the paths where naming it anyway is still
 * correct.
 *
 * The distinction the gate has to make is between ROT (prose that tells a model
 * to CALL a tool that will 404) and HISTORY (prose that accurately says a tool
 * was removed). Both contain the same string, so matching alone cannot tell them
 * apart — hence per-name exceptions, each with a reason, reviewed in the diff.
 * Anything outside them fails.
 */
export interface DeadName {
  /** The removed tool name, matched on word boundaries. */
  name: string;
  /** Version that removed it — quoted in the failure message. */
  since: string;
  /** What to call instead. This is the actionable half of the error. */
  replacement: string;
  /**
   * Specific OCCURRENCES where a mention is legitimate history, not rot.
   *
   * Both fields are matched: `path` exactly (never a glob — a glob would quietly
   * cover files added later) AND `context`, a substring that must appear on the
   * same line as the name.
   *
   * `context` is not decoration. Without it an exemption is whole-FILE, so one
   * legitimate historical sentence in src/orchestrator/panel-tools.ts — thousands of
   * lines of model-facing tool descriptions — would leave every future live
   * instruction in that file pre-approved. Per-occurrence means a real instruction
   * added to an exempted file still fails.
   */
  allowedIn?: Array<{ path: string; context: string; why: string }>;
  /**
   * Files that IMPLEMENT the surviving tool, where this name still appears as a
   * bare quoted action literal — `"regenerate"` as a `z.enum` member, a
   * `case "regenerate":` label, an argument to a per-action error builder.
   *
   * Only meaningful when the fold reused the retired tool name as its action name
   * (`replacement: 'generate_image (action:"regenerate")'`), which is what
   * `declaredActions` checks. If the slice renamed the action, this licenses
   * nothing.
   *
   * NOT a whole-file pass, and the difference is the whole point. It licenses ONE
   * structural form: a complete quoted string literal whose entire content is the
   * name. src/tools/generate-image.ts is thousands of lines of model-facing
   * description strings, and `SELF`-listing it would pre-approve every live
   * instruction added there later — the exact reasoning that made `allowedIn`
   * per-occurrence. Here, `"Call regenerate to redo the render"` is still reported,
   * because the literal's content is not the name; only `"regenerate"` standing
   * alone is the action vocabulary.
   *
   * Exact paths, never globs, for the same reason as `allowedIn.path`. An entry
   * whose file no longer contains such a literal is reported as stale by
   * scripts/check-tool-vocabulary.mts — exceptions expire.
   */
  implementedIn?: string[];
}

/**
 * Matches a tool name standing on its own, optionally behind an
 * `mcp__<server>__` prefix.
 *
 * Lives here rather than in the checker script because it IS the matching
 * contract, and because scripts/ is outside `tsconfig.json`'s include — here it
 * is type-checked and unit-testable (see vocabulary.test.ts).
 *
 * `\b` is WRONG for these names: it treats `_` as a word character, so
 * `\bpanel_get_graph\b` fails to match inside `mcp__comfyui__panel_get_graph` —
 * the exact form tool names take in agent transcripts and skill files. Explicit
 * `[A-Za-z0-9_]` lookarounds fix that while still rejecting the inverse case, a
 * name embedded in a longer identifier: `get_image` must not match
 * `retarget_image` (real data at packs/artokun-flow/workflow.json:5130) and
 * `panel_get_graph` must not match its own sibling `panel_get_graph_outline`.
 */
export function deadNameRe(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])(?:mcp__[A-Za-z0-9_]+__)?${escaped}(?![A-Za-z0-9_])`);
}

/** A half-open `[start, end)` slice of one line. */
export interface Span {
  start: number;
  end: number;
}

/**
 * WHERE on a line `deadNameRe(name)` matches, not merely whether.
 *
 * `deadNameRe` answers a boolean, which is all the scanner needed while every
 * mention of a dead name was equally bad. `rotMentions` below has to tell two
 * mentions on the SAME line apart, so it needs positions — and it must get them
 * from the identical pattern, or the exemption would be reasoning about spans the
 * gate does not actually flag. Hence the shared `.source` rather than a second
 * hand-written regex.
 *
 * The `g` flag is applied to a FRESH RegExp each call: `deadNameRe`'s result is
 * unflagged and shared with `.test()` callers, and a stateful `lastIndex` leaking
 * between them is the classic way a scan starts skipping matches.
 */
export function deadNameMentions(name: string, line: string): Span[] {
  const re = new RegExp(deadNameRe(name).source, "g");
  const spans: Span[] = [];
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    // Defensive: a zero-length match would spin forever. Unreachable for a
    // non-empty name, and a ledger entry with an empty name is already a bug.
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

const IDENT = /[A-Za-z0-9_]/;

/**
 * The `mcp__<server>__` prefix, anchored to end exactly where a replacement copy
 * begins.
 *
 * The server segment forbids `__` — `[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*` allows
 * `comfyui_panel` but not `comfyui__wrong`. `deadNameRe`'s own prefix is the
 * looser `[A-Za-z0-9_]+`, and that difference is deliberate rather than an
 * oversight: there, greediness only makes it MATCH more, which is fail-safe for a
 * gate that hunts mentions. Here the same greediness EXEMPTS more, and
 * `mcp__comfyui__wrong__get_system_stats (action:"clear_vram")` would slip
 * through by letting the segment swallow `comfyui__wrong` — a line that, read the
 * ordinary way, names server `comfyui`'s tool `wrong__get_system_stats`. Strict
 * where it exempts, loose where it flags.
 */
const MCP_PREFIX_END = /(?:^|[^A-Za-z0-9_])mcp__[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*__$/;

/** Live tool names, for the "the replacement must name a real tool" guard below. */
const LIVE_TOOLS: ReadonlySet<string> = new Set<string>(TOOL_NAMES);

/** Escape for embedding in a RegExp source. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The action names a replacement declares:
 *
 *     'generate_image (action:"regenerate")'                  → ["regenerate"]
 *     'comfy_cli (action:"models_list"|"models_show")'        → ["models_list", "models_show"]
 *     'queue (action:"list")'                                 → ["list"]
 *     'panel_get_errors'                                      → []
 *
 * This is how the ledger tells us that a retired TOOL name is now an ACTION name.
 * Everything the action-form rules license keys off it, so a fold that RENAMED its
 * action (slice 9's `list_skills` → `skill_list`) declares no collision and gets
 * no new exemptions at all — the same self-derivation the replacement-copy rule
 * uses, applied to the other half of the call form.
 */
export function declaredActions(replacement: string): string[] {
  // ANCHORED to the call form: `<tool> (action:…)` at the START of the
  // replacement, not the first `action:` anywhere in it. Otherwise prose that
  // merely quotes the old spelling —
  //     'generate_image (mode:"fast") — old syntax action:"regenerate" is retired'
  // — reads as a declaration and switches the action rules on for a name the
  // surviving tool has no action for.
  const call =
    /^\s*(?:mcp__[A-Za-z0-9_]+__)?[A-Za-z0-9_]+\s*\(\s*action\s*:\s*((?:["'`][A-Za-z0-9_]+["'`]\s*\|?\s*)+)\)/.exec(
      replacement,
    );
  if (!call) return [];
  return [...call[1]!.matchAll(/["'`]([A-Za-z0-9_]+)["'`]/g)].map((m) => m[1]!);
}

/**
 * An `action:` key opening a call's argument list — `tool (action:"N")`.
 *
 * Just `\(\s*$`, not `<identifier>\s*\(\s*$`: the narrower shape missed
 * `some_other_tool?.(action:"N")` and `some_other_tool /* note *\/ (action:"N")`,
 * which name a tool exactly as much as the plain form does. Any `(` is the
 * conservative reading, and it costs nothing — the legitimate forms are separated
 * from a call by a quote (`fn('action:"N" …')`) or a brace (`{ action:"N" }`),
 * never by a bare paren.
 */
const TOOL_CALL_OPEN = /\(\s*$/;

/**
 * Positions where a quoted literal is an ACTION rather than a tool argument:
 * an array/enum member (`[` or `,` before it) or a `case` label. These are the
 * three forms the slices measured.
 *
 * A call's FIRST argument — `callTool("regenerate", payload)` — is deliberately
 * NOT one of them. It is indistinguishable from `z.literal("regenerate")`, and one
 * of those two is a live dispatch to the retired tool. Fail closed: report it, and
 * let a real case be an `allowedIn` with a reason.
 */
const ACTION_LITERAL_LEAD = /(?:[[,]|(?<![A-Za-z0-9_])case)\s*$/;

/**
 * Where `line` uses `name` as an ACTION VALUE — `action:"regenerate"`,
 * `"action": "regenerate"`, `c.args?.action === "regenerate"`.
 *
 * WHY THIS IS NOT ROT AT ALL. After a fold, `regenerate` is no longer a tool name,
 * but it IS a live action name, and `deadNameRe` cannot tell the two apart because
 * they are spelled identically. The replacement-copy rule only covers prose that
 * quotes the whole call form; slice 16 measured the rest and it is the majority —
 * 57 of 84 hits are the token used as a value or identifier, where no replacement
 * string can wrap it. The text here says `action` itself, so it is self-evidencing
 * and needs no ledger entry, which is also what keeps `docs:gen` output stable:
 * the generated `"action": "regenerate"` in docs/tools/*.mdx is covered by the same
 * rule as the source string it was generated from.
 *
 * THE EXCLUSION IS THE LOAD-BEARING PART. `some_other_tool (action:"regenerate")`
 * also contains `action:"regenerate"` — and it must still fail, because it names
 * the WRONG tool. So an `action` key sitting directly in a `<identifier> (`
 * argument position is a TOOL-CALL form: it claims a specific tool, and it is
 * judged by the replacement-copy rule instead, which exempts it only when the tool
 * is the declared survivor. A bare `- action:"regenerate" — …` bullet claims no
 * tool and is licensed here.
 *
 * The prefix is measured to the `action` TOKEN, not to the match start, and that
 * is what separates a call form from a string: `.describe('action:"regenerate" …')`
 * has a quote between the `(` and the key, so a string opened and the text inside
 * is prose, not an argument list. Testing from the match start instead classified
 * every `fn('action:"…"')` as a tool call and flagged it — one of the measured
 * forms.
 *
 * ACCEPTED LIMIT: a quoted key inside a call, `some_other_tool ("action": "x")`,
 * is therefore not treated as a call form. It is not a shape anyone writes — the
 * documented call form is `tool (action:"x")` — and the canonical one is excluded.
 */
export function actionValueSpans(name: string, line: string): Span[] {
  const re = new RegExp(
    `(?<![A-Za-z0-9_])(["'\`]?)action["'\`]?\\s*(?::|={1,3}|!={1,2})\\s*["'\`]${escapeRe(name)}["'\`]`,
    "g",
  );
  const spans: Span[] = [];
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    const keyStart = m.index + m[1]!.length;
    if (TOOL_CALL_OPEN.test(line.slice(0, keyStart))) continue;
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/**
 * Where `line` spells `name` as a COMPLETE quoted string literal — `"regenerate"`.
 *
 * This is the residue slice 16 measured inside the file that registers the
 * surviving tool: `z.enum([… "regenerate" …])`, `case "regenerate":`,
 * `need(args.asset_id, "regenerate", …)`. Nothing on those lines says the word
 * "action", so no self-evidencing rule can reach them; they are licensed only in
 * the paths an entry names in `implementedIn`.
 *
 * Narrow on purpose, in two dimensions. The literal's ENTIRE content must be the
 * name, so `"Call regenerate to redo the render"` is a quoted string in the same
 * file and is still reported; backticks are excluded, so a markdown code span
 * `` `regenerate` `` in a JSDoc block there is still reported too. And it must sit
 * in an action POSITION — see ACTION_LITERAL_LEAD — so a dispatch by tool name,
 * `callTool("regenerate", payload)`, is still reported even in a declared file.
 */
export function actionLiteralSpans(name: string, line: string): Span[] {
  const re = new RegExp(`(["'])${escapeRe(name)}\\1`, "g");
  const spans: Span[] = [];
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (!ACTION_LITERAL_LEAD.test(line.slice(0, m.index))) continue;
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/**
 * Every verbatim occurrence of `needle` in `line` that BEGINS at a token
 * boundary, INCLUDING occurrences that overlap each other.
 *
 * The boundary rule is not decoration. Without it `indexOf` treats the
 * replacement as an unbounded substring, and
 *
 *     not_get_system_stats (action:"clear_vram")
 *
 * contains `get_system_stats (action:"clear_vram")` starting at index 4 — so a
 * mention naming a DIFFERENT tool would be exempted by the mere suffix of that
 * tool's name, which is precisely the case this whole exemption must not admit.
 * Requiring a non-identifier character (or start of line) before the copy is the
 * same contract `deadNameRe` already applies to names, `mcp__<server>__` allowance
 * included: a namespacing client writes `mcp__comfyui__get_system_stats (…)`,
 * which is the same tool and must still count. See MCP_PREFIX_END for why that
 * allowance is stricter here than in `deadNameRe`.
 *
 * The asymmetry is deliberate: there is no matching rule on the RIGHT. A
 * replacement names its tool at the START, so an identifier run before the copy
 * changes WHICH tool is named, while one after it only extends trailing prose —
 * `foo (action:"old_tool") x` inside `foo (action:"old_tool") xy` still names foo
 * and still carries the correct call form, so flagging it would be a false
 * positive that sends a sweep to "fix" text that is already right.
 */
function literalSpans(needle: string, line: string): Span[] {
  const spans: Span[] = [];
  if (needle.length === 0) return spans;
  for (let i = line.indexOf(needle); i !== -1; i = line.indexOf(needle, i + 1)) {
    const startsAtBoundary =
      i === 0 || !IDENT.test(line[i - 1]!) || MCP_PREFIX_END.test(line.slice(0, i));
    if (startsAtBoundary) spans.push({ start: i, end: i + needle.length });
  }
  return spans;
}

/**
 * Is this entry a usable migration instruction at all? Every exemption below
 * reads it as one, so a broken entry must license nothing.
 */
function usableTarget(dead: DeadName): boolean {
  if (!dead.replacement.includes(dead.name)) return false;
  // The replacement must spell the retired name EXACTLY ONCE. One mention is the
  // action slot — the whole reason this exemption exists. A second is something
  // else, and `get_system_stats (action:"clear_vram") then call clear_vram` is a
  // ledger entry carrying its own live instruction: exempting a verbatim copy would
  // launder that instruction into every page that quotes the ledger. Zero mentions
  // means the name only occurs inside a longer identifier (`clear_vram_stats`), so
  // there is nothing to exempt either. Both fail CLOSED.
  const inReplacement = deadNameMentions(dead.name, dead.replacement);
  if (inReplacement.length !== 1) return false;

  // The replacement must also name a tool that ACTUALLY EXISTS, other than the dead
  // one. A replacement carrying nothing beyond the dead name — `clear_vram`,
  // `` `clear_vram` ``, `clear_vram.`, and equally the prose `Use clear_vram` — is
  // not a migration target; it says "call the tool that no longer exists".
  // Exempting against it would blind the gate for that name completely, which is
  // the one way this rule could turn into the bypass it is meant not to be. Merely
  // requiring "some identifier survives" was not enough, because `Use` is an
  // identifier. Requiring a LIVE tool name turns a heuristic into a checkable
  // property, and catches a mistyped survivor in the ledger as a bonus.
  //
  // KNOWN LIMIT: `TOOL_NAMES` is core-only, so a fold whose replacement names a
  // PANEL tool AND whose action reuses the retired name would not be exempted. No
  // such entry exists (every panel replacement in the ledger names a different
  // tool, so the `includes` guard above already returns first), and the failure
  // direction is a visible false positive — the gate reports the line, and the
  // DEAD_NAMES ledger test names the entry — never a silent pass.
  const rest =
    dead.replacement.slice(0, inReplacement[0]!.start) +
    dead.replacement.slice(inReplacement[0]!.end);
  return (rest.match(/[A-Za-z0-9_]+/g) ?? []).some((token) => LIVE_TOOLS.has(token));
}

/**
 * The mentions of a dead name on one line that are ROT.
 *
 * WHY ANY EXEMPTION EXISTS. For many 0.50.0 folds the natural action name IS the
 * retired tool name. So `regenerate` stops being a tool and becomes an ACTION of
 * `generate_image` — and `deadNameRe` cannot tell those apart, because they are
 * spelled identically. Every remaining use of the token is then flagged, including
 * the migration text the prose sweep is REQUIRED to write:
 *
 *     generate_image (action:"regenerate")
 *
 * Without a rule, no sweep for those names can ever go green. Slice 9 escaped only
 * by RENAMING its actions (`list_skills` → `skill_list`); that does not scale to
 * `apply_manifest` (93 mentions) or `clear_vram` (35), where contorting exactly the
 * names models reach for is a real discoverability regression.
 *
 * THE THREE RULES, each self-derived from the entry and each POSITIONAL:
 *
 *   (a) MIGRATION TARGET — inside a verbatim copy of the entry's own
 *       `replacement`. Covers prose: comments, README rows, docs. Measured at 27
 *       of slice 16's 84 hits.
 *   (b) ACTION VALUE — `action:"regenerate"`, `"action": "regenerate"`,
 *       `args.action === "regenerate"`. Self-evidencing (the text says `action`),
 *       so repo-wide and no ledger entry, which is what keeps `docs:gen` output
 *       stable across regeneration. See actionValueSpans.
 *   (c) ACTION LITERAL — `"regenerate"` as a complete quoted string, ONLY in the
 *       paths the entry lists in `implementedIn`: enum members, `case` labels,
 *       arguments to per-action helpers. See actionLiteralSpans.
 *
 * (b) and (c) require the entry's `replacement` to declare this exact name as an
 * action (`declaredActions`), so a fold that renamed its action gets nothing.
 *
 * WHY THIS DOES NOT WEAKEN THE RATCHET. Nothing here is a human-chosen string:
 * (a) is the ledger's own output, (b) is a syntactic form that names itself, (c) is
 * one structural form in explicitly declared files. All of these still fail:
 *
 *   - a bare `regenerate` anywhere, and `call regenerate to redo the render`;
 *   - `some_other_tool (action:"regenerate")` — the WRONG tool. (b) deliberately
 *     skips any match preceded by `<identifier> (`, handing it to (a), which
 *     exempts it only when the tool is the declared survivor;
 *   - `not_generate_image (action:"regenerate")` — a tool whose name merely ENDS
 *     with the survivor's;
 *   - `"Call regenerate now"` in an `implementedIn` file — a quoted string whose
 *     content is not exactly the name;
 *   - a rotten bare mention sharing a line with a legitimate replacement form or
 *     `action:"N"`. Exemption is by span CONTAINMENT, never line-wide.
 *
 * (a) matches LITERALLY (`indexOf`), never a regex built from `replacement`: the
 * replacements are call forms containing `(`, `)`, `"` and `|`, and a pattern
 * compiled from `comfy_cli (action:"a"|"b")` would alternate rather than match.
 *
 * Entries whose replacement does not contain their own name — the large majority,
 * and every entry in the ledger today — are byte-for-byte unaffected by all three.
 *
 * NOTE for a fold whose replacement names several actions: declare the SAME
 * combined string (`manager (action:"update_all"|"self_update")`) on every entry it
 * covers. The rules are per-name and self-derived on purpose, so a name is exempted
 * only against ITS OWN declared target.
 *
 * `path` is the repo-relative file being scanned; omit it and rule (c) is off.
 */
export function rotMentions(dead: DeadName, line: string, path?: string): Span[] {
  const mentions = deadNameMentions(dead.name, line);
  if (mentions.length === 0) return mentions;
  // Every rule below reads the ledger entry as a migration instruction, so a broken
  // entry licenses nothing at all. One gate, three rules, fail-closed.
  if (!usableTarget(dead)) return mentions;

  // (a) The migration TARGET, spelled exactly — the form the prose sweep writes.
  const targets = literalSpans(dead.replacement, line);

  // (b) and (c) apply only when the fold reused the retired TOOL name as its
  // ACTION name, which is the collision that creates the problem. A fold that
  // renamed its action declares nothing here and gains nothing.
  if (declaredActions(dead.replacement).includes(dead.name)) {
    // (b) The name used as an action VALUE. Self-evidencing, so repo-wide.
    targets.push(...actionValueSpans(dead.name, line));
    // (c) The name as a bare quoted action literal, only in the declared
    // implementing files. `path` is optional so a caller with no file context
    // (call_tool, a unit test) simply never gets this rule.
    if (path !== undefined && dead.implementedIn?.includes(path)) {
      targets.push(...actionLiteralSpans(dead.name, line));
    }
  }

  if (targets.length === 0) return mentions;
  // CONTAINMENT, not overlap, and it is what makes all three rules per-OCCURRENCE
  // rather than per-line. A mention that merely straddles the edge of a replacement
  // copy — which a truncated or mistyped `replacement` produces — is not "inside" a
  // verbatim copy of anything; and a rotten bare mention sitting beside a legitimate
  // `action:"N"` is outside that span, so it is still reported. A line-wide test
  // would exempt both, which is the single most dangerous way to widen this.
  return mentions.filter((m) => !targets.some((t) => m.start >= t.start && m.end <= t.end));
}

/**
 * Seeded with real rot rather than a hypothetical, so the gate proves itself on
 * day one: `panel_get_graph` was removed upstream but survives in FIVE live
 * hint strings in the panel repo (comfyui-mcp-panel.js:3733,3737,4659,5328,5704)
 * — strings that instruct the model to call a tool that does not exist. The
 * mirrored gate in the panel repo is what catches those; here the same ledger
 * entry documents the two mentions in this repo that are correct.
 */
export const DEAD_NAMES: readonly DeadName[] = [
  // 0.49.0 slice 6: the three workspace tools folded into one
  // action-parameterized `workspace` tool. Same workspace-env services, same
  // JSON return shapes — only the surface changed, so every mention of the old
  // names is now rot pointing at a 404.
  {
    name: "get_workspace",
    since: "0.49.0",
    replacement: 'workspace (action:"get")',
    allowedIn: [
      {
        path: "docs/using-tools.mdx",
        context: "| `get_workspace` | `workspace` with `action: \"get\"` |",
        why: "The old-name → new-form migration table on the human-facing tools guide. A community reader (#660-adjacent confusion) read the 0.49.0 consolidation as capability being REMOVED; the table exists to show the same behaviour under a new label, so the left column must spell the retired name. It is a mapping AWAY from the name, never an instruction to call it.",
      },
      {
        path: "docs/ko/using-tools.mdx",
        context: "| `get_workspace` | `workspace` with `action: \"get\"` |",
        why: "Same migration table as docs/using-tools.mdx, in the Korean translation. Cells stay English (identifiers); only the surrounding prose is translated.",
      },
      {
        path: "docs/ja/using-tools.mdx",
        context: "| `get_workspace` | `workspace` with `action: \"get\"` |",
        why: "Same migration table as docs/using-tools.mdx, in the Japanese translation. Cells stay English (identifiers); only the surrounding prose is translated.",
      },
      {
        path: "docs/zh/using-tools.mdx",
        context: "| `get_workspace` | `workspace` with `action: \"get\"` |",
        why: "Same migration table as docs/using-tools.mdx, Simplified Chinese translation. Cells stay English.",
      },
      {
        path: "docs/fr/using-tools.mdx",
        context: "| `get_workspace` | `workspace` with `action: \"get\"` |",
        why: "Same migration table as docs/using-tools.mdx, French translation. Cells stay English.",
      },
      {
        path: "docs/es/using-tools.mdx",
        context: "| `get_workspace` | `workspace` with `action: \"get\"` |",
        why: "Same migration table as docs/using-tools.mdx, es translation. Cells stay English.",
      },
      {
        path: "docs/zh-TW/using-tools.mdx",
        context: "| `get_workspace` | `workspace` with `action: \"get\"` |",
        why: "Same migration table as docs/using-tools.mdx, zh-TW translation. Cells stay English.",
      },
      {
        path: "docs/ru/using-tools.mdx",
        context: "| `get_workspace` | `workspace` with `action: \"get\"` |",
        why: "Same migration table as docs/using-tools.mdx, ru translation. Cells stay English.",
      },
      {
        path: "docs/ar/using-tools.mdx",
        context: "| `get_workspace` | `workspace` with `action: \"get\"` |",
        why: "Same migration table as docs/using-tools.mdx, ar translation. Cells stay English.",
      },
      {
        path: "docs/pt-BR/using-tools.mdx",
        context: "| `get_workspace` | `workspace` with `action: \"get\"` |",
        why: "Same migration table as docs/using-tools.mdx, pt-BR translation. Cells stay English.",
      },
      {
        path: "docs/tr/using-tools.mdx",
        context: "| `get_workspace` | `workspace` with `action: \"get\"` |",
        why: "Same migration table as docs/using-tools.mdx, tr translation. Cells stay English.",
      },
      {
        path: "src/tools/retired-redirect.ts",
        context: '"Tool get_workspace not found"',
        why: "A verbatim quotation of MEASURED output: the three-row table in that module's header records what each call path actually answered on 0.49.0 for an already-retired name, which is the evidence the module exists at all. Quoting the SDK's bare 404 is the opposite of instructing anyone to call the name — it is the defect being removed. Deliberately the ONLY mention left in that file: the surrounding prose was reworded to say 'a name the 0.49.0 slices had already retired', and its test file derives the name from this ledger rather than spelling it, so this exemption covers one quoted line instead of seven comments. Pinned to the quotation because a quotation is the part least likely to be reworded — and if it IS reworded the gate should fire.",
      },
    ],
  },
  {
    name: "set_default_workspace",
    since: "0.49.0",
    replacement: 'workspace (action:"set_default")',
  },
  {
    name: "list_workspaces",
    since: "0.49.0",
    replacement: 'workspace (action:"list")',
  },
  // 0.49.0 slice 5: the three model-metadata tools folded into one
  // action-parameterized `model_metadata` tool. Same Model Explorer proxy routes,
  // same 404 degradations, same return shapes — only the surface changed, so
  // every mention of the old names is now rot pointing at a 404.
  {
    name: "model_metadata_read",
    since: "0.49.0",
    replacement: 'model_metadata (action:"read")',
  },
  {
    name: "model_metadata_propose",
    since: "0.49.0",
    replacement: 'model_metadata (action:"propose")',
  },
  {
    name: "model_metadata_fetch_civitai",
    since: "0.49.0",
    replacement: 'model_metadata (action:"fetch_civitai")',
  },
  // 0.49.0 slice 4: the eight queue/jobs tools folded into one action-parameterized
  // `queue` tool. Same queue-manager services, same return shapes (JSON for the
  // query actions, prose for the cancels) — only the surface changed, so every
  // mention of the old names is now rot pointing at a 404.
  {
    name: "get_queue",
    since: "0.49.0",
    replacement: 'queue (action:"list")',
    allowedIn: [
      {
        path: "docs/using-tools.mdx",
        context: "| `get_queue` | `queue` with `action: \"list\"` |",
        why: "Same migration table as get_workspace above — the retired name appears only in the left column, mapped to its live replacement on the right.",
      },
      {
        path: "docs/ko/using-tools.mdx",
        context: "| `get_queue` | `queue` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, Korean translation. Cells stay English.",
      },
      {
        path: "docs/ja/using-tools.mdx",
        context: "| `get_queue` | `queue` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, Japanese translation. Cells stay English.",
      },
      {
        path: "docs/zh/using-tools.mdx",
        context: "| `get_queue` | `queue` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, Simplified Chinese translation. Cells stay English.",
      },
      {
        path: "docs/fr/using-tools.mdx",
        context: "| `get_queue` | `queue` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, French translation. Cells stay English.",
      },
      {
        path: "docs/es/using-tools.mdx",
        context: "| `get_queue` | `queue` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, es translation. Cells stay English.",
      },
      {
        path: "docs/zh-TW/using-tools.mdx",
        context: "| `get_queue` | `queue` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, zh-TW translation. Cells stay English.",
      },
      {
        path: "docs/ru/using-tools.mdx",
        context: "| `get_queue` | `queue` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, ru translation. Cells stay English.",
      },
      {
        path: "docs/ar/using-tools.mdx",
        context: "| `get_queue` | `queue` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, ar translation. Cells stay English.",
      },
      {
        path: "docs/pt-BR/using-tools.mdx",
        context: "| `get_queue` | `queue` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, pt-BR translation. Cells stay English.",
      },
      {
        path: "docs/tr/using-tools.mdx",
        context: "| `get_queue` | `queue` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, tr translation. Cells stay English.",
      },
    ],
  },
  {
    name: "get_queued_workflow",
    since: "0.49.0",
    replacement: 'queue (action:"get_workflow")',
  },
  {
    name: "move_queued_job",
    since: "0.49.0",
    replacement: 'queue (action:"move")',
  },
  {
    name: "edit_queued_job",
    since: "0.49.0",
    replacement: 'queue (action:"edit")',
  },
  {
    name: "get_job_status",
    since: "0.49.0",
    replacement: 'queue (action:"status")',
  },
  {
    name: "cancel_job",
    since: "0.49.0",
    replacement: 'queue (action:"cancel")',
    allowedIn: [
      {
        path: "docs/blog/comfyui-mcp-tdqs-case-study.mdx",
        context: "our single weakest tool, `cancel_job`,",
        why: "A DATED case study of a tool-description audit, narrating what the score was when the tool still had this name. Rewriting the score narrative to the new name would falsify the record of what was measured.",
      },
      {
        path: "docs/blog/comfyui-mcp-tdqs-case-study.mdx",
        context: "Here's `cancel_job`, our 3.1, before and after:",
        why: "Same post, introducing a verbatim quote of the tool's description at audit time — the quote is the artifact under analysis.",
      },
      {
        path: "docs/blog/comfyui-mcp-tdqs-case-study.mdx",
        context: "Raising the floor — `cancel_job`,",
        why: "Same post, past-tense recap of which tools were rewritten in that audit.",
      },
    ],
  },
  {
    name: "cancel_queued_job",
    since: "0.49.0",
    replacement: 'queue (action:"cancel_queued")',
    allowedIn: [
      {
        path: "docs/blog/comfyui-mcp-tdqs-case-study.mdx",
        context: "use `cancel_queued_job` to remove one specific pending job",
        why: "Inside a verbatim > quote of cancel_job's description AS WRITTEN at audit time — the before/after quote is the post's evidence, so editing it would misquote the artifact.",
      },
    ],
  },
  {
    name: "clear_queue",
    since: "0.49.0",
    replacement: 'queue (action:"clear")',
    allowedIn: [
      {
        path: "docs/blog/comfyui-mcp-tdqs-case-study.mdx",
        context: "`clear_queue` to drop all pending jobs",
        why: "Same verbatim quote of the audited description — a historical artifact in a dated post, not live guidance.",
      },
    ],
  },
  // 0.49.0 slice 3: the eight comfy_cli_* tools folded into one action-parameterized
  // `comfy_cli` tool. Same services, same envelope/1 return shapes, same CLI command
  // construction — only the surface changed, so every mention of the old names is now
  // rot pointing at a 404. The replacements name the action family because each old
  // tool covered several actions (comfy_cli_jobs alone was five).
  {
    name: "comfy_cli_status",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"status")',
  },
  {
    name: "comfy_cli_server",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"server_start"|"server_stop"|"server_restart")',
  },
  {
    name: "comfy_cli_jobs",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"jobs_list"|"jobs_status"|"jobs_wait"|"jobs_watch"|"jobs_cancel")',
  },
  {
    name: "comfy_cli_search_nodes",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"search_nodes")',
  },
  {
    name: "comfy_cli_workflow",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"workflow_validate"|"workflow_run")',
  },
  {
    name: "comfy_cli_transfer",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"transfer_upload"|"transfer_download")',
  },
  {
    name: "comfy_cli_models",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"models_list_folders"|"models_list_folder"|"models_search"|"models_show"|"models_download"|"models_remove")',
  },
  {
    name: "comfy_cli_skills",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"skills_list"|"skills_show"|"skills_validate"|"skills_install"|"skills_status"|"skills_uninstall")',
  },
  // 0.49.0 slice 2: three more families folded into action-parameterized tools —
  // the three node-snapshot tools into `node_snapshot`, the four batch tools into
  // `batch`, and the five apps_* tools into `apps`. Same services, same return
  // shapes; only the surface changed, so every mention of the old names is now rot
  // pointing at a 404.
  {
    name: "save_node_snapshot",
    since: "0.49.0",
    replacement: 'node_snapshot (action:"save")',
  },
  {
    name: "restore_node_snapshot",
    since: "0.49.0",
    replacement: 'node_snapshot (action:"restore")',
  },
  {
    name: "list_node_snapshots",
    since: "0.49.0",
    replacement: 'node_snapshot (action:"list")',
  },
  {
    name: "submit_batch",
    since: "0.49.0",
    replacement: 'batch (action:"submit")',
  },
  {
    name: "get_batch_status",
    since: "0.49.0",
    replacement: 'batch (action:"status")',
  },
  {
    name: "get_batch_output",
    since: "0.49.0",
    replacement: 'batch (action:"output")',
  },
  {
    name: "wait_for_batch",
    since: "0.49.0",
    replacement: 'batch (action:"wait")',
  },
  {
    name: "apps_list",
    since: "0.49.0",
    replacement: 'apps (action:"list")',
  },
  {
    name: "apps_get",
    since: "0.49.0",
    replacement: 'apps (action:"get")',
  },
  {
    name: "apps_run",
    since: "0.49.0",
    replacement: 'apps (action:"run")',
  },
  {
    name: "apps_run_status",
    since: "0.49.0",
    replacement: 'apps (action:"run_status")',
    allowedIn: [
      {
        path: "docs/using-tools.mdx",
        context: "| `apps_run_status` | `apps` with `action: \"run_status\"` |",
        why: "Same migration table as get_workspace above. Included as the third row because it is from a DIFFERENT consolidation slice, showing the reader that the pattern is general rather than one tool's quirk.",
      },
      {
        path: "docs/ko/using-tools.mdx",
        context: "| `apps_run_status` | `apps` with `action: \"run_status\"` |",
        why: "Same migration table as docs/using-tools.mdx, Korean translation. Cells stay English.",
      },
      {
        path: "docs/ja/using-tools.mdx",
        context: "| `apps_run_status` | `apps` with `action: \"run_status\"` |",
        why: "Same migration table as docs/using-tools.mdx, Japanese translation. Cells stay English.",
      },
      {
        path: "docs/zh/using-tools.mdx",
        context: "| `apps_run_status` | `apps` with `action: \"run_status\"` |",
        why: "Same migration table as docs/using-tools.mdx, Simplified Chinese translation. Cells stay English.",
      },
      {
        path: "docs/fr/using-tools.mdx",
        context: "| `apps_run_status` | `apps` with `action: \"run_status\"` |",
        why: "Same migration table as docs/using-tools.mdx, French translation. Cells stay English.",
      },
      {
        path: "docs/es/using-tools.mdx",
        context: "| `apps_run_status` | `apps` with `action: \"run_status\"` |",
        why: "Same migration table as docs/using-tools.mdx, es translation. Cells stay English.",
      },
      {
        path: "docs/zh-TW/using-tools.mdx",
        context: "| `apps_run_status` | `apps` with `action: \"run_status\"` |",
        why: "Same migration table as docs/using-tools.mdx, zh-TW translation. Cells stay English.",
      },
      {
        path: "docs/ru/using-tools.mdx",
        context: "| `apps_run_status` | `apps` with `action: \"run_status\"` |",
        why: "Same migration table as docs/using-tools.mdx, ru translation. Cells stay English.",
      },
      {
        path: "docs/ar/using-tools.mdx",
        context: "| `apps_run_status` | `apps` with `action: \"run_status\"` |",
        why: "Same migration table as docs/using-tools.mdx, ar translation. Cells stay English.",
      },
      {
        path: "docs/pt-BR/using-tools.mdx",
        context: "| `apps_run_status` | `apps` with `action: \"run_status\"` |",
        why: "Same migration table as docs/using-tools.mdx, pt-BR translation. Cells stay English.",
      },
      {
        path: "docs/tr/using-tools.mdx",
        context: "| `apps_run_status` | `apps` with `action: \"run_status\"` |",
        why: "Same migration table as docs/using-tools.mdx, tr translation. Cells stay English.",
      },
    ],
  },
  {
    name: "apps_import",
    since: "0.49.0",
    replacement: 'apps (action:"import")',
  },
  // 0.49.0 slice 1: the five bisect_* tools folded into one action-parameterized
  // `bisect` tool. Same state machine, same return shapes — only the surface
  // changed, so every mention of the old names is now rot pointing at a 404.
  {
    name: "bisect_start",
    since: "0.49.0",
    replacement: 'bisect (action:"start")',
  },
  {
    name: "bisect_good",
    since: "0.49.0",
    replacement: 'bisect (action:"good")',
  },
  {
    name: "bisect_bad",
    since: "0.49.0",
    replacement: 'bisect (action:"bad")',
  },
  {
    name: "bisect_reset",
    since: "0.49.0",
    replacement: 'bisect (action:"reset")',
  },
  {
    name: "bisect_status",
    since: "0.49.0",
    replacement: 'bisect (action:"status")',
  },
  {
    name: "panel_view_errored_nodes",
    since: "removed upstream before 0.48.0",
    replacement: "panel_get_errors",
    // Found by review, not by the ratchet, and that is the point: this name was retired
    // BEFORE docs/design/panel-surface.txt was frozen, so `BASELINE \ live` could never
    // contain it. The ratchet's guarantee is bounded by when the baseline was taken —
    // it catches everything retired FROM 0.48.6 ONWARD, and nothing retired before.
    // Names from earlier eras only enter the ledger when something finds them, which is
    // why the dead-name scan has to keep running over prose rather than being replaced
    // by the ratchet.
  },
  {
    name: "panel_get_graph",
    since: "removed upstream before 0.48.0",
    replacement: "panel_query_graph (token-bounded) or panel_graph_outline",
    allowedIn: [
      {
        path: "src/orchestrator/panel-tools.ts",
        context: "replaces the old panel_get_graph full-JSON dump",
        why: "panel_query_graph's own description, saying what it replaced — accurate, and useful orientation for a model that saw the old name in training data.",
      },
      {
        path: "src/__tests__/orchestrator/panel-tools.test.ts",
        context: "Upstream replaced panel_get_graph",
        why: "Comment recording WHY the test asserts panel_query_graph. Deleting it would lose the rationale.",
      },
      {
        path: "docs/blog/panel-workflow-layout.mdx",
        context: "New panel tools: richer `panel_get_graph`",
        why: "A DATED post about the release that shipped this tool. Rewriting it to name a tool that did not exist yet would falsify the record, so the post carries a <Note> stating what replaced it. docs/blog is NOT blanket-historical: it is published and navigable, and treating it as an archive hid this exact line advertising a dead tool as new, with CI green.",
      },
      {
        path: "docs/blog/panel-workflow-layout.mdx",
        context: "The old `panel_get_graph` returned ids",
        why: "Same post, explicitly narrating the OLD behaviour in the past tense.",
      },
    ],
  },
  // ─────────────────────────────────────────────────────────────────────────
  // 0.50.0 slice 8: the eleven RunPod tools folded into TWO action-parameterized
  // tools — the pod LIFECYCLE + local⇄pod host switch into the new name `runpod`
  // (8 actions), and the live-status/diagnosis surface into the surviving
  // `runpod_watch` (3 actions). Same runpod-client / runpod-watch services, same
  // control-channel requests, same return shapes — only the surface changed, so
  // every mention of the old names is now rot pointing at a 404.
  //
  // Split rather than one twelve-action tool because the two halves have
  // different blast radii: `runpod` spends and saves real money and moves the
  // orchestrator's render target; `runpod_watch` only changes what is DISPLAYED.
  // The orchestrator's call_tool whitelist depends on that split — see
  // CALL_TOOL_ACTION_WHITELIST in src/orchestrator/call-tool-admission.ts, which
  // keeps action:"create"/"start" (the two BILLING actions) unreachable from a
  // canvas-less client exactly as their retired standalone names were.
  {
    name: "runpod_pod_create",
    since: "0.50.0",
    replacement: 'runpod (action:"create")',
  },
  {
    name: "runpod_pod_start",
    since: "0.50.0",
    replacement: 'runpod (action:"start")',
  },
  {
    name: "runpod_pod_stop",
    since: "0.50.0",
    replacement: 'runpod (action:"stop")',
  },
  {
    name: "runpod_pod_status",
    since: "0.50.0",
    replacement: 'runpod (action:"status")',
  },
  {
    name: "runpod_list_pods",
    since: "0.50.0",
    replacement: 'runpod (action:"list")',
  },
  {
    name: "runpod_pod_connect",
    since: "0.50.0",
    replacement: 'runpod (action:"connect")',
  },
  {
    name: "runpod_use_local",
    since: "0.50.0",
    replacement: 'runpod (action:"use_local")',
  },
  {
    name: "runpod_deploy_link",
    since: "0.50.0",
    replacement: 'runpod (action:"deploy_link")',
  },
  {
    name: "runpod_unwatch",
    since: "0.50.0",
    replacement: 'runpod_watch (action:"unwatch")',
  },
  {
    name: "runpod_pod_troubleshoot",
    since: "0.50.0",
    replacement: 'runpod_watch (action:"troubleshoot")',
  },
  // ── 0.50.0 slice 7 (warmup): process control, API nodes, defaults ──────────
  // Ten names folded into three action-parameterized tools. Same services, same
  // arguments, same return shapes — only the surface changed, so every mention
  // of a retired name is now rot pointing at a 404.
  //
  //   restart_comfyui ← start_comfyui, stop_comfyui
  //   list_api_nodes  ← get_api_node_schema, generate_with_api_node
  //   get_defaults    ← set_defaults, get_comfyui_settings, set_comfyui_setting
  //
  // The get_defaults fold spans TWO backing stores that must not be conflated:
  // action:"get"/"set" are the MCP server's own generation defaults, while
  // action:"get_ui"/"set_ui" are ComfyUI's separate frontend UI settings. The
  // replacements below therefore keep the `_ui` suffix visible — a caller sent
  // from set_comfyui_setting to action:"set" would silently write the wrong
  // store.
  {
    name: "start_comfyui",
    since: "0.50.0",
    replacement: 'restart_comfyui (action:"start")',
  },
  {
    name: "stop_comfyui",
    since: "0.50.0",
    replacement: 'restart_comfyui (action:"stop")',
  },
  {
    name: "get_api_node_schema",
    since: "0.50.0",
    replacement: 'list_api_nodes (action:"schema")',
  },
  {
    name: "generate_with_api_node",
    since: "0.50.0",
    replacement: 'list_api_nodes (action:"generate")',
  },
  {
    name: "set_defaults",
    since: "0.50.0",
    replacement: 'get_defaults (action:"set")',
  },
  {
    name: "get_comfyui_settings",
    since: "0.50.0",
    replacement: 'get_defaults (action:"get_ui")',
    allowedIn: [
      {
        path: "design/comfyui-settings-tools.md",
        context: "The read tool shipped as `get_comfyui_settings`",
        why: "The dated design spec for the PR that BUILT these two tools. Its superseded banner records the name each tool shipped under and maps it to today's action — the same mapping-away-from-the-name shape as the docs/using-tools.mdx migration table, never an instruction to call it. The banner's two mentions are on separate lines so each is a single occurrence bound to its own context.",
      },
    ],
  },
  {
    name: "set_comfyui_setting",
    since: "0.50.0",
    replacement: 'get_defaults (action:"set_ui")',
    allowedIn: [
      {
        path: "design/comfyui-settings-tools.md",
        context: "The write tool shipped as `set_comfyui_setting`",
        why: "Second line of the same superseded banner — see the get_comfyui_settings entry above.",
      },
    ],
  },
  // 0.50.0 slice 9: the nine knowledge tools — bundled skills, installer packs,
  // the connected server's workflow templates, and the two workflow-readiness
  // checks — folded into one action-parameterized `list_packs` tool. Same
  // enumeration/reading helpers, same api-nodes + workflow-deps + skill-cache
  // services, same return shapes (JSON for the listings, raw markdown/graph text
  // for the reads, the markdown report for the deps actions, and
  // generate_skill's `structuredContent`) — only the surface changed, so every
  // mention of the old names is now rot pointing at a 404.
  {
    name: "read_pack_workflow",
    since: "0.50.0",
    replacement: 'list_packs (action:"read_workflow")',
  },
  {
    name: "list_workflow_templates",
    since: "0.50.0",
    replacement: 'list_packs (action:"list_templates")',
  },
  {
    name: "check_workflow_runtime",
    since: "0.50.0",
    replacement: 'list_packs (action:"check_runtime")',
  },
  {
    name: "extract_workflow_dependencies",
    since: "0.50.0",
    replacement: 'list_packs (action:"extract_deps")',
  },
  {
    name: "install_workflow_dependencies",
    since: "0.50.0",
    replacement: 'list_packs (action:"install_deps")',
    allowedIn: [
      {
        path: "docs/using-tools.mdx",
        context: '| `install_workflow_dependencies` | `list_packs` with `action: "install_deps"` |',
        why: "The old-name → new-form migration table on the human-facing tools guide, same as the get_workspace/get_queue rows above. The left column must spell the retired name; it is a mapping AWAY from the name, never an instruction to call it.",
      },
      {
        path: "docs/ko/using-tools.mdx",
        context: '| `install_workflow_dependencies` | `list_packs` with `action: "install_deps"` |',
        why: "Same migration table as docs/using-tools.mdx, Korean translation. Cells stay English.",
      },
      {
        path: "docs/ja/using-tools.mdx",
        context: '| `install_workflow_dependencies` | `list_packs` with `action: "install_deps"` |',
        why: "Same migration table as docs/using-tools.mdx, Japanese translation. Cells stay English.",
      },
      {
        path: "docs/zh/using-tools.mdx",
        context: '| `install_workflow_dependencies` | `list_packs` with `action: "install_deps"` |',
        why: "Same migration table as docs/using-tools.mdx, Simplified Chinese translation. Cells stay English.",
      },
      {
        path: "docs/fr/using-tools.mdx",
        context: '| `install_workflow_dependencies` | `list_packs` with `action: "install_deps"` |',
        why: "Same migration table as docs/using-tools.mdx, French translation. Cells stay English.",
      },
      {
        path: "docs/es/using-tools.mdx",
        context: '| `install_workflow_dependencies` | `list_packs` with `action: "install_deps"` |',
        why: "Same migration table as docs/using-tools.mdx, es translation. Cells stay English.",
      },
      {
        path: "docs/zh-TW/using-tools.mdx",
        context: '| `install_workflow_dependencies` | `list_packs` with `action: "install_deps"` |',
        why: "Same migration table as docs/using-tools.mdx, zh-TW translation. Cells stay English.",
      },
      {
        path: "docs/ru/using-tools.mdx",
        context: '| `install_workflow_dependencies` | `list_packs` with `action: "install_deps"` |',
        why: "Same migration table as docs/using-tools.mdx, ru translation. Cells stay English.",
      },
      {
        path: "docs/ar/using-tools.mdx",
        context: '| `install_workflow_dependencies` | `list_packs` with `action: "install_deps"` |',
        why: "Same migration table as docs/using-tools.mdx, ar translation. Cells stay English.",
      },
      {
        path: "docs/pt-BR/using-tools.mdx",
        context: '| `install_workflow_dependencies` | `list_packs` with `action: "install_deps"` |',
        why: "Same migration table as docs/using-tools.mdx, pt-BR translation. Cells stay English.",
      },
      {
        path: "docs/tr/using-tools.mdx",
        context: '| `install_workflow_dependencies` | `list_packs` with `action: "install_deps"` |',
        why: "Same migration table as docs/using-tools.mdx, tr translation. Cells stay English.",
      },
    ],
  },
  {
    name: "list_skills",
    since: "0.50.0",
    // NOT action:"list_skills". An action may never be spelled the same as a
    // name the same fold retires: the dead-name gate matches the bare token, so
    // `list_packs (action:"list_skills")` — the very replacement text every
    // sweep would have to write — reads as a live reference to the dead tool and
    // can never go green. Same for read_skill → action:"skill_read" below.
    replacement: 'list_packs (action:"skill_list")',
  },
  {
    name: "read_skill",
    since: "0.50.0",
    replacement: 'list_packs (action:"skill_read")',
  },
  {
    name: "generate_node_skill",
    since: "0.50.0",
    replacement: 'list_packs (action:"generate_skill")',
  },
  // ── 0.50.0 slice 10: the eighteen train_* tools folded into three
  // action-parameterized tools, split by work-domain: `train_prepare_dataset`
  // owns the DATASETS, `train_start` owns the JOBS, `train_doctor` owns the
  // TRAINER ITSELF. Same training services, same envelope return shapes — only
  // the surface changed, so every mention of the old names is now rot pointing
  // at a 404.
  //
  // The two `delete` actions are deliberately keyed differently: `train_delete_job`
  // becomes train_start (action:"delete") keyed by `id`, while `train_dataset_delete`
  // becomes train_prepare_dataset (action:"delete") keyed by `name`. Both
  // replacements below spell the tool AND the key so a reader of the error can
  // never land on the wrong one.
  {
    name: "train_status",
    since: "0.50.0",
    replacement: 'train_start (action:"status")',
    allowedIn: [
      {
        path: "docs/blog/lora-trainer-p1.mdx",
        context: "5. **`train_status`** — poll it whenever.",
        why: "A DATED post announcing the train_* surface AS IT SHIPPED, narrating the seven-tool walkthrough of that release. The post carries a <Note> mapping every name in it to its 0.50.0 replacement, so a reader is never stranded; rewriting the walkthrough would falsify what the release contained.",
      },
      {
        path: "docs/blog/lora-trainer-p1.mdx",
        context: "(`train_status` and `train_list_flows` are whitelisted",
        why: "Same post, stating which tools the mobile call_tool path whitelisted AT THE TIME. That is a fact about the 0.31 admission list, not an instruction — and the fact survives the fold (see call-tool-admission.ts).",
      },
      {
        path: "docs/blog/lora-trainer-p1.mdx",
        context: "with its catalog entry. `train_status`",
        why: "Same post, the E2E receipts section: a past-tense record of what was observed on an RTX 4090 run of that exact code. Renaming the tool in a receipt would misreport the evidence.",
      },
      {
        path: "docs/blog/train-lora-runpod.mdx",
        context: "`train_status`, `train_cancel`, `train_list_flows` — backed by the",
        why: "A DATED sequel post listing the seven P1 tools it reuses unchanged on a pod. Same <Note> treatment as lora-trainer-p1; the list is a statement about the P1 surface, not a call sequence.",
      },
      {
        path: "docs/blog/train-lora-runpod.mdx",
        context: "- **`train_status`** streams step/loss/sample progress",
        why: "Same post, per-tool bullet describing the pod behaviour of that release's surface.",
      },
    ],
  },
  {
    name: "train_cancel",
    since: "0.50.0",
    replacement: 'train_start (action:"cancel")',
    allowedIn: [
      {
        path: "src/services/ai-toolkit.ts",
        context: 'cancel: "train_cancel",',
        why: "NOT a tool reference — the frozen envelope/1 `command` LABEL for the stop operation. TrainerEnvelope.command is a RETURN SHAPE that clients and tests key on, so slice 10 deliberately did not rename it; see TRAINER_COMMAND's doc comment. Hoisted to this one constant precisely so the string appears once, here, rather than at 13 call sites.",
      },
      {
        path: "docs/blog/lora-trainer-p1.mdx",
        context: "And if you change your mind: **`train_cancel`**",
        why: "Same dated P1 announcement post, introducing the section on verified cancellation. See the train_status entries above.",
      },
      {
        path: "docs/blog/lora-trainer-p1.mdx",
        context: "can't prove.** `train_cancel` issues a",
        why: "Same post, narrating the verify-before-reporting design of that release in the present tense of its publication date.",
      },
      {
        path: "docs/blog/train-lora-runpod.mdx",
        context: "`train_status`, `train_cancel`, `train_list_flows` — backed by the",
        why: "Same seven-tool list in the dated sequel post — see the train_status entry for this line.",
      },
      {
        path: "docs/blog/train-lora-runpod.mdx",
        context: "- **`train_cancel`** stops the remote trainer with `pkill`",
        why: "Same post, per-tool bullet describing the pod cancel path of that release's surface.",
      },
    ],
  },
  {
    name: "train_delete_job",
    since: "0.50.0",
    replacement: 'train_start (action:"delete") — the JOB delete, keyed by `id`',
  },
  {
    name: "train_list_flows",
    since: "0.50.0",
    replacement: 'train_start (action:"list_flows")',
    allowedIn: [
      {
        path: "docs/blog/lora-trainer-p1.mdx",
        context: "(`train_status` and `train_list_flows` are whitelisted",
        why: "Same dated P1 post line as the train_status entry above — a statement about the mobile call_tool whitelist at that release, not an instruction to call either name.",
      },
      {
        path: "docs/blog/train-lora-runpod.mdx",
        context: "`train_status`, `train_cancel`, `train_list_flows` — backed by the",
        why: "Same seven-tool list in the dated sequel post — see the train_status entry for this line.",
      },
    ],
  },
  {
    name: "train_job_config",
    since: "0.50.0",
    replacement: 'train_start (action:"job_config")',
  },
  {
    name: "train_preview_config",
    since: "0.50.0",
    replacement: 'train_start (action:"preview_config")',
  },
  {
    name: "train_list_datasets",
    since: "0.50.0",
    replacement: 'train_prepare_dataset (action:"list")',
  },
  {
    name: "train_dataset_detail",
    since: "0.50.0",
    replacement: 'train_prepare_dataset (action:"detail")',
  },
  {
    name: "train_dataset_update",
    since: "0.50.0",
    replacement: 'train_prepare_dataset (action:"update")',
  },
  {
    name: "train_dataset_delete",
    since: "0.50.0",
    replacement: 'train_prepare_dataset (action:"delete") — the DATASET delete, keyed by `name`',
  },
  {
    name: "train_file",
    since: "0.50.0",
    replacement: 'train_prepare_dataset (action:"file")',
  },
  {
    name: "train_caption_image",
    since: "0.50.0",
    replacement: 'train_prepare_dataset (action:"caption_image")',
  },
  {
    name: "train_caption_dataset",
    since: "0.50.0",
    replacement: 'train_prepare_dataset (action:"caption_dataset")',
  },
  {
    name: "train_bootstrap",
    since: "0.50.0",
    replacement: 'train_doctor (action:"bootstrap")',
    allowedIn: [
      {
        path: "src/services/ai-toolkit.ts",
        context: 'bootstrap: "train_bootstrap",',
        why: "NOT a tool reference — the frozen envelope/1 `command` LABEL for the native-toolkit bootstrap operation, a RETURN SHAPE slice 10 deliberately did not rename. See TRAINER_COMMAND's doc comment.",
      },
    ],
  },
  {
    name: "train_build_image",
    since: "0.50.0",
    replacement: 'train_doctor (action:"build_image")',
    allowedIn: [
      {
        path: "src/services/ai-toolkit.ts",
        context: 'buildImage: "train_build_image",',
        why: "NOT a tool reference — the frozen envelope/1 `command` LABEL for the image-build operation, a RETURN SHAPE slice 10 deliberately did not rename. See TRAINER_COMMAND's doc comment.",
      },
      {
        path: "docs/blog/lora-trainer-p1.mdx",
        context: "2. **`train_build_image`** — one-time, several minutes.",
        why: "Same dated P1 announcement post — step 2 of the seven-tool walkthrough as that release shipped it. The post's <Note> maps it to train_doctor (action:\"build_image\").",
      },
      {
        path: "docs/blog/train-lora-runpod.mdx",
        context: "`train_doctor`, `train_build_image`, `train_prepare_dataset`, `train_start`,",
        why: "Same seven-tool list in the dated sequel post; the other three names on this line survive the fold, so only this one needs the exemption.",
      },
    ],
  },
  // ── 0.50.0 slice 11: models ───────────────────────────────────────────────
  // The fourteen model tools folded into two action-parameterized survivors:
  // `download_model` (acquire) and `list_local_models` (inventory). Same
  // services, same return shapes, same error paths — only the surface changed,
  // so every mention of the eight retired names below is now rot pointing at a
  // 404. APPENDED at the end of the array, not prepended: concurrent slices all
  // edit this file and prepending makes every one of them collide on the same
  // three lines.
  {
    name: "search_models",
    since: "0.50.0",
    replacement: 'download_model (action:"search")',
    allowedIn: [
      {
        path: "docs/blog/comfyui-mcp-tdqs-case-study.mdx",
        context: "`search_models`, and the rest of the",
        why: "A DATED case study of a tool-description audit, naming the tools whose descriptions were rewritten AS THEY WERE NAMED when they were scored. Rewriting the name would falsify the record of what was measured — and the sentence is a past-tense result, not an instruction to call anything.",
      },
    ],
  },
  {
    name: "download_status",
    since: "0.50.0",
    replacement: 'download_model (action:"status")',
  },
  {
    name: "cancel_download",
    since: "0.50.0",
    replacement: 'download_model (action:"cancel")',
  },
  {
    name: "search_civitai_models",
    since: "0.50.0",
    replacement: 'download_model (action:"search_civitai")',
  },
  {
    name: "search_civitai_creators",
    since: "0.50.0",
    replacement: 'download_model (action:"search_creators")',
  },
  {
    name: "download_civitai_model",
    since: "0.50.0",
    replacement: 'download_model (action:"download_civitai")',
  },
  {
    name: "resolve_missing_models",
    since: "0.50.0",
    replacement: 'download_model (action:"resolve_missing")',
  },
  {
    name: "remove_model",
    since: "0.50.0",
    // The one destructive action in the slice: it unlinks a model FILE, with no
    // undo and no recycle bin. The replacement names the action explicitly so a
    // stale caller is redirected to the exact enum value rather than guessing at
    // `remove_path`, which edits a YAML config and deletes nothing.
    replacement: 'list_local_models (action:"remove")',
  },
  {
    name: "get_embeddings",
    since: "0.50.0",
    replacement: 'list_local_models (action:"embeddings")',
  },
  {
    name: "list_extra_paths",
    since: "0.50.0",
    replacement: 'list_local_models (action:"list_paths")',
  },
  {
    name: "add_extra_path",
    since: "0.50.0",
    replacement: 'list_local_models (action:"add_path")',
  },
  {
    name: "remove_extra_path",
    since: "0.50.0",
    replacement: 'list_local_models (action:"remove_path")',
  },
  // 0.50.0 slice 14: the twenty workflow-authoring and workflow-library tools
  // folded into four action-parameterized survivors — create_workflow (4),
  // visualize_workflow (5), get_workflow (8) and save_workflow (3). Same
  // composer/validator/converter/slicer/graph-query/lock services, same return
  // shapes; only the surface changed, so every mention of the old names is now
  // rot pointing at a 404.
  {
    name: "modify_workflow",
    since: "0.50.0",
    replacement: 'create_workflow (action:"modify")',
  },
  {
    name: "validate_workflow",
    since: "0.50.0",
    replacement: 'create_workflow (action:"validate")',
    allowedIn: [
      {
        path: "docs/using-tools.mdx",
        context: "| `validate_workflow` | `create_workflow` with `action: \"validate\"` |",
        why: "The old-name -> new-form migration table on the human-facing tools guide, the same row-per-retirement the get_workspace entry above documents. Readers watching the tool count fall read a consolidation as capability being REMOVED; the table exists to show the same behaviour under a new label, so the left column must spell the retired name. It is a mapping AWAY from the name, never an instruction to call it.",
      },
      {
        path: "docs/ko/using-tools.mdx",
        context: "| `validate_workflow` | `create_workflow` with `action: \"validate\"` |",
        why: "Same migration table as docs/using-tools.mdx, Korean translation. Cells stay English.",
      },
      {
        path: "docs/ja/using-tools.mdx",
        context: "| `validate_workflow` | `create_workflow` with `action: \"validate\"` |",
        why: "Same migration table as docs/using-tools.mdx, Japanese translation. Cells stay English.",
      },
      {
        path: "docs/zh/using-tools.mdx",
        context: "| `validate_workflow` | `create_workflow` with `action: \"validate\"` |",
        why: "Same migration table as docs/using-tools.mdx, Simplified Chinese translation. Cells stay English.",
      },
      {
        path: "docs/fr/using-tools.mdx",
        context: "| `validate_workflow` | `create_workflow` with `action: \"validate\"` |",
        why: "Same migration table as docs/using-tools.mdx, French translation. Cells stay English.",
      },
      {
        path: "docs/es/using-tools.mdx",
        context: "| `validate_workflow` | `create_workflow` with `action: \"validate\"` |",
        why: "Same migration table as docs/using-tools.mdx, es translation. Cells stay English.",
      },
      {
        path: "docs/zh-TW/using-tools.mdx",
        context: "| `validate_workflow` | `create_workflow` with `action: \"validate\"` |",
        why: "Same migration table as docs/using-tools.mdx, zh-TW translation. Cells stay English.",
      },
      {
        path: "docs/ru/using-tools.mdx",
        context: "| `validate_workflow` | `create_workflow` with `action: \"validate\"` |",
        why: "Same migration table as docs/using-tools.mdx, ru translation. Cells stay English.",
      },
      {
        path: "docs/ar/using-tools.mdx",
        context: "| `validate_workflow` | `create_workflow` with `action: \"validate\"` |",
        why: "Same migration table as docs/using-tools.mdx, ar translation. Cells stay English.",
      },
      {
        path: "docs/pt-BR/using-tools.mdx",
        context: "| `validate_workflow` | `create_workflow` with `action: \"validate\"` |",
        why: "Same migration table as docs/using-tools.mdx, pt-BR translation. Cells stay English.",
      },
      {
        path: "docs/tr/using-tools.mdx",
        context: "| `validate_workflow` | `create_workflow` with `action: \"validate\"` |",
        why: "Same migration table as docs/using-tools.mdx, tr translation. Cells stay English.",
      },
    ],
  },
  {
    name: "get_node_info",
    since: "0.50.0",
    replacement: 'create_workflow (action:"node_info")',
  },
  {
    name: "visualize_workflow_hierarchical",
    since: "0.50.0",
    replacement: 'visualize_workflow (action:"render_hierarchical")',
  },
  {
    name: "mermaid_to_workflow",
    since: "0.50.0",
    replacement: 'visualize_workflow (action:"mermaid")',
  },
  {
    name: "workflow_to_dsl",
    since: "0.50.0",
    replacement: 'visualize_workflow (action:"to_dsl")',
  },
  {
    name: "dsl_to_workflow",
    since: "0.50.0",
    replacement: 'visualize_workflow (action:"from_dsl")',
  },
  {
    name: "list_workflows",
    since: "0.50.0",
    replacement: 'get_workflow (action:"list")',
    allowedIn: [
      {
        path: "docs/using-tools.mdx",
        context: "| `list_workflows` | `get_workflow` with `action: \"list\"` |",
        why: "The old-name -> new-form migration table on the human-facing tools guide, the same row-per-retirement the get_workspace entry above documents. Readers watching the tool count fall read a consolidation as capability being REMOVED; the table exists to show the same behaviour under a new label, so the left column must spell the retired name. It is a mapping AWAY from the name, never an instruction to call it.",
      },
      {
        path: "docs/ko/using-tools.mdx",
        context: "| `list_workflows` | `get_workflow` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, Korean translation. Cells stay English.",
      },
      {
        path: "docs/ja/using-tools.mdx",
        context: "| `list_workflows` | `get_workflow` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, Japanese translation. Cells stay English.",
      },
      {
        path: "docs/zh/using-tools.mdx",
        context: "| `list_workflows` | `get_workflow` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, Simplified Chinese translation. Cells stay English.",
      },
      {
        path: "docs/fr/using-tools.mdx",
        context: "| `list_workflows` | `get_workflow` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, French translation. Cells stay English.",
      },
      {
        path: "docs/es/using-tools.mdx",
        context: "| `list_workflows` | `get_workflow` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, es translation. Cells stay English.",
      },
      {
        path: "docs/zh-TW/using-tools.mdx",
        context: "| `list_workflows` | `get_workflow` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, zh-TW translation. Cells stay English.",
      },
      {
        path: "docs/ru/using-tools.mdx",
        context: "| `list_workflows` | `get_workflow` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, ru translation. Cells stay English.",
      },
      {
        path: "docs/ar/using-tools.mdx",
        context: "| `list_workflows` | `get_workflow` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, ar translation. Cells stay English.",
      },
      {
        path: "docs/pt-BR/using-tools.mdx",
        context: "| `list_workflows` | `get_workflow` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, pt-BR translation. Cells stay English.",
      },
      {
        path: "docs/tr/using-tools.mdx",
        context: "| `list_workflows` | `get_workflow` with `action: \"list\"` |",
        why: "Same migration table as docs/using-tools.mdx, tr translation. Cells stay English.",
      },
    ],
  },
  {
    name: "strip_workflow",
    since: "0.50.0",
    replacement: 'get_workflow (action:"strip")',
  },
  {
    name: "slice_workflow",
    since: "0.50.0",
    replacement: 'get_workflow (action:"slice")',
  },
  {
    name: "workflow_from_image",
    since: "0.50.0",
    replacement: 'get_workflow (action:"from_image")',
  },
  {
    name: "analyze_workflow",
    since: "0.50.0",
    replacement: 'get_workflow (action:"analyze")',
    allowedIn: [
      {
        path: "docs/using-tools.mdx",
        context: "| `analyze_workflow` | `get_workflow` with `action: \"analyze\"` |",
        why: "The old-name -> new-form migration table on the human-facing tools guide, the same row-per-retirement the get_workspace entry above documents. Readers watching the tool count fall read a consolidation as capability being REMOVED; the table exists to show the same behaviour under a new label, so the left column must spell the retired name. It is a mapping AWAY from the name, never an instruction to call it.",
      },
      {
        path: "docs/ko/using-tools.mdx",
        context: "| `analyze_workflow` | `get_workflow` with `action: \"analyze\"` |",
        why: "Same migration table as docs/using-tools.mdx, Korean translation. Cells stay English.",
      },
      {
        path: "docs/ja/using-tools.mdx",
        context: "| `analyze_workflow` | `get_workflow` with `action: \"analyze\"` |",
        why: "Same migration table as docs/using-tools.mdx, Japanese translation. Cells stay English.",
      },
      {
        path: "docs/zh/using-tools.mdx",
        context: "| `analyze_workflow` | `get_workflow` with `action: \"analyze\"` |",
        why: "Same migration table as docs/using-tools.mdx, Simplified Chinese translation. Cells stay English.",
      },
      {
        path: "docs/fr/using-tools.mdx",
        context: "| `analyze_workflow` | `get_workflow` with `action: \"analyze\"` |",
        why: "Same migration table as docs/using-tools.mdx, French translation. Cells stay English.",
      },
      {
        path: "docs/es/using-tools.mdx",
        context: "| `analyze_workflow` | `get_workflow` with `action: \"analyze\"` |",
        why: "Same migration table as docs/using-tools.mdx, es translation. Cells stay English.",
      },
      {
        path: "docs/zh-TW/using-tools.mdx",
        context: "| `analyze_workflow` | `get_workflow` with `action: \"analyze\"` |",
        why: "Same migration table as docs/using-tools.mdx, zh-TW translation. Cells stay English.",
      },
      {
        path: "docs/ru/using-tools.mdx",
        context: "| `analyze_workflow` | `get_workflow` with `action: \"analyze\"` |",
        why: "Same migration table as docs/using-tools.mdx, ru translation. Cells stay English.",
      },
      {
        path: "docs/ar/using-tools.mdx",
        context: "| `analyze_workflow` | `get_workflow` with `action: \"analyze\"` |",
        why: "Same migration table as docs/using-tools.mdx, ar translation. Cells stay English.",
      },
      {
        path: "docs/pt-BR/using-tools.mdx",
        context: "| `analyze_workflow` | `get_workflow` with `action: \"analyze\"` |",
        why: "Same migration table as docs/using-tools.mdx, pt-BR translation. Cells stay English.",
      },
      {
        path: "docs/tr/using-tools.mdx",
        context: "| `analyze_workflow` | `get_workflow` with `action: \"analyze\"` |",
        why: "Same migration table as docs/using-tools.mdx, tr translation. Cells stay English.",
      },
    ],
  },
  {
    name: "query_workflow",
    since: "0.50.0",
    replacement: 'get_workflow (action:"query")',
  },
  {
    name: "prompt_director_inspect",
    since: "0.50.0",
    replacement: 'get_workflow (action:"prompt_director")',
  },
  {
    name: "lock_workflow",
    since: "0.50.0",
    replacement: 'save_workflow (action:"lock")',
  },
  {
    name: "verify_workflow_lock",
    since: "0.50.0",
    replacement: 'save_workflow (action:"verify_lock")',
  },
  // ─────────────────────────────────────────────────────────────────────────
  // 0.50.0 slice 12: the twenty custom-node tools folded into THREE
  // action-parameterized tools — the pack LIFECYCLE into the surviving
  // `install_custom_node` (9 actions), the public-registry DISCOVERY pair into
  // the surviving `search_custom_nodes` (2 actions), and the AUTHOR loop into
  // the new name `node_pack` (9 actions). Same node-management / registry-client
  // / node-authoring / node-verify / node-dev services, same panel-pin redirects,
  // same return shapes — only the surface changed, so every mention of a RETIRED
  // name is now rot pointing at a 404. (`search_custom_nodes` is NOT retired: it
  // survives as the discovery tool and absorbs get_node_pack_details.)
  //
  // Three tools rather than one grab-bag because the thirds have different blast
  // radii, and the NAME is the unit that the call_tool whitelist and the ollama
  // loop-breaker both reason about:
  //   • install_custom_node runs third-party pack code and mutates what is
  //     installed. See CALL_TOOL_ACTION_WHITELIST in
  //     src/orchestrator/call-tool-admission.ts, which keeps it reachable from a
  //     canvas-less client for exactly the two actions its retired standalone
  //     entries covered (install + list) and leaves uninstall/update/reinstall/
  //     fix unreachable.
  //   • search_custom_nodes is read-only and network-only — no ComfyUI, no
  //     COMFYUI_PATH. Never whitelisted before, so it is not whitelisted now.
  //   • node_pack reads and WRITES your own source on disk and runs git in it.
  //     Not whitelisted at all.
  {
    name: "update_custom_node",
    since: "0.50.0",
    replacement: 'install_custom_node (action:"update")',
  },
  {
    name: "reinstall_custom_node",
    since: "0.50.0",
    replacement: 'install_custom_node (action:"reinstall")',
  },
  {
    name: "fix_custom_node",
    since: "0.50.0",
    replacement: 'install_custom_node (action:"fix")',
  },
  {
    name: "uninstall_custom_node",
    since: "0.50.0",
    replacement: 'install_custom_node (action:"uninstall")',
  },
  {
    name: "enable_custom_node",
    since: "0.50.0",
    replacement: 'install_custom_node (action:"enable")',
  },
  {
    name: "disable_custom_node",
    since: "0.50.0",
    replacement: 'install_custom_node (action:"disable")',
  },
  {
    name: "list_installed_nodes",
    since: "0.50.0",
    replacement: 'install_custom_node (action:"list")',
  },
  {
    name: "sync_node_dependencies",
    since: "0.50.0",
    replacement: 'install_custom_node (action:"sync_deps")',
  },
  {
    name: "get_node_pack_details",
    since: "0.50.0",
    replacement: 'search_custom_nodes (action:"details")',
  },
  {
    name: "scaffold_custom_node",
    since: "0.50.0",
    replacement: 'node_pack (action:"scaffold")',
  },
  {
    name: "verify_custom_node",
    since: "0.50.0",
    replacement: 'node_pack (action:"verify")',
  },
  {
    name: "publish_custom_node",
    since: "0.50.0",
    replacement: 'node_pack (action:"publish")',
  },
  {
    name: "list_node_pack_files",
    since: "0.50.0",
    replacement: 'node_pack (action:"list_files")',
  },
  {
    name: "read_node_file",
    since: "0.50.0",
    replacement: 'node_pack (action:"read")',
  },
  {
    name: "search_node_packs",
    since: "0.50.0",
    replacement: 'node_pack (action:"search")',
  },
  {
    name: "write_node_file",
    since: "0.50.0",
    replacement: 'node_pack (action:"write")',
  },
  {
    name: "apply_node_patch",
    since: "0.50.0",
    replacement: 'node_pack (action:"patch")',
  },
  // node_pack_git's own `action` parameter is the one argument this whole
  // consolidation could not preserve — it collided with the tool's dispatch
  // field — so the replacement names BOTH levels, or a caller rewriting
  // `node_pack_git(pack, action:"commit")` would silently produce
  // `node_pack(action:"commit")`, which is not an action at all.
  //
  // The comment sits ABOVE the entry rather than inside it on purpose: a
  // leading comment between `{` and `name:` hides the entry from every
  // name-extracting scanner that anchors on `^  \{\n    name:` — including the
  // ratchet verifier — so an entry that IS in the ledger reads as missing.
  {
    name: "node_pack_git",
    since: "0.50.0",
    replacement: 'node_pack (action:"git", git_action:"status"|"diff"|"log"|"commit"|"push")',
  },
  // 0.50.0 slice 15: the twelve image/asset tools folded into TWO
  // action-parameterized tools, both of them SURVIVORS keeping their
  // registration slots — the READ/INSPECT half onto `get_image` (7 actions)
  // and the WRITE half onto `upload_image` (5 actions). Same
  // image-management / view-image / image-convert / color-analysis /
  // asset-registry / storage-upload services, same arguments, same return
  // shapes (inline image blocks, the markdown/json listings, the upload
  // prose) — only the surface changed, so every mention of the old names is
  // now rot pointing at a 404.
  //
  // Split by DIRECTION OF TRAVEL rather than into one twelve-action tool:
  // everything on `get_image` reads (its one write is saving bytes it just
  // fetched to the caller's own save_dir), while every action on
  // `upload_image` puts a file somewhere — ComfyUI's input/ directory or a
  // cloud bucket. The orchestrator's call_tool whitelist depends on that
  // split: `get_image` was whitelisted (as was `list_output_images`) and is
  // now ACTION-scoped to exactly those two actions — see
  // CALL_TOOL_ACTION_WHITELIST in src/orchestrator/call-tool-admission.ts —
  // while `upload_image` was never whitelisted and still is not.
  {
    name: "view_image",
    since: "0.50.0",
    replacement: 'get_image (action:"view")',
    allowedIn: [
      {
        path: "docs/blog/blind-mode-privacy.mdx",
        context: "but get_image and view_image fetched them straight from ComfyUI's /view anyway",
        why: "A DATED post about the v0.42.0 Blind-mode fix, narrating the two tools that leaked pixels AT THAT TIME. Rewriting it to the folded form would make the sentence read 'get_image and get_image (action:\"view\")' — a false account of what the bug was, in a frontmatter description that is also a double-quoted YAML string the replacement's quotes would break.",
      },
      {
        path: "docs/blog/blind-mode-privacy.mdx",
        context: "(`get_image`, `view_image`) fetch bytes straight from ComfyUI's HTTP `/view`",
        why: "Same post, body: the pair of tools the reporter proved were leaking. Same collapse into 'get_image, get_image' if rewritten.",
      },
      {
        path: "docs/blog/blind-mode-privacy.mdx",
        context: "`get_image`, then to `view_image`, then remember `convert_image` returns",
        why: "Same post, listing the tools a whack-a-mole per-tool fix would have had to chase — the point being that the list is open-ended. It is an argument about the past, not an instruction to call anything.",
      },
    ],
  },
  {
    name: "list_output_images",
    since: "0.50.0",
    replacement: 'get_image (action:"list_outputs")',
  },
  {
    name: "convert_image",
    since: "0.50.0",
    replacement: 'get_image (action:"convert")',
    allowedIn: [
      {
        path: "docs/blog/blind-mode-privacy.mdx",
        context: "then remember `convert_image` returns",
        why: "Same dated Blind-mode post as view_image above — the third name in the open-ended list of image-returning tools a per-tool fix would have had to chase, written in the past tense about v0.42.0.",
      },
    ],
  },
  {
    name: "analyze_color",
    since: "0.50.0",
    replacement: 'get_image (action:"analyze_color")',
    // The fold reused the retired TOOL name as its ACTION name, so the tool
    // that implements it necessarily spells the bare token twice: as a member
    // of get_image's action enum, and as the `case` label that dispatches it.
    // Rule (c) licenses exactly that one structural form — a complete quoted
    // literal whose whole content is the name — in these two files, and
    // nothing else: a live `call analyze_color` sentence in either of them is
    // still reported, which is why this is not a SELF entry.
    implementedIn: ["src/tools/image-management.ts"],
  },
  {
    name: "list_assets",
    since: "0.50.0",
    replacement: 'get_image (action:"list_assets")',
    // Same collision as analyze_color above, same two structural forms, same
    // two files. See that entry for why this is implementedIn and not SELF.
    implementedIn: ["src/tools/image-management.ts"],
  },
  {
    name: "get_asset_metadata",
    since: "0.50.0",
    replacement: 'get_image (action:"asset_metadata")',
  },
  {
    name: "upload_video",
    since: "0.50.0",
    replacement: 'upload_image (action:"video")',
  },
  {
    name: "upload_audio",
    since: "0.50.0",
    replacement: 'upload_image (action:"audio")',
  },
  {
    name: "upload_output",
    since: "0.50.0",
    replacement: 'upload_image (action:"output")',
  },
  {
    name: "stage_output_as_input",
    since: "0.50.0",
    replacement: 'upload_image (action:"stage")',
  },
  // ─────────────────────────────────────────────────────────────────────────
  // 0.50.0 slice 16 (the FINAL slice): eighteen execution / generation /
  // observability names folded into the THREE survivors models reach for first
  // — `enqueue_workflow` (5 actions), `generate_image` (9) and `get_history`
  // (4). Same workflow-executor / generate-* / tracker / history services, same
  // arguments, same return shapes — only the surface changed, so every mention
  // of the old names is now rot pointing at a 404.
  //
  // `enqueue_workflow` REMAINS A NAMED ENTRY POINT: its four satellite entry
  // points fold INTO it and it is never itself subsumed. Its call_tool
  // admission is ACTION-scoped to exactly ["enqueue"] — see
  // CALL_TOOL_ACTION_WHITELIST in src/orchestrator/call-tool-admission.ts,
  // where action:"run_url" (fetch a workflow from an ARBITRARY URL and execute
  // it) must stay unreachable from a canvas-less client. `get_history` is ADDED
  // to that whitelist, action-scoped to ["diagnose"], because the retired
  // `diagnose_run` was whitelisted and the panel's "why did my render fail?"
  // would otherwise break with a false refusal.
  {
    name: "rerun_generation",
    since: "0.50.0",
    replacement: 'enqueue_workflow (action:"rerun")',
  },
  {
    name: "run_workflow_url",
    since: "0.50.0",
    replacement: 'enqueue_workflow (action:"run_url")',
  },
  {
    name: "get_template_schema",
    since: "0.50.0",
    replacement: 'enqueue_workflow (action:"template_schema")',
  },
  {
    name: "run_template",
    since: "0.50.0",
    replacement: 'enqueue_workflow (action:"run_template")',
    implementedIn: [
      "src/tools/workflow-execute.ts",
      "src/__tests__/tools/workflow-execute.test.ts",
    ],
  },
  {
    name: "generate_audio",
    since: "0.50.0",
    replacement: 'generate_image (action:"audio")',
    allowedIn: [
      {
        path: "src/__tests__/services/nested-seed-without-phantom.test.ts",
        context: "//   generate_audio    true       \"default\"",
        why: "NOT our retired tool — a homonym in a different namespace. This is a WIDGET name on a third-party ComfyUI node (TongzeArkReferenceToVideo), quoted from #1334's measured wrong output to record which value landed in which slot. The gate cannot know the namespace, so the collision is declared here rather than worked around: renaming the widget would make the fixture stop reproducing the reporter's row, which is the only thing that makes the regression provable. Pinned to the measured-output line because that is the part that must not be paraphrased.",
      },
      {
        path: "src/__tests__/services/nested-seed-without-phantom.test.ts",
        context: "generate_audio: [\"BOOLEAN\", { default: true }],",
        why: "The same third-party node's object_info spec, reproduced verbatim so the nested widget ORDER matches the reporter's. Order is the entire subject of #1334 — a shifted slot is the defect — so the fixture must carry their names in their positions, not stand-ins.",
      },
      {
        path: "src/__tests__/services/nested-seed-without-phantom.test.ts",
        context: "expect(inputs[\"model.generate_audio\"]).toBe(true);",
        why: "The assertion on that same widget's converted value. It reads `model.generate_audio` because that is the dotted key the converter emits for the nested leaf; asserting on a renamed key would assert on something the reporter's workflow does not contain.",
      },
    ],
  },
  {
    name: "generate_video",
    since: "0.50.0",
    replacement: 'generate_image (action:"video")',
  },
  {
    name: "generate_3d",
    since: "0.50.0",
    replacement: 'generate_image (action:"3d")',
  },
  {
    name: "generate_with_controlnet",
    since: "0.50.0",
    replacement: 'generate_image (action:"controlnet")',
  },
  {
    name: "generate_with_ip_adapter",
    since: "0.50.0",
    replacement: 'generate_image (action:"ip_adapter")',
  },
  // The highest-traffic retirement in the consolidation (19 live mentions), and
  // the one whose name is ALSO an ordinary English verb. Most of the exemptions
  // below are therefore NOT "history" in the usual sense — they are prose where
  // "regenerate" is a verb about rebuilding a file or re-synthesising image
  // detail, and has nothing to do with any tool. Rewriting correct prose to
  // dodge a name collision is the failure mode the per-occurrence mechanism
  // exists to prevent, so each one is listed, read, and reasoned about here.
  {
    name: "regenerate",
    since: "0.50.0",
    replacement: 'generate_image (action:"regenerate")',
    // The tool that answers for this name, and the two files that drive it under
    // test — the only places a bare "regenerate" literal is the action vocabulary
    // rather than a tool name.
    implementedIn: [
      "src/tools/generate-image.ts",
      "src/__tests__/tools/generate-image.test.ts",
    ],
    allowedIn: [
      {
        path: "docs/blog/flatten-workflows.mdx",
        context: "then regenerate a UI graph from it and",
        why: "The ENGLISH VERB, in a dated post narrating an algorithm: rebuild a UI-format graph from an API-format one. Nothing to do with any tool. Rewriting published prose to dodge a name collision is exactly the 'fix' the per-occurrence mechanism exists to prevent.",
      },
      {
        path: "docs/blog/flatten-workflows.mdx",
        context: "regenerate positions wholesale, every group on the canvas becomes an empty box",
        why: "Same post, same English verb — recomputing node POSITIONS, in the sentence that explains why litegraph groups break when you do.",
      },
      {
        path: "docs/blog/video-upscale-comfyui.mdx",
        context: "FlashVSR *regenerate* detail.",
        why: "The English verb, and load-bearing technical vocabulary: a restorer model literally re-generates image detail rather than magnifying it. No synonym says this as precisely, and the post is dated.",
      },
      {
        path: "docs/blog/video-upscale-comfyui.mdx",
        context: "**Why downscale before upscaling?** Restorers regenerate detail.",
        why: "Same post, same claim in the body copy.",
      },
      {
        path: "plugin/skills/video-upscale/SKILL.md",
        context: "(and FlashVSR) regenerate detail. Feeding them a small frame forces the model",
        why: "The same technical claim in the bundled skill the post documents. Model-facing, but it is describing what an UPSCALER MODEL does to pixels — it is not an instruction to call a tool.",
      },
      {
        path: "packs/z-image-base-inpaint/pack.yaml",
        context: "an input image and regenerate only the masked area from a text prompt",
        why: "The English verb in a pack DESCRIPTION of inpainting — regenerating the masked region is literally what the pack does. packs/*/workflow.json is path-exempt as data, but pack.yaml is prose, so this occurrence is exempted on its own.",
      },
    ],
  },
  {
    name: "upscale_image",
    since: "0.50.0",
    replacement: 'generate_image (action:"upscale")',
    allowedIn: [
      {
        path: "src/__tests__/tools/generate-image.test.ts",
        context: 'expect(schema.action.safeParse("upscale_image").success).toBe(false)',
        why: "A deliberate NEGATIVE fixture: the action is `upscale`, so the RETIRED tool name must be rejected by the enum. `implementedIn` cannot license it — that rule only covers a name the fold reused AS an action, and this one it did not. The assertion is that nothing serves this name.",
      },
      {
        path: "src/__tests__/tools/generate-image.test.ts",
        context: 'const res = await handler({ action: "upscale_image" });',
        why: "The same fixture one layer down: the unknown-action branch must reject it at runtime too, not merely at the schema. A call argument under test.",
      },
    ],
  },
  {
    name: "remove_background",
    since: "0.50.0",
    replacement: 'generate_image (action:"remove_background")',
    implementedIn: [
      "src/tools/generate-image.ts",
      "src/__tests__/tools/generate-image.test.ts",
    ],
    allowedIn: [
      {
        path: "src/services/workflow-composer.ts",
        context: "remove_background: (p) => buildRemoveBackground(",
        why: "A create_workflow TEMPLATE KEY in the builder registry, not a tool name. It happens to be spelled the same because both name the same operation. Renaming it would change a service (the key is part of create_workflow's public template enum), which a pure surface consolidation must not do.",
      },
      {
        path: "src/services/remove-background.ts",
        context: 'const workflow = createWorkflow("remove_background", {',
        why: "The call site of that same template key — the service asking the composer for the cutout graph.",
      },
      {
        path: "docs/tools/workflow-authoring.mdx",
        // Trimmed to the template-key run itself. It used to carry the trailing prose
        // ("). Pure local generation"), which broke the moment the description stopped
        // hand-listing four templates and started interpolating all ten from
        // TEMPLATE_NAMES — an exception keyed to wording that is not the part being excused.
        context: "stable_audio_3, remove_background, ltx_video",
        why: "GENERATED from create_workflow's description, which lists the template keys above. Fixing it at the source would mean renaming the template.",
      },
      {
        path: "docs/tools/workflow-authoring.mdx",
        context: "`stable_audio_3`, `remove_background`, `ltx_video`.",
        why: "Generated from the same template enum, rendered as the parameter's option list.",
      },
    ],
  },
  {
    name: "generation_stats",
    since: "0.50.0",
    replacement: 'get_history (action:"stats")',
  },
  {
    name: "suggest_settings",
    since: "0.50.0",
    replacement: 'get_history (action:"suggest")',
  },
  {
    name: "diagnose_run",
    since: "0.50.0",
    replacement: 'get_history (action:"diagnose")',
  },
  // ─────────────────────────────────────────────────────────────────────────
  // 0.50.0 slice 13: the install/environment and stats/diagnostics families
  // folded into TWO action-parameterized tools — the mutating install surface
  // (ComfyUI core, every custom node pack, the sidebar panel, this npm package,
  // Manager settings) plus the environment read into the surviving
  // `install_comfyui` (7 actions), and the connected server's READS into the
  // surviving `get_system_stats` (3 actions). Same services, same arguments,
  // same return shapes — only the surface changed, so every mention of the old
  // names is now rot pointing at a 404.
  //
  // FOUR names the slice originally folded are NOT here, because review took
  // the RFC's documented fallback and left them STANDALONE: `apply_manifest`
  // (the most-referenced name on the surface, and nearly all of those mentions
  // are one-line install instructions), `clear_vram` (the OOM panic button,
  // which belongs at one call's reach), `report_issue` (it FILES A PUBLIC
  // GITHUB ISSUE and had no business on a tool named "get system stats") and
  // `calculate` (a pure offline utility with nothing to do with server state).
  // They are unchanged on the live surface and retire nothing.
  //
  // THREE of the folded tools had an `action` parameter of their own, which a
  // flat schema cannot host twice: install_panel's became `panel_action`,
  // self_update's `self_update_action`, and configure_manager's
  // `manager_setting`. The enum VALUES and their defaults are unchanged, so a
  // caller translating `install_panel(action='sync')` writes
  // `install_comfyui(action:"panel", panel_action:"sync")`.
  {
    name: "update_comfyui",
    since: "0.50.0",
    replacement: 'install_comfyui (action:"update")',
    allowedIn: [
      {
        path: "src/services/manager-config.ts",
        context: "compared server-side (manager_server.py update_comfyui)",
        why: "Names ComfyUI-Manager's OWN Python handler (manager_server.py's update_comfyui route), which is upstream code this repo does not own and cannot rename. It is not, and never was, a reference to our tool.",
      },
    ],
  },
  {
    name: "update_all",
    since: "0.50.0",
    replacement: 'install_comfyui (action:"update_all")',
    // Rule (c): this name is spelled exactly like its own ACTION, so the module
    // that DEFINES the enum necessarily contains it as a quoted literal — an enum
    // member and a case label. Licensed there and nowhere else.
    implementedIn: ["src/tools/install-comfyui.ts"],
    // NOTE for reviewers: `update_all` is ALSO the name of ComfyUI-Manager's own
    // bulk-update operation and the tail of its HTTP route
    // (/manager/queue/update_all). About 120 of the ~134 in-repo occurrences
    // were that UPSTREAM operation, not our tool. Exempting them one by one
    // would have meant ~120 ledger entries; exempting them by file would have
    // been the whole-file exemption this ledger exists to avoid. They were
    // instead respelled in prose as "update-all" — a hyphen, so not a tool-name
    // token, and already the spelling the pending-op ledger uses for the op
    // kind — leaving the literal `update_all` only where it IS the upstream
    // route string.
    allowedIn: [
      // ONE context per file, and it is the upstream ROUTE PATH — which is what
      // keeps these narrow rather than whole-file: only a line containing
      // "/manager/queue/update_all" is exempt, and the v4 route
      // "/v2/manager/queue/update_all" contains it as a substring, so one entry
      // covers both dialects. A live instruction to call the retired TOOL,
      // added to any of these files later, still fails the gate.
      {
        path: "src/services/node-management.ts",
        context: "/manager/queue/update_all",
        why: "ComfyUI-Manager's own HTTP route, which this code POSTs to and its comments enumerate by path. Upstream API surface we cannot rename — rewriting it would break the request.",
      },
      {
        path: "src/services/node-management.ts",
        context: "endpoint: `${prefix}/update_all`",
        why: "Builds that same upstream route path to report back as `endpoint`. A URL segment, not a tool name.",
      },
      {
        path: "src/services/update-comfyui.ts",
        context: "/manager/queue/update_all",
        why: "A comment naming the two upstream Manager routes (legacy 3.x and v4) by their exact paths, which is the whole point of the line.",
      },
      {
        path: "src/__tests__/services/update-comfyui.test.ts",
        context: "/manager/queue/update_all",
        why: "The tests pin WHICH upstream route the enqueue uses per Manager dialect (#656). The literal path is the assertion.",
      },
      {
        path: "src/__tests__/services/manager-dialect-cache.test.ts",
        context: "/manager/queue/update_all",
        why: "Same: the dialect-cache tests stub and count calls to the upstream route by path.",
      },
      {
        path: "src/__tests__/services/node-management.test.ts",
        context: "/manager/queue/update_all",
        why: "Same: asserts the 'all' id routes to the upstream v4 route with query params rather than a body.",
      },
      {
        path: "src/__tests__/services/panel-pin-cancel.test.ts",
        context: "/manager/queue/update_all",
        why: "Same: the Manager persona stubs match on the upstream route path.",
      },
    ],
  },
  {
    name: "install_panel",
    since: "0.50.0",
    replacement: 'install_comfyui (action:"panel")',
  },
  {
    name: "self_update",
    since: "0.50.0",
    replacement: 'install_comfyui (action:"self_update")',
    // Rule (c): this name is spelled exactly like its own ACTION, so the module
    // that DEFINES the enum necessarily contains it as a quoted literal — an enum
    // member and a case label. Licensed there and nowhere else.
    implementedIn: ["src/tools/install-comfyui.ts"],
  },
  {
    name: "get_environment",
    since: "0.50.0",
    replacement: 'install_comfyui (action:"environment")',
  },
  {
    name: "configure_manager",
    since: "0.50.0",
    replacement: 'install_comfyui (action:"configure_manager")',
    // Rule (c): this name is spelled exactly like its own ACTION, so the module
    // that DEFINES the enum necessarily contains it as a quoted literal — an enum
    // member and a case label. Licensed there and nowhere else.
    implementedIn: ["src/tools/install-comfyui.ts"],
  },
  {
    name: "get_logs",
    since: "0.50.0",
    replacement: 'get_system_stats (action:"logs")',
  },
  {
    name: "health_check",
    since: "0.50.0",
    replacement: 'get_system_stats (action:"health")',
  },
];

/**
 * deadNameRe's contract anchored to the WHOLE string — it answers "is this
 * exact name retired?", the question call_tool has to answer when a client
 * invokes a name that no longer exists (#659), where deadNameRe answers "does
 * this prose mention one?".
 *
 * The `mcp__<server>__` prefix rides along because that is the form names take
 * in MCP clients that namespace tools, so `apps_list` and
 * `mcp__comfyui__apps_list` resolve to the same entry. Anchoring is the safety
 * property: a merely-similar name (`apps_list_v2`, `my_apps_list`) returns
 * undefined and falls through to the fuzzy unknown-tool path, so a ledger entry
 * can never shadow the suggestions for a partial name.
 */
export function findDeadName(name: string): DeadName | undefined {
  return DEAD_NAMES.find((d) => {
    const escaped = d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^(?:mcp__[A-Za-z0-9_]+__)?${escaped}$`).test(name);
  });
}

/**
 * The error a caller gets for invoking a RETIRED name: which version removed it
 * and what to call instead, straight from the ledger — turning every
 * consolidation from a silent break into a self-explaining one (#659). Undefined
 * for names the ledger does not know, so callers fall through to their ordinary
 * unknown-tool handling.
 *
 * `since` is usually a bare version ("0.49.0") but the pre-baseline entries carry
 * a clause ("removed upstream before 0.48.0"), so only the version form is
 * conjugated — "removed in ${since}" would mangle the clause into "removed in
 * removed upstream before 0.48.0".
 */
export function retiredToolMessage(name: string): string | undefined {
  const dead = findDeadName(name);
  if (!dead) return undefined;
  const removed = dead.since.startsWith("removed") ? dead.since : `removed in ${dead.since}`;
  return (
    `Unknown tool '${name}' — ${removed}. Call ${dead.replacement} instead.` +
    // #996 — the redirect answered WHAT to call and never WHY the caller was
    // holding a name that does not exist. A reporter saw list_tools advertise
    // read_skill and describe_tool succeed on it, then got this error, and
    // filed a catalog/dispatcher mismatch. The catalog is built by re-running
    // the SAME registration pass, so it cannot contain a retired name — what
    // they were reading was a tool list captured BEFORE the upgrade and cached
    // by the client (MCP clients hold tools/list until told otherwise).
    //
    // Without this sentence the only reading available is "the server is
    // inconsistent", which is both wrong and unactionable. One line converts it
    // into a stale-cache diagnosis with a remedy — the same job the rest of this
    // message already does for the name itself.
    ` If your tool list still shows '${name}', it was captured before this server` +
    ` was upgraded: reconnect the MCP client (/mcp) to pick up the current` +
    ` surface. The catalog this server serves cannot contain a retired name.`
  );
}

/**
 * The identity of the TOOL VOCABULARY, as a hash — the primitive the panel
 * handshake compares (#683 follow-up).
 *
 * ## Why this exists
 *
 * The panel calls these names as bare string literals from browser JS and vendors
 * a generated copy of this vocabulary to validate them against. Nothing checks
 * that its copy still matches the server it is talking to. `vocab:export --check`
 * proves the artefact matches THIS repo's ledger; the panel's own gate verifies
 * its vendored file against its own contents. Both are self-consistency checks,
 * and neither can see across the repo boundary.
 *
 * That gap has now cost twice, in both directions. Panel #683: the panel sat at
 * 145 tools while core had finished at 37, and the whole Training tab called
 * names that no longer existed. The mirror case is just as real — a rig running
 * an updated panel against a not-yet-updated server, where the panel calls the
 * consolidated names and the server only answers the old ones. Either way the
 * failure surfaces at CALL time as "unknown tool", which reads to a user as "the
 * panel is broken" and gives an agent nothing to act on.
 *
 * A version string cannot close this: two builds of the same version can carry
 * different vocabularies, and two different versions can carry identical ones.
 * Hashing the vocabulary itself is stable across releases and changes exactly
 * when the thing it identifies changes.
 *
 * ## What it deliberately does NOT cover
 *
 * Names only. Schemas, descriptions, annotations and handlers can all change
 * while every name stays identical, and this will read as a match — the same
 * scope `vocab:export` documents for the artefact. It answers "do we agree on
 * what exists", not "do we agree on what it does".
 *
 * MUST stay byte-identical to the artefact's `vocabularyHash`, so
 * scripts/export-vocabulary.mts calls THIS function rather than repeating the
 * expression. Two copies of a hash rule drift, and a handshake that compares a
 * drifted hash reports a mismatch that is not real — worse than no check.
 */
/**
 * The hash of THIS server's vocabulary — the value the panel handshake compares
 * against (#236).
 *
 * The panel tool names arrive as an argument rather than being imported, and that
 * is load-bearing: `buildPanelToolDefs` lives in orchestrator/panel-tools.ts, which
 * imports ui-bridge, which would make importing it here a cycle. Passing them in
 * keeps this module free of the orchestrator entirely.
 *
 * ## Why the ASSEMBLY lives here and not at each call site
 *
 * `computeVocabularyHash` hashes whatever it is handed; deciding WHAT to hand it —
 * core names, panel names SORTED, dead names — is a second rule, and it was
 * previously written out only in scripts/export-vocabulary.mts. A runtime check
 * that assembled its own copy would agree with the artefact right up until one of
 * the two changed, and then report a mismatch that is not real. The doc on
 * `computeVocabularyHash` says two copies of the hash rule must not exist; this is
 * the same argument applied to its input, which is just as capable of drifting.
 *
 * So the exporter calls this too, and `vocabulary-handshake.test.ts` asserts the
 * value it produces from the live panel defs equals the artefact's own
 * `vocabularyHash` — the only check that can actually catch drift between them.
 */
export function assembleVocabularyHash(panelToolNames: readonly string[]): string {
  return computeVocabularyHash({
    core: [...TOOL_NAMES],
    panel: [...panelToolNames].sort(),
    dead: DEAD_NAMES.map((d) => d.name),
  });
}

export function computeVocabularyHash(input: {
  core: readonly string[];
  panel: readonly string[];
  dead: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        core: [...input.core],
        panel: [...input.panel],
        dead: [...input.dead],
      }),
    )
    .digest("hex");
}

/** What a vocabulary comparison concluded. `unknown` is a first-class outcome. */
export type VocabularySkew =
  | { status: "match" }
  /** The panel did not advertise a hash at all — an older build. NOT a mismatch. */
  | { status: "unknown"; reason: string }
  | { status: "mismatch"; message: string };

/**
 * Compare the server's vocabulary against the one the panel vendored.
 *
 * ## The one rule that matters here
 *
 * A panel that sends NO hash is `unknown`, never `mismatch`. Older panels do not
 * advertise one, and "it did not tell us" is not "it disagrees" — folding those
 * together would fire a scary, actionable-sounding warning at every user on an
 * older panel whose vocabulary is very likely fine. That is the same
 * could-not-determine-reported-as-determined defect this function exists to catch
 * in the tool surface, and it would be embarrassing to commit it here.
 *
 * ## Why the message does not name which side is stale
 *
 * It cannot, and guessing would be worse than not saying. Both sides are opaque
 * digests; there is no ordering between two hashes and no history to rank them
 * against. The server knows only that they differ. So the message states exactly
 * that, and gives the one remedy that is correct in both directions — bring both
 * to the same release — rather than a 50/50 guess that sends half of users to
 * update the component that was already current.
 */
export function describeVocabularySkew(
  serverHash: string,
  panelHash: string | undefined,
  panelVersion?: string,
): VocabularySkew {
  if (!panelHash) {
    return {
      status: "unknown",
      reason:
        "the panel did not advertise a vocabulary hash (builds before this handshake do not) — " +
        "its vocabulary is UNVERIFIED, which is not the same as wrong",
    };
  }
  if (panelHash === serverHash) return { status: "match" };
  const who = panelVersion ? `panel ${panelVersion}` : "the panel";
  return {
    status: "mismatch",
    message:
      `The tool vocabulary ${who} vendored does not match this server's ` +
      `(panel ${panelHash.slice(0, 8)} vs server ${serverHash.slice(0, 8)}). One of the two is ` +
      `behind the other — a hash cannot say which, so update BOTH to the same release rather ` +
      `than guessing. Until then, tool calls can fail as "unknown tool" for names one side has ` +
      `and the other does not: that is this skew surfacing at call time, not a broken panel.`,
  };
}
