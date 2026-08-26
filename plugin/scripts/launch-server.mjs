#!/usr/bin/env node
/**
 * #1447 — plugin MCP server launcher.
 *
 * The plugin's .mcp.json used to be `npx -y comfyui-mcp --full` directly. On a
 * cold npx cache that downloads the whole ~818 MB dependency tree INSIDE the
 * client's MCP handshake timeout; the client kills the attempt, nothing is
 * persisted, and every retry pays the full cost again (the measured `_npx`
 * cache timestamped to a manual run, never to a client attempt).
 *
 * This wrapper has two halves.
 *
 * 1. THE WARM PATH. When `comfyui-mcp` is installed globally
 *    (`npm install -g comfyui-mcp`), it resolves `<npm root -g>/comfyui-mcp/
 *    dist/index.js` and runs it with this same node — sub-second start, no
 *    registry round-trip, stdio inherited verbatim. Nothing below touches it.
 *
 * 2. THE COLD PATH (the npx fallback), which is what a FIRST-RUN user gets:
 *    they have no global install, so the fallback is the very cold-npx path
 *    this issue was filed about. Measured on this machine, 2026-08-25, against
 *    a genuinely empty npm cache and an empty global prefix:
 *
 *      cold `npx -y comfyui-mcp --full` → `initialize` response  21.6 s
 *      npm install alone (818 MB, 170 packages)                  15.2 s
 *      warm `_npx` cache                → `initialize` response   1.2 s
 *                                        (7.0 s once, when npx updated first)
 *
 *    …and `claude mcp list` on that cold cache reported
 *    `✘ Failed to connect — MCP server connection timed out`, while the same
 *    launcher with a warm cache reported `✔ Connected`. The install is the
 *    whole difference.
 *
 *    So on the fallback the wrapper stops being a pipe and becomes a
 *    transparent MCP proxy that can WIN THE HANDSHAKE RACE. It forwards
 *    everything verbatim; if the real server has not answered the client's
 *    `initialize` by its deadline, the wrapper answers it itself, keeps the
 *    connection alive with an empty tool list while npm works, and hands over
 *    to the real server the moment it is up — announcing the real tools with
 *    `notifications/tools/list_changed`. A cold cache then costs LATENCY
 *    instead of a failed connection.
 *
 *    The deadline is not one number. With nothing unpacked under `_npx` there
 *    is no server to wait for, so it is the floor and does NOT depend on the
 *    client budget we assume; with a tree already cached the launch is normally
 *    1.2 s and must stay transparent, so it gets the generous deadline bounded
 *    by the client’s own MCP_TIMEOUT. See coldStartDeadlineMs.
 *
 *    Measured against the real client (Claude Code 2.1.246): it re-issues
 *    `tools/list` after that notification and calls a tool that existed only
 *    in the second listing. The handover is not theoretical.
 *
 * STDIO IS THE MCP TRANSPORT. Everything on stdout is the protocol. The warm
 * path inherits stdio and writes nothing; the proxy writes ONLY complete
 * newline-delimited JSON-RPC messages. Diagnostics go to stderr.
 *
 * Import-safe: nothing here runs on import. The resolution and protocol
 * decisions are pure exports so the tests can call the real thing instead of
 * reimplementing it (the #1385 lesson — a test of a copy is a test of nothing).
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

/**
 * An npm probe is normally ~100 ms. These bound a wedged npm: never longer than
 * the ceiling, and never more than a slice of the client's own budget, because
 * every millisecond spent probing is a millisecond the rescue deadline no
 * longer has. See npmProbeTimeoutMs.
 */
const NPM_PROBE_CEILING_MS = 5000;
const NPM_PROBE_FRACTION = 0.2;

/**
 * `npm root -g` stdout → the global install's entry point, or null when the
 * output is unusable or the install is absent/incomplete (no dist/index.js).
 * null is not an error here — it means "take the npx path".
 */
