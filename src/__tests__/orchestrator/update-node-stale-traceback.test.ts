// #1870 — panel_update_node reported a stale generation traceback as the
// Manager update failure.
//
// The reporter called panel_update_node(id:"fal-api", version:"nightly") after
// a ByteDance generation died with FalApiError HTTP 500. The pack is a Comfy
// Registry zip (no nested .git). Manager's do_update stored the generic
// sentence and logged `res.result=False, res.action=update-git`. The panel
// (#1320) then attached /internal/logs/raw as "Manager traceback:" — and the
// last traceback that named `fal-api` was the previous generation, not the
// update.
//
// These tests drive the SHIPPED panel_update_node handler. A helper-only suite
// would stay green if the handler never called it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const disk = vi.hoisted(() => ({ root: undefined as string | undefined }));
const mode = vi.hoisted(() => ({ remote: false }));

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, isRemoteMode: () => mode.remote };
});

vi.mock("../../services/workspace-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/workspace-env.js")>();
  return {
    ...actual,
    resolveEffectiveComfyUIBase: () => disk.root ?? actual.resolveEffectiveComfyUIBase(),
  };
});

const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const PACK = "fal-api";
const TAB = "11111111-2222-3333-4444-555555555555";

const FAL_TB = [
  "Traceback (most recent call last):",
  `  File "C:\\Users\\Artokun\\ComfyUI\\custom_nodes\\${PACK}\\nodes.py", line 88, in execute`,
  '    raise FalApiError("Downstream service error (HTTP 500)")',
  "FalApiError: Downstream service error (HTTP 500)",
].join("\n");

const UPDATE_GIT_LINE =
  `ERROR: An error occurred while updating '${PACK}'. (res.result=False, res.action=update-git)`;

const GENERIC = `An error occurred while updating '${PACK}'.`;

/** The reporter's exact panel failure, as ctx.call surfaces it (fail() prefix). */
function reportedFailure(traceback: string): string {
  return (
    `Error: Update of "${PACK}" FAILED: the ComfyUI-Manager task terminated with an ` +
    `error (dialect v2): ${GENERIC}. The pack was NOT updated. Manager traceback:\n` +
    traceback
  );
}

const REAL_MANAGER_TB = [
  "Traceback (most recent call last):",
  `  File "C:\\Users\\Artokun\\ComfyUI\\custom_nodes\\ComfyUI-Manager\\glob\\manager_core.py", line 2100, in repo_update`,
  "    remote.fetch()",
  "git.exc.GitCommandError: Cmd('git') failed due to: exit code(128)",
  "  cmdline: git fetch",
  UPDATE_GIT_LINE,
].join("\n");

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  return def;
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

function makeCtx(reply: ToolResult): { ctx: PanelToolCtx; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const ctx: PanelToolCtx = {
    call: async (cmd) => {
      calls.push(cmd);
      return reply;
    },
    confirm: async () => "yes" as const,
    tabId: TAB,
  };
  return { ctx, calls };
}

function zipPackRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cmcp-1870-"));
  mkdirSync(join(root, "custom_nodes", PACK), { recursive: true });
  writeFileSync(join(root, "custom_nodes", PACK, "__init__.py"), "# zip install\n");
  return root;
}

afterEach(() => {
  if (disk.root) {
    rmSync(disk.root, { recursive: true, force: true });
    disk.root = undefined;
  }
  mode.remote = false;
});

