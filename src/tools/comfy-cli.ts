import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getComfyCliVersion,
  isComfyCliUsable,
  resolveComfyCliExecutable,
  runComfyCli,
} from "../services/comfy-cli.js";
import { searchLiveObjectInfo } from "../services/object-info-search.js";
import {
  isLocalModelsListAction,
  listLocalModelsFallback,
} from "../services/local-models-fallback.js";
import { resetManagerApiCache } from "../services/manager-api-cache.js";
import { errorToToolResult } from "../utils/errors.js";

const whereSchema = z.enum(["local", "cloud"]).optional();
const workspaceSchema = z.string().optional().describe("Optional ComfyUI workspace override (the data/base root comfy-cli uses for custom_nodes/models). Otherwise the live --base-directory / COMFYUI_PATH is used; the CLI executable may still come from the COMFYUI_CODE_PATH checkout's .venv.");

function textEnvelope(envelope: unknown) {
  const failed = typeof envelope === "object" && envelope !== null && "ok" in envelope && envelope.ok === false;
  return {
    ...(failed ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
  };
}

async function call(args: string[], options: { workspace?: string; where?: "local" | "cloud"; timeoutMs?: number; idleTimeoutMs?: number; cwd?: string }) {
  return textEnvelope(await runComfyCli(args, options));
}

/**
 * The eight comfy_cli_* tools collapsed into one action-parameterized
 * `comfy_cli` tool (0.49.0 surface consolidation, slice 3).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model. A flat enum keeps `action` and
 * the per-action arguments visible and self-documenting. Action names carry
 * their family prefix (`jobs_wait`, `models_list_folder`, …) so one flat enum
 * can hold all 26 operations without collisions.
 *
 * REQUIREDNESS: only `action` can be schema-required, because e.g. `query` is
 * required for search_nodes and meaningless everywhere else. The zod layer keeps
 * every VALUE constraint the old tools had (query/workflowPath .min(1), url
 * .url(), limit 1-100) and the handler enforces per-action PRESENCE.
 *
 * The two guards that replace formerly schema-required fields (query for
 * search_nodes, workflowPath for the workflow actions) test ABSENCE
 * (`=== undefined`), never falsiness — an explicit empty string still fails the
 * retained .min(1) at the boundary, exactly as it did before. Every other
 * presence check (promptId, files, folder, url, …) was a handler-level throw in
 * the old tools already and is kept verbatim, messages included. Each branch
 * builds exactly the CLI command the old tool built and returns the identical
 * envelope block.
 */
export function registerComfyCliTools(server: McpServer): void {
  server.tool(
    "comfy_cli",
    "Drive the official comfy-cli (envelope/1 JSON contract) for the selected ComfyUI environment. The MCP resolves `comfy` from COMFY_CLI_PATH, PATH, or the selected workspace's .venv/venv. Driven by the `action` parameter:\n" +
      '- action:"status" — Inspect the comfy-cli integration and selected environment (`comfy which` / `comfy env`); `detail` selects version/which/env/discover (default env). Call this before local CLI operations when workspace or server routing is uncertain.\n' +
      '- action:"server_start" / "server_stop" / "server_restart" — Manage a local ComfyUI through comfy-cli background process management. Restart performs `comfy stop` followed by `comfy launch --background`; extra launch arguments go in `launchArgs`.\n' +
      '- action:"jobs_list" — List local or Comfy Cloud jobs (`limit` optional). Local jobs include CLI-tracked async submissions plus the ComfyUI queue/history.\n' +
      '- action:"jobs_status" / "jobs_watch" / "jobs_cancel" — Inspect, watch, or cancel one job; `promptId` required.\n' +
      '- action:"jobs_wait" — Wait for jobs: one of `promptId`, `promptIds`, or all=true is required; `timeoutSeconds` optional.\n' +
      '- action:"search_nodes" — Fuzzy-search actual ComfyUI node classes by name, display name, or description using `comfy nodes search`; `query` required. Complements search_custom_nodes, which searches installable node packs. Works locally, in Comfy Cloud, or offline with `objectInfoPath`. When comfy-cli is not installed/on PATH and the target is the connected (local) server, falls back to fuzzy-searching that server\'s live /object_info — so installed-node discovery works without the CLI.\n' +
      '- action:"workflow_validate" — Validate an API/UI workflow file (class types, inputs, enums, edge wiring) without submission; `workflowPath` required.\n' +
      '- action:"workflow_run" — Submit an API/UI workflow file (`workflowPath` required). Asynchronous by default; set wait=true to await outputs (`timeoutSeconds`).\n' +
      '- action:"transfer_upload" — Upload input files (`files` required) for local ComfyUI or Comfy Cloud; overwrite=false passes --no-overwrite.\n' +
      '- action:"transfer_download" — Download completed outputs for `promptId` (required); `outDir` and `urlOnly` optional.\n' +
      '- action:"models_list_folders" / "models_list_folder" / "models_search" / "models_show" — Discover model folders/files locally or in Comfy Cloud (`folder` required for list_folder, `name` for show). For models_show, pass `folder`/`type` or a relative `name` path (e.g. vae/foo.safetensors) when the same basename exists in more than one folder. When comfy-cli is not installed/on PATH and the target is the connected (local) server, these read-only listings fall back to that server\'s own local models (via /models) — so model discovery works without the CLI.\n' +
      '- action:"models_download" — Download a model `url` (required) into the workspace (`relativePath`, default models/checkpoints). A download can run for many minutes and is gated on an idle-liveness timeout, so a progressing download is never killed.\n' +
      '- action:"models_remove" — Remove workspace model files (`modelNames` required; `relativePath` optional).\n' +
      '- action:"skills_list" / "skills_show" / "skills_validate" / "skills_install" / "skills_status" / "skills_uninstall" — Manage the official comfy-cli bundled agent skills (comfy, fragments, debug, relay, director). validate requires `path`; install/uninstall default to dry-run unless apply=true; scope="project" requires `projectDir`.',
    {
      action: z
        .enum([
          "status",
          "server_start",
          "server_stop",
          "server_restart",
          "jobs_list",
          "jobs_status",
          "jobs_wait",
          "jobs_watch",
          "jobs_cancel",
          "search_nodes",
          "workflow_validate",
          "workflow_run",
          "transfer_upload",
          "transfer_download",
          "models_list_folders",
          "models_list_folder",
          "models_search",
          "models_show",
          "models_download",
          "models_remove",
          "skills_list",
          "skills_show",
          "skills_validate",
          "skills_install",
          "skills_status",
          "skills_uninstall",
        ])
        .describe(
          'Which comfy-cli operation to perform. Families: status; server_* (lifecycle); jobs_* (list/status/wait/watch/cancel); search_nodes; workflow_* (validate/run); transfer_* (upload/download); models_* (list_folders/list_folder/search/show/download/remove); skills_* (list/show/validate/install/status/uninstall).',
        ),
      detail: z.enum(["version", "which", "env", "discover"]).optional().default("env").describe('action:"status" — which inspection to run.'),
      workspace: workspaceSchema,
      launchArgs: z.array(z.string()).optional().describe('actions "server_start"/"server_restart" — extra ComfyUI launch arguments, e.g. [\'--listen\',\'0.0.0.0\',\'--port\',\'8188\'].'),
      promptId: z.string().optional().describe('Single prompt id. Required for "jobs_status"/"jobs_watch"/"jobs_cancel" and "transfer_download"; accepted for "jobs_wait" (normalized into a one-element promptIds list).'),
      promptIds: z.array(z.string()).optional().describe('action:"jobs_wait" — prompt ids to wait on. Use this or promptId or all=true.'),
      all: z.boolean().optional().describe('action:"jobs_wait" — wait on every known job.'),
      limit: z.number().int().min(1).max(100).optional().describe('Result cap for "jobs_list", "search_nodes" and the "models_*" listing/search actions.'),
      timeoutSeconds: z.number().int().min(1).optional().describe('actions "jobs_wait"/"jobs_watch"/"workflow_run" — max seconds to wait.'),
      where: whereSchema.describe('Target for the jobs/search_nodes/workflow/transfer/models actions: "local" (default) or "cloud" (Comfy Cloud).'),
      query: z.string().min(1).optional().describe('action:"search_nodes" — fuzzy search text. REQUIRED.'),
      objectInfoPath: z.string().optional().describe('action:"search_nodes" — offline object_info JSON file to search instead of a live target.'),
      workflowPath: z.string().min(1).optional().describe('actions "workflow_validate"/"workflow_run" — path to an API/UI workflow JSON file. REQUIRED.'),
      wait: z.boolean().optional().describe('action:"workflow_run" — await outputs instead of returning after submission.'),
      files: z.array(z.string()).optional().describe('action:"transfer_upload" — input files to upload. REQUIRED.'),
      outDir: z.string().optional().describe('action:"transfer_download" — output directory.'),
      overwrite: z.boolean().optional().describe('action:"transfer_upload" — set false to pass --no-overwrite.'),
      urlOnly: z.boolean().optional().describe('action:"transfer_download" — print URLs instead of downloading files.'),
      folder: z.string().optional().describe('action:"models_list_folder" — the model folder to list (REQUIRED). action:"models_show" — optional folder to pick among duplicate basenames.'),
      text: z.string().optional().describe('action:"models_search" — search text.'),
      type: z.string().optional().describe('action:"models_search" — model type filter (checkpoint, lora, vae, …). action:"models_show" — same filter, to pick among duplicate basenames.'),
      name: z.string().optional().describe('actions "models_show"/"skills_show" — the model or skill name. For models_show a relative path (e.g. vae/qwen_image_vae.safetensors) selects among duplicate basenames.'),
      url: z.string().url().optional().describe('action:"models_download" — model URL to download. REQUIRED.'),
      relativePath: z.string().optional().describe('actions "models_download"/"models_remove" — workspace-relative model directory (default models/checkpoints).'),
      modelNames: z.array(z.string()).optional().describe('action:"models_remove" — model filenames to remove. REQUIRED.'),
      path: z.string().optional().describe('action:"skills_validate" — path to the skill to validate. REQUIRED.'),
      scope: z.enum(["user", "project"]).optional().describe('actions "skills_install"/"skills_uninstall"/"skills_status" — install scope.'),
      projectDir: z.string().optional().describe("Working directory for project-scoped skill operations. Required when scope='project'."),
      targets: z.array(z.string()).optional().describe('actions "skills_install"/"skills_uninstall" — agent targets.'),
      skills: z.array(z.string()).optional().describe('actions "skills_install"/"skills_uninstall" — skill names.'),
      apply: z.boolean().optional().default(false).describe('actions "skills_install"/"skills_uninstall" — actually mutate; default false = dry-run.'),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "status": {
            if (args.detail === "version") {
              return textEnvelope({ executable: resolveComfyCliExecutable({ workspace: args.workspace }), version: getComfyCliVersion({ workspace: args.workspace }) });
            }
            return await call([args.detail], { workspace: args.workspace, timeoutMs: 30_000 });
          }

          case "server_start":
          case "server_stop":
          case "server_restart": {
            const sub = args.action.slice(7) as "start" | "stop" | "restart";
            const options = { workspace: args.workspace, timeoutMs: 120_000 };
            let stopped: Awaited<ReturnType<typeof runComfyCli>> | undefined;
            if (sub !== "start") {
              stopped = await runComfyCli(["stop"], options);
              // This is a ComfyUI lifecycle transition like any other: the instance
              // that comes back on the same URL can be a different ComfyUI-Manager
              // generation, so the detected dialect must not carry over (#646).
              resetManagerApiCache("comfy-cli server stop");
            }
            if (sub === "stop") return textEnvelope(stopped);
            if (stopped && !stopped.ok) return textEnvelope(stopped);
            const launch = ["launch", "--background"];
            if (args.launchArgs?.length) launch.push("--", ...args.launchArgs);
            const started = await runComfyCli(launch, options);
            // A launch may have replaced the server behind the same URL — re-probe.
            resetManagerApiCache("comfy-cli server launch");
            return textEnvelope(sub === "restart" ? { stopped, started } : started);
          }

          case "jobs_list":
          case "jobs_status":
          case "jobs_wait":
          case "jobs_watch":
          case "jobs_cancel": {
            const sub = args.action.slice(5); // list | status | wait | watch | cancel
            const subcommand = sub === "list" ? "ls" : sub;
            const command = ["jobs", subcommand];
            if (["status", "watch", "cancel"].includes(sub)) {
              if (!args.promptId) throw new Error(`promptId is required for jobs ${sub}`);
              command.push(args.promptId);
            } else if (sub === "wait") {
              // Accept the documented singular `promptId` by normalizing it into a
              // one-element promptIds list before validation (#360).
              const waitIds = args.promptIds?.length
                ? args.promptIds
                : args.promptId
                  ? [args.promptId]
                  : [];
              if (args.all) command.push("--all");
              else if (waitIds.length) command.push(...waitIds);
              else throw new Error("promptId, promptIds, or all=true is required for jobs wait");
            }
            if (args.limit && sub === "list") command.push("--limit", String(args.limit));
            if (args.timeoutSeconds && ["wait", "watch"].includes(sub)) command.push("--timeout", String(args.timeoutSeconds));
            return await call(command, { workspace: args.workspace, where: args.where, timeoutMs: ((args.timeoutSeconds ?? 120) + 10) * 1000 });
          }

          case "search_nodes": {
            // ABSENCE only, never falsiness: `query` was schema-required with
            // .min(1) before this consolidation, so an empty string failed at the
            // boundary (the retained .min(1) still fails it there) and only a
            // genuinely OMITTED query is the case the schema used to catch.
            if (args.query === undefined) {
              throw new Error('comfy_cli action:"search_nodes" requires `query` — the fuzzy search text.');
            }
            // Live /object_info fallback (#354): when comfy-cli is absent and we are
            // searching the connected local server (not Comfy Cloud, and not an
            // explicit offline object_info file), query the running ComfyUI's
            // /object_info directly instead of failing on the missing CLI.
            // Honor an explicit `workspace`: /object_info comes from the CONNECTED
            // server, which may be a DIFFERENT install than the one requested — so
            // when a workspace is pinned we do NOT substitute it silently. Instead we
            // fall through and let comfy-cli surface its clear not-found error for
            // that workspace (install comfy-cli there, or drop `workspace` to search
            // the connected server).
            if (
              args.where !== "cloud" &&
              !args.objectInfoPath &&
              !args.workspace &&
              !isComfyCliUsable({ workspace: args.workspace })
            ) {
              const results = await searchLiveObjectInfo(args.query, args.limit ?? 20);
              return textEnvelope({
                schema: "envelope/1",
                type: "envelope",
                ok: true,
                command: `nodes search ${args.query}`,
                version: "object_info-fallback",
                where: "local",
                source: "live_object_info",
                note: "comfy-cli was not found; searched the connected ComfyUI's live /object_info instead.",
                data: { count: results.length, results },
                error: null,
              });
            }
            const command = ["nodes", "search", args.query];
            if (args.limit) command.push("--limit", String(args.limit));
            if (args.objectInfoPath) command.push("--input", args.objectInfoPath);
            return await call(command, { workspace: args.workspace, where: args.where, timeoutMs: 60_000 });
          }

          case "workflow_validate":
          case "workflow_run": {
            // ABSENCE only, never falsiness — same reason as `query` above:
            // workflowPath was schema-required with .min(1), which still rejects
            // an explicit empty string at the boundary.
            if (args.workflowPath === undefined) {
              throw new Error(`comfy_cli action:"${args.action}" requires \`workflowPath\` — the API/UI workflow JSON file.`);
            }
            const sub = args.action.slice(9); // validate | run
            const command = [sub, "--workflow", args.workflowPath];
            if (sub === "run" && args.wait) command.push("--wait");
            if (sub === "run" && args.timeoutSeconds) command.push("--timeout", String(args.timeoutSeconds));
            return await call(command, { workspace: args.workspace, where: args.where, timeoutMs: ((args.timeoutSeconds ?? 120) + 10) * 1000 });
          }

          case "transfer_upload":
          case "transfer_download": {
            const sub = args.action.slice(9); // upload | download
            const command: string[] = [sub];
            if (sub === "upload") {
              if (!args.files?.length) throw new Error("files is required for upload");
              command.push(...args.files);
              if (args.overwrite === false) command.push("--no-overwrite");
            } else {
              if (!args.promptId) throw new Error("promptId is required for download");
              command.push(args.promptId);
              if (args.outDir) command.push("--out-dir", args.outDir);
              if (args.urlOnly) command.push("--url-only");
            }
            return await call(command, { workspace: args.workspace, where: args.where, timeoutMs: 300_000 });
          }

          case "models_list_folders":
          case "models_list_folder":
          case "models_search":
          case "models_show":
          case "models_download":
          case "models_remove": {
            const sub = args.action.slice(7).replace(/_/g, "-"); // list-folders | list-folder | search | show | download | remove
            // Local models fallback (#460): the read-only listing actions don't
            // need comfy-cli — the connected local ComfyUI already reports its
            // installed models. When comfy-cli is absent and we're targeting the
            // connected server (not Comfy Cloud, no pinned workspace), serve the
            // listing from listLocalModels() instead of failing on the missing CLI.
            // A pinned `workspace` may be a DIFFERENT install than the connected
            // server, so we don't substitute silently — we fall through and let
            // comfy-cli surface its clear not-found error for that workspace.
            // Mirrors the live /object_info fallback for action:"search_nodes".
            // The fallback fires when comfy-cli is UNUSABLE — either absent OR a
            // found-but-unrecognized/too-old version. An unsupported CLI otherwise
            // returns `unsupported_version` without attempting the server (#487); the
            // connected ComfyUI already reports its models via /models (through
            // listLocalModels), so read-only listing works regardless of the CLI.
            const listAction = isLocalModelsListAction(sub) ? sub : undefined;
            if (
              listAction &&
              args.where !== "cloud" &&
              !args.workspace &&
              !isComfyCliUsable({ workspace: args.workspace })
            ) {
              const { command, data } = await listLocalModelsFallback({ ...args, action: listAction });
              return textEnvelope({
                schema: "envelope/1",
                type: "envelope",
                ok: true,
                command,
                version: "local-models-fallback",
                where: "local",
                source: "local_models",
                note: "comfy-cli was not found; listed the connected ComfyUI's local models instead.",
                data,
                error: null,
              });
            }
            const command = [sub === "download" || sub === "remove" ? "model" : "models", sub];
            if (sub === "list-folder") {
              if (!args.folder) throw new Error("folder is required for list-folder");
              command.push(args.folder);
            }
            if (sub === "show") {
              if (!args.name) throw new Error("name is required for show");
              command.push(args.name);
            }
            if (sub === "search") {
              if (args.text) command.push("--text", args.text);
              if (args.type) command.push("--type", args.type);
            }
            if (sub === "download") {
              if (!args.url) throw new Error("url is required for model download");
              command.push("--url", args.url);
              if (args.relativePath) command.push("--relative-path", args.relativePath);
            }
            if (sub === "remove") {
              if (!args.modelNames?.length) throw new Error("modelNames is required for model remove");
              if (args.relativePath) command.push("--relative-path", args.relativePath);
              command.push("--model-names", args.modelNames.join(" "));
            }
            if (args.limit && sub !== "show" && sub !== "list-folders") command.push("--limit", String(args.limit));
            // A download can legitimately run for many minutes. Gate it on an IDLE
            // (liveness) timeout so a still-progressing download is not killed —
            // downloader progress output resets the clock — while a truly stalled
            // one is still terminated. Other actions keep the fast hard timeout.
            if (sub === "download") {
              return await call(command, { workspace: args.workspace, where: args.where, idleTimeoutMs: 120_000 });
            }
            return await call(command, { workspace: args.workspace, where: args.where, timeoutMs: 60_000 });
          }

          case "skills_list":
          case "skills_show":
          case "skills_validate":
          case "skills_install":
          case "skills_status":
          case "skills_uninstall": {
            const sub = args.action.slice(7); // list | show | validate | install | status | uninstall
            const command = ["skills", sub];
            if (args.scope === "project" && !args.projectDir) {
              throw new Error("projectDir is required when scope='project'");
            }
            if (sub === "show" && args.name) command.push(args.name);
            if (sub === "validate") {
              if (!args.path) throw new Error("path is required for skills validate");
              command.push(args.path);
            }
            if (["install", "uninstall", "status"].includes(sub) && args.scope) command.push("--scope", args.scope);
            if (["install", "uninstall"].includes(sub)) {
              for (const target of args.targets ?? []) command.push("--target", target);
              for (const skill of args.skills ?? []) command.push("--skill", skill);
              if (!args.apply) command.push("--dry-run");
            }
            return await call(command, { workspace: args.workspace, timeoutMs: 60_000, cwd: args.projectDir });
          }

          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown comfy_cli action "${String(exhaustive)}". Expected one of: status, server_start, server_stop, server_restart, jobs_list, jobs_status, jobs_wait, jobs_watch, jobs_cancel, search_nodes, workflow_validate, workflow_run, transfer_upload, transfer_download, models_list_folders, models_list_folder, models_search, models_show, models_download, models_remove, skills_list, skills_show, skills_validate, skills_install, skills_status, skills_uninstall.`,
            );
          }
        }
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );
}
