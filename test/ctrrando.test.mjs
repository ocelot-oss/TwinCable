// Randomizing Nintendo 3DS games (server/lib/ctrrando.mjs, the 3DS path of server/lib/build.mjs, the bridge options in
// server/lib/toolchain.mjs). No real game here: the build tests run a stand-in for the Java bridge; the live tests
// (Java + UPR available) feed UPR ZX tiny made-up files – only header fields, no game data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, linkSync, openSync, writeSync, closeSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cci, ncchHeader } from './fixtures/ctr.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-ctrrando-'));
process.env.SLS_DATA_DIR = DATA;
const { ncchSizeOf, freeBytes, checkCtrSpace, ctrRandoError, ctrProgress, hashFile, inspectCtr, CTR_WORK_MARGIN } = await import('../server/lib/ctrrando.mjs');
const { javaOptsFor, parseBridgeOutput, JAVA_OPTS, CTR_HEAP, detectJava, UPR_JAR, runBridge } = await import('../server/lib/toolchain.mjs');
const { buildRun, runPack, readManifest } = await import('../server/lib/build.mjs');
const { sameSettings, buildValues, PRESETS, OPTION_GROUPS, forGen } = await import('../shared/randomizer-options.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const LIB = join(DATA, 'Library');
mkdirSync(LIB, { recursive: true });
const ROM = join(LIB, 'Pokemon X.3ds');
const ROM_BYTES = cci({ productCode: 'CTR-P-EKJA', titleId: '0004000000055D00' });
writeFileSync(ROM, ROM_BYTES);

/**
 * A stand-in for runBridge('randomize', …): prints the progress lines the real bridge and UPR print, then writes the
 * "game" like UPR's RandomAccessFile("rw") – into an existing file without truncating it. The bytes depend on seed
 * and settings only, as with the real one.
 */
function fakeBridge(calls, { fail = null } = {}) {
  return async (args, opts) => {
    calls.push({ args, opts });
    const [cmd, , out, props, seed, log, data] = args;
    assert.equal(cmd, 'randomize');
    for (const l of ['NCCH: Visiting file a/0/0/0', '@@STEP "load"', '@@FILES 4', '@@STEP "randomize"', 'NCCH: Rebuilding exefs...',
      'NCCH: Writing file a/0/0/0 to romfs', 'NCCH: Writing file a/0/0/1 to romfs', 'NCCH: Writing file a/0/0/2 to romfs', 'NCCH: Writing file a/0/0/3 to romfs']) opts.onLine?.(l);
    if (fail) throw Object.assign(new Error(`Randomizer-Fehler: ${fail}`), { code: fail });
    const bytes = Buffer.from(`CXI seed=${seed} ${sha1(readFileSync(props))}`);
    const fd = openSync(out, existsSync(out) ? 'r+' : 'w');
    writeSync(fd, bytes, 0, bytes.length, 0);
    closeSync(fd);
    writeFileSync(log, `log ${seed}`);
    writeFileSync(data, JSON.stringify({ seed, pokemon: [], starters: [], encounters: [], statics: [] }));
    return { warnings: ['Some code tweaks are not supported by this ROM and were removed'], settingsString: 'SETTINGS' };
  };
}

const VALUES = buildValues(PRESETS.find((p) => p.id === 'hardcore').values, 6);

test('bridge options: Gen 1–5 keep their JVM options, a 3DS game gets the big heap and its own working folder', () => {
  assert.deepEqual(javaOptsFor(), JAVA_OPTS);
  assert.equal(JAVA_OPTS.find((o) => o.startsWith('-Xmx')), '-Xmx1g');
  const ctr = javaOptsFor({ ctr: true, workDir: '/tmp/w' });
  assert.equal(ctr.filter((o) => o.startsWith('-Xmx')).length, 1);
  assert.ok(ctr.includes(CTR_HEAP));
  assert.ok(ctr.includes('-Dtwicable.upr.root=/tmp/w'));
  for (const o of JAVA_OPTS.filter((x) => !x.startsWith('-Xmx'))) assert.ok(ctr.includes(o), o);
});

test('the bridge\'s @@ lines: codes, steps and the romfs file count; garbage is skipped', () => {
  const r = parseBridgeOutput(['NCCH: Reading exefs...', '@@STEP "load"', '@@FILES 665', '@@WARN "w"', '@@CODE "encrypted"', '@@ERROR "boom"', '@@JSON {broken', ''].join('\n'));
  assert.equal(r.step, 'load');
  assert.equal(r.files, 665);
  assert.equal(r.code, 'encrypted');
  assert.equal(r.error, 'boom');
  assert.deepEqual(r.warnings, ['w']);
  assert.equal(r.json, null);
});

test('progress of a 3DS build: load, randomize, write in ~5 % steps, finish once every file is written', () => {
  const seen = [];
  const feed = ctrProgress((p) => seen.push(p));
  for (const l of ['@@STEP "load"', '@@FILES 40', '@@STEP "randomize"', 'NCCH: Rebuilding exefs...']) feed(l);
  for (let i = 0; i < 40; i++) feed(`NCCH: Writing file a/${i} to romfs`);
  assert.deepEqual(seen.slice(0, 3), [{ phase: 'load' }, { phase: 'randomize' }, { phase: 'write', done: 0, total: 40 }]);
  const writes = seen.filter((p) => p.phase === 'write');
  assert.ok(writes.length <= 21, `throttled: ${writes.length}`);
  assert.deepEqual(writes.at(-1), { phase: 'write', done: 38, total: 40 }); // (the 95 % step)
  assert.deepEqual(seen.at(-1), { phase: 'finish' }, 'every file written: UPR hashes the romfs');
  // without a file count: one "writing" step, no percentages
  const bare = [];
  const f2 = ctrProgress((p) => bare.push(p));
  f2('NCCH: Rebuilding exefs...');
  f2('NCCH: Writing file x to romfs');
  assert.deepEqual(bare, [{ phase: 'write', done: 0, total: 0 }]);
});

test('size of the game\'s NCCH: from the cartridge\'s partition table or the NCCH header, else the file size', () => {
  const big = cci();
  big[0x124] = 0x10; // partition 0: 0x10 media units = 0x2000 bytes
  writeFileSync(join(DATA, 'p.3ds'), big);
  assert.equal(ncchSizeOf(join(DATA, 'p.3ds')), 0x2000);
  const n = new Uint8Array(0x1000);
  n.set(ncchHeader(), 0);
  n[0x104] = 4; // content size: 4 media units
  writeFileSync(join(DATA, 'p.cxi'), n);
  assert.equal(ncchSizeOf(join(DATA, 'p.cxi')), 0x800);
  writeFileSync(join(DATA, 'p.cia'), new Uint8Array(0x300));
  assert.equal(ncchSizeOf(join(DATA, 'p.cia')), 0x300);
  assert.equal(ncchSizeOf(join(DATA, 'missing.3ds')), 0);
});

test('space check: a clear 507 with the numbers, nothing when the free space is unknown', () => {
  const gb = 1024 ** 3;
  assert.doesNotThrow(() => checkCtrSpace(DATA, 3 * gb, 1, { free: 3 * gb + CTR_WORK_MARGIN }));
  assert.throws(() => checkCtrSpace(DATA, 3 * gb, 2, { free: 4 * gb }), (e) => e.status === 507 && e.code === 'ctrNoSpace' && e.vars.need === '6.8' && e.vars.free === '4.0');
  assert.doesNotThrow(() => checkCtrSpace(DATA, 3 * gb, 4, { free: null }));
  assert.ok(freeBytes(DATA) > 0);
  assert.equal(freeBytes(DATA, () => { throw new Error('no statfs'); }), null);
});

test('the bridge\'s error codes become messages the app translates', () => {
  assert.equal(ctrRandoError(Object.assign(new Error('x'), { code: 'encrypted' })).code, 'ctrEncrypted');
  assert.equal(ctrRandoError(Object.assign(new Error('x'), { code: 'encrypted' })).status, 422);
  assert.equal(ctrRandoError(Object.assign(new Error('x'), { code: 'memory' })).code, 'ctrMemory');
  assert.equal(ctrRandoError(Object.assign(new Error('x'), { code: 'timeout' })).code, 'ctrTimeout');
  const other = new Error('Randomizer-Fehler: something');
  assert.equal(ctrRandoError(other), other);
});

test('hashFile streams the same SHA-1 as hashing the whole file', async () => {
  const f = join(DATA, 'h.bin');
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 7, 0x5a);
  writeFileSync(f, bytes);
  assert.equal(await hashFile(f), sha1(bytes));
});

