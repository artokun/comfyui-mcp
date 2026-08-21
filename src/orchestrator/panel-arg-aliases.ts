/**
 * #1968 — the argument name an agent reaches for FIRST is accepted, and the
 * canonical one stays canonical.
 *
 * The premise, from the report: if a capable model calls a tool with the obvious
 * argument and gets a validation error, that is a naming/schema defect, not a
 * caller error. The first guess is drawn from the tool's own name plus the
 * conventions of its siblings, so a rejected first guess costs a full round trip
 * AND teaches the caller to be tentative with a surface it should use fluently.
 *
 * This module is the ONE place an alias is resolved, so the three group tools and
 * the todo/media tools cannot drift into disagreeing about which spelling wins.
 *
 * ALIAS, NEVER REPLACE. Every canonical key keeps working untouched and stays the
 * name the tool DESCRIPTION teaches — one vocabulary to learn. The alias exists
 * so a first call lands, not so there are two names to choose between. That is
 * the same trade #1018 made for the todo STATUS synonyms (accept `in_progress`,
 * document only `active`) and #845 made for string node ids.
 *
 * AN AMBIGUOUS PAIR IS REFUSED, NOT RESOLVED. When a caller supplies both the
 * canonical key and its alias with DIFFERENT values there is no way to know which
 * they meant, and picking one would apply an edit they did not ask for. Equal
 * values are accepted (a caller belt-and-bracing both spellings is unambiguous);
 * unequal ones get a refusal naming both, which is a read rather than a wrong
 * mutation to undo.
 */

import { describeReceived } from "./node-id.js";

/** A group id as the graph readers print it. Integers only: the panel resolves a
 *  group with a strict `===` against `group.id` (resolveGroup), so a string that
 *  reached the wire would miss a group that exists and report "No group with id
 *  …" about one the caller is looking at. Coerced here instead. */
export const GROUP_ID_PATTERN = /^-?\d+$/;

export const GROUP_ID_MESSAGE =
  "a group id must be an integer (e.g. 2) — panel_query_graph's groups[] and panel_create_group both return it";

/**
 * Normalize an accepted group id to the NUMBER the wire has always carried.
 *
 * Mirrors normalizeNodeId's contract minus the subgraph-qualified shape: a group
 * id has no nested form, so unlike a node id there is nothing here that must pass
 * through as a string.
 */
export function normalizeGroupId(v: number | string): number {
  return typeof v === "number" ? v : Number.parseInt(v, 10);
}

/** The outcome of resolving one canonical/alias pair: a value, or the refusal to
 *  guess between two conflicting ones. */
export type AliasPick<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Resolve a canonical key and its alias to one value.
 *
 * Equality is by JSON rather than `===` so an array/object argument (`items` vs
 * `todos`) compares by CONTENT — two structurally identical checklists are not
 * ambiguous just because they are different references. JSON.stringify can throw
 * on a circular or BigInt value, so a comparison that cannot be made is treated
 * as "not equal" (refuse) rather than as agreement: refusing an unreadable pair
 * costs a round trip, silently picking one applies the wrong list.
 */
export function pickAlias<T>(
  subject: string,
  canonical: { name: string; value: T | undefined },
  alias: { name: string; value: T | undefined },
): AliasPick<T> {
  const hasCanonical = canonical.value !== undefined;
  const hasAlias = alias.value !== undefined;
  if (hasCanonical && hasAlias) {
    if (!sameValue(canonical.value, alias.value)) {
      return {
        ok: false,
        error:
          `${subject} got both \`${canonical.name}\` and \`${alias.name}\`, with different values ` +
          `(${canonical.name}=${describeReceived(canonical.value)}, ${alias.name}=${describeReceived(alias.value)}). ` +
          `They are the SAME argument — \`${alias.name}\` is an accepted alias for \`${canonical.name}\` — so this ` +
          `call names one target twice and does not say which. Nothing was sent. Re-send with ONE of them.`,
      };
    }
    return { ok: true, value: canonical.value as T };
  }
  if (hasCanonical) return { ok: true, value: canonical.value as T };
  if (hasAlias) return { ok: true, value: alias.value as T };
  return {
    ok: false,
    error:
      `${subject} requires \`${canonical.name}\` (or its alias \`${alias.name}\`) — neither was supplied.`,
  };
}

