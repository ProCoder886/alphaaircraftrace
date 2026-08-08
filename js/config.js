/**
 * ALPHA AIRCRAFT RACE 3D — config.js
 * ---------------------------------------------------------------------------
 * Immutable game data: constants, tunables, content tables (aircraft, biomes,
 * weather, track segments, powers, difficulty, achievements) plus the seeded
 * deterministic RNG / noise utilities every procedural system is built on.
 *
 * Nothing in this module imports anything else — it is the root of the graph.
 */

export const VERSION = '1.0.0';
export const GAME_NAME = 'ALPHA AIRCRAFT RACE 3D';

/* ===========================================================================
 * MATH
 * ======================================================================== */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };

/** Framerate-independent exponential smoothing. `l` = higher is snappier. */
export const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));

/** Shortest signed angular difference (radians). */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Deadzone + expo curve used for every analogue axis in the game. */
export function shapeAxis(v, deadzone = 0.06, expo = 0.35) {
  const s = Math.sign(v);
  const a = Math.abs(v);
  if (a < deadzone) return 0;
  const n = (a - deadzone) / (1 - deadzone);
  return s * lerp(n, n * n * n, expo);
}

/* ===========================================================================
 * DETERMINISTIC RNG + NOISE
 * ------------------------------------------------------------------------
 * Every procedural system takes an explicit seed so any run can be replayed
 * bit-for-bit from its `runSeed` (surfaced in the debug overlay).
 * ======================================================================== */

/** xmur3 string hash → 32-bit seed. */
export function hashSeed(str) {
  str = String(str);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^= h >>> 16) >>> 0;
}

/** Integer hash — fast, well-distributed, used for per-cell noise lookups. */
export function hashInt(x) {
  x = (x ^ 61) ^ (x >>> 16);
  x = x + (x << 3);
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x >>> 0;
}

export function hash2(x, y) { return hashInt(Math.imul(x, 374761393) + Math.imul(y, 668265263) + 1442695040); }
export function hash3(x, y, z) { return hashInt(Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2246822519)); }

/** mulberry32 — small, fast, statistically fine for content generation. */
export class RNG {
  constructor(seed) { this.seed = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed); this.state = this.seed; }
  /** float [0,1) */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  float(a = 0, b = 1) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.float(a, b + 1)); }
  bool(p = 0.5) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** Weighted pick. `items` = [{ w, ... }] or parallel weights array. */
  weighted(items, weightOf = (i) => i.w ?? 1) {
    let total = 0;
    for (const it of items) total += weightOf(it);
    let r = this.next() * total;
    for (const it of items) { r -= weightOf(it); if (r <= 0) return it; }
    return items[items.length - 1];
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  /** Gaussian-ish via sum of uniforms — cheaper than Box–Muller, plenty good. */
  gauss(mean = 0, sd = 1) {
    return mean + sd * ((this.next() + this.next() + this.next() + this.next() - 2) * 1.1);
  }
  fork(salt) { return new RNG(hashSeed(`${this.seed}:${salt}`)); }
}

/** Smooth 2D value noise on an infinite lattice (seeded, allocation-free). */
export function valueNoise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const s = seed | 0;
  const n00 = hash3(xi, yi, s) / 4294967296;
  const n10 = hash3(xi + 1, yi, s) / 4294967296;
  const n01 = hash3(xi, yi + 1, s) / 4294967296;
  const n11 = hash3(xi + 1, yi + 1, s) / 4294967296;
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 2 - 1;
}

/** Fractal Brownian motion over valueNoise2. Returns roughly [-1, 1]. */
export function fbm2(x, y, seed = 0, octaves = 5, lacunarity = 2.03, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 131);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal — produces mountain ridges rather than rolling hills. */
export function ridged2(x, y, seed = 0, octaves = 5, lacunarity = 2.07, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, y * freq, seed + i * 977));
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return (sum / norm) * 2 - 1;
}

/* ===========================================================================
 * WORLD / PHYSICS CONSTANTS  (1 unit = 1 metre)
 * ======================================================================== */

export const WORLD = {
  pathNodeSpacing: 220,        // metres between race-path spline nodes
  nodesPerSegment: 9,          // path nodes contributed by one track segment
  checkpointEvery: 6,          // path nodes between checkpoints
  corridorRadius: 320,         // nominal free-flight tube radius around path
  corridorRadiusMin: 150,
  corridorRadiusMax: 620,
  terrainChunkSize: 3072,      // metres per terrain tile
  terrainGrid: 48,             // vertices per tile edge (LOD0)
  minAltitude: 40,             // below this over terrain = ground strike risk
  maxAltitude: 7200,           // above this the air thins and thrust falls off
  softCeiling: 5200,
  seaLevel: 0,
  streamAhead: 5,              // chunks kept ahead of the player (~26 km)
  streamBehind: 1,
  farPlane: 62000,
  gravity: 9.81,
};

export const PHYSICS = {
  gravity: 9.81,               // m/s² — used by the flight model and crash tumble
  // Speeds are stored in m/s internally; the HUD converts to km/h.
  minSpeed: 74,                // ~265 km/h — stall floor, engine holds you up
  cruiseSpeed: 320,            // ~1150 km/h
  maxSpeed: 500,               // ~1800 km/h
  boostSpeed: 640,             // ~2300 km/h with Turbo Overdrive stacked
  baseThrust: 145,             // m/s^2 at full throttle
  brakeDecel: 190,
  dragCoefficient: 0.00042,
  /* ---- flight dynamics --------------------------------------------------
   * The airframe flies on a real fighter's turn equation rather than on a flat
   * "pitch rate" number: the stick commands a LOAD FACTOR, and the resulting
   * body pitch rate is  q = G·(n − upY)/V. Everything that makes a jet feel
   * like a jet falls out of that one line — you turn far harder slow than
   * fast, the nose falls when you stop pulling, banking curves the flight path
   * without any special case, and holding G bleeds energy.
   *
   * `flightG` is a deliberately scaled gravity (real g would give ~14°/s at
   * racing speed, which is unflyable inside a corridor). Scaling it keeps every
   * relationship intact while landing the turn rates where the game needs them.
   * The G-meter reports the true, unitless load factor.
   * -------------------------------------------------------------------- */
  flightG: 46,                 // m/s² — scaled gravity for the flight dynamics
  gLimit: 9.0,                 // structural load factor at full pull
  gLimitNeg: 3.2,              // negative-G limit on a push
  cornerSpeed: 210,            // m/s — below this the wing cannot pull full G
  pitchTau: 0.20,              // s — how quickly the airframe reaches its G
  rollTau: 0.11,               // s — roll acceleration
  yawRate: 0.52,               // rad/s of rudder authority at low speed
  rollRate: 3.35,              // rad/s — ~190°/s, a real fighter roll rate
  adverseYaw: 0.085,           // yaw induced by rolling
  inducedDrag: 260,            // energy bled by pulling G
  spoolUp: 1.30,               // s — dry thrust lag
  spoolDown: 0.85,
  burnerLight: 0.34,           // s — afterburner light-off delay
  stallSink: 115,              // m/s of mush with no lift left
  autoLevel: 0.9,              // assist strength when the stick is centred
  boostAccel: 260,
  boostDrain: 26,              // boost units per second (meter is 0..100)
  boostRegen: 11,
  boostRegenDelay: 0.85,
  turbulenceScale: 1.0,
  collisionBounce: 0.42,
  maxHealth: 100,
};

/* ===========================================================================
 * GRAPHICS QUALITY PRESETS
 * ------------------------------------------------------------------------
 * EXTREME is the shipping default. MEDIUM is what the adaptive ladder falls
 * back to on weaker hardware and must still look premium: it keeps bloom,
 * motion blur, reflections and volumetric-style clouds — it trades draw
 * distance, shadow resolution and particle counts instead.
 * ======================================================================== */

export const QUALITY_PRESETS = {
  low: {
    label: 'LOW', pixelRatio: 0.72, shadows: false, shadowMapSize: 1024, shadowDistance: 900,
    bloom: true, bloomStrength: 0.5, motionBlur: false, chromatic: false, grain: false, blurTaps: 6,
    reflections: false, envMapSize: 64, envUpdateInterval: 999,
    cloudQuality: 0.35, cloudLayers: 2, weatherParticles: 500, particleBudget: 400,
    viewDistance: 0.55, terrainLOD: 2, propDensity: 0.35, trafficDensity: 0.4,
    trailSegments: 22, anisotropy: 2, aircraftDetail: 0, ssaa: 1, glassTransmission: false,
  },
  medium: {
    label: 'MEDIUM', pixelRatio: 0.92, shadows: true, shadowMapSize: 1536, shadowDistance: 1500,
    bloom: true, bloomStrength: 0.68, motionBlur: true, chromatic: true, grain: true, blurTaps: 10,
    reflections: true, envMapSize: 128, envUpdateInterval: 6,
    cloudQuality: 0.7, cloudLayers: 3, weatherParticles: 1400, particleBudget: 1200,
    viewDistance: 0.78, terrainLOD: 3, propDensity: 0.7, trafficDensity: 0.75,
    trailSegments: 40, anisotropy: 4, aircraftDetail: 1, ssaa: 1, glassTransmission: false,
  },
  high: {
    label: 'HIGH', pixelRatio: 1.0, shadows: true, shadowMapSize: 2048, shadowDistance: 2200,
    bloom: true, bloomStrength: 0.74, motionBlur: true, chromatic: true, grain: true, blurTaps: 12,
    reflections: true, envMapSize: 256, envUpdateInterval: 4,
    cloudQuality: 1.0, cloudLayers: 4, weatherParticles: 2600, particleBudget: 2200,
    viewDistance: 1.0, terrainLOD: 3, propDensity: 1.0, trafficDensity: 1.0,
    trailSegments: 56, anisotropy: 8, aircraftDetail: 2, ssaa: 1, glassTransmission: true,
  },
  ultra: {
    label: 'ULTRA', pixelRatio: 1.25, shadows: true, shadowMapSize: 3072, shadowDistance: 3200,
    bloom: true, bloomStrength: 0.8, motionBlur: true, chromatic: true, grain: true, blurTaps: 16,
    reflections: true, envMapSize: 384, envUpdateInterval: 3,
    cloudQuality: 1.35, cloudLayers: 5, weatherParticles: 4200, particleBudget: 3600,
    viewDistance: 1.25, terrainLOD: 4, propDensity: 1.35, trafficDensity: 1.2,
    trailSegments: 72, anisotropy: 16, aircraftDetail: 2, ssaa: 1, glassTransmission: true,
  },
  extreme: {
    label: 'EXTREME', pixelRatio: 1.6, shadows: true, shadowMapSize: 4096, shadowDistance: 4200,
    bloom: true, bloomStrength: 0.86, motionBlur: true, chromatic: true, grain: true, blurTaps: 20,
    reflections: true, envMapSize: 512, envUpdateInterval: 2,
    cloudQuality: 1.7, cloudLayers: 6, weatherParticles: 6000, particleBudget: 5200,
    viewDistance: 1.5, terrainLOD: 4, propDensity: 1.7, trafficDensity: 1.4,
    trailSegments: 90, anisotropy: 16, aircraftDetail: 2, ssaa: 1, glassTransmission: true,
  },
};
export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra', 'extreme'];

