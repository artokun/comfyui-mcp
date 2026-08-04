// Local Desktop restart (issue #400): a LOCALLY-installed ComfyUI **Desktop**
// instance is Electron-supervised. restart_comfyui must NOT kill it and re-spawn
// the exe (that leaves it down — stopped:true, started:false after 60 probes).
// Instead it fires a ComfyUI-Manager HTTP reboot and polls readiness, exactly
// like the remote path. Everything runs through mocked comfyuiFetch + execSync +
// spawn; no real process/port/network is touched.

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  remoteMode: { value: false },
  fetchMock: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
  // argv that marks this as a Comfy Desktop install (see isDesktopApp()).
  getSystemStats: vi.fn(async () => ({
    system: {
      argv: [
        "C:\\Users\\x\\AppData\\Local\\Programs\\Comfy Desktop\\resources\\ComfyUI\\main.py",
        "--listen",
        "127.0.0.1",
        "--port",
        "8188",
      ],
    },
  })),
  execSync: vi.fn(() => ""),
  spawn: vi.fn(),
}));

vi.mock("../../config.js", () => ({
  config: { resolvedPort: 8188, comfyuiPath: "/fake/comfy", comfyuiBasePath: "" },
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  isRemoteMode: () => hoisted.remoteMode.value,
}));

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (url: string, init?: RequestInit) => hoisted.fetchMock(url, init),
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: hoisted.getSystemStats,
  resetClient: hoisted.resetClient,
  resetObjectInfoCache: hoisted.resetObjectInfoCache,
}));

vi.mock("node:child_process", () => ({
  execSync: hoisted.execSync,
  spawn: hoisted.spawn,
  execFile: vi.fn(),
}));

import {
  restartComfyUI,
  __processControlTestHooks,
} from "../../services/process-control.js";
import { __portOwnerTestHooks } from "../../services/port-owner.js";

/**
 * One `/proc/net/tcp` row for a socket LISTENING on `port`, in the kernel's own
 * format (hex big-endian address:port, state `0A` = TCP_LISTEN).
 *
 * On Linux the port probe consults this table BEFORE `lsof`, because it sees every
 * socket regardless of owner. That makes it the host's answer, not the fixture's —
 * so a test that does not state what the table says is graded against the runner's
 * real network state, where port 8188 is idle, and the execSync port fixtures below
 * are never reached at all (#776 CI). This file models the host it means to model:
 * a live Desktop instance IS listening on the port, and lsof then names its owner.
 */
function procNetTableWithListenerOn(port: number): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  return [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    `   0: 0100007F:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 54321 1 0000000000000000 100 0 0 10 0`,
    "",
  ].join("\n");
}

type FetchCall = [string, RequestInit | undefined];
const pathOf = (u: string): string => new URL(u).pathname;
const findCall = (pred: (path: string) => boolean): FetchCall | undefined =>
  (hoisted.fetchMock.mock.calls as FetchCall[]).find(([u]) => pred(pathOf(u)));

