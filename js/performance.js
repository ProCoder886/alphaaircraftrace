/**
 * ALPHA AIRCRAFT RACE 3D — performance.js
 * ---------------------------------------------------------------------------
 * Everything that keeps the game at 60 FPS and loading fast:
 *   • DeviceProfile   — capability + tier detection, picks a sane starting preset
 *   • PerfMonitor     — frame timing, percentiles, stutter detection
 *   • AdaptiveQuality — gradual, ordered quality ladder (never a cliff-edge drop)
 *   • Scheduler       — time-sliced cooperative work queue for world streaming
 *   • ObjectPool      — allocation-free reuse for VFX / obstacles / AI
 *   • LODController   — distance-banded detail + culling helper
 *   • LoadPipeline    — staged loader reporting *real* progress
 */

import { QUALITY_PRESETS, QUALITY_ORDER, clamp, clamp01, lerp, damp } from './config.js';

/** Common display refresh intervals, snapped to when the delta lands near one. */
const SNAP_STEPS = [1 / 144, 1 / 120, 1 / 90, 1 / 75, 1 / 60, 1 / 50, 1 / 30];
const SNAP_TOLERANCE = 0.0009;   // 0.9 ms — jitter, not a real frame-rate change

/* ===========================================================================
 * DEVICE PROFILE
 * ======================================================================== */

export class DeviceProfile {
  constructor() {
    this.isMobile = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile|Tablet/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
    this.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.cores = navigator.hardwareConcurrency || (this.isMobile ? 4 : 8);
    this.memory = navigator.deviceMemory || (this.isMobile ? 4 : 8);
    this.dpr = window.devicePixelRatio || 1;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;

    const gl = this._probeGL();
    this.webgl2 = gl.webgl2;
    this.renderer = gl.renderer;
    this.maxTextureSize = gl.maxTextureSize;
    this.floatTextures = gl.floatTextures;
    this.anisotropyMax = gl.anisotropyMax;

    this.tier = this._scoreTier();
    this.suggestedPreset = this._suggestPreset();
  }

  _probeGL() {
    const out = { webgl2: false, renderer: 'unknown', maxTextureSize: 2048, floatTextures: false, anisotropyMax: 1 };
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return out;
      out.webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      out.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) out.renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || 'unknown');
      out.floatTextures = !!(out.webgl2 || gl.getExtension('OES_texture_float'));
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
        || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
      if (aniso) out.anisotropyMax = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch (e) { /* headless / blocked WebGL — fall through to defaults */ }
    return out;
  }

  /** 0 = weak, 1 = mid, 2 = strong, 3 = desktop enthusiast. */
  _scoreTier() {
    let score = 0;
    score += this.webgl2 ? 1.2 : 0;
    score += clamp((this.cores - 2) / 6, 0, 1.4);
    score += clamp((this.memory - 2) / 6, 0, 1.2);
    score += this.maxTextureSize >= 8192 ? 0.7 : this.maxTextureSize >= 4096 ? 0.35 : 0;
    if (this.isMobile) score -= 1.5;
    const r = this.renderer.toLowerCase();
    if (/(rtx|radeon rx|apple m[1-9]|geforce (gtx )?(10|16|20|30|40|50)[5-9]0)/.test(r)) score += 1.1;
    if (/(swiftshader|llvmpipe|software|mesa offscreen)/.test(r)) score -= 3;
    if (score < 0.9) return 0;
    if (score < 2.1) return 1;
    if (score < 3.4) return 2;
    return 3;
  }

  _suggestPreset() {
    return ['low', 'medium', 'high', 'ultra'][this.tier];
  }

  describe() {
    return `${this.isMobile ? 'Mobile' : 'Desktop'} · tier ${this.tier} · ${this.cores}c/${this.memory}GB · ${this.webgl2 ? 'WebGL2' : 'WebGL1'}`;
  }
}

/* ===========================================================================
 * PERF MONITOR
 * ======================================================================== */

export class PerfMonitor {
  constructor(sampleSize = 120) {
    this.sampleSize = sampleSize;
    this.samples = new Float32Array(sampleSize);
    this.index = 0;
    this.filled = 0;
    this.fps = 60;
    this.smoothFps = 60;
    this.frameTime = 16.7;
    this.worstFrame = 16.7;
    this.stutters = 0;
    this.lastTime = 0;
    this.elapsed = 0;
    this.frames = 0;
    this.hitchWindow = 0;
    this.info = { drawCalls: 0, triangles: 0, programs: 0, geometries: 0, textures: 0 };
    this.memoryMB = 0;
  }