/* ===========================================================================
 * AIRCRAFT ROSTER
 * ------------------------------------------------------------------------
 * `shape` drives the procedural mesh builder in renderer.js, so every airframe
 * has a genuinely different silhouette rather than a recoloured clone.
 * Stats are 0..1 and are mapped onto real physics numbers in player.js.
 * ======================================================================== */

export const AIRCRAFT = [
  /* ---------------------------------------------------------------------
   * GLB airframes. These are real modelled aircraft loaded from
   * /Assets/3d/aircraft/.
   *
   * `model.quat` puts each one into the game's frame (nose = -Z, up = +Y,
   * right wing = +X). None of the three arrived axis-aligned — two are pitched
   * several degrees in their own files — so the quaternions were solved rather
   * than guessed: the direction in which an aircraft is thinnest is its "up",
   * the widest direction perpendicular to that is the fuselage, the blunter end
   * is the tail, and the fins point up. `model.length` is the fuselage length
   * in metres; the mesh is scaled uniformly to it. `nozzles` and `engineRadius`
   * are in those same metres, in the corrected frame. Wingtips are measured off
   * the fitted mesh at load time — exactly half the span, wherever that lands.
   *
   * `shape` is still supplied: it drives the hangar silhouette and is the
   * fallback airframe if a GLB ever fails to load.
   * ------------------------------------------------------------------ */
  {
    id: 'raptor', name: 'FR-22 RAPTOR', class: 'Air Superiority Fighter',
    desc: 'A twin-tail air superiority airframe in circuit livery. Thrust-vectoring nozzles and a huge control surface area make it the most obedient thing on the grid at high alpha.',
    stats: { speed: 0.88, accel: 0.86, handling: 0.90, boost: 0.84, durability: 0.72 },
    ability: 'Thrust Vectoring — 25% tighter turn radius while boosting.',
    abilityKey: 'vector',
    unlock: { type: 'default' },
    colors: { primary: 0xb3202c, secondary: 0x15161a, accent: 0xff4152, emissive: 0xffa050, trail: 0xff8a6a },
    model: {
      file: 'Assets/3d/aircraft/raptor.glb',
      lod1: 'Assets/3d/aircraft/raptor.lod1.glb',
      // Authored nose +Y / dorsal +Z, pitched a few degrees. Fits to 14.8 m span.
      quat: [-0.653743, -0.017117, -0.015360, 0.756367],
      length: 19.4,
      nozzles: [[0.85, -0.15, 8.95], [-0.85, -0.15, 8.95]],
      engineRadius: 0.42,
    },
    shape: {
      length: 19.4, noseLen: 0.32, noseSharp: 1.9, bodyW: 1.72, bodyH: 1.20,
      wingSpan: 15.2, wingSweep: 0.70, wingRoot: 7.0, wingTip: 1.4, wingDihedral: 0.02, wingPos: 0.03,
      canard: 0.5, canardSpan: 5.4, tail: 'twin', tailSize: 1.12, tailCant: 0.48,
      engines: 2, engineSep: 1.44, engineR: 0.94, nozzleFlare: 1.24, intake: 'side',
      strakes: 1.2, ventral: 0.6, livery: 'blade',
    },
  },
  {
    id: 'falcon', name: 'FA-19 FALCON', class: 'Carrier Strike Fighter',
    desc: 'A navalised strike fighter in display-team colours. Built to be caught by a wire at sea, which makes it astonishingly stable in dirty air and at low speed.',
    stats: { speed: 0.80, accel: 0.82, handling: 0.84, boost: 0.78, durability: 0.88 },
    ability: 'Carrier Trim — auto-levelling assist is 30% stronger.',
    abilityKey: 'trim',
    unlock: { type: 'default' },
    colors: { primary: 0x13182c, secondary: 0xf2c032, accent: 0xffd24a, emissive: 0x9fd8ff, trail: 0xffd98a },
    model: {
      file: 'Assets/3d/aircraft/falcon.glb',
      lod1: 'Assets/3d/aircraft/falcon.lod1.glb',
      // Authored nose +Z / dorsal +Y. The gear is down in the mesh, which is why
      // the bounding box is tall and the nozzles sit well above its centre.
      quat: [0.991796, -0.000038, 0.000005, 0.127829],
      length: 17.6,
      nozzles: [[0.60, 0.95, 8.20], [-0.60, 0.95, 8.20]],
      engineRadius: 0.40,
    },
    shape: {
      length: 17.6, noseLen: 0.30, noseSharp: 1.6, bodyW: 1.66, bodyH: 1.28,
      wingSpan: 13.4, wingSweep: 0.52, wingRoot: 5.8, wingTip: 1.8, wingDihedral: 0.04, wingPos: 0.05,
      canard: 0.0, canardSpan: 0, tail: 'twin', tailSize: 1.08, tailCant: 0.52,
      engines: 2, engineSep: 1.30, engineR: 0.90, nozzleFlare: 1.14, intake: 'side',
      strakes: 1.35, ventral: 0.4, livery: 'chevron',
    },
  },
  {
    id: 'warhawk', name: 'MK-29 WARHAWK', class: 'Heavy Interceptor',
    desc: 'A big twin-engine interceptor built around two enormous powerplants. It does not turn so much as re-aim, but nothing on the grid accelerates through the top of the range like it does.',
    stats: { speed: 0.94, accel: 0.90, handling: 0.66, boost: 0.92, durability: 0.82 },
    ability: 'Ram Intakes — boost recharges 35% faster above 1400 km/h.',
    abilityKey: 'ramair',
    unlock: { type: 'default' },
    colors: { primary: 0x9aa3ad, secondary: 0x353c45, accent: 0x7fb8e8, emissive: 0xbfe0ff, trail: 0xbcd8f2 },
    model: {
      file: 'Assets/3d/aircraft/warhawk.glb',
      lod1: 'Assets/3d/aircraft/warhawk.lod1.glb',
      // Authored nose +Y / dorsal +Z with a noticeable pitch. Fits to 17.2 m span
      // — widely spaced engine nacelles, hence the wide, low nozzles.
      quat: [-0.546387, -0.029391, 0.002659, 0.837013],
      length: 21.2,
      nozzles: [[1.15, -1.00, 9.60], [-1.15, -1.00, 9.60]],
      engineRadius: 0.60,
    },
    shape: {
      length: 21.2, noseLen: 0.28, noseSharp: 1.7, bodyW: 1.96, bodyH: 1.42,
      wingSpan: 16.0, wingSweep: 0.62, wingRoot: 7.6, wingTip: 2.0, wingDihedral: 0.01, wingPos: 0.02,
      canard: 0.0, canardSpan: 0, tail: 'twin', tailSize: 1.24, tailCant: 0.40,
      engines: 2, engineSep: 1.70, engineR: 1.08, nozzleFlare: 1.30, intake: 'side',
      strakes: 1.4, ventral: 0.8, livery: 'splinter',
    },
  },
  {
    id: 'vector', name: 'AX-01 VECTOR', class: 'Balanced Interceptor',
    desc: 'The reference airframe of the Alpha circuit. Neutral handling, forgiving recovery and a wide power band — everything a rookie needs and nothing they do not.',
    stats: { speed: 0.62, accel: 0.66, handling: 0.70, boost: 0.62, durability: 0.66 },
    ability: 'Adaptive Trim — auto-levelling assist is 30% stronger.',
    abilityKey: 'trim',
    unlock: { type: 'default' },
    colors: { primary: 0x8d99a6, secondary: 0x252b33, accent: 0x2ff0d0, emissive: 0x39f5ff, trail: 0x63e9ff },
    shape: {
      length: 17.5, noseLen: 0.30, noseSharp: 1.5, bodyW: 1.55, bodyH: 1.30,
      wingSpan: 12.4, wingSweep: 0.62, wingRoot: 5.6, wingTip: 1.5, wingDihedral: 0.03, wingPos: 0.06,
      canard: 0.55, canardSpan: 5.0, tail: 'twin', tailSize: 1.0, tailCant: 0.42,
      engines: 2, engineSep: 1.35, engineR: 0.86, nozzleFlare: 1.18, intake: 'side',
      strakes: 1.0, ventral: 0.5, livery: 'stripe',
    },
  },
  {
    id: 'talon', name: 'SR-9 TALON', class: 'Speed Specialist',
    desc: 'A fuselage wrapped around two oversized reheat cores. Devastating on the long sky-highways, punishing in the canyon work.',
    stats: { speed: 0.95, accel: 0.84, handling: 0.44, boost: 0.86, durability: 0.48 },
    ability: 'Ram Air — boost recharges 35% faster above 1400 km/h.',
    abilityKey: 'ramair',
    unlock: { type: 'credits', cost: 4500 },
    colors: { primary: 0xc41f2e, secondary: 0x14161a, accent: 0xff5a3c, emissive: 0xff7a2a, trail: 0xff8a3a },
    shape: {
      length: 21.0, noseLen: 0.36, noseSharp: 2.3, bodyW: 1.42, bodyH: 1.18,
      wingSpan: 11.0, wingSweep: 0.86, wingRoot: 7.4, wingTip: 0.9, wingDihedral: -0.02, wingPos: 0.02,
      canard: 0.0, canardSpan: 0, tail: 'twin', tailSize: 1.15, tailCant: 0.30,
      engines: 2, engineSep: 1.5, engineR: 1.02, nozzleFlare: 1.34, intake: 'chin',
      strakes: 1.3, ventral: 0.9, livery: 'blade',
    },
  },
  {
    id: 'kestrel', name: 'KV-7 KESTREL', class: 'Agility Specialist',
    desc: 'Forward canards, huge control authority and a body built to change direction. Threads gate chains that other frames have to slow down for.',
    stats: { speed: 0.66, accel: 0.74, handling: 0.96, boost: 0.60, durability: 0.52 },
    ability: 'Vector Thrust — 25% tighter turn radius while boosting.',
    abilityKey: 'vector',
    unlock: { type: 'credits', cost: 5200 },
    colors: { primary: 0x2fbf4f, secondary: 0x1c2228, accent: 0x9dff4a, emissive: 0x7bff3d, trail: 0x9dff6a },
    shape: {
      length: 16.6, noseLen: 0.27, noseSharp: 1.3, bodyW: 1.66, bodyH: 1.34,
      wingSpan: 14.2, wingSweep: 0.44, wingRoot: 5.0, wingTip: 2.0, wingDihedral: 0.09, wingPos: 0.08,
      canard: 0.9, canardSpan: 6.6, tail: 'twin', tailSize: 1.1, tailCant: 0.58,
      engines: 2, engineSep: 1.22, engineR: 0.80, nozzleFlare: 1.10, intake: 'side',
      strakes: 0.8, ventral: 0.35, livery: 'splinter',
    },
  },
  {
    id: 'bastion', name: 'HB-4 BASTION', class: 'Heavy Assault Racer',
    desc: 'Armoured leading edges and a reinforced spine. It shrugs off contact that would end another pilot\'s race, then grinds the place back.',
    stats: { speed: 0.70, accel: 0.52, handling: 0.48, boost: 0.66, durability: 1.00 },
    ability: 'Ablative Hull — collision damage reduced by 40%.',
    abilityKey: 'ablative',
    unlock: { type: 'credits', cost: 6800 },
    colors: { primary: 0xe8b21c, secondary: 0x1b1b1d, accent: 0xffd85e, emissive: 0xffae2b, trail: 0xffcd6a },
    shape: {
      length: 20.2, noseLen: 0.24, noseSharp: 1.1, bodyW: 2.05, bodyH: 1.66,
      wingSpan: 13.6, wingSweep: 0.58, wingRoot: 6.8, wingTip: 2.3, wingDihedral: 0.02, wingPos: 0.00,
      canard: 0.4, canardSpan: 5.2, tail: 'twin', tailSize: 1.28, tailCant: 0.36,
      engines: 2, engineSep: 1.72, engineR: 1.12, nozzleFlare: 1.26, intake: 'side',
      strakes: 1.5, ventral: 1.1, livery: 'hazard',
    },
  },
  {
    id: 'wraith', name: 'NX-3 WRAITH', class: 'Stealth Prototype',
    desc: 'Faceted, radar-dark and unnervingly quiet until the reheat lights. Built for pilots who prefer to be past you before you knew they were there.',
    stats: { speed: 0.80, accel: 0.78, handling: 0.76, boost: 0.74, durability: 0.58 },
    ability: 'Ghost Frame — Phase Shift lasts 50% longer.',
    abilityKey: 'ghost',
    unlock: { type: 'credits', cost: 9000 },
    colors: { primary: 0x4a5058, secondary: 0x101317, accent: 0x9fb4c7, emissive: 0x8fd6ff, trail: 0xaad4ff },
    shape: {
      length: 19.0, noseLen: 0.33, noseSharp: 1.9, bodyW: 1.95, bodyH: 1.05,
      wingSpan: 13.8, wingSweep: 0.78, wingRoot: 8.2, wingTip: 1.2, wingDihedral: 0.0, wingPos: 0.0,
      canard: 0.0, canardSpan: 0, tail: 'v', tailSize: 1.0, tailCant: 0.72,
      engines: 2, engineSep: 1.30, engineR: 0.84, nozzleFlare: 0.92, intake: 'dorsal',
      strakes: 1.1, ventral: 0.2, livery: 'facet',
    },
  },
  {
    id: 'phantom', name: 'PH-12 PHANTOM', class: 'Technical Racer',
    desc: 'A route-runner\'s frame. Extended sensor spine, superb low-speed control and the stability to take shortcuts nobody else attempts.',
    stats: { speed: 0.74, accel: 0.80, handling: 0.86, boost: 0.70, durability: 0.62 },
    ability: 'Deep Scan — Route Scan reveals shortcuts 60% further ahead.',
    abilityKey: 'deepscan',
    unlock: { type: 'credits', cost: 11500 },
    colors: { primary: 0x7b4fd6, secondary: 0xe9edf2, accent: 0xc79bff, emissive: 0xb478ff, trail: 0xc79bff },
    shape: {
      length: 18.4, noseLen: 0.38, noseSharp: 2.0, bodyW: 1.60, bodyH: 1.24,
      wingSpan: 13.2, wingSweep: 0.54, wingRoot: 5.4, wingTip: 1.8, wingDihedral: 0.06, wingPos: 0.05,
      canard: 0.75, canardSpan: 5.8, tail: 'twin', tailSize: 1.05, tailCant: 0.50,
      engines: 2, engineSep: 1.28, engineR: 0.82, nozzleFlare: 1.14, intake: 'side',
      strakes: 0.9, ventral: 0.4, livery: 'circuit',
    },
  },
  {
    id: 'zephyr', name: 'ZR-8 ZEPHYR', class: 'Elite Airframe',
    desc: 'Circuit-legal exotics only. There is no weak axis on this aircraft, which is exactly why it costs what it costs.',
    stats: { speed: 0.88, accel: 0.90, handling: 0.88, boost: 0.90, durability: 0.70 },
    ability: 'Circuit Tuning — all power cooldowns reduced by 15%.',
    abilityKey: 'tuning',
    unlock: { type: 'credits', cost: 18000 },
    colors: { primary: 0xf2f4f7, secondary: 0x2a2f36, accent: 0xffcf4d, emissive: 0xffd76b, trail: 0xfff0b0 },
    shape: {
      length: 19.6, noseLen: 0.34, noseSharp: 1.8, bodyW: 1.68, bodyH: 1.22,
      wingSpan: 13.9, wingSweep: 0.68, wingRoot: 6.4, wingTip: 1.5, wingDihedral: 0.04, wingPos: 0.04,
      canard: 0.65, canardSpan: 5.6, tail: 'twin', tailSize: 1.12, tailCant: 0.46,
      engines: 2, engineSep: 1.40, engineR: 0.92, nozzleFlare: 1.22, intake: 'side',
      strakes: 1.2, ventral: 0.6, livery: 'chevron',
    },
  },
  {
    id: 'omega', name: 'OM-X OMEGA', class: 'Legendary Prototype',
    desc: 'An experimental core wrapped in an airframe that should not be flyable. Reheat measured in the wrong units. Reserved for pilots who have proven everything else.',
    stats: { speed: 1.00, accel: 0.96, handling: 0.82, boost: 1.00, durability: 0.74 },
    ability: 'Overcharge — Turbo Overdrive grants an extra 12% top speed.',
    abilityKey: 'overcharge',
    unlock: { type: 'achievement', id: 'legend', label: 'Win a Legendary difficulty race' },
    colors: { primary: 0x14161b, secondary: 0x2b2f38, accent: 0xff7a18, emissive: 0xff9a2e, trail: 0xffb15a },
    shape: {
      length: 22.0, noseLen: 0.35, noseSharp: 2.2, bodyW: 1.86, bodyH: 1.30,
      wingSpan: 15.0, wingSweep: 0.74, wingRoot: 7.8, wingTip: 1.3, wingDihedral: 0.05, wingPos: 0.03,
      canard: 0.8, canardSpan: 6.2, tail: 'twin', tailSize: 1.22, tailCant: 0.54,
      engines: 2, engineSep: 1.56, engineR: 1.06, nozzleFlare: 1.42, intake: 'chin',
      strakes: 1.4, ventral: 0.8, livery: 'ember',
    },
  },
  {
    id: 'vipera', name: 'VP-5 VIPERA', class: 'Aggressive Duellist',
    desc: 'Twitchy, unstable, absurdly quick to rotate. Built for close-quarters overtaking and near-miss chains, not for relaxing.',
    stats: { speed: 0.84, accel: 0.88, handling: 0.80, boost: 0.78, durability: 0.44 },
    ability: 'Predator — near misses award 40% more score and combo.',
    abilityKey: 'predator',
    unlock: { type: 'credits', cost: 14000 },
    colors: { primary: 0x9d0f2b, secondary: 0x1a1416, accent: 0xff2f5f, emissive: 0xff3a6a, trail: 0xff6a92 },
    shape: {
      length: 17.8, noseLen: 0.31, noseSharp: 2.1, bodyW: 1.48, bodyH: 1.16,
      wingSpan: 12.0, wingSweep: 0.72, wingRoot: 6.2, wingTip: 1.1, wingDihedral: -0.05, wingPos: 0.02,
      canard: 0.7, canardSpan: 5.4, tail: 'v', tailSize: 1.06, tailCant: 0.66,
      engines: 2, engineSep: 1.24, engineR: 0.88, nozzleFlare: 1.28, intake: 'side',
      strakes: 1.25, ventral: 0.7, livery: 'fang',
    },
  },
  {
    id: 'aurora', name: 'AU-0 AURORA', class: 'Endurance Frame',
    desc: 'A long-range survey airframe pressed into racing. Enormous internal volume means shields that hold and boost that never quite runs dry.',
    stats: { speed: 0.68, accel: 0.60, handling: 0.66, boost: 0.94, durability: 0.86 },
    ability: 'Deep Reserves — boost meter capacity increased by 30%.',
    abilityKey: 'reserves',
    unlock: { type: 'credits', cost: 8200 },
    colors: { primary: 0x2fa5b8, secondary: 0xc9d3da, accent: 0x7ff0ff, emissive: 0x5fe4ff, trail: 0x8ff4ff },
    shape: {
      length: 20.8, noseLen: 0.29, noseSharp: 1.4, bodyW: 1.92, bodyH: 1.52,
      wingSpan: 15.6, wingSweep: 0.50, wingRoot: 6.0, wingTip: 2.6, wingDihedral: 0.08, wingPos: 0.05,
      canard: 0.5, canardSpan: 5.4, tail: 'twin', tailSize: 1.18, tailCant: 0.40,
      engines: 2, engineSep: 1.62, engineR: 1.00, nozzleFlare: 1.12, intake: 'side',
      strakes: 1.0, ventral: 0.6, livery: 'wave',
    },
  },
];

