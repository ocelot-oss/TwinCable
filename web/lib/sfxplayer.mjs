// The game's sound effects while a 3DS game fast-forwards – at their normal speed and pitch, each one when it happens.
//
// With "Music continues" the turbo mixer plays the music track straight from the ROM (romvoice.mjs). The core hands out
// the game's sound without the voices that play that music (native/azahar-patch/twicable-sfx.patch, ctrhost.c message
// 11): menu clicks, cries, attacks – at the game's pace, k seconds of it per second of real time, and the places where a
// new sound began (the DSP voice's key-on). Sped up those would be chipmunk chirps, and played in full at 1× they would
// pile up and come later and later (k × more of them than fits). So every new sound starts the moment it arrives (that is
// when the game made it – the picture of the same frame is out at the same time) and plays from there at 1×, reading the
// game's sound at its own pace: its natural pitch, its first moments exactly as the game made them. The game meanwhile
// races ahead; what comes after the sound in the game's own timeline is the next sound's business:
//   - a newer sound starts a new reader right away; the older one may ring on for a moment (`overlap`) but never past
//     the point where the newer one began (it would play that one a second time, late) – then it fades out quickly;
//     at most `voices` play at once, the oldest goes first;
//   - a sound that goes on and on (battle ambience, a long cry) is played for `maxEvent` of its own length; if nothing
//     new came by then, the reader jumps to where the game is now (crossfaded) – a continuous sound goes on in pieces at
//     its natural pitch, never falling behind;
//   - nothing is ever queued for later: what plays is what the game is doing now, at most one sound's length behind.
// A WSOLA-style time-compression of each sound was the other way (all of it, k × shorter, natural pitch): it keeps the
// whole sound but smears its attack and comes out warbly at 4× and above, and it can't start a sound before the one
// before it is done. The owner's rule – each sound at normal speed and pitch, when it happens, never dragging behind –
// is what the readers do.
// Stretches the core couldn't separate (a voice it wasn't sure about: flags) come in as silence – the music track is
// already playing, the game's sound there would double it.
//
// Plain DSP without Web Audio types (AudioWorklet, node --test).

export class SfxPlayer {
  constructor(sampleRate, { seconds = 24, voices = 3, maxEvent = 1.2, overlap = 0.25, merge = 0.03, burst = 0.15, burstCap = 0.3, fadeIn = 0.002, fadeOut = 0.015, xfade = 0.02, lead = 0.01 } = {}) {
    const S = (s) => Math.max(1, Math.round(s * sampleRate));
    this.sr = sampleRate;
    this.cap = S(seconds);
    this.l = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.written = 0; // samples of the game's sound ever pushed (its own pace)
    this.rendered = 0; // samples of real time rendered so far (the clock for `burst`)
    this.k = { voices, burst: burst > 0 ? S(burst) : 0, burstCap: S(burstCap), maxEvent: S(maxEvent), overlap: S(overlap), merge: S(merge), fadeIn: S(fadeIn), fadeOut: S(fadeOut), xfade: S(xfade), lead: S(lead) };
    this.readers = []; // { start, pos, end, g, gs, played, cutIn, cont, done }
    this.newest = null;
    this.stats = { onsets: 0, merged: 0, started: 0, conts: 0, dropped: 0, underruns: 0 };
  }

  get oldest() {
    return Math.max(0, this.written - this.cap);
  }

  /** Forget everything (fast-forward began or ended, a state was loaded). */
  reset() {
    this.readers = [];
    this.newest = null;
    this.written = 0;
  }

  get active() {
    return this.readers.length > 0;
  }

  /**
   * The game's sound effects as they come (n stereo samples, its own pace) and where in them new sounds began
   * (`onsets`: offsets into this block). `ok` false: the core couldn't leave the music out here – kept as silence.
   */
  push(l, r, n = l.length, onsets = [], ok = true) {
    const base = this.written;
    let at = base % this.cap;
    for (let i = 0; i < n; i++) {
      this.l[at] = ok ? l[i] : 0;
      this.r[at] = ok ? r[i] : 0;
      if (++at === this.cap) at = 0;
    }
    this.written += n;
    if (!ok) return;
    for (const o of onsets) if (o >= 0 && o < n) this.onset(base + o);
  }

