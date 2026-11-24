// "Music from the ROM" for 3DS games: which music stream the game plays, and where in it – read off the game's own RomFS
// reads (the emulator notes each read: native/azahar-patch/twicable-romfs.patch, ctrhost.c message 9). The turbo mixer
// then plays that track itself at normal speed while the game fast-forwards (web/lib/romvoice.mjs).
//
// Nothing here depends on file names. A file is music when its own bytes are a stream (shared/ctr/streams.mjs: BCSTM,
// ADTS AAC – a small registry) and the game reads it the way a stream is read: block after block, over time, back to
// its loop start at its end. Names only break a tie: a short stream that doesn't loop is a jingle (a fanfare, "item
// get") – the music around it goes on – and a name starting with "me_" says the same.
//
// What the reads show, measured on Pokémon Sun in Azahar (test/rommusic.test.mjs replays that log):
//   - a stream starts with its header read (0x8000 bytes from 0, the first block with it), then a burst of blocks
//     (prefill), then two blocks (0x4000 bytes of each channel) every 0.876 s – exactly as fast as they play;
//   - at the end of the stream the next read goes back to the block of the loop start;
//   - each steady read of the block starting at sample S happens when the sound of that frame starts at S − LEAD,
//     LEAD = 57 570 samples (4 blocks + 226) ± 300 – the same on every read, on two different songs. The game's sound
//     is the track itself, sample for sample (correlation 1.000 over 15 s).
// So the position is a straight line in emulated frames – pos(f) = pos(f₀) + (f − f₀) · rate · frame time – anchored at
// the stream's start (its first read, plus a few frames), refined by every steady read (the median of the last few
// disagreements), re-anchored on a loop or a restart, and wrapped at the loop. The lead per codec can be measured
// against the game's sound (setLead, web/lib/rommusic.mjs); until then the measured default.
//
// Pure logic: the RomFS tables and stream infos come in through setFiles / setInfo (the page reads them through the
// core); reads(list) says what it still needs.

import { fileAt } from './romfs.mjs';
import { cstmSampleAt, cstmSamplesThrough, adtsSampleAt, adtsSamplesThrough } from './streams.mjs';

/** One 3DS frame (268111856 Hz ARM11 clock, 4481136 ticks per frame): 547 samples of the 32728 Hz sound. */
export const FRAME_SEC = 4481136 / 268111856;
/** A short stream that doesn't loop is a jingle, not music (Pokémon Sun's longest jingle: 11.6 s). */
export const JINGLE_SEC = 20;
/** Frames the first sound of a stream comes after its first read (measured: 4.4 and 15 – the steady reads correct it). */
const START_FRAMES = 5;
/** Steady reads whose disagreement with the line is kept (the median of these moves the line). */
const KEEP = 7;
/** A disagreement above this many seconds is no drift but a jump the read didn't explain: re-anchored instead. */
const JUMP_SEC = 1.5;
/**
 * RomFS readers (tags) whose tables are kept: the one being read and the one before. Every reset or new reader gives a
 * new tag (the core counts on), and each one's file list is megabytes – an older one goes once it hasn't been read for
 * TAG_IDLE_SEC (more are kept while they are all read – a game that reads several at once – but never above TAG_HARD).
 */
export const MAX_TAGS = 2;
const TAG_IDLE_SEC = 10;
const TAG_HARD = 4;

/** The default lead (see above) for a stream: 4 blocks + 226 samples at 32728 Hz for BCSTM, about as long for others. */
export function defaultLead(info) {
  if (info.codec === 'cstm') return 4 * info.blockSamples + Math.round((226 * info.rate) / 32728);
  return Math.round(1.76 * info.rate);
}

/** Is this stream a jingle (not music to go on with)? Its own bytes first, the name only as a hint. */
export function isJingle(info, path = '') {
  const name = String(path).split('/').pop().toLowerCase();
  if (info.loop) return /^me_/.test(name) && info.samples / info.rate < JINGLE_SEC; // (a looping fanfare is rare – trust a name for it)
  return info.samples / info.rate < JINGLE_SEC || /^me_/.test(name);
}

