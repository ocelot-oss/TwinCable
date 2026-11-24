// Alternate forms in live tracking (2.8.3, a player's report on Discord: a friend caught a Mega Charizard Y and had to
// enter it on the route by hand – it wasn't tracked). The three ways a game can hand twincable such a Pokémon:
//  (a) a randomized 3DS game with "Allow alternate forms" (UPR ZX writes species + form into the wild slots): the PK6/PK7
//      keeps the National Dex number and the form apart – tracked as its species, the form only shown;
//  (b) an expanded GBA engine (pokeemerald-expansion, Complete FireRed Upgrade) numbers every form as a species of its
//      own after the National Dex and names it like its species. A build that leaves out generations (P_GEN_9_POKEMON
//      off …) has a long run of zeroed gSpeciesInfo entries in front of the forms – the name table ended after 16 of
//      them, so every Mega, Primal and regional form had no species and its catch was no Pokémon to the live reader;
//  (c) Gen 4/5 form bits on a normal species (already tracked as the species).
// Plus: forms a battle gives (Mega Evolution, Zygarde Complete, Wishiwashi's School, Mimikyu Busted, Aegislash, Zen
// Mode) are never a catch, an evolution, a death or a missing Pokémon; the dupes clause counts regional forms as their
// line; what the UI, the Showdown export, the spoilers and the stream API show. Synthetic data, no ROM needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { romSpecies, gen3Forms, gen3SpeciesMap } from '../shared/live/romspecies.mjs';
import { parsePk3, LiveTables } from '../shared/live/parse.mjs';
import { encryptPK6, pk6Mon, readGen67Battle, BOX_SIZE } from '../shared/live/gen67.mjs';
import { formSpriteId, formTypes, formKind } from '../shared/forms.mjs';
import { showdownSet } from '../shared/monstats.mjs';
import { buildState } from '../shared/streamapi.mjs';
import { digestRun, buildDex } from '../shared/trophies.mjs';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');
const D = await import('../web/lib/data.mjs');

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const cs3 = json('charset_gen3.json');
const api = json('pokeapi.json');
const dexNames = api.names.en;
const code3 = Object.fromEntries(Object.entries(cs3.table).filter(([, v]) => v.length === 1).map(([k, v]) => [v, parseInt(k, 16)]));
const enc3 = (s) => [...s].map((c) => code3[c]);

// the page's names (PokeAPI data, served from /shared/data)
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (!String(url).startsWith('/shared/')) throw new Error('offline');
  const body = readFileSync(new URL('..' + url, import.meta.url), 'utf8');
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => JSON.parse(body) };
};
try {
  await D.loadData();
} finally {
  globalThis.fetch = realFetch;
}

function mkDoc() {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  return d;
}
const feedTypes = (d) => Object.values(d.scan('feed:')).filter(Boolean).map((f) => f.type);

// ---------------------------------------------------------------------------------------------- (b) expanded engines

const STRIDE = 0x104; // gSpeciesInfo in Too Many Types 2
// a build with Gen 8 left out (96 zeroed entries, 810–905), then its forms – named like their species
const FORMS = { 906: 'Venusaur', 907: 'Charizard', 908: 'Charizard', 909: 'Vulpix', 910: 'Kyogre', 911: 'Snorlax' };
// base stats (HP, Atk, Def, Speed, Sp. Atk, Sp. Def): the species' and its forms' (Mega X / Mega Y / Alolan Vulpix /
// Primal Kyogre official, a Gigantamax Snorlax a hack gave +100 – Snorlax has no Mega)
const STATS = {
  3: [80, 82, 83, 80, 100, 100], 6: [78, 84, 78, 100, 109, 85], 37: [38, 41, 40, 65, 50, 65], 382: [100, 100, 90, 90, 150, 140],
  143: [160, 110, 65, 30, 65, 110],
  906: [80, 100, 123, 80, 122, 120], 907: [78, 130, 111, 100, 130, 85], 908: [78, 104, 78, 100, 159, 115],
  909: [38, 41, 40, 65, 50, 65], 910: [100, 150, 90, 90, 180, 160], 911: [160, 160, 85, 30, 80, 125],
};
const STATS_AT = 0x40000;
const STATS_STRIDE = 28;

