import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRegisteredTools } from "../../tools/introspect.js";
import { buildPanelToolDefs } from "../../orchestrator/panel-tools.js";
import { extractExecutionError, TRACEBACK_MAX_CHARS } from "../../services/job-history.js";
import { parseCrashBlock } from "../../services/crash-log.js";
import {
  readBoundNotice,
  gitBoundNotice,
  patchBoundNotice,
  clipMatchLine,
  searchTruncationHint,
  READ_MAX_CHARS,
  SEARCH_LINE_MAX,
  SEARCH_MAX_RESULTS,
} from "../../services/node-dev.js";
import {
  queryApiGraph,
  LIMIT_CEILING,
  MAX_CHARS_CEILING,
  MAX_CHARS_FLOOR,
} from "../../services/graph-query.js";

/**
 * #809 — a truncation marker is an INSTRUCTION TO A MACHINE.
 *
 * The defect this file exists to prevent is not "the hint is missing", it is "the hint
 * names the WRONG lever". The saved-file query's truncation tail told callers to raise
 * `limit` even when the CHAR BUDGET had cut the result — where raising `limit` does
 * nothing and makes the overflow worse. The agent tries it, it fails, and the failure
 * confirms the wrong conclusion: "this tool cannot read this graph."
 *
 * So the assertions below are driven off the REAL registered surface — the JSON Schema
 * the SDK derives from each tool's zod shape, fetched through a real MCP client by
 * listRegisteredTools(). A hand-written table of "params that exist" would rot in
 * exactly the way the hint itself rotted, and would have passed the whole time.
 *
 * The conventions the extraction relies on, which every remedy string must follow:
 *
 *   • A parameter OF THE EMITTING TOOL is written in `backticks`. Everything backticked
 *     that looks like an identifier is checked against that tool's schema.
 *   • A parameter OF A DIFFERENT tool is written bare, inside that tool's own call
 *     syntax (`panel_query_graph {ids:[…]}`) — it is not this tool's lever and must not
 *     be dressed as one.
 *   • A SIBLING TOOL is named bare and must be a registered tool.
 *   • A stated ceiling is written "`param` up to N", and N must equal the schema's real
 *     maximum — not the prose's idea of it. (The git action's true 24000 ceiling was a
 *     code clamp its description never mentioned, so callers raised past it and saw
 *     nothing change.)
 */

/** Identifier-shaped backticked tokens: `max_chars`, `limit`, `group_by`. */
const BACKTICKED = /`([A-Za-z_][A-Za-z0-9_]*)`/g;
/**
 * A sentence is a REMEDY when it tells the caller what to do about dropped content.
 * Descriptions legitimately backtick things that are not parameters (a binary name, a
 * response field), so the strict "backticked ⇒ parameter" rule is applied to remedy
 * sentences only — which is exactly the surface this issue is about, and which no
 * hand-maintained allowlist has to be kept in step with.
 */
const REMEDY_SENTENCE = /\braise\b|truncat|\bcut by\b|\bcapped\b|\bcap\b|\bSTOPS\b|\bbudget\b|\bomitted\b/i;
const splitSentences = (text: string): string[] =>
  text.split(/(?<=[.!?;])\s+|\n+/).filter((s) => s.trim().length > 0);
/** Bare panel tool references — response fields never carry this prefix. */
const PANEL_TOOL_REF = /\b(panel_[a-z0-9_]+)\b/g;
/** A stated ceiling: "`max_chars` up to 60000" or "raise `max_chars` (up to 60000)". */
const CEILING = /`([A-Za-z_][A-Za-z0-9_]*)`\s+\(?up to\s+(\d+)/g;
/** An instruction to raise a parameter — which is only actionable WITH a ceiling. */
const RAISE = /\braise\s+`([A-Za-z_][A-Za-z0-9_]*)`/gi;

function matchAll(re: RegExp, text: string, group = 1): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) out.push(m[group]);
  return out;
}

