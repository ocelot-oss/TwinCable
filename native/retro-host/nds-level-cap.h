// ARM9 Thumb layouts for US HGSS and Platinum. The game's level-up ceiling
// clips awards that would otherwise grant several levels in one battle.
// Battle locations: G4Patcher (Memory5ty7/Kalaay); Platinum ARM9: PokePlat.
#ifndef TWINCABLE_NDS_LEVEL_CAP_H
#define TWINCABLE_NDS_LEVEL_CAP_H
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>

#define NDS_RAM 0x02000000u

struct nds_cap_layout {
  uint32_t gate, getter, level_up, growth_lookup;
};

static const struct nds_cap_layout *nds_cap_layout(const char code[4]) {
  static const struct nds_cap_layout hgss = {0x02245a2cu, 0x0206e540u, 0x02070db4u, 0x0206fd30u};
  static const struct nds_cap_layout platinum = {0x02249008u, 0x02074470u, 0x02076b14u, 0x02075b00u};
  if (!memcmp(code, "IPKE", 4) || !memcmp(code, "IPGE", 4)) return &hgss;
  return !memcmp(code, "CPUE", 4) ? &platinum : NULL;
}

static uint16_t nds_half(const uint8_t *p) {
  return (uint16_t)(p[0] | (p[1] << 8));
}

static uint32_t nds_call_target(const uint8_t *p, uint32_t at) {
  const uint16_t high = nds_half(p), low = nds_half(p + 2);
  if ((high & 0xf800u) != 0xf000u || (low & 0xf800u) != 0xf800u) return false;
  const uint32_t off = ((high & 0x7ffu) << 12) | ((low & 0x7ffu) << 1);
  return at + 4 + off - (off & 0x400000u ? 0x800000u : 0u);
}

static bool nds_calls(const uint8_t *p, uint32_t at, uint32_t target) {
  return nds_call_target(p, at) == target;
}

static bool nds_localized_platinum(const char code[4]) {
  return !memcmp(code, "CPU", 3) && code[3] && strchr("DFIJKPS", code[3]);
}

static bool nds_bw_exp_cap(const char code[4]) {
  return !memcmp(code, "IRBO", 4) || !memcmp(code, "IRAO", 4);
}

// Aletheia ov093: BTL_POKEPARAM_AddExp (IRBO 0x021D69B8) awards at most one
// level per call. The battle server and client both call it again for leftover
// XP. Replacing its level-100 guard stops that loop at the selected level.
// Validate the level field load, the comparison, and both calls to the same
// growth function (AddExp and the immediately following GetMaxLevelExp).
static uint32_t nds_find_bw_exp_guard(const uint8_t *ram) {
  uint32_t guard = 0;
  for (uint32_t at = 0x021d5000; at < 0x021d8400; at += 2) {
    const uint8_t *fn = ram + at - NDS_RAM;
    if (fn[1] != 0xb5) continue;
    for (unsigned i = 4; i < 32; i += 2) {
      const uint16_t cmp = nds_half(fn + i);
      if ((cmp & 0xf8ffu) != 0x2864u) continue;
      const unsigned reg = (cmp >> 8) & 7;
      bool level_load = false;
      for (unsigned j = 2; j < i; j += 2) {
        if ((nds_half(fn + j) & 0xffc7u) == (0x7e00u | reg)) level_load = true;
      }
      const uint16_t branch = nds_half(fn + i + 2), jump = nds_half(fn + i + 4);
      // A short branch enters the award block, skipping the long bailout.
      if (!level_load || (branch != 0xd300u && branch != 0xdb00u) ||
          (jump & 0xf800u) != 0xe000u) continue;
      const unsigned bailout = i + 8 + (jump & 0x7ffu) * 2;
      if (bailout < 396 || bailout >= 436) continue;
      for (unsigned j = i + 6; j < 72; j += 2) {
        const uint32_t growth = nds_call_target(fn + j, at + j);
        if (growth < 0x02017000 || growth >= 0x0201a000) continue;
        bool same_growth = false;
        for (unsigned k = 440; k < 462; k += 2) {
          if (nds_calls(fn + k, at + k, growth)) same_growth = true;
        }
        if (!same_growth) continue;
        if (guard && guard != at + i) return 0;
        guard = at + i;
      }
    }
  }
  return guard;
}

static bool nds_apply_bw_cap(uint8_t *ram, unsigned cap, uint32_t *guard, unsigned *previous) {
  if (!ram || cap < 1 || cap > 100) return false;
  if (!*guard && cap != 100) *guard = nds_find_bw_exp_guard(ram);
  if (!*guard) return false;
  uint8_t *const cmp = ram + *guard - NDS_RAM;
  const uint16_t branch = nds_half(cmp + 2);
  if ((cmp[1] & 0xf8u) != 0x28u || (cmp[0] != 100 && cmp[0] != *previous) ||
      (branch != 0xd300u && branch != 0xdb00u) || (nds_half(cmp + 4) & 0xf800u) != 0xe000u) return false;
  cmp[0] = (uint8_t)cap;
  *previous = cap;
  return true;
}