/** Structural equality for the alias check. Never throws: an unstringifiable pair
 *  is reported as unequal so the caller gets the refusal, not a coin flip. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * #1968 — `panel_show_media` items: accept the ComfyUI output ref at the ITEM
 * level and wrap it into `source`.
 *
 * The tool's OWN prose says "pass the output ref `{filename, subfolder, type}`",
 * and that is exactly what the reporter passed — one level too shallow, because
 * the schema wants it nested under `source`. A doc that describes the payload and
 * a schema that wants it wrapped is a defect in the pair, not in the caller.
 *
 * Only ever ADDS the wrapper. An item that already carries `source` is returned
 * untouched, so the canonical shape cannot be reinterpreted by this function.
 *
 * An item carrying NEITHER shape is refused here rather than passed on. The
 * handler's first act on an item is `"path" in src`, which throws a TypeError on
 * an absent source — turning a caller's misnamed key into an unhandled crash
 * instead of a sentence they can act on.
 */
export function normalizeShowMediaItem(
  item: Record<string, unknown>,
  index: number,
): AliasPick<Record<string, unknown>> {
  const { source, filename, subfolder, type, path, stage, label, caption, ...rest } = item;
  const at = `panel_show_media items[${index}]`;
  const out: Record<string, unknown> = { ...rest };

  if (source !== undefined) {
    // The canonical shape wins outright, but a flat ref sitting BESIDE it means
    // the item names two different media and says which only by nesting depth.
    if (filename !== undefined || path !== undefined) {
      return {
        ok: false,
        error:
          `${at} carries \`source\` AND a top-level ${filename !== undefined ? "`filename`" : "`path`"}. ` +
          `The flat form is an accepted alias for \`source\`, so this item names its media twice. ` +
          `Nothing was displayed. Send the ref in ONE place.`,
      };
    }
    // The ref's MODIFIERS — subfolder/type/stage — can arrive flat while the ref
    // itself is nested. Before this alias existed zod stripped them from the item
    // silently; now the schema ADVERTISES them, so dropping one would be a
    // parameter that is accepted and does nothing. `stage` is the one that
    // matters: it is the opt-in for a real disk write, so a caller who sets it
    // and is ignored gets a refusal for an oversized file they thought they had
    // handled. Fold each into `source` where it is absent, and refuse rather
    // than overwrite where the two disagree.
    const merged: Record<string, unknown> = { ...(source as Record<string, unknown>) };
    for (const [key, value] of [
      ["subfolder", subfolder],
      ["type", type],
      ["stage", stage],
    ] as const) {
      if (value === undefined) continue;
      if (merged[key] !== undefined && !sameValue(merged[key], value)) {
        return {
          ok: false,
          error:
            `${at} sets \`${key}\` both inside \`source\` (${describeReceived(merged[key])}) and at item ` +
            `level (${describeReceived(value)}). The flat key is an alias for the nested one, so this ` +
            `says two things about one ref. Nothing was displayed. Set it in ONE place.`,
        };
      }
      merged[key] = value;
    }
    out.source = merged;
  } else if (path !== undefined) {
    // The disk-path member of the same union, flattened the same way.
    out.source = stage === undefined ? { path } : { path, stage };
  } else if (filename !== undefined) {
    out.source = {
      filename,
      ...(subfolder === undefined ? {} : { subfolder }),
      ...(type === undefined ? {} : { type }),
    };
  } else {
    return {
      ok: false,
      error:
        `${at} has no media to show: it needs \`source\` — or, equivalently, a top-level \`filename\` ` +
        `(a ComfyUI output ref: {filename, subfolder?, type?}) or \`path\` (an absolute disk path).`,
    };
  }

  // `caption` is and remains canonical (it has been the key since v0.19.0 — the
  // report's claim that the tool "requires label" is the one row of its table
  // that does not reproduce). `label` is accepted because a caller who guessed it
  // once will guess it again, and a dropped caption is a silent loss: zod strips
  // an unknown key from a NESTED object rather than refusing it, so the media
  // would have rendered captionless with no error to read.
  const text = pickAliasOptional(at, { name: "caption", value: caption }, { name: "label", value: label });
  if (!text.ok) return text;
  if (text.value !== undefined) out.caption = text.value;

  return { ok: true, value: out };
}

