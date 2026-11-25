import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bwExpCap } from '../web/lib/bw-exp-cap.mjs';

test('browser DS XP cap requires both calls, updates and follows an overlay reload', () => {
  const ram = new Uint8Array(0x400000);
  const view = new DataView(ram.buffer);
  const fn = 0x1d69b8;
  const half = (off, value) => view.setUint16(fn + off, value, true);
  const growthCall = (off) => {
    const delta = (0x02018584 - (0x02000000 + fn + off + 4)) & 0x7fffff;
    half(off, 0xf000 | (delta >> 12));
    half(off + 2, 0xf800 | ((delta >> 1) & 0x7ff));
  };
  half(0, 0xb5f8);
  half(8, 0x7e2a);
  half(12, 0x2a64);
  half(14, 0xd300);
  half(16, 0xe0c4);
  growthCall(38);
  const patch = bwExpCap();
  assert.equal(patch(ram, 20), false);
  half(444, 0x4b02);
  half(446, 0x2264);
  half(448, 0x4718);
  view.setUint32(fn + 456, 0x02018585, true);
  assert.equal(patch(ram, 20), true);
  assert.equal(ram[fn + 12], 20);
  assert.equal(patch(ram, 23), true);
  half(12, 0x2a64);
  assert.equal(patch(ram, 23), true);
  assert.equal(ram[fn + 12], 23);
  assert.equal(patch(ram, 100), true);
  assert.equal(ram[fn + 12], 100);
});
