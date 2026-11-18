import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * #2031 — node_pack action:"scaffold" on a split install.
 *
 * The reporter's session had workspace_path ~/ComfyUI and code_path
 * ~/ComfyUI/ComfyUI. Scaffold wrote under the data workspace; after restart
 * the class was missing from /object_info; copying the pack into the checkout's
 * custom_nodes loaded it. Drive the same functions the node_pack handler
 * threads (resolveCustomNodesScanBaseLive → scaffoldCustomNode) against real
 * temp trees — no mock of the resolver, no reimplementation of the scan rule.
 */

const h = vi.hoisted(() => ({
  mockConfig: {
    comfyuiPath: undefined as string | undefined,
    comfyuiCodePath: undefined as string | undefined,
    resolvedPort: 8188,
  },
  mockGetSystemStats: vi.fn(),
  remoteMode: { value: false },
}));

vi.mock("../../config.js", () => ({
  config: h.mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  isRemoteMode: () => h.remoteMode.value,
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: () => h.mockGetSystemStats(),
}));

vi.mock("../../services/live-interpreter.js", () => ({
  resolveLiveInterpreter: () => undefined,
  observeLiveServerProcess: () => undefined,
}));

import { scaffoldCustomNode } from "../../services/node-authoring.js";
import { resolveCustomNodesScanBaseLive } from "../../services/workspace-env.js";

async function tmpDir(): Promise<string> {
  // Canonical from the start: the live root is realpath'd (ComfyUI anchors on
  // realpath(__file__)), so on a host whose temp dir is an alias (macOS /var →
  // /private/var) every expected path must be spelled the same way. Alias handling
  // itself is covered by the tests that build an explicit symlink/junction/script.
  return realpathSync(await mkdtemp(join(tmpdir(), "comfyui-pack-split-")));
}

beforeEach(() => {
  h.mockConfig.comfyuiPath = undefined;
  h.mockConfig.comfyuiCodePath = undefined;
  h.remoteMode.value = false;
  h.mockGetSystemStats.mockReset();
});

afterEach(async () => {
  h.mockGetSystemStats.mockReset();
});

describe("node_pack scaffold scan root on a split install (#2031)", () => {
  it("writes the pack under the live checkout custom_nodes, not the data workspace", async () => {
    const dir = await tmpDir();
    try {
      const workspace = join(dir, "ComfyUI");
      const code = join(workspace, "ComfyUI");
      await mkdir(join(workspace, "custom_nodes"), { recursive: true });
      await mkdir(join(code, "custom_nodes"), { recursive: true });
      await writeFile(join(code, "main.py"), "", "utf-8");

      h.mockConfig.comfyuiPath = workspace;
      h.mockConfig.comfyuiCodePath = code;
      h.mockGetSystemStats.mockResolvedValue({
        system: { argv: [join(code, "main.py"), "--listen"] },
      });

      const base = await resolveCustomNodesScanBaseLive();
      const res = scaffoldCustomNode(
        { name: "h3-indexed-text-slots", displayName: "H3 Indexed Text Slots" },
        undefined,
        base,
      );

      const scanned = resolve(join(code, "custom_nodes"), "h3-indexed-text-slots");
      const unscanned = resolve(join(workspace, "custom_nodes"), "h3-indexed-text-slots");
      expect(res.path).toBe(scanned);
      expect(existsSync(join(scanned, "__init__.py"))).toBe(true);
      expect(existsSync(unscanned)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still writes under --base-directory when the runtime reports one (#1770)", async () => {
    const dir = await tmpDir();
    try {
      const workspace = join(dir, "user-data");
      const code = join(dir, "install", "ComfyUI");
      await mkdir(join(workspace, "custom_nodes"), { recursive: true });
      await mkdir(join(code, "custom_nodes"), { recursive: true });
      await writeFile(join(code, "main.py"), "", "utf-8");

      h.mockConfig.comfyuiPath = workspace;
      h.mockGetSystemStats.mockResolvedValue({
        system: {
          argv: [join(code, "main.py"), "--base-directory", workspace],
        },
      });

      const base = await resolveCustomNodesScanBaseLive();
      const res = scaffoldCustomNode(
        { name: "desktop-pack", displayName: "Desktop Pack" },
        undefined,
        base,
      );

      const scanned = resolve(join(workspace, "custom_nodes"), "desktop-pack");
      const checkout = resolve(join(code, "custom_nodes"), "desktop-pack");
      expect(res.path).toBe(scanned);
      expect(existsSync(join(scanned, "__init__.py"))).toBe(true);
      expect(existsSync(checkout)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
