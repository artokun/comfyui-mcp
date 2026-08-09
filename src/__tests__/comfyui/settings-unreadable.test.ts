// #796 again: an UNREADABLE settings answer is not an empty one.
//
// getSettings() fell through to `{}` on any non-JSON body, and getSetting() was
// documented as folding "empty / null / 404 / PARSE-FAILURE" uniformly into
// "unset (frontend default applies)".
//
// The first three are things a ComfyUI build actually SAYS to mean unset. A
// non-empty body that is not JSON is something else answering — an auth proxy's
// sign-in page, an API gateway's error envelope, a different service on the host.
// This repo meets that responder constantly (#828/#952/#954), and the settings
// path was the one place that read it as an answer.
//
// What the caller saw:
//   get_defaults action:"get_ui"          → count: 0, "only explicitly-stored
//                                            settings appear here" — i.e. "you
//                                            have none", from a body nobody parsed
//   get_defaults action:"get_ui" id:X     → value: null, "unset (frontend default
//                                            applies)"
//   get_defaults action:"set_ui"          → previous: null — so a user who then
//                                            set a value was told the old one was
//                                            unset, and could not restore it.
//
// The fix routes both through the guard the file already imported for every other
// JSON endpoint (readComfyJson / classifyNonJson), which names the URL and the
// responder and scrubs secret-shaped text.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isCloudMode: () => false, getComfyUIApiHost: () => "127.0.0.1:8188" };
});

const fetchApi = vi.fn();
vi.mock("@stable-canvas/comfyui-client", () => ({
  Client: class {
    // #385 — call sites moved to `comfyApiFetch`, which reuses the library's
    // own routing (apiURL/apiHeaders) and its injected `fetch`, so it can read a
    // 4xx instead of having `fetchApi` throw it away. The double routes `fetch`
    // back through its own `fetchApi`, so every existing impl and spy in this
    // file keeps working and keeps asserting the same route.
    apiURL(p: string) {
      return p;
    }
    apiHeaders(init?: { headers?: unknown }) {
      return (init && init.headers) || {};
    }
    async fetch(u: string, init?: unknown) {
      return (this as unknown as { fetchApi: (u: string, i?: unknown) => unknown }).fetchApi(u, init);
    }
    fetchApi = fetchApi;
    close() {}
  },
}));

const { getSettings, getSetting } = await import("../../comfyui/client.js");

/** A Response-alike with just what the settings path reads. */
function reply(body: string, opts: { status?: number; contentType?: string } = {}) {
  return {
    status: opts.status ?? 200,
    ok: (opts.status ?? 200) < 400,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? opts.contentType ?? "application/json" : null) },
    text: async () => body,
  };
}

/** The classic culprit: a proxy sign-in page served where JSON was promised. */
const SIGN_IN_PAGE =
  "<!DOCTYPE html><html><head><title>Sign in</title></head><body><form>Please sign in</form></body></html>";

beforeEach(() => fetchApi.mockReset());
afterEach(() => vi.clearAllMocks());

describe("getSettings: an unparseable body is not 'no settings'", () => {
  it("throws instead of returning {} when a sign-in page answers", async () => {
    fetchApi.mockResolvedValue(reply(SIGN_IN_PAGE, { contentType: "text/html" }));

    await expect(getSettings()).rejects.toThrow();
    // The message must name the route and point at the responder, not the user's
    // settings — that is the whole difference from silently answering "none".
    await expect(getSettings()).rejects.toThrow(/\/settings/);
  });

  it("throws when the body parses but is not a settings map", async () => {
    // An API gateway's own JSON error envelope: valid JSON, wrong document. The
    // old truthiness check accepted ANY object, including an array.
    fetchApi.mockResolvedValue(reply(JSON.stringify(["nope"])));

    await expect(getSettings()).rejects.toThrow();
  });

  it("still returns the settings map on a normal answer", async () => {
    fetchApi.mockResolvedValue(reply(JSON.stringify({ "Comfy.Validation.Workflows": false })));

    await expect(getSettings()).resolves.toEqual({ "Comfy.Validation.Workflows": false });
  });
});

describe("getSetting: unset and unreadable are different answers", () => {
  // The three signals a real ComfyUI build uses for "unset" must still be unset —
  // this is the noise guard. Turning these into errors would make the tool throw
  // constantly on perfectly healthy installs.
  it("still reports UNSET for an empty body", async () => {
    fetchApi.mockResolvedValue(reply(""));
    await expect(getSetting("Comfy.Foo")).resolves.toBeUndefined();
  });

  it("still reports UNSET for a null body", async () => {
    fetchApi.mockResolvedValue(reply("null"));
    await expect(getSetting("Comfy.Foo")).resolves.toBeUndefined();
  });

  it("still reports UNSET for a 404 route", async () => {
    fetchApi.mockResolvedValue(reply("", { status: 404 }));
    await expect(getSetting("Comfy.Foo")).resolves.toBeUndefined();
  });

  it("THROWS for a non-empty unparseable body instead of claiming unset", async () => {
    fetchApi.mockResolvedValue(reply(SIGN_IN_PAGE, { contentType: "text/html" }));

    await expect(getSetting("Comfy.Foo")).rejects.toThrow();
  });

  it("passes a stored value through verbatim, uncoerced", async () => {
    // An older frontend stores booleans as strings; that must survive.
    fetchApi.mockResolvedValue(reply(JSON.stringify("true")));
    await expect(getSetting("Comfy.Foo")).resolves.toBe("true");

    fetchApi.mockResolvedValue(reply(JSON.stringify(false)));
    await expect(getSetting("Comfy.Foo")).resolves.toBe(false);
  });
});