/**
 * #1968 — `panel_set_todo` items: accept `content` for `text`.
 *
 * "todo" is in the tool's name and `content` is the key the analogous built-in
 * TODO surface uses, so it is the first guess. It failed as a SECOND error after
 * `todos`-for-`items` was fixed, because zod strips an unrecognized key from a
 * nested object and then reports the canonical one missing — the caller pays two
 * round trips for one misnamed pair.
 *
 * `text` is therefore OPTIONAL in the schema and required HERE, so that a missing
 * step description is still refused — the alias widens which spelling lands, and
 * must not quietly make the field itself skippable.
 */
export function normalizeTodoItemKeys(
  items: Array<Record<string, unknown>>,
): AliasPick<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: `panel_set_todo items[${index}] is not an object.` };
    }
    const { content, ...rest } = item;
    const picked = pickAlias(
      `panel_set_todo items[${index}]`,
      { name: "text", value: rest.text },
      { name: "content", value: content },
    );
    if (!picked.ok) return picked;
    out.push({ ...rest, text: picked.value });
  }
  return { ok: true, value: out };
}

/** pickAlias for a pair that is genuinely OPTIONAL: absent on both sides is a
 *  valid answer (undefined), while a conflicting pair is still refused. */
function pickAliasOptional<T>(
  subject: string,
  canonical: { name: string; value: T | undefined },
  alias: { name: string; value: T | undefined },
): AliasPick<T | undefined> {
  if (canonical.value === undefined && alias.value === undefined) return { ok: true, value: undefined };
  return pickAlias(subject, canonical, alias);
}

/** The projections `panel_find_nodes` offers, matching `panel_query_graph`'s
 *  `fields` exactly — same three names, same meanings, so one is learned once. */
export const FIND_NODES_FIELDS = ["ids", "compact", "detail"] as const;
export type FindNodesFields = (typeof FIND_NODES_FIELDS)[number];

/**
 * The default is `compact`, NOT `detail`, and that is a deliberate behaviour
 * change (#1968).
 *
 * `find_nodes` had no verbosity control at all while its sibling `query_graph`
 * defaulted to compact, so a search — the cheap orienting call — was the most
 * expensive read on the surface. The reporter measured four matches on a
 * TEN-node graph returning a very large payload; on a realistic 50-node graph
 * with a common term that is a meaningful fraction of an agent's context spent
 * on a lookup. Full detail is still one argument away and the reply says which
 * projection it applied, so nothing is lost silently.
 */
export const FIND_NODES_DEFAULT_FIELDS: FindNodesFields = "compact";

/**
 * The keys a `compact` match row keeps.
 *
 * Everything that says WHICH node this is and WHY it matched; nothing that
 * re-describes the node's interior. The dropped keys are the bulk — `widgets`,
 * `inputs` (each with its `connected_from`), `outputs`, and the node
 * `description` — and every one of them is reachable per-node with
 * panel_query_graph({ids:[id], fields:'detail'}) or by re-running with
 * fields:'detail'.
 *
 * `matched_on` is KEPT on purpose even though it is a list: it is the answer to
 * the question the caller asked (why is this node in my results?), and dropping
 * it would make a compact result a worse search reply rather than a cheaper one.
 */
const COMPACT_MATCH_KEYS = [
  "id",
  "type",
  "title",
  "mode",
  "is_output",
  "is_subgraph",
  "matched_on",
] as const;

/**
 * Project one match row. Unknown keys are DROPPED for compact, not carried:
 * carrying them would make the bound depend on the panel build, and a projection
 * that shrinks by an unpredictable amount is not a bound at all.
 */
function compactMatch(match: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of COMPACT_MATCH_KEYS) {
    if (match[key] !== undefined) out[key] = match[key];
  }
  return out;
}

/**
 * Apply a `fields` projection to a `graph_find_nodes` payload, IN PLACE on a copy.
 *
 * Returns null when there was nothing to project — no `matches` array, or
 * `fields:'detail'`, which is today's behaviour byte for byte. A null return is
 * how the caller knows NOT to stamp `fields` onto the reply: announcing a
 * projection that did not run is the "schema says accept, not do" defect, and it
 * would be indistinguishable from a real one to the agent reading it.
 */
export function projectFindNodesPayload(
  payload: Record<string, unknown>,
  fields: FindNodesFields,
): Record<string, unknown> | null {
  if (fields === "detail") return null;
  const matches = payload.matches;
  if (!Array.isArray(matches)) return null;

  const projected =
    fields === "ids"
      ? matches.map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).id : m))
      : matches.map((m) =>
          m && typeof m === "object" ? compactMatch(m as Record<string, unknown>) : m,
        );

  return { ...payload, matches: projected, fields };
}
