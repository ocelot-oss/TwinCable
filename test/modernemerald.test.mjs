// Modern Emerald (resetes12, built from the pret disassembly with modern mechanics, 50 more species, 15 PC boxes):
// its RAM isn't the retail Emerald's (PokemonModernEmerald3.6.sym: gPlayerParty 0x0201D9CC, gPlayerPartyBackup between
// it and gEnemyParty 0x0201DE7C, gMain 0x03001574, gSaveBlock1Ptr 0x030036F0, SaveBlock1's flags at +0x1364 – the
// retail flag numbers –, SaveBlock2's encryption key past +0xAC, a string right in front of gTrainers). Synthetic data shaped
// like what was measured in the running game (twicable's ROM matrix with the 3.6 patch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-me-'));
process.env.SLS_DATA_DIR = DATA;
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const { partyPair, gen3FlagsAt, gen3RamMoved } = await import('../shared/live/romloc.mjs');
const { gen3Trainers } = await import('../shared/live/romcaps.mjs');
const { readLiveParty, readLiveBattle, findEntry, LiveTables, expandedEntry } = await import('../shared/live/parse.mjs');
const { addRareCandies, cheatSupported } = await import('../shared/live/cheats.mjs');
const { romFeatures } = await import('../shared/live/features.mjs');

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const addresses = json('addresses.json');
const cs3 = json('charset_gen3.json');
const emerald = findEntry(addresses, { platform: 'gba', code: 'BPEE' });
const put32 = (b, o, v) => {
  for (let i = 0; i < 4; i++) b[o + i] = (v >>> (i * 8)) & 0xff;
};
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

function gba(size) {
  const rom = new Uint8Array(size);
  rom[3] = 0xea;
  rom[0xb2] = 0x96;
  rom.set([...'BPEE'].map((c) => c.charCodeAt(0)), 0xac);
  return rom;
}
/** A literal pool holding `value` `n` times (with `neighbours` right behind it). */
const pool = (rom, at, value, n, neighbours = []) => {
  for (let i = 0; i < n; i++) {
    put32(rom, at + i * 16, value);
    neighbours.forEach((v, k) => put32(rom, at + i * 16 + 4 + k * 4, v));
  }
};

test('Modern Emerald: the party pair two arrays apart, the flags offset and moved RAM come from the code', () => {
  const rom = gba(0x40000);
  pool(rom, 0x1000, 0x0201d9cc, 60); // gPlayerParty (600 times in 3.6)
  pool(rom, 0x2000, 0x0201dc24, 2); // gPlayerPartyBackup (twice)
  pool(rom, 0x3000, 0x0201de7c, 25); // gEnemyParty (205 times)
  pool(rom, 0x4000, 0x0200141c, 30); // something else busy …
  pool(rom, 0x5000, 0x02001674, 21); // … 600 bytes from something else
  assert.deepEqual(partyPair(rom), { player: 0x0201d9cc, enemy: 0x0201de7c });
  // GetFlagPointer's pool (newer compiler): -0x4000, gSpecialFlags, the flags' offset, gSaveBlock1Ptr – inlined 5 times
  for (let i = 0; i < 5; i++) [0xffffc000, 0x020067dc, 0x1364, 0x030036f0].forEach((v, k) => put32(rom, 0x6000 + i * 32 + k * 4, v));
  // another function with gSaveBlock1Ptr and a SaveBlock1 offset, no special-flag bound near it
  pool(rom, 0x7000, 0x030036f0, 8, [0x490]);
  assert.deepEqual(gen3FlagsAt(rom, [0x03003c10, 0x030036f0]), { sb1Ptr: 0x030036f0, flags: 0x1364 });
  assert.equal(gen3FlagsAt(rom, [0x03003c10]), null, 'only the addresses the code names most');
  // the retail build: 0x3FFF, gSaveBlock1Ptr, 0x1270 (measured in Emerald)
  const retail = gba(0x10000);
  for (let i = 0; i < 3; i++) [0x3fff, 0x03005d8c, 0x1270].forEach((v, k) => put32(retail, 0x1000 + i * 32 + k * 4, v));
  assert.deepEqual(gen3FlagsAt(retail, [0x03005d8c]), { sb1Ptr: 0x03005d8c, flags: 0x1270 });
  // the base game's gPlayerParty named all over (retail, binary hacks) – or hardly at all (a decomp hack's moved RAM)
  const kept = gba(0x10000);
  pool(kept, 0x1000, 0x020244ec, 40);
  assert.equal(gen3RamMoved(kept, emerald), false);
  assert.equal(gen3RamMoved(rom, emerald), true);
});

