/**
 * The retirement ledger, served on the DIRECT `tools/call` path.
 *
 * Consolidation rule 6 is that a retired tool name answers with a self-explaining
 * redirect — "Unknown tool 'X' — removed in 0.49.0. Call Y (action:"z") instead." —
 * rather than a bare 404. That is the whole reason retiring a high-traffic name is
 * acceptable: the caller is told, in the error, what to call next.
 *
 * Before this module, `retiredToolMessage()` was wired into exactly two call paths —
 * the `call_tool` facade (src/tools/compact.ts) and the Ollama backend's tool router
 * (src/orchestrator/ollama-backend.ts). Nothing served it on a direct MCP
 * `tools/call`, where the SDK's own handler answers `Tool <name> not found` and stops.
 * Measured on 0.49.0, full mode, against a name the 0.49.0 slices had already retired:
 *
 *   direct tools/call        → "Tool get_workspace not found"       ← bare 404
 *   call_tool (compact)      → the ledger redirect                  ← correct
 *   call_tool on full (#616) → the ledger redirect                  ← correct
 *
 * That gap is invisible today only because compact mode is the DEFAULT, so every
 * call goes through the facade. The 0.50.0 flip (#726) makes direct `tools/call` the
 * default path in the same release that retires 121 names, so rule 6 would break for
 * the entire surface at once. Hence this.
 *
 * ## Why this reaches into SDK internals
 *
 * @modelcontextprotocol/sdk offers no supported way to see or extend the `tools/call`
 * dispatch it installs. Everything else was considered first:
 *
 *  - `setRequestHandler(CallToolRequestSchema, …)` BEFORE registering any tool: the
 *    SDK's `setToolRequestHandlers()` calls `assertCanSetRequestHandler('tools/call')`
 *    and throws if a handler already exists, so registration itself would fail.
 *  - `fallbackRequestHandler`: only consulted when NO handler exists for a method.
 *    `tools/call` always has one, so it is never reached.
 *  - Registering each dead name as a real tool: they would appear in `tools/list`,
 *    which is precisely what the consolidation removes. Registering them disabled
 *    short-circuits with "Tool X disabled" before the handler runs.
 *  - Wrapping the transport's `onmessage`: means fabricating JSON-RPC frames outside
 *    the Protocol's request bookkeeping, at every connect site. Strictly worse.
 *
 * So we capture the handler the SDK installed and put a wrapper in front of it. The
 * wrapper is additive: for any name that is registered, or that the ledger does not
 * know, it delegates to the original handler with the same request object, and the
 * SDK's behaviour — argument validation, disabled tools, task augmentation, output
 * validation, its own "not found" for a genuinely unknown name — is untouched.
 *
 * ## The failure mode this module is built around
 *
 * `server.server._requestHandlers` and `server._registeredTools` are PRIVATE in SDK
 * 1.29.0. If a future SDK renames or reshapes either, the natural failure is that the
 * wrapper quietly stops intercepting — CI stays green, and every retired name silently
 * reverts to a bare 404. A fix that can turn itself off without saying so is worse
 * than no fix.
 *
 * Two things prevent it:
 *
 *  1. Every assumption is asserted at install time and named in the failure, including
 *     a POST-condition: after installing, the entry the dispatcher reads must actually
 *     be our wrapper. That is the one check that catches "setRequestHandler no longer
 *     writes to the map we captured from", which is the silent-no-op case a
 *     pre-condition check alone cannot see.
 *  2. `src/__tests__/tools/retired-redirect.test.ts` runs the install against a REAL
 *     McpServer and asserts it succeeds, so an SDK bump that breaks the capture fails
 *     CI on the bump's own PR, naming the field that moved.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ServerResult } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger.js";
import { DEAD_NAMES, retiredToolMessage } from "./vocabulary.js";

/** The JSON-RPC method whose dispatch we wrap. */
const CALL_TOOL = "tools/call";