/** The sample range a read of bytes [rel, rel + len) of the stream file covers: { s (its first), e (through) } or null. */
export function readSpan(info, rel, len) {
  if (info.codec === 'cstm') {
    const s = cstmSampleAt(info, rel);
    if (s < 0) return rel + len > info.dataStart ? { s: 0, e: cstmSamplesThrough(info, rel + len) } : null; // (the header read brings the first block along)
    return { s, e: cstmSamplesThrough(info, rel + len) };
  }
  if (info.codec === 'adts' && info.frames) {
    // (the decoder's first 1024 samples are its delay: the stream's own sample 0 comes after them)
    const d = info.priming || 0;
    const s = adtsSampleAt(info.frames, rel);
    return s < 0 ? null : { s: Math.max(0, s - d), e: Math.max(0, adtsSamplesThrough(info.frames, rel + len) - d) };
  }
  return null;
}

/** A track position from a position on the unwrapped line (loops taken: the loop repeats from its start). */
export function wrap(info, u) {
  const l = info.loop;
  if (!l || u < l.end) return Math.max(0, u);
  return l.start + ((u - l.start) % (l.end - l.start));
}

export class RomMusicTracker {
  constructor({ frameSec = FRAME_SEC, onEvent = null, onForget = null } = {}) {
    this.frameSec = frameSec;
    this.onEvent = onEvent;
    this.onForget = onForget; // (tag) – a tag's state was let go (MAX_TAGS): what the page keeps for it can go too
    this.tags = new Map(); // tag → { files: [] | null (asked), infos: Map(start → info | null | undefined) , pending: Map(start → reads[]), last (frame of its latest read) }
    this.streams = new Map(); // key `${tag}:${start}` → stream state
    this.leads = new Map(); // codec → measured lead in seconds
    this.cur = null; // the stream state of the music playing now
    this.frame = 0; // the latest frame the host reported
    this.needs = [];
  }

  emit(e) {
    try {
      this.onEvent?.(e);
    } catch {
      // the listener's problem
    }
  }

  tag(t) {
    let x = this.tags.get(t);
    if (!x) this.tags.set(t, (x = { files: undefined, infos: new Map(), pending: new Map(), early: [], last: this.frame }));
    return x;
  }

  /** Lets go of the tags not read for a while beyond the newest MAX_TAGS (never the playing music's). */
  prune() {
    if (this.tags.size <= MAX_TAGS) return;
    const keep = this.cur?.tag;
    const old = [...this.tags].filter(([t]) => t !== keep).sort((a, b) => a[1].last - b[1].last);
    for (const [t, x] of old) {
      if (this.tags.size <= MAX_TAGS) break;
      if ((this.frame - x.last) * this.frameSec < TAG_IDLE_SEC && this.tags.size <= TAG_HARD) break;
      this.forget(t);
    }
  }

  /** Forgets everything about RomFS `tag` (read again from scratch should the game read it again). */
  forget(t) {
    if (!this.tags.delete(t)) return;
    for (const [k, st] of this.streams) if (st.tag === t && st !== this.cur) this.streams.delete(k);
    try {
      this.onForget?.(t);
    } catch {
      // the listener's problem
    }
  }

  /**
   * The RomFS file list of a tag (shared/ctr/romfs.mjs romfsFiles; [] when it has none / can't be read). The reads that
   * waited for it are placed now – returns what they need (as reads()).
   */
  setFiles(t, files) {
    const x = this.tag(t);
    x.files = files || [];
    const early = x.early.splice(0);
    return early.length ? this.reads(early) : [];
  }

  /** The stream info of a file (streams.mjs sniffStream / cstmInfo, ADTS with `frames`), or null: not music. */
  setInfo(t, file, info) {
    const x = this.tag(t);
    x.infos.set(file.start, info || null);
    const queued = x.pending.get(file.start);
    x.pending.delete(file.start);
    if (info && queued) for (const r of queued) this.readStream(t, file, info, r);
    if (info && queued) this.choose();
  }

  /** The lead measured against the game's own sound for this codec (seconds). */
  setLead(codec, sec) {
    if (Number.isFinite(sec) && sec > 0 && sec < 10) this.leads.set(codec, sec);
  }

  leadOf(info) {
    const s = this.leads.get(info.codec);
    return s ? Math.round(s * info.rate) : defaultLead(info);
  }

  /** The host's frame clock (every ROMFS message, reads or not). */
  tick(frame) {
    if (frame > this.frame) this.frame = frame;
    this.choose();
  }

