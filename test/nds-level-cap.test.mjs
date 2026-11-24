import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cc = [process.env.TWICABLE_TEST_CC, 'cc', 'clang', 'gcc'].filter(Boolean)
  .find((command) => spawnSync(command, ['-v']).status === 0);

const driver = String.raw`
#include <assert.h>
#include <stdlib.h>
#include "nds-level-cap.h"

static void half(uint8_t *bytes, uint16_t value) {
  bytes[0] = (uint8_t)value;
  bytes[1] = (uint8_t)(value >> 8);
}

static void call(uint8_t *bytes, uint32_t address, uint32_t target) {
  uint32_t delta = (target - address - 4) & 0x7fffff;
  half(bytes, 0xf000 | (delta >> 12));
  half(bytes + 2, 0xf800 | ((delta >> 1) & 0x7ff));
}

static void check_layout(uint8_t *ram, const char *code, unsigned mov_offset) {
  const struct nds_cap_layout *layout = nds_cap_layout(code);
  assert(layout);
  unsigned offset = 0;
  uint8_t *gate = ram + layout->gate - NDS_RAM;
  uint8_t *fn = ram + layout->level_up - NDS_RAM;
  uint8_t *ceiling = fn + mov_offset;
  call(gate - 4, layout->gate - 4, layout->getter);
  half(gate, 0x2864);
  half(gate + 2, 0xd100);
  half(gate + 4, 0xe085);
  half(fn, 0xb538);
  half(ceiling, 0x2164);
  call(ceiling + 4, layout->level_up + mov_offset + 4, layout->growth_lookup);

  /* Never write either site when only one signature matches. */
  gate[1] = 0x29;
  assert(!nds_apply_cap(ram, layout, 14, &offset));
  assert(nds_half(ceiling) == 0x2164);
  gate[1] = 0x28;
  assert(nds_apply_cap(ram, layout, 14, &offset));
  assert(nds_half(ceiling) == 0x210e);
  assert(nds_half(gate) == 0x280e && nds_half(gate + 2) == 0xdb00);

  /* The overlay gets loaded again in the next battle. */
  half(gate, 0x2864);
  half(gate + 2, 0xd100);
  assert(nds_apply_cap(ram, layout, 18, &offset));
  assert(nds_half(ceiling) == 0x2112 && nds_half(gate) == 0x2812);
  assert(nds_apply_cap(ram, layout, 100, &offset));
  assert(nds_half(ceiling) == 0x2164);
  assert(nds_half(gate) == 0x2864 && nds_half(gate + 2) == 0xd100);
}

static void check_bw(uint8_t *ram) {
  const uint32_t at = 0x021d69b8, growth = 0x02018584;
  uint8_t *fn = ram + at - NDS_RAM;
  uint32_t guard = 0;
  unsigned previous = 0;
  assert(nds_bw_exp_cap("IRBO") && nds_bw_exp_cap("IRAO") && !nds_bw_exp_cap("IREO"));
  half(fn, 0xb5f8);
  half(fn + 8, 0x7e25);
  half(fn + 10, 0x2d64);
  half(fn + 12, 0xd300);
  half(fn + 14, 0xe0c7);
  call(fn + 40, at + 40, growth);
  assert(!nds_apply_bw_cap(ram, 20, &guard, &previous));
  assert(nds_half(fn + 10) == 0x2d64);
  call(fn + 444, at + 444, growth);
  assert(nds_apply_bw_cap(ram, 20, &guard, &previous));
  assert(guard == at + 10 && nds_half(fn + 10) == 0x2d14);
  assert(nds_apply_bw_cap(ram, 23, &guard, &previous));
  assert(nds_half(fn + 10) == 0x2d17);
  assert(nds_apply_bw_cap(ram, 100, &guard, &previous));
  assert(nds_half(fn + 10) == 0x2d64);
}

int main(void) {
  uint8_t *ram = calloc(1, 0x400000);
  assert(ram && !nds_cap_layout("IRBO") && !nds_cap_layout("CPUF"));
  assert(nds_cap_layout("IPKE") == nds_cap_layout("IPGE"));
  check_layout(ram, "IPKE", 0x38);
  check_layout(ram, "CPUE", 0x36);
  check_bw(ram);
  assert(nds_localized_platinum("CPUF") && nds_localized_platinum("CPUJ"));
  assert(!nds_localized_platinum("IRBF") && !nds_localized_platinum("CPU\0"));
  const uint32_t at = 0x02075000, getter = 0x02072000, growth = 0x02074000;
  const uint32_t gate_at = 0x02248000;
  uint8_t *fn = ram + at - NDS_RAM, *gate = ram + gate_at - NDS_RAM;
  half(fn, 0xb538);
  half(fn + 2, 0xb082);
  half(fn + 4, 0x2105);
  half(fn + 6, 0x2200);
  call(fn + 10, at + 10, getter);
  half(fn + 20, 0x21a1);
  half(fn + 22, 0x2200);
  call(fn + 24, at + 24, getter);
  half(fn + 36, 0x2108);
  half(fn + 38, 0x2200);
  call(fn + 40, at + 40, getter);
  half(fn + 54, 0x2164);
  call(fn + 58, at + 58, growth);
  half(fn + 62, 0x9901);
  half(fn + 64, 0x4281);
  half(fn + 84, 0x2964);
  call(fn + 96, at + 96, growth);

  struct nds_cap_layout relocated = {0};
  assert(!nds_find_platinum(ram, &relocated));
  assert(relocated.level_up == at && !relocated.gate);
  half(gate - 20, 0x21a3);
  call(gate - 18, gate_at - 18, getter);
  half(gate - 14, 0x2800);
  half(gate - 12, 0xd006);
  half(gate - 8, 0x21a1);
  half(gate - 6, 0x2200);
  call(gate - 4, gate_at - 4, getter);
  half(gate, 0x2864);
  half(gate + 2, 0xd100);
  half(gate + 4, 0xe085);
  assert(nds_find_platinum(ram, &relocated) && relocated.gate == gate_at);
  unsigned offset = 0;
  assert(nds_apply_cap(ram, &relocated, 25, &offset));
  assert(nds_half(fn + 54) == 0x2119 && nds_half(gate) == 0x2819);
  free(ram);
  return 0;
}
`;

test('native DS XP caps validate both instructions, survive an overlay reload and restore stock behavior', { skip: !cc && 'no C compiler' }, (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'twicable-nds-cap-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const source = join(scratch, 'probe.c');
  const exe = join(scratch, process.platform === 'win32' ? 'probe.exe' : 'probe');
  writeFileSync(source, driver);
  const include = fileURLToPath(new URL('../native/retro-host/', import.meta.url));
  const result = spawnSync(cc, ['-I', include, '-o', exe, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const probe = spawnSync(exe, [], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
});
