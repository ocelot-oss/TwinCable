// Sound effects while a 3DS game fast-forwards: the core leaves the music voices out (native/azahar-patch/twicable-sfx.patch
// – its voice bookkeeping is compiled and run here on its own), the page plays each new sound at 1× when it happens
// (web/lib/sfxplayer.mjs) over the ROM track (TurboMixer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SfxPlayer } from '../web/lib/sfxplayer.mjs';
import { TurboMixer } from '../web/lib/turboaudio.mjs';

const SR = 32728;
const N = 128;
const FRAME = 547; // one 3DS frame of sound

/**
 * A game at `k`× (wall time in blocks of N): each press at wall time tp makes the game play a `freq` Hz burst of `len`
 * seconds (its own time) from the sample the game is at then – reported as an onset in the frame that holds it. The
 * player gets every frame the moment the game made it and renders block by block. Returns the press latencies (first
 * sound out after the press), the pitch heard in each burst and the output.
 */
function simulate({ k, seconds, presses, freq = 1000, len = 0.15, cont = null, ok = () => true, player = new SfxPlayer(SR) }) {
  const blocks = Math.ceil((seconds * SR) / N);
  const out = new Float32Array(blocks * N);
  const events = presses.map((tp) => ({ tp, g: Math.round(tp * k * SR) })).sort((a, b) => a.g - b.g);
  const burst = Math.round(len * SR);
  let lo = 0; // (the first burst that may still sound)
  const fill = (L, made) => {
    for (let i = 0; i < FRAME; i++) L[i] = cont && made + i >= cont.from ? 0.2 * Math.sin((2 * Math.PI * cont.freq * (made + i)) / SR) : 0;
    while (lo < events.length && events[lo].g + burst <= made) lo++;
    for (let j = lo; j < events.length && events[j].g < made + FRAME; j++) {
      const e = events[j];
      for (let i = Math.max(0, e.g - made); i < FRAME && made + i < e.g + burst; i++) L[i] += 0.5 * Math.sin((2 * Math.PI * freq * (made + i - e.g)) / SR);
    }
  };
  let made = 0;
  let due = 0;
  let ei = 0;
  const L = new Float32Array(FRAME);
  const oL = new Float32Array(N);
  const oR = new Float32Array(N);
  for (let b = 0; b < blocks; b++) {
    due += k * N;
    while (due >= FRAME) {
      const onsets = [];
      fill(L, made);
      while (ei < events.length && events[ei].g < made + FRAME) onsets.push(events[ei++].g - made);
      if (cont && cont.from >= made && cont.from < made + FRAME) onsets.push(cont.from - made);
      player.push(L, L, FRAME, onsets.sort((x, y) => x - y), ok(made));
      made += FRAME;
      due -= FRAME;
    }
    oL.fill(0);
    oR.fill(0);
    player.render(oL, oR, N);
    out.set(oL, b * N);
  }
  const lat = [];
  const pitch = [];
  for (const tp of presses) {
    const s0 = Math.round(tp * SR);
    let s = s0;
    while (s < out.length && Math.abs(out[s]) < 0.05) s++;
    lat.push(((s - s0) / SR) * 1000);
    // zero crossings over 60 ms of what came out
    let z = 0;
    const span = Math.round(0.06 * SR);
    for (let i = s + 1; i < Math.min(out.length, s + span); i++) if ((out[i - 1] < 0) !== (out[i] < 0)) z++;
    pitch.push(z / 2 / 0.06);
  }
  return { lat, pitch, out, player, made };
}
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

