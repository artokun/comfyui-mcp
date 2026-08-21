import { vi, type Mock } from "vitest";

/**
 * Typed doubles for `global.fetch` and the Response it resolves.
 *
 * ## Why these exist
 *
 * Almost every test under `src/__tests__/comfyui` replaces `global.fetch`, and until
 * the anti-slop pilot every one of them did it the same way:
 *
 *     global.fetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
 *
 * The double cast was cargo-culted from one file to the next. It is NOT needed for a
 * zero-argument impl — `Mock<() => Promise<Response>>` is assignable to `typeof fetch`
 * as it stands — and where it WAS needed it was hiding a lie: a spy declared with no
 * parameters records its calls as `[]`, so `spy.mock.calls[0][0]` is a type error that
 * the cast kept the compiler from ever reporting (system-stats-non-json.test.ts, #101 of
 * the pilot). Vitest strips types without checking them, so nothing else would have.
 *
 * `fakeFetch` gives a test a spy whose recorded calls carry the real `fetch` parameter
 * types, while letting the impl be written against the one thing tests actually look
 * at — the request target as a string. The `string | URL | Request` union is the
 * REAL fetch contract, and the impl signature narrowing it to `string` is exactly what
 * made the casts necessary in the first place (parameter contravariance: an impl that
 * accepts only `string` is not a `fetch`). So the widening happens HERE, once, with the
 * normalisation spelled out, instead of in every file as `(input as Request).url`.
 *
 * `jsonResponse` replaces the `{ ok: true, json: async () => body } as unknown as
 * Response` object literals. A real `Response` is strictly more honest than a partial
 * one: it has the `headers`, `statusText`, `text()` and single-use body that the code
 * under test may read, and it cannot drift from the platform type because it IS the
 * platform type. Where a test needs a response the constructor cannot express (a body
 * that reads twice, a `json()` that throws a specific error) it should say so at the
 * site rather than teach this helper to lie.
 */

/** What a test's fetch impl receives: the request target as a plain string. */
export type FakeFetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The request target as a string, however the caller spelled it.
 *
 * `String(url)` is `url.href`; a `Request` stringifies to `[object Request]`, which is
 * why it is the one case that needs its own branch.
 */
export function targetUrl(input: string | URL | Request): string {
  if (input instanceof Request) return input.url;
  return String(input);
}

/**
 * A `fetch` spy whose impl sees the target as a string and whose recorded calls are
 * typed as real `fetch` calls — so `spy.mock.calls[0][0]` type-checks and
 * `global.fetch = fakeFetch(...)` needs no cast.
 */
export function fakeFetch(impl: FakeFetchImpl): Mock<typeof fetch> {
  return vi.fn<typeof fetch>((input, init) => impl(targetUrl(input), init));
}

/**
 * What `JSON.stringify` can carry faithfully. Narrower than `unknown` on purpose: a
 * function or `undefined` at the top level stringifies to `undefined`, which the
 * Response constructor would accept as a body of the literal text "undefined".
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A real `Response` carrying `body` as JSON, with `content-type: application/json`
 * unless the caller set one. `status` defaults to 200 via the platform constructor.
 */
export function jsonResponse(body: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}
