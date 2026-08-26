/**
 * ALPHA AIRCRAFT RACE 3D — audio.js
 * ---------------------------------------------------------------------------
 * Every sound in the game is synthesised at runtime with the Web Audio API:
 * no audio files to download, no decode stalls, and the engine note can be
 * driven continuously by the flight model instead of crossfading samples.
 *
 *   AudioSystem  — context, buses, settings, lifecycle
 *   EngineSynth  — continuous turbine + reheat, driven by speed/throttle/boost
 *   AmbienceSynth— wind, rain, snow hiss, cavern tone
 *   SFXKit       — one-shot UI and gameplay sounds
 *   MusicEngine  — generative adaptive score
 *
 * Everything is defensive: if the AudioContext is unavailable or blocked the
 * game carries on silently rather than throwing.
 */

import { clamp, clamp01, lerp } from './config.js';

const NOTE = (semitonesFromA4) => 440 * Math.pow(2, semitonesFromA4 / 12);

/* ===========================================================================
 * ENGINE
 * ======================================================================== */

/**
 * Haas widener.
 *
 * Everything in this engine is synthesised mono, and mono broadband noise sits
 * as a point in the centre of the head — which is exactly why the jet read as
 * small. Delaying one channel by a few milliseconds and rolling its top off
 * slightly makes the same signal occupy the full stereo field without any
 * comb-filtering you can hear, and it is the single biggest difference on
 * headphones. `bass` is fed straight through: low frequencies carry no useful
 * localisation and splitting them just thins the low end.
 */
function widener(ctx, dest, delayMs = 11, tilt = 4200) {
  const input = ctx.createGain();
  const merge = ctx.createChannelMerger(2);

  const left = ctx.createGain();
  input.connect(left);
  left.connect(merge, 0, 0);

  const delay = ctx.createDelay(0.05);
  delay.delayTime.value = delayMs / 1000;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass'; tone.frequency.value = tilt; tone.Q.value = 0.4;
  input.connect(delay); delay.connect(tone); tone.connect(merge, 0, 1);

  merge.connect(dest);
  return input;
}

/**
 * A military turbofan, not an engine block.
 *
 * The distinguishing sound of a fighter is a stack of *inharmonic* blade-
 * passing tones from the fan and compressor sitting on top of an enormous
 * broadband core roar — not the buzzy sawtooth of a piston engine, which is
 * what this used to be and why it read as a car. Seven layers:
 *
 *   fan      — blade-passing partials at non-integer multiples of N1, swept
 *              through a resonant bandpass. This is the "whine".
 *   buzzsaw  — a detuned pair that beats against the fan once N1 is high,
 *              giving the shimmering edge a real intake has at speed.
 *   core     — band-passed noise: combustion and the exhaust column, the body
 *              of the sound and most of its level.
 *   rumble   — the low band of that column, kept centred and pushed hard. This
 *              is the chest-hit, and it is what makes it read as military
 *              rather than as an airliner going over.
 *   sub      — a pure tone well below the blade-passing fundamental, so the
 *              weight survives on headphones and small speakers.
 *   hiss     — high-passed noise, the tearing edge of the exhaust plume.
 *   reheat   — sub-bass rumble with an unstable amplitude, plus a mid-band
 *              roar. Afterburners are not smooth, and the wobble is the tell.
 *
 * Airframe noise (the air itself) rides on top, scaled with V², so speed is
 * audible even at idle thrust. Everything but the bass is widened across the
 * stereo field; a low shelf on the way out weights the whole engine downward.
 */
class EngineSynth {
  constructor(ctx, dest, noiseBuffer) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;

    /* ---- output chain ----------------------------------------------------
     * The jet is voiced through a low shelf before it reaches the bus, so the
     * whole engine is weighted toward the bottom of the spectrum the way a
     * real one is at close range. Mid and top go through the widener; the
     * sub-bass bypasses it and stays centred. */
    this.shelf = ctx.createBiquadFilter();
    this.shelf.type = 'lowshelf';
    this.shelf.frequency.value = 190;
    this.shelf.gain.value = 8.5;
    this.out.connect(this.shelf);
    this.shelf.connect(dest);

    this.stereo = widener(ctx, this.out, 12, 5200);
    this.centre = this.out;                     // sub-bass path, no widening

    this.running = false;
    this.n1 = 0;              // spool state, 0..1 — lags the throttle
    this.ignitionUntil = 0;