function expansionRom() {
  const rom = new Uint8Array(0x80000);
  rom[3] = 0xea;
  rom[0xb2] = 0x96;
  rom.set([...'BPEE'].map((c) => c.charCodeAt(0)), 0xac);
  const names = ['??????????', ...dexNames.slice(1, 810)];
  for (let i = 810; i <= 905; i++) names[i] = '';
  for (const [i, n] of Object.entries(FORMS)) names[i] = n;
  const at = 0x1000;
  names.forEach((n, i) => {
    const o = at + i * STRIDE;
    if (n) {
      rom.fill(0x11, o + 13, o + STRIDE);
      rom.fill(0xff, o, o + 13);
      rom.set(enc3(n).slice(0, 12), o);
    } else rom.fill(0, o, o + STRIDE); // a left-out species: the whole entry zeroed
  });
  for (const [i, s] of Object.entries(STATS)) rom.set(s, STATS_AT + Number(i) * STATS_STRIDE);
  return rom;
}

const speciesOpts = { gen3Charset: cs3, dexNames, dexNamesOther: ['de', 'fr', 'es', 'it'].map((l) => api.names[l]) };

test('(b) pokeemerald-expansion with generations left out: the forms behind the gap are their species (they were no Pokémon)', () => {
  const sp = romSpecies(expansionRom(), speciesOpts);
  assert.equal(sp.engine, 'expanded');
  assert.equal(sp.count, 911, 'the table goes on past 96 zeroed entries (it ended at 809 – after 16 blanks)');
  assert.equal(sp.map[810], 0, 'a left-out species is no Pokémon');
  assert.deepEqual([906, 907, 908, 909, 910, 911].map((i) => sp.map[i]), [3, 6, 6, 37, 382, 143], 'each form is its species');
  // which forms are Megas / Primal: from the ROM's base stats
  const forms = gen3Forms(expansionRom(), sp, { offset: STATS_AT, stride: STATS_STRIDE });
  assert.deepEqual(forms, { 906: 1, 907: 1, 908: 2, 910: 1 }, 'Mega Venusaur, Mega Charizard X and Y, Primal Kyogre – not Alolan Vulpix (same stats) or a Snorlax that has no Mega');
  assert.equal(gen3Forms(expansionRom(), sp, null), null, 'no base stats found: no forms (still their species)');
  assert.equal(gen3Forms(expansionRom(), { ...sp, engine: 'vanilla' }, { offset: STATS_AT, stride: STATS_STRIDE }), null, 'a retail engine has none');
});

test('(b) a hack that names the form ("Mega Lucario", "MegaCharizY", "Alolan Vulpix") is that species with the form', () => {
  const names = ['', 'Bulbasaur', 'Mega Lucario', 'MegaCharizY', 'Alolan Vulpix', 'Primal Kyogre', 'Galarian Meowth', 'Megalodon', 'Meganium', 'Yanmega', 'MegaChariz'];
  const r = gen3SpeciesMap(names, [], dexNames, speciesOpts.dexNamesOther);
  assert.deepEqual(r.map, [0, 1, 448, 6, 37, 382, 52, 0, 154, 469, 6]);
  assert.deepEqual(r.forms, { 2: 1, 3: 2, 4: 1, 5: 1 }, 'Galar has no form number here; "MegaChariz" leaves X or Y to the base stats');
  assert.deepEqual(r.unknown, { 7: 'Megalodon' }, 'a fakémon that only starts like a form word stays one');
  assert.equal(gen3SpeciesMap(['', 'Bulbasaur'], [], dexNames).forms, undefined);
});

/** A party struct as Unbound / Radical Red / Run & Bun keep it: unencrypted, checksum 0, Growth Attacks EVs Misc. */
function plainPk3({ pid, otId = 0x7e0e3343, species, level = 30, hp = 80, maxHp = 90, met = 16 }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d.set([...enc3('MON'), 0xff], 8);
  d[0x13] = 0x02;
  dv.setUint16(32, species, true);
  dv.setUint32(36, 5000, true);
  dv.setUint16(44, 33, true);
  d[52] = 20;
  d[69] = met; // Misc: met location
  dv.setUint16(70, level, true); // met level (bits 0–6)
  dv.setUint32(72, 0x3fffffff, true);
  d[84] = level;
  dv.setUint16(86, hp, true);
  dv.setUint16(88, maxHp, true);
  return d;
}

