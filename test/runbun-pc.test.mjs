// #77: Run & Bun (Emerald, an expanded engine) – a Pokémon fished in Littleroot Town wasn't filed, the place sign kept
// "First encounter open". What twincable read from the running game (checked in Run & Bun 1.07 with the ROM test
// matrix): Littleroot (map 0.9, region map section 0) has a pond and a fishing table of its own (Surskit, Lotad, Finneon,
// Tympole at Lv 2–3); a fished Pokémon carries met location 0, and with room in the team it was filed under "Littleroot
// Town" as it should be. With a full team the game sends the catch to the PC – and twincable didn't read Run & Bun's PC
// at all (only expanded engines that kept the retail item numbers), so the catch stayed unseen until it joined the team.
// Run & Bun keeps the PC where Emerald does (gPokemonStoragePtr right after the save block pointers, 14 boxes "Box1" …).
// These tests feed the live readers simulated RAM (the layout measured in the game) and the run logic the snapshots
// the play view would make from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { readLiveParty, findEntry, expandedEntry, LiveTables } from '../shared/live/parse.mjs';
import { readLocation } from '../shared/live/location.mjs';

const ROOT = new URL('../', import.meta.url);
const json = (f) => JSON.parse(readFileSync(new URL(`shared/data/${f}`, ROOT), 'utf8'));
const cs3 = json('charset_gen3.json');
const idx3 = json('gen3_index_to_dex.json');
const maps = json('maps.json');
const emerald = findEntry(json('addresses.json'), { platform: 'gba', code: 'BPEE' });
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const ME = 0x1bcd2d7b; // the player's trainer ID

/** A Gen 3 party struct (100 bytes): encrypted, checksummed, met at `met` (region map section) at level `metLevel`. */
function pk3({ pid, otId = ME, internal, level, hp = 15, maxHp = 15, met = 0, metLevel = level }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d.fill(0xff, 8, 18);
  d[0x13] = 0x02; // has species
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][pid % 24];
  const plain = new Uint8Array(48);
  const pv = new DataView(plain.buffer);
  pv.setUint16(order.indexOf('G') * 12, internal, true);
  pv.setUint16(order.indexOf('A') * 12, 33, true); // Tackle
  plain[order.indexOf('M') * 12 + 1] = met; // metLocation
  pv.setUint16(order.indexOf('M') * 12 + 2, metLevel & 0x7f, true); // origins: met level (+ game, ball)
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

/** EWRAM + IWRAM at their bus addresses. */
function gbaMemory() {
  const ew = new Uint8Array(0x40000);
  const iw = new Uint8Array(0x8000);
  const at = (a) => (a >= 0x03000000 ? [iw, a - 0x03000000] : [ew, a - 0x02000000]);
  return {
    put(a, bytes) {
      const [r, o] = at(a);
      r.set(bytes, o);
    },
    read(a, n) {
      const [r, o] = at(a);
      return o >= 0 && o + n <= r.length ? r.slice(o, o + n) : null;
    },
  };
}

/** A PC (PokemonStorage) at `at`: `n` boxes, names "Box1" … and wallpapers behind them; `mons` = [[box, slot, pk3]]. */
function putStorage(m, at, mons, n = 14) {
  m.put(at, [0]); // currentBox
  for (const [box, slot, mon] of mons) m.put(at + 4 + (box * 30 + slot) * 80, mon.subarray(0, 80));
  const enc = (s) => [...s].map((c) => (c >= '0' && c <= '9' ? 0xa1 + Number(c) : c === 'B' ? 0xbc : c === 'o' ? 0xe3 : 0xec));
  for (let b = 0; b < n; b++) m.put(at + 4 + n * 2400 + b * 9, [...enc(`Box${b + 1}`), 0xff]);
}

