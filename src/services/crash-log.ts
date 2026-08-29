// Crash-log reader/parser for ComfyUI native crashes.
//
// When a workflow run crashes the ComfyUI process with a NATIVE fault (a CUDA
// access violation inside a custom node's C/Python extension, a segfault, a
// fatal Python error), ComfyUI captures the fault to its on-disk log before the
// process dies — but the agent never sees it: the panel agent only learns
// "ComfyUI restarted." This module reads the tail of that log on resume,
// detects a crash signature, and extracts BOTH the fatal block and the most
// likely CULPRIT custom node (the deepest custom_nodes/<NodeDir>/<file>:<line>
// frame in the traceback) so the orchestrator can inject it into the agent's
// resume context — turning "it just restarted" into "WanVideoWrapper's
// apply_lora at utils.py:338 access-violated; update or fix it before retrying."
//
// Pure + unit-testable: parseCrashBlock(text) has no I/O; readComfyuiCrashLog
// resolves the log path under COMFYUI_PATH and returns the parse of its tail.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The result of scanning a log tail for a native crash. */
export interface CrashParseResult {
  /** True only when a real crash signature was found in the scanned text. */
  fatal: boolean;
  /** The trimmed fatal block to show the agent (empty when !fatal). */
  block: string;
  /** The culprit custom-node directory name, e.g. "ComfyUI-WanVideoWrapper". */
  culpritNode?: string;
  /** The deepest `<file>:<line>` frame (within the culprit node when known). */
  culpritFrame?: string;
  /**
   * The innermost frame overall, set ONLY when a culprit custom node was named
   * but that node is NOT where the fault actually happened — i.e. a deeper frame
   * outside custom_nodes sits between it and the crash.
   *
   * The culprit search deliberately PREFERS a custom_nodes frame, because a
   * custom node is the usual cause and the one thing the user can act on. But
   * when the innermost frame is core ComfyUI or a site-packages kernel, the
   * custom node may be doing nothing but wrapping the call — TiledDiffusion
   * monkey-patches KSAMPLER_sample and passes straight through, so it appears on
   * every sampler stack it is installed for, including a SageAttention CUDA
   * fault it had no part in (#2497). Naming it unhedged sent the user to update
   * an innocent node and re-run the same crashing graph.
   */
  faultFrame?: string;
  /** A stable identifier for THIS crash (signature head + culprit), so the caller
   *  can inject a given crash at most once and not re-surface it on every later
   *  resume. Also set for the `unreadable` case below — the injection site skips
   *  any note without one — and otherwise absent. */
  fingerprint?: string;
  /**
   * A log candidate EXISTED and could not be read (#796's class).
   *
   * `fatal` is a two-valued field carrying three states: a crash was found, no
   * crash was found, and NOTHING WAS LOOKED AT. The third used to render as the
   * second, and formatCrashNote returns null for `!fatal` — so a log we could not
   * open (locked mid-write on Windows, permissions, a truncated read) told the
   * agent that its restart was CLEAN. That is the worst possible direction here:
   * the whole feature exists so the agent does not re-run the graph that just
   * killed the server, and silence is read as "safe to proceed".
   *
   * Set ONLY when a candidate file exists and reading or stat-ing it failed.
   * Deliberately NOT set when there are no candidates at all: that is "no source
   * to consult", it is the normal state for anyone whose logs live elsewhere, and
   * a permanent unknown-banner on every resume would be noise — which is how a
   * real warning stops being read.
   */
  unreadable?: { path: string; reason: string };
}

/** What readComfyuiCrashLog returns: the parse plus where it read from. */
export interface CrashLogReadResult extends CrashParseResult {
  /** The log file actually read (the most-recently-modified candidate), if any. */
  logPath?: string;
}

/** Signatures that mark a NATIVE/fatal crash (not an ordinary node exec error). */
const CRASH_SIGNATURES = [
  /Windows fatal exception/i,
  /access violation/i,
  /Segmentation fault/i,
  /Fatal Python error/i,
];