test('(b) the caught Mega is filed on its route as its species; a Mega Evolution in battle is no catch, evolution or death', () => {
  const rom = expansionRom();
  const sp = romSpecies(rom, speciesOpts);
  sp.forms = gen3Forms(rom, sp, { offset: STATS_AT, stride: STATS_STRIDE });
  const T = new LiveTables({ charsetGen3: cs3 }).withSpecies(sp);
  const starter = parsePk3(plainPk3({ pid: 0x101, species: 3, met: 0 }), T);
  const mega = parsePk3(plainPk3({ pid: 0x202, species: 908, met: 16 }), T);
  assert.deepEqual([starter.species, starter.form, mega.species, mega.form], [3, undefined, 6, 2], 'Charizard in its Mega Y form');
  const d = mkDoc();
  const M = { id: 'r1', game: { system: 'gba', code: 'BPEE', hackName: 'Some Expansion Hack' }, mode: 'nuzlocke', players: { p1: { name: 'A' } } };
  assert.deepEqual(R.applySnapshot(d, M, 3, 'p1', { source: 'live', party: [starter] }).newCatches, ['starter']);
  const res = R.applySnapshot(d, M, 3, 'p1', { source: 'live', party: [starter, mega] });
  assert.equal(res.newCatches.length, 1, 'tracked by itself – no inbox, no typing it in');
  assert.deepEqual(res.inbox, []);
  const enc = R.encounter(d, res.newCatches[0], 'p1');
  assert.deepEqual([enc.species, enc.form, enc.outcome], [6, 2, 'caught'], 'Charizard for the rules, Mega Y to show');
  // in a battle the Venusaur Mega Evolves: the game writes the Mega's number into the party
  const inBattle = parsePk3(plainPk3({ pid: 0x101, species: 906, met: 0 }), T);
  assert.deepEqual([inBattle.key, inBattle.species, inBattle.form], [starter.key, 3, 1]);
  const fight = { kind: 'trainer', enemy: { species: 25, level: 30 } };
  const before = feedTypes(d).length;
  const b = R.applySnapshot(d, M, 3, 'p1', { source: 'live', party: [inBattle, mega], boxes: [] }, { battle: fight });
  assert.deepEqual([b.newCatches, b.inbox, b.deaths, b.alerts], [[], [], [], []]);
  assert.equal(feedTypes(d).length, before, 'no "evolved" line');
  assert.equal(R.encounter(d, 'starter', 'p1').form, undefined, 'the encounter keeps the form it had before the battle');
  assert.equal(d.get('live:p1').party[0].form, 1, 'the team shows it as it is now');
  // the battle is over: the party holds the Venusaur again
  const after = R.applySnapshot(d, M, 3, 'p1', { source: 'live', party: [starter, mega], boxes: [] });
  assert.deepEqual([after.newCatches, after.inbox, after.deaths, after.alerts], [[], [], [], []]);
  assert.equal(d.get('live:p1').party[0].form, undefined);
  // trophies / the Pokédex: the Mega is a Charizard – no entry of its own
  const dex = buildDex([digestRun(M, d.entries, 'p1')]);
  assert.deepEqual(Object.keys(dex).map(Number).sort((a, b) => a - b), [3, 6]);
});

// ------------------------------------------------------------------------------- (a) randomized 3DS, wild alt forms

const w16 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};
const w32 = (b, o, v) => {
  for (let i = 0; i < 4; i++) b[o + i] = (v >>> (i * 8)) & 0xff;
};
/** A decrypted 260-byte party PK6/PK7. */
function pk6({ pid, species, form = 0, level = 20, hp = 50, maxHp = 60, met = 38 }) {
  const d = new Uint8Array(BOX_SIZE + 0x1c);
  w32(d, 0, pid * 7 + 3);
  w16(d, 0x08, species);
  w16(d, 0x0c, 12345);
  w16(d, 0x0e, 54321);
  w32(d, 0x18, pid);
  d[0x1d] = (form << 3) | 2;
  w16(d, 0x5a, 33);
  w16(d, 0xda, met);
  d[0xdd] = level;
  d[0xec] = level;
  w16(d, 0xf0, hp);
  w16(d, 0xf2, maxHp);
  for (let o = 0xf4; o < 0xfe; o += 2) w16(d, o, 40);
  return pk6Mon(encryptPK6(d), 7);
}
const XY = { id: 'r6', game: { system: '3ds', code: 'EKJA' }, mode: 'nuzlocke', players: { p1: { name: 'A' } } };