test('inspect: UPR\'s info for a supported game, clear reasons for encrypted and compressed files', async () => {
  const calls = [];
  const ok = await inspectCtr('/g.3ds', { encrypted: false }, async (args, opts) => {
    calls.push({ args, opts });
    return { json: { generation: 7, pokemonCount: 802, miscTweaks: ['FASTEST_TEXT'] } };
  });
  assert.deepEqual(calls[0].args, ['info', '/g.3ds']);
  assert.equal(calls[0].opts.ctr, true);
  assert.equal(ok.generation, 7);
  assert.equal(ok.system, '3ds');
  assert.equal(ok.unsupported, undefined);
  const enc = await inspectCtr('/g.3ds', {}, async () => { throw Object.assign(new Error('x'), { code: 'encrypted' }); });
  assert.equal(enc.reason, 'encrypted');
  // the header says encrypted and UPR couldn't read it: encrypted, not "unsupported game"
  assert.equal((await inspectCtr('/g.3ds', { encrypted: true }, async () => { throw new Error('not supported'); })).reason, 'encrypted');
  assert.equal((await inspectCtr('/g.3ds', { encrypted: false }, async () => { throw new Error('not supported'); })).reason, 'ctr');
  let called = false;
  const z = await inspectCtr('/g.zcci', { compressed: true }, async () => { called = true; return {}; });
  assert.deepEqual([z.reason, called], ['compressed', false]);
});