// Look up the relocated functions by their Thumb instruction sequences. The
// two reads of level must call the same Pokémon getter, and the two growth
// table reads must use the same routine. Reject ambiguous matches.
static bool nds_find_platinum(const uint8_t *ram, struct nds_cap_layout *layout) {
  if (!ram) return false;
  if (!layout->level_up) {
    struct nds_cap_layout found = {0};
    for (uint32_t at = 0x02060000; at < 0x02090000; at += 2) {
      const uint8_t *fn = ram + at - NDS_RAM;
      if (nds_half(fn) != 0xb538 || nds_half(fn + 2) != 0xb082 ||
          nds_half(fn + 4) != 0x2105 || nds_half(fn + 6) != 0x2200 ||
          nds_half(fn + 20) != 0x21a1 || nds_half(fn + 22) != 0x2200 ||
          nds_half(fn + 36) != 0x2108 || nds_half(fn + 38) != 0x2200 ||
          nds_half(fn + 54) != 0x2164 || nds_half(fn + 62) != 0x9901 ||
          nds_half(fn + 64) != 0x4281 || nds_half(fn + 84) != 0x2964) continue;
      const uint32_t getter = nds_call_target(fn + 10, at + 10);
      const uint32_t growth = nds_call_target(fn + 58, at + 58);
      if (getter < NDS_RAM || getter >= at || growth < NDS_RAM || growth >= at ||
          !nds_calls(fn + 24, at + 24, getter) || !nds_calls(fn + 40, at + 40, getter) ||
          !nds_calls(fn + 96, at + 96, growth)) continue;
      if (found.level_up) return false;
      found = (struct nds_cap_layout){0, getter, at, growth};
    }
    *layout = found;
  }
  if (!layout->level_up) return false;
  uint32_t found_gate = 0;
  for (uint32_t at = 0x02230000; at < 0x02260000; at += 2) {
    const uint8_t *gate = ram + at - NDS_RAM;
    if (nds_half(gate) != 0x2864 || nds_half(gate + 2) != 0xd100 ||
        (nds_half(gate + 4) & 0xf800u) != 0xe000u ||
        nds_half(gate - 8) != 0x21a1 || nds_half(gate - 6) != 0x2200 ||
        (nds_half(gate - 12) & 0xff00u) != 0xd000u || nds_half(gate - 14) != 0x2800 ||
        nds_half(gate - 20) != 0x21a3 ||
        !nds_calls(gate - 18, at - 18, layout->getter) ||
        !nds_calls(gate - 4, at - 4, layout->getter)) continue;
    if (found_gate) return false;
    found_gate = at;
  }
  layout->gate = found_gate;
  return found_gate != 0;
}

static bool nds_apply_cap(uint8_t *ram, const struct nds_cap_layout *layout, unsigned cap, unsigned *limit_offset) {
  if (!ram || !layout || cap < 1 || cap > 100) return false;
  uint8_t *const check = ram + layout->gate - NDS_RAM;
  // The overlay can be absent, or replaced by a hack. Verify the level getter
  // call, its CMP r0, #100 and the conditional short branch around the bailout.
  const bool gate = nds_calls(check - 4, layout->gate - 4, layout->getter) &&
      check[1] == 0x28 && check[2] == 0 && (check[3] == 0xdb || (check[3] == 0xd1 && check[0] == 100)) &&
      (nds_half(check + 4) & 0xf800u) == 0xe000u;
  if (!gate && (cap != 100 || !*limit_offset)) return false;

  uint8_t *const fn = ram + layout->level_up - NDS_RAM;
  if (fn[1] != 0xb5) return false; // Thumb PUSH {...,lr}
  for (unsigned i = 2; i < 0x60; i += 2) {
    if (!nds_calls(fn + i, layout->level_up + i, layout->growth_lookup)) continue;
    // The first call gets the species' XP at the common ceiling. The second
    // gets the XP at the Pokémon's next level, so leave it alone.
    for (unsigned j = 2; j <= 6 && j <= i; j += 2) {
      uint8_t *const limit = fn + i - j;
      const bool known_limit = i - j == *limit_offset || (gate && check[3] == 0xdb && limit[0] == check[0]);
      if (!gate && i - j != *limit_offset) continue;
      if (limit[1] != 0x21 || (limit[0] != 100 && (!known_limit || limit[0] == 0 || limit[0] > 100))) continue;
      *limit_offset = i - j;
      limit[0] = (uint8_t)cap;
      if (gate) {
        check[0] = (uint8_t)cap;
        check[3] = cap == 100 ? 0xd1 : 0xdb; // stock BNE / BLT (at and above the cap gain nothing)
      }
      return true;
    }
    return false;
  }
  return false;
}
#endif