describe("#809 truncation remedies name a lever that actually exists", () => {
  let schemaOf: Map<string, Record<string, unknown>>;
  let toolNames: Set<string>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // Same isolation as the surface gate: autoloaded saved-workflow tools and the
    // compact tool mode both change what "registered" means.
    for (const key of ["COMFYUI_WORKFLOWS_DIR", "COMFYUI_MCP_TOOL_MODE"]) {
      saved[key] = process.env[key];
    }
    process.env.COMFYUI_WORKFLOWS_DIR = await mkdtemp(join(tmpdir(), "comfyui-mcp-remedy-"));
    delete process.env.COMFYUI_MCP_TOOL_MODE;

    const registered = await listRegisteredTools();
    schemaOf = new Map();
    toolNames = new Set(registered.map((t) => t.name));
    for (const t of registered) {
      const props = (t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
      schemaOf.set(t.name, props);
    }
    // The panel_* surface is registered against a LIVE panel session, so it is not in
    // the headless registration pass. Take its schemas from the single source of truth
    // both transports register from — still the real zod shape, never a hand list.
    for (const d of buildPanelToolDefs()) {
      toolNames.add(d.name);
      if (!schemaOf.has(d.name)) schemaOf.set(d.name, { ...d.schema });
    }
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** The one assertion the issue asks for, applied to one emitted string. */
  function assertRemedyIsActionable(tool: string, where: string, text: string): void {
    const props = schemaOf.get(tool);
    expect(props, `${tool} is not a registered tool — the scenario table is stale`).toBeTruthy();

    for (const name of matchAll(BACKTICKED, text)) {
      expect(
        Object.prototype.hasOwnProperty.call(props!, name),
        `${where}: remedy names \`${name}\`, which is NOT a parameter of ${tool}. ` +
          `Backticks mean "a lever on THIS tool" — a parameter of another tool must be ` +
          `written bare inside that tool's call syntax. Remedy: ${JSON.stringify(text)}`,
      ).toBe(true);
    }

    for (const referenced of matchAll(PANEL_TOOL_REF, text)) {
      expect(
        toolNames.has(referenced),
        `${where}: remedy points the caller at "${referenced}", which is not a ` +
          `registered tool. Remedy: ${JSON.stringify(text)}`,
      ).toBe(true);
    }

    // THE STRONGER BAR. "names a parameter that exists" is necessary and NOT sufficient:
    // a parameter already at its ceiling names a real lever that cannot move, and costs
    // the caller exactly the wasted round trip this issue exists to prevent. So any
    // remedy that says "raise `X`" must also say HOW FAR — otherwise the caller cannot
    // tell whether the retry is even possible.
    for (const m of text.matchAll(RAISE)) {
      const name = m[1];
      const stated = new RegExp(
        `\`${name}\`[^.]{0,40}?(up to \\d+)|\`${name}\` is already at its ceiling`,
      );
      expect(
        stated.test(text),
        `${where}: remedy says "raise \`${name}\`" without a ceiling. A caller already at ` +
          `the maximum is being sent on a retry that cannot change anything — the same ` +
          `wasted round trip as naming a parameter that does not exist. Say "up to N", ` +
          `or say it is already at its ceiling. Remedy: ${JSON.stringify(text)}`,
      ).toBe(true);
    }

    for (const m of text.matchAll(CEILING)) {
      const [, name, stated] = m;
      const spec = props![name] as { maximum?: number } | undefined;
      // Only enforce where the schema publishes a REAL maximum. `z.number().int()` with
      // no `.max()` still emits `maximum: Number.MAX_SAFE_INTEGER` — the int-range
      // sentinel, not a ceiling — and treating it as one would demand that every remedy
      // quote 9007199254740991. Those tools clamp in code instead (the git action's
      // hidden 24000 is the case the issue names), and their remedies are pinned against
      // the exported clamp constant by their own cases below.
      const published =
        spec && typeof spec.maximum === "number" && spec.maximum !== Number.MAX_SAFE_INTEGER;
      if (published) {
        expect(
          Number(stated),
          `${where}: remedy says "\`${name}\` up to ${stated}" but the schema's real ` +
            `maximum is ${spec.maximum}. A ceiling the runtime does not honour sends the ` +
            `caller at a value that is silently clamped.`,
        ).toBe(spec.maximum);
      }
    }
  }

  // ---- get_workflow action:"query" (src/services/graph-query.ts) -------------------
  //
  // Scenarios are real engine runs, not fixtures: the string under test is the one the
  // tool would actually emit.

  const bigGraph = (n: number, widget = "x") =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        String(i + 1),
        { class_type: "KSampler", inputs: { [widget]: `v${i}`, cfg: 8 }, _meta: { title: `n${i}` } },
      ]),
    );

  const scenarios: Array<{ name: string; text: () => string }> = [
    {
      name: "limit cut, no ids",
      text: () => queryApiGraph(bigGraph(120), { limit: 5, max_chars: 60000 }).text,
    },
    {
      name: "char-budget cut, no ids",
      text: () => queryApiGraph(bigGraph(120), { limit: 200, max_chars: 600 }).text,
    },
    {
      name: "limit cut with explicit ids",
      text: () =>
        queryApiGraph(bigGraph(120), {
          ids: Array.from({ length: 60 }, (_, i) => String(i + 1)),
          limit: 3,
          max_chars: 60000,
        }).text,
    },
    {
      name: "char-budget cut with explicit ids",
      text: () =>
        queryApiGraph(bigGraph(120), {
          ids: Array.from({ length: 60 }, (_, i) => String(i + 1)),
          max_chars: 600,
        }).text,
    },
    {
      name: "aggregate cut by the char budget",
      text: () => {
        const g: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
        for (let i = 0; i < 400; i++) g[String(i)] = { class_type: `Type${i}`, inputs: {} };
        return queryApiGraph(g, { group_by: "type", max_chars: MAX_CHARS_FLOOR }).text;
      },
    },
    {
      name: "detail row whose widget value hits the fixed per-widget cap",
      text: () =>
        queryApiGraph(
          { "1": { class_type: "T", inputs: { blob: "z".repeat(9000) } } },
          { fields: "detail", max_chars: 60000 },
        ).text,
    },
    {
      // The per-widget cap TIGHTENS to the budget when the budget is the smaller of the
      // two. That path's remedy is the opposite of the fixed-cap one — raising max_chars
      // genuinely lifts it — so it needs its own coverage.
      name: "detail widget value cut by the BUDGET-tightened per-value cap",
      text: () =>
        queryApiGraph(
          { "1": { class_type: "T", inputs: { blob: "b".repeat(3000) } } },
          { fields: "detail", max_chars: 2000 },
        ).text,
    },
    {
      name: "detail row whose widgets are dropped by the char budget",
      text: () => {
        const inputs: Record<string, unknown> = {};
        for (let i = 0; i < 200; i++) inputs[`w${i}`] = "y".repeat(60);
        return queryApiGraph({ "1": { class_type: "T", inputs } }, { fields: "detail", max_chars: 900 })
          .text;
      },
    },
    {
      name: "detail row past the fixed ref / consumer caps",
      text: () => {
        const g: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
          "1": { class_type: "Hub", inputs: {} },
        };
        const inputs: Record<string, unknown> = {};
        for (let i = 0; i < 90; i++) {
          g[String(i + 2)] = { class_type: "Src", inputs: {} };
          inputs[`in${i}`] = [String(i + 2), 0];
        }
        g["1"].inputs = inputs;
        return queryApiGraph(g, { ids: ["1"], fields: "detail", max_chars: MAX_CHARS_CEILING }).text;
      },
    },
    {
      name: "compact row whose widget values hit the fixed 60-char clip",
      text: () => queryApiGraph({ "1": { class_type: "T", inputs: { p: "q".repeat(400) } } }, {}).text,
    },
    {
      name: "compact line longer than the whole budget",
      text: () => {
        const inputs: Record<string, unknown> = {};
        for (let i = 0; i < 400; i++) inputs[`w${i}`] = "k".repeat(30);
        return queryApiGraph({ "1": { class_type: "T", inputs } }, { max_chars: MAX_CHARS_FLOOR }).text;
      },
    },
  ];

  for (const s of scenarios) {
    it(`get_workflow action:"query" — ${s.name}`, () => {
      const text = s.text();
      // Every scenario must actually have dropped something, or it is asserting nothing.
      expect(text, `scenario "${s.name}" produced no truncation marker`).toMatch(
        /…|truncated|cut|omitted/,
      );
      assertRemedyIsActionable("get_workflow", `get_workflow action:"query" (${s.name})`, text);
    });
  }

  // ---- defect 1: the tail must name the lever that ACTUALLY fired -------------------

  it("names max_chars — and NOT limit — when the char budget did the cutting", () => {
    const r = queryApiGraph(bigGraph(120), { limit: LIMIT_CEILING, max_chars: 600 });
    expect(r.truncated).toBe(true);
    expect(r.truncated_by).toBe("max_chars");
    expect(r.text).toContain("`max_chars`");
    expect(r.text).toContain(`up to ${MAX_CHARS_CEILING}`);
    // The pre-#809 tail ended "…or raise limit." on this exact path. Raising `limit`
    // here cannot help, so the tail must not read as an instruction to raise it.
    expect(r.text).not.toMatch(/raise `limit`/);
    expect(r.text).toMatch(/Raising `limit` will not help/);
  });

  it("names limit — and says max_chars is not the constraint — when the limit did the cutting", () => {
    const r = queryApiGraph(bigGraph(120), { limit: 5, max_chars: MAX_CHARS_CEILING });
    expect(r.truncated).toBe(true);
    expect(r.truncated_by).toBe("limit");
    expect(r.text).toContain("raise `limit`");
    expect(r.text).toContain(`up to ${LIMIT_CEILING}`);
    expect(r.text).toMatch(/`max_chars` is not the constraint here/);
  });

  it("applies the same cause split on the explicit-ids path", () => {
    const ids = Array.from({ length: 60 }, (_, i) => String(i + 1));
    const byLimit = queryApiGraph(bigGraph(120), { ids, limit: 3, max_chars: MAX_CHARS_CEILING });
    expect(byLimit.truncated_by).toBe("limit");
    expect(byLimit.text).toContain("raise `limit`");
    expect(byLimit.text).not.toMatch(/raise `max_chars`/);

    const byChars = queryApiGraph(bigGraph(120), { ids, max_chars: 600 });
    expect(byChars.truncated_by).toBe("max_chars");
    expect(byChars.text).toContain("raise `max_chars`");
    expect(byChars.text).not.toMatch(/raise `limit`/);
  });

  // codex gate: "raise `X` up to N" is ITSELF a dead retry at N. The whole point of this
  // issue is that a wasted retry teaches the agent the tool cannot do the job — so a
  // caller already at the ceiling must be pointed somewhere that can still work.
  it("stops telling the caller to raise a parameter that is already at its ceiling", () => {
    const byLimit = queryApiGraph(bigGraph(500), {
      limit: LIMIT_CEILING,
      max_chars: MAX_CHARS_CEILING,
    });
    expect(byLimit.truncated_by).toBe("limit");
    expect(byLimit.text).toMatch(new RegExp(`\`limit\` is already at its ceiling of ${LIMIT_CEILING}`));
    expect(byLimit.text).not.toMatch(/raise `limit` up to/);
    // …and it still names what IS left.
    expect(byLimit.text).toMatch(/narrow with `types`/);

    // Fat rows so the CHAR budget fires before the row cap, with both at their ceilings.
    const fat: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
    for (let i = 0; i < 100; i++) {
      const inputs: Record<string, unknown> = {};
      for (let w = 0; w < 30; w++) inputs[`w${w}`] = "v".repeat(80);
      fat[String(i)] = { class_type: "KSampler", inputs };
    }
    const byChars = queryApiGraph(fat, {
      limit: LIMIT_CEILING,
      max_chars: MAX_CHARS_CEILING,
    });
    expect(byChars.truncated_by).toBe("max_chars");
    expect(byChars.text).toMatch(
      new RegExp(`\`max_chars\` is already at its ceiling of ${MAX_CHARS_CEILING}`),
    );
    expect(byChars.text).not.toMatch(/raise `max_chars` up to/);
  });

  it("still offers the raise when the caller is below the ceiling", () => {
    const r = queryApiGraph(bigGraph(500), { limit: 10, max_chars: MAX_CHARS_CEILING });
    expect(r.text).toContain(`raise \`limit\` up to ${LIMIT_CEILING}`);
    expect(r.text).not.toMatch(/already at its ceiling/);
  });

  // The INVERSE defect, and just as costly: claiming a cut that did not happen. The
  // caller retries wider for nothing, or distrusts a complete result. Reserving the
  // footer's worst case up front caused exactly this at the 500 floor (codex gate), so
  // the fit is done afterwards by dropping only as many rows as actually needed.
  it("never claims truncation for a result that fits, even at the max_chars floor", () => {
    const small = {
      "1": { class_type: "A", inputs: { s: 1 } },
      "2": { class_type: "B", inputs: { s: 2 } },
    };
    const r = queryApiGraph(small, { max_chars: MAX_CHARS_FLOOR });
    expect(r.shown).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.truncated_by).toBeNull();
    expect(r.text).not.toMatch(/truncated at/);
    expect(r.text.length).toBeLessThanOrEqual(MAX_CHARS_FLOOR);
  });

  it("keeps the WHOLE result — tail and footer included — inside max_chars", () => {
    // The tail and the clip footer are part of the result. Appending them past the bound
    // would break the promise the parameter makes; the first row stays exempt (#609).
    for (const budget of [MAX_CHARS_FLOOR, 900, 4000]) {
      const g: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
      for (let i = 0; i < 60; i++) {
        g[String(i)] = { class_type: `Type${i}`, inputs: { note: "n".repeat(300) } };
      }
      const r = queryApiGraph(g, { max_chars: budget });
      const firstRowLen = r.text.split("\n")[1]?.length ?? 0;
      expect(
        r.text.length,
        `budget ${budget} breached (first row ${firstRowLen})`,
      ).toBeLessThanOrEqual(Math.max(budget, firstRowLen * 2));
      if (r.shown > 1) expect(r.text.length).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps the AGGREGATE inside max_chars too, tail included", () => {
    // The aggregate path filled the budget with rows and then appended its tail — the
    // same tail-after-budget defect the row path had, on a branch the row-path fix does
    // not touch (codex gate).
    for (const budget of [MAX_CHARS_FLOOR, 800, 3000]) {
      const g: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
      for (let i = 0; i < 400; i++) g[String(i)] = { class_type: `VeryLongTypeName_${i}`, inputs: {} };
      const r = queryApiGraph(g, { group_by: "type", max_chars: budget });
      expect(r.text.length, `aggregate breached budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(r.truncated).toBe(true);
      expect(r.truncated_by).toBe("max_chars");
    }
  });

  it("counts only the clips in rows it actually returned", () => {
    // The footer used a running total, so rows the budget rejected — and rows the
    // post-fit loop popped — still counted. A note claiming clips the reader cannot see
    // is a false truncation claim inside the one string that has to be trustworthy.
    const g: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
    for (let i = 0; i < 40; i++) {
      g[String(i)] = { class_type: "T", inputs: { long: "v".repeat(400) } };
    }
    const r = queryApiGraph(g, { max_chars: 900 });
    const m = /\((\d+) widget value\(s\) clipped/.exec(r.text);
    expect(m, "the clip footer must be present").toBeTruthy();
    // Exactly one clipped value per rendered row, so the count must equal `shown`.
    expect(Number(m![1])).toBe(r.shown);
    expect(r.text.split("\n").filter((l) => l.startsWith("#")).length).toBe(r.shown);
  });

  it("says when it clipped the id it is echoing back", () => {
    // A shortened id echoed with a bare "…" reads as "that is the id I looked for", so a
    // caller cannot tell a typo from a clip and re-sends the same value (codex gate).
    const r = queryApiGraph({ "1": { class_type: "T", inputs: {} } }, { upstream_of: "n".repeat(400) });
    expect(r.text).toMatch(/id shown clipped to 120 of 400 chars/);
    expect(r.text).toMatch(/not found in the graph/);
  });

  it("reports truncated_by: null when nothing was dropped", () => {
    const r = queryApiGraph(bigGraph(3), { max_chars: MAX_CHARS_CEILING });
    expect(r.truncated).toBe(false);
    expect(r.truncated_by).toBeNull();
  });

  // ---- the fixed caps must not advertise a lever that cannot move them --------------

  it("names max_chars when the per-value cap was TIGHTENED by the budget", () => {
    // Same code path, opposite remedy: here raising `max_chars` really does lift the cut,
    // so it must be named — and it must not repeat the "does not raise" wording.
    const r = queryApiGraph(
      { "1": { class_type: "T", inputs: { blob: "b".repeat(3000) } } },
      { fields: "detail", max_chars: 2000 },
    );
    expect(r.text).toMatch(/chars cut over the `max_chars` budget; raise `max_chars`/);
    expect(r.text).not.toMatch(/does not raise/);
  });

  it("says plainly that the per-widget cap is NOT raised by max_chars", () => {
    const r = queryApiGraph(
      { "1": { class_type: "T", inputs: { blob: "z".repeat(9000) } } },
      { fields: "detail", max_chars: MAX_CHARS_CEILING },
    );
    expect(r.text).toMatch(/per-widget cap, which `max_chars` does not raise/);
  });

  it("points the fixed ref/consumer caps at the traversal that returns them all", () => {
    const g: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
      "1": { class_type: "Hub", inputs: {} },
    };
    const inputs: Record<string, unknown> = {};
    for (let i = 0; i < 90; i++) {
      g[String(i + 2)] = { class_type: "Src", inputs: {} };
      inputs[`in${i}`] = [String(i + 2), 0];
    }
    g["1"].inputs = inputs;
    const r = queryApiGraph(g, { ids: ["1"], fields: "detail", max_chars: MAX_CHARS_CEILING });
    expect(r.text).toContain("`upstream_of`");
    expect(r.text).toContain("`depth`");
  });

  it("stops saying 'list all' once the follow-up would exceed limit's own ceiling", () => {
    // codex gate: at more than LIMIT_CEILING-1 neighbours the suggested traversal cannot
    // return them in one call. Promising "list all" there would be a SECOND false hint
    // inside the remedy for the first one.
    const g: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
      "1": { class_type: "Hub", inputs: {} },
    };
    const inputs: Record<string, unknown> = {};
    for (let i = 0; i < 250; i++) {
      g[String(i + 2)] = { class_type: "Src", inputs: {} };
      inputs[`in${i}`] = [String(i + 2), 0];
    }
    g["1"].inputs = inputs;
    const r = queryApiGraph(g, { ids: ["1"], fields: "detail", max_chars: MAX_CHARS_CEILING });
    expect(r.text).not.toMatch(/list all/);
    expect(r.text).toContain(`list the first ${LIMIT_CEILING}`);
    // The query action has NO cursor/offset, so "page through them" would be a second
    // false promise inside the remedy for the first one.
    expect(r.text).toMatch(/there is no cursor\/offset/);
    // And it still never quotes a limit above the ceiling.
    expect(r.text).not.toMatch(/`limit`:2[0-9][1-9]/);
    assertRemedyIsActionable("get_workflow", "get_workflow query 250-ref follow-up", r.text);
  });

  it("points the fixed compact-value clip at fields:'detail', not at a dead lever", () => {
    const r = queryApiGraph({ "1": { class_type: "T", inputs: { p: "q".repeat(400) } } }, {});
    expect(r.text).toContain('`fields`:"detail"');
    expect(r.text).not.toMatch(/raise `max_chars`/);
  });

  // ---- panel_* descriptions and riders ---------------------------------------------

  it("panel_find_nodes no longer claims it does not truncate", () => {
    const d = buildPanelToolDefs().find((t) => t.name === "panel_find_nodes");
    expect(d).toBeTruthy();
    expect(d!.description).not.toMatch(/no truncation/i);
    // It must state the cap AND that a capped result is not a complete match set —
    // "returns 40" without that reads as "there are 40".
    expect(d!.description).toMatch(/`limit`/);
    expect(d!.description).toMatch(/STOPS/);
  });

  /** Apply the rule to a DESCRIPTION, sentence by sentence, remedy sentences only. */
  function assertDescriptionRemediesAreActionable(tool: string, description: string): void {
    for (const sentence of splitSentences(description)) {
      if (!REMEDY_SENTENCE.test(sentence)) continue;
      assertRemedyIsActionable(tool, `${tool} description`, sentence);
    }
  }

  it("every panel_* description's truncation prose names real parameters of that tool", () => {
    for (const d of buildPanelToolDefs()) {
      assertDescriptionRemediesAreActionable(d.name, d.description);
    }
  });

  it("every registered tool's truncation prose names real parameters of that tool", async () => {
    // Through the real registry, so a renamed parameter still quoted in prose fails here
    // rather than misleading a caller in production.
    for (const t of await listRegisteredTools()) {
      assertDescriptionRemediesAreActionable(t.name, t.description);
    }
  });

  // ---- the panel riders (#809): a boolean is replaced by a usable instruction --------
  //
  // Driven through the REAL tool definitions with a stubbed panel reply, so the string
  // asserted here is the one a caller would receive.

  async function runPanelTool(
    name: string,
    args: Record<string, unknown>,
    reply: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const d = buildPanelToolDefs().find((t) => t.name === name);
    expect(d, `${name} is not a panel tool`).toBeTruthy();
    const res = await d!.handler(args, {
      call: async () => ({
        content: [{ type: "text" as const, text: JSON.stringify(reply, null, 2) }],
      }),
      // The riders only use ctx.call; the rest of the ctx surface is unused here.
    } as unknown as Parameters<typeof d.handler>[1]);
    const text = res.content.find((c) => c.type === "text");
    expect(text, `${name} returned no text block`).toBeTruthy();
    return JSON.parse((text as { text: string }).text) as Record<string, unknown>;
  }

  const riderCases: Array<{
    tool: string;
    args?: Record<string, unknown>;
    reply: Record<string, unknown>;
    key: string;
    /** Substrings the remedy must contain to be actionable at all. */
    mustSay: RegExp[];
  }> = [
    {
      tool: "panel_find_nodes",
      args: { query: "load", limit: 40 },
      reply: { total: 690, count: 40, truncated: true, matches: new Array(40).fill({ id: 1 }) },
      key: "truncation_hint",
      // "MAY be incomplete", never "there ARE more": this orchestrator ships ahead of the
      // panel, and an older panel sets `truncated` on an exact-cap result that dropped
      // nothing. Asserting more exist would manufacture the false alarm (codex gate).
      mustSay: [/`limit`/, /up to 200/, /MAY be incomplete/, /not proof a node is absent/],
    },
    {
      tool: "panel_view_selected",
      reply: { selected_count: 690, nodes: new Array(100).fill({ id: 1 }), truncated: true },
      key: "truncation_hint",
      mustSay: [/100 of 690/, /FIXED cap/, /no parameter raises it/, /panel_query_graph/],
    },
    {
      tool: "panel_view_nodes_in_viewport",
      reply: { in_view_count: 300, nodes: new Array(100).fill({ id: 1 }), truncated: true },
      key: "truncation_hint",
      mustSay: [/100 of 300/, /no parameter raises it/, /panel_query_graph/],
    },
    {
      tool: "panel_get_subgraph",
      args: { node_id: 7 },
      reply: { node_count: 240, nodes: new Array(100).fill({ id: 1 }), truncated: true },
      key: "truncation_hint",
      mustSay: [/100 of 240/, /no parameter raises it/, /panel_enter_subgraph/],
    },
    {
      tool: "panel_get_errors",
      reply: { errored_count: 150, nodes: new Array(100).fill({ id: 1 }), truncated: true },
      key: "truncation_hint",
      mustSay: [/100 of 150/, /no parameter raises it/],
    },
    {
      tool: "panel_graph_outline",
      args: { max_chars: 4000 },
      reply: { node_count: 690, group_count: 12, degraded: true, detail_level: "groups", outline: "…" },
      key: "truncation_hint",
      mustSay: [/covers ALL 690 node/, /`max_chars`/, /up to 60000/],
    },
  ];

  for (const c of riderCases) {
    it(`${c.tool} replaces its bare truncation boolean with an instruction`, async () => {
      const payload = await runPanelTool(c.tool, c.args ?? {}, c.reply);
      const hint = payload[c.key];
      expect(typeof hint, `${c.tool} emitted no ${c.key}`).toBe("string");
      for (const re of c.mustSay) expect(hint as string).toMatch(re);
      assertRemedyIsActionable(c.tool, `${c.tool} ${c.key}`, hint as string);
    });

    it(`${c.tool} attaches nothing when the result was not cut`, async () => {
      const clean = { ...c.reply, truncated: false, degraded: false };
      const payload = await runPanelTool(c.tool, c.args ?? {}, clean);
      expect(payload[c.key]).toBeUndefined();
    });
  }

  it("the stale-red-flags rider does not imply the shown count is the whole list", async () => {
    const payload = await runPanelTool(
      "panel_get_errors",
      {},
      {
        errored_count: 3,
        nodes: [],
        stale_flags: new Array(100).fill({ id: 1 }),
        stale_flags_truncated: true,
      },
    );
    const hint = payload.stale_flags_truncation_hint as string;
    expect(typeof hint).toBe("string");
    // Older panels send no total for this list. Saying "Showing 100" alone would read as
    // "there are 100" — the rider must say the remainder is unknown instead.
    expect(hint).toMatch(/unknown number more were cut/);
    assertRemedyIsActionable("panel_get_errors", "panel_get_errors stale flags", hint);
  });

  // ---- node-dev: the same schema check, on the builders those tools emit -------------
  //
  // These are exported precisely so the check needs no filesystem. `boundText` is shared
  // by ACTIONS with DIFFERENT levers (node_pack action:"read" has `max_chars`,
  // action:"patch" has none), which is how a shared default would have shipped a dead
  // remedy. 0.50.0 slice 12 folded the six node-dev tools into `node_pack`, so the
  // schema these remedies are checked against is now the union of its nine actions.

  const nodeDevRemedies: Array<{ tool: string; where: string; text: string }> = [
    {
      tool: "node_pack",
      where: 'node_pack action:"read" bound notice',
      text: readBoundNotice(12_000, 1, 240)(5_000),
    },
    {
      tool: "node_pack",
      where: 'node_pack action:"git" bound notice',
      text: gitBoundNotice(12_000)(5_000),
    },
    {
      tool: "node_pack",
      where: 'node_pack action:"search" result cap',
      text: searchTruncationHint("max_results", 50, 50),
    },
    {
      tool: "node_pack",
      where: 'node_pack action:"search" scanned-file bound',
      text: searchTruncationHint("scanned_files", 12, 50),
    },
  ];

  for (const r of nodeDevRemedies) {
    it(`${r.where} names only real parameters of ${r.tool}`, () => {
      assertRemedyIsActionable(r.tool, r.where, r.text);
    });
  }

  // Where the schema publishes no maximum, the remedy and the runtime clamp are the SAME
  // exported constant by construction. That the CLAMP really honours it is exercised for
  // real in src/__tests__/services/node-dev.test.ts ("max_chars clamps are real"), which
  // calls readNodeFile / nodePackGit with an over-ceiling budget — asserting
  // `Math.min(x, CONST) === CONST` here would only restate arithmetic.
  it("code-clamp remedies quote the exported constant, not a hand-typed number", () => {
    expect(readBoundNotice(1, 1, 2)(1)).toContain(`up to ${READ_MAX_CHARS}`);
    expect(searchTruncationHint("max_results", 1, 1)).toContain(`up to ${SEARCH_MAX_RESULTS}`);
  });

  it('node_pack action:"git" remedy quotes the CODE clamp its description used to hide', () => {
    // The issue records this specifically: the real ceiling (24000) is a runtime clamp,
    // and the schema publishes no `maximum`, so the schema-driven ceiling check cannot
    // see it. Pin it against the constant the clamp itself uses.
    const text = gitBoundNotice(12_000)(1);
    expect(text).toContain(`up to ${READ_MAX_CHARS}`);
    expect(text).toContain("a hard clamp");
  });

  it('node_pack action:"patch" remedy names NO lever, because it has none', () => {
    const text = patchBoundNotice(500);
    // Its only parameter is `patch`. A remedy naming `max_chars` here would be defect 1
    // pointing the other way: a lever the caller cannot pull. NOTE the fold makes this
    // check STRICTER, not weaker: `max_chars` IS a property of `node_pack` now (action
    // "read"/"git" have it), so a remedy that named it would still pass the
    // parameter-exists bar — which is why the explicit assertions below matter.
    assertRemedyIsActionable("node_pack", 'node_pack action:"patch" bound notice', text);
    expect(text).toMatch(/has no parameter to raise it/);
    expect(text).not.toContain("max_chars");
    // Nor may it hand off to an action that cannot run the same command: the git
    // action's git_action values are status/diff/log/commit/push — none of them can
    // `git apply` (codex gate). The only real remedy is a smaller patch.
    expect(text).not.toContain('action:"git"');
    expect(text).toMatch(/Split the patch into smaller per-file hunks/);
  });

  it("the per-line search clip stays INSIDE the cap it describes", () => {
    const clipped = clipMatchLine("q".repeat(5_000));
    expect(clipped.length).toBeLessThanOrEqual(SEARCH_LINE_MAX);
    expect(clipped).toMatch(/fixed 600-char per-line cap/);
    expect(clipped).toContain('node_pack (action:"read")');
  });

  // ---- sites with NO lever: they must say so, and must not promise one ---------------
  //
  // These fell outside the schema-driven sweep because their text is not emitted by a
  // parameterised tool at all. That is exactly why they need checking: a fixed cap with
  // an invented remedy is the same defect as defect 1, pointing the other way.

  it('the traceback cap states it is fixed, and only says get_system_stats (action:"logs") MAY have the rest', () => {
    const err = extractExecutionError({
      status: {
        messages: [
          [
            "execution_error",
            {
              node_id: "3",
              node_type: "KSampler",
              exception_message: "boom",
              traceback: ["Traceback\n", "x".repeat(TRACEBACK_MAX_CHARS + 500)],
            },
          ],
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const tb = err?.traceback ?? "";
    expect(err?.traceback_truncated).toBe(true);
    expect(tb).toContain(`fixed ${TRACEBACK_MAX_CHARS}-char traceback cap`);
    expect(tb).toContain("no parameter raises it");
    // A Python traceback prints the exception LAST, so the cut end is the useful end —
    // the marker has to say that or the reader trusts a head that names nothing.
    expect(tb).toMatch(/final exception line is likely among the cut frames/);
    // "may still hold" — never a promise. Nothing re-serves the /history traceback.
    expect(tb).toMatch(/get_system_stats \(action:"logs"\) may still hold/);
    expect(tb).not.toMatch(/read the full traceback with/);
  });

  it('the crash-block cap states it is fixed and does not promise get_system_stats (action:"logs") has the rest', () => {
    const head = "Windows fatal exception: access violation\n";
    const r = parseCrashBlock(head + "F".repeat(9000));
    expect(r.fatal).toBe(true);
    expect(r.block).toContain("crash-block cap");
    expect(r.block).toContain("no parameter raises it");
    expect(r.block).toMatch(/get_system_stats \(action:"logs"\) may still hold/);
  });

  it("does not claim full coverage when the outline REFUSED to render", async () => {
    // `degraded` covers two opposite outcomes. On "refused" the panel returned NO
    // outline, so "still covers ALL 690 nodes" would describe content the reader cannot
    // see — the same lie as a silent cut, wearing the opposite hat (codex gate).
    const payload = await runPanelTool(
      "panel_graph_outline",
      { max_chars: 500 },
      { node_count: 690, group_count: 12, degraded: true, detail_level: "refused", outline: "⚠" },
    );
    const hint = payload.truncation_hint as string;
    expect(hint).toMatch(/NO outline was returned/);
    expect(hint).not.toMatch(/still covers ALL/);
    expect(hint).toMatch(/690 node\(s\)/);
    expect(hint).toMatch(/withheld because it would read as complete/);
    assertRemedyIsActionable("panel_graph_outline", "panel_graph_outline refusal", hint);
  });

  it("says so when the panel is too old to honour the max_chars it was sent", async () => {
    // The orchestrator ships ahead of the panel. An older build ignores the budget and
    // returns the full outline, so the bound this tool ADVERTISES silently did not apply
    // — and an unbounded reply would otherwise read as "this fitted" (codex gate).
    const legacy = await runPanelTool(
      "panel_graph_outline",
      { max_chars: 4000 },
      { node_count: 690, group_count: 12, outline: "…" }, // no max_chars echoed back
    );
    const hint = legacy.max_chars_hint as string;
    expect(typeof hint).toBe("string");
    expect(hint).toMatch(/does not support `max_chars`/);
    expect(hint).toMatch(/was NOT applied/);
    expect(hint).toMatch(/690 node\(s\)/);
    // The synthetic flag is plumbing and must never reach the caller.
    expect(legacy.__budget_ignored).toBeUndefined();
    assertRemedyIsActionable("panel_graph_outline", "panel_graph_outline legacy", hint);

    // A current panel echoes the budget back, so the rider stays silent.
    const current = await runPanelTool(
      "panel_graph_outline",
      { max_chars: 4000 },
      { node_count: 690, group_count: 12, outline: "…", max_chars: 4000 },
    );
    expect(current.max_chars_hint).toBeUndefined();

    // And it stays silent when the caller never asked for a budget.
    const noArg = await runPanelTool("panel_graph_outline", {}, { node_count: 3, outline: "…" });
    expect(noArg.max_chars_hint).toBeUndefined();
  });

  it("does not tell the caller to raise a budget that could never hold the outline", async () => {
    // A graph whose group-level floor exceeds the CEILING cannot be outlined at any
    // accepted budget. "Raise max_chars to 60000" there is a guaranteed second refusal.
    const payload = await runPanelTool(
      "panel_graph_outline",
      { max_chars: 500 },
      {
        node_count: 20000,
        group_count: 300,
        degraded: true,
        detail_level: "refused",
        floor_chars: 100_000,
        max_chars: 500,
        outline: "⚠",
      },
    );
    const hint = payload.truncation_hint as string;
    expect(hint).toMatch(/raising it will NOT produce an outline/);
    expect(hint).not.toMatch(/Raise `max_chars` \(up to/);
    expect(hint).toMatch(/panel_query_graph/);
  });

  it("does not promise a raise will work when the panel cannot say whether it would", async () => {
    // The panel revision between "accepts max_chars" and "reports floor_chars" refuses
    // without saying how big the floor is. Treating UNKNOWN as reachable is what produced
    // the dead retry: on a graph whose floor exceeds the ceiling, "raise to 60000" must
    // refuse again (codex gate).
    const payload = await runPanelTool(
      "panel_graph_outline",
      { max_chars: 500 },
      {
        node_count: 20000,
        group_count: 300,
        degraded: true,
        detail_level: "refused",
        max_chars: 500, // budget-aware…
        outline: "⚠", // …but no floor_chars
      },
    );
    const hint = payload.truncation_hint as string;
    expect(hint).toMatch(/does not report how large the smallest form would be/);
    expect(hint).toMatch(/MAY still refuse/);
    expect(hint).toMatch(/panel_query_graph/);
    // It must NOT read as an assurance that the retry succeeds.
    expect(hint).not.toMatch(/Raise `max_chars` \(up to \d+\) for more detail/);
    assertRemedyIsActionable("panel_graph_outline", "panel_graph_outline unknown floor", hint);
  });

  it("does not offer a follow-up as if it could return everything", () => {
    // panel_query_graph clamps `limit` at 200 and has no cursor, so on a >200-node
    // subgraph it reads MORE, not all. Saying "to read the rest" overpromised.
    const d = buildPanelToolDefs().find((t) => t.name === "panel_get_subgraph");
    const handlerSrc = String(d!.handler);
    expect(handlerSrc).toContain("max 200");
    expect(handlerSrc).toContain("no cursor");
    expect(handlerSrc).not.toContain("To read the rest");
  });

  it("no longer advertises groups/rails as riding outside the max_chars accounting", () => {
    // #807 folded them in, so the #809-era disclosure would now be false. A budget the
    // description says covers only `text` sends a caller lowering max_chars looking for
    // a second knob that no longer exists.
    const d = buildPanelToolDefs().find((t) => t.name === "panel_query_graph");
    expect(d!.description).not.toMatch(/bounds the `text` field ONLY/);
    expect(d!.description).toMatch(/`max_chars` bounds the WHOLE result/);
  });

  it("#807 — every note the whole-reply budget emits names a real lever of this tool", async () => {
    // The budget accounting added for #807 emits four new strings, and each of them is a
    // remedy in exactly the sense this file polices. They go through the SAME schema-driven
    // check as everything else, so a note that backticks a RESPONSE FIELD (`node_ids`,
    // `groups`) as though it were a parameter, or points at a tool that is not registered,
    // fails here rather than costing a caller a round trip.
    const groups = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      title: `REGION ${i}`,
      color: "#333",
      bounding: [0, 0, 100, 100],
      node_count: 200,
      node_ids: Array.from({ length: 200 }, (_, n) => i * 1000 + n),
    }));
    const base = { total: 690, matched: 1, shown: 1, truncated: false, text: "#42 KSampler" };

    for (const [where, args, reply] of [
      // Membership shed, with a raise that WOULD fit.
      ["membership", { max_chars: 4000 }, { ...base, groups: groups.slice(0, 6) }],
      // Group index shed, with a raise that could never fit.
      ["index", { max_chars: 1500 }, { ...base, groups }],
      // Caller already at the ceiling.
      ["ceiling", { max_chars: 60000 }, { ...base, groups }],
      // Rails shed and the reply still over the bound.
      ["rails", { max_chars: 500 }, { ...base, groups, rails: { input: { id: -10 } } }],
    ] as Array<[string, Record<string, unknown>, Record<string, unknown>]>) {
      const payload = await runPanelTool("panel_query_graph", args, reply);
      const notes = [
        payload.groups_membership_omitted,
        payload.groups_omitted,
        payload.rails_omitted,
        payload.budget_overrun,
      ].filter((n): n is string => typeof n === "string");
      expect(notes.length, `${where}: the budget shed content without saying so`).toBeGreaterThan(0);
      for (const note of notes) {
        assertRemedyIsActionable("panel_query_graph", `panel_query_graph #807 (${where})`, note);
      }
    }
  });

  it("never clobbers a hint the panel itself supplied", async () => {
    const payload = await runPanelTool(
      "panel_find_nodes",
      { query: "x" },
      { truncated: true, count: 40, matches: [], truncation_hint: "panel-supplied" },
    );
    expect(payload.truncation_hint).toBe("panel-supplied");
  });
});
