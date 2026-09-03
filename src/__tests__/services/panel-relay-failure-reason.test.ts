// #2703 — a connected-panel read that fails must say WHY, not only that it failed.
//
// The reporter's session had a dead COMFYUI_URL and a live sidebar panel, so the
// #2532 read fallback was the one path that could have answered. It declined
// with `PANEL_FETCH_FAILED`, which the relay returns for EVERY non-timeout throw
// out of `bridge.send` — the panel's own too_large / timeout / network_error /
// http_error / invalid_origin / redirect_error / api_unavailable, the
// workflow-reload guard, and "Unknown command" from a pre-relay panel all
// collapse into that one token. The error naming which of them it was already
// existed inside the relay; it was dropped before the response was built.
//
// These exercise the REAL loopback relay server end to end (a live HTTP round
// trip, the real capability and the real response MAC), because the collapse
// happened in the response the server writes, not in a helper.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  PANEL_IMAGE_RELAY_HTTP_PATH,
  PANEL_IMAGE_RELAY_VERSION,
  PanelComfyUIReadRelayError,
  PanelImageRelayError,
  requestPanelComfyUIRead,
  requestPanelImage,
  startPanelImageRelayServer,
  verifyPanelComfyUIReadRelayCapability,
  verifyPanelImageRelayCapability,
} from "../../services/panel-image-relay.js";

const SECRET = "b".repeat(64);
const TARGET_URL = "http://127.0.0.1:8188";
const TARGET_GENERATION = 3;

const savedEnv = {
  secret: process.env.COMFYUI_MCP_RELAY_SECRET,
  url: process.env.COMFYUI_MCP_RELAY_URL,
  comfyui: process.env.COMFYUI_URL,
  generation: process.env.COMFYUI_MCP_TARGET_GENERATION,
};

beforeEach(() => {
  process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
  process.env.COMFYUI_URL = TARGET_URL;
  process.env.COMFYUI_MCP_TARGET_GENERATION = String(TARGET_GENERATION);
});

