// Read a Windows minidump far enough to say WHICH crash it is (panel#2023).
//
//   node scripts/read-minidump.mjs <file.dmp> [more.dmp …]
//
// panel#2023 — Comfy Desktop's renderer dies with `render-process-gone
// exitCode=-1073741819` and takes the ComfyUI server down with it, several times
// a day. Its first requested step is to symbolise the renderer dump against
// Electron symbols. That needs a symbol server and a Windows debugging
// toolchain, so it does not get done, and the reports arrive as a screenshot of
// a browser error page.
//
// The three facts that decide whether two reports are the SAME crash need none of
// that, because they are in the file already:
//
//   * the exception CODE — 0xC0000005 (access violation) is a different bug from
//     0x80000003 (a deliberate breakpoint) or Crashpad's own simulated-dump code,
//     and a report that quotes only "the app crashed" cannot tell them apart;
//   * the faulting ADDRESS;
//   * which loaded MODULE owns that address.
//
// That last one is the whole question on panel#2023, whose hypothesis is a
// DirectWrite text-layout fault. It does not resolve a function name — for that
// the symbols really are needed — but it does say whether the fault is even in
// the module the hypothesis blames, which is what turns "we think it is DWrite"
// into something checkable by whoever has the file.
//
// Structures per the documented layout (MINIDUMP_HEADER, MINIDUMP_DIRECTORY,
// MINIDUMP_EXCEPTION_STREAM, MINIDUMP_MODULE_LIST, MINIDUMP_SYSTEM_INFO). All
// little-endian. Nothing here writes, uploads, or phones anywhere: a crash dump
// contains process memory, so this stays a local read.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MDMP_SIGNATURE = 0x504d444d; // 'MDMP'
const STREAM_TYPE = { threadList: 3, moduleList: 4, exception: 6, systemInfo: 7, crashpadInfo: 0x43500001 };
/** MINIDUMP_MODULE is a fixed 108 bytes on both 32- and 64-bit dumps. */
const MODULE_RECORD_BYTES = 108;

/** Exception codes worth naming, because the number alone hides the difference. */
const KNOWN_CODES = new Map([
  [0xc0000005, "EXCEPTION_ACCESS_VIOLATION — a read/write of an address the process does not own"],
  [0xc00000fd, "EXCEPTION_STACK_OVERFLOW"],
  [0xc000001d, "EXCEPTION_ILLEGAL_INSTRUCTION"],
  [0xc0000094, "EXCEPTION_INT_DIVIDE_BY_ZERO"],
  // Seen on a real dump while validating this against files it did not construct:
  // a bare 0xC0000006 printed no gloss, and it is a genuinely different diagnosis
  // from an access violation — the pager could not read the page, classically a
  // failing disk or a network mapping that went away, not a pointer bug.
  [0xc0000006, "EXCEPTION_IN_PAGE_ERROR — the pager could not read a page (failing disk, or a mapping that went away), NOT a pointer bug"],
  [0xc0000409, "STATUS_STACK_BUFFER_OVERRUN — /GS or __fastfail; a corruption CHECK fired, so the address is the check site, not the bug"],
  [0xc0000374, "STATUS_HEAP_CORRUPTION — the heap detected damage done EARLIER; the faulting module is where it was noticed, not where it happened"],
  [0x80000003, "EXCEPTION_BREAKPOINT — a deliberate __debugbreak/abort, NOT a memory fault"],
  [0xe0000008, "a RAISED exception (RaiseException), not a hardware fault"],
  [0x0517a7ed, "Crashpad's SIMULATED code — a dump someone REQUESTED, not a crash"],
]);

/** MINIDUMP_STRING: a u32 byte length followed by UTF-16LE. */
/**
 * A Crashpad MinidumpUTF8String: u32 byte length, then UTF-8, then a NUL.
 * Bounds-checked because these RVAs come from a file that may be truncated or
 * simply not the shape claimed — a diagnostic must not throw on a bad dump.
 */
function readAnnotationString(buf, rva) {
  if (!rva || rva + 4 > buf.length) return null;
  const len = buf.readUInt32LE(rva);
  if (len > 4096 || rva + 4 + len > buf.length) return null;
  return buf.toString("utf8", rva + 4, rva + 4 + len);
}

function readMinidumpString(buf, rva) {
  if (!rva || rva + 4 > buf.length) return "";
  const bytes = buf.readUInt32LE(rva);
  return buf.toString("utf16le", rva + 4, Math.min(rva + 4 + bytes, buf.length));
}

/**
 * Parse a minidump into the facts above.
 *
 * Returns `{ error }` rather than throwing for anything unreadable — a truncated
 * or non-minidump file is a normal thing to be handed when someone is chasing a
 * crash, and it must not look like a tool failure.
 */
