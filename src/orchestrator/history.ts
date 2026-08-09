// Chat-history parity for the mobile client: read the Claude Code session
// transcripts the orchestrator's agent writes to disk, so the phone can browse
// and resume the SAME conversations the desktop panel drives.
//
// Claude Code stores one JSONL file per session under
//   ~/.claude/projects/<cwd-encoded>/<session-id>.jsonl
// where <cwd-encoded> is the agent's working directory with every path separator
// (and the drive colon) replaced by `-`. Both the panel and the mobile app drive
// the same orchestrator process (same cwd), so they share this session pool.
//
// This is Claude-backend-specific (JSONL shape). Other backends return an empty
// list — history parity is a Claude feature for now.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

export interface HistorySessionSummary {
  sessionId: string;
  /** First user message, trimmed — the conversation's title/preview. */
  title: string;
  /** Last-modified time (ms since epoch) for sorting + display. */
  updatedAt: number;
  /** Count of user+assistant turns (rough conversation length). */
  messageCount: number;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

/** The Claude projects dir for the current working directory. Claude encodes the
 *  cwd by replacing `:`, `\` and `/` with `-` (e.g. C:\Users\a\b → C--Users-a-b). */
function projectDir(cwd: string): string {
  const encoded = cwd.replace(/[:\\/]/g, "-");
  return join(homedir(), ".claude", "projects", encoded);
}

/** Pull the plain text out of a Claude message `content` (string or block array),
 *  keeping only human-readable text blocks (skips tool_use / tool_result / thinking). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("").trim();
}

/** Is this a real user turn (not a tool_result echoed back as a user message)? */
function isRealUserText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  // A tool_result-only user message isn't a human turn.
  return content.some(
    (b) => b && typeof b === "object" && (b as { type?: string }).type === "text",
  );
}

/** Strip orchestrator-injected prefixes so we show the user's actual message.
 *  Headless (mobile) turns are prepended with the HEADLESS_DIRECTIVE joined by
 *  a blank line; panel turns are clean. Returns "" for a message that is ONLY an
 *  injected directive / transcript-replay seed (so it's dropped). */
function cleanUserText(raw: string): string {
  let t = raw.trim();
  if (t.startsWith("[HEADLESS SESSION")) {
    const i = t.indexOf("\n\n");
    t = i >= 0 ? t.slice(i + 2).trim() : "";
  }
  // The panel replays the whole transcript as a bracketed/angled seed on
  // reconnect — not a real turn.
  if (t.startsWith("<") || t.startsWith("[Conversation so far")) return "";
  return t;
}

/**
 * List the agent's saved sessions for [cwd], newest first. [limit] caps how many
 * are returned.
 *
 * Best-effort about CONTENT: an unparseable file is skipped rather than failing
 * the list. NOT best-effort about the DIRECTORY (#796): a missing directory is an
 * empty list (a first run looks exactly like that), but one that exists and
 * cannot be read THROWS — reporting "no saved sessions" for a permission or IO
 * error is a wrong answer that reads as data loss.
 */
export async function listSessions(
  cwd: string,
  limit = 50,
): Promise<HistorySessionSummary[]> {
  const dir = projectDir(cwd);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    // #796 — "you have no saved sessions" and "your sessions could not be read"
    // are different answers, and this returned the first for both.
    //
    // ENOENT/ENOTDIR is genuine: the directory has not been created yet, which is
    // what a first run looks like, and an empty list is the truth. A permission
    // error, an IO error or a network path that went away is NOT — and telling
    // someone their history is empty is the one wrong answer that reads as data
    // loss. They go looking for conversations they think they lost.
    //
    // Thrown rather than returned-with-a-flag because the ONE caller already
    // wraps this in a `.catch` that pushes `{ sessions: [], error }` to the
    // panel — plumbing that could never fire for a read failure, because this
    // swallowed every one of them.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw new Error(
      `Could not read the saved-session directory (${dir}): ${
        err instanceof Error ? err.message : String(err)
      }. This is NOT the same as having no saved sessions — none could be listed, ` +
        `so nothing about their existence is known.`,
    );
  }

  const summaries = await Promise.all(
    files.map(async (file): Promise<HistorySessionSummary | null> => {
      const path = join(dir, file);
      try {
        const info = await stat(path);
        const raw = await readFile(path, "utf8");
        let title = "";
        let messageCount = 0;
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let d: unknown;
          try {
            d = JSON.parse(line);
          } catch {
            continue;
          }
          const msg = (d as { message?: unknown }).message;
          if (!msg || typeof msg !== "object") continue;
          const role = (msg as { role?: string }).role;
          const content = (msg as { content?: unknown }).content;
          if (role === "user" && isRealUserText(content)) {
            const t = cleanUserText(textOf(content));
            if (!t) continue; // pure directive / replay seed — not a turn
            messageCount++;
            if (!title) title = t.replace(/\s+/g, " ").slice(0, 100);
          } else if (role === "assistant" && textOf(content)) {
            messageCount++;
          }
        }
        if (messageCount === 0) return null; // empty / tool-only session — skip
        return {
          sessionId: file.replace(/\.jsonl$/, ""),
          title: title || "(untitled conversation)",
          updatedAt: info.mtimeMs,
          messageCount,
        };
      } catch (err) {
        logger.debug("history: failed to summarize session", { file, err });
        return null;
      }
    }),
  );

  return summaries
    .filter((s): s is HistorySessionSummary => s !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/**
 * Parse one session's transcript into an ordered user/assistant message list,
 * dropping tool calls, thinking, and meta rows. Returns [] if the file is
 * missing or unreadable.
 */
export async function loadTranscript(
  cwd: string,
  sessionId: string,
): Promise<HistoryMessage[]> {
  // Guard the id to a bare uuid-ish filename (no path traversal).
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return [];
  const path = join(projectDir(cwd), `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: HistoryMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = (d as { message?: unknown }).message;
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: string }).role;
    const content = (msg as { content?: unknown }).content;
    if (role === "user") {
      if (!isRealUserText(content)) continue; // skip tool_result echoes
      const text = cleanUserText(textOf(content));
      if (!text) continue; // pure directive / replay seed
      out.push({ role: "user", text });
    } else if (role === "assistant") {
      const text = textOf(content);
      if (text) out.push({ role: "assistant", text });
    }
  }
  return out;
}
