/**
 * #1870 — `panel_update_node` labeled a previous generation traceback as the
 * Manager update traceback.
 *
 * The panel (#1320) fetches `/internal/logs/raw` when Manager stores only
 * "An error occurred while updating 'X'." and attaches the last traceback that
 * NAMES the pack. After a failed generation the log still holds that node's
 * execution stack (`FalApiError: Downstream service error (HTTP 500)` in the
 * report). For pack `fal-api` that stack names the pack, so it is attached as
 * `Manager traceback:` while the Manager log only says
 * `res.result=False, res.action=update-git`.
 *
 * The orchestrator keeps Manager task evidence (the generic update ERROR line,
 * `res.action`/`res.result`, `do_update` / `repo_update` frames) and drops
 * ComfyUI execution history. When that evidence shows an update-git (or
 * generic update) failure and the pack is a registry zip (no nested `.git`),
 * it names that and re-routes to reinstall rather than leaving the reader
 * debugging a stale generation error. The reinstall note is gated on that
 * observed Manager evidence, not on the caller's `version` argument (#1888).
 *
 * Never throws: this runs on an error path, and a guard that becomes the error
 * is strictly worse than the message it was improving.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  capturePackPresenceContext,
  findPackOnDisk,
} from "./node-management.js";

const MANAGER_TRACEBACK_MARKER = /Manager traceback:\s*/i;

/** Frames / log lines that belong to a Manager UPDATE, not a generation. */
const MANAGER_UPDATE_EVIDENCE =
  /\bdo_update\b|\bunified_update\b|\brepo_update\b|manager_server\.py|manager_core\.py|\bres\.action\s*=|\bres\.result\s*=/i;

const GENERIC_UPDATE_LINE = /An error occurred while updating\s+'([^']+)'/i;

const UPDATE_GIT = /res\.action\s*=\s*update-git/i;

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

export interface PanelUpdateFailureOpts {
  id: string;
  version?: string;
}

/**
 * A ToolResult-shaped reply. Kept structural so this module does not import
 * the orchestrator's type (panel-tools is the caller).
 */
export interface UpdateErrorToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function stripAnsi(line: string): string {
  return line.replace(ANSI, "");
}

function isTracebackStart(line: string): boolean {
  return /Traceback \(most recent call last\):/.test(line);
}

function isTracebackContinuation(line: string): boolean {
  const s = stripAnsi(line);
  if (!s.trim()) return true;
  if (/^\s/.test(s)) return true;
  if (isTracebackStart(s)) return true;
  if (/During handling of the above exception/.test(s)) return true;
  if (/The above exception was the direct cause/.test(s)) return true;
  return /^[A-Za-z_][\w.]*(Error|Exception|Exit|Warning|Interrupt):/.test(s.trim());
}

/**
 * True when `text` is evidence of the Manager UPDATE itself — not a node's
 * generation failure that happens to name the same pack.
 */
export function isManagerUpdateEvidence(text: string): boolean {
  return typeof text === "string" && MANAGER_UPDATE_EVIDENCE.test(text);
}

/**
 * Observe whether the installed pack has a nested `.git`.
 *
 * `true`  — a git checkout (file or directory `.git`).
 * `false` — the pack is on disk here and has no `.git` (registry zip / copy).
 * `undefined` — we could not look (remote session, no root, pack not found,
 *               unreadable). Absence of an observation is not "no git".
 */
export function observePackNestedGit(id: string): boolean | undefined {
  try {
    const ctx = capturePackPresenceContext();
    if (ctx.remote || !ctx.diskRoot) return undefined;
    const disk = findPackOnDisk(id, ctx.diskRoot);
    if (disk.state !== "found") return undefined;
    return existsSync(join(disk.dir, ".git"));
  } catch {
    return undefined;
  }
}

function nonGitRegistryNote(id: string): string {
  return (
    `NOTE: "${id}" is installed as a Comfy Registry zip (no nested .git), so ` +
    `Manager's update-git cannot pull a nightly/git HEAD. The pack was NOT ` +
    `git-updated. Reinstall it from the registry instead: install_custom_node ` +
    `(action:"reinstall", id:"${id}") — or panel_install_node with the same id. ` +
    `Nightly needs a git checkout; a zip-installed pack cannot be git-updated.`
  );
}

