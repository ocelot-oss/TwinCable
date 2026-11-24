// The built-in 3DS player's renderer (server/lib/ctrrenderer.mjs, native/ctr-host --renderer): the choice, what
// "auto" remembers per graphics card, when a host's end counts as a renderer failure, and the step down to the next
// safer renderer inside the same session (CtrSessions.relaunch) – the page's stream goes on, no "stopped" error, the
// memory it watches handed to the new host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fakeHostSpawn, killFakeHosts } from './fixtures/fakehosts.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'sls-ctrrenderer-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
test.afterEach(killFakeHosts); // (a test that failed half way leaves its stand-in host running)
process.env.SLS_DATA_DIR = TMP;
const R = await import('../server/lib/ctrrenderer.mjs');
const { CtrSessions, MSG, CMD, command, splitMessages } = await import('../server/lib/ctr.mjs');

const AMD = { name: 'AMD Radeon RX 9070 XT', vendor: '1002', device: '7550', driver: '2.0.416 AMD proprietary driver 26.11.1 (LLPC)' };

test('the setting: auto picks Vulkan, or what was learned for the last graphics card; a fixed choice stays fixed', () => {
  assert.deepEqual(R.pickRenderer({}), { mode: 'vulkan', auto: true });
  assert.deepEqual(R.pickRenderer({ setting: 'nonsense' }), { mode: 'vulkan', auto: true });
  const key = R.gpuKey(AMD);
  assert.equal(key, '1002:7550|2.0.416 AMD proprietary driver 26.11.1 (LLPC)');
  assert.equal(R.gpuKey(null), '?');
  const memo = R.remember({}, key, 'compat');
  assert.deepEqual(R.pickRenderer({ setting: 'auto', memo, lastGpu: key }), { mode: 'compat', auto: true });
  // a driver update: a new key – Vulkan again
  assert.deepEqual(R.pickRenderer({ setting: 'auto', memo, lastGpu: R.gpuKey({ ...AMD, driver: '2.0.420' }) }), { mode: 'vulkan', auto: true });
  // junk in the config is ignored
  assert.deepEqual(R.pickRenderer({ setting: 'auto', memo: { [key]: 'opengl' }, lastGpu: key }), { mode: 'vulkan', auto: true });
  for (const m of ['vulkan', 'compat', 'software']) assert.deepEqual(R.pickRenderer({ setting: m, memo, lastGpu: key }), { mode: m, auto: false });
  assert.equal(R.validRenderer('software'), 'software');
  assert.equal(R.validRenderer(undefined), 'auto');
});

test('the fallback order, and the memory keeps the newest cards only', () => {
  assert.equal(R.nextRenderer('vulkan'), 'compat');
  assert.equal(R.nextRenderer('compat'), 'software');
  assert.equal(R.nextRenderer('software'), null);
  let memo = {};
  for (let i = 0; i < 20; i++) memo = R.remember(memo, `card${i}`, 'compat');
  assert.equal(Object.keys(memo).length, 16);
  assert.ok(!('card0' in memo) && memo.card19 === 'compat');
  memo = R.remember(memo, 'card5', 'software');
  assert.equal(Object.keys(memo).at(-1), 'card5');
  assert.equal(memo.card5, 'software');
  assert.deepEqual(R.remember(null, 'x', 'compat'), { x: 'compat' });
});