beforeEach(() => {
  hoisted.remoteMode.value = false;
  hoisted.fetchMock.mockReset();
  hoisted.resetClient.mockClear();
  hoisted.resetObjectInfoCache.mockClear();
  hoisted.getSystemStats.mockClear();
  hoisted.spawn.mockReset();
  hoisted.execSync.mockReset();
  // Map the running Desktop server's :8188 listener to a PID so gatherProcessInfo
  // resolves a live, Desktop-flagged instance — on either host platform.
  hoisted.execSync.mockImplementation((cmd: string) => {
    if (/netstat/i.test(cmd)) {
      return "  TCP    127.0.0.1:8188    0.0.0.0:0    LISTENING    4321\n";
    }
    // findPidByPort probes with `lsof -nP -iTCP:PORT -sTCP:LISTEN -Fpn`, whose
    // field output is p<pid> / n<addr:port> records — not the terse `-t` list.
    if (/lsof/i.test(cmd)) return "p4321\nn127.0.0.1:8188\n";
    return "";
  });
  // …and state the kernel table to match, so the Linux-first branch answers from
  // the fixture rather than from the runner's own sockets. `/proc/net/tcp6` is
  // absent here — one readable table is a complete answer.
  __portOwnerTestHooks.setProcNetReader((table) => {
    if (table === "/proc/net/tcp") return procNetTableWithListenerOn(8188);
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  __processControlTestHooks.reset();
  // The identity bracket around /system_stats (#776) runs for Desktop too — the
  // Desktop classification is itself derived from that same possibly-stale argv, so
  // it cannot be what decides whether to verify. It needs the port owner's creation
  // time at both ends; model the ordinary host where that is readable.
  // …and a LIVE Desktop shell above the backend (#814). A Manager reboot STOPS the
  // process and depends on that shell to start it again, so the restart now proves
  // the shell is there before dispatching anything. These tests are about what
  // happens AFTER the dispatch — the reboot firing, and above all that the instance
  // is never KILLED (#400) — so they must model the install they mean to model: an
  // ordinary Desktop with its supervisor running. The refusal path has its own tests.
  __processControlTestHooks.setProcessIdentityResolver((pid) => {
    if (pid === 300) {
      return {
        executablePath: "C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe",
        commandLine: '"C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe"',
        startedAt: "2000", // the shell predates the backend it spawned
      };
    }
    // A COMPARABLE stamp, not a placeholder: the supervisor check confirms the
    // parent link causally (a parent cannot have started after its child), so a
    // stamp that cannot be compared against the shell's leaves the link unverified.
    return { startedAt: "5000", parentPid: 300 };
  });
  __processControlTestHooks.setParentPidResolver((pid) => (pid === 4321 ? 300 : undefined));
  __processControlTestHooks.setProcessExistsProbe(() => true);
});

afterEach(() => {
  __portOwnerTestHooks.reset();
  __processControlTestHooks.reset();
});

describe("restartComfyUI — local Desktop (Manager reboot, never kill) [#400]", () => {
  it("reboots the Desktop instance via Manager and never kills/re-spawns it", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    let statsCalls = 0;
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") return new Response("", { status: 200 });
      if (path === "/system_stats") {
        statsCalls++;
        // First probe after firing: origin still going down. Then ready.
        if (statsCalls <= 1) throw new Error("fetch failed");
        return new Response(JSON.stringify({ system: {} }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.stopped).toBe(true);
    expect(res.started).toBe(true);
    expect(res.ready).toBe(true);
    expect(res.message).toContain("rebooted via ComfyUI-Manager");
    expect(res.message).toContain("Desktop/supervised");

    // The Manager reboot was fired.
    expect(findCall((p) => p === "/v2/manager/reboot")).toBeDefined();
    // Crucially: the Desktop app was NEVER killed or re-spawned.
    expect(hoisted.spawn).not.toHaveBeenCalled();
    const killed = hoisted.execSync.mock.calls.some(([c]: [string]) =>
      /taskkill|\bkill\b|pkill/i.test(c),
    );
    expect(killed).toBe(false);
    expect(hoisted.resetClient).toHaveBeenCalledTimes(1);
  });

  it("refuses without killing when the Manager reboot cannot be fired (403)", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 100,
      intervalMs: 5,
    });
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      if (pathOf(url).endsWith("/manager/reboot")) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response("", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.started).toBe(false);
    expect(res.stopped).toBe(false);
    expect(res.message).toContain("403");
    // Refusal must leave the Desktop instance running — no kill, no re-spawn.
    expect(hoisted.spawn).not.toHaveBeenCalled();
    const killed = hoisted.execSync.mock.calls.some(([c]: [string]) =>
      /taskkill|\bkill\b|pkill/i.test(c),
    );
    expect(killed).toBe(false);
    expect(hoisted.resetClient).not.toHaveBeenCalled();
  });
});
