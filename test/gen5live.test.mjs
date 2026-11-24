// Black/White and Black 2/White 2 live tracking: status conditions (#5), badges and level caps (#13), place names of
// catches filed under a number (#14) and held item names (#15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { findEntry, readLiveParty, readLiveBattle, playerBattle, withBattleHp, confirmFaints, LiveTables, gen5Status } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';
import { statusKey } from '../shared/overlay.mjs';
import { vanillaCapFor, gymCapsFamily } from '../shared/routes.mjs';
import { levelCapOf } from '../shared/streamapi.mjs';

// web/lib/*.mjs import browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');
const { loadData, itemName } = await import('../web/lib/data.mjs');

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const T = new LiveTables({
  charsetGen1: L('charset_gen1.json'), charsetGen2: L('charset_gen2.json'), charsetGen3: L('charset_gen3.json'),
  gen1Index: L('gen1_index_to_dex.json'), gen3Index: L('gen3_index_to_dex.json'), gen4: L('gen4.json'),
});
const TABLE = L('addresses.json');

function memory() {
  const blocks = [];
  return {
    write(addr, bytes) { blocks.push({ addr, bytes: Uint8Array.from(bytes) }); },
    read(addr, len) {
      const out = new Uint8Array(len);
      for (const b of blocks) {
        for (let i = 0; i < len; i++) {
          const o = addr + i - b.addr;
          if (o >= 0 && o < b.bytes.length) out[i] = b.bytes[o];
        }
      }
      return out;
    },
  };
}

const TID = 31337;
const SID = 4242;
function pk5({ pid, species = 495, level = 9, hp = 25, maxHp = 30, status = 0, item = 0, form = 0 }) {
  const mon = new Uint8Array(220);
  const dv = new DataView(mon.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0a, item, true);
  mon[0x40] = form << 3;
  dv.setUint16(0x0c, TID, true);
  dv.setUint16(0x0e, SID, true);
  dv.setUint32(0x88, status, true);
  mon[0x8c] = level;
  dv.setUint16(0x8e, hp, true);
  dv.setUint16(0x90, maxHp, true);
  for (let i = 0x92; i < 0x9c; i += 2) dv.setUint16(i, 20 + i, true);
  return encryptPK4(mon);
}

// Black 2: the party behind the pointer at 0x02000024 (+0x19728 to the mons), the save blocks around it as in the .sav
const CORE = 0x02000000 + 0x200000 + 0x19728 - 8;
function black2({ mons, badges = 0, money = 3000, tid = TID, sid = SID }) {
  const m = memory();
  m.write(0x02000024, [0x00, 0x00, 0x20, 0x02]);
  m.write(CORE, [6, 0, 0, 0, mons.length, 0, 0, 0, ...mons.flatMap((x) => [...x])]);
  m.write(CORE + 0x600 + 0x14, [tid & 0xff, tid >> 8, sid & 0xff, sid >> 8]); // trainer data block (0x19400)
  m.write(CORE + 0x8300, [money & 0xff, (money >> 8) & 0xff, (money >> 16) & 0xff, money >>> 24, badges]); // Misc (0x21100)
  return m;
}

test('Gen 5 status conditions are a number, not Gen 4 bits: poison shows as poison, not sleep (#5)', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map((s) => statusKey({ status: gen5Status(s) })), ['', 'par', 'slp', 'frz', 'brn', 'psn', '', '']);
  const e = findEntry(TABLE, { platform: 'nds', code: 'IREO' });
  const mons = [1, 2, 3, 4, 5].map((status, i) => pk5({ pid: 0x10000 + i * 0x777, species: 495 + i, status }));
  const r = readLiveParty(e, black2({ mons }).read, T, {});
  assert.deepEqual(r.party.map((x) => statusKey(x)), ['par', 'slp', 'frz', 'brn', 'psn']);
  // Gen 4 keeps its bits (HeartGold: 8 = poison)
  assert.equal(statusKey({ status: 8 }), 'psn');
});