    const noiseSource = (filterType, freq, q, target = this.stereo) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = filterType; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(target);
      return { src, filter: f, gain: g };
    };

    /* ---- fan and compressor: inharmonic blade-passing tones ------------- */
    this.fanFilter = ctx.createBiquadFilter();
    this.fanFilter.type = 'bandpass';
    this.fanFilter.frequency.value = 900;
    this.fanFilter.Q.value = 1.5;
    this.fanFilter.connect(this.stereo);

    // Deliberately non-integer: a turbofan's tones do not line up into a
    // musical harmonic series, and integer multiples sound like an organ.
    this.fan = [];
    for (const [mult, gain, type, detune] of [
      [1.00, 0.055, 'sine', 0],
      [2.07, 0.042, 'sine', 6],
      [3.19, 0.030, 'triangle', -8],
      [4.41, 0.022, 'sine', 11],
      [6.13, 0.014, 'sine', -14],
      [8.90, 0.009, 'sine', 17],
    ]) {
      const o = ctx.createOscillator();
      o.type = type; o.detune.value = detune; o.frequency.value = 120 * mult;
      const g = ctx.createGain(); g.gain.value = gain;
      o.connect(g); g.connect(this.fanFilter);
      this.fan.push({ osc: o, mult, base: gain, gain: g });
    }

    /* ---- buzzsaw: two close tones that beat as the fan spins up --------- */
    this.buzz = [];
    this.buzzGain = ctx.createGain();
    this.buzzGain.gain.value = 0;
    this.buzzGain.connect(this.fanFilter);
    for (const detune of [-9, 11]) {
      const o = ctx.createOscillator();
      o.type = 'triangle'; o.detune.value = detune; o.frequency.value = 1400;
      o.connect(this.buzzGain);
      this.buzz.push(o);
    }

    /* ---- core roar, exhaust hiss, airframe ------------------------------ */
    this.core = noiseSource('bandpass', 240, 0.55);
    this.hiss = noiseSource('highpass', 2600, 0.7);
    this.airframe = noiseSource('highpass', 900, 0.5);

    /* ---- sub-bass: the part you feel -------------------------------------
     * Two centred layers under everything else. `rumble` is the low band of
     * the exhaust column — the chest-hit — and `sub` is a pure tone an octave
     * and a half below the blade-passing fundamental, which is what gives a
     * military jet its weight on headphones where a small speaker cannot
     * reproduce the noise floor down there at all. */
    this.rumble = noiseSource('lowpass', 90, 1.6, this.centre);
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 42;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.sub.connect(this.subGain); this.subGain.connect(this.centre);

    /* ---- reheat: sub rumble with an unstable amplitude ------------------- */
    this.reheat = noiseSource('lowpass', 130, 1.1, this.centre);
    this.reheatMid = noiseSource('bandpass', 420, 0.8);
    this.instability = ctx.createGain();
    this.instability.gain.value = 1;
    // Two incommensurate LFOs so the wobble never settles into a pattern.
    this.lfoA = ctx.createOscillator(); this.lfoA.frequency.value = 7.3;
    this.lfoB = ctx.createOscillator(); this.lfoB.frequency.value = 11.9;
    this.lfoAG = ctx.createGain(); this.lfoAG.gain.value = 0;
    this.lfoBG = ctx.createGain(); this.lfoBG.gain.value = 0;
    this.lfoA.connect(this.lfoAG); this.lfoAG.connect(this.reheat.gain.gain);
    this.lfoB.connect(this.lfoBG); this.lfoBG.connect(this.reheatMid.gain.gain);

    /* ---- damage: compressor stall stutter -------------------------------- */
    this.damageOsc = ctx.createOscillator();
    this.damageOsc.type = 'sawtooth';
    this.damageOsc.frequency.value = 41;
    this.damageGain = ctx.createGain();
    this.damageGain.gain.value = 0;
    const df = ctx.createBiquadFilter();
    df.type = 'lowpass'; df.frequency.value = 260;
    this.damageOsc.connect(this.damageGain); this.damageGain.connect(df); df.connect(this.centre);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const t = this.ctx.currentTime;
    try {
      for (const f of this.fan) f.osc.start(t);
      for (const b of this.buzz) b.start(t);
      for (const n of [this.core, this.hiss, this.airframe, this.reheat, this.reheatMid, this.rumble]) n.src.start(t);
      this.lfoA.start(t); this.lfoB.start(t);
      this.sub.start(t);
      this.damageOsc.start(t);
    } catch (e) { /* already started */ }
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(1, t + 0.45);
  }

  /**
   * Cold start: the starter motor winds the fan up, the igniters light the
   * can, and the core settles to idle. Called once when a run begins.
   */
  ignite() {
    const t = this.ctx.currentTime;
    this.n1 = 0;
    this.ignitionUntil = t + 2.6;
    // A short low thump as the fuel lights.
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + 1.15);
    g.gain.exponentialRampToValueAtTime(0.34, t + 1.22);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
    const src = this.ctx.createBufferSource();
    src.buffer = this.core.src.buffer;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(90, t + 1.15);
    f.frequency.exponentialRampToValueAtTime(700, t + 2.0);
    src.connect(f); f.connect(g); g.connect(this.out);
    src.start(t + 1.1); src.stop(t + 2.2);
  }

  stop() {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + 0.4);
  }

  /** @param s {speed01, throttle, boost, turbo, accel, damage01, altitude01} */
  update(s) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const set = (param, v, k = 0.09) => param.setTargetAtTime(v, t, k);

    /* Every field defaults. An AudioParam handed a NaN throws, and one throw
     * inside the engine update leaves the whole synth half-written for the
     * rest of the frame — so a caller that omits a field gets silence in that
     * channel rather than taking the engine down with it. `clamp01(undefined)`
     * is NaN, not 0, which is exactly the trap this closes. */
    const spd = clamp01(s.speed01 ?? 0);
    const boost = clamp01(s.boost ?? 0);
    const thr = clamp01(s.throttle ?? 1);
    /* The Turbo stage, and how hard the airframe is CHANGING speed.
     *
     * Turbo is its own channel rather than more `boost` because the two
     * together are the only route to the top of the envelope, and the ear
     * should be able to tell that both are lit — a combined run has to sound
     * like more engine than either one alone, not like the same engine louder.
     *
     * `accel` is signed. Gaining speed loads the core up; shedding it — the
     * air brake — unloads it, which is what makes F audible as well as
     * visible. Without this the note tracked speed alone, so working up to
     * Mach 20 and sitting at Mach 20 sounded exactly the same. */
    const turbo = clamp01(s.turbo ?? 0);
    const accel = clamp(s.accel ?? 0, -1, 1);
    const gaining = Math.max(0, accel);
    const losing = Math.max(0, -accel);

    // N1 lags: a big fan takes seconds to spool, and hearing that lag is most
    // of what separates a jet from anything with pistons.
    const spooling = t < this.ignitionUntil;
    const n1Target = spooling ? 0.34 : clamp01(0.30 + thr * 0.42 + spd * 0.36
      + boost * 0.22 + turbo * 0.14 + gaining * 0.09 - losing * 0.12);
    this.n1 += (n1Target - this.n1) * (spooling ? 0.010 : 0.030);
    const n1 = this.n1;

    // Blade-passing fundamental: ~95 Hz at idle to ~430 Hz at full chat.
    const f0 = lerp(95, 430, Math.pow(n1, 1.15));
    for (const f of this.fan) {
      set(f.osc.frequency, f0 * f.mult, 0.12);
      // Higher partials only appear as the fan loads up.
      set(f.gain.gain, f.base * lerp(0.35, 1.25, n1) * (f.mult > 4 ? n1 : 1));
    }
    set(this.fanFilter.frequency, lerp(600, 3600, Math.pow(n1, 0.8)), 0.12);
    set(this.fanFilter.Q, lerp(1.1, 3.4, n1));

    // Buzzsaw only bites near military power.
    const buzz = clamp01((n1 - 0.62) / 0.38);
    for (const b of this.buzz) set(b.frequency, f0 * 5.4, 0.12);
    set(this.buzzGain.gain, buzz * 0.030 * lerp(0.6, 1.0, thr));

    // Core roar — the body of the sound. Voiced lower and louder than a
    // civil turbofan: the combustion band on a military engine sits well under
    // 500 Hz and it is most of what you hear from behind.
    set(this.core.filter.frequency, lerp(130, 620, n1), 0.12);
    set(this.core.gain.gain, lerp(0.09, 0.52, n1) * lerp(0.75, 1.15, thr));

    // Sub-bass. The rumble tracks thrust; the tone tracks the fan an octave
    // and a half down, so it moves with the engine instead of droning.
    set(this.rumble.filter.frequency, lerp(62, 128, n1), 0.15);
    set(this.rumble.gain.gain, lerp(0.10, 0.44, Math.pow(n1, 0.85)) + boost * 0.42 + turbo * 0.26);
    set(this.sub.frequency, clamp(f0 * 0.34, 26, 118), 0.14);
    set(this.subGain.gain, lerp(0.045, 0.185, Math.pow(n1, 1.2)) + boost * 0.19 + turbo * 0.12);
    // Exhaust tearing. Tears harder while the airframe is still gaining.
    set(this.hiss.filter.frequency, lerp(2200, 5200, spd));
    set(this.hiss.gain.gain, lerp(0.012, 0.095, Math.pow(spd, 1.3))
      + boost * 0.105 + turbo * 0.06 + gaining * 0.045);
    // Airframe: the air itself, which is loud in a fast jet even at idle.
    set(this.airframe.filter.frequency, lerp(700, 1800, spd));
    set(this.airframe.gain.gain, Math.pow(spd, 1.9) * 0.115);

    /* Reheat: unstable by nature, and enormous. Both stages feed it and the
     * combined figure is allowed past what either reaches alone — nitrous and
     * Turbo together is the loudest the aircraft ever is, and it should be
     * unmistakably that rather than a slightly hotter version of nitrous. */
    const fire = clamp01(boost * 0.78 + turbo * 0.46);
    set(this.reheat.gain.gain, fire * 0.86 + Math.pow(n1, 3) * 0.05);
    set(this.reheat.filter.frequency, lerp(95, 178, fire));
    set(this.reheatMid.gain.gain, fire * 0.40);
    set(this.reheatMid.filter.frequency, lerp(300, 680, fire));
    // The instability itself: a bigger plume flickers harder.
    set(this.lfoAG.gain, fire * 0.21);
    set(this.lfoBG.gain, fire * 0.115);

    // A damaged compressor stalls and surges.
    const dmg = clamp01(((s.damage01 ?? 0) - 0.45) / 0.55);
    set(this.damageGain.gain, dmg * 0.055 * (0.4 + Math.random() * 0.6), 0.05);
    if (dmg > 0.02) this.damageOsc.frequency.setTargetAtTime(31 + Math.random() * 34, t, 0.06);

    // Thin air carries less of the note.
    set(this.out.gain, lerp(1, 0.74, clamp01(s.altitude01 || 0)));
  }

  dispose() {
    try {
      for (const f of this.fan) f.osc.stop();
      for (const b of this.buzz) b.stop();
      for (const n of [this.core, this.hiss, this.airframe, this.reheat, this.reheatMid, this.rumble]) n.src.stop();
      this.lfoA.stop(); this.lfoB.stop(); this.sub.stop(); this.damageOsc.stop();
    } catch (e) { /* not started */ }
    this.out.disconnect();
  }
}

