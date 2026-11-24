// Another shiny rate for a run (shared/shiny.mjs, server/lib/shiny.mjs): finding the games' shiny compares by their
// code, the byte edits per generation, Gen 3's SHINY_ODDS picture arguments, the DS ARM9 compressed again into its
// old space (shared/nds.mjs blzCompressTo), the setting through build → invite → the partner's build, and the live
// reader counting shinies with the run's threshold. Synthetic THUMB code only – real ROMs when present:
//   TWICABLE_TEST_ROMS=/folder/with/roms node --test test/shiny.test.mjs
// (retail Gen 3–5 dumps: each one is found, patched on a copy in a temp folder and checked; never commit ROMs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { SHINY_RATES, NORMAL_RATE, MIN_RATE, cleanShiny, shinyThreshold, shinyChanged, shinyFamily, findShinyCompares, findShinyLiterals, locateShiny, shinyEdits, trainerShiniesOk, shinyOdds, shinyNeedsHigh, shinyKnownTo280, validRate } from '../shared/shiny.mjs';
import { deadAfter, decode } from '../shared/thumb.mjs';
import { blzCompressTo, blzDecompress, ndsArm9 } from '../shared/nds.mjs';
import { LiveTables, parsePk3 } from '../shared/live/parse.mjs';
import { identifyRom } from '../shared/romid.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-shiny-'));
process.env.SLS_DATA_DIR = DATA;
const { shinySupport, applyShiny } = await import('../server/lib/shiny.mjs');
const { buildRun, readManifest, checkPack, runPack } = await import('../server/lib/build.mjs');
const { restartRequest } = await import('../shared/restart.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

// ---- a small THUMB assembler: halfwords with labels, branches resolved at the end ----------------------------------
function asm() {
  const out = [];
  const labels = {};
  const fix = [];
  const a = {
    at: () => out.length * 2,
    label(name) {
      labels[name] = out.length * 2;
      return a;
    },
    h(...hs) {
      out.push(...hs);
      return a;
    },
    bcond(cond, name) {
      fix.push({ i: out.length, kind: 'bcond', cond, name });
      return a.h(0);
    },
    b(name) {
      fix.push({ i: out.length, kind: 'b', name });
      return a.h(0);
    },
    bl(name) {
      fix.push({ i: out.length, kind: 'bl', name });
      return a.h(0, 0);
    },
    ldr(rd, name) {
      fix.push({ i: out.length, kind: 'ldr', rd, name });
      return a.h(0);
    },
    word(name, v) {
      if (out.length & 1) out.push(0);
      labels[name] = out.length * 2;
      return a.h(v & 0xffff, v >>> 16);
    },
    pad(bytes) {
      while (out.length * 2 < bytes) out.push(0x46c0);
      return a;
    },
    bytes() {
      for (const f of fix) {
        const d = labels[f.name] - (f.i * 2 + 4);
        if (f.kind === 'ldr') out[f.i] = 0x4800 | (f.rd << 8) | ((labels[f.name] - ((f.i * 2 + 4) & ~3)) >> 2);
        else if (f.kind === 'bcond') out[f.i] = 0xd000 | (f.cond << 8) | ((d >> 1) & 0xff);
        else if (f.kind === 'b') out[f.i] = 0xe000 | ((d >> 1) & 0x7ff);
        else {
          out[f.i] = 0xf000 | ((d >> 12) & 0x7ff);
          out[f.i + 1] = 0xf800 | ((d >> 1) & 0x7ff);
        }
      }
      const b = new Uint8Array(out.length * 2);
      out.forEach((h, i) => {
        b[i * 2] = h & 0xff;
        b[i * 2 + 1] = h >> 8;
      });
      return b;
    },
  };
  return a;
}
const BLS = 9;
const BHI = 8;
const BLO = 3;
const BHS = 2;
// XOR of the four halves of r0 (OT ID) and r1 (personality) into rN, as the games compile it
const xorInto = (a, n) => a.h(0x0c00 | (16 << 6) | n, 0x4018, 0x4040 | n, 0x0c08, 0x4040 | n, 0x4019, 0x4040 | (1 << 3) | n);
// Gen 3: `cmp rN, #7` + bhi (IsShinyOtIdPersonality) or bls (the palettes); Gen 4/5: `cmp r0, #8` + bhs
function check(a, name, { gen = 3, cond = BHI, n = 2 } = {}) {
  a.label(name).h(0xb510, 0x2400);
  xorInto(a, n).h(0x2800 | (n << 8) | (gen === 3 ? 7 : 8)).bcond(gen === 3 ? cond : BHS, `${name}.no`);
  return a.h(0x2401).label(`${name}.no`).h(0x1c20, 0xbc10, 0xbc02, 0x4708);
}
// the not-shiny loop of NPC Pokémon: draw an OT ID, again while shiny, then on
function loop(a, name, { gen = 3, n = 1 } = {}) {
  a.label(name).h(0xb5f0).label(`${name}.top`).h(0x2000, 0x2100);
  xorInto(a, n).h(0x2800 | (n << 8) | (gen === 3 ? 7 : 8)).bcond(gen === 3 ? BLS : BLO, `${name}.top`).b(`${name}.out`);
  return a.h(0x46c0).label(`${name}.out`).h(0xbdf0);
}
/** A Gen 3 game: the loop, four checks (one a palette function) and a picture function that reaches the palette. */
function gen3Code({ literals = 1 } = {}) {
  const a = asm();
  a.pad(0x40);
  loop(a, 'loop');
  check(a, 'isShiny');
  check(a, 'pal1', { cond: BLS, n: 0 });
  check(a, 'pal2', { cond: BLS, n: 0 });
  check(a, 'sparkle', { n: 0 });
  // CreateMonPicSprite → LoadPicPalette → the palette function
  a.label('loadPal').h(0xb500).bl('pal1').h(0xbd00);
  a.label('pic').h(0xb500).bl('loadPal').h(0xbd00);
  a.label('other').h(0xb500, 0x2000).h(0xbd00); // reaches no shiny check
  for (let i = 0; i < literals; i++) a.h(0xb500, 0x2108, 0x2200, 0x2301).bl('pic').h(0xbd00); // (species, SHINY_ODDS, 0, TRUE)
  a.h(0xb500, 0x2108, 0x2301).bl('other').h(0xbd00); // r1 = 8 for something else
  a.h(0xb500, 0x2108, 0x6809, 0x2301).bl('pic').h(0xbd00); // r1 = 8, then loaded from memory: not the argument
  return { code: a.pad(0x400).bytes(), a };
}
const FAMILY3 = (literals = 1) => ({ gen: 3, checks: 4, loops: 1, literals: [literals, literals] });

test('cleanShiny: any whole rate from 1 in 2 to 1 in 8192, null for the games’ own odds; thresholds per preset', () => {
  assert.deepEqual(cleanShiny({ rate: 512, trainers: true }), { rate: 512, trainers: true });
  assert.deepEqual(cleanShiny({ rate: '1024' }), { rate: 1024, trainers: false });
  assert.deepEqual(cleanShiny({ rate: 8192, trainers: true }), { rate: 8192, trainers: true });
  assert.equal(cleanShiny({ rate: 8192 }), null);
  assert.deepEqual(cleanShiny({ rate: 100 }), { rate: 100, trainers: false }, 'a custom rate (2.8.1)');
  assert.deepEqual(cleanShiny({ rate: 2 }), { rate: 2, trainers: false });
  for (const bad of [1, 0, -5, 8193, 99999, 2.5, NaN, 'x', null]) assert.equal(cleanShiny({ rate: bad }), null, `${bad}: the games’ own odds`);
  assert.equal(cleanShiny({ rate: 512, trainers: 'yes' }).trainers, false);
  for (const bad of [null, undefined, 3, 'x', [], { trainers: 1 }]) assert.equal(cleanShiny(bad), null);
  assert.deepEqual(SHINY_RATES.map((r) => shinyThreshold({ rate: r })), [8, 16, 64, 128, 255]);
  assert.equal(shinyThreshold(null), 8);
  assert.equal(shinyChanged({ rate: 8192 }), false);
  assert.equal(shinyChanged({ rate: 4096 }), true);
});

test('shinyFamily: Gen 3–5 GBA/DS games by their code, nothing else', () => {
  assert.equal(shinyFamily('gba', 'BPEE').literals[0], 3);
  assert.equal(shinyFamily('gba', 'AXVD').gen, 3);
  assert.equal(shinyFamily('gba', 'BPGD').literals[1], 7);
  assert.equal(shinyFamily('nds', 'IPKE').loops, 1);
  assert.equal(shinyFamily('nds', 'IREO').gen, 5);
  assert.equal(shinyFamily('nds', 'IRBO').loops, 0);
  for (const [sys, code] of [['gbc', 'BYTE'], ['gb', ''], ['gba', 'AGBJ'], ['nds', 'NTRJ'], ['3ds', 'ECRA']]) assert.equal(shinyFamily(sys, code), null);
});

test('findShinyCompares: the compares after the XOR of the halves, the loop told apart', () => {
  const { code } = gen3Code();
  const found = findShinyCompares(code, 7);
  assert.deepEqual(found.map((x) => x.kind), ['loop', 'check', 'check', 'check', 'check']);
  assert.equal(findShinyCompares(code, 8).length, 0, 'Gen 4/5 compares #8');
  // the same compare without the XOR before it is something else
  const plain = asm().pad(0x40).h(0x2000, 0x2100, 0x2207, 0x4042).h(0x2a07).bcond(BHI, 'x').label('x').h(0x4770).pad(0x80).bytes();
  assert.equal(findShinyCompares(plain, 7).length, 0);
});

test('findShinyLiterals: SHINY_ODDS passed into a picture function – not other calls, not when r1 changes', () => {
  const { code } = gen3Code({ literals: 2 });
  const checks = findShinyCompares(code, 7).filter((x) => x.kind === 'check').map((x) => x.at);
  const lits = findShinyLiterals(code, checks);
  assert.equal(lits.length, 2);
  for (const at of lits) assert.deepEqual([code[at], code[at + 1]], [0x08, 0x21]);
});

test('locateShiny + shinyEdits, Gen 3: thresholds - 1 at every check, the loop opened or tightened, pictures moved', () => {
  const { code } = gen3Code();
  const loc = locateShiny(code, FAMILY3());
  assert.equal(loc.gen, 3);
  assert.equal(loc.checks.length, 4);
  assert.equal(loc.literals.length, 1);
  assert.equal(trainerShiniesOk(loc), true);
  assert.deepEqual(locateShiny(code, FAMILY3(2)), { error: 'code' }, 'one picture argument fewer than the game has');
  assert.deepEqual(locateShiny(code, { ...FAMILY3(), checks: 5 }), { error: 'code' });
  assert.deepEqual(locateShiny(code, null), { error: 'game' });

  const apply = (shiny) => {
    const c = code.slice();
    for (const e of shinyEdits(loc, shiny)) c.set(e.bytes, e.at);
    return c;
  };
  const p = apply({ rate: 512 });
  for (const at of loc.checks) assert.equal(p[at], 127);
  assert.equal(p[loc.loop], 127, 'trainers stay never shiny at the new rate');
  assert.equal(p[loc.literals[0]], 0xff, 'the pictures’ OT ID stays above the threshold');
  const t = apply({ rate: 256, trainers: true });
  for (const at of loc.checks) assert.equal(t[at], 254);
  assert.deepEqual([t[loc.loop], t[loc.loop + 2], t[loc.loop + 3]], [7, 0xc0, 0x46], 'the branch back is a nop');
  const only = shinyEdits(loc, { rate: 8192, trainers: true });
  assert.deepEqual(only, [{ at: loc.loop + 2, bytes: [0xc0, 0x46] }], 'trainer shinies at the normal rate: just the loop');
  assert.deepEqual(shinyEdits(loc, null), []);
  // nothing else changes
  const diff = [...p].filter((b, i) => b !== code[i]).length;
  assert.equal(diff, 6);
});

test('shinyEdits, Gen 4/5: the threshold itself; Gen 5 has no loop to open', () => {
  const a = asm().pad(0x40);
  loop(a, 'loop', { gen: 4, n: 0 });
  check(a, 'calc', { gen: 4, n: 0 });
  const code4 = a.pad(0x200).bytes();
  const loc4 = locateShiny(code4, { gen: 4, checks: 1, loops: 1, literals: [0, 0] });
  assert.equal(loc4.literals.length, 0);
  const e4 = shinyEdits(loc4, { rate: 1024 });
  assert.deepEqual(e4.map((e) => e.bytes[0]), [64, 64]);
  const b = asm().pad(0x40);
  check(b, 'calc', { gen: 5, n: 0 });
  const code5 = b.pad(0x200).bytes();
  const loc5 = locateShiny(code5, { gen: 5, checks: 1, loops: 0, literals: [0, 0] });
  assert.equal(trainerShiniesOk(loc5), false);
  assert.deepEqual(shinyEdits(loc5, { rate: 256 }).map((e) => e.bytes[0]), [255]);
  assert.throws(() => shinyEdits(loc5, { rate: 256, trainers: true }), /trainer/);
});

test('blzCompressTo: exactly the given size, the start kept, decompresses back – in place', () => {
  // compressible "code": repeating runs with some noise
  const raw = new Uint8Array(0x9000);
  let x = 1;
  for (let i = 0; i < raw.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    raw[i] = i % 64 < 40 ? (i >> 3) & 0xff : (x >>> 24) & 0x0f;
  }
  for (const size of [0x6000, 0x7000, 0x8ff0]) {
    const out = blzCompressTo(raw, size, 0x1000);
    assert.ok(out, `fits into ${size.toString(16)}`);
    assert.equal(out.length, size);
    assert.deepEqual(out.subarray(0, 0x1000), raw.subarray(0, 0x1000), 'the start stays as it is');
    assert.deepEqual(blzDecompress(out), raw);
  }
  assert.equal(blzCompressTo(raw, 0x800, 0x400), null, 'too small');
});

// ---- files: a GBA game and a DS game with a compressed ARM9 --------------------------------------------------------
function gbaRom(code, gameCode = 'AXVE') {
  const rom = new Uint8Array(0x8000);
  rom.set(code.subarray(0, 0x7000), 0x1000);
  rom[0xb2] = 0x96;
  rom.set([...gameCode].map((c) => c.charCodeAt(0)), 0xac);
  return rom;
}
const put32 = (b, o, v) => {
  for (let i = 0; i < 4; i++) b[o + i] = (v >>> (i * 8)) & 0xff;
};
/** A Gen 5 DS game: header + an ARM9 (module params in its uncompressed start) compressed to `packed` bytes. */
function ndsRom(code) {
  const RAM = 0x02004000;
  const raw = new Uint8Array(0x6000);
  for (let i = 0; i < 0x4000; i++) raw[i] = (i * 7) & 0xff; // the start (secure area, crt0)
  const params = 0x800;
  put32(raw, params + 0x1c, 0xdec00621);
  raw.set(code.subarray(0, 0x2000), 0x4000);
  const packed = 0x5800;
  put32(raw, params + 0x14, RAM + packed); // compressed_static_end
  const image = blzCompressTo(raw, packed, 0x4000);
  assert.ok(image);
  const rom = new Uint8Array(0x4000 + packed);
  rom.set([...'POKEMON B2'].map((c) => c.charCodeAt(0)), 0);
  rom.set([...'IREO'].map((c) => c.charCodeAt(0)), 0x0c);
  put32(rom, 0x20, 0x4000);
  put32(rom, 0x28, RAM);
  put32(rom, 0x2c, packed);
  rom[0x15c] = 0x56;
  rom[0x15d] = 0xcf;
  rom.set(image, 0x4000);
  return rom;
}

test('applyShiny on a GBA file: the edits land in the file, a game without the code is refused', () => {
  const dir = mkdtempSync(join(DATA, 'gba-'));
  const { code } = gen3Code({ literals: 0 });
  const path = join(dir, 'Ruby.gba');
  writeFileSync(path, gbaRom(code));
  assert.deepEqual({ ...shinySupport(path), high: undefined }, { ok: true, gen: 3, trainers: true, high: undefined });
  assert.deepEqual(shinySupport(path, { original: false }), { ok: false, reason: 'hack', gen: 3 });
  assert.deepEqual(applyShiny(path, { rate: 1024, trainers: true }), { changed: 5 });
  const after = new Uint8Array(readFileSync(path));
  assert.deepEqual(locateShiny(after, shinyFamily('gba', 'AXVE')), { error: 'code' }, 'patched: the compares changed');
  assert.deepEqual(applyShiny(path, null), { changed: 0 });

  const gb = join(dir, 'Red.gb');
  writeFileSync(gb, new Uint8Array(0x8000));
  assert.deepEqual(shinySupport(gb), { ok: false, reason: 'game' });
  assert.throws(() => applyShiny(gb, { rate: 512 }), (e) => e.code === 'shinyUnsupported');
  const odd = join(dir, 'Emerald.gba');
  writeFileSync(odd, gbaRom(code, 'BPEE')); // Emerald has three picture arguments – this one none
  assert.equal(shinySupport(odd).reason, 'code');
});

test('applyShiny on a DS game: the compressed ARM9 is compressed again into its own space', () => {
  const dir = mkdtempSync(join(DATA, 'nds-'));
  const a = asm().pad(0x40);
  check(a, 'calc', { gen: 5, n: 0 });
  const rom = ndsRom(a.pad(0x2000).bytes());
  const path = join(dir, 'Black 2.nds');
  writeFileSync(path, rom);
  assert.deepEqual(shinySupport(path), { ok: true, gen: 5, trainers: false, high: false }, '(this check’s halves are made in a way the rewrite doesn’t know)');
  assert.throws(() => applyShiny(path, { rate: 512, trainers: true }), (e) => e.code === 'shinyUnsupported');
  assert.deepEqual(applyShiny(path, { rate: 512 }), { changed: 1 });
  const after = new Uint8Array(readFileSync(path));
  assert.equal(after.length, rom.length, 'nothing moved');
  assert.deepEqual(after.subarray(0, 0x4000 + 0x4000), rom.subarray(0, 0x4000 + 0x4000), 'header and the ARM9’s start as they were');
  const a9 = ndsArm9(after);
  assert.equal(a9.packed, 0x5800);
  const before = ndsArm9(rom).bytes;
  const changed = [...a9.bytes].map((b, i) => (b !== before[i] ? i : -1)).filter((i) => i >= 0);
  assert.equal(changed.length, 1);
  assert.equal(a9.bytes[changed[0]], 128);
});

// ---- the setting through a run --------------------------------------------------------------------------------------
test('build → invite → partner: every player’s game patched alike, a game that can’t take it is refused', async () => {
  const LIB = join(DATA, 'Library');
  mkdirSync(LIB, { recursive: true });
  const ROM = join(LIB, 'Sapphire.gba');
  writeFileSync(ROM, gbaRom(gen3Code({ literals: 0 }).code, 'AXPE'));
  const log = [];
  const m = await buildRun({ romId: ROM, randomize: false, config: {}, shiny: { rate: 512, trainers: true }, players: { p1: { name: 'Lou' }, p2: { name: 'Kim' } } }, (l) => log.push(l));
  assert.deepEqual(m.shiny, { rate: 512, trainers: true });
  assert.ok(log.some((l) => l?.code === 'shinyTrainers' && l.vars?.rate === 512), 'the build log says the rate went in (a code the page translates)');
  const out = new Uint8Array(readFileSync(join(DATA, 'runs', m.id, m.outputs.p1.rom)));
  assert.notDeepEqual(out, new Uint8Array(readFileSync(ROM)));
  assert.equal(m.outputs.p1.sha1, m.outputs.p2.sha1);

  const pack = runPack(m);
  assert.deepEqual(pack.shiny, { rate: 512, trainers: true });
  assert.deepEqual(checkPack(pack).shiny, { rate: 512, trainers: true });
  assert.equal(checkPack({ ...pack, shiny: { rate: 1 } }).shiny, null, 'a pack with a rate a run can’t have: the games’ own odds');
  assert.equal(pack.format, 'soullink-studio/run-pack@2', 'a preset: 2.8.0 can still join');
  // the partner's build (an imported run has the setting; the request doesn't repeat it)
  const again = await buildRun({ identity: { id: m.id, room: m.room, secret: m.secret }, romId: ROM, randomize: false, config: {}, players: pack.players, buildFor: ['p2'], expectedOutputs: pack.outputs });
  assert.equal(again.outputs.p2.matchesFriend, true);
  assert.deepEqual(readManifest(m.id).shiny, { rate: 512, trainers: true });
  // a new attempt keeps it
  assert.deepEqual(restartRequest(m, { library: { roms: [{ id: ROM, crc: m.base.crc }] }, runs: [] }).shiny, { rate: 512, trainers: true });
  assert.equal(restartRequest({ ...m, shiny: null }, { library: { roms: [{ id: ROM, crc: m.base.crc }] }, runs: [] }).shiny, undefined);

  // a rate 2.8.0 doesn't know: a pack 2.8.0 refuses ("update to 2.8.1"), the rate kept through build and pack
  const custom = await buildRun({ romId: ROM, randomize: false, config: {}, shiny: { rate: 1000 }, players: { p1: { name: 'Lou' }, p2: { name: 'Kim' } } });
  assert.deepEqual(custom.shiny, { rate: 1000, trainers: false });
  const cp = runPack(custom);
  assert.deepEqual([cp.format, cp.minVersion], ['soullink-studio/run-pack@3', '2.8.1']);
  assert.deepEqual(checkPack(cp).shiny, { rate: 1000, trainers: false });
  const cOut = new Uint8Array(readFileSync(join(DATA, 'runs', custom.id, custom.outputs.p1.rom)));
  const loc0 = locateShiny(new Uint8Array(readFileSync(ROM)).subarray(0x1000), FAMILY3(0));
  assert.equal(cOut[0x1000 + loc0.checks[0]], 65, 'threshold 66 (1 in 993 – the closest to 1 in 1000): `cmp #65` + bls');

  const plain = await buildRun({ romId: ROM, randomize: false, config: {}, mode: 'nuzlocke', players: { p1: { name: 'Lou' } } });
  assert.equal(plain.shiny, null);
  assert.equal(runPack(plain).shiny, undefined, 'runs without the setting: the pack as before');

  const GB = join(LIB, 'Fake.gb');
  writeFileSync(GB, Buffer.alloc(0x8000, 7));
  await assert.rejects(buildRun({ romId: GB, randomize: false, config: {}, mode: 'nuzlocke', shiny: { rate: 256 }, players: { p1: { name: 'Lou' } } }), (e) => e.code === 'shinyUnsupported');
});

test('the live reader calls a Pokémon shiny with the run’s threshold', () => {
  const T = new LiveTables({ gen3Index: { map: { 1: 1 } } });
  assert.equal(T.withShinyOdds(8), T);
  assert.equal(T.withShinyOdds(undefined), T);
  const T512 = T.withShinyOdds(128);
  assert.equal(T512.shinyOdds, 128);
  // a Gen 3 party mon (unencrypted key 0: PID = OT ID ^ data key) with a shiny value of 100
  const mon = (sv) => {
    const d = new Uint8Array(100);
    const pid = 0x00010000 | sv; // high half 1, low half sv: XOR with OT ID 0x00000001 → sv
    put32(d, 0, pid);
    put32(d, 4, 0x00000001);
    const key = (pid ^ 1) >>> 0;
    const plain = new Uint8Array(48);
    plain[0] = 1; // species index 1 in the Growth block
    let sum = 0;
    const order = pid % 24; // the substructures' order (pokeemerald pokemon.c GetSubstruct)
    const at = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][order].indexOf('G');
    const block = new Uint8Array(48);
    block.set(plain.subarray(0, 12), at * 12);
    for (let i = 0; i < 48; i += 2) sum = (sum + (block[i] | (block[i + 1] << 8))) & 0xffff;
    d[0x1c] = sum & 0xff;
    d[0x1d] = sum >> 8;
    for (let i = 0; i < 48; i += 4) put32(d, 32 + i, ((block[i] | (block[i + 1] << 8) | (block[i + 2] << 16) | (block[i + 3] << 24)) ^ key) >>> 0);
    return d;
  };
  const m100 = mon(100);
  assert.equal(parsePk3(m100, T)?.shiny, false);
  assert.equal(parsePk3(m100, T512)?.shiny, true);
  assert.equal(parsePk3(mon(200), T512)?.shiny, false);
  assert.equal(parsePk3(mon(3), T)?.shiny, true);
});