test('gTrainers: text right in front of the table doesn\'t number every trainer one too high (Roxanne got Brawly\'s script)', () => {
  const code3 = Object.fromEntries(Object.entries(cs3.table).filter(([, v]) => v.length === 1).map(([k, v]) => [v, parseInt(k, 16)]));
  const enc = (str) => [...str].map((c) => code3[c]);
  const rom = gba(0x20000);
  const at = 0x4000; // gTrainers: 40 bytes per trainer, trainer 0 empty
  // the strings in front of it (Modern Emerald: "… Pyramid King", "Trainer Nurse"): pass for an empty trainer 40 bytes before
  rom.set([...enc('mid King'), 0xff], at - 36);
  rom[at + 4] = 0xff; // TRAINER_NONE
  for (let i = 1; i <= 120; i++) {
    const o = at + i * 40;
    rom.set([...enc(i === 34 ? 'Roxanne' : 'Sawyer'), 0xff], o + 4);
    rom[o + 0x20] = 1;
    put32(rom, o + 0x24, 0x08010000 + i * 8);
  }
  const tr = gen3Trainers(rom, cs3.table);
  assert.equal(tr.offset, at);
  assert.equal(tr.list.find((t) => t.name === 'Roxanne').id, 34);
});

/** A party struct (100 bytes): the retail layout, a valid checksum. */
function pk3({ pid, otId, species, level = 5, hp = 20, maxHp = 20 }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d[8] = 0xff;
  d[0x13] = 0x02;
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][pid % 24];
  const plain = new Uint8Array(48);
  const pv = new DataView(plain.buffer);
  pv.setUint16(order.indexOf('G') * 12, species, true);
  pv.setUint16(order.indexOf('A') * 12, 33, true); // Tackle
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + pv.getUint16(i, true)) & 0xffff;
  dv.setUint16(28, sum, true);
  const key = (pid ^ otId) >>> 0;
  for (let i = 0; i < 48; i += 4) dv.setUint32(32 + i, (pv.getUint32(i, true) ^ key) >>> 0, true);
  d[84] = level;
  dv.setUint16(86, hp, true);
  dv.setUint16(88, maxHp, true);
  return d;
}

/** EWRAM + IWRAM as the game keeps them (the bus addresses), with writes. */
function gbaMemory() {
  const ew = new Uint8Array(0x40000);
  const iw = new Uint8Array(0x8000);
  const at = (a) => (a >= 0x03000000 ? [iw, a - 0x03000000] : [ew, a - 0x02000000]);
  const mem = {
    writes: 0,
    put(a, bytes) {
      const [r, o] = at(a);
      r.set(bytes, o);
    },
    read(a, n) {
      const [r, o] = at(a);
      return o >= 0 && o + n <= r.length ? r.slice(o, o + n) : null;
    },
    write(a, bytes) {
      mem.writes++;
      mem.put(a, bytes);
      return true;
    },
  };
  return mem;
}

const ME = 0x411d0a72; // the player's trainer ID (OT ID of their own Pokémon)
const SB1P = 0x030036f0;
const SB1 = 0x0200f700;
const SB2 = 0x02000800;
const KEY = 0x6d58a1c3;
const KEY_AT = 0xc8; // (behind the options Modern Emerald added in front of encryptionKey)
const STORAGE = 0x02030000;