export const AIRCRAFT_BY_ID = Object.fromEntries(AIRCRAFT.map((a) => [a.id, a]));

/* ===========================================================================
 * BIOMES / LOCATIONS
 * ------------------------------------------------------------------------
 * Every entry is an *aerial* interpretation: the aircraft always races through
 * open sky, the biome decides what is underneath and what the air looks like.
 * ======================================================================== */

const B = (o) => o;
export const BIOMES = [
  B({
    id: 'forest', name: 'EMERALD BASIN', short: 'Forest',
    desc: 'Deep conifer valleys and river basins under fast-moving weather. Wide corridors, soft terrain, generous racing lines.',
    difficulty: 0.75, order: 0,
    ground: { base: 0x2f4a2a, high: 0x6f7f5a, low: 0x1e3320, rock: 0x5a5b52, snowLine: 2600, water: 0x1d3b4a },
    relief: { scale: 0.00042, height: 900, ridge: 0.45, roughness: 0.55, plateau: 0.2, water: 0.22 },
    props: { trees: 1.0, buildings: 0.12, rocks: 0.4, towers: 0.1, farms: 0.25 },
    weather: ['clear', 'cloudy', 'lightRain', 'heavyRain', 'fog', 'sunset'],
    times: ['morning', 'noon', 'afternoon', 'sunset'],
    accent: 0x7fdc6a, fogTint: 0xa9c4b4, landmark: ['ridgeTower', 'archBridge', 'dam'],
  }),
  B({
    id: 'ice', name: 'GLACIER REACH', short: 'Ice',
    desc: 'Frozen ranges and calving shelves. Whiteout squalls, brutal crosswinds and ice pillars that appear with almost no warning.',
    difficulty: 1.15, order: 1,
    ground: { base: 0xd8e6ef, high: 0xffffff, low: 0x9fb9cc, rock: 0x6d7c8a, snowLine: 200, water: 0x2b5c78 },
    relief: { scale: 0.00036, height: 1500, ridge: 0.75, roughness: 0.6, plateau: 0.28, water: 0.3 },
    props: { trees: 0.05, buildings: 0.06, rocks: 0.9, towers: 0.12, farms: 0 },
    weather: ['snow', 'heavySnow', 'fog', 'storm', 'clear', 'cloudy'],
    times: ['morning', 'noon', 'dusk'],
    accent: 0x9fe8ff, fogTint: 0xcfe3f2, landmark: ['iceArch', 'ridgeTower', 'shelfWall'],
  }),
  B({
    id: 'night', name: 'MIDNIGHT CORRIDOR', short: 'Night',
    desc: 'A dark-sky circuit lit only by gate energy, aircraft trails and the settlements far below. Depth perception is the whole challenge.',
    difficulty: 1.25, order: 2,
    ground: { base: 0x121820, high: 0x1c2530, low: 0x0a0e14, rock: 0x1a1f27, snowLine: 3200, water: 0x060b12 },
    relief: { scale: 0.0004, height: 1100, ridge: 0.55, roughness: 0.5, plateau: 0.22, water: 0.25 },
    props: { trees: 0.4, buildings: 0.55, rocks: 0.4, towers: 0.5, farms: 0.1 },
    weather: ['night', 'neonNight', 'lightRain', 'fog', 'storm'],
    times: ['night'],
    accent: 0x63a8ff, fogTint: 0x121a26, landmark: ['beaconTower', 'archBridge', 'ringGateArray'],
  }),
  B({
    id: 'desert', name: 'ASHFALL FLATS', short: 'Desert',
    desc: 'Endless dunes broken by mesa fields and dry riverbeds. Thermals throw the aircraft around; dust storms erase the horizon.',
    difficulty: 0.95, order: 3,
    ground: { base: 0xc9a06a, high: 0xe6cfa2, low: 0x8f6b42, rock: 0xa5703f, snowLine: 9999, water: 0x3c6b6b },
    relief: { scale: 0.00030, height: 700, ridge: 0.35, roughness: 0.4, plateau: 0.55, water: 0.06 },
    props: { trees: 0.05, buildings: 0.1, rocks: 0.7, towers: 0.2, farms: 0.05 },
    weather: ['clear', 'dustStorm', 'sunset', 'sunrise', 'cloudy'],
    times: ['noon', 'afternoon', 'sunset', 'sunrise'],
    accent: 0xffb35c, fogTint: 0xd9b183, landmark: ['mesaArch', 'solarField', 'ridgeTower'],
  }),
  B({
    id: 'jungle', name: 'VERDANT DELTA', short: 'Jungle',
    desc: 'Steaming canopy, karst spires and braided waterways. Low visibility, high humidity and gates hidden inside the cloud layer.',
    difficulty: 1.05, order: 4,
    ground: { base: 0x1f4a26, high: 0x3f6b32, low: 0x123219, rock: 0x4c5340, snowLine: 9999, water: 0x14494a },
    relief: { scale: 0.00050, height: 820, ridge: 0.68, roughness: 0.7, plateau: 0.14, water: 0.34 },
    props: { trees: 1.35, buildings: 0.08, rocks: 0.55, towers: 0.12, farms: 0.08 },
    weather: ['heavyRain', 'fog', 'cloudy', 'sunrise', 'storm', 'lightRain'],
    times: ['sunrise', 'morning', 'noon'],
    accent: 0x54e08a, fogTint: 0xa8c7ae, landmark: ['ruinTemple', 'archBridge', 'karstSpire'],
  }),
  B({
    id: 'bunker', name: 'IRON BASTION', short: 'Bunker',
    desc: 'A hardened military plateau of concrete revetments, blast doors and searchlight towers. Tight, overcast, unfriendly airspace.',
    difficulty: 1.2, order: 5,
    ground: { base: 0x4a4d4a, high: 0x6a6d68, low: 0x2c2f2e, rock: 0x585b57, snowLine: 9999, water: 0x223034 },
    relief: { scale: 0.00034, height: 520, ridge: 0.3, roughness: 0.45, plateau: 0.7, water: 0.1 },
    props: { trees: 0.1, buildings: 0.85, rocks: 0.35, towers: 0.75, farms: 0 },
    weather: ['cloudy', 'fog', 'storm', 'lightRain', 'night'],
    times: ['morning', 'afternoon', 'dusk'],
    accent: 0xffa63d, fogTint: 0x8a8f92, landmark: ['bunkerComplex', 'radarArray', 'beaconTower'],
  }),
  B({
    id: 'basement', name: 'THE UNDERVAULT', short: 'Basement',
    desc: 'A collapsed sub-surface reservoir the size of a city. You fly beneath a rock ceiling on industrial lighting alone — the tightest corridor on the circuit.',
    difficulty: 1.45, order: 6,
    ground: { base: 0x33302c, high: 0x4a453e, low: 0x1a1815, rock: 0x3d3831, snowLine: 9999, water: 0x152026 },
    relief: { scale: 0.00058, height: 640, ridge: 0.8, roughness: 0.8, plateau: 0.15, water: 0.3 },
    props: { trees: 0, buildings: 0.5, rocks: 1.2, towers: 0.5, farms: 0 },
    weather: ['fog', 'night', 'cloudy'],
    times: ['night'],
    accent: 0xffc24d, fogTint: 0x2a2622, ceiling: true, landmark: ['pillarField', 'bunkerComplex', 'pipeworks'],
  }),
  B({
    id: 'mudwater', name: 'DROWNED FLATS', short: 'Mud & Water',
    desc: 'A flooded delta of silt banks and standing water. Mirror-flat reflections, permanent rain and almost no altitude to play with.',
    difficulty: 1.0, order: 7,
    ground: { base: 0x4a4030, high: 0x6b5c44, low: 0x2a2620, rock: 0x54503f, snowLine: 9999, water: 0x2c3f3a },
    relief: { scale: 0.00028, height: 260, ridge: 0.2, roughness: 0.35, plateau: 0.5, water: 0.62 },
    props: { trees: 0.45, buildings: 0.2, rocks: 0.3, towers: 0.25, farms: 0.3 },
    weather: ['heavyRain', 'lightRain', 'fog', 'storm', 'cloudy', 'sunset'],
    times: ['morning', 'afternoon', 'sunset', 'dusk'],
    accent: 0x8fd8c0, fogTint: 0x9aa79c, landmark: ['dam', 'archBridge', 'stiltVillage'],
  }),
  B({
    id: 'fortress', name: 'CITADEL SIEGE', short: 'Fortress',
    desc: 'A walled highland citadel of curtain walls, keeps and siege towers, ringed by storm cells. Low passes between the bastions are worth the risk.',
    difficulty: 1.3, order: 8,
    ground: { base: 0x4f4a41, high: 0x736c5e, low: 0x2b2a27, rock: 0x605a4f, snowLine: 3000, water: 0x2b4450 },
    relief: { scale: 0.00040, height: 1050, ridge: 0.62, roughness: 0.58, plateau: 0.42, water: 0.28 },
    props: { trees: 0.3, buildings: 0.95, rocks: 0.6, towers: 0.9, farms: 0.15 },
    weather: ['storm', 'thunderstorm', 'cloudy', 'fog', 'sunset', 'heavyRain'],
    times: ['afternoon', 'dusk', 'sunset'],
    accent: 0xffb648, fogTint: 0x8e9299, landmark: ['citadel', 'archBridge', 'beaconTower'],
  }),
  B({
    id: 'redstone', name: 'CRIMSON CONDUIT', short: 'Redstone',
    desc: 'Iron-red mesa country threaded with glowing power conduits and pylon lines. Every shortcut runs between live energy fields.',
    difficulty: 1.2, order: 9,
    ground: { base: 0x8c3a24, high: 0xc2653a, low: 0x4a1c14, rock: 0x9c4a2a, snowLine: 9999, water: 0x3a2a26 },
    relief: { scale: 0.00033, height: 880, ridge: 0.5, roughness: 0.5, plateau: 0.62, water: 0.08 },
    props: { trees: 0.05, buildings: 0.25, rocks: 0.85, towers: 0.8, farms: 0 },
    weather: ['clear', 'dustStorm', 'sunset', 'thunderstorm', 'night'],
    times: ['afternoon', 'sunset', 'dusk'],
    accent: 0xff4a2a, fogTint: 0xb47458, landmark: ['conduitPylon', 'mesaArch', 'refinery'],
  }),
  B({
    id: 'tower', name: 'SPIRE ASCENT', short: 'Tower',
    desc: 'A cluster of kilometre-scale spires rising out of the cloud deck. Vertical racing: the route climbs and dives around the structures themselves.',
    difficulty: 1.35, order: 10,
    ground: { base: 0x3a4048, high: 0x545c66, low: 0x22262c, rock: 0x424852, snowLine: 4200, water: 0x1d2a34 },
    relief: { scale: 0.00038, height: 760, ridge: 0.42, roughness: 0.45, plateau: 0.45, water: 0.2 },
    props: { trees: 0.15, buildings: 0.6, rocks: 0.35, towers: 1.6, farms: 0 },
    weather: ['cloudy', 'clear', 'storm', 'fog', 'sunset', 'neonNight'],
    times: ['morning', 'afternoon', 'sunset', 'night'],
    accent: 0x6fd0ff, fogTint: 0xa8b6c4, landmark: ['megaSpire', 'skyBridge', 'ringGateArray'],
  }),
  B({
    id: 'village', name: 'HOLLOW VALE', short: 'Village',
    desc: 'Patchwork farmland, hamlets and windmill ridges at first light. The gentlest terrain on the circuit — and the fastest lap times.',
    difficulty: 0.65, order: 11,
    ground: { base: 0x5c7a3e, high: 0x8ea45e, low: 0x3d5430, rock: 0x6a6552, snowLine: 3000, water: 0x2f5a68 },
    relief: { scale: 0.00030, height: 480, ridge: 0.25, roughness: 0.4, plateau: 0.5, water: 0.2 },
    props: { trees: 0.6, buildings: 0.45, rocks: 0.2, towers: 0.3, farms: 1.2 },
    weather: ['sunrise', 'clear', 'cloudy', 'lightRain', 'fog'],
    times: ['sunrise', 'morning', 'noon'],
    accent: 0xffd98a, fogTint: 0xcfd6b8, landmark: ['windmillRidge', 'stiltVillage', 'archBridge'],
  }),
  B({
    id: 'city', name: 'MERIDIAN SPRAWL', short: 'City',
    desc: 'A living megacity of glass towers and elevated arterials. The line runs between the buildings, not above them.',
    difficulty: 1.1, order: 12,
    ground: { base: 0x3c4149, high: 0x596069, low: 0x24282e, rock: 0x454a52, snowLine: 9999, water: 0x1c3040 },
    relief: { scale: 0.00026, height: 340, ridge: 0.2, roughness: 0.3, plateau: 0.75, water: 0.18 },
    props: { trees: 0.3, buildings: 1.6, rocks: 0.1, towers: 1.1, farms: 0 },
    weather: ['clear', 'cloudy', 'lightRain', 'sunset', 'night', 'neonNight', 'fog'],
    times: ['morning', 'noon', 'afternoon', 'sunset', 'night'],
    accent: 0x64c8ff, fogTint: 0xb9c6d2, landmark: ['megaSpire', 'skyBridge', 'stadium'],
  }),
  B({
    id: 'mountain', name: 'TITAN RANGE', short: 'Mountain',
    desc: 'Serrated high peaks and glacial saddles. The route threads passes barely wider than a wingspan at nine hundred metres a second.',
    difficulty: 1.25, order: 13,
    ground: { base: 0x565f5a, high: 0xe8eef2, low: 0x33403c, rock: 0x6a716d, snowLine: 1800, water: 0x24444f },
    relief: { scale: 0.00030, height: 2100, ridge: 0.9, roughness: 0.7, plateau: 0.12, water: 0.14 },
    props: { trees: 0.5, buildings: 0.08, rocks: 1.0, towers: 0.15, farms: 0.05 },
    weather: ['clear', 'cloudy', 'snow', 'storm', 'fog', 'sunset'],
    times: ['sunrise', 'morning', 'afternoon', 'sunset'],
    accent: 0xbfe6ff, fogTint: 0xb8c8d6, landmark: ['ridgeTower', 'archBridge', 'summitGate'],
  }),
  B({
    id: 'canyon', name: 'RIFT CANYONS', short: 'Canyon',
    desc: 'A drainage network cut a kilometre deep. Almost the entire race happens below the rim, where the walls decide your line.',
    difficulty: 1.3, order: 14,
    ground: { base: 0xa8663c, high: 0xd39a63, low: 0x5c3421, rock: 0x8f5230, snowLine: 9999, water: 0x2f5560 },
    relief: { scale: 0.00042, height: 1250, ridge: 0.85, roughness: 0.62, plateau: 0.55, water: 0.16 },
    props: { trees: 0.12, buildings: 0.1, rocks: 1.1, towers: 0.25, farms: 0 },
    weather: ['clear', 'dustStorm', 'sunset', 'cloudy', 'thunderstorm'],
    times: ['morning', 'noon', 'afternoon', 'sunset'],
    accent: 0xffa04a, fogTint: 0xc99a72, landmark: ['mesaArch', 'archBridge', 'canyonNarrows'],
  }),
  B({
    id: 'storm', name: 'TEMPEST FRONT', short: 'Storm',
    desc: 'A permanent supercell system. Lightning fields, violent shear and cloud walls that swallow gates whole. The circuit\'s highest-risk venue.',
    difficulty: 1.5, order: 15,
    ground: { base: 0x3b4348, high: 0x545f66, low: 0x232a2f, rock: 0x474f55, snowLine: 3400, water: 0x1b2a33 },
    relief: { scale: 0.00040, height: 1250, ridge: 0.7, roughness: 0.65, plateau: 0.25, water: 0.32 },
    props: { trees: 0.3, buildings: 0.2, rocks: 0.6, towers: 0.4, farms: 0.05 },
    weather: ['thunderstorm', 'storm', 'heavyRain', 'fog'],
    times: ['afternoon', 'dusk', 'night'],
    accent: 0x8fb6ff, fogTint: 0x6b7783, landmark: ['stormPylon', 'ridgeTower', 'archBridge'],
  }),
  B({
    id: 'neon', name: 'NEON MEGACITY', short: 'Neon',
    desc: 'Rain-slick hologram canyons at three in the morning. Every surface is a light source and every reflection lies about the distance.',
    difficulty: 1.4, order: 16,
    ground: { base: 0x191d29, high: 0x2a3145, low: 0x0d1018, rock: 0x212636, snowLine: 9999, water: 0x0d1622 },
    relief: { scale: 0.00026, height: 300, ridge: 0.2, roughness: 0.3, plateau: 0.8, water: 0.18 },
    props: { trees: 0.1, buildings: 1.8, rocks: 0.05, towers: 1.4, farms: 0 },
    weather: ['neonNight', 'night', 'heavyRain', 'fog', 'lightRain'],
    times: ['night'],
    accent: 0xff2fd0, fogTint: 0x2a2140, landmark: ['megaSpire', 'skyBridge', 'holoArray'],
  }),
];