/* ===========================================================================
 * AMBIENCE
 * ======================================================================== */

class AmbienceSynth {
  constructor(ctx, dest, noiseBuffer) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(dest);

    const mkNoise = (type, freq, q, gain) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = gain;
      src.connect(f); f.connect(g); g.connect(this.out);
      return { src, filter: f, gain: g, started: false };
    };

    this.wind = mkNoise('bandpass', 480, 0.6, 0);
    this.rain = mkNoise('highpass', 2400, 0.4, 0);
    this.hiss = mkNoise('bandpass', 6200, 1.4, 0);   // snow / dust
    this.cavern = mkNoise('lowpass', 180, 1.0, 0);

    // Slow LFO so the wind breathes instead of sitting there.
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.11;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 260;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.wind.filter.frequency);
  }

  start() {
    const t = this.ctx.currentTime;
    for (const n of [this.wind, this.rain, this.hiss, this.cavern]) {
      if (!n.started) { try { n.src.start(t); n.started = true; } catch (e) { /* noop */ } }
    }
    try { this.lfo.start(t); } catch (e) { /* noop */ }
  }

  set(weather, speed01, cavern = 0) {
    const t = this.ctx.currentTime;
    const s = (p, v) => p.setTargetAtTime(v, t, 0.35);
    const w = weather || {};
    s(this.wind.gain.gain, 0.020 + speed01 * 0.085 + (w.wind || 0) * 0.05);
    s(this.wind.filter.frequency, 380 + speed01 * 1400);
    s(this.rain.gain.gain, w.precip === 'rain' ? 0.035 + (w.precipRate || 0) * 0.075 : 0);
    s(this.hiss.gain.gain, (w.precip === 'snow' || w.precip === 'dust') ? 0.020 + (w.precipRate || 0) * 0.035 : 0);
    s(this.cavern.gain.gain, cavern * 0.06);
  }

  dispose() {
    try {
      for (const n of [this.wind, this.rain, this.hiss, this.cavern]) n.src.stop();
      this.lfo.stop();
    } catch (e) { /* noop */ }
    this.out.disconnect();
  }
}

/* ===========================================================================
 * SFX KIT
 * ======================================================================== */

class SFXKit {
  constructor(ctx, dest, noiseBuffer) {
    this.ctx = ctx;
    this.dest = dest;
    this.noiseBuffer = noiseBuffer;
    this.last = new Map();
  }

