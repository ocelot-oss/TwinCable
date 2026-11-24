// US HeartGold/SoulSilver, ARM9 Thumb. The EXP task's hook location was documented
// by Memory5ty7/Kalaay (G4Patcher). The game's existing level-up ceiling does the
// actual XP clipping, including awards large enough to gain several levels.
#ifndef TWICABLE_HGSS_LEVEL_CAP_H
#define TWICABLE_HGSS_LEVEL_CAP_H
#include <stdbool.h>
#include <stdint.h>

#define HGSS_RAM 0x02000000u
#define HGSS_TRY_LEVEL_UP 0x02070db4u
#define HGSS_EXP_CHECK 0x02245a2cu

static uint16_t hgss_half(const uint8_t *p) {
  return (uint16_t)(p[0] | (p[1] << 8));
}

static bool hgss_calls(const uint8_t *p, uint32_t at, uint32_t target) {
  const uint16_t high = hgss_half(p), low = hgss_half(p + 2);
  if ((high & 0xf800u) != 0xf000u || (low & 0xf800u) != 0xf800u) return false;
  const uint32_t off = ((high & 0x7ffu) << 12) | ((low & 0x7ffu) << 1);
  return at + 4 + off - (off & 0x400000u ? 0x800000u : 0u) == target;
}

static bool hgss_apply_cap(uint8_t *ram, unsigned cap) {
  static unsigned limit_offset;
  if (!ram || cap < 1 || cap > 100) return false;
  uint8_t *const check = ram + HGSS_EXP_CHECK - HGSS_RAM;
  // The overlay can be absent, or replaced by a hack. Verify the level getter
  // call, its CMP r0, #100 and the conditional short branch around the bailout.
  const bool gate = hgss_calls(check - 4, HGSS_EXP_CHECK - 4, 0x0206e540u) &&
      check[1] == 0x28 && check[2] == 0 && (check[3] == 0xdb || (check[3] == 0xd1 && check[0] == 100)) &&
      (hgss_half(check + 4) & 0xf800u) == 0xe000u;
  if (!gate && (cap != 100 || !limit_offset)) return false;

  uint8_t *const fn = ram + HGSS_TRY_LEVEL_UP - HGSS_RAM;
  if (fn[1] != 0xb5) return false; // Thumb PUSH {...,lr}
  for (unsigned i = 2; i < 0x60; i += 2) {
    if (!hgss_calls(fn + i, HGSS_TRY_LEVEL_UP + i, 0x0206fd30u)) continue;
    // The first call gets the species' XP at the common ceiling. The second
    // gets the XP at the Pokémon's next level, so leave it alone.
    for (unsigned j = 2; j <= 6 && j <= i; j += 2) {
      uint8_t *const limit = fn + i - j;
      const bool known_limit = i - j == limit_offset || (gate && check[3] == 0xdb && limit[0] == check[0]);
      if (!gate && i - j != limit_offset) continue;
      if (limit[1] != 0x21 || (limit[0] != 100 && (!known_limit || limit[0] == 0 || limit[0] > 100))) continue;
      limit_offset = i - j;
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