export const BIOMES_BY_ID = Object.fromEntries(BIOMES.map((b) => [b.id, b]));

/* ===========================================================================
 * WEATHER + TIME OF DAY
 * ======================================================================== */

export const WEATHER = {
  clear:        { name: 'Clear',          cloud: 0.22, fog: 0.35, vis: 1.00, precip: null,  precipRate: 0,    wind: 0.25, turb: 0.20, lightning: 0,    sat: 1.05, exposure: 1.00 },
  cloudy:       { name: 'Cloudy',         cloud: 0.68, fog: 0.55, vis: 0.86, precip: null,  precipRate: 0,    wind: 0.40, turb: 0.35, lightning: 0,    sat: 0.94, exposure: 0.94 },
  lightRain:    { name: 'Light Rain',     cloud: 0.78, fog: 0.70, vis: 0.72, precip: 'rain', precipRate: 0.35, wind: 0.50, turb: 0.45, lightning: 0,    sat: 0.90, exposure: 0.88 },
  heavyRain:    { name: 'Heavy Rain',     cloud: 0.92, fog: 0.88, vis: 0.54, precip: 'rain', precipRate: 1.00, wind: 0.72, turb: 0.68, lightning: 0.05, sat: 0.84, exposure: 0.80 },
  storm:        { name: 'Storm',          cloud: 0.96, fog: 0.92, vis: 0.48, precip: 'rain', precipRate: 0.80, wind: 0.92, turb: 0.90, lightning: 0.25, sat: 0.80, exposure: 0.76 },
  thunderstorm: { name: 'Thunderstorm',   cloud: 1.00, fog: 0.95, vis: 0.42, precip: 'rain', precipRate: 1.15, wind: 1.00, turb: 1.00, lightning: 1.00, sat: 0.78, exposure: 0.72 },
  snow:         { name: 'Snow',           cloud: 0.80, fog: 0.78, vis: 0.66, precip: 'snow', precipRate: 0.45, wind: 0.45, turb: 0.42, lightning: 0,    sat: 0.86, exposure: 1.02 },
  heavySnow:    { name: 'Heavy Snow',     cloud: 0.95, fog: 0.95, vis: 0.40, precip: 'snow', precipRate: 1.10, wind: 0.80, turb: 0.72, lightning: 0,    sat: 0.78, exposure: 0.98 },
  fog:          { name: 'Fog Bank',       cloud: 0.72, fog: 1.20, vis: 0.34, precip: null,  precipRate: 0,    wind: 0.20, turb: 0.28, lightning: 0,    sat: 0.82, exposure: 0.92 },
  denseCloud:   { name: 'Dense Cloud',    cloud: 1.20, fog: 0.85, vis: 0.46, precip: null,  precipRate: 0,    wind: 0.55, turb: 0.55, lightning: 0,    sat: 0.88, exposure: 0.90 },
  dustStorm:    { name: 'Dust Storm',     cloud: 0.55, fog: 1.10, vis: 0.38, precip: 'dust', precipRate: 0.9,  wind: 0.85, turb: 0.78, lightning: 0,    sat: 0.92, exposure: 0.94, tint: 0xd9a463 },
  sunset:       { name: 'Sunset',         cloud: 0.45, fog: 0.55, vis: 0.90, precip: null,  precipRate: 0,    wind: 0.30, turb: 0.25, lightning: 0,    sat: 1.14, exposure: 1.02, time: 'sunset' },
  sunrise:      { name: 'Sunrise',        cloud: 0.50, fog: 0.72, vis: 0.86, precip: null,  precipRate: 0,    wind: 0.28, turb: 0.24, lightning: 0,    sat: 1.10, exposure: 1.00, time: 'sunrise' },
  night:        { name: 'Night',          cloud: 0.42, fog: 0.55, vis: 0.80, precip: null,  precipRate: 0,    wind: 0.32, turb: 0.30, lightning: 0,    sat: 0.94, exposure: 1.18, time: 'night' },
  neonNight:    { name: 'Neon Night',     cloud: 0.62, fog: 0.80, vis: 0.66, precip: 'rain', precipRate: 0.45, wind: 0.40, turb: 0.38, lightning: 0,    sat: 1.22, exposure: 1.22, time: 'night', tint: 0x5a3aff },
};
export const WEATHER_IDS = Object.keys(WEATHER);

