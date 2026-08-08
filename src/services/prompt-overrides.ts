// User-editable overrides for EVERY agent prompt the orchestrator controls.
//
// Design: each prompt registers its built-in DEFAULT (id + label + default text).
// The user's override is stored SEPARATELY (~/.comfyui-mcp/panel-prompts.json), so
// a default is never destroyed — an empty override or an explicit Reset always falls
// back to the built-in. This makes "edit any prompt" safe: a bad edit that breaks
// tool use is one Reset away.
//
// resolvePrompt(id, fallback) is what call-sites use — it returns the override when
// present and non-empty, else the inline default (which is also what gets registered
// for the console listing). The store imports nothing from the backends, so wiring a
// call-site (backends import THIS) never risks a circular import; defaults are
// registered centrally at startup (see registerBuiltinPrompts in index.ts).

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";
import { assertNotWritingRealHomeInTests } from "./test-isolation-guard.js";

export interface PromptDef {
  id: string;
  label: string;
  /** One-line note shown under the label in the editor (e.g. when it takes effect). */
  help?: string;
  default: string;
}

export interface PromptListItem {
  id: string;
  label: string;
  help?: string;
  default: string;
  /** The stored override text, or null when using the default. */
  override: string | null;
  overridden: boolean;
}

const REGISTRY = new Map<string, PromptDef>();
const emitter = new EventEmitter();

/** Overrides file path. Overridable for tests. */
export function panelPromptsPath(): string {
  return (
    process.env.COMFYUI_MCP_PANEL_PROMPTS ||
    join(homedir(), ".comfyui-mcp", "panel-prompts.json")
  );
}

/**
 * Load the overrides, distinguishing ABSENT from UNREADABLE (#796).
 *
 * `{}` is right for a file that is not there and WRONG for one that exists and
 * could not be read, because setPromptOverride is a read-modify-write:
 * `{}` + one new override, written back, erases every other prompt the user has
 * written. This file holds USER-AUTHORED PROMPT TEXT — as the write guard below
 * already says — so that is lost writing, not a lost setting.
 */
function readOverridesState(): { values: Record<string, string>; unreadable?: string } {
  const p = panelPromptsPath();
  if (!existsSync(p)) return { values: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { values: {}, unreadable: "it is valid JSON but not an object" };
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return { values: out };
  } catch (err) {
    logger.warn(`[prompt-overrides] could not parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
    return { values: {}, unreadable: err instanceof Error ? err.message : String(err) };
  }
}

/** The lenient read, for QUERIES (which prompt text applies right now). An
 *  unreadable file means the built-in defaults apply — a wrong answer, but not a
 *  destructive one, and throwing here would break every prompt lookup. */
function readOverrides(): Record<string, string> {
  return readOverridesState().values;
}

function writeOverrides(o: Record<string, string>): void {
  const p = panelPromptsPath();
  // User-authored prompt text lives here — a test run writing the real file
  // rewrites what the user's prompts say. Refuse at the write.
  assertNotWritingRealHomeInTests(p, "the panel prompt overrides");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(o, null, 2), "utf-8");
}

/** Register a prompt's built-in default so the editor can list + reset it. Idempotent. */
export function registerPrompt(id: string, label: string, def: string, help?: string): void {
  REGISTRY.set(id, { id, label, default: def, help });
}

/**
 * The effective prompt text for `id`: the stored override if present and non-empty,
 * otherwise `fallback` (the call-site's inline default, which also seeds the registry
 * default). A whitespace-only override counts as "use default".
 */
export function resolvePrompt(id: string, fallback: string): string {
  const ov = readOverrides()[id];
  if (typeof ov === "string" && ov.trim().length > 0) return ov;
  return fallback;
}

/** Persist an override. Empty/whitespace clears it (→ back to default). Emits change. */
export function setPromptOverride(id: string, value: string): void {
  const { values: o, unreadable } = readOverridesState();
  // The file exists and we could not read it, so `o` is EMPTY — not because the
  // user has no overrides, but because we could not read the ones they wrote.
  // Writing now would replace all of their prompt text with this single entry.
  // This IS our file, so it is preserved and replaced (the ruling for
  // ~/.claude.json is different — that one belongs to another program and is
  // refused instead of moved).
  if (unreadable !== undefined) preserveUnreadableOverrides(unreadable);
  if (!value || !value.trim()) delete o[id];
  else o[id] = value;
  writeOverrides(o);
  emitter.emit("change", id);
}

/**
 * Move an unreadable overrides file aside so the write that follows cannot
 * destroy it. Throws if it cannot be moved — refusing to persist is better than
 * overwriting prompt text the user typed, which is the same ruling the session
 * store and defaults manager make.
 */
function preserveUnreadableOverrides(reason: string): void {
  const p = panelPromptsPath();
  const aside = `${p}.unreadable-${Date.now()}`;
  try {
    renameSync(p, aside);
    logger.warn(
      `[prompt-overrides] preserved the unreadable overrides as ${aside} before writing a fresh ` +
        `file (it could not be read: ${reason}). Any prompt text you had customised is in there.`,
    );
  } catch (err) {
    throw new Error(
      `Refusing to overwrite ${p}: it could not be read (${reason}) and could not be moved aside ` +
        `either (${err instanceof Error ? err.message : String(err)}), so writing would destroy ` +
        `prompt text that is probably still there. Fix or move that file, then set the prompt again.`,
    );
  }
}

/** Remove an override → back to the built-in default. Emits change. */
export function clearPromptOverride(id: string): void {
  const o = readOverrides();
  if (id in o) {
    delete o[id];
    writeOverrides(o);
  }
  emitter.emit("change", id);
}

/** All registered prompts with their default + current override, for the editor. */
export function listPrompts(): PromptListItem[] {
  const ov = readOverrides();
  return [...REGISTRY.values()].map((e) => {
    const o = ov[e.id];
    const overridden = typeof o === "string" && o.trim().length > 0;
    return { id: e.id, label: e.label, help: e.help, default: e.default, override: overridden ? o : null, overridden };
  });
}

/** Is `id` a prompt we know about? (Guards the write endpoint.) */
export function isKnownPrompt(id: string): boolean {
  return REGISTRY.has(id);
}

/** Subscribe to "a prompt override changed" (arg: the changed id). Returns unsubscribe. */
export function onPromptsChanged(cb: (id: string) => void): () => void {
  emitter.on("change", cb);
  return () => emitter.off("change", cb);
}
