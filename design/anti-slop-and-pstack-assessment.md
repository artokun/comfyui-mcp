# anti-slop and pstack: what they are worth on this codebase

Written after an overnight batch that applied both projects to comfyui-mcp in eleven
parallel worktree PRs. The question it answers is the one that started the batch:
how do these two net out, and should the other repos I maintain adopt them?

Measured on `main` at `1a1703ef` (2026-08-20): 918 TypeScript files, 400k lines, of which
186k are non-test source and 214k are tests. The repo had no linter; `npm run lint` was
`tsc --noEmit`.

## The two projects, in one paragraph each

**dmmulroy/anti-slop** is not a prose style guide. It is sixteen Oxlint AST rules that
reject "low-evidence" TypeScript: `x as unknown as T`, `unknown` in parameters and
returns, `Record<string, unknown>`, bare `typeof` checks, `vi.mock`, a symbol named
`shape`, and a type assertion without a `SAFETY:` comment. It is vendored, not published
(the author disabled PRs and left the package private on purpose). It is a week old,
has 3.2k stars, and its own largest adoption report (issue #21, a 568k-line monorepo)
kept six rules and rejected or deferred the other ten for false positives.

**michael-denyer/pstack-claude** is a global Claude Code plugin: 48 skills, 27 slash
commands, 21 "principle" leaf skills, 17 playbooks, and one SessionStart hook, about
200 KB of instruction prose ported from Cursor's pstack. Three things in it are
mechanical (the hook, a self-test script, a TSV logger). Everything else is text the
model reads. Nothing installs into a repository. The parts that can touch a repo are
the `unslop` prose rules (31 of them), the `deslop` diff rules, the
`thermo-nuclear-code-quality-review` rule that no PR pushes a file past 1,000 lines,
and `principle-encode-lessons-in-structure`: the second time you write the same
instruction, turn it into a lint or a CI gate.

The last of those is the most important sentence in either project for us, and this
repo already practices it. `scripts/check-unknown-collapse.mjs` (#796) and the SHA-pinned
tool vocabulary are exactly the shape pstack recommends. The batch extended that idiom
rather than replacing it.

## anti-slop, rule by rule

All fifteen generic rules were run over `src/` and `scripts/` before any change.
12,086 diagnostics. Here is each rule with its count and the verdict the batch acted on.

| Rule | Prod | Test | Verdict | Why |
|---|---:|---:|---|---|
| `no-chained-type-assertions` | 65 | 588 | **on** | The one rule that earns its place. `x as unknown as T` launders a value past every other check. See the pilot below. |
| `no-widen-then-assert` | 1 | 0 | **on** | Free. |
| `no-reflect-get` | 2 | 0 | **on** | Both sites are Proxy `get` traps, where `Reflect.get` is the correct idiom. Justified with a disable-next-line comment that says so. |
| `no-unknown-type-aliases`, `no-object-parameters`, `no-reflect-apply` | 0 | 4 | **on** | Free. |
| `no-unknown-returns` | 50 | 68 | **on, tracked** | `readJsonBody(): Promise<unknown>` is the boundary the rule says to parse at. Ratcheted so new ones need a reason; existing ones are not wrong. |
| `require-safety-comment-for-type-assertion` | 1,412 | 4,201 | off | Satisfied by an empty `SAFETY:` marker (upstream #24). A comment-presence rule is not a type-safety rule. |
| `no-runtime-typeof` | 1,184 | 133 | off | The house style narrows ComfyUI's JSON by hand. There is no schema layer, and the rule is near-unusable without one (its README says as much). |
| `no-unsafe-dictionary-type` | 656 | 786 | off | `/object_info` and workflow JSON are open dictionaries. That is what they are. |
| `no-unknown-parameters` | 438 | 381 | off | Boundary parsers take `unknown` by design; the rule bans writing a type guard (upstream #15). |
| `no-known-value-widening` | 374 | 208 | off | Upstream #18: "117 of 150 reports are provably no-op edits." |
| `no-conditional-empty-object-spread` | 274 | 36 | off | Key omission is load-bearing in MCP results. The rewrite it wants reads worse. |
| `no-shape-in-symbol-names` | 103 | 386 | off | Substring match. Flags `shape: "stamped" \| "unstamped"`, a legitimate discriminant. |
| `no-module-mocking` | 0 | 623 | off | CONTRIBUTING mandates mocking `node:fs`, `node:child_process`, and `fetch`. |

Seven on, eight off. This matches the upstream adoption report almost exactly, which
is the strongest evidence that the split is about the rules and not about this repo.

### What the tier-1 fixes found

Removing the 65 production `as unknown as` chains (units 2 and 3) was type-level work
with byte-identical emitted JavaScript. The pattern in `src/orchestrator/panel-tools.ts`
was `ctx.bridge as unknown as { someOptionalMethod?: unknown }` to probe bridge members
without declaring them; the fix was to declare them. In `src/services` the chains were
mostly a single assertion written as two. Five review agents over both diffs found no
behavior change. One found a sequential `for await` over six independent model-category
fetches in `runHealthCheck`, which predates the batch and is a separate fix.

### The test pilot: 46 casts in `src/__tests__/comfyui`

This is the number the assessment turns on, because 588 of the 653 chained-assertion
hits are in tests, all of the form `{ ...mock } as unknown as RealType`. Unit 4 fixed
one directory properly and timed it.

| Finding | Number |
|---|---:|
| Casts before / after | 46 / 0 |
| Genuine double casts that had to stay | 0 |
| Casts that were never needed (deleting the text was the fix) | 25 |
| Casts asserting a method the mock did not define (a latent wiring bug) | 4 |
| Helpers added (`fakeFetch`, `jsonResponse`, `targetUrl`) | 3, with 7 tests |
| Wall-clock per ten casts | 7 to 8 minutes, almost all of it reading |
| Other anti-slop diagnostics in the tree, as a side effect | 414 to 240 |

The finding that matters more than the count: **the test tree does not type-check.**
`tsconfig.json` excludes `src/__tests__`, and vitest strips types without checking
them. A scratch tsconfig over `comfyui/` and `helpers/` reports 17 pre-existing errors;
the one the pilot fixed was a cast site, where `as unknown as typeof fetch` hid a spy
declared with no parameters. Over the whole `src/__tests__` tree the count is about
500. Without a type-check gate for tests, "typed fake" is a claim nobody verifies, and
`no-chained-type-assertions` in tests is a rule about evidence that no checker reads.

Profiling the remaining 514 test casts by target type: 190 are `PanelToolCtx["bridge"]`
and 58 are a whole `PanelToolCtx`, so one factory family absorbs 48% of what is left.
56 are `typeof fetch`, most deletable outright. About 99 are inline private-surface
shapes (`QMPriv` and friends), each a design decision. The rest is a long tail.

## pstack, part by part

| Part | Applied here as | Result |
|---|---|---|
| `unslop` (31 prose rules) | Units 5 to 9: README, CONTRIBUTING, ROADMAP, llms-install, 11 commands, 4 agents, 39 plugin skills | README: 115 em dashes to 54 (every survivor in a table, fence, or the H1), 12 connector colons to 0, 3 emoji to 0, `automatically` 7 to 0. CONTRIBUTING + ROADMAP + prompts: 221 to 30, prose 191 to 0. Skills A: 292 to 53, banned words 21 to 5. Skills B: prose em dashes 232 to 1, 12,724 words to 12,605, and one unbalanced code fence found and fixed. Skills C: 399 to 82. Every survivor is in a heading, table, fence, URL, or quoted prompt. Link sets and heading sets byte-identical before and after in every file; `sync-agents.mjs` and the skill-authoring tests caught the one regression (a `: ` in a frontmatter description is nested YAML). |
| `thermo-nuclear` 1k-line rule | Unit 10: `scripts/check-file-size.mjs`, a shrink-only baseline of the 40 files already over the limit | `panel-tools.ts` is 17,813 lines. The gate does not shrink it; it stops the 41st file and stops the 40 from growing. |
| `deslop` | Unit 11 | 13 colocated tests moved to the documented `__tests__` mirror, 5 `eslint-disable` comments with no ESLint deleted, a dead `test:integration` script deleted. The move also fixed a real bug: those 13 tests were inside `tsc`'s include, so `npm run build` compiled them into `dist/` and the published tarball shipped 26 test files that import `vitest`, a devDependency. Now 0. |
| `principle-encode-lessons-in-structure` | The whole batch | Three ratchets in the `check-unknown-collapse` idiom now exist (unknown-collapse, anti-slop, file-size). The next one should extract the shared walker and flag parser into `scripts/lib/`. |
| Everything else (poteto-mode, playbooks, arena, interrogate, babysit, why, how, …) | Not applied; it is user-level | See the recommendation below. |

What the prose pass cost and what it bought: about 11k lines of skill prose were
rewritten with meaning pinned by invariants (frontmatter keys, trigger keywords, node
and model names, code blocks, tables, headings, `## Sources` sections). The skills are
LLM-facing prompts shipped to npm, so plainer prose is cheaper per invocation and
harder to misread. Nothing measured that; it is the argument pstack makes and it is
plausible. The em-dash purge is the part of `unslop` most people will disagree with,
and the diff shows why it is expensive: 115 em dashes in the README alone, each one a
sentence restructured by hand.

## How they net out

**anti-slop**: worth vendoring for seven rules, not sixteen. The value is concentrated
in one rule, `no-chained-type-assertions`, and that rule's value in tests depends on a
type-check gate this repo does not have yet. The other eight rules assume a
schema-parsing culture (zod, Effect Schema) that a ComfyUI client talking to
`/object_info` does not have and should not fake. Treat the vendored copy as ours, as
the author says to; it has no upstream to track.

**pstack**: two of its ideas are worth a CI gate each (done), its prose rules are worth
one pass over shipped prompt text (done), and the rest is a workflow plugin that lives
in `~/.claude`, not in a repo. Installing it globally is a personal choice with a real
context-window cost: the hub skill alone is 16 KB and it mandates reading a 21-entry
principle index before every non-trivial task. Its own `principle-guard-the-context-window`
argues against that. Try it for a week with `/plugin install pstack@pstack-claude`;
the SessionStart hook can be deleted if the mandate is too loud. Nothing about that
decision belongs in this repo, and `.claude/` is gitignored here on purpose.

## Portability to comfyui-mcp-panel and comfyui-mcp-relay

Same maintainer, same TypeScript, npm, vitest stack, same SHA-ratchet idiom. The
checklist, in the order that pays fastest:

1. **A tests tsconfig and a `lint:tests` gate, ratcheted to today's error count.** This
   is the prerequisite for every type-level rule in tests. It costs an afternoon and it
   is what the 46-cast pilot said to do first.
2. **Vendor anti-slop with the seven-rule config** from `tools/oxlint/README.md` and the
   `scripts/check-anti-slop.mjs` ratchet. Copy both; change nothing but the baseline.
3. **The file-size ratchet**, if the repo has any file over 1,000 lines. If it does not,
   the gate with an empty baseline is the cheapest possible way to keep it that way.
4. **`unslop` on shipped prompt text only** (skills, commands, agents, tool descriptions
   if they are not SHA-pinned). Not on docs with locale mirrors; that is a retranslation
   round. Not on design docs or changelogs; they are records.
5. **`no-chained-type-assertions` in production code**: fix on touch, not as a sweep.
   65 sites here took two units a night and found nothing wrong.
6. Skip `require-safety-comment`, `no-runtime-typeof`, `no-unknown-parameters`, and
   `no-unsafe-dictionary-type` until the repo has a schema layer at its I/O boundary.
   If it never gets one, that is fine; those rules are not for it.

## What the batch left behind

Follow-ups filed or noted in PR bodies, none blocking:

- Tests are not type-checked (`tsconfig` excludes `src/__tests__`, ~500 errors). A
  ratcheted `tsconfig.test.json` is the fix. The 13 moved tests in unit 11 lost the
  incidental coverage they had by being in the main include.
- Second typed-fake pilot for the `PanelToolCtx`/`bridge` family (248 casts, one shape).
- `scripts/tool-doc-examples.ts` is 1,202 lines and outside the file-size gate's `src/`
  scope.
- Three gates now duplicate a walker and a flag parser; extract `scripts/lib/gate.mjs`.
- Two design docs still describe an opt-in `COMFYUI_INTEGRATION=true` test mode that
  nothing reads.
- 16 vitest failures on macOS in `services/{extra-paths*,comfy-view-ref,training-datasets}`
  from `/var` vs `/private/var` realpath containment; green on CI's Ubuntu
  (`comfyui-mcp-1qe`).
- `runHealthCheck` fetches six model categories sequentially.
- The README's `npm run lint` table row still says "type-check without emitting"; it
  now also runs two ratchets.

## PRs

| Unit | PR |
|---|---|
| 1 anti-slop foundation (merge last; the coordinator regenerates its baseline against `main` first) | #1988 |
| 2 tier-1 fixes, orchestrator | #1992 |
| 3 tier-1 fixes, services / tools / comfyui / scripts | #1993 |
| 4 typed-fake pilot, `__tests__/comfyui` | #1976 |
| 5 unslop README | #1970 |
| 6 unslop CONTRIBUTING, ROADMAP, llms-install, commands, agents | #1987 |
| 7 unslop skills A | #1974 |
| 8 unslop skills B | #1991 |
| 9 unslop skills C | #1989 |
| 10 file-size ratchet | #1975 |
| 11 repo hygiene | #1990 |