export function globalEntry(npmRootStdout, { exists = existsSync } = {}) {
  const root = typeof npmRootStdout === "string" ? npmRootStdout.trim() : "";
  if (!root) return null;
  const entry = join(root, "comfyui-mcp", "dist", "index.js");
  return exists(entry) ? entry : null;
}

/**
 * Tokens the shell form may contain. The fallback's args come from the
 * plugin's own .mcp.json (today: `--full`), never from user input — but a
 * shell command is string concatenation, so anything outside this alphabet
 * (whitespace, quotes, metacharacters) is REFUSED rather than passed through
 * to be silently misparsed.
 */
const SHELL_SAFE_TOKEN = /^[A-Za-z0-9@._~:/=-]+$/;

/**
 * The spawn spec for the resolved server. `extraArgs` are the plugin's own
 * args from .mcp.json (`--full`), forwarded to whichever server runs so the
 * manifest stays the declarative source of how the server is started.
 *
 * With an entry point we spawn node directly — no shell, no shim resolution.
 *
 * The npx fallback differs by platform:
 *  - POSIX: spawn npx with an args array, no shell.
 *  - Windows: npx is npx.cmd, which Node refuses to spawn without a shell
 *    since the 18.20.2/20.12.2 bat-file fix — but `shell` + an args array
 *    triggers DEP0190 (args are concatenated UNESCAPED, and Node warns every
 *    launch). So the Windows spec is one pre-validated command string instead:
 *    same concatenation, but every token is checked against SHELL_SAFE_TOKEN
 *    first, so what the shell parses is exactly what was written.
 */
export function serverSpec(entry, extraArgs, { platform = process.platform, node = process.execPath } = {}) {
  if (entry) return { command: node, args: [entry, ...extraArgs], shell: false };
  const npxArgs = ["-y", "comfyui-mcp", ...extraArgs];
  if (platform !== "win32") return { command: "npx", args: npxArgs, shell: false };
  for (const token of ["npx", ...npxArgs]) {
    if (!SHELL_SAFE_TOKEN.test(token)) {
      throw new Error(`[comfyui-mcp launcher] refusing to pass unsafe shell token to npx: ${JSON.stringify(token)}`);
    }
  }
  return { command: ["npx", ...npxArgs].join(" "), args: [], shell: true };
}

// ---------------------------------------------------------------------------
// #1447 cold-start rescue
// ---------------------------------------------------------------------------

/**
 * What we assume the client will wait for the handshake when it tells us
 * nothing. Claude Code's documented default; measured here as "> 21.6 s", so
 * an unknown-but-real budget is very unlikely to be smaller.
 */
export const DEFAULT_CLIENT_BUDGET_MS = 30000;

/**
 * How much of the client's budget the real server gets before the wrapper
 * answers for it. Deliberately well under half: the point is to rescue with
 * margin to spare, not to shave the deadline.
 */
export const RESCUE_BUDGET_FRACTION = 0.4;
/** Nothing cached: rescue this soon, or sooner if the budget is tighter still. */
export const RESCUE_MIN_MS = 1500;
/**
 * Something cached: wait at most this long for the real handshake.
 *
 * This was 12 s, derived from DEFAULT_CLIENT_BUDGET_MS — and two separate gate
 * rounds pushed on the same thing from different sides: a deadline computed
 * from a budget we only ASSUME is a deadline that can outlive the budget we
 * actually got. The assumption is not free, so it is worth as little as
 * possible.
 *
 * 4 s is what the measurements say it can safely be. Warm-npx handshakes here
 * are 1.2 s, 1.2 s, 1.2 s — better than 3x of margin, so healthy launches still
 * keep their own `serverInfo` and instructions. The one 7.0 s observation was
 * npx UPDATING to a newer release first, which is an install racing the
 * handshake, i.e. exactly what the rescue is for. And 4 s leaves room under any
 * client budget of 10 s or more, so the assumed default no longer has to be
 * right for the fix to work.
 */
export const RESCUE_MAX_MS = 4000;