/**
 * Raised when the SDK does not look the way this interception needs it to.
 *
 * Carries the specific assumption that failed, because "the redirect could not be
 * installed" is not actionable and "server.server._requestHandlers is not a Map —
 * @modelcontextprotocol/sdk internals changed" is.
 */
export class RetiredRedirectUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `Cannot install the retired-tool-name redirect on tools/call: ${detail}. ` +
        `This interception depends on @modelcontextprotocol/sdk internals ` +
        `(server.server._requestHandlers, server._registeredTools), which are private. ` +
        `package.json caps the SDK at the verified minor (~1.29.0) precisely so this ` +
        `cannot happen by resolution alone — see src/tools/retired-redirect.ts.`,
    );
    this.name = "RetiredRedirectUnavailableError";
  }
}

/** The private SDK shape we depend on, named so the checks below read as prose. */
interface SdkShape {
  /** Protocol._requestHandlers — the map `Protocol._onrequest` dispatches through. */
  handlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  /** The `tools/call` entry the SDK's `setToolRequestHandlers()` installed. */
  original: (request: unknown, extra: unknown) => Promise<unknown>;
  /** McpServer._registeredTools — the live registration table, keyed by tool name. */
  registered: Record<string, unknown>;
}

function inspect(server: McpServer): SdkShape {
  // `unknown` on purpose, here and for the registration table below: the SDK's
  // declared types are exactly what this function refuses to take on faith.
  const inner: unknown = server.server;
  if (!inner || typeof inner !== "object") {
    throw new RetiredRedirectUnavailableError("server.server is missing or not an object");
  }
  const handlers = (inner as { _requestHandlers?: unknown })._requestHandlers;
  if (!(handlers instanceof Map)) {
    throw new RetiredRedirectUnavailableError(
      `server.server._requestHandlers is ${handlers === undefined ? "missing" : "not a Map"}`,
    );
  }
  const original: unknown = handlers.get(CALL_TOOL);
  if (typeof original !== "function") {
    // Reachable by our own mistake as well as by an SDK change: the SDK installs the
    // tools/call handler LAZILY, on the first `server.tool()`. Calling this before any
    // tool is registered lands here, and saying so beats blaming the dependency.
    throw new RetiredRedirectUnavailableError(
      `server.server._requestHandlers has no '${CALL_TOOL}' function ` +
        `(the SDK installs it on the first tool registration — install this AFTER registering tools)`,
    );
  }
  // Bracket access is TypeScript's sanctioned way past a `private` member; the .d.ts
  // gives it no type, so the annotation keeps `any` from leaking out of this line.
  const registered: unknown = server["_registeredTools"];
  if (!registered || typeof registered !== "object" || Array.isArray(registered)) {
    throw new RetiredRedirectUnavailableError(
      `server._registeredTools is ${registered === undefined ? "missing" : "not a plain object"}`,
    );
  }
  if (Object.keys(registered).length === 0) {
    // Catches the one shape a `!registered` test cannot: the field still exists and is
    // still an object, but is not the table the SDK is filling. Treating that decoy as
    // the truth would mark every name unregistered and let the ledger shadow a live
    // tool — a wrong answer rather than a missing one.
    //
    // The honest caveat: an empty table alongside a live tools/call handler is not
    // strictly impossible. Registering a tool and then removing it again leaves exactly
    // this state, because the SDK never tears the handler back down. Nothing in this
    // repo does that, and both call sites install immediately after a registration
    // pass — and tryInstallRetiredNameRedirect degrades rather than throwing, so even
    // that unreachable case would cost a log line, not a startup.
    throw new RetiredRedirectUnavailableError(
      `server._registeredTools is empty although '${CALL_TOOL}' is already handled — ` +
        `the registration table is not where we are looking`,
    );
  }
  return {
    handlers: handlers as SdkShape["handlers"],
    original: original as SdkShape["original"],
    registered: registered as Record<string, unknown>,
  };
}