// ---- any rate (2.8.1): thresholds above 255 -------------------------------------------------------------------------

test('shinyOdds: presets as in 2.8.0, any other rate to the nearest threshold the patch can build', () => {
  assert.deepEqual(SHINY_RATES.map((r) => shinyOdds(r).threshold), [8, 16, 64, 128, 255]);
  const rep = (t) => {
    while (t > 255) {
      if (t % 2) return false;
      t /= 2;
    }
    return true;
  };
  const candidates = [];
  for (let k = 1; k <= 255; k++) for (let s = 0; s <= 8; s++) candidates.push(k * 2 ** s);
  for (let n = MIN_RATE; n <= NORMAL_RATE; n++) {
    const o = shinyOdds(n);
    assert.ok(o.threshold >= 8 && o.threshold <= 32768 && rep(o.threshold), `${n}: ${o.threshold}`);
    assert.equal(o.effective, 65536 / o.threshold);
    if (SHINY_RATES.includes(n) || o.threshold === 8) continue;
    const want = 65536 / n;
    const best = Math.min(...candidates.map((t) => Math.abs(t - want)));
    assert.equal(Math.abs(o.threshold - want), best, `${n}: the nearest one`);
    if (o.threshold > 255) assert.ok(Math.abs(o.effective - n) / n < 0.004, `${n}: ${o.effective} – 8 significant bits`);
    assert.equal(o.exact, Number.isInteger(Math.log2(n)), `${n}: exact only for powers of two`);
  }
  assert.deepEqual([100, 50, 10, 2, 3, 1000, 8191].map((n) => shinyOdds(n).threshold), [656, 1312, 6560, 32768, 21888, 66, 8]);
  assert.equal(shinyOdds(2).exact, true);
  assert.equal(shinyOdds(1), null);
  assert.equal(shinyOdds(8193), null);
  assert.deepEqual([2, 8192, 100].map(validRate), [true, true, true]);
  assert.deepEqual([1, 8193, 99.5, '100'].map(validRate), [false, false, false, false]);
  assert.equal(shinyThreshold({ rate: 100 }), 656);
  assert.deepEqual([{ rate: 257 }, { rate: 256 }, { rate: 255 }, null].map(shinyNeedsHigh), [false, false, true, false]);
  assert.deepEqual([{ rate: 512 }, { rate: 8192, trainers: true }, { rate: 100 }, null].map(shinyKnownTo280), [true, true, false, true]);
});

