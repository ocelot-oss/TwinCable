// AudioWorklet of the fast player (lib/nativeplayer.mjs) and the 3DS player (lib/ctrplayer.mjs): the host's stereo
// samples (at the context's rate) go through a jitter buffer (jitterring.mjs) and twicable's turbo mixer (turboaudio.mjs)
// – at 1× the game's sound as it is, while fast-forwarding the music at normal speed ("music"), silence ("mute") or the
// sped-up original ("original"; "plain" leaves the mixer out). The hosts send fast-forward sound sped up by the real
// speed, as RetroArch does for player.html, so the mixer works here exactly as there. If the mixer ever fails, the sound
// passes through as it is.
// The 3DS page asks for a deeper buffer (processorOptions `prime`, `primeMax`, `trim`, `maxLag` – see jitterring.mjs):
// its sound arrives between pictures of up to 7 MB. Commands marked `inband` (the 3DS host's fast-forward ratio) take
// effect when the sound that arrived after them is played, not when they arrive. { type: 'ffsound', f } is the 3DS
// host's own sound while it fast-forwards (interleaved stereo, the game's pace – ctrhost.c message 8): it goes straight to
// the mixer's recording (TurboMixer.ffSound), not through the buffer – it is not played as it is, and there is k times
// more of it than real time. { type: 'sfx', f, onsets, ok } is the same with the music voices left out by the core (ctrhost.c
// message 11): the game's sound effects, played over the ROM track at their normal speed (TurboMixer.sfxSound,
// sfxplayer.mjs). { type: 'tap', frames } records what
// comes out and sends it back with the buffer's numbers (tests, diagnostics; `part: 'sfx'`: only what the sound effects add);
// the numbers also go to the page once a
// second ({ type: 'ring' }).
// A speed step, another sound mode, the game going on after a pause and 'clear' (a loaded state, a reset) are breaks the
// player asked for: the buffer starts over from its base depth (JitterRing.rebase) instead of taking them for gaps. So is
// { type: 'stall' }: the 3DS host stops between two frames to copy a save state (the play view's resume state, every
// 2 minutes) – the sound may run dry for a moment, which must not grow the buffer (and the sound's delay) for good.
// { type: 'quiet', id, ms } asks to be told ({ type: 'quiet', id }) once `ms` in a row came out nearly silent – the play
// view takes its resume state then, where the host's moment without sound isn't heard ({ type: 'quiet', cancel }: not).
import { TurboMixer } from './turboaudio.mjs';
import { JitterRing } from './jitterring.mjs';

const QUIET_PEAK = 0.01; // −40 dBFS: below it a moment counts as quiet (a scene change, a menu, a fade)

class NativeAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ring = new JitterRing(sampleRate, options?.processorOptions || {});
    this.inband = []; // [{ at, m }]
    this.inL = new Float32Array(128);
    this.inR = new Float32Array(128);
    this.ffL = new Float32Array(2048); // (the host's own fast-forward sound, split into channels)
    this.ffR = new Float32Array(2048);
    this.plain = false;
    this.broken = false;
    this.asked = { speed: null, mode: null }; // (a break only when they change)
    // what came out over the last ~0.1 s (RMS and peak of both channels) – the probe reports it (tests, diagnostics)
    this.level = { rms: 0, peak: 0 };
    this.lvl = { sum: 0, peak: 0, n: 0 };
    this.quietRun = 0; // frames in a row that came out (nearly) silent
    this.quiet = null; // { id, need }: tell the page once `need` frames in a row were silent ({ type: 'quiet' })
    this.tap = null; // { l, r, at } – a recording of what comes out ({ type: 'tap' }: tests, diagnostics)
    this.told = 0; // frames since the buffer's numbers last went to the page (once a second: diagnostics)
    this.mixer = new TurboMixer(sampleRate, { onEvent: (e) => this.port.postMessage({ type: 'mixer', e: e.type === 'probe' ? { ...e, level: this.level } : e }) });
    for (const m of options?.processorOptions?.init || []) this.command(m);
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof Float32Array) return this.ring.push(d);
      if (d === 'clear') {
        this.ring.clear();
        for (const x of this.inband.splice(0)) this.command(x.m); // (nothing left to wait for)
        return;
      }
      if (d?.type === 'ffsound') return this.ffSound(d.f);
      if (d?.type === 'sfx') return this.sfxSound(d);
      if (d?.type === 'tap') {
        const n = Math.max(0, Math.min(d.frames | 0, sampleRate * 120));
        this.tap = n ? { l: new Float32Array(n), r: new Float32Array(n), at: 0, sfx: d.part === 'sfx' } : null;
        this.mixer.sfxSolo = this.tap?.sfx ? { l: null, r: null, n: 0 } : null; // (only the sound effects' share)
        return;
      }
      if (d?.inband) this.inband.push({ at: this.ring.pushed, m: d });
      else this.command(d);
    };
  }

  command(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'mode') this.plain = m.mode === 'plain';
    if (m.type === 'paused') {
      if (this.ring.paused && !m.paused) this.ring.rebase();
      this.ring.paused = !!m.paused;
    }
    if (m.type === 'quiet') this.quiet = m.cancel ? null : { id: m.id, need: Math.round(((m.ms ?? 200) / 1000) * sampleRate) };
    if (m.type === 'stall') this.ring.rebase(); // (the host stops a moment for a save state: no gap, see ctrplayer getState)
    if ((m.type === 'speed' && m.ratio !== this.asked.speed) || (m.type === 'mode' && m.mode !== this.asked.mode)) {
      if (this.asked[m.type] !== null) this.ring.rebase();
      this.asked[m.type] = m.type === 'speed' ? m.ratio : m.mode;
    }
    try {
      this.mixer.command(m.type === 'mode' && m.mode === 'plain' ? { type: 'mode', mode: 'original' } : m);
    } catch (err) {
      this.fail(err);
    }
  }

  /** The host's own fast-forward sound (interleaved) into the mixer's recording, split into its two channels. */
  ffSound(f) {
    if (this.plain || this.broken || !(f instanceof Float32Array)) return;
    const n = f.length >> 1;
    if (this.ffL.length < n) {
      this.ffL = new Float32Array(n);
      this.ffR = new Float32Array(n);
    }
    for (let i = 0; i < n; i++) {
      this.ffL[i] = f[i * 2];
      this.ffR[i] = f[i * 2 + 1];
    }
    try {
      this.mixer.ffSound(this.ffL, this.ffR, n);
    } catch (err) {
      this.fail(err);
    }
  }

  /** The game's sound effects without its music (interleaved) into the mixer, split into its two channels. */
  sfxSound(d) {
    if (this.plain || this.broken || !(d.f instanceof Float32Array)) return;
    const n = d.f.length >> 1;
    this.split(d.f, n);
    try {
      this.mixer.sfxSound(this.ffL, this.ffR, n, d.onsets || [], d.ok !== false);
    } catch (err) {
      this.fail(err);
    }
  }

  split(f, n) {
    if (this.ffL.length < n) {
      this.ffL = new Float32Array(n);
      this.ffR = new Float32Array(n);
    }
    for (let i = 0; i < n; i++) {
      this.ffL[i] = f[i * 2];
      this.ffR[i] = f[i * 2 + 1];
    }
  }

  fail(err) {
    if (!this.broken) this.port.postMessage({ type: 'mixer', e: { type: 'error', message: String(err?.message || err) } });
    this.broken = true;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    if (this.inL.length < n) {
      this.inL = new Float32Array(n);
      this.inR = new Float32Array(n);
    }
    while (this.inband.length && this.inband[0].at <= this.ring.played) this.command(this.inband.shift().m);
    this.ring.take(this.inL, this.inR, n);
    let mixed = false;
    if (!this.plain && !this.broken) {
      try {
        this.mixer.process(this.inL, this.inR, L, R, n);
        mixed = true;
      } catch (err) {
        this.fail(err);
      }
    }
    if (!mixed) {
      L.set(this.inL.subarray(0, n));
      if (R !== L) R.set(this.inR.subarray(0, n));
    }
    this.measure(L, R, n);
    if (this.tap?.sfx) {
      const x = this.mixer.sfxSolo;
      if (x?.n === n) this.record(x.l, x.r, n);
      else this.record(this.zeros(n), this.zeros(n), n);
      if (x) x.n = 0;
    } else if (this.tap) this.record(L, R, n);
    if ((this.told += n) >= sampleRate) {
      this.told = 0;
      this.port.postMessage({ type: 'ring', ring: this.ringStats() });
    }
    return true;
  }

  zeros(n) {
    if (!this.zb || this.zb.length < n) this.zb = new Float32Array(n);
    return this.zb.subarray(0, n);
  }

  /** The buffer's numbers so far (jitterring.mjs stats) and its state now. */
  ringStats() {
    return { ...this.ring.stats, prime: this.ring.prime, lag: this.ring.lag, ratio: this.ring.ratio };
  }

  /** The tap: what came out, until it is full – then it goes to the page with the ring's numbers. */
  record(L, R, n) {
    const t = this.tap;
    const k = Math.min(n, t.l.length - t.at);
    t.l.set(L.subarray(0, k), t.at);
    t.r.set(R.subarray(0, k), t.at);
    t.at += k;
    if (t.at < t.l.length) return;
    this.tap = null;
    this.mixer.sfxSolo = null;
    this.port.postMessage({ type: 'tap', l: t.l, r: t.r, sampleRate, ring: this.ringStats() }, [t.l.buffer, t.r.buffer]);
  }

  measure(L, R, n) {
    const m = this.lvl;
    let bp = 0;
    for (let i = 0; i < n; i++) {
      const a = L[i];
      const b = R[i];
      m.sum += a * a + b * b;
      const p = Math.max(Math.abs(a), Math.abs(b));
      if (p > bp) bp = p;
    }
    if (bp > m.peak) m.peak = bp;
    m.n += n;
    this.quietRun = bp < QUIET_PEAK ? this.quietRun + n : 0;
    if (this.quiet && this.quietRun >= this.quiet.need) {
      this.port.postMessage({ type: 'quiet', id: this.quiet.id });
      this.quiet = null;
    }
    if (m.n >= sampleRate / 10) {
      this.level = { rms: Math.sqrt(m.sum / (2 * m.n)), peak: m.peak };
      m.sum = m.peak = m.n = 0;
    }
  }
}
registerProcessor('native-audio', NativeAudio);
