// The 3DS core's stamp (tools/ctr/<platform>/TWINCABLE_CORE, written by scripts/build-ctr.mjs): which Azahar and which of
// native/azahar-patch/*.patch went into the core – by name and by a hash of their contents. `build-ctr.mjs --check`
// (npm run dist, CI) compares it with the patches now, so a core built before a patch was added or changed is caught
// (until 2.8.2's review it only looked whether the file was there: a local core without twincable-sfx.patch passed).
import { createHash } from 'node:crypto';

/** The stamp for Azahar `tag` with the patches `names` (read(name) → its text; line endings as LF, so a Windows
 *  checkout gives the same hash). */
export function coreStamp(tag, names, read) {
  const h = createHash('sha256');
  for (const n of names) h.update(`${n}\0${read(n).replace(/\r\n/g, '\n')}\0`);
  return `Azahar ${tag} libretro core with ${names.map((n) => `native/azahar-patch/${n}`).join(', ')}\npatches sha256 ${h.digest('hex')}\n`;
}

/** Why the stamp `text` doesn't fit the stamp `want` (coreStamp of the patches now), or null when it does. */
export function staleCore(text, want) {
  const names = (s) => [...String(s).matchAll(/native\/azahar-patch\/([^,\s]+\.patch)/g)].map((m) => m[1]);
  const hash = (s) => /patches sha256 ([0-9a-f]{64})/.exec(String(s))?.[1] || null;
  const tag = (s) => /^Azahar (\S+)/.exec(String(s))?.[1] || null;
  const missing = names(want).filter((n) => !names(text).includes(n));
  if (missing.length) return `built without ${missing.join(', ')}`;
  if (tag(text) !== tag(want)) return `built from Azahar ${tag(text) || '?'}, not ${tag(want)}`;
  if (!hash(text)) return 'built before the patches were stamped (it can\'t tell whether they changed since)';
  if (hash(text) !== hash(want)) return 'built from older versions of the patches';
  return null;
}