/** Hard caps so an enormous log can't blow up memory or the agent's context. */
const MAX_TAIL_BYTES = 256 * 1024; // read at most the last 256 KiB of the log

/**
 * The dedupe key for an UNREADABLE log, in the same namespace as a crash
 * fingerprint (the injection site skips any note without one, and keys on it to
 * inject at most once per tab).
 *
 * Keyed on path + reason so a persistent condition — a permissions problem, say —
 * is surfaced ONCE rather than on every resume for the rest of the session, while
 * a genuinely different failure later still gets through. The reason is truncated
 * so an error string carrying a varying detail (an offset, a handle id) cannot
 * defeat the dedupe by minting a fresh key each time.
 */
function unreadableFingerprint(u: { path: string; reason: string }): string {
  return `unreadable:${u.path}:${u.reason.slice(0, 60)}`;
}
const MAX_BLOCK_CHARS = 4000; // the injected fatal block is capped to this

/**
 * How much of the log ABOVE the fatal signature to keep as CAUSAL CONTEXT.
 *
 * A native fault is frequently PRECEDED by the only line that names what
 * actually failed, and the signature itself says nothing. ComfyUI's Sage path
 * logs `Error running sage attention: CUDA error: an illegal memory access was
 * encountered, using pytorch attention instead.` and only then aborts with a
 * bare `Fatal Python error: Aborted` (#2497). Anchoring the block AT the
 * signature dropped exactly that line, so the agent was handed an abort with no
 * cause — and the nearest custom node on the stack took the blame for a fault in
 * a pip-installed CUDA kernel.
 *
 * A bounded window, not a search for error-ish words: the useful line has no
 * fixed wording, so any prose predicate would miss the next variant. Two caps so
 * a log with enormously long lines can't blow the budget on one of them.
 */
const MAX_CONTEXT_LINES = 25;
const MAX_CONTEXT_CHARS = 1200;

/**
 * The contiguous stack that the frame at `index` belongs to.
 *
 * The culprit region runs from the signature to the END of the tail, which after
 * a restart also holds log APPENDED post-crash. Comparing frame depth across
 * that whole span lets a later, unrelated traceback supply the "innermost"
 * frame: a segfault in custom_nodes/GoodNode followed by an ordinary
 * comfy/server.py traceback would name server.py the fault site and tell the
 * user NOT to update the node that actually crashed (gate r1 P1). Depth is only
 * meaningful WITHIN one stack, so the comparison is bounded to one.
 *
 * A stack line is an indented frame/source line, or a bare `file.py:12` form.
 * A blank line or an unindented log line ends the run — which is exactly what
 * separates a crash dump from whatever the server printed next.
 */
function firstStackFrames(region: string): { frames: { path: string; line?: string }[]; start: number } {
  const lines = region.split("\n");
  let off = 0;
  let runStart = 0;
  let frames: { path: string; line?: string }[] = [];
  let inRun = false;
  for (const raw of lines) {
    const lineStart = off;
    off += raw.length + 1;
    // A stack is a contiguous run of frame lines and their indented source
    // lines. A blank or unindented log line ends it — which is exactly what
    // separates a crash dump from whatever the server printed next.
    const isStackLine = raw.trim() !== "" && (/^\s/.test(raw) || frameOnLine(raw) !== null);
    if (isStackLine) {
      if (!inRun) {
        inRun = true;
        runStart = lineStart;
        frames = [];
      }
      const f = frameOnLine(raw);
      if (f) frames.push(f);
    } else {
      if (inRun && frames.length > 0) return { frames, start: runStart };
      inRun = false;
    }
  }
  return inRun && frames.length > 0 ? { frames, start: runStart } : { frames: [], start: 0 };
}

