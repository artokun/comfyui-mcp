// #2030 — never kill a process we cannot prove is ours.
//
// Logitech G HUB's lghub_agent accepts a TCP connect on 9180 but does not
// speak the panel protocol. tryReclaimBridgePort must probe, classify not-ours,
// and return without prompting or taskkill. This suite drives the shipped
// function against a real TCP listener that refuses the WebSocket upgrade.

import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessBridgeHolder,
  bindFailureAdvice,
  foreignBridgeHolderAdvice,
  tryReclaimBridgePort,
} from "../../services/bridge-port-reclaim.js";
import { classifyBridgeHolder, unclassifiedOwnership } from "../../services/listener-ownership.js";
import { probePanelOrchestrator } from "../../services/panel-launcher.js";
import { DEFAULT_PANEL_BRIDGE_PORT, LEGACY_PANEL_BRIDGE_PORT } from "../../services/bridge-ports.js";

function listenHttp200(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer((sock) => {
      sock.once("data", () => {
        sock.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise((r) => {
            srv.close(() => r());
          }),
      });
    });
  });
}

describe("classifyBridgeHolder (#2030)", () => {
  it("a TCP holder that does not speak the panel protocol is not-ours and not reclaimable", () => {
    const v = classifyBridgeHolder({
      speaksPanelProtocol: false,
      lockfileOursOrStale: true,
    });
    expect(v.ownership).toBe("not-ours");
    expect(v.reclaimable).toBe(false);
  });

  it("a leftover lockfile does not make a foreign holder ours", () => {
    const v = classifyBridgeHolder({
      speaksPanelProtocol: false,
      lockfileOursOrStale: false,
    });
    expect(v.ownership).toBe("not-ours");
    expect(v.reclaimable).toBe(false);
  });

  it("a panel-protocol speaker is ours to reclaim", () => {
    const v = classifyBridgeHolder({
      speaksPanelProtocol: true,
      lockfileOursOrStale: true,
    });
    expect(v.ownership).toBe("ours");
    expect(v.reclaimable).toBe(true);
    expect(v.supervision).toBe("abandoned");
  });
});

describe("tryReclaimBridgePort against a foreign holder (#2030)", () => {
  it("TCP open + protocol probe fail → no kill, no prompt, message names the process as not ours", async () => {
    const { port, close } = await listenHttp200();
    try {
      expect(await probePanelOrchestrator(port, 400)).toBe(false);

      const kills: number[] = [];
      const prompts: string[] = [];
      const logs: string[] = [];
      const lockPath = join(mkdtempSync(join(tmpdir(), "cmcp-reclaim-")), "lock.json");
      writeFileSync(lockPath, JSON.stringify({ pid: 1, version: "0.1.0" }));

      const result = await tryReclaimBridgePort(
        { start: () => undefined, whenReady: async () => false },
        port,
        lockPath,
        {
          isTty: () => true,
          promptYesNo: async (q) => {
            prompts.push(q);
            return true;
          },
          killProcessTree: (pid) => {
            kills.push(pid);
          },
          log: {
            warn: (m) => logs.push(m),
            info: (m) => logs.push(m),
          },
        },
      );

      expect(result.bound).toBe(false);
      expect(result.ownership).toBe("not-ours");
      expect(result.prompted).toBe(false);
      expect(result.killed).toEqual([]);
      expect(kills).toEqual([]);
      expect(prompts).toEqual([]);
      const msg = logs.join("\n");
      expect(msg).toMatch(/does not speak the comfyui-mcp panel protocol/);
      expect(msg).toMatch(/not comfyui-mcp/);
      expect(msg).not.toMatch(/Stop it \(and its whole process tree\)/);
      expect(msg).toMatch(new RegExp(String(DEFAULT_PANEL_BRIDGE_PORT)));
      expect(msg).toMatch(/Logitech G HUB/);
    } finally {
      await close();
    }
  });

  it("probe fail + no pid: still not-ours; bind-fail advice has no taskkill (#2030)", async () => {
    // netstat/lsof miss (timeout, no lsof): bind already lost, protocol failed.
    // Restoring `if (!pid) unclassifiedOwnership()` must go red — unclassified
    // used to fall through to the taskkill one-liner.
    const lockPath = join(mkdtempSync(join(tmpdir(), "cmcp-nopid-")), "missing.json");
    const assessment = await assessBridgeHolder(9199, lockPath, {
      probe: async () => false,
      pidListeningOnPort: () => null,
      processNameOf: () => "unknown",
      readLock: () => null,
      pidExists: () => false,
    });
    expect(assessment.pid).toBeNull();
    expect(assessment.speaksPanelProtocol).toBe(false);
    expect(assessment.ownership).toBe("not-ours");
    expect(assessment.reclaimable).toBe(false);

    const advice = bindFailureAdvice(9199, assessment);
    expect(advice).not.toMatch(/taskkill/i);
    expect(advice).not.toMatch(/kill -9/);
    expect(advice).toMatch(/not comfyui-mcp/);
    expect(advice).toContain("COMFYUI_MCP_BRIDGE_PORT");
    expect(advice).toContain(String(DEFAULT_PANEL_BRIDGE_PORT));

    const kills: number[] = [];
    const prompts: string[] = [];
    const logs: string[] = [];
    const result = await tryReclaimBridgePort(
      { start: () => undefined, whenReady: async () => false },
      9199,
      lockPath,
      {
        probe: async () => false,
        pidListeningOnPort: () => null,
        processNameOf: () => "unknown",
        readLock: () => null,
        pidExists: () => false,
        isTty: () => true,
        promptYesNo: async (q) => {
          prompts.push(q);
          return true;
        },
        killProcessTree: (pid) => {
          kills.push(pid);
        },
        log: {
          warn: (m) => logs.push(m),
          info: (m) => logs.push(m),
        },
      },
    );
    expect(result.ownership).toBe("not-ours");
    expect(result.prompted).toBe(false);
    expect(result.killed).toEqual([]);
    expect(kills).toEqual([]);
    expect(prompts).toEqual([]);
    expect(logs.join("\n")).not.toMatch(/taskkill/i);
    expect(logs.join("\n")).not.toMatch(/kill -9/);
  });

  it("assessBridgeHolder agrees: open TCP that is not the panel protocol is not-ours", async () => {
    const { port, close } = await listenHttp200();
    try {
      const assessment = await assessBridgeHolder(
        port,
        join(mkdtempSync(join(tmpdir(), "cmcp-assess-")), "missing.json"),
      );
      expect(assessment.speaksPanelProtocol).toBe(false);
      expect(assessment.ownership).toBe("not-ours");
      expect(assessment.reclaimable).toBe(false);
      expect(assessment.pid).not.toBeNull();
    } finally {
      await close();
    }
  });
});

