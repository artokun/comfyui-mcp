import { DEFERRED_PANEL_TOOLS_NOTE } from "../deferred-panel-tools.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ComfyUIError, errorToToolResult } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { CatalogedTool, ToolCatalog } from "./catalog.js";
import { retiredToolMessage } from "./vocabulary.js";

/** First sentence of a tool description, hard-capped so the manifest stays token-light. */
export function summarize(description: string, maxLen = 160): string {
  const firstSentence = description.split(/(?<=\.)\s+/, 1)[0] ?? description;
  const line = firstSentence.replace(/\s+/g, " ").trim();
  return line.length <= maxLen ? line : `${line.slice(0, maxLen - 1).trimEnd()}…`;
}

function text(s: string): CallToolResult {
  return { content: [{ type: "text", text: s }] };
}

function errorText(s: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: s }] };
}

function inputJsonSchema(tool: CatalogedTool): Record<string, unknown> | undefined {
  if (!tool.schema || Object.keys(tool.schema).length === 0) return undefined;
  const json = z.toJSONSchema(z.object(tool.schema), {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete json.$schema; // noise for an LLM reader
  return json;
}

/** Searchable corpus for one tool: name, description, and the parameter
 *  names + descriptions — so a search like "checkpoint" also finds tools
 *  whose relevance only shows in their arguments (e.g. list_local_models). */
function searchCorpus(tool: CatalogedTool): string {
  const params = Object.entries(tool.schema ?? {})
    .map(([key, schema]) => `${key} ${(schema as { description?: string }).description ?? ""}`)
    .join(" ");
  return normalizeForSearch(`${tool.name} ${tool.description} ${params}`);
}

/**
 * #1525 — fold the separators that only exist because tool names are identifiers.
 *
 * `list_tools search:"download model"` returned ONLY `runpod`, which reads as a
 * broken index. It was doing exactly what it was told: matching the literal
 * phrase. `download_model` is spelled with an UNDERSCORE, so the phrase never
 * occurred in it, while runpod's prose happens to contain "download model" as
 * ordinary English — so the one tool the caller obviously wanted was the one tool
 * excluded, and the only tool returned was the coincidence.
 *
 * Underscores and hyphens become spaces on BOTH sides, so a caller may type a
 * tool's name the way they say it.
 *
 * DOTS AND SLASHES ARE LEFT ALONE, deliberately. Folding them bought nothing —
 * no tool name contains one — while costing literal queries their meaning: `v1.2`
 * would split into `v1` + `2` and `foo/bar` into `foo` + `bar`, each fragment
 * then matching anywhere, so a precise version or path search would return
 * unrelated tools (codex). The separators worth folding are exactly the ones that
 * exist because names are identifiers.
 */
function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Every term must appear, in any order and anywhere in the corpus.
 *
 * Wider than the phrase match it replaces: a single term behaves identically, and
 * a multi-word query no longer demands the words be adjacent in that order.
 *
 * NOTE that the name tier below IS narrowing, and I claimed otherwise (codex).
 * `search:"download model"` used to return `runpod` and now does not. That is a
 * deliberate ranking policy, not preservation, and calling it "strictly wider"
 * was simply wrong. The footer says so when it happens, so a caller can see that
 * results were chosen by name rather than drawn from everything that matched.
 */
function matchesSearch(corpus: string, terms: readonly string[]): boolean {
  return terms.every((term) => corpus.includes(term));
}

export function buildManifest(
  catalog: ToolCatalog,
  opts: { category?: string; search?: string } = {},
): string {
  // #1525 — split into TERMS rather than matching the raw phrase.
  //
  // A whitespace-only search is treated as no search. That is a CHANGE, not a
  // preservation (codex): it used to be a literal `includes("   ")`, which
  // matched nothing and returned "No tools matched". Showing the catalog is the
  // better answer, but it is a different one.
  const terms = opts.search ? normalizeForSearch(opts.search).split(" ").filter(Boolean) : [];
  // #1525 — NAME MATCHES WIN, when there are any.
  //
  // Matching every term across name + description + parameter docs is what makes
  // `download_model` findable at all, but on the real 37-tool surface it is barely
  // a filter: "install node" hit 19 tools, because "install" and "node" are
  // ordinary words in a dozen descriptions. The reporter's complaint was not only
  // that their tool was missing — it was that the filtered view "is misleading and
  // forces a full-catalog workaround". A result set of 19 does that too.
  //
  // So: if any tool's NAME carries every term, the answer is those tools. Nobody
  // typing "download model" wants the nine tools that merely mention downloading
  // models. When no name matches — "checkpoint", "liveness" — this tier is inert
  // and the corpus search answers, which is the case that made the corpus search
  // worth having.
  //
  // NOT "exactly as before" there either (codex): the corpus search is now
  // term-based, so it finds strictly more than the old phrase match. `run memory`
  // matches `clear_vram` — terms far apart, in neither order — where the phrase
  // search found nothing.
  //
  // Scoped to the CATEGORY when one is given. Computing it over the whole catalog
  // meant `{category:"models", search:"install node"}` found `install_custom_node`
  // in a different category, then displayed nothing at all from `models` — a name
  // tier suppressing the corpus results inside the very category the caller asked
  // to browse. Within a category the question is "which of THESE", so the tier is
  // answered from the same set the loop will show.
  const inScope = [...catalog.tools.values()].filter(
    (t) => !opts.category || t.category === opts.category,
  );
  const nameMatches = terms.length
    ? inScope.filter((t) => matchesSearch(normalizeForSearch(t.name), terms))
    : [];
  const byName = new Set(nameMatches.map((t) => t.name));
  const lines: string[] = [];
  let shown = 0;
  for (const [category, tools] of catalog.byCategory()) {
    if (opts.category && category !== opts.category) continue;
    const matching = terms.length
      ? tools.filter((t) => (byName.size ? byName.has(t.name) : matchesSearch(searchCorpus(t), terms)))
      : tools;
    if (matching.length === 0) continue;
    lines.push("", `## ${category} (${matching.length})`);
    for (const t of matching) {
      lines.push(`- ${t.name}: ${summarize(t.description)}`);
      shown++;
    }
  }
  if (shown === 0) {
    const cats = [...catalog.byCategory().keys()].join(", ");
    return `No tools matched (category=${opts.category ?? "any"}, search=${opts.search ?? "none"}). Categories: ${cats}`;
  }
  // `terms.length`, not raw `opts.search` (codex). A whitespace-only search
  // filters nothing, and stamping "(filtered)" on a complete catalog tells the
  // caller something untrue about what they are looking at — while the source
  // comment two lines away claimed such a search was treated as no search at all.
  // The behaviour was right; only this line disagreed with it.
  const filtered = Boolean(opts.category) || terms.length > 0;
  const header =
    `comfyui-mcp tool catalog — ${shown} of ${catalog.tools.size} tools` +
    (filtered ? " (filtered)" : "") +
    ". Workflow: pick a tool → describe_tool {\"name\": ...} for its parameters → call_tool {\"name\": ..., \"args\": {...}}.";
  // #1525 — DISCLOSE the name tier when it did the selecting (codex). Results
  // chosen by name are not "everything that matched", and a caller who cannot
  // tell the difference will read a short list as the whole answer. Counted
  // rather than asserted: this is how many tools the corpus search WOULD have
  // returned and this view is not showing.
  const suppressed = byName.size
    ? inScope.filter((t) => !byName.has(t.name) && matchesSearch(searchCorpus(t), terms)).length
    : 0;
  // WORDING, not the count (codex). The count is right: `suppressed` is exactly
  // what the corpus search would have returned and this view is withholding. But
  // saying those tools match "in their description or parameters" claims WHERE
  // they matched, and the corpus includes the name — `download_asset` described
  // as "handles model files" takes one term from each, so the claim is false for
  // it while the count is still correct. The note now says only what it knows.
  const tierNote = suppressed
    ? ` Showing tools whose NAME matches; ${suppressed} other tool(s) also match this search — search a distinctive word from one to see them.`
    : "";
  const footer =
    filtered && shown < catalog.tools.size
      ? `\n\nThis is a FILTERED view (${catalog.tools.size - shown} tools hidden).${tierNote} If nothing here fits the task, call list_tools again with a broader search or no filter.`
      : "";
  return header + lines.join("\n") + footer;
}

/**
 * Compact tool mode — the DEFAULT registration (since #667; --full /
 * COMFYUI_MCP_TOOL_MODE=full opts out): registers exactly three meta-tools
 * backed by the captured catalog, instead of the full ~200-tool surface.
 * Built for small/local models (Hermes Agent, Ollama, any MCP client on a
 * non-frontier LLM) where 200 JSON schemas blow the context budget — see
 * issue #97 — and the right default everywhere: the full surface costs a
 * client ~200KB (~50k tokens) per tools/list.
 */
export function registerCompactTools(
  server: McpServer,
  catalog: ToolCatalog,
  opts: { skip?: ReadonlySet<string> } = {},
): void {
  // A caller may reserve some meta-tool names — e.g. registerFullTools layers the
  // facade onto the full direct surface, and if the user has an autoloaded
  // workflow literally named `call_tool`/`list_tools`/`describe_tool`, that name
  // is ALREADY registered on the live server; re-registering it here would throw
  // (McpServer rejects duplicate tool names) and take down startup. `skip`
  // dedups the EXPECTED collisions the caller detected. The try/catch is the
  // belt-and-suspenders: collision detection relies on a catalog snapshot that
  // could, in a startup race, disagree with what's actually on the live server
  // (a workflow file removed between the two discovery passes), so a duplicate
  // that slips past `skip` is swallowed and logged rather than crashing startup.
  // In every collision case the FIRST registration (the user's direct tool)
  // keeps the name; the rest of the facade still registers. (#616)
  const skip = opts.skip ?? new Set<string>();
  const register: McpServer["tool"] = ((...args: Parameters<McpServer["tool"]>) => {
    const name = args[0] as string;
    if (skip.has(name)) return undefined as unknown as ReturnType<McpServer["tool"]>;
    try {
      return server.tool(...args);
    } catch (err) {
      logger.warn(
        `[compact] skipping facade meta-tool '${name}' — already registered (name collision): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined as unknown as ReturnType<McpServer["tool"]>;
    }
  }) as McpServer["tool"];
  const listToolsSchema = {
    category: z
      .string()
      .optional()
      .describe("Only list this category (as shown in the catalog headings)."),
    search: z
      .string()
      .optional()
      .describe("Case-insensitive substring filter over tool names and descriptions."),
  };
  const describeToolSchema = {
    name: z.string().optional().describe("Exact tool name from list_tools."),
    tool_name: z.string().optional().describe("Alias for name."),
  };
  const describeTool = (params: { name?: string; tool_name?: string }): CallToolResult => {
    const name = params.name ?? params.tool_name;
    if (!name) return errorText('Missing tool name. Call as: describe_tool {"name": "<tool>"}');
    const tool = catalog.get(name);
    if (!tool) return errorText(unknownToolMessage(catalog, name));
    const schema = inputJsonSchema(tool);
    const sections = [
      `# ${tool.name}  (category: ${tool.category})`,
      "",
      tool.description,
      "",
      schema
        ? `Parameters (JSON Schema):\n${JSON.stringify(schema, null, 1)}`
        : "Parameters: none.",
      "",
      `Run it with: call_tool {"name": "${tool.name}", "args": ${schema ? "{...}" : "{}"}}`,
    ];
    return text(sections.join("\n"));
  };
  register(
    "list_tools",
    "List every comfyui-mcp capability as a token-light catalog: tool names with one-line summaries, grouped by category. Start here. Then use describe_tool to get a tool's parameters and call_tool to run it.",
    listToolsSchema,
    async (args) => text(buildManifest(catalog, args)),
  );

  register(
    "describe_tool",
    "Get the full description and JSON Schema of one tool from the catalog. Always call this before the first call_tool of a tool you haven't used in this session.",
    describeToolSchema,
    async (params) => describeTool(params),
  );

  register(
    "call_tool",
    "Execute a tool from the catalog by name. Pass its parameters in `args` (object). The result is exactly what the underlying tool returns.",
    {
      // Everything is optional and loosely typed on purpose: small models
      // frequently alias field names or mis-type values, and an SDK-level
      // -32602 gives them nothing to correct from. We validate inside the
      // handler instead, where errors can carry the expected schema.
      name: z.string().optional().describe("Exact tool name from list_tools."),
      tool_name: z.string().optional().describe("Alias for name."),
      args: z
        .unknown()
        .optional()
        .describe(
          "The tool's parameters as an object matching its describe_tool schema. A JSON-encoded string is also accepted. Omit for tools without parameters.",
        ),
      arguments: z.unknown().optional().describe("Alias for args."),
      // #1824 — ChatGPT's multi_tool_use.parallel wrapper names its payload
      // `parameters`. After the first call_tool in a batch the model often
      // copies that key inward instead of `args`, and Zod would strip the
      // unknown field so the inner tool saw an empty object (`action` missing).
      parameters: z.unknown().optional().describe("Alias for args."),
    },
    async (params) => {
      const name = params.name ?? params.tool_name;
      if (!name) {
        return errorText('Missing tool name. Call as: call_tool {"name": "<tool>", "args": {...}}');
      }
      const tool = catalog.get(name);
      // #693 — a client can retain the stable call_tool binding while its direct
      // describe_tool/list_tools bindings are stale after a reconnect. The manifest
      // itself tells that client to describe a tool before calling it, so route those
      // two facade control-plane operations through call_tool too. Do this ONLY when
      // the catalog has no direct tool under the same name: in full mode a user
      // workflow may legitimately claim a reserved name and win the direct registry.
      const facadeMeta = !tool && (name === "list_tools" || name === "describe_tool") ? name : null;
      if (!tool && !facadeMeta) return errorText(unknownToolMessage(catalog, name));

      const args = params.args ?? params.arguments ?? params.parameters;
      let rawArgs: Record<string, unknown> = {};
      if (typeof args === "string") {
        if (args.trim()) {
          try {
            const parsed: unknown = JSON.parse(args);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              return errorText(`args must be a JSON object, got: ${args.slice(0, 200)}`);
            }
            rawArgs = parsed as Record<string, unknown>;
          } catch {
            return errorText(`args is not valid JSON: ${args.slice(0, 200)}`);
          }
        }
      } else if (Array.isArray(args)) {
        return errorText(
          `args must be a JSON object keyed by parameter name, not an array. Use describe_tool {"name": "${name}"} to see the schema.`,
        );
      } else if (args !== undefined && args !== null) {
        if (typeof args !== "object") {
          return errorText(
            `args must be a JSON object, got ${typeof args}. Use describe_tool {"name": "${name}"} to see the schema.`,
          );
        }
        rawArgs = args as Record<string, unknown>;
      }

      if (facadeMeta === "list_tools") {
        const parsed = z.object(listToolsSchema).safeParse(rawArgs);
        if (!parsed.success) return errorText(`Invalid arguments for list_tools: ${parsed.error.message}`);
        return text(buildManifest(catalog, parsed.data));
      }
      if (facadeMeta === "describe_tool") {
        const parsed = z.object(describeToolSchema).safeParse(rawArgs);
        if (!parsed.success) return errorText(`Invalid arguments for describe_tool: ${parsed.error.message}`);
        return describeTool(parsed.data);
      }

      // The only catalog-less names above returned through facadeMeta, so the
      // remaining branch always has a concrete application tool to validate.
      if (!tool) return errorText(unknownToolMessage(catalog, name));

      const validated = z.object(tool.schema ?? {}).safeParse(rawArgs);
      if (!validated.success) {
        const issues = validated.error.issues
          .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n");
        const schema = inputJsonSchema(tool);
        return errorText(
          `Invalid arguments for ${name}:\n${issues}\n\nExpected schema:\n${JSON.stringify(schema ?? {}, null, 1)}`,
        );
      }

      try {
        return await tool.handler(validated.data as Record<string, unknown>);
      } catch (err) {
        return errorToToolResult(contextualizeBareParseError(err, name));
      }
    },
  );
}

/**
 * A BACKSTOP for a bare `JSON.parse` message reaching a caller (#1160).
 *
 * The repo's own request paths classify this properly: readComfyJson names the
 * URL, status, content type and body prefix; `/upload/image` and `/view` both
 * report a non-OK status before parsing; the argument parser above catches its
 * own JSON.parse. Every one of those was checked against this report and none of
 * them is the source.
 *
 * A reporter on an AUTHENTICATED remote still got `Unexpected end of JSON input`
 * from `upload_image` AND `get_image` — identical text from two different
 * endpoints, which points at a layer below all of that (the ComfyUI client
 * library's own fetch, or an auth proxy answering somewhere the guards do not
 * reach). Without their server I cannot say which.
 *
 * What I can say is that the message is useless wherever it comes from: it names
 * no endpoint, no status, and — for an upload — does not say whether the POST was
 * delivered. So this catches the shape at the one choke point every compact call
 * passes through and attaches what IS known: the tool, and the fact that a POST's
 * outcome is undetermined.
 *
 * Deliberately narrow. Only a bare `SyntaxError` whose message is one of V8's
 * JSON-parse forms is rewritten, and the original text is kept at the front so
 * anything matching on it still matches. A properly classified error (a
 * NonJsonResponseError, a ComfyUIError) passes through untouched — this must not
 * paper over the diagnostics that already work.
 */
export function contextualizeBareParseError(err: unknown, toolName: string): unknown {
  if (!(err instanceof SyntaxError)) return err;
  const msg = err.message ?? "";
  const isJsonParse =
    /^Unexpected end of JSON input$/.test(msg) ||
    /^Unexpected (?:token|non-whitespace character).*JSON/i.test(msg) ||
    /^JSON\.parse:/.test(msg);
  if (!isJsonParse) return err;
  return new ComfyUIError(
    `${msg} — while running ${toolName}. A JSON response could not be parsed and the ` +
      `failure escaped without naming the endpoint, so this is NOT a problem with your ` +
      `arguments. The usual cause is something other than ComfyUI answering the request: ` +
      `an auth gate or proxy returning an empty body, a login page, or a redirect. Check ` +
      `that the configured COMFYUI_URL is reachable WITHOUT a browser session — a panel ` +
      `that works proves the browser is authenticated, not that this server is. ` +
      `get_system_stats (action:"health") exercises the same path and reports the status. ` +
      `IMPORTANT: if ${toolName} sends data (an upload), the request may or may not have ` +
      `been delivered — verify before retrying rather than assuming nothing happened.`,
    "NON_JSON_RESPONSE",
    { tool: toolName, original: msg },
  );
}

/**
 * `panel_…`, optionally behind a client's `mcp__<server>__` namespacing — which is
 * how tool names appear in agent transcripts and skill files.
 *
 * The namespace part is `[A-Za-z0-9_]+` and nothing else, deliberately: this is the
 * SAME form `deadNameRe`/`findDeadName` accept in vocabulary.ts, and the two have to
 * agree or a name could get the panel-surface answer while the retirement ledger
 * declined to recognise it (or the reverse). So a namespace carrying any other
 * character — a hyphenated server label, say — matches neither, and falls through to
 * the fuzzy unknown-tool path. That is a real gap rather than a claimed guarantee,
 * and it is written down here so the next reader does not assume coverage this
 * pattern does not have.
 */
const PANEL_NAMESPACE_RE = /^(?:mcp__[A-Za-z0-9_]+__)?panel_/;

/**
 * The answer for a `panel_*` name, which is NOT the same question as "does this
 * tool exist".
 *
 * The panel_* live-canvas tools are registered by a DIFFERENT server — the
 * orchestrator's per-tab surface (registerPanelTools / startPanelMcpHttpServer),
 * never by this one. So this catalog's silence about `panel_graph_outline` says
 * nothing whatsoever about whether that tool exists; it only says this server
 * does not serve it. The bare "Unknown tool 'panel_graph_outline'." that used to
 * come back is the #804 defect in miniature: a tool the caller could not SEE,
 * narrated as a tool that does not EXIST — and a model that reads it that way
 * tells the user the capability is missing, which is false and sends them to
 * reinstall something that is already fine.
 *
 * This path is reachable through our own prose, not just through a model's
 * imagination: `visualize_workflow`'s render and render_hierarchical actions
 * both tell the reader to "use panel_graph_outline instead" for the live canvas, and
 * the bundled plugin's debug-render / director skills name panel_* tools too —
 * all of which an outside MCP client reads while holding none of them (#784, same
 * family: recovery guidance naming a tool the caller cannot invoke).
 *
 * What this message must NOT do is replace one asserted cause with another. The
 * test is only a PREFIX, so four separate things stay deliberately unclaimed:
 *
 *  - whether `name` is a real panel tool at all. `panel_typo` reaches here too,
 *    and the namespace fact is true of it while "it exists elsewhere" is not.
 *  - that NO `panel_`-prefixed tool can be on this surface. An autoloaded workflow
 *    file (registerAutoloadedWorkflows) is registered under its slugified filename,
 *    so `panel_custom.json` really is a `panel_custom` tool here — this patch's own
 *    test proves it. An earlier draft said the prefix "is not this server's to
 *    serve", which that same test disproves, and an absolute a colleague can falsify
 *    from the diff is exactly the overclaim this change exists to remove. So the
 *    sentence is now DERIVED: the catalog is asked what `panel_` names it actually
 *    holds, and the message says only what the answer supports.
 *  - which surfaces the caller holds. From inside this catalog a panel-hosted
 *    session and an outside client are indistinguishable, so both are addressed.
 *  - HOW the caller would reach the panel surface if it has one. Not every host
 *    exposes the panel tools by their own names: the Ollama backend advertises a
 *    three-tool panel router (panel_list_tools / panel_describe_tool /
 *    panel_call_tool) instead, so "call it directly" would be wrong advice there.
 *    The caller's own tool list is the authority, and it is the one thing the
 *    caller can read and we cannot.
 *  - that the sidebar's agent necessarily holds these tools. It usually does, but
 *    the `pi` backend has no MCP client at all (see pi-backend.ts) and therefore
 *    gets no ComfyUI tools whatever is installed — so that fallback is stated
 *    with its condition rather than as a guarantee.
 */
function panelNamespaceMessage(catalog: ToolCatalog, name: string): string {
  // Derived, not asserted — and scoped to the ONE thing it is derived from.
  //
  // The claim is about THIS CATALOG, never about "this server", because in full mode
  // the facade's catalog comes from a SECOND workflow discovery pass (see
  // registerFullTools) and the two can legitimately disagree for a moment: a
  // workflow file removed between the passes stays directly registered on the live
  // server while being absent here. "This server serves no panel_ names" would be
  // false in exactly that window. "This catalog holds none" is what was measured,
  // and it is also the only thing that matters to the caller, since call_tool
  // dispatches through this catalog and nothing else.
  const localPanelTools = [...catalog.tools.keys()].filter((n) => n.startsWith("panel_"));
  const localNote = localPanelTools.length
    ? `This catalog does hold ${localPanelTools.length} name(s) under \`panel_\` — ` +
      `${localPanelTools.slice(0, 5).join(", ")}${localPanelTools.length > 5 ? ", …" : ""} ` +
      `(autoloaded workflow files take their tool name from their filename) — but '${name}' is not among them. ` +
      "The LIVE-CANVAS panel_* tools are a different thing entirely: they are served "
    : "This catalog holds no `panel_` names at all: that prefix is the live-canvas surface, served ";
  return (
    `Unknown tool '${name}' — no tool by that name is in THIS server's call_tool catalog. ` +
    localNote +
    "separately by the ComfyUI sidebar panel's own per-tab MCP server. So this answers WHICH " +
    `SURFACE you reached, and says nothing about whether '${name}' exists. This server cannot ` +
    "see what else your client holds, so check the tool list your client gave you. " +
    `If it offers ${name}, or a panel router such as panel_call_tool, go that way — call_tool ` +
    "dispatches only within this server's own catalog and can never reach the panel surface. " +
    // #1353 — SEARCHING ONLY THE DIRECT DECLARATIONS PRODUCES A FALSE NEGATIVE.
    //
    // On a code-mode client (the Codex backend) the panel tools are DEFERRED: they
    // live in the `ALL_TOOLS` catalog under an `mcp__panel__` prefix, so a scan for a
    // bare `panel_` prefix among direct declarations finds nothing while the panel MCP
    // endpoint is answering tools/list with 91 tools. A reporter followed the sentence
    // below literally and declared the live-canvas tools missing, repeatedly, with no
    // transport error anywhere — the failure was entirely this instruction.
    //
    // So the absence test has to name both the prefix and the deferred catalog before
    // it is allowed to conclude anything.
    // Shared with the INJECTED steering (#1398): two surfaces phrasing this in their
    // own words is how one ends up a version behind the other.
    `BEFORE concluding they are absent: ${DEFERRED_PANEL_TOOLS_NOTE} Only when BOTH the ` +
    "direct declarations and the deferred catalog have nothing matching `panel_` is there " +
    "no live-canvas route from here: read the " +
    "workflow from disk instead (get_workflow, whose list/get/analyze/query actions read saved files), " +
    "or ask the user to make the request from the Agent tab in the ComfyUI sidebar, on a backend " +
    "that has ComfyUI tools (the pi backend has no MCP client and so has none)."
  );
}

function unknownToolMessage(catalog: ToolCatalog, name: string): string {
  // A name in the retirement ledger gets a specific answer — which version
  // removed it and what to call instead (#659). Exact matches only: partial
  // names still get the fuzzy suggestions below.
  //
  // Checked BEFORE the panel namespace, because the ledger holds retired panel_*
  // names too and has a strictly better answer for them — a named live replacement
  // — than "wrong surface" does. Answering "ask the panel agent" for a name no
  // panel agent serves either would send the caller to a second dead end.
  const retired = retiredToolMessage(name);
  if (retired) return retired;
  // The namespace answer is only correct when the name is not ALSO a real tool on
  // this surface under its bare form. `catalog.get()` above is an exact lookup, so
  // a client that namespaces its calls (`mcp__comfyui__panel_custom`) misses an
  // autoloaded `panel_custom` workflow and would land here — where "that prefix
  // belongs to another server" is exactly the wrong thing to say about a tool this
  // server does serve. Fall through to the fuzzy path instead, which suggests the
  // bare name (the behaviour every other namespaced live tool already gets).
  const bare = name.replace(/^mcp__[A-Za-z0-9_]+__/, "");
  if (PANEL_NAMESPACE_RE.test(name) && !catalog.get(bare)) return panelNamespaceMessage(catalog, name);
  const needle = name.toLowerCase();
  const close = [...catalog.tools.keys()]
    .filter((n) => n.includes(needle) || needle.includes(n))
    .slice(0, 5);
  return (
    `Unknown tool '${name}'.` +
    (close.length ? ` Did you mean: ${close.join(", ")}?` : "") +
    " Use list_tools to see the catalog."
  );
}