/** Sun elevation/azimuth + colour identity per time of day. */
export const TIME_OF_DAY = {
  sunrise:   { name: 'Sunrise',   elev: 5,   azim: 96,  sun: 0xffb072, ambient: 0x5a6b8c, ground: 0x6b5a48, intensity: 2.4, sky: 0.42, stars: 0.15 },
  morning:   { name: 'Morning',   elev: 32,  azim: 118, sun: 0xfff0d8, ambient: 0x8aa4c8, ground: 0x6b7264, intensity: 3.5, sky: 0.9,  stars: 0 },
  noon:      { name: 'Noon',      elev: 72,  azim: 176, sun: 0xffffff, ambient: 0x9dbbe0, ground: 0x76806f, intensity: 4.1, sky: 1.0,  stars: 0 },
  afternoon: { name: 'Afternoon', elev: 40,  azim: 232, sun: 0xffeccb, ambient: 0x8fabd0, ground: 0x726f5f, intensity: 3.3, sky: 0.86, stars: 0 },
  sunset:    { name: 'Sunset',    elev: 4,   azim: 268, sun: 0xff9a4d, ambient: 0x6a5f86, ground: 0x5c4a3c, intensity: 2.6, sky: 0.38, stars: 0.2 },
  dusk:      { name: 'Dusk',      elev: -4,  azim: 282, sun: 0xff6a3c, ambient: 0x3f4a72, ground: 0x2e3040, intensity: 1.1, sky: 0.2,  stars: 0.55 },
  night:     { name: 'Night',     elev: -16, azim: 310, sun: 0x9fc0ff, ambient: 0x1d2740, ground: 0x14181f, intensity: 0.45, sky: 0.06, stars: 1.0 },
};

