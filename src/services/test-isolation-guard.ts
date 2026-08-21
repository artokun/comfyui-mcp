// Test-state isolation: the RUNTIME half of "the suite must never write the
// developer's real ~/.comfyui-mcp".
//
// Two mechanisms, one property:
//
// 1. The vitest setup file (src/__tests__/helpers/isolated-test-home.ts) points
//    HOME/USERPROFILE at a fresh temp directory for the ENTIRE run, before any
//    test module — and therefore any product module — is imported. Every
//    homedir()-based default lands in the throwaway home, however the writer
//    spelled it, including module-eval-time captures and child processes that
//    inherit the environment. That is the catch-all: it does not enumerate
//    writers, so a writer nobody audited is still safe (#866, #879).
//
// 2. `assertNotWritingRealHomeInTests` below refuses, at the moment of the
//    write, any write whose target is inside the REAL home recorded before the
//    redirect. It exists for the writers whose loss is live-harmful (pending
//    panel operations, the panel pin/settings, prompt overrides), so that a
//    test which deliberately points one of those back at the real home fails
//    loudly instead of silently damaging it.
//
// The credential stores keep their own, stricter guards in panel-secrets.ts:
// there a test must redirect the store explicitly, because a dummy token
// landing in the REAL .env once already cost a live CivitAI token.

import { join, resolve, sep } from "node:path";

/**
 * Are we running INSIDE the test runner?
 *
 * The first version of this guard asked `NODE_ENV === "test" || VITEST ||
 * VITEST_WORKER_ID` — ordinary environment variables that any user can have set,
 * for reasons of their own, in the shell this app was launched from. A user with
 * a leftover `VITEST` export, or `NODE_ENV=test` from an adjacent project, was
 * then REFUSED when saving their own API key (codex gate). Refusing a real user
 * their credential is a worse outcome than the accidental store overwrite this
 * guard replaced, so the guard must key off something only the runner itself
 * produces.
 *
 * Vitest injects these into the global scope of every worker it runs. They are
 * not environment variables and there is no plausible way for a user's shell to
 * put them there. When none is present we do NOT know we are under a runner —
 * and in that uncertainty the write is ALLOWED, deliberately: the failure mode
 * we accept is "a rogue test slips past the runtime guard and is caught by the
 * static sweep instead", never "a real user cannot save a token".
 *
 * `scope` is a parameter so this can be tested for what it must NOT do. Some of
 * the runner's own globals are non-configurable, so a test cannot remove them to
 * check that the answer does not fall back to `VITEST` / `NODE_ENV`; passing a
 * bare object asks the question directly.
 */
export function runningUnderTestRunner(scope: Record<string, unknown> = globalThis): boolean {
  return (
    "__vitest_worker__" in scope ||
    "__vitest_index__" in scope ||
    "__vitest_environment__" in scope
  );
}

/**
 * Where the REAL home directory is recorded for the duration of a test run.
 * A global, not an environment variable: an env var is something a user can
 * plausibly have set (or a test can wipe by replacing `process.env`), and this
 * value must only ever come from the test setup file. The name cannot collide
 * with anything the runner itself defines.
 */
const REAL_HOME_GLOBAL = "__comfyui_mcp_test_real_home__";

declare global {
  /** Declared (as `var`, the one form that lands on globalThis) so the two
   *  accessors below read and write it as the string it is, instead of going
   *  through an untyped view of globalThis. */
  var __comfyui_mcp_test_real_home__: string | undefined;
}

/**
 * Called ONCE by the vitest setup file, before it redirects HOME: remember
 * where the developer's real home directory is, so write-guards can still
 * recognise a target inside it after the redirect makes `homedir()` answer
 * with the throwaway one.
 */
export function recordRealHomeForTestIsolation(realHome: string): void {
  globalThis[REAL_HOME_GLOBAL] = realHome;
}

/** The home the run started with, if the setup file recorded one. Exported so
 *  tests can assert the redirect is actually in force (a guard nobody wired
 *  up guards nothing). */
export function realHomeRecordedForTestIsolation(): string | undefined {
  const value = globalThis[REAL_HOME_GLOBAL];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * REFUSE to write the developer's real ~/.comfyui-mcp state from a test run.
 *
 * This is the write-side guard for state files whose corruption is
 * live-harmful but which have no per-store redirect convention worth
 * enforcing (the global HOME redirect already keeps the default path safe).
 * It refuses only the one target that is never legitimate under a runner:
 * inside the real home's .comfyui-mcp directory, recorded at setup.
 *
 * The comparison root is the STATE DIRECTORY, not the home directory itself:
 * on Windows the OS temp directory lives INSIDE the user's home
 * (C:\Users\x\AppData\Local\Temp), so "outside the real home" would refuse
 * every correctly-redirected temp-path write on exactly the platform class
 * that produced #866.
 *
 * The fail-open cases are deliberate and match the credential-store guards:
 * no runner globals (production — the guard is inert there) or no recorded
 * real home (a runner without our setup file) both ALLOW the write. Refusing
 * a real user their own state on an uncertain detection is the worse failure.
 */
export function assertNotWritingRealHomeInTests(targetPath: string, what: string): void {
  if (!runningUnderTestRunner()) return; // detection is uncertain → ALLOW the write
  const realHome = realHomeRecordedForTestIsolation();
  if (!realHome) return; // no redirect installed → nothing to compare against
  // Case-insensitive on Windows, where the filesystem is; a prefix check must
  // include the separator so ".../.comfyui-mcp-old" is not "inside"
  // ".../.comfyui-mcp".
  const normalize = (p: string): string => {
    const r = resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const target = normalize(targetPath);
  const stateRoot = normalize(join(realHome, ".comfyui-mcp"));
  const rootWithSep = stateRoot.endsWith(sep) ? stateRoot : stateRoot + sep;
  if (target === stateRoot || target.startsWith(rootWithSep)) {
    throw new Error(
      `Refusing to write ${what} from a test run: ${targetPath} is inside the developer's ` +
        `real state directory (${stateRoot}). The test run redirects HOME to a throwaway ` +
        `directory precisely so this cannot happen — a test that reaches the real path ` +
        `has explicitly undone that isolation. Point the store's redirect variable at a ` +
        `temp path instead. Nothing was written.`,
    );
  }
}