  begin(now) {
    if (!this.lastTime) { this.lastTime = now; return 1 / 60; }
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Guard against tab-switch mega-deltas destroying the simulation.
    if (dt > 0.25) dt = 0.25;
    if (dt <= 0) dt = 1 / 240;

    /* ---- delta snapping ---------------------------------------------------
     * rAF deltas jitter by a millisecond either side of the true refresh
     * interval even when the machine is comfortably keeping up. Feeding that
     * jitter straight into the simulation makes a perfectly smooth 60 fps look
     * like it is stuttering, because the world moves a slightly different
     * distance every frame. Snapping a near-miss delta onto the exact refresh
     * interval — and carrying the remainder forward so no time is invented or
     * lost — removes the judder without touching the measured frame time.
     * -------------------------------------------------------------------- */
    this.rawDt = dt;
    dt += this.dtResidual || 0;
    for (const step of SNAP_STEPS) {
      if (Math.abs(dt - step) < SNAP_TOLERANCE) { dt = step; break; }
    }
    this.dtResidual = clamp((this.rawDt + (this.dtResidual || 0)) - dt, -0.008, 0.008);
    dt = clamp(dt, 1 / 480, 0.25);

    const ms = this.rawDt * 1000;
    this.frameTime = ms;
    this.samples[this.index] = ms;
    this.index = (this.index + 1) % this.sampleSize;
    this.filled = Math.min(this.filled + 1, this.sampleSize);
    this.fps = 1 / this.rawDt;
    this.smoothFps = lerp(this.smoothFps, this.fps, 0.06);
    this.elapsed += dt;
    this.dt = dt;
    this.frames++;
    if (ms > 42) { this.stutters++; this.hitchWindow = 1.2; }
    else this.hitchWindow = Math.max(0, this.hitchWindow - dt);
    return dt;
  }

  /** p-th percentile frame time in ms (p in 0..1). */
  percentile(p) {
    if (!this.filled) return 16.7;
    const arr = Array.prototype.slice.call(this.samples, 0, this.filled).sort((a, b) => a - b);
    return arr[clamp(Math.floor(arr.length * p), 0, arr.length - 1)];
  }

  get p95() { return this.percentile(0.95); }
  get avgMs() {
    if (!this.filled) return 16.7;
    let s = 0;
    for (let i = 0; i < this.filled; i++) s += this.samples[i];
    return s / this.filled;
  }

  readRenderer(renderer) {
    if (!renderer?.info) return;
    this.info.drawCalls = renderer.info.render.calls;
    this.info.triangles = renderer.info.render.triangles;
    this.info.programs = renderer.info.programs?.length || 0;
    this.info.geometries = renderer.info.memory.geometries;
    this.info.textures = renderer.info.memory.textures;
    if (performance.memory) this.memoryMB = performance.memory.usedJSHeapSize / 1048576;
  }
}

/* ===========================================================================
 * ADAPTIVE QUALITY
 * ------------------------------------------------------------------------
 * A *ladder*, not a switch. Level 0 = the chosen preset untouched. Each step
 * down trims the cheapest-to-lose thing first (far particles, shadow refresh,
 * reflection refresh, far prop density, cloud detail, post intensity, LOD),
 * exactly in the order the design brief requires. Player aircraft fidelity,
 * core lighting, HUD and input responsiveness are never touched.
 * ======================================================================== */

