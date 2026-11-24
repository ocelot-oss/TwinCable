// Ticket #18 (Discord, 2.7.4): a two-player SoulLink in vanilla Platinum, dupes clause "Per player", level caps on.
// "The board didn't register an encounter as dupe if I caught the encounter on the route but my friend killed it."
// What twicable does there, end to end on the run logic (web/lib/run.mjs) with a Platinum run:
// - the pair of that area failed: the caught Pokémon may not be used (an error while it is in the team);
// - the dupes clause counts every catch – also one of a failed or dead pair: a second Pokémon of that line is a dupe;
//   "Per player" only your own catches, "For both" the partner's too;
// - a Pokémon that got away or was knocked out isn't a catch: it counts as a dupe only with the dupes clause's switch
//   "Fled or knocked-out encounters count as dupes" on (rules.missedDupes) and its species known – twicable notes it
//   when it saw the battle, the board's "Missed" takes it optionally;
// - like a solo Nuzlocke, each player's play view asks after a wild battle that ended without a catch: "Mark as
//   spent" enters that player's encounter as missed, with its species – the pair fails, the partners get it by sync;
// - the level caps come from the game's own trainers (Platinum has no curated list) and the badges read from the game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// web/lib/run.mjs imports browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

// Platinum (USA) is a "dynamic" game: its areas are made from the places the catches were met at
const PT = { id: 'pt18', mode: 'soullink', game: { id: 'pokemon-platinum', code: 'CPUE', system: 'nds' }, players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } } };
const R201 = 'm4-16'; // Route 201 (Gen 4 met location 16)
const R202 = 'm4-17';
const R203 = 'm4-18';
// Starly 396 → Staravia 397 → Staraptor 398, Bidoof 399 → Bibarel 400
const rd = { familyRoot: (id) => ({ 397: 396, 398: 396, 400: 399 })[id] || id, types: () => [] };
function mkDoc(rules) {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}
const mon = (o = {}) => ({ key: 'k1', species: 393, nickname: 'PIPLUP', level: 5, hp: 20, maxHp: 20, metLocation: 1, metLevel: 5, ...o });
const snap = (d, slot, party, extra = {}) => R.applySnapshot(d, PT, 4, slot, { source: 'live', party, ...extra }, { rd });

/** Ana catches a Starly on Route 201, Ben knocks his encounter there out and enters it as missed on the board. */
function failedPair(rules) {
  const d = mkDoc(rules);
  const ana = [mon({ key: 'a1' }), mon({ key: 'a2', species: 396, nickname: 'STARLY', metLocation: 16 })];
  const ben = [mon({ key: 'b1', species: 390, nickname: 'CHIMCHAR' })];
  snap(d, 'p1', ana);
  snap(d, 'p2', ben);
  // (what the board's encounter dialog saves for "Missed (fled / fainted)")
  R.setEncounter(d, PT, R201, 'p2', { outcome: 'missed', species: null, nickname: '', level: null, shiny: false, key: null }, { by: 'p2' });
  return { d, ana, ben };
}

test('Platinum SoulLink: caught on a route where the partner’s encounter was knocked out – the pair failed, the catch may not be used', () => {
  const { d } = failedPair({ dupes: 'player', levelCaps: true });
  assert.equal(d.get(`enc:${R201}:p1`).species, 396, 'the live tracking filed the Starly under Route 201');
  assert.equal(R.pairState(d, R201, PT).state, 'failed');
  const errs = R.checks(d, PT, rd).filter((c) => c.level === 'error');
  assert.deepEqual(errs.map((c) => c.area), [R201]);
  assert.match(errs[0].text, /may not be used \(team of Ana\)/);
  // with "a missed encounter costs the whole pair" switched off the Starly stays usable
  const off = failedPair({ dupes: 'player', failKillsPair: false });
  assert.equal(R.checks(off.d, PT, rd).filter((c) => c.level === 'error').length, 0);
});

