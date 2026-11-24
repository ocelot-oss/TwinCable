// Nintendo 3DS game updates (title ID 0004000E + the game's low half): what an update file holds and where its parts
// go on the emulated SD card. Azahar (and its libretro core) loads an installed update by itself whenever the game
// starts – from the game's code onwards it plays the updated version (src/core/loader/ncch.cpp: the update's NCCH at
// sdmc/Nintendo 3DS/<id0>/<id1>/title/0004000e/<low>/content/<id>.app, named by the .tmd next to it – the smallest .tmd
// in that folder is the one it reads, its first content record the .app). twicable installs the update into each
// 3DS save folder itself (server/lib/ctrupdate.mjs): the same files Azahar's "Install CIA" writes for a decrypted CIA
// (the TMD, and each content as it is – Azahar's CIAFile writes an unencrypted NCCH unchanged).
//
//   .cia          the usual form: the TMD names the contents (64-byte aligned after it, in TMD order, only those set in
//                 the CIA header's content index); contents encrypted with the title key (TMD content type bit 0) or an
//                 NCCH without "NoCrypto" can't be installed without Nintendo's keys – twicable has none
//   .cxi / .3ds   an update as a bare NCCH (or a cartridge image whose partition 0 is one): installed with a TMD twicable
//                 writes for it (Azahar reads the content's ID and size from it, no signature or hash is checked)
//
// `readAt(offset, length)` returns the bytes there (a Uint8Array, shorter at the end of the file, or null).

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64be = (b, o) => u32be(b, o) * 0x100000000 + u32be(b, o + 4);
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const hex8 = (n) => n.toString(16).toUpperCase().padStart(8, '0');
const align = (n, a) => Math.ceil(n / a) * a;

/** The SD card's two 32-digit folders Azahar uses (src/core/hle/service/fs/archive.h SYSTEM_ID / SDCARD_ID). */
export const SD_ID = '00000000000000000000000000000000';
/** TMD content type flags (3dbrew "Title metadata"). */
const ENCRYPTED = 0x0001;
const OPTIONAL = 0x4000;
/** A TMD's body after its signature block, and its 64 content info records. */
const BODY = 0xc4;
const INFO_RECORDS = 0x900;
const CHUNK = 0x30;
/** The most contents twicable takes from one update (real ones have one, some two). */
const MAX_CONTENTS = 64;

/** Size of a TMD's signature block (type, signature, padding) by its type – 0 for an unknown one. */
export function sigBlock(type) {
  switch (type) {
    case 0x10000: case 0x10003: return 0x200 + 0x3c + 4;
    case 0x10001: case 0x10004: return 0x100 + 0x3c + 4;
    case 0x10002: case 0x10005: return 0x3c + 0x40 + 4;
    default: return 0;
  }
}

/** A title version as the 3DS and Azahar show it: 2080 → "v2.2.0" (6 bits major, 6 bits minor, 4 bits micro). */
export function titleVersionText(v) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) return '';
  return `v${v >> 10}.${(v >> 4) & 0x3f}.${v & 0xf}`;
}

/** The update title ID of a game ("0004000000164800" → "0004000E00164800"), null for anything that isn't a game's. */
export function updateTitleIdOf(gameTid) {
  const t = String(gameTid || '').toUpperCase();
  return /^00040000[0-9A-F]{8}$/.test(t) ? `0004000E${t.slice(8)}` : null;
}

/** The game an update belongs to ("0004000E00164800" → "0004000000164800"), null for anything that isn't an update. */
export function gameTitleIdOf(updateTid) {
  const t = String(updateTid || '').toUpperCase();
  return /^0004000E[0-9A-F]{8}$/.test(t) ? `00040000${t.slice(8)}` : null;
}

/**
 * The latest update of each Pokémon 3DS game: its title version (UPR ZX's FullyUpdatedVersionNumber,
 * config/gen6_offsets.ini / gen7_offsets.ini) and the version the game shows on its title screen. twicable's live data
 * (shared/data/addresses.json) knows these games in version 1.0 and in their latest update.
 */
export const CTR_LATEST_UPDATE = {
  '0004000000055D00': { version: 5232, name: '1.5' }, // X
  '0004000000055E00': { version: 5216, name: '1.5' }, // Y
  '000400000011C400': { version: 7280, name: '1.4' }, // Omega Ruby
  '000400000011C500': { version: 7280, name: '1.4' }, // Alpha Sapphire
  '0004000000164800': { version: 2112, name: '1.2' }, // Sun
  '0004000000175E00': { version: 2112, name: '1.2' }, // Moon
  '00040000001B5000': { version: 2080, name: '1.2' }, // Ultra Sun
  '00040000001B5100': { version: 2080, name: '1.2' }, // Ultra Moon
};

