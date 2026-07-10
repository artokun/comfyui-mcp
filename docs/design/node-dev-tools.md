# Path-jailed live custom-node dev tools

**Status:** implemented (this PR)

> **Safety-gates note:** The original design depended on a general safety-gates framework (spec PR #172), which was closed — a gates framework is deferred to **ROADMAP Theme G**. This PR therefore ships without gates: `write_node_file` / `apply_node_patch` are UNGATED (like the other mutating tools in this repo today), and `node_pack_git commit`/`push` are guarded by a single narrow inline env flag, `COMFYUI_MCP_ALLOW_GIT_WRITES` (`"1"`/`"true"`; default OFF). When off, commit/push return an `isError` result with the structured `DISABLED_BY_CONFIG` body (`{ "error": "DISABLED_BY_CONFIG", "disabled_by_config": true, "required_flag": "COMFYUI_MCP_ALLOW_GIT_WRITES=1", "message": … }`); `status`/`diff`/`log` are always allowed. Theme G's gates framework will absorb this flag. Wherever the text below says "gated `node-writes`"/"gated `git-writes`", read it as: node-writes → ungated; git-writes → the `COMFYUI_MCP_ALLOW_GIT_WRITES` flag.

> Prior art: [filliptm/ComfyUI_FL-MCP](https://github.com/filliptm/ComfyUI_FL-MCP) `backend/coding_tools.py` — file read/search/write/patch/git tools hard-jailed to `custom_nodes/` with bounded output. We port the shape and the output-bounding constants, and add Windows symlink/junction safety, gate integration, and reuse of our existing containment code.

## Motivation

The bisect/fix flow (`bisect_*` in `src/tools/node-bisect.ts`, `fix_custom_node` in `src/tools/node-management.ts:148`) can isolate a broken pack, and `scaffold_custom_node`/`verify_custom_node`/`publish_custom_node` (`src/services/node-authoring.ts`, `node-verify.ts`) cover create/verify/ship — but there is no way for an agent to actually **read, search, edit, and commit** pack source in between. Users currently need a second coding agent with unrestricted filesystem access. This closes the loop: bisect → search/read → patch → `verify_custom_node` → `restart_comfyui` → git commit → `publish_custom_node`.

## Tool API

New `src/tools/node-dev.ts` + service `src/services/node-dev.ts`, category `custom-nodes`, LOCAL-only (no `config.comfyuiPath` in remote/cloud mode → the clear "requires a local ComfyUI install" refusal already used at `node-management.ts:804-810`). Naming is snake_case verb-noun like the rest of the surface; note `list_packs` is taken (installer packs, `skills-access.ts:273`) and `list_installed_nodes` already lists packs, so there is no new list-packs tool.

1. **`list_node_pack_files`** — read-only, ungated.
   Params: `pack: string` (folder under `custom_nodes`), `glob?: string`, `max_entries?: number` (default 500, max 2000).
   Result: `{ pack, root, entries: [{ path, size, dir }], truncated, is_git_repo, has_pyproject }`. Skips `.git/`, `__pycache__/`, `node_modules/`.

2. **`read_node_file`** — read-only, ungated.
   Params: `path: string` (pack-relative, e.g. `MyPack/nodes.py`), `start_line?: number` (default 1), `line_count?: number` (default 240, max 800), `max_chars?: number` (default 12000, max 24000).
   Result: `{ path, content, start_line, end_line, total_lines, size, truncated }` with a truncation notice appended when clipped ("request a narrower line range…"). Long lines chunked at 1000 chars. (Bounds are FL-MCP's proven constants.)

3. **`search_node_packs`** — read-only, ungated.
   Params: `query: string` (regex), `path?: string` (default `.` = all packs), `glob?: string`, `max_results?: number` (default 50, max 100), `case_sensitive?: boolean`.
   Result: `{ engine: "ripgrep" | "builtin", matches: [{ file, line, text }], truncated }`; match lines capped at 600 chars.
   Ripgrep is **not** a current dependency (verified). Strategy: probe `rg` on PATH once (`spawnSync("rg", ["--version"])`); if absent, fall back to a bounded pure-JS scanner (recursive walk, skip dot dirs/`__pycache__`, skip files > 1 MiB or containing NUL bytes, `RegExp` per line, hard cap on scanned files). Optional follow-up: `@vscode/ripgrep` in `optionalDependencies` via `requireOptionalDep` (`src/utils/optional-dep.ts`), consistent with how cloud SDKs are handled.

4. **`write_node_file`** — gated `node-writes`.
   Params: `path: string`, `content: string`, `overwrite?: boolean` (default false; refuse existing file without it), `create_dirs?: boolean` (default true).
   Result: `{ path, bytes, created: boolean }`.

5. **`apply_node_patch`** — gated `node-writes`.
   Params: `patch: string` (unified diff; `a/`–`b/` prefixes accepted).
   Behavior (FL-MCP's two-phase apply): parse `+++`/`---` headers, jail-check **every** touched path **before any git call**, then `git apply --check` followed by `git apply`, run from the pack directory; `--unsafe-paths` never allowed. Works on non-repo packs too (`git apply` functions outside a repository for plain file patching).
   Result: `{ success, stage: "check" | "apply", touched: [...], stdout, stderr }` (output bounded at 12000 chars).

6. **`node_pack_git`** — one tool, action enum (keeps the catalog small; compact-router agents discover subactions via `describe_tool`).
   Params: `pack: string`, `action: "status" | "diff" | "log" | "commit" | "push"`, `message?: string` (required for commit), `paths?: string[]` (jail-checked, staged selectively; default all pack changes), `max_chars?: number`.
   Gating: `status`/`diff`/`log` ungated (reads); `commit`/`push` gated `git-writes` (default **closed** per the gates RFC) via an **in-handler** `isGateOpen`/`gateRefusal` check — the one sanctioned exception, since registration-time wrapping can't see actions. Refusal is the standard `DISABLED_BY_CONFIG` shape with `required_flag: "COMFYUI_MCP_ALLOW_GIT_WRITES=1"`.
   Execution: `execFileSync("git", [...], { cwd: packDir })` with `nonInteractiveGitEnv()` reused (exported) from `src/services/node-management.ts` (prevents credential prompts hanging the server), timeouts (60 s; 180 s for push), bounded output, `--end-of-options` wherever args are user-derived (same discipline as `node-management.ts:836-838`).

All tools error with `class NodeDevError extends ComfyUIError` (code `NODE_DEV_ERROR`) through the standard `errorToToolResult` path.

## Path-jail mechanism

`src/services/node-dev.ts` exports one auditable function used by every tool:

```ts
function resolveInJail(relOrAbs: string): { abs: string; rel: string }
```

1. Root = `resolve(config.comfyuiPath, "custom_nodes")` (identical to `node-management.ts:821`).
2. Candidate = absolute input taken as-is, else `resolve(root, input)`.
3. Lexical containment: `relative(root, candidate)` must be non-empty, not start with `..`, not `isAbsolute` (existing pattern at `node-management.ts:823-828`, mirroring `manifest.ts`'s `isWithinRoot`).
4. **Symlink safety:** realpath the deepest **existing** ancestor of the candidate (`fs.realpathSync.native`) and realpath the root, then re-run containment on the realpaths. Defeats a symlinked pack dir — and Windows junctions/dir-symlinks, which `realpathSync.native` resolves. Not-yet-existing files (`write_node_file`) are checked via their existing parent.
5. Windows extras: reject NTFS alternate data streams (`:` in any segment past the drive letter), reserved device names (`CON`, `NUL`, `COM1`…), and trailing dots/spaces in segments; comparisons via `relative()` (platform-correct case sensitivity).
6. Write/patch/git never operate on the root itself (`rel === ""` rejected; list/search may use `.`).

`pack` params additionally pass the existing `assertSafeRepoName`-style validation (exported from `node-management.ts`).

## Integration with existing flows

- Tool descriptions cross-reference the closed loop (scaffold → write/patch → verify → restart → commit → publish); `fix_custom_node` and the bisect tools mention the diagnose-then-patch follow-up in their descriptions (descriptions are the agent UX).
- Compact router: a new `["custom-nodes", registerNodeDevTools]` entry appended to `TOOL_GROUPS` is captured by `collectToolCatalog` automatically, and `searchCorpus` (`compact.ts:35-40`) indexes the param descriptions, so `list_tools search:"patch"` finds it. Gates apply identically because the gates wrapper sits before the catalog.

## Implementation plan

1. `src/services/node-dev.ts` — jail resolver, bounded-text helpers (`boundText`, `chunkLongLines`; FL constants: read 12k/24k chars, 240/800 lines, search lines 600 chars, command output 12k), git runner, builtin search fallback, ripgrep probe. Inject fs/exec seams like `AuthoringDeps` (`node-authoring.ts:104-120`) so tests need no real disk/subprocess.
2. `src/tools/node-dev.ts` — six `server.tool` registrations with zod schemas; handlers `try/catch errorToToolResult`.
3. `src/tools/index.ts` — append `["custom-nodes", registerNodeDevTools]` (registration order is observable; append-only).
4. ~~`src/tools/gates.ts`~~ — no gates framework in this PR (deferred to ROADMAP Theme G). Instead, `node_pack_git commit`/`push` do an in-handler `gitWritesEnabled()` (`COMFYUI_MCP_ALLOW_GIT_WRITES`) check returning the `DISABLED_BY_CONFIG` refusal; `write_node_file`/`apply_node_patch` ship ungated.
5. Export `nonInteractiveGitEnv` (and `assertSafeRepoName`) from `src/services/node-management.ts`.
6. Docs page + README section; call out `git-writes` default-closed prominently.

## Test plan (vitest, `src/__tests__/node-dev.test.ts`)

- **Jail:** table-driven — `../x`, `..\x`, absolute outside root, drive-relative (`C:x`), UNC, ADS (`nodes.py:zone`), reserved names, `.`/`..` pack names, and a junction-escape fixture (`fs.symlinkSync(target, link, "junction")` in a tmpdir — junctions need no admin on Windows; skip POSIX-symlink variant on unprivileged win32 CI).
- **read/list bounding:** line-range math, char-truncation notice, long-line chunking, `total_lines` on CRLF files.
- **search:** builtin fallback correctness + caps; ripgrep path via exec seam; binary/large-file skip.
- **patch:** temp git-repo fixture — clean apply; check-stage failure surfaces stderr; patch touching a path outside `custom_nodes` refused **before** any git call.
- **git:** seam-mocked exec asserting exact argv (no option injection); commit requires message; commit/push return the gates refusal when `git-writes` closed.
- **Integration (opt-in, `COMFYUI_INTEGRATION=true`):** scaffold → write → verify → git status roundtrip in a temp workspace.

## Rollout / compat

- Six new tools appended; no existing tool changes. Reads work day one; writes honor SAFE_MODE; `node_pack_git commit/push` require explicit `COMFYUI_MCP_ALLOW_GIT_WRITES=1` — safe-by-default for the only genuinely new blast radius.
- Remote/cloud modes: all six refuse cleanly (no `comfyuiPath`), consistent with node-authoring's LOCAL-ONLY contract.
- Ships independently: the safety-gates framework is deferred to ROADMAP Theme G, which will later absorb the narrow `COMFYUI_MCP_ALLOW_GIT_WRITES` flag introduced here.