afterEach(() => {
  for (const [key, value] of [
    ["COMFYUI_MCP_RELAY_SECRET", savedEnv.secret],
    ["COMFYUI_MCP_RELAY_URL", savedEnv.url],
    ["COMFYUI_URL", savedEnv.comfyui],
    ["COMFYUI_MCP_TARGET_GENERATION", savedEnv.generation],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Start the real relay in front of a bridge whose send REJECTS, which is the
 *  exact shape a panel executor throw takes when it reaches the relay. */
async function relayRejectingWith(error: unknown) {
  const server = await startPanelImageRelayServer({
    resolvePanelAgent: (value) => {
      // Each verifier answers for ONE request shape; asking the wrong one first
      // is how this harness turned a PANEL_FETCH_FAILED into RELAY_UNAVAILABLE.
      const ok = ((): boolean => {
        try {
          if ("operation" in (value as Record<string, unknown>)) {
            return verifyPanelComfyUIReadRelayCapability(SECRET, value);
          }
          return verifyPanelImageRelayCapability(SECRET, value);
        } catch {
          return false;
        }
      })();
      return ok ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined;
    },
    resolvePanelTab: () => "panel-tab",
    resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
    resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
    bridge: {
      canReach: () => true,
      send: vi.fn(async () => {
        throw error;
      }),
    },
  });
  process.env.COMFYUI_MCP_RELAY_URL = server.endpointUrl;
  return server;
}

/** A fake relay peer that answers every request with one hand-built, hand-signed
 *  reply. Used to exercise digests this codebase's own writer never produces. */
async function staticSignedReply(
  build: (requestId: string) => Record<string, unknown>,
): Promise<{ close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { requestId: string };
      const body = JSON.stringify(build(input.requestId));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
  const port = (fake.address() as { port: number }).port;
  process.env.COMFYUI_MCP_RELAY_URL = `http://127.0.0.1:${port}${PANEL_IMAGE_RELAY_HTTP_PATH}`;
  return { close: () => new Promise<void>((resolve) => fake.close(() => resolve())) };
}

describe("#2703 — a PANEL_FETCH_FAILED read names its cause", () => {
  it("carries the panel's own message back through the signed response", async () => {
    // The panel's real too_large text. This is the case that is INDISTINGUISH-
    // ABLE from every other cause under the bare code, and the one where the
    // remedy (ask for one prompt_id, not the whole history) depends entirely on
    // knowing which it was.
    const server = await relayRejectingWith(
      new Error("fetch_comfyui_read response exceeds the 16777216-byte limit"),
    );
    try {
      const failure = await requestPanelComfyUIRead("history").then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PanelComfyUIReadRelayError);
      const relayError = failure as PanelComfyUIReadRelayError;
      expect(relayError.code).toBe("PANEL_FETCH_FAILED");
      expect(relayError.reason).toBe("fetch_comfyui_read response exceeds the 16777216-byte limit");
      expect(relayError.message).toContain("16777216-byte limit");
    } finally {
      await server.close();
    }
  });

  it("distinguishes an old panel from a failed read, which the code alone cannot", async () => {
    // Same code, entirely different remedy: update the panel.
    const server = await relayRejectingWith(new Error('Unknown command "fetch_comfyui_read"'));
    try {
      const failure = await requestPanelComfyUIRead("history").then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((failure as PanelComfyUIReadRelayError).code).toBe("PANEL_FETCH_FAILED");
      expect((failure as PanelComfyUIReadRelayError).reason).toBe('Unknown command "fetch_comfyui_read"');
    } finally {
      await server.close();
    }
  });

  it("bounds a hostile reason instead of forwarding it, and never drops the code", async () => {
    // Control characters would let a panel forge extra lines in an agent-facing
    // error; length would let it move a payload. Both are handled without
    // losing the failure itself.
    const server = await relayRejectingWith(
      new Error(`line one\nline two${"x".repeat(500)}`),
    );
    try {
      const failure = (await requestPanelComfyUIRead("history").then(
        () => undefined,
        (error: unknown) => error,
      )) as PanelComfyUIReadRelayError;
      expect(failure.code).toBe("PANEL_FETCH_FAILED");
      expect(failure.reason).toBeDefined();
      expect(failure.reason!.length).toBeLessThanOrEqual(200);
      expect([...failure.reason!].every((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)).toBe(true);
      expect(failure.reason).toContain("line one line two");
    } finally {
      await server.close();
    }
  });

  it("says nothing rather than something empty when the throw carries no message", async () => {
    const server = await relayRejectingWith(new Error("   "));
    try {
      const failure = (await requestPanelComfyUIRead("history").then(
        () => undefined,
        (error: unknown) => error,
      )) as PanelComfyUIReadRelayError;
      expect(failure.code).toBe("PANEL_FETCH_FAILED");
      expect(failure.reason).toBeUndefined();
      // The pre-#2703 sentence, unchanged, with nothing bolted onto it.
      expect(failure.message).toBe("The connected panel could not read ComfyUI.");
    } finally {
      await server.close();
    }
  });

  it("carries the cause on the image relay too — one catch produces both codes", async () => {
    const server = await relayRejectingWith(new Error("fetch_image could not reach /view: Failed to fetch"));
    try {
      const failure = (await requestPanelImage("render.png", "output", "").then(
        () => undefined,
        (error: unknown) => error,
      )) as PanelImageRelayError;
      expect(failure).toBeInstanceOf(PanelImageRelayError);
      expect(failure.code).toBe("PANEL_FETCH_FAILED");
      expect(failure.reason).toBe("fetch_image could not reach /view: Failed to fetch");
    } finally {
      await server.close();
    }
  });

  it("refuses a correctly SIGNED reason that breaks the bound", async () => {
    // A peer holding the relay secret is not thereby allowed to hand the agent
    // an unbounded sentence: the MAC proves WHO wrote it, never that what they
    // wrote is within contract. Without the field validation this reply is
    // authentic, oversized, and accepted.
    const upstream = await relayRejectingWith(new Error("genuine cause"));
    const honestEndpoint = process.env.COMFYUI_MCP_RELAY_URL as string;
    const { createServer } = await import("node:http");
    const resigner = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        const forwarded = await fetch(honestEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.concat(chunks),
        });
        const body = (await forwarded.json()) as Record<string, unknown>;
        body.reason = "z".repeat(5_000);
        body.responseMac = createHmac("sha256", SECRET)
          .update(
            JSON.stringify([
              PANEL_IMAGE_RELAY_VERSION,
              body.requestId,
              false,
              body.error,
              body.updated,
              body.reason,
            ]),
          )
          .digest("hex");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => resigner.listen(0, "127.0.0.1", () => resolve()));
    const port = (resigner.address() as { port: number }).port;
    process.env.COMFYUI_MCP_RELAY_URL = `http://127.0.0.1:${port}${new URL(honestEndpoint).pathname}`;
    try {
      const failure = (await requestPanelComfyUIRead("history").then(
        () => undefined,
        (error: unknown) => error,
      )) as PanelComfyUIReadRelayError;
      expect(failure.code).toBe("MALFORMED_REPLY");
      expect(failure.reason).toBeUndefined();
      expect(failure.message).not.toContain("zzz");
    } finally {
      await new Promise<void>((resolve) => resigner.close(() => resolve()));
      await upstream.close();
    }
  });

  // Codex gate, finding 2: the tampering cases above are also satisfied by the
  // PRE-#2703 reject-all-extra-keys rule, so on their own they do not separate
  // the new contract from the old one. These three do — each one is about a
  // response this diff must treat differently from how it treated it before.

  it("verifies a hand-signed LEGACY five-element failure unchanged", async () => {
    // The compatibility claim, stated directly instead of resting on an
    // unrelated shipped test: a peer that signed the pre-#2703 payload (an old
    // orchestrator serving a child spawned after an in-place package update)
    // must still verify, and must produce the bare pre-#2703 sentence.
    const server = await staticSignedReply((requestId) => {
      const unsigned = {
        version: PANEL_IMAGE_RELAY_VERSION,
        requestId,
        ok: false,
        error: "PANEL_FETCH_FAILED",
        updated: Date.now(),
      };
      return {
        ...unsigned,
        responseMac: createHmac("sha256", SECRET)
          .update(
            JSON.stringify([unsigned.version, unsigned.requestId, false, unsigned.error, unsigned.updated]),
          )
          .digest("hex"),
      };
    });
    try {
      const failure = (await requestPanelComfyUIRead("history").then(
        () => undefined,
        (error: unknown) => error,
      )) as PanelComfyUIReadRelayError;
      expect(failure.code).toBe("PANEL_FETCH_FAILED");
      expect(failure.reason).toBeUndefined();
      expect(failure.message).toBe("The connected panel could not read ComfyUI.");
    } finally {
      await server.close();
    }
  });

  it("refuses a six-element digest whose reason was stripped in flight", async () => {
    // The other direction from the append attack: a response SIGNED with a
    // reason, delivered without it. Believing it would let a man-in-the-middle
    // silently delete the diagnosis this whole change exists to deliver.
    const server = await staticSignedReply((requestId) => {
      const unsigned = {
        version: PANEL_IMAGE_RELAY_VERSION,
        requestId,
        ok: false,
        error: "PANEL_FETCH_FAILED",
        updated: Date.now(),
      };
      const mac = createHmac("sha256", SECRET)
        .update(
          JSON.stringify([
            unsigned.version,
            unsigned.requestId,
            false,
            unsigned.error,
            unsigned.updated,
            "the reason that was signed",
          ]),
        )
        .digest("hex");
      return { ...unsigned, responseMac: mac };
    });
    try {
      const failure = (await requestPanelComfyUIRead("history").then(
        () => undefined,
        (error: unknown) => error,
      )) as PanelComfyUIReadRelayError;
      expect(failure.code).toBe("MALFORMED_REPLY");
    } finally {
      await server.close();
    }
  });

  it("refuses a correctly signed reason on a code that never carries one", async () => {
    // Codex gate r1 finding 1, then r2 finding 1. Our writer only ever mints a
    // reason alongside PANEL_FETCH_FAILED, but the response is input that
    // merely has to verify — so the READER enforces it. The first draft dropped
    // the reason at render time and returned TIMEOUT; that fixed what the user
    // reads while quietly widening the wire contract, since BEFORE this change
    // the extra key made this reply MALFORMED_REPLY. It does again.
    const server = await staticSignedReply((requestId) => {
      const unsigned = {
        version: PANEL_IMAGE_RELAY_VERSION,
        requestId,
        ok: false,
        error: "TIMEOUT",
        updated: Date.now(),
        reason: "a sentence TIMEOUT must not carry",
      };
      return {
        ...unsigned,
        responseMac: createHmac("sha256", SECRET)
          .update(
            JSON.stringify([
              unsigned.version,
              unsigned.requestId,
              false,
              unsigned.error,
              unsigned.updated,
              unsigned.reason,
            ]),
          )
          .digest("hex"),
      };
    });
    try {
      const failure = (await requestPanelComfyUIRead("history").then(
        () => undefined,
        (error: unknown) => error,
      )) as PanelComfyUIReadRelayError;
      expect(failure.code).toBe("MALFORMED_REPLY");
      expect(failure.reason).toBeUndefined();
      expect(failure.message).not.toContain("must not carry");
    } finally {
      await server.close();
    }
  });

  it("refuses a reason reached through a polluted prototype", async () => {
    // Codex gate r2, finding 2. `hasOwn` says "absent" for an inherited
    // `reason` while every reader — including the MAC payload — sees it.
    //
    // The peer here signs the SIX-element digest INCLUDING the inherited value,
    // which is what makes this a live hole rather than a redundancy: the
    // response body carries no `reason` key at all, so an own-property check
    // sees a plain reasonless failure, while `responseMacPayload` reads the
    // prototype's value and computes exactly the digest the peer sent. The MAC
    // therefore VERIFIES, and `validFailureReason` is the only thing left
    // standing between a 5000-character string and the user's error message.
    // (An earlier draft of this test had the peer sign the five-element digest;
    // that reply is refused by the MAC and the guard never runs, so it proved
    // nothing — mutation testing said so by leaving the guard alive.)
    const polluted: { reason?: string } = Object.prototype;
    polluted.reason = "z".repeat(5_000);
    const server = await staticSignedReply((requestId) => {
      const unsigned = {
        version: PANEL_IMAGE_RELAY_VERSION,
        requestId,
        ok: false,
        error: "PANEL_FETCH_FAILED",
        updated: Date.now(),
      };
      return {
        ...unsigned,
        responseMac: createHmac("sha256", SECRET)
          .update(
            JSON.stringify([
              unsigned.version,
              unsigned.requestId,
              false,
              unsigned.error,
              unsigned.updated,
              polluted.reason,
            ]),
          )
          .digest("hex"),
      };
    });
    try {
      const failure = (await requestPanelComfyUIRead("history").then(
        () => undefined,
        (error: unknown) => error,
      )) as PanelComfyUIReadRelayError;
      expect(failure.code).toBe("MALFORMED_REPLY");
      expect(failure.message).not.toContain("zzz");
    } finally {
      delete polluted.reason;
      await server.close();
    }
  });

  it("ACCEPTS a well-formed signed reason on the same hand-built wire path", async () => {
    // The positive control for every refusal above (codex gate r2, finding 3):
    // those cases assert MALFORMED_REPLY, which the PRE-#2703 code also
    // answered by rejecting the extra key — so on their own they cannot show
    // the refusals are about the reason rather than about the path. This one
    // travels the identical hand-built, hand-signed path and comes back
    // ACCEPTED, so a change that broke reason support would fail HERE while the
    // refusals stayed green, and the pair is what separates the two.
    const server = await staticSignedReply((requestId) => {
      const unsigned = {
        version: PANEL_IMAGE_RELAY_VERSION,
        requestId,
        ok: false,
        error: "PANEL_FETCH_FAILED",
        updated: Date.now(),
        reason: "fetch_comfyui_read history returned HTTP 403",
      };
      return {
        ...unsigned,
        responseMac: createHmac("sha256", SECRET)
          .update(
            JSON.stringify([
              unsigned.version,
              unsigned.requestId,
              false,
              unsigned.error,
              unsigned.updated,
              unsigned.reason,
            ]),
          )
          .digest("hex"),
      };
    });
    try {
      const failure = (await requestPanelComfyUIRead("history").then(
        () => undefined,
        (error: unknown) => error,
      )) as PanelComfyUIReadRelayError;
      expect(failure.code).toBe("PANEL_FETCH_FAILED");
      expect(failure.reason).toBe("fetch_comfyui_read history returned HTTP 403");
      expect(failure.message).toContain("HTTP 403");
    } finally {
      await server.close();
    }
  });

  it("refuses a reason the relay did not sign", async () => {
    // The reason is read out loud and attributed to the panel, so it has to be
    // covered by the response MAC. A man-in-the-middle on the loopback endpoint
    // that appends one must be rejected outright, not believed.
    const upstream = await relayRejectingWith(new Error("genuine cause"));
    // Captured BEFORE the env is repointed at the proxy: reading it inside the
    // handler makes the proxy forward to itself.
    const honestEndpoint = process.env.COMFYUI_MCP_RELAY_URL as string;
    const { createServer } = await import("node:http");
    const tamper = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        const forwarded = await fetch(honestEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.concat(chunks),
        });
        const body = (await forwarded.json()) as Record<string, unknown>;
        // Same MAC, different sentence.
        body.reason = "a cause the relay never signed";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => tamper.listen(0, "127.0.0.1", () => resolve()));
    const port = (tamper.address() as { port: number }).port;
    process.env.COMFYUI_MCP_RELAY_URL = `http://127.0.0.1:${port}${new URL(honestEndpoint).pathname}`;
    try {
      const failure = (await requestPanelComfyUIRead("history").then(
        () => undefined,
        (error: unknown) => error,
      )) as PanelComfyUIReadRelayError;
      expect(failure.code).toBe("MALFORMED_REPLY");
      expect(failure.message).not.toContain("never signed");
    } finally {
      await new Promise<void>((resolve) => tamper.close(() => resolve()));
      await upstream.close();
    }
  });
});
