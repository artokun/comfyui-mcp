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
  /** A stable identifier for THIS crash (signature head + culprit), so the caller
   *  can inject a given crash at most once and not re-surface it on every later
   *  resume. Absent when !fatal. */
  fingerprint?: string;
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
const MAX_BLOCK_CHARS = 4000; // the injected fatal block is capped to this

/**
 * Match a stack frame that points INTO a custom node. Handles both quoted
 * `File "...custom_nodes/<Node>/<file.py>", line 338` (Windows fatal-exception
 * dumps + Python tracebacks) and bare `custom_nodes/<Node>/<file.py>:338` forms,
 * with either path separator.
 */
const CUSTOM_NODE_FRAME =
  /custom_nodes[\\/]+([^\\/]+)[\\/]+([^\s"',]+?\.py)(?:["']?,?\s*line\s*(\d+)|:(\d+))/gi;

/** Any `<file>:<line>` or `File "...", line N` frame — the fallback culprit. */
const ANY_FRAME =
  /(?:File\s*["']([^"']+?\.py)["']?,?\s*line\s*(\d+))|([^\s"',()]+?\.py):(\d+)/gi;

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
    const idx = text.search(re);
    // search() finds the first; walk to the LAST via a global clone.
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    let last = idx;
    while ((m = g.exec(text)) !== null) {
      last = m.index;
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
  let block = text.slice(lineStart).trim();
  if (block.length > MAX_BLOCK_CHARS) {
    // Keep the HEAD of the block (the signature + the top frames matter most).
    block = block.slice(0, MAX_BLOCK_CHARS) + "\n…(truncated)";
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
  /** Collect every match of a global regex against the region. */
  const collectAll = (source: string, flags: string): RegExpExecArray[] => {
    const g = new RegExp(source, flags);
    const out: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = g.exec(region)) !== null) {
      out.push(m);
      if (m.index === g.lastIndex) g.lastIndex++;
    }
    return out;
  };
  /** Pick the innermost match given the trace order. */
  const pickInnermost = <T>(matches: T[]): T | undefined =>
    matches.length === 0 ? undefined : mostRecentFirst ? matches[0] : matches[matches.length - 1];

  let culpritNode: string | undefined;
  let culpritFrame: string | undefined;
  const nodeMatch = pickInnermost(collectAll(CUSTOM_NODE_FRAME.source, CUSTOM_NODE_FRAME.flags));
  if (nodeMatch) {
    culpritNode = nodeMatch[1];
    const file = baseName(nodeMatch[2]);
    const line = nodeMatch[3] ?? nodeMatch[4];
    culpritFrame = line ? `${file}:${line}` : file;
  } else {
    // Fallback: no custom-node frame — take the innermost ANY frame so the agent
    // at least gets a file:line to look at (e.g. a core ComfyUI crash).
    const anyMatch = pickInnermost(collectAll(ANY_FRAME.source, ANY_FRAME.flags));
    if (anyMatch) {
      const file = baseName(anyMatch[1] ?? anyMatch[3] ?? "");
      const line = anyMatch[2] ?? anyMatch[4];
      if (file) culpritFrame = line ? `${file}:${line}` : file;
    }
  }

  // Fingerprint the STABLE head of the crash (the signature + top frames + culprit)
  // — not the whole block, which grows as the log appends post-restart — so the
  // caller can dedupe: inject a given crash once, never re-surface it on later
  // resumes.
  const fingerprintBasis = `${culpritNode ?? ""}|${culpritFrame ?? ""}|${block
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
  for (const p of candidates) {
    try {
      const m = statSync(p).mtimeMs;
      if (m > chosenMtime) {
        chosenMtime = m;
        chosen = p;
      }
    } catch {
      // unreadable stat — skip this candidate
    }
  }
  if (!chosen) return { fatal: false, block: "" };

  let text: string;
  try {
    const { size } = statSync(chosen);
    const buf = readFileSync(chosen);
    text =
      size > MAX_TAIL_BYTES
        ? buf.subarray(size - MAX_TAIL_BYTES).toString("utf8")
        : buf.toString("utf8");
  } catch {
    return { fatal: false, block: "", logPath: chosen };
  }
  return { ...parseCrashBlock(text), logPath: chosen };
}

/**
 * Format the crash parse into the note the agent sees FIRST on resume. Returns
 * null when there's nothing to inject (clean restart). Kept small + capped.
 */
export function formatCrashNote(result: CrashParseResult): string | null {
  if (!result.fatal) return null;
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
    "(escalate per your crash-recovery steps: panel_update_node / update_custom_node → " +
    "git pull in custom_nodes → targeted patch + verify)."
  );
}