test('(a) a randomized X/Y with wild alternate forms: a caught Mega Charizard Y is its route\'s Charizard; reverting changes nothing', () => {
  const d = mkDoc();
  const starter = pk6({ pid: 0x11, species: 650, met: 8 });
  R.applySnapshot(d, XY, 6, 'p1', { source: 'live', party: [starter] });
  const mega = pk6({ pid: 0x22, species: 6, form: 2, met: 38 });
  assert.deepEqual([mega.species, mega.form], [6, 2]);
  const res = R.applySnapshot(d, XY, 6, 'p1', { source: 'live', party: [starter, mega] });
  assert.deepEqual(res.newCatches, ['m6-38']);
  assert.deepEqual([R.encounter(d, 'm6-38', 'p1').species, R.encounter(d, 'm6-38', 'p1').form], [6, 2]);
  // the game drops the Mega form (a reset; Gen 7 at the end of a battle): the same Pokémon, its species unchanged
  const reverted = pk6({ pid: 0x22, species: 6, form: 0, met: 38 });
  const before = feedTypes(d).length;
  const r2 = R.applySnapshot(d, XY, 6, 'p1', { source: 'live', party: [starter, reverted], boxes: [] });
  assert.deepEqual([r2.newCatches, r2.inbox, r2.deaths, r2.alerts], [[], [], [], []], 'no second encounter, no death, nothing missing');
  assert.equal(feedTypes(d).length, before, 'no "evolved" line');
  assert.equal(R.encounter(d, 'm6-38', 'p1').form, undefined, 'shown as Charizard now');
  assert.equal(R.encounter(d, 'm6-38', 'p1').species, 6);
  // a Charmander on another route is a dupe of that Charizard (evolution line)
  const rd = { familyRoot: (id) => D.pokeapi().evolvesFrom[id] ? (D.pokeapi().evolvesFrom[D.pokeapi().evolvesFrom[id]] || D.pokeapi().evolvesFrom[id]) : id };
  const char = pk6({ pid: 0x33, species: 4, met: 40 });
  const r3 = R.applySnapshot(d, { ...XY, rules: undefined }, 6, 'p1', { source: 'live', party: [starter, reverted, char] }, { rd });
  assert.deepEqual(r3.newCatches, []);
  assert.equal(r3.inbox[0]?.reason, 'dupe');
});

test('(a) Alolan forms count as their evolution line for the dupes clause (the common Nuzlocke convention, Showdown\'s Species Clause too)', () => {
  const d = mkDoc();
  const SM = { ...XY, game: { system: '3ds', code: 'BNDA' } };
  const rd = { familyRoot: (id) => (id === 38 ? 37 : id) };
  R.applySnapshot(d, SM, 7, 'p1', { source: 'live', party: [pk6({ pid: 0x11, species: 722, met: 8 })] });
  const alolan = pk6({ pid: 0x44, species: 37, form: 1, met: 20 });
  assert.deepEqual(R.applySnapshot(d, SM, 7, 'p1', { source: 'live', party: [pk6({ pid: 0x11, species: 722, met: 8 }), alolan] }, { rd }).newCatches, ['m7-20']);
  const kanto = pk6({ pid: 0x55, species: 38, form: 0, met: 22 });
  const r = R.applySnapshot(d, SM, 7, 'p1', { source: 'live', party: [pk6({ pid: 0x11, species: 722, met: 8 }), alolan, kanto] }, { rd });
  assert.equal(r.inbox[0]?.reason, 'dupe', 'a Ninetales after an Alolan Vulpix is the same line');
});