  /**
   * The game's reads [{ serial, tag, off, len, frame }]. Returns what's still needed to place them:
   * [{ type: 'files', tag }] (the tag's RomFS tables) and [{ type: 'head', tag, file }] (a file's first bytes).
   */
  reads(list) {
    const needs = [];
    for (const r of list) {
      if (r.frame > this.frame) this.frame = r.frame;
      const x = this.tag(r.tag);
      if (r.frame > x.last) x.last = r.frame;
      if (x.files === undefined) {
        x.files = null; // asked
        needs.push({ type: 'files', tag: r.tag });
      }
      if (!x.files) {
        if (x.early.length < 512) x.early.push(r);
        continue;
      }
      const f = fileAt(x.files, r.off);
      if (!f) continue;
      const info = x.infos.get(f.start);
      if (info === null) continue; // not music
      if (info === undefined) {
        let q = x.pending.get(f.start);
        if (!q) {
          x.pending.set(f.start, (q = []));
          x.infos.set(f.start, undefined);
          needs.push({ type: 'head', tag: r.tag, file: f });
        }
        if (q.length < 64) q.push(r);
        continue;
      }
      this.readStream(r.tag, f, info, r);
    }
    this.choose();
    this.prune();
    return needs;
  }

  /** One read of a stream file: start, resume, steady, loop. */
  readStream(t, file, info, r) {
    const span = readSpan(info, r.off - file.start, r.len);
    if (!span) return; // (only its header)
    const key = `${t}:${file.start}`;
    let st = this.streams.get(key);
    if (!st) {
      st = { key, tag: t, file, info, jingle: isJingle(info, file.path), active: false, u: 0, base: 0, end: 0, last: 0, chunk: 0, anchor: null, errs: [], steady: 0, lastFrame: -1, started: 0, loops: 0 };
      this.streams.set(key, st);
    }
    const spf = info.rate * this.frameSec;
    const gap = st.active ? (r.frame - st.lastFrame) * this.frameSec : Infinity;
    st.lastFrame = r.frame;
    st.chunk = Math.max(st.chunk, span.e - span.s); // (what one read brings – a block pair, ~20 AAC frames)
    // where this read is on the unwrapped line: a read back to the loop start goes on after the loop end. A read may
    // overlap the one before (X/Y's AAC reader starts at an aligned offset, a frame or so back): that is no jump –
    // only a read before the last one's start is
    let u = st.base + span.s;
    if (st.active && u < st.last - 64) {
      const l = info.loop || this.learnLoop(st, span);
      if (l && span.s <= l.start && l.start < span.e && st.end >= st.base + l.end - this.slack(st)) {
        st.base += l.end - l.start; // the loop: the line goes on
        st.loops++;
        u = st.base + span.s;
        st.end = Math.max(st.end, st.base + span.e);
        st.last = u;
        st.steady = -2; // (the first read after the loop comes early: the last block was short)
        this.emit({ type: 'loop', key, at: wrap(info, u) });
        return;
      }
      st.active = false; // read from somewhere else: a restart (or the game seeked)
    }
    if (st.active && u > st.end + this.slack(st)) st.active = false; // (a jump ahead: the game seeked)
    if (st.active && gap > 3 + this.leadOf(info) / info.rate) st.active = false; // (a long pause, then on: a resume)
    if (!st.active) {
      // (re)start: the first read of a burst is what plays next, a few frames later
      st.active = true;
      st.base = 0;
      u = span.s;
      st.end = span.e;
      st.last = u;
      st.anchor = { frame: r.frame + START_FRAMES, u, guess: true };
      st.errs = [];
      st.steady = -1; // the prefill burst isn't steady yet – the first read after it is
      st.started = r.frame;
      this.emit({ type: 'start', key, path: file.path, at: span.s, frame: r.frame, jingle: st.jingle });
      return;
    }
    // the new part of this read starts where the reads so far ended (the same as u for block reads)
    const fresh = Math.max(u, st.end);
    const contiguous = u <= st.end + 64 && st.base + span.e > st.end;
    st.end = Math.max(st.end, st.base + span.e);
    st.last = u;
    if (!contiguous) return;
    // a burst (the prefill, or catching up after the loop) comes within a few frames of the read before: not steady
    if (gap < 0.25) {
      st.steady = Math.min(st.steady, -1);
      return;
    }
    if (st.steady < 0) {
      st.steady++;
      if (st.steady < 0) return;
    }
    st.steady++;
    // a steady read of the data from `fresh` on: the frame's sound starts at fresh − lead
    const want = fresh - this.leadOf(info);
    const err = want - this.lineAt(st, r.frame, spf);
    if (st.anchor.guess) {
      // the first steady read beats the guess from the start (that is off by up to 15 frames, a steady read by ±300 samples)
      st.anchor = { frame: r.frame, u: want };
      st.errs = [];
      return;
    }
    if (Math.abs(err) > JUMP_SEC * info.rate) {
      if (st.steady > 2) st.anchor = { frame: r.frame, u: want }; // (the line was wrong – a pause the reads didn't show)
      st.errs = [];
      return;
    }
    st.errs.push(err);
    if (st.errs.length > KEEP) st.errs.shift();
    const med = [...st.errs].sort((a, b) => a - b)[st.errs.length >> 1];
    if (st.errs.length >= 3 && Math.abs(med) > 32) {
      st.anchor = { frame: st.anchor.frame, u: st.anchor.u + med };
      st.errs = st.errs.map((e) => e - med);
    }
  }