/**
 * A THUMB function of `code` run from `entry` (r0… = args) until it returns – flags for the compares, shifts and ALU
 * ops these functions use, conditional branches, bl, push/pop, a stack and memory (`mem`, address → byte). → r0.
 */
function exec(code, entry, args, mem = new Map()) {
  const R = new Uint32Array(16);
  args.forEach((v, i) => (R[i] = v));
  R[13] = 0x03007e00;
  R[14] = 0xfffffff1;
  let N = false;
  let Z = false;
  let C = false;
  const rd32 = (a) => [0, 1, 2, 3].reduce((v, i) => v | ((mem.get(a + i) ?? 0) << (8 * i)), 0) >>> 0;
  const wr32 = (a, v) => [0, 1, 2, 3].forEach((i) => mem.set(a + i, (v >>> (8 * i)) & 0xff));
  const nz = (v) => {
    v >>>= 0;
    N = v >= 0x80000000;
    Z = v === 0;
    return v;
  };
  const sub = (a, b) => {
    C = a >>> 0 >= b >>> 0;
    return nz(a - b);
  };
  let pc = entry;
  for (let steps = 0; steps < 100000; steps++) {
    if (pc === 0xfffffff0) return R[0];
    const h = code[pc] | (code[pc + 1] << 8);
    const d = h & 7;
    const m = (h >> 3) & 7;
    const top = h >> 11;
    let next = pc + 2;
    if (top <= 2) {
      const imm = (h >> 6) & 31;
      const v = R[m];
      if (top === 0) {
        if (imm) C = !!((v >>> (32 - imm)) & 1);
        R[d] = nz(v << imm);
      } else {
        const sh = imm || 32;
        C = !!((v >>> (sh - 1)) & 1);
        R[d] = nz(top === 1 ? (sh === 32 ? 0 : v >>> sh) : v >> Math.min(31, sh));
      }
    } else if (top === 3) {
      const n = h & 0x400 ? (h >> 6) & 7 : R[(h >> 6) & 7];
      R[d] = h & 0x200 ? sub(R[m], n) : nz(R[m] + n);
    } else if (top >= 4 && top <= 7) {
      const r = (h >> 8) & 7;
      const imm = h & 0xff;
      if (top === 4) R[r] = nz(imm);
      else if (top === 5) sub(R[r], imm);
      else if (top === 6) R[r] = nz(R[r] + imm);
      else R[r] = sub(R[r], imm);
    } else if ((h & 0xfc00) === 0x4000) {
      const op = (h >> 6) & 15;
      const a = R[d];
      const b = R[m];
      if (op === 8) nz(a & b);
      else if (op === 10) sub(a, b);
      else R[d] = nz([a & b, a ^ b, a << b, a >>> b, a >> b, 0, 0, 0, 0, -b, 0, 0, a | b, Math.imul(a, b), a & ~b, ~b][op]);
    } else if ((h & 0xfc00) === 0x4400) {
      const op = (h >> 8) & 3;
      const rd = d | ((h >> 4) & 8);
      const rs = (h >> 3) & 15;
      if (op === 3) next = (R[rs] & ~1) >>> 0;
      else if (op === 2) R[rd] = R[rs];
      else if (op === 1) sub(R[rd], R[rs]);
      else R[rd] += R[rs];
    } else if (top === 9) {
      const a = ((pc + 4) & ~3) + (h & 0xff) * 4;
      R[(h >> 8) & 7] = (code[a] | (code[a + 1] << 8) | (code[a + 2] << 16) | (code[a + 3] << 24)) >>> 0;
    } else if ((h & 0xf800) === 0x6800) R[d] = rd32(R[m] + ((h >> 6) & 31) * 4);
    else if ((h & 0xf800) === 0x6000) wr32(R[m] + ((h >> 6) & 31) * 4, R[d]);
    else if ((h & 0xf600) === 0xb400) {
      const list = [0, 1, 2, 3, 4, 5, 6, 7].filter((r) => h & (1 << r));
      if (h & 0x800) {
        for (const r of list) [R[r], R[13]] = [rd32(R[13]), R[13] + 4];
        if (h & 0x100) [next, R[13]] = [(rd32(R[13]) & ~1) >>> 0, R[13] + 4];
      } else {
        if (h & 0x100) wr32((R[13] -= 4), R[14]);
        for (const r of list.reverse()) wr32((R[13] -= 4), R[r]);
      }
    } else if ((h & 0xf000) === 0xd000) {
      const cond = (h >> 8) & 15;
      const take = [Z, !Z, C, !C, N, !N, false, false, C && !Z, !C || Z][cond];
      if (take === undefined) throw new Error(`cond ${cond}`);
      if (take) next = pc + 4 + 2 * ((h << 24) >> 24);
    } else if ((h & 0xf800) === 0xe000) next = pc + 4 + 2 * ((h << 21) >> 21);
    else if ((h & 0xf800) === 0xf000) {
      const h2 = code[pc + 2] | (code[pc + 3] << 8);
      let off = ((h & 0x7ff) << 12) | ((h2 & 0x7ff) << 1);
      if (off & 0x400000) off -= 0x800000;
      R[14] = (pc + 4) | 1;
      next = pc + 4 + off;
    } else throw new Error(`exec: ${h.toString(16)} at ${pc.toString(16)}`);
    pc = next;
  }
  throw new Error('exec: no return');
}