test('forms a battle gives are never a catch, an evolution, a death or a missing Pokémon', () => {
  const d = mkDoc();
  const team = (f) => [
    pk6({ pid: 0x11, species: 746, form: f.wishi, met: 8, maxHp: 120, hp: 100 }), // Wishiwashi: School
    pk6({ pid: 0x12, species: 778, form: f.mimi, met: 9 }), // Mimikyu: Busted
    pk6({ pid: 0x13, species: 718, form: f.zyg, met: 10, maxHp: f.zyg === 4 ? 400 : 200, hp: f.zyg === 4 ? 390 : 190 }), // Zygarde: 10% → Complete
    pk6({ pid: 0x14, species: 681, form: f.aegis, met: 11 }), // Aegislash: Blade
    pk6({ pid: 0x15, species: 658, form: f.gren, met: 12 }), // Greninja: Ash
  ];
  const SM = { ...XY, game: { system: '3ds', code: 'BNDA' } };
  const first = R.applySnapshot(d, SM, 7, 'p1', { source: 'live', party: team({ wishi: 0, mimi: 0, zyg: 1, aegis: 0, gren: 1 }), boxes: [] });
  assert.equal(first.newCatches.length + first.inbox.length, 5);
  const encs = JSON.stringify(Object.entries(d.scan('enc:')).map(([k, v]) => [k, v.species, v.key]));
  const fight = { kind: 'trainer', enemy: { species: 25, level: 30 } };
  const before = feedTypes(d).length;
  for (const f of [{ wishi: 1, mimi: 1, zyg: 4, aegis: 1, gren: 2 }, { wishi: 0, mimi: 1, zyg: 1, aegis: 0, gren: 1 }]) {
    const r = R.applySnapshot(d, SM, 7, 'p1', { source: 'live', party: team(f), boxes: [] }, { battle: fight });
    assert.deepEqual([r.newCatches, r.inbox, r.deaths, r.alerts], [[], [], [], []], JSON.stringify(f));
  }
  assert.equal(feedTypes(d).length, before, 'no "evolved" lines');
  assert.equal(JSON.stringify(Object.entries(d.scan('enc:')).map(([k, v]) => [k, v.species, v.key])), encs, 'the encounters are as they were');
  // Gen 5: Darmanitan's Zen Mode (form 1) the same way
  const d5 = mkDoc();
  const B2 = { id: 'r5', game: { system: 'nds', code: 'IREO' }, mode: 'nuzlocke', players: { p1: { name: 'A' } } };
  const darm = (form) => ({ key: 'g5-1', species: 555, form, nickname: 'DARM', level: 40, hp: 100, maxHp: 140, metLocation: 20, metLevel: 35 });
  R.applySnapshot(d5, B2, 5, 'p1', { source: 'live', party: [darm(0)] });
  const z = R.applySnapshot(d5, B2, 5, 'p1', { source: 'live', party: [darm(1)], boxes: [] }, { battle: fight });
  assert.deepEqual([z.newCatches, z.inbox, z.deaths, z.alerts], [[], [], [], []]);
});

test('3DS battles: the opponent\'s form (Mega, Primal …) is shown – a byte that names no form of its species is ignored', () => {
  const entry = { gen: 6, battle: { wild: '0x8000000', trainer: '0x8100000', stride: 580 } };
  const block = (species, level, hp, maxHp, slot, form) => {
    const b = new Uint8Array(580);
    w16(b, 4, species);
    w16(b, 6, maxHp);
    w16(b, 8, hp);
    b[0x10] = level;
    b[0x11] = slot;
    b[0x14b] = form;
    return b;
  };
  const mem = (foe) => {
    const r = new Uint8Array(580 * 12);
    r.set(block(650, 20, 50, 60, 0, 0), 0);
    r.set(foe, 580 * 1);
    return (addr, len) => (addr === 0x8000000 ? r.subarray(0, len) : new Uint8Array(len));
  };
  assert.deepEqual(readGen67Battle(entry, mem(block(6, 30, 90, 100, 12, 2))).enemy, { species: 6, level: 30, hp: 90, maxHp: 100, form: 2 });
  assert.deepEqual(readGen67Battle(entry, mem(block(16, 3, 10, 12, 12, 9))).enemy, { species: 16, level: 3, hp: 10, maxHp: 12 }, 'Pidgey has no form 9');
});

// ----------------------------------------------------------------------------------------------- what is shown