  /** How far from the end a read back still counts as the loop (two reads' worth – blocks or AAC frames). */
  slack(st) {
    return 2 * Math.max(st.info.blockSamples || 0, st.chunk || 0) + 2048;
  }

  /** A stream without loop points that reads back: its loop from the reads (the block read back to, the end of the data). */
  learnLoop(st, span) {
    const info = st.info;
    const endSample = st.end - st.base;
    if (endSample < info.samples - this.slack(st)) return null; // (not at its end: a seek)
    info.loop = { start: span.s, end: info.samples, learned: true };
    this.emit({ type: 'learned', key: st.key, loop: info.loop });
    return info.loop;
  }

  /**
   * The game's own sound says the line is `err` samples off (web/lib/rommusic.mjs calibrate – measured at `frame`). A
   * line placed only by the start (no steady reads yet – or a reader whose reads don't show it) takes it as it is; one
   * placed by steady reads moves too, and the lead with it, so the next steady reads agree.
   */
  nudge(err, { codec = null } = {}) {
    const st = this.cur;
    if (!st?.anchor || !Number.isFinite(err)) return false;
    if (!st.anchor.guess && (codec == null || codec === st.info.codec)) this.setLead(st.info.codec, (this.leadOf(st.info) - err) / st.info.rate);
    st.anchor = { frame: st.anchor.frame, u: st.anchor.u + err, guess: false, heard: true };
    st.errs = [];
    this.emit({ type: 'anchor', key: st.key, err: Math.round(err), heard: true });
    return true;
  }

  lineAt(st, frame, spf = st.info.rate * this.frameSec) {
    return st.anchor.u + (frame - st.anchor.frame) * spf;
  }

  /**
   * The music playing at `frame` (default: the latest reported): { key, tag, file, info, pos (the track sample at the
   * start of that frame's sound), u (on the unwrapped line), loops } or null.
   */
  playing(frame = this.frame) {
    const st = this.cur;
    if (!st) return null;
    const u = Math.max(st.anchor.u, this.lineAt(st, frame));
    return { key: st.key, tag: st.tag, file: st.file, info: st.info, pos: wrap(st.info, u), u, loops: st.loops };
  }

  /** Which stream is the music now: the latest started one still being read (jingles never). */
  choose() {
    let best = null;
    for (const st of this.streams.values()) {
      if (!st.active) continue;
      // read everything it read (and the lead) – and nothing for a while: it ended or the game stopped it
      const spf = st.info.rate * this.frameSec;
      const silent = (this.frame - st.lastFrame) * this.frameSec;
      if (this.lineAt(st, this.frame, spf) > st.end + 0.5 * st.info.rate && silent > 2) {
        st.active = false;
        this.emit({ type: 'stop', key: st.key });
        continue;
      }
      if (st.jingle) continue;
      if (!best || st.started > best.started) best = st;
    }
    if (best !== this.cur) {
      this.cur = best;
      this.emit({ type: 'track', key: best?.key ?? null, path: best?.file.path ?? null });
    }
  }
}