/**
 * What twicable knows about an update of a game: { versionText ("v2.2.0"), gameVersion ("1.2" – only for a known latest
 * update, else null), latest (true / false; null: a game twicable has no list for), tracking: 'known' (twicable's live data
 * has this version's addresses: no update, or the latest), 'older' (an update before the latest – the team may not be
 * found), 'unknown' (a game twicable has no update list for) }.
 */
export function updateStatus(gameTid, version) {
  const known = CTR_LATEST_UPDATE[String(gameTid || '').toUpperCase()];
  if (version == null) return { versionText: '', gameVersion: null, latest: null, tracking: known ? 'known' : 'unknown' };
  const latest = known ? version >= known.version : null;
  return {
    versionText: titleVersionText(version),
    gameVersion: known && version === known.version ? known.name : null,
    latest,
    tracking: !known ? 'unknown' : latest ? 'known' : 'older',
  };
}

/** NCCH header at `b[o]`: { titleId, size (bytes), encrypted } or null. */
function ncchAt(b, o = 0) {
  if (!b || b.length < o + 0x200 || tag(b, o + 0x100) !== 'NCCH') return null;
  const unit = 0x200 * 2 ** (b[o + 0x188 + 6] || 0);
  return {
    titleId: hex8(u32(b, o + 0x11c)) + hex8(u32(b, o + 0x118)),
    version: b[o + 0x112] | (b[o + 0x113] << 8),
    size: u32(b, o + 0x104) * unit,
    encrypted: !(b[o + 0x18f] & 0x04),
  };
}

