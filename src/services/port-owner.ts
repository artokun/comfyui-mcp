// Port → owning PID lookup.
//
// Extracted from process-control so the live-interpreter resolver can use it
// WITHOUT importing process-control (which imports workspace-env, which consumes
// the resolver — that would be an import cycle). This module is a LEAF: node
// builtins only. process-control re-exports parseListenerPidFromNetstat so its
// existing tests keep importing it from there.

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { platform } from "node:os";

const IS_WIN = platform() === "win32";

/**
 * Extract the PID that is LISTENING on `port` from `netstat -ano` output.
 *
 * We anchor on the local-address `:PORT` suffix rather than grepping the state
 * word ("LISTENING"), which is TRANSLATED on non-English Windows (German
 * "ABHÖREN", French "À L'ÉCOUTE", …). The old `findstr LISTENING` filter dropped
 * every line on those systems, so a perfectly reachable ComfyUI looked like "no
 * process on port". Anchoring on the local column also correctly IGNORES an
 * outbound/established connection whose REMOTE peer happens to use `:PORT`.
 *
 * Exported for tests: this pure function is where the bug lived.
 */
/** Loopback spellings that all denote "this machine". */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** Bind addresses that accept connections for EVERY local address. */
const WILDCARD = new Set(["0.0.0.0", "::", "*", ""]);

/** Split "127.0.0.1:8188" / "[::1]:8188" / "*:8188" into address + port. */
function splitEndpoint(endpoint: string): { address: string; port: string } {
  const idx = endpoint.lastIndexOf(":");
  if (idx < 0) return { address: endpoint, port: "" };
  const address = endpoint.slice(0, idx).replace(/^\[|\]$/g, "");
  return { address, port: endpoint.slice(idx + 1) };
}

/**
 * Does a listener bound to `address` serve the host we are actually talking to?
 *
 * A wildcard bind serves every local address, so it always matches. Otherwise the
 * addresses must agree, with the loopback spellings treated as equivalent. Binding
 * the lookup to the HOST — not just the port number — keeps two instances on
 * different loopback addresses from being confused for one another (#401 round 4).
 */
export function addressServesHost(address: string, wantHost?: string): boolean {
  const a = address.toLowerCase();
  if (WILDCARD.has(a)) return true;
  if (!wantHost) return true;
  const w = wantHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (a === w) return true;
  return LOOPBACK.has(a) && LOOPBACK.has(w);
}