const RNG = 0x03005d80; // the random generator's state (as in Emerald, gRngValue)
/** Random(): state = state × 0x41C64E6D + 0x6073, the upper half returned (pokeemerald random.c, as agbcc builds it). */
function random(a) {
  return a.label('rand').ldr(2, 'rand.state').h(0x6811).ldr(0, 'rand.mul').h(0x4348).ldr(1, 'rand.add').h(0x1840, 0x6010, 0x0c00, 0x4770)
    .word('rand.state', RNG).word('rand.mul', 0x41c64e6d).word('rand.add', 0x6073);
}

/**
 * A Gen 3 game as agbcc builds it (Emerald's shapes): IsShinyOtIdPersonality, two palette functions, the battle
 * sparkle (its 0xFFFF mask register still needed after the compare), CreateBoxMon's not-shiny loop around Random() and
 * a picture drawn with SHINY_ODDS. `live`: the sparkle reads its XOR value after the compare (can't be rewritten).
 */
function gen3High({ live = false } = {}) {
  const a = asm().h(0x4770).pad(0x40);
  random(a);
  // IsShinyOtIdPersonality(otId r0, personality r1) → bool
  a.label('isShiny').h(0xb510, 0x2400, 0x0c02).ldr(3, 'isShiny.mask').h(0x4018, 0x4042, 0x0c08, 0x4042, 0x4019, 0x404a, 0x2a07).bcond(BHI, 'isShiny.no')
    .h(0x2401).label('isShiny.no').h(0x1c20, 0xbc10, 0xbc02, 0x4708).word('isShiny.mask', 0xffff);
  // palettes(species r0, otId r1, personality r2) → 0x1000 + species normal, 0x2000 + species shiny
  for (const p of ['pal1', 'pal2']) {
    a.label(p).h(0xb510, 0x1c04, 0x1c13, 0x0c08).ldr(2, `${p}.mask`).h(0x4011, 0x4048, 0x0c19, 0x4048, 0x4013, 0x4058, 0x2807).bcond(BLS, `${p}.sh`)
      .ldr(0, `${p}.normal`).b(`${p}.j`).label(`${p}.sh`).ldr(0, `${p}.shiny`).label(`${p}.j`).h(0x1900, 0xbc10, 0xbc02, 0x4708)
      .word(`${p}.mask`, 0xffff).word(`${p}.normal`, 0x1000).word(`${p}.shiny`, 0x2000);
  }
  // sparkle(otId r0, personality r1) → bool & mask (the mask in r7 still used after the compare)
  a.label('sparkle').h(0xb5f0, 0x1c05, 0x1c0c, 0x2600, 0x0c28).ldr(7, 'sparkle.mask').h(0x403d, 0x4068, 0x0c21, 0x4048, 0x403c, 0x4060, 0x2807)
    .bcond(BHI, 'sparkle.no').h(0x2601).label('sparkle.no').h(live ? 0x1c06 : 0x46c0, 0x1c30, 0x4038, 0xbcf0, 0xbc02, 0x4708).word('sparkle.mask', 0xffff);
  // MakeOtId(personality r0) → an OT ID that isn't shiny with it (CreateBoxMon's OT_ID_RANDOM_NO_SHINY loop)
  a.label('makeOt').h(0xb570, 0x1c06).ldr(5, 'makeOt.mask').label('makeOt.top').bl('rand').h(0x1c04).bl('rand').h(0x0400, 0x4304)
    .h(0x0c21, 0x1c22, 0x402a, 0x4051, 0x0c30, 0x4041, 0x1c32, 0x402a, 0x4051, 0x2907).bcond(BLS, 'makeOt.top').b('makeOt.out')
    .h(0x46c0).label('makeOt.out').h(0x1c20, 0xbc70, 0xbc02, 0x4708).word('makeOt.mask', 0xffff);
  // a picture with SHINY_ODDS as the OT ID: CreateMonPic → the palette
  a.label('pic').h(0xb510).bl('pal1').h(0xbc10, 0xbc02, 0x4708);
  a.label('starter').h(0xb510, 0x2019, 0x2108, 0x2200, 0x2301).bl('pic').h(0xbc10, 0xbc02, 0x4708);
  return { code: a.pad(0x800).bytes(), a };
}