test('Gen 5 badges come from the save blocks next to the party – only when they belong to this trainer (#13)', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IREO' });
  const mons = [pk5({ pid: 0xabcdef01 })];
  assert.equal(readLiveParty(e, black2({ mons, badges: 0b00000111 }).read, T, {}).badges, 3);
  assert.equal(readLiveParty(e, black2({ mons, badges: 0 }).read, T, {}).badges, 0);
  assert.equal(readLiveParty(e, black2({ mons, badges: 0xff }).read, T, {}).badges, 8);
  // another trainer's data there (not the save blocks), or no money amount: unknown, never a guess
  assert.equal(readLiveParty(e, black2({ mons, badges: 3, tid: 1 }).read, T, {}).badges, undefined);
  assert.equal(readLiveParty(e, black2({ mons, badges: 3, money: 0x7fffffff }).read, T, {}).badges, undefined);
});

test('Black 2: the summary screen (flag 0x88C2) is no battle – the catching demo\'s leftover Patrat stays off the panel (#9)', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IREO' });
  const mons = [pk5({ pid: 0xabcdef01 })];
  const m = black2({ mons });
  // a freed copy of the demo battle's party: none of the player's Pokémon, another trainer
  const demo = pk5({ pid: 0x5eed0001, species: 504, level: 2, hp: 11, maxHp: 11 });
  m.write(0x02300000, [6, 0, 0, 0, 1, 0, 0, 0, ...demo]);
  const poll = (ent, flag, state, n = 6) => {
    m.write(0x021b5138, [flag & 0xff, flag >> 8]);
    let fight = null;
    for (let i = 0; i < n; i++) fight = readLiveBattle(ent, m.read, T, state, readLiveParty(ent, m.read, T, state).party);
    return fight;
  };
  assert.equal(poll(e, 0x2800, {}), null, 'overworld');
  assert.equal(poll(e, 0x88c2, {}), null, 'summary screen: no battle');
  assert.equal(poll(e, 0x2100, {})?.enemy?.species, 504, 'a real battle still shows (here the copy stands in for its opponent)');
  // one odd read in the middle of a battle doesn't end it for good – a few in a row do
  const fight = {};
  assert.equal(poll(e, 0x2100, fight)?.enemy?.species, 504);
  assert.equal(poll(e, 0x88c2, fight, 1)?.enemy?.species, 504, 'a single odd value: still the battle');
  assert.equal(poll(e, 0x2100, fight)?.enemy?.species, 504, 'and the panel keeps its opponent afterwards');
  assert.equal(poll(e, 0x88c2, fight, 4), null, 'several odd values in a row: the battle is over');
  // a long wait in a battle menu (the copies look stale by then): one odd value still doesn't end the battle
  const realNow = Date.now;
  try {
    const slow = {};
    const t0 = realNow();
    Date.now = () => t0;
    assert.equal(poll(e, 0x2100, slow)?.enemy?.species, 504);
    Date.now = () => t0 + 5 * 60000;
    poll(e, 0x2100, slow);
    assert.equal(poll(e, 0x88c2, slow, 1)?.enemy?.species, 504, 'one odd read after minutes in the menu: still the battle');
    assert.equal(poll(e, 0x2100, slow)?.enemy?.species, 504, 'and the opponent is still there afterwards');
  } finally {
    Date.now = realNow;
  }
  // another language of the game (its memory may lie elsewhere): an unknown value is left to the copies as before …
  const de = findEntry(TABLE, { platform: 'nds', code: 'IRED' });
  assert.equal(de.scanOnly, true);
  const st = {};
  assert.equal(poll(de, 0x88c2, st)?.enemy?.species, 504);
  // … until the address has shown both its battle and its overworld value in this session
  poll(de, 0x2100, st);
  poll(de, 0x2800, st);
  assert.equal(poll(de, 0x88c2, st), null);
});

