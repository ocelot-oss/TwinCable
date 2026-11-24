// A randomizer build that stops at a file (Discord, Alpha Sapphire on a MacBook: "Randomizer error: RandomizerIOException"
// – the same file randomized on a friend's Windows laptop). UPR ZX wraps every IOException in its RandomizerIOException;
// the page said "its data isn't where the randomizer expects it, as in some ROM hacks" and named only that class, and the
// diagnostics kept the outer message ("Error when building romfs: File: a/0/8/2 …") – the system's reason behind it ("No
// space left on device", "Permission denied", "Input/output error") was in none of them. Now the answer names the
// system's words, which file (the game, the new game in the run folder, the working files) and what helps; the
// diagnostics get the cause, which file, reading or writing, and the free space then.
//
// The stack traces below are the bundled Temurin 17 + UPR ZX 4.6.1 on macOS (Apple Silicon), Pokémon Sun rebuilt by the
// bridge exactly as the app runs it: the run folder on a full disk image, the run folder not writable, the drive with
// the game detached during the rebuild. Only the folders are made up (with spaces, as players' folders have).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-randoio-'));
process.env.SLS_DATA_DIR = DATA;
const { randomizerError, ioFailure, javaExceptions, randomizerTrace, runBridge, detectJava, UPR_JAR } = await import('../server/lib/toolchain.mjs');
const { ctrRandoError } = await import('../server/lib/ctrrando.mjs');
const { errorBody } = await import('../server/app.mjs');
const { serverErrorText } = await import('../web/lib/errors.mjs');
const { IS_MAC } = await import('../web/lib/platform.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const HOME = '/Users/anna maria';
const FILES = {
  game: `${HOME}/Downloads/Pokemon Alpha Sapphire (USA).3ds`,
  output: `${HOME}/Library/Application Support/SoulLink Studio/runs/1a2b3c4d/Anna - Alpha Sapphire Randomized.cxi`,
  work: `${HOME}/Library/Application Support/SoulLink Studio/cache/upr-3ds/0123456789ab`,
};
const OUTER = (msg, line) => `com.dabomstew.pkrandom.exceptions.RandomizerIOException: ${msg}
\tat com.dabomstew.pkrandom.ctr.NCCH.rebuildRomfs(NCCH.java:${line})
\tat com.dabomstew.pkrandom.ctr.NCCH.saveAsNCCH(NCCH.java:316)
\tat com.dabomstew.pkrandom.romhandlers.Abstract3DSRomHandler.saveRomFile(Abstract3DSRomHandler.java:90)
\tat com.dabomstew.pkrandom.Randomizer.randomize(Randomizer.java:680)
\tat SoulLinkBridge.randomize(SoulLinkBridge.java:404)
\tat SoulLinkBridge.main(SoulLinkBridge.java:81)
`;
/** What runBridge rejects with (server/lib/toolchain.mjs): the @@ERROR text, the stack trace, the call's files. */
const failure = (error, stderr, files = FILES) => Object.assign(new Error(`Randomizer error: ${error}`), {
  details: { error, exitCode: 1, stdout: `@@ERROR ${JSON.stringify(error)}`, stderr, files },
});

// the run folder's disk ran full while UPR wrote the new game
const NO_SPACE = failure('com.dabomstew.pkrandom.exceptions.RandomizerIOException: Error when building romfs: File: a/0/8/2, offset: 10824, size: 348976124',
  `${OUTER('Error when building romfs: File: a/0/8/2, offset: 10824, size: 348976124', 491)}Caused by: java.io.IOException: No space left on device
\tat java.base/java.io.RandomAccessFile.writeBytes(Native Method)
\tat java.base/java.io.RandomAccessFile.write(Unknown Source)
\tat com.dabomstew.pkrandom.ctr.NCCH.rebuildRomfs(NCCH.java:486)
\t... 5 more
`);
// the run folder isn't writable
const DENIED_PATH = `${FILES.output} (Permission denied)`;
const DENIED = failure(`com.dabomstew.pkrandom.exceptions.RandomizerIOException: java.io.FileNotFoundException: ${DENIED_PATH}`,
  `com.dabomstew.pkrandom.exceptions.RandomizerIOException: java.io.FileNotFoundException: ${DENIED_PATH}
\tat com.dabomstew.pkrandom.romhandlers.Abstract3DSRomHandler.saveRomFile(Abstract3DSRomHandler.java:95)
\tat com.dabomstew.pkrandom.Randomizer.randomize(Randomizer.java:680)
\tat SoulLinkBridge.randomize(SoulLinkBridge.java:404)
\tat SoulLinkBridge.main(SoulLinkBridge.java:81)
Caused by: java.io.FileNotFoundException: ${DENIED_PATH}
\tat java.base/java.io.RandomAccessFile.open0(Native Method)
\tat java.base/java.io.RandomAccessFile.open(Unknown Source)
\tat java.base/java.io.RandomAccessFile.<init>(Unknown Source)
\tat java.base/java.io.RandomAccessFile.<init>(Unknown Source)
\tat java.base/java.io.RandomAccessFile.<init>(Unknown Source)
\tat com.dabomstew.pkrandom.ctr.NCCH.saveAsNCCH(NCCH.java:254)
\tat com.dabomstew.pkrandom.romhandlers.Abstract3DSRomHandler.saveRomFile(Abstract3DSRomHandler.java:90)
\t... 3 more
`);
// the drive with the game went away while UPR read it for the rebuild
const UNPLUGGED = failure('com.dabomstew.pkrandom.exceptions.RandomizerIOException: Error when building romfs: File: a/0/4/4, offset: 9456, size: 1583648',
  `${OUTER('Error when building romfs: File: a/0/4/4, offset: 9456, size: 1583648', 491)}Caused by: java.io.IOException: Input/output error
\tat java.base/java.io.RandomAccessFile.readBytes(Native Method)
\tat java.base/java.io.RandomAccessFile.read(Unknown Source)
\tat java.base/java.io.RandomAccessFile.readFully(Unknown Source)
\tat java.base/java.io.RandomAccessFile.readFully(Unknown Source)
\tat com.dabomstew.pkrandom.ctr.NCCH.rebuildRomfs(NCCH.java:482)
\t... 5 more
`);
const statfs = (gb) => () => ({ bavail: BigInt(Math.round(gb * 1024 ** 3 / 4096)), bsize: 4096n });
const PRIVATE = ['anna', 'maria', 'Downloads', 'Library', 'Application Support', '1a2b3c4d', 'Alpha Sapphire Randomized'];
const noPrivate = (s, label) => {
  for (const p of PRIVATE) assert.ok(!String(s).includes(p), `${label}: "${p}" in ${s}`);
};

test('a full disk: "No space left on device", the new game, writing – and the free space then', () => {
  const e = ctrRandoError(NO_SPACE, { statfs: statfs(1.2) });
  assert.equal(e.status, 507);
  assert.equal(e.code, 'randoNoSpace');
  assert.deepEqual([e.vars.what, e.vars.where, e.vars.op], ['No space left on device', 'output', 'write']);
  // the diagnostics: where UPR was, and the cause behind "Error when building romfs" – with Java's own frames (writing)
  assert.deepEqual(e.vars.trace.slice(-4), ['Caused by: java.io.IOException: No space left on device', 'RandomAccessFile.writeBytes', 'RandomAccessFile.write', 'NCCH.rebuildRomfs:486']);
  assert.equal(e.vars.trace[1], 'NCCH.rebuildRomfs:491');
  assert.ok(e.details, 'the bridge\'s output stays on the error for the server log');
  const shown = serverErrorText(errorBody(e), e.status);
  assert.match(shown, /disk ran full/);
  assert.match(shown, /No space left on device/);
  assert.match(shown, /the new game in the run folder/);
  assert.doesNotMatch(shown, /ROM hacks|RandomizerIOException/);
});

test('a folder twicable may not write to: "Permission denied", which file – never its path', () => {
  const e = randomizerError(DENIED, { statfs: statfs(80) });
  assert.equal(e.status, 403);
  assert.equal(e.code, 'randoNoAccess');
  assert.deepEqual([e.vars.what, e.vars.where, e.vars.op, e.vars.free], ['Permission denied', 'output', 'write', '80.0']);
  const body = errorBody(e);
  noPrivate(JSON.stringify(body), 'answer');
  const shown = serverErrorText(body, e.status);
  assert.match(shown, /isn’t allowed to use the new game in the run folder \(Permission denied\)/);
  // (the hint for the computer the page runs on – web/lib/platform.mjs)
  assert.match(shown, IS_MAC ? /Privacy & Security › Files and Folders/ : /Controlled folder access/);
  assert.ok(e.vars.trace.includes('Caused by: java.io.FileNotFoundException: … (Permission denied)'), e.vars.trace.join('\n'));
});

test('a game file that can\'t be read to the end (a drive unplugged, iCloud, a damaged copy): what to do with the game file', () => {
  const e = randomizerError(UNPLUGGED, { statfs: statfs(40) });
  assert.equal(e.code, 'randoReadFailed');
  assert.deepEqual([e.vars.what, e.vars.where, e.vars.op], ['Input/output error', 'game', 'read']);
  const shown = serverErrorText(errorBody(e), e.status);
  assert.match(shown, /couldn’t be read completely \(Input\/output error\)/);
  assert.match(shown, /external drive.*iCloud Drive/);
  // the game file named by its path in the message (it was moved away, or its drive is gone)
  const gone = ioFailure({ error: `java.io.FileNotFoundException: ${FILES.game} (No such file or directory)`, stderr: '', files: FILES });
  assert.deepEqual(gone, { code: 'randoReadFailed', error: 'No such file or directory', where: 'game', op: 'read' });
  // a file that ends early
  const eof = ioFailure({ stderr: `${OUTER('Error when building romfs: File: a/0/1/2, offset: 1, size: 2', 491)}Caused by: java.io.EOFException\n\tat java.base/java.io.RandomAccessFile.readFully(Unknown Source)\n\tat com.dabomstew.pkrandom.ctr.NCCH.rebuildRomfs(NCCH.java:482)\n`, files: FILES });
  assert.deepEqual(eof, { code: 'randoReadFailed', error: 'EOFException', where: 'game', op: 'read' });
});

test('which file it was: the working files, the run folder\'s log, Windows\' "Access is denied", the system\'s words in German', () => {
  // UPR's unpacked game file gone from its working folder (RomfsFile reads it back while rebuilding)
  const work = `${FILES.work}/tmp_PokemonAlphaSapphireUSA/a012`;
  const tmp = ioFailure({ stderr: `${OUTER('Error when building romfs: File: a/0/1/2, offset: 1, size: 2', 491)}Caused by: java.io.FileNotFoundException: ${work}
\tat com.dabomstew.pkrandom.FileFunctions.readFileFullyIntoBuffer(FileFunctions.java:153)
\tat com.dabomstew.pkrandom.ctr.RomfsFile.getContents(RomfsFile.java:81)
\tat com.dabomstew.pkrandom.ctr.RomfsFile.getOverrideContents(RomfsFile.java:117)
\tat com.dabomstew.pkrandom.ctr.NCCH.rebuildRomfs(NCCH.java:477)
`, files: FILES });
  assert.deepEqual(tmp, { code: 'randoIoFailed', error: 'FileNotFoundException', where: 'work', op: 'read' });
  // a full disk while UPR unpacks a game file (no path in the message: the frames tell)
  const unpack = ioFailure({ stderr: `com.dabomstew.pkrandom.exceptions.RandomizerIOException: java.io.IOException: No space left on device
\tat com.dabomstew.pkrandom.romhandlers.Gen6RomHandler.loadedROM(Gen6RomHandler.java:307)
Caused by: java.io.IOException: No space left on device
\tat java.base/java.io.FileOutputStream.writeBytes(Native Method)
\tat java.base/java.io.FileOutputStream.write(Unknown Source)
\tat com.dabomstew.pkrandom.ctr.RomfsFile.getContents(RomfsFile.java:62)
`, files: FILES });
  assert.deepEqual(unpack, { code: 'randoNoSpace', error: 'No space left on device', where: 'work', op: 'write' });
  // the bridge's spoiler log in the run folder
  const log = ioFailure({ error: `java.io.FileNotFoundException: ${HOME}/Library/Application Support/SoulLink Studio/runs/1a2b3c4d/Anna - Spoiler-Log.txt (Operation not permitted)`, files: FILES });
  assert.deepEqual([log.code, log.where, log.error], ['randoNoAccess', 'output', 'Operation not permitted']);
  // UPR on Windows turns "Access is denied" on the output into its CannotWriteToLocationException
  const win = randomizerError(failure('com.dabomstew.pkrandom.exceptions.CannotWriteToLocationException: The randomizer cannot write to this location: C:\\Users\\Max Mustermann\\AppData\\Roaming\\SoulLink Studio\\runs\\1a2b3c4d\\Max - X Randomized.cxi',
    'com.dabomstew.pkrandom.exceptions.CannotWriteToLocationException: The randomizer cannot write to this location: C:\\Users\\Max Mustermann\\AppData\\Roaming\\SoulLink Studio\\runs\\1a2b3c4d\\Max - X Randomized.cxi\n\tat com.dabomstew.pkrandom.romhandlers.Abstract3DSRomHandler.saveRomFile(Abstract3DSRomHandler.java:93)\n',
    { game: 'C:\\Games\\X.3ds', output: 'C:\\Users\\Max Mustermann\\AppData\\Roaming\\SoulLink Studio\\runs\\1a2b3c4d\\Max - X Randomized.cxi', work: 'C:\\w' }), { statfs: () => { throw new Error('no'); } });
  assert.deepEqual([win.code, win.vars.what, win.vars.where, win.vars.free], ['randoNoAccess', 'Access is denied', 'output', undefined]);
  assert.ok(!JSON.stringify(errorBody(win)).includes('Mustermann'));
  // Windows writes the system's reason in its own language
  assert.equal(ioFailure({ error: 'com.dabomstew.pkrandom.exceptions.RandomizerIOException: java.io.IOException: Auf dem Datenträger ist nicht genügend Speicherplatz vorhanden' }).code, 'randoNoSpace');
});

test('no file error: data UPR choked on stays "randoFailed", also when UPR wrapped it in its RandomizerIOException', () => {
  const broken = failure('com.dabomstew.pkrandom.exceptions.RandomizerIOException: Error when building romfs: File: a/0/1/2, offset: 1, size: -4',
    `${OUTER('Error when building romfs: File: a/0/1/2, offset: 1, size: -4', 491)}Caused by: java.lang.NegativeArraySizeException: -4\n\tat com.dabomstew.pkrandom.ctr.NCCH.rebuildRomfs(NCCH.java:480)\n`);
  assert.equal(ioFailure(broken.details), null);
  const e = randomizerError(broken);
  assert.equal(e.code, 'randoFailed');
  assert.equal(e.vars.what, 'RandomizerIOException');
  assert.ok(e.vars.trace.includes('Caused by: java.lang.NegativeArraySizeException: -4'), 'the diagnostics still get the cause');
  const aioobe = failure('java.lang.ArrayIndexOutOfBoundsException: Index 1286 out of bounds for length 1268', 'java.lang.ArrayIndexOutOfBoundsException: Index 1286 out of bounds for length 1268\n\tat com.dabomstew.pkrandom.romhandlers.Gen5RomHandler.setStarters(Gen5RomHandler.java:1)\n');
  assert.equal(randomizerError(aioobe).code, 'randoFailed');
  assert.deepEqual(randomizerError(aioobe).vars.trace, ['java.lang.ArrayIndexOutOfBoundsException: Index 1286 out of bounds for length 1268', 'Gen5RomHandler.setStarters:1']);
});

test('the exception chain: from the stack trace, from the @@ERROR text alone, and a cause carried as the message', () => {
  assert.deepEqual(javaExceptions(NO_SPACE.details).map((x) => [x.cls, x.message]), [
    ['com.dabomstew.pkrandom.exceptions.RandomizerIOException', 'Error when building romfs: File: a/0/8/2, offset: 10824, size: 348976124'],
    ['java.io.IOException', 'No space left on device'],
  ]);
  assert.deepEqual(javaExceptions({ error: 'com.dabomstew.pkrandom.exceptions.RandomizerIOException: java.io.IOException: Input/output error' }).map((x) => x.cls),
    ['com.dabomstew.pkrandom.exceptions.RandomizerIOException', 'java.io.IOException']);
  // one exception line without "Caused by:" whose message is its cause (new RandomizerIOException(e))
  const one = javaExceptions({ stderr: 'com.dabomstew.pkrandom.exceptions.RandomizerIOException: java.io.FileNotFoundException: /x/a002\n\tat a.B.c(B.java:1)\n' });
  assert.deepEqual(one.map((x) => [x.cls, x.message]), [['com.dabomstew.pkrandom.exceptions.RandomizerIOException', 'java.io.FileNotFoundException: /x/a002'], ['java.io.FileNotFoundException', '/x/a002']]);
  // (and no "Caused by:" line made up for the diagnostics from it)
  assert.deepEqual(randomizerTrace({ stderr: 'com.dabomstew.pkrandom.exceptions.RandomizerIOException: java.io.FileNotFoundException: /x/a002\n\tat a.B.c(B.java:1)\n' }),
    ['com.dabomstew.pkrandom.exceptions.RandomizerIOException: java.io.FileNotFoundException: …', 'B.c:1']);
  assert.deepEqual(javaExceptions({}), []);
});

test('runBridge hands the files of a failed call to the error (they stay on the server)', async (t) => {
  if (!detectJava().ok || !existsSync(UPR_JAR)) return t.skip('Java or the randomizer missing');
  const { EventEmitter } = await import('node:events');
  let c;
  const child = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  const output = join(DATA, 'Anna - Alpha Sapphire Randomized.cxi'); // (a folder that exists: its drive's free space)
  const run = runBridge(['randomize', FILES.game, output, '/p', '1', '/l', '/d'], { ctr: true, spawnFn: () => (c = child()), removeDir: async () => {} });
  c.stdout.emit('data', `@@ERROR ${JSON.stringify(NO_SPACE.details.error)}\n`);
  c.stderr.emit('data', NO_SPACE.details.stderr);
  c.emit('close', 1);
  const err = await run.catch((e) => e);
  assert.equal(err.details.files.game, FILES.game);
  assert.equal(err.details.files.output, output);
  assert.match(err.details.files.work, /upr-3ds/);
  const e = ctrRandoError(err);
  assert.deepEqual([e.code, e.vars.where], ['randoNoSpace', 'output']);
  assert.equal(typeof e.vars.free, 'string', 'the free space of the run folder\'s drive (the real one here)');
  // `info` writes nothing: no output file
  const info = runBridge(['info', FILES.game], { ctr: true, spawnFn: () => (c = child()), removeDir: async () => {} });
  c.stdout.emit('data', '@@ERROR "java.lang.RuntimeException: x"\n');
  c.emit('close', 1);
  assert.equal((await info.catch((x) => x)).details.files.output, null);
});

test('a 3DS build that stops at a full disk: the readable answer, no half-written game left – the free space taken first', async () => {
  const { buildRun } = await import('../server/lib/build.mjs');
  const { buildValues, PRESETS } = await import('../shared/randomizer-options.mjs');
  const { cci } = await import('./fixtures/ctr.mjs');
  mkdirSync(join(DATA, 'Library'), { recursive: true });
  const rom = join(DATA, 'Library', 'Pokemon X.3ds');
  writeFileSync(rom, cci({ productCode: 'CTR-P-EKJA', titleId: '0004000000055D00' }));
  let out = null;
  const bridge = async (args) => {
    out = args[2];
    writeFileSync(out, 'half a game'); // (UPR had started writing)
    throw failure(NO_SPACE.details.error, NO_SPACE.details.stderr, { game: args[1], output: args[2], work: join(DATA, 'cache', 'upr-3ds', 'x') });
  };
  await assert.rejects(buildRun({ romId: rom, gameId: 'pokemon-x', randomize: true, values: buildValues(PRESETS[0].values, 6), seeds: { p1: '9' }, mode: 'nuzlocke',
    players: { p1: { name: 'Anna' } }, config: {}, identity: { id: 'abcdef34', room: 'r-r-r', secret: 'secretsecret' } }, () => {}, () => {}, { bridge }),
  (e) => e.code === 'randoNoSpace' && e.status === 507 && e.vars.where === 'output' && typeof e.vars.free === 'string');
  assert.ok(out && !existsSync(out), 'the half-written game is gone');
  // the free space is read while the half-written game is still there (what the disk had when the build stopped)
  const src = readFileSync(new URL('../server/lib/build.mjs', import.meta.url), 'utf8');
  assert.match(src, /const err = ctrRandoError\(e\);[^\n]*\n\s*rmSync\(romOut, \{ force: true \}\);[^\n]*\n\s*throw err;/);
});

test('the new messages are in every language, with the same placeholders; the diagnostics keep which file and the free space', () => {
  const en = JSON.parse(readFileSync(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
  const keys = ['err.randoNoSpace', 'err.randoNoAccess', 'err.randoNoAccessMac', 'err.randoReadFailed', 'err.randoIoFailed', 'err.randoFile.game', 'err.randoFile.output', 'err.randoFile.work', 'err.randoFile.other'];
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const d = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of keys) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.doesNotMatch(d[k], /faint/i, `${lang}: ${k}`);
      assert.deepEqual((d[k].match(/\{\w+\}/g) || []).sort(), (en[k].match(/\{\w+\}/g) || []).sort(), `${lang}: ${k}`);
    }
  }
  const api = readFileSync(new URL('../web/lib/api.mjs', import.meta.url), 'utf8');
  assert.match(api, /where: data\.vars\.where, op: data\.vars\.op \?\? null, free: data\.vars\.free \?\? null/);
});
