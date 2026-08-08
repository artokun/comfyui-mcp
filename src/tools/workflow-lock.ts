import { getClient } from "../comfyui/client.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import {
  diffLocks,
  generateLock,
  parseWorkflowLock,
  type WorkflowLock,
} from "../services/workflow-lock.js";
import { ValidationError } from "../utils/errors.js";

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
  // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
  // HTTP status is reported either way, so an unreadable body costs detail in the
  // text, never a wrong conclusion. Verified there is no branch on this value.
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
    // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
    // HTTP status is reported either way, so an unreadable body costs detail in the
    // text, never a wrong conclusion. Verified there is no branch on this value.
    const text = await res.text().catch(() => "");
    throw new ValidationError(
      `Failed to save lock file for ${filename}: ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`,
    );
  }
}

/**
 * `save_workflow (action:"lock")` — the body of the retired provenance-lock
 * tool, verbatim (0.50.0 slice 14). Same library load, same `generateLock`,
 * same `<filename>.lock.json` write, same content block.
 *
 * This action WRITES, which is why `save_workflow`'s `call_tool` admission is
 * action-scoped to `save` alone — see src/orchestrator/call-tool-admission.ts.
 */
export async function lockWorkflowAction(
  filename: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const workflow = await loadWorkflowFromLibrary(filename);
  const lock = await generateLock(workflow);
  await saveLockToLibrary(filename, lock);
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Locked "${filename}" against ComfyUI ${lock.comfyui_version}.\n` +
          `- ${lock.models.length} model(s), ${lock.models.filter((m) => m.sha256).length} hashed, ${lock.models.filter((m) => m.missing).length} missing on disk.\n` +
          `- ${lock.node_packs.length} custom pack(s), ${lock.node_packs.filter((p) => p.commit_sha).length} with commit recorded.\n\n` +
          "```json\n" +
          JSON.stringify(lock, null, 2) +
          "\n```",
      },
    ],
  };
}

/**
 * `save_workflow (action:"verify_lock")` — the body of the retired lock-drift
 * tool, verbatim (0.50.0 slice 14). Read-only: loads the lock, recomputes a
 * current one, and reports the diff.
 *
 * Both throw rather than returning `errorToToolResult`; the caller wraps every
 * action in the identical catch, so failures render exactly as before.
 */
export async function verifyWorkflowLockAction(
  filename: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const [workflow, lock] = await Promise.all([
    loadWorkflowFromLibrary(filename),
    loadLockFromLibrary(filename),
  ]);

  if (!lock) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `No lock present for "${filename}" — there is nothing to verify yet. ` +
            `Run save_workflow (action:"lock") on "${filename}" first to create ` +
            `"${filename}.lock.json", then save_workflow (action:"verify_lock") will report drift against it.`,
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
          text: `No drift — "${filename}" still matches its lock from ${lock.generated_at}.`,
        },
      ],
    };
  }

  const lines: string[] = [
    `**Drift detected for "${filename}"** — ${driftCount} change(s) since the lock was generated at ${lock.generated_at}.`,
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
}
