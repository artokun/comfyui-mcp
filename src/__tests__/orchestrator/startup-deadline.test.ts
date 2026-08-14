// #1524 — a respawned orchestrator was observed alive for HOURS holding no
// listening ports, while an older instance owned 9180/9181/9183. From the user's
// side the sidebar kept working; the agent session had simply lost the panel.
//
// WHY THE EXISTING GUARD DOES NOT COVER IT, which is the whole reason this is a
// startup-wide deadline rather than a bind timeout: the bind-failure path is
// already bounded and already exits. `attemptListen` retries EADDRINUSE five
// times, then resolves `whenReady()` false; `runPanelOrchestrator` tries to
// reclaim the port and, failing that, logs and exits non-zero. A process holding
// NO port never reached any of that — it hung earlier. A guard wrapped around the
// bind would have watched the one place the failure was not.
//
// So the deadline is armed before anything can block and disarmed only once the
// port is genuinely held. It does not care where the hang is; the failure it
// prevents is not "the bind failed" but "we never found out".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Importing the orchestrator drags in `resolveLiveInterpreter`, which shells out
// to find the python actually serving the port ON THIS MACHINE — so an unstubbed
// import asserts one thing where ComfyUI is running and another where it is not,
// and CI cannot tell you because CI is one of those machines (#1263). The repo
// gates against exactly that, and it caught this file. Stubbed at the module
// boundary; this suite never wants a live process table anyway, since it injects
// its own `incumbent` lookup.
vi.mock("../../services/live-interpreter.js", async () => ({
  ...(await vi.importActual("../../services/live-interpreter.js")),
  resolveLiveInterpreter: () => undefined,
  observeLiveServerProcess: () => undefined,
}));

const { armStartupDeadline } = await import("../../orchestrator/index.js");

const PORT = 9180;

let exits: number[];
let errors: string[];
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  exits = [];
  errors = [];
  // The orchestrator logs through the shared logger, which writes to stderr.
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    errors.push(String(chunk));
    return true;
  });
  delete process.env.COMFYUI_MCP_STARTUP_DEADLINE_MS;
});

afterEach(() => {
  vi.useRealTimers();
  errSpy.mockRestore();
  delete process.env.COMFYUI_MCP_STARTUP_DEADLINE_MS;
});

const exit = ((code: number) => {
  exits.push(code);
  return undefined as never;
}) as (code: number) => never;