test('White: the battle flag ends Juniper\'s catching demo and every battle at once (#9)', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IRAO' });
  assert.equal(e.id, 'white_us');
  const me = pk5({ pid: 0x8efb4911, species: 498, level: 6, hp: 25, maxHp: 25 });
  const m = memory();
  m.write(0x022349cc, [6, 0, 0, 0, 1, 0, 0, 0, ...me]); // the party (count at 0x022349D0)
  // the demo's party in the heap: Juniper's Minccino (another trainer, none of the player's Pokémon)
  const minccino = pk5({ pid: 0x5eed0001, species: 572, level: 7, hp: 25, maxHp: 25 });
  m.write(0x02300000, [6, 0, 0, 0, 1, 0, 0, 0, ...minccino]);
  // (battleActive: in White it holds the wild opponent's PID – the demo's Patrat there, checked live)
  const poll = (flag, pidAt, state, n = 6) => {
    m.write(0x021d07b8, [flag & 0xff, flag >> 8]);
    m.write(0x022a7e34, [pidAt & 0xff, (pidAt >> 8) & 0xff, (pidAt >> 16) & 0xff, pidAt >>> 24]);
    let fight = null;
    for (let i = 0; i < n; i++) fight = readLiveBattle(e, m.read, T, state, readLiveParty(e, m.read, T, state).party);
    return fight;
  };
  // checked live in White: the flag is 0x2100 in the demo too
  assert.equal(poll(0xf841, 0, {}), null, 'overworld');
  // the demo sets the battle value too – Juniper's party alone (its other copy not found yet) still reads as a battle …
  const demo = {};
  assert.equal(poll(0x2100, 0xd56bfdba, demo)?.enemy?.species, 572, 'the demo while it runs');
  assert.equal(poll(0xf841, 0xd56bfdba, demo), null, 'after the demo: its leftover copy stays off the panel');
  // … and with the demo's wild Patrat (Lv. 2) next to it, it is the catching demo: no battle of the player's (2.8.1)
  m.write(0x02300400, [6, 0, 0, 0, 1, 0, 0, 0, ...pk5({ pid: 0xd56bfdba, species: 504, level: 2, hp: 11, maxHp: 11 })]);
  const demo2 = {};
  const seen = poll(0x2100, 0xd56bfdba, demo2);
  assert.equal(seen.tutorial, true);
  assert.equal(seen.enemy.species, 504);
  assert.equal(playerBattle(seen), null);
  assert.equal(poll(0xf841, 0xd56bfdba, demo2), null);
  m.write(0x02300400, new Array(8 + 220).fill(0));
  // a real battle: a copy of the player's party in the heap (here the demo copy stands in for the opponent) …
  m.write(0x02310000, [6, 0, 0, 0, 1, 0, 0, 0, ...pk5({ pid: 0x8efb4911, species: 498, level: 6, hp: 19, maxHp: 25 })]);
  const fight = {};
  assert.equal(poll(0x2100, 0xc44634a6, fight)?.enemy?.species, 572);
  assert.equal(poll(0x2100, 0xc44634a6, fight)?.active?.index, 0);
  // … and the flag (checked live: 0xF841 out of battle) ends it at once – the copies alone would keep it for up to 90 s
  assert.equal(poll(0xf841, 0xc44634a6, fight), null, 'the battle is over');
  // the game's other languages (memory unchecked) only trust the flag once it showed both values (scanOnly)
  const de = findEntry(TABLE, { platform: 'nds', code: 'IRAD' });
  assert.equal(de.scanOnly, true);
});

