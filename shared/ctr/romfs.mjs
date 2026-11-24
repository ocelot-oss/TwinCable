// A Nintendo 3DS game's RomFS (its file system): where level 3 – the game's own directory and file tables and the file
// data – starts in a game file, and the list of its files. Used by "music from the ROM" (shared/ctr/rommusic.mjs): the
// emulator reports the game's RomFS reads as offsets from the start of level 3, and this list turns them into "file X,
// byte Y". Everything comes from the RomFS itself – any language, update, ROM hack or LayeredFS mod lists its own files.
//
// Level 3 layout (3dbrew "RomFS"): a 0x28-byte header – u32 header size (0x28), then offset/length pairs of the
// directory hash table, the directory metadata table, the file hash table, the file metadata table, and u32 the file
// data offset – all from the start of level 3. Directory entry: u32 parent, next sibling, first child dir, first file,
// next in hash bucket, name length (bytes), UTF-16 name. File entry: u32 parent, next sibling, u64 data offset (from the
// file data offset), u64 size, u32 next in hash bucket, name length, UTF-16 name.
//
// `readAt(offset, length)` returns the bytes there (a Uint8Array, shorter at the end of the file, or null).

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 0x100000000;
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const NONE = 0xffffffff;
/** Tables bigger than this are damage, not a game (Sun: ~0.2 MB of file entries for ~30 000 files). */
export const MAX_TABLE = 16 * 1024 * 1024;

/** The NCCH of a game file: its offset (a .3ds/.cci cartridge image's partition 0, a .cia's first content, a .cxi). */
export function ncchOffset(readAt) {
  const h = readAt(0, 0x200);
  if (!h || h.length < 0x200) return -1;
  if (tag(h, 0x100) === 'NCSD') {
    const unit = 0x200 * 2 ** (h[0x188 + 6] || 0);
    return u32(h, 0x120) * unit;
  }
  if (tag(h, 0x100) === 'NCCH') return 0;
  if (u32(h, 0) === 0x2020) {
    // CIA: header, certificates, ticket, TMD, then the contents (the meta block comes after them) – each part aligned
    // to 64 bytes; content 0 is the game
    const align = (n) => Math.ceil(n / 64) * 64;
    const tmdOff = align(0x2020) + align(u32(h, 0x08)) + align(u32(h, 0x0c));
    const off = tmdOff + align(u32(h, 0x10));
    const tmd = readAt(tmdOff, 0x4 + 0x200);
    // (content 0 encrypted with the title key: twincable has no keys – its RomFS isn't readable)
    const sig = tmd && tmd.length >= 4 ? { 0x10000: 0x240, 0x10001: 0x140, 0x10002: 0x80, 0x10003: 0x240, 0x10004: 0x140, 0x10005: 0x80 }[u32be(tmd, 0)] : 0;
    if (!sig) return -1;
    const chunk = readAt(tmdOff + sig + 0xc4 + 0x900, 0x30);
    if (!chunk || chunk.length < 8 || chunk[7] & 1) return -1;
    const n = readAt(off, 0x200);
    return n && n.length >= 0x200 && tag(n, 0x100) === 'NCCH' ? off : -1;
  }
  return -1;
}

/**
 * Where level 3 of the game's RomFS starts in the file: { base, size } – or null (no RomFS, encrypted, damaged). An
 * NCCH's RomFS is an IVFC tree; level 3 starts after the IVFC header and the master hash, aligned to its block size.
 */
export function romfsLevel3(readAt, at = ncchOffset(readAt)) {
  if (at < 0) return null;
  const h = readAt(at, 0x200);
  if (!h || h.length < 0x200 || tag(h, 0x100) !== 'NCCH') return null;
  if (!(h[0x18f] & 0x04)) return null; // encrypted contents ("NoCrypto" not set)
  const unit = 0x200 * 2 ** (h[0x188 + 6] || 0);
  const off = at + u32(h, 0x1b0) * unit;
  if (!u32(h, 0x1b4)) return null;
  const ivfc = readAt(off, 0x60);
  if (!ivfc || ivfc.length < 0x60 || tag(ivfc, 0) !== 'IVFC') return null;
  const l3Block = 2 ** u32(ivfc, 0x4c);
  const base = off + Math.ceil((0x60 + u32(ivfc, 0x08)) / l3Block) * l3Block;
  return { base, size: u64(ivfc, 0x44) };
}