test('Platinum SoulLink, dupes "Per player": the catch of a failed pair still counts – the same line again is a dupe for its catcher only', () => {
  const { d, ana, ben } = failedPair({ dupes: 'player' });
  // in battle (the play view's catch rules): Ana meets another Starly – a dupe; for Ben it isn't (per player)
  assert.deepEqual(R.dupeOf(d, PT, rd, 396, 'p1'), { area: R201, slot: 'p1' });
  assert.deepEqual(R.dupeOf(d, PT, rd, 398, 'p1'), { area: R201, slot: 'p1' }, 'the whole evolution line');
  assert.equal(R.dupeOf(d, PT, rd, 396, 'p2'), null);
  // Ana catches a Staravia on Route 202 anyway: not entered as the area's encounter – the inbox says why
  const res = snap(d, 'p1', [...ana, mon({ key: 'a3', species: 397, nickname: 'STARAVIA', metLocation: 17 })]);
  assert.equal(d.get(`enc:${R202}:p1`, null), null);
  assert.deepEqual(res.inbox.map((i) => [i.mon.key, i.reason, i.dupeArea]), [['a3', 'dupe', R201]]);
  // Ben catches a Starly on Route 202: his first of that line – his encounter there
  snap(d, 'p2', [...ben, mon({ key: 'b3', species: 396, nickname: 'STARLY', metLocation: 17 })]);
  assert.equal(d.get(`enc:${R202}:p2`).species, 396);
});

test('Platinum SoulLink, dupes "For both": a line either of you caught is a dupe for both – also from a failed pair', () => {
  const { d, ben } = failedPair({ dupes: 'both' });
  assert.deepEqual(R.dupeOf(d, PT, rd, 396, 'p2'), { area: R201, slot: 'p1' });
  const res = snap(d, 'p2', [...ben, mon({ key: 'b3', species: 396, nickname: 'STARLY', metLocation: 17 })]);
  assert.equal(d.get(`enc:${R202}:p2`, null), null);
  assert.deepEqual(res.inbox.map((i) => [i.reason, i.dupeArea]), [['dupe', R201]]);
});

test('Platinum SoulLink: a dead pair still counts for the dupes clause; a Pokémon that got away never does', () => {
  const { d, ben } = failedPair({ dupes: 'player' });
  // Route 203: both caught, then Ben's Bidoof fell – the pair is dead, both Pokémon count as caught for the dupes clause
  snap(d, 'p1', [mon({ key: 'a1' }), mon({ key: 'a4', species: 403, nickname: 'SHINX', metLocation: 18 })]);
  snap(d, 'p2', [...ben, mon({ key: 'b4', species: 399, nickname: 'BIDOOF', metLocation: 18 })]);
  R.markDead(d, PT, R203, { slot: 'p2', cause: 'test' });
  assert.equal(R.pairState(d, R203, PT).state, 'dead');
  assert.deepEqual(R.dupeOf(d, PT, rd, 400, 'p2'), { area: R203, slot: 'p2' });
  // Ben's encounter on Route 201 was knocked out, not caught, and entered without its species: no dupe
  assert.equal(d.get(`enc:${R201}:p2`).species, null);
  for (const s of [396, 399, 390]) assert.equal(R.dupeOf(mkDoc({ dupes: 'both' }), PT, rd, s, 'p2'), null);
});