test('Gen 5 level caps: the gym aces of Black/White and Black 2/White 2, then the Elite Four (#13)', () => {
  assert.equal(gymCapsFamily('pokemon-black'), 'bw');
  assert.equal(gymCapsFamily('pokemon-white-de'), 'bw');
  assert.equal(gymCapsFamily('pokemon-black-2'), 'b2w2');
  assert.equal(gymCapsFamily('pokemon-white-2-de'), 'b2w2');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((b) => vanillaCapFor('bw', b).cap), [14, 20, 23, 27, 31, 35, 39, 43]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((b) => vanillaCapFor('b2w2', b).cap), [13, 18, 24, 30, 33, 39, 48, 51]);
  assert.deepEqual(vanillaCapFor('bw', 8), { cap: 50, boss: { key: 'elite four', name: 'Elite Four' } });
  assert.equal(vanillaCapFor('b2w2', 8).cap, 58);

  const B2 = { id: 'b2', mode: 'nuzlocke', players: { p1: { name: 'Lou' } }, game: { id: 'pokemon-black-2', code: 'IREO', system: 'nds' } };
  const d = new RunDoc('t');
  d._persistSoon = () => {};
  d.set('live:p1', { badges: 3, at: Date.now() });
  assert.deepEqual(R.levelCap(d, B2, 'p1'), { cap: 30, boss: { key: 'gym4', badge: 3, name: 'Gym 4' }, vanilla: true });
  d.set('live:p1', { badges: 8, at: Date.now() });
  assert.equal(R.levelCap(d, B2, 'p1').boss.name, 'Elite Four');
  assert.deepEqual(R.levelCap(d, { ...B2, game: { ...B2.game, hackId: 'blaze-black-2-redux' } }, 'p1'), { cap: null, boss: null }, 'a ROM hack: no retail cap');
  // the stream API says the same
  assert.equal(levelCapOf(B2, { levelCaps: 'warn' }, {}, 1).cap, 18);
  // a ROM hack (Blaze Black 2 Redux) has trainers of other levels: no retail cap rather than a wrong one
  assert.equal(levelCapOf({ ...B2, game: { ...B2.game, hackId: 'blaze-black-2-redux' } }, { levelCaps: 'warn' }, {}, 1), null);
  assert.equal(levelCapOf({ ...B2, patch: { name: 'x.xdelta' } }, { levelCaps: 'warn' }, {}, 1), null);
});

test('catches filed under a place number get the place name once it is known (#14)', () => {
  const B2 = { id: 'b2', mode: 'nuzlocke', players: { p1: { name: 'Lou' } }, game: { id: 'pokemon-black-2', code: 'IREO', system: 'nds' } };
  const d = new RunDoc('t');
  d._persistSoon = () => {};
  d.set('area:m5-6', { name: '#6', met: [6], auto: true, order: 1 }); // an older run (2.2.0 had no Gen 5 names)
  d.set('area:m5-5', { name: 'Our spot', met: [5], auto: false, order: 2 }); // named by hand: stays
  R.setRomPlaces(null);
  assert.equal(R.areaName(d, B2, 'm5-6'), '#6', 'still unknown without the ROM’s names');
  R.setRomPlaces({ gen: 5, lang: 'en', vanilla: true, names: ['', 'Mystery Zone', 'Faraway place', '', 'Nuvema Town', 'Accumula Town', 'Striaton City'] });
  try {
    assert.equal(R.areaName(d, B2, 'm5-6'), 'Striaton City', 'shown by its name at once');
    const mon = { key: 'k1', species: 495, nickname: 'SNIVY', level: 5, hp: 20, maxHp: 20, metLocation: 6, metLevel: 5 };
    R.applySnapshot(d, B2, 5, 'p1', { source: 'live', party: [mon] });
    assert.equal(d.get('area:m5-6').name, 'Striaton City', 'and written into the run, for the partners too');
    assert.equal(d.get('area:m5-5').name, 'Our spot');
  } finally {
    R.setRomPlaces(null);
  }
});

