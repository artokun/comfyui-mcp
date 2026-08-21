import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const TOOL = "src/tools/install-panel.ts";
const SYNC = "src/services/panel-sync.ts";
const TEST = "src/__tests__/tools/panel-status-latest.test.ts";

const MUTATIONS = [
  ["M1 CALL SITE: evaluatePanelSync(status, { latestVersion }) -> evaluatePanelSync(status)", TOOL,
    "sync: evaluatePanelSync(status, { latestVersion }),", "sync: evaluatePanelSync(status),"],
  ["M2 CALL SITE: probe never awaited (latestVersion always undefined)", TOOL,
    "const latestVersion = await probeLatestPanelVersion(status.applicable);", "const latestVersion = undefined;"],
  ["M3 PROBE: getLatestPublishedPanelVersion() never called", TOOL,
    "return (await getLatestPublishedPanelVersion()) ?? null;", "return null;"],
  ["M4 SKIP: probe even where it cannot mean anything", TOOL,
    "  if (!applicable) return undefined;", "  if (false && !applicable) return undefined;"],
  ["M5 COLLAPSE: failed lookup answers 'not behind latest'", SYNC,
    'if (!latest) return { behindLatest: null, unknownBecause: "no-latest" };',
    'if (!latest) return { behindLatest: false, unknownBecause: "no-latest" };'],
  ["M6 COLLAPSE: uncomparable installed version answers 'not behind latest'", SYNC,
    'return { latestPublishedVersion: latest, behindLatest: null, unknownBecause: "incomparable" };',
    'return { latestPublishedVersion: latest, behindLatest: false, unknownBecause: "incomparable" };'],
  ["M7 FOLD: floor and latest collapse into one verdict", SYNC,
    "    behindLatest: latest.behindLatest,\r\n    summary:",
    "    behindLatest: latest.behindLatest,\r\n    behind: floor.behind || latest.behindLatest === true,\r\n    summary:"],
  ["M8 SUMMARY: the latest note is dropped", SYNC,
    "summary: floor.summary + latestNote(status, latest, opts.latestVersion),", "summary: floor.summary,"],
  ["M9 DIRECTION: behindLatest inverted", SYNC,
    "behindLatest: compareSemver(status.installedVersion, latest) < 0,",
    "behindLatest: compareSemver(status.installedVersion, latest) > 0,"],
  ["M10 TRUST: a shadow copy's untrusted version is compared anyway", SYNC,
    "    status.scanReliable === false ||\r\n    status.shadowInspectFailed === true ||\r\n    (status.shadows?.length ?? 0) > 0\r\n  ) {",
    "    false\r\n  ) {"],
  ["M11 TRUST: an unreliable scan alone no longer blocks the claim", SYNC,
    "    status.scanReliable === false ||\r\n", "    false ||\r\n"],
  ["M12 PIN: the advisory reads a missing pin as unpinned", SYNC,
    "  const pinned = resolvePin(status).pinned;",
    "  const pinned = status.pin && typeof status.pin === \"object\" && status.pin.pinned;"],
  ["M13 DEV: the advisory sends a dev symlink at the update action", SYNC,
    "  const remedy = status.isDevSymlink\r\n    ? //", "  const remedy = false\r\n    ? //"],
  ["M14 ABSENCE: an unproven absence is claimed as behind latest", SYNC,
    "    return status.absenceProven === false\r\n", "    return false\r\n"],
];

const restore = () => execFileSync("git", ["checkout", "--", TOOL, SYNC], { cwd: ROOT });
let survived = 0;
for (const [name, file, from, to] of MUTATIONS) {
  restore();
  const src = readFileSync(file, "utf8");
  if (!src.includes(from)) { console.log(`NOT-APPLIED | ${name}`); survived++; continue; }
  writeFileSync(file, src.replace(from, to));
  let out = "", killed = false;
  try {
    out = execFileSync("npx", ["vitest", "run", TEST, "--reporter=dot"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true });
  } catch (e) { out = `${e.stdout ?? ""}${e.stderr ?? ""}`; killed = true; }
  const summary = (out.match(/Tests\s+.*$/m) ?? ["(none)"])[0].trim();
  if (!killed) survived++;
  console.log(`${killed ? "KILLED  " : "SURVIVED"} | ${name}\n   ${summary}`);
}
restore();
console.log(`\n${MUTATIONS.length} mutations, ${survived} survived/not-applied`);
