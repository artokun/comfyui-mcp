import { describe, expect, it } from "vitest";
import {
  BASELINE_SHA256,
  DEAD_NAMES,
  MAX_TOOLS,
  retirementBaseline,
  TOOL_NAMES,
  baselineIntegrity,
  declaredActions,
  deadNameMentions,
  deadNameRe,
  findDeadName,
  retiredToolMessage,
  rotMentions,
  type DeadName,
} from "../../tools/vocabulary.js";

/**
 * The dead-name matching contract.
 *
 * scripts/check-tool-vocabulary.mts fails the build on references to removed
 * tools, and during the 0.49.0 consolidation ~250 names die — so this regex
 * decides, hundreds of times, whether a real problem is reported or correct code
 * is falsely flagged. Both failure directions are expensive:
 *
 *  - a MISS leaves a hint string telling a model to call a tool that 404s, which
 *    the model cannot diagnose and the user sees as a broken feature;
 *  - a FALSE POSITIVE trains everyone to widen the allowlist, which disarms the
 *    gate permanently.
 *
 * It gets its own test because `\b` looks obviously right here and is wrong.
 */
describe("deadNameRe", () => {
  const matches = (name: string, text: string) => deadNameRe(name).test(text);

  it("matches a bare reference", () => {
    expect(matches("get_image", "call get_image now")).toBe(true);
  });

  // The case that rules out \b: `_` is a word character, so \bget_image\b does
  // NOT match here — and this is the form tool names take in agent transcripts,
  // skill files, and anything quoting a Claude Code tool id.
  it("matches through an mcp__<server>__ prefix", () => {
    expect(matches("get_image", "mcp__comfyui__get_image")).toBe(true);
    expect(matches("panel_get_graph", "use mcp__comfyui_panel__panel_get_graph")).toBe(true);
  });

  // Plan constraint 7, with real data behind it: packs/artokun-flow/workflow.json
  // contains `retarget_image`, which a substring search for `get_image` hits.
  it("rejects a name embedded in a longer identifier", () => {
    expect(matches("get_image", "retarget_image")).toBe(false);
    expect(matches("get_image", '"retarget_image": 5130')).toBe(false);
    expect(matches("get_image", "my_get_image")).toBe(false);
  });

  it("rejects a name that is a prefix of a different name", () => {
    expect(matches("get_image", "get_images")).toBe(false);
    expect(matches("train_start", "train_started_at")).toBe(false);
    // The dangerous one: a dead name whose live REPLACEMENT contains it.
    expect(matches("panel_get_graph", "panel_get_graph_outline")).toBe(false);
  });

  it("survives regex metacharacters in a name", () => {
    expect(() => deadNameRe("weird.name+v2")).not.toThrow();
    expect(matches("weird.name+v2", "weird.name+v2")).toBe(true);
    expect(matches("weird.name+v2", "weirdXnameXv2")).toBe(false);
  });
});

/**
 * The replacement-form exemption — the one place the dead-name gate is allowed to
 * see its own name and stay quiet.
 *
 * Every test here is about the SAME question asked from a different angle: can
 * this exemption be used to launder a live instruction? Because the ratchet is
 * the whole migration's safety net, and a too-broad exemption is the same class
 * of harm as deleting a baseline line — just less visible in a diff. The
 * mutation-check that matters is therefore not "does the exemption work" but
 * "does a WIDER exemption fail a test": ignore which tool the replacement names,
 * or exempt the line rather than the span, and one of these must go red.
 */
