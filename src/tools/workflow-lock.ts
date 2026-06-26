import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../comfyui/client.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import {
  diffLocks,
  generateLock,
  parseWorkflowLock,
  type WorkflowLock,
} from "../services/workflow-lock.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";

async function loadWorkflowFromLibrary(filename: string): Promise<WorkflowJSON> {
  const client = getClient();
  const encoded = encodeURIComponent(`workflows/${filename}`);
  const res = await client.fetchApi(`/api/userdata/${encoded}`);
  if (!res.ok) {
    throw new ValidationError(`Workflow not found in user library: ${filename} (${res.status})`);
  }
  return (await res.json()) as WorkflowJSON;
}

/**
 * Load a workflow's lock from the user library. Returns null when no lock is
 * present — either a 404, or (seen on some builds) a 200 with an empty body.
 * Only a genuinely malformed JSON body throws.
 */
async function loadLockFromLibrary(filename: string): Promise<WorkflowLock | null> {
  const lockName = `${filename}.lock.json`;
  const client = getClient();
  const encoded = encodeURIComponent(`workflows/${lockName}`);
  const res = await client.fetchApi(`/api/userdata/${encoded}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new ValidationError(
      `Failed to read lock for "${filename}": ${res.status} ${res.statusText}.`,
    );
  }
  const text = await res.text().catch(() => "");
  return parseWorkflowLock(text);
}

async function saveLockToLibrary(filename: string, lock: WorkflowLock): Promise<void> {
  const lockName = `${filename}.lock.json`;
  const client = getClient();
  const encoded = encodeURIComponent(`workflows/${lockName}`);
  const res = await client.fetchApi(`/api/userdata/${encoded}`, {
    method: "POST",
    body: JSON.stringify(lock, null, 2),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ValidationError(
      `Failed to save lock file for ${filename}: ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`,
    );
  }
}

export function registerWorkflowLockTools(server: McpServer): void {
  server.tool(
    "lock_workflow",
    "Capture a provenance lock for a saved workflow so it can be exactly reproduced later. Walks the workflow's model loaders (CheckpointLoaderSimple, UNETLoader, VAELoader, LoraLoader, ControlNetLoader, etc.), SHA-256s every referenced model file, records the git commit currently checked out for every custom node pack the workflow's class_types come from, and captures ComfyUI's reported version. Writes `<filename>.lock.json` next to the workflow in ComfyUI's user library. Requires a local install (COMFYUI_PATH) — SHA-256 needs raw file bytes and pack commits come from `custom_nodes/*/.git/HEAD`. Pair with verify_workflow_lock later to detect drift.",
    {
      filename: z
        .string()
        .describe("Workflow filename in the ComfyUI user library (e.g. 'my_workflow.json'). The lock is written as '<filename>.lock.json' alongside."),
    },
    async (args) => {
      try {
        const workflow = await loadWorkflowFromLibrary(args.filename);
        const lock = await generateLock(workflow);
        await saveLockToLibrary(args.filename, lock);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Locked "${args.filename}" against ComfyUI ${lock.comfyui_version}.\n` +
                `- ${lock.models.length} model(s), ${lock.models.filter((m) => m.sha256).length} hashed, ${lock.models.filter((m) => m.missing).length} missing on disk.\n` +
                `- ${lock.node_packs.length} custom pack(s), ${lock.node_packs.filter((p) => p.commit_sha).length} with commit recorded.\n\n` +
                "```json\n" +
                JSON.stringify(lock, null, 2) +
                "\n```",
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "verify_workflow_lock",
    "Compare a saved workflow's lock file against the current state of the local install and report drift. Loads `<filename>.lock.json` from ComfyUI's user library, re-computes a current lock from the same workflow, and diffs: which models have a different SHA-256, which custom node packs are on a different commit, whether ComfyUI's version changed. Use before re-running an important workflow days or weeks later to confirm it'll behave the same. Requires a local install (COMFYUI_PATH). Returns a structured drift report (empty arrays everywhere mean perfect parity).",
    {
      filename: z
        .string()
        .describe("Workflow filename whose lock to verify (e.g. 'my_workflow.json')."),
    },
    async (args) => {
      try {
        const [workflow, lock] = await Promise.all([
          loadWorkflowFromLibrary(args.filename),
          loadLockFromLibrary(args.filename),
        ]);

        if (!lock) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No lock present for "${args.filename}" — there is nothing to verify yet. ` +
                  `Run lock_workflow on "${args.filename}" first to create ` +
                  `"${args.filename}.lock.json", then verify_workflow_lock will report drift against it.`,
              },
            ],
          };
        }

        const current = await generateLock(workflow);
        const drift = diffLocks(lock, current);
        const driftCount =
          drift.models.length + drift.node_packs.length + (drift.comfyui_version ? 1 : 0);

        if (driftCount === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No drift — "${args.filename}" still matches its lock from ${lock.generated_at}.`,
              },
            ],
          };
        }

        const lines: string[] = [
          `**Drift detected for "${args.filename}"** — ${driftCount} change(s) since the lock was generated at ${lock.generated_at}.`,
          "",
        ];
        if (drift.comfyui_version) {
          lines.push(
            `**ComfyUI version**: locked at ${drift.comfyui_version.lock}, currently ${drift.comfyui_version.current}.`,
            "",
          );
        }
        if (drift.models.length > 0) {
          lines.push("**Models:**");
          for (const m of drift.models) {
            if (m.status === "missing") {
              lines.push(`- 🚫 missing — ${m.type}/${m.name} (locked sha256 \`${m.lock_sha256?.slice(0, 12) ?? "?"}\`)`);
            } else if (m.status === "changed") {
              lines.push(`- ✏️ changed — ${m.type}/${m.name} (locked \`${m.lock_sha256?.slice(0, 12)}\` → current \`${m.current_sha256?.slice(0, 12)}\`)`);
            } else {
              lines.push(`- ➕ added — ${m.type}/${m.name}`);
            }
          }
          lines.push("");
        }
        if (drift.node_packs.length > 0) {
          lines.push("**Node packs:**");
          for (const p of drift.node_packs) {
            if (p.status === "missing") {
              lines.push(`- 🚫 missing — ${p.id} (locked commit \`${p.lock_commit?.slice(0, 7) ?? "?"}\`)`);
            } else if (p.status === "changed") {
              lines.push(`- ✏️ commit changed — ${p.id} (\`${p.lock_commit?.slice(0, 7)}\` → \`${p.current_commit?.slice(0, 7)}\`)`);
            } else {
              lines.push(`- ➕ added — ${p.id}`);
            }
          }
          lines.push("");
        }
        lines.push("```json\n" + JSON.stringify(drift, null, 2) + "\n```");

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
