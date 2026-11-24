// Intro saves (a community idea): a save made right after a game's intro – before the starter – that new attempts of
// the same game start from, so nobody has to sit through the intro again. This file reads such a save: is there a
// game save in it at all, and which Pokémon are already in the team (the point is a save *before* the starter – the
// app says so gently when it isn't). Pure – the server (server/lib/introsave.mjs) keeps and applies the saves.
//
// Why a battery save works for every new randomized attempt: none of these saves depends on the ROM's bytes. Gen 1/2
// check a sum over the save itself, Gen 3 a sum and a signature per 4 KB section, Gen 4/5 a CRC16 per block, the 3DS
// games checksums (and in Gen 7 a signature) over the save – never a ROM checksum or header. The randomizer keeps the
// save layout (it changes data in the ROM – starters, wild Pokémon, trainers – not what a save holds), so the starter
// you then pick is the new attempt's own. A save state would not work: it is a picture of the old ROM's memory.
//
// Every reader is careful: a layout it doesn't recognise (a Japanese release, a ROM hack with its own save) answers
// 'unknown' – the save is still kept, only the team isn't known. 'empty' is a file that holds no save at all.
import { crc16ccitt, decryptPK4 } from './gen4save.mjs';
import { pk6Mon } from './live/gen67.mjs';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const hex8 = (n) => n.toString(16).padStart(8, '0');

/** The systems an intro save works for – every one twincable plays (3DS: in twincable's own 3DS player). */
export const INTRO_SYSTEMS = ['gb', 'gbc', 'gba', 'nds', '3ds'];

/** All bytes alike (a cartridge never written: 0xFF or 0x00) – trailing emulator data (a clock, ≤ 256 bytes) aside. */
export function blankSave(u8) {
  const n = u8.length > 512 ? u8.length - 256 : u8.length;
  if (!n) return true;
  const v = u8[0];
  if (v !== 0xff && v !== 0x00) return false;
  for (let i = 1; i < n; i++) if (u8[i] !== v) return false;
  return true;
}

// ---- Gen 1 / 2 (international releases; the party list: count, species list, mons, OT names, nicknames) ----------
const GB_LAYOUTS = [
  // Red, Blue, Yellow: one sum over the main data (bulbapedia "Save data structure (Generation I)")
  { gen: 1, sum: [0x2598, 0x3523], at: 0x3523, kind: 'byte', party: 0x2f2c, size: 44, ot: 0x0c, dv: 0x1b, level: 0x21 },
  // Crystal, then Gold / Silver (Generation II): a 16-bit sum
  { gen: 2, sum: [0x2009, 0x2b83], at: 0x2d0d, kind: 'word', party: 0x2865, size: 48, ot: 0x06, dv: 0x15, level: 0x1f },
  { gen: 2, sum: [0x2009, 0x2d69], at: 0x2d69, kind: 'word', party: 0x288a, size: 48, ot: 0x06, dv: 0x15, level: 0x1f },
];

function gbParty(u8, L, tables) {
  let sum = 0;
  for (let i = L.sum[0]; i < L.sum[1]; i++) sum += u8[i];
  if (L.kind === 'byte' ? ((~sum) & 0xff) !== u8[L.at] : (sum & 0xffff) !== u16(u8, L.at)) return null;
  const n = u8[L.party];
  if (n > 6) return null;
  const mons = [];
  for (let i = 0; i < n; i++) {
    const d = u8.subarray(L.party + 8 + i * L.size, L.party + 8 + (i + 1) * L.size);
    const raw = d[0];
    const species = L.gen === 1 ? tables?.gen1Index?.[raw] || null : raw || null;
    // the live reader's key (shared/live/parse.mjs): OT id and DVs
    mons.push({ key: `g${L.gen}-${u16be(d, L.ot).toString(16)}-${u16be(d, L.dv).toString(16).padStart(4, '0')}`, species, level: d[L.level] || null });
  }
  return { gen: L.gen, mons };
}