export function parseListenerPidFromNetstat(
  output: string,
  port: number,
  host?: string,
): number | null {
  const suffix = `:${port}`;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    // Expected columns: PROTO LOCAL FOREIGN STATE PID
    if (parts.length < 5) continue;
    if (parts[0].toUpperCase() !== "TCP") continue;
    const local = parts[1];
    const foreign = parts[2];
    // The leading colon anchors the match: "…:8188" matches but "…:81880" and
    // "…:18188" do not (their last chars aren't ":8188").
    if (!local.endsWith(suffix)) continue;
    // Require a LISTENING row without depending on the localized state word: a
    // listener's foreign endpoint is always the wildcard port 0 (0.0.0.0:0 /
    // [::]:0). This rejects an ESTABLISHED connection that merely bound its
    // local side to :PORT — killing that would take down the wrong process
    // (or none) when ComfyUI is actually down.
    if (!foreign.endsWith(":0")) continue;
    if (!addressServesHost(splitEndpoint(local).address, host)) continue;
    const pid = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * Parse `lsof -V -nP -iTCP:PORT -sTCP:LISTEN -Fpn` field output. Records look like
 *   p1234
 *   n127.0.0.1:8188
 * so we can bind the match to the ADDRESS as well as the port, which the plain
 * `-t` (terse) output cannot express.
 */
export function parseListenerPidFromLsof(
  output: string,
  port: number,
  host?: string,
): number | null {
  let pid: number | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("p")) {
      const parsed = parseInt(line.slice(1), 10);
      pid = !Number.isNaN(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (line.startsWith("n") && pid !== null) {
      const endpoint = line.slice(1);
      // Ignore a peer-qualified name ("a->b"); listeners have no peer.
      if (endpoint.includes("->")) continue;
      const { address, port: p } = splitEndpoint(endpoint);
      if (p !== String(port)) continue;
      if (!addressServesHost(address, host)) continue;
      return pid;
    }
  }
  return null;
}

/**
 * The result of asking "who owns this port?" — with "I could not find out" kept
 * DISTINCT from "nobody".
 *
 * `findPidByPort` collapses both into `null`, which is fine for "find me the pid"
 * but dangerous for "has the port been released?": a lookup that merely FAILED
 * would read as proof the port is free, and callers acting on that proof (tearing
 * down supervision after a kill) would act on a server that is still running.
 */
export type PortOwnerProbe =
  | { state: "owned"; pid: number }
  | { state: "free" }
  | { state: "unknown"; reason: string };

/**
 * Did `lsof` positively STATE that nothing is listening?
 *
 * Its exit status cannot answer this. Verified against the manual and by
 * experiment: lsof "returns a one (1) if any error was detected, INCLUDING the
 * failure to locate ... Internet addresses", so status 1 conflates "searched and
 * found nothing" with "could not search". Worse, a run that enumerates nothing
 * because it lacks permission also produces status 1 with EMPTY stdout and EMPTY
 * stderr — so "quiet" is not evidence either, with or without `-w` (which only
 * suppresses warnings and therefore makes silence less meaningful, not more).
 *
 * What IS a positive statement of absence is `-V`, which makes lsof say what it
 * failed to locate: `lsof: Internet address not located: TCP:8188`. That marker,
 * and nothing else, is treated as "free". Anything else exits to "unknown", which
 * a caller may not spend as proof of release.
 */
/**
 * lsof reporting that its own enumeration was INCOMPLETE.
 *
 * Any such note voids the absence marker: "I searched and did not find it" is a
 * statement about the whole machine, but a run that could not stat or open part of
 * `/proc` only searched the part it could see. The marker and a warning can appear
 * TOGETHER — lsof reports what it skipped and still names what it failed to locate —
 * and reading that combination as "free" certifies a release from an enumeration
 * that admits it was partial.
 */
/**
 * Did lsof complain about anything, i.e. admit its enumeration was incomplete?
 *
 * Recognised by INVERSION rather than by enumerating diagnostics. Listing the ones I
 * could think of (`WARNING`, `permission denied`, …) missed real ones lsof documents
 * — `lsof: can't read proc table info` among them — and every miss certifies a
 * release from a partial search. The set of things lsof can complain about is open;
 * the set of things it says as ITS `-V` REPORT is closed and known: `not located`
 * lines, verified from a live run to be exactly
 *
 *     lsof: Internet address not located: TCP:65432
 *     lsof: TCP state not located: LISTEN
 *
 * So any `lsof:`-prefixed line that is NOT part of that report is a complaint,
 * whatever it says. `Output information may be incomplete.` is checked separately
 * because lsof prints it without the prefix.
 */
function admitsIncompleteEnumeration(output: string): boolean {
  if (/may be incomplete/i.test(output)) return true;
  return output.split("\n").some((raw) => {
    const line = raw.trim();
    if (!/^lsof:/i.test(line)) return false;
    return !/\bnot located\b/i.test(line);
  });
}

/**
 * What lsof said about absence — kept as THREE outcomes, not a boolean.
 *
 *   "stated"     — it named what it failed to locate, and reported no gaps.
 *   "inconclusive" — it named what it failed to locate AND admitted it could not
 *                  enumerate everything. The verdict is the same as `silent`
 *                  (`unknown`), but the CAUSE is not, and a caller that waits out a
 *                  budget deserves to be told which one it was.
 *   "silent"     — it said nothing about an empty search.
 *
 * Collapsing the middle case into `silent` is how the verdict stayed right while the
 * message asserted something that did not happen — lsof plainly DID report an empty
 * search; we declined to spend it.
 */
type LsofAbsence = "stated" | "inconclusive" | "silent";

const LSOF_INCONCLUSIVE_REASON =
  "lsof reported nothing listening on the port but also reported that it could not enumerate everything, so its search describes only what it could see";

/**
 * THE ONLY WAY THIS MODULE MAY RUN `lsof`.
 *
 * Invariant 4 — lsof must STATE absence (`-V`); silence is not evidence — is a
 * property of the COMMAND, and a rule that lives in a comment survives only as long
 * as everyone remembers it at the next call site. A quiet `lsof` without `-V` exits 1
 * with empty stdout AND stderr whether it searched and found nothing or could not
 * search at all, so a second invocation that omitted the flag would hand a caller a
 * `free` verdict for a live port. Building the argument list HERE, once, is what
 * makes the invariant structural: there is no other place to get an lsof result from,
 * and a future call site inherits `-V` whether or not its author knew to ask for it.
 *
 * `2>&1` for the matching reason: lsof reports an INCOMPLETE enumeration on stderr,
 * and on the success path `execSync` returns stdout ONLY — so without the redirect a
 * marker on stdout beside a warning on stderr reads as a clean absence and certifies
 * a release from a search that admitted it was partial. The error path already sees
 * both streams; this makes the success path see what the error path sees. Warnings do
 * not disturb the field parser, which keys on `p`/`n` line prefixes, so a host whose
 * lsof warns routinely loses only the fast path — a wait, never a wrong answer.
 */
function runLsofListenerQuery(port: number): string {
  return execSync(`lsof -V -nP -iTCP:${port} -sTCP:LISTEN -Fpn 2>&1`, {
    encoding: "utf-8",
    timeout: 5000,
  });
}

function readLsofAbsence(output: string): LsofAbsence {
  if (!/internet address not located/i.test(output)) return "silent";
  return admitsIncompleteEnumeration(output) ? "inconclusive" : "stated";
}

function lsofErrorAbsence(err: unknown): LsofAbsence {
  const e = err as NodeJS.ErrnoException & {
    status?: number;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
  };
  // A spawn-level failure (command missing, timeout) tells us nothing at all.
  if (e?.code) return "silent";
  if (e?.status !== 1) return "silent";
  const text = (v: Buffer | string | undefined): string =>
    v == null ? "" : typeof v === "string" ? v : v.toString("utf-8");
  return readLsofAbsence(`${text(e.stdout)}\n${text(e.stderr)}`);
}

/**
 * How the kernel socket tables are read.
 *
 * Injected rather than called directly so a test can drive this branch the way it
 * already drives the `lsof` branch (through the `node:child_process` mock):
 * present-and-listening, present-and-free, or inaccessible, on demand. Reading
 * `readFileSync` directly made the answer depend on the HOST — on a Linux runner
 * `/proc` genuinely exists, so the real socket table silently outranked a test's
 * port fixtures and the assertions were graded against the runner's own network
 * state instead (#776 CI). A suite that can only be green on a machine with
 * nothing on port 8188 is not testing anything.
 */
export type ProcNetTableReader = (table: string) => string;

const defaultProcNetReader: ProcNetTableReader = (table) => readFileSync(table, "utf-8");

let procNetReader: ProcNetTableReader = defaultProcNetReader;

/**
 * How `/proc/<pid>/fd` is walked to ATTRIBUTE a kernel socket to a process (#795).
 *
 * Injected for the same reason as the socket-table reader: on a Linux runner the
 * real `/proc` exists, so an un-injected read would grade assertions against the
 * runner's own process table instead of the fixtures. Kept as three narrow
 * operations rather than a filesystem handle so a test can make ONE pid unreadable
 * (the permission case that must never become a definite answer) without having to
 * model a filesystem.
 */
export interface ProcFdReader {
  /** Numeric entries of `/proc` — every process on the machine. */
  listPids(): number[];
  /** Entries of `/proc/<pid>/fd`. */
  listFds(pid: number): string[];
  /** Target of `/proc/<pid>/fd/<fd>` — `socket:[<inode>]` for a socket. */
  readFdLink(pid: number, fd: string): string;
}

const defaultProcFdReader: ProcFdReader = {
  listPids: () =>
    readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map((name) => Number(name)),
  listFds: (pid) => readdirSync(`/proc/${pid}/fd`),
  readFdLink: (pid, fd) => readlinkSync(`/proc/${pid}/fd/${fd}`),
};

let procFdReader: ProcFdReader = defaultProcFdReader;

export const __portOwnerTestHooks = {
  /** Drive the kernel-table read. `null` restores the real `/proc` reader. */
  setProcNetReader(fn: ProcNetTableReader | null): void {
    procNetReader = fn ?? defaultProcNetReader;
  },
  /** Drive the `/proc/<pid>/fd` walk (#795). `null` restores the real reader. */
  setProcFdReader(fn: ProcFdReader | null): void {
    procFdReader = fn ?? defaultProcFdReader;
  },
  reset(): void {
    procNetReader = defaultProcNetReader;
    procFdReader = defaultProcFdReader;
  },
};

/**
 * Is a socket LISTENING on `port`, according to the kernel's own table?
 *
 * `/proc/net/tcp{,6}` lists every TCP socket on the machine regardless of owner
 * and needs no external tool, so it answers free-vs-occupied definitively where
 * `lsof` can only answer ambiguously (and cannot see another user's sockets at
 * all). It does not name the owning pid — that still needs lsof (or #795's
 * `/proc/<pid>/fd` scan) — but the safety-critical question after a kill is
 * whether the port was RELEASED, and this settles exactly that.
 *
 * A POSITIVE is decisive from a single table: one LISTEN row is a socket, whatever
 * the other table says. A NEGATIVE requires having read them BOTH — "no IPv4
 * listener, and I could not open the IPv6 table" is not "nothing is listening", it
 * is "I did not finish looking". Certifying that as free is the same fold this
 * whole change exists to remove: a source that could not answer producing a
 * definite one.
 *
 *   "listening"   — a LISTEN row was seen. Decisive.
 *   "none"        — every table was read AND fully parsed, and none held a LISTEN
 *                   row for the port. The only decisive negative.
 *   "incomplete"  — something was read, but a table could not be opened or held a
 *                   row that could not be parsed. A NAMED BLIND SPOT: an unreadable
 *                   tcp6 may hold an IPv6 listener.
 *   "unavailable" — no table could be read at all.
 *
 * The last two are both "not an answer", but they are NOT interchangeable once lsof
 * then states absence. With a blind spot, lsof may simply SHARE it — an
 * unprivileged lsof cannot see another user's sockets either, so the same listener
 * is invisible to both and "free" would be a guess. With no table at all (every
 * non-Linux POSIX host, where /proc/net does not exist) lsof is the only evidence
 * there has ever been, and refusing to believe it would leave macOS permanently
 * unable to observe a port release.
 */
type KernelSocketTables = "listening" | "none" | "incomplete" | "unavailable";

/**
 * Does a failed table read mean the table is ABSENT, or that we could not look?
 *
 * Classified from the errno, exactly as this change classifies a launcher config,
 * because "both reads failed" is not by itself evidence of an absent source.
 *
 * Only ENOENT and ENOTDIR prove absence: they say this PATHNAME does not resolve to
 * a file, so there is no table and nothing can be hiding in it. Every non-Linux
 * POSIX host has no `/proc/net` at all, and a kernel booted with `ipv6.disable=1`
 * has no `tcp6`.
 *
 * Everything else is "I could not look": a blind spot an unprivileged lsof may
 * SHARE, which must never be spent as proof the port is free. That deliberately
 * includes ENOSYS ("function not implemented") and ENXIO ("no such device or
 * address") — both describe a failed OPERATION, not a pathname that resolves to
 * nothing, so neither rules out a listener in a table we did not read. An
 * errno-less failure is likewise a blind spot.
 */
function tableIsAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * A kernel socket row: `<hex-address>:<hex-port>` (8 hex digits for IPv4, 32 for
 * IPv6) and a two-hex-digit state. Verified against real kernel output —
 * `0100007F:1FFC` / `00000000000000000000000001000000:49D3`, state `0A`. Requiring
 * the SHAPE, not merely four fields, is what stops a garbled row from being
 * silently skipped and then reported as "no listener here".
 */
const KERNEL_LOCAL_ENDPOINT = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/;
const KERNEL_STATE = /^[0-9A-Fa-f]{2}$/;
const KERNEL_SLOT = /^(\d+):$/;
/** The kernel's hex code for TCP_LISTEN. */
const LISTEN_STATE = "0A";
/**
 * The highest TCP state these tables can print: `TCP_CLOSING` (11 = 0x0B).
 *
 * The enum defines two values above it, and NEITHER reaches this column:
 *
 *   `TCP_NEW_SYN_RECV` (12 = 0x0C) is the sk_state of a request socket, but the
 *     seq_show path renders those through `get_openreq4`, which prints the state as
 *     `TCP_SYN_RECV` (3). So a half-open connection appears here as `03`, never `0C`.
 *   `TCP_BOUND_INACTIVE` (13 = 0x0D) is a pseudo-state for inet_diag, which walks the
 *     BIND table — and these files do not. `/proc/net/tcp` iterates the listening and
 *     established hashes only. MEASURED on 6.18: a socket bound to a port without
 *     `listen()` produces NO row here at all, in any state.
 *
 * So the domain is 01..0B, and anything above it is damage rather than a socket. A
 * future kernel printing a new state costs that host only its fast path
 * (`incomplete`, i.e. `unknown`), never a false answer.
 */
const MAX_TCP_STATE = 0x0b;
/**
 * The socket tables, each with the address width it is DEFINED to print: one 32-bit
 * word for IPv4, four for IPv6. Binding rows to their table is what stops a 32-hex
 * row in `/proc/net/tcp` — impossible, and therefore evidence of nothing — from
 * being read as either a listener or a clean negative.
 */
const KERNEL_TABLES: ReadonlyArray<{
  path: string;
  addressHexWidth: number;
  header: RegExp;
}> = [
  { path: "/proc/net/tcp", addressHexWidth: 8, header: kernelHeader("rem_address") },
  {
    path: "/proc/net/tcp6",
    addressHexWidth: 32,
    header: kernelHeader("remote_address"),
  },
];
const KERNEL_QUEUES = /^[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8}$/;
const KERNEL_TIMER = /^[0-9A-Fa-f]{2}:[0-9A-Fa-f]{8}$/;
const KERNEL_HEX8 = /^[0-9A-Fa-f]{8}$/;
const KERNEL_DECIMAL = /^\d+$/;

/**
 * The local hex port of a COMPLETE socket row, or undefined if this is not one.
 *
 * The row is validated through its `inode` column for the same reason the header is
 * validated through its last column: a row cut short after `st` still has four
 * well-formed tokens, and accepting it would mean accepting a table that EOF
 * truncated mid-row — taking any later listener rows with it — as a clean, complete
 * "nothing is listening". Trailing columns beyond `inode` (refcount, pointer, and
 * the rest, which vary by kernel) are accepted without inspection.
 *
 * Column shapes captured from a live kernel:
 *   0:  slot            `0:`
 *   1:  local_address   `0100007F:1FFC` / 32-hex for IPv6
 *   2:  rem_address     same widths
 *   3:  st              `0A`
 *   4:  tx_queue:rx_queue `00000000:00000000`
 *   5:  tr:tm->when     `00:00000000`
 *   6:  retrnsmt        `00000000`
 *   7:  uid             decimal
 *   8:  timeout         decimal
 *   9:  inode           decimal
 */
interface KernelRow {
  slot: number;
  localPort: string;
  /** The local address exactly as the table printed it (8 or 32 hex digits). */
  localAddressHex: string;
  state: string;
  /**
   * The socket's inode, present only when the WHOLE row parsed. This is the join
   * key to `/proc/<pid>/fd/*` → `socket:[<inode>]`, i.e. the half of the identity
   * that names an OWNER (#795); the existence half above never depends on it.
   */
  inode?: string;
}

/**
 * The first four columns — slot, local endpoint, remote endpoint, state — which are
 * the MINIMUM that can carry a positive finding.
 *
 * A positive is read from this prefix rather than from a whole row, because
 * truncation after the state cannot unmake the fields before it. But it must be the
 * whole prefix: `cols[1]` and `cols[3]` alone would let a line like
 * `corrupt 0100007F:1FFC garbage 0A` fabricate a listener out of bytes we have
 * every reason to distrust. Untrustworthy input must not become a definite finding
 * in EITHER direction.
 */
function parseKernelRowPrefix(
  cols: string[],
  addressHexWidth: number,
): KernelRow | undefined {
  const slot = KERNEL_SLOT.exec(cols[0] ?? "");
  const local = KERNEL_LOCAL_ENDPOINT.exec(cols[1] ?? "");
  const remote = KERNEL_LOCAL_ENDPOINT.exec(cols[2] ?? "");
  const state = cols[3] ?? "";
  if (!slot || !local || !remote || !KERNEL_STATE.test(state)) return undefined;
  // CROSS-FIELD consistency, because four individually well-shaped tokens can still
  // be a row no kernel ever wrote. Both endpoints must be the width THIS TABLE is
  // defined to print — which also settles the two against each other.
  if (local[1].length !== addressHexWidth || remote[1].length !== addressHexWidth) {
    return undefined;
  }
  // The state must be one the kernel can actually be in.
  const stateCode = parseInt(state, 16);
  if (stateCode < 1 || stateCode > MAX_TCP_STATE) return undefined;
  // A LISTENING socket has no peer: its remote endpoint is all zeros on port 0. The
  // netstat parser above leans on the same invariant (#401) to tell a listener from
  // an established connection that merely bound its local side to the port.
  if (
    state.toUpperCase() === LISTEN_STATE &&
    (remote[2] !== "0000" || /[^0]/.test(remote[1]))
  ) {
    return undefined;
  }
  return {
    slot: Number(slot[1]),
    localPort: local[2],
    localAddressHex: local[1],
    state,
  };
}

function parseKernelRow(
  cols: string[],
  addressHexWidth: number,
): KernelRow | undefined {
  if (cols.length < 10) return undefined;
  const prefix = parseKernelRowPrefix(cols, addressHexWidth);
  if (
    !prefix ||
    !KERNEL_QUEUES.test(cols[4]) ||
    !KERNEL_TIMER.test(cols[5]) ||
    !KERNEL_HEX8.test(cols[6]) ||
    !KERNEL_DECIMAL.test(cols[7]) ||
    !KERNEL_DECIMAL.test(cols[8]) ||
    !KERNEL_DECIMAL.test(cols[9])
  ) {
    return undefined;
  }
  return { ...prefix, inode: cols[9] };
}

/**
 * The kernel's hex local address as text the ADDRESS COMPARATOR understands, or
 * `undefined` when this module will not risk a comparison.
 *
 * Both tables print addresses as little-endian 32-bit words, so the bytes come out
 * reversed WITHIN each word: `0100007F` is 127.0.0.1, and the 32-digit
 * `00000000000000000000000001000000` is `::1`. Verified against live kernel output.
 *
 * Only the forms whose spelling is unambiguous are produced — a dotted quad, the
 * two wildcards, `::1`, and an IPv4-mapped `::ffff:a.b.c.d` reduced to its IPv4
 * form. A general IPv6 address has several legal textual spellings (which groups
 * `::` elides, leading zeros, case), and picking one to string-compare against a
 * user-supplied host would be a guess; guessing here would produce a POSITIVE
 * attribution, which is the direction that licenses stopping a process. So it
 * returns `undefined` and the caller declines to attribute — the honest cost is a
 * fall-through to lsof, never a wrong owner.
 */
function decodeKernelAddress(hex: string): string | undefined {
  const bytes: number[] = [];
  if (hex.length !== 8 && hex.length !== 32) return undefined;
  for (let word = 0; word < hex.length / 8; word++) {
    const w = hex.slice(word * 8, word * 8 + 8);
    // Little-endian: the LAST byte pair of the word is the FIRST address byte.
    for (let i = 3; i >= 0; i--) {
      const byte = parseInt(w.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byte)) return undefined;
      bytes.push(byte);
    }
  }
  if (bytes.length === 4) return bytes.join(".");
  const zeros = (from: number, to: number): boolean =>
    bytes.slice(from, to).every((b) => b === 0);
  if (zeros(0, 16)) return "::";
  if (zeros(0, 15) && bytes[15] === 1) return "::1";
  // IPv4-mapped (::ffff:a.b.c.d) — what a dual-stack socket shows for an IPv4 peer.
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12).join(".");
  }
  return undefined;
}