describe("tryReclaimBridgePort against a protocol speaker", () => {
  it("still prompts and does not kill when the user declines", async () => {
    const kills: number[] = [];
    const prompts: string[] = [];
    const result = await tryReclaimBridgePort(
      { start: () => undefined, whenReady: async () => false },
      9199,
      join(mkdtempSync(join(tmpdir(), "cmcp-ours-")), "lock.json"),
      {
        probe: async () => true,
        pidListeningOnPort: () => 4242,
        processNameOf: () => "node.exe",
        readLock: () => ({ pid: 4242, version: "0.52.0" }),
        pidExists: () => true,
        isTty: () => true,
        promptYesNo: async (q) => {
          prompts.push(q);
          return false;
        },
        killProcessTree: (pid) => {
          kills.push(pid);
        },
        log: { warn: () => undefined, info: () => undefined },
      },
    );
    expect(result.ownership).toBe("ours");
    expect(result.prompted).toBe(true);
    expect(prompts.length).toBe(1);
    expect(kills).toEqual([]);
    expect(result.bound).toBe(false);
  });
});

describe("foreignBridgeHolderAdvice", () => {
  it("names the process, refuses to kill it, and points at the override / new default", () => {
    const msg = foreignBridgeHolderAdvice(LEGACY_PANEL_BRIDGE_PORT, "lghub_agent.exe");
    expect(msg).toContain("lghub_agent.exe");
    expect(msg).toMatch(/not comfyui-mcp/);
    expect(msg).toMatch(/will not stop it/);
    expect(msg).toContain("COMFYUI_MCP_BRIDGE_PORT");
    expect(msg).toContain(String(DEFAULT_PANEL_BRIDGE_PORT));
    expect(msg).toMatch(/Logitech G HUB/);
  });
});

describe("bindFailureAdvice (#2030)", () => {
  it("prints taskkill only for a definite ours", () => {
    const ours = bindFailureAdvice(9199, {
      ownership: classifyBridgeHolder({
        speaksPanelProtocol: true,
        lockfileOursOrStale: true,
      }).ownership,
      processName: "node.exe",
    });
    expect(ours).toMatch(/taskkill/i);

    const foreign = bindFailureAdvice(9180, {
      ownership: classifyBridgeHolder({
        speaksPanelProtocol: false,
        lockfileOursOrStale: true,
      }).ownership,
      processName: "lghub_agent.exe",
    });
    expect(foreign).not.toMatch(/taskkill/i);
    expect(foreign).not.toMatch(/kill -9/);

    const unconfirmed = bindFailureAdvice(9180, {
      ownership: unclassifiedOwnership(),
      processName: "unknown",
    });
    expect(unconfirmed).not.toMatch(/taskkill/i);
    expect(unconfirmed).not.toMatch(/kill -9/);
    expect(unconfirmed).toContain("COMFYUI_MCP_BRIDGE_PORT");
  });
});