/**
 * Put the retirement ledger in front of the SDK's `tools/call` dispatch.
 *
 * Call AFTER the registration pass — the SDK installs its `tools/call` handler on the
 * first `server.tool()`, so there is nothing to capture before then — and BEFORE
 * `server.connect()`, so no request can arrive mid-swap.
 *
 * Throws `RetiredRedirectUnavailableError` if any assumption about the SDK fails, or if
 * the installed wrapper cannot be shown to actually answer. Production callers should
 * prefer {@link tryInstallRetiredNameRedirect}, which logs instead — see its comment
 * for why the runtime does not fail hard here.
 *
 * Async only because of the self-test at the end, which drives the installed handler
 * once. Nothing is in flight yet at that point: this runs before `server.connect()`.
 */
export async function installRetiredNameRedirect(server: McpServer): Promise<void> {
  const { handlers, original, registered } = inspect(server);

  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<ServerResult> => {
      const name = request.params.name;
      // A REGISTERED name always wins, even against the ledger. The two sets cannot
      // overlap today — registerAutoloadedWorkflows reserves DEAD_NAMES as well as
      // TOOL_NAMES, so a saved workflow file whose name slugifies onto a retired tool
      // is skipped rather than registered — but that is another module's invariant.
      // If it ever regresses, a live tool
      // must still run rather than be shadowed by a redirect telling its caller to go
      // somewhere else, which is a wrong answer rather than a missing one.
      //
      // `hasOwnProperty` rather than a truthiness test on the value: the table is a
      // plain object, so `registered['constructor']` is a function by inheritance and
      // `registered['toString']` is truthy. A tool named `constructor` is a legal MCP
      // tool name and an autoloaded `constructor.json` produces exactly that.
      if (!Object.prototype.hasOwnProperty.call(registered, name)) {
        const message = retiredToolMessage(name);
        if (message) {
          // Shaped like the SDK's own `createToolError` — a text block with
          // `isError: true` — so a client that already handles a failed tool call
          // handles this one identically, and reads the reason out of the same place.
          const result: CallToolResult = {
            isError: true,
            content: [{ type: "text", text: message }],
          };
          return result;
        }
      }
      // Everything else is the SDK's business, with the request object unchanged:
      // argument validation, disabled tools, task augmentation, output-schema
      // validation, and its own "Tool <name> not found" for a name the ledger does not
      // know. A made-up name is NOT a retired name and must not be told it was.
      return (await original(request, extra)) as ServerResult;
    },
  );

  // POST-CONDITION, and the point of the whole module. `setRequestHandler` is
  // documented to replace the handler for a method, but "replace" is only useful here
  // if it replaces the entry in the map we captured from and that `Protocol._onrequest`
  // dispatches through. If a future SDK routes registrations somewhere else, our
  // wrapper would be installed into a table nobody reads: every call would still reach
  // the SDK's handler, every retired name would 404, and nothing would say so.
  //
  // The cheap half — "the entry changed" — is only a smell test, and a misleading one.
  // It passes for ANY function that is not the original, so a future SDK that writes
  // some third thing into the slot would report the redirect as ACTIVE while this
  // wrapper never runs. That is the same false-acceptance shape the check exists to
  // prevent, one level up. It stays because it produces the clearest message for the
  // likeliest failure, but it does not decide anything.
  const installed = handlers.get(CALL_TOOL);
  if (typeof installed !== "function" || installed === original) {
    throw new RetiredRedirectUnavailableError(
      `setRequestHandler did not replace the '${CALL_TOOL}' entry in server.server._requestHandlers ` +
        `(it still holds ${installed === original ? "the SDK's original handler" : String(installed)}), ` +
        `so the wrapper would never run`,
    );
  }

  // What actually decides: DRIVE the installed entry and require the redirect back.
  // Identity is not assertable — `setRequestHandler` stores its own closure around our
  // handler, so the map never holds the function we wrote — and identity would be the
  // weaker question anyway. This asks the only one that matters: if the dispatcher
  // routes a retired name through what is now in that slot, does the ledger answer?
  // Any rename, re-route, or reshape that leaves the wrapper unreachable fails HERE,
  // whatever it did to the plumbing.
  //
  // The probe is side-effect-free by construction: it names a RETIRED tool that is not
  // registered, so the only two outcomes are our redirect (pass) or the SDK's
  // "not found" (fail). No tool handler runs either way.
  const probe = DEAD_NAMES.find((d) => !Object.prototype.hasOwnProperty.call(registered, d.name));
  if (!probe) {
    // Every retired name is also a live tool — impossible while the vocabulary gate and
    // registerAutoloadedWorkflows both hold, and it would make the whole ledger
    // unreachable anyway. Refuse rather than skip the self-test and claim success.
    throw new RetiredRedirectUnavailableError(
      `no retired name is available to self-test with — all ${DEAD_NAMES.length} are also registered tools`,
    );
  }
  const expected = retiredToolMessage(probe.name);
  let answered: unknown;
  try {
    answered = await installed(
      { method: CALL_TOOL, params: { name: probe.name, arguments: {} } },
      // `extra` is never dereferenced on the redirect path — the wrapper returns before
      // delegating — so a placeholder is honest here rather than a fake handshake.
      {} as never,
    );
  } catch (err) {
    throw new RetiredRedirectUnavailableError(
      `the installed '${CALL_TOOL}' handler threw on a self-test call for the retired name ` +
        `'${probe.name}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = (answered as CallToolResult | undefined)?.content
    ?.map((c) => (c.type === "text" ? c.text : ""))
    .join("");
  if (text !== expected) {
    throw new RetiredRedirectUnavailableError(
      `the installed '${CALL_TOOL}' handler did not serve the ledger for the retired name ` +
        `'${probe.name}' — expected ${JSON.stringify(expected)}, got ${JSON.stringify(text)}. ` +
        `Something other than this wrapper is answering tools/call`,
    );
  }
}

/**
 * {@link installRetiredNameRedirect}, degraded to a loud log instead of a throw.
 * Returns whether the redirect is active.
 *
 * Why the runtime does not fail hard: throwing here would mean the MCP server does not
 * START — a total outage — in order to protect the QUALITY of one error message.
 * Degrading instead restores exactly the pre-fix behaviour: retired names get the SDK's
 * bare "Tool X not found", every live tool keeps working, and the server boots.
 *
 * That trade is only defensible because the SDK a user can resolve is BOUNDED. This
 * package is normally run as `npx comfyui-mcp`, which resolves dependencies fresh —
 * package-lock.json protects `npm ci` in CI and nothing else — so a caret range would
 * have made "internals nothing ever ran against" the COMMON case rather than an edge
 * one. package.json therefore caps `@modelcontextprotocol/sdk` below the first
 * unverified minor, and raising that cap is a deliberate, reviewed edit that runs the
 * canary in src/__tests__/tools/retired-redirect.test.ts against the new SDK. Inside
 * the cap the install additionally SELF-TESTS on every boot (see
 * installRetiredNameRedirect), so "active" is measured rather than assumed.
 *
 * What remains, said plainly: nothing here can make a degraded state visible to the
 * CALLER, because the wrapper is the sole thing that could have changed what the caller
 * sees. The log below and the boolean the call sites report are the only signals, and
 * they reach an operator, not a model. That is the residual cost of not bricking
 * startup, and it is why the cap — not the log — is what actually holds the guarantee.
 */
export async function tryInstallRetiredNameRedirect(server: McpServer): Promise<boolean> {
  try {
    await installRetiredNameRedirect(server);
    return true;
  } catch (err) {
    logger.error(
      `[tools] retired-tool-name redirects are NOT active on direct tools/call — ` +
        `a call to a name removed in an earlier release will answer with the SDK's bare ` +
        `"Tool <name> not found" instead of naming its replacement. Live tools are unaffected. ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
}
