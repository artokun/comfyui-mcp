import { afterEach, describe, expect, it } from "vitest";
import { fakeFetch, jsonResponse, targetUrl } from "./fake-fetch.js";

/**
 * The contract the comfyui tests lean on, and nothing more: the impl sees a string
 * target whatever the caller passed, the spy records real fetch calls, and the JSON
 * response is a genuine platform Response rather than a shape that resembles one.
 */
describe("fakeFetch", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("hands the impl the target as a string for a string, a URL and a Request", async () => {
    const seen: string[] = [];
    global.fetch = fakeFetch(async (url) => {
      seen.push(url);
      return new Response("");
    });
    await fetch("http://a.test/x");
    await fetch(new URL("http://b.test/y"));
    await fetch(new Request("http://c.test/z"));
    expect(seen).toEqual(["http://a.test/x", "http://b.test/y", "http://c.test/z"]);
  });

  it("forwards init untouched and records the call with fetch's own parameter types", async () => {
    const spy = fakeFetch(async () => new Response(""));
    global.fetch = spy;
    const init: RequestInit = { method: "POST", headers: { "x-probe": "1" } };
    await fetch("http://a.test/x", init);
    // Typed as `string | URL | Request` and `RequestInit | undefined` — the point of the
    // helper. A zero-arg `vi.fn()` records `[]` here and the index is a type error.
    const [input, recordedInit] = spy.mock.calls[0];
    expect(String(input)).toBe("http://a.test/x");
    expect(recordedInit).toBe(init);
  });

  it("propagates a rejection from the impl as fetch would", async () => {
    global.fetch = fakeFetch(async () => {
      throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" });
    });
    await expect(fetch("http://a.test/x")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

describe("targetUrl", () => {
  it("uses a Request's url rather than its [object Request] string form", () => {
    expect(targetUrl(new Request("http://c.test/z?q=1"))).toBe("http://c.test/z?q=1");
    expect(targetUrl(new URL("http://b.test/y"))).toBe("http://b.test/y");
    expect(targetUrl("relative/path")).toBe("relative/path");
  });
});

describe("jsonResponse", () => {
  it("is a real Response: ok, 200, application/json, and a body that parses back", async () => {
    const res = jsonResponse({ prompt_id: "p-1", number: 3 });
    expect(res).toBeInstanceOf(Response);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    await expect(res.json()).resolves.toEqual({ prompt_id: "p-1", number: 3 });
  });

  it("keeps the caller's status, statusText and headers, adding content-type only when absent", () => {
    const res = jsonResponse({ error: "nope" }, {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "text/plain", "x-served-by": "proxy" },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    expect(res.statusText).toBe("Bad Gateway");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("x-served-by")).toBe("proxy");
  });

  it("has a single-use body like the platform's — reading twice is an error, not a quiet repeat", async () => {
    // This is the one behaviour a `{ json: async () => body }` literal got wrong, and
    // the reason a real Response is the more honest double.
    const res = jsonResponse({});
    await res.text();
    await expect(res.text()).rejects.toThrow();
  });
});