test('held items by name: the game\'s number in Gen 3, 4 and 5 (#15)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith('/shared/')) throw new Error('offline');
    const body = readFileSync(new URL('..' + url, import.meta.url), 'utf8');
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => JSON.parse(body) };
  };
  try {
    await loadData();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(itemName(155, 5, 'en'), 'Oran Berry');
  assert.equal(itemName(155, 5, 'de'), 'Sinelbeere');
  assert.equal(itemName(234, 5, 'en'), 'Leftovers');
  // Gen 6/7 (3DS): their own numbers – Assault Vest came with X/Y
  assert.equal(itemName(234, 7, 'en'), 'Leftovers');
  assert.equal(itemName(640, 6, 'en'), 'Assault Vest');
  assert.equal(itemName(640, 7, 'de'), 'Offensivweste');
  assert.equal(itemName(640, 5, 'en'), '');
  assert.equal(itemName(155, 4, 'en'), 'Oran Berry');
  assert.equal(itemName(139, 3, 'en'), 'Oran Berry', 'Gen 3 numbers its items differently');
  assert.equal(itemName(155, 2, 'en'), '', 'no table for Gen 1/2');
  assert.equal(itemName(9999, 5, 'en'), '', 'an item only a ROM hack has');
  assert.equal(itemName(0, 5, 'en'), '');
});

// Gen 5 battle structs as Black 2 keeps them (captured in twicable's fast player, #12): { u32 → the Pokémon in the battle's
// party copy, u32, u32, u16 species, u16 max HP, u16 HP, u8 ×6, u8 level } – the struct's address is the species'
function battleStruct(m, addr, { pp, species, maxHp, hp, level }) {
  const b = new Uint8Array(0x0c + 14);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, pp, true);
  dv.setUint16(0x0c, species, true);
  dv.setUint16(0x0e, maxHp, true);
  dv.setUint16(0x10, hp, true);
  b[0x0c + 12] = level;
  m.write(addr - 0x0c, b);
}

test('Black 2: a wild Pokémon that looks like a benched one fainting never kills it – battle structs are told by PID (#12)', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IREO' });
  // the player's Patrat (Lv. 3, 16 HP) leads and is switched out for Tepig, against a wild Patrat with the same level and max HP
  const patrat = { pid: 0x0badf00d, species: 504, level: 3, hp: 16, maxHp: 16 };
  const tepig = { pid: 0x7e9170aa, species: 498, level: 6, hp: 24, maxHp: 24 };
  const wild = { pid: 0x5eed0042, species: 504, level: 3, hp: 16, maxHp: 16 };
  const m = black2({ mons: [pk5(patrat), pk5(tepig)] });
  const MINE = 0x02257d6c; // the battle's copy of the player's party
  const FOE = 0x0225882c; // the wild one's
  m.write(MINE, [6, 0, 0, 0, 2, 0, 0, 0, ...pk5(patrat), ...pk5(tepig)]);
  m.write(FOE, [6, 0, 0, 0, 1, 0, 0, 0, ...pk5(wild)]);
  const S = { patrat: 0x0225b1f0, tepig: 0x0225b414, wild: 0x0225b638 };
  battleStruct(m, S.patrat, { pp: MINE + 8, ...patrat });
  battleStruct(m, S.tepig, { pp: MINE + 8 + 220, ...tepig });
  battleStruct(m, S.wild, { pp: FOE + 8, ...wild });
  // a freed struct of an earlier battle where this Patrat fell: it points into a copy that is gone
  battleStruct(m, 0x02240000, { pp: 0x02300008, ...patrat, hp: 0 });
  m.write(0x021b5138, [0x00, 0x21]); // in battle
  const state = {};
  const poll = () => {
    const party = readLiveParty(e, m.read, T, state).party;
    const fight = readLiveBattle(e, m.read, T, state, party);
    return { fight, party: withBattleHp(party, fight) };
  };
  for (let i = 0; i < 6; i++) poll(); // (the heap search takes a few polls)
  let r = poll();
  assert.deepEqual(r.party.map((x) => x.hp), [16, 24]);
  assert.equal(r.fight.enemy.hp, 16);
  // Tepig hits; the wild Patrat faints, and the benched Patrat grows to Lv. 4 from the shared EXP – its struct gets the new
  // level and max HP (the save party keeps the old ones until the battle ends)
  battleStruct(m, S.tepig, { pp: MINE + 8 + 220, ...tepig, hp: 17 });
  battleStruct(m, S.wild, { pp: FOE + 8, ...wild, hp: 0 });
  battleStruct(m, S.patrat, { pp: MINE + 8, ...patrat, level: 4, maxHp: 17, hp: 17 });
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0 + 5000; // (past the 2 s between two heap searches)
    r = poll();
  } finally {
    Date.now = realNow;
  }
  assert.equal(r.fight.enemy.hp, 0, 'the wild Patrat is down');
  assert.deepEqual(r.party.map((x) => x.hp), [16, 17], 'the player\'s Patrat is not (its HP within the max HP the team shows until the battle ends)');
  // a real faint still shows in the battle
  battleStruct(m, S.tepig, { pp: MINE + 8 + 220, ...tepig, hp: 0 });
  assert.deepEqual(poll().party.map((x) => x.hp), [16, 0]);
});