  _tone({ freq = 440, type = 'sine', dur = 0.15, gain = 0.3, sweep = 0, attack = 0.005, curve = 'exp', detune = 0, filter = null, delay = 0 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep) {
      const target = Math.max(20, freq + sweep);
      if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(target, t0 + dur);
      else osc.frequency.linearRampToValueAtTime(target, t0 + dur);
    }
    let node = osc;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type || 'lowpass';
      f.frequency.setValueAtTime(filter.freq || 1200, t0);
      if (filter.sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, filter.freq + filter.sweep), t0 + dur);
      f.Q.value = filter.q || 1;
      node.connect(f); node = f;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    node.connect(g); g.connect(this.dest);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    return { osc, gain: g };
  }

  _noise({ dur = 0.3, gain = 0.3, type = 'lowpass', freq = 1200, sweep = -900, q = 1, attack = 0.004, delay = 0 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(50, freq + sweep), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.dest);
    src.start(t0); src.stop(t0 + dur + 0.02);
    return src;
  }

  /** Rate-limit a sound so rapid events do not stack into mush. */
  _guard(name, ms) {
    const now = performance.now();
    if (this.last.get(name) > now - ms) return false;
    this.last.set(name, now);
    return true;
  }

  play(name, opts = {}) {
    const v = opts.volume ?? 1;
    switch (name) {
      /* ---- UI ---- */
      // UI sounds share a house style: a short filtered transient over a low
      // body note, so they sit in the same mix as the jet rather than sounding
      // like a different application. Every one is guarded — the menu fires
      // these on pointer move and they would otherwise stack into a buzz.
      case 'hover':
        if (!this._guard('hover', 40)) return;
        this._tone({ freq: 1240, type: 'sine', dur: 0.05, gain: 0.060 * v, sweep: 210 });
        this._noise({ dur: 0.03, gain: 0.022 * v, type: 'highpass', freq: 5200, sweep: 1800 });
        break;
      case 'click':
        this._tone({ freq: 740, type: 'square', dur: 0.055, gain: 0.10 * v, sweep: -240,
          filter: { type: 'lowpass', freq: 2600 } });
        this._noise({ dur: 0.045, gain: 0.055 * v, type: 'highpass', freq: 2800, sweep: 1500 });
        this._tone({ freq: 118, type: 'sine', dur: 0.09, gain: 0.11 * v, sweep: -30 });
        break;
      case 'select':
        this._tone({ freq: 620, type: 'triangle', dur: 0.10, gain: 0.12 * v, sweep: 400 });
        this._tone({ freq: 930, type: 'sine', dur: 0.16, gain: 0.085 * v, delay: 0.05 });
        this._tone({ freq: 96, type: 'sine', dur: 0.16, gain: 0.14 * v, sweep: -22 });
        this._noise({ dur: 0.06, gain: 0.04 * v, type: 'bandpass', freq: 3600, sweep: 1200, q: 2 });
        break;
      case 'back':
        this._tone({ freq: 520, type: 'triangle', dur: 0.12, gain: 0.11 * v, sweep: -230 });
        this._tone({ freq: 88, type: 'sine', dur: 0.18, gain: 0.13 * v, sweep: -18 });
        break;
      case 'confirm':
        this._tone({ freq: 523, type: 'sine', dur: 0.14, gain: 0.13 * v });
        this._tone({ freq: 784, type: 'sine', dur: 0.20, gain: 0.12 * v, delay: 0.08 });
        this._tone({ freq: 1046, type: 'sine', dur: 0.30, gain: 0.10 * v, delay: 0.16 });
        // Launch has weight under it — it is the biggest button in the game.
        this._tone({ freq: 65, type: 'sine', dur: 0.55, gain: 0.22 * v, sweep: -14 });
        this._noise({ dur: 0.42, gain: 0.09 * v, type: 'bandpass', freq: 900, sweep: 1600, q: 1.2 });
        break;
      case 'error':
        this._tone({ freq: 180, type: 'sawtooth', dur: 0.20, gain: 0.09 * v, sweep: -60, filter: { type: 'lowpass', freq: 900 } });
        break;
      case 'toggle':
        this._tone({ freq: opts.on ? 900 : 600, type: 'square', dur: 0.05, gain: 0.06 * v, filter: { type: 'lowpass', freq: 2200 } });
        break;
      case 'slider':
        if (!this._guard('slider', 28)) return;
        this._tone({ freq: 1400 + (opts.value || 0) * 900, type: 'sine', dur: 0.03, gain: 0.025 * v });
        break;

      /* ---- gameplay ---- */
      case 'checkpoint':
        this._tone({ freq: 660, type: 'sine', dur: 0.18, gain: 0.14 * v, sweep: 340 });
        this._tone({ freq: 990, type: 'triangle', dur: 0.26, gain: 0.10 * v, delay: 0.06 });
        this._noise({ dur: 0.30, gain: 0.05 * v, type: 'bandpass', freq: 2400, sweep: 2600, q: 2 });
        break;
      case 'ring':
        if (!this._guard('ring', 45)) return;
        this._tone({ freq: 1250 + (opts.pitch || 0) * 220, type: 'sine', dur: 0.10, gain: 0.075 * v, sweep: 420 });
        break;
      case 'ringBoost':
        this._tone({ freq: 420, type: 'sawtooth', dur: 0.28, gain: 0.11 * v, sweep: 900, filter: { type: 'lowpass', freq: 900, sweep: 3200, q: 4 } });
        break;
      case 'collision':
        // Airframe strike: skin panel deforming, then the structure ringing,
        // with a real impact under it.
        this._noise({ dur: 0.07, gain: 0.60 * v, type: 'highpass', freq: 3600, sweep: -2100, attack: 0.0008 });
        this._noise({ dur: 0.50, gain: 0.44 * v, type: 'bandpass', freq: 1500, sweep: -1220, q: 1.6 });
        this._tone({ freq: 138, type: 'triangle', dur: 0.40, gain: 0.40 * v, sweep: -92, filter: { type: 'lowpass', freq: 620 } });
        this._tone({ freq: 46, type: 'sine', dur: 0.70, gain: 0.55 * v, sweep: -16, attack: 0.003 });
        break;
      case 'explosion':
        /* A detonation, in the order a detonation happens.
         *
         * The CRACK is the shock front and it is over in under a tenth of a
         * second. The BODY is the deflagration behind it. The RUMBLE is what
         * you feel rather than hear, and it is the longest-lived thing here —
         * a big warhead is still moving air a second and a half later. Then
         * the debris, and finally the reflection off whatever is around you,
         * which is the layer that tells the ear this happened somewhere with
         * ground under it rather than in a vacuum.
         * ------------------------------------------------------------------ */
        // 1. Shock front — the crack.
        this._noise({ dur: 0.055, gain: 0.80 * v, type: 'highpass', freq: 5200, sweep: -3400, attack: 0.0005 });
        this._noise({ dur: 0.10, gain: 0.62 * v, type: 'bandpass', freq: 2100, sweep: -1500, q: 0.8, attack: 0.0008 });
        // 2. Body — the fuel going off.
        this._tone({ freq: 124, type: 'sawtooth', dur: 0.34, gain: 0.72 * v, sweep: -88, attack: 0.0018,
          filter: { type: 'lowpass', freq: 940, sweep: -700, q: 2.2 } });
        this._noise({ dur: 0.55, gain: 0.70 * v, type: 'lowpass', freq: 1800, sweep: -1560, q: 0.8, attack: 0.006 });
        // 3. Rumble — three sub layers, each longer and lower than the last.
        this._tone({ freq: 58, type: 'sine', dur: 1.7, gain: 0.92 * v, sweep: -24, attack: 0.004 });
        this._tone({ freq: 29, type: 'sine', dur: 2.4, gain: 0.74 * v, sweep: -10, attack: 0.012 });
        this._tone({ freq: 19, type: 'sine', dur: 3.0, gain: 0.46 * v, sweep: -5, attack: 0.030, delay: 0.05 });
        // 4. Debris, and then the reflection coming back off the world.
        this._noise({ dur: 1.9, gain: 0.52 * v, type: 'lowpass', freq: 2600, sweep: -2400, q: 0.7, delay: 0.10 });
        this._noise({ dur: 1.3, gain: 0.30 * v, type: 'bandpass', freq: 2200, sweep: -1750, q: 0.9, delay: 0.28 });
        this._noise({ dur: 1.6, gain: 0.20 * v, type: 'lowpass', freq: 700, sweep: -520, q: 0.6, delay: 0.46 });
        break;
      case 'shield':
        this._tone({ freq: 300, type: 'sine', dur: 0.55, gain: 0.13 * v, sweep: 500, filter: { type: 'bandpass', freq: 900, q: 6 } });
        break;
      case 'boost':
        // Reheat light-off: raw fuel hits the jet pipe and goes off with a
        // thump, then the plume settles into a roar.
        if (!this._guard('boost', 340)) return;
        this._tone({ freq: 62, type: 'sine', dur: 0.42, gain: 0.26 * v, sweep: -18 });
        this._noise({ dur: 0.14, gain: 0.24 * v, type: 'lowpass', freq: 420, sweep: 900, q: 1.2 });
        this._noise({ dur: 0.75, gain: 0.19 * v, type: 'bandpass', freq: 260, sweep: 1500, q: 1.1, delay: 0.05 });
        break;
      case 'burnerLight': {
        // The fire itself: raw fuel dumped into the jet pipe going off. A hard
        // percussive crack, a low detonation body that drops an octave, then a
        // long roaring wash of flame that decays as the plume stabilises. This
        // is deliberately loud — it is the loudest single event in the game.
        if (!this._guard('burnerLight', 300)) return;
        this._noise({ dur: 0.055, gain: 0.52 * v, type: 'highpass', freq: 2600, sweep: 5200, attack: 0.001 });
        this._tone({ freq: 132, type: 'sawtooth', dur: 0.30, gain: 0.40 * v, sweep: -96, attack: 0.002,
          filter: { type: 'lowpass', freq: 900, sweep: -520, q: 2.2 } });
        this._tone({ freq: 47, type: 'sine', dur: 0.90, gain: 0.46 * v, sweep: -17, attack: 0.004 });
        // The flame front: broadband roar opening up and then burning down.
        this._noise({ dur: 0.34, gain: 0.40 * v, type: 'lowpass', freq: 380, sweep: 3400, q: 0.9, attack: 0.003 });
        this._noise({ dur: 1.30, gain: 0.30 * v, type: 'bandpass', freq: 520, sweep: -390, q: 0.55, delay: 0.06 });
        this._noise({ dur: 0.95, gain: 0.15 * v, type: 'highpass', freq: 3200, sweep: -2100, delay: 0.03 });
        break;
      }
      case 'machStep': {
        /* Passing a Mach band on the way UP.
         *
         * A jet accelerating through its range is not one continuous note: the
         * intakes reschedule, the nozzle steps, and the whole airframe settles
         * into a new place every few Mach. Without a marker the climb from
         * cruise to the ceiling is twenty Mach of the same sound getting
         * slightly louder, and the player has no sense of covering ground.
         *
         * `opts.step` (0..1) is how far up the range the band sits, so the
         * cue climbs with it — low and mechanical down low, hard and metallic
         * at the top of the envelope where the airframe is complaining.
         * ------------------------------------------------------------------ */
        if (!this._guard('machStep', 260)) return;
        const k = clamp01(opts.step ?? 0.5);
        // Intake schedule: a bass step that rises with the band.
        this._tone({ freq: 58 + k * 46, type: 'square', dur: 0.17, gain: 0.30 * v, sweep: 20 + k * 34,
          attack: 0.002, filter: { type: 'lowpass', freq: 240 + k * 220, q: 3.0 } });
        this._tone({ freq: 34 + k * 20, type: 'sine', dur: 0.44, gain: 0.34 * v, sweep: 16, attack: 0.006 });
        // Nozzle stepping — short, metallic, and brighter the higher you are.
        this._noise({ dur: 0.05, gain: (0.10 + k * 0.16) * v, type: 'bandpass',
          freq: 2400 + k * 2200, sweep: -1200, q: 4.5, attack: 0.001, delay: 0.01 });
        // The airframe settling into the new band behind it.
        this._noise({ dur: 0.40 + k * 0.25, gain: (0.12 + k * 0.14) * v, type: 'bandpass',
          freq: 700 + k * 900, sweep: 500 + k * 900, q: 0.9, attack: 0.010, delay: 0.03 });
        break;
      }
      case 'gearShift': {
        // Jet gear change: the accessory gearbox stepping up a ratio. Heavy
        // mechanical engagement — a bass thump with a metallic dog-clutch bite
        // over it, then the shaft settling at the new speed.
        if (!this._guard('gearShift', 300)) return;
        this._tone({ freq: 74, type: 'square', dur: 0.20, gain: 0.44 * v, sweep: -26, attack: 0.002,
          filter: { type: 'lowpass', freq: 260, q: 3.0 } });
        this._tone({ freq: 38, type: 'sine', dur: 0.55, gain: 0.44 * v, sweep: 22, attack: 0.006 });
        // Clutch bite: short, hard, high — the metal-on-metal engagement.
        this._noise({ dur: 0.045, gain: 0.26 * v, type: 'bandpass', freq: 3100, sweep: -1500, q: 5.0, attack: 0.001 });
        this._tone({ freq: 196, type: 'sawtooth', dur: 0.10, gain: 0.17 * v, sweep: -78, delay: 0.012,
          filter: { type: 'lowpass', freq: 1500, q: 4 } });
        // Shaft spinning up into the new ratio behind it.
        this._tone({ freq: 118, type: 'triangle', dur: 0.46, gain: 0.20 * v, sweep: 168, delay: 0.05,
          filter: { type: 'lowpass', freq: 900, sweep: 700, q: 2.6 } });
        break;
      }
      case 'boostOut':
        // Reheat cut — the plume collapses.
        if (!this._guard('boostOut', 340)) return;
        this._noise({ dur: 0.42, gain: 0.13 * v, type: 'bandpass', freq: 900, sweep: -700, q: 1.3 });
        this._tone({ freq: 130, type: 'sine', dur: 0.28, gain: 0.08 * v, sweep: -70 });
        break;
      case 'sonicBoom':
        if (!this._guard('sonicBoom', 5000)) return;
        this._noise({ dur: 0.06, gain: 0.42 * v, type: 'highpass', freq: 1800, sweep: 2600 });
        this._tone({ freq: 44, type: 'sine', dur: 1.0, gain: 0.30 * v, sweep: -18, delay: 0.02 });
        this._noise({ dur: 0.9, gain: 0.20 * v, type: 'lowpass', freq: 1200, sweep: -1050, q: 0.7, delay: 0.03 });
        break;
      case 'flyby':
        // A rival going past: the plume arrives after the airframe does.
        if (!this._guard('flyby', 700)) return;
        this._noise({ dur: 0.55, gain: 0.16 * v, type: 'bandpass', freq: 2400, sweep: -1900, q: 0.9 });
        this._noise({ dur: 0.75, gain: 0.13 * v, type: 'lowpass', freq: 900, sweep: -620, q: 0.8, delay: 0.09 });
        break;
      case 'stallWarn':
        // The aural warning every fast jet has: an insistent two-tone.
        if (!this._guard('stallWarn', 900)) return;
        this._tone({ freq: 740, type: 'square', dur: 0.11, gain: 0.06 * v, filter: { type: 'lowpass', freq: 2000 } });
        this._tone({ freq: 560, type: 'square', dur: 0.11, gain: 0.06 * v, delay: 0.14, filter: { type: 'lowpass', freq: 2000 } });
        break;
      /* ---- weapons ---- */
      case 'gunFire':
        // Rotary cannon. Four layers because a real one is four things at
        // once: the crack of the round leaving, the muzzle blast, the low
        // thump of the gas, and the mechanical clatter of the breech. Guarded
        // tightly so a held trigger reads as one continuous rip rather than a
        // wall of overlapping copies.
        if (!this._guard('gunFire', 52)) return;
        this._noise({ dur: 0.035, gain: 0.62 * v, type: 'highpass', freq: 3200, sweep: -2000, attack: 0.0008 });
        this._noise({ dur: 0.11, gain: 0.50 * v, type: 'bandpass', freq: 780, sweep: -430, q: 0.8, attack: 0.001 });
        this._tone({ freq: 152, type: 'square', dur: 0.075, gain: 0.44 * v, sweep: -84, attack: 0.001,
          filter: { type: 'lowpass', freq: 1100, q: 2.6 } });
        this._tone({ freq: 58, type: 'sine', dur: 0.14, gain: 0.46 * v, sweep: -20, attack: 0.002 });
        break;
      case 'heavyGunFire':
        // A 40 mm. One round at a time, and you hear the whole thing: the
        // breech, the muzzle blast, and the low thud rolling off after it.
        if (!this._guard('heavyGunFire', 130)) return;
        this._noise({ dur: 0.05, gain: 0.72 * v, type: 'highpass', freq: 2400, sweep: -1600, attack: 0.0008 });
        this._noise({ dur: 0.24, gain: 0.62 * v, type: 'bandpass', freq: 520, sweep: -300, q: 0.7, attack: 0.002 });
        this._tone({ freq: 104, type: 'square', dur: 0.16, gain: 0.58 * v, sweep: -58, attack: 0.001,
          filter: { type: 'lowpass', freq: 760, q: 2.4 } });
        this._tone({ freq: 41, type: 'sine', dur: 0.36, gain: 0.62 * v, sweep: -12, attack: 0.003 });
        break;
      case 'gunFireDistant':
        // Somebody else's guns: no muzzle crack, just the report arriving.
        if (!this._guard('gunFireDistant', 130)) return;
        this._noise({ dur: 0.16, gain: 0.09 * v, type: 'bandpass', freq: 620, sweep: -320, q: 1.1 });
        break;
      case 'missileLaunch':
        /* A launch is four things in a row and the ORDER is what sells it:
         * the rail lets go, the motor lights, the motor RUNS, and then the
         * round is far enough away that all you have left is a receding hiss.
         *
         * The old version fired the whole thing at once, which is why a
         * several-hundred-kilo round leaving the wing sounded like a click.
         * Everything below is delayed into its place, and the motor is now the
         * long loud part rather than a tail on the end of a transient.
         * ------------------------------------------------------------------ */
        if (!this._guard('missileLaunch', 130)) return;
        // 1. Rail release — metal letting go, sharp and immediately gone.
        this._noise({ dur: 0.035, gain: 0.50 * v, type: 'highpass', freq: 4200, sweep: -2600, attack: 0.0006 });
        this._tone({ freq: 1750, type: 'square', dur: 0.045, gain: 0.10 * v, sweep: -900, attack: 0.0008 });
        // 2. Ignition — the charge, with a real body under it.
        this._tone({ freq: 108, type: 'sawtooth', dur: 0.26, gain: 0.62 * v, sweep: -54, attack: 0.0016, delay: 0.012,
          filter: { type: 'lowpass', freq: 820, sweep: -420, q: 2.2 } });
        this._tone({ freq: 42, type: 'sine', dur: 1.05, gain: 0.78 * v, sweep: -13, attack: 0.004, delay: 0.012 });
        this._tone({ freq: 26, type: 'sine', dur: 1.35, gain: 0.44 * v, sweep: -7, attack: 0.010, delay: 0.02 });
        // 3. Motor run — the loud part. Broadband, opening up as the plume
        //    establishes, then held while the round accelerates away.
        this._noise({ dur: 0.34, gain: 0.72 * v, type: 'lowpass', freq: 420, sweep: 4200, q: 0.9, attack: 0.004, delay: 0.02 });
        this._noise({ dur: 1.05, gain: 0.58 * v, type: 'bandpass', freq: 1500, sweep: -1080, q: 0.6, delay: 0.09 });
        this._tone({ freq: 300, type: 'sawtooth', dur: 0.95, gain: 0.30 * v, sweep: -215, delay: 0.05,
          filter: { type: 'lowpass', freq: 2100, sweep: -1650 } });
        // 4. Departure — a thin receding hiss, well after the rest has gone.
        this._noise({ dur: 1.5, gain: 0.24 * v, type: 'bandpass', freq: 2600, sweep: -2100, q: 1.1, delay: 0.55 });
        break;
      case 'grenadeThrow':
        if (!this._guard('grenadeThrow', 140)) return;
        this._noise({ dur: 0.14, gain: 0.17 * v, type: 'bandpass', freq: 1400, sweep: -900, q: 1.6 });
        this._tone({ freq: 320, type: 'triangle', dur: 0.20, gain: 0.10 * v, sweep: -180 });
        break;
      case 'lockTone':
        // The seeker acquiring: the steady tone every pilot knows.
        if (!this._guard('lockTone', 420)) return;
        for (let i = 0; i < 3; i++) {
          this._tone({ freq: 1320, type: 'square', dur: 0.055, gain: 0.055 * v, delay: i * 0.075,
            filter: { type: 'lowpass', freq: 3200 } });
        }
        this._tone({ freq: 1980, type: 'sine', dur: 0.26, gain: 0.05 * v, delay: 0.23 });
        break;
      case 'lockWarn':
        // Somebody has a lock on YOU.
        if (!this._guard('lockWarn', 900)) return;
        this._tone({ freq: 640, type: 'sawtooth', dur: 0.13, gain: 0.09 * v, filter: { type: 'lowpass', freq: 1800 } });
        this._tone({ freq: 640, type: 'sawtooth', dur: 0.13, gain: 0.09 * v, delay: 0.19, filter: { type: 'lowpass', freq: 1800 } });
        break;
      case 'collisionWarn': {
        // Ground-proximity style alert. The pitch steps up with the threat
        // level so the ear knows how bad it is before the eye reads the
        // distance, and it is deliberately harsh — this is not a nice sound.
        const lvl = opts.pitch || 0;
        const f = [520, 700, 980][clamp(lvl, 0, 2)];
        this._tone({ freq: f, type: 'square', dur: 0.075, gain: 0.16 * v,
          filter: { type: 'bandpass', freq: f * 1.6, q: 2.2 } });
        this._tone({ freq: f * 0.5, type: 'sawtooth', dur: 0.085, gain: 0.11 * v,
          filter: { type: 'lowpass', freq: 1400 } });
        if (lvl >= 2) this._tone({ freq: 86, type: 'sine', dur: 0.14, gain: 0.22 * v, sweep: -22 });
        break;
      }
      case 'overheat':
        // Engine overheat: a hot, distressed two-tone with a metallic strain
        // under it, so it is unmistakably the ENGINE and not the ground.
        if (!this._guard('overheat', 780)) return;
        this._tone({ freq: 880, type: 'sawtooth', dur: 0.20, gain: 0.16 * v, sweep: -180,
          filter: { type: 'bandpass', freq: 1500, q: 3.0 } });
        this._tone({ freq: 660, type: 'sawtooth', dur: 0.22, gain: 0.15 * v, sweep: -140, delay: 0.22,
          filter: { type: 'bandpass', freq: 1200, q: 3.0 } });
        this._noise({ dur: 0.55, gain: 0.13 * v, type: 'bandpass', freq: 2600, sweep: -900, q: 4.0 });
        this._tone({ freq: 62, type: 'sine', dur: 0.60, gain: 0.24 * v, sweep: -14 });
        break;
      case 'overheatCritical':
        // The last few seconds before the engine lets go.
        if (!this._guard('overheatCritical', 420)) return;
        this._tone({ freq: 1180, type: 'square', dur: 0.10, gain: 0.20 * v,
          filter: { type: 'bandpass', freq: 2200, q: 3.5 } });
        this._tone({ freq: 1180, type: 'square', dur: 0.10, gain: 0.20 * v, delay: 0.13,
          filter: { type: 'bandpass', freq: 2200, q: 3.5 } });
        this._noise({ dur: 0.34, gain: 0.20 * v, type: 'bandpass', freq: 3400, sweep: -1800, q: 5.0 });
        this._tone({ freq: 44, type: 'sine', dur: 0.42, gain: 0.34 * v, sweep: -12 });
        break;
      case 'gearLock':
        this._noise({ dur: 0.16, gain: 0.10 * v, type: 'bandpass', freq: 1100, sweep: -600, q: 2.4 });
        break;
      case 'power':
        this._tone({ freq: 300, type: 'triangle', dur: 0.36, gain: 0.13 * v, sweep: 1300, filter: { type: 'bandpass', freq: 1100, q: 5 } });
        this._tone({ freq: 1600, type: 'sine', dur: 0.24, gain: 0.06 * v, sweep: -700, delay: 0.06 });
        break;
      case 'powerReady':
        this._tone({ freq: 1046, type: 'sine', dur: 0.10, gain: 0.055 * v });
        this._tone({ freq: 1568, type: 'sine', dur: 0.12, gain: 0.045 * v, delay: 0.06 });
        break;
      case 'powerBlocked':
        this._tone({ freq: 220, type: 'square', dur: 0.09, gain: 0.05 * v, sweep: -70 });
        break;
      case 'alert':
        if (!this._guard('alert', 700)) return;
        this._tone({ freq: 880, type: 'square', dur: 0.09, gain: 0.075 * v });
        this._tone({ freq: 880, type: 'square', dur: 0.09, gain: 0.075 * v, delay: 0.15 });
        break;
      case 'thunder':
        this._noise({ dur: 2.4, gain: 0.30 * v, type: 'lowpass', freq: 700, sweep: -600, q: 0.6, delay: opts.delay || 0 });
        this._tone({ freq: 52, type: 'sine', dur: 1.9, gain: 0.22 * v, sweep: -20, delay: (opts.delay || 0) + 0.1 });
        break;
      case 'countdown':
        // Range-clearance tone, not a musical beep.
        this._tone({ freq: 620, type: 'square', dur: 0.14, gain: 0.12 * v, filter: { type: 'lowpass', freq: 1800 } });
        this._noise({ dur: 0.05, gain: 0.035 * v, type: 'highpass', freq: 4000, sweep: 1200 });
        break;
      case 'go':
        this._tone({ freq: 990, type: 'square', dur: 0.42, gain: 0.17 * v, filter: { type: 'lowpass', freq: 3200 } });
        break;
      case 'victory':
        [0, 4, 7, 12].forEach((s, i) => this._tone({
          freq: NOTE(s + 3), type: 'triangle', dur: 0.8, gain: 0.11 * v, delay: i * 0.13,
        }));
        break;
      case 'defeat':
        [0, -3, -7, -12].forEach((s, i) => this._tone({
          freq: NOTE(s - 5), type: 'sawtooth', dur: 0.9, gain: 0.10 * v, delay: i * 0.20,
          filter: { type: 'lowpass', freq: 1100, sweep: -700 },
        }));
        break;
      case 'objective':
        [0, 5, 9].forEach((s, i) => this._tone({ freq: NOTE(s + 7), type: 'sine', dur: 0.4, gain: 0.09 * v, delay: i * 0.08 }));
        break;
      case 'unlock':
        [0, 7, 12, 16, 19].forEach((s, i) => this._tone({ freq: NOTE(s), type: 'triangle', dur: 0.55, gain: 0.09 * v, delay: i * 0.09 }));
        break;
      case 'nearMiss':
        if (!this._guard('nearMiss', 220)) return;
        this._noise({ dur: 0.22, gain: 0.12 * v * (0.4 + (opts.closeness || 0)), type: 'bandpass', freq: 900, sweep: 2600, q: 1.6 });
        break;
      case 'overtake':
        this._tone({ freq: 520, type: 'triangle', dur: 0.22, gain: 0.10 * v, sweep: 520 });
        break;
      case 'warn':
        if (!this._guard('warn', 480)) return;
        this._tone({ freq: 400, type: 'sawtooth', dur: 0.20, gain: 0.09 * v, sweep: -110, filter: { type: 'lowpass', freq: 1400 } });
        break;
      default:
        break;
    }
  }
}