/**
 * May a kernel row be attributed to the host we are actually talking to?
 *
 * With no host constraint every listener on the port qualifies, exactly as the lsof
 * parser behaves — so the address is not even decoded. With one, an address we
 * decline to decode is NOT a match: the strictness belongs to the finding that
 * would name an owner.
 */
function kernelRowServesHost(localAddressHex: string, wantHost?: string): boolean {
  if (!wantHost) return true;
  const decoded = decodeKernelAddress(localAddressHex);
  if (decoded === undefined) return false;
  return addressServesHost(decoded, wantHost);
}

/**
 * The COMPLETE column header, matched end to end — EVERY column named in order.
 *
 * Anchoring only the start would accept a header truncated to `sl local_address`,
 * and a body truncated to nothing then reads as a table with no listeners — "the
 * header parsed" silently standing in for "the body was read". Nor is it enough to
 * pin only the two ends and allow anything between: `sl local_address rem_address
 * inode` would satisfy that while missing every intervening column, which is the
 * same truncation one level in. So the whole sequence is spelled out.
 *
 * Captured from a live kernel: IPv4 says `rem_address`, IPv6 says `remote_address`,
 * and the IPv4 line carries trailing padding (removed by the caller's trim). Each
 * table gets its OWN pattern rather than accepting either spelling, because the two
 * are not interchangeable — an IPv4-form header standing over `/proc/net/tcp6` is a
 * table we did not really read, not a table with nothing in it.
 *
 * A layout this does not recognise costs that host only its fast path — the read
 * becomes `incomplete`, which is the safe direction — never a false negative.
 */
