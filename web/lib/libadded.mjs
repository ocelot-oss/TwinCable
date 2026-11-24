// What adding files to the library actually changed – for the message after an import or upload (web/views/library.mjs).
// Compares the library before and after: an entry from one of the added files is new, or was there already (the same
// ROM or patch, by checksum, under this or another name). A file that gave no entry holds nothing twicable can use.
import { t, currentLang } from './i18n.mjs';
import { catalog, gameTitle } from './data.mjs';
import { patchTitle } from '/shared/patchname.mjs';

/** The content of a library entry: CRC32 of a ROM (3DS: title + size, no CRC), SHA-1 of a patch. */
const sig = (kind, e) => (kind === 'patch' ? `p:${e.sha1 || e.id}` : kind === 'update' ? `u:${e.titleId}|${e.version}|${e.size}` : `r:${e.crc || `${e.system}|${e.titleId || e.code || ''}|${e.size}`}`);

/**
 * before / after: scanLibrary() results; paths: the library files the server reported as added ({ added } of
 * /api/library/import and /upload), or null for a whole folder (then every entry new since `before` counts).
 * → { added: [{ kind: 'rom'|'patch'|'update', entry }], already: [...], unusable: number of files with nothing usable }
 * (a 3DS game update: `hasGame` – its game is in the library)
 */
export function addedToLibrary(before, after, paths) {
  const had = new Set();
  for (const r of before?.roms || []) had.add(sig('rom', r));
  for (const p of before?.patches || []) had.add(sig('patch', p));
  for (const u of before?.ctrUpdates || []) had.add(sig('update', u));
  const games = new Set((after?.roms || []).filter((r) => r.system === '3ds' && r.titleId).map((r) => r.titleId));
  const entries = [...(after?.roms || []).map((entry) => ({ kind: 'rom', entry })), ...(after?.patches || []).map((entry) => ({ kind: 'patch', entry })),
    ...(after?.ctrUpdates || []).map((entry) => ({ kind: 'update', entry, hasGame: games.has(entry.gameTitleId) }))];
  const added = [];
  const already = [];
  let unusable = 0;
  const sort = (list) => {
    for (const x of list) (had.has(sig(x.kind, x.entry)) ? already : added).push(x);
  };
  if (!paths) {
    sort(entries.filter((x) => !had.has(sig(x.kind, x.entry))));
  } else {
    for (const path of new Set(paths)) {
      const mine = entries.filter((x) => x.entry.file === path);
      if (!mine.length) unusable++;
      sort(mine);
    }
  }
  return { added, already, unusable };
}