/* ===========================================================================
 * TRACK SEGMENTS
 * ------------------------------------------------------------------------
 * The procedural route is a sequence of these. Each describes how heading,
 * pitch, corridor radius and content density evolve over its length. The
 * generator enforces `minAlt`, curvature limits and corridor clearance so an
 * impossible route can never be produced.
 * ======================================================================== */

export const SEGMENTS = [
  { id: 'straight',    name: 'Sky Corridor',        w: 12, turn: [0, 0.10],   pitch: [-0.04, 0.04], radius: [1.0, 1.25], nodes: 8,  speed: 1.10, obst: 0.7, rings: 1.2, risk: 0.4 },
  { id: 'highway',     name: 'Aerial Highway',      w: 9,  turn: [0, 0.16],   pitch: [-0.03, 0.03], radius: [1.5, 1.9],  nodes: 10, speed: 1.20, obst: 0.5, rings: 1.5, risk: 0.25 },
  { id: 'sweeper',     name: 'Long Sweeper',        w: 11, turn: [0.28, 0.55],pitch: [-0.05, 0.05], radius: [1.0, 1.2],  nodes: 10, speed: 1.0,  obst: 0.8, rings: 1.1, risk: 0.5 },
  { id: 'chicane',     name: 'Chicane',             w: 8,  turn: [0.55, 0.95],pitch: [-0.06, 0.06], radius: [0.78, 0.95],nodes: 8,  speed: 0.86, obst: 1.0, rings: 0.9, risk: 0.75 },
  { id: 'canyonRun',   name: 'Narrow Canyon',       w: 7,  turn: [0.30, 0.75],pitch: [-0.08, 0.02], radius: [0.5, 0.68], nodes: 9,  speed: 0.9,  obst: 1.3, rings: 0.8, risk: 0.95, lowAlt: true },
  { id: 'climb',       name: 'Vertical Climb',      w: 6,  turn: [0, 0.22],   pitch: [0.22, 0.42],  radius: [0.9, 1.15], nodes: 7,  speed: 0.95, obst: 0.6, rings: 1.3, risk: 0.5 },
  { id: 'dive',        name: 'Power Dive',          w: 6,  turn: [0, 0.22],   pitch: [-0.44, -0.24],radius: [0.9, 1.15], nodes: 7,  speed: 1.25, obst: 0.9, rings: 1.3, risk: 0.7 },
  { id: 'spiral',      name: 'Spiral',              w: 5,  turn: [0.9, 1.35], pitch: [-0.10, 0.16], radius: [0.72, 0.9], nodes: 12, speed: 0.82, obst: 0.9, rings: 1.4, risk: 0.85, roll: 1.0 },
  { id: 'corkscrew',   name: 'Corkscrew',           w: 4,  turn: [0.7, 1.15], pitch: [-0.16, 0.22], radius: [0.66, 0.85],nodes: 12, speed: 0.85, obst: 0.8, rings: 1.6, risk: 0.9, roll: 1.6 },
  { id: 'tunnel',      name: 'Aerial Tunnel',       w: 5,  turn: [0.1, 0.35], pitch: [-0.06, 0.06], radius: [0.42, 0.55],nodes: 8,  speed: 1.05, obst: 1.1, rings: 1.0, risk: 1.0, tunnel: true },
  { id: 'cloudTunnel', name: 'Cloud Tunnel',        w: 6,  turn: [0.15, 0.45],pitch: [-0.08, 0.10], radius: [0.7, 0.95], nodes: 9,  speed: 1.0,  obst: 0.7, rings: 1.2, risk: 0.7, cloudDense: true },
  { id: 'cityRun',     name: 'City Corridor',       w: 7,  turn: [0.25, 0.7], pitch: [-0.06, 0.06], radius: [0.55, 0.8], nodes: 10, speed: 0.92, obst: 1.4, rings: 0.9, risk: 0.95, lowAlt: true, urban: true },
  { id: 'towerWeave',  name: 'Tower Weave',         w: 5,  turn: [0.6, 1.05], pitch: [-0.10, 0.14], radius: [0.6, 0.82], nodes: 10, speed: 0.88, obst: 1.5, rings: 1.0, risk: 1.05, urban: true },
  { id: 'bridgeSpan',  name: 'Sky Bridge Span',     w: 5,  turn: [0.05, 0.25],pitch: [-0.05, 0.05], radius: [0.8, 1.0],  nodes: 8,  speed: 1.05, obst: 1.2, rings: 1.1, risk: 0.8, structure: 'bridge' },
  { id: 'gateArray',   name: 'Energy Gate Array',   w: 7,  turn: [0.1, 0.4],  pitch: [-0.08, 0.10], radius: [0.85, 1.1], nodes: 9,  speed: 1.0,  obst: 0.6, rings: 2.2, risk: 0.6, gates: true },
  { id: 'islandField', name: 'Floating Islands',    w: 6,  turn: [0.3, 0.8],  pitch: [-0.12, 0.14], radius: [0.75, 1.0], nodes: 10, speed: 0.95, obst: 1.35, rings: 1.1, risk: 0.9, islands: true },
  { id: 'stormCell',   name: 'Storm Cell',          w: 4,  turn: [0.35, 0.85],pitch: [-0.14, 0.16], radius: [0.7, 0.95], nodes: 10, speed: 0.9,  obst: 1.0, rings: 1.0, risk: 1.1, storm: true },
  { id: 'lowPass',     name: 'Low Altitude Run',    w: 5,  turn: [0.2, 0.6],  pitch: [-0.12, 0.06], radius: [0.62, 0.85],nodes: 9,  speed: 1.05, obst: 1.25, rings: 1.0, risk: 1.1, lowAlt: true, forceLow: true },
  { id: 'highSpeed',   name: 'High Altitude Sprint',w: 6,  turn: [0, 0.12],   pitch: [0.02, 0.14],  radius: [1.3, 1.7],  nodes: 9,  speed: 1.35, obst: 0.4, rings: 1.4, risk: 0.35, forceHigh: true },
  { id: 'splitRoute',  name: 'Route Split',         w: 6,  turn: [0.15, 0.5], pitch: [-0.08, 0.10], radius: [1.1, 1.45], nodes: 9,  speed: 1.0,  obst: 0.9, rings: 1.2, risk: 0.7, split: true },
  { id: 'shortcut',    name: 'High-Risk Shortcut',  w: 3,  turn: [0.4, 0.9],  pitch: [-0.16, 0.12], radius: [0.45, 0.62],nodes: 7,  speed: 1.1,  obst: 1.6, rings: 1.3, risk: 1.4, shortcut: true },
  { id: 'debrisField', name: 'Debris Field',        w: 4,  turn: [0.2, 0.55], pitch: [-0.10, 0.10], radius: [0.8, 1.05], nodes: 9,  speed: 0.95, obst: 1.8, rings: 0.8, risk: 1.25 },
];
export const SEGMENTS_BY_ID = Object.fromEntries(SEGMENTS.map((s) => [s.id, s]));

/* ===========================================================================
 * SPECIAL POWERS  (NUM 1 .. NUM 5)
 * ======================================================================== */

export const POWERS = [
  {
    id: 'scan', slot: 1, name: 'ROUTE SCAN', short: 'SCAN', icon: 'scan',
    desc: 'Reveals the safest line, the next two checkpoints, the recommended altitude band and any shortcut openings.',
    cooldown: 20, duration: 7.0, color: 0x39f5ff,
  },
  {
    id: 'freeze', slot: 2, name: 'TIME FREEZE', short: 'FRZ', icon: 'freeze',
    desc: 'Collapses the local timeframe. Nearby obstacles, traffic and rival aircraft slow to a third of their speed. You do not.',
    cooldown: 40, duration: 4.5, color: 0x8fd6ff,
  },
  {
    id: 'phase', slot: 3, name: 'PHASE SHIFT', short: 'PHS', icon: 'phase',
    desc: 'Desynchronises the airframe so it passes cleanly through soft obstacles, debris and energy barriers.',
    cooldown: 30, duration: 5.0, color: 0xb478ff,
  },
  {
    id: 'shield', slot: 4, name: 'AERIAL SHIELD', short: 'SHD', icon: 'shield',
    desc: 'Projects a hardened collision envelope. Impacts are absorbed instead of damaging the hull.',
    cooldown: 45, duration: 8.0, color: 0x5fe4ff,
  },
  {
    id: 'turbo', slot: 5, name: 'TURBO OVERDRIVE', short: 'TRB', icon: 'turbo',
    desc: 'Dumps the reserve into the reheat stage. Extreme acceleration and a raised speed ceiling, at the cost of turn authority.',
    cooldown: 25, duration: 6.0, color: 0xff8a3a,
  },
];
export const POWERS_BY_ID = Object.fromEntries(POWERS.map((p) => [p.id, p]));

