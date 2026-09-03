import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  scaffoldCustomNode,
  publishCustomNode,
} from "../services/node-authoring.js";
import { verifyCustomNode } from "../services/node-verify.js";
import { resolveCustomNodesScanBaseLiveStrict } from "../services/workspace-env.js";
import {
  listNodePackFiles,
  readNodeFile,
  searchNodePacks,
  writeNodeFile,
  applyNodePatch,
  nodePackGit,
  // #809: quote the REAL clamps, never a hand-typed number. The git ceiling of
  // 24000 was a code clamp its description never mentioned, which is exactly how a
  // caller ends up raising a parameter and seeing nothing change.
  READ_DEFAULT_LINES,
  READ_MAX_LINES,
  READ_DEFAULT_CHARS,
  READ_MAX_CHARS,
  SEARCH_DEFAULT_RESULTS,
  SEARCH_MAX_RESULTS,
  CMD_OUTPUT_MAX,
  LIST_DEFAULT_ENTRIES,
  LIST_MAX_ENTRIES,
  MIN_OUTPUT_CHARS,
} from "../services/node-dev.js";
import { errorToToolResult } from "../utils/errors.js";

const jsonResult = (result: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
});

/**
 * The nine custom-node AUTHORING tools collapsed into one action-parameterized
 * `node_pack` tool (0.50.0 surface consolidation, slice 12).
 *
 * They are one work-domain by construction: they are the author loop, in order —
 * scaffold → write/patch → verify → git → publish — with read/list/search as the
 * orientation steps between them. Every one is LOCAL-ONLY, and every
 * FILE-TOUCHING one is jailed to custom_nodes/ under the directory ComfyUI
 * actually scans: the running server's own --base-directory when it reports one
 * (#1715 — on ComfyUI Desktop that is NOT the code install root), else the live
 * main.py checkout on a split install that has no --base-directory (#2031 — the
 * data workspace is not scanned unless the flag said so), else COMFYUI_PATH,
 * else the saved default workspace, else the running local server's own install
 * root (#1653). The single
 * exception is action:"publish" with an explicit `path`, which the retired tool
 * accepted as an absolute pack directory anywhere on the machine (deliberately —
 * publishing is a local filesystem + comfy-cli operation independent of which
 * ComfyUI is targeted, see publishCustomNode). A fold must not narrow that, so
 * the tool's description states the exception rather than claiming a jail it
 * does not have. See design/node-dev-tools.md.
 *
 * A NEW name rather than a survivor: none of the nine is a natural umbrella
 * (the scaffold tool is the first STEP, not the family), so `node_pack` takes
 * the registration slot of the family's first member in registration order —
 * the retired scaffold tool — and the surviving relative order of every other tool is
 * unchanged (registry-surface.test.ts pins it).
 *
 * SPLIT from `install_custom_node` deliberately: that tool manages SOMEONE
 * ELSE'S pack through ComfyUI-Manager (install, update, remove, discover); this
 * one edits and publishes YOUR OWN source on disk. Different services, different
 * failure modes, and — the load-bearing part — different admission. `node_pack`
 * is NOT on the orchestrator's direct call_tool whitelist and must not be added
 * to it: action:"write", action:"patch" and action:"git" are arbitrary file
 * writes and git operations on the user's machine, and none of the nine names it
 * replaces was ever reachable from a canvas-less client.
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required. Every VALUE constraint the
 * old tools had is unchanged at the zod layer (the numeric fields keep .int(),
 * `class_types`/`paths` keep their array types); the handler enforces per-action
 * presence and names the missing field — the one deliberate behavioural
 * difference a flat enum permits. Each branch calls the same service function
 * the old tool called, with the same arguments, and returns the identical
 * content block (pretty-printed JSON throughout).
 *
 * ONE ARGUMENT IS RENAMED, and only because it collided: the retired git tool's own
 * `action` ("status"|"diff"|"log"|"commit"|"push") cannot keep that name when
 * `action` is the tool's dispatch field. It becomes `git_action`, and the
 * service is still called with `action: git_action` — the git operation itself
 * is untouched. This is the one place a fold could not preserve a parameter
 * name; everything else keeps the spelling it had.
 */