const gbText = (n) => {
  const gb = Math.max(0, Number(n) || 0) / 1024 ** 3;
  let num = gb.toFixed(1);
  try {
    num = gb.toLocaleString(currentLang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  } catch {
    // unknown locale – "4.0"
  }
  return `${num} GB`;
};

/**
 * The progress toast while a zipped 3DS game is unpacked (the server's "unpack" events: { state, name, gameId, size,
 * done }): "Unpacking Pokémon Sun … 40 % of 4.0 GB", replaced as it goes (key) and taken away when it's over – the
 * page that added it then says what was added, or why it failed.
 */
export function unpackToast(p, cat = catalog()) {
  if (!p || (p.state !== 'start' && p.state !== 'progress')) return { key: 'unpack', remove: true };
  const g = p.gameId ? (cat.games || []).find((x) => x.id === p.gameId) : null;
  const pct = p.size > 0 ? Math.min(100, Math.floor((100 * (p.done || 0)) / p.size)) : 0;
  return {
    key: 'unpack', kind: 'warn', ttl: 30 * 60 * 1000,
    title: t('lib.unpacking', 'Unpacking {name} …', { name: g ? gameTitle(g) : p.name }),
    text: t('lib.unpackingText', '{pct} % of {size} – twicable unpacks 3DS games into your library once', { pct, size: gbText(p.size) }),
  };
}

/** A name for an entry in the "added" message: the game or hack it is (with the patch's version), else its file name. */
function addedName({ kind, entry }, cat) {
  if (kind === 'update') {
    const g = entry.gameId ? (cat.games || []).find((x) => x.id === entry.gameId) : null;
    return t('lib.addedUpdateName', 'Update {version} for {game}', { version: entry.versionText || '', game: g ? gameTitle(g) : entry.gameTitleId || entry.name });
  }
  if (kind === 'patch') {
    const h = entry.hackId ? (cat.hacks || []).find((x) => x.id === entry.hackId) : null;
    const { title, version } = patchTitle(entry.name);
    return t('lib.addedPatchName', '{name} (patch)', { name: [h ? h.name : title, version].filter(Boolean).join(' ') });
  }
  const h = entry.hackId ? (cat.hacks || []).find((x) => x.id === entry.hackId) : null;
  if (!h && entry.customHack) return entry.customHack;
  const g = entry.gameId ? (cat.games || []).find((x) => x.id === entry.gameId) : null;
  return h ? h.name : g ? gameTitle(g) : entry.title || entry.name;
}

/** The toast (kind, title, text) for addedToLibrary()'s result: "Added: …", "2 games and 1 patch added", "Already in your library" … */
export function addedMessage({ added, already, unusable }, cat = catalog()) {
  const name = (x) => addedName(x, cat);
  const names = (list) => {
    const all = [...new Set(list.map(name))];
    return all.length > 5 ? `${all.slice(0, 5).join(', ')} …` : all.join(', ');
  };
  const extra = [];
  if (added.length && already.length) extra.push(t('lib.addedAlready', 'Already in your library: {names}', { names: names(already) }));
  if (unusable) extra.push(t('lib.addedUnusable', '{count} file has no game or patch twicable can use.|{count} files have no game or patch twicable can use.', { count: unusable }));
  if (added.length === 1) {
    const u = added[0].kind === 'update' ? added[0] : null;
    const hint = u ? (u.entry.encrypted ? t('lib.addedUpdateEncrypted', 'It’s encrypted, so twicable can’t use it – add a decrypted copy of the update.')
      : u.hasGame ? t('lib.addedUpdateHint', 'twicable’s player starts the game with it now.') : t('lib.addedUpdateWaiting', 'twicable uses it as soon as you add the game.'))
      : added[0].kind === 'patch' ? t('lib.addedPatchHint', 'You’ll find it under ROM hacks.') : t('lib.addedGameHint', 'It’s on the shelf now.');
    if (u?.entry.encrypted) return { kind: 'warn', title: t('lib.addedOne', 'Added: {name}', { name: name(added[0]) }), text: [hint, ...extra].join('\n') };
    // an already-patched ROM whose file name looks like a catalog hack ("kaizo-emerald.gba", server/lib/library.mjs):
    // the page offers to link it (`suggest`, a button on the toast)
    const e = added[0].entry;
    const h = added[0].kind === 'rom' && e.suggestedHackId && e.crc ? (cat.hacks || []).find((x) => x.id === e.suggestedHackId) : null;
    if (h) {
      return { kind: 'ok', title: t('lib.addedOne', 'Added: {name}', { name: name(added[0]) }), ttl: 15000,
        text: [t('lib.hackSuggest', 'Looks like {hack} – link it?', { hack: h.name }), ...extra].join('\n'), suggest: { crc: e.crc, hackId: h.id, hack: h.name } };
    }
    return { kind: 'ok', title: t('lib.addedOne', 'Added: {name}', { name: name(added[0]) }), text: [hint, ...extra].join('\n') };
  }
  if (added.length) {
    const games = added.filter((x) => x.kind === 'rom').length;
    const updates = added.filter((x) => x.kind === 'update').length;
    const patches = added.length - games - updates;
    const parts = [games && t('lib.addedGames', '{count} game|{count} games', { count: games }), patches && t('lib.addedPatches', '{count} patch|{count} patches', { count: patches }),
      updates && t('lib.addedUpdates', '{count} update|{count} updates', { count: updates })].filter(Boolean);
    const what = parts.length >= 2 ? t('lib.addedAnd', '{a} and {b}', { a: parts.slice(0, -1).join(', '), b: parts.at(-1) }) : parts[0];
    return { kind: 'ok', title: t('lib.addedMany', '{what} added', { what }), text: [names(added), ...extra].join('\n') };
  }
  if (already.length) return { kind: 'ok', title: t('lib.alreadyIn', 'Already in your library'), text: [names(already), ...extra].join('\n') };
  return { kind: 'warn', title: t('lib.nothingAdded', 'Nothing added'), text: extra.join('\n') || t('lib.nothingAddedText', 'No new game or patch was found in these files.') };
}