function kernelHeader(remoteColumn: string): RegExp {
  return new RegExp(
    `^sl\\s+local_address\\s+${remoteColumn}\\s+st\\s+tx_queue\\s+rx_queue\\s+tr\\s+tm->when\\s+retrnsmt\\s+uid\\s+timeout\\s+inode$`,
    "i",
  );
}

/**
 * What the kernel tables said: whether anything is listening, and — separately —
 * the inodes of the listening sockets that may be attributed to `host` (#795).
 *
 * The two answer DIFFERENT questions and are gathered to different standards. The
 * existence half stays exactly as #785 left it: port-only (a listener on any local
 * address blocks a `free` verdict) and satisfied by a row truncated after its state.
 * The inode half backs a POSITIVE claim about a specific process, so it takes only
 * rows that parsed WHOLE and whose address provably serves the host asked about.
 */
interface KernelTableReading {
  existence: KernelSocketTables;
  inodes: string[];
}

function readKernelSocketTables(port: number, host?: string): KernelTableReading {
  const wanted = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes: string[] = [];
  let sawListener = false;
  let tablesRead = 0;
  let blind = false;
  for (const { path: table, addressHexWidth, header } of KERNEL_TABLES) {
    let raw: string;
    try {
      raw = procNetReader(table);
    } catch (err) {
      // An absent table hides nothing; an unreadable one hides anything.
      if (!tableIsAbsent(err)) blind = true;
      continue;
    }
    tablesRead++;
    // Row COUNT cannot distinguish a genuinely idle table from one truncated after
    // its header — both have zero rows. So the table's OWN BOUNDARIES do: a real
    // /proc/net/tcp always opens with the column header and always ends with a
    // newline. Seeing neither end is what separates "I read the whole table and it
    // held no listener" from "I read part of a table".
    //
    // A POSITIVE is unaffected and returns immediately below: a socket we can see is
    // a socket, however much else was lost. Only the NEGATIVE needs completeness.
    let sawHeader = false;
    let nextSlot = 0;
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      // The header must OPEN the table — its first physical line. Accepting it
      // wherever it turns up would let a table whose beginning was lost, or one with
      // rows standing before it, pass as a table we watched from the start.
      if (i === 0 && header.test(text)) {
        sawHeader = true;
        continue;
      }
      if (text === "") {
        // Only the FINAL element may be blank — it is the artifact of the table's
        // terminating newline. A blank ANYWHERE else is an empty record, which the
        // kernel never writes: one non-empty line per entry. Treating an interior
        // gap as ordinary structure would let a record deleted from the middle pass
        // as a table that simply had nothing there.
        if (i !== lines.length - 1) blind = true;
        continue;
      }
      const cols = text.split(/\s+/);
      // THE POSITIVE COMES FIRST, and needs only the fields that carry it: a local
      // endpoint on the port we asked about, in the LISTEN state. Truncation AFTER
      // the state cannot unmake the fields before it, so a row cut short of `inode`
      // still proves the socket it already showed us. Putting the completeness gate
      // ahead of this would be the same fold as everywhere else in this function,
      // merely pointed at a positive: withholding a finding we actually made.
      const prefix = parseKernelRowPrefix(cols, addressHexWidth);
      const matchesPort =
        prefix != null &&
        prefix.localPort.toUpperCase() === wanted &&
        prefix.state.toUpperCase() === LISTEN_STATE;
      if (matchesPort) sawListener = true;
      // Everything below serves the NEGATIVE, which is the half that needs the row
      // to be whole — and the inode, which needs the same wholeness for its own
      // reason (see KernelTableReading). Scanning ON past a positive costs one more
      // table read and cannot unmake `sawListener`, which is spent before `blind`
      // below: a socket we have already seen stays seen however damaged the rest is.
      const row = parseKernelRow(cols, addressHexWidth);
      if (row === undefined) {
        blind = true;
        continue;
      }
      if (
        matchesPort &&
        row.inode != null &&
        // A LISTEN row always carries a real inode. `0` is what a socket with no
        // inode of its own prints (a TIME_WAIT/request socket), and `socket:[0]`
        // is not something any `/proc/<pid>/fd` entry points at — matching on it
        // could only ever produce a coincidence, never an owner.
        row.inode !== "0" &&
        kernelRowServesHost(row.localAddressHex, host)
      ) {
        inodes.push(row.inode);
      }
      // The kernel numbers rows with a running counter from 0, so the sequence is
      // its own continuity check: a GAP means a record between these two is missing
      // from what we read, and a first row numbered above 0 means we picked the
      // table up after its beginning. Neither is visible in any single row.
      if (row.slot !== nextSlot) blind = true;
      nextSlot = row.slot + 1;
    }
    // No header on the first line means we did not see where the table STARTS — rows
    // before the point we picked it up may be missing, and a well-formed row proves
    // only that the bytes we got were well-formed. No trailing newline means we did
    // not see where it ENDS. Either way this read cannot support a definite negative.
    if (!sawHeader || !raw.endsWith("\n")) blind = true;
  }
  // A POSITIVE outranks everything, including a blind spot: a socket we saw is a
  // socket, however much else was lost. Then a blind spot outranks the negative — it
  // means something could still be hiding. Only when nothing could be — every table
  // either read cleanly or provably does not exist — may the negative be spent.
  const existence: KernelSocketTables = sawListener
    ? "listening"
    : blind
      ? "incomplete"
      : tablesRead === 0
        ? "unavailable"
        : "none";
  return { existence, inodes };
}