const LADDER = [
  // level: { label, scalars applied on top of the preset }
  { label: 'Full',            farParticles: 1.00, shadowInterval: 1, envInterval: 1.0, propDensity: 1.00, cloudDetail: 1.00, post: 1.00, lodBias: 1.00, pixel: 1.00 },
  { label: 'Trim particles',  farParticles: 0.72, shadowInterval: 1, envInterval: 1.4, propDensity: 1.00, cloudDetail: 1.00, post: 1.00, lodBias: 1.00, pixel: 1.00 },
  { label: 'Shadow cadence',  farParticles: 0.58, shadowInterval: 2, envInterval: 2.0, propDensity: 0.92, cloudDetail: 0.94, post: 0.96, lodBias: 0.94, pixel: 1.00 },
  { label: 'Reflection rate', farParticles: 0.46, shadowInterval: 3, envInterval: 3.0, propDensity: 0.80, cloudDetail: 0.84, post: 0.90, lodBias: 0.86, pixel: 0.96 },
  { label: 'Far density',     farParticles: 0.34, shadowInterval: 4, envInterval: 4.5, propDensity: 0.64, cloudDetail: 0.70, post: 0.82, lodBias: 0.76, pixel: 0.92 },
  { label: 'Cloud detail',    farParticles: 0.24, shadowInterval: 6, envInterval: 6.0, propDensity: 0.50, cloudDetail: 0.55, post: 0.72, lodBias: 0.66, pixel: 0.86 },
  { label: 'Post intensity',  farParticles: 0.16, shadowInterval: 8, envInterval: 8.0, propDensity: 0.38, cloudDetail: 0.42, post: 0.58, lodBias: 0.56, pixel: 0.80 },
  { label: 'Minimum',         farParticles: 0.10, shadowInterval: 12, envInterval: 12.0, propDensity: 0.28, cloudDetail: 0.32, post: 0.45, lodBias: 0.46, pixel: 0.74 },
];

export class AdaptiveQuality {
  constructor(monitor, presetName = 'medium') {
    this.monitor = monitor;
    this.enabled = true;
    this.targetFps = 60;
    this.level = 0;
    this.maxLevel = LADDER.length - 1;
    this.cooldown = 2.5;
    this.riseCredit = 0;
    this.dropDebt = 0;
    this.setPreset(presetName);
    /** Live values other systems read every frame. */
    this.scalars = { ...LADDER[0] };
    this.onChange = null;
  }

  setPreset(name) {
    this.presetName = QUALITY_ORDER.includes(name) ? name : 'medium';
    this.preset = { ...QUALITY_PRESETS[this.presetName] };
    this.level = 0;
    this.scalars = { ...LADDER[0] };
    return this.preset;
  }

  /** Per-setting user overrides from the Settings screen. */
  applyOverrides(s = {}) {
    const p = this.preset;
    if (s.shadows === false) p.shadows = false;
    if (s.reflections === false) p.reflections = false;
    if (s.bloom === false) p.bloom = false;
    if (s.motionBlur === false) p.motionBlur = false;
    if (s.effects === false) { p.chromatic = false; p.grain = false; }
    if (typeof s.particles === 'number') p.particleBudget = Math.round(QUALITY_PRESETS[this.presetName].particleBudget * s.particles);
    if (typeof s.viewDistance === 'number') p.viewDistance = QUALITY_PRESETS[this.presetName].viewDistance * s.viewDistance;
    if (typeof s.cloudQuality === 'number') p.cloudQuality = QUALITY_PRESETS[this.presetName].cloudQuality * s.cloudQuality;
    if (typeof s.weatherQuality === 'number') p.weatherParticles = Math.round(QUALITY_PRESETS[this.presetName].weatherParticles * s.weatherQuality);
    if (typeof s.resolutionScale === 'number') p.pixelRatio = QUALITY_PRESETS[this.presetName].pixelRatio * s.resolutionScale;
    return p;
  }

  update(dt) {
    if (!this.enabled) return false;
    this.cooldown -= dt;
    const avg = this.monitor.avgMs;
    const p95 = this.monitor.p95;
    const budget = 1000 / this.targetFps;

    // Debt accrues when we are consistently over budget; credit when comfortably under.
    if (p95 > budget * 1.28 || avg > budget * 1.14) {
      this.dropDebt += dt * (avg > budget * 1.4 ? 2.2 : 1);
      this.riseCredit = 0;
    } else if (avg < budget * 0.78 && p95 < budget * 1.02) {
      this.riseCredit += dt;
      this.dropDebt = Math.max(0, this.dropDebt - dt * 0.5);
    } else {
      this.dropDebt = Math.max(0, this.dropDebt - dt * 0.3);
      this.riseCredit = Math.max(0, this.riseCredit - dt * 0.3);
    }

    let changed = false;
    if (this.cooldown <= 0) {
      if (this.dropDebt > 1.1 && this.level < this.maxLevel) {
        this.level++; this.dropDebt = 0; this.cooldown = 3.0; changed = true;
      } else if (this.riseCredit > 7.0 && this.level > 0) {
        this.level--; this.riseCredit = 0; this.cooldown = 6.0; changed = true;
      }
    }

    // Always ease toward the target scalars so nothing pops.
    const t = LADDER[this.level];
    const k = 2.2;
    for (const key of Object.keys(t)) {
      if (key === 'label') { this.scalars.label = t.label; continue; }
      if (key === 'shadowInterval') { this.scalars.shadowInterval = t.shadowInterval; continue; }
      this.scalars[key] = damp(this.scalars[key] ?? t[key], t[key], k, dt);
    }
    if (changed && this.onChange) this.onChange(this.level, t.label);
    return changed;
  }

