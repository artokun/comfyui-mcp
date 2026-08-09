// #385 — every `if (!res.ok)` / `if (res.status === 404)` written after a
// `client.fetchApi(...)` call was DEAD CODE.
//
// `Client.fetchApi` throws for every status outside [200, 400), so it never
// returns a 4xx response and the branch never runs. The endpoint-specific
// answers behind those checks had therefore never executed once in production:
//
//   - `fetchImage`'s IMAGE_NOT_FOUND was added by #435 FOR THIS ISSUE, and is
//     the clearest case — a missing output file is the single most common /view
//     failure, and the curated message naming the file and the listing tool was
//     unreachable from the day it was written.
//   - `getSetting` treats a 404 as "unset (frontend default applies)" because
//     some ComfyUI builds 404 the per-id settings route. Those builds threw.
//   - `getSettings` has a curated version-drift error for a 404.
//   - `loadLockFromLibrary` treats a 404 as "no lock present" — the ORDINARY
//     case for an unlocked workflow.
//
// `comfyApiFetch` keeps the library's URL and header construction (api_base,
// clientId, comfy-user) and only declines to convert the response into an
// exception. These tests drive the REAL client through the REAL wiring, so
// reverting a call site to `client.fetchApi` fails them.

import { describe, expect, it, beforeEach, vi } from "vitest";

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
  comfyApiFetch,
  fetchImage,
  getSetting,
  getSettings,
  resetClient,
  setSetting,
  uploadImageHttp,
} from "../../comfyui/client.js";

/** Answer every request with one status/body. */
function answer(status: number, body: string | null, contentType?: string): void {
  global.fetch = vi.fn(async () => {
    const headers: Record<string, string> = {};
    if (contentType) headers["content-type"] = contentType;
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetClient();
});

describe("status branches after a ComfyUI API call are reachable (#385)", () => {
  it("fetchImage reports IMAGE_NOT_FOUND for a missing file", async () => {
    // The exact scenario #385 was filed for, and that #435 wrote the message for.
    answer(404, "not found", "text/plain");

    const err = await fetchImage("missing.png", "input").then(
      () => null,
      (e: unknown) => e,
    );

    expect((err as { code?: string }).code).toBe("IMAGE_NOT_FOUND");
    const message = (err as Error).message;
    // The whole point of the curated message: name the file, the directory, and
    // where to look next. A generic "something answered with non-JSON" does not.
    expect(message).toContain("missing.png");
    expect(message).toContain("input");
    expect(message).toContain('get_image (action:"list_outputs")');
    // And it must NOT be the parser message or the #828 fallback diagnosis.
    expect(message).not.toMatch(/Unexpected token|is not valid JSON/);
  });

  it("fetchImage still reports a non-404 status distinctly", async () => {
    answer(500, "boom", "text/plain");
    const err = await fetchImage("x.png").then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("VIEW_ERROR");
  });

  it("getSetting treats a 404 as unset rather than throwing", async () => {
    // Documented behaviour that could never happen: "some builds 404 the per-id
    // route, so empty / null / 404 are treated uniformly as unset".
    answer(404, null);
    await expect(getSetting("Comfy.ColorPalette")).resolves.toBeUndefined();
  });

  // Review finding 1 + the coverage hole it came through: the suite exercised
  // exactly ONE status on getSetting — 404 — so a non-404 falling through to
  // JSON.parse and being RETURNED AS THE VALUE sailed past a green run.
  it.each([
    ["403 with a gateway's JSON envelope", 403, '{"error":"forbidden","code":403}'],
    ["500 with an empty body", 500, ""],
    ["502 with a null body", 502, "null"],
  ])("getSetting THROWS on %s rather than reporting a value or 'unset'", async (_l, status, body) => {
    answer(status, body, "application/json");
    const err = await getSetting("Comfy.ColorPalette").then(
      (v) => ({ resolved: v }),
      (e: unknown) => e,
    );
    // Neither of the two wrong outputs: the envelope as the stored value, nor
    // `undefined`, which this function documents as "unset (frontend default
    // applies)" and which set_ui echoes back as `previous:`.
    expect(err).not.toHaveProperty("resolved");
    expect((err as { code?: string }).code).toBe("HTTP_ERROR");
    expect((err as Error).message).toMatch(/not a report that it is unset/);
  });

  it("setSetting does not print a reflected credential", async () => {
    // Review finding 2, reproduced: a gateway that echoes the request put our
    // own Authorization value into a tool result.
    answer(403, "invalid token: Bearer s3cr3t-token-value-abcdef for /settings", "text/plain");
    const err = await setSetting("Comfy.ColorPalette", "dark").then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).not.toContain("s3cr3t-token-value-abcdef");
    expect((err as Error).message).toContain("403");
  });

  it("getSettings reports the curated version-drift error on a 404", async () => {
    answer(404, null);
    await expect(getSettings()).rejects.toSatisfy(
      (e: unknown) => (e as { code?: string }).code === "SETTINGS_UNSUPPORTED",
    );
  });

  it("uploadImageHttp CLASSIFIES a rejected upload rather than dumping the body", async () => {
    // Making this branch reachable must not cost the #1160 diagnosis, and must
    // not print a raw body — a gateway that reflects the request can put our own
    // credential in it. So it classifies instead of interpolating.
    answer(413, "too large", "text/plain");
    const err = await uploadImageHttp("big.png", Buffer.from("x")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("NON_JSON_RESPONSE");
    expect((err as Error).message).toContain("/upload/image");
    expect((err as Error).message).toContain("413");
  });

  it("uploadImageHttp still names a sign-in gate on a 401 (#1160 must not regress)", async () => {
    // The regression this conversion nearly caused: with `!res.ok` reachable, a
    // hand-rolled "returned 401: <!DOCTYPE html>…" would have replaced the
    // diagnosis that says WHICH layer wants the credential.
    answer(
      401,
      '<!DOCTYPE html><html><head><title>Sign in</title></head><body><form action="/login"><input type="password" name="p"></form></body></html>',
      "text/html",
    );
    const err = await uploadImageHttp("cat.png", Buffer.from("x")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/SIGN-IN PAGE/);
    expect((err as Error).message).toMatch(/credential belongs to that GATEWAY/);
  });

  it("a 2xx still flows through untouched", async () => {
    // The conversion must be invisible when nothing is wrong.
    answer(200, JSON.stringify({ name: "cat.png", subfolder: "", type: "input" }), "application/json");
    await expect(uploadImageHttp("cat.png", Buffer.from("x"))).resolves.toEqual({
      name: "cat.png",
      subfolder: "",
      type: "input",
    });
  });
});

describe("comfyApiFetch keeps the library's routing", () => {
  it("returns the 4xx response instead of throwing", async () => {
    answer(404, "nope", "text/plain");
    const res = await comfyApiFetch("/anything");
    expect(res.status).toBe(404);
    await expect(res.text()).resolves.toBe("nope");
  });

  it("still adds the clientId the library would", async () => {
    // apiURL/apiHeaders are reused verbatim, so a proxied, prefixed or
    // multi-user target resolves exactly as it did through fetchApi. Losing
    // this would be a silent routing change on someone else's deployment.
    const seen: string[] = [];
    global.fetch = vi.fn(async (input: unknown) => {
      seen.push(String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await comfyApiFetch("/settings");
    expect(seen[0]).toContain("remote.example:8188");
    expect(seen[0]).toContain("clientId=comfyui-mcp");
  });
});