/**
 * Is there already an unpacked comfyui-mcp under npm's `_npx` cache?
 *
 * This is the difference between "npm has to fetch 818 MB before a server
 * process can exist" and "npx has a tree on disk and is about to exec it".
 * `npm config get cache` is the authority on where that lives — guessing the
 * platform default would misread every machine with a cache path in `.npmrc`,
 * and misreading it in that direction would degrade every launch.
 *
 * Any failure answers false, i.e. "assume nothing is cached". That is the safe
 * direction: it rescues sooner, and being early costs one session's
 * `serverInfo`, while being late costs the connection.
 */
export function cachedNpxInstallExists(npmCacheStdout, { readdir = readdirSync, exists = existsSync } = {}) {
  const root = typeof npmCacheStdout === "string" ? npmCacheStdout.trim() : "";
  if (!root || root === "undefined" || root === "null") return false;
  const npxRoot = join(root, "_npx");
  let entries;
  try {
    entries = readdir(npxRoot);
  } catch {
    return false;
  }
  // A `comfyui-mcp` directory with no manifest is the half-deleted state a
  // failed Windows uninstall leaves behind (`npm ls -g` shows `comfyui-mcp@`
  // with no version). It is not a runnable install, so it does not count.
  return entries.some((name) => exists(join(npxRoot, name, "node_modules", "comfyui-mcp", "package.json")));
}

/**
 * The rescue deadline, in ms after the client's `initialize` arrives.
 *
 * TWO CASES, because they are not the same question.
 *
 * NOTHING CACHED — the reported first run. npm must fetch and unpack the whole
 * tree before a server process exists at all (measured: 15.2 s of npm on a fast
 * link, 818 MB / 170 packages), so waiting cannot pay: there is no server to
 * wait for. 1.5 s, and deliberately NOT derived from the assumed default budget
 * — a client that waits less than we assume must still be rescued in time. This
 * is the branch the round-1 gate was right to press on.
 *
 * SOMETHING CACHED — npx has a tree and is about to exec it. Measured warm-npx
 * handshakes on this machine: 1.2 s, 1.2 s, 1.2 s, and 7.0 s once when npx
 * updated to a newer release first. The 1.2 s launches must stay TRANSPARENT,
 * because rescuing them would swap the server's real `serverInfo` and
 * instructions for a stand-in on a launch that was going to succeed. So this
 * branch waits longer — 4 s, still comfortably clear of 1.2 s — and the 7.0 s
 * case is rescued, which is right: an npx update is an install racing the
 * handshake, the very thing this exists for.
 *
 * MCP_TIMEOUT is that budget and it is VISIBLE to us — verified by measurement:
 * a server launched by `MCP_TIMEOUT=17000 claude …` reads
 * `process.env.MCP_TIMEOUT === "17000"`. So a user who tightens the budget gets
 * rescued sooner, not later — and the budget share is a ceiling on BOTH
 * branches, so no floor of ours can ever schedule the rescue past it.
 */