/** Gen 4/5 as mwcc builds them (Black's, Platinum's shapes): the leaf check, Gen 4's not-shiny loop. `live`: r1 read after it. */
function gen45High({ loop = false, live = false } = {}) {
  const a = asm().h(0x4770).pad(0x40);
  random(a);
  a.label('check').ldr(3, 'check.mask').h(0x040a, 0x4019, 0x4003, 0x0400, 0x0c1b, 0x0c00, 0x0c09, 0x4058, 0x0c12, 0x4048, 0x4050, 0x2808)
    .bcond(BHS, 'check.no').h(0x2001, live ? 0x1840 : 0x46c0, 0x4770).label('check.no').h(0x2000, 0x4770).word('check.mask', 0xffff0000);
  if (loop) {
    a.label('makeOt').h(0xb570, 0x1c06).label('makeOt.top').bl('rand').h(0x1c04).bl('rand').h(0x0400, 0x4304)
      .h(0x0432, 0x0c12, 0x0c31, 0x0c20, 0x0423, 0x0c1b, 0x4058, 0x4048, 0x4050, 0x2808).bcond(BLO, 'makeOt.top').b('makeOt.out')
      .h(0x46c0).label('makeOt.out').h(0x1c20, 0xbc70, 0xbc02, 0x4708);
  }
  return { code: a.pad(0x400).bytes(), a };
}