test('a randomized 3DS Nuzlocke: one .cxi, its SHA-1, progress, the library file untouched', async () => {
  const calls = [];
  const progress = [];
  const log = [];
  const m = await buildRun({ romId: ROM, gameId: 'pokemon-x', gameTitle: 'Pokémon X', randomize: true, values: VALUES, seeds: { p1: '12345' }, mode: 'nuzlocke',
    players: { p1: { name: 'Ash' } }, config: {} }, (l) => log.push(l), (p) => progress.push(p), { bridge: fakeBridge(calls) });
  assert.equal(m.randomizer.enabled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.ctr, true);
  assert.equal(calls[0].args[1], ROM, 'read straight from the library file');
  const out = m.outputs.p1;
  assert.equal(out.rom, 'Ash - X Randomized.cxi');
  const built = readFileSync(join(DATA, 'runs', m.id, out.rom));
  assert.equal(out.sha1, sha1(built));
  assert.equal(out.data, 'p1.data.json');
  assert.equal(m.randomizer.settingsString, 'SETTINGS');
  assert.deepEqual([...readFileSync(ROM)], [...ROM_BYTES], 'the library file is never written');
  assert.deepEqual(progress.map((p) => p.phase).filter((x, i, a) => a[i - 1] !== x), ['randomize', 'load', 'randomize', 'write', 'finish', 'hash']);
  assert.ok(progress.every((p) => p.slot === 'p1' && p.index === 0 && p.count === 1));
  assert.equal(m.diff, undefined, 'no NDS file diff for a 3DS game');
  const pack = runPack(m);
  assert.deepEqual(pack.outputs, { p1: { sha1: out.sha1 } });
});

test('a rebuild never writes into a hard link to the library\'s game (UPR doesn\'t truncate), and drops the old file', async () => {
  // a plain 3DS run first: its game is a hard link to the library file
  const plain = await buildRun({ romId: ROM, gameId: 'pokemon-x', gameTitle: 'Pokémon X', randomize: false, mode: 'nuzlocke', players: { p1: { name: 'Ash' } }, config: {} });
  const dir = join(DATA, 'runs', plain.id);
  const oldRom = join(dir, plain.outputs.p1.rom);
  assert.equal(statSync(oldRom).ino, statSync(ROM).ino);
  // and a hard link where the randomized game will go (a crafted worst case)
  const target = join(dir, 'Ash - X Randomized.cxi');
  linkSync(ROM, target);
  const m = await buildRun({ romId: ROM, gameId: 'pokemon-x', gameTitle: 'Pokémon X', randomize: true, values: VALUES, seeds: { p1: '777' }, mode: 'nuzlocke',
    players: { p1: { name: 'Ash' } }, identity: { id: plain.id, room: plain.room, secret: plain.secret }, config: {} }, () => {}, () => {}, { bridge: fakeBridge([]) });
  assert.deepEqual([...readFileSync(ROM)], [...ROM_BYTES], 'the library file kept its bytes');
  assert.notEqual(statSync(target).ino, statSync(ROM).ino);
  assert.equal(m.outputs.p1.rom, 'Ash - X Randomized.cxi');
  assert.equal(existsSync(oldRom), false, 'the plain run\'s game link is gone');
  assert.ok(existsSync(ROM));
});