/* ===========================================================================
 * MUSIC ENGINE — generative adaptive score
 * ======================================================================== */

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};

const TRACKS = {
  // Four menu beds. They rotate on every return to the menu so the hangar is
  // not the same eight bars for the whole session.
  menu: { root: -9, scale: 'dorian', bpm: 92, prog: [0, 5, 3, 4], baseIntensity: 0.35, pad: 1.0, arp: 0.4, drums: 0.25 },
  menu2: { root: -12, scale: 'lydian', bpm: 78, prog: [0, 4, 2, 6], baseIntensity: 0.30, pad: 1.3, arp: 0.3, drums: 0.12 },
  menu3: { root: -7, scale: 'minor', bpm: 104, prog: [0, 3, 5, 4], baseIntensity: 0.42, pad: 0.85, arp: 0.65, drums: 0.45 },
  menu4: { root: -14, scale: 'phrygian', bpm: 86, prog: [0, 1, 5, 3], baseIntensity: 0.38, pad: 1.1, arp: 0.5, drums: 0.30 },
  race: { root: -7, scale: 'minor', bpm: 138, prog: [0, 0, 5, 3], baseIntensity: 0.6, pad: 0.7, arp: 0.9, drums: 1.0 },
  survival: { root: -10, scale: 'phrygian', bpm: 146, prog: [0, 1, 0, 5], baseIntensity: 0.7, pad: 0.5, arp: 1.0, drums: 1.0 },
  timeattack: { root: -5, scale: 'dorian', bpm: 152, prog: [0, 4, 5, 3], baseIntensity: 0.65, pad: 0.6, arp: 1.0, drums: 1.0 },
  free: { root: -12, scale: 'lydian', bpm: 84, prog: [0, 4, 2, 5], baseIntensity: 0.25, pad: 1.2, arp: 0.3, drums: 0.0 },
  boss: { root: -12, scale: 'phrygian', bpm: 152, prog: [0, 0, 1, 0], baseIntensity: 0.85, pad: 0.6, arp: 1.0, drums: 1.2 },
  gameover: { root: -14, scale: 'minor', bpm: 68, prog: [0, 5, 3, 4], baseIntensity: 0.2, pad: 1.4, arp: 0.0, drums: 0.0 },
  victory: { root: -5, scale: 'lydian', bpm: 124, prog: [0, 4, 5, 4], baseIntensity: 0.7, pad: 1.0, arp: 0.8, drums: 0.8 },
};

