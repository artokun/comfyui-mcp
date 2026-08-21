import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

// The write path can be made to LAND but be unverifiable, so the endpoint's
// three-valued handling is testable: `unknown` is not a success.
// The store is written ATOMICALLY (temp file, fsync, rename), so it changes at
// exactly one instant: the rename. Read 1 after a rename is the writer's own
// whole-file verification; read 2 is the caller's read-back. Breaking the 2nd
// leaves the write PROVEN on disk with no verdict about its content — the exact
// shape of "written, but could not be verified".
const fsState = vi.hoisted(() => ({
  breakSecondReadAfterRename: false,
  /** Break the FIRST store read after the Nth store rename — the writer's own
   *  whole-file verification. The rename has landed by then, so this is the "it
   *  happened but its account could not be taken" case. Keyed to a specific
   *  rename because a test does its setup writes through the same endpoint, and
   *  a break armed by a flag alone fires on the setup instead. */
  breakFirstReadAfterRenameNo: null as number | null,
  /** Break read #`read` after store-rename #`rename` — the general form, for a
   *  request that does its own setup writes through the same endpoint. */
  breakReadAfterRename: null as null | { rename: number; read: number },
  readsSinceRename: 0,
  /** Only count reads once a rename has actually happened — a read taken BEFORE
   *  the store was ever swapped is not the post-rename verification. */
  sawRename: false,
  renames: 0,
  /** Replace what the rename installs, so the store comes back missing keys it
   *  held before — the data-loss case this endpoint used to answer ok:true to. */
  tamperOnRename: null as null | (() => string),
  /** Per-rename tamper (1-based), so a specific write in a slot fan-out — or its
   *  ROLLBACK — can be singled out. */
  tamperAtRename: {} as Record<number, () => string>,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isStore = (p: unknown) => String(p).endsWith(".env");
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (isStore(to)) {
      const tamper = fsState.tamperOnRename ?? fsState.tamperAtRename[fsState.renames + 1];
      if (tamper) {
        fsState.tamperOnRename = null;
        delete fsState.tamperAtRename[fsState.renames + 1];
        actual.writeFileSync(from, tamper());
      }
    }
    const out = actual.renameSync(from, to);
    if (isStore(to)) {
      fsState.readsSinceRename = 0;
      fsState.sawRename = true;
      fsState.renames++;
    }
    return out;
  };
  const readFileSync: typeof actual.readFileSync = ((
    ...args: Parameters<typeof actual.readFileSync>
  ) => {
    const breakFirstNow =
      fsState.breakFirstReadAfterRenameNo !== null &&
      fsState.renames === fsState.breakFirstReadAfterRenameNo;
    const targeted =
      fsState.breakReadAfterRename !== null &&
      fsState.renames === fsState.breakReadAfterRename.rename;
    if (
      fsState.sawRename &&
      (fsState.breakSecondReadAfterRename || breakFirstNow || targeted) &&
      isStore(args[0])
    ) {
      fsState.readsSinceRename++;
      const breakAt = targeted
        ? fsState.breakReadAfterRename!.read
        : breakFirstNow
          ? 1
          : 2;
      if (fsState.readsSinceRename === breakAt) {
        throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      }
    }
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, renameSync, readFileSync }, renameSync, readFileSync };
});

import { startPanelConsoleHttpServer, type PanelConsoleHttpServer } from "../../orchestrator/panel-console-http.js";
import { DEFAULT_PANEL_BRIDGE_PORT } from "../../services/bridge-ports.js";

const TOKEN = "test-console-token";
let srv: PanelConsoleHttpServer;
let envPath: string;
const base = () => srv.url;