// Run & Bun 1.07 as measured (rom-matrix probe in Littleroot Town): the team at 0x02023A98 (count 3 bytes before it),
// gSaveBlock1Ptr 0x03005D9C → SaveBlock1 0x02024CBC (x, y, map group, map number), gSaveBlock2Ptr 0x03005DA0,
// gPokemonStoragePtr 0x03005DA4 → 0x02028848. Species in National Dex order (the ROM's own table, by name).
const RB = { party: 0x02023a98, sb1Ptr: 0x03005d9c, sb1: 0x02024cbc, sb2: 0x02024018, storage: 0x02028848 };
const rbSpecies = Object.assign([], { 390: 390, 270: 270, 283: 283, 263: 263, 265: 265, 261: 261, 293: 293, 396: 396 });
// (its own item numbers: Poké Ball 1, Master Ball 4, Calcium 68 – no retail bag, no cheats)
const rbItems = Object.assign([], { 1: 'Poké Ball', 4: 'Master Ball', 68: 'Calcium', 709: 'Old Rod' });
const rbT = new LiveTables({ charsetGen3: cs3, gen3Index: idx3 }).withSpecies({ engine: 'expanded', map: rbSpecies }, { items: { names: rbItems } });
// romloc.mjs gen3MapTable of Run & Bun 1.07: Littleroot Town is map 0.9 (and its houses/lab 1.x), section 0
const rbRom = { gen: 3, family: 'rse', lang: 'en', vanilla: false, names: Object.assign([], { 0: 'Littleroot Town', 16: 'Route 101' }), mapLoc: null,
  maps3: { mapsec: { '0.9': 0, '1.4': 0, '0.16': 16 }, iwram: [0x03005e10, RB.sb1Ptr], party3: { player: RB.party, enemy: RB.party + 600 } } };
const rbEntry = expandedEntry(emerald, rbRom.maps3, rbItems);

const chimchar = pk3({ pid: 0x0badf00d, internal: 390, level: 9, met: 255, metLevel: 5 }); // the starter (a gift: 255)
const lotad = pk3({ pid: 0x13572468, internal: 270, level: 3, met: 0 }); // fished in Littleroot Town
const others = [263, 265, 261, 293, 396].map((internal, i) => pk3({ pid: 0x22220000 + i * 0x101, internal, level: 6, met: 16 }));

/** Run & Bun's RAM in Littleroot Town: the team, the save blocks, the PC (with `boxed` in it). */
function runAndBun(team, boxed = []) {
  const m = gbaMemory();
  m.put(RB.party - 3, [team.length]);
  team.forEach((mon, i) => m.put(RB.party + i * 100, mon));
  m.put(RB.sb1Ptr, le32(RB.sb1));
  m.put(RB.sb1Ptr + 4, le32(RB.sb2));
  m.put(RB.sb1Ptr + 8, le32(RB.storage));
  m.put(RB.sb1, [...le16(15), ...le16(14), 0, 9]); // x 15, y 14 (at the pond), map 0.9
  m.put(RB.sb2 + 0x0a, le32(ME));
  putStorage(m, RB.storage, boxed);
  return m;
}

/** What the play view does each poll: the place sign, the team (+ PC), and the snapshot it hands the run. */
function poll(m, entry, T, rom, state) {
  const loc = readLocation(maps, entry, m.read, { rom, state });
  const here = loc ? { gen: loc.gen, id: loc.id, name: loc.romName || rom?.names?.[loc.id] || '' } : null;
  const res = readLiveParty(entry, m.read, T, state);
  return { here, res, snap: { source: 'live', party: res.party, boxes: res.boxes || null, game: entry.id, here } };
}

async function runLogic(rom) {
  registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(new URL(spec.slice(1), ROOT).href, ctx) : next(spec, ctx)) });
  const R = await import('../web/lib/run.mjs');
  const { RunDoc } = await import('../web/lib/doc.mjs');
  R.setRomPlaces(rom);
  const doc = new RunDoc('t77');
  doc.by = 'a';
  doc._persistSoon = () => {};
  return { R, doc };
}

const nuzlocke = (hackId) => ({ id: 't77', mode: 'nuzlocke', players: { p1: { name: 'A' } }, game: { system: 'gba', code: 'BPEE', ...(hackId ? { hackId } : {}) } });

