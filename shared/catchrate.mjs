// The chance to catch a wild Pokémon with one ball – the battle helper's "Catch chance" row – computed the way each
// generation's game does it, from the species' catch rate, the opponent's current and maximum HP, its level and its
// status condition (shared/live/parse.mjs readLiveBattle reads them; a game whose status can't be read passes none).
//
// Sources, per generation:
// - Gen 1: pret/pokered engine/items/item_effects.asm ItemUseBall – a first random number in a range per ball (Poké
//   0–255, Great 0–200, Ultra/Safari 0–150) minus a status value (sleep/freeze 25, poison/burn/paralysis 12), checked
//   against the catch rate, then a second one against f = ⌊⌊MaxHP·255 / Ball⌋ / max(⌊HP/4⌋, 1)⌋ (Ball 8 for the Great
//   Ball, 12 otherwise). Both random numbers are enumerated, so the chance is exact.
// - Gen 2: pret/pokecrystal engine/items/item_effects.asm PokeBallEffect + BallMultiplierFunctionTable – the 8-bit
//   arithmetic as the game does it, its bugs included (poison/burn/paralysis add nothing, the HP part of a Pokémon with
//   more than 341 max HP overflows), one random number 0–255 against the result.
// - Gen 3/4: pret/pokeemerald src/battle_script_commands.c Cmd_handleballthrow (pokeruby: bad poison gives no bonus
//   there), pret/pokeplatinum src/battle/battle_script.c BattleScript_CalcCatchShakes – a = ⌊⌊rate·ball/10⌋ ·
//   (3·MaxHP − 2·HP) / (3·MaxHP)⌋ · status, caught at 255, else four shake checks with
//   b = ⌊1048560 / ⌊√⌊√⌊16711680 / a⌋⌋⌋⌋ against a 16-bit random number.
// - Gen 5: Bulbapedia "Catch rate" (Generation V) and The Cave of Dragonflies "Gen V Capture Mechanics" – the same a in
//   steps of 1/4096 (status ×2.5 for sleep/freeze), three shake checks with Y = ⌊65536 / ⁴√(255 / X)⌋.
// - Gen 6/7: Bulbapedia (Generation VI, VII) and The Cave of Dragonflies "Gen VI/VII Capture Mechanics" – Gen 5's X,
//   four shake checks with Y = ⌊65536 / (255 / X)^(3/16)⌋; Gen 7: any ball but the Beast Ball is ×410/4096 on an Ultra
//   Beast. (The low-level bonus, max((30 − level) / 10, 1), only came with Gen 8 – Sword/Shield and Brilliant
//   Diamond/Shining Pearl – so it doesn't apply to any game twincable runs.)
//
// Left out on purpose, as twincable can't know them: critical captures (Gen 5–7: they depend on the Pokédex count and only
// ever raise the chance), Gen 5's dark-grass penalty, Entralink/O-Power/Roto Catch boosts, the first route of the 3DS
// games where every ball catches, and balls whose bonus needs the turn count, the time of day, the terrain or the
// Pokédex (Quick, Timer, Dusk, Dive, Repeat, the Apricorn balls). The only situational balls shown are the ones whose
// condition is in what the battle reader sees: the Net Ball (a Water or Bug type), the Nest Ball (the level – Gen 3/4,
// where pret's code gives its exact formula) and the Beast Ball (an Ultra Beast, Gen 7).

/** The status condition of a status word (Gen 3/4 bits; Gen 1/2 use the same low byte, Gen 5 is converted to it). */
export function statusKind(s) {
  if (typeof s !== 'number' || !s) return null;
  if (s & 7) return 'slp';
  if (s & 0x20) return 'frz';
  if (s & 0x80) return 'tox';
  if (s & 0x08) return 'psn';
  if (s & 0x10) return 'brn';
  if (s & 0x40) return 'par';
  return null;
}

// Gen 7's Ultra Beasts (Nihilego … Guzzlord, Poipole, Naganadel, Stakataka, Blacephalon)
const ULTRA_BEASTS = new Set([793, 794, 795, 796, 797, 798, 799, 803, 804, 805, 806]);
export const isUltraBeast = (species) => ULTRA_BEASTS.has(species);

/**
 * The ball bonus as the game stores it: Gen 3/4 in tenths (pokeemerald sBallCatchBonuses: Ultra 20, Great 15, Poké
 * 10), Gen 5–7 in 4096ths. null where the ball has no effect in that generation (or its condition doesn't hold – the
 * caller only offers it where it does).
 */
