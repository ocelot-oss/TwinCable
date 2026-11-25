// The same overlay 93 checks as native/retro-host/nds-level-cap.h.
const base = 0x02000000;
const scanEnd = 0x1d8400;
const signatureSize = 484;
export const BW_EXP_START = 0x1d5000;
export const BW_EXP_END = scanEnd + signatureSize;
const half = (ram, o) => ram[o] | (ram[o + 1] << 8);
const branch = (op) => op === 0xd300 || op === 0xdb00;

function call(ram, o, offset) {
  const hi = half(ram, o), lo = half(ram, o + 2);
  if ((hi & 0xf800) !== 0xf000 || (lo & 0xf800) !== 0xf800) return 0;
  const delta = ((hi & 0x7ff) << 12) | ((lo & 0x7ff) << 1);
  return base + offset + o + 4 + ((delta << 9) >> 9);
}

function ceilingCall(ram, o, offset) {
  const load = half(ram, o);
  // GetMaxLevelExp tail-calls the growth function through a Thumb pointer.
  if ((load & 0xff00) === 0x4b00 && half(ram, o + 2) === 0x2264 && half(ram, o + 4) === 0x4718) {
    const literal = ((o + 4) & ~3) + (load & 0xff) * 4;
    if (literal <= o + 20) return (half(ram, literal) | (half(ram, literal + 2) << 16)) & ~1;
  }
  return call(ram, o, offset);
}

export function findBwExpGuard(ram, offset = 0) {
  let guard = 0;
  const start = Math.max(0, BW_EXP_START - offset);
  const end = Math.min(ram.length - signatureSize + 1, scanEnd - offset);
  for (let fn = start; fn < end; fn += 2) {
    if (ram[fn + 1] !== 0xb5) continue;
    for (let i = 4; i < 32; i += 2) {
      const site = fn + i, cmp = half(ram, site), jump = half(ram, site + 4);
      if ((cmp & 0xf8ff) !== 0x2864 || !branch(half(ram, site + 2)) || (jump & 0xf800) !== 0xe000) continue;
      const bailout = i + 8 + (jump & 0x7ff) * 2;
      if (bailout < 396 || bailout >= 436) continue;
      const load = 0x7e00 | ((cmp >> 8) & 7);
      let level = false;
      for (let j = fn + 2; j < site; j += 2) if ((half(ram, j) & 0xffc7) === load) level = true;
      if (!level) continue;
      for (let j = site + 6; j < fn + 72; j += 2) {
        const growth = call(ram, j, offset);
        if (growth < 0x02017000 || growth >= 0x0201a000) continue;
        for (let k = fn + 440; k < fn + 462; k += 2) {
          if (ceilingCall(ram, k, offset) !== growth) continue;
          if (guard && guard !== site) return 0;
          guard = site;
        }
      }
    }
  }
  return guard;
}

export function isBwExpGuard(bytes, previous) {
  return bytes.length >= 6 && (bytes[1] & 0xf8) === 0x28 && (bytes[0] === 100 || bytes[0] === previous) &&
    branch(half(bytes, 2)) && (half(bytes, 4) & 0xf800) === 0xe000;
}

export function bwExpCap() {
  let guard = 0, previous = 100;
  return (ram, cap) => {
    if (ram.length !== 0x400000 || !Number.isInteger(cap) || cap < 1 || cap > 100) return false;
    if (guard && !isBwExpGuard(ram.subarray(guard, guard + 6), previous)) guard = 0;
    if (!guard && cap !== 100) guard = findBwExpGuard(ram);
    if (!guard) return false;
    ram[guard] = cap;
    previous = cap;
    return true;
  };
}