test('Run & Bun: a Pokémon fished in Littleroot Town (met location 0) is filed under Littleroot Town – the sign’s area', async () => {
  const { R, doc } = await runLogic(rbRom);
  const manifest = nuzlocke('run-and-bun');
  const state = {};
  const before = poll(runAndBun([chimchar]), rbEntry, rbT, rbRom, state);
  assert.deepEqual(before.here, { gen: 3, id: 0, name: 'Littleroot Town' });
  R.applySnapshot(doc, manifest, 3, 'p1', before.snap);
  assert.equal(doc.get('enc:starter:p1').species, 390);
  const sign = R.areaForPlace(doc, manifest, 3, before.here);
  assert.equal(sign, 'm3-0');
  assert.equal(R.encounter(doc, sign, 'p1'), null, 'the sign: first encounter open');
  // the fishing battle (wild), then Lotad joins the team
  R.applySnapshot(doc, manifest, 3, 'p1', before.snap, { battle: { kind: 'wild', enemy: { species: 270, level: 3 } } });
  const after = poll(runAndBun([chimchar, lotad]), rbEntry, rbT, rbRom, state);
  assert.deepEqual(after.res.party.map((x) => [x.species, x.metLocation, x.metLevel]), [[390, 255, 5], [270, 0, 3]]);
  const out = R.applySnapshot(doc, manifest, 3, 'p1', after.snap);
  assert.deepEqual(out.newCatches, ['m3-0']);
  assert.equal(R.areaName(doc, manifest, 'm3-0'), 'Littleroot Town');
  assert.equal(R.encounter(doc, R.areaForPlace(doc, manifest, 3, after.here), 'p1').species, 270, 'the sign now shows the catch');
});

test('Run & Bun: with a full team the fished Pokémon goes to the PC – read there and filed under Littleroot Town (#77)', async () => {
  const { R, doc } = await runLogic(rbRom);
  const manifest = nuzlocke('run-and-bun');
  const team = [chimchar, ...others];
  const state = {};
  const first = poll(runAndBun(team), rbEntry, rbT, rbRom, state);
  assert.equal(first.res.party.length, 6);
  assert.equal(state.sb1PtrAddr, RB.sb1Ptr, 'the place reader found the save block pointers');
  assert.deepEqual(first.res.boxes, [], 'an empty PC reads as one (14 boxes), not as "unknown"');
  // (the team as the run knows it: the starter, one of them filed on Route 101, the others waiting in the inbox)
  R.applySnapshot(doc, manifest, 3, 'p1', first.snap);
  assert.equal(R.encounter(doc, 'm3-0', 'p1'), null);
  // a wild battle that ends without a catch is asked about now that the PC is seen (before: never with six in the team)
  assert.equal(R.missedQuestion(doc, manifest, null, 'p1', { foe: { species: 270 }, wild: true, from: 1, newMonAt: 0, boxes: Array.isArray(first.res.boxes), partySize: 6, here: first.here }), true);
  // the catch: Lotad into box 1, slot 1 (the PC is read every 2.5 s – a new poll a moment later)
  state.box3At = 0;
  const after = poll(runAndBun(team, [[0, 0, lotad]]), rbEntry, rbT, rbRom, state);
  assert.deepEqual(after.res.boxes.map((x) => [x.species, x.metLocation, x.box, x.slot]), [[270, 0, 0, 0]]);
  const out = R.applySnapshot(doc, manifest, 3, 'p1', after.snap);
  assert.deepEqual(out.newCatches, ['m3-0']);
  assert.equal(R.encounter(doc, R.areaForPlace(doc, manifest, 3, after.here), 'p1').species, 270);
  assert.equal(out.alerts.filter((a) => a.type === 'missing').length, 0, 'nobody of the team looks released');
});

