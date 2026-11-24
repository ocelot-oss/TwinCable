// The 3DS audit (2.7.0): installing Azahar from its real Windows zip (backslash folder entries), a retry after a broken
// install, translated install errors, the 3DS player's screen layouts and touch mapping, and how a crashed 3DS host is
// reported (exit text, the graphics card, the end of its stderr) for "Save diagnostics".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeHostSpawn, killFakeHosts } from './fixtures/fakehosts.mjs';
import { crc32 } from '../shared/checksum.mjs';
import { extractArchive, isFolderEntry } from '../server/lib/archive.mjs';
import { CTR_LAYOUTS, ctrLayout, ctrLayoutAspect, ctrTouchAt } from '../shared/ctrlayout.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'sls-ctrplayer-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
test.afterEach(killFakeHosts); // (a test that failed half way leaves its stand-in host running)
// (a scratch data folder before the server modules read their paths: the 3DS host's save folders land there)
process.env.SLS_DATA_DIR = TMP;
const { installDownloaded, installEmulator } = await import('../server/lib/emulator.mjs');
const { exitText, redactHome, CtrSessions } = await import('../server/lib/ctr.mjs');

const le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
/** A stored zip of { name, data } entries (names exactly as given – backslashes too). */
function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data, crc = crc32(data) } of entries) {
    const n = Buffer.from(name);
    const head = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(crc), ...le(data.length), ...le(data.length), n.length, 0, 0, 0]);
    local.push(head, n, Buffer.from(data));
    central.push(Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(crc), ...le(data.length), ...le(data.length),
      n.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(offset)]), n);
    offset += head.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...local, cd, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, entries.length, 0, entries.length, 0, ...le(cd.length), ...le(offset), 0, 0])]);
}
const B = (s) => Buffer.from(s);
// the layout of azahar-windows-msvc-2126.2.zip (made with PowerShell): backslashes, the plugins folder as its FIRST entry
const AZAHAR_WIN = [
  { name: 'azahar-windows-msvc-2126.2\\plugins\\', data: B('') },
  { name: 'azahar-windows-msvc-2126.2\\azahar.exe', data: B('MZ azahar') },
  { name: 'azahar-windows-msvc-2126.2\\azahar-room.exe', data: B('MZ room') },
  { name: 'azahar-windows-msvc-2126.2\\qt.conf', data: B('[Paths]\nprefix=.') },
  { name: 'azahar-windows-msvc-2126.2\\plugins\\generic\\qtuiotouchplugin.dll', data: B('MZ touch') },
  { name: 'azahar-windows-msvc-2126.2\\plugins\\platforms\\qwindows.dll', data: B('MZ qwindows') },
];

// ---- 1: unpacking Azahar for Windows ---------------------------------------------------------------------------------
test('Azahar\'s Windows zip unpacks: a backslash folder entry is a folder, not an empty file (ENOTDIR)', () => {
  assert.ok(isFolderEntry('a\\plugins\\') && isFolderEntry('a/plugins/') && !isFolderEntry('a\\plugins\\x.dll'));
  const zip = join(TMP, 'azahar-windows-msvc-2126.2.zip');
  writeFileSync(zip, makeZip(AZAHAR_WIN));
  const out = join(TMP, 'x-azahar');
  const written = extractArchive(zip, out);
  assert.equal(written.length, 5);
  const root = join(out, 'azahar-windows-msvc-2126.2');
  assert.ok(statSync(join(root, 'plugins')).isDirectory());
  assert.equal(readFileSync(join(root, 'plugins', 'generic', 'qtuiotouchplugin.dll'), 'utf8'), 'MZ touch');
  assert.equal(readFileSync(join(root, 'azahar.exe'), 'utf8'), 'MZ azahar');
});

test('a folder stored as an empty FILE entry (no separator) gives way to the files inside it; duplicates: the last wins', () => {
  const zip = join(TMP, 'odd.zip');
  writeFileSync(zip, makeZip([
    { name: 'emu/plugins', data: B('') },
    { name: 'emu/plugins/a.dll', data: B('A') },
    { name: 'emu/readme.txt', data: B('one') },
    { name: 'emu/readme.txt', data: B('two') },
    { name: 'emu/plugins', data: B('') }, // the folder again
  ]));
  const out = join(TMP, 'x-odd');
  const written = extractArchive(zip, out);
  assert.equal(readFileSync(join(out, 'emu', 'plugins', 'a.dll'), 'utf8'), 'A');
  assert.equal(readFileSync(join(out, 'emu', 'readme.txt'), 'utf8'), 'two');
  assert.deepEqual(written.map((f) => f.slice(out.length + 1).replace(/\\/g, '/')).sort(), ['emu/plugins/a.dll', 'emu/readme.txt']);
  // a real file in the way of a folder is a broken archive – an error, never a silent overwrite
  const bad = join(TMP, 'bad-dir.zip');
  writeFileSync(bad, makeZip([{ name: 'emu/plugins', data: B('data') }, { name: 'emu/plugins/a.dll', data: B('A') }]));
  assert.throws(() => extractArchive(bad, join(TMP, 'x-bad-dir')), /EEXIST|ENOTDIR|file already exists|not a directory/i);
});

