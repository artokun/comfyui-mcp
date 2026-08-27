import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { probeOk } from "../../orchestrator/probe-ok.js";
import { judgeHelloRetarget } from "../../services/hello-retarget.js";
import * as cfg from "../../config.js";

const INDEX = readFileSync(
  fileURLToPath(new URL("../../orchestrator/index.ts", import.meta.url)),
  "utf8",
);
const PROBE_SRC = readFileSync(
  fileURLToPath(new URL("../../orchestrator/probe-ok.ts", import.meta.url)),
  "utf8",
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * #2425 — `probeOk` was a nested `const` arrow declared ~2000 lines BELOW the
 * hello-retarget path that closed over it. A hello arriving in that window
 * threw "Cannot access 'probeOk' before initialization". The process-level
 * handler swallowed it as an ignored unhandled rejection, so the retarget
 * silently did not happen.
 *
 * These tests drive the shipped probe (not a reimplementation) and fail if the
 * binding is a `const` sitting after the hello call — the ordering that TDZs.
 */
function extractAsyncFunction(src: string, name: string): string {
  const re = new RegExp(`(?:export\\s+)?async function ${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m || m.index === undefined) {
    throw new Error(`${name} is not an async function declaration in the shipped source`);
  }
  const brace = src.indexOf("{", m.index);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error(`${name} body is unclosed`);
}

/** Strip the one signature this function is pinned to so `new Function` can run it. */
function asJsDeclaration(tsFn: string): string {
  return tsFn
    .replace(/^export\s+/, "")
    .replace(/\(url: string, timeoutMs = 8_000\): Promise<boolean>/, "(url, timeoutMs = 8_000)");
}

function helloOrdering(declarationJs: string): (fetchImpl: typeof fetch, headers: () => Record<string, string>) => unknown {
  // Same order as the bug: the hello path builds `probe: (u) => probeOk(u, 3_000)`
  // and invokes it BEFORE source evaluation would reach a later `const`.
  return new Function(
    "fetch",
    "getComfyUIAuthHeaders",
    `"use strict";
     const probe = (u) => probeOk(u, 3_000);
     const pending = probe("http://example.test/system_stats");
     ${declarationJs}
     return pending;`,
  ) as (fetchImpl: typeof fetch, headers: () => Record<string, string>) => unknown;
}

describe("probeOk hoisting (#2425)", () => {
  it("is declared as a hoisted function, never a const arrow", () => {
    expect(PROBE_SRC).toMatch(/export async function probeOk\s*\(/);
    expect(PROBE_SRC).not.toMatch(/const\s+probeOk\s*=/);
    expect(INDEX).not.toMatch(/const\s+probeOk\s*=/);
    expect(INDEX).not.toMatch(/async function probeOk\s*\(/);
  });

  it("is still called from the hello-retarget path it was crashing on", () => {
    expect(INDEX).toMatch(/from "\.\/probe-ok\.js"/);
    expect(INDEX).toMatch(/probe:\s*\(u\)\s*=>\s*probeOk\(u,/);
    const importAt = INDEX.search(/import\s*\{[^}]*\bprobeOk\b[^}]*\}\s*from\s*"\.\/probe-ok\.js"/);
    const callAt = INDEX.search(/probe:\s*\(u\)\s*=>\s*probeOk\(u,/);
    expect(importAt, "hello must import probeOk, not close over a later nested binding").toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(importAt);
  });

  it("a hung or dead URL is false, not a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(probeOk("http://127.0.0.1:9/system_stats", 50)).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      ),
    );
    await expect(probeOk("http://127.0.0.1:9/system_stats", 30)).resolves.toBe(false);
  });

  it("returns true when the URL answers, and forwards configured auth headers", async () => {
    vi.spyOn(cfg, "getComfyUIAuthHeaders").mockReturnValue({ Authorization: "Bearer t" });
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer t");
      return { ok: true };
    });
    vi.stubGlobal("fetch", fetch);
    await expect(probeOk("http://127.0.0.1:8188/system_stats", 50)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("the hello-retarget path actually calls the shipped probe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: url.includes("8189") })),
    );
    const verdict = await judgeHelloRetarget({
      helloUrl: "http://127.0.0.1:8189",
      currentUrl: "http://127.0.0.1:8188",
      observedOrigin: "http://192.168.1.99:8188",
      probe: (u) => probeOk(u, 3_000),
    });
    expect(verdict.apply).toBe(true);
    expect(verdict.reason).toBe("healthy-untrusted");
  });

  it("the shipped declaration is callable before its source line; the const form TDZs", async () => {
    const tsFn = extractAsyncFunction(PROBE_SRC, "probeOk");
    const fnJs = asJsDeclaration(tsFn);
    const okFetch = (async () => ({ ok: true })) as unknown as typeof fetch;
    const headers = () => ({});

    await expect(helloOrdering(fnJs)(okFetch, headers)).resolves.toBe(true);

    const constJs = fnJs.replace(
      /^async function probeOk\s*\(([^)]*)\)\s*/,
      "const probeOk = async ($1) => ",
    );
    expect(constJs, "mutant must be the const-arrow form that shipped in 0.52.139").toMatch(
      /^const probeOk = async \(/,
    );
    expect(() => helloOrdering(constJs)(okFetch, headers)).toThrow(
      /Cannot access 'probeOk' before initialization/,
    );
  });
});