test('Run & Bun: a PC that doesn’t check out is not read (and not every poll)', () => {
  const team = [chimchar, ...others];
  // a slot that doesn't read (a packed or other struct): no boxes – else its Pokémon would look released
  const m = runAndBun(team, [[0, 0, lotad]]);
  m.put(RB.storage + 4 + 80, new Uint8Array(80).fill(0x5a));
  const state = {};
  readLocation(maps, rbEntry, m.read, { rom: rbRom, state });
  assert.equal(readLiveParty(rbEntry, m.read, rbT, state).boxes, undefined);
  // no box names behind 14–24 boxes: no PC either
  const n = runAndBun(team);
  n.put(RB.storage + 4 + 14 * 2400, new Uint8Array(14 * 10).fill(0));
  const s2 = {};
  readLocation(maps, rbEntry, n.read, { rom: rbRom, state: s2 });
  assert.equal(readLiveParty(rbEntry, n.read, rbT, s2).boxes, undefined);
  // a failed read is tried again only after 2.5 s
  let reads = 0;
  const counting = { read: (a, len) => (a === RB.storage + 4 + 14 * 2400 || a === RB.storage ? reads++ : 0, n.read(a, len)) };
  readLiveParty(rbEntry, counting.read, rbT, s2);
  assert.equal(reads, 0, 'within 2.5 s of the miss');
  s2.box3Miss = 0;
  readLiveParty(rbEntry, counting.read, rbT, s2);
  assert.ok(reads > 0, 'and again after it');
  // before the place reader found the save block pointers: nothing (no guessing where they are)
  assert.equal(readLiveParty(rbEntry, runAndBun(team, [[0, 0, lotad]]).read, rbT, {}).boxes, undefined);
});

test('Emerald: a Pokémon caught in Littleroot Town (section 0) – in the team or in the PC – is filed there too', async () => {
  const rom = { gen: 3, family: 'rse', lang: 'en', vanilla: true, names: Object.assign([], { 0: 'Littleroot Town' }), mapLoc: null };
  const { R, doc } = await runLogic(rom);
  const manifest = nuzlocke(null);
  const T = new LiveTables({ charsetGen3: cs3, gen3Index: idx3 });
  const internal = (dex) => Number(Object.entries(idx3.map).find(([, v]) => v === dex)[0]);
  const mudkip = pk3({ pid: 0x0badf00d, internal: internal(258), level: 9, met: 16, metLevel: 5 });
  const poochyena = (i) => pk3({ pid: 0x22220000 + i * 0x101, internal: internal(261), level: 6, met: 16 });
  const lotadE = pk3({ pid: 0x13572468, internal: internal(270), level: 3, met: 0 });
  const mem = (team, boxed = []) => {
    const m = gbaMemory();
    m.put(Number(emerald.partyCountAddr), [team.length]);
    team.forEach((mon, i) => m.put(Number(emerald.partyAddr) + i * 100, mon));
    // gMapHeader: layout and events in the ROM, section 0 (Littleroot Town)
    const hdr = Number(maps.games.emerald_us.mapHeaderAddr);
    m.put(hdr, [...le32(0x08481234), ...le32(0x08485678)]);
    m.put(hdr + 0x14, [0]);
    // gPokemonStoragePtr (0x03005D94) → the PC
    m.put(0x03005d94, le32(0x02029808));
    putStorage(m, 0x02029808, boxed);
    return m;
  };
  const state = {};
  const one = poll(mem([mudkip]), emerald, T, null, state);
  assert.equal(one.here.id, 0);
  R.applySnapshot(doc, manifest, 3, 'p1', one.snap);
  const two = poll(mem([mudkip, lotadE]), emerald, T, null, state);
  assert.deepEqual(R.applySnapshot(doc, manifest, 3, 'p1', two.snap).newCatches, ['m3-0']);
  assert.equal(R.encounter(doc, R.areaForPlace(doc, manifest, 3, { ...two.here, name: 'Littleroot Town' }), 'p1').species, 270);
  // the same catch with a full team, into the PC
  const { doc: doc2 } = await runLogic(rom);
  const six = [mudkip, ...[0, 1, 2, 3, 4].map(poochyena)];
  const s2 = {};
  R.applySnapshot(doc2, manifest, 3, 'p1', poll(mem(six), emerald, T, null, s2).snap);
  s2.box3At = 0;
  const boxed = poll(mem(six, [[0, 0, lotadE]]), emerald, T, null, s2);
  assert.deepEqual(boxed.res.boxes.map((x) => [x.species, x.metLocation]), [[270, 0]]);
  const out = R.applySnapshot(doc2, manifest, 3, 'p1', boxed.snap);
  assert.deepEqual(out.newCatches, ['m3-0']);
  assert.equal(R.encounter(doc2, 'm3-0', 'p1').species, 270);
});