export function readMinidump(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return { error: "file is too small to be a minidump" };
  if (buf.readUInt32LE(0) !== MDMP_SIGNATURE) return { error: "not a minidump (no MDMP signature)" };

  const streamCount = buf.readUInt32LE(8);
  const directoryRva = buf.readUInt32LE(12);
  const streams = new Map();
  let directoryTruncated = false;
  for (let i = 0; i < streamCount; i += 1) {
    const at = directoryRva + i * 12;
    if (at + 12 > buf.length) {
      // The header PROMISED streamCount entries and the file does not carry them.
      // Breaking silently here produced a normal-looking result from an incomplete
      // file, which is the one thing this reader must not do: its whole job is to
      // say WHICH crash a dump is, and half a dump cannot answer that.
      directoryTruncated = true;
      break;
    }
    const sType = buf.readUInt32LE(at);
    const sSize = buf.readUInt32LE(at + 4);
    const sRva = buf.readUInt32LE(at + 8);
    // The DIRECTORY can be complete while the DATA it points at is not — which is
    // what a real truncated dump looks like: the header and directory land in the
    // first pages and the payload is missing. Detecting only a short directory
    // therefore missed the actual case (measured: a 60,000-byte prefix of a real
    // dump has an intact directory and a crashpad stream at rva 73,928).

    if (sRva + sSize > buf.length) directoryTruncated = true;
    streams.set(sType, { size: sSize, rva: sRva });
  }

  const out = { streamCount, modules: [], annotations: {}, truncated: directoryTruncated };

  const exception = streams.get(STREAM_TYPE.exception);
  if (exception && exception.rva + 40 <= buf.length) {
    const record = exception.rva + 8; // past ThreadId + alignment
    const code = buf.readUInt32LE(record);
    const address = buf.readBigUInt64LE(record + 16);
    out.exception = {
      code,
      codeHex: "0x" + code.toString(16).toUpperCase().padStart(8, "0"),
      meaning: KNOWN_CODES.get(code) ?? null,
      address,
      addressHex: "0x" + address.toString(16),
    };
  }

  const moduleList = streams.get(STREAM_TYPE.moduleList);
  if (moduleList && moduleList.rva + 4 <= buf.length) {
    const count = buf.readUInt32LE(moduleList.rva);
    for (let i = 0; i < count; i += 1) {
      const at = moduleList.rva + 4 + i * MODULE_RECORD_BYTES;
      if (at + MODULE_RECORD_BYTES > buf.length) break;
      out.modules.push({
        base: buf.readBigUInt64LE(at),
        size: buf.readUInt32LE(at + 8),
        name: readMinidumpString(buf, buf.readUInt32LE(at + 20)),
      });
    }
    if (out.exception) {
      const addr = out.exception.address;
      const owner = out.modules.find((m) => addr >= m.base && addr < m.base + BigInt(m.size));
      // NULL, not "unknown": an address inside no loaded module is itself a
      // finding (a jump through a freed pointer), and collapsing it into the
      // same answer as "we could not read the module list" would hide that.
      out.faultingModule = owner ? { name: owner.name, offset: "0x" + (addr - owner.base).toString(16) } : null;
    }
  }

  const systemInfo = streams.get(STREAM_TYPE.systemInfo);
  if (systemInfo && systemInfo.rva + 20 <= buf.length) {
    out.system = {
      major: buf.readUInt32LE(systemInfo.rva + 8),
      minor: buf.readUInt32LE(systemInfo.rva + 12),
      build: buf.readUInt32LE(systemInfo.rva + 16),
    };
  }

  // Crashpad's SIMPLE annotation dictionary (#2023). Electron writes the product
  // and the Chromium/Electron version here, which is the correlator a text-stack
  // crash needs: two reports are only the same bug if they are the same renderer.
  //
  // Only the simple dictionary is read. Crashpad ALSO carries per-module annotation
  // objects (where `ptype` lives, naming browser vs renderer vs gpu-process), but
  // that structure is nested differently and a first attempt at it read garbage
  // memory. A diagnostic that prints rubbish is worse than one that omits a field,
  // so it is left unread rather than guessed at.
  const crashpad = streams.get(STREAM_TYPE.crashpadInfo);
  if (crashpad && crashpad.rva + 48 <= buf.length) {
    // version u32 | report_id 16 | client_id 16 | simple_annotations {size,rva}
    const dictRva = buf.readUInt32LE(crashpad.rva + 4 + 16 + 16 + 4);
    if (dictRva && dictRva + 4 <= buf.length) {
      const count = buf.readUInt32LE(dictRva);
      if (count > 0 && count <= 64) {
        for (let i = 0; i < count; i++) {
          const e = dictRva + 4 + i * 8;
          if (e + 8 > buf.length) break;
          const k = readAnnotationString(buf, buf.readUInt32LE(e));
          const v = readAnnotationString(buf, buf.readUInt32LE(e + 4));
          if (k && v !== null) out.annotations[k] = v;
        }
      }
    }
  }
    // PER-MODULE annotation OBJECTS, where Chromium writes `ptype` — browser vs
    // renderer vs gpu-process. For panel#2023 that is the triage question before any
    // other line matters: a renderer crash needs the RENDERER's dump, and a
    // gpu-process dump describes a different fault with equal confidence.
    //
    // Layout, derived from a real dump rather than guessed (a first attempt read the
    // entries as RVAs and printed garbage memory):
    //   CrashpadInfo.module_list -> {u32 count, entries[{u32 index, LOC{size,rva}}]}
    //   entry.loc.rva -> ModuleCrashpadInfo {u32 version, LOC list, LOC simple, LOC objects}
    //   objects.rva -> {u32 count, MinidumpAnnotation[12 bytes each]}
    //   MinidumpAnnotation = {u32 name_rva, u16 type, u16 reserved, u32 value_rva}
    // The entries are INLINE structs, not a list of RVAs. That was the whole error.
    // Bounds-checked like every other read in this file. It was not, and on a
    // TRUNCATED dump -- an interrupted upload, a partially written crash file, the
    // exact thing a reporter is most likely to hand over -- `crashpad.rva + 44` can
    // sit past the end and readUInt32LE throws. The CLI then died with a Node
    // RangeError stack trace instead of saying the file is incomplete.
    const crashpadModListAt = crashpad ? crashpad.rva + 4 + 16 + 16 + 8 + 4 : 0;
    const modListRva =
      crashpad && crashpadModListAt + 4 <= buf.length ? buf.readUInt32LE(crashpadModListAt) : 0;
    if (modListRva && modListRva + 4 <= buf.length) {
      const modCount = buf.readUInt32LE(modListRva);
      for (let m = 0; m < Math.min(modCount, 16); m++) {
        const entry = modListRva + 4 + m * 12;
        if (entry + 12 > buf.length) break;
        const miRva = buf.readUInt32LE(entry + 8);
        if (!miRva || miRva + 28 > buf.length) continue;
        const objRva = buf.readUInt32LE(miRva + 4 + 8 + 8 + 4);
        if (!objRva || objRva + 4 > buf.length) continue;
        const objCount = buf.readUInt32LE(objRva);
        if (objCount === 0 || objCount > 64) continue;
        for (let k = 0; k < objCount; k++) {
          const a = objRva + 4 + k * 12;
          if (a + 12 > buf.length) break;
          const name = readAnnotationString(buf, buf.readUInt32LE(a));
          const value = readAnnotationString(buf, buf.readUInt32LE(a + 8));
          if (name && value !== null) out.annotations[name] = value;
        }
      }
    }
  return out;
}