function collectTracebackAt(lines: string[], start: number): string[] | null {
  if (start < 0 || start >= lines.length || !isTracebackStart(lines[start])) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (!isTracebackContinuation(lines[i])) break;
    out.push(lines[i]);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.length ? out : null;
}

/**
 * Keep Manager-task lines from an attached traceback; drop execution-history
 * frames. Returns `{ kept, droppedExecution }` so the caller can disclose the
 * omission rather than silently shrinking the message.
 */
export function keepManagerUpdateEvidence(traceback: string): {
  kept: string;
  droppedExecution: boolean;
} {
  const lines = traceback.split(/\r?\n/).map(stripAnsi);
  const kept: string[] = [];
  let droppedExecution = false;
  let i = 0;
  while (i < lines.length) {
    if (isTracebackStart(lines[i])) {
      const block = collectTracebackAt(lines, i);
      if (!block) {
        i += 1;
        continue;
      }
      i += block.length;
      if (isManagerUpdateEvidence(block.join("\n"))) {
        kept.push(block.join("\n").trimEnd());
      } else {
        droppedExecution = true;
      }
      continue;
    }
    const line = lines[i].trimEnd();
    if (GENERIC_UPDATE_LINE.test(line) || /\bres\.(action|result)\s*=/.test(line)) {
      kept.push(line.trim());
    }
    i += 1;
  }
  return { kept: kept.join("\n").trim(), droppedExecution };
}

/**
 * #1888 — the reinstall note is a claim about Manager's update, so it fires
 * only when the message itself carries that evidence. `version === "nightly"`
 * is the caller's argument, not an observation: on a zip-installed pack it
 * bolted the note onto every `isError`, including a disconnected tab and a
 * reply-timeout whose own text says the mutation's outcome is unknown.
 */
function wantsNonGitReroute(message: string): boolean {
  return UPDATE_GIT.test(message) || GENERIC_UPDATE_LINE.test(message);
}

/**
 * Rewrite a `panel_update_node` failure so Manager task evidence is not mixed
 * with ComfyUI execution history. Identity when there is nothing to change.
 */
export function sanitizePanelUpdateFailure(
  message: string,
  opts: PanelUpdateFailureOpts,
): string {
  if (typeof message !== "string" || !message) return message;

  let out = message;
  const marker = MANAGER_TRACEBACK_MARKER.exec(message);
  if (marker && marker.index !== undefined) {
    const head = message.slice(0, marker.index).trimEnd();
    const tb = message.slice(marker.index + marker[0].length);
    const { kept, droppedExecution } = keepManagerUpdateEvidence(tb);
    if (droppedExecution) {
      const omitted =
        " (The previous ComfyUI generation traceback is execution history, not this Manager update, and was omitted.)";
      out = kept
        ? `${head}${omitted} Manager traceback:\n${kept}`
        : `${head}${omitted}`;
    }
  }

  if (wantsNonGitReroute(out) && observePackNestedGit(opts.id) === false) {
    const note = nonGitRegistryNote(opts.id);
    if (!out.includes(note)) out = `${out.trimEnd()}\n\n${note}`;
  }
  return out;
}

/**
 * Post-process the ToolResult `panel_update_node` got from the panel. Success
 * and unrelated failures pass through. Never throws.
 */
export function sanitizePanelUpdateNodeResult<T extends UpdateErrorToolResult>(
  res: T,
  opts: PanelUpdateFailureOpts,
): T {
  try {
    if (!res?.isError || !Array.isArray(res.content)) return res;
    const idx = res.content.findIndex((c) => c.type === "text" && typeof c.text === "string");
    if (idx < 0) return res;
    const text = res.content[idx].text ?? "";
    const cleaned = sanitizePanelUpdateFailure(text, opts);
    if (cleaned === text) return res;
    const content = res.content.slice();
    content[idx] = { ...content[idx], text: cleaned };
    return { ...res, content };
  } catch {
    return res;
  }
}