test('a Pokémon at 0 HP counts once two reads in a row say so – one odd read never files a death (#12)', () => {
  const mon = (hp, key = 'a') => ({ key, species: 504, level: 4, hp, maxHp: 17 });
  const st = {};
  assert.deepEqual(confirmFaints([mon(17), mon(9, 'b')], st).map((m) => m.hp), [17, 9]);
  assert.deepEqual(confirmFaints([mon(0), mon(9, 'b')], st).map((m) => m.hp), [17, 9], 'the first read at 0 keeps the HP before');
  assert.deepEqual(confirmFaints([mon(17), mon(9, 'b')], st).map((m) => m.hp), [17, 9], 'it was a flicker');
  assert.deepEqual(confirmFaints([mon(0), mon(9, 'b')], st).map((m) => m.hp), [17, 9]);
  assert.deepEqual(confirmFaints([mon(0), mon(9, 'b')], st).map((m) => m.hp), [0, 9], 'the second read in a row: down');
  assert.deepEqual(confirmFaints([mon(0), mon(9, 'b')], st).map((m) => m.hp), [0, 9], 'and it stays down');
  // a team already down when tracking starts has no HP to hold
  assert.deepEqual(confirmFaints([mon(0)], {}).map((m) => m.hp), [0]);
  // the tracker files the death only from the confirmed read
  const B2 = { id: 'b2', mode: 'soullink', players: { p1: { name: 'Lou' }, p2: { name: 'Kim' } }, game: { id: 'pokemon-black-2', code: 'IREO', system: 'nds' } };
  const d = new RunDoc('t');
  d._persistSoon = () => {};
  d.set('enc:starter:p1', { outcome: 'caught', species: 504, key: 'a', level: 4 });
  d.set('enc:starter:p2', { outcome: 'caught', species: 509, key: 'z', level: 4 });
  const live = {};
  const snap = (hp) => R.applySnapshot(d, B2, 5, 'p1', { source: 'live', party: confirmFaints([{ ...mon(hp), metLocation: 0 }], live) });
  snap(17);
  assert.deepEqual(snap(0).deaths, [], 'one read at 0: no death yet');
  assert.equal(R.pairState(d, 'starter').state !== 'dead', true);
  assert.deepEqual(snap(0).deaths, ['starter'], 'the next one confirms it');
});

