/**
 * "First rank" Claude default: the newest Opus the account actually advertises.
 *
 * Server-side twin of the panel's `pickDefaultModel` (comfyui-mcp-panel,
 * web/js/lib/model-catalog.js). It has to be the SAME rule: the panel highlights
 * its pick as the default, and the orchestrator decides what a tab really spawns
 * on — two rules would put one model in the picker and another in the turn.
 *
 * Reading it from `supportedModels()` rather than baking an id is what makes it
 * safe to auto-upgrade: that list is per-account, so the pick is always a model
 * this subscription can actually run. A baked `claude-opus-5` was a generation
 * behind the moment the SDK learned `claude-opus-5-5`.
 */
const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];

export interface ParsedClaudeModel {
  family: string;
  /** [5] for claude-opus-5, [5, 5] for claude-opus-5-5; null for an alias with no resolved id. */
  version: number[] | null;
  /** True for a bare family alias ("opus"), false for a pinned `claude-*` id. */
  alias: boolean;
}

/** Strip a trailing context marker (`[1m]`). A `-fast` suffix is deliberately kept:
 *  it is a distinct, differently-priced variant and must fail the pinned-id parse. */
function stripModelSuffix(id: string): string {
  return id.replace(/\[[^\]]*\]\s*$/, "").trim();
}

export function parseClaudeModel(id: string, resolved?: string): ParsedClaudeModel | null {
  const pinned = (src: string): ParsedClaudeModel | null => {
    const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/.exec(stripModelSuffix(src).toLowerCase());
    if (!m) return null;
    const version = [Number(m[2])];
    if (m[3] !== undefined) version.push(Number(m[3]));
    return { family: m[1], version, alias: false };
  };
  const own = pinned(id);
  if (own) return own;
  const bare = stripModelSuffix(id).toLowerCase();
  if (CLAUDE_FAMILIES.includes(bare)) {
    const r = resolved ? pinned(resolved) : null;
    return { family: bare, version: r ? r.version : null, alias: true };
  }
  return resolved ? pinned(resolved) : null;
}

/** >0 when `a` is newer than `b`; null sorts lowest. */
export function cmpVersion(a: number[] | null, b: number[] | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** On a version tie: a plain pinned id beats a `[1m]`-suffixed one, and both beat an
 *  alias. An alias resolves to whatever the installed SDK thinks is newest, which is
 *  exactly what lagged in #377 (`opus` still meaning 4.8 after Opus 5 shipped). */
function tieRank(value: string, parsed: ParsedClaudeModel): number {
  if (parsed.alias) return 2;
  return stripModelSuffix(value) === value.trim() ? 0 : 1;
}

/** The value to default to, or undefined for an empty list. Newest Opus first; with no
 *  recognizable Opus, the first opus-ish row, then the SDK's own first row.
 *
 *  The SDK's `default` row ("Default (recommended)") is never a candidate, exactly as
 *  the panel's presentableModels drops it before its own pickDefaultModel runs. It is
 *  not a family, it is whatever Anthropic currently recommends — free to point at a
 *  Sonnet tomorrow. And because it is not a family name, parseClaudeModel reads it
 *  through its resolved id as if it were PINNED, so it won every tie against `opus`:
 *  on a live account (2026-10-13) the newest Opus is advertised ONLY as the `default`
 *  and `opus` aliases, and beta.5 picked `default` while the panel picked `opus`. */
export function pickTopClaudeModel(
  models: ReadonlyArray<{ value: string; resolvedModel?: string }>,
): string | undefined {
  const pool = models.filter((m) => m.value !== "default");
  const candidates = pool.length ? pool : models;
  const opus = candidates
    .map((m, i) => ({ m, i, c: parseClaudeModel(m.value, m.resolvedModel) }))
    .filter((x): x is { m: (typeof models)[number]; i: number; c: ParsedClaudeModel } => x.c?.family === "opus");
  if (opus.length) {
    opus.sort(
      (a, b) =>
        cmpVersion(b.c.version, a.c.version) ||
        tieRank(a.m.value, a.c) - tieRank(b.m.value, b.c) ||
        a.i - b.i,
    );
    return opus[0].m.value;
  }
  return (candidates.find((m) => /opus/i.test(m.value)) ?? candidates[0])?.value;
}