export function clientBudgetMs(env = process.env) {
  const raw = Number(env.MCP_TIMEOUT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLIENT_BUDGET_MS;
}

export function coldStartDeadlineMs(env = process.env, { cachedInstall = true } = {}) {
  // The share is a hard ceiling in BOTH branches. A floor that could exceed it
  // was the round-2 gate's finding: at `MCP_TIMEOUT=1000` a 1500 ms floor
  // scheduled the rescue after the client had already given up, so the floor
  // has to lose to the budget rather than the other way round.
  const share = Math.round(clientBudgetMs(env) * RESCUE_BUDGET_FRACTION);
  return Math.min(cachedInstall ? RESCUE_MAX_MS : RESCUE_MIN_MS, share);
}

/**
 * How long the two npm probes get before the launcher gives up on them.
 *
 * This is subtracted from the client's budget before the rescue deadline even
 * starts, so it cannot be a fixed 5 s: the round-2 gate found that two
 * sequential 5 s probes could consume a 10 s budget entirely and the rescue
 * would never arm. The probes now run CONCURRENTLY and are bounded by a slice
 * of the same budget, so probe + deadline together stay well inside it.
 */
export function npmProbeTimeoutMs(env = process.env) {
  return Math.min(NPM_PROBE_CEILING_MS, Math.max(300, Math.round(clientBudgetMs(env) * NPM_PROBE_FRACTION)));
}

/**
 * The version the wrapper reports when it answers `initialize` on the server's
 * behalf. It is NOT a plausible version on purpose — #1503 replaced a
 * hardcoded "0.1.0" precisely because a real-looking number made every bug
 * report ambiguous about which build produced it. The wrapper genuinely does
 * not know the version yet (npm is still fetching it), and says so.
 *
 * This is paid only on a launch that would otherwise have FAILED. Every later
 * launch finds a warm cache, the real server answers inside the deadline, and
 * the client gets the real `serverInfo` untouched.
 */
export const INSTALLING_VERSION = "0.0.0-installing";

/**
 * `instructions` for the rescued handshake. The real server's instructions are
 * not knowable before it exists, and instructions cannot be refreshed later —
 * so this says what is true and, importantly, heads off the exact failure the
 * reopened report describes: with the server dead the model "improvised —
 * shelled out, poked at files, invented API calls", and the user read that as
 * a bad agent rather than a server that never started.
 */
export const INSTALLING_INSTRUCTIONS = [
  "comfyui-mcp is still installing. This is the first launch on this machine, so npm is",
  "fetching the server's dependency tree; the plugin launcher answered this handshake to keep",
  "the connection alive. This server has NO tools yet — they arrive by",
  "notifications/tools/list_changed as soon as the install finishes, usually within a minute.",
  "Until then: do not start comfyui-mcp by hand, do not call ComfyUI's HTTP API directly, and do",
  "not tell the user their setup is broken. Wait, re-list the tools, and use them normally.",
  "The server's own usage instructions were not available at handshake time; restarting this MCP",
  "server once the install has finished will pick them up.",
].join(" ");

/**
 * The `initialize` result the wrapper sends in the server's place.
 *
 * `protocolVersion` echoes the client's request: the wrapper is not a protocol
 * implementation with opinions, it is a stand-in, and echoing is what keeps a
 * client from failing the handshake over a version it did not ask for.
 *
 * The capabilities mirror what the real server advertises (measured:
 * `{tools:{listChanged:true},resources:{},prompts:{}}`) so the client's picture
 * of the server does not change under it at handover. `listChanged` is the
 * load-bearing one — it is how the real tools arrive.
 */
export function rescueInitializeResult(clientParams) {
  const requested = clientParams && typeof clientParams.protocolVersion === "string"
    ? clientParams.protocolVersion
    : "2025-06-18";
  return {
    protocolVersion: requested,
    capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
    serverInfo: { name: "comfyui-mcp", version: INSTALLING_VERSION },
    instructions: INSTALLING_INSTRUCTIONS,
  };
}

/** JSON-RPC error code for "the server exists but cannot serve this yet". */
const NOT_READY_CODE = -32002;

/**
 * What to do with a client message that arrives while the real server is still
 * installing.
 *
 * The rule that matters: a request must never be FORWARDED and also answered
 * here, and it must never be left unanswered. Forwarding `tools/list` would
 * park the client on a request until npm finishes — which is the timeout this
 * fix exists to remove, moved one method along. So the list methods are
 * answered empty right now and corrected by `notifications/tools/list_changed`
 * at handover.
 *
 * `notifications/initialized` is the exception that MUST be forwarded: the
 * server's SDK will not serve anything until it sees it, and the pipe preserves
 * order, so it lands behind the `initialize` the client already sent.
 *
 * A frame with an id and no method is a RESPONSE, not a request — it belongs to
 * whoever asked, so it is forwarded rather than swallowed. Other notifications
 * are dropped: they can only refer to requests this wrapper answered itself.
 *
 * A JSON-RPC BATCH (an array) is routed member by member. MCP dropped batching
 * in 2025-06-18, but 2025-03-26 allows it, and forwarding one whole would park
 * every request inside it on the install — the round-3 gate's finding, and the
 * same timeout this fix exists to remove wearing a different hat. The answers
 * go back as ONE array, which is the response shape the client is waiting for;
 * members that need no answer are forwarded on their own, which is valid
 * JSON-RPC (a notification is a notification, batched or not).
 *
 * @returns {{action: "forward"} | {action: "drop"} | {action: "reply", message: object}
 *          | {action: "batch", replies: object[], forward: object[]}}
 */
export function installingDecision(msg) {
  if (Array.isArray(msg)) {
    const replies = [];
    const forward = [];
    for (const member of msg) {
      const decision = installingDecision(member);
      if (decision.action === "reply") replies.push(decision.message);
      else if (decision.action === "forward") forward.push(member);
      // A nested array is not legal JSON-RPC; `drop` covers it and everything
      // else that cannot be answered.
    }
    // Nothing to answer — the batch is notifications and/or responses, so the
    // original line goes to the server exactly as it arrived.
    if (replies.length === 0) return { action: "forward" };
    return { action: "batch", replies, forward };
  }
  if (!msg || typeof msg !== "object") return { action: "drop" };
  if (msg.method === "initialized" || msg.method === "notifications/initialized") {
    return { action: "forward" };
  }
  if (typeof msg.method !== "string") return { action: "forward" };
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (!isRequest) return { action: "drop" };

  const reply = (result) => ({ action: "reply", message: { jsonrpc: "2.0", id: msg.id, result } });
  switch (msg.method) {
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [] });
    case "resources/list":
      return reply({ resources: [] });
    case "resources/templates/list":
      return reply({ resourceTemplates: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return {
        action: "reply",
        message: {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: NOT_READY_CODE,
            message:
              "comfyui-mcp is still installing (first launch fetches the dependency tree). " +
              "Its tools appear via notifications/tools/list_changed when the install finishes.",
          },
        },
      };
  }
}

