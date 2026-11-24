// Is a 3DS game file whole? A copy that was cut off (twincable closed while it copied a 4 GB game, a download that
// stopped) still has its header – it is recognised, listed as ready and starts – but the game behind it is missing,
// and the player sees a black screen (ticket #19). The game's own hashes tell: the NCCH header holds SHA-256 hashes of
// the ExeFS's and the RomFS's first bytes, and the RomFS is a hash tree (IVFC: level 3 = the files, level 2 = a hash
// per level-3 block, level 1 = a hash per level-2 block, the master hash over level 1). Here: the two header hashes,
// the master hash over level 1's first block, and samples of level 3 spread over the whole file (the last block
// always) against their level-2 hashes – a few dozen 4 KB reads, never the whole file.
//
// Physical layout of the RomFS (3dbrew "RomFS"): the IVFC header and the master hash, level 3 (aligned to its block
// size), then level 1, then level 2 – so a file cut off anywhere after the first few MB loses level 2 and the samples
// fail. Checked on a retail cartridge image and on UPR ZX's randomized .cxi (it rebuilds the tree correctly).
//
// `readAt(offset, length)` returns the bytes there (shorter at the end of the file); `sha256(bytes)` → hex.

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 0x100000000;
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const align = (n, a) => Math.ceil(n / a) * a;
const allZero = (b) => {
  for (let i = 0; i < b.length; i++) if (b[i]) return false;
  return true;
};

/** Level-3 blocks sampled (spread evenly; the first and the last always). */
export const CTR_SAMPLES = 40;
/**
 * The most bytes a header hash region is read and hashed for (real ones: 0x200 for the ExeFS, a few KB for the RomFS).
 * A header that says more is damaged or made up – its region is left unchecked instead of read and hashed in one go.
 */
export const CTR_MAX_HASH_REGION = 1024 * 1024;

/**
 * { state, why } – state 'ok' (every hash checked matched), 'damaged' (the game is missing parts: the file ends early, or
 * where its hashes say data is there are only zeros – a copy that was cut off), 'mismatch' (hashes that don't match over
 * data that is there – a modified game whose tools left old hashes; it may well run, so it is only reported), or
 * 'unchecked' (no NCCH twincable can check: encrypted, a .cia / .3dsx, compressed, unknown). `why` names the first
 * finding. Never throws.
 */
