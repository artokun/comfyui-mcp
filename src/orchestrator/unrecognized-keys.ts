/**
 * #1969 — an unrecognized argument key used to name only itself.
 *
 * Trajectories for the in-house panel model are server-VERIFIED, so they
 * contain only successful calls. A 2–4B model never sees the error-to-recovery
 * transition; a frontier model infers it from sibling tools. The cheap runtime
 * substitute is to JOIN the two halves of the refusal the caller already gets:
 *
 *     unrecognized_keys: ["group"]
 *     expected number, received undefined at group_id
 *
 * into one line a small model can act on:
 *
 *     Unrecognized key 'group' — did you mean 'group_id'?
 *
 * This does NOT accept the wrong key (that's #1968's aliases). It only names
 * the intended one. Wired through `strictPanelSchema` so both transports see it.
 */

import { safeParse, type z } from "zod";

/** Structural slice of a Zod 4 unrecognized_keys issue. The full $ZodRawIssue
 *  type is internal; this is what `finalizeIssue` actually hands the error map. */
export type UnrecognizedKeysIssue = {
  code?: string;
  keys?: string[];
  input?: unknown;
};

const COMMON_SUFFIXES = ["_id", "_ids", "_name", "_key"];

/**
 * Levenshtein distance. Keys are short (a handful of characters); a full DP
 * table is cheaper than importing a package, and this runs only on the
 * validation-failure path.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

function fold(s: string): string {
  return s.toLowerCase().replace(/-/g, "_");
}

function compact(s: string): string {
  return fold(s).replace(/_/g, "");
}

/** True when one name is the other plus a separator/`_id`-style suffix —
 *  `group` vs `group_id`, `groupid` vs `group_id`. Not a general thesaurus. */
export function isAffixMatch(a: string, b: string): boolean {
  const fa = fold(a);
  const fb = fold(b);
  if (fa === fb) return true;
  const [shorter, longer] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  if (longer.startsWith(`${shorter}_`) || longer.endsWith(`_${shorter}`)) return shorter.length >= 2;
  const ca = compact(a);
  const cb = compact(b);
  const [cs, cl] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (cs.length < 3 || !cl.startsWith(cs)) return false;
  // Same letters, different separators: `groupid` vs `group_id`.
  if (cs === cl) return true;
  return COMMON_SUFFIXES.includes(`_${cl.slice(cs.length)}`);
}

function distanceThreshold(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  if (n <= 3) return 1;
  if (n <= 6) return 2;
  return 3;
}

/**
 * Closest known key, or undefined when nothing is close enough to recommend
 * OR when two candidates fit equally well.
 *
 * Prefer an affix match over a mere edit distance, so `group` → `group_id`
 * beats a coincidental neighbour of the same length.
 */
export function suggestKnownKey(
  unknown: string,
  candidates: readonly string[],
  fits?: FitsPredicate,
  value?: unknown,
): string | undefined {
  const folded = fold(unknown);
  let tied: string[] = [];
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c === unknown) continue;
    const fc = fold(c);
    if (fc === folded) return c;
    let score: number;
    if (isAffixMatch(unknown, c)) {
      // #1969 review — every affix match is the SAME quality of evidence: the
      // name is the other one plus a separator/suffix. Ranking them by length
      // difference is not evidence, and it invented a winner — `panel_connect`
      // called with `id` affix-matches both `from_node_id` and `to_node_id`,
      // and the length tiebreak silently answered "did you mean 'to_node_id'?"
      // on what is a coin flip.
      score = 0;
    } else {
      const d = editDistance(folded, fc);
      if (d > distanceThreshold(folded, fc)) continue;
      // Affix scores are 0; offset typos so they cannot outrank an affix.
      score = 1 + d;
    }
    if (score < bestScore) {
      bestScore = score;
      tied = [c];
    } else if (score === bestScore) {
      tied.push(c);
    }
  }
  if (tied.length === 1) return tied[0];
  // The NAMES tie, so let the VALUE break it — but only when exactly one
  // candidate would accept what the caller actually sent. `panel_edit_node`
  // carries both `node_id` and `node_ids`, so `node: 5` ties on the name and
  // is decided by the 5 (a scalar is not a `node_ids`). `panel_connect` called
  // with `id: 5` stays ambiguous, because a number fits both endpoints — and
  // there, naming one is a guess wearing the same phrasing as a real match.
  if (tied.length > 1 && fits) {
    const accepting = tied.filter((c) => fits(c, value));
    if (accepting.length === 1) return accepting[0];
  }
  return undefined;
}

function providedKeys(input: unknown): Set<string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return new Set();
  return new Set(Object.keys(input as Record<string, unknown>));
}

function valueAt(input: unknown, key: string): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  try {
    return (input as Record<string, unknown>)[key];
  } catch {
    // A revoked proxy throws on read. No value is not a fit.
    return undefined;
  }
}

/**
 * A paired unrecognized key, and how strong the claim behind the pairing is.
 *
 * `confident` separates a statement about the KEY ("these two names denote the
 * same argument") from a statement about the SCHEMA ("one key is unknown and
 * one required key is missing"). Both are worth telling the caller; only the
 * first may be phrased as "did you mean".
 */
export type KeyPairing = { key: string; confident: boolean };

/** Does the value supplied under the wrong key parse under a candidate key's
 *  schema? Used only to promote a structural 1:1 join to a confident one. */
export type FitsPredicate = (target: string, value: unknown) => boolean;