test('same seed for everyone: built once, the other players get a link to it – same bytes, same checksum', async () => {
  const calls = [];
  const progress = [];
  const m = await buildRun({ romId: ROM, gameId: 'pokemon-x', gameTitle: 'Pokémon X', randomize: true, values: VALUES, seeds: { p1: '42', p2: '42', p3: '42' }, sharedSeed: true,
    mode: 'soullink', players: { p1: { name: 'Ash' }, p2: { name: 'Misty' }, p3: { name: 'Brock' } }, config: {} }, () => {}, (p) => progress.push(p), { bridge: fakeBridge(calls) });
  assert.equal(calls.length, 1);
  const dir = join(DATA, 'runs', m.id);
  const a = statSync(join(dir, m.outputs.p1.rom));
  const b = statSync(join(dir, m.outputs.p2.rom));
  assert.equal(a.ino, b.ino);
  assert.equal(m.outputs.p1.sha1, m.outputs.p3.sha1);
  assert.equal(readFileSync(join(dir, 'p2.data.json'), 'utf8'), readFileSync(join(dir, 'p1.data.json'), 'utf8'));
  assert.deepEqual(progress.filter((p) => p.phase === 'reuse').map((p) => p.slot), ['p2', 'p3']);

  // separate seeds: one build per player
  const calls2 = [];
  const m2 = await buildRun({ romId: ROM, gameId: 'pokemon-x', randomize: true, values: VALUES, seeds: { p1: '1', p2: '2' }, mode: 'soullink',
    players: { p1: { name: 'Ash' }, p2: { name: 'Misty' } }, config: {} }, () => {}, () => {}, { bridge: fakeBridge(calls2) });
  assert.equal(calls2.length, 2);
  assert.notEqual(m2.outputs.p1.sha1, m2.outputs.p2.sha1);
});

test('joining a randomized 3DS run compares the game with the host\'s like a Gen 1–5 ROM', async () => {
  const host = await buildRun({ romId: ROM, gameId: 'pokemon-x', gameTitle: 'Pokémon X', randomize: true, values: VALUES, seeds: { p1: '5', p2: '6' }, mode: 'soullink',
    players: { p1: { name: 'Ash' }, p2: { name: 'Misty' } }, config: {} }, () => {}, () => {}, { bridge: fakeBridge([]) });
  const pack = runPack(host);
  assert.match(pack.outputs.p2.sha1, /^[0-9a-f]{40}$/);
  const join2 = (expected, log) => buildRun({ romId: ROM, gameId: 'pokemon-x', gameTitle: 'Pokémon X', randomize: true, values: pack.randomizer.values, seeds: pack.randomizer.seeds,
    mode: 'soullink', players: pack.players, identity: { id: host.id, room: host.room, secret: host.secret }, buildFor: ['p2'], expectedOutputs: expected, config: {} },
  (l) => log.push(l), () => {}, { bridge: fakeBridge([]) });
  const log = [];
  const ok = await join2(pack.outputs, log);
  assert.equal(ok.outputs.p2.matchesFriend, true);
  assert.ok(log.some((l) => l.code === 'romMatches' && l.vars.name === pack.players.p2.name), JSON.stringify(log));
  const log2 = [];
  const bad = await join2({ p2: { sha1: '0'.repeat(40) } }, log2);
  assert.equal(bad.outputs.p2.matchesFriend, false);
  assert.ok(log2.some((l) => l.code === 'romDiffers'), JSON.stringify(log2));
});

test('an encrypted dump: the build fails with ctrEncrypted, a new run leaves no folder and no half-written game', async () => {
  await assert.rejects(buildRun({ romId: ROM, gameId: 'pokemon-x', randomize: true, values: VALUES, seeds: { p1: '9' }, mode: 'nuzlocke', players: { p1: { name: 'Ash' } }, config: {},
    identity: { id: 'abcdef12', room: 'r-r-r', secret: 'secretsecret' } }, () => {}, () => {}, { bridge: fakeBridge([], { fail: 'encrypted' }) }),
  (e) => e.code === 'ctrEncrypted' && e.status === 422);
  assert.equal(existsSync(join(DATA, 'runs', 'abcdef12')), false);
  assert.equal(readManifest('abcdef12'), null);
});