  get effectivePixelRatio() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return clamp(this.preset.pixelRatio * this.scalars.pixel * dpr, 0.45, 2.2);
  }
  get particleBudget() { return Math.round(this.preset.particleBudget * this.scalars.farParticles); }
  get weatherParticles() { return Math.round(this.preset.weatherParticles * lerp(0.45, 1, this.scalars.farParticles)); }
  get propDensity() { return this.preset.propDensity * this.scalars.propDensity; }
  get viewDistance() { return this.preset.viewDistance * lerp(0.72, 1, this.scalars.lodBias); }
  get cloudQuality() { return this.preset.cloudQuality * this.scalars.cloudDetail; }
  get envUpdateInterval() { return this.preset.envUpdateInterval * this.scalars.envInterval; }
  get postIntensity() { return this.scalars.post; }
  get statusLabel() { return `${this.preset.label}${this.level ? ` · ${LADDER[this.level].label}` : ''}`; }
}

/* ===========================================================================
 * SCHEDULER — cooperative, time-sliced background work
 * ------------------------------------------------------------------------
 * World chunk generation is expensive. Rather than building a chunk in one
 * frame (guaranteed hitch) each builder is a generator that yields between
 * sub-steps; the scheduler runs them until the per-frame budget is spent.
 * ======================================================================== */

export class Scheduler {
  constructor(budgetMs = 5.5) {
    this.budgetMs = budgetMs;
    this.queue = [];
    this.running = 0;
    this.completed = 0;
  }

  /** @param {Generator} gen  @param {number} priority higher runs first */
  add(gen, priority = 0, label = '') {
    this.queue.push({ gen, priority, label, id: ++this.running });
    this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
    return this.queue.length;
  }

  clear() { this.queue.length = 0; }
  get pending() { return this.queue.length; }

  /** Runs queued generators until `budgetMs` is spent this frame. */
  run(budgetMs = this.budgetMs) {
    const start = performance.now();
    let guard = 0;
    while (this.queue.length && performance.now() - start < budgetMs && guard++ < 4096) {
      const task = this.queue[0];
      let res;
      try {
        res = task.gen.next();
      } catch (err) {
        console.error(`[Scheduler] task "${task.label}" failed:`, err);
        this.queue.shift();
        continue;
      }
      if (res.done) { this.queue.shift(); this.completed++; }
    }
    return this.queue.length;
  }

  /** Drain everything synchronously — used during the loading screen. */
  drain(maxMs = 1e9) {
    const start = performance.now();
    while (this.queue.length && performance.now() - start < maxMs) this.run(12);
    return this.queue.length;
  }
}

/* ===========================================================================
 * OBJECT POOL
 * ======================================================================== */

export class ObjectPool {
  /**
   * @param {Function} factory   creates a new instance
   * @param {Function} [reset]   called on acquire(obj, ...args)
   * @param {Function} [release] called on return(obj)
   */
  constructor(factory, reset = null, release = null, initial = 0, hardCap = 4096) {
    this.factory = factory;
    this.reset = reset;
    this.releaseFn = release;
    this.free = [];
    this.active = new Set();
    this.hardCap = hardCap;
    this.created = 0;
    for (let i = 0; i < initial; i++) { this.free.push(this._create()); }
  }
  _create() { this.created++; return this.factory(); }
  acquire(...args) {
    if (this.active.size >= this.hardCap) return null;
    const obj = this.free.pop() || this._create();
    this.active.add(obj);
    if (this.reset) this.reset(obj, ...args);
    return obj;
  }
  release(obj) {
    if (!this.active.delete(obj)) return;
    if (this.releaseFn) this.releaseFn(obj);
    this.free.push(obj);
  }
  releaseAll() { for (const o of Array.from(this.active)) this.release(o); }
  get size() { return this.active.size; }
  get capacity() { return this.created; }
}

/* ===========================================================================
 * LOD CONTROLLER
 * ======================================================================== */