/**
 * Read a stream as newline-delimited JSON-RPC frames.
 *
 * StringDecoder, not `chunk.toString()`: a multi-byte character split across
 * two chunks would otherwise be corrupted, and this transport carries every
 * localised string the panel and the tools emit.
 */
function readFrames(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += decoder.write(chunk);
    let nl;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      onLine(line);
    }
  });
}

/** Write one frame, honouring backpressure by pausing the source that fed it. */
function writeFrame(dest, source, line) {
  if (!dest || dest.destroyed || dest.writableEnded) return;
  if (!dest.write(line + "\n") && source) {
    source.pause();
    dest.once("drain", () => source.resume());
  }
}

/**
 * The transparent proxy with a rescue.
 *
 * Phases:
 *   opening      — forwarding both ways verbatim, waiting for the real server's
 *                  `initialize` response, deadline armed.
 *   transparent  — the server answered in time. Pure passthrough forever; the
 *                  client got the REAL serverInfo, capabilities and
 *                  instructions, and nothing below ever ran.
 *   installing   — the deadline won. The wrapper answered `initialize` and is
 *                  holding the connection open with empty lists.
 *   live         — the server's (now redundant) `initialize` result has been
 *                  swallowed and `tools/list_changed` sent. Pure passthrough.
 *   failed       — the server answered that same `initialize` with an ERROR.
 *                  The client is holding a success we sent for it and there is
 *                  no way to retract it, so the transport is dropped instead of
 *                  announcing tools that will never exist.
 *
 * Exported and stream-injectable so the tests can drive the REAL state machine
 * rather than a description of it.
 */