  /** A new sound began at sample `at` of the game's sound: play it from there, now. */
  onset(at) {
    this.stats.onsets++;
    const nw = this.newest;
    if (nw && !nw.done && at >= nw.start && at - nw.start < this.k.merge && !nw.cont) {
      this.stats.merged++; // (a few voices keyed on together: one sound – the reader plays all of it)
      return;
    }
    // a burst of key-ons within a few ms of real time – a held cursor key repeating at the game's 17× pace, a key-on
    // every ~2 ms here: cutting the reader at each one buzzes (~100 Hz). The burst's first key-on started the sound right
    // away; the rest are part of it – it plays on at 1× for at most `burstCap` of the game's sound, never dragging on
    if (nw && !nw.done && !nw.cont && this.rendered - nw.realStart < this.k.burst) {
      this.stats.merged++;
      nw.end = Math.min(nw.end, nw.start + this.k.burstCap);
      return;
    }
    if (nw && !nw.done) {
      nw.end = Math.min(nw.end, at);
      nw.cutIn = Math.min(nw.cutIn, this.k.overlap);
    }
    this.start(at, false, this.k.fadeIn);
    const live = this.readers.filter((x) => !x.done && x.gs >= 0);
    for (let i = 0; i < live.length - this.k.voices; i++) {
      this.fade(live[i], this.k.fadeOut);
      this.stats.dropped++;
    }
  }

  start(at, cont, fadeIn) {
    const x = { start: at, realStart: this.rendered, pos: at, end: Infinity, g: 0, gs: 1 / Math.max(1, fadeIn), played: 0, cutIn: Infinity, cont, done: false };
    this.readers.push(x);
    this.newest = x;
    this.stats[cont ? 'conts' : 'started']++;
    return x;
  }

  fade(x, len) {
    if (x.gs < 0) return;
    x.gs = -Math.max(x.g, 1e-6) / Math.max(1, len);
  }

  /** Adds the sound effects into out (n samples), at a gain going from g0 to g1 over the block. */
  render(outL, outR, n, g0 = 1, g1 = g0) {
    this.rendered += n;
    if (!this.readers.length) return;
    const k = this.k;
    const mono = outR === outL;
    const dg = (g1 - g0) / n;
    // (a copy: a continuation started below is first rendered in the next block – it starts where the game is now)
    for (const x of this.readers.slice()) {
      if (x.done) continue;
      if (x.pos < this.oldest) {
        x.done = true; // (overwritten: the game raced far ahead – nothing of it is left to play)
        continue;
      }
      // a sound that went on long enough with nothing new after it: on to where the game is now, crossfaded
      if (x === this.newest && x.played >= k.maxEvent && x.gs >= 0 && x.end === Infinity) {
        const now = Math.max(x.pos, this.written - k.lead);
        if (now > x.pos + k.xfade) {
          this.start(now, true, k.xfade);
          this.fade(x, k.xfade);
        } else x.played = 0; // (the game isn't ahead – it runs at about 1×: just go on)
      }
      if (x.cutIn <= k.fadeOut) this.fade(x, Math.max(1, x.cutIn));
      if (x.end - x.pos <= k.fadeOut + n) this.fade(x, Math.max(1, Math.min(k.fadeOut, x.end - x.pos)));
      // a new sound starts once a block's worth of it is there (the game makes its sound a frame at a time, faster than
      // real time – at most a frame's wait, instead of a hole right after the start)
      if (x.played === 0 && this.written - x.pos < n) continue;
      let g = g0;
      for (let i = 0; i < n; i++, g += dg) {
        if (x.pos >= x.end || (x.gs < 0 && x.g <= 0)) {
          x.done = true;
          break;
        }
        if (x.pos >= this.written) {
          this.stats.underruns++; // (the game isn't ahead of real time just now: wait for it)
          break;
        }
        x.g += x.gs;
        if (x.g > 1) {
          x.g = 1;
          x.gs = 0;
        }
        if (x.g < 0) x.g = 0;
        const j = x.pos % this.cap;
        const v = x.g * g;
        if (mono) outL[i] += ((this.l[j] + this.r[j]) / 2) * v;
        else {
          outL[i] += this.l[j] * v;
          outR[i] += this.r[j] * v;
        }
        x.pos++;
        x.played++;
        x.cutIn--;
      }
    }
    this.readers = this.readers.filter((x) => !x.done);
    if (this.newest?.done) this.newest = this.readers.at(-1) || null;
  }
}