/**
 * WHO holds these listening sockets, resolved from `/proc` alone (#795).
 *
 * `/proc/net/tcp{,6}` gave the socket's inode; every `/proc/<pid>/fd/*` symlink of a
 * process holding it reads `socket:[<inode>]`. Matching the two names the owner with
 * no external binary at all, which is the point: a host without `lsof` was otherwise
 * permanently unable to identify its own ComfyUI, and every feature built on process
 * identity degraded to "cannot confirm" there forever.
 *
 * Both halves of the tri-state are earned:
 *   • `owned` means THIS PROCESS HOLDS THE LISTENING SOCKET. Deliberately not "is
 *     the only process that holds it" — see the note on blindness below.
 *   • anything else is `unattributed`, which is NOT a statement that the port is
 *     free — the kernel already told us a socket is there. It only means this source
 *     could not name the owner, and the caller falls through to lsof exactly as
 *     before.
 *
 * SEVERAL VISIBLE holders is `unattributed` on purpose. Forked workers and
 * SO_REUSEPORT siblings genuinely share one listener, and picking one of them out of
 * a set we can SEE would be arbitrary. "Two processes share this socket" is a better
 * answer than an arbitrary one.
 *
 * A pid whose `/proc/<pid>/fd` cannot be read does NOT withdraw a single-holder
 * finding, and that asymmetry is a decision, not an oversight:
 *
 *   • Requiring a complete walk would make attribution impossible on any multi-user
 *     host. An unprivileged process cannot read the fds of ANY other user's process,
 *     and every Linux box runs root daemons — so "the walk was complete" is
 *     essentially never true, and demanding it would restore exactly the permanent
 *     "cannot confirm" this whole change exists to remove.
 *   • lsof reaches no further. It reads the same `/proc/<pid>/fd` with the same
 *     credentials, so falling through to it after refusing here buys nothing.
 *   • The residual harm is bounded by HOW the pid is spent. A socket is shared by
 *     INHERITANCE (fork, or SCM_RIGHTS), so an unseen co-holder is essentially always
 *     a descendant — and every kill in this codebase kills the process TREE/group,
 *     which takes those with it. Nothing here is ever used to certify a port as free;
 *     that verdict comes only from the kernel table, which sees every socket
 *     regardless of owner.
 */