/** The function around `at`: where its `push {…, lr}` is. */
const fnStart = (code, at) => {
  for (let o = at; o > at - 96; o -= 2) if (code[o + 1] === 0xb5) return o;
  throw new Error('no push');
};
const patched = (code, loc, shiny) => {
  const c = code.slice();
  for (const e of shinyEdits(loc, shiny)) c.set(e.bytes, e.at);
  return c;
};
const shinyCount = (fn) => {
  let n = 0;
  for (let v = 0; v < 65536; v++) n += fn(v) ? 1 : 0;
  return n;
};

test('Gen 4/5 above 255: every half shifted further, the compare with k – exactly k × 2^s of 65536 shiny', () => {
  const { code } = gen45High({ loop: true });
  const F4 = { gen: 4, checks: 1, loops: 1, literals: [0, 0] };
  const loc = locateShiny(code, F4);
  assert.equal(loc.high.ok, true, loc.high.why);
  assert.equal(loc.high.checks[0].kind, 'shift');
  const fn = loc.checks[0] - 24; // the leaf starts with `ldr r3, =0xFFFF0000`, 12 instructions before its compare
  assert.equal(code[fn + 1] & 0xf8, 0x48);
  for (const rate of [2, 3, 10, 50, 100, 255, 256, 300, 4096]) {
    const c = patched(code, loc, { rate });
    assert.equal(shinyCount((v) => exec(c, fn, [0, v])), shinyThreshold({ rate }), `1 in ${rate}`);
    assert.equal(shinyCount((v) => exec(c, fn, [0x12345678, (0x12345678 ^ v) >>> 0])) > 0, true);
  }
  // the not-shiny loop: never an OT ID below the threshold – trainer shinies on: just once
  for (const [rate, trainers] of [[2, false], [100, false], [100, true]]) {
    const c = patched(code, loc, { rate, trainers });
    const T = shinyThreshold({ rate });
    const mem = new Map();
    let low = 65536;
    let below = 0;
    for (let i = 0; i < 400; i++) {
      [0, 1, 2, 3].forEach((k) => mem.set(RNG + k, (i * 2654435761 >>> (8 * k)) & 0xff));
      const pid = 0x12345678;
      const ot = exec(c, fnStart(c, loc.loop), [pid], mem);
      const sv = (ot >>> 16) ^ (ot & 0xffff) ^ (pid >>> 16) ^ (pid & 0xffff);
      low = Math.min(low, sv);
      below += sv < T ? 1 : 0;
    }
    if (trainers) assert.ok(below > 0, `1 in ${rate}, trainer shinies: some below ${T}`);
    else assert.ok(low >= T, `1 in ${rate}: lowest ${low}, threshold ${T}`);
  }
});