export function registerNodePackTools(server: McpServer): void {
  server.tool(
    "node_pack",
    "Author, edit, test and publish YOUR OWN ComfyUI custom-node pack under the custom_nodes/ directory the running ComfyUI actually scans. LOCAL-ONLY: it acts on the local filesystem and is meaningless for a remote --comfyui-url target. Every file-touching action (list_files, read, search, write, patch, git) is jailed to custom_nodes/ under the directory the running ComfyUI actually scans — the server's own --base-directory when it reports one (on ComfyUI Desktop that is NOT the code install root), else the live main.py checkout on a split install that has no --base-directory (the data workspace is not scanned unless the flag said so), else COMFYUI_PATH, else the saved default workspace, else the running LOCAL server's own install root; the one exception is action:\"publish\", which also accepts an explicit `path` to a pack directory ANYWHERE on this machine and therefore works without COMFYUI_PATH. To INSTALL or update someone else's pack use install_custom_node instead. Driven by the `action` parameter:\n" +
      '- action:"scaffold" — Generate a new pack from a template into the local ComfyUI\'s scanned custom_nodes/<name>/ (the install base resolves from the running server\'s --base-directory when it reports one, else the live main.py checkout on a split install, else COMFYUI_PATH, else the saved default workspace, else the running LOCAL server this session is connected to). Writes pyproject.toml (with the [tool.comfy] PublisherId/DisplayName/Icon table the Comfy Registry requires), __init__.py exporting NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS, and src/nodes.py containing a runnable sample node (INPUT_TYPES/RETURN_TYPES/FUNCTION/CATEGORY), plus .comfyignore and .gitignore. Optionally emits a web/js frontend stub (wiring WEB_DIRECTORY) and a GitHub Actions publish workflow (with_ci). This is the FIRST step of the author loop: scaffold here, then restart_comfyui to load it, test it, and finally action:"publish". Names must be a safe lowercase slug and cannot escape custom_nodes/; an existing non-empty directory is left untouched unless overwrite is true. Requires `name` and `display_name`.\n' +
      '- action:"verify" — Test that a pack actually LOADS in ComfyUI — the middle step of the author loop. Restarts the local ComfyUI and waits for it to become ready, then checks that the pack\'s node class_types appear in /object_info. A node that fails to import (a missing dependency or a syntax error) simply never registers, so any missing class_types pinpoint a broken pack. Provide `class_types` explicitly, or a pack `name` whose __init__.py declares NODE_CLASS_MAPPINGS (the keys are inferred). Needs a managed local ComfyUI. Set restart:false to check the already-running server without restarting it.\n' +
      '- action:"publish" — Publish a local pack to the public Comfy Registry (registry.comfy.org) by running `comfy node publish` inside the pack directory. First validates the pack\'s pyproject.toml has the required [project].name, [project].version and [tool.comfy].PublisherId (refusing the scaffold placeholder), then publishes using the API key from the REGISTRY_ACCESS_TOKEN environment variable (passed to comfy-cli via the environment, never via logged arguments). This is the LAST step of the author loop and an IRREVERSIBLE, EXTERNAL action: it creates/updates a PUBLIC registry version that this tool cannot undo. Requires comfy-cli installed and REGISTRY_ACCESS_TOKEN set. Give `name` (a folder under custom_nodes/) or `path` (an explicit pack directory).\n' +
      '- action:"list_files" — List the files in one installed pack under custom_nodes/<pack>/ (read-only). Skips .git/, __pycache__/ and node_modules/. Use this to orient before action:"read" / action:"search" when diagnosing or editing a pack you found via bisect or install_custom_node (action:"fix"). Requires `pack`.\n' +
      '- action:"read" — Read a slice of ONE file inside a pack (read-only), with bounded output so a huge file can\'t flood the context. Returns the requested line range with a truncation notice when clipped; long lines are chunked. Pair with action:"search" to locate the line, then action:"patch" or action:"write" to change it. Requires `path`.\n' +
      '- action:"search" — Regex-search custom-node source under custom_nodes/ (read-only). Uses ripgrep when it\'s on PATH, otherwise a bounded built-in scanner (skips dot-dirs, __pycache__/node_modules, binary and >1 MiB files). Returns file/line/text matches with per-line and result caps. Use this to find where a node class, import, or error string lives before reading or patching. Requires `query`.\n' +
      '- action:"write" — Create or overwrite ONE file inside a pack. Refuses to clobber an existing file unless overwrite is true, and creates parent directories by default. Use for whole-file edits or new files; for surgical edits prefer action:"patch". After writing, run action:"verify" and restart_comfyui to load the change. Requires `path` and `content`.\n' +
      '- action:"patch" — Apply a unified diff (---/+++ headers) or an apply-patch / simplified diff (`*** Begin Patch` / `*** Update File`) to custom-node source under custom_nodes/. Every touched path is jail-checked BEFORE any git call, then the patch is validated with `git apply --check` and only applied if the check passes (two-phase; never uses --unsafe-paths). Paths are relative to custom_nodes/ and may carry a/ b/ prefixes; works on non-repo packs too. Ideal for surgical edits located via action:"search". Requires `patch`.\n' +
      '- action:"git" — Run a git operation inside one pack, selected by `git_action` (status/diff/log/commit/push). Reads (status/diff/log) are always allowed. Writes (commit/push) require the environment flag COMFYUI_MCP_ALLOW_GIT_WRITES=1 (default OFF) and otherwise return a structured DISABLED_BY_CONFIG refusal so you can self-correct. `paths` entries are pack-relative paths to stage/scope, resolved against the selected pack root (not custom_nodes/); an absolute path is accepted only when it remains inside both the selected pack and custom_nodes/ jails. commit requires a `message` and stages either the given `paths` or all pack changes. This is the final step of the author loop after scaffold → write/patch → verify → restart_comfyui, before action:"publish". Requires `pack` and `git_action`.',
    {
      action: z
        .enum([
          "scaffold",
          "verify",
          "publish",
          "list_files",
          "read",
          "search",
          "write",
          "patch",
          "git",
        ])
        .describe(
          'Which node-pack operation to perform. "scaffold" requires `name` + `display_name`; "list_files" requires `pack`; "read" requires `path`; "search" requires `query`; "write" requires `path` + `content`; "patch" requires `patch`; "git" requires `pack` + `git_action`. "verify" and "publish" have no required parameters — "verify" resolves the pack from `name` (or checks `class_types` directly), "publish" from `name` or `path`.',
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Pack folder name under <COMFYUI_PATH>/custom_nodes/. REQUIRED for action:"scaffold" — a safe lowercase slug (letters, digits, hyphens, underscores), e.g. \'my-cool-nodes\', which becomes the directory under custom_nodes/ and the pyproject [project].name. For action:"verify", the pack whose __init__.py NODE_CLASS_MAPPINGS keys are inferred and checked when `class_types` is omitted. For action:"publish", the pack folder to publish (give this or `path`).',
        ),
      display_name: z
        .string()
        .optional()
        .describe(
          'action:"scaffold" — REQUIRED. Human-readable name shown in the ComfyUI node menu and the registry listing.',
        ),
      category: z
        .string()
        .optional()
        .describe('action:"scaffold" — node menu category for the sample node (default \'custom\').'),
      description: z
        .string()
        .optional()
        .describe('action:"scaffold" — short description written to pyproject [project].description.'),
      publisher_id: z
        .string()
        .optional()
        .describe(
          'action:"scaffold" — your Comfy Registry publisher id, stamped into [tool.comfy].PublisherId. If omitted a placeholder is written that you must replace before publishing.',
        ),
      with_frontend: z
        .boolean()
        .optional()
        .describe(
          'action:"scaffold" — if true, also generate a web/js/<name>.js extension stub and set WEB_DIRECTORY (default false).',
        ),
      with_ci: z
        .boolean()
        .optional()
        .describe(
          'action:"scaffold" — if true, also generate .github/workflows/publish_action.yml (Comfy-Org/publish-node-action; needs the REGISTRY_ACCESS_TOKEN repo secret) so pushing a pyproject.toml version bump auto-publishes (default false).',
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe(
          'action:"scaffold" — overwrite template files in an existing pack directory instead of refusing (default false). action:"write" — overwrite an existing file instead of refusing (default false).',
        ),
      class_types: z
        .array(z.string())
        .optional()
        .describe(
          'action:"verify" — explicit NODE_CLASS_MAPPINGS keys to confirm are registered in /object_info. Takes precedence over inferring from `name`.',
        ),
      restart: z
        .boolean()
        .optional()
        .describe(
          'action:"verify" — restart ComfyUI before checking so newly-added packs load (default true). Set false to check the live server as-is.',
        ),
      pack: z
        .string()
        .optional()
        .describe(
          'Pack folder name under custom_nodes/ (e.g. \'ComfyUI-Manager\'). REQUIRED for action:"list_files" and action:"git".',
        ),
      path: z
        .string()
        .optional()
        .describe(
          'REQUIRED for action:"read" and action:"write": a pack-relative path under custom_nodes/, e.g. \'MyPack/nodes.py\'. For action:"search", the pack-relative directory to search, or \'.\' for all packs (default \'.\'). For action:"publish" ONLY, this is instead an explicit absolute path to the pack directory to publish, and it overrides `name` when both are given.',
        ),
      content: z
        .string()
        .optional()
        .describe('action:"write" — REQUIRED. Full file contents to write.'),
      create_dirs: z
        .boolean()
        .optional()
        .describe('action:"write" — create missing parent directories (default true).'),
      patch: z
        .string()
        .optional()
        .describe(
          'action:"patch" — REQUIRED. A unified diff (---/+++ headers) or an apply-patch / simplified diff (`*** Begin Patch` / `*** Update File: path`). File headers are read to determine touched paths, which must resolve inside custom_nodes/ (e.g. \'a/MyPack/nodes.py\' or \'MyPack/nodes.py\').',
        ),
      query: z
        .string()
        .optional()
        .describe('action:"search" — REQUIRED. Regular expression to search for.'),
      glob: z
        .string()
        .optional()
        .describe(
          'action:"list_files" — optional glob to filter entries (supports *, **, ?), matched against pack-relative paths. action:"search" — optional glob to restrict which files are searched (e.g. \'**/*.py\').',
        ),
      max_entries: z
        .number()
        .int()
        .optional()
        .describe(
          `action:"list_files" — maximum entries to return (default ${LIST_DEFAULT_ENTRIES}, max ${LIST_MAX_ENTRIES} — a hard clamp). The walk STOPS at this many, so a capped result is not the pack's full file list.`,
        ),
      start_line: z
        .number()
        .int()
        .optional()
        .describe('action:"read" — 1-based line to start at (default 1).'),
      line_count: z
        .number()
        .int()
        .optional()
        .describe(
          `action:"read" — number of lines to return (default ${READ_DEFAULT_LINES}, max ${READ_MAX_LINES}).`,
        ),
      max_chars: z
        .number()
        .int()
        .optional()
        .describe(
          `action:"read" — maximum characters to return (default ${READ_DEFAULT_CHARS}, min ${MIN_OUTPUT_CHARS}, max ${READ_MAX_CHARS} — hard clamps; values outside are silently pulled into range). action:"git" — maximum characters of git output to return (default ${CMD_OUTPUT_MAX}, min ${MIN_OUTPUT_CHARS}, max ${READ_MAX_CHARS} — hard clamps the runtime applies; values outside are silently pulled into range).`,
        ),
      max_results: z
        .number()
        .int()
        .optional()
        .describe(
          `action:"search" — maximum matches to return (default ${SEARCH_DEFAULT_RESULTS}, max ${SEARCH_MAX_RESULTS}). The scan STOPS at this many, so a capped result is not a complete match set.`,
        ),
      case_sensitive: z
        .boolean()
        .optional()
        .describe('action:"search" — match case-sensitively (default false).'),
      git_action: z
        .enum(["status", "diff", "log", "commit", "push"])
        .optional()
        .describe(
          'action:"git" — REQUIRED. Which git operation to run: status/diff/log are read-only; commit/push require COMFYUI_MCP_ALLOW_GIT_WRITES=1. Named `git_action` rather than `action` only because `action` is this tool\'s dispatch field; the git operation itself is unchanged.',
        ),
      message: z
        .string()
        .optional()
        .describe('action:"git" — commit message (required for git_action \'commit\').'),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'action:"git" — pack-relative paths to stage/scope (jail-checked). Defaults to all pack changes.',
        ),
    },
    async (args) => {
      try {
        // None of these can be schema-required in a flat shape, so the handler
        // enforces per-action presence and names the missing field — the same
        // information the old per-tool schemas gave a caller.
        //
        // ABSENCE only, never falsiness. Every one of these fields had a real
        // empty-value path before the consolidation and still must:
        //   • `content: ""` writes an EMPTY FILE, which is a legitimate write
        //     (an empty __init__.py is how Python packages are made). A
        //     `!content` guard would refuse it.
        //   • `pack: ""` / `path: ""` / `query: ""` / `patch: ""` passed
        //     z.string() before and reached the service, which answers with its
        //     own jail / not-found / invalid-diff error. A falsiness guard would
        //     swallow those answers and substitute generic text.
        const required = <T>(value: T | undefined, action: string, field: string, what: string): T => {
          if (value === undefined) {
            throw new Error(`node_pack action:"${action}" requires \`${field}\` — ${what}.`);
          }
          return value;
        };

        switch (args.action) {
          case "scaffold":
            return jsonResult(
              scaffoldCustomNode(
                {
                  name: required(args.name, "scaffold", "name", "the pack folder name to create under custom_nodes/"),
                  displayName: required(
                    args.display_name,
                    "scaffold",
                    "display_name",
                    "the human-readable name shown in the ComfyUI node menu",
                  ),
                  category: args.category,
                  description: args.description,
                  publisherId: args.publisher_id,
                  withFrontend: args.with_frontend,
                  withCi: args.with_ci,
                  overwrite: args.overwrite,
                },
                // Deps stay default; the THIRD argument is the directory
                // ComfyUI actually scans custom_nodes/ from (#1653/#1715/#2031):
                // --base-directory when reported (Desktop: NOT the code install
                // root), else the live main.py checkout on a split install that
                // has no --base-directory (the data workspace is not scanned
                // unless the flag said so), else configuration.
                undefined,
                await resolveCustomNodesScanBaseLiveStrict(),
              ),
            );
          case "verify":
            return jsonResult(
              await verifyCustomNode({
                name: args.name,
                classTypes: args.class_types,
                restart: args.restart,
                // The SAME scan root scaffold wrote to (#1715/#2031): verify
                // reads the pack's __init__.py from the directory the runtime
                // actually scans, so authoring and verification cannot target
                // different roots.
                resolvedBase: await resolveCustomNodesScanBaseLiveStrict(),
              }),
            );
          case "publish":
            return jsonResult(
              publishCustomNode(
                { name: args.name, path: args.path },
                // An explicit `path` never consults the install base (remote-mode
                // publish stays allowed), so the live-aware resolution (#1653)
                // only runs — and only costs a /system_stats probe — for `name`.
                undefined,
                args.path && args.path.trim()
                  ? undefined
                  : await resolveCustomNodesScanBaseLiveStrict(),
              ),
            );
          case "list_files":
            return jsonResult(
              listNodePackFiles(
                {
                  pack: required(args.pack, "list_files", "pack", "the pack folder name under custom_nodes/"),
                  glob: args.glob,
                  maxEntries: args.max_entries,
                },
                undefined,
                await resolveCustomNodesScanBaseLiveStrict(),
              ),
            );
          case "read":
            return jsonResult(
              readNodeFile(
                {
                  path: required(args.path, "read", "path", "the pack-relative file to read, e.g. 'MyPack/nodes.py'"),
                  startLine: args.start_line,
                  lineCount: args.line_count,
                  maxChars: args.max_chars,
                },
                undefined,
                await resolveCustomNodesScanBaseLiveStrict(),
              ),
            );
          case "search":
            return jsonResult(
              searchNodePacks(
                {
                  query: required(args.query, "search", "query", "the regular expression to search for"),
                  path: args.path,
                  glob: args.glob,
                  maxResults: args.max_results,
                  caseSensitive: args.case_sensitive,
                },
                undefined,
                await resolveCustomNodesScanBaseLiveStrict(),
              ),
            );
          case "write":
            return jsonResult(
              writeNodeFile(
                {
                  path: required(args.path, "write", "path", "the pack-relative file to write, e.g. 'MyPack/nodes.py'"),
                  content: required(args.content, "write", "content", "the full file contents to write"),
                  overwrite: args.overwrite,
                  createDirs: args.create_dirs,
                },
                undefined,
                await resolveCustomNodesScanBaseLiveStrict(),
              ),
            );
          case "patch":
            return jsonResult(
              applyNodePatch(
                required(args.patch, "patch", "patch", "the unified or apply-patch diff to apply under custom_nodes/"),
                undefined,
                await resolveCustomNodesScanBaseLiveStrict(),
              ),
            );
          case "git":
            return jsonResult(
              nodePackGit(
                {
                  pack: required(args.pack, "git", "pack", "the pack folder name under custom_nodes/"),
                  // The rename, and the only one: `git_action` carries what the
                  // retired git tool called `action`, and the service still
                  // receives it under its original key.
                  action: required(
                    args.git_action,
                    "git",
                    "git_action",
                    'one of "status", "diff", "log", "commit", "push"',
                  ),
                  message: args.message,
                  paths: args.paths,
                  maxChars: args.max_chars,
                },
                undefined,
                await resolveCustomNodesScanBaseLiveStrict(),
              ),
            );
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown node_pack action "${String(exhaustive)}". Expected one of: scaffold, verify, publish, list_files, read, search, write, patch, git.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