export function ctrIntegrity(readAt, fileSize, sha256, { samples = CTR_SAMPLES } = {}) {
  const res = (state, why = null) => ({ state, why });
  try {
    if (!(fileSize > 0)) return res('unchecked', 'size');
    let h = readAt(0, 0x200);
    if (!h || h.length < 0x200) return res('damaged', 'header');
    let n = 0;
    if (tag(h, 0x100) === 'NCSD') {
      const unit = 0x200 * 2 ** (h[0x188 + 6] || 0);
      n = u32(h, 0x120) * unit;
      const end = n + u32(h, 0x124) * unit;
      if (!n) return res('unchecked', 'partition');
      // (a trimmed dump ends after its last partition – but never before the game's own)
      if (end > fileSize) return res('damaged', 'truncated');
      h = readAt(n, 0x200);
      if (!h || h.length < 0x200) return res('damaged', 'truncated');
    }
    if (tag(h, 0x100) !== 'NCCH') return allZero(h.subarray(0x100, 0x104)) && n ? res('damaged', 'ncch') : res('unchecked', 'format');
    if (!(h[0x18f] & 0x04)) return res('unchecked', 'encrypted');
    const unit = 0x200 * 2 ** (h[0x188 + 6] || 0);
    // the ExeFS: the code – its first bytes against the header's hash
    const exefsOff = u32(h, 0x1a0) * unit;
    const exefsHash = u32(h, 0x1a8) * unit;
    let mismatch = null;
    if (exefsOff && exefsHash && exefsHash <= CTR_MAX_HASH_REGION) {
      const at = n + exefsOff;
      if (at + exefsHash > fileSize) return res('damaged', 'truncated');
      const b = readAt(at, exefsHash);
      if (!b || b.length < exefsHash) return res('damaged', 'truncated');
      if (sha256(b) !== hexOf(h.subarray(0x1c0, 0x1e0))) {
        if (allZero(b)) return res('damaged', 'exefs');
        mismatch ||= 'exefs';
      }
    }
    const romfsOff = u32(h, 0x1b0) * unit;
    const romfsHash = u32(h, 0x1b8) * unit <= CTR_MAX_HASH_REGION ? u32(h, 0x1b8) * unit : 0; // (too big: unchecked)
    if (!romfsOff || !u32(h, 0x1b4)) return res(mismatch ? 'mismatch' : 'ok', mismatch);
    const rf = n + romfsOff;
    if (rf + Math.max(romfsHash, 0x60) > fileSize) return res('damaged', 'truncated');
    const head = readAt(rf, Math.max(romfsHash, 0x60));
    if (!head || head.length < 0x60) return res('damaged', 'truncated');
    if (romfsHash && sha256(head.subarray(0, romfsHash)) !== hexOf(h.subarray(0x1e0, 0x200))) {
      if (allZero(head.subarray(0, 0x60))) return res('damaged', 'romfs');
      mismatch ||= 'romfs';
    }
    if (tag(head, 0) !== 'IVFC') return res(mismatch ? 'mismatch' : 'unchecked', mismatch || 'ivfc');
    const masterSize = u32(head, 0x08);
    const L = [0, 1, 2].map((i) => ({ size: u64(head, 0x14 + i * 0x18), bs: 2 ** u32(head, 0x1c + i * 0x18) }));
    if (L.some((l) => !l.size || l.bs < 0x200 || l.bs > 0x100000) || !masterSize || masterSize > 0x10000) return res(mismatch ? 'mismatch' : 'unchecked', mismatch || 'ivfc');
    const l3 = rf + align(0x60 + masterSize, L[2].bs);
    const l1 = l3 + align(L[2].size, L[2].bs);
    const l2 = l1 + align(L[0].size, L[0].bs);
    // level 2 is the last part of the game: a file that ends before it is cut off
    if (l2 + L[1].size > fileSize) return res('damaged', 'truncated');
    const block = (at, bs, len = bs) => {
      const b = readAt(at, len);
      if (!b || b.length < len) return null;
      if (len === bs) return b;
      const out = new Uint8Array(bs); // (a level's last block is hashed padded with zeros)
      out.set(b);
      return out;
    };
    // level 1's first block against the master hash
    const master = readAt(rf + 0x60, 32);
    const b1 = block(l1, L[0].bs, Math.min(L[0].bs, L[0].size));
    if (!b1 || !master) return res('damaged', 'truncated');
    if (sha256(b1) !== hexOf(master)) {
      if (allZero(b1)) return res('damaged', 'romfs-tree');
      mismatch ||= 'romfs-tree';
    }
    // level 3 samples against level 2
    const blocks = Math.ceil(L[2].size / L[2].bs);
    const picks = new Set([0, blocks - 1]);
    for (let i = 1; i < samples - 1; i++) picks.add(Math.floor((i * (blocks - 1)) / (samples - 1)));
    for (const i of [...picks].sort((a, b) => a - b)) {
      const len = Math.min(L[2].bs, L[2].size - i * L[2].bs);
      const b = block(l3 + i * L[2].bs, L[2].bs, len);
      const want = readAt(l2 + i * 32, 32);
      if (!b || !want || want.length < 32) return res('damaged', 'truncated');
      if (sha256(b) === hexOf(want)) continue;
      // zeros where the game has data or its hashes: the copy stopped there (an interrupted copy may leave a file of
      // the full size whose rest was never written)
      if (allZero(b.subarray(0, len)) || allZero(want)) return res('damaged', 'romfs-data');
      mismatch ||= 'romfs-data';
    }
    return res(mismatch ? 'mismatch' : 'ok', mismatch);
  } catch {
    return res('unchecked', 'error');
  }
}