class MusicEngine {
  constructor(ctx, dest, noiseBuffer) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.noiseBuffer = noiseBuffer;

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.4, 2.6);
    this.wet = ctx.createGain(); this.wet.gain.value = 0.30;
    this.dry = ctx.createGain(); this.dry.gain.value = 0.85;
    this.out.connect(this.dry); this.dry.connect(dest);
    this.out.connect(this.reverb); this.reverb.connect(this.wet); this.wet.connect(dest);

    this.track = TRACKS.menu;
    this.intensity = 0.4;
    this.targetIntensity = 0.4;
    this.step = 0;
    this.nextTime = 0;
    this.timer = null;
    this.playing = false;
    this.rngState = 12345;
  }

  _rand() {
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 4294967296;
  }

  _impulse(duration, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * duration));
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  setTrack(name, intensity = null) {
    const t = TRACKS[name] || TRACKS.race;
    if (t === this.track && intensity == null) return;
    this.track = t;
    this.step = 0;
    if (intensity != null) this.targetIntensity = intensity;
    else this.targetIntensity = t.baseIntensity;
  }

  setIntensity(v) { this.targetIntensity = clamp01(v); }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.nextTime = this.ctx.currentTime + 0.08;
    this.timer = setInterval(() => this._schedule(), 60);
  }

  stop() {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  _voice(freq, t, dur, gain, type, filterFreq, q = 1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = filterFreq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(this.out);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _drum(kind, t, gain) {
    const ctx = this.ctx;
    if (kind === 'kick') {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g); g.connect(this.out);
      o.start(t); o.stop(t + 0.24);
    } else {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuffer; s.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = kind === 'snare' ? 'bandpass' : 'highpass';
      f.frequency.value = kind === 'snare' ? 1900 : 7200;
      f.Q.value = kind === 'snare' ? 1.2 : 0.8;
      const g = ctx.createGain();
      const dur = kind === 'snare' ? 0.16 : 0.045;
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.out);
      s.start(t); s.stop(t + dur + 0.02);
    }
  }

  _schedule() {
    if (!this.playing) return;
    const ctx = this.ctx;
    const T = this.track;
    this.intensity = lerp(this.intensity, this.targetIntensity, 0.05);
    const I = this.intensity;
    const beat = 60 / (T.bpm * lerp(0.92, 1.08, I));
    const sixteenth = beat / 4;

    while (this.nextTime < ctx.currentTime + 0.35) {
      const t = this.nextTime;
      const s = this.step;
      const bar = Math.floor(s / 16) % T.prog.length;
      const scale = SCALES[T.scale];
      const chordRoot = T.root + scale[T.prog[bar] % scale.length];
      const deg = (i) => NOTE(chordRoot + scale[i % scale.length] + 12 * Math.floor(i / scale.length));

      // --- pad: sustained chord at the top of each bar --------------------
      if (s % 16 === 0 && T.pad > 0) {
        for (const iv of [0, 2, 4]) {
          this._voice(deg(iv) / 2, t, beat * 3.6, 0.035 * T.pad * lerp(0.6, 1.0, I), 'sawtooth', 700 + I * 900, 1.2);
        }
      }
      // --- bass ------------------------------------------------------------
      if (s % 4 === 0) {
        this._voice(NOTE(chordRoot) / 4, t, beat * 0.85, 0.10 * lerp(0.6, 1.15, I), 'triangle', 400, 1);
      }
      // --- arp -------------------------------------------------------------
      if (T.arp > 0 && I > 0.28) {
        const density = I > 0.7 ? 1 : 2;
        if (s % density === 0) {
          const idx = [0, 2, 4, 6, 4, 2][(s / density) % 6 | 0];
          this._voice(deg(idx) * 2, t, sixteenth * 1.6,
            0.030 * T.arp * lerp(0.4, 1.0, I) * (this._rand() > 0.18 ? 1 : 0.3),
            'square', 1400 + I * 2600, 3);
        }
      }
      // --- drums ------------------------------------------------------------
      if (T.drums > 0 && I > 0.2) {
        const dg = T.drums * lerp(0.35, 1.0, I);
        if (s % 8 === 0) this._drum('kick', t, 0.28 * dg);
        if (s % 16 === 8) this._drum('snare', t, 0.13 * dg);
        if (I > 0.5 && s % 2 === 0) this._drum('hat', t, 0.045 * dg * (s % 4 === 0 ? 1 : 0.6));
        if (I > 0.85 && s % 16 === 14) this._drum('snare', t, 0.10 * dg);
      }

      this.nextTime += sixteenth;
      this.step = (s + 1) % (16 * T.prog.length);
    }
  }

  dispose() { this.stop(); this.out.disconnect(); }
}