/** Modern Emerald 3.6 mid-battle: Torchic against a wild Zigzagoon, two badges, a Wurmple in the 15th box. */
function modernEmerald() {
  const m = gbaMemory();
  const torchic = pk3({ pid: 0xbb38a7b4, otId: ME, species: 280, level: 5, hp: 20, maxHp: 20 });
  const zigzagoon = pk3({ pid: 0x67da6cfd, otId: ME, species: 288, level: 2, hp: 13, maxHp: 13 });
  m.put(0x0201d9c9, [1]); // gPlayerPartyCount
  m.put(0x0201d9cc, torchic); // gPlayerParty
  m.put(0x0201dc24, torchic); // gPlayerPartyBackup: a copy of the team
  m.put(0x0201de7c, zigzagoon); // gEnemyParty
  m.put(0x03001574 + 0x439, [0x02]); // gMain.inBattle
  // gBattleMons (the retail BattlePokemon, 0x58 bytes): battler 0 ours, 1 the wild one
  const battler = (i, raw, species, hp, maxHp, level) => {
    const b = 0x0200143c + i * 0x58;
    m.put(b, le16(species));
    m.put(b + 0x28, le16(hp));
    m.put(b + 0x2a, [level]);
    m.put(b + 0x2c, le16(maxHp));
    m.put(b + 0x48, raw.subarray(0, 4));
    m.put(b + 0x54, raw.subarray(4, 8));
  };
  battler(0, torchic, 280, 17, 20, 5);
  battler(1, zigzagoon, 288, 6, 13, 2);
  // the save blocks: pointers, trainer ID, flags (has a Pokémon 0x860, badges 0x867 + 0x868)
  m.put(SB1P, le32(SB1));
  m.put(SB1P + 4, le32(SB2));
  m.put(SB1P + 8, le32(STORAGE));
  m.put(SB2 + 0x0a, le32(ME));
  const setFlag = (f) => m.put(SB1 + 0x1364 + (f >> 3), [(m.read(SB1 + 0x1364 + (f >> 3), 1)[0] | (1 << (f & 7)))]);
  [0x860, 0x867, 0x868].forEach(setFlag);
  // the bag: every quantity (an empty slot's too) XORed with the key's low half, the money with all of it
  m.put(SB2 + 0xac, le32(0x00000016)); // (the retail key's place holds something else)
  m.put(SB2 + KEY_AT, le32(KEY));
  m.put(SB1 + 0x490, le32((3000 ^ KEY) >>> 0));
  const k = KEY & 0xffff;
  for (let i = 0; i < 30; i++) m.put(SB1 + 0x560 + i * 4, [...le16(i === 0 ? 13 : 0), ...le16((i === 0 ? 5 : 0) ^ k)]); // Potion ×5
  for (let i = 0; i < 16; i++) m.put(SB1 + 0x650 + i * 4, [...le16(0), ...le16(k)]);
  // the PC: 15 boxes, names "BOX1" … and wallpapers behind them
  m.put(STORAGE, [0]);
  m.put(STORAGE + 4 + 14 * 30 * 80, pk3({ pid: 0x1234567c, otId: ME, species: 290, level: 3 }).subarray(0, 80));
  for (let b = 0; b < 15; b++) m.put(STORAGE + 4 + 15 * 2400 + b * 9, [0xbc, 0xc9, 0xd2, 0xa1 + b, 0xff]);
  return { m, torchic, zigzagoon };
}

const species = Object.assign([], { 280: 255, 288: 263, 290: 265, 412: 424 }); // (a Modern Emerald index past 411)
const items = Object.assign(new Array(398).fill(''), { 4: 'Poké Ball', 13: 'Potion', 68: 'Rare Candy' });
const T = new LiveTables({ charsetGen3: cs3 }).withSpecies({ engine: 'expanded', map: species }, { items: { names: items } }).withRom({ caps: { badgeFlags: 0x867 } });
const maps3 = { party3: { player: 0x0201d9cc, enemy: 0x0201de7c }, gMain: 0x03001574, flags3: { sb1Ptr: SB1P, flags: 0x1364 }, iwram: [0x03003c10, SB1P, SB1P + 4] };

test('Modern Emerald live: the team, the wild battle, two badges and the 15th PC box', () => {
  const { m } = modernEmerald();
  const entry = expandedEntry(emerald, maps3, items);
  assert.equal(entry.retail3, true, 'retail save data and item numbers');
  assert.equal(entry.inBattle.addr, '0x30019ad', 'gMain + 0x439');
  const state = { sb1PtrAddr: SB1P }; // (the place reader found gSaveBlock1Ptr: location.mjs readGen3x)
  const r = readLiveParty(entry, m.read, T, state);
  assert.deepEqual(r.party.map((x) => [x.species, x.level, x.hp]), [[255, 5, 20]]);
  assert.equal(state.enemy3, 0x0201de7c, 'gEnemyParty where the code names it, not right behind the team');
  assert.equal(r.badges, 2);
  assert.deepEqual(r.boxes.map((x) => [x.species, x.box, x.slot]), [[265, 14, 0]]);
  const fight = readLiveBattle(entry, m.read, T, state, r.party);
  assert.equal(fight.kind, 'wild');
  assert.deepEqual([fight.enemy.species, fight.enemy.level, fight.enemy.hp, fight.enemy.maxHp], [263, 2, 6, 13]);
  assert.deepEqual([fight.active.index, fight.active.hp], [0, 17]);
});