/** The text a bug report should carry. Kept separate so it is testable. */
export function describeMinidump(name, dump) {
  // A TRUNCATED file is answered as such, before anything else. The header declared
  // more streams than the file carries, so every absence below is unexplained: the
  // exception record may simply not be present yet. Rendering "not a crash dump" for
  // it would be this tool asserting the one thing it cannot know -- and a reporter
  // handing over a partially uploaded dump is exactly who reads that line.
  if (dump && dump.truncated) {
    return (
      `=== ${name} ===` + String.fromCharCode(10) +
      `  TRUNCATED — the header declares ${dump.streamCount} stream(s) and the file does not` +
      String.fromCharCode(10) +
      "             carry them. Nothing below can be concluded; re-copy the .dmp in full."
    );
  }
  const LF = String.fromCharCode(10);
  const lines = [`=== ${name} ===`];
  if (dump.error) return [...lines, `  ${dump.error}`].join("\n");
  if (dump.system) lines.push(`  Windows ${dump.system.major}.${dump.system.minor} build ${dump.system.build}`);
  if (dump.exception) {
    lines.push(`  exception  ${dump.exception.codeHex} at ${dump.exception.addressHex}`);
    if (dump.exception.meaning) lines.push(`             ${dump.exception.meaning}`);
  } else {
    lines.push("  exception  <none recorded — not a crash dump>");
  }
  if (dump.faultingModule) {
    lines.push(`  faulting   ${dump.faultingModule.name}+${dump.faultingModule.offset}`);
  } else if (dump.faultingModule === null) {
    // STRICT null. The parser distinguishes "the address is in no module" (a
    // finding: a jump through a freed pointer) from "the module list could not be
    // read" (undefined, a gap in what we know) and says so in its own comment --
    // and this line used to collapse them with a truthiness test, reporting the
    // first for both. That turns a missing stream into a false diagnosis.
    lines.push("  faulting   <the address is inside NO loaded module>");
  } else if (dump.exception) {
    lines.push("  faulting   <unknown — the module list could not be read>");
  }
  const text = dump.modules.filter((m) => /dwrite|d2d1|dcomp|gdi32/i.test(m.name));
  lines.push(
  // WHICH PROCESS crashed. MINIDUMP_MODULE_LIST puts the main image first, so
  // module[0] names the executable. Worth printing because a dump can arrive from
  // the wrong place entirely -- another Electron app's Crashpad directory looks
  // identical on disk, and a browser/GPU process dump is not the renderer one a
  // renderer crash needs. Without this the report is confidently about a file
  // nobody has confirmed is the right file.
  `  process    ${dump.modules[0]?.name ?? "<no module list>"}
` +
    // The Electron/Chromium build, when the dump carries Crashpad annotations. Two
    // WHICH PROCESS TYPE, when Chromium wrote it. For panel#2023 this is the first
    // line to read: a renderer crash needs the RENDERER's dump, and a browser- or
    // gpu-process dump describes a different fault with exactly the same confidence.
    (dump.annotations?.ptype || dump.annotations?.process_type
      ? `  proc type  ${dump.annotations.ptype ?? dump.annotations.process_type}
`
      : "") +
    // text-stack crashes are only the SAME bug if they are the same renderer, and an
    // app version does not give that.
    (dump.annotations?.prod || dump.annotations?.ver
      ? `  built by   ${dump.annotations.prod ?? "?"} ${dump.annotations.ver ?? "?"}
`
      : "") +
    `  modules    ${dump.modules.length} loaded` +
      (text.length
        ? `; text-rendering DLLs LOADED (module list, NOT call stack): ${text.map((m) => m.name.split(/[\\/]/).pop()).join(", ")}`
        : "; no DirectWrite/Direct2D loaded"),
  );
  // panel#2023 asks ONE question -- is the faulting module a text-rendering DLL --
  // and the module list answers a different one. DWrite.dll is loaded in every GUI
  // process (present in all three real Comfy Desktop dumps on the machine this was
  // written on, including a 37-module one), so listing it carries no discriminating
  // value and reads, to someone scanning for 'DWrite', exactly like a hit. State the
  // verdict instead of leaving it to be inferred from a list.
  if (dump.faultingModule) {
    const faultingIsText = /dwrite|d2d1|dcomp|gdi32/i.test(dump.faultingModule.name);
    // The NEGATIVE branch must not conclude "not panel#2023". That issue's own dump
    // faults at `Comfy Desktop.exe+0x4147f6e` with DWrite.dll TEN FRAMES UP the call
    // stack -- so the canonical instance of the bug has a non-text faulting module,
    // and the old wording answered it "not the panel#2023 shape". A false negative on
    // the one case this exists to recognise.
    //
    // This parser reads the exception record and the module list. It does not walk
    // the call stack, so it cannot see a text DLL that is a CALLER rather than the
    // fault site, and must not pronounce on a hypothesis that lives there.
    lines.push(
      faultingIsText
        ? '  verdict    the FAULTING module is a text-rendering DLL -- consistent with panel#2023'
        : '  verdict    the faulting module is NOT a text-rendering DLL. This does NOT rule out'
          + LF + '             panel#2023: its own dump faults inside Comfy Desktop.exe with DWrite'
          + LF + '             ten frames up the stack, which this reader does not walk.',
    );
  } else {
    lines.push('  verdict    <no faulting module resolved -- cannot say either way>');
  }
  return lines.join("\n");
}

// Run the CLI only when THIS file is the entry point. Comparing URLs rather than
// matching the path's tail: the tail test made the script silent the moment it was
// copied or renamed -- it printed nothing and exited 0, which is indistinguishable
// from "ran fine, found nothing". That matters because the whole point of this file
// is to be handed to a reporter, who will put it wherever they put it.
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node scripts/read-minidump.mjs <file.dmp> [more.dmp …]");
    console.error("Windows Crashpad dumps live under %APPDATA%/<app>/Crashpad/reports/.");
    process.exit(2);
  }
  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch (err) {
      console.log(describeMinidump(file, { error: `could not read: ${err.message}` }));
      continue;
    }
    console.log(describeMinidump(file, readMinidump(buf)));
    console.log("");
  }
}
