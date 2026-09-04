import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeHelloRetarget, canonComfyuiTargetUrl, comfyuiOriginKey } from "../../services/hello-retarget.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// #756 (local ComfyUI misclassified as remote after a restart) + the #303
// zombie-tab guard + the codex-gate trust model: hello.comfyui_url is
// page-JS-WRITABLE (spoofable by a stale/confused tab), so a retarget is
// trusted ONLY when the tab's server-observed WebSocket handshake Origin —
// which the browser sets and page JS cannot forge — corroborates the claim.
// Untrusted claims are probed and may apply on EVIDENCE (a live instance),
// but never on trust alone: no no-probe shortcut and no #756 both-dead
// recovery. The /system_stats probe is injected, so "unreachable" is a probe
// resolving false — no real I/O, no timing dependence.

/** A probe that answers true only for the listed reachable base URLs. */
function probeFor(...reachableBases: string[]) {
  const reachable = new Set(reachableBases.map((b) => `${b.replace(/\/+$/, "")}/system_stats`));
  return vi.fn(async (systemStatsUrl: string) => reachable.has(systemStatsUrl));
}

const LOCAL = "http://127.0.0.1:8188";
const POD = "https://abc123-3000.proxy.runpod.net";

describe("judgeHelloRetarget — origin-trusted claims (#756 restart window)", () => {
  it("APPLIES a local hello that races the ComfyUI restart window when the current (stale remote) target is dead too", async () => {
    // The orchestrator is pinned to a stale RunPod target; the local panel
    // reconnects while the local ComfyUI is still booting — BOTH probes read
    // dead, but the tab's handshake origin PROVES it fronts the local
    // instance it claims. Pre-#756 the veto dropped this hello and pinned
    // remote forever.
    const probe = probeFor(); // nothing answers — the restart window
    const verdict = await judgeHelloRetarget({
      helloUrl: LOCAL,
      currentUrl: POD,
      observedOrigin: LOCAL,
      probe,
    });
    expect(verdict.apply).toBe(true);
    expect(verdict.reason).toBe("current-also-unreachable");
    expect(verdict.trusted).toBe(true);
    expect(verdict.base).toBe(LOCAL);
    expect(probe).toHaveBeenCalledWith(`${LOCAL}/system_stats`);
    expect(probe).toHaveBeenCalledWith(`${POD}/system_stats`);
  });

  it("restart → reconnect → local ref resolution + Manager probing recover (composed with the real config)", async () => {
    // Boot the shared config ON a stale pod target (remote), then apply the
    // hello verdict through the same setComfyuiTarget the orchestrator calls:
    // the classification must return to LOCAL and the base URL every tool
    // (train refs, Manager v4 queue probing) derives must be the local one.
    vi.resetModules();
    const OLD_ENV = process.env;
    process.env = { ...OLD_ENV };
    try {
      const fakeHome = mkdtempSync(join(tmpdir(), "hello-retarget-home-"));
      process.env.COMFYUI_MCP_LOCAL_TARGET_FILE = join(fakeHome, "local-target.json");
      process.env.COMFYUI_API_KEY = "";
      process.env.COMFYUI_PATH = "";
      process.env.COMFYUI_HOST = "";
      process.env.COMFYUI_PORT = "8188";
      process.env.COMFYUI_MCP_FORCE_REMOTE = "";
      process.env.COMFYUI_URL = POD;
      const mod = await import("../../config.js");
      expect(mod.isRemoteMode()).toBe(true); // genuinely-remote config classifies remote

      const probe = probeFor(); // restart window: local ComfyUI still booting
      const verdict = await judgeHelloRetarget({
        helloUrl: LOCAL,
        currentUrl: mod.getComfyUIBaseUrl(),
        observedOrigin: LOCAL,
        probe,
      });
      expect(verdict.apply).toBe(true);
      expect(verdict.reason).toBe("current-also-unreachable");

      expect(mod.setComfyuiTarget(verdict.base!)).toBe(true);
      // Local classification holds after the retarget: train refs resolve
      // locally (isRemoteMode() gates "ref items need a LOCAL ComfyUI")…
      expect(mod.isRemoteMode()).toBe(false);
      expect(mod.isLocalMode()).toBe(true);
      // …and Manager's queue probing (managerBaseUrl() = getComfyUIBaseUrl())
      // targets the reconnected local server, not the dead remote.
      expect(mod.getComfyUIBaseUrl()).toBe(LOCAL);
    } finally {
      process.env = OLD_ENV;
    }
  });

  it("VETOES a dead hello while the current target is healthy (#303 zombie-tab guard preserved)", async () => {
    // The zombie tab's observed origin IS the corpse it fronts — trust does
    // not save it: its instance is dead and the current target is healthy.
    const probe = probeFor(LOCAL); // current answers, corpse doesn't
    const verdict = await judgeHelloRetarget({
      helloUrl: "http://127.0.0.1:8189",
      currentUrl: LOCAL,
      observedOrigin: "http://127.0.0.1:8189",
      probe,
    });
    expect(verdict.apply).toBe(false);
    expect(verdict.reason).toBe("vetoed-unreachable");
    expect(verdict.trusted).toBe(true);
    expect(probe).toHaveBeenCalledWith("http://127.0.0.1:8189/system_stats");
    expect(probe).toHaveBeenCalledWith(`${LOCAL}/system_stats`);
  });

  it("a transiently-unreachable REMOTE hello does not flip a healthy LOCAL target (#303, remote direction)", async () => {
    const probe = probeFor(LOCAL);
    const verdict = await judgeHelloRetarget({
      helloUrl: "http://comfy.example-vps.com:8188",
      currentUrl: LOCAL,
      observedOrigin: "http://comfy.example-vps.com:8188",
      probe,
    });
    expect(verdict.apply).toBe(false);
    expect(verdict.reason).toBe("vetoed-unreachable");
  });

  it("a transiently-unreachable LOCAL hello does not flip a healthy REMOTE target (genuinely-remote stays remote)", async () => {
    const probe = probeFor("http://192.168.1.50:8188");
    const verdict = await judgeHelloRetarget({
      helloUrl: LOCAL,
      currentUrl: "http://192.168.1.50:8188",
      observedOrigin: LOCAL,
      probe,
    });
    expect(verdict.apply).toBe(false);
    expect(verdict.reason).toBe("vetoed-unreachable");
  });

  it("APPLIES a healthy hello without probing the current target", async () => {
    const probe = probeFor("http://192.168.1.50:8188");
    const verdict = await judgeHelloRetarget({
      helloUrl: "http://192.168.1.50:8188",
      currentUrl: LOCAL,
      observedOrigin: "http://192.168.1.50:8188",
      probe,
    });
    expect(verdict.apply).toBe(true);
    expect(verdict.reason).toBe("healthy");
    expect(verdict.trusted).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith("http://192.168.1.50:8188/system_stats");
  });

  it("APPLIES a RunPod proxy hello WITHOUT probing when the tab provably fronts the pod (#303)", async () => {
    const probe = probeFor();
    const verdict = await judgeHelloRetarget({
      helloUrl: POD,
      currentUrl: LOCAL,
      observedOrigin: POD,
      probe,
    });
    expect(verdict.apply).toBe(true);
    expect(verdict.reason).toBe("runpod-proxy");
    expect(verdict.trusted).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("a same-target hello is a no-op APPLY and is NEVER probed (no restart-window stall)", async () => {
    const probe = probeFor();
    const verdict = await judgeHelloRetarget({
      helloUrl: `${LOCAL}/`,
      currentUrl: LOCAL,
      observedOrigin: LOCAL,
      probe,
    });
    expect(verdict.apply).toBe(true);
    expect(verdict.reason).toBe("same-target");
    expect(verdict.trusted).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects a non-string hello URL without probing", async () => {
    const probe = probeFor();
    const verdict = await judgeHelloRetarget({
      helloUrl: undefined,
      currentUrl: LOCAL,
      observedOrigin: LOCAL,
      probe,
    });
    expect(verdict.apply).toBe(false);
    expect(verdict.reason).toBe("not-a-url");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("judgeHelloRetarget — UNTRUSTED claims (spoofable hello.comfyui_url, codex gate)", () => {
  it("claimed != observed origin and BOTH probes dead → REFUSES (never retargets on trust alone)", async () => {
    // A stale/confused tab CLAIMS the local instance while its handshake
    // origin says it fronts something else entirely. Both instances read
    // dead — the #756 recovery must NOT fire on an uncorroborated claim.
    const probe = probeFor();
    const verdict = await judgeHelloRetarget({
      helloUrl: LOCAL,
      currentUrl: POD,
      observedOrigin: "http://192.168.1.99:8188",
      probe,
    });
    expect(verdict.apply).toBe(false);
    expect(verdict.reason).toBe("vetoed-untrusted");
    expect(verdict.trusted).toBe(false);
    // The claimed URL was probed (evidence sought); the current target was
    // NOT — the both-dead recovery is reserved for trusted claims.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(`${LOCAL}/system_stats`);
  });

  it("claimed != observed origin but the claimed instance is HEALTHY → applies on evidence", async () => {
    const probe = probeFor(LOCAL);
    const verdict = await judgeHelloRetarget({
      helloUrl: LOCAL,
      currentUrl: POD,
      observedOrigin: "http://192.168.1.99:8188",
      probe,
    });
    expect(verdict.apply).toBe(true);
    expect(verdict.reason).toBe("healthy-untrusted");
    expect(verdict.trusted).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("an ABSENT observed origin (relay/headless client) is untrusted: dead claim refuses, live claim applies on evidence", async () => {
    const dead = probeFor();
    const refused = await judgeHelloRetarget({
      helloUrl: LOCAL,
      currentUrl: POD,
      observedOrigin: undefined,
      probe: dead,
    });
    expect(refused.apply).toBe(false);
    expect(refused.reason).toBe("vetoed-untrusted");
    expect(refused.trusted).toBe(false);

    const live = probeFor(LOCAL);
    const applied = await judgeHelloRetarget({
      helloUrl: LOCAL,
      currentUrl: POD,
      observedOrigin: undefined,
      probe: live,
    });
    expect(applied.apply).toBe(true);
    expect(applied.reason).toBe("healthy-untrusted");
  });

  it("a RunPod claim whose origin does NOT corroborate it is probed like any other claim", async () => {
    // The unprobed proxy skip is trust-gated: a tab fronting a LOCAL instance
    // cannot name a dead pod and have it applied sight-unseen.
    const probe = probeFor();
    const verdict = await judgeHelloRetarget({
      helloUrl: POD,
      currentUrl: LOCAL,
      observedOrigin: LOCAL,
      probe,
    });
    expect(verdict.apply).toBe(false);
    expect(verdict.reason).toBe("vetoed-untrusted");
    expect(probe).toHaveBeenCalledWith(`${POD}/system_stats`);
  });

  it("the same-target no-probe shortcut compares the OBSERVED origin, not the claim", async () => {
    // Claimed URL == current target, but the tab's origin says it fronts a
    // DIFFERENT instance: the no-probe shortcut must NOT fire — the claim is
    // probed instead. (Applying would be a no-op either way; the point is the
    // shortcut's trust key, which later paths rely on.)
    const probe = probeFor(LOCAL); // claimed == current answers
    const verdict = await judgeHelloRetarget({
      helloUrl: LOCAL,
      currentUrl: LOCAL,
      observedOrigin: "http://127.0.0.1:8189",
      probe,
    });
    expect(verdict.apply).toBe(true);
    expect(verdict.reason).toBe("healthy-untrusted"); // NOT "same-target"
    expect(verdict.trusted).toBe(false);
    expect(probe).toHaveBeenCalledWith(`${LOCAL}/system_stats`);
  });

  it("a same-target claim with a mismatched origin and a DEAD instance refuses (fail closed)", async () => {
    const probe = probeFor(); // restart window — nothing answers
    const verdict = await judgeHelloRetarget({
      helloUrl: LOCAL,
      currentUrl: LOCAL,
      observedOrigin: "http://127.0.0.1:8189",
      probe,
    });
    expect(verdict.apply).toBe(false);
    expect(verdict.reason).toBe("vetoed-untrusted");
  });
});

describe("comfyuiOriginKey", () => {
  it("canonicalizes loopback families (v4 → 127.0.0.1, v6 → ::1) with explicit default ports", () => {
    expect(comfyuiOriginKey("http://0.0.0.0:8188/path")).toBe("http://127.0.0.1:8188");
    expect(comfyuiOriginKey("http://[::1]:8188")).toBe("http://::1:8188");
    expect(comfyuiOriginKey("https://example.com/")).toBe("https://example.com:443");
    expect(comfyuiOriginKey("http://example.com")).toBe("http://example.com:80");
  });

  it("ignores the path (the WS handshake Origin carries none) and keeps families distinct", () => {
    expect(comfyuiOriginKey("http://127.0.0.1:8188/comfy")).toBe(comfyuiOriginKey("http://127.0.0.1:8188"));
    expect(comfyuiOriginKey("http://[::1]:8188")).not.toBe(comfyuiOriginKey("http://127.0.0.1:8188"));
    // `localhost` is DNS-ambiguous — deliberately NOT family-canonicalized.
    expect(comfyuiOriginKey("http://localhost:8188")).toBe("http://localhost:8188");
  });

  it("returns null for unparseable input", () => {
    expect(comfyuiOriginKey("not a url")).toBeNull();
  });
});

describe("canonComfyuiTargetUrl", () => {
  it("strips the scheme's default port only (http:443 and http:80 are NOT the same endpoint)", () => {
    // Trailing slashes (including the root "/") are stripped by the canon.
    expect(canonComfyuiTargetUrl("http://example.com:80/")).toBe("http://example.com");
    expect(canonComfyuiTargetUrl("https://example.com:443/")).toBe("https://example.com");
    expect(canonComfyuiTargetUrl("http://example.com:443/")).toBe("http://example.com:443");
    expect(canonComfyuiTargetUrl("https://example.com:80/")).toBe("https://example.com:80");
  });

  it("strips trailing slashes and tolerates unparseable input", () => {
    expect(canonComfyuiTargetUrl("http://127.0.0.1:8188///")).toBe("http://127.0.0.1:8188");
    expect(canonComfyuiTargetUrl("not a url//")).toBe("not a url");
  });
});

describe("#2742 a hello that names NO url is not reported as a dead instance", () => {
  // The verdict layer already returns `not-a-url` with no `base` (asserted above).
  // The defect was one layer up: index.ts logged every non-applying verdict with the
  // same sentence, so this one rendered as
  //
  //   ignoring hello retarget to unreachable undefined (stale tab on a dead instance?)
  //
  // which asserts a target was named AND that it was found dead, about a frame that
  // claimed neither. The reporter saw it 17 times from tabs that were merely churning.
  //
  // Pinned as source because the handler is a closure inside the orchestrator's
  // connection wiring and cannot be driven from a unit test.
  const src = readFileSync(
    fileURLToPath(new URL("../../orchestrator/index.ts", import.meta.url)),
    "utf8",
  );

  it("returns before the shared warning, rather than falling into it", () => {
    const guard = src.indexOf('verdict.reason === "not-a-url"');
    const warn = src.indexOf("ignoring hello retarget to unreachable");
    expect(guard).toBeGreaterThan(-1);
    expect(warn).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(warn);
    // And it must actually leave — a log without a return still reaches the warning.
    expect(src.slice(guard, warn)).toContain("return;");
  });

  it("says only what is true: no url was carried", () => {
    const guard = src.indexOf('verdict.reason === "not-a-url"');
    const block = src.slice(guard, guard + 400);
    expect(block).toContain("no usable comfyui_url");
    expect(block).not.toContain("stale tab");
    expect(block).not.toContain("unreachable");
  });
});