for (const k of [4, 16, 40]) {
  test(`rapid menu presses at ${k}×: every sound at 1× pitch, within 100 ms of the press, no delay building up over 2 minutes`, () => {
    // X / B every 0.5–0.8 s, a burst of presses now and then (two within 0.2 s)
    const presses = [];
    let t = 1;
    let i = 0;
    while (t < 118) {
      presses.push(t);
      t += i++ % 7 === 6 ? 0.2 : 0.5 + ((i * 37) % 31) / 100;
    }
    const r = simulate({ k, seconds: 120, presses });
    const half = presses.length >> 1;
    assert.ok(Math.max(...r.lat) <= 100, `latency max ${Math.max(...r.lat).toFixed(1)} ms`);
    assert.ok(Math.abs(median(r.lat.slice(half)) - median(r.lat.slice(0, half))) < 5, 'no trend');
    for (const p of r.pitch) assert.ok(Math.abs(p - 1000) < 40, `pitch ${p} Hz (sped up it would be ${1000 * k})`);
    assert.equal(r.player.stats.started, presses.length);
    assert.ok(r.player.readers.length <= 3);
  });
}

test('a sound that goes on (ambience): natural pitch in pieces from where the game is now – never falling behind', () => {
  const k = 6;
  const r = simulate({ k, seconds: 30, presses: [], cont: { from: Math.round(1 * k * SR), freq: 440 } });
  const p = r.player;
  // the reader that plays now is never more than one sound's length (maxEvent, its own time) behind the game
  const nw = p.newest;
  assert.ok(p.written - nw.pos <= p.k.maxEvent * k + 4 * FRAME, `behind ${(p.written - nw.pos) / SR} s of game time`);
  assert.ok(p.stats.conts > 15, `continuations ${p.stats.conts}`);
  // and it is heard all along, at 440 Hz
  for (let s = 3; s < 29; s += 2) {
    const a = Math.round(s * SR);
    let e = 0;
    let z = 0;
    for (let i = a; i < a + SR / 4; i++) {
      e += r.out[i] * r.out[i];
      if (i > a && (r.out[i - 1] < 0) !== (r.out[i] < 0)) z++;
    }
    assert.ok(Math.sqrt(e / (SR / 4)) > 0.1, `heard at ${s} s`);
    assert.ok(Math.abs(z / 2 / 0.25 - 440) < 25, `pitch at ${s} s: ${z / 2 / 0.25}`);
  }
});

test('a newer sound cuts the older one at the latest where it began – at most three at once, nothing queued', () => {
  const p = new SfxPlayer(SR, { burst: 0 }); // (all six arrive at one moment of real time: no burst merging here)
  const L = new Float32Array(FRAME).fill(0.3);
  for (let i = 0; i < 6; i++) {
    p.push(L, L, FRAME, [0]);
    p.push(L, L, FRAME, []); // (33 ms apart: six sounds, not one)
  }
  assert.equal(p.stats.started, 6);
  const out = new Float32Array(N);
  p.render(out, new Float32Array(N), N);
  // the three oldest fade out right away (a dropped one never comes back later)
  for (let i = 0; i < 10; i++) p.render(new Float32Array(N), new Float32Array(N), N);
  assert.ok(p.readers.length <= 3, `${p.readers.length} readers`);
  for (const x of p.readers) assert.ok(x.end === Infinity || x.pos <= x.end);
  // the older readers never play past the start of the next sound
  const starts = p.readers.map((x) => x.start);
  for (let i = 0; i + 1 < p.readers.length; i++) assert.ok(p.readers[i].end <= starts[i + 1]);
});

