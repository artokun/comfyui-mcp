// #2451 — create_workflow action:"node_info" vs a remote /object_info that
// answers HTTP 401 with an empty body.
//
// Repro: panel_refresh_nodes succeeded and panel_add_node could add
// RegionalMaskPromptPalette / RegionalMaskPromptEncode, but node_info with
// refresh:true failed because the headless connector's /object_info was a
// bodiless 401. That must not look like "the pack is missing" / "No nodes
// found matching". Drive the SHIPPED nodeInfo function (and the getObjectInfo
// path it calls), not a parallel checker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: "" },
  getComfyUIApiHost: () => "remote.example:8188",
  getComfyUIBasePath: () => "",
  getComfyUIBaseUrl: () => "http://remote.example:8188",
  getComfyUIAuthHeaders: () => ({}),
  isCloudMode: () => false,
  isRemoteMode: () => true,
}));

import {
  resetClient,
  resetObjectInfoCache,
  setLiveObjectInfoFallbackForTests,
} from "../../comfyui/client.js";
import { resetComfyApiRootValidated } from "../../comfyui/json-guard.js";
import type { ComfyUINodeDef, ObjectInfo } from "../../comfyui/types.js";
import { ComfyUIError } from "../../utils/errors.js";
import { nodeInfo } from "../../tools/workflow-compose.js";
import { fakeFetch } from "../helpers/fake-fetch.js";

function unauthorizedEmpty(): Response {
  return new Response(null, { status: 401, statusText: "Unauthorized" });
}

function serve401Empty(): void {
  vi.stubGlobal("fetch", fakeFetch(async () => unauthorizedEmpty()));
}

function regionalMaskDef(name: string): ComfyUINodeDef {
  return {
    input: {
      required: { text: ["STRING", {}] },
    },
    output: ["CONDITIONING"],
    output_is_list: [false],
    output_name: ["CONDITIONING"],
    name,
    display_name: name,
    description: `${name} live registry definition`,
    category: "regional_mask_prompt",
    output_node: false,
  };
}

function liveRegionalMaskRegistry(): ObjectInfo {
  return {
    RegionalMaskPromptPalette: regionalMaskDef("RegionalMaskPromptPalette"),
    RegionalMaskPromptEncode: regionalMaskDef("RegionalMaskPromptEncode"),
  };
}

function looksLikeAbsentNode(text: string): boolean {
  // The honest 401 text names the pack only to DENY that conclusion
  // ("not evidence that the node pack is missing"). That is not a claim
  // the pack is gone.
  if (/not evidence that the node pack is missing/i.test(text)) return false;
  return /No nodes found matching/i.test(text);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetClient();
  resetObjectInfoCache();
  resetComfyApiRootValidated();
  setLiveObjectInfoFallbackForTests(undefined);
});

afterEach(() => {
  setLiveObjectInfoFallbackForTests(undefined);
  vi.unstubAllGlobals();
});

describe('create_workflow nodeInfo behind a remote /object_info 401 (#2451)', () => {
  it("reports the live type when the panel registry already has it", async () => {
    serve401Empty();
    setLiveObjectInfoFallbackForTests(async () => liveRegionalMaskRegistry());

    const res = await nodeInfo("RegionalMaskPrompt", true, true);
    const text = res.content[0].text;

    expect(text).not.toMatch(/No nodes found matching/);
    expect(looksLikeAbsentNode(text)).toBe(false);
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toMatchObject({
      RegionalMaskPromptPalette: { name: "RegionalMaskPromptPalette" },
      RegionalMaskPromptEncode: { name: "RegionalMaskPromptEncode" },
    });
  });

  it("reports honest 401-auth, not a missing pack, when no live registry is available", async () => {
    serve401Empty();

    const err = await nodeInfo("RegionalMaskPrompt", false, true).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ComfyUIError);
    const failure = err as ComfyUIError;
    expect(failure.code).toBe("OBJECT_INFO_AUTH");
    expect(failure.message).toMatch(/401/);
    expect(failure.message).toMatch(/authentication failure/i);
    expect(failure.message).toMatch(/not evidence that the node pack is missing/i);
    expect(failure.message).toMatch(/EMPTY body/);
    expect(failure.message).toContain("/object_info");
    expect(failure.message).not.toMatch(/No nodes found matching/);
    expect(looksLikeAbsentNode(failure.message)).toBe(false);
  });

  it("does not turn 401+empty into 'No nodes found matching' for the shipped summary path", async () => {
    serve401Empty();

    await expect(nodeInfo("RegionalMaskPrompt", false, true)).rejects.toMatchObject({
      code: "OBJECT_INFO_AUTH",
    });
  });
});