type ProcAttribution =
  | {
      state: "owned";
      pid: number;
      /** The socket the caller brackets on — one specific listener, not just "the port". */
      inode: string;
      /**
       * EVERY listening socket on the port this pid holds, not merely the one the walk
       * stopped at. A process listening on both address families holds two, and the
       * re-check has to be able to ask "does it still hold I?" rather than "did the
       * walk happen to select I again?" — the second question is about fd ordering.
       */
      inodes: string[];
    }
  | { state: "unattributed"; reason: string };

/** Did this read fail because the process is GONE, or because we could not look? */
function pidVanished(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  // ENOENT: the pid exited between listing /proc and reading its fds — it cannot be
  // holding the socket. ESRCH is the same fact by another name. Anything else
  // (EACCES/EPERM on another user's process, and an errno-less failure) is a place we
  // could not see into, and something could be hiding there.
  return code === "ENOENT" || code === "ESRCH";
}

function attributeInodes(inodes: string[], port: number): ProcAttribution {
  const wanted = new Map(inodes.map((inode) => [`socket:[${inode}]`, inode]));
  let pids: number[];
  try {
    pids = procFdReader.listPids();
  } catch (err) {
    return {
      state: "unattributed",
      reason: `a socket is listening on port ${port} but /proc could not be enumerated to name its owner (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }
  const owners = new Map<number, string[]>();
  let blind = false;
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = procFdReader.listFds(pid);
    } catch (err) {
      if (!pidVanished(err)) blind = true;
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = procFdReader.readFdLink(pid, fd);
      } catch (err) {
        // A single fd closing mid-walk is ordinary; a permission wall is not.
        if (!pidVanished(err)) blind = true;
        continue;
      }
      const inode = wanted.get(link);
      if (inode !== undefined) {
        // NO EARLY BREAK. Stopping at the first match records an ARBITRARY one of the
        // pid's listening sockets, and a later re-check asking "does it still hold I?"
        // would then be answered by whichever socket the walk happened to reach first
        // — so a process that released I while acquiring another listener on the same
        // port would still look unchanged (codex gate round 11).
        const seen = owners.get(pid);
        if (seen) {
          if (!seen.includes(inode)) seen.push(inode);
        } else {
          owners.set(pid, [inode]);
        }
      }
    }
  }
  if (owners.size === 1) {
    const [pid, inodes] = [...owners][0];
    return { state: "owned", pid, inode: inodes[0], inodes };
  }
  if (owners.size > 1) {
    return {
      state: "unattributed",
      reason: `the socket listening on port ${port} is held by several processes (${[
        ...owners.keys(),
      ]
        .sort((a, b) => a - b)
        .join(", ")}), so no single process owns it`,
    };
  }
  return {
    state: "unattributed",
    reason: blind
      ? `a socket is listening on port ${port} but the /proc entries that would name its owner could not all be read (it belongs to another user, or the process list changed underneath us)`
      : `a socket is listening on port ${port} but no process in /proc holds it`,
  };
}

export function probePortOwner(port: number, host?: string): PortOwnerProbe {
  if (IS_WIN) {
    let ranSomething = false;
    const failures: string[] = [];
    try {
      const out = execSync(`netstat -ano -p TCP`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      ranSomething = true;
      const pid = parseListenerPidFromNetstat(out, port, host);
      if (pid) return { state: "owned", pid };
    } catch (err) {
      failures.push(`netstat: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { \\"$($_.LocalAddress) $($_.OwningProcess)\\" }"`,
        { encoding: "utf-8", timeout: 8000 },
      );
      ranSomething = true;
      for (const raw of out.split(/\r?\n/)) {
        const [addr, pidText] = raw.trim().split(/\s+/);
        if (!addr || !pidText) continue;
        if (!addressServesHost(addr.replace(/^\[|\]$/g, ""), host)) continue;
        const pid = parseInt(pidText, 10);
        if (!Number.isNaN(pid) && pid > 0) return { state: "owned", pid };
      }
    } catch (err) {
      failures.push(`powershell: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A probe that RAN and matched nothing is real evidence the port is free.
    // Every probe failing is not.
    return ranSomething
      ? { state: "free" }
      : { state: "unknown", reason: failures.join("; ") || "no port probe available" };
  }

  // THE PRECEDENCE BETWEEN THE TWO SOURCES — stated here because it is the thing a
  // future edit will get wrong, and because getting it wrong certifies a stop that
  // never happened:
  //
  //   EXISTENCE is decided by the kernel table wherever it is available.
  //   lsof only ATTRIBUTES an existing socket to a pid.
  //
  // The kernel table sees every socket regardless of owner and cannot be silenced —
  // that is the entire reason it is consulted. lsof needs privileges the table does
  // not, so lsof failing to find or name a listener the kernel CAN see means "I
  // could not identify it", never "it is not there". A positive existence finding is
  // therefore never overridable by a negative from a source that sees strictly less.
  const reading = readKernelSocketTables(port, host);
  const kernel = reading.existence;
  if (kernel === "none") return { state: "free" };

  // ATTRIBUTION FROM THE SAME SOURCE (#795). The kernel table already handed us the
  // listening socket's inode; `/proc/<pid>/fd` says which process holds it. Consulted
  // BEFORE lsof because it is the same evidence one step further along, needs no
  // external binary, and reaches exactly as far as an unprivileged lsof does — so on
  // a host with no lsof at all this is the difference between an identified server
  // and a permanent "cannot confirm". It never answers `free`: existence was settled
  // above, and failing to NAME an owner is not evidence there is none.
  let procNote: string | undefined;
  if (reading.inodes.length > 0) {
    const attributed = attributeInodes(reading.inodes, port);
    if (attributed.state === "owned") {
      // BRACKET THE JOIN (codex gate). The inode came from one read and the fd walk
      // is another, and a socket inode is reusable the moment its socket closes: the
      // listener can go away between the two, its number be handed to an unrelated
      // socket, and the walk then name whatever process holds THAT. Nothing later
      // would catch it on the path where the server is wedged and has no argv to
      // corroborate against — and the pid is what a stop kills.
      //
      // So re-read the table and require the SAME inode to still be listening on the
      // port. This is the same discipline the restart path already applies to the
      // /system_stats pairing: carry something across two observations that a
      // substitution cannot reproduce.
      const after = readKernelSocketTables(port, host);
      // THE WHOLE FINDING HAS TO REPRODUCE, not just a part of it.
      //
      // The claim being bracketed is "exactly one visible process holds THIS socket",
      // so the closing check re-derives exactly that. Two weaker versions were both
      // wrong, in the same way:
      //   • confirming only that a listener is still on the port accepts a REPLACEMENT
      //     socket that reused the inode;
      //   • confirming only that OUR pid still holds the inode accepts a SECOND holder
      //     appearing beside it — which the opening scan would have refused as
      //     ambiguous, so the bracket would have laundered a verdict the same evidence
      //     was not allowed to produce a moment earlier (codex gate round 10).
      // A full re-attribution costs one more `/proc` walk on the positive path — the
      // same order as the lsof spawn it replaces — and is the only form that cannot
      // certify something the first pass would have rejected.
      // THREE conditions, which together are exactly the claim and no more: the socket
      // we attributed is still listening, re-deriving the owner still yields THIS pid
      // alone, and that pid still holds THAT socket.
      //
      // The third is not the same as "the walk selected the same inode again" — which
      // is about fd ordering and would fail a dual-stack listener spuriously. It asks
      // whether I is in the pid's complete set. Dropping it entirely (as an earlier
      // revision did) reopens the substitution from the other side: A could release I
      // while holding another listener J on the same port, an unreadable B could take
      // I, and re-attribution would return A/J alone — proving A owns *a* listener
      // while never proving it still owns the one being bracketed (codex gate r11).
      const stillListening = after.inodes.includes(attributed.inode);
      const recheck = stillListening ? attributeInodes(after.inodes, port) : undefined;
      if (
        recheck?.state === "owned" &&
        recheck.pid === attributed.pid &&
        recheck.inodes.includes(attributed.inode)
      ) {
        return { state: "owned", pid: attributed.pid };
      }
      // Each way the re-check can fail is a DIFFERENT fact about the world, and the
      // reason has to say which — "changed hands (PID 4321, then PID 4321)" is what
      // comes out of collapsing the same-pid-different-socket case into the
      // changed-owner one.
      procNote = !stillListening
        ? `the socket listening on port ${port} changed while its owner was being identified, ` +
          `so PID ${attributed.pid} cannot be tied to it`
        : recheck?.state === "owned" && recheck.pid !== attributed.pid
          ? `the socket listening on port ${port} changed hands while its owner was being ` +
            `identified (PID ${attributed.pid}, then PID ${recheck.pid})`
          : recheck?.state === "owned"
            ? `PID ${attributed.pid} no longer holds the socket it was identified by on port ` +
              `${port} — it holds another listener there, which is not the same finding`
            : `PID ${attributed.pid} could not be re-confirmed as the owner of the socket ` +
              `listening on port ${port}: ${recheck?.reason ?? "the re-check could not be performed"}`;
    } else {
      procNote = attributed.reason;
    }
  }

  const listeningButUnnamed = {
    state: "unknown",
    reason:
      "a socket is listening on the port but lsof could not name its owner" +
      (procNote ? `, and ${procNote}` : ""),
  } as const;

  /**
   * lsof positively STATED that nothing is listening. Believable only when the
   * kernel has neither contradicted it nor left a blind spot lsof could share: an
   * unprivileged lsof reports exactly this while being unable to enumerate another
   * user's listener, so it may not be spent as proof against a table we could not
   * finish reading.
   */
  const lsofReportsNothingListening = (): PortOwnerProbe => {
    if (kernel === "listening") return listeningButUnnamed;
    if (kernel === "incomplete") {
      return {
        state: "unknown",
        reason:
          "lsof found nothing, but a kernel socket table could not be read in full — an unreadable table may hold the listener",
      };
    }
    return { state: "free" };
  };

  // WHICH HALF CARRIES THE GUARANTEE — stated here because the two sources below do
  // NOT offer the same one, and a reader who assumes they do will over-trust this.
  //
  // The `/proc` attribution above brackets a pid against a SPECIFIC SOCKET: the inode
  // is re-read from the kernel table and the pid's complete fd set must still contain
  // it, so a socket that changed hands, or was released while its holder kept another
  // listener on the same port, withdraws the finding.
  //
  // `lsof -Fpn` cannot express that. Its records carry a pid and an address:port and
  // NO inode, so this fallback attributes BY PID ALONE — it can say "some process is
  // listening there and it is this one", not "this process holds the socket I was
  // tracking". The substitution the bracket closes is therefore closed for the /proc
  // path and NOT for this one.
  //
  // It is kept regardless, and deliberately: it is exactly the pre-existing behaviour
  // (this is how the port owner has always been named on hosts without a readable
  // /proc), so nothing is made worse, while removing it would restore the permanent
  // "cannot confirm" on every non-Linux and unprivileged host — the very state #795
  // exists to shrink. The honest summary is that /proc attribution is stronger than
  // lsof attribution, not that both are airtight.
  try {
    const out = runLsofListenerQuery(port);
    const pid = parseListenerPidFromLsof(out, port, host);
    if (pid) return { state: "owned", pid };
    const absence = readLsofAbsence(out);
    if (absence === "stated") return lsofReportsNothingListening();
    // It DID report an empty search; we declined to spend it. Say that, rather than
    // reporting the one cause we know did not apply.
    if (absence === "inconclusive") {
      return { state: "unknown", reason: LSOF_INCONCLUSIVE_REASON };
    }
    // Exited 0 but named nobody, and did not say it looked and found nothing.
    return kernel === "listening"
      ? listeningButUnnamed
      : { state: "unknown", reason: "lsof listed no owner and did not report an empty search" };
  } catch (err) {
    const absence = lsofErrorAbsence(err);
    if (absence === "stated") return lsofReportsNothingListening();
    if (absence === "inconclusive") {
      return { state: "unknown", reason: LSOF_INCONCLUSIVE_REASON };
    }
    return {
      state: "unknown",
      reason:
        // The /proc finding leads when there is one: on a host with no lsof at all
        // (#795's whole subject) "lsof: spawn ENOENT" says nothing about the port,
        // while "a socket is listening but its owner is another user's" does.
        (procNote ? `${procNote}; ` : "") +
        `lsof: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function findPidByPort(port: number, host?: string): number | null {
  const probe = probePortOwner(port, host);
  return probe.state === "owned" ? probe.pid : null;
}