test('Platinum SoulLink level caps: the gym aces read from the game, by the badges each player has – per player, warnings name them', () => {
  const d = mkDoc({ levelCaps: true });
  // what shared/live/romcaps.mjs reads from Platinum (USA): Roark 14, Gardenia 22, Fantina 26, Maylene 32, Wake 37,
  // Byron 41, Candice 44, Volkner 50, Champion Cynthia 62 (checked against the ROM for ticket #18)
  const romCaps = { caps: [14, 22, 26, 32, 37, 41, 44, 50], leaders: null, final: { name: 'Champion', cap: 62 } };
  // (a level jump is believed on the second read in a row – lib/run.mjs trustLevels)
  const reads = (slot, party, extra) => [1, 2].forEach(() => snap(d, slot, party, extra));
  const ana = (level) => [mon({ key: 'a1', level })];
  const ben = (level) => [mon({ key: 'b1', species: 390, nickname: 'CHIMCHAR', level })];
  snap(d, 'p1', ana(12), { romCaps });
  assert.equal(R.levelCap(d, PT, 'p1').cap, null, 'badges not read yet: no cap rather than a wrong one');
  snap(d, 'p1', ana(12), { romCaps, badges: 0 });
  snap(d, 'p2', ben(13), { romCaps, badges: 0 });
  assert.deepEqual([R.levelCap(d, PT, 'p1').cap, R.levelCap(d, PT, 'p2').cap], [14, 14]);
  assert.equal(R.levelCap(d, PT, 'p1').boss.name, 'Gym 1', '(Platinum names no leader per badge: "Gym n")');
  assert.equal(R.checks(d, PT, rd).filter((c) => /Level cap/.test(c.text)).length, 0);
  // Ana beats Roark and Gardenia, Ben only Roark: each has the cap of their own next gym
  reads('p1', ana(23), { romCaps, badges: 2 });
  reads('p2', ben(23), { romCaps, badges: 1 });
  assert.deepEqual([R.levelCap(d, PT, 'p1').cap, R.levelCap(d, PT, 'p2').cap], [26, 22]);
  const over = R.checks(d, PT, rd).filter((c) => /Level cap/.test(c.text));
  assert.deepEqual(over.map((c) => [c.level, c.slot]), [['warn', 'p2']]);
  assert.match(over[0].text, /Level cap 22 exceeded: Ben’s CHIMCHAR is level 23/);
  // all eight badges: the champion's ace
  reads('p1', ana(55), { romCaps, badges: 8 });
  assert.equal(R.levelCap(d, PT, 'p1').cap, 62);
  // caps off: no warnings at all
  d.set('rules', { levelCaps: false });
  assert.equal(R.checks(d, PT, rd).filter((c) => /Level cap/.test(c.text)).length, 0);
});

