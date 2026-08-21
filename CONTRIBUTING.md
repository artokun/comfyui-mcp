# Contributing to comfyui-mcp

Thanks for your interest in improving comfyui-mcp, an MCP server (and Claude Code plugin)
that lets an AI agent drive [ComfyUI](https://github.com/comfyanonymous/ComfyUI). This guide covers
the dev setup, project conventions, how to add a tool, and how releases work.

By contributing you agree your contributions are licensed under the project's [MIT License](./LICENSE).

## Getting started

You need Node 22 or newer and npm. The repo is committed with `package-lock.json`, and npm is the
supported dev path.

```bash
git clone https://github.com/artokun/comfyui-mcp
cd comfyui-mcp
npm install        # builds native deps (better-sqlite3, sharp)
npm run build      # tsc → dist/
npm test           # vitest
```

- `npm run build` type-checks and compiles to `dist/` (`tsc`).
- `npm run lint` type-checks only (`tsc --noEmit`).
- `npm test` and `npm run test:watch` run the vitest suite.
- `npm run dev` runs the server from source via `tsx`.
- `npm run docs:gen` rebuilds the docs tool reference from the live schemas (see [Docs](#documentation)).

> pnpm 10 blocks dependency build scripts unless they are allow-listed. The native deps are
> already declared in `package.json` `pnpm.onlyBuiltDependencies` (`better-sqlite3`, `sharp`). If you
> add a dependency that needs a build step at runtime, add it there too.

Before opening a PR, make sure `npm run build` and `npm test` both pass.

## Project layout

```
src/
  tools/        # thin MCP tool wrappers — one registerXxxTools(server) per file
    index.ts    #   registers every tool group (the one shared wiring file)
  services/     # the actual logic (network, subprocess, filesystem)
  comfyui/      # ComfyUI client + workflow types
  utils/        # errors, logger, shared helpers
  __tests__/    # vitest tests, mirroring the source path
scripts/        # build/docs/util scripts (gen-tool-docs.ts, smoke-install.mjs, …)
docs/           # Mintlify docs site (tool reference is GENERATED — see below)
plugin/         # the Claude Code plugin (skills, agents, slash commands, hooks)
```

Business logic lives in `src/services/<name>.ts`. The matching
`src/tools/<name>.ts` is a thin wrapper that defines the MCP tool and calls the service.

## Conventions

- **ESM.** This is an ESM package, so relative imports must use the `.js` extension
  (`import { foo } from "./foo.js"`), even from `.ts` files.
- **Errors.** Throw typed errors from `src/utils/errors.ts` (`ComfyUIError`, `ValidationError`,
  `ProcessControlError`, and the rest) and convert them at the tool boundary with `errorToToolResult(err)`.
- **Local vs remote.** comfyui-mcp can target a remote ComfyUI (`--comfyui-url`). Tools that need a
  local install must read `config.comfyuiPath` and throw a clear error when it is undefined.
- **Security.** Review enforces these:
  - Secrets (API tokens, registry keys, cloud credentials) travel in headers or env, never in
    URLs, argv, or logs. Redact secrets from any logged URL.
  - Validate filesystem paths against traversal and symlink escapes (resolve the path, then check it stays inside the intended root).
  - Validate values that reach a subprocess argv (reject a leading `-` and control chars; use
    `--end-of-options` for git, and the equivalent for other tools).
- **anti-slop ratchet.** `npm run lint` runs `scripts/check-anti-slop.mjs`: seven vendored Oxlint
  rules (`tools/oxlint/README.md`) against a per-file, per-rule baseline that may shrink and never
  grow. A new `x as unknown as Foo`, `(): unknown`, `Reflect.get`, and so on fails the build. Fix
  it, or justify it at the site on one line:
  `// oxlint-disable-next-line anti-slop/<rule> -- <why>` (a bare directive is rejected). When a
  change removes findings, run `node scripts/check-anti-slop.mjs --baseline` in the same PR so the
  debt list pays down; never hand-edit a count upward.
- **Plugin skills.** Every skill (`plugin/skills/<name>/SKILL.md`) ends with a
  `## Sources` section that separates **Official** sources (vendor docs, node README,
  `/object_info`) from **Empirical** ones (working graphs, observed behaviour). A skill
  with no vendor documentation says so (`none found`) rather than leaving the
  question unanswered. `list_packs` `action:"generate_skill"` emits this section
  automatically.

## Adding a new MCP tool

Use `src/tools/registry-search.ts` and `src/tools/process-control.ts` as canonical examples.

1. **Service.** Add `src/services/<name>.ts` with the logic and an exported function. Keep network
   in `fetch`, subprocess in `node:child_process`. Make I/O seams injectable so they are testable.
2. **Tool.** Add `src/tools/<name>.ts` exporting `registerXxxTools(server: McpServer): void`. Inside,
   call `server.tool(name, description, zodShape, handler)`. Handlers return
   `{ content: [{ type: "text" as const, text }] }` and wrap failures with `errorToToolResult(err)`.
3. **Wire it.** Add one import and one `registerXxxTools(server);` call in `src/tools/index.ts`,
   before `await registerAutoloadedWorkflows(server);`.
4. **Categorize for docs.** Add the new tool name to the right category in
   `scripts/gen-tool-docs.ts` (`CATEGORIES`), then run `npm run docs:gen`. It warns about any
   uncategorized tool.
5. **Test.** Add `src/__tests__/…` mirroring the source path. Mock `global.fetch`,
   `node:child_process`, and `node:fs`. No real network, disk, or process side effects.

### Tool descriptions matter

Descriptions are the agent's only guide to a tool. Write them to answer three questions:
what it does to the world (read-only? mutates disk? requires a running server? irreversible?),
when to use it instead of a sibling tool, and what each parameter means beyond its type. Don't just
restate the schema. Glama's TDQS grades this; see the [blog post](https://comfyui-mcp.artokun.io/docs/blog/comfyui-mcp-tdqs-case-study).

## Documentation

The hosted docs live in `docs/` (Mintlify). The Tool Reference is generated from the live tool
schemas, so do not hand-edit `docs/tools/*.mdx`. After changing any tool (name, description,
params), run:

```bash
npm run docs:gen
```

and commit the regenerated MDX. Guide pages (`docs/*.mdx`) are hand-written; edit those directly.
Run `cd docs && npx mint broken-links` to validate links.

### Blog posts and translated pages

`docs/blog/*.mdx` and `docs/<locale>/*.mdx` have their own gates. Model posts need a `## Licensing`
section, model and script filenames are checked against the pack
that ships them, and translated pages are compared structurally to their English source. Those
run in `npm test`.

Two related checks do not run there. `node scripts/asset-counts.mjs --check` (advertised counts against the
live registry) runs in CI and needs a fresh `dist/`. `node scripts/check-docs-deployed.mjs`
(every nav page serves) runs only when you invoke it against a published site.

Read [design/writing-blog-posts.md](design/writing-blog-posts.md) before writing one. It
also documents the Mintlify caveats that make a page fail to build, including the one page
that has never built and why, and a short list of things previously believed about this build
that turned out, on measurement, to be false.

## Optional / experimental dependencies

Cloud storage (`@aws-sdk/client-s3`, `@azure/storage-blob`) and the experimental agent-panel POC
(`ai`, `@ai-sdk/*`, `cloudflared`) are only needed by optional, flag-gated features. Keep new heavy or
feature-specific dependencies out of the core hot path, and prefer lazy or dynamic imports so a base
install stays small.

## Commits & pull requests

- Branch off `main` (`feat/…`, `fix/…`, `docs/…`).
- Use Conventional Commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`).
- Keep PRs focused; include tests for behavior changes.
- Before opening the PR, check that `npm run build` passes, `npm test` passes, the docs are
  regenerated if tools changed, and the description says what changed and why.
- When you add or touch a predicate, ask what it returns when the observation
  FAILS. If that is the same value it returns for a genuine negative, you have
  written the most common defect in this codebase. "I could not determine this"
  collapses into "I determined it is not so", and the user is told a confident
  wrong answer. Examples from this repo: a pack reported "not installed" by code that never reached the
  disk, a port reported free by a lookup that failed, a download reported
  verified after an unverified server swap. Give unknown its own representation
  (`yes | no | unknown`, or a tagged result), and test the failed observation,
  not just the negative answer. Every instance found so far had tests, and
  none of them tested the probe failing. `npm run check:unknown-collapse` catches
  the common written form. It cannot catch the shape; only you can.

Open a GitHub issue first for large or potentially breaking changes so we can align on the approach.

## Releases (maintainers)

Releases are automated. Never run `npm publish` by hand. Bump and tag; pushing the `v*` tag
triggers the GitHub Actions workflow that publishes to npm with provenance (OIDC):

```bash
npm run release        # patch
npm run release:minor  # minor
npm run release:major  # major
```

Each script runs `npm version <bump>` (creating the commit and tag) and `git push --follow-tags`.
Update `CHANGELOG.md` (Keep a Changelog) and rebuild the docs before tagging.

## Questions

Open a [GitHub issue](https://github.com/artokun/comfyui-mcp/issues) or start a discussion. Thanks for contributing.