describe("console /api/secrets", () => {
  beforeEach(async () => {
    fsState.breakSecondReadAfterRename = false;
    fsState.breakFirstReadAfterRenameNo = null;
    fsState.breakReadAfterRename = null;
    fsState.sawRename = false;
    fsState.renames = 0;
    fsState.readsSinceRename = 0;
    fsState.tamperOnRename = null;
    fsState.tamperAtRename = {};
    process.env.COMFYUI_MCP_PANEL_SECRETS = join(tmpdir(), `secrets-${randomUUID()}.json`);
    // ISOLATE THE CANONICAL CREDENTIAL STORE. Without this the suite writes to
    // the developer's REAL ~/.comfyui-mcp/.env: the "sets a key" case below
    // overwrote their live CIVITAI_API_TOKEN with a dummy on every `npm test`,
    // and the revoke case deleted whatever slot it cleared. A test must never
    // be able to damage the machine it runs on.
    envPath = join(tmpdir(), `env-${randomUUID()}.env`);
    process.env.COMFYUI_MCP_ENV_FILE = envPath;
    srv = await startPanelConsoleHttpServer({ port: 0, bridgePort: DEFAULT_PANEL_BRIDGE_PORT, comfyuiUrl: "http://127.0.0.1:8188", token: TOKEN });
  });
  afterEach(async () => {
    await srv.stop();
    fsState.breakSecondReadAfterRename = false;
    fsState.breakFirstReadAfterRenameNo = null;
    fsState.breakReadAfterRename = null;
    fsState.sawRename = false;
    fsState.renames = 0;
    fsState.readsSinceRename = 0;
    fsState.tamperOnRename = null;
    fsState.tamperAtRename = {};
    delete process.env.COMFYUI_MCP_ENV_FILE;
    delete process.env.COMFYUI_MCP_PANEL_SECRETS;
    rmSync(envPath, { force: true });
  });

  it("401s without the token", async () => {
    const r = await fetch(`${base()}/api/secrets`);
    expect(r.status).toBe(401);
  });

  it("lists masked slots with the token", async () => {
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.slots.find((s: any) => s.id === "openrouter")).toBeTruthy();
    expect(body.slots.every((s: any) => s.masked === null || typeof s.masked === "string")).toBe(true);
  });

  it("sets a key and reflects it masked; rejects unknown slot", async () => {
    const ok = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", value: "civ_key_123456789" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).masked).toBe("civ_…789");

    const bad = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "nope", value: "x" }),
    });
    expect(bad.status).toBe(400);
  });

  it("does NOT report ok:true for a save that DESTROYED other credentials", async () => {
    // THE defect this PR opened on, surviving one layer further out: the save
    // read back saying "yes", `slotSaveConfirmed` looked only at `confirmed`,
    // and this endpoint sent `200 {ok:true, masked}` without ever inspecting a
    // receipt's `lostKeys`. So the console reported a clean save while the
    // user's HuggingFace and RunPod tokens were gone (codex gate).
    //
    // It cannot recur by omission now: a receipt that carries lost keys is
    // `persisted: "damaged"`, which is not "yes", so `confirmed` is false and
    // this endpoint has no path to ok:true at all.
    await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "runpod", value: "rp_key_keep_me_123" }),
    });
    await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "huggingface", value: "hf_key_keep_me_123" }),
    });
    // The next write installs a store containing ONLY the key being saved.
    fsState.tamperOnRename = () => "CIVITAI_API_TOKEN=civ_key_survivor\n";
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", value: "civ_key_survivor" }),
    });
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(r.status).toBe(500);
    // It names WHICH credentials are gone — by key name only.
    expect(body.lost_keys).toContain("RUNPOD_API_KEY");
    expect(body.lost_keys).toContain("HF_TOKEN");
    expect(String(body.error)).toMatch(/no longer carries/);
    // The post-state is the one we are ACTUALLY in. "Nothing was rolled back"
    // was asserted unconditionally here, including on the path where a failed
    // save DID roll back and the rollback is what lost the keys (codex gate).
    expect(body.rolled_back).toBe(false);
    expect(String(body.error)).toMatch(/Nothing was rolled back/);
    // And it does not offer the panel anything it could render as a save.
    expect(body.masked).toBeUndefined();
    // The values never leave.
    expect(JSON.stringify(body)).not.toContain("civ_key_survivor");
    expect(JSON.stringify(body)).not.toContain("rp_key_keep_me_123");
  });

  it("does not claim 'nothing was rolled back' when the ROLLBACK is what lost the keys", async () => {
    // The damage branch asserted that post-state unconditionally. It is also
    // reached when a FAILED save rolled back and the rollback destroyed the
    // credentials — so it reported a state that had not happened (codex gate).
    await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "runpod", value: "rp_key_keep_me_123" }),
    }); // store-rename 1
    // Rename 2 = HF_TOKEN lands. Rename 3 = HUGGINGFACE_TOKEN is installed
    // WITHOUT itself, so that alias reads back as not saved and the slot rolls
    // back — nothing lost yet. Rename 4 IS the rollback, and it eats RunPod.
    fsState.tamperAtRename[3] = () => "RUNPOD_API_KEY=rp_key_keep_me_123\nHF_TOKEN=hf_new_value\n";
    fsState.tamperAtRename[4] = () => "# the rollback ate it\n";
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "huggingface", value: "hf_new_value" }),
    });
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.lost_keys).toContain("RUNPOD_API_KEY");
    // The rollback DID happen, so the post-state must say so...
    expect(body.rolled_back).toBe(true);
    expect(String(body.error)).not.toMatch(/Nothing was rolled back/);
    expect(String(body.error)).toMatch(/that rollback is what the store lost these entries during/);
    expect(JSON.stringify(body)).not.toContain("hf_new_value");
    expect(JSON.stringify(body)).not.toContain("rp_key_keep_me_123");
  });

  it("DISCLOSES a revoke that lost other credentials instead of failing generically", async () => {
    // `removeEnvFileKey` used to THROW here. The removal had already happened,
    // so the throw became a generic `ok:false` in the endpoint's catch — with no
    // sign that anything was removed at all — and the caller retried a removal
    // that had already run, against a store that had already lost keys (codex
    // gate). Everything after the rename is a disclosure.
    await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "runpod", value: "rp_key_keep_me_123" }),
    });
    await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", value: "civ_key_to_revoke" }),
    });
    fsState.tamperOnRename = () => "# everything else gone\n";
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", clear: true }),
    });
    const body = await r.json();
    expect(body.ok).toBe(false);
    // It says the removal HAPPENED — that is the difference between a
    // disclosure and a refusal, and it is what stops the caller retrying.
    expect(body.cleared).toBe(true);
    expect(body.lost_keys).toContain("RUNPOD_API_KEY");
    expect(String(body.error)).toMatch(/WAS removed/);
    expect(String(body.error)).toMatch(/Do NOT repeat the revoke/);
    expect(JSON.stringify(body)).not.toContain("rp_key_keep_me_123");
    // It also reports the VERIFIED end state. This branch used to return before
    // the end-state check, so a revoke that lost keys never said whether the
    // credential it was revoking still resolves (codex gate).
    expect(body).toHaveProperty("still_resolves");
    expect(body.still_resolves).toBe(false);
  });

  it("does not answer a revoke CLEAN when its loss account could not be completed", async () => {
    // A revoke is a store rewrite: it can lose credentials, drop comments, and
    // fail to be durable, exactly as a save can. This endpoint was reading only
    // "did anything change", so a removal whose whole-file account was never
    // taken came back as a clean 200 once the final state read happened to
    // succeed (codex gate). The obligations now come from the same shared list
    // the save path uses.
    await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", value: "civ_key_to_revoke" }),
    });
    // Break the writer's own post-rename verification read (read 1 after the
    // REVOKE's rename, which is store-rename #2 — #1 was the save above): the
    // removal LANDS, but nothing is established about the rest of the store.
    fsState.breakFirstReadAfterRenameNo = 2;
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", clear: true }),
    });
    fsState.breakFirstReadAfterRenameNo = null;
    fsState.readsSinceRename = 0;
    const body = await r.json();
    // The revoke DID happen, so this is a disclosure, not a refusal...
    expect(body.cleared).toBe(true);
    // ...but it must not read as a clean one. The WARNING said the account was
    // not established while `ok:true` sat beside it, and a consumer reads the
    // flag (codex gate).
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(String(body.warnings.join(" "))).toMatch(/NOT established/);
    expect(JSON.stringify(body)).not.toContain("civ_key_to_revoke");
  });

  it("does not answer ok:true when the revoke's END STATE is unknown", async () => {
    // The warning said the end state was UNKNOWN while the success flag next to
    // it said the revoke worked — and a consumer reads the flag (codex gate).
    // `cleared` still reports that the removal happened, so this stays a
    // disclosure and nobody is invited to retry a completed operation.
    await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", value: "civ_key_to_revoke" }),
    });
    // Break the read `slotRevokeState` uses — read #2 after the REVOKE's rename
    // (#1 is the writer's own whole-file verification; the save above was
    // store-rename #1, so the revoke is #2).
    fsState.breakReadAfterRename = { rename: 2, read: 2 };
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", clear: true }),
    });
    fsState.breakReadAfterRename = null;
    const body = await r.json();
    // We really are in the unknown-end-state branch (never assert vacuously).
    expect(body.still_resolves).toBeNull();
    expect(String(body.warning)).toMatch(/UNKNOWN/);
    expect(body.ok).toBe(false); // the flag agrees with the warning
    expect(body.cleared).toBe(true); // ...and still says the removal happened
    expect(JSON.stringify(body)).not.toContain("civ_key_to_revoke");
  });

  it("clears a set slot with clear:true (issue #203) — removes all alias keys", async () => {
    // set → confirm set → clear → confirm gone
    await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "glm", value: "glm_key_abcdef12345" }),
    });
    const afterSet = await (await fetch(`${base()}/api/secrets?token=${TOKEN}`)).json();
    expect(afterSet.slots.find((s: any) => s.id === "glm").set).toBe(true);

    const clr = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "glm", clear: true }),
    });
    expect(clr.status).toBe(200);
    const clrBody = await clr.json();
    expect(clrBody.ok).toBe(true);
    expect(clrBody.cleared).toBe(true);

    const afterClear = await (await fetch(`${base()}/api/secrets?token=${TOKEN}`)).json();
    const slot = afterClear.slots.find((s: any) => s.id === "glm");
    expect(slot.set).toBe(false);
    expect(slot.masked).toBeNull();

    // clearing an already-empty slot reports cleared:false but still 200
    const again = await (await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "glm", clear: true }),
    })).json();
    expect(again.ok).toBe(true);
    expect(again.cleared).toBe(false);

    // unknown slot still 400s on the clear path
    const bad = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "nope", clear: true }),
    });
    expect(bad.status).toBe(400);
  });

  it("does NOT report ok:true for a save it could not verify", async () => {
    // `setEnvSecret` returns yes/no/unknown and this endpoint used to fold
    // `unknown` into success — a definite configured state asserted from a
    // failed read-back, which is the #826 defect reappearing in the vocabulary
    // introduced to prevent it.
    fsState.breakSecondReadAfterRename = true;
    fsState.readsSinceRename = 0;
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", value: "civ_key_unverifiable" }),
    });
    const body = await r.json();
    fsState.breakSecondReadAfterRename = false;
    fsState.breakFirstReadAfterRenameNo = null;
    fsState.breakReadAfterRename = null;
    fsState.sawRename = false;
    fsState.renames = 0;
    fsState.readsSinceRename = 0;
    expect(body.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(String(body.error)).toContain("UNKNOWN");
    expect(String(body.error)).not.toMatch(/was NOT saved/); // not a proven failure either
    expect(body.unverified_keys).toContain("CIVITAI_API_TOKEN");
    // ...and it must never echo the value.
    expect(JSON.stringify(body)).not.toContain("civ_key_unverifiable");
  });

  it("rejects an oversized body instead of hanging", async () => {
    const oversized = JSON.stringify({ slot: "civitai", value: "x".repeat(1_100_000) });
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: oversized,
    });
    expect(r.status).toBe(400);
    await r.text().catch(() => {});
  }, 5000);
});