describe("the startup deadline (#1524)", () => {
  it("exits non-zero when startup never completes", () => {
    armStartupDeadline(PORT, { exit, incumbent: () => undefined });

    vi.advanceTimersByTime(89_000);
    expect(exits).toEqual([]); // still within the default window

    vi.advanceTimersByTime(2_000);
    expect(exits).toEqual([1]);
  });

  it("does NOTHING once startup disarms it", () => {
    const disarm = armStartupDeadline(PORT, { exit, incumbent: () => undefined });
    disarm();

    vi.advanceTimersByTime(10 * 60_000);
    expect(exits).toEqual([]);
    expect(errors.join("")).not.toMatch(/startup did not complete/);
  });

  it("names the incumbent pid when one holds the port", () => {
    // The actionable case: an older comfyui-mcp still owns 9180. Telling the user
    // WHICH pid is the difference between "something is wrong" and a fix.
    armStartupDeadline(PORT, { exit, incumbent: () => 3807 });
    vi.advanceTimersByTime(91_000);

    const msg = errors.join("");
    expect(msg).toMatch(/pid 3807/);
    expect(msg).toMatch(/stop it/);
  });

  it("says the hang is BEFORE the bind when nothing holds the port", () => {
    // The reporter's actual state: no listener at all, so the process did not even
    // reach the bind. That is a different instruction — and a bug report, not a
    // port conflict.
    armStartupDeadline(PORT, { exit, incumbent: () => undefined });
    vi.advanceTimersByTime(91_000);

    const msg = errors.join("");
    expect(msg).toMatch(/before the bind/);
    expect(msg).toMatch(/#1524/);
    expect(msg).not.toMatch(/pid \d/);
  });

  it("honours COMFYUI_MCP_STARTUP_DEADLINE_MS", () => {
    // A cold npx start on a slow disk is legitimately slow; the escape hatch has
    // to work or the guard becomes the outage.
    process.env.COMFYUI_MCP_STARTUP_DEADLINE_MS = "5000";
    armStartupDeadline(PORT, { exit, incumbent: () => undefined });

    vi.advanceTimersByTime(4_000);
    expect(exits).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(exits).toEqual([1]);
  });

  it("ignores a nonsense override rather than disabling itself", () => {
    // `0`, a negative, or a word must not silently switch the guard off — that
    // would reintroduce exactly the silent-zombie state, via a typo.
    // `0.5` and anything past Node's 32-bit setTimeout ceiling both COERCE TO 1ms
    // — so a value typed while trying to RAISE the deadline would fire almost
    // instantly and kill every healthy startup. An escape hatch that can cause the
    // outage it exists to prevent is worse than none (codex).
    for (const bad of ["0", "-1", "soon", "", "0.5", "999", "2147483648", "1e30"]) {
      exits = [];
      process.env.COMFYUI_MCP_STARTUP_DEADLINE_MS = bad;
      const disarm = armStartupDeadline(PORT, { exit, incumbent: () => undefined });

      // WHEN it fires, not merely THAT it fires. Dropping the `raw > 0` guard
      // turns "0" and "-1" into a ZERO-millisecond deadline that kills every
      // startup instantly — strictly worse than disabling it — and an
      // exits-are-[1]-after-91s assertion cannot tell that apart from a sane
      // default. A surviving mutation is what exposed the gap.
      vi.advanceTimersByTime(89_000);
      expect(exits, `override ${JSON.stringify(bad)} must not fire early`).toEqual([]);

      vi.advanceTimersByTime(2_000);
      expect(exits, `override ${JSON.stringify(bad)} should fall back to the default`).toEqual([1]);
      disarm();
    }
  });

  it("is ARMED before startup can block, and DISARMED only after the bind", () => {
    // The placement is the whole fix and a unit test cannot see it:
    // `runPanelOrchestrator` is far too large to drive here, so the ordering is
    // asserted against the source. Armed too late and it misses the hang it
    // exists for; disarmed too early and it stops guarding; never disarmed and it
    // kills a healthy orchestrator 90 seconds in.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "orchestrator", "index.ts"), "utf8");
    const lines = src.split(/\r?\n/);

    // The CALL site, not the definition. `findIndex` on the bare name matches
    // `export function armStartupDeadline(` first, which sits above everything
    // and makes "armed before the bridge" true by construction — a test that
    // passes whatever the wiring does. Third time today that shape has appeared.
    const armAt = lines.findIndex((l) => /=\s*armStartupDeadline\(/.test(l));
    const disarmAt = lines.findIndex((l) => l.trim().startsWith("disarmStartupDeadline()"));
    const bridgeAt = lines.findIndex((l) => l.includes("startUiBridge("));
    const boundAt = lines.findIndex((l) => l.includes("await bridge.whenReady()"));

    // Every anchor must exist, or this test silently checks nothing.
    for (const [name, at] of [["arm", armAt], ["disarm", disarmAt], ["startUiBridge", bridgeAt], ["whenReady", boundAt]] as const) {
      expect(at, `could not find the ${name} site in orchestrator/index.ts`).toBeGreaterThan(-1);
    }

    // Armed before the bridge is even constructed — the reporter's process held
    // NO port, so the hang was upstream of it.
    expect(armAt).toBeLessThan(bridgeAt);
    // Disarmed only after the port is confirmed held.
    expect(disarmAt).toBeGreaterThan(boundAt);
  });

  it("does not hold the process open by itself", () => {
    // The deadline must never be the reason a healthy short-lived run cannot
    // exit; it is a guard, not a keepalive.
    const disarm = armStartupDeadline(PORT, { exit, incumbent: () => undefined });
    const timers = vi.getTimerCount();
    expect(timers).toBeGreaterThan(0);
    disarm();
    expect(vi.getTimerCount()).toBe(timers - 1);

    // `unref` is not observable under fake timers — the count above is identical
    // with or without it — so the call is asserted against the source instead.
    // Without it a process that finishes its work inside the window cannot exit
    // until the deadline elapses, which is a hang introduced by the anti-hang
    // guard. A surviving mutation is what showed the behavioural test could not
    // see this.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "orchestrator", "index.ts"),
      "utf8",
    );
    // SCOPED to this function. index.ts has more than one `timer.unref?.()`, so a
    // file-wide match passed even with THIS one deleted — an assertion satisfied
    // by an unrelated line. Only the deadline's own body counts.
    const start = src.indexOf("export function armStartupDeadline");
    expect(start, "armStartupDeadline is gone — this test is checking nothing").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("return () => clearTimeout(timer);", start));
    expect(body).toMatch(/timer\.unref\?\.\(\)/);
  });
});
