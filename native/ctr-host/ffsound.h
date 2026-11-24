// twincable's fast-forward sound, shared by the 3DS host (ctrhost.c) and the fast player's host (retro-host/retrohost.c):
// the frames' sound sped up by the real speed, resampled to exactly real time. The including file defines audio_buf /
// audio_n (the frame's s16 stereo samples), send_msg and send_event before it includes this, and calls ff_reset when
// fast-forward starts or ends and ff_frame after each fast-forwarded frame.
#ifndef TWINCABLE_FFSOUND_H
#define TWINCABLE_FFSOUND_H
// ---- fast-forward sound -------------------------------------------------------------------------------------------
// While fast-forwarding the core makes k seconds of sound per second, k being the speed it really reaches – and on a
// 3DS that swings from frame to frame (Pokémon Sun's overworld on a mid-range PC: anywhere between 1.1× and 3× within
// a second). 2.7.2 averaged every frame's sound down by the speed measured over the last quarter second and threw
// away whole frames once it was ahead of real time (as the fast player's host did until 2.8.1): with a swinging speed
// the page got too little sound, then too much, and played it with ~10 holes a second. The fast player's host
// (retrohost.c, melonDS and the other native cores) uses this code too since 2.8.2 – a DS player heard its fast-forward
// sound go out of step with the game: its ratio jumped to the speed measured every quarter second and whole frames of
// sound were left out whenever it came out ahead of real time.
// Now the frames' sound goes into a queue and comes out resampled by k, exactly as many samples as wall-clock time
// has passed – without holes. k follows the measured speed and how full the queue is (its target: FF_TMIN … FF_TARGET
// seconds, as deep as the speed makes it swing – the queue is also how late the sped-up sound comes); it
// glides (no jumps in pitch), and every change is announced right before the first sound made with it (event
// "ffrate"), so twincable's turbo mixer can slow the sound back down by exactly the ratio it was sped up with.
// Until 2.8.1 k followed the speed within 0.15 s and pulled hard on the queue (60 % faster or slower at a full target's
// error): a Windows player's Pokémon Y video (4× asked, the PC at ≈1.7–3.7×) had the sped-up sound warble by about a
// semitone, up and down every second or so – the pitch followed every swing of the speed. Now k follows the speed it
// holds over a few seconds (FF_FOLLOW), and the queue takes up the swings; it is only pulled on gently
// (FF_PULL) – hard only near empty or full, where a hole or a skip would be worse than a short change of pitch.
// The resampler is a windowed-sinc low-pass stretched by k (the sped-up sound's new Nyquist frequency) – every output
// sample its own weighted sum of the queue. Until 2.8.2 a 4th-order Butterworth went first (two biquads) and a 4-point
// Hermite read the queue: at "Max" (≈20× on a Windows player's PC, k 16) the overtones folded back down at only 28–48 dB
// below the sound (measured: a tone sped up past the new Nyquist frequency came out as an alias at −28 dB at 16 kHz,
// −42 dB at 8 kHz, −49 dB at 3 kHz) – aliased mush; now the aliases stay below −70 dB (test/ctrffsound.test.mjs).
// The queue never gets deeper than FF_LAG (0.3 s): until 2.8.2 k followed a step up of the speed over FF_FOLLOW seconds
// too, and the queue only skipped above FF_MAXK× – after 2× → 8× the sped-up sound trailed the picture by 1.5 s, after
// 2× → 30× by 4.7 s, and the 3DS host kept up to 0.45 s for a swinging speed. Now it skips ahead (a short crossfade)
// once it is deeper than FF_LAG, at any k, and a step up makes k follow within a fraction of a second (FF_RISE): the
// sped-up sound is at most ~0.3 s behind, after a step up only for a moment (test/ctrffsound.test.mjs).
// Above FF_MAXK× k can't follow: the queue skips ahead every now and then, crossfaded.
// That low-pass leaves a k-th of the bandwidth: slowed back down by the mixer ("Music continues" while a song has no
// loop yet), 4× sound kept nothing above ~1.8 kHz – muffled music. So each frame's sound also goes out as it is
// (message 8, FFSOUND), and the mixer records that one: the music at its own pace and pitch, nothing resampled.
#define FF_MAXK 16.0
#ifndef FF_TARGET // (a host may keep less)
#define FF_TARGET 0.2  // seconds of output kept in the queue at most (for a speed that swings hard; until 2.8.2: 0.45) …
#endif
#ifndef FF_TMIN
#define FF_TMIN 0.12   // … and at least (a steady speed)
#endif
#define FF_DEPTH 2.5   // the queue is kept this many times as deep as it swings around its target …
#define FF_SWING 8     // … the swing being the largest of the last few seconds (fading with this time constant) …
#define FF_SINK 0.015  // … and it gets shallower by at most this many seconds per second (deeper: within ~1 s)
#define FF_FOLLOW 5    // seconds over which the speed the sound comes in at is averaged (time constant)
#define FF_GLIDE 0.6   // seconds k takes to get where it is headed (time constant)
#define FF_PULL 0.08   // how much faster / slower k goes for a queue a whole target too full / too empty …
#define FF_EDGE 0.6    // … and, beyond this share of the target off, how much more for the rest (near empty or full)
#ifndef FF_LAG
#define FF_LAG 0.3     // seconds of output in the queue at most: deeper (the game got faster) and it skips ahead
#endif
#define FF_RISE 0.25   // the speed of the last this many seconds is what k jumps to when the game got faster (time constant) …
#define FF_CATCH 1.5   // … and for this many seconds k follows the speed that fast
#ifndef FF_HOP
#define FF_HOP 0.02    // seconds of output a skip leaves out (small: the pull on k hardly changes – no jump in pitch)
#endif
#ifndef FF_STEP
#define FF_STEP 0.08   // this many seconds skipped within about a second: the game got faster (not a swing of its speed)
#endif
#define FF_TMAX (FF_TARGET < FF_LAG * 0.67 ? FF_TARGET : FF_LAG * 0.67) // the queue's target at most
#define FF_XFADE 256   // output frames of crossfade where the queue skips ahead
#define FF_PI 3.14159265358979323846
// the resampler's kernel: a Kaiser-windowed sinc FF_ZC output samples either side (2 · FF_ZC · k taps per output
// sample), cut off at FF_CUT of the output's Nyquist frequency, so that what lies above that Nyquist frequency is
// ≥ 70 dB down before it can fold back (FF_BETA); a table of FF_NP steps per output sample, linear in between
#define FF_ZC 12
#define FF_CUT 0.78
#define FF_BETA 8.6
#define FF_NP 256
#define FF_KN (FF_ZC * FF_NP)
#define FF_HIST (FF_ZC * FF_MAXK + 4) // input frames kept before the read position (the kernel's reach at FF_MAXK)
#define FF_CHUNK 160  // output frames sent at least at a time (~5 ms)
static struct {
  float *q; // queue: interleaved stereo, `n` frames
  size_t n, cap;
  double pos;       // read position in the queue (frames, fractional)
  double k;         // the ratio in use (announced)
  double glide;     // where k is gliding
  double kin;       // the speed the sound comes in at (smoothed)
  double kfast;     // … and over the last FF_RISE seconds (what k goes to when the game got faster)
  double rise;      // seconds k still follows the speed fast (the game got faster)
  double hopped;    // seconds of output skipped lately (fading over a second)
  double due;       // output frames owed to wall-clock time
  double age;       // seconds since turbo began (the speed isn't known yet at first: k follows it faster)
  double target;    // seconds of output the queue is kept at (FF_TMIN … FF_TARGET; kept from one fast-forward to the next)
  double swing;     // how far the queue swung around it lately (seconds)
  int primed;       // the queue was full enough to start (again)
  double xpos;      // where the queue skipped from (crossfade), and how many frames of it are left
  int xleft;
  float kt[FF_KN + 2]; // the kernel, from its centre out (see ff_kernel)
  int kt_ready;
  int16_t *out;
  size_t ocap;
  uint32_t holes;   // times the queue ran dry (diagnostics: stats)
  uint32_t skips;   // times it skipped ahead
} ff;