test('3DS options: totems only for Gen 7, Mega Evolution options for Gen 6–7; Gen 1–5 build exactly as before', () => {
  const fields = OPTION_GROUPS.flatMap((g) => g.fields);
  const totems = OPTION_GROUPS.find((g) => g.id === 'totems');
  assert.ok(totems.fields.every((f) => forGen(f, 7) && !forGen(f, 6) && !forGen(f, 4)));
  for (const k of ['swapTrainerMegaEvos', 'swapStaticMegaEvos', 'typesFollowMegaEvolutions', 'abilitiesFollowMegaEvolutions', 'baseStatsFollowMegaEvolutions']) {
    const f = fields.find((x) => x.key === k);
    assert.ok(forGen(f, 6) && forGen(f, 7) && !forGen(f, 5), k);
  }
  const hard = PRESETS.find((p) => p.id === 'hardcore').values;
  assert.equal(buildValues(hard, 7).totemPokemonMod, 'SIMILAR_STRENGTH');
  assert.equal(buildValues(hard, 6).totemPokemonMod, 'UNCHANGED', 'X/Y have no totems');
  // on Gen 4 every 3DS-only option is UPR's default – the same settings string, the same ROM
  const g4 = buildValues(hard, 4);
  for (const k of ['totemPokemonMod', 'allyPokemonMod', 'auraMod']) assert.equal(g4[k], 'UNCHANGED');
  for (const k of ['swapTrainerMegaEvos', 'randomizeTotemHeldItems', 'totemLevelsModified']) assert.equal(g4[k], false);
  assert.equal(g4.totemLevelModifier, 0);
});

test('sameSettings with a generation: an old Gen 4 run still matches its preset, a 3DS run its totem choice', () => {
  const trainers = PRESETS.find((p) => p.id === 'soullink-trainers').values;
  // a run saved before the 3DS options existed (no totem keys)
  const old = Object.fromEntries(Object.entries(trainers).filter(([k]) => !/totem|ally|aura|Mega/i.test(k)));
  assert.equal(sameSettings(trainers, old), false, 'without the generation the Gen 7 totems differ');
  assert.equal(sameSettings(trainers, old, 4), true);
  assert.equal(sameSettings(trainers, buildValues(trainers, 4), 4), true);
  assert.equal(sameSettings(trainers, buildValues(trainers, 7), 7), true);
  assert.equal(sameSettings(trainers, { ...buildValues(trainers, 7), totemPokemonMod: 'RANDOM' }, 7), false);
});

// ---- live: the real bridge with UPR ZX (skipped without Java) ----

const canRunBridge = detectJava().ok && existsSync(UPR_JAR);

/** A made-up cartridge image with Pokémon Sun's product code and title ID, its contents not readable (as if encrypted). */
function fakeSun({ decryptedFlag = false } = {}) {
  const b = cci({ productCode: 'CTR-P-BNDA', titleId: '0004000000164800', encrypted: !decryptedFlag });
  const out = new Uint8Array(0x4000 + 0x4000);
  out.set(b.subarray(0, 0x4000 + 0x200), 0);
  out[0x4000 + 0x1a0] = 2; // exefs at 2 media units into the NCCH
  out[0x4000 + 0x1b0] = 4; // romfs at 4 – zeros: no romfs magic, nothing UPR recognises
  return out;
}

test('live: an encrypted 3DS dump is reported as such by UPR ZX, never "not supported"', { skip: !canRunBridge && 'no Java / UPR here' }, async () => {
  const f = join(DATA, 'enc.3ds');
  writeFileSync(f, fakeSun());
  await assert.rejects(runBridge(['info', f], { ctr: true, timeoutMs: 120000 }), (e) => e.code === 'encrypted');
  const info = await inspectCtr(f, { encrypted: true }, runBridge);
  assert.equal(info.reason, 'encrypted');
  // UPR's working folder for 3DS games is the bridge call's own, under the cache – gone afterwards (removed right after
  // the answer, best effort: a folder a scanner holds must never keep the answer back – toolchain.mjs runBridge)
  const left = () => (existsSync(join(DATA, 'cache', 'upr-3ds')) ? readdirSync(join(DATA, 'cache', 'upr-3ds')) : []);
  for (let i = 0; i < 100 && left().length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(left(), []);
});

test('live: a 3DS file of another game is "not supported", without the encrypted code', { skip: !canRunBridge && 'no Java / UPR here' }, async () => {
  const f = join(DATA, 'other.3ds');
  const b = cci({ productCode: 'CTR-P-AAAA', titleId: '0004000000012300' });
  writeFileSync(f, b);
  await assert.rejects(runBridge(['info', f], { ctr: true, timeoutMs: 120000 }), (e) => !e.code && /not supported/i.test(e.message));
});