/**
 * Parse ONE line as a stack frame, or null if it is not one.
 *
 * Deliberately ANCHORED at the start of the (trimmed) line. An unanchored match
 * hits anywhere, so an ordinary indented SOURCE line inside a traceback —
 * `raise RuntimeError("bad.py:99")`, or `raise RuntimeError("custom_nodes/Fake/f.py:99")` —
 * reads as a frame in a file that was never on the stack, and names a false
 * fault site or a nonexistent culprit node (gate r2/r3 P1).
 */
function frameOnLine(line: string): { path: string; line?: string } | null {
  const quoted = /^\s*File\s+["']([^"']+?\.py)["']?,?\s*line\s*(\d+)/i.exec(line);
  if (quoted) return { path: quoted[1], line: quoted[2] };
  const bare = /^\s*([^\s"',()]+?\.py):(\d+)/i.exec(line);
  if (bare) return { path: bare[1], line: bare[2] };
  return null;
}

/**
 * Which end of THIS stack is innermost, from the nearest direction marker ABOVE
 * it. Read globally, a marker printed after the restart reverses an earlier
 * crash stack and flips the answer (gate r2 P1); the marker that governs a stack
 * is the closest one preceding it. Falls back to the caller's global reading
 * when this stack has no marker of its own.
 */
function traceDirectionFor(region: string, runStart: number, fallback: boolean): boolean {
  const before = region.slice(0, runStart);
  const first = before.toLowerCase().lastIndexOf("most recent call first");
  const last = before.toLowerCase().lastIndexOf("most recent call last");
  if (first < 0 && last < 0) return fallback;
  return first > last;
}

/**
 * The bounded run of lines immediately preceding `lineStart`, oldest-first.
 * Returns "" when the signature is already at the top of the scanned tail.
 */
function precedingContext(text: string, lineStart: number): string {
  if (lineStart <= 0) return "";
  const lines = text.slice(0, lineStart).split("\n");
  // slice(0, lineStart) ends ON the newline that opens the anchor line, so the
  // split leaves a trailing "" that is not a real line.
  if (lines[lines.length - 1] === "") lines.pop();
  const kept: string[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_CONTEXT_LINES; i--) {
    chars += lines[i].length + 1;
    if (chars > MAX_CONTEXT_CHARS) break;
    kept.unshift(lines[i]);
  }
  return kept.join("\n").trim();
}

/** The custom-node directory in a frame path: `custom_nodes/<NodeDir>/…`. */
const CUSTOM_NODE_DIR = /custom_nodes[\\/]+([^\\/]+)/i;

/**
 * True when a crash-signature hit sits inside a Python "Exception ignored in:"
 * block — an exception raised inside a __del__/weakref callback during garbage
 * collection. CPython PRINTS these but SWALLOWS them: the process keeps running
 * and subsequent prompts execute normally, so they must NOT be classified as a
 * process crash. Uses a bounded look-back (1200 chars) that stops at a blank
 * line, so it cannot reach into an unrelated earlier block.
 */
function isSwallowedDestructorHit(text: string, index: number): boolean {
  const from = Math.max(0, index - 1200);
  const before = text.slice(from, index);
  // Stop at the LAST blank line — handling LF, CRLF, and whitespace-only blank
  // lines so a Windows (CRLF) log's block boundary isn't missed and the look-back
  // can't reach into an unrelated earlier block.
  const blank = /\r?\n[ \t]*\r?\n/g;
  let cut = -1;
  let b: RegExpExecArray | null;
  while ((b = blank.exec(before)) !== null) cut = b.index;
  return /Exception ignored in:/i.test(cut >= 0 ? before.slice(cut) : before);
}

/** Basename of a path with either separator (no node:path needed for a string). */
function baseName(p: string): string {
  const parts = p.split(/[\\/]+/);
  return parts[parts.length - 1] || p;
}

/**
 * Scan a chunk of log text for a native crash. Returns { fatal:false } when no
 * crash signature is present (a clean restart). When fatal, extracts a trimmed
 * fatal block and the deepest custom-node frame as the likely culprit.
 *
 * The scan deliberately considers the LAST signature/traceback in the text (the
 * most recent crash) so an old crash earlier in the tail can't shadow a clean
 * recent run — and conversely a recent crash is found even if the tail also
 * contains earlier benign content.
 */
export function parseCrashBlock(text: string): CrashParseResult {
  if (!text) return { fatal: false, block: "" };

  // Find the LAST position where any crash signature or a traceback header
  // appears — that anchors the most-recent fatal event.
  let anchor = -1;
  let sawSignature = false;
  for (const re of CRASH_SIGNATURES) {
    // Walk EVERY match via a global clone and take the LAST hit that is NOT
    // inside a swallowed "Exception ignored in:" destructor block.
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    let last = -1;
    while ((m = g.exec(text)) !== null) {
      if (!isSwallowedDestructorHit(text, m.index)) last = m.index;
      if (m.index === g.lastIndex) g.lastIndex++; // avoid zero-width loop
    }
    if (last >= 0) {
      sawSignature = true;
      if (last > anchor) anchor = last;
    }
  }
  // A bare Python traceback (no native signature) is an ORDINARY handled
  // exception, NOT a process crash — don't treat it as fatal. Otherwise a normal
  // node error sitting in the log tail would be mis-injected as a "crash" on a
  // later resume (P2). Only the native signatures above (access violation /
  // segfault / fatal Python/Windows exception) mark a real crash.
  if (!sawSignature) return { fatal: false, block: "" };

  // The fatal block = from a little BEFORE the anchor (to include the header
  // line) to the end of the tail. Back up to the start of the anchor's line.
  const lineStart = text.lastIndexOf("\n", anchor) + 1;
  // What the block used to be, and STILL the basis for the fingerprint below:
  // the dedupe key must not shift just because we now display more context.
  const fatalRegion = text.slice(lineStart).trim();
  // Prepend the bounded run of lines above the signature — for a whole class of
  // faults the cause is stated there and nowhere else (#2497).
  const context = precedingContext(text, lineStart);
  let block = context ? `${context}\n${fatalRegion}` : fatalRegion;
  if (block.length > MAX_BLOCK_CHARS) {
    // Keep the HEAD of the block (the signature + the top frames matter most).
    // #809: "…(truncated)" said nothing actionable. Name the amount, the fixed cap, and
    // the tool that holds the rest — this block is INJECTED, so it has no parameters of
    // its own and inventing a lever here would send the caller nowhere.
    const dropped = block.length - MAX_BLOCK_CHARS;
    block =
      block.slice(0, MAX_BLOCK_CHARS) +
      `\n…(+${dropped} more char(s) cut at the fixed ${MAX_BLOCK_CHARS}-char crash-block cap — no parameter raises it; get_system_stats (action:"logs") may still hold the full crash while it is within the log tail)`;
  }

  // Culprit: the DEEPEST (innermost / actually-crashing) frame in the fatal
  // region. WHERE the innermost frame sits depends on the trace ORDER:
  //   • Windows fatal-exception dumps & faulthandler print "most recent call
  //     FIRST" — the crashing frame is the TOP one, so take the FIRST match.
  //   • Standard Python tracebacks print "most recent call LAST" — the crashing
  //     frame is the BOTTOM one, so take the LAST match.
  // For the WanVideoWrapper access violation this yields apply_lora @ utils.py:338
  // (the top custom-node frame), not its caller loadmodel.
  const region = text.slice(lineStart);
  const mostRecentFirst = /most recent call first/i.test(region);
  let culpritNode: string | undefined;
  let culpritFrame: string | undefined;
  let faultFrame: string | undefined;

  // Blame is decided inside ONE stack: the first one after the fatal signature.
  // The region reaches the end of the tail, so it also holds whatever the server
  // printed after the restart, and every cross-stack question has a wrong answer
  // available to it — a later dump's direction marker reverses this stack, and a
  // later traceback's frames pose as this one's (gate r1/r2/r3 P1). Frames come
  // from frameOnLine, so a `.py:N` inside a source line is not one.
  const stack = firstStackFrames(region);
  if (stack.frames.length > 0) {
    const innerFirst = traceDirectionFor(region, stack.start, mostRecentFirst);
    const ordered = innerFirst ? stack.frames : [...stack.frames].reverse();
    const innermost = ordered[0];
    // The deepest CUSTOM-NODE frame is the culprit when there is one — a custom
    // node is the usual cause and the one thing the user can act on.
    const nodeFrame = ordered.find((f) => CUSTOM_NODE_DIR.test(f.path));
    if (nodeFrame) {
      culpritNode = CUSTOM_NODE_DIR.exec(nodeFrame.path)?.[1];
      const file = baseName(nodeFrame.path);
      culpritFrame = nodeFrame.line ? `${file}:${nodeFrame.line}` : file;
      // …but if a NON-custom-node frame is deeper still, the node is only on the
      // stack, not at the fault site, and naming it alone is a confident wrong
      // answer (#2497).
      if (!CUSTOM_NODE_DIR.test(innermost.path)) {
        const f = baseName(innermost.path);
        faultFrame = innermost.line ? `${f}:${innermost.line}` : f;
      }
    } else {
      // No custom-node frame — give the agent the innermost file:line anyway so
      // it has something to look at (e.g. a core ComfyUI crash).
      const file = baseName(innermost.path);
      culpritFrame = innermost.line ? `${file}:${innermost.line}` : file;
    }
  }

  // Fingerprint the STABLE head of the crash (the signature + top frames + culprit)
  // — not the whole block, which grows as the log appends post-restart — so the
  // caller can dedupe: inject a given crash once, never re-surface it on later
  // resumes.
  // Hashed over the FATAL region, never the displayed block: the block now also
  // carries preceding log context, and keying on that would both shift every
  // existing crash's key and let an unrelated line drifting into the window mint
  // a fresh key for a crash already injected.
  const fingerprintBasis = `${culpritNode ?? ""}|${culpritFrame ?? ""}|${fatalRegion
    .split("\n")
    .slice(0, 4)
    .join("\n")}`;
  const fingerprint = createHash("sha1").update(fingerprintBasis).digest("hex").slice(0, 16);

  return {
    fatal: true,
    block,
    fingerprint,
    ...(culpritNode ? { culpritNode } : {}),
    ...(culpritFrame ? { culpritFrame } : {}),
    ...(faultFrame ? { faultFrame } : {}),
  };
}

/** Candidate log paths under a ComfyUI install, most-likely first. */
export function comfyuiLogCandidates(comfyPath: string): string[] {
  return [join(comfyPath, "logs", "comfyui.log"), join(comfyPath, "user", "comfyui.log")];
}

/**
 * Read the tail of ComfyUI's log (picking the most-recently-modified of the
 * candidate paths under `comfyPath`) and parse it for a native crash. Returns
 * { fatal:false } on a clean log, a missing path, or any read error — so the
 * caller injects a crash note ONLY when there's a real, recent crash signature.
 */
export function readComfyuiCrashLog(comfyPath: string | undefined): CrashLogReadResult {
  if (!comfyPath) return { fatal: false, block: "" };
  const candidates = comfyuiLogCandidates(comfyPath).filter((p) => existsSync(p));
  if (candidates.length === 0) return { fatal: false, block: "" };
  // Most-recently-modified candidate (the live log after a crash+restart).
  let chosen: string | undefined;
  let chosenMtime = -Infinity;
  let statFailure: { path: string; reason: string } | undefined;
  for (const p of candidates) {
    try {
      const m = statSync(p).mtimeMs;
      if (m > chosenMtime) {
        chosenMtime = m;
        chosen = p;
      }
    } catch (err) {
      // Remember WHY, rather than only skipping. If no candidate survives, this
      // is the difference between "no crash" and "could not look" (#796).
      statFailure ??= { path: p, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  // Candidates existed (they passed existsSync) and every one failed to stat.
  if (!chosen) {
    return statFailure
      ? { fatal: false, block: "", unreadable: statFailure, fingerprint: unreadableFingerprint(statFailure) }
      : { fatal: false, block: "" };
  }

  let text: string;
  try {
    const { size } = statSync(chosen);
    const buf = readFileSync(chosen);
    text =
      size > MAX_TAIL_BYTES
        ? buf.subarray(size - MAX_TAIL_BYTES).toString("utf8")
        : buf.toString("utf8");
  } catch (err) {
    const unreadable = { path: chosen, reason: err instanceof Error ? err.message : String(err) };
    return {
      fatal: false,
      block: "",
      logPath: chosen,
      unreadable,
      fingerprint: unreadableFingerprint(unreadable),
    };
  }
  return { ...parseCrashBlock(text), logPath: chosen };
}

/**
 * Format the crash parse into the note the agent sees FIRST on resume. Returns
 * null when there's nothing to inject (clean restart). Kept small + capped.
 */
export function formatCrashNote(result: CrashParseResult): string | null {
  // A log we could not open is NOT a clean restart (#796). Say so plainly, and
  // say what it does and does not establish — the agent's next move after a
  // resume is usually to re-run what it was doing, which is the one thing a
  // genuine crash makes dangerous.
  if (!result.fatal && result.unreadable) {
    return (
      "⚠️ ComfyUI restarted, and its log could NOT be read — so whether it crashed is UNKNOWN. " +
      `Tried: ${result.unreadable.path} (${result.unreadable.reason}). ` +
      "This is not a clean restart, it is an unread one: no crash signature was ruled out, because " +
      "nothing was scanned. Before re-running the last action, consider whether it was heavy " +
      "(large model load, a custom node doing native work) — a repeat of a native fault will look " +
      "identical from here. Reading that file yourself, or checking ComfyUI's console, is the " +
      "quickest way to settle it."
    );
  }
  if (!result.fatal) return null;
  // A custom node was named, but a deeper NON-custom-node frame is where it
  // actually died: report the fault site first and the node as a possibility,
  // not as a verdict. Sending the user to update a node that only wraps the call
  // costs them a re-run of the graph that just killed the server (#2497).
  if (result.culpritNode && result.faultFrame) {
    return (
      "⚠️ ComfyUI crashed during your last action (a native fault captured in its log). " +
      "Fatal log:\n" +
      "```\n" +
      result.block +
      "\n```\n" +
      `The innermost frame is ${result.faultFrame}, which is NOT inside a custom node — so the fault ` +
      `happened in ComfyUI core or a native/pip library it called. ${result.culpritNode}` +
      `${result.culpritFrame ? ` (${result.culpritFrame})` : ""} is the nearest custom node on the stack, ` +
      "but it may only be wrapping the call and be blameless. Read the log lines ABOVE the signature — " +
      "for this class of fault the failing subsystem is usually named there and nowhere else — and treat " +
      `${result.faultFrame} as the fault site. Do NOT just re-run the same graph, and do not update ` +
      `${result.culpritNode} on the strength of this trace alone.`
    );
  }
  const culprit = result.culpritNode
    ? `Most likely culprit custom node: ${result.culpritNode}${
        result.culpritFrame ? ` (${result.culpritFrame})` : ""
      }.`
    : result.culpritFrame
      ? `Most likely culprit frame: ${result.culpritFrame}.`
      : "Could not pinpoint a single culprit node from the trace.";
  return (
    "⚠️ ComfyUI crashed during your last action (a native fault captured in its log). " +
    "Fatal log:\n" +
    "```\n" +
    result.block +
    "\n```\n" +
    culprit +
    " Update or fix that node before retrying — do NOT just re-run the same graph " +
    "(escalate per your crash-recovery steps: panel_update_node / install_custom_node (action:'update') → " +
    "git pull in custom_nodes → targeted patch + verify)."
  );
}