export function attachColdStartProxy({
  clientIn,
  clientOut,
  childIn,
  childOut,
  deadlineMs,
  onRescue,
  onHandoverFailed,
}) {
  let phase = "opening";
  let initializeId;
  let initializeParams;
  let timer = null;
  let clientInitialized = false;
  let announcePending = false;
  const announceTimers = [];

  // No backpressure source: these are the wrapper's own short control frames,
  // and pausing an unrelated stream to emit one would be a bug, not a courtesy.
  const toClient = (message) => writeFrame(clientOut, null, JSON.stringify(message));

  /**
   * Tell the client to re-list — the one message that turns a rescued session
   * into a working one. It is sent MORE THAN ONCE, on purpose (round-4 gate).
   *
   * A single notification is a single point of failure for the whole fix: if the
   * client is not yet listening for it, the session sits on the empty tool list
   * for good, which is the silent, total failure this issue is about. The client
   * registers that listener around its own `initialize` bookkeeping, and the
   * handover can land in the middle of it.
   *
   * Re-listing is idempotent — it costs one `tools/list` round-trip — so paying
   * for two extra notifications to close a race that costs the user the whole
   * session is the right trade.
   */
  const ANNOUNCE_REPEAT_MS = [1500, 6000];
  const announceTools = () => {
    toClient({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    for (const delay of ANNOUNCE_REPEAT_MS) {
      const repeat = setTimeout(() => toClient({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }), delay);
      if (typeof repeat.unref === "function") repeat.unref();
      announceTimers.push(repeat);
    }
  };

  /**
   * …and it is never sent before the client says it is initialized. The spec
   * puts `notifications/initialized` at the end of the client's handshake, so a
   * notification sent ahead of it is one the client is entitled to ignore.
   */
  const announceWhenReady = () => {
    if (clientInitialized) announceTools();
    else announcePending = true;
  };

  const markClientInitialized = () => {
    if (clientInitialized) return;
    clientInitialized = true;
    if (announcePending) {
      announcePending = false;
      announceTools();
    }
  };

  const disarm = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const rescue = () => {
    if (phase !== "opening" || initializeId === undefined) return;
    phase = "installing";
    disarm();
    toClient({ jsonrpc: "2.0", id: initializeId, result: rescueInitializeResult(initializeParams) });
    if (onRescue) onRescue();
  };

  readFrames(clientIn, (line) => {
    if (phase !== "installing") {
      // opening/transparent/live all forward verbatim. In `opening` we still
      // peek, but only to learn the id we may have to answer for — the line
      // itself goes to the server untouched either way.
      //
      // Peeking means PARSING, never matching the text `"initialize"`: JSON may
      // escape any character in a string, so `"initialize"` is the same
      // method to a parser and invisible to a substring test. The round-2 gate
      // found that shortcut, and it would have disarmed the rescue entirely for
      // a client that escapes. It costs nothing to drop — at most a couple of
      // frames reach here before the handshake settles.
      if (phase === "opening" && initializeId === undefined) {
        const request = findInitializeRequest(parseFrame(line));
        if (request) {
          initializeId = request.id;
          initializeParams = request.params;
          disarm();
          timer = setTimeout(rescue, deadlineMs);
          if (typeof timer.unref === "function") timer.unref();
        }
      } else if (announcePending && carriesInitialized(parseFrame(line))) {
        // The handover beat the client's own handshake. `live` is otherwise a
        // pure wire, so without this the deferred announcement would never fire
        // and the session would keep the empty tool list for good.
        markClientInitialized();
      }
      writeFrame(childIn, clientIn, line);
      return;
    }
    const parsed = parseFrame(line);
    if (carriesInitialized(parsed)) markClientInitialized();
    const decision = installingDecision(parsed);
    if (decision.action === "forward") {
      writeFrame(childIn, clientIn, line);
    } else if (decision.action === "reply") {
      toClient(decision.message);
    } else if (decision.action === "batch") {
      // Order matters: the server sees the batch's notifications before the
      // client is told its requests are answered.
      for (const member of decision.forward) writeFrame(childIn, clientIn, JSON.stringify(member));
      toClient(decision.replies);
    }
  });

  // The client closing stdin is how an MCP stdio session ends. With inherited
  // stdio that reached the server for free; through the proxy it has to be
  // relayed, or the server would sit on a dead transport forever.
  clientIn.on("end", () => {
    if (childIn && !childIn.writableEnded) childIn.end();
  });

  readFrames(childOut, (line) => {
    if (phase === "transparent" || phase === "live") {
      writeFrame(clientOut, childOut, line);
      return;
    }
    // Only the server's answer to the client's `initialize` changes anything,
    // and a response carries no `method`. Parse rather than sniff for `"id"`,
    // for the same escaping reason as the client side, and look inside a batch
    // for the same reason the client side does.
    const parsed = parseFrame(line);
    const { response: msg, rest } = initializeId === undefined
      ? { response: null, rest: [] }
      : splitResponseTo(parsed, initializeId);
    if (!msg) {
      writeFrame(clientOut, childOut, line);
      return;
    }
    if (phase === "opening") {
      // The server won the race. Hand the client its real handshake — error or
      // not, it is the server's own answer — and never look at another frame.
      phase = "transparent";
      disarm();
      writeFrame(clientOut, childOut, line);
      return;
    }
    // phase === "installing": the client already has an `initialize` result for
    // this id, so a second response for the same id cannot be forwarded — but
    // anything that merely shared its batch still belongs to the client.
    if (rest.length > 0) writeFrame(clientOut, childOut, JSON.stringify(rest));
    if (msg.error) {
      // …but the server FAILED to initialize. The client is holding a success
      // we sent on its behalf, and there is no way to retract it — so the
      // honest move is to stop, loudly, rather than announce tools that will
      // never exist. Found by the round-2 gate: this path previously emitted
      // `tools/list_changed` and left the client believing it had connected.
      phase = "failed";
      disarm();
      for (const repeat of announceTimers) clearTimeout(repeat);
      if (onHandoverFailed) onHandoverFailed(msg.error);
      return;
    }
    phase = "live";
    announceWhenReady();
  });

  return {
    phase: () => phase,
    // Test seam: fire the deadline without waiting for wall-clock time.
    forceRescue: rescue,
  };
}

/** Does this client frame — single or batched — say the client is initialized? */
function carriesInitialized(msg) {
  if (Array.isArray(msg)) return msg.some(carriesInitialized);
  return Boolean(msg) && (msg.method === "notifications/initialized" || msg.method === "initialized");
}

/**
 * The `initialize` REQUEST inside a frame, single or batched, or null.
 *
 * MCP 2025-03-26 forbids batching `initialize` and 2025-06-18 has no batching
 * at all, so a batched handshake is a client bug — but the whole rescue hangs
 * off finding this request, and "we did not arm because the client was slightly
 * wrong" is a cold start that still times out (round-6 gate). Every other frame
 * shape in this proxy already handles batches; this one now matches.
 */
export function findInitializeRequest(msg) {
  if (Array.isArray(msg)) {
    for (const member of msg) {
      const found = findInitializeRequest(member);
      if (found) return found;
    }
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const usable = msg.method === "initialize" && msg.id !== undefined && msg.id !== null;
  return usable ? msg : null;
}

/**
 * Split a server frame into the response to `id` and everything else, so a
 * response that arrives inside a batch can be swallowed at handover without
 * taking its batch-mates with it.
 *
 * @returns {{response: object|null, rest: object[]}}
 */
export function splitResponseTo(msg, id) {
  const members = Array.isArray(msg) ? msg : [msg];
  let response = null;
  const rest = [];
  for (const member of members) {
    const isResponse =
      member && typeof member === "object" && member.method === undefined && sameId(member.id, id);
    if (isResponse && response === null) response = member;
    else rest.push(member);
  }
  return { response, rest };
}

function parseFrame(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** JSON-RPC ids are strings or numbers; compare without coercing across types. */
function sameId(a, b) {
  return typeof a === typeof b && a === b;
}

/** Ask npm something. String-command form on Windows for the same DEP0190
 *  reason as serverSpec; the arguments are fixed literals, so there is nothing
 *  to inject. Resolves null on any failure — for the global root that degrades
 *  to exactly what the plugin did before this wrapper existed (the npx path),
 *  and for the cache root it degrades to "assume nothing is cached", which
 *  rescues sooner rather than later. */
function probeNpm(args, timeout = NPM_PROBE_CEILING_MS) {
  const isWin = process.platform === "win32";
  return new Promise((resolve) => {
    execFile(
      isWin ? ["npm", ...args].join(" ") : "npm",
      isWin ? [] : args,
      { shell: isWin, timeout },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/** Shared child lifecycle: signal forwarding, exit code, spawn failure. */
function superviseChild(child, spec) {
  // The client kills the WRAPPER when it shuts the server down; without
  // forwarding, the real server would be orphaned holding stdio. Killing the
  // child on signal makes its `exit` fire, which is what exits the wrapper.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => child.kill(sig));
  }

  child.on("exit", (code, signal) => {
    // A signal death has no code; 1 keeps the client from reading it as clean.
    process.exit(code ?? (signal ? 1 : 0));
  });
  child.on("error", (err) => {
    // Honest failure, loudly: a server that never started must not look like
    // one that exited cleanly. stderr, never stdout — see the header.
    console.error(`[comfyui-mcp launcher] failed to start ${spec.command}: ${err.message}`);
    process.exit(1);
  });
}

/** Warm path: stdio inherited verbatim, wrapper is a bystander. */
function run(spec) {
  superviseChild(spawn(spec.command, spec.args, { stdio: "inherit", shell: spec.shell }), spec);
}

/**
 * Cold path: the wrapper sits in the stdio stream so it can answer the
 * handshake if npm is still working. stderr stays inherited — npm's progress
 * and the server's own logs belong in the client's server log untouched.
 */
function runProxied(spec, deadlineMs) {
  const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "inherit"], shell: spec.shell });
  if (child.stdin && child.stdout) {
    // EPIPE when the install dies mid-frame is not worth a crash: the child's
    // `exit` handler is what reports the failure.
    child.stdin.on("error", () => {});
    attachColdStartProxy({
      clientIn: process.stdin,
      clientOut: process.stdout,
      childIn: child.stdin,
      childOut: child.stdout,
      deadlineMs,
      onRescue: () =>
        console.error(
          "[comfyui-mcp launcher] the server did not finish starting within " +
            `${deadlineMs}ms (first launch installs ~818MB); answered the MCP handshake on its ` +
            "behalf and will announce its tools when the install completes.",
        ),
      onHandoverFailed: (error) => {
        // The client is holding a handshake this wrapper answered, and the
        // server has now refused its own. Dropping the transport is the only
        // honest signal left: the client reports a disconnect instead of a
        // connected server with no tools, and this line is in its server log.
        console.error(
          "[comfyui-mcp launcher] the server refused to initialize after the launcher answered " +
            `the handshake for it: ${JSON.stringify(error)}. Closing the connection rather than ` +
            "reporting a server that will never have tools.",
        );
        try {
          child.kill();
        } catch {
          /* already gone; the exit handler still runs */
        }
        process.exitCode = 1;
      },
    });
  }
  superviseChild(child, spec);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const extraArgs = process.argv.slice(2);
  // CONCURRENTLY, and bounded by a slice of the client's budget. Sequential
  // probes could each burn the full timeout and leave nothing for the rescue
  // (round-2 gate); in parallel the worst case is one probe, not two.
  const probeTimeout = npmProbeTimeoutMs();
  const [npmRoot, npmCache] = await Promise.all([
    probeNpm(["root", "-g"], probeTimeout),
    probeNpm(["config", "get", "cache"], probeTimeout),
  ]);
  const entry = globalEntry(npmRoot);
  // The rescue exists for the npx fallback, which is the only path that can
  // have an install in front of the handshake. A resolved global entry starts
  // a server that is already on disk, so it keeps inherited stdio and this
  // wrapper stays out of its protocol entirely.
  if (entry) {
    run(serverSpec(entry, extraArgs));
  } else {
    const cachedInstall = cachedNpxInstallExists(npmCache);
    runProxied(serverSpec(null, extraArgs), coldStartDeadlineMs(process.env, { cachedInstall }));
  }
}
