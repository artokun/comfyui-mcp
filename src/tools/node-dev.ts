import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listNodePackFiles,
  readNodeFile,
  searchNodePacks,
  writeNodeFile,
  applyNodePatch,
  nodePackGit,
} from "../services/node-dev.js";
import { errorToToolResult } from "../utils/errors.js";

const jsonResult = (result: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
});

/**
 * Path-jailed live custom-node dev tools — read/search/edit/commit a pack's
 * source under <COMFYUI_PATH>/custom_nodes. Closes the diagnose→patch→verify→
 * commit loop between the bisect/fix tools and verify/publish. See
 * docs/design/node-dev-tools.md. LOCAL-ONLY (needs COMFYUI_PATH); every path is
 * jailed to custom_nodes/.
 */
export function registerNodeDevTools(server: McpServer): void {
  server.tool(
    "list_node_pack_files",
    "List the files in one installed custom-node pack under " +
      "<COMFYUI_PATH>/custom_nodes/<pack>/ (read-only). Skips .git/, " +
      "__pycache__/ and node_modules/. Use this to orient before read_node_file / " +
      "search_node_packs when diagnosing or editing a pack you found via " +
      "bisect_* or fix_custom_node. LOCAL-ONLY (requires COMFYUI_PATH); the pack " +
      "name and every returned path are jailed to custom_nodes/.",
    {
      pack: z
        .string()
        .describe("Pack folder name under custom_nodes/ (e.g. 'ComfyUI-Manager')."),
      glob: z
        .string()
        .optional()
        .describe("Optional glob to filter entries (supports *, **, ?), matched against pack-relative paths."),
      max_entries: z
        .number()
        .int()
        .optional()
        .describe("Maximum entries to return (default 500, max 2000)."),
    },
    async (args) => {
      try {
        return jsonResult(
          listNodePackFiles({
            pack: args.pack,
            glob: args.glob,
            maxEntries: args.max_entries,
          }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "read_node_file",
    "Read a slice of one file inside a custom-node pack (read-only), with " +
      "bounded output so a huge file can't flood the context. Returns the " +
      "requested line range with a truncation notice when clipped; long lines are " +
      "chunked. Pair with search_node_packs to locate the line, then apply_node_patch " +
      "or write_node_file to change it. LOCAL-ONLY (requires COMFYUI_PATH); the " +
      "path is jailed to custom_nodes/.",
    {
      path: z
        .string()
        .describe("Pack-relative path under custom_nodes/, e.g. 'MyPack/nodes.py'."),
      start_line: z
        .number()
        .int()
        .optional()
        .describe("1-based line to start at (default 1)."),
      line_count: z
        .number()
        .int()
        .optional()
        .describe("Number of lines to return (default 240, max 800)."),
      max_chars: z
        .number()
        .int()
        .optional()
        .describe("Maximum characters to return (default 12000, max 24000)."),
    },
    async (args) => {
      try {
        return jsonResult(
          readNodeFile({
            path: args.path,
            startLine: args.start_line,
            lineCount: args.line_count,
            maxChars: args.max_chars,
          }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "search_node_packs",
    "Regex-search custom-node source under custom_nodes/ (read-only). Uses " +
      "ripgrep when it's on PATH, otherwise a bounded built-in scanner (skips " +
      "dot-dirs, __pycache__/node_modules, binary and >1 MiB files). Returns " +
      "file/line/text matches with per-line and result caps. Use this to find " +
      "where a node class, import, or error string lives before reading or " +
      "patching. LOCAL-ONLY (requires COMFYUI_PATH); the search path is jailed to " +
      "custom_nodes/.",
    {
      query: z.string().describe("Regular expression to search for."),
      path: z
        .string()
        .optional()
        .describe("Pack-relative directory to search, or '.' for all packs (default '.')."),
      glob: z
        .string()
        .optional()
        .describe("Optional glob to restrict which files are searched (e.g. '**/*.py')."),
      max_results: z
        .number()
        .int()
        .optional()
        .describe("Maximum matches to return (default 50, max 100)."),
      case_sensitive: z
        .boolean()
        .optional()
        .describe("Match case-sensitively (default false)."),
    },
    async (args) => {
      try {
        return jsonResult(
          searchNodePacks({
            query: args.query,
            path: args.path,
            glob: args.glob,
            maxResults: args.max_results,
            caseSensitive: args.case_sensitive,
          }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "write_node_file",
    "Create or overwrite one file inside a custom-node pack under " +
      "custom_nodes/. Refuses to clobber an existing file unless overwrite is " +
      "true, and creates parent directories by default. Use for whole-file edits " +
      "or new files; for surgical edits prefer apply_node_patch. After writing, " +
      "run verify_custom_node and restart_comfyui to load the change. LOCAL-ONLY " +
      "(requires COMFYUI_PATH); the path is jailed to custom_nodes/.",
    {
      path: z
        .string()
        .describe("Pack-relative path under custom_nodes/, e.g. 'MyPack/nodes.py'."),
      content: z.string().describe("Full file contents to write."),
      overwrite: z
        .boolean()
        .optional()
        .describe("Overwrite an existing file instead of refusing (default false)."),
      create_dirs: z
        .boolean()
        .optional()
        .describe("Create missing parent directories (default true)."),
    },
    async (args) => {
      try {
        return jsonResult(
          writeNodeFile({
            path: args.path,
            content: args.content,
            overwrite: args.overwrite,
            createDirs: args.create_dirs,
          }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "apply_node_patch",
    "Apply a unified diff to custom-node source under custom_nodes/. Every " +
      "touched path is jail-checked BEFORE any git call, then the patch is " +
      "validated with `git apply --check` and only applied if the check passes " +
      "(two-phase; never uses --unsafe-paths). Paths are relative to custom_nodes/ " +
      "and may carry a/ b/ prefixes; works on non-repo packs too. Ideal for " +
      "surgical edits located via search_node_packs. LOCAL-ONLY (requires " +
      "COMFYUI_PATH).",
    {
      patch: z
        .string()
        .describe(
          "A unified diff. File headers (---/+++) are read to determine touched paths, which must resolve inside custom_nodes/ (e.g. 'a/MyPack/nodes.py').",
        ),
    },
    async (args) => {
      try {
        return jsonResult(applyNodePatch(args.patch));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "node_pack_git",
    "Run a git operation inside one custom-node pack (status/diff/log/commit/" +
      "push). Reads (status/diff/log) are always allowed. Writes (commit/push) " +
      "require the environment flag COMFYUI_MCP_ALLOW_GIT_WRITES=1 (default OFF) " +
      "and otherwise return a structured DISABLED_BY_CONFIG refusal so you can " +
      "self-correct. commit requires a message and stages either the given paths " +
      "or all pack changes. This is the final step of the author loop after " +
      "scaffold_custom_node → write_node_file/apply_node_patch → verify_custom_node " +
      "→ restart_comfyui, before publish_custom_node. LOCAL-ONLY (requires " +
      "COMFYUI_PATH); the pack and any paths are jailed to custom_nodes/.",
    {
      pack: z
        .string()
        .describe("Pack folder name under custom_nodes/."),
      action: z
        .enum(["status", "diff", "log", "commit", "push"])
        .describe(
          "Git action. status/diff/log are read-only; commit/push require COMFYUI_MCP_ALLOW_GIT_WRITES=1.",
        ),
      message: z
        .string()
        .optional()
        .describe("Commit message (required for action 'commit')."),
      paths: z
        .array(z.string())
        .optional()
        .describe("Pack-relative paths to stage/scope (jail-checked). Defaults to all pack changes."),
      max_chars: z
        .number()
        .int()
        .optional()
        .describe("Maximum characters of git output to return (default 12000)."),
    },
    async (args) => {
      try {
        return jsonResult(
          nodePackGit({
            pack: args.pack,
            action: args.action,
            message: args.message,
            paths: args.paths,
            maxChars: args.max_chars,
          }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