test('shown: sprites, types and names of the forms; the Showdown export; the species stays the species everywhere else', () => {
  assert.deepEqual([formSpriteId(6, 2), formSpriteId(6, 1), formSpriteId(382, 1), formSpriteId(37, 1), formSpriteId(16, 9), formSpriteId(479, 1)], [10035, 10034, 10077, 10103, 16, 10008]);
  assert.deepEqual(formTypes(6, 1, 6), ['fire', 'dragon']);
  assert.equal(formTypes(6, 2, 6), null, 'Mega Y keeps Charizard\'s types');
  assert.equal(formTypes(37, 1, 6), null, 'no Alolan form before Sun/Moon');
  assert.deepEqual(formTypes(37, 1, 7), ['ice']);
  assert.deepEqual(formTypes(383, 1, 3), ['ground', 'fire'], 'an expanded GBA engine\'s Primal Groudon');
  assert.equal(formTypes(479, 1, 3), null, 'Gen 3 has no other forms');
  assert.deepEqual([formKind(6, 2), formKind(150, 1), formKind(3, 1), formKind(382, 1), formKind(37, 1, 7), formKind(37, 1, 6), formKind(479, 1)], ['megaY', 'megaX', 'mega', 'primal', 'alola', null, null]);
  assert.equal(D.speciesFormName(6, 2, 6), 'Charizard (Mega Y)');
  assert.equal(D.speciesFormName(382, 1, 3), 'Kyogre (Primal)');
  assert.equal(D.speciesFormName(37, 1, 7), 'Vulpix (Alolan form)');
  assert.equal(D.speciesFormName(479, 1, 5), 'Rotom', 'a form without a name of its own: the species');
  assert.equal(D.speciesFormName(6, 0, 6), 'Charizard');
  assert.equal(D.spriteUrl(6, { gen: 6, form: 2 }), '/sprites/default/10035.png');
  assert.equal(D.spriteUrl(6, { gen: 3, form: 2 }), '/sprites/default/10035.png', 'an expanded GBA engine\'s Mega');
  assert.equal(D.spriteUrl(6, { gen: 3 }), '/sprites/gen3/6.png');
  const N = { species: (id) => dexNames[id], item: () => '', move: () => '', ability: () => '', nature: () => '' };
  const sd = (species, form, gen = 7) => showdownSet({ species, form, level: 50 }, gen, N).split('\n')[0];
  assert.deepEqual([sd(6, 2), sd(6, 1), sd(150, 2), sd(3, 1), sd(382, 1), sd(37, 1), sd(718, 4), sd(718, 2), sd(746, 1), sd(778, 1), sd(681, 1), sd(774, 0), sd(774, 8), sd(6, 2, 3)],
    ['Charizard-Mega-Y', 'Charizard-Mega-X', 'Mewtwo-Mega-Y', 'Venusaur-Mega', 'Kyogre-Primal', 'Vulpix-Alola', 'Zygarde-Complete', 'Zygarde-10%', 'Wishiwashi-School', 'Mimikyu-Busted', 'Aegislash-Blade', 'Minior-Meteor', 'Minior', 'Charizard-Mega-Y']);
});

test('the stream API: the species with its form number (sprites and name the species\' – the overlay and Pokélink show the species)', () => {
  const live = { source: 'live', at: 1, party: [{ key: 'a', area: 'm6-38', species: 6, form: 2, nick: 'Zard', level: 30, hp: 50, maxHp: 90 }] };
  const doc = { 'live:p1': { v: live, t: 1, by: 'a' }, 'enc:m6-38:p1': { v: { outcome: 'caught', species: 6, form: 2, level: 30, at: 2 }, t: 1, by: 'a' } };
  const s = buildState({ id: 'r6', game: { system: '3ds' }, mode: 'nuzlocke', players: { p1: { name: 'A' } } }, doc, { speciesName: (id) => dexNames[id] });
  const m = (Array.isArray(s.players) ? s.players[0] : Object.values(s.players)[0]).party[0];
  assert.deepEqual([m.species, m.form, m.name], [6, 2, 'Charizard']);
  assert.match(m.sprites.front, /\/6\.png$/);
});

test('spoilers of a randomized run: UPR\'s numbers for forms (Gen 6 from 722) are named as the form, not as another species', () => {
  const rd = new D.RunData();
  rd.gen = 6;
  rd.romData.p1 = { pokemon: [{ id: 6, name: 'Charizard', forme: 0, types: ['FIRE', 'FLYING'] }, { id: 725, name: 'Charizard-Mega-Y', forme: 2, types: ['FIRE', 'FLYING'] }, { id: 731, name: 'Rotom-Heat', forme: 1, types: ['ELECTRIC', 'FIRE'] }, { id: 479, name: 'Rotom', forme: 0, types: ['ELECTRIC', 'GHOST'] }] };
  assert.deepEqual(rd.uprMon(725, 'p1'), { species: 6, form: 2, name: 'Charizard (Mega Y)' }, 'not #725 Litten');
  assert.deepEqual(rd.uprMon(731, 'p1'), { species: 479, form: 1, name: 'Rotom-Heat' });
  assert.deepEqual(rd.uprMon(16, 'p1'), { species: 16, form: 0, name: 'Pidgey' });
});
