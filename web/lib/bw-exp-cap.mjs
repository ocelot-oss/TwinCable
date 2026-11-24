// The same overlay 93 checks as native/retro-host/nds-level-cap.h.
const base = 0x02000000;
const half = (ram, o) => ram[o] | (ram[o + 1] << 8);
const branch = (op) => op === 0xd300 || op === 0xdb00;

function call(ram, o) {
  const hi = half(ram, o), lo = half(ram, o + 2);
  if ((hi & 0xf800) !== 0xf000 || (lo & 0xf800) !== 0xf800) return 0;
  const delta = ((hi & 0x7ff) << 12) | ((lo & 0x7ff) << 1);
  return base + o + 4 + ((delta << 9) >> 9);
}

function findGuard(ram) {
  let guard = 0;
  for (let fn = 0x1d5000; fn < 0x1d8400; fn += 2) {
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
        const growth = call(ram, j);
        if (growth < 0x02017000 || growth >= 0x0201a000) continue;
        for (let k = fn + 440; k < fn + 462; k += 2) {
          if (call(ram, k) !== growth) continue;
          if (guard && guard !== site) return 0;
          guard = site;
        }
      }
    }
  }
  return guard;
}

export function bwExpCap() {
  let guard = 0, previous = 100;
  return (ram, cap) => {
    if (ram.length !== 0x400000 || !Number.isInteger(cap) || cap < 1 || cap > 100) return false;
    if (!guard && cap !== 100) guard = findGuard(ram);
    if (!guard || (ram[guard + 1] & 0xf8) !== 0x28 || (ram[guard] !== 100 && ram[guard] !== previous) ||
      !branch(half(ram, guard + 2)) || (half(ram, guard + 4) & 0xf800) !== 0xe000) return false;
    ram[guard] = cap;
    previous = cap;
    return true;
  };
}