function ballBonus(gen, ball, foe) {
  const tenths = { poke: 10, great: 15, ultra: 20 }[ball];
  if (gen <= 4) {
    if (tenths) return tenths;
    if (ball === 'net') return 30; // Water or Bug (pokeemerald ITEM_NET_BALL, pokeplatinum ITEM_NET_BALL)
    if (ball === 'nest') return Math.max(40 - foe.level, 10); // below level 40, at least ×1 (both decomps)
    return null;
  }
  // Gen 7: any ball but the Beast Ball is ×410/4096 on an Ultra Beast, the Beast Ball ×5 on them
  if (gen >= 7 && isUltraBeast(foe.species)) return ball === 'beast' ? 5 * 4096 : 410;
  if (tenths) return tenths * 4096 / 10;
  if (ball === 'net') return gen >= 7 ? 3.5 * 4096 : 3 * 4096;
  return null;
}

const isqrt = (n) => {
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
};

/** Gen 1 (pokered ItemUseBall): every first random number of the ball's range, each with its chance for the second. */
function gen1(foe, ball) {
  const N = ball === 'poke' ? 255 : ball === 'great' ? 200 : 150; // (Ultra and Safari Ball alike)
  const st = statusKind(foe.status);
  const S = st === 'slp' || st === 'frz' ? 25 : st ? 12 : 0;
  const factor = ball === 'great' ? 8 : 12;
  const w = Math.floor(Math.floor(foe.maxHp * 255 / factor) / (((foe.hp >> 2) & 0xff) || 1));
  const x = Math.min(w, 255);
  let caught = 0;
  for (let r = 0; r <= N; r++) {
    if (r < S) caught += 1; // the status value is bigger than the number: caught for sure
    else if (r - S > foe.rate) continue; // above the catch rate: it breaks free
    else if (w > 255) caught += 1;
    else caught += (x + 1) / 256; // a second number 0–255 must be at most f
  }
  return caught / (N + 1);
}

/** Gen 2 (pokecrystal PokeBallEffect): the game's own 8-bit steps, bugs included. null when it would divide by 0. */
function gen2(foe, ball) {
  let b = foe.rate;
  if (ball === 'great') b = Math.min(b + (b >> 1), 255); // GreatBallMultiplier: ×1.5
  if (ball === 'ultra') b = Math.min(b * 2, 255); // UltraBallMultiplier: ×2
  let c = foe.hp * 2;
  let e = foe.maxHp * 3;
  if (e > 255) {
    // both halved twice; only the low bytes go on (a max HP above 341 overflows here, as in the game)
    e >>= 2;
    c >>= 2;
    if ((c & 0xff) === 0) c = 1;
  }
  c &= 0xff;
  e &= 0xff;
  if (!e) return null;
  let a = Math.floor((b * ((e - c) & 0xff)) / e) & 0xff;
  if (!a) a = 1;
  // only sleep and freeze add (+10): poison, burn and paralysis were meant to add 5, but the check reads the wrong bits
  const st = statusKind(foe.status);
  if (st === 'slp' || st === 'frz') a = Math.min(a + 10, 255);
  return (a + 1) / 256; // caught when a random number 0–255 is at most a
}

/** Gen 3/4 (pokeemerald Cmd_handleballthrow, pokeplatinum BattleScript_CalcCatchShakes). */
function gen34(foe, ball, game) {
  const bonus = ballBonus(foe.gen, ball, foe);
  let a = Math.floor(Math.floor(foe.rate * bonus / 10) * (foe.maxHp * 3 - foe.hp * 2) / (foe.maxHp * 3));
  const st = statusKind(foe.status);
  if (st === 'slp' || st === 'frz') a *= 2;
  // Ruby/Sapphire leave bad poison out of the check (pokeruby: "/*| STATUS1_TOXIC_POISON */"), fixed in Emerald/FRLG
  const rsToxic = st === 'tox' && /^(ruby|sapphire)/.test(game || '');
  if ((st === 'psn' || st === 'brn' || st === 'par' || st === 'tox') && !rsToxic) a = Math.floor(a * 15 / 10);
  if (a >= 255) return 1;
  a = Math.max(a, 1); // (never 0 – Bulbapedia; the games would divide by it)
  const b = Math.floor(1048560 / isqrt(isqrt(Math.floor(16711680 / a))));
  return Math.min(b / 65536, 1) ** 4;
}

/** X of Gen 5–7 in 4096ths (The Cave of Dragonflies: X = down(round(down(round((3M − 2H)·C·B) / 3M) · S))). */
function x4096(foe, ball) {
  const bonus = ballBonus(foe.gen, ball, foe);
  let x = Math.floor((foe.maxHp * 3 - foe.hp * 2) * foe.rate * bonus / (foe.maxHp * 3));
  const st = statusKind(foe.status);
  const s = st === 'slp' || st === 'frz' ? 10240 : st ? 6144 : 4096; // ×2.5 / ×1.5 / ×1
  x = Math.floor((x * s + 2048) / 4096);
  return x;
}

