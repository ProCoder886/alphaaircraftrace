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
 * A military turbofan, not an engine block.
 *
 * The distinguishing sound of a fighter is a stack of *inharmonic* blade-
 * passing tones from the fan and compressor sitting on top of an enormous
 * broadband core roar — not the buzzy sawtooth of a piston engine, which is
 * what this used to be and why it read as a car. Five layers:
 *
 *   fan      — blade-passing partials at non-integer multiples of N1, swept
 *              through a resonant bandpass. This is the "whine".
 *   buzzsaw  — a detuned pair that beats against the fan once N1 is high,
 *              giving the shimmering edge a real intake has at speed.
 *   core     — band-passed noise: combustion and the exhaust column, the body
 *              of the sound and most of its level.
 *   hiss     — high-passed noise, the tearing edge of the exhaust plume.
 *   reheat   — sub-bass rumble with an unstable amplitude, plus a mid-band
 *              roar. Afterburners are not smooth, and the wobble is the tell.
 *
 * Airframe noise (the air itself) rides on top, scaled with V², so speed is
 * audible even at idle thrust.
 */
class EngineSynth {
  constructor(ctx, dest, noiseBuffer) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    this.running = false;
    this.n1 = 0;              // spool state, 0..1 — lags the throttle
    this.ignitionUntil = 0;