describe("rotMentions", () => {
  /**
   * The brief's worked example. `clear_vram` is the OOM panic button and folds
   * into get_system_stats under its own name, so the migration target the prose
   * sweep is required to write contains the retired token verbatim.
   */
  const clearVram: DeadName = {
    name: "clear_vram",
    since: "0.50.0",
    replacement: 'get_system_stats (action:"clear_vram")',
  };
  const rot = (dead: DeadName, line: string, path?: string) => rotMentions(dead, line, path);

  it("exempts a mention inside the name's own declared replacement", () => {
    expect(rot(clearVram, 'get_system_stats (action:"clear_vram")')).toEqual([]);
    expect(rot(clearVram, 'Call `get_system_stats (action:"clear_vram")` to free VRAM.')).toEqual(
      [],
    );
  });

  it("still reports a bare mention", () => {
    expect(rot(clearVram, "clear_vram")).toHaveLength(1);
    expect(rot(clearVram, "| `clear_vram` | frees VRAM |")).toHaveLength(1);
  });

  it("still reports prose that instructs a model to call it", () => {
    expect(rot(clearVram, "call clear_vram to free VRAM")).toHaveLength(1);
  });

  // The exemption is per-name and SELF-derived: it is the ledger's own output for
  // THIS name, not "any tool with a matching action". A mention pointing at the
  // wrong migration target sends the model somewhere that will not answer, which
  // is a defect worth catching rather than one to wave through.
  it("still reports a mention that names the WRONG replacement tool", () => {
    expect(rot(clearVram, 'some_other_tool (action:"clear_vram")')).toHaveLength(1);
    expect(rot(clearVram, 'queue (action:"clear_vram")')).toHaveLength(1);
  });

  /**
   * The wrong tool CAN be a superstring of the right one, and a plain substring
   * search does not notice: `not_get_system_stats (action:"clear_vram")` contains
   * the declared replacement starting at index 4. The copy has to BEGIN at a token
   * boundary, exactly as a name does — otherwise any tool whose name merely ends
   * with the survivor's is a free pass.
   */
  it("still reports a wrong tool whose name merely ENDS with the right one", () => {
    expect(rot(clearVram, 'not_get_system_stats (action:"clear_vram")')).toHaveLength(1);
    expect(rot(clearVram, 'xget_system_stats (action:"clear_vram")')).toHaveLength(1);
    // The mcp__<server>__ allowance must not become a hole either: only a real
    // prefix passes, `xmcp__…` is just another identifier run.
    expect(rot(clearVram, 'xmcp__comfyui__get_system_stats (action:"clear_vram")')).toHaveLength(1);
  });

  /**
   * The `mcp__<server>__` allowance is where a wrong tool could sneak back in, so
   * the server segment forbids `__`. Otherwise `[A-Za-z0-9_]+` swallows
   * `comfyui__wrong` and the line — which reads as server `comfyui`'s tool
   * `wrong__get_system_stats` — is exempted. `deadNameRe`'s own prefix is looser on
   * purpose: there greediness only MATCHES more, which is fail-safe; here it would
   * EXEMPT more, which is not.
   */
  it("does not let the mcp server segment swallow a second name", () => {
    expect(
      rot(clearVram, 'mcp__comfyui__wrong__get_system_stats (action:"clear_vram")'),
    ).toHaveLength(1);
    // A single underscore in the server name is ordinary and must still work.
    expect(rot(clearVram, 'mcp__comfyui_panel__get_system_stats (action:"clear_vram")')).toEqual([]);
  });

  /**
   * The boundary rule stops at the LEFT on purpose — a replacement names its tool
   * at the start, so trailing text cannot change which tool is named. Pinning the
   * asymmetry: a copy followed by more identifier characters is still the correct
   * call form and must not be reported, or a sweep gets sent to "fix" right text.
   */
  it("does not require a boundary after the replacement copy", () => {
    const trailing: DeadName = {
      name: "clear_vram",
      since: "0.50.0",
      replacement: 'get_system_stats (action:"clear_vram") see docs',
    };
    expect(rot(trailing, `${trailing.replacement}_v2`)).toEqual([]);
  });

  // THE SUBTLEST CASE, and the one that separates a positional exemption from a
  // line-wide one. A line-wide `text.includes(replacement)` check passes this line
  // — and that is exactly how a live instruction launders itself by standing next
  // to correct prose, the same laundering the allowedIn logic already had to close.
  // Asserting the SPAN, not just the count, pins which mention survived.
  it("reports the bare mention on a line that also carries the replacement form", () => {
    const line = 'Use get_system_stats (action:"clear_vram"); the old clear_vram is gone.';
    const hits = rot(clearVram, line);
    expect(hits).toHaveLength(1);
    expect(line.slice(hits[0]!.start, hits[0]!.end)).toBe("clear_vram");
    // ...and it is the SECOND one — the bare instruction, not the one inside the
    // replacement. Without this the test would pass on an implementation that
    // exempted the wrong occurrence.
    expect(hits[0]!.start).toBe(line.lastIndexOf("clear_vram"));
  });

  it("does not match a longer action name that merely starts with the dead name", () => {
    expect(deadNameMentions("clear_vram", 'get_system_stats (action:"clear_vram_now")')).toEqual([]);
    expect(rot(clearVram, 'get_system_stats (action:"clear_vram_now")')).toEqual([]);
  });

  // deadNameRe deliberately matches through an mcp__<server>__ prefix, so both
  // directions need pinning: a prefixed replacement form is still the migration
  // target, and a prefixed BARE name is still rot.
  it("handles the mcp__<server>__ prefix form in both directions", () => {
    expect(rot(clearVram, 'mcp__comfyui__get_system_stats (action:"clear_vram")')).toEqual([]);
    expect(rot(clearVram, "mcp__comfyui__clear_vram")).toHaveLength(1);
    // A prefixed name INSIDE the action slot is not the declared replacement.
    expect(rot(clearVram, 'get_system_stats (action:"mcp__comfyui__clear_vram")')).toHaveLength(1);
  });

  it("exempts every copy when the replacement form repeats, and only those", () => {
    const twice = 'get_system_stats (action:"clear_vram") get_system_stats (action:"clear_vram")';
    expect(rot(clearVram, twice)).toEqual([]);
    expect(rot(clearVram, `${twice} — formerly clear_vram`)).toHaveLength(1);
  });

  /**
   * The copies above are ADJACENT; these OVERLAP, which needs the scan to advance
   * one character at a time rather than by the replacement's length. A real call
   * form cannot overlap itself (it starts with a tool name and ends with `)`), so
   * this uses a deliberately self-bordering replacement. The failure it prevents is
   * a false POSITIVE — a legitimate replacement form reported as rot, which is how
   * a sweep gets told to "fix" text that is already correct.
   */
  it("finds overlapping copies of the replacement, not just adjacent ones", () => {
    const replacement = "get_system_stats-clear_vram-get_system_stats-";
    const bordering: DeadName = { name: "clear_vram", since: "0.50.0", replacement };
    const line = `${replacement}clear_vram-get_system_stats-`;
    // Sanity: two copies, and the second starts before the first one ends.
    expect(line.indexOf(replacement)).toBe(0);
    expect(line.indexOf(replacement, 1)).toBe(28);
    expect(28).toBeLessThan(replacement.length);
    expect(rot(bordering, line)).toEqual([]);
  });

  /**
   * The replacements are full call forms, so they carry `(`, `)`, `"` and `|`.
   * Matching them as a compiled PATTERN rather than a literal would be a silent
   * widening: `/comfy_cli \(action:"models_list"|"models_show"\)/` alternates, so
   * the partial form below would match its left branch and be exempted. Literal
   * `indexOf` means the exemption covers the declared string and nothing else.
   */
  it("matches the replacement literally, so regex metacharacters cannot widen it", () => {
    const multi: DeadName = {
      name: "models_list",
      since: "0.50.0",
      replacement: 'comfy_cli (action:"models_list"|"models_show")',
    };
    expect(rot(multi, 'comfy_cli (action:"models_list"|"models_show")')).toEqual([]);
    // A PARTIAL of the declared replacement is not the declared replacement.
    expect(rot(multi, 'comfy_cli (action:"models_list")')).toHaveLength(1);
  });

  /**
   * Degenerate ledger data must fail CLOSED, because `DEAD_NAMES` is
   * hand-maintained: `"".indexOf` semantics would make an empty replacement match
   * at every index and exempt every line, and a replacement that says nothing
   * beyond the dead name would exempt every mention of it — blinding the gate for
   * that name entirely, which is exactly the bypass this rule must not become.
   */
  it("exempts nothing for a degenerate replacement", () => {
    const empty: DeadName = { name: "clear_vram", since: "0.50.0", replacement: "" };
    expect(rot(empty, "call clear_vram now")).toHaveLength(1);
    expect(rot(empty, 'get_system_stats (action:"clear_vram")')).toHaveLength(1);
    // "call the tool that no longer exists" — no migration target, so no exemption.
    // Punctuation, markup and PROSE do not make one: `Use` is an identifier but not
    // a tool, so what must survive cutting the name out is the name of a tool that
    // actually exists.
    const useless = [
      "clear_vram",
      " clear_vram ",
      "`clear_vram`",
      "clear_vram.",
      '"clear_vram"',
      "Use clear_vram",
      "call clear_vram instead",
      // A survivor that is not a real tool — a typo in the ledger, or a name the
      // slice forgot to register. Nothing to migrate to, so nothing is exempted.
      'get_system_stat (action:"clear_vram")',
    ];
    for (const replacement of useless) {
      const circular: DeadName = { name: "clear_vram", since: "0.50.0", replacement };
      expect(rot(circular, replacement), replacement).toHaveLength(1);
      expect(rot(circular, "call clear_vram now"), replacement).toHaveLength(1);
    }
    // ...while a replacement that DOES name another tool still works, markup and all.
    const real: DeadName = {
      name: "clear_vram",
      since: "0.50.0",
      replacement: '`get_system_stats (action:"clear_vram")`',
    };
    expect(rot(real, real.replacement)).toEqual([]);
  });

  /**
   * A replacement may spell the retired name exactly ONCE — in the action slot,
   * which is the whole reason this exemption exists. A second mention makes the
   * ledger entry carry its own live instruction, and exempting a verbatim copy
   * would launder that instruction into every page that quotes the ledger. Note the
   * bare mention here is INSIDE the declared replacement, so span containment alone
   * would exempt it; only counting the mentions in the ledger data catches it.
   */
  it("exempts nothing when the replacement spells the dead name more than once", () => {
    const chatty: DeadName = {
      name: "clear_vram",
      since: "0.50.0",
      replacement: 'get_system_stats (action:"clear_vram") then call clear_vram',
    };
    expect(rot(chatty, chatty.replacement)).toHaveLength(2);
    expect(rot(chatty, 'get_system_stats (action:"clear_vram")')).toHaveLength(1);
  });

  /**
   * CONTAINMENT, not overlap — the difference only shows up on a mention that
   * STRADDLES the edge of a replacement copy, which a truncated `replacement`
   * produces. It is contrived data on purpose: the point is that one mistyped
   * ledger string must not be able to silence a real mention next to it, and an
   * overlap test would let it.
   */
  it("does not exempt a mention that merely straddles the replacement's edge", () => {
    const truncated: DeadName = {
      name: "clear_vram",
      since: "0.50.0",
      // Pasted with a truncated tail, so a verbatim copy of it ends mid-mention.
      replacement: 'get_system_stats (action:"clear_vram") not clear_vr',
    };
    const line = 'get_system_stats (action:"clear_vram") not clear_vram")';
    // Sanity: the copy really is present and really does end inside the second
    // mention, which is therefore overlapped but NOT contained.
    expect(line.startsWith(truncated.replacement)).toBe(true);
    const hits = rot(truncated, line);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.start).toBe(line.lastIndexOf("clear_vram"));
  });

  /**
   * The live end-to-end proof. These are the slice-13 folds whose natural action
   * name IS the retired tool name — the collision that made this change necessary.
   *
   * Slice 13 owns the actual fold map, so the survivors here are illustrative; what
   * is under test is the SHAPE, which is fixed: `<tool> (action:"<dead>")`. They are
   * nonetheless all names that are LIVE in TOOL_NAMES, because the exemption
   * requires the replacement to name a tool that exists — an invented survivor
   * would (correctly) not be exempted at all.
   *
   * The survivor is one of the eight tools the 0.50.0 plan FREEZES (`queue`, shipped
   * in the 0.49.0 slices and explicitly "do not re-open"), rather than whichever tool
   * slice 13 happens to fold these into. An earlier revision spelled real mid-flight
   * survivors and broke the moment a DIFFERENT slice landed: slice 9 retired
   * `install_workflow_dependencies`, and this test started failing for a reason that
   * had nothing to do with the rule under test. Anchoring to a frozen name keeps the
   * fixture about the SHAPE, which is the stated intent, and immune to every
   * remaining slice.
   */
  // The four names slice 13 originally folded and then did NOT retire —
  // apply_manifest, clear_vram, report_issue and calculate — are deliberately
  // absent from this fixture: they are live tools, so a synthetic DeadName for
  // them would document a retirement that never happened.
  // The four names slice 13 originally folded and then did NOT retire —
  // apply_manifest, clear_vram, report_issue and calculate — are deliberately
  // absent from this fixture: they are live tools, so a synthetic DeadName for
  // them would document a retirement that never happened.
  it("passes the slice-13 replacement forms while their bare forms still fail", () => {
    const SURVIVOR = "queue"; // frozen by the 0.50.0 plan; see above
    const folds: Array<[string, string]> = [
      "update_comfyui",
      "update_all",
      "self_update",
      "configure_manager",
    ].map((name) => [name, `${SURVIVOR} (action:"${name}")`]);
    // The fold map is slice 13's, but "the survivor must be a real tool" is not.
    for (const [, replacement] of folds) {
      expect(TOOL_NAMES as readonly string[]).toContain(replacement.split(" ")[0]);
    }
    for (const [name, replacement] of folds) {
      const dead: DeadName = { name, since: "0.50.0", replacement };
      expect(rot(dead, replacement), `${name}: its own replacement must pass`).toEqual([]);
      expect(rot(dead, `call ${name} now`), `${name}: a bare mention must fail`).toHaveLength(1);
      expect(
        rot(dead, `other_tool (action:"${name}")`),
        `${name}: the wrong replacement tool must fail`,
      ).toHaveLength(1);
    }
  });

  /**
   * RULE (b) — the name used as an ACTION VALUE.
   *
   * Slice 16 swept every mention it controlled into the exact replacement form and
   * then classified the 84 hits that remained: 27 were prose (rule (a)) and 57 were
   * the token used as a value or identifier, where no replacement string can wrap
   * it. Slice 15 measured the same shape independently (77 hits). These lines say
   * the word `action` themselves, so the rule is self-evidencing and needs no
   * ledger entry — which is also what makes it stable across `docs:gen`, since the
   * generated `"action": "regenerate"` is covered by the same rule as the source
   * string it was generated from.
   */
  const regenerate: DeadName = {
    name: "regenerate",
    since: "0.50.0",
    replacement: 'generate_image (action:"regenerate")',
  };

  it("exempts the name used as an action value, in every form the slices measured", () => {
    const forms = [
      '- action:"regenerate" — Re-enqueue the workflow that produced an image.',
      '.describe(\'action:"regenerate" — max seconds to wait\')',
      '  "action": "regenerate",',
      "  action: 'regenerate',",
      'c.args?.action === "regenerate"',
      'if (args.action !== "regenerate") return;',
      '{ action:"regenerate", asset_id: "x" }',
    ];
    for (const line of forms) expect(rot(regenerate, line), line).toEqual([]);
  });

  // THE CONSTRAINT THAT MATTERS MOST. Rule (b) as "the line matches action:\"N\""
  // would exempt EVERY occurrence on the line, including a genuinely rotten one
  // beside it. Containment means only the matched occurrence is exempt.
  it("still reports a bare mention sharing a line with an action value", () => {
    const line = '- action:"regenerate" — replaces the old regenerate tool; call regenerate';
    const hits = rot(regenerate, line);
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      // Neither surviving hit is the one inside the action:"…" construct.
      expect(h.start).toBeGreaterThan(line.indexOf('action:"regenerate"') + 18);
    }
  });

  /**
   * A tool-call form CLAIMS a tool, so it is judged by rule (a) — which exempts it
   * only when the tool is the declared survivor. Without this exclusion, rule (b)
   * would exempt `some_other_tool (action:"regenerate")`, breaking the wrong-tool
   * guarantee outright.
   */
  it("does not let the action-value rule launder a wrong tool", () => {
    expect(rot(regenerate, 'generate_image (action:"regenerate")')).toEqual([]);
    for (const wrong of [
      'some_other_tool (action:"regenerate")',
      'queue (action:"regenerate")',
      'not_generate_image (action:"regenerate")',
      'generate_images (action:"regenerate")',
    ]) {
      expect(rot(regenerate, wrong), wrong).toHaveLength(1);
    }
  });

  /**
   * A wrong tool names itself just as much through `?.()`, through a comment, or
   * with no space — so the call-form test is "an `action:` key opening ANY paren",
   * not "an identifier immediately before the paren". The narrower shape let all
   * three of these through.
   */
  it("treats every call syntax as a tool-call form, not just `<ident> (`", () => {
    for (const wrong of [
      'some_other_tool?.(action:"regenerate")',
      "some_other_tool /* traced */ (action:\"regenerate\")",
      'some_other_tool(action:"regenerate")',
      'obj.method(action:"regenerate")',
    ]) {
      expect(rot(regenerate, wrong), wrong).toHaveLength(1);
    }
    // ...while the forms separated from a call by a quote or a brace are still
    // action vocabulary. This is the line the paren rule must not cross.
    expect(rot(regenerate, '.describe(\'action:"regenerate" — seconds\')')).toEqual([]);
    expect(rot(regenerate, 'callTool({ name: "x", args: { action:"regenerate" } })')).toEqual([]);
  });

  it("does not exempt an action value for a name the replacement never declares", () => {
    // The fold RENAMED the action (slice 9's escape hatch), so there is no
    // collision and rule (b) must not fire for the old name.
    const renamed: DeadName = {
      name: "list_skills",
      since: "0.50.0",
      replacement: 'comfy_cli (action:"skill_list") — was list_skills',
    };
    expect(rot(renamed, 'action:"list_skills"')).toHaveLength(1);
    // A DIFFERENT tool's action slot is not this name's licence either.
    expect(rot(regenerate, 'action:"regenerate_all"')).toEqual([]); // no mention at all
  });

  /**
   * The declaration is the `action:` CLAUSE, not any quoted token anywhere in the
   * replacement. Here the fold renamed the action to `upscale` and the prose merely
   * quotes the retired name — reading that as a declaration would switch rules (b)
   * and (c) on for a name that has no action at all.
   */
  it("reads the action clause, not any quoted token in the replacement", () => {
    const quoted: DeadName = {
      name: "regenerate",
      since: "0.50.0",
      replacement: 'generate_image (action:"upscale") — replaces "regenerate"',
    };
    expect(declaredActions(quoted.replacement)).toEqual(["upscale"]);
    expect(rot(quoted, 'action:"regenerate"')).toHaveLength(1);
    expect(rot(quoted, '  case "regenerate":', "src/tools/generate-image.ts")).toHaveLength(1);
  });

  /**
   * The declaration must be the call form's OWN action clause, anchored at the
   * start of the replacement. Prose that merely spells `action:"N"` further along
   * is not a declaration — reading it as one would switch both action rules on for
   * a name the surviving tool has no action for, from a replacement that otherwise
   * looks well-formed.
   */
  it("does not read a declaration out of prose after the call form", () => {
    const prose: DeadName = {
      name: "regenerate",
      since: "0.50.0",
      replacement: 'generate_image (mode:"fast") — old syntax action:"regenerate" is retired',
      implementedIn: ["src/tools/generate-image.ts"],
    };
    expect(declaredActions(prose.replacement)).toEqual([]);
    expect(rot(prose, 'action:"regenerate"')).toHaveLength(1);
    expect(rot(prose, '  ["a", "regenerate"]', "src/tools/generate-image.ts")).toHaveLength(1);
  });

  it("reads a multi-action clause, and only from inside the parens", () => {
    expect(declaredActions('comfy_cli (action:"models_list"|"models_show")')).toEqual([
      "models_list",
      "models_show",
    ]);
    expect(declaredActions('mcp__comfyui__apps (action:"run")')).toEqual(["run"]);
    expect(declaredActions("panel_get_errors")).toEqual([]);
    expect(declaredActions("panel_query_graph (token-bounded) or panel_graph_outline")).toEqual([]);
  });

  /**
   * RULE (c) — the residue slice 16 measured inside the file that registers the
   * surviving tool: `z.enum` members, `case` labels, arguments to per-action error
   * builders. Nothing on those lines says "action", so only a declared path can
   * license them.
   */
  const implemented: DeadName = {
    ...regenerate,
    implementedIn: ["src/tools/generate-image.ts"],
  };

  it("exempts a bare quoted action literal, but only in a declared file", () => {
    const forms = [
      '  .enum(["image", "audio", "regenerate", "upscale"])',
      '    case "regenerate":',
      '      need(args.asset_id, "regenerate", "asset_id", "the asset to re-run");',
    ];
    for (const line of forms) {
      expect(rot(implemented, line, "src/tools/generate-image.ts"), line).toEqual([]);
      // Same text, undeclared file — still rot. The licence is the path.
      expect(rot(implemented, line, "src/tools/other.ts"), line).not.toEqual([]);
      // ...and an entry with no implementedIn licenses nothing anywhere.
      expect(rot(regenerate, line, "src/tools/generate-image.ts"), line).not.toEqual([]);
    }
  });

  /**
   * NOT a whole-file pass, which is the entire reason this is a structural form
   * rather than a `SELF` entry. generate-image.ts is thousands of lines of
   * model-facing description strings; a live instruction added there later must
   * still fail, exactly as it would anywhere else.
   */
  it("still reports a live instruction inside a declared implementing file", () => {
    const path = "src/tools/generate-image.ts";
    for (const line of [
      '    description: "Call regenerate to redo the last render",',
      "    // TODO: regenerate is faster here",
      '    hint: "use regenerate",',
      // A markdown code span in a JSDoc block is PROSE, not an enum member, which
      // is why the literal rule takes `"` and `'` but not backticks. Doc comments
      // in the implementing file are exactly what a whole-file pass would swallow.
      "     * Re-runs the last generation. See `regenerate`.",
    ]) {
      expect(rot(implemented, line, path), line).toHaveLength(1);
    }
    // The quoted literal is exempt; a bare mention BESIDE it on the same line is not.
    const mixed = '    case "regenerate": // falls through to regenerate';
    const hits = rot(implemented, mixed, path);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.start).toBe(mixed.lastIndexOf("regenerate"));
  });

  /**
   * The literal must sit in an ACTION position — an enum/array member or a `case`
   * label. A call's first argument is not one: `callTool("regenerate", …)` is a
   * live dispatch BY TOOL NAME, and the implementing file is a perfectly normal
   * place for one to appear. It is indistinguishable from `z.literal("regenerate")`
   * by syntax alone, so this fails closed and a real case takes an `allowedIn`.
   */
  it("still reports a dispatch by tool name inside a declared file", () => {
    const path = "src/tools/generate-image.ts";
    for (const line of [
      '  await callTool("regenerate", payload);',
      '  return client.call("regenerate");',
      '  const TOOL = "regenerate";',
    ]) {
      expect(rot(implemented, line, path), line).toHaveLength(1);
    }
    // The measured forms all lead with `[`, `,` or `case`, and still pass.
    for (const line of [
      '  .enum(["regenerate", "upscale"])',
      '  .enum(["image", "regenerate"])',
      '    case "regenerate":',
      '      need(args.asset_id, "regenerate", "asset_id", "the asset");',
    ]) {
      expect(rot(implemented, line, path), line).toEqual([]);
    }
  });

  // Ledger-wide, and true no matter what future slices append: the exemption can
  // never silence a BARE mention of any dead name. If a change to rotMentions ever
  // makes it whole-line or name-agnostic, this goes red across the whole ledger.
  it("still reports a bare mention of every name in the real ledger", () => {
    const silenced = DEAD_NAMES.filter(
      (d) => rotMentions(d, `call ${d.name} now`).length !== 1,
    ).map((d) => d.name);
    expect(silenced).toEqual([]);
  });

  // The no-op guarantee for the majority. An entry whose replacement does not spell
  // its own name cannot have a mention contained in a replacement copy, so its
  // verdicts must be identical to plain deadNameRe matching — byte for byte.
  it("is inert for entries whose replacement does not name them", () => {
    const unaffected = DEAD_NAMES.filter((d) => !d.replacement.includes(d.name));
    expect(unaffected.length).toBeGreaterThan(0);
    for (const d of unaffected) {
      const line = `${d.replacement} replaces ${d.name}, formerly mcp__comfyui__${d.name}`;
      expect(rotMentions(d, line), d.name).toEqual(deadNameMentions(d.name, line));
    }
  });
});

