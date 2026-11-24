// A 3DS host that can't even be started: on Windows a file that isn't a program (an empty or broken ctrhost.exe)
// makes spawn() throw right away instead of sending an 'error' event. The session must end like any failed start –
// stopping it, a new start and a page's commands must not crash on the missing child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'sls-ctrspawnfail-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
process.env.SLS_DATA_DIR = TMP;
const { CtrSessions } = await import('../server/lib/ctr.mjs');

const throwingSpawn = () => {
  const e = new Error('spawn UNKNOWN');
  e.code = 'UNKNOWN';
  throw e;
};

test('a host that fails in spawn() itself ends the session; stop, a new start and send do not crash', () => {
  const ctr = new CtrSessions({ spawn: throwingSpawn });
  const id = ctr.launch('C:/twincable/tools/ctr/ctrhost.exe', ['--rom', 'game.3ds'], null);
  const s = ctr.get(id);
  assert.equal(s.child, null);
  assert.deepEqual(s.exit, { error: 'spawn UNKNOWN' });
  assert.equal(s.closed, true);
  assert.match(ctr.last?.exit || '', /spawn UNKNOWN/);
  assert.throws(() => ctr.send(id, Buffer.alloc(0)), (e) => e.code === 'ctrEnded' || /stopped/.test(e.message));
  assert.doesNotThrow(() => ctr.release(s));
  // a new start stops the old session first – this used to throw "Cannot read properties of null (reading 'stdout')"
  const id2 = ctr.launch('C:/twincable/tools/ctr/ctrhost.exe', ['--rom', 'game.3ds'], null);
  assert.notEqual(id2, id);
  assert.doesNotThrow(() => ctr.stop());
  assert.equal(ctr.current, null);
});