test('which ends count as "this renderer can\'t run here": early crashes and Vulkan errors – not the game file, not later, not a stop', () => {
  const crash = { event: 'error', crash: true, message: 'crashed: access violation 0xC0000005 in amdvlk64.dll+0x2e52fc4 while running the first frames' };
  assert.equal(R.rendererFailure({ exit: { code: 3221225477 }, events: [crash], ms: 480 }), true);
  assert.equal(R.rendererFailure({ exit: { code: 3221225477 }, events: [], ms: 480 }), true); // no report at all
  assert.equal(R.rendererFailure({ exit: { code: null, signal: 'SIGSEGV' }, ms: 2000 }), true);
  assert.equal(R.rendererFailure({ exit: { code: 1 }, events: [{ event: 'error', message: 'the graphics driver stopped the game\'s GPU work (VK_ERROR_DEVICE_LOST)' }], ms: 5000 }), true);
  assert.equal(R.rendererFailure({ exit: { code: 1 }, events: [{ event: 'error', message: 'Vulkan library not loadable: LoadLibrary failed (error 126)' }], ms: 100 }), true);
  // not the renderer's fault
  assert.equal(R.rendererFailure({ exit: { code: 1 }, events: [{ event: 'error', message: 'the core couldn\'t load the game' }], ms: 300 }), false);
  assert.equal(R.rendererFailure({ exit: { code: 1 }, events: [{ event: 'error', message: 'core not loadable: dlopen failed' }], ms: 300 }), false);
  assert.equal(R.rendererFailure({ exit: { error: 'spawn ENOENT' }, ms: 10 }), false);
  assert.equal(R.rendererFailure({ exit: { code: 0 }, events: [], ms: 1000 }), false);
  // after the first seconds, or stopped by twincable
  assert.equal(R.rendererFailure({ exit: { code: 3221225477 }, events: [crash], ms: R.RETRY_WINDOW_MS + 1 }), false);
  assert.equal(R.rendererFailure({ exit: { code: 3221225477 }, events: [crash], ms: 100, quit: true }), false);
});

test('3DS resolution (#59): 1×–3× or 1×; the Software renderer always 1×; --scale replaced or added', () => {
  assert.deepEqual([1, 2, 3, 4, 0, '2', null, undefined, 2.5].map(R.validScale), [1, 2, 3, 1, 1, 1, 1, 1, 1]);
  assert.equal(R.scaleFor(3, 'vulkan'), 3);
  assert.equal(R.scaleFor(2, 'compat'), 2);
  assert.equal(R.scaleFor(3, 'software'), 1);
  assert.equal(R.scaleFor(9, 'vulkan'), 1);
  assert.deepEqual(R.withArg(['--scale', '3', '--renderer', 'compat'], '--scale', 1), ['--scale', '1', '--renderer', 'compat']);
  assert.deepEqual(R.withArg(['--rom', 'x'], '--scale', 2), ['--rom', 'x', '--scale', '2']);
});

test('the host\'s arguments get the renderer (replaced, or added)', () => {
  assert.deepEqual(R.withRenderer(['--rom', 'x', '--renderer', 'vulkan'], 'compat'), ['--rom', 'x', '--renderer', 'compat']);
  assert.deepEqual(R.withRenderer(['--rom', 'x'], 'software'), ['--rom', 'x', '--renderer', 'software']);
});

// A stand-in host: with --renderer vulkan it crashes the way the RX 9070 XT did (gpu event, crash event, NTSTATUS
// exit) – with any other renderer it runs, and reports each command it gets as a LOG message.
const FAKE = `
const send = (type, o) => { const p = Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)); const h = Buffer.alloc(8); h.writeUInt32LE(type, 0); h.writeUInt32LE(p.length, 4); process.stdout.write(Buffer.concat([h, p])); };
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const renderer = arg('--renderer');
const fail = (process.env.FAKE_FAIL || 'vulkan').split(',');
if (renderer !== 'software') send(7, { event: 'gpu', name: 'AMD Radeon RX 9070 XT', type: 'discrete', vendor: '1002', device: '7550', driver: '2.0.416 AMD proprietary driver 26.11.1 (LLPC)', api: '1.4.359', index: 0, count: 1, renderer });
if (fail.includes(renderer)) {
  setTimeout(() => {
    process.stderr.write('ctrhost: crashed: access violation 0xC0000005 in amdvlk64.dll+0x2e52fc4 while running the first frames\\n');
    send(7, { event: 'error', crash: true, message: 'crashed: access violation 0xC0000005 in amdvlk64.dll+0x2e52fc4 while running the first frames' });
    setTimeout(() => process.exit(3), 30);
  }, Number(process.env.FAKE_DELAY || 0));
} else {
  send(7, { event: 'loaded', width: 400, height: 480, fps: 60, sampleRate: 32728, maps: 2, memory: true, renderer });
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8 && buf.length >= 8 + buf.readUInt32LE(4)) {
      const type = buf.readUInt32LE(0);
      send(6, 'cmd ' + type + ' ' + renderer);
      if (type === 6) process.exit(0);
      buf = buf.subarray(8 + buf.readUInt32LE(4));
    }
  });
}
process.stdin.on('end', () => process.exit(0));
`;
const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; !fn();) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
/** A page's stream: what the server writes, as messages. */
function page() {
  const res = new PassThrough();
  res.writeHead = () => {};
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  return {
    res,
    messages: () => splitMessages(Buffer.concat(chunks)).messages.map((m) => ({ type: m.type, text: m.payload.toString('utf8') })),
  };
}
const quietly = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
};
const sessions = (env = {}) => {
  const ctr = new CtrSessions({ spawn: fakeHostSpawn(FAKE, env) });
  ctr.logFile = join(TMP, 'logs', 'players.log');
  return ctr;
};
const tools = { host: 'ctrhost', core: 'core', vulkan: 'vk' };