describe("DEAD_NAMES ledger", () => {
  // Enforced in the checker too, but as a test it fails fast and locally: a
  // revert that re-registers a tool while the ledger still calls it dead would
  // otherwise only surface in CI.
  it("lists no name that is currently registered", () => {
    const alive = new Set<string>(TOOL_NAMES);
    expect(DEAD_NAMES.filter((d) => alive.has(d.name)).map((d) => d.name)).toEqual([]);
  });

  // THE RATCHET. Without this, the guardrails only ever compare the new registry
  // against the newly-edited ledger — both changed in the same commit — so a removal
  // that forgets its DEAD_NAMES entry passes every gate, and the dead-name scan is
  // silently disarmed for that name because it only hunts names already listed.
  //
  // Against the frozen baseline the obligation cannot be forgotten: anything that
  // existed at 0.48.6 and no longer exists must be declared dead, with a
  // replacement, or the build fails.
  it("declares every retired name dead (baseline \\ ledger ⊆ DEAD_NAMES)", () => {
    const alive = new Set<string>(TOOL_NAMES);
    const declaredDead = new Set(DEAD_NAMES.map((d) => d.name));
    const retiredButNotDeclared = retirementBaseline().filter(
      (n) => !alive.has(n) && !declaredDead.has(n),
    );
    expect(
      retiredButNotDeclared,
      "These tools existed at 0.48.6 and are no longer registered, but are absent from " +
        "DEAD_NAMES — so nothing will flag the prose, hint strings and docs that still " +
        "tell a model to call them. Add each to DEAD_NAMES with a replacement.",
    ).toEqual([]);
  });

  // The ratchet is only as strong as the baseline it measures against, and the
  // baseline is an ordinary tracked file. Deleting a line from it in the same commit
  // as a removal made the whole invariant vacuous.
  it("has an unmodified retirement baseline", () => {
    const { ok, actual } = baselineIntegrity();
    expect(
      ok,
      `docs/design/tool-surface.txt changed (sha256 ${actual}, expected ${BASELINE_SHA256}). ` +
        "Deleting a line disables the retirement ratchet for that name. If you appended " +
        "newly shipped tools, update BASELINE_SHA256 deliberately.",
    ).toBe(true);
  });

  it("keeps MAX_TOOLS equal to the ledger size", () => {
    expect(MAX_TOOLS).toBe(TOOL_NAMES.length);
  });

  // The other half. Treating a live-but-unbaselined name as "simply new, which is fine"
  // was the hole: a name created after 0.48.6 never entered the baseline, so retiring it
  // later triggered nothing. That is exactly the Phase 5 shape — introduce comfy_queue,
  // retire it two slices on, and the ratchet never sees either event.
  it("has every live tool in the baseline (live ⊆ baseline)", () => {
    const baseline = new Set(retirementBaseline());
    expect(
      TOOL_NAMES.filter((n) => !baseline.has(n)),
      "A new tool must join docs/design/tool-surface.txt when it ships, or retiring it " +
        "later is unenforced. Append it, then update BASELINE_SHA256.",
    ).toEqual([]);
  });

  it("gives every dead name an actionable replacement", () => {
    expect(DEAD_NAMES.filter((d) => !d.replacement.trim()).map((d) => d.name)).toEqual([]);
  });

  /**
   * The obligation that arrived with the replacement-form exemption. An entry whose
   * replacement spells its own name is only usable if `rotMentions` actually
   * exempts that replacement — and it refuses to when the replacement names no LIVE
   * tool, e.g. a mistyped survivor (`get_system_stat`) or one the slice forgot to
   * register. Left to CI that surfaces as an unfixable prose sweep: every mention
   * flagged, and rewriting it to the documented form flagged too. Here it surfaces
   * as one clear failure naming the entry.
   *
   * Vacuous today (no entry spells its own name) and binding from slice 13 on.
   * Scoped to self-naming entries deliberately: an entry whose replacement does not
   * spell its own name is never exempted anyway, which is what keeps the PANEL
   * replacements — whose targets are not in the core TOOL_NAMES — out of scope.
   */
  it("makes every self-naming replacement usable (it must point at a live tool)", () => {
    const unusable = DEAD_NAMES.filter((d) => d.replacement.includes(d.name)).filter(
      (d) => rotMentions(d, d.replacement).length !== 0,
    );
    expect(
      unusable.map((d) => `${d.name} → ${d.replacement}`),
      "This replacement spells its own dead name but names no live tool, so the gate " +
        "will flag the very text the prose sweep is required to write. Name the " +
        "surviving tool exactly as it appears in TOOL_NAMES.",
    ).toEqual([]);
  });

  /**
   * `implementedIn` licenses a bare `"name"` literal, and it only means anything
   * when the fold reused the retired TOOL name as its ACTION name. On an entry
   * whose replacement declares no such action it is inert — and an inert exemption
   * is worse than none, because it reads in review as though it were doing
   * something. Vacuous today, binding from slice 13 on.
   */
  it("only lets implementedIn appear where the action reuses the retired name", () => {
    const inert = DEAD_NAMES.filter(
      (d) => d.implementedIn?.length && !declaredActions(d.replacement).includes(d.name),
    );
    expect(
      inert.map((d) => `${d.name} → ${d.replacement}`),
      "implementedIn licenses a quoted action literal, but this entry's replacement " +
        "does not declare the retired name as an action, so it licenses nothing. " +
        "Either fix the replacement or drop implementedIn.",
    ).toEqual([]);
  });

  // An exception without a reason is indistinguishable from someone silencing
  // the gate, which is the failure mode this whole ledger exists to prevent.
  it("gives every allowedIn exception a reason", () => {
    const unjustified = DEAD_NAMES.flatMap((d) =>
      (d.allowedIn ?? []).filter((a) => !a.why.trim()).map((a) => `${d.name} → ${a.path}`),
    );
    expect(unjustified).toEqual([]);
  });
});