test('installing: unpacked next to the old install and swapped in – a failed try changes nothing, a retry works', async () => {
  const dir = join(TMP, 'tools', 'emulators', 'azahar');
  const zip = makeZip(AZAHAR_WIN);
  await installDownloaded('azahar', 'azahar-windows-msvc-2126.2.zip', zip, dir, { platform: 'win32' });
  const exe = join(dir, 'azahar-windows-msvc-2126.2', 'azahar.exe');
  assert.equal(readFileSync(exe, 'utf8'), 'MZ azahar');
  assert.ok(!existsSync(`${dir}.new`) && !existsSync(`${dir}.old`), 'nothing left beside it');
  assert.ok(!existsSync(join(dir, 'azahar-windows-msvc-2126.2.zip')), 'the download is removed');

  // a broken download: an error with a code the page translates, the working install untouched
  const broken = makeZip([{ name: 'azahar-windows-msvc-2126.3\\azahar.exe', data: B('MZ'), crc: 1 }]);
  await assert.rejects(installDownloaded('azahar', 'azahar-windows-msvc-2126.3.zip', broken, dir, { platform: 'win32' }),
    (e) => e.code === 'emuUnpack' && e.status === 500 && e.vars.emu === 'Azahar' && /CRC/.test(e.vars.detail));
  assert.equal(readFileSync(exe, 'utf8'), 'MZ azahar');
  assert.ok(!existsSync(`${dir}.new`));
  // a download without the emulator in it isn't installed either
  await assert.rejects(installDownloaded('azahar', 'azahar-x.zip', makeZip([{ name: 'readme.txt', data: B('hi') }]), dir, { platform: 'win32' }),
    (e) => e.code === 'emuUnpack' && /not found/.test(e.vars.detail));
  assert.equal(readFileSync(exe, 'utf8'), 'MZ azahar');

  // an earlier attempt that died half-way (the old bug): a FILE where the plugins folder must go, in the leftover
  mkdirSync(join(`${dir}.new`, 'azahar-windows-msvc-2126.2'), { recursive: true });
  writeFileSync(join(`${dir}.new`, 'azahar-windows-msvc-2126.2', 'plugins'), '');
  const newer = makeZip(AZAHAR_WIN.map((e) => (e.name.endsWith('azahar.exe') ? { ...e, data: B('MZ azahar 2') } : e)));
  await installDownloaded('azahar', 'azahar-windows-msvc-2126.2.zip', newer, dir, { platform: 'win32' });
  assert.equal(readFileSync(exe, 'utf8'), 'MZ azahar 2');
  assert.ok(statSync(join(dir, 'azahar-windows-msvc-2126.2', 'plugins', 'generic')).isDirectory());
});

test('install errors carry codes (offline, GitHub error, no build for this system) – never only German text', async () => {
  const offline = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  await assert.rejects(installEmulator('azahar', { fetchImpl: offline }), (e) => e.code === 'emuOffline' && e.vars.detail === 'ENOTFOUND');
  await assert.rejects(installEmulator('azahar', { fetchImpl: async () => ({ ok: false, status: 403 }) }), (e) => e.code === 'emuGithub' && e.vars.status === 403);
  const noAsset = async () => ({ ok: true, json: async () => ({ tag_name: '9', assets: [{ name: 'azahar-android.apk' }] }) });
  await assert.rejects(installEmulator('azahar', { fetchImpl: noAsset }), (e) => e.code === 'emuNoAsset' && !!e.vars.platform);
  let n = 0;
  const failDownload = async () => (n++ ? { ok: false, status: 502 } : {
    ok: true, json: async () => ({ tag_name: '9', assets: ['azahar-macos-universal-9.zip', 'azahar-windows-msvc-9.zip', 'azahar.AppImage'].map((name) => ({ name, browser_download_url: `https://x/${name}` })) }),
  });
  await assert.rejects(installEmulator('azahar', { fetchImpl: failDownload }), (e) => e.code === 'emuDownload' && e.vars.detail === 'HTTP 502');
  await assert.rejects(installEmulator('nope'), (e) => e.code === 'unknownEmulator');
});

