// #1415 — the orchestrator→child half of the #952 drift comparison.
//
// The comparison itself already shipped and is already tested
// (fetch-failure-diagnostics.test.ts). What was missing is the transport: its
// source is injected from the bridge, which only exists in the orchestrator
// process, while every headless comfyui tool runs in a spawned stdio child. This
// file covers the small file channel that carries the set across.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PANEL_ORIGINS_FILE,
  publishConnectedPanelOrigins,
  readPublishedPanelOrigins,
  resetPublishedPanelOrigins,
} from "../../services/panel-origin-channel.js";
import { CONTROL_PREFIX, listTargetChangeRequests } from "../../services/download-progress.js";

let dir = "";
const savedEnv = process.env.COMFYUI_MCP_PROGRESS_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comfyui-mcp-origins-"));
  // The CHILD's view of the channel: the orchestrator hands it this dir in the
  // spawn env (buildComfyuiMcpEnv → COMFYUI_MCP_PROGRESS_DIR).
  process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
  resetPublishedPanelOrigins();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.COMFYUI_MCP_PROGRESS_DIR;
  else process.env.COMFYUI_MCP_PROGRESS_DIR = savedEnv;
  rmSync(dir, { recursive: true, force: true });
  resetPublishedPanelOrigins();
});

describe("panel-origin channel", () => {
  it("carries the origins the orchestrator published", () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    expect(readPublishedPanelOrigins()).toEqual(["http://127.0.0.1:8188"]);
  });

  // The direction that matters most: a stale claim is worse than no claim. The
  // publisher is level-triggered on the orchestrator's poll tick, so a tab that
  // disconnects blanks the file rather than leaving the child quoting a panel
  // that is gone.
  it("BLANKS when the last panel disconnects", () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    publishConnectedPanelOrigins(dir, []);
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("reads nothing when there is no channel — a plain MCP server", () => {
    delete process.env.COMFYUI_MCP_PROGRESS_DIR;
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("reads nothing when nothing has been published yet", () => {
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("reads nothing from a mid-write or corrupt file", () => {
    writeFileSync(join(dir, PANEL_ORIGINS_FILE), '{"origins": ["http://127.');
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("ignores a payload whose origins are not strings", () => {
    writeFileSync(join(dir, PANEL_ORIGINS_FILE), JSON.stringify({ origins: [1, null, "", "http://a:1"] }));
    expect(readPublishedPanelOrigins()).toEqual(["http://a:1"]);
  });

  it("survives an unwritable directory instead of throwing into the poll tick", () => {
    expect(() => publishConnectedPanelOrigins(join(dir, "nope", "\0bad"), ["http://a:1"])).not.toThrow();
  });

  it("does nothing at all without a dir", () => {
    publishConnectedPanelOrigins("", ["http://127.0.0.1:8188"]);
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  // This runs on a 700ms tick for the life of the orchestrator.
  it("writes only when the set changed", () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    const first = readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8");
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    expect(readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8")).toBe(first);
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8189"]);
    expect(readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8")).not.toBe(first);
  });
});

// The progress dir is shared with the download tray and the target-change
// control channel. This file must be invisible to both, and the only thing
// making that true is its name.
describe("the channel file cannot be mistaken for a download row or a request", () => {
  it("carries the control prefix pollDownloads filters on", () => {
    expect(PANEL_ORIGINS_FILE.startsWith(CONTROL_PREFIX)).toBe(true);
  });

  it("is not read as a pending target-change request", () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    expect(listTargetChangeRequests(dir)).toEqual([]);
  });
});
