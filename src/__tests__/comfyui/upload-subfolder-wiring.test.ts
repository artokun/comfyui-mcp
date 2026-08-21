// #946 — the WIRING half. `splitUploadTarget`'s own rules are pinned in
// upload-subfolder.test.ts; these prove `uploadImageHttp` actually USES it: the
// multipart filename carries the bare name and the subfolder rides in the form
// field ComfyUI's /upload/image reads. Without this, deleting the split at the
// call site breaks nothing visible.
//
// Also pins the second defect: a non-JSON body must not surface as a raw
// `Unexpected non-whitespace character after JSON at position 4`, which is
// exactly what the reporter got — a parser message in place of a diagnosis.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    isCloudMode: () => false,
    getComfyUIApiHost: () => "127.0.0.1:8188",
  };
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
    async fetch(u: string, init?: RequestInit) {
      return this.fetchApi(u, init);
    }
    fetchApi = fetchApi;
    close() {}
  },
}));

const { uploadImageHttp } = await import("../../comfyui/client.js");

/** The FormData the last upload sent. */
function sentForm(): FormData {
  const init = fetchApi.mock.calls.at(-1)?.[1] as { body?: unknown } | undefined;
  return init?.body as FormData;
}

const okJson = (obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => fetchApi.mockReset());
afterEach(() => vi.clearAllMocks());

describe("#946: uploadImageHttp sends the subfolder as its own field", () => {
  it("splits a path filename — bare name in the part, subfolder in the field", async () => {
    fetchApi.mockResolvedValue(okJson({ name: "clip.mp4", subfolder: "assets", type: "input" }));
    await uploadImageHttp("assets/clip.mp4", Buffer.from("x"), "video/mp4");

    const form = sentForm();
    expect(form.get("subfolder")).toBe("assets");
    // The multipart part's own filename must be the BARE name — sending the
    // whole path there is what produced the reported failure.
    const part = form.get("image") as File;
    expect(part.name).toBe("clip.mp4");
    expect(fetchApi.mock.calls.at(-1)?.[0]).toBe("/upload/image");
  });

  it("sends NO subfolder field for a plain filename (unchanged behaviour)", async () => {
    fetchApi.mockResolvedValue(okJson({ name: "clip.mp4", subfolder: "", type: "input" }));
    await uploadImageHttp("clip.mp4", Buffer.from("x"), "video/mp4");
    expect(sentForm().has("subfolder")).toBe(false);
    expect((sentForm().get("image") as File).name).toBe("clip.mp4");
  });

  it("refuses a traversal before anything is sent", async () => {
    await expect(uploadImageHttp("../escape.png", Buffer.from("x"))).rejects.toThrow(
      /walks outside/,
    );
    expect(fetchApi).not.toHaveBeenCalled();
  });
});

describe("#946: a non-JSON upload reply is diagnosed, not parsed at the caller", () => {
  it("does not surface a bare JSON parser message", async () => {
    // A proxy or a still-starting server answering 200 with HTML. The old
    // res.json() gave the reporter "Unexpected non-whitespace character after
    // JSON at position 4" and nothing else.
    fetchApi.mockResolvedValue(
      new Response("<!doctype html><html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const err = await uploadImageHttp("clip.mp4", Buffer.from("x")).catch((e: Error) => e);
    const msg = String((err as Error).message);
    expect(msg).not.toMatch(/Unexpected non-whitespace character/);
    expect(msg).not.toMatch(/Unexpected token/);
    // It names what was asked for instead.
    expect(msg).toMatch(/upload\/image/);
  });

  it("still rejects a JSON body of the wrong shape rather than returning it", async () => {
    fetchApi.mockResolvedValue(okJson({ error: "nope" }));
    await expect(uploadImageHttp("clip.mp4", Buffer.from("x"))).rejects.toThrow();
  });

  it("passes a well-formed reply straight through", async () => {
    fetchApi.mockResolvedValue(okJson({ name: "clip.mp4", subfolder: "assets", type: "input" }));
    await expect(uploadImageHttp("assets/clip.mp4", Buffer.from("x"))).resolves.toMatchObject({
      name: "clip.mp4",
      subfolder: "assets",
    });
  });
});