describe("#1870 panel_update_node does not attach a stale generation traceback", () => {
  it("THE REPORT: FalApiError is omitted; update-git is the Manager error", async () => {
    disk.root = zipPackRoot();
    const { ctx, calls } = makeCtx({
      content: [{ type: "text", text: reportedFailure(`${FAL_TB}\n${UPDATE_GIT_LINE}`) }],
      isError: true,
    });

    const res = await defByName("panel_update_node").handler(
      { id: PACK, version: "nightly" },
      ctx,
    );

    expect(calls[0]).toMatchObject({
      cmd: "graph_update_node",
      id: PACK,
      version: "nightly",
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/Update of "fal-api" FAILED/);
    expect(text).toMatch(/res\.action=update-git/);
    expect(text).toMatch(/res\.result=False/);
    expect(text).not.toMatch(/FalApiError/);
    expect(text).not.toMatch(/Downstream service error \(HTTP 500\)/);
    expect(text).toMatch(/execution history, not this Manager update/);
    expect(text).toMatch(/Comfy Registry zip/);
    expect(text).toMatch(/install_custom_node \(action:"reinstall"/);
    expect(text).toMatch(/panel_install_node/);
  });

  it("a generation traceback with no Manager evidence is dropped even without res.action", async () => {
    // The panel's fallback extractor attaches the last traceback that NAMES the
    // pack when it cannot find the generic ERROR line. That path still must not
    // label FalApiError as the Manager update.
    disk.root = zipPackRoot();
    const { ctx } = makeCtx({
      content: [{ type: "text", text: reportedFailure(FAL_TB) }],
      isError: true,
    });
    const res = await defByName("panel_update_node").handler(
      { id: PACK, version: "nightly" },
      ctx,
    );
    const text = textOf(res);
    expect(text).not.toMatch(/FalApiError/);
    expect(text).toMatch(/execution history, not this Manager update/);
    expect(text).toMatch(/Comfy Registry zip/);
    expect(text).not.toMatch(/Manager traceback:/);
  });

  it("a real Manager update traceback is kept (GitCommandError in repo_update)", async () => {
    const { ctx } = makeCtx({
      content: [{ type: "text", text: reportedFailure(REAL_MANAGER_TB) }],
      isError: true,
    });

    const res = await defByName("panel_update_node").handler({ id: PACK, version: "nightly" }, ctx);
    const text = textOf(res);
    expect(text).toMatch(/GitCommandError/);
    expect(text).toMatch(/repo_update/);
    expect(text).toMatch(/res\.action=update-git/);
    expect(text).not.toMatch(/execution history, not this Manager update/);
  });

  it("a successful update is not rewritten", async () => {
    const ok = {
      queued: true,
      updated: true,
      verified: true,
      id: PACK,
      note: "Update applied and VERIFIED by the ComfyUI-Manager task.",
    };
    const { ctx } = makeCtx({
      content: [{ type: "text", text: JSON.stringify(ok) }],
    });
    const res = await defByName("panel_update_node").handler({ id: PACK }, ctx);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe(JSON.stringify(ok));
  });

  it("an unrelated bridge failure is left alone", async () => {
    const raw = 'Error: no connected tab with id "dead". Connected: none';
    const { ctx } = makeCtx({
      content: [{ type: "text", text: raw }],
      isError: true,
    });
    const res = await defByName("panel_update_node").handler({ id: PACK }, ctx);
    expect(textOf(res)).toBe(raw);
  });

  it("does not claim a zip install when the disk could not be observed (remote)", async () => {
    mode.remote = true;
    const { ctx } = makeCtx({
      content: [{ type: "text", text: reportedFailure(`${FAL_TB}\n${UPDATE_GIT_LINE}`) }],
      isError: true,
    });
    const res = await defByName("panel_update_node").handler(
      { id: PACK, version: "nightly" },
      ctx,
    );
    const text = textOf(res);
    expect(text).not.toMatch(/FalApiError/);
    expect(text).toMatch(/res\.action=update-git/);
    expect(text).not.toMatch(/Comfy Registry zip/);
    expect(text).not.toMatch(/no nested \.git/);
  });

  it("does not re-route a git checkout as a zip", async () => {
    const root = zipPackRoot();
    mkdirSync(join(root, "custom_nodes", PACK, ".git"));
    disk.root = root;
    const { ctx } = makeCtx({
      content: [{ type: "text", text: reportedFailure(REAL_MANAGER_TB) }],
      isError: true,
    });
    const res = await defByName("panel_update_node").handler({ id: PACK, version: "nightly" }, ctx);
    expect(textOf(res)).not.toMatch(/Comfy Registry zip/);
    expect(textOf(res)).toMatch(/GitCommandError/);
  });
});

describe("#1888 reinstall note requires observed Manager evidence, not version", () => {
  // The sanitizer is sound; the defect is the gate. wantsNonGitReroute fired
  // on version==="nightly" alone, so a zip-installed pack got a reinstall NOTE
  // on every isError — including failures that never reached Manager.
  const DISCONNECTED = 'Error: no connected tab with id "dead". Connected: none';
  const REPLY_TIMEOUT =
    'Error: Panel tab tab-1 did not reply to "graph_update_node" within 30000 ms — the ComfyUI tab may be backgrounded or frozen\n\n' +
    'To retry this exact mutation, re-issue identical args plus retry_of:"11111111-2222-3333-4444-555555555555"; otherwise call normally.';

  it("THE REPORT: a disconnected-tab error with version nightly does not get the reinstall note", async () => {
    disk.root = zipPackRoot();
    const { ctx } = makeCtx({
      content: [{ type: "text", text: DISCONNECTED }],
      isError: true,
    });
    const res = await defByName("panel_update_node").handler(
      { id: PACK, version: "nightly" },
      ctx,
    );
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toBe(DISCONNECTED);
    expect(text).not.toMatch(/Comfy Registry zip/);
    expect(text).not.toMatch(/The pack was NOT git-updated/);
    expect(text).not.toMatch(/install_custom_node \(action:"reinstall"/);
  });

  it("a reply-timeout (outcome unknown) with version nightly does not get the reinstall note", async () => {
    disk.root = zipPackRoot();
    const { ctx } = makeCtx({
      content: [{ type: "text", text: REPLY_TIMEOUT }],
      isError: true,
    });
    const res = await defByName("panel_update_node").handler(
      { id: PACK, version: "nightly" },
      ctx,
    );
    const text = textOf(res);
    expect(text).toBe(REPLY_TIMEOUT);
    expect(text).toMatch(/retry_of:"11111111-2222-3333-4444-555555555555"/);
    expect(text).not.toMatch(/Comfy Registry zip/);
    expect(text).not.toMatch(/The pack was NOT git-updated/);
  });

  it("update-git evidence still re-routes a zip pack when version is not nightly", async () => {
    disk.root = zipPackRoot();
    const { ctx } = makeCtx({
      content: [{ type: "text", text: reportedFailure(`${FAL_TB}\n${UPDATE_GIT_LINE}`) }],
      isError: true,
    });
    const res = await defByName("panel_update_node").handler({ id: PACK }, ctx);
    const text = textOf(res);
    expect(text).toMatch(/res\.action=update-git/);
    expect(text).toMatch(/Comfy Registry zip/);
    expect(text).toMatch(/install_custom_node \(action:"reinstall"/);
    expect(text).not.toMatch(/FalApiError/);
  });

  it("the generic Manager update line still re-routes a zip pack without nightly or update-git", async () => {
    disk.root = zipPackRoot();
    const { ctx } = makeCtx({
      content: [{ type: "text", text: reportedFailure(FAL_TB) }],
      isError: true,
    });
    const res = await defByName("panel_update_node").handler({ id: PACK, version: "latest" }, ctx);
    const text = textOf(res);
    expect(text).toMatch(/An error occurred while updating 'fal-api'/);
    expect(text).toMatch(/Comfy Registry zip/);
    expect(text).not.toMatch(/FalApiError/);
    expect(text).not.toMatch(/res\.action=update-git/);
  });
});

describe("#1870 WIRING: the handler actually sanitizes", () => {
  it("panel_update_node calls sanitizePanelUpdateNodeResult on the panel reply", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../orchestrator/panel-tools.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /import \{ sanitizePanelUpdateNodeResult \} from "\.\.\/services\/manager-update-error\.js";/,
    );
    const start = src.search(/def\(\r?\n\s*"panel_update_node"/);
    expect(start).toBeGreaterThan(-1);
    const end = src.search(/def\(\r?\n\s*"panel_node_queue_status"/);
    expect(end).toBeGreaterThan(start);
    const handler = src.slice(start, end);
    expect(handler).toMatch(/sanitizePanelUpdateNodeResult\(res/);
    expect(handler).toMatch(/cmd: "graph_update_node"/);
  });
});
