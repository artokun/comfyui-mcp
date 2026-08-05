import { defineConfig } from "vitest/config";

// Scope test discovery to the source tree. Without this, Vitest's default glob
// also picks up test files inside transient git worktrees under .claude/ (left
// by background agents), polluting the run.
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/.claude/**",
    ],
    // Vitest defaults both of these to 5s, which is too tight for THIS suite on a
    // loaded machine, and that produced a long-running myth of "the suite flakes in
    // a rotating cast of unrelated files" (#852). It is not flaky in the usual
    // sense: two full-concurrency runs on the same commit failed in almost
    // disjoint sets — grok-backend + training-jobs, then node-dev,
    // panel-recovery-cluster, panel-status-base-path and two training-jobs cases —
    // and every one of them failed with vitest's own "If this is a long-running
    // test/hook, pass a timeout value", i.e. a TIMEOUT, never an assertion. Each
    // passes in isolation.
    //
    // WHY THIS IS NOT "WIDENING A TOLERANCE TO HIDE A RACE", which we deliberately
    // refuse to do elsewhere (#821/#843 rebuilt a fixture around `listen(0)` rather
    // than raising its timeout; panel #652 made an injected delay instant rather
    // than lengthening the budget). Those guarded races in PRODUCT code, where a
    // longer fuse leaves the bug and moves the symptom. This guards the RUNNER
    // being starved of CPU: several of these tests do real work — `node-dev`
    // shells out to real git — and 5s is simply not a meaningful budget for that
    // when the machine is saturated. Nothing about the code under test is racy;
    // the measurement apparatus was.
    //
    // The cost is bounded and falls only on failures: a genuinely hung test now
    // takes 30s to report instead of 5s. Suite wall-clock is unchanged, because a
    // passing test still returns when it returns — raising a ceiling nobody reaches
    // costs nothing.
    //
    // If a test starts needing MORE than this, that is a signal to make it
    // deterministic (inject the clock, remove the real timer), not to raise this
    // number again.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
