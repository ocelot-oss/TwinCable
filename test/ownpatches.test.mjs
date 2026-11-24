// Patches of hacks the catalog doesn't know (on the shelf, named after the file, versions together) and the message
// after adding files ("Added: …", "Already in your library" …) – 2.6.3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { crc32 } from 'node:zlib';
import { patchTitle, patchFamily } from '../shared/patchname.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-ownpatch-'));
process.env.SLS_DATA_DIR = DATA;
const { scanLibrary } = await import('../server/lib/library.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

// the web modules import browser paths (/shared/…): map them onto the project folder
const ROOT = new URL('../', import.meta.url).href;
registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx)) });
const { addedToLibrary, addedMessage } = await import('../web/lib/libadded.mjs');

/** A valid BPS patch from `source` to `source` with the bytes of `tag` written at 16 (source / result CRC32 inside). */
function bps(source, tag) {
  const target = Buffer.from(source);
  Buffer.from(tag).copy(target, 16);
  const out = [];
  const num = (d) => {
    for (;;) {
      const x = d & 0x7f;
      d = Math.floor(d / 128);
      if (d === 0) return out.push(0x80 | x);
      out.push(x);
      d--;
    }
  };
  out.push(...Buffer.from('BPS1'));
  num(source.length);
  num(target.length);
  num(0);
  num(((16 - 1) * 4) | 0);
  num(((tag.length - 1) * 4) | 1);
  out.push(...Buffer.from(tag));
  num(((source.length - 16 - tag.length - 1) * 4) | 0);
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    out.push(...b);
  };
  u32(crc32(source));
  u32(crc32(target));
  u32(crc32(Buffer.from(out)));
  return Buffer.from(out);
}

test('a patch file name becomes a title and a version', () => {
  const cases = {
    'Pokémon_Light_Platinum (U) 1.0.ips': ['Pokémon Light Platinum (U)', '1.0'],
    'v1.4.1_BlazeBlack2Redux.xdelta': ['BlazeBlack2Redux', '1.4.1'],
    'Pokemon.Crystal.Legacy.V1.3.1.Patches.bps': ['Pokemon Crystal Legacy Patches', '1.3.1'],
    'RenegadePlatinumV130.xdelta': ['RenegadePlatinum', '130'],
    'Pokemon Run&Bun 1.07.bps': ['Pokemon Run&Bun', '1.07'],
    'Emerald Crest v2.bps': ['Emerald Crest', '2'],
    'My_Hack_ver_1_2.bps': ['My Hack', '1.2'],
    'Pokemon Black 2 Kaizo.xdelta': ['Pokemon Black 2 Kaizo', null], // "2" is part of the name
    'Hack.bps': ['Hack', null],
  };
  for (const [name, [title, version]] of Object.entries(cases)) assert.deepEqual(patchTitle(name), { title, version }, name);
  assert.equal(patchFamily('Emerald Crest v1.bps'), patchFamily('Emerald_Crest_v2.0.bps'));
  assert.notEqual(patchFamily('Emerald Crest v1.bps'), patchFamily('Emerald Rush v1.bps'));
});

test('a patch the catalog doesn\'t know: its versions are one family, newest first, base ROM found by the patch\'s CRC32', () => {
  const dir = join(DATA, 'own');
  mkdirSync(dir, { recursive: true });
  const rom = Buffer.alloc(256, 7);
  writeFileSync(join(dir, 'Base.gba'), rom);
  writeFileSync(join(dir, 'Emerald Crest v1.bps'), bps(rom, 'CREST1'));
  writeFileSync(join(dir, 'Emerald Crest v2.bps'), bps(rom, 'CREST2'));
  writeFileSync(join(dir, 'Other Hack.ips'), Buffer.from('PATCHEOF', 'latin1'));
  utimesSync(join(dir, 'Emerald Crest v1.bps'), new Date('2026-11-14'), new Date('2026-11-14')); // the old one copied last
  const res = scanLibrary({ libraryFolders: [dir] });
  const crest = res.patches.filter((p) => p.family === 'emeraldcrest');
  assert.deepEqual(crest.map((p) => p.name), ['Emerald Crest v2.bps', 'Emerald Crest v1.bps']);
  assert.deepEqual(crest.map((p) => !!p.olderVersion), [false, true]);
  const base = res.roms.find((r) => r.name === 'Base.gba');
  for (const p of crest) {
    assert.equal(p.hackId, null);
    assert.equal(p.expectedCrc, base.crc);
    assert.equal(p.baseRomId, base.id);
  }
  const other = res.patches.find((p) => p.name === 'Other Hack.ips');
  assert.equal(other.family, 'otherhack');
  assert.equal(other.baseRomId, null, 'IPS carries no checksum of its ROM');
  assert.ok(!res.patches.some((p) => p.hackId && p.family), 'catalog hacks are grouped by hackId');
});