export class LODController {
  /** bands: [{ dist, detail }] sorted ascending by dist. */
  constructor(bands = [{ dist: 900, detail: 2 }, { dist: 2600, detail: 1 }, { dist: 9000, detail: 0 }]) {
    this.bands = bands;
    this.bias = 1;
  }
  detailFor(distance) {
    const d = distance / Math.max(0.2, this.bias);
    for (const b of this.bands) if (d <= b.dist) return b.detail;
    return -1; // cull
  }
  /** Applies LOD by toggling child visibility on a group of [hi, mid, lo] meshes. */
  applyToSwapGroup(group, distance) {
    const detail = this.detailFor(distance);
    if (detail < 0) { group.visible = false; return -1; }
    group.visible = true;
    for (let i = 0; i < group.children.length; i++) {
      group.children[i].visible = (group.children.length - 1 - i) === detail
        || (detail >= group.children.length && i === 0);
    }
    return detail;
  }
}

/* ===========================================================================
 * LOAD PIPELINE — real staged progress
 * ------------------------------------------------------------------------
 * Stages carry a weight; progress is (completed weight + current stage's own
 * sub-progress) / total weight. Nothing is faked: the numbers move because
 * work actually finished.
 * ======================================================================== */

export class LoadPipeline {
  constructor(onProgress) {
    this.stages = [];
    this.onProgress = onProgress || (() => {});
    this.totalWeight = 0;
    this.doneWeight = 0;
    this.currentLabel = '';
    this.startTime = 0;
    this.aborted = false;
  }

  /** @param {string} label @param {number} weight @param {Function} fn async or sync, may take (report) */
  stage(label, weight, fn) {
    this.stages.push({ label, weight, fn });
    this.totalWeight += weight;
    return this;
  }

  _report(sub = 0) {
    const p = this.totalWeight ? clamp01((this.doneWeight + sub) / this.totalWeight) : 0;
    this.onProgress(p, this.currentLabel);
  }

  async run() {
    this.startTime = performance.now();
    for (const st of this.stages) {
      if (this.aborted) break;
      this.currentLabel = st.label;
      this._report(0);
      // Yield to the browser so the loading screen can actually paint.
      await nextFrame();
      const report = (frac) => this._report(st.weight * clamp01(frac));
      try {
        await st.fn(report);
      } catch (err) {
        console.error(`[Load] stage "${st.label}" failed:`, err);
      }
      this.doneWeight += st.weight;
      this._report(0);
    }
    this.currentLabel = 'Ready';
    this._report(0);
    return (performance.now() - this.startTime) / 1000;
  }
}

/** Await one animation frame (falls back to a timeout in hidden tabs). */
export function nextFrame() {
  return new Promise((res) => {
    if (document.hidden) setTimeout(res, 8);
    else requestAnimationFrame(() => res());
  });
}

/** Await until at least `ms` of work-free time has passed, yielding frames. */
export async function yieldFor(ms) {
  const t = performance.now();
  while (performance.now() - t < ms) await nextFrame();
}

/* ===========================================================================
 * FRAME BUDGET HELPERS
 * ======================================================================== */

/** Runs `fn` at most every `interval` seconds. Returns a tick(dt) closure. */
export function throttled(interval, fn) {
  let acc = interval;
  return (dt, ...args) => {
    acc += dt;
    if (acc >= interval) { acc = 0; return fn(...args); }
    return undefined;
  };
}

/** Round-robin work spreader: processes `slice` items of `arr` per call. */
export class RoundRobin {
  constructor(slice = 8) { this.slice = slice; this.cursor = 0; }
  process(arr, fn) {
    if (!arr.length) return;
    const n = Math.min(this.slice, arr.length);
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % arr.length;
      fn(arr[idx], idx);
    }
    this.cursor = (this.cursor + n) % arr.length;
  }
}

/* ===========================================================================
 * MEMORY HYGIENE
 * ======================================================================== */

/** Deeply dispose a three.js object's geometries/materials/textures. */
export function disposeObject(obj, disposedSets = null) {
  if (!obj) return;
  const geos = disposedSets?.geos || new Set();
  const mats = disposedSets?.mats || new Set();
  obj.traverse((n) => {
    if (n.geometry && !geos.has(n.geometry)) { geos.add(n.geometry); n.geometry.dispose(); }
    const m = n.material;
    if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    for (const mat of list) {
      if (mats.has(mat)) continue;
      mats.add(mat);
      for (const key of Object.keys(mat)) {
        const v = mat[key];
        if (v && v.isTexture) v.dispose();
      }
      mat.dispose();
    }
  });
}