/**
 * The call_tool side of the ledger (#659): an EXACT retired name — bare or
 * behind an mcp__<server>__ prefix — resolves to its entry so the caller can be
 * told what replaced it, and nothing else does. The anchoring cases mirror
 * deadNameRe's: the same names that must not match in prose must not resolve
 * here either, or the fuzzy unknown-tool path would be shadowed for them.
 */
describe("findDeadName", () => {
  it("resolves a bare retired name", () => {
    expect(findDeadName("apps_list")?.replacement).toBe('apps (action:"list")');
  });

  it("resolves through an mcp__<server>__ prefix", () => {
    expect(findDeadName("mcp__comfyui__apps_run")?.name).toBe("apps_run");
  });

  it("rejects a name embedded in a longer identifier", () => {
    expect(findDeadName("my_apps_list")).toBeUndefined();
    expect(findDeadName("retarget_image")).toBeUndefined();
  });

  it("rejects a retired name that is only a prefix of the called name", () => {
    expect(findDeadName("apps_list_v2")).toBeUndefined();
    expect(findDeadName("panel_get_graph_outline")).toBeUndefined();
  });

  it("rejects live and unknown names", () => {
    expect(findDeadName("apps")).toBeUndefined();
    expect(findDeadName("definitely_not_a_tool")).toBeUndefined();
  });
});

describe("retiredToolMessage", () => {
  it("quotes the removing version and the replacement", () => {
    expect(retiredToolMessage("apps_run")).toBe(
      `Unknown tool 'apps_run' — removed in 0.49.0. Call apps (action:"run") instead.`,
    );
  });

  it("resolves the prefixed form to the same message", () => {
    expect(retiredToolMessage("mcp__comfyui__apps_import")).toContain('Call apps (action:"import") instead.');
  });

  it("stays grammatical for a clause-shaped since (pre-baseline entries)", () => {
    const message = retiredToolMessage("panel_get_graph");
    expect(message).toContain("removed upstream before 0.48.0");
    expect(message).not.toContain("removed in removed");
  });

  it("returns undefined for a genuinely unknown name", () => {
    expect(retiredToolMessage("definitely_not_a_tool")).toBeUndefined();
  });
});
