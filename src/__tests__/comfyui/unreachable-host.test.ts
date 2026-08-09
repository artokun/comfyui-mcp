// #1136 — an unreachable host must say UNREACHABLE, and name itself.
//
// The reported harm: a user was told to search ComfyUI Manager, the registry was
// unreachable, the list came back empty, and they concluded the pack did not
// exist. Empty reads as "nothing matched". Three rounds of advice were aimed at
// a door that could not open.
//
// The discriminating cases here are the NEGATIVE ones. `describeUnreachableHost`
// is a deliberate SUBSET of NEVER_DELIVERED_CODES, which answers a different
// question ("could this have been delivered?") for which a malformed URL and a
// filtered DNS lookup are equivalent. For THIS question they are opposites, and
// a test suite that only checked the positive cases would pass just as happily
// against the wrong set.

import { describe, expect, it } from "vitest";

import { describeUnreachableHost } from "../../comfyui/fetch.js";

/** A Node transport error as undici surfaces it: the code hangs off `cause`. */
function transportError(code: string): Error {
  const err = new TypeError("fetch failed");
  (err as unknown as { cause: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

describe("describeUnreachableHost (#1136)", () => {
  it("names the host on a DNS failure", () => {
    const msg = describeUnreachableHost(transportError("ENOTFOUND"), "https://civitai.com/api/v1/models?query=x");
    expect(msg).toBeTruthy();
    expect(msg).toContain("civitai.com");
    expect(msg).toMatch(/could not be resolved/i);
  });

  it("says CONNECTIVITY, not emptiness — the whole point of the issue", () => {
    // Without this sentence the caller still has to guess whether an empty grid
    // means "absent" or "unreachable", which is the reported failure verbatim.
    const msg = describeUnreachableHost(transportError("ECONNREFUSED"), "https://registry.npmjs.org/comfyui-mcp/latest");
    expect(msg).toMatch(/not an empty result/i);
    expect(msg).toMatch(/does not mean the thing you searched for is absent/i);
    expect(msg).toContain("registry.npmjs.org");
  });

  it("treats a TLS failure as unreachable — an intercepting middlebox looks like this", () => {
    const msg = describeUnreachableHost(transportError("CERT_HAS_EXPIRED"), "https://search-new.civitai.com/x");
    expect(msg).toContain("search-new.civitai.com");
    expect(msg).toMatch(/TLS/);
  });

  it("does NOT claim unreachable for a malformed URL — that is the caller's mistake", () => {
    // ERR_INVALID_URL IS in NEVER_DELIVERED_CODES, because nothing was delivered.
    // Reusing that set here would send a user with a typo to inspect a firewall.
    expect(describeUnreachableHost(transportError("ERR_INVALID_URL"), "https://civitai.com/x")).toBeNull();
    expect(
      describeUnreachableHost(transportError("ERR_UNSUPPORTED_PROTOCOL"), "https://civitai.com/x"),
    ).toBeNull();
  });

  it("does NOT claim unreachable for a mid-connection drop — the host WAS reached", () => {
    // ECONNRESET/EPIPE fire on an ESTABLISHED connection. Reporting those as
    // "could not reach" would be the same overclaim pointing the other way.
    expect(describeUnreachableHost(transportError("ECONNRESET"), "https://civitai.com/x")).toBeNull();
    expect(describeUnreachableHost(transportError("EPIPE"), "https://civitai.com/x")).toBeNull();
  });

  it("returns null for a non-transport error, so a 404 is never mislabelled", () => {
    expect(describeUnreachableHost(new Error("Unexpected token < in JSON"), "https://civitai.com/x")).toBeNull();
    expect(describeUnreachableHost(undefined, "https://civitai.com/x")).toBeNull();
  });

  it("falls back to the raw string when the url is not parseable", () => {
    // The caller may hand us something we assembled ourselves; dropping the name
    // would defeat the one thing this function exists to provide.
    const msg = describeUnreachableHost(transportError("ENOTFOUND"), "civitai.com");
    expect(msg).toContain("civitai.com");
  });
});