test('every error code of the install / 3DS paths has a text in all five languages, with the same placeholders', () => {
  const src = readFileSync(new URL('../web/lib/errors.mjs', import.meta.url), 'utf8');
  const codes = ['emuOffline', 'emuGithub', 'emuNoAsset', 'emuDownload', 'emuUnpack', 'emuWrite', 'emuInUse', 'emuNotInstalled', 'emuLaunch', 'ctrEncrypted'];
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  const en = JSON.parse(readFileSync(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
  for (const c of codes) {
    assert.match(src, new RegExp(`\\b${c}: `), `errors.mjs knows ${c}`);
    for (const lang of ['de', 'fr', 'es', 'it']) {
      const d = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
      assert.ok(d[`err.${c}`], `${lang} err.${c}`);
      assert.equal(ph(d[`err.${c}`]), ph(en[`err.${c}`]), `${lang} err.${c} placeholders`);
    }
  }
  // the server's own install path throws coded errors only (the German text is just the fallback)
  const emu = readFileSync(new URL('../server/lib/emulator.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(emu, /throw new Error\(/);
});

// ---- 3: the 3DS player's screen layouts ------------------------------------------------------------------------------
test('3DS layouts: sizes at 1× and 2×, and the screens taken from the core\'s top-above-bottom picture', () => {
  assert.deepEqual(CTR_LAYOUTS, ['tb', 'lr', 'large', 'bt', 'top']);
  assert.equal(ctrLayoutAspect('tb'), 400 / 480);
  assert.equal(ctrLayoutAspect('lr'), 3);
  assert.equal(ctrLayoutAspect('nope'), 400 / 480);
  const lr = ctrLayout('lr', 800, 960);
  assert.equal(lr.width, 1440);
  assert.equal(lr.height, 480);
  assert.deepEqual(lr.quads.map((q) => q.src), [{ x: 0, y: 0, w: 800, h: 480 }, { x: 80, y: 480, w: 640, h: 480 }]);
  assert.deepEqual(lr.quads.map((q) => q.dst), [{ x: 0, y: 0, w: 800, h: 480 }, { x: 800, y: 0, w: 640, h: 480 }]);
  assert.equal(ctrLayout('top', 400, 480).quads.length, 1);
  const bt = ctrLayout('bt', 400, 480);
  assert.deepEqual(bt.quads.find((q) => q.screen === 'bottom').dst, { x: 40, y: 0, w: 320, h: 240 });
  // something that isn't the core's default picture is shown as it is
  assert.equal(ctrLayout('lr', 640, 480).id, 'raw');
});

test('3DS touch: a click on the bottom screen reaches the core at the right spot in every layout', () => {
  // the bottom screen's centre is (200, 360) in the core's 400×480 picture → 0.5, 0.75
  const centre = { tb: [0.5, 0.75], bt: [0.5, 0.25], lr: [560 / 720, 0.5], large: [480 / 560, 0.75] };
  for (const [id, [fx, fy]] of Object.entries(centre)) {
    for (const k of [1, 3]) {
      const at = ctrTouchAt(ctrLayout(id, 400 * k, 480 * k), fx, fy);
      assert.ok(Math.abs(at.x - 0.5) < 1e-6 && Math.abs(at.y - 0.75) < 1e-6, `${id} ${k}×: ${JSON.stringify(at)}`);
    }
  }
  // the bottom screen's top-left corner in side by side → (40, 240)
  const corner = ctrTouchAt(ctrLayout('lr', 400, 480), 400 / 720, 0);
  assert.ok(Math.abs(corner.x - 0.1) < 1e-9 && Math.abs(corner.y - 0.5) < 1e-9);
  // a click on the top screen isn't a touch; a drag past the edge stays on it
  assert.equal(ctrTouchAt(ctrLayout('lr', 400, 480), 0.2, 0.5), null);
  assert.equal(ctrTouchAt(ctrLayout('tb', 400, 480), 0.5, 0.2), null);
  assert.deepEqual(ctrTouchAt(ctrLayout('lr', 400, 480), 0.2, 0.5, { clamp: true }), { x: 0.1, y: 0.75 });
  assert.equal(ctrTouchAt(ctrLayout('top', 400, 480), 0.5, 0.5), null);
  assert.equal(ctrTouchAt(ctrLayout('tb', 400, 480), NaN, 0.5), null);
});

// ---- 2: a crashed 3DS host is visible ----------------------------------------------------------------------------------
test('how a host ended, readable: Windows exception codes, signals, plain exit codes; the home folder shortened', () => {
  assert.equal(exitText({ code: 3221225477, signal: null }), 'exit code 0xC0000005 (access violation)');
  assert.equal(exitText({ code: -1073741819, signal: null }), 'exit code 0xC0000005 (access violation)');
  assert.equal(exitText({ code: null, signal: 'SIGSEGV' }), 'signal SIGSEGV');
  assert.equal(exitText({ code: 1, signal: null }), 'exit code 1');
  assert.equal(exitText({ error: 'spawn EACCES' }), 'spawn EACCES');
  assert.equal(exitText(null), '');
  assert.equal(redactHome('C:\\Users\\Jürgen\\AppData\\x', 'C:\\Users\\Jürgen'), '~\\AppData\\x');
  assert.equal(redactHome(JSON.stringify({ p: 'C:\\Users\\Jürgen\\a' }), 'C:\\Users\\Jürgen'), '{"p":"~\\\\a"}');
  assert.equal(redactHome('/home/ana/x', '/home/ana'), '~/x');
});

const FAKE = `
const ev = (o) => { const p = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(8); h.writeUInt32LE(7, 0); h.writeUInt32LE(p.length, 4); process.stdout.write(Buffer.concat([h, p])); };
const mode = process.argv[process.argv.indexOf('--rom') + 1];
ev({ event: 'gpu', name: 'AMD Radeon RX 9070 XT', type: 'discrete', vendor: '1002', device: '7550', driver: '2.0.341 AMD proprietary driver 25.10.2', api: '1.4.315', index: 0, count: 2 });
process.stderr.write('Vulkan: using device 0 of 2 – AMD Radeon RX 9070 XT\\nctrhost: crashed: access violation 0xC0000005 in amdvlk64.dll+0x1234 while starting the renderer\\n');
setTimeout(() => { if (mode === 'crash') process.exit(5); if (mode === 'die') { ev({ event: 'error', message: 'the core couldn\\'t create its Vulkan device' }); setTimeout(() => process.exit(1), 50); } }, 100);
process.stdin.on('data', (d) => d.readUInt32LE(0) === 6 && process.exit(0));
process.stdin.on('end', () => process.exit(0));
`;
const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; !fn();) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('a 3DS host that crashes: its graphics card, exit and last stderr stay for diagnostics; a normal stop does not', async () => {
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const ctr = new CtrSessions({ spawn: fakeHostSpawn(FAKE) });
    ctr.logFile = join(TMP, 'logs', 'players.log');
    const tools = { host: 'ctrhost', core: 'core', vulkan: 'vk' };
    ctr.start({ rom: 'crash', key: 'k-crash', tools });
    const s = ctr.current;
    await until(() => ctr.last);
    assert.equal(ctr.last.exit, 'exit code 5');
    assert.equal(ctr.last.gpu.name, 'AMD Radeon RX 9070 XT');
    assert.match(ctr.last.stderr, /amdvlk64\.dll/);
    assert.match(ctr.last.stderrStart, /using device 0 of 2/);
    // also in the players' log file, which outlives a restart of twincable
    assert.equal(ctr.diagnostics().log.at(-1).gpu.name, 'AMD Radeon RX 9070 XT');
    assert.equal(ctr.status().gpu.driver, '2.0.341 AMD proprietary driver 25.10.2');
    assert.ok(warned.some((w) => /the host ended: exit code 5 – GPU AMD Radeon RX 9070 XT/.test(w)), warned.join('\n'));
    assert.equal(s.exit.code, 5);
    // the host's own error message
    ctr.start({ rom: 'die', key: 'k-die', tools });
    await until(() => ctr.last?.error);
    assert.equal(ctr.last.exit, 'exit code 1');
    assert.match(ctr.last.error, /Vulkan device/);
    // twincable stops a game: nothing to report – the last failure stays
    const before = ctr.last;
    ctr.start({ rom: 'ok', key: 'k-ok', tools });
    const ok = ctr.current;
    await until(() => ok.gpu);
    ctr.stop();
    await until(() => ok.recorded);
    assert.equal(ctr.last, before);
    assert.equal(ctr.diagnostics().last, before);
  } finally {
    console.warn = warn;
  }
});
