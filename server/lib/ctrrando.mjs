// Randomizing Nintendo 3DS games (Gen 6: X/Y, Omega Ruby/Alpha Sapphire; Gen 7: Sun/Moon, Ultra Sun/Ultra Moon) with
// the bundled Universal Pokemon Randomizer ZX – the same jar and bridge as Gen 1–5 (server/lib/toolchain.mjs), only
// with UPR ZX's Gen6/Gen7RomHandler. What goes in and comes out:
//
//   in   a decrypted .3ds / .cci (cartridge image), .cxi or .cia from the library. UPR reads the game's NCCH
//        partition; an encrypted dump it can't read (twincable has no Nintendo keys and decrypts nothing) ends in
//        the error code 'ctrEncrypted' – the player needs a decrypted dump.
//   out  one rebuilt, self-contained .cxi (~3 GB for Sun) in the run folder: the built-in player (Azahar's libretro
//        core) and Azahar itself start it like any other 3DS game file – no LayeredFS mod folder to install, and two
//        runs of the same game never overwrite each other's mods. The same seed + settings + game give the same bytes
//        on every computer, so its SHA-1 is compared on a SoulLink join like a Gen 1–5 ROM's.
//
// This module holds the pieces build.mjs needs around the bridge call: the space check, the progress the bridge
// prints, hashing the big output off the main thread, and turning the bridge's error codes into messages.
import { openSync, readSync, closeSync, statSync, statfsSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { httpError } from './fsutil.mjs';
import { randomizerError } from './toolchain.mjs';

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/**
 * Size of the game's own NCCH partition (what UPR rebuilds) from a 3DS file's header – the rest of a cartridge image
 * is padding, manual and update partitions. Falls back to the file size (a .cia, an unreadable header).
 */
export function ncchSizeOf(path) {
  let fd;
  try {
    const size = statSync(path).size;
    fd = openSync(path, 'r');
    const h = Buffer.alloc(0x200);
    if (readSync(fd, h, 0, 0x200, 0) < 0x200) return size;
    if (tag(h, 0x100) === 'NCSD') {
      const unit = 0x200 * 2 ** (h[0x188 + 6] || 0);
      const n = u32(h, 0x124) * unit; // partition 0: offset 0x120, size 0x124 (media units)
      return n > 0 && n <= size ? n : size;
    }
    if (tag(h, 0x100) === 'NCCH') {
      const unit = 0x200 * 2 ** (h[0x188 + 6] || 0);
      const n = u32(h, 0x104) * unit;
      return n > 0 && n <= size ? n : size;
    }
    return size;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Free bytes on the drive of `dir`, or null if the system can't tell. */
export function freeBytes(dir, statfs = statfsSync) {
  try {
    const s = statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Room UPR needs besides the output: the game files it unpacks into its working folder while it runs. */
export const CTR_WORK_MARGIN = 768 * 1024 * 1024;

/**
 * Throw a clear 507 when the drive can't hold `count` rebuilt games of `ncchSize` bytes (+ UPR's working files).
 * Unknown free space (statfs failed) lets the build go on – it then fails at the write with the system's error.
 */
export function checkCtrSpace(dir, ncchSize, count = 1, { free = freeBytes(dir) } = {}) {
  if (free == null || !ncchSize) return;
  const need = ncchSize * count + CTR_WORK_MARGIN;
  if (free < need) {
    const gb = (n) => (n / 1024 ** 3).toFixed(1);
    throw httpError(507, `Not enough disk space: the randomized 3DS games need about ${gb(need)} GB, ${gb(free)} GB are free`, 'ctrNoSpace', { need: gb(need), free: gb(free) });
  }
}

/**
 * The bridge's error codes as messages the app translates (web/lib/errors.mjs); other randomizer failures as for Gen 1–5
 * (a file it couldn't read or write among them – toolchain.mjs ioFailure). `opts`: randomizerError's (tests).
 */
export function ctrRandoError(e, opts) {
  if (e?.status) return e;
  if (e?.code === 'encrypted') {
    return httpError(422, 'This 3DS game is encrypted. The randomizer needs a decrypted copy (.3ds/.cci/.cxi) – twincable doesn’t decrypt games.', 'ctrEncrypted');
  }
  if (e?.code === 'memory') return httpError(507, 'Not enough memory for the 3DS randomizer (it needs up to 4.5 GB)', 'ctrMemory');
  if (e?.code === 'timeout') return httpError(504, 'The 3DS randomizer took too long and was stopped', 'ctrTimeout');
  return randomizerError(e, opts);
}

/**
 * Follows a 3DS bridge run line by line and reports its phases to `report({ phase, done?, total? })`:
 * 'load' (reading the game), 'randomize', 'write' (rebuilding the .cxi – `done` of `total` romfs files, reported in
 * steps of about 5 %), 'finish' (all files written, UPR hashes the new romfs). The lines are the bridge's @@STEP / @@FILES and UPR ZX's NCCH output ("NCCH: Rebuilding
 * exefs...", one "NCCH: Writing file … to romfs" per file).
 */
export function ctrProgress(report) {
  let total = 0;
  let done = 0;
  let lastPct = -1;
  return (line) => {
    const step = /^@@STEP "(\w+)"/.exec(line);
    if (step) return report({ phase: step[1] });
    const files = /^@@FILES (-?\d+)/.exec(line);
    if (files) {
      total = Math.max(0, Number(files[1]));
      return undefined;
    }
    if (line.startsWith('NCCH: Rebuilding exefs')) {
      lastPct = 0;
      return report({ phase: 'write', done: 0, total });
    }
    if (line.startsWith('NCCH: Writing file ')) {
      done++;
      // every file written: UPR now hashes the new romfs (its hash tree) – it reads the ~3 GB back, that takes a while
      if (total && done === total) return report({ phase: 'finish' });
      const pct = total ? Math.floor((done / total) * 20) * 5 : -1;
      if (pct > lastPct) {
        lastPct = pct;
        return report({ phase: 'write', done, total });
      }
    }
    return undefined;
  };
}

/** SHA-1 of a (large) file, streamed – a 3 GB game neither fits a Buffer nor may block the server. */
export function hashFile(path, algorithm = 'sha1') {
  return new Promise((resolve, reject) => {
    const h = createHash(algorithm);
    createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * What the new-run wizard needs to know about a 3DS game (POST /api/rom/inspect): UPR ZX's `info` for it, or why it
 * can't be randomized – { unsupported: true, reason: 'compressed' | 'encrypted' | 'ctr', error? }. `header`: the
 * library's identifyCtr result. `run`: runBridge (tests pass a stand-in).
 */
export async function inspectCtr(path, header, run) {
  // Azahar's compressed .zcci/.zcxi: UPR can't read inside them
  if (header?.compressed) return { unsupported: true, reason: 'compressed' };
  try {
    const res = await run(['info', path], { ctr: true, timeoutMs: 5 * 60 * 1000 });
    if (!res.json) return { unsupported: true, reason: 'ctr' };
    return { ...res.json, system: '3ds' };
  } catch (e) {
    // (an encrypted dump: UPR reads it as encrypted, or the header says so and UPR found nothing it knows)
    if (e?.code === 'encrypted' || (header?.encrypted && !e?.code)) return { unsupported: true, reason: 'encrypted', error: e?.message };
    return { unsupported: true, reason: e?.code === 'memory' ? 'memory' : 'ctr', error: e?.message };
  }
}