/* ===========================================================================
 * DIFFICULTY
 * ------------------------------------------------------------------------
 * Difficulty changes *behaviour*, not just AI top speed: obstacle density,
 * route complexity, recovery windows, weather severity and traffic all move.
 * ======================================================================== */

export const DIFFICULTIES = {
  normal: {
    name: 'NORMAL', order: 0, desc: 'Forgiving lines, patient rivals, generous recovery.',
    aiSkill: 0.52, aiAggression: 0.30, aiSpeed: 0.86, aiMistake: 0.22, aiPowerUse: 0.3, aiRubberband: 0.5,
    obstacleDensity: 0.55, trafficDensity: 0.5, routeComplexity: 0.4, weatherSeverity: 0.5,
    turbulence: 0.5, damageScale: 0.6, recoveryWindow: 2.2, rewardMult: 1.0, aiCount: 5, timeBonus: 1.35,
  },
  hard: {
    name: 'HARD', order: 1, desc: 'Rivals defend position and the route stops being polite.',
    aiSkill: 0.66, aiAggression: 0.48, aiSpeed: 0.93, aiMistake: 0.14, aiPowerUse: 0.5, aiRubberband: 0.42,
    obstacleDensity: 0.78, trafficDensity: 0.72, routeComplexity: 0.62, weatherSeverity: 0.72,
    turbulence: 0.72, damageScale: 0.8, recoveryWindow: 1.8, rewardMult: 1.35, aiCount: 6, timeBonus: 1.18,
  },
  elite: {
    name: 'ELITE', order: 2, desc: 'The championship standard. Intelligent rivals, dense airspace, real consequences.',
    aiSkill: 0.79, aiAggression: 0.62, aiSpeed: 1.0, aiMistake: 0.08, aiPowerUse: 0.7, aiRubberband: 0.34,
    obstacleDensity: 1.0, trafficDensity: 0.95, routeComplexity: 0.82, weatherSeverity: 0.9,
    turbulence: 0.9, damageScale: 1.0, recoveryWindow: 1.5, rewardMult: 1.75, aiCount: 7, timeBonus: 1.0,
  },
  master: {
    name: 'MASTER', order: 3, desc: 'Rivals read your line and close the door before you commit to it.',
    aiSkill: 0.89, aiAggression: 0.76, aiSpeed: 1.06, aiMistake: 0.04, aiPowerUse: 0.85, aiRubberband: 0.24,
    obstacleDensity: 1.25, trafficDensity: 1.15, routeComplexity: 0.94, weatherSeverity: 1.05,
    turbulence: 1.05, damageScale: 1.25, recoveryWindow: 1.2, rewardMult: 2.3, aiCount: 7, timeBonus: 0.9,
  },
  legendary: {
    name: 'LEGENDARY', order: 4, desc: 'No mistakes, no mercy, no clean air. Very few pilots finish.',
    aiSkill: 0.97, aiAggression: 0.92, aiSpeed: 1.12, aiMistake: 0.015, aiPowerUse: 1.0, aiRubberband: 0.16,
    obstacleDensity: 1.55, trafficDensity: 1.35, routeComplexity: 1.0, weatherSeverity: 1.2,
    turbulence: 1.2, damageScale: 1.5, recoveryWindow: 0.95, rewardMult: 3.2, aiCount: 7, timeBonus: 0.82,
  },
};
export const DIFFICULTY_ORDER = ['normal', 'hard', 'elite', 'master', 'legendary'];

/* ===========================================================================
 * GAME MODES
 * ======================================================================== */

export const MODES = {
  endless: {
    id: 'endless', name: 'ENDLESS FLIGHT', tag: 'DEFAULT',
    desc: 'An infinite procedurally streamed sky route that escalates for as long as you survive. Distance and score are everything.',
    hasLaps: false, hasRivals: true, hasTimer: false, escalates: true, failOnDamage: true, primary: 'distance',
  },
  quick: {
    id: 'quick', name: 'QUICK RACE', tag: null,
    desc: 'One standalone race against a full grid over a freshly generated route. Finish as high up the order as you can.',
    hasLaps: true, laps: 2, hasRivals: true, hasTimer: false, escalates: false, failOnDamage: true, primary: 'position',
  },
  campaign: {
    id: 'campaign', name: 'CAMPAIGN', tag: null,
    desc: 'Nine chapters across the whole circuit, each with its own venue, rival grid and objective. Beat the chapter to unlock the next.',
    hasLaps: true, laps: 2, hasRivals: true, hasTimer: false, escalates: false, failOnDamage: true, primary: 'position',
  },
  survival: {
    id: 'survival', name: 'SURVIVAL', tag: null,
    desc: 'The airspace closes in around you. Obstacle density, traffic, weather and rival pressure climb until the hull gives out.',
    hasLaps: false, hasRivals: true, hasTimer: false, escalates: true, aggressive: true, failOnDamage: true, primary: 'time',
  },
  timeattack: {
    id: 'timeattack', name: 'TIME ATTACK', tag: null,
    desc: 'A countdown you extend by hitting checkpoints. Every gate buys seconds, every mistake costs them.',
    hasLaps: false, hasRivals: false, hasTimer: true, startTime: 45, escalates: true, failOnDamage: true, primary: 'checkpoints',
  },
  free: {
    id: 'free', name: 'FREE FLIGHT', tag: null,
    desc: 'No timer, no rivals, no failure state. Explore the generated venue, learn an airframe, practise the gate work.',
    hasLaps: false, hasRivals: false, hasTimer: false, escalates: false, failOnDamage: false, primary: 'distance',
  },
};
export const MODE_ORDER = ['endless', 'quick', 'campaign', 'survival', 'timeattack', 'free'];

/* ===========================================================================
 * CAMPAIGN
 * ======================================================================== */

export const CAMPAIGN = [
  { id: 1, name: 'FIRST LIGHT',      biome: 'village',  weather: 'sunrise',      diff: 'normal', laps: 1, goal: { type: 'position', value: 3 }, reward: 1200, desc: 'A shakedown run over the vale. Finish on the podium.' },
  { id: 2, name: 'CANOPY RUN',       biome: 'forest',   weather: 'lightRain',    diff: 'normal', laps: 2, goal: { type: 'position', value: 2 }, reward: 1600, desc: 'Wet air over the basin. Second or better.' },
  { id: 3, name: 'GLASS CANYONS',    biome: 'city',     weather: 'sunset',       diff: 'hard',   laps: 2, goal: { type: 'position', value: 2 }, reward: 2200, desc: 'Between the towers at golden hour.' },
  { id: 4, name: 'DRY THUNDER',      biome: 'desert',   weather: 'dustStorm',    diff: 'hard',   laps: 2, goal: { type: 'position', value: 1 }, reward: 3000, desc: 'Zero visibility across the flats. Win it.' },
  { id: 5, name: 'WHITE SILENCE',    biome: 'ice',      weather: 'heavySnow',    diff: 'elite',  laps: 2, goal: { type: 'position', value: 2 }, reward: 3800, desc: 'Whiteout over the glacier shelf.' },
  { id: 6, name: 'THE CITADEL',      biome: 'fortress', weather: 'thunderstorm', diff: 'elite',  laps: 2, goal: { type: 'position', value: 1 }, reward: 5000, desc: 'Boss race. The circuit\'s oldest venue, at its worst.', boss: true },
  { id: 7, name: 'CRIMSON LINE',     biome: 'redstone', weather: 'sunset',       diff: 'master', laps: 2, goal: { type: 'position', value: 1 }, reward: 6400, desc: 'Live conduits and mesa narrows.' },
  { id: 8, name: 'SPIRE ASCENT',     biome: 'tower',    weather: 'storm',        diff: 'master', laps: 2, goal: { type: 'position', value: 1 }, reward: 8000, desc: 'Vertical racing around kilometre-tall structures.' },
  { id: 9, name: 'ALPHA FINAL',      biome: 'neon',     weather: 'neonNight',    diff: 'legendary', laps: 3, goal: { type: 'position', value: 1 }, reward: 15000, desc: 'The championship decider. Everything you have.', boss: true },
];

/* ===========================================================================
 * OBJECTIVES  (dynamically drawn per run)
 * ======================================================================== */