// ---- Gen 3 (two slots of 14 sections; section 1 holds the team) ---------------------------------------------------
const G3_SIG = 0x08012025;
const G3_SIZES = [3884, 3968, 3968, 3968, 3848, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000];
const G3_PERM = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
  'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'];

function g3Sections(u8, slot) {
  const out = [];
  let index = -1;
  for (let i = 0; i < 14; i++) {
    const o = slot + i * 0x1000;
    if (o + 0x1000 > u8.length || u32(u8, o + 0xff8) !== G3_SIG) return null;
    const id = u16(u8, o + 0xff4);
    if (id > 13 || out[id] !== undefined) return null;
    out[id] = o;
    index = u32(u8, o + 0xffc);
  }
  return { sections: out, index };
}

function g3Checksum(u8, o, size) {
  let sum = 0;
  for (let i = 0; i < size; i += 4) sum = (sum + u32(u8, o + i)) >>> 0;
  return ((sum >>> 16) + (sum & 0xffff)) & 0xffff;
}

function g3Species(d, tables) {
  if (!tables?.gen3Index) return null;
  const pid = u32(d, 0);
  const key = (pid ^ u32(d, 4)) >>> 0;
  const order = G3_PERM[pid % 24];
  const g = 32 + order.indexOf('G') * 12; // the Growth block: species first
  const internal = (u32(d, g) ^ key) & 0xffff;
  return tables.gen3Index[internal] || null;
}

function gen3Party(u8, tables) {
  const slots = [0, 0xe000].map((s) => g3Sections(u8, s)).filter(Boolean);
  if (!slots.length) return null;
  const cur = slots.sort((a, b) => b.index - a.index)[0];
  const team = cur.sections[1];
  if (g3Checksum(u8, team, G3_SIZES[1]) !== u16(u8, team + 0xff6)) return null;
  // FireRed / LeafGreen write 1 at 0xAC of section 0, Ruby / Sapphire 0, Emerald its random security key (PKHeX)
  const frlg = u32(u8, cur.sections[0] + 0xac) === 1;
  const count = frlg ? 0x34 : 0x234;
  const n = u32(u8, team + count);
  if (n > 6) return null;
  const mons = [];
  for (let i = 0; i < n; i++) {
    const d = u8.subarray(team + count + 4 + i * 100, team + count + 4 + (i + 1) * 100);
    const pid = u32(d, 0);
    mons.push({ key: `g3-${hex8(pid)}-${u32(d, 4).toString(16)}`, species: g3Species(d, tables), level: d[84] || null });
  }
  return { gen: 3, mons };
}

// ---- Gen 4 (two partitions of 256 KB; the General block holds the team) ------------------------------------------
const G4_MAGICS = [0x20060623, 0x20070903];
const G4_LAYOUTS = [
  { name: 'dp', general: 0xc100, footer: 0x14, party: 0x98 },
  { name: 'pt', general: 0xcf2c, footer: 0x14, party: 0xa0 },
  { name: 'hgss', general: 0xf628, footer: 0x10, party: 0x98 },
];

function g4Block(u8, base, L) {
  const end = base + L.general;
  if (end > u8.length) return null;
  if (u32(u8, end - 0x0c) !== L.general || !G4_MAGICS.includes(u32(u8, end - 0x08))) return null;
  if (crc16ccitt(u8, base, end - L.footer) !== u16(u8, end - 0x02)) return null;
  return { base, count: u32(u8, end - L.footer) };
}

const pk45Key = (d) => `${hex8(u32(d, 0))}-${u16(d, 0x0c)}-${u16(d, 0x0e)}`;

function pk45Party(u8, at, n, size) {
  const mons = [];
  for (let i = 0; i < n; i++) {
    const { data: d, checksumOk } = decryptPK4(u8.slice(at + i * size, at + (i + 1) * size));
    if (!checksumOk || !u16(d, 0x08)) return null;
    mons.push({ key: pk45Key(d), species: u16(d, 0x08), level: d[0x8c] || null });
  }
  return mons;
}

