# Vendored Oxlint rules: anti-slop

`tools/oxlint/anti-slop/` is a copy of the Oxlint plugin from
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), a set of rules that
reject TypeScript which asserts a shape it has no evidence for. Upstream asks to
be vendored rather than depended on ("the vendored files are yours to maintain"),
so the copy lives here and is ignored by the linter itself.

| | |
|---|---|
| Upstream commit | `6d538555cb151d4121ed51a27db81890eacf8ae9` |
| Upstream commit date | 2026-08-18 |
| Vendored on | 2026-08-20 |
| Copied with | `node <anti-slop>/skills/install-anti-slop/scripts/install.mjs` (the upstream skill's installer, run from the repo root) |
| Pinned to | `oxlint@1.79.0` and `@oxlint/plugins@1.79.0`, exact |

The two packages are pinned exactly, not with a caret: the plugin API is matched
release to release, and a range that let one of them drift ahead of the other
would break the plugin load in a way that looks like a clean lint. Bump them
together.

The `effect/` directory is part of the upstream copy and is NOT registered in
`.oxlintrc.json` — this repo has no `effect` dependency. It is kept so a future
re-sync is a plain diff against upstream rather than a partial one.

This directory is neither compiled nor shipped: `tsconfig.json` includes only
`src/**`, and `package.json#files` is a whitelist that does not name `tools/`.

## How it is wired

- `.oxlintrc.json` registers the plugin and turns every built-in Oxlint category
  OFF. Only anti-slop rules run; the built-ins are a separate decision nobody has
  made yet, and mixing them into this baseline would make that decision by
  accident. Run `npx oxlint src scripts` and every code is `anti-slop(...)`.
- `scripts/check-anti-slop.mjs` runs oxlint, aggregates findings per file per
  rule, and compares them with `scripts/anti-slop-baseline.json`. The baseline
  may shrink and never grow. It is part of `npm run lint` and a named CI step.
- Waive a finding at the site, with a reason, on one line:
  `// oxlint-disable-next-line anti-slop/<rule> -- <why>`. A directive with no
  reason fails the gate. A `//` directive must not wrap — the continuation
  comment becomes the "next line" and the directive misses the code; use a
  `/* … */` block when the reason needs the room.

## Rules ON (`"error"`, gated by the baseline)

These seven produced 780 findings on the tree they landed on, almost all of them
`no-chained-type-assertions` in tests. Each is a pattern this codebase has
already paid for once (see #796, the unknown-collapse gate).

| Rule | What it rejects |
|---|---|
| `no-chained-type-assertions` | `x as unknown as Foo` — laundering a value through `unknown` into a precise type |
| `no-widen-then-assert` | a binding typed wider than its initialiser, then narrowed back with an assertion |
| `no-unknown-type-aliases` | `type Foo = unknown` — a name that promises a shape and delivers none |
| `no-object-parameters` | a parameter typed as the `object` keyword (not destructuring — the broad type) |
| `no-reflect-apply` | `Reflect.apply(...)` where a direct call would be type-checked |
| `no-reflect-get` | `Reflect.get(obj, key)` where a property access would be type-checked |
| `no-unknown-returns` | a function whose declared return type is `unknown` / `Promise<unknown>` |

## Rules OFF, and why

Hit counts are from `src scripts` at the vendored commit. A rule is off because
its findings on this tree are mostly not defects, not because the pattern is
endorsed. Revisit any of these by turning it on, running `--baseline`, and
reviewing what the diff says.

| Rule | Hits | Why off |
|---|---|---|
| `require-safety-comment-for-type-assertion` | 5626 | Trivially satisfiable — an empty `SAFETY:` marker passes ([upstream #24](https://github.com/dmmulroy/anti-slop/issues/24)), so at this volume it would produce 5.6k markers and no safety. |
| `no-unsafe-dictionary-type` | 1447 | `/object_info` and workflow JSON are open dictionaries by nature; `Record<string, …>` is the honest type for them. |
| `no-runtime-typeof` | 1380 | House style hand-narrows ComfyUI JSON with `typeof` guards; there is no schema layer to replace them with. |
| `no-unknown-parameters` | 823 | Boundary parsers take `unknown` by design — that is what makes them boundaries. |
| `no-module-mocking` | 623 | CONTRIBUTING mandates mocking `node:fs`, `node:child_process`, and `fetch` so tests never touch disk, process, or network. |
| `no-known-value-widening` | 587 | False-positive heavy: a `Record` with a closed key set is reported as widening ([upstream #18](https://github.com/dmmulroy/anti-slop/issues/18), 117 of 150 reports there). |
| `no-shape-in-symbol-names` | 509 | Substring match; it flags the legitimate `shape: "stamped" \| "unstamped" \| "unstated"` discriminant in `panel-tools.ts` along with everything else containing "shape". |
| `no-conditional-empty-object-spread` | 313 | Key omission is load-bearing in MCP results (an absent key and an `undefined` key are different things to `in` checks and `Object.keys`), and `exactOptionalPropertyTypes` is not on, so the "fix" would type-check while changing behaviour. |

## Re-syncing with upstream

```sh
git clone https://github.com/dmmulroy/anti-slop /tmp/anti-slop
node /tmp/anti-slop/skills/install-anti-slop/scripts/install.mjs --force   # from the repo root
git diff -- tools/oxlint/anti-slop                                         # read it
node scripts/check-anti-slop.mjs --baseline                                # stricter rules may grow the baseline; say so in the PR
```

Update the commit and dates in the table above. Match `oxlint` and
`@oxlint/plugins` to upstream's `package.json` (query `npm view <pkg> version`
for the current pair) and bump both together.