static double ff_bessel0(double x) {
  double sum = 1, term = 1;
  for (int k = 1; k < 40; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** The kernel table: sinc(FF_CUT · x) · Kaiser(x / FF_ZC) for x = 0 … FF_ZC output samples (FF_NP steps each). */
static void ff_kernel(void) {
  const double norm = ff_bessel0(FF_BETA);
  for (int j = 0; j <= FF_KN; j++) {
    const double x = (double)j / FF_NP, t = x / FF_ZC;
    const double w = t >= 1 ? 0 : ff_bessel0(FF_BETA * sqrt(1 - t * t)) / norm;
    ff.kt[j] = (float)(j ? sin(FF_PI * FF_CUT * x) / (FF_PI * FF_CUT * x) * w : w);
  }
  ff.kt[FF_KN + 1] = 0;
  ff.kt_ready = 1;
}

/** A fresh start: turbo began (or ended). */
static void ff_reset(double k) {
  ff.n = 0;
  ff.pos = 0;
  ff.due = 0;
  ff.primed = 0;
  ff.xleft = 0;
  ff.k = ff.glide = ff.kin = ff.kfast = k;
  ff.rise = 0;
  ff.hopped = 0;
  ff.age = 0;
  ff.swing = 0;
  if (!(ff.target >= FF_TMIN && ff.target <= FF_TMAX)) ff.target = FF_TMAX; // (the first time: deep, to be safe)
  if (!ff.kt_ready) ff_kernel();
}

/** The frame's sound (n stereo frames) into the queue. */
static void ff_push(const int16_t *d, size_t n) {
  // drop what was read (but keep what the kernel reaches back to from the read position – and the crossfade's source)
  double keep = (ff.xleft && ff.xpos < ff.pos ? ff.xpos : ff.pos) - FF_HIST;
  size_t drop = keep > 0 ? (size_t)keep : 0;
  if (drop > ff.n) drop = ff.n;
  if (drop > 4096 || ff.n + n > ff.cap) {
    memmove(ff.q, ff.q + drop * 2, (ff.n - drop) * 2 * sizeof *ff.q);
    ff.n -= drop;
    ff.pos -= (double)drop;
    ff.xpos -= (double)drop;
  }
  if (ff.n + n > ff.cap) {
    size_t cap = (ff.n + n) * 2;
    float *q = realloc(ff.q, cap * 2 * sizeof *q);
    if (!q) return; // out of memory: this frame's sound is left out
    ff.q = q;
    ff.cap = cap;
  }
  float *o = ff.q + ff.n * 2;
  for (size_t i = 0; i < n * 2; i++) o[i] = d[i] / 32768.0f;
  ff.n += n;
}

/** How far the kernel reaches either side of a read position at ratio k (input frames). */
static double ff_reach(double k) { return FF_ZC * (k > 1 ? k : 1); }

/**
 * The queue at position p, both channels (o[0], o[1]): the windowed-sinc low-pass stretched by k – its cut-off follows
 * the output's Nyquist frequency – summed over the input frames it reaches (p + ff_reach(k) < n), divided by the
 * weights' sum (exactly the input's level at 0 Hz, also where the queue begins).
 */
static void ff_at(double p, double k, double *o) {
  const double s = k > 1 ? k : 1, reach = FF_ZC * s, step = FF_NP / s;
  long i = (long)ceil(p - reach), end = (long)floor(p + reach);
  if (i < 0) i = 0;
  if (end > (long)ff.n - 1) end = (long)ff.n - 1;
  const float *q = ff.q, *kt = ff.kt;
  double l = 0, r = 0, sum = 0;
  double x = (p - (double)i) * step; // the tap's distance from p, in table steps (falls by `step` per tap)
  for (; i <= end && x > 0; i++, x -= step) { // (the taps before p)
    const int j = (int)x;
    if (j >= FF_KN) continue;
    const double c = kt[j] + (kt[j + 1] - kt[j]) * (x - j);
    l += q[i * 2] * c;
    r += q[i * 2 + 1] * c;
    sum += c;
  }
  for (; i <= end; i++, x -= step) { // (p and after)
    const double ax = -x;
    const int j = (int)ax;
    if (j >= FF_KN) break;
    const double c = kt[j] + (kt[j + 1] - kt[j]) * (ax - j);
    l += q[i * 2] * c;
    r += q[i * 2 + 1] * c;
    sum += c;
  }
  if (sum > 0) l /= sum, r /= sum;
  o[0] = l;
  o[1] = r;
}

/** Up to `want` output frames into ff.out at ratio ff.k; returns how many there were. */
static size_t ff_make(size_t want) {
  const double avail = (double)ff.n - 1 - ff_reach(ff.k) - ff.pos;
  size_t m = avail > 0 ? (size_t)(avail / ff.k) : 0;
  if (m > want) m = want;
  if (ff.ocap < m) {
    int16_t *o = realloc(ff.out, m * 2 * sizeof *o);
    if (!o) return 0;
    ff.out = o;
    ff.ocap = m;
  }
  for (size_t j = 0; j < m; j++) {
    double v2[2], x2[2];
    ff_at(ff.pos, ff.k, v2);
    if (ff.xleft) { // equal-power crossfade from where the queue skipped
      const double g = (double)ff.xleft / FF_XFADE, a = sin((1 - g) * FF_PI / 2), b = sin(g * FF_PI / 2);
      ff_at(ff.xpos, ff.k, x2);
      v2[0] = v2[0] * a + x2[0] * b;
      v2[1] = v2[1] * a + x2[1] * b;
    }
    for (int c = 0; c < 2; c++) {
      double v = v2[c] * 32768;
      ff.out[j * 2 + c] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
    }
    ff.pos += ff.k;
    if (ff.xleft) {
      ff.xpos += ff.k;
      ff.xleft--;
    }
  }
  return m;
}

/** Fast-forward, after a frame: its sound into the queue, and the sped-up sound for `dt` seconds out to twincable. */
static void ff_frame(double dt, double sample_rate) {
  if (!(dt > 0)) dt = 0; // (a clock that went back: no time passed)
  ff_push(audio_buf, audio_n / 2);
  ff.due += dt * sample_rate;
  if (ff.due > sample_rate * 0.1) ff.due = sample_rate * 0.1; // stalled (loading): the page went without meanwhile
  double fill = ((double)ff.n - 1 - ff_reach(ff.k) - ff.pos) / ff.k / sample_rate; // seconds of output in the queue
  int skipped = 0;
  if (fill > (ff.rise > 0 ? FF_LAG * 0.8 : FF_LAG) && !ff.xleft) { // (k catching up with a step up: sooner)
    // more than FF_LAG behind (the game got faster than k follows, or faster than FF_MAXK×): skip ahead to the target,
    // crossfaded – the sped-up sound never trails the picture by more than that
    ff.xpos = ff.pos;
    ff.xleft = FF_XFADE;
    // (a little below FF_LAG – a swing of the speed passes, or k follows meanwhile; while k catches up with a step up
    // down to the target, and faster than FF_MAXK× – where k can't follow – down to FF_TMIN: fewer skips)
    const int pinned = ff.k >= FF_MAXK * 0.99;
    double hop = pinned ? fill - FF_TMIN : ff.rise > 0 || ff.hopped > FF_STEP ? fill - ff.target : fill - FF_LAG + FF_HOP;
    if (!pinned && hop > fill - ff.target) hop = fill - ff.target;
    if (hop < 0) hop = 0;
    ff.pos += hop * ff.k * sample_rate;
    fill -= hop;
    ff.hopped += hop;
    ff.skips++;
    skipped = 1;
  }
  // how deep the queue needs to be: as deep as the speed makes it swing (a 3DS game whose speed swings needs the most;
  // a steady one keeps only FF_TMIN – the sped-up sound that much closer to the picture). Until 2.8.2 it was always
  // FF_TARGET deep: ~0.4 s behind the picture at any speed (at 4×: 1.6 s of the game). Never more than two thirds of
  // FF_LAG: the swings have room before it skips.
  if (ff.primed && ff.rise <= 0) { // (not while k catches up with a step up of the speed: that's no swing)
    const double dev = fabs(fill - ff.target);
    ff.swing = dev > ff.swing ? dev : ff.swing * (1 - (dt < FF_SWING ? dt / FF_SWING : 1));
    double want = FF_DEPTH * ff.swing;
    if (want < FF_TMIN) want = FF_TMIN;
    if (want > FF_TMAX) want = FF_TMAX;
    if (want > ff.target) ff.target += (want - ff.target) * (dt < 1 ? dt : 1);
    else ff.target = want > ff.target - FF_SINK * dt ? want : ff.target - FF_SINK * dt;
  }
  // the ratio: the speed the sound comes in at, nudged towards the queue's target fill, gliding there (no jumps in
  // pitch); twincable hears of every change of more than 1 %, right before the sound made with it
  // (right after the switch k starts at the asked-for speed, which the PC may not reach: it follows faster at first, so
  // the queue doesn't run dry while it gets there)
  ff.age += dt;
  // The game got faster: the queue skipped again and again (more than FF_STEP within about a second – a swing of the
  // speed makes it skip once in a while at most) – k goes straight to the speed of the last moment and, for FF_CATCH
  // seconds, follows it within FF_RISE. Until 2.8.2 k only followed over FF_FOLLOW seconds, and the queue only skipped
  // above FF_MAXK×: after a step up the sped-up sound trailed the picture by seconds (2× → 8×: 1.5 s, 2× → 30×: 4.7 s).
  // Slower again: k comes down gently, the queue takes it up.
  ff.hopped *= 1 - (dt < 1 ? dt : 1);
  if (skipped && ff.hopped > FF_STEP && ff.kfast > ff.kin) {
    ff.kin = ff.kfast > FF_MAXK ? FF_MAXK : ff.kfast;
    ff.rise = FF_CATCH;
    ff.swing = 0;
  }
  const int catching = ff.rise > 0;
  if (catching) ff.rise -= dt;
  const double follow = catching ? FF_RISE : ff.age < FF_FOLLOW ? 0.25 + ff.age * (FF_FOLLOW - 0.25) / FF_FOLLOW : FF_FOLLOW;
  double glide = ff.age < FF_FOLLOW ? 0.15 + ff.age * (FF_GLIDE - 0.15) / FF_FOLLOW : FF_GLIDE;
  if (catching && glide > FF_RISE * 0.4) glide = FF_RISE * 0.4;
  if (dt > 0) {
    const double in = (double)(audio_n / 2) / (dt * sample_rate);
    ff.kin += (in - ff.kin) * (dt < follow ? dt / follow : 1);
    ff.kfast += (in - ff.kfast) * (dt < FF_RISE ? dt / FF_RISE : 1);
  }
  double e = (fill - ff.target) / ff.target;
  if (e < -1) e = -1;
  if (e > 1.5) e = 1.5;
  double pull = FF_PULL * e; // gently around the target, hard near empty or full
  if (e > FF_EDGE) pull += 0.6 * (e - FF_EDGE);
  else if (e < -FF_EDGE) pull += 0.6 * (e + FF_EDGE);
  double to = ff.kin * (1 + pull);
  if (to < 1) to = 1;
  if (to > FF_MAXK) to = FF_MAXK;
  ff.glide += (to - ff.glide) * (dt < glide ? dt / glide : 1);
  if (fabs(ff.glide / ff.k - 1) > 0.01) {
    ff.k = ff.glide;
    send_event("{\"event\":\"ffrate\",\"k\":%.4f}", ff.k);
    fill = ((double)ff.n - 1 - ff_reach(ff.k) - ff.pos) / ff.k / sample_rate;
  }
  if (!ff.primed) {
    // (re)starting: wait until the queue holds its target – one short gap instead of a crackle of small ones
    if (fill < ff.target * 0.6) {
      ff.due = 0;
      return;
    }
    ff.primed = 1;
  }
  const size_t want = (size_t)ff.due;
  if (want < FF_CHUNK) return; // (at Max a frame takes well under a millisecond: its few samples go out together)
  const size_t m = ff_make(want);
  ff.due -= (double)m;
  if (m) send_msg(3, ff.out, (uint32_t)(m * 2 * sizeof *ff.out));
  if (m + 64 < want) { // ran dry (the game stalled)
    ff.primed = 0;
    ff.holes++;
  }
}

#endif