/* ===========================================================================
 * AUDIO SYSTEM
 * ======================================================================== */

export class AudioSystem {
  constructor() {
    this.ready = false;
    this.failed = false;
    this.ctx = null;
    this.settings = {
      masterVolume: 0.85, musicVolume: 0.55, sfxVolume: 0.9, environmentVolume: 0.8,
    };
    this.muted = false;
  }

  init() {
    if (this.ready || this.failed) return this.ready;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio unavailable');
      this.ctx = new AC({ latencyHint: 'interactive' });

      this.master = this.ctx.createGain();
      this.master.gain.value = this.settings.masterVolume;

      /* ---- master voicing ------------------------------------------------
       * A low shelf and a narrow lift around 55 Hz put real weight under the
       * whole mix — jet, cannon and detonations alike — and a small presence
       * bump keeps the top from being buried by it. The limiter then holds the
       * peaks, which is what lets everything below it run this hot without
       * clipping on a burst of explosions. */
      this.bass = this.ctx.createBiquadFilter();
      this.bass.type = 'lowshelf';
      this.bass.frequency.value = 145;
      this.bass.gain.value = 6.0;

      this.subLift = this.ctx.createBiquadFilter();
      this.subLift.type = 'peaking';
      this.subLift.frequency.value = 55;
      this.subLift.Q.value = 0.85;
      this.subLift.gain.value = 5.0;

      this.presence = this.ctx.createBiquadFilter();
      this.presence.type = 'peaking';
      this.presence.frequency.value = 3100;
      this.presence.Q.value = 0.7;
      this.presence.gain.value = 2.4;

      // A gentle limiter keeps explosions from clipping the mix.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -10;
      this.limiter.knee.value = 10;
      this.limiter.ratio.value = 9;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.20;

      this.master.connect(this.bass);
      this.bass.connect(this.subLift);
      this.subLift.connect(this.presence);
      this.presence.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);

