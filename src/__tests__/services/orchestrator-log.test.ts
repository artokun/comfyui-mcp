import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closePersistentLogFile,
  configurePersistentLogFile,
  logger,
  MAX_PERSISTENT_LOG_BYTES,
} from "../../utils/logger.js";
import { orchestratorLogPath } from "../../services/orchestrator-log.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cmcp-orchestrator-log-"));
});

afterEach(() => {
  closePersistentLogFile();
  rmSync(root, { recursive: true, force: true });
});

describe("orchestratorLogPath", () => {
  it("uses the shared data-dir override and stable connect log name", () => {
    expect(orchestratorLogPath({ dataDir: root })).toBe(
      join(root, "launch-logs", "connect-orchestrator.log"),
    );
  });

  it("falls back to the supplied home when no data-dir override exists", () => {
    const home = join(root, "home");
    expect(orchestratorLogPath({ home, dataDir: "" })).toBe(
      join(home, ".comfyui-mcp", "launch-logs", "connect-orchestrator.log"),
    );
  });
});

describe("persistent orchestrator logger", () => {
  it("mirrors startup and exit records to disk without changing the stderr contract", () => {
    const path = orchestratorLogPath({ dataDir: root });
    expect(configurePersistentLogFile(path)).toBe(true);

    const originalStderrWrite = process.stderr.write;
    let stderr = "";
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      logger.info("orchestrator startup");
      logger.error("orchestrator exit", { code: 1 });
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    const log = readFileSync(path, "utf8");
    expect(stderr).toContain("orchestrator startup");
    expect(stderr).toContain("orchestrator exit");
    expect(log).toContain("orchestrator startup");
    expect(log).toContain("orchestrator exit");
    expect(log).toContain('"code":1');
  });

  it("bounds a noisy history and keeps the newest diagnostic record", () => {
    const path = orchestratorLogPath({ dataDir: root });
    expect(configurePersistentLogFile(path)).toBe(true);

    const originalStderrWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      logger.info("x".repeat(MAX_PERSISTENT_LOG_BYTES + 128));
      logger.info("newest diagnostic record");
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    const log = readFileSync(path, "utf8");
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(MAX_PERSISTENT_LOG_BYTES);
    expect(log).toContain("persistent log truncated");
    expect(log).toContain("newest diagnostic record");
  });

  it("fails open when the persistent path is unusable", () => {
    const blocker = join(root, "file");
    writeFileSync(blocker, "not a directory", "utf8");

    expect(configurePersistentLogFile(join(blocker, "nested", "orchestrator.log"))).toBe(false);
    expect(() => logger.warn("stderr remains available")).not.toThrow();
  });

  it("keeps policy validation first and logs connect failures before orchestration", () => {
    const boot = readFileSync(new URL("../../boot.ts", import.meta.url), "utf8");
    const policy = boot.indexOf("resolveToolSurfacePolicy();");
    const orchestrator = boot.indexOf("if (cli.panelOrchestrator)");
    const logging = boot.indexOf("const logPath = orchestratorLogPath();", orchestrator);
    const http = boot.indexOf('if (cli.transport === "http")', orchestrator);
    const urlValidation = boot.indexOf("const urlError = validateConnectUrl(cli.comfyuiUrl);", logging);
    const dynamicImport = boot.indexOf('await import("./orchestrator/index.js")', logging);

    expect(policy).toBeGreaterThan(-1);
    expect(orchestrator).toBeGreaterThan(policy);
    expect(logging).toBeGreaterThan(orchestrator);
    expect(orchestrator).toBeLessThan(http);
    expect(urlValidation).toBeGreaterThan(logging);
    expect(dynamicImport).toBeGreaterThan(logging);
    expect(boot).toContain("configurePersistentLogFile(logPath)");
  });
});