test('auto: a crash in the first frames with Vulkan starts the same session again in compat – no error on the page, memory handed over', async () => {
  await quietly(async () => {
    const ctr = sessions({ FAKE_DELAY: '300' });
    const failed = [];
    ctr.onRendererFailed = (x) => failed.push(x);
    const id = ctr.start({ rom: 'r', key: 'k-auto', tools, renderer: 'vulkan', auto: true });
    const p = page();
    ctr.attach(id, p.res);
    // the page asks for memory and pauses while the first host still runs – the new one must get both without the
    // page sending them again (it only sends a WATCH when the region list changes)
    const watch = Buffer.alloc(12);
    watch.writeUInt32LE(1, 0);
    watch.writeUInt32LE(0x30000000, 4);
    watch.writeUInt32LE(64, 8);
    ctr.send(id, Buffer.concat([command(CMD.WATCH, watch), command(CMD.SPEED, Buffer.from(new Float32Array([0]).buffer))]));
    // (both, in whatever order the handover writes them: waiting for one and checking the other at once failed on a
    // busy Windows runner)
    const got = (t) => p.messages().some((m) => m.type === MSG.LOG && m.text === t);
    await until(() => got('cmd 2 compat') && got('cmd 5 compat'));
    const msgs = p.messages();
    assert.ok(!msgs.some((m) => m.type === MSG.EVENT && /"error"/.test(m.text)), 'the crash of the first try never reaches the page');
    assert.ok(msgs.some((m) => m.type === MSG.EVENT && /"renderer":"compat"/.test(m.text) && /"loaded"/.test(m.text)));
    assert.deepEqual(failed.map((f) => [f.from, f.to, f.gpu?.vendor]), [['vulkan', 'compat', '1002']]);
    const st = ctr.status();
    assert.equal(st.renderer, 'compat');
    assert.deepEqual(st.fellBack, ['vulkan']);
    assert.equal(st.running, true);
    // the failed try is in the diagnostics and the players' log, with the renderer it had
    assert.equal(ctr.last.renderer, 'vulkan');
    assert.equal(ctr.last.retriedWith, 'compat');
    assert.equal(ctr.diagnostics().log.at(-1).retriedWith, 'compat');
    assert.match(ctr.current.log.join(''), /starting it again with "compat"/);
    ctr.stop();
    await until(() => ctr.current === null);
  });
});