/**
 * Pair each unrecognized key with at most one known key.
 *
 * 1. Confident match (affix / short edit) against missing required keys.
 * 2. Same, against every known key (optional fields included).
 * 3. If exactly one unknown and exactly one required key remain, join them
 *    even when the names are not similar (`todos` vs `items`). That is the
 *    "information is present but the caller has to join it" case.
 *
 * Rules 1 and 2 are always confident — they matched on the NAME. Rule 3 is a
 * structural coincidence of counts and is confident only when `fits` agrees
 * the caller's value would also parse under the target. See the note at the
 * rule-3 branch for the surface measurement behind that split.
 */
export function pairUnrecognizedKeys(
  unknownKeys: readonly string[],
  knownKeys: readonly string[],
  requiredKeys: readonly string[],
  input: unknown,
  fits?: FitsPredicate,
): Map<string, KeyPairing> {
  const suggestions = new Map<string, KeyPairing>();
  const used = new Set<string>();
  const present = providedKeys(input);
  const missingRequired = requiredKeys.filter((k) => !present.has(k));

  const take = (unknown: string, pool: readonly string[]): void => {
    const leftover = pool.filter((k) => !used.has(k) && k !== unknown);
    const match = suggestKnownKey(unknown, leftover, fits, valueAt(input, unknown));
    if (!match) return;
    suggestions.set(unknown, { key: match, confident: true });
    used.add(match);
  };

  for (const k of unknownKeys) take(k, missingRequired);
  for (const k of unknownKeys) {
    if (!suggestions.has(k)) take(k, knownKeys);
  }

  const leftoverUnknown = unknownKeys.filter((k) => !suggestions.has(k));
  const leftoverMissing = missingRequired.filter((k) => !used.has(k));
  if (leftoverUnknown.length === 1 && leftoverMissing.length === 1) {
    const unknown = leftoverUnknown[0]!;
    const target = leftoverMissing[0]!;
    // #1969 review — rule 3 holds because the COUNTS line up, not because the
    // names mean the same thing, and 34 of the 95 live panel tools take exactly
    // one required key. So without this split every one of them answered any
    // stray key with a confident guess: `panel_remove_node {dry_run: true}`
    // replied "did you mean 'node_id'?", phrased identically to the true
    // `group` → `group_id` case and indistinguishable from it by the 2–4B
    // models this whole change exists to serve. Promote to "did you mean" only
    // when the VALUE the caller sent also parses under the target's schema —
    // which still covers the reporter's `todos` → `items`, because the todo
    // array they sent is a valid `items`.
    const confident = fits ? fits(target, valueAt(input, unknown)) : false;
    suggestions.set(unknown, { key: target, confident });
  }
  return suggestions;
}

function quoteKey(k: string): string {
  return `'${k.replace(/'/g, "\\'")}'`;
}

/** The sentence a caller reads. Never throws — a formatter that throws turns
 *  a clean validation refusal into a 500. */
export function formatUnrecognizedKeyMessage(
  keys: readonly string[],
  knownKeys: readonly string[],
  requiredKeys: readonly string[],
  input: unknown,
  fits?: FitsPredicate,
): string {
  try {
    const unique = [...new Set(keys)];
    const paired = pairUnrecognizedKeys(unique, knownKeys, requiredKeys, input, fits);
    return unique
      .map((k) => {
        const suggestion = paired.get(k);
        if (!suggestion) return `Unrecognized key ${quoteKey(k)}`;
        // An unconfident pairing still carries both halves of the join in one
        // sentence — which is the whole ask — but states the schema fact it
        // actually knows instead of guessing at intent.
        return suggestion.confident
          ? `Unrecognized key ${quoteKey(k)} — did you mean ${quoteKey(suggestion.key)}?`
          : `Unrecognized key ${quoteKey(k)} — required key ${quoteKey(suggestion.key)} is missing`;
      })
      .join("; ");
  } catch {
    const listed = keys.map((k) => quoteKey(k)).join(", ");
    return `Unrecognized key${keys.length > 1 ? "s" : ""} ${listed}`;
  }
}

function requiredKeysOf(shape: z.ZodRawShape): string[] {
  const keys: string[] = [];
  for (const [k, schema] of Object.entries(shape)) {
    try {
      // ZodRawShape values are typed as core $ZodType (no `.safeParse` method).
      // The top-level helper accepts that shape.
      if (!safeParse(schema, undefined).success) keys.push(k);
    } catch {
      // A throwing probe is not evidence the field is required.
    }
  }
  return keys;
}

/**
 * Zod 4 `error` map for a strict object. Returns a message only for
 * `unrecognized_keys`; every other issue falls through to the locale default.
 */
export function unrecognizedKeysError(shape: z.ZodRawShape): (iss: UnrecognizedKeysIssue) => string | undefined {
  const knownKeys = Object.keys(shape);
  const requiredKeys = requiredKeysOf(shape);
  // Runs only on the validation-failure path, and only for the single leftover
  // candidate — never across the whole shape.
  const fits: FitsPredicate = (target, value) => {
    const schema = shape[target];
    if (!schema) return false;
    try {
      return safeParse(schema, value).success;
    } catch {
      // A throwing probe is not evidence the value fits.
      return false;
    }
  };
  return (iss) => {
    if (iss.code !== "unrecognized_keys" || !iss.keys?.length) return undefined;
    return formatUnrecognizedKeyMessage(iss.keys, knownKeys, requiredKeys, iss.input, fits);
  };
}