    const noiseSource = (filterType, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = filterType; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.out);
      return { src, filter: f, gain: g };
    };

    /* ---- fan and compressor: inharmonic blade-passing tones ------------- */
    this.fanFilter = ctx.createBiquadFilter();
    this.fanFilter.type = 'bandpass';
    this.fanFilter.frequency.value = 900;
    this.fanFilter.Q.value = 1.5;
    this.fanFilter.connect(this.out);

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

    /* ---- reheat: sub rumble with an unstable amplitude ------------------- */
    this.reheat = noiseSource('lowpass', 130, 1.1);
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
    this.damageOsc.connect(this.damageGain); this.damageGain.connect(df); df.connect(this.out);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const t = this.ctx.currentTime;
    try {
      for (const f of this.fan) f.osc.start(t);
      for (const b of this.buzz) b.start(t);
      for (const n of [this.core, this.hiss, this.airframe, this.reheat, this.reheatMid]) n.src.start(t);
      this.lfoA.start(t); this.lfoB.start(t);
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

  /** @param s {speed01, throttle, boost, damage01, altitude01} */
  update(s) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const set = (param, v, k = 0.09) => param.setTargetAtTime(v, t, k);

    const spd = clamp01(s.speed01);
    const boost = clamp01(s.boost);
    const thr = clamp01(s.throttle ?? 1);

    // N1 lags: a big fan takes seconds to spool, and hearing that lag is most
    // of what separates a jet from anything with pistons.
    const spooling = t < this.ignitionUntil;
    const n1Target = spooling ? 0.34 : clamp01(0.30 + thr * 0.42 + spd * 0.36 + boost * 0.22);
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

    // Core roar — the body of the sound.
    set(this.core.filter.frequency, lerp(170, 780, n1), 0.12);
    set(this.core.gain.gain, lerp(0.05, 0.30, n1) * lerp(0.75, 1.15, thr));
    // Exhaust tearing.
    set(this.hiss.filter.frequency, lerp(2200, 5200, spd));
    set(this.hiss.gain.gain, lerp(0.012, 0.075, Math.pow(spd, 1.3)) + boost * 0.055);
    // Airframe: the air itself, which is loud in a fast jet even at idle.
    set(this.airframe.filter.frequency, lerp(700, 1800, spd));
    set(this.airframe.gain.gain, Math.pow(spd, 1.9) * 0.085);

    // Reheat: unstable by nature.
    set(this.reheat.gain.gain, boost * 0.26 + Math.pow(n1, 3) * 0.03);
    set(this.reheat.filter.frequency, lerp(95, 165, boost));
    set(this.reheatMid.gain.gain, boost * 0.13);
    set(this.reheatMid.filter.frequency, lerp(300, 620, boost));
    set(this.lfoAG.gain, boost * 0.075);
    set(this.lfoBG.gain, boost * 0.045);

    // A damaged compressor stalls and surges.
    const dmg = clamp01((s.damage01 - 0.45) / 0.55);
    set(this.damageGain.gain, dmg * 0.055 * (0.4 + Math.random() * 0.6), 0.05);
    if (dmg > 0.02) this.damageOsc.frequency.setTargetAtTime(31 + Math.random() * 34, t, 0.06);

    // Thin air carries less of the note.
    set(this.out.gain, lerp(1, 0.74, clamp01(s.altitude01 || 0)));
  }

  dispose() {
    try {
      for (const f of this.fan) f.osc.stop();
      for (const b of this.buzz) b.stop();
      for (const n of [this.core, this.hiss, this.airframe, this.reheat, this.reheatMid]) n.src.stop();
      this.lfoA.stop(); this.lfoB.stop(); this.damageOsc.stop();
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
      case 'hover':
        if (!this._guard('hover', 40)) return;
        this._tone({ freq: 1180, type: 'sine', dur: 0.055, gain: 0.045 * v, sweep: 180 });
        break;
      case 'click':
        this._tone({ freq: 720, type: 'square', dur: 0.06, gain: 0.075 * v, sweep: -220, filter: { type: 'lowpass', freq: 2600 } });
        this._noise({ dur: 0.05, gain: 0.04 * v, type: 'highpass', freq: 2600, sweep: 1400 });
        break;
      case 'select':
        this._tone({ freq: 620, type: 'triangle', dur: 0.11, gain: 0.09 * v, sweep: 380 });
        this._tone({ freq: 930, type: 'sine', dur: 0.16, gain: 0.06 * v, delay: 0.05 });
        break;
      case 'back':
        this._tone({ freq: 520, type: 'triangle', dur: 0.12, gain: 0.08 * v, sweep: -220 });
        break;
      case 'confirm':
        this._tone({ freq: 523, type: 'sine', dur: 0.14, gain: 0.10 * v });
        this._tone({ freq: 784, type: 'sine', dur: 0.20, gain: 0.09 * v, delay: 0.08 });
        this._tone({ freq: 1046, type: 'sine', dur: 0.30, gain: 0.07 * v, delay: 0.16 });
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
        // Airframe strike: skin panel deforming, then the structure ringing.
        this._noise({ dur: 0.09, gain: 0.34 * v, type: 'highpass', freq: 3400, sweep: -1800 });
        this._noise({ dur: 0.40, gain: 0.26 * v, type: 'bandpass', freq: 1500, sweep: -1150, q: 1.6 });
        this._tone({ freq: 148, type: 'triangle', dur: 0.34, gain: 0.18 * v, sweep: -96, filter: { type: 'lowpass', freq: 620 } });
        break;
      case 'explosion':
        // Fuel deflagration, then the airframe coming apart.
        this._noise({ dur: 0.09, gain: 0.34 * v, type: 'highpass', freq: 4200, sweep: 2000 });
        this._noise({ dur: 1.7, gain: 0.44 * v, type: 'lowpass', freq: 2400, sweep: -2280, q: 0.7 });
        this._tone({ freq: 86, type: 'sine', dur: 1.25, gain: 0.34 * v, sweep: -58 });
        this._noise({ dur: 0.85, gain: 0.16 * v, type: 'bandpass', freq: 2200, sweep: -1600, q: 0.9, delay: 0.18 });
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
      // A gentle limiter keeps explosions from clipping the mix.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.knee.value = 12;
      this.limiter.ratio.value = 6;
      this.limiter.attack.value = 0.004;
      this.limiter.release.value = 0.22;
      this.master.connect(this.limiter);
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