      const bus = (v) => { const g = this.ctx.createGain(); g.gain.value = v; g.connect(this.master); return g; };
      this.musicBus = bus(this.settings.musicVolume);
      this.sfxBus = bus(this.settings.sfxVolume);
      this.envBus = bus(this.settings.environmentVolume);

      this.noiseBuffer = this._makeNoise(2.5);
      this.engine = new EngineSynth(this.ctx, this.envBus, this.noiseBuffer);
      this.ambience = new AmbienceSynth(this.ctx, this.envBus, this.noiseBuffer);
      this.sfx = new SFXKit(this.ctx, this.sfxBus, this.noiseBuffer);
      this.uiSfx = new SFXKit(this.ctx, this.sfxBus, this.noiseBuffer);
      this.music = new MusicEngine(this.ctx, this.musicBus, this.noiseBuffer);

      this.ready = true;
      return true;
    } catch (err) {
      console.warn('[Audio] disabled:', err.message);
      this.failed = true;
      return false;
    }
  }

  _makeNoise(seconds) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    // Slightly pink-tinted noise reads warmer than pure white.
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = clamp((b0 + b1 + b2 + w * 0.1848) * 0.28, -1, 1);
    }
    return buf;
  }

  /** Must be called from a user gesture — browsers block audio otherwise. */
  async unlock() {
    if (!this.init()) return false;
    try {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.ambience.start();
      return this.ctx.state === 'running';
    } catch (e) { return false; }
  }

  applySettings(s) {
    Object.assign(this.settings, s || {});
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const m = this.muted ? 0 : 1;
    this.master.gain.setTargetAtTime(this.settings.masterVolume * m, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.settings.musicVolume, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.settings.sfxVolume, t, 0.05);
    this.envBus.gain.setTargetAtTime(this.settings.environmentVolume, t, 0.05);
  }

  setMuted(v) { this.muted = v; this.applySettings(); }

  /* ---- façade ---------------------------------------------------------- */
  play(name, opts) { if (this.ready && !this.muted) try { this.sfx.play(name, opts); } catch (e) { /* noop */ } }
  ui(name, opts) { if (this.ready && !this.muted) try { this.uiSfx.play(name, opts); } catch (e) { /* noop */ } }

  startEngine() { if (this.ready) this.engine.start(); }
  igniteEngine() { if (this.ready) { this.engine.start(); this.engine.ignite(); } }
  stopEngine() { if (this.ready) this.engine.stop(); }
  updateEngine(state) { if (this.ready) try { this.engine.update(state); } catch (e) { /* noop */ } }

  setEnvironment(weather, speed01, cavern) {
    if (this.ready) try { this.ambience.set(weather, speed01, cavern); } catch (e) { /* noop */ }
  }

  /**
   * Rotate through the four menu beds. Called instead of setMusic('menu') so
   * every trip back to the hangar gets a different one.
   */
  setMenuMusic(intensity) {
    const beds = ['menu', 'menu3', 'menu2', 'menu4'];
    this._menuBed = ((this._menuBed ?? -1) + 1) % beds.length;
    this.setMusic(beds[this._menuBed], intensity);
    return beds[this._menuBed];
  }

  setMusic(track, intensity) {
    if (!this.ready) return;
    this.music.setTrack(track, intensity);
    this.music.start();
  }
  setMusicIntensity(v) { if (this.ready) this.music.setIntensity(v); }
  stopMusic() { if (this.ready) this.music.stop(); }

  suspend() {
    if (!this.ready) return;
    this.music.stop();
    this.engine.stop();
    try { this.ctx.suspend(); } catch (e) { /* noop */ }
  }
  async resume() {
    if (!this.ready) return;
    try { await this.ctx.resume(); } catch (e) { /* noop */ }
  }

  dispose() {
    if (!this.ready) return;
    this.music.dispose();
    this.engine.dispose();
    this.ambience.dispose();
    try { this.ctx.close(); } catch (e) { /* noop */ }
    this.ready = false;
  }
}
