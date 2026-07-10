# `calculate` — safe batch expression evaluator

**Status:** implemented (this PR)

> Prior art: [filliptm/ComfyUI_FL-MCP](https://github.com/filliptm/ComfyUI_FL-MCP) `backend/calc.py` — a batch math evaluator with persistent assignments, seeded RNG, and a strict AST whitelist. Python got safety cheap via `ast`; our TypeScript equivalent is a tiny hand-rolled parser — **no `eval`/`new Function`, ever**.

## Motivation

Agents constantly do arithmetic they get wrong token-by-token: SDXL-legal resolutions from an aspect ratio (`floor(sqrt(1024*1024*ar)/64)*64`), tile/grid layout math, cfg/denoise sweeps, reproducible seed batches. A connection-free `calculate` tool answers these exactly, in one call, and is one of the few tools that works even when ComfyUI is down.

## Parser decision: zero-dep hand-rolled Pratt parser

Verified: runtime deps are 8 heavyweight-for-a-reason packages; nothing expression-related exists in deps or `src/`. Adding a dependency for ~150 lines of parser contradicts the repo's lean-deps philosophy, and `expr-eval` is unmaintained with past prototype-pollution advisories. Recursive-descent/Pratt it is.

## Tool API

`calculate` — category `diagnostics`, pure, no ComfyUI connection (usable in cloud mode):

```ts
{
  spec: z.union([z.string(), z.array(z.string())])
    .describe("Expressions to evaluate, separated by newlines/semicolons (string) or one per array item. `name = expr` assigns; assignments persist across subsequent lines. NOTE: comma is an argument separator (min(a,b)), NOT an expression separator."),
  variables: z.record(z.string(), z.number()).optional()
    .describe("Initial variable environment, e.g. {\"w\": 1024, \"ar\": 1.5}."),
  seed: z.number().int().optional()
    .describe("Seed for rand()/uniform(a,b)/randint(a,b). Same seed => identical sequence (mulberry32). Omit for a random seed (echoed in the result)."),
}
```

**Deliberate deviation from FL-MCP:** `calc.py` splits on commas too, which breaks `min(1, 2)` unless the caller knows the quirk. We split only on newlines and semicolons; the parser handles commas inside call argument lists. Documented in the tool description.

Result (text + machine-readable):

```
results:   [5, 2.5, 1216]
variables: { w: 1216, h: 832, ar: 1.4615... }
seed:      123456789   (echoed or generated)
```

Per-line errors do **not** abort the batch: an erroring line yields `results[i] = null` plus an entry in `errors: [{ line, expr, message }]` — better for agents than FL-MCP's fail-fast, since they see exactly which line broke. Total failure (nothing parseable) still returns `isError` via `errorToToolResult`.

## Evaluator design — `src/services/calc-evaluator.ts` (pure, ~200 lines)

- **Tokenizer:** numbers (int/float/scientific), identifiers, operators `+ - * / // % **`, comparisons `< <= > >= == !=` (returning 1/0 — useful for sweeps/clamps), parens, comma, `=`.
- **Pratt parser → direct evaluation** (no retained AST): precedence `= (statement) < comparison < add < mul < unary < ** (right-assoc) < call/primary`. Assignment only as a full statement `name = expr` (FL-MCP's restriction; no chained `a = b = 1`).
- **Environment:** `Map<string, number>` seeded from `variables`; constants `pi, e, tau`; function table (numbers only — no strings/objects): `abs round min max pow sqrt floor ceil sin cos tan asin acos atan atan2 sinh cosh tanh exp log log10 log2 hypot radians degrees sign trunc clamp(x,lo,hi)` plus `rand() random() uniform(a,b) randint(a,b)`. Arity-checked; unknown identifier/function → line error.
- **Seeded RNG:** mulberry32, instantiated per call from `seed >>> 0`; when omitted, drawn from `crypto.randomInt` and echoed so runs are reproducible after the fact. `randint(a,b)` inclusive both ends (matches Python `random.randint`).
- **Safety:** no property access, no strings, no arrays, no `eval`; results are `number` only; caps (≤1000 expressions, ≤10k chars each); NaN/Infinity passed through but flagged in the rendered text.

```ts
export function evaluateBatch(
  spec: string[],
  variables?: Record<string, number>,
  seed?: number,
): {
  results: (number | null)[];
  variables: Record<string, number>;
  errors: { line: number; expr: string; message: string }[];
  seed: number;
}
```

## Implementation plan

1. `src/services/calc-evaluator.ts` — tokenizer, Pratt evaluator, mulberry32, `evaluateBatch`.
2. `src/tools/calculate.ts` — `registerCalculateTools(server)`: schema above, spec normalization (split/trim/drop-empty, minus commas), rendering, `errorToToolResult`. Motivating examples in the description (aspect-ratio snap-to-64, per-line `randint(0, 2**32-1)` seed batches, cfg sweeps).
3. `src/tools/index.ts` — append `["diagnostics", registerCalculateTools]` to `TOOL_GROUPS` (order-stability rule: append-only).

## Test plan (vitest)

`src/__tests__/services/calc-evaluator.test.ts` (bulk of coverage, pure): precedence incl. right-assoc `2**3**2 = 512`; unary minus `-2**2`; floordiv/mod; comparisons; assignments persisting and returned; input `variables` respected and not mutated; determinism — same seed twice → identical sequences, mulberry32 known-answer for seed 42; `randint` bounds inclusivity over many draws; per-line error isolation (later lines still evaluate); rejection of `constructor`, `__proto__`, property-access syntax, string literals; spec-size limits. Thin `src/__tests__/tools/calculate.test.ts` for schema/rendering.

## Rollout / compat

Additive and connection-free. Registers through `TOOL_GROUPS`, so the compact router catalog picks it up automatically. No gates (pure computation).