test('a held cursor key repeating at 17× (a key-on every 34 ms of game time, ~2 ms real): one sound per press, no buzz, never dragging on', () => {
  const k = 17;
  const p = new SfxPlayer(SR);
  const click = Math.round(0.02 * SR); // each repeat: a 20 ms 1 kHz click
  const rep = Math.round(0.034 * SR);
  const pressAt = [0.5, 1.5]; // wall seconds; each tap holds the key for 120 ms of real time = ~2 s of game time
  const hold = 0.12 * k * SR;
  const blocks = Math.ceil((2.5 * SR) / N);
  const out = new Float32Array(blocks * N);
  const L = new Float32Array(FRAME);
  const oL = new Float32Array(N);
  let made = 0;
  let due = 0;
  for (let b = 0; b < blocks; b++) {
    due += k * N;
    while (due >= FRAME) {
      const onsets = [];
      L.fill(0);
      for (const tp of pressAt) {
        const g0 = Math.round(tp * k * SR);
        for (let g = g0; g < g0 + hold; g += rep) {
          if (g >= made && g < made + FRAME) onsets.push(g - made);
          for (let i = Math.max(0, g - made); i < FRAME && made + i < g + click; i++) L[i] += 0.5 * Math.sin((2 * Math.PI * 1000 * (made + i - g)) / SR);
        }
      }
      p.push(L, L, FRAME, onsets);
      made += FRAME;
      due -= FRAME;
    }
    oL.fill(0);
    p.render(oL, oL, N);
    out.set(oL, b * N);
  }
  assert.equal(p.stats.started, 2, `started ${p.stats.started} (one per press)`);
  assert.ok(p.stats.merged > 60, `merged ${p.stats.merged}`);
  for (const tp of pressAt) {
    const s0 = Math.round(tp * SR);
    let s = s0;
    while (Math.abs(out[s]) < 0.05) s++;
    assert.ok((s - s0) / SR < 0.03, `first click ${(((s - s0) / SR) * 1000).toFixed(1)} ms after the press`);
    // the press's sound lasts at most burstCap (0.3 s) plus a fade – then quiet until the next press
    let last = s;
    for (let i = s; i < Math.min(out.length, s0 + Math.round(0.9 * SR)); i++) if (Math.abs(out[i]) > 0.01) last = i;
    assert.ok((last - s0) / SR < 0.35, `sound of the press ends ${((last - s0) / SR).toFixed(2)} s after it`);
    assert.ok(Math.max(...out.subarray(s0, s0 + Math.round(0.4 * SR)).map(Math.abs)) < 1, 'no pile-up (clipping)');
  }
});

test('where the core kept the music in (unsure), nothing is played', () => {
  const r = simulate({ k: 4, seconds: 6, presses: [1, 2, 3, 4], ok: () => false });
  assert.equal(r.player.stats.started, 0);
  assert.ok(r.out.every((x) => x === 0));
});

// ---- in the mixer ---------------------------------------------------------------------------------------------------
function pcmTrack(seconds) {
  const n = Math.round(seconds * SR);
  const l = new Int16Array(n);
  for (let i = 0; i < n; i++) l[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / SR));
  return { l, r: l.slice(), rate: SR, loop: null };
}

test('the mixer: sound effects over the ROM track only while fast-forwarding – 1× is untouched', () => {
  const run = (withSfx) => {
    const m = new TurboMixer(SR);
    m.command({ type: 'mode', mode: 'music' });
    const A = pcmTrack(20);
    m.command({ type: 'rom-track', id: 'A', kind: 'pcm', ...A });
    m.command({ type: 'rom-sync', id: 'A', pos: 0, slow: true });
    const inL = new Float32Array(N);
    const oL = new Float32Array(N);
    const oR = new Float32Array(N);
    const out = [];
    const fx = new Float32Array(FRAME).fill(0);
    for (let i = 0; i < FRAME; i++) fx[i] = 0.25 * Math.sin((2 * Math.PI * 1500 * i) / SR);
    const block = (b) => {
      for (let i = 0; i < N; i++) inL[i] = 0.1 * Math.sin((b * N + i) * 0.01);
      if (withSfx) m.sfxSound(fx, fx, FRAME, b % 50 === 0 ? [0] : [], true); // (the host sends it in fast-forward only – here always)
      m.process(inL, inL, oL, oR, N);
      out.push(...oL);
    };
    for (let b = 0; b < 200; b++) block(b);
    const one = out.splice(0);
    m.command({ type: 'speed', ratio: 4 });
    for (let b = 200; b < 600; b++) block(b);
    return { one, ff: out, m };
  };
  const a = run(false);
  const b = run(true);
  assert.deepEqual(b.one, a.one, '1×: the same, sample for sample');
  // fast-forward, after the fades: the track, plus the sound effects where they came
  let diff = 0;
  for (let i = Math.round(0.1 * SR); i < a.ff.length; i++) diff = Math.max(diff, Math.abs(b.ff[i] - a.ff[i]));
  assert.ok(diff > 0.2, `sound effects heard over the track (${diff.toFixed(2)})`);
  assert.equal(b.m.playing().src, 'rom');
  assert.ok(b.m.state().sfx.started > 0);
  // back to 1×: they fade out and stop
  b.m.command({ type: 'speed', ratio: 1 });
  const oL = new Float32Array(N);
  for (let i = 0; i < 20; i++) b.m.process(null, null, oL, new Float32Array(N), N);
  assert.equal(b.m.sv.t, 0);
  assert.equal(b.m.sfx.active, false);
});