test('auto: commands the page sent before the step down reach the new host (WATCH, SPEED, FRAMESKIP – the last of each)', async () => {
  await quietly(async () => {
    const ctr = sessions({ FAKE_FAIL: 'none' });
    const id = ctr.start({ rom: 'r', key: 'k-replay', tools, renderer: 'vulkan', auto: true });
    const p = page();
    ctr.attach(id, p.res);
    await until(() => p.messages().some((m) => /"loaded"/.test(m.text)));
    const watch = Buffer.alloc(4);
    ctr.send(id, Buffer.concat([command(CMD.WATCH, watch), command(CMD.FRAMESKIP, Buffer.from([2, 0, 0, 0])), command(CMD.INPUT, Buffer.alloc(17))]));
    await until(() => p.messages().some((m) => m.text === 'cmd 8 vulkan'));
    assert.deepEqual(Object.keys(ctr.current.lastCmds).map(Number).sort(), [CMD.WATCH, CMD.FRAMESKIP].sort());
    ctr.stop();
  });
});

test('auto: a step down after a crash at 3× resolution goes back to 1× as well (and software starts at 1×)', async () => {
  await quietly(async () => {
    const ctr = sessions({ FAKE_FAIL: 'vulkan' });
    const id = ctr.start({ rom: 'r', key: 'k-scale', tools, renderer: 'vulkan', auto: true, scale: 3 });
    assert.match(ctr.current.args.join(' '), /--scale 3/);
    assert.equal(ctr.status().scale, 3);
    const p = page();
    ctr.attach(id, p.res);
    await until(() => p.messages().some((m) => /"loaded"/.test(m.text) && /"compat"/.test(m.text)));
    assert.match(ctr.current.args.join(' '), /--scale 1 /);
    assert.doesNotMatch(ctr.current.args.join(' '), /--scale 3/);
    assert.equal(ctr.status().scale, 1);
    assert.equal(ctr.last.scale, 3, 'the failed try is logged with its resolution');
    ctr.stop();
    await until(() => ctr.current === null);
    const sw = sessions({ FAKE_FAIL: 'none' });
    sw.start({ rom: 'r', key: 'k-sw', tools, renderer: 'software', scale: 3 });
    assert.match(sw.current.args.join(' '), /--scale 1 /);
    sw.stop();
    await until(() => sw.current === null);
  });
});

test('auto: compat crashing as well goes on to software; software is the end of the line – then the page hears the error', async () => {
  await quietly(async () => {
    const ctr = sessions({ FAKE_FAIL: 'vulkan,compat' });
    const failed = [];
    ctr.onRendererFailed = (x) => failed.push(`${x.from}>${x.to}`);
    const id = ctr.start({ rom: 'r', key: 'k-chain', tools, renderer: 'vulkan', auto: true });
    const p = page();
    ctr.attach(id, p.res);
    await until(() => p.messages().some((m) => /"loaded"/.test(m.text) && /"software"/.test(m.text)));
    assert.deepEqual(failed, ['vulkan>compat', 'compat>software']);
    assert.ok(!p.messages().some((m) => /"error"/.test(m.text)));
    ctr.stop();
    await until(() => ctr.current === null);

    const all = sessions({ FAKE_FAIL: 'vulkan,compat,software' });
    const id2 = all.start({ rom: 'r', key: 'k-end', tools, renderer: 'vulkan', auto: true });
    const p2 = page();
    all.attach(id2, p2.res);
    await until(() => all.current?.closed);
    const msgs = p2.messages();
    assert.equal(msgs.filter((m) => /"error"/.test(m.text)).length, 1, 'only the last host\'s error reaches the page');
    assert.equal(all.last.renderer, 'software');
    assert.equal(all.last.retriedWith, undefined);
  });
});

test('a fixed renderer (not auto) never steps down: the crash reaches the page as before', async () => {
  await quietly(async () => {
    const ctr = sessions();
    let called = false;
    ctr.onRendererFailed = () => (called = true);
    const id = ctr.start({ rom: 'r', key: 'k-fixed', tools, renderer: 'vulkan', auto: false });
    const p = page();
    ctr.attach(id, p.res);
    await until(() => ctr.current?.closed);
    assert.equal(called, false);
    assert.ok(p.messages().some((m) => m.type === MSG.EVENT && /"crash":true/.test(m.text)));
    assert.equal(ctr.last.renderer, 'vulkan');
    assert.match(ctr.current.args.join(' '), /--renderer vulkan/);
  });
});
