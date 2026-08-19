# Contributing to comfyui-mcp

Thanks for your interest in improving **comfyui-mcp** — an MCP server (and Claude Code plugin)
that lets an AI agent drive [ComfyUI](https://github.com/comfyanonymous/ComfyUI). This guide covers
the dev setup, project conventions, how to add a tool, and how releases work.

By contributing you agree your contributions are licensed under the project's [MIT License](./LICENSE).

## Getting started

Requirements: **Node ≥ 22** and npm (the repo is committed with `package-lock.json`; npm is the
supported dev path).

```bash
git clone https://github.com/artokun/comfyui-mcp
cd comfyui-mcp
npm install        # builds native deps (better-sqlite3, sharp)
npm run build      # tsc → dist/
npm test           # vitest
```

- **`npm run build`** — type-checks and compiles to `dist/` (`tsc`).
- **`npm run lint`** — type-check only (`tsc --noEmit`).
- **`npm test`** / **`npm run test:watch`** — the vitest suite.
- **`npm run dev`** — run the server from source via `tsx`.
- **`npm run docs:gen`** — rebuild the docs tool reference from the live schemas (see [Docs](#documentation)).

> **pnpm users:** pnpm 10 blocks dependency build scripts unless allow-listed. The native deps are
> already declared in `package.json` `pnpm.onlyBuiltDependencies` (`better-sqlite3`, `sharp`); if you
> add a dependency that needs a build step at runtime, add it there too.

Before opening a PR, make sure **`npm run build` and `npm test` both pass**.

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

**Separation of concerns:** business logic lives in `src/services/<name>.ts`; the matching
`src/tools/<name>.ts` is a thin wrapper that defines the MCP tool and calls the service.

## Conventions

- **ESM** — this is an ESM package; **relative imports must use the `.js` extension**
  (`import { foo } from "./foo.js"`), even from `.ts` files.
- **Errors** — throw typed errors from `src/utils/errors.ts` (`ComfyUIError`, `ValidationError`,
  `ProcessControlError`, …) and convert them at the tool boundary with `errorToToolResult(err)`.
- **Local vs remote** — comfyui-mcp can target a remote ComfyUI (`--comfyui-url`). Tools that need a
  local install must read `config.comfyuiPath` and throw a clear error when it's undefined.
- **Security** (please respect these — they're enforced in review):
  - Secrets (API tokens, registry keys, cloud credentials) travel in **headers or env**, never in
    URLs, argv, or logs. Redact secrets from any logged URL.
  - Validate filesystem paths against traversal/symlink escapes (resolve + contain to the intended root).
  - Validate values that reach a subprocess argv (reject leading `-` / control chars; use
    `--end-of-options` for git, etc.).
- **Plugin skills** (`plugin/skills/<name>/SKILL.md`) — every skill ends with a
  `## Sources` section that distinguishes **Official** (vendor docs, node README,
  `/object_info`) from **Empirical** (working graphs, observed behaviour). A skill
  with no vendor documentation says so (`none found`) rather than leaving the
  question unanswered. `list_packs` `action:"generate_skill"` emits this section
  automatically.

## Adding a new MCP tool

Use `src/tools/registry-search.ts` and `src/tools/process-control.ts` as canonical examples.

1. **Service** — add `src/services/<name>.ts` with the logic and an exported function. Keep network
   in `fetch`, subprocess in `node:child_process`. Make I/O seams injectable so they're testable.
2. **Tool** — add `src/tools/<name>.ts` exporting `registerXxxTools(server: McpServer): void`. Inside,
   call `server.tool(name, description, zodShape, handler)`. Handlers return
   `{ content: [{ type: "text" as const, text }] }` and wrap failures with `errorToToolResult(err)`.
3. **Wire it** — add one import and one `registerXxxTools(server);` call in `src/tools/index.ts`,
   **before** `await registerAutoloadedWorkflows(server);`.
4. **Categorize for docs** — add the new tool name to the right category in
   `scripts/gen-tool-docs.ts` (`CATEGORIES`), then run `npm run docs:gen` (it warns about any
   uncategorized tool).
5. **Test** — add `src/__tests__/…` mirroring the source path. Mock `global.fetch`,
   `node:child_process`, and `node:fs` — **no real network, disk, or process side effects**.

### Tool descriptions matter

Descriptions are the agent's only guide to a tool. Write them to answer three questions:
**what it does to the world** (read-only? mutates disk? requires a running server? irreversible?),
**when to use it vs. a sibling tool**, and **what each parameter means beyond its type**. Don't just
restate the schema. (This is graded by Glama's TDQS — see the [blog post](https://comfyui-mcp.artokun.io/docs/blog/comfyui-mcp-tdqs-case-study).)

## Documentation

The hosted docs live in `docs/` (Mintlify). The **Tool Reference is generated** from the live tool
schemas — **do not hand-edit `docs/tools/*.mdx`**. After changing any tool (name, description,
params), run:

```bash
npm run docs:gen
```

and commit the regenerated MDX. Guide pages (`docs/*.mdx`) are hand-written; edit those directly.
Run `cd docs && npx mint broken-links` to validate links.

### Blog posts and translated pages

`docs/blog/*.mdx` and `docs/<locale>/*.mdx` are covered by their own gates — a `## Licensing`
section is required on model posts, model and script filenames are checked against the pack
that ships them, and translated pages are compared structurally to their English source. Those
run in `npm test`.

Two related checks do **not**: `node scripts/asset-counts.mjs --check` (advertised counts vs the
live registry) runs in CI and needs a fresh `dist/`, and `node scripts/check-docs-deployed.mjs`
(every nav page actually serves) runs only when you invoke it against a published site.

Read **[design/writing-blog-posts.md](design/writing-blog-posts.md)** before writing one. It
also documents the Mintlify caveats that make a page fail to build — including the one page
that has never built and why — and a short list of things previously believed about this build
that turned out, on measurement, to be false.

## Optional / experimental dependencies

Cloud storage (`@aws-sdk/client-s3`, `@azure/storage-blob`) and the experimental agent-panel POC
(`ai`, `@ai-sdk/*`, `cloudflared`) power optional/flag-gated features. Keep new heavy or
feature-specific dependencies out of the core hot path, and prefer lazy/dynamic imports so a base
install stays lean.

## Commits & pull requests

- **Branch** off `main` (`feat/…`, `fix/…`, `docs/…`).
- Use **Conventional Commit** prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`).
- Keep PRs focused; include tests for behavior changes.
- **PR checklist:** `npm run build` ✓ · `npm test` ✓ · docs regenerated if tools changed ✓ ·
  a clear description of what and why.
- **When you add or touch a predicate, ask what it returns when the observation
  FAILS.** If that is the same value it returns for a genuine negative, you have
  written the most common defect in this codebase: "I could not determine this"
  collapsing into "I determined it is not so." The user is then told a confident
  wrong answer — a pack reported "not installed" by code that never reached the
  disk, a port reported free by a lookup that failed, a download reported
  verified after an unverified server swap. Give unknown its own representation
  (`yes | no | unknown`, or a tagged result), and **test the failed observation,
  not just the negative answer** — every instance found so far had tests, and
  none of them tested the probe failing. `npm run check:unknown-collapse` catches
  the common written form; it cannot catch the shape, only you can.

Open a GitHub issue first for large or potentially-breaking changes so we can align on the approach.

## Releases (maintainers)

Releases are automated — **never `npm publish` manually**. Bump + tag, and pushing the `v*` tag
triggers the GitHub Actions workflow that publishes to npm with provenance (OIDC):

```bash
npm run release        # patch
npm run release:minor  # minor
npm run release:major  # major
```

Each script runs `npm version <bump>` (creating the commit + tag) and `git push --follow-tags`.
Update `CHANGELOG.md` (Keep a Changelog) and rebuild the docs before tagging.

## Questions

Open a [GitHub issue](https://github.com/artokun/comfyui-mcp/issues) or start a discussion. Thanks for contributing! 🎨
