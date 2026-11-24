// `build-ctr.mjs --check` (npm run dist, CI) catches a 3DS core built before a patch was added or changed: the core's
// stamp (TWICABLE_CORE) names the patches and hashes them (scripts/ctrstamp.mjs). Until 2.8.2's review it only looked
// whether the file was there – a local core without twicable-sfx.patch passed and lacked what the app asks it for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { coreStamp, staleCore } from '../scripts/ctrstamp.mjs';

const dir = new URL('../native/azahar-patch/', import.meta.url);
const names = readdirSync(dir).filter((n) => n.endsWith('.patch')).sort();
const read = (n) => readFileSync(new URL(n, dir), 'utf8');

test('the 3DS core stamp: the same patches pass; a missing, changed or unstamped patch, or another Azahar, is caught', () => {
  const now = coreStamp('2126.2', names, read);
  assert.equal(staleCore(now, now), null);
  // a Windows checkout (CRLF) stamps the same
  assert.equal(coreStamp('2126.2', names, (n) => read(n).replace(/\n/g, '\r\n')), now);
  // built before the last patch came (the stamp as 2.8.1's build-ctr.mjs wrote it, one patch short)
  const short = `Azahar 2126.2 libretro core with ${names.slice(0, -1).map((n) => `native/azahar-patch/${n}`).join(', ')}\n`;
  assert.match(staleCore(short, now), new RegExp(`without ${names.at(-1).replace('.', '\\.')}`));
  // every patch named, but stamped before there was a hash
  const old = now.split('\n')[0] + '\n';
  assert.match(staleCore(old, now), /stamped/);
  // a patch changed since the core was built
  const changed = coreStamp('2126.2', names, (n) => (n === names[0] ? `${read(n)}\n+one more line\n` : read(n)));
  assert.match(staleCore(changed, now), /older versions/);
  // another Azahar
  assert.match(staleCore(coreStamp('2125.0', names, read), now), /Azahar 2125\.0/);
});

test('build-ctr.mjs --check says so (and SLS_NO_3DS still builds without the 3DS part)', () => {
  const run = (env = {}) => spawnSync(process.execPath, ['scripts/build-ctr.mjs', '--check', '--platform', 'linux-test'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, SLS_NO_3DS: '', ...env } });
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /incomplete/);
  assert.equal(run({ SLS_NO_3DS: '1' }).status, 0);
  const src = readFileSync(new URL('../scripts/build-ctr.mjs', import.meta.url), 'utf8');
  assert.match(src, /writeFileSync\(join\(out, 'TWICABLE_CORE'\), coreStamp\(\)\)/, 'the build writes the stamp with the hash');
  assert.match(src, /staleCore\(readFileSync\(join\(out, 'TWICABLE_CORE'\)/, '--check compares it');
});