test('board rules: the dupes clause says what counts – whose catches, and that a failed or dead pair’s catch counts too', () => {
  // (the SoulLink rules are one component for the board and the wizard since 2.8.2 – views/nuzrules.mjs SoulLinkRules)
  const board = readFileSync(new URL('../web/views/nuzrules.mjs', import.meta.url), 'utf8');
  assert.match(readFileSync(new URL('../web/views/board.mjs', import.meta.url), 'utf8'), /<\$\{SoulLinkRules\} value=\$\{r\}/);
  assert.match(board, /t\('rules\.dupesPlayerHint'/);
  assert.match(board, /t\('rules\.dupesBothHint'/);
  assert.match(board, /t\('rules\.dupesWhich'/);
  const en = JSON.parse(readFileSync(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
  assert.match(board, /MissedDupesRule/, 'the switch "Fled or knocked-out encounters count as dupes"');
  for (const lang of ['de', 'fr', 'es', 'it']) {
    const tr = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of Object.keys(en).filter((x) => /^(rules\.(dupes|missedDupes)|enc\.(missed|dupe)|feed\.missed|battle\.dupe|inbox\.dupe)/.test(x))) assert.ok(tr[k], `${lang}: ${k}`);
  }
});

// ---------------------------------------------------------------------------
// Missed encounters with their species (2.8.0): the dupes clause's switch, and the got-away question in a SoulLink

/** Ana caught a Starly on Route 201; Ben's wild Bidoof there got away and was entered as missed, with its species. */
function missedPair(rules, { by = 'b' } = {}) {
  const d = mkDoc(rules);
  d.by = by;
  snap(d, 'p1', [mon({ key: 'a1' }), mon({ key: 'a2', species: 396, nickname: 'STARLY', metLocation: 16 })]);
  snap(d, 'p2', [mon({ key: 'b1', species: 390, nickname: 'CHIMCHAR' })]);
  assert.equal(R.markMissed(d, PT, R.areaForCatch(d, PT, 4, 16), 'p2', { species: 399, by: 'p2' }), true);
  return d;
}

test('missed with its species, switch off (the default and every older run): it never counts as a dupe', () => {
  for (const rules of [{ dupes: 'player' }, { dupes: 'both' }, { dupes: 'both', missedDupes: false }]) {
    const d = missedPair(rules);
    assert.equal(d.get(`enc:${R201}:p2`).species, 399, 'the species is kept with the missed encounter');
    assert.equal(R.rules(d, PT).missedDupes, false);
    assert.equal(R.dupeOf(d, PT, rd, 399, 'p2'), null);
    assert.equal(R.dupeOf(d, PT, rd, 400, 'p1'), null);
    // the catches still count as before
    assert.deepEqual(R.dupeOf(d, PT, rd, 396, 'p1'), { area: R201, slot: 'p1' });
  }
});

test('missed with its species, switch on, "Per player": the line is used up for the one it got away from', () => {
  const d = missedPair({ dupes: 'player', missedDupes: true });
  assert.deepEqual(R.dupeOf(d, PT, rd, 399, 'p2'), { area: R201, slot: 'p2', missed: true });
  assert.deepEqual(R.dupeOf(d, PT, rd, 400, 'p2'), { area: R201, slot: 'p2', missed: true }, 'the whole evolution line');
  assert.equal(R.dupeOf(d, PT, rd, 399, 'p1'), null, 'Ana: the partner’s encounters don’t matter per player');
  // Ben catches a Bidoof on Route 202 anyway: not his encounter there – the inbox says it got away before
  const res = snap(d, 'p2', [mon({ key: 'b1', species: 390, nickname: 'CHIMCHAR' }), mon({ key: 'b2', species: 399, nickname: 'BIDOOF', metLocation: 17 })]);
  assert.equal(d.get(`enc:${R202}:p2`, null), null);
  assert.deepEqual(res.inbox.map((i) => [i.reason, i.dupeArea, i.dupeMissed]), [['dupe', R201, true]]);
  // a catch of the line (Ben assigns a Bibarel by hand) wins over the missed one – the texts say "already caught"
  R.setEncounter(d, PT, R.areaForCatch(d, PT, 4, 18), 'p2', { outcome: 'caught', species: 400, key: 'b3' }, { by: 'p2' });
  assert.deepEqual(R.dupeOf(d, PT, rd, 399, 'p2'), { area: R203, slot: 'p2' });
});

test('missed with its species, switch on, "For both": the line is used up for either player; dupes "species" compares species', () => {
  const d = missedPair({ dupes: 'both', missedDupes: true });
  assert.deepEqual(R.dupeOf(d, PT, rd, 400, 'p1'), { area: R201, slot: 'p2', missed: true });
  const res = snap(d, 'p1', [mon({ key: 'a1' }), mon({ key: 'a2', species: 396, nickname: 'STARLY', metLocation: 16 }), mon({ key: 'a3', species: 399, nickname: 'BIDOOF', metLocation: 17 })]);
  assert.equal(d.get(`enc:${R202}:p1`, null), null);
  assert.deepEqual(res.inbox.map((i) => [i.reason, i.dupeMissed]), [['dupe', true]]);
  const sp = missedPair({ dupes: 'species', missedDupes: true });
  assert.ok(R.dupeOf(sp, PT, rd, 399, 'p2')?.missed);
  assert.equal(R.dupeOf(sp, PT, rd, 400, 'p2'), null);
  // off is off
  assert.equal(R.dupeOf(missedPair({ dupes: 'off', missedDupes: true }), PT, rd, 399, 'p2'), null);
});

test('old runs: a missed encounter without its species never counts, also with the switch on', () => {
  const { d } = failedPair({ dupes: 'both', missedDupes: true });
  assert.equal(d.get(`enc:${R201}:p2`).species, null);
  for (const s of [399, 400]) assert.equal(R.dupeOf(d, PT, rd, s, 'p2'), null);
  // rules stored before the switch existed: off
  const old = mkDoc({ dupes: 'both', failKillsPair: true });
  assert.equal(R.rules(old, PT).missedDupes, false);
});

test('SoulLink got-away question: each player is asked after a wild battle without a catch – unless their encounter there is entered', () => {
  const d = mkDoc({ dupes: 'player' });
  snap(d, 'p1', [mon({ key: 'a1' })]);
  snap(d, 'p2', [mon({ key: 'b1', species: 390, nickname: 'CHIMCHAR' })]);
  const here = { gen: 4, id: 16, name: 'Route 201' };
  const base = { foe: { species: 399, level: 3 }, wild: true, from: 1000, newMonAt: 0, boxes: true, partySize: 1, here };
  const ask = (slot, o = {}, doc = d) => R.missedQuestion(doc, PT, rd, slot, { ...base, ...o });
  assert.equal(ask('p1'), true);
  assert.equal(ask('p2'), true);
  assert.equal(ask('p2', { wild: false }), false, 'a trainer battle');
  assert.equal(ask('p2', { newMonAt: 2000 }), false, 'caught after all');
  assert.equal(ask('p2', { foe: { species: 399, shiny: true } }), false, 'shiny clause');
  // Ana catches a Starly on Route 201: her encounter there is entered – no first encounter for her anymore, Ben still has his
  snap(d, 'p1', [mon({ key: 'a1' }), mon({ key: 'a2', species: 396, nickname: 'STARLY', metLocation: 16 })]);
  assert.equal(ask('p1'), false, 'Ana’s encounter on Route 201 is entered');
  assert.equal(ask('p1', { here: { gen: 4, id: 17, name: 'Route 202' } }), true, 'on Route 202 it is her first');
  assert.equal(ask('p2'), true);
  assert.equal(ask('p1', { foe: { species: 397 }, here: { gen: 4, id: 17, name: 'Route 202' } }), false, 'a dupe for Ana doesn’t count anyway');
  // a place the app can't tell (no place sign, a sign of another generation): no question in a SoulLink – a "yes"
  // would fail the pair for everyone, after every wild battle there
  assert.equal(ask('p2', { here: null }), false, 'no place sign');
  assert.equal(ask('p2', { here: { gen: 3, id: 16, name: 'Route 201' } }), false, 'not this game\'s place');
  assert.equal(ask('p2', { here: { gen: 4, id: null, name: '?' } }), false);
  // a known place nobody caught at yet: asked
  assert.equal(ask('p2', { here: { gen: 4, id: 18, name: 'Route 203' } }), true);
  // the run is over: nobody is asked
  d.set('run:status', { state: 'failed', at: Date.now() });
  assert.equal(ask('p2'), false);
});

test('SoulLink got-away → Missed with its species: the pair fails, the partner gets it by sync, the log says so', () => {
  // Ana's and Ben's computers: two copies of the run document, merged like the run sync does
  const ana = mkDoc({ dupes: 'both', missedDupes: true });
  const ben = mkDoc();
  ben.by = 'b';
  ben.merge(structuredClone(ana.entries));
  snap(ana, 'p1', [mon({ key: 'a1' }), mon({ key: 'a2', species: 396, nickname: 'STARLY', metLocation: 16 })]);
  snap(ben, 'p2', [mon({ key: 'b1', species: 390, nickname: 'CHIMCHAR' })]);
  ben.merge(structuredClone(ana.entries));
  assert.equal(R.pairState(ben, R201, PT).state, 'waiting');
  // Ben's wild Bidoof on Route 201 got away: his play view asks, he marks the area (the place sign's) as spent
  assert.equal(R.missedQuestion(ben, PT, rd, 'p2', { foe: { species: 399, level: 3 }, wild: true, from: 1000, here: { gen: 4, id: 16, name: 'Route 201' } }), true);
  assert.equal(R.markMissed(ben, PT, R.areaForCatch(ben, PT, 4, 16, { create: false }), 'p2', { species: 399, by: 'p2' }), true);
  assert.equal(R.markMissed(ben, PT, R201, 'p2', { species: 399 }), false, 'once');
  ana.merge(structuredClone(ben.entries));
  for (const d of [ana, ben]) {
    assert.equal(R.pairState(d, R201, PT).state, 'failed');
    assert.deepEqual(d.get(`enc:${R201}:p2`), { ...d.get(`enc:${R201}:p2`), outcome: 'missed', species: 399, by: 'p2' });
  }
  // Ana's Starly may not be used now, and Bidoof's line is a dupe for her too (for both + the switch)
  assert.deepEqual(R.checks(ana, PT, rd).filter((c) => c.level === 'error').map((c) => c.area), [R201]);
  assert.deepEqual(R.dupeOf(ana, PT, rd, 400, 'p1'), { area: R201, slot: 'p2', missed: true });
  // the log line Ana's toast shows
  const f = R.feedList(ana).find((x) => x.type === 'missed');
  assert.deepEqual([f.slot, f.species, f.msg.key], ['p2', 399, 'feed.missedPair']);
  assert.match(R.feedText(ana, PT, f), /Route 201|#16/);
  assert.match(R.feedText(ana, PT, f), /got away – the pair is lost/);
  // with "a missed encounter costs the whole pair" off it is just Ben's area
  const off = missedPair({ failKillsPair: false });
  assert.equal(R.feedList(off).find((x) => x.type === 'missed').msg.key, 'feed.missedSpecies');
  assert.equal(R.checks(off, PT, rd).filter((c) => c.level === 'error').length, 0);
  // the switch set on one computer reaches the other one like every rule
  ben.set('rules', { ...ben.get('rules'), missedDupes: false });
  ana.merge(structuredClone(ben.entries));
  assert.equal(R.rules(ana, PT).missedDupes, false);
  assert.equal(R.dupeOf(ana, PT, rd, 400, 'p1'), null);
});

test('the board’s Missed: entered by hand with its species (it logs it), and the last wild Pokémon of the place fills it in', () => {
  const d = mkDoc({ dupes: 'player', missedDupes: true });
  snap(d, 'p2', [mon({ key: 'b1', species: 390, nickname: 'CHIMCHAR' })]);
  // the play view keeps the last wild Pokémon with the place sign ("where:<slot>".wild)
  d.set('where:p2', { gen: 4, id: 16, name: 'Route 201', at: Date.now(), wild: { species: 399, level: 3, at: Date.now() } });
  R.areaForCatch(d, PT, 4, 16);
  assert.deepEqual(R.lastWildAt(d, PT, 4, R201, 'p2'), { species: 399, level: 3, at: d.get('where:p2').wild.at });
  assert.equal(R.lastWildAt(d, PT, 4, R202, 'p2'), null, 'another area');
  assert.equal(R.lastWildAt(d, PT, 4, R201, 'p1'), null, 'another player');
  // (what EncounterModal saves for "Missed" with a species)
  R.setEncounter(d, PT, R201, 'p2', { outcome: 'missed', species: 399, nickname: '', level: null, shiny: false, key: null }, { by: 'p2' });
  assert.deepEqual(R.feedList(d).find((x) => x.type === 'missed').species, 399);
  assert.deepEqual(R.dupeOf(d, PT, rd, 400, 'p2'), { area: R201, slot: 'p2', missed: true });
  // without a species (optional): as before
  R.setEncounter(d, PT, R202, 'p2', { outcome: 'missed', species: null }, { by: 'p2' });
  assert.equal(R.feedList(d).filter((x) => x.type === 'missed').find((x) => x.area === R202).msg.key, 'feed.missed');
});
