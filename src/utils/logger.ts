import {
  chmodSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

// Logs to stderr by default — critical for MCP stdio transport. The
// orchestrator may additionally opt into a bounded file sink before it starts;
// the ordinary MCP server never does, so its wire transport stays untouched.
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

/** Keep one diagnostic file from growing forever across a long-lived install. */
export const MAX_PERSISTENT_LOG_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = "\n[comfyui-mcp] persistent log truncated; keeping the newest records\n";

type PersistentFileSink = { fd: number; bytes: number };
let persistentFileSink: PersistentFileSink | undefined;

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function retainNewestBytes(fd: number, size: number, reserveBytes = 0): number {
  const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
  const keep = Math.max(0, MAX_PERSISTENT_LOG_BYTES - marker.length - reserveBytes);
  const tailLength = Math.min(size, keep);
  const tail = Buffer.alloc(tailLength);
  if (tailLength > 0) readSync(fd, tail, 0, tailLength, size - tailLength);
  ftruncateSync(fd, 0);
  writeSync(fd, marker, 0, marker.length, 0);
  if (tailLength > 0) writeSync(fd, tail, 0, tailLength, marker.length);
  return marker.length + tailLength;
}

/**
 * Open a best-effort persistent mirror for a long-lived process.
 *
 * The sink is deliberately explicit rather than env-enabled: a normal MCP
 * stdio process must never write an unexpected file, while the panel
 * orchestrator has a user-visible need for evidence after its terminal dies.
 * Writes are synchronous because the orchestrator has several hard
 * `process.exit()` paths; an async stream could lose the last fatal line.
 */
export function configurePersistentLogFile(path: string): boolean {
  closePersistentLogFile();
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Create first when needed, then reopen read/write. Windows does not allow
    // ftruncate on an append-mode descriptor, and bounded rotation needs both
    // operations on the same file.
    try {
      fd = openSync(path, "r+", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      fd = openSync(path, "w+", 0o600);
    }
    try {
      // chmod is a no-op on platforms whose ACLs own the mode, and best-effort
      // there. On POSIX this keeps diagnostic contents owner-readable only.
      chmodSync(path, 0o600);
    } catch {
      /* best-effort permissions */
    }
    const size = fstatSync(fd).size;
    const bytes = size > MAX_PERSISTENT_LOG_BYTES ? retainNewestBytes(fd, size) : size;
    persistentFileSink = { fd, bytes };
    return true;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
    return false;
  }
}

export function closePersistentLogFile(): void {
  const sink = persistentFileSink;
  persistentFileSink = undefined;
  if (!sink) return;
  try {
    closeSync(sink.fd);
  } catch {
    /* best-effort cleanup */
  }
}

function appendPersistentLog(line: string): void {
  const sink = persistentFileSink;
  if (!sink) return;
  try {
    const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
    let bytes = Buffer.from(`${line}\n`, "utf8");
    if (bytes.length + marker.length >= MAX_PERSISTENT_LOG_BYTES) {
      const keep = Math.max(0, MAX_PERSISTENT_LOG_BYTES - marker.length);
      bytes = bytes.subarray(bytes.length - keep);
      ftruncateSync(sink.fd, 0);
      writeSync(sink.fd, marker, 0, marker.length, 0);
      sink.bytes = marker.length;
    } else if (sink.bytes + bytes.length > MAX_PERSISTENT_LOG_BYTES) {
      sink.bytes = retainNewestBytes(sink.fd, sink.bytes, bytes.length);
    }
    writeSync(sink.fd, bytes, 0, bytes.length, sink.bytes);
    sink.bytes += bytes.length;
  } catch {
    // Diagnostics must never become the reason the orchestrator fails to start
    // or finish shutting down. Keep stderr logging alive if the file vanishes.
    closePersistentLogFile();
  }
}

function log(level: LogLevel, message: string, data?: unknown): void {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const line = data
    ? `[${ts}] [${level.toUpperCase()}] ${message} ${JSON.stringify(data)}`
    : `[${ts}] [${level.toUpperCase()}] ${message}`;
  appendPersistentLog(line);
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (msg: string, data?: unknown) => log("debug", msg, data),
  info: (msg: string, data?: unknown) => log("info", msg, data),
  warn: (msg: string, data?: unknown) => log("warn", msg, data),
  error: (msg: string, data?: unknown) => log("error", msg, data),
};
