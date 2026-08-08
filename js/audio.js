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

class EngineSynth {
  constructor(ctx, dest, noiseBuffer) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    this.running = false;

    // --- turbine core: three detuned saws through a resonant lowpass -----
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 700;
    this.filter.Q.value = 3.2;
    this.filter.connect(this.out);

    this.oscs = [];
    this.oscGains = [];
    for (const [mult, detune, gain, type] of [
      [1.0, 0, 0.34, 'sawtooth'], [1.5, 7, 0.20, 'sawtooth'],
      [2.01, -9, 0.15, 'square'], [0.5, 3, 0.26, 'triangle'],
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 60 * mult;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g); g.connect(this.filter);
      this.oscs.push({ osc: o, mult });
      this.oscGains.push(g);
    }

    // --- compressor blade whine ------------------------------------------
    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whine.frequency.value = 900;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0.02;
    this.whine.connect(this.whineGain); this.whineGain.connect(this.out);

    // --- exhaust roar: band-passed noise ---------------------------------
    this.noise = ctx.createBufferSource();
    this.noise.buffer = noiseBuffer;
    this.noise.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 420;
    this.noiseFilter.Q.value = 0.7;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0.0;
    this.noise.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.out);

    // --- reheat rumble ----------------------------------------------------
    this.rumble = ctx.createBufferSource();
    this.rumble.buffer = noiseBuffer;
    this.rumble.loop = true;
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 160;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumble.connect(this.rumbleFilter);
    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.out);

    // --- damage stutter ----------------------------------------------------
    this.damageOsc = ctx.createOscillator();
    this.damageOsc.type = 'square';
    this.damageOsc.frequency.value = 34;
    this.damageGain = ctx.createGain();
    this.damageGain.gain.value = 0;
    this.damageOsc.connect(this.damageGain);
    this.damageGain.connect(this.out);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const t = this.ctx.currentTime;
    try {
      for (const { osc } of this.oscs) osc.start(t);
      this.whine.start(t);
      this.noise.start(t);
      this.rumble.start(t);
      this.damageOsc.start(t);
    } catch (e) { /* already started */ }
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(1, t + 0.5);
  }

  stop() {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + 0.35);
  }

  /** @param s {speed01, throttle, boost, damage01, altitude01, near} */
  update(s) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const k = 0.09;                                  // smoothing time constant
    const set = (param, v) => param.setTargetAtTime(v, t, k);

    const spd = clamp01(s.speed01);
    const boost = clamp01(s.boost);
    // Fundamental climbs about two octaves across the speed range.
    const f0 = lerp(46, 138, Math.pow(spd, 0.85)) * lerp(1, 1.18, boost);
    for (const { osc, mult } of this.oscs) set(osc.frequency, f0 * mult);
    set(this.whine.frequency, f0 * 13.5 + boost * 340);
    set(this.whineGain.gain, (0.012 + spd * 0.030) * lerp(0.5, 1.3, s.throttle));

    set(this.filter.frequency, lerp(430, 2600, Math.pow(spd, 0.7)) * lerp(0.85, 1.5, boost));
    set(this.noiseFilter.frequency, lerp(300, 1500, spd));
    set(this.noiseGain.gain, (0.05 + spd * 0.16 + boost * 0.16) * lerp(0.55, 1.15, s.throttle));
    set(this.rumbleGain.gain, boost * 0.30 + spd * 0.05);
    set(this.rumbleFilter.frequency, lerp(90, 230, boost));

    // A damaged engine coughs.
    const dmg = clamp01((s.damage01 - 0.5) / 0.5);
    set(this.damageGain.gain, dmg * 0.05 * (0.5 + Math.random() * 0.5));
    if (dmg > 0.02) this.damageOsc.frequency.setTargetAtTime(28 + Math.random() * 26, t, 0.05);

    // Thin air at altitude takes the body out of the note.
    set(this.out.gain, lerp(1, 0.72, clamp01(s.altitude01 || 0)));
  }

  dispose() {
    try {
      for (const { osc } of this.oscs) osc.stop();
      this.whine.stop(); this.noise.stop(); this.rumble.stop(); this.damageOsc.stop();
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
        this._noise({ dur: 0.42, gain: 0.30 * v, type: 'lowpass', freq: 1600, sweep: -1450, q: 1.2 });
        this._tone({ freq: 130, type: 'square', dur: 0.30, gain: 0.20 * v, sweep: -85, filter: { type: 'lowpass', freq: 700 } });
        break;
      case 'explosion':
        this._noise({ dur: 1.5, gain: 0.42 * v, type: 'lowpass', freq: 2200, sweep: -2100, q: 0.8 });
        this._tone({ freq: 90, type: 'sine', dur: 1.1, gain: 0.34 * v, sweep: -62 });
        this._noise({ dur: 0.10, gain: 0.30 * v, type: 'highpass', freq: 3000, sweep: 3000 });
        break;
      case 'shield':
        this._tone({ freq: 300, type: 'sine', dur: 0.55, gain: 0.13 * v, sweep: 500, filter: { type: 'bandpass', freq: 900, q: 6 } });
        break;
      case 'boost':
        if (!this._guard('boost', 380)) return;
        this._noise({ dur: 0.65, gain: 0.20 * v, type: 'bandpass', freq: 300, sweep: 2000, q: 1.4 });
        this._tone({ freq: 110, type: 'sawtooth', dur: 0.55, gain: 0.12 * v, sweep: 260, filter: { type: 'lowpass', freq: 700, sweep: 2400 } });
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
        this._tone({ freq: 660, type: 'square', dur: 0.16, gain: 0.13 * v, filter: { type: 'lowpass', freq: 2000 } });
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
  menu: { root: -9, scale: 'dorian', bpm: 92, prog: [0, 5, 3, 4], baseIntensity: 0.35, pad: 1.0, arp: 0.4, drums: 0.25 },
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
  stopEngine() { if (this.ready) this.engine.stop(); }
  updateEngine(state) { if (this.ready) try { this.engine.update(state); } catch (e) { /* noop */ } }

  setEnvironment(weather, speed01, cavern) {
    if (this.ready) try { this.ambience.set(weather, speed01, cavern); } catch (e) { /* noop */ }
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
