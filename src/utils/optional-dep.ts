// Helper for lazy-loading optional dependencies.
//
// Heavy or feature-gated packages (cloud SDKs, AI SDKs, cloudflared) live in
// `optionalDependencies` so a `npm install --no-optional comfyui-mcp` install
// still yields a working server. The features that need those deps surface a
// clear "install <pkg>" error instead of crashing on import.

import { ModelError } from "./errors.js";

const cache = new Map<string, unknown>();


/**
 * WHY did `import(spec)` fail — three answers, not one (#796).
 *
 * A dynamic import fails for reasons with OPPOSITE remedies, and this said "is
 * not installed. To enable it, run: npm install <pkg>" for all of them:
 *
 *   - the package really is absent            → install it (the message was right)
 *   - the package is present but one of ITS
 *     dependencies is not                     → its tree is broken; installing
 *                                               the package again reports nothing
 *                                               to do
 *   - the package is present and THROWS on
 *     load (a native binary built for another
 *     Node ABI or platform is the common one) → installing it changes nothing
 *
 * In the last two the suggested command tells the user "already up to date" and
 * leaves them exactly where they started, having spent the round trip proving
 * the advice wrong. The cause was already captured in the error metadata; only
 * the sentence claimed to know something it had not checked.
 *
 * WHICH specifier is missing decides between the first two, and Node names it in
 * the message ("Cannot find package 'x' imported from …"). When it cannot be
 * extracted the answer is the SAFE one — a load failure, whose advice does not
 * hinge on knowing the package is absent.
 */
export type ImportFailure =
  | { kind: "missing" }
  | { kind: "missing-transitive"; detail: string }
  | { kind: "unloadable"; detail: string };

export function classifyImportFailure(spec: string, err: unknown): ImportFailure {
  const e = err as NodeJS.ErrnoException & { message?: string };
  const message = typeof e?.message === "string" ? e.message : String(err);
  const notFound = e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND";
  if (!notFound) return { kind: "unloadable", detail: message };

  // "Cannot find package 'x' imported from …" / "Cannot find module 'x'".
  const named = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(message)?.[1];
  if (named === undefined) {
    // A not-found we cannot attribute. Treat it as the requested package rather
    // than inventing a transitive one — this is the pre-existing behaviour and
    // the common case.
    return { kind: "missing" };
  }
  // SUBPATHS RUN BOTH WAYS, and only one direction is obvious. Requesting
  // "pkg/sub" makes Node report `Cannot find package 'pkg'` — it names the bare
  // PACKAGE, not what was asked for — so a `named === spec` test fails and the
  // package gets blamed as its own dependency. Found by a surviving mutant and
  // confirmed against real Node before fixing.
  const isSelf =
    named === spec || named.startsWith(`${spec}/`) || spec.startsWith(`${named}/`);
  return isSelf ? { kind: "missing" } : { kind: "missing-transitive", detail: named };
}

export async function requireOptionalDep<T>(
  spec: string,
  options?: {
    feature?: string;
    installHint?: string;
  },
): Promise<T> {
  const cached = cache.get(spec);
  if (cached !== undefined) return cached as T;
  try {
    const mod = (await import(spec)) as T;
    cache.set(spec, mod);
    return mod;
  } catch (err) {
    const feature = options?.feature ?? spec;
    const installHint = options?.installHint ?? `npm install ${spec}`;
    const why = classifyImportFailure(spec, err);
    throw new ModelError(
      why.kind === "missing"
        ? `Optional dependency for ${feature} is not installed. To enable it, run: ${installHint}`
        : why.kind === "missing-transitive"
          ? `Optional dependency for ${feature} IS installed, but it could not load because ` +
            `${why.detail} is missing — one of its own dependencies, not this package. ` +
            `Running "${installHint}" will report nothing to do. Reinstall it so its ` +
            `dependency tree is resolved (npm install --force ${spec}), or install ${why.detail} directly.`
          : `Optional dependency for ${feature} IS installed, but it failed to LOAD: ${why.detail}. ` +
            `Running "${installHint}" will report nothing to do — the package is present and ` +
            `broken, which is usually a native binary built for a different Node/ABI or platform. ` +
            `Reinstall it (npm install --force ${spec}), or check that binary's own requirements.`,
      {
        // The code still distinguishes the two for programmatic callers: only a
        // genuinely absent package is MISSING.
        code: why.kind === "missing" ? "OPTIONAL_DEP_MISSING" : "OPTIONAL_DEP_UNLOADABLE",
        package: spec,
        cause: err instanceof Error ? err.message : String(err),
      },
    );
  }
}