function gen4Party(u8) {
  for (const L of G4_LAYOUTS) {
    const blocks = [0, 0x40000].map((p) => g4Block(u8, p, L)).filter(Boolean);
    if (!blocks.length) continue;
    const g = blocks.sort((a, b) => b.count - a.count)[0].base;
    const n = u32(u8, g + L.party - 4);
    if (n > 6) return null;
    const mons = pk45Party(u8, g + L.party, n, 236);
    return mons ? { gen: 4, mons } : null;
  }
  return null;
}

// ---- Gen 5 (Black, White, Black 2, White 2: the party block at 0x18E00, 0x534 bytes, its CRC16 at 0x19336 – PKHeX) --
function gen5Party(u8) {
  if (u8.length < 0x80000 || crc16ccitt(u8, 0x18e00, 0x18e00 + 0x534) !== u16(u8, 0x19336)) return null;
  const n = u32(u8, 0x18e04);
  if (n > 6) return null;
  const mons = pk45Party(u8, 0x18e08, n, 220);
  return mons ? { gen: 5, mons } : null;
}

// ---- Gen 6 / 7 (3DS: the save's `main` file; offsets by its size, PKHeX) -------------------------------------------
const CTR_LAYOUTS = [
  { size: 0x65600, gen: 6, party: 0x14200 }, // X, Y
  { size: 0x76000, gen: 6, party: 0x14200 }, // Omega Ruby, Alpha Sapphire
  { size: 0x6be00, gen: 7, party: 0x01400 }, // Sun, Moon (checked on a real save)
  { size: 0x6cc00, gen: 7, party: 0x01600 }, // Ultra Sun, Ultra Moon
];

function ctrParty(u8) {
  const L = CTR_LAYOUTS.find((x) => x.size === u8.length);
  if (!L) return null;
  const n = u8[L.party + 6 * 260];
  if (n > 6) return null;
  const mons = [];
  for (let i = 0; i < n; i++) {
    const m = pk6Mon(u8.subarray(L.party + i * 260, L.party + (i + 1) * 260), L.gen);
    if (!m) return null;
    mons.push({ key: m.key, species: m.species, level: m.level || null });
  }
  return { gen: L.gen, mons };
}

/**
 * Read a save of a game on `system` (gb/gbc/gba/nds: the battery save; 3ds: the save's `main` file).
 * tables: { gen1Index, gen3Index } (index → National Dex, as arrays) for the species of Gen 1/3 Pokémon – optional.
 * → { state: 'ok', gen, party, mons: [{ key, species, level }] } – the team, with the keys the live reader gives them
 *   { state: 'unknown' } – a save, but not a layout this file knows (kept all the same; the team isn't known)
 *   { state: 'empty' }   – no save in it (nothing was ever saved)
 */
export function inspectSave(bytes, system, tables = null) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!u8.length || blankSave(u8)) return { state: 'empty' };
  let res = null;
  if (system === 'gb' || system === 'gbc' || system === 'sgb') {
    // Red, Blue and Yellow are Game Boy games, Gold, Silver and Crystal Game Boy Color ones
    const gen = system === 'gbc' ? 2 : 1;
    if (u8.length >= 0x8000) for (const L of GB_LAYOUTS) if (L.gen === gen && (res = gbParty(u8, L, tables))) break;
  } else if (system === 'gba') {
    res = gen3Party(u8, tables);
  } else if (system === 'nds') {
    // (a DeSmuME .dsv has 122 bytes after the 512 KB)
    const s = u8.length > 0x80000 && u8.length < 0x80000 + 0x100 ? u8.subarray(0, 0x80000) : u8;
    res = gen4Party(s) || gen5Party(s);
  } else if (system === '3ds') {
    res = ctrParty(u8);
  }
  return res ? { state: 'ok', gen: res.gen, party: res.mons.length, mons: res.mons } : { state: 'unknown' };
}