test('Modern Emerald live without the code\'s hint: gEnemyParty is found in battle (not the backup of the team)', () => {
  const { m } = modernEmerald();
  const entry = expandedEntry(emerald, { ...maps3, party3: null }, items);
  const state = { sb1PtrAddr: SB1P };
  const r = readLiveParty(entry, m.read, T, state);
  assert.equal(state.enemy3, 0x0201dc24, 'first guess: right behind the team (the backup)');
  const fight = readLiveBattle(entry, m.read, T, state, r.party);
  assert.equal(fight.enemy.species, 263);
  assert.equal(state.enemy3, 0x0201de7c);
});

test('Modern Emerald: badges and boxes stay unread where they don\'t check out', () => {
  // no "has a Pokémon" flag at the offset the code names: no badge count (rather than 0)
  const { m } = modernEmerald();
  const entry = expandedEntry(emerald, { ...maps3, flags3: { sb1Ptr: SB1P, flags: 0x1270 } }, items);
  const r = readLiveParty(entry, m.read, T, { sb1PtrAddr: SB1P });
  assert.equal(r.badges, undefined);
  // a PC slot that doesn't read (a packed or other struct): no boxes at all – else its Pokémon would look released
  const b = modernEmerald();
  b.m.put(STORAGE + 4 + 80, new Uint8Array(80).fill(0x5a));
  const r2 = readLiveParty(expandedEntry(emerald, maps3, items), b.m.read, T, { sb1PtrAddr: SB1P });
  assert.equal(r2.boxes, undefined);
  // an engine that numbers its items its own way (Run & Bun: Master Ball 4, Calcium 68): no cheats – but its PC is read
  // where it checks out like any other (the bag and the boxes are separate things, #77)
  const rb = expandedEntry(emerald, maps3, Object.assign([], { 4: 'Master Ball', 68: 'Calcium' }));
  assert.equal(rb.retail3, undefined);
  assert.deepEqual(readLiveParty(rb, modernEmerald().m.read, T, { sb1PtrAddr: SB1P }).boxes.map((x) => [x.species, x.box, x.slot]), [[265, 14, 0]]);
  assert.equal(readLiveParty(rb, b.m.read, T, { sb1PtrAddr: SB1P }).boxes, undefined, 'and not where a slot doesn’t read');
  assert.equal(cheatSupported(rb), false);
});

test('Modern Emerald: Rare Candies go into the bag through the found save blocks and the moved encryption key', () => {
  const { m } = modernEmerald();
  const entry = expandedEntry(emerald, maps3, items);
  assert.equal(cheatSupported(entry), true);
  assert.deepEqual(addRareCandies(entry, m, {}), { error: 'notFound' }, 'not before the save blocks are found');
  assert.equal(m.writes, 0);
  const res = addRareCandies(entry, m, { sb1PtrAddr: SB1P }, 99);
  assert.deepEqual(res, { ok: true, before: 0, after: 99, added: 99 });
  const slot1 = m.read(SB1 + 0x564, 4);
  assert.deepEqual([slot1[0] | (slot1[1] << 8), (slot1[2] | (slot1[3] << 8)) ^ (KEY & 0xffff)], [68, 99]);
});

test('Modern Emerald: what twicable reads from the ROM – level caps too now that its badge flags are known', () => {
  const rom = { header: { system: 'gba', code: 'BPEE', title: 'POKEMON EMER' }, species: { engine: 'expanded', map: species }, data: { names: ['x'], maps3 }, items: { names: items }, caps: { caps: [15, 19, 24, 29, 31, 33, 42, 46], badgeFlags: 0x867 } };
  const f = romFeatures(rom, addresses);
  assert.deepEqual([f.party, f.battle, f.catch, f.items, f.caps], ['yes', 'yes', 'yes', 'yes', 'yes']);
  assert.equal(romFeatures({ ...rom, caps: { ...rom.caps, badgeFlags: null } }, addresses).caps, 'no');
  // a decomp hack with the retail species whose RAM moved: its caps need the badge flags as well
  const moved = { ...rom, species: { engine: 'vanilla' }, data: { names: ['x'], maps3: { ...maps3, moved: true } }, caps: { ...rom.caps, badgeFlags: null } };
  assert.equal(romFeatures(moved, addresses).caps, 'no');
});