test('the library shelf shows patches of unknown hacks, one card per family, with a detail page and a version picker', () => {
  const view = readFileSync(new URL('../web/views/library.mjs', import.meta.url), 'utf8');
  assert.match(view, /export function ownPatchCards\(library\)/);
  assert.match(view, /if \(p\.hackId\) continue;/);
  assert.match(view, /ownPatches\.map\(\(c\) => html`<\$\{Cart\}/);
  const detail = view.slice(view.indexOf('function PatchDetail'), view.indexOf('function RomDetail'));
  assert.match(detail, /card\.versions\.length > 1/);
  assert.match(detail, /PlayButtons/);
  assert.match(detail, /lib\.exportPatched/);
  assert.match(detail, /NewRunButtons\} gameId=\$\{baseRom\?\.gameId\} patchId=\$\{patch\.id\}/);
  const wizard = readFileSync(new URL('../web/views/soullink.mjs', import.meta.url), 'utf8');
  assert.match(wizard, /patchPick=\$\{p\.patch\}/);
});

// ---- what was added ----------------------------------------------------------------------------------------------
const LIB = '/lib';
const rom = (name, crc, gameId = null) => ({ id: `${LIB}/${name}`, name, file: `${LIB}/${name}`, crc, gameId, system: 'gba' });
const patch = (name, sha1, hackId = null) => ({ id: `${LIB}/${name}`, name, file: `${LIB}/${name}`, sha1, hackId });
const cat = { games: [{ id: 'pokemon-emerald', title: 'Pokémon Emerald' }], hacks: [{ id: 'run-and-bun', name: 'Pokémon Run & Bun' }] };

test('added: a newer patch version next to the old one is reported by name and version', () => {
  const before = { roms: [rom('E.gba', 'AAAA', 'pokemon-emerald')], patches: [patch('Pokemon Run&Bun 1.07.bps', 's107', 'run-and-bun')] };
  const after = { roms: before.roms, patches: [patch('Pokemon Run&Bun 1.08.bps', 's108', 'run-and-bun'), ...before.patches] };
  const res = addedToLibrary(before, after, [`${LIB}/Pokemon Run&Bun 1.08.bps`]);
  assert.equal(res.added.length, 1);
  assert.equal(res.already.length, 0);
  const msg = addedMessage(res, cat);
  assert.equal(msg.title, 'Added: Pokémon Run & Bun 1.08 (patch)');
  assert.equal(msg.kind, 'ok');
  assert.doesNotMatch(msg.text, /New games are on the shelf/);
});

test('added: the same file again (also under another name) is "already in your library"', () => {
  const before = { roms: [rom('E.gba', 'AAAA', 'pokemon-emerald')], patches: [patch('Pokemon Run&Bun 1.07.bps', 's107', 'run-and-bun')] };
  const again = addedToLibrary(before, before, [`${LIB}/Pokemon Run&Bun 1.07.bps`]);
  assert.equal(addedMessage(again, cat).title, 'Already in your library');
  const copy = { roms: [...before.roms, rom('E (1).gba', 'AAAA', 'pokemon-emerald')], patches: before.patches };
  const dup = addedToLibrary(before, copy, [`${LIB}/E (1).gba`]);
  assert.equal(dup.already.length, 1);
  assert.equal(addedMessage(dup, cat).text, 'Pokémon Emerald');
});

test('added: the same file name with new content counts as added (an overwritten patch)', () => {
  const before = { roms: [], patches: [patch('Hack.bps', 'old')] };
  const after = { roms: [], patches: [patch('Hack.bps', 'new')] };
  assert.equal(addedToLibrary(before, after, [`${LIB}/Hack.bps`]).added.length, 1);
});

test('added: several files are counted ("2 games and 1 patch added"), unusable files and duplicates named', () => {
  const before = { roms: [rom('E.gba', 'AAAA', 'pokemon-emerald')], patches: [] };
  const after = {
    roms: [...before.roms, rom('X.gba', 'BBBB'), rom('Y.gba', 'CCCC'), rom('E2.gba', 'AAAA', 'pokemon-emerald')],
    patches: [patch('Emerald Crest v2.bps', 'c2')],
  };
  const res = addedToLibrary(before, after, ['X.gba', 'Y.gba', 'Emerald Crest v2.bps', 'E2.gba', 'readme.zip'].map((f) => `${LIB}/${f}`));
  assert.deepEqual([res.added.length, res.already.length, res.unusable], [3, 1, 1]);
  const msg = addedMessage(res, cat);
  assert.equal(msg.title, '2 games and 1 patch added');
  assert.match(msg.text, /Emerald Crest 2 \(patch\)/);
  assert.match(msg.text, /Already in your library: Pokémon Emerald/);
  assert.match(msg.text, /1 file has no game or patch twicable can use\./);
  const none = addedToLibrary(before, before, [`${LIB}/notes.zip`]);
  assert.deepEqual([addedMessage(none, cat).kind, addedMessage(none, cat).title], ['warn', 'Nothing added']);
});

test('added: a whole folder (no file list) – only what is new since before counts', () => {
  const before = { roms: [rom('E.gba', 'AAAA', 'pokemon-emerald')], patches: [] };
  const after = { roms: [...before.roms, { ...rom('F.gba', 'DDDD'), file: '/games/F.gba', id: '/games/F.gba', title: 'POKEMON FIRE' }], patches: [] };
  const res = addedToLibrary(before, after, null);
  assert.deepEqual([res.added.length, res.already.length], [1, 0]);
  assert.equal(addedMessage(res, cat).title, 'Added: POKEMON FIRE');
});

test('every new message has a German translation (and the other languages)', () => {
  const keys = ['lib.addedOne', 'lib.addedMany', 'lib.addedGames', 'lib.addedPatches', 'lib.addedAnd', 'lib.alreadyIn', 'lib.addedAlready',
    'lib.addedUnusable', 'lib.nothingAdded', 'lib.nothingAddedText', 'lib.addedPatchName', 'lib.addedPatchHint', 'lib.addedGameHint',
    'lib.ownPatch', 'lib.ownPatchText', 'lib.patchVersion', 'lib.patchNoBase', 'lib.patchUnreadable'];
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const d = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of keys) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.doesNotMatch(d[k], /faint/i, `${lang}: ${k}`);
    }
  }
});