class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The parts of an update file: { titleId, version, format ('cia' | 'cxi' | 'cci'), tmd (Uint8Array: the TMD file to
 * write), contents: [{ id (8 hex digits, lower case – the .app's name), offset, size }] (where each content is in the
 * file), optional: whether the contents go one folder deeper (Azahar's rule for DLC – never for an update) }.
 * Throws an Error with `code`: 'notUpdate' (no 3DS update – a game, DLC, anything else), 'encrypted' (encrypted
 * contents), 'invalid' (damaged, cut off, sizes that don't fit the file).
 */
export function updateLayout(readAt, ext, fileSize) {
  ext = String(ext || '').toLowerCase().replace(/^\./, '');
  if (ext === 'cia') return ciaLayout(readAt, fileSize);
  if (['cxi', '3ds', 'cci', 'app'].includes(ext)) return ncchLayout(readAt, fileSize);
  throw new UpdateError('notUpdate', 'not a 3DS update file');
}

function ciaLayout(readAt, fileSize) {
  const h = readAt(0, 0x2020);
  if (!h || h.length < 0x2020 || u32(h, 0) !== 0x2020) throw new UpdateError('invalid', 'no CIA header');
  const certSize = u32(h, 0x08);
  const ticketSize = u32(h, 0x0c);
  const tmdSize = u32(h, 0x10);
  const tmdOff = align(0x2020, 64) + align(certSize, 64) + align(ticketSize, 64);
  if (!tmdSize || tmdSize > 0x100000 || tmdOff + tmdSize > fileSize) throw new UpdateError('invalid', 'TMD out of the file');
  const tmd = readAt(tmdOff, tmdSize);
  if (!tmd || tmd.length < tmdSize) throw new UpdateError('invalid', 'TMD cut off');
  const sig = sigBlock(u32be(tmd, 0));
  if (!sig || tmd.length < sig + BODY + INFO_RECORDS) throw new UpdateError('invalid', 'unknown TMD');
  const titleId = hex8(u32be(tmd, sig + 0x4c)) + hex8(u32be(tmd, sig + 0x50));
  if (!gameTitleIdOf(titleId)) throw new UpdateError('notUpdate', `title ${titleId} is no update`);
  const version = u16be(tmd, sig + 0x9c);
  const count = u16be(tmd, sig + 0x9e);
  if (!count || count > MAX_CONTENTS || tmd.length < sig + BODY + INFO_RECORDS + count * CHUNK) throw new UpdateError('invalid', 'content records');
  // the contents follow the TMD in TMD order – only those the header's content index marks as present (Azahar
  // CIAContainer::GetContentOffset / IsContentPresent: bit i of the index, most significant bit first, for record i)
  let at = align(tmdOff + tmdSize, 64);
  const contents = [];
  const types = [];
  for (let i = 0; i < count; i++) {
    const c = sig + BODY + INFO_RECORDS + i * CHUNK;
    const type = u16be(tmd, c + 6);
    types.push(type);
    if (!(h[0x20 + (i >> 3)] & (0x80 >> (i & 7)))) continue;
    const size = u64be(tmd, c + 8);
    if (!Number.isSafeInteger(size) || at + size > fileSize) throw new UpdateError('invalid', 'content out of the file');
    if (type & ENCRYPTED) throw new UpdateError('encrypted', 'the update is encrypted');
    contents.push({ id: hex8(u32be(tmd, c)).toLowerCase(), offset: at, size });
    at += size;
  }
  if (!contents.length) throw new UpdateError('invalid', 'no content');
  // each content an NCCH that isn't encrypted (Azahar's CheckCIAToInstall checks the same)
  for (const c of contents) {
    const n = ncchAt(readAt(c.offset, 0x200));
    if (!n) throw new UpdateError(c === contents[0] ? 'encrypted' : 'invalid', 'content is no readable NCCH');
    if (n.encrypted) throw new UpdateError('encrypted', 'the update is encrypted');
  }
  return { titleId, version, format: 'cia', tmd, contents, optional: count > 1 && !!(types[1] & OPTIONAL) };
}

function ncchLayout(readAt, fileSize) {
  const h = readAt(0, 0x200);
  if (!h || h.length < 0x200) throw new UpdateError('invalid', 'file too short');
  let offset = 0;
  let format = 'cxi';
  if (tag(h, 0x100) === 'NCSD') {
    format = 'cci';
    const unit = 0x200 * 2 ** (h[0x188 + 6] || 0);
    offset = u32(h, 0x120) * unit;
    if (!offset) throw new UpdateError('invalid', 'no partition 0');
  }
  const n = ncchAt(offset ? readAt(offset, 0x200) : h);
  if (!n) throw new UpdateError(format === 'cci' ? 'encrypted' : 'invalid', 'no readable NCCH');
  if (!gameTitleIdOf(n.titleId)) throw new UpdateError('notUpdate', `title ${n.titleId} is no update`);
  if (n.encrypted) throw new UpdateError('encrypted', 'the update is encrypted');
  if (!n.size || offset + n.size > fileSize) throw new UpdateError('invalid', 'NCCH out of the file');
  const version = n.version;
  return { titleId: n.titleId, version, format, tmd: makeTmd(n.titleId, version, n.size), contents: [{ id: '00000000', offset, size: n.size }], optional: false };
}

/**
 * A TMD for one content (an update that came as a bare NCCH): RSA-2048 signature type with an empty signature, the
 * title ID and version, one content record (ID 0, index 0, its size). Azahar reads only those (TitleMetadata::Load).
 */
export function makeTmd(titleId, version, size) {
  const sig = sigBlock(0x10004);
  const b = new Uint8Array(sig + BODY + INFO_RECORDS + CHUNK);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x10004);
  const issuer = 'Root-CA00000003-CP0000000b';
  for (let i = 0; i < issuer.length; i++) b[sig + i] = issuer.charCodeAt(i);
  dv.setUint32(sig + 0x4c, parseInt(titleId.slice(0, 8), 16));
  dv.setUint32(sig + 0x50, parseInt(titleId.slice(8), 16));
  dv.setUint32(sig + 0x54, 0x40); // title type: CTR
  dv.setUint16(sig + 0x9c, version & 0xffff);
  dv.setUint16(sig + 0x9e, 1);
  dv.setUint16(sig + BODY + 2, 1); // content info record 0: index 0, one command
  const c = sig + BODY + INFO_RECORDS;
  dv.setUint32(c + 8, Math.floor(size / 0x100000000));
  dv.setUint32(c + 12, size >>> 0);
  return b;
}

/**
 * Where an update's files go on the SD card, relative to the folder that holds "Nintendo 3DS" (Azahar's sdmc):
 * { titleDir, tmdDir, appDir } as path parts (Azahar names the folders with lower-case hex: title/0004000e/001b5000;
 * the .tmd in content/, the .apps there too – one folder deeper when the second content is optional, its DLC rule).
 */
export function updatePaths(titleId, { optional = false } = {}) {
  const t = String(titleId).toLowerCase();
  const titleDir = ['Nintendo 3DS', SD_ID, SD_ID, 'title', t.slice(0, 8), t.slice(8)];
  const tmdDir = [...titleDir, 'content'];
  return { titleDir, tmdDir, appDir: optional ? [...tmdDir, '00000000'] : tmdDir };
}

/**
 * The update a game plays with, from the library's update files (scanLibrary's ctrUpdates: { gameTitleId, version,
 * encrypted, detached, name }): the newest one twicable can install – an encrypted one only when there is no other (it
 * is shown, with why it isn't used). null when the library has none for `gameTid`.
 */
export function pickUpdate(updates, gameTid) {
  const tid = String(gameTid || '').toUpperCase();
  const mine = (updates || []).filter((u) => u && !u.detached && u.gameTitleId === tid);
  const rank = (u) => (u.encrypted ? -1 : u.version ?? 0);
  return mine.sort((a, b) => rank(b) - rank(a) || String(a.name).localeCompare(String(b.name)))[0] || null;
}