test('Black/White, Black 2/White 2: a trainer\'s next Pokémon is the one the battle sends out – the battle order, not the party order (2.8.1)', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IREO' });
  const tepig = { pid: 0x7e9170aa, species: 498, level: 14, hp: 40, maxHp: 40 };
  const foes = [
    { pid: 0x7e000001, species: 506, level: 12, hp: 30, maxHp: 30 },
    { pid: 0x7e000002, species: 509, level: 12, hp: 30, maxHp: 30 },
    { pid: 0x7e000003, species: 511, level: 14, hp: 33, maxHp: 33 },
  ];
  const m = black2({ mons: [pk5(tepig)] });
  const MINE = 0x02257d6c;
  const FOE = 0x0225882c;
  m.write(MINE, [6, 0, 0, 0, 1, 0, 0, 0, ...pk5(tepig)]);
  m.write(FOE, [6, 0, 0, 0, 3, 0, 0, 0, ...foes.flatMap((f) => [...pk5(f)])]);
  const S = [0x0225b1f0, 0x0225b414, 0x0225b638];
  const structs = (hps) => foes.forEach((f, i) => battleStruct(m, S[i], { pp: FOE + 8 + i * 220, ...f, hp: hps[i] }));
  battleStruct(m, 0x0225b85c, { pp: MINE + 8, ...tepig });
  structs([30, 30, 33]);
  // the battle's pointer arrays of the opponent's team (struct − 0x0C): its own order and the battle order
  const order = (at, idx) => m.write(at, idx.flatMap((i) => { const v = S[i] - 0x0c; return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]; }));
  order(0x02256000, [0, 1, 2]);
  order(0x02256100, [0, 1, 2]);
  m.write(0x021b5138, [0x00, 0x21]); // in battle
  const state = {};
  const realNow = Date.now;
  let t = realNow();
  const poll = (n = 1) => {
    let fight = null;
    try {
      for (let i = 0; i < n; i++) {
        t += 2500; // (past the 2 s between two heap searches)
        Date.now = () => t;
        fight = readLiveBattle(e, m.read, T, state, readLiveParty(e, m.read, T, state).party);
      }
    } finally {
      Date.now = realNow;
    }
    return fight;
  };
  assert.equal(poll(6).enemy.species, 506, 'the lead');
  // the lead is down – the trainer hasn't chosen yet: the lead stays on the panel at 0 HP (not the next one in the party)
  structs([0, 30, 33]);
  let f = poll();
  assert.deepEqual([f.enemy.species, f.enemy.hp], [506, 0]);
  // the trainer sends its third Pokémon: the battle order puts it in front
  order(0x02256100, [2, 1, 0]);
  f = poll();
  assert.deepEqual([f.enemy.species, f.enemy.hp], [511, 33]);
  // down too, one left: that one is next for sure
  structs([0, 30, 0]);
  assert.equal(poll().enemy.species, 509);
  // without the arrays (not found): the first one standing, as before
  const plain = {};
  m.write(0x02256000, new Array(12).fill(0));
  m.write(0x02256100, new Array(12).fill(0));
  structs([30, 30, 33]);
  let g = null;
  for (let i = 0; i < 6; i++) g = readLiveBattle(e, m.read, T, plain, readLiveParty(e, m.read, T, plain).party);
  assert.equal(g.enemy.species, 506);
});

test('Gen 5 PC boxes: a catch the game sends to the PC (full party) is filed at once – and a full party gets the missed-encounter question (2.8.1)', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IREO' });
  const team = [0, 1, 2, 3, 4, 5].map((i) => pk5({ pid: 0x10000 + i * 0x777, species: 495 + i }));
  const m = black2({ mons: team });
  const BOXES = CORE + 0x400 - 0x18e00; // PKHeX SAV5: box 1 at 0x400, the party block at 0x18E00
  // box 1 slot 1: a Purrloin just caught (stored format: the first 136 bytes), slot 2 emptied (zeros, encrypted)
  const purrloin = pk5({ pid: 0x0ca7c4a7, species: 509, level: 3 }).subarray(0, 136);
  m.write(BOXES, [...purrloin, ...encryptPK4(new Uint8Array(220)).subarray(0, 136)]);
  // box 3 slot 5
  m.write(BOXES + 2 * 0x1000 + 4 * 136, [...pk5({ pid: 0x0ca7c4a8, species: 504, level: 4 }).subarray(0, 136)]);
  const r = readLiveParty(e, m.read, T, {});
  assert.deepEqual(r.boxes.map((x) => [x.species, x.box, x.slot]), [[509, 0, 0], [504, 2, 4]]);
  // the tracker files the boxed catch where it was met
  const B2 = { id: 'b2', mode: 'nuzlocke', players: { p1: { name: 'Lou' } }, game: { id: 'pokemon-black-2', code: 'IREO', system: 'nds' } };
  const d = new RunDoc('t');
  d._persistSoon = () => {};
  team.forEach((x, i) => d.set(`enc:a${i}:p1`, { outcome: 'caught', species: 495 + i, key: r.party[i].key }));
  const snap = R.applySnapshot(d, B2, 5, 'p1', { source: 'live', party: r.party, boxes: r.boxes.map((x) => ({ ...x, metLocation: 20 })) });
  assert.ok(snap.newCatches.length + snap.inbox.length >= 1, 'the boxed Purrloin is seen');
  // (with the PC read, a full party no longer rules the missed-encounter question out)
  assert.equal(R.missedQuestion(d, B2, null, 'p1', { foe: { species: 506 }, wild: true, from: 2, newMonAt: 1, boxes: true, partySize: 6 }), true);
  assert.equal(R.missedQuestion(d, B2, null, 'p1', { foe: { species: 506 }, wild: true, from: 2, newMonAt: 1, boxes: false, partySize: 6 }), false);
  // another trainer's data behind the party (a battle's copy), garbage, or a PC with nothing readable: no PC rather than a wrong one
  assert.equal(readLiveParty(e, black2({ mons: team, tid: 1 }).read, T, {}).boxes, undefined);
  const junk = black2({ mons: team });
  junk.write(BOXES, Array.from({ length: 0x3000 }, (_, i) => (i * 37 + 11) & 0xff));
  assert.equal(readLiveParty(e, junk.read, T, {}).boxes, undefined);
  assert.equal(readLiveParty(e, black2({ mons: team }).read, T, {}).boxes, undefined, 'empty: can\'t be told from a wrong place');
});