/** Level 3's header (the first 0x28 bytes): the tables' places, or null. */
export function romfsHeader(b) {
  if (!b || b.length < 0x28 || u32(b, 0) !== 0x28) return null;
  const h = { dirMeta: { off: u32(b, 0x0c), len: u32(b, 0x10) }, fileMeta: { off: u32(b, 0x1c), len: u32(b, 0x20) }, data: u32(b, 0x24) };
  if (h.dirMeta.len > MAX_TABLE || h.fileMeta.len > MAX_TABLE || h.dirMeta.len < 0x18) return null;
  return h;
}

/** A RomFS name is at most 255 UTF-16 units (the 3DS' FS limit) – a longer length field is damage. */
export const MAX_NAME = 255;
/** A path deeper or longer than this isn't walked further (no game nests more than a handful of folders). */
const MAX_DEPTH = 64;
const MAX_PATH = 1024;
/** All the paths of a walk together, in characters (Sun: ~1.2 M for ~30 000 files) – the rest is damage. */
const MAX_CHARS = 32 * 1024 * 1024;

const name16 = (b, o, len) => {
  const n = Math.min(len >>> 1, MAX_NAME, Math.max(0, (b.length - o) >> 1));
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(u16(b, o + i * 2));
  return s;
};

/**
 * Every file of the RomFS: [{ path ('sound/bgm_xy_starting.aac', no leading slash), start, size }] sorted by start –
 * `start` from the beginning of level 3, as the emulator reports reads. `dirs` / `files`: the two metadata tables.
 * Damaged entries end the walk of their directory, never throw: every directory and file entry is visited once at most
 * (a sibling list that points back into itself ends there), names are cut at MAX_NAME, paths at MAX_PATH, the whole walk
 * at `max` files and MAX_CHARS characters – damaged or hostile tables cost no more than a real game's.
 */
export function romfsFiles(header, dirs, files, { max = 200000 } = {}) {
  const out = [];
  if (!header || !dirs || !files) return out;
  const seenDirs = new Set();
  const seenFiles = new Set();
  let chars = 0;
  let dirsLeft = 100000;
  const full = () => out.length >= max || chars > MAX_CHARS;
  const walk = (dir, prefix, depth) => {
    for (let f = u32(dirs, dir + 0x0c); f !== NONE && !full(); f = u32(files, f + 0x04)) {
      if (f + 0x20 > files.length || seenFiles.has(f)) break;
      seenFiles.add(f);
      const path = prefix + name16(files, f + 0x20, u32(files, f + 0x1c));
      chars += path.length;
      out.push({ path, start: header.data + u64(files, f + 0x08), size: u64(files, f + 0x10) });
    }
    if (depth >= MAX_DEPTH || prefix.length > MAX_PATH) return;
    for (let d = u32(dirs, dir + 0x08); d !== NONE && !full(); d = u32(dirs, d + 0x04)) {
      // (checked before its name is built: a list that loops costs one look per entry, not a name per turn)
      if (d + 0x18 > dirs.length || seenDirs.has(d) || --dirsLeft < 0) break;
      seenDirs.add(d);
      const sub = `${prefix}${name16(dirs, d + 0x18, u32(dirs, d + 0x14))}/`;
      chars += sub.length;
      walk(d, sub, depth + 1);
    }
  };
  seenDirs.add(0);
  if (dirs.length >= 0x18) walk(0, '', 0);
  return out.sort((a, b) => a.start - b.start);
}

/** The file holding level-3 offset `off` (binary search in romfsFiles' sorted list), or null. */
export function fileAt(list, off) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = list[mid];
    if (off < f.start) hi = mid - 1;
    else if (off >= f.start + f.size) lo = mid + 1;
    else return f;
  }
  return null;
}

/**
 * The RomFS file list of a game file (readAt over the whole file): { base, size, files } – `base` where level 3 starts
 * in the file (a file's bytes are at base + start) – or null. Never throws.
 */
export function romfsOfFile(readAt) {
  try {
    const l3 = romfsLevel3(readAt);
    if (!l3) return null;
    const header = romfsHeader(readAt(l3.base, 0x28));
    if (!header) return null;
    const dirs = readAt(l3.base + header.dirMeta.off, header.dirMeta.len);
    const files = readAt(l3.base + header.fileMeta.off, header.fileMeta.len);
    if (!dirs || !files) return null;
    return { base: l3.base, size: l3.size, files: romfsFiles(header, dirs, files) };
  } catch {
    return null;
  }
}
