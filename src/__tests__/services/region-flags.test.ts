// Network-restricted-region flags (issue #127): HF_ENDPOINT mirror rewriting
// and the CIVITAI_ENABLED=0 kill-switch. Adapted from the 1696762169 fork's
// patches (6a2bd96, a6441c0) — these tests pin OUR contract for them.

import { describe, expect, it, afterEach } from "vitest";
import {
  applyHfEndpoint,
  civitaiDisabled,
  CIVITAI_DISABLED_MESSAGE,
} from "../../services/model-resolver.js";

const REAL_HF = process.env.HF_ENDPOINT;
const REAL_CIV = process.env.CIVITAI_ENABLED;

afterEach(() => {
  if (REAL_HF === undefined) delete process.env.HF_ENDPOINT;
  else process.env.HF_ENDPOINT = REAL_HF;
  if (REAL_CIV === undefined) delete process.env.CIVITAI_ENABLED;
  else process.env.CIVITAI_ENABLED = REAL_CIV;
});

describe("applyHfEndpoint", () => {
  it("no-ops when HF_ENDPOINT is unset", () => {
    delete process.env.HF_ENDPOINT;
    const u = "https://huggingface.co/artokun/gemma4-comfyui-mcp/resolve/main/x.gguf";
    expect(applyHfEndpoint(u)).toBe(u);
  });

  it("rewrites the huggingface.co host, preserving path and query", () => {
    process.env.HF_ENDPOINT = "https://hf-mirror.com";
    expect(applyHfEndpoint("https://huggingface.co/api/models?search=flux")).toBe(
      "https://hf-mirror.com/api/models?search=flux",
    );
    expect(applyHfEndpoint("http://huggingface.co/repo/resolve/main/a.safetensors")).toBe(
      "https://hf-mirror.com/repo/resolve/main/a.safetensors",
    );
  });

  it("tolerates a trailing slash on the endpoint", () => {
    process.env.HF_ENDPOINT = "https://hf-mirror.com/";
    expect(applyHfEndpoint("https://huggingface.co/x")).toBe("https://hf-mirror.com/x");
  });

  it("does NOT rewrite lookalike hosts or non-HF URLs", () => {
    process.env.HF_ENDPOINT = "https://hf-mirror.com";
    const lookalike = "https://huggingface.co.evil.com/x";
    expect(applyHfEndpoint(lookalike)).toBe(lookalike);
    const civitai = "https://civitai.com/api/download/models/1";
    expect(applyHfEndpoint(civitai)).toBe(civitai);
  });

  it("ignores a non-http(s) endpoint value", () => {
    process.env.HF_ENDPOINT = "ftp://mirror";
    const u = "https://huggingface.co/x";
    expect(applyHfEndpoint(u)).toBe(u);
  });
});

describe("civitaiDisabled", () => {
  it("off by default and for truthy values", () => {
    delete process.env.CIVITAI_ENABLED;
    expect(civitaiDisabled()).toBe(false);
    process.env.CIVITAI_ENABLED = "1";
    expect(civitaiDisabled()).toBe(false);
    process.env.CIVITAI_ENABLED = "true";
    expect(civitaiDisabled()).toBe(false);
  });

  it("on for 0 / false / no (case-insensitive)", () => {
    for (const v of ["0", "false", "FALSE", "no"]) {
      process.env.CIVITAI_ENABLED = v;
      expect(civitaiDisabled(), `CIVITAI_ENABLED=${v}`).toBe(true);
    }
  });

  it("the user-facing message names the flag and the workaround", () => {
    expect(CIVITAI_DISABLED_MESSAGE).toContain("CIVITAI_ENABLED=0");
    expect(CIVITAI_DISABLED_MESSAGE).toContain("download_model");
  });
});