test('Gen 3 above 255: the XOR made anew next to the threshold – checks, palettes, the sparkle, the loop and the pictures', () => {
  const { code } = gen3High();
  const F = { gen: 3, checks: 4, loops: 1, literals: [1, 1] };
  const loc = locateShiny(code, F);
  assert.equal(loc.high.ok, true, loc.high.why);
  assert.deepEqual(loc.high.checks.map((p) => p.kind), ['rewrite', 'rewrite', 'rewrite', 'rewrite']);
  const fnOf = (at) => fnStart(code, at);
  const [isShiny, pal1, pal2, sparkle] = loc.checks.map(fnOf);
  const starter = loc.literals[0] - 4;
  for (const rate of [2, 10, 50, 100, 1000, 4096, 8192]) {
    const T = shinyThreshold({ rate });
    const c = patched(code, loc, { rate });
    assert.equal(shinyCount((v) => exec(c, isShiny, [0, v]) & 0xff), T, `1 in ${rate}: IsShinyOtIdPersonality`);
    for (const f of [pal1, pal2]) assert.equal(shinyCount((v) => exec(c, f, [25, 0, v]) === 0x2019), T, `1 in ${rate}: palette`);
    assert.equal(shinyCount((v) => exec(c, sparkle, [0, v])), T, `1 in ${rate}: sparkle (its mask still 0xFFFF after the compare)`);
    assert.equal(exec(c, starter, []), 0x1019, `1 in ${rate}: the pictures drawn with SHINY_ODDS stay normal`);
    const mem = new Map();
    let low = 65536;
    for (let i = 0; i < 300; i++) {
      [0, 1, 2, 3].forEach((k) => mem.set(RNG + k, (i * 2654435761 >>> (8 * k)) & 0xff));
      const ot = exec(c, fnOf(loc.loop), [0xabcd1234], mem);
      low = Math.min(low, (ot >>> 16) ^ (ot & 0xffff) ^ 0xabcd ^ 0x1234);
    }
    assert.ok(low >= T, `1 in ${rate}: trainers' OT IDs never shiny (lowest ${low})`);
  }
  // a rate the 8-bit compare takes is patched as in 2.8.0 – the same bytes
  const old = shinyEdits({ ...loc, high: { ok: false } }, { rate: 512 });
  assert.deepEqual(shinyEdits(loc, { rate: 512 }), old);
  // the pictures: 0xFF up to 255, an OT ID of 0x8000 above (`movs r3, #1` first, then `lsls r1, r3, #15`)
  const c = patched(code, loc, { rate: 100 });
  const lit = loc.literals[0];
  assert.deepEqual([...c.subarray(lit, lit + 2)], [0x01, 0x23]);
  assert.deepEqual([...c.subarray(lit + 4, lit + 6)], [0xd9, 0x03]);
});