export const OBJECTIVE_POOL = [
  { id: 'dist',      text: (v) => `Fly ${(v / 1000).toFixed(0)} km`,              metric: 'distance',   values: [8000, 14000, 22000, 32000], reward: 1.0, modes: ['endless', 'survival', 'free', 'timeattack'] },
  { id: 'checks',    text: (v) => `Clear ${v} checkpoints`,                       metric: 'checkpoints', values: [10, 18, 28, 40],            reward: 1.0, modes: ['endless', 'survival', 'timeattack', 'quick', 'campaign'] },
  { id: 'rings',     text: (v) => `Pass through ${v} race rings`,                 metric: 'rings',      values: [25, 45, 70, 100],           reward: 0.9, modes: ['endless', 'survival', 'free', 'timeattack', 'quick'] },
  { id: 'nearmiss',  text: (v) => `Score ${v} near misses`,                       metric: 'nearMisses', values: [10, 20, 35, 55],            reward: 1.2, modes: ['endless', 'survival', 'quick', 'campaign'] },
  { id: 'overtake',  text: (v) => `Overtake ${v} rival aircraft`,                 metric: 'overtakes',  values: [5, 10, 18, 28],             reward: 1.3, modes: ['endless', 'survival', 'quick', 'campaign'] },
  { id: 'topspeed',  text: (v) => `Reach ${v} km/h`,                              metric: 'topSpeedKmh', values: [1400, 1650, 1850, 2050],   reward: 1.1, modes: ['endless', 'survival', 'free', 'timeattack', 'quick'] },
  { id: 'survive',   text: (v) => `Survive ${Math.round(v / 60)} minutes`,        metric: 'time',       values: [180, 300, 480, 720],        reward: 1.25, modes: ['endless', 'survival'] },
  { id: 'combo',     text: (v) => `Build a x${v} combo`,                          metric: 'maxCombo',   values: [8, 14, 22, 32],             reward: 1.15, modes: ['endless', 'survival', 'quick'] },
  { id: 'clean',     text: (v) => `Clear ${v} checkpoints without a collision`,   metric: 'cleanStreak', values: [6, 10, 16, 24],            reward: 1.4, modes: ['endless', 'survival', 'timeattack', 'quick', 'campaign'] },
  { id: 'powers',    text: (v) => `Land ${v} effective power activations`,        metric: 'powerUses',  values: [4, 8, 14, 20],              reward: 1.0, modes: ['endless', 'survival', 'quick', 'campaign'] },
  { id: 'shortcut',  text: (v) => `Commit to ${v} high-risk shortcuts`,           metric: 'shortcuts',  values: [2, 4, 7, 11],               reward: 1.5, modes: ['endless', 'survival', 'quick'] },
  { id: 'highalt',   text: (v) => `Hold above 3000 m for ${v} seconds`,           metric: 'highAltTime', values: [20, 45, 80, 130],          reward: 1.1, modes: ['endless', 'free', 'survival'] },
  { id: 'lowalt',    text: (v) => `Hold below 250 m for ${v} seconds`,            metric: 'lowAltTime', values: [15, 32, 60, 95],            reward: 1.45, modes: ['endless', 'survival', 'free'] },
  { id: 'podium',    text: () => 'Finish on the podium',                          metric: 'positionInv', values: [3],                        reward: 1.3, modes: ['quick', 'campaign'] },
  { id: 'win',       text: () => 'Win the race',                                  metric: 'positionInv', values: [1],                        reward: 1.8, modes: ['quick', 'campaign'] },
];

/* ===========================================================================
 * ACHIEVEMENTS
 * ======================================================================== */

export const ACHIEVEMENTS = [
  { id: 'firstflight', name: 'First Flight',       desc: 'Complete your first run.',                       check: (s) => s.totalRuns >= 1,             reward: 500 },
  { id: 'centurion',   name: 'Centurion',          desc: 'Clear 100 checkpoints in total.',                check: (s) => s.totalCheckpoints >= 100,    reward: 800 },
  { id: 'marathon',    name: 'Long Haul',          desc: 'Fly 250 km across all runs.',                    check: (s) => s.totalDistance >= 250000,    reward: 1200 },
  { id: 'sonic',       name: 'Sonic',              desc: 'Reach 1800 km/h.',                               check: (s) => s.bestSpeedKmh >= 1800,       reward: 1000 },
  { id: 'threader',    name: 'Needle Threader',    desc: 'Record 250 near misses.',                        check: (s) => s.totalNearMisses >= 250,     reward: 1400 },
  { id: 'untouchable', name: 'Untouchable',        desc: 'Clear 20 checkpoints in one run without contact.',check: (s) => s.bestCleanStreak >= 20,      reward: 2000 },
  { id: 'overtaker',   name: 'Overtaker',          desc: 'Overtake 100 rival aircraft.',                   check: (s) => s.totalOvertakes >= 100,      reward: 1600 },
  { id: 'combolord',   name: 'Chain Reaction',     desc: 'Build a x30 combo.',                             check: (s) => s.bestCombo >= 30,            reward: 2200 },
  { id: 'survivor',    name: 'Survivor',           desc: 'Survive 10 minutes in a single run.',            check: (s) => s.bestSurvivalTime >= 600,    reward: 2500 },
  { id: 'tourist',     name: 'Circuit Tourist',    desc: 'Race in 10 different venues.',                   check: (s) => Object.keys(s.biomesVisited || {}).length >= 10, reward: 1800 },
  { id: 'podiumist',   name: 'Podium Regular',     desc: 'Finish on the podium 10 times.',                 check: (s) => s.podiums >= 10,              reward: 2000 },
  { id: 'legend',      name: 'Legend',             desc: 'Win a race on Legendary difficulty.',            check: (s) => s.legendaryWins >= 1,         reward: 6000 },
  { id: 'collector',   name: 'Hangar Complete',    desc: 'Unlock every airframe.',                         check: (s, save) => AIRCRAFT.every((a) => a.unlock.type === 'default' || (save.unlocked || []).includes(a.id)), reward: 5000 },
  { id: 'champion',    name: 'Circuit Champion',   desc: 'Complete the campaign.',                         check: (s, save) => (save.campaignProgress || 0) >= CAMPAIGN.length, reward: 10000 },
];

/* ===========================================================================
 * INPUT
 * ======================================================================== */

export const DEFAULT_BINDINGS = {
  pitchUp:    ['KeyW', 'ArrowUp'],
  pitchDown:  ['KeyS', 'ArrowDown'],
  rollLeft:   ['KeyA', 'ArrowLeft'],
  rollRight:  ['KeyD', 'ArrowRight'],
  yawLeft:    ['KeyQ'],
  yawRight:   ['KeyE'],
  throttleUp: ['ShiftLeft', 'ShiftRight'],
  brake:      ['KeyC', 'ControlLeft'],
  boost:      ['Space'],
  power1:     ['Numpad1', 'Digit1'],
  power2:     ['Numpad2', 'Digit2'],
  power3:     ['Numpad3', 'Digit3'],
  power4:     ['Numpad4', 'Digit4'],
  power5:     ['Numpad5', 'Digit5'],
  pause:      ['Escape'],
  fullscreen: ['KeyF'],
  camera:     ['KeyV'],
  debug:      ['F8'],
};

export const BINDING_LABELS = {
  pitchUp: 'Pitch Up / Climb', pitchDown: 'Pitch Down / Dive',
  rollLeft: 'Roll Left', rollRight: 'Roll Right',
  yawLeft: 'Yaw Left', yawRight: 'Yaw Right',
  throttleUp: 'Throttle Up', brake: 'Air Brake', boost: 'Boost',
  power1: 'Power 1 — Route Scan', power2: 'Power 2 — Time Freeze',
  power3: 'Power 3 — Phase Shift', power4: 'Power 4 — Aerial Shield',
  power5: 'Power 5 — Turbo Overdrive',
  pause: 'Pause', fullscreen: 'Fullscreen', camera: 'Cycle Camera', debug: 'Debug Overlay',
};

/* ===========================================================================
 * SCORING
 * ======================================================================== */

export const SCORE = {
  checkpoint: 250,
  ring: 60,
  ringBoost: 90,
  ringPrecision: 180,
  nearMiss: 45,
  nearMissClose: 120,
  overtake: 400,
  shortcut: 750,
  perfectCheckpoint: 150,     // dead-centre bonus
  distancePerKm: 120,
  speedBonusPerSec: 14,       // awarded above 90% of max speed
  comboStep: 0.06,            // multiplier gained per combo tick
  comboMax: 4.0,
  comboDecay: 4.5,            // seconds of no scoring before combo drops
  collisionPenalty: -300,
  missedCheckpoint: -500,
};

export const CREDITS = { perScore: 0.045, perObjective: 350, dailyBonus: 900, podium: [900, 550, 320] };

/* ===========================================================================
 * DEFAULTS / STORAGE
 * ======================================================================== */

export const STORAGE_KEY = 'alpha_aircraft_race_3d_save_v1';

export const DEFAULT_SAVE = {
  version: 1,
  onboarded: false,
  credits: 0,
  unlocked: ['vector'],
  selectedAircraft: 'vector',
  selectedMode: 'endless',
  selectedDifficulty: 'elite',
  selectedLocation: 'random',
  campaignProgress: 0,
  achievements: [],
  dailyState: { date: null, completed: false, best: 0 },
  settings: {
    graphics: 'extreme',
    resolutionScale: 1.0,
    shadows: true,
    reflections: true,
    effects: true,
    bloom: true,
    motionBlur: true,
    particles: 1.0,
    viewDistance: 1.0,
    cloudQuality: 1.0,
    weatherQuality: 1.0,
    masterVolume: 0.85,
    musicVolume: 0.55,
    sfxVolume: 0.9,
    environmentVolume: 0.8,
    cameraSensitivity: 1.0,
    flightSensitivity: 1.0,
    vibration: true,
    reducedMotion: false,
    invertPitch: false,
    showDebug: false,
    hudScale: 1.0,
    touchControls: true,
    bindings: null,
  },
  stats: {
    totalRuns: 0, totalDistance: 0, totalCheckpoints: 0, totalNearMisses: 0, totalOvertakes: 0,
    totalRings: 0, totalScore: 0, totalTime: 0, podiums: 0, wins: 0, legendaryWins: 0, crashes: 0,
    bestScore: 0, bestDistance: 0, bestSpeedKmh: 0, bestCombo: 0, bestCleanStreak: 0,
    bestSurvivalTime: 0, bestLapTime: 0, biomesVisited: {}, modeRuns: {},
  },
  records: {},
};

export const DEFAULTS = {
  mode: 'endless',
  difficulty: 'elite',
  location: 'random',
  graphics: 'extreme',
  aircraft: 'vector',
};

/* ===========================================================================
 * MISC PRESENTATION DATA
 * ======================================================================== */

export const LOADING_STAGES = [
  'Booting flight systems',
  'Generating sky route',
  'Raising terrain',
  'Seeding environment',
  'Building cloud layers',
  'Assembling airframes',
  'Briefing rival pilots',
  'Calibrating weather',
  'Priming effects',
  'Compiling shaders',
  'Arming HUD',
  'Ready',
];

export const TIPS = [
  'Bank into the turn — heading follows roll far faster than rudder alone.',
  'Boost rings top the meter back up. Chain them through the long sweepers.',
  'Near misses feed the combo multiplier. Risk pays, right up until it does not.',
  'Route Scan (NUM 1) shows the recommended altitude band as well as the line.',
  'Aerial Shield (NUM 4) before a debris field is worth more than boosting through it.',
  'Cutting a checkpoint dead-centre awards a precision bonus.',
  'Air brake tightens your turn radius — the fastest line is not always full throttle.',
  'Time Freeze (NUM 2) works on rival aircraft as well as obstacles.',
  'High-risk shortcuts are always narrower than they look. Commit early or not at all.',
  'Damage does not regenerate mid-run. Trade paint sparingly.',
];