// ---- the core's voice bookkeeping (C++, from the Azahar patch) -------------------------------------------------------
const patch = readFileSync(new URL('../native/azahar-patch/twicable-sfx.patch', import.meta.url), 'utf8');
function addedFile(name) {
  const at = patch.indexOf(`+++ b/${name}`);
  assert.ok(at >= 0, name);
  const body = patch.slice(patch.indexOf('\n@@', at) + 1);
  const end = body.indexOf('\ndiff --git');
  return (end >= 0 ? body.slice(0, end) : body).split('\n').filter((l) => !l.startsWith('@@')).map((l) => l.slice(1)).join('\n');
}
const cxx = ['c++', 'g++', 'clang++'].find((c) => spawnSync(c, ['--version']).status === 0);

test('the core: music voices recognised by the stream bytes they play (ADPCM and AAC), muted only when asked and sure', { skip: !cxx && 'no C++ compiler' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sls-sfx-'));
  try {
    writeFileSync(join(dir, 'twicable_music.h'), addedFile('src/common/twicable_music.h'));
    writeFileSync(join(dir, 't.cpp'), `
#include "twicable_music.h"
#include <cstdio>
#include <vector>
using namespace TwicableMusic;
static uint32_t rnd = 12345;
static uint8_t r8() { rnd = rnd * 1103515245u + 12345u; return (uint8_t)(rnd >> 16); }
#define CHECK(c) do { if (!(c)) { printf("fail line %d: %s\\n", __LINE__, #c); return 1; } } while (0)
static int frame(std::vector<bool> on, bool& asked, bool& muted, uint32_t& flags) {
  const bool mute = BeginFrame(asked);
  bool onset = false, music = false;
  muted = false;
  for (uint32_t i = 0; i < on.size(); i++) { bool m = VoiceFrame(i, on[i], onset); music |= m; if (mute && m) muted = true; }
  flags = EndFrame(asked, muted, music, onset);
  return 0;
}
int main() {
  // a music stream (random ADPCM-like bytes) at [0x10000, 0x30000) of RomFS 1, a sound effect elsewhere
  std::vector<uint8_t> romfs(0x40000);
  for (auto& b : romfs) b = r8();
  // AAC frames: sync words at odd places
  for (uint32_t p = 0x20003; p + 16 < 0x30000; p += 371) { romfs[p] = 0xFF; romfs[p + 1] = 0xF1; }
  CHECK(Lookup(&romfs[0x10000]) == 0); // no ranges yet: nothing is music
  const uint64_t pairs[] = {0x10000, 0x30000};
  SetRanges(1, pairs, 1);
  // the game reads the stream in blocks (one starts mid-file, unaligned to the read)
  for (uint64_t off = 0x10000; off < 0x30000; off += 0x3000) NoteRead(1, off, &romfs[off], (size_t)std::min<uint64_t>(0x3000, 0x30000 - off));
  NoteRead(1, 0x34000, &romfs[0x34000], 0x1000); // (outside the streams: not fingerprinted)
  NoteRead(2, 0x10000, &romfs[0x10000], 0x1000); // (another RomFS without ranges: not either)
  CHECK(Lookup(&romfs[0x10000]) == 1);
  CHECK(Lookup(&romfs[0x18008]) == 1); // any DSP-ADPCM frame of the file
  CHECK(Lookup(&romfs[0x18004]) == 0); // not a frame start
  CHECK(Lookup(&romfs[0x34000]) == 0);
  uint8_t flat[16] = {0x40};
  CHECK(Lookup(flat) == -1); // silence says nothing
  // voices: 0 and 1 play the stream (L, R), 5 a sound effect from memory
  OnKeyOn(0); OnBuffer(0, &romfs[0x12000], 0x800, 0x20000000, false, false);
  OnKeyOn(1); OnBuffer(1, &romfs[0x12800], 0x800, 0x20001000, false, false);
  OnKeyOn(5); OnBuffer(5, &romfs[0x35000], 0x800, 0x20008000, false, false);
  bool asked, muted; uint32_t f;
  frame({true, true, false, false, false, true}, asked, muted, f);
  CHECK(!asked && !muted && (f & F_ONSET) && (f & F_MUSIC) && !(f & F_ASKED)); // (not asked: nothing left out)
  S().mute = true;
  frame({true, true, false, false, false, true}, asked, muted, f);
  CHECK(asked && muted && !(f & F_ONSET) && !(f & F_UNSURE));
  // the stream goes on in queued buffers; a looping repeat changes nothing
  for (int i = 0; i < 10; i++) { OnBuffer(0, &romfs[0x13000 + i * 0x400], 0x400, 0, true, false); OnBuffer(0, nullptr, 0, 0, true, true); }
  CHECK(S().voices[0].music);
  // one queued buffer that doesn't match is forgiven, two in a row aren't
  OnBuffer(1, &romfs[0x35800], 0x400, 0, true, false);
  CHECK(S().voices[1].music);
  OnBuffer(1, &romfs[0x36000], 0x400, 0, true, false);
  CHECK(!S().voices[1].music);
  // a new sound on a music voice: not music any more, and it is an onset
  OnKeyOn(0); OnBuffer(0, &romfs[0x37000], 0x400, 0, false, false);
  frame({true, false, false, false, false, false}, asked, muted, f);
  CHECK(!S().voices[0].music && (f & F_ONSET) && !muted);
  // an unknown voice streaming queued buffers for half a second: unsure – nothing muted from the next frame on
  OnBuffer(0, &romfs[0x12000], 0x800, 0, false, false); // (voice 0 is music again)
  OnBuffer(7, &romfs[0x38000], 0x800, 0, true, false);
  for (uint32_t i = 0; i <= UNSURE_FRAMES; i++) frame({true, false, false, false, false, false, false, true}, asked, muted, f);
  CHECK(f & F_UNSURE);
  frame({true, false, false, false, false, false, false, true}, asked, muted, f);
  CHECK(!muted && (f & F_UNSURE) && (f & F_MUSIC));
  frame({true, false, false, false, false, false, false, false}, asked, muted, f); // (it stopped)
  frame({true, false, false, false, false, false, false, false}, asked, muted, f);
  CHECK(muted && !(f & F_UNSURE));
  // X/Y: the DSP's AAC decoder decodes a frame of the stream – its output (by address and by content) is music
  std::vector<uint8_t> pcm0(2048), pcm1(2048);
  for (auto& b : pcm0) b = r8();
  for (auto& b : pcm1) b = r8();
  NoteDecoded(&romfs[0x20003 + 371 * 5], 600, 0x21000000, pcm0.data(), 0x21010000, pcm1.data(), 2048);
  CHECK(InDecoded(0x21000400, 512) && InDecoded(0x21010000, 16) && !InDecoded(0x21002000, 16));
  OnKeyOn(9); OnBuffer(9, pcm0.data() + 512, 1024, 0x21000200, false, false); // (the game plays the PCM where it was written)
  CHECK(S().voices[9].music);
  std::vector<uint8_t> copy(pcm1.begin() + 256, pcm1.end());
  OnKeyOn(10); OnBuffer(10, copy.data(), 1024, 0x22000000, false, false); // (or a copy of it elsewhere)
  CHECK(S().voices[10].music);
  // a decode of something else (not a music stream's frame): its output isn't music
  std::vector<uint8_t> other(600);
  for (auto& b : other) b = r8();
  other[0] = 0xFF; other[1] = 0xF1;
  std::vector<uint8_t> pcm2(2048);
  for (auto& b : pcm2) b = r8();
  NoteDecoded(other.data(), 600, 0x23000000, pcm2.data(), 0, nullptr, 2048);
  CHECK(!InDecoded(0x23000000, 64));
  OnKeyOn(11); OnBuffer(11, pcm2.data(), 1024, 0x23000000, false, false);
  CHECK(!S().voices[11].music);
  SetRanges(1, nullptr, 0); // forgotten: (fingerprints already noted stay, new reads aren't)
  printf("ok %llu\\n", (unsigned long long)S().noted.load());
  return 0;
}
`);
    const exe = join(dir, process.platform === 'win32' ? 't.exe' : 't');
    const c = spawnSync(cxx, ['-std=c++17', '-O2', '-pthread', '-Wall', '-o', exe, join(dir, 't.cpp')], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok \d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the patch: the game hears everything as before – only the copy for the frontend leaves the music out; the exports', () => {
  // the final mix the game reads back (shared memory) is the full one, written before the music is taken off the
  // outgoing copy (the hunk comes after it)
  assert.match(patch, /\+ {4}TwicableMusic::EndFrame\(asked, muted, music, onset\);\n\+ {4}if \(muted\) \{/);
  assert.match(patch, /return mixers\.TwicableDownmix\(music_mixes\);/);
  // source statuses and the aux sends are made from the same mixes as always (the music voices are summed in too)
  assert.match(patch, /\+ {24}intermediate_mixes\[mix\]\[k\]\[c\] \+= own\[k\]\[c\];/);
  assert.match(patch, /^\+ {4}Twicable::Fingerprint\(romfs_file, offset, buffer, std::min\(got, length\)\);/m);
  assert.match(patch, /^\+ {4}TwicableMusic::NoteDecoded\(/m);
  for (const f of ['twicable_audio_music_ranges', 'twicable_audio_mute_music', 'twicable_audio_frame_flags', 'twicable_audio_music_state']) {
    assert.match(patch, new RegExp(`^\\+RETRO_API \\w+ ${f}\\(`, 'm'), f);
    assert.match(patch, new RegExp(`^\\+_${f}$`, 'm'), `${f} in libretro.osx.def`);
  }
  const yml = readFileSync(new URL('../.github/workflows/ctr.yml', import.meta.url), 'utf8');
  assert.equal(yml.match(/twicable_audio_frame_flags/g)?.length, 2, 'CI checks the exports on Linux and Windows');
});

test('the server passes MUSIC and SFX on only with their exact sizes', async () => {
  const { checkCommands, command, CMD, CTR_MUSIC_MAX } = await import('../server/lib/ctr.mjs');
  const music = (n, claim = n) => {
    const b = Buffer.alloc(8 + n * 16);
    b.writeUInt32LE(1, 0);
    b.writeUInt32LE(claim, 4);
    return command(CMD.MUSIC, b);
  };
  assert.ok(checkCommands(music(3)));
  assert.ok(checkCommands(music(0)));
  assert.ok(checkCommands(Buffer.concat([music(2), command(CMD.SFX, Buffer.from([1, 0, 0, 0]))])));
  const bad = (buf) => assert.throws(() => checkCommands(buf), (e) => e.status === 400 && e.code === 'badCommand');
  bad(music(3, 4));
  bad(music(CTR_MUSIC_MAX + 1));
  bad(command(CMD.SFX, Buffer.alloc(5)));
  bad(command(CMD.MUSIC, Buffer.alloc(4)));
});