test('Black: Rotom\'s forms – the form is read, and the battle panel gets the form\'s types (2.8.1)', async () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IREO' });
  const r = readLiveParty(e, black2({ mons: [pk5({ pid: 0x40740001, species: 479, form: 2 }), pk5({ pid: 0x40740002, species: 479 })] }).read, T, {});
  assert.deepEqual(r.party.map((x) => x.form), [2, undefined]);
  const { RunData } = await import('../web/lib/data.mjs');
  const rd = new RunData();
  rd.gen = 5;
  assert.deepEqual(rd.types(479, 'p1', 2), ['electric', 'water'], 'Wash Rotom');
  assert.deepEqual(rd.types(479, 'p1', 1), ['electric', 'fire'], 'Heat Rotom');
  assert.deepEqual(rd.types(413, 'p1', 2), ['bug', 'steel'], 'Trash Cloak Wormadam');
  assert.deepEqual(rd.types(492, 'p1', 1), ['grass', 'flying'], 'Sky Forme Shaymin');
  assert.deepEqual(rd.types(493, 'p1', 9), ['fire'], 'Arceus with the Flame Plate (Gen 5 order)');
  rd.gen = 4;
  assert.deepEqual(rd.types(479, 'p1', 1), ['electric', 'ghost'], 'Gen 4: the appliances were still Electric/Ghost');
  assert.deepEqual(rd.types(493, 'p1', 10), ['fire'], 'Arceus in Gen 4 (\'???\' at 9)');
  // the randomizer's types for the form
  rd.gen = 5;
  rd.romData = { p1: { pokemon: [{ id: 479, name: 'Rotom', forme: 0, types: ['ELECTRIC', 'GHOST'] }, { id: 657, name: 'Rotom-W', forme: 2, types: ['ICE', 'DARK'] }] } };
  rd.byId = { p1: new Map([[479, rd.romData.p1.pokemon[0]]]) };
  assert.deepEqual(rd.types(479, 'p1', 2), ['ice', 'dark']);
  // the sprite of the form (PokeAPI's number for it, in the Gen 5 set)
  const { spriteUrl } = await import('../web/lib/data.mjs');
  assert.equal(spriteUrl(479, { gen: 5, form: 2 }), '/sprites/gen5/10009.png');
  assert.equal(spriteUrl(479, { gen: 5 }), '/sprites/gen5/479.png');
  assert.equal(spriteUrl(646, { gen: 5, form: 2, shiny: true }), '/sprites/gen5shiny/10022.png', 'Black Kyurem');
});
