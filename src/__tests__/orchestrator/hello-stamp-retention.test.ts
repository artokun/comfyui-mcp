// #689/#688/#607/#702 — the panel wedges "workflow instance mismatch" on EVERY
// command (including panel_list_workflows) after a reconnect or workflow switch,
// and neither panel_open_workflow nor panel_set_workflow_target({mode:"current"})
// clears it.
//
// The wedge is not a STALE stamp, it is an ABSENT one. The hello handler used to
// DELETE the tab's command stamp whenever it could not derive a trusted identity
// from the hello (`workflowIdentityParts` returns undefined when the uuid is
// missing/malformed OR the server-observed origin is empty — a reconnect hello
// that lands before the canvas identity is readable carries no uuid). With no
// stamp, UiBridge sends frames with no `workflow_uuid` at all, and the panel
// counts an unstamped command as a mismatch too (#718, deliberately fail-closed).
// So erasing the stamp does not relax the fence — it refuses HARDER, across
// everything the fence covers.
//
// The two outcomes are asymmetric in RECOVERABILITY, which is what made this
// permanent: a stale stamp is replaced by the next hello that does resolve an
// identity, while an absent one is not, because the panel's re-advertise repair
// is capped (MISMATCH_REHELLO_MAX_PER_IDENTITY = 3) per identity. Once those are
// spent against an orchestrator that still cannot derive an identity, nothing
// retries and the tab is refused for the rest of the session.
//
// Retaining is SAFE, and that is the load-bearing claim these tests defend: the
// panel authorizes a fenced command IFF stamp === the live active workflow uuid,
// so a retained stamp can only ever authorize a command naming the canvas that
// is actually mounted. It permits no write a correct stamp would not permit.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { workflowIdentityParts } from "../../orchestrator/session-store.js";

const indexSrc = (): string =>
  readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");

/** The hello handler's identity block, isolated so the assertions below cannot be
 *  satisfied (or broken) by an unrelated `tabCommandWorkflowUuid` site elsewhere
 *  in the file — notably the legitimate migration `delete(migratedFrom)`. */
function helloIdentityBlock(src: string): string {
  const anchor = src.indexOf("if (newIdentity) {");
  expect(anchor, "the hello handler's identity block must still exist").toBeGreaterThan(-1);
  return src.slice(anchor, anchor + 400);
}

describe("an untrusted hello RETAINS the tab's command stamp (#689)", () => {
  it("SOURCE: the untrusted branch does not delete the stamp", () => {
    const block = helloIdentityBlock(indexSrc());
    // A trusted identity still records the stamp — the fix must not have turned
    // the setter off, only the eraser.
    expect(block).toContain("tabCommandWorkflowUuid.set(panelTab, newIdentity.uuid);");
    // The regression itself. `delete(panelTab)` here is what converts a
    // recoverable stale stamp into an unrecoverable absent one.
    expect(
      block.includes("tabCommandWorkflowUuid.delete(panelTab)"),
      "an untrusted hello must NOT erase the stamp — that is the #689 wedge",
    ).toBe(false);
  });

  it("the identity that triggers the untrusted branch is reachable from a real reconnect hello", () => {
    // Not a hypothetical branch: these are the exact inputs a reconnect produces.
    const origin = "http://127.0.0.1:8188";
    const uuid = "33333333-3333-4333-8333-333333333333";

    // A hello that lands before the canvas identity is readable carries no uuid.
    expect(workflowIdentityParts({ workflowUuid: undefined, origin })).toBeUndefined();
    expect(workflowIdentityParts({ workflowUuid: "", origin })).toBeUndefined();
    // …and one whose server-observed origin is not resolvable is untrusted too.
    expect(workflowIdentityParts({ workflowUuid: uuid, origin: undefined })).toBeUndefined();
    expect(workflowIdentityParts({ workflowUuid: uuid, origin: "" })).toBeUndefined();
    // A fully-formed hello IS trusted — otherwise the branch above would be the
    // only one ever taken and the test would prove nothing about untrusted input.
    // #1255 — the returned origin is now CANONICAL, so every loopback spelling
    // folds to one value and a fence bound under `127.0.0.1` validates against a
    // panel reached on `localhost`. What this test is about — which identities
    // are trusted vs untrusted — is unchanged; only the canonical form moved.
    expect(workflowIdentityParts({ workflowUuid: uuid, origin })).toEqual({
      origin: "http://localhost:8188",
      uuid,
    });
  });

  it("SOURCE: the migration path's own delete is untouched — only the untrusted-hello eraser goes", () => {
    // #436's `delete(migratedFrom)` retires the PREVIOUS tab id's stamp on a
    // proven workflow change. That is a different decision (a tab id going away)
    // and must survive this fix; deleting it here would be an unrelated
    // behavioural change smuggled in on the same line of reasoning.
    expect(indexSrc()).toContain("tabCommandWorkflowUuid.delete(migratedFrom);");
  });
});