test('above 255 only where it is safe: a value read after the compare, a branch into the rewrite, a callee reading its argument', () => {
  const F5 = { gen: 5, checks: 1, loops: 0, literals: [0, 0] };
  const F4 = { gen: 4, checks: 1, loops: 1, literals: [0, 0] };
  const F3 = { gen: 3, checks: 4, loops: 1, literals: [1, 1] };
  assert.equal(locateShiny(gen45High().code, F5).high.ok, true);
  assert.deepEqual(locateShiny(gen45High({ live: true }).code, F5).high, { ok: false, why: 'check' }, 'r1 is read after the compare (it changes)');
  assert.deepEqual(locateShiny(gen3High({ live: true }).code, F3).high, { ok: false, why: 'check' }, 'the sparkle reads its value after the compare');
  // a branch from elsewhere into the middle of the rewritten code
  const { code } = gen45High();
  const loc = locateShiny(code, F5);
  const mid = Math.max(...loc.high.checks[0].leaves.map((l) => l.at));
  const c = code.slice();
  const from = 0x380;
  const d = (mid - (from + 4)) >> 1;
  c.set([d & 0xff, 0xe0 | ((d >> 8) & 7)], from);
  assert.equal(locateShiny(c, F5).high.ok, false, '(the trial window ends where a branch lands: too short for the four halves)');
  // a bl into it from anywhere: found by its own scan
  const bl = code.slice();
  const dd = (mid - (0x384 + 4)) >> 1;
  bl.set([(dd >> 11) & 0xff, 0xf0 | ((dd >> 19) & 7), dd & 0xff, 0xf8 | ((dd >> 8) & 7)], 0x384);
  assert.deepEqual(locateShiny(bl, F5).high, { ok: false, why: 'branch' });
  // the loop's way back calls a function that reads the register the rewrite changes
  const b = gen45High({ loop: true });
  const loc4 = locateShiny(b.code, F4);
  assert.equal(loc4.high.ok, true);
  const rd = b.code.slice();
  const rand = 0x40; // (Random() comes first)
  rd.set([0x01, 0x1c], rand); // adds r1, r0, #0 – reads r0 before writing it
  assert.deepEqual(locateShiny(rd, F4).high, { ok: false, why: 'loop' });
  // refused: shinyEdits throws, the 8-bit rates still work
  const bad = locateShiny(gen45High({ live: true }).code, F5);
  assert.throws(() => shinyEdits(bad, { rate: 100 }), /not available/);
  assert.equal(shinyEdits(bad, { rate: 300 }).length, 1);
});

test('liveness: overwritten before read on every path, into called functions, a return reads r0 and r4–r11', () => {
  // movs r1, #0; bx lr – r1 dead; r0 read at the return
  const ret = Uint8Array.of(0x00, 0x21, 0x70, 0x47);
  assert.equal(deadAfter(ret, [0], 1 << 1), true);
  assert.equal(deadAfter(ret, [0], 1 << 0), false);
  assert.equal(deadAfter(ret, [0], 1 << 4), false, 'r4 is the caller’s');
  // beq +2; adds r0, r1, #0 (reads r1); movs r1, #0; bx lr – read on one way
  const fork = Uint8Array.of(0x00, 0xd0, 0x08, 0x1c, 0x00, 0x21, 0x70, 0x47);
  assert.equal(deadAfter(fork, [0], 1 << 1), false);
  assert.equal(deadAfter(fork, [4], 1 << 1), true);
  assert.equal(decode(fork, 0).flow, 'cond');
  assert.equal(decode(Uint8Array.of(0x70, 0x47), 0).flow, 'return');
});

// ---- real ROMs (optional) ------------------------------------------------------------------------------------------
const ROMS = process.env.TWICABLE_TEST_ROMS;
test('real Gen 3–5 ROMs: found, patched on a copy (1 in 512, 100 and 2), the code reads back patched, the check counts right', { skip: !ROMS && 'set TWICABLE_TEST_ROMS' }, () => {
  const dir = mkdtempSync(join(DATA, 'real-'));
  const files = readdirSync(ROMS).filter((f) => ['.gba', '.nds'].includes(extname(f).toLowerCase()));
  let checked = 0;
  for (const f of files) {
    const src = join(ROMS, f);
    const s = shinySupport(src);
    if (!s.ok) continue;
    assert.equal(s.high, true, `${f}: rates above 1 in 257 too`);
    const before = new Uint8Array(readFileSync(src));
    const code = (b) => (extname(f).toLowerCase() === '.gba' ? b : ndsArm9(b).bytes);
    const was = code(before);
    const id = identifyRom(before.subarray(0, 0x200));
    const loc = locateShiny(was, shinyFamily(id.system, id.code));
    for (const shiny of [{ rate: 512, trainers: s.trainers }, { rate: 100 }, { rate: 2, trainers: s.trainers }]) {
      const copy = join(dir, f);
      copyFileSync(src, copy);
      const res = applyShiny(copy, shiny);
      assert.ok(res.changed > 0, f);
      const after = new Uint8Array(readFileSync(copy));
      assert.equal(after.length, before.length, f);
      const now = code(after);
      const edits = shinyEdits(loc, shiny);
      const diff = [...now].map((b, i) => (b !== was[i] ? i : -1)).filter((i) => i >= 0);
      assert.deepEqual(diff, edits.flatMap((e) => e.bytes.map((_, k) => e.at + k)).filter((o) => now[o] !== was[o]), `${f} 1 in ${shiny.rate}`);
      // the check called for every shiny value: Gen 3's IsShinyOtIdPersonality (push {r4, lr}; movs r4, #0), the DS games'
      // leaf check (it starts with the mask, `ldr r3, [pc, #…]`)
      const T = shinyThreshold(shiny);
      const fn = loc.gen === 3
        ? loc.checks.map((at) => fnStart(was, at)).find((o) => was[o] === 0x10 && was[o + 1] === 0xb5 && was[o + 2] === 0x00 && was[o + 3] === 0x24)
        : (() => {
          for (let o = loc.checks[0]; o > loc.checks[0] - 32; o -= 2) if ((was[o + 1] & 0xf8) === 0x48 && (was[o + 1] & 7) === 3) return o;
          return null;
        })();
      assert.ok(fn, `${f}: the check function`);
      assert.equal(shinyCount((v) => exec(now, fn, [0, v]) & 0xff), T, `${f} 1 in ${shiny.rate}: ${T} of 65536 shiny`);
      rmSync(copy);
    }
    checked++;
  }
  assert.ok(checked > 0 || !existsSync(ROMS));
});