/** Gen 5: three shake checks (the fourth root); Gen 6/7: four (the power 3/16). */
function gen567(foe, ball) {
  const x = x4096(foe, ball) / 4096;
  if (x >= 255) return 1;
  if (x <= 0) return 0;
  const r4 = (v) => Math.round(v * 4096) / 4096; // (Gen 5 rounds each step to 1/4096)
  if (foe.gen === 5) {
    const y = Math.floor(65536 / r4(Math.sqrt(r4(Math.sqrt(r4(255 / x))))));
    return Math.min(y / 65536, 1) ** 3;
  }
  const y = Math.floor(65536 / (255 / x) ** (3 / 16));
  return Math.min(y / 65536, 1) ** 4;
}

/**
 * The chance (0–1) that one `ball` catches `foe` = { gen, rate (the species' catch rate), hp, maxHp, level, status?,
 * species? }; `game` = the memory-table id (Ruby/Sapphire's bad-poison bug). null when it can't be told.
 */
export function catchChance(foe, ball, game = '') {
  if (!foe || !(foe.rate >= 1 && foe.rate <= 255) || !(foe.maxHp > 0) || !(foe.hp >= 0) || foe.hp > foe.maxHp) return null;
  const f = { ...foe, gen: Number(foe.gen) };
  if (f.gen === 1) return ['poke', 'great', 'ultra', 'safari'].includes(ball) ? gen1(f, ball) : null;
  if (f.gen === 2) return ['poke', 'great', 'ultra'].includes(ball) ? gen2(f, ball) : null;
  if (ballBonus(f.gen, ball, f) === null) return null;
  if (f.gen === 3 || f.gen === 4) return gen34(f, ball, game);
  if (f.gen >= 5 && f.gen <= 7) return gen567(f, ball);
  return null;
}

/**
 * The balls the battle helper shows for a wild opponent, with their chances: the Poké, Great and Ultra Ball, and the
 * one situational ball that helps here, if any (Net Ball on a Water or Bug type from Gen 3 on, Nest Ball on a Pokémon
 * below level 30 in Gen 3/4, Beast Ball on an Ultra Beast in Gen 7). `foe` as catchChance, plus `types` (its types
 * right now); `safari`: a Gen 1 Safari Zone battle (only Safari Balls). → [{ ball, p }] or null when the chance can't be
 * told (no catch rate known, a generation without a formula).
 */
export function catchRow(foe, { game = '', types = [], safari = false } = {}) {
  if (!foe || catchChance(foe, 'poke', game) === null) return null;
  const gen = Number(foe.gen);
  if (safari) return gen === 1 ? [{ ball: 'safari', p: catchChance(foe, 'safari', game) }] : null;
  const row = ['poke', 'great', 'ultra'].map((ball) => ({ ball, p: catchChance(foe, ball, game) }));
  const extra = [];
  if (gen >= 3 && types.some((t) => t === 'water' || t === 'bug')) extra.push('net');
  if ((gen === 3 || gen === 4) && foe.level < 30) extra.push('nest'); // (from level 30 on it's ×1)
  if (gen === 7 && isUltraBeast(foe.species)) extra.push('beast');
  // (the likelier one; on a tie – both certain – the bigger bonus, which stays ahead as the HP goes up)
  const f = { ...foe, gen };
  const best = extra.map((ball) => ({ ball, p: catchChance(foe, ball, game), bonus: ballBonus(gen, ball, f) })).filter((x) => x.p !== null)
    .sort((a, b) => b.p - a.p || b.bonus - a.bonus)[0];
  return best ? [...row, { ball: best.ball, p: best.p }] : row;
}

/** A chance as the panel shows it: whole percent, never "100 %" unless certain nor "0 %" unless impossible. */
export function chanceText(p) {
  if (p === null || p === undefined || Number.isNaN(p)) return '–';
  if (p >= 1) return '100%';
  if (p <= 0) return '0%';
  const n = Math.round(p * 100);
  if (n >= 100) return '>99%';
  if (n < 1) return '<1%';
  return `${n}%`;
}

/**
 * The foe's status condition for the catch chance, held for the battle (`key`: the foe – species, level, max HP). The
 * Gen 3/4 readers leave `status` out for a poll when they don't find the battle struct that frame: without holding it,
 * "status not read" flickered on and off and the chance jumped with it. `held`: the previous result (or null).
 * → { key, read, status }: `read` once a status came in this battle (the last one stands until a new one comes).
 */
export function holdFoeStatus(held, key, status) {
  if (status !== undefined) return { key, read: true, status };
  if (held?.key === key && held.read) return held;
  return { key, read: false, status: undefined };
}
