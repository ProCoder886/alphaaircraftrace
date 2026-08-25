/**
 * ALPHA AIRCRAFT RACE 3D — config.js
 * ---------------------------------------------------------------------------
 * Immutable game data: constants, tunables, content tables (aircraft, biomes,
 * weather, track segments, powers, difficulty, achievements) plus the seeded
 * deterministic RNG / noise utilities every procedural system is built on.
 *
 * The only import is the venue roster in ./locations.js, which imports nothing
 * itself and is therefore the true root of the graph.
 */

import { LOCATIONS, LOCATIONS_BY_ID } from './locations.js';

export const VERSION = '1.2.0';
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

/* ===========================================================================
 * MACH
 * ------------------------------------------------------------------------
 * The airframe is simulated in game units per second — a scale the terrain,
 * corridor and streaming budget are all built around. True airspeed is
 * reported from that through one constant: `msPerMach` units of simulated
 * speed is one Mach, and one Mach is `kmh` km/h. Both the HUD and every
 * threshold in the game read Mach, so the whole envelope moves together if
 * this number is ever retuned.
 *
 *   stall  ~Mach 2.1   cruise ~Mach 9   dry max ~Mach 20
 *   nitrous ~Mach 25   turbo overdrive  Mach 30 (hard ceiling)
 *
 * The readout scale is deliberately NOT real-world Mach. At the true 1234.8
 * km/h per Mach the speed tape spent the whole race in five and six figures,
 * which is unreadable at a glance and drowns the digit that actually changes.
 * One Mach reads as 100 km/h instead, so the ceiling lands on a round Mach 30
 * / 3000 km/h and the number moves in hundreds. This is a DISPLAY scale only:
 * `msPerMach` is untouched, so the flight model, the terrain scale and every
 * threshold in the game keep the same relationship to the world.
 * ======================================================================== */
export const MACH = {
  kmh: 100,                    // km/h shown per Mach — display scale, see above
  msPerMach: 35,               // simulated m/s per Mach
  max: 30,                     // absolute ceiling for player and enemies — 3000 km/h
  blurMach: 22,                // Mach at which motion blur and trails saturate
  /* Airframe buffet. Past this the whole picture starts trembling — a purely
   * presentational cue that you are into the part of the envelope the airframe
   * was not really built for, and it lands just under the Mach 24 redline. */
  shakeMach: 23,               // Mach at which the airframe starts to complain
  /* ---- the extreme band -------------------------------------------------
   * Everything presentational — shake, motion blur, speed lines, chromatic
   * aberration, the vignette, the lens — ramps in from `shakeMach` and is at
   * MAXIMUM by `extremeMach`, then stays there. Above Mach 25 the picture is
   * supposed to be barely holding together: that band is five Mach wide, it is
   * where the airframe is past its thermal redline, and it should not look
   * like cruising with a bigger number on the tape.
   * -------------------------------------------------------------------- */
  extremeMach: 25,             // Mach at and above which the presentation saturates
  shakeAmount: 1.05,           // shake magnitude once past extremeMach
  /* ---- thermal limit ----------------------------------------------------
   * The airframe is cleared to Mach 24. Above it the intakes and the leading
   * edges start soaking heat faster than the fuel can carry it away, and the
   * engine has exactly one minute of that before it lets go. Dropping back
   * below the limit cools it again, but slowly — a dozen short excursions add
   * up the same way one long one does.
   *
   * The redline sits SIX Mach below the ceiling, not two: the top of the
   * envelope is now a place you can genuinely live in, and the warning is the
   * price of staying there rather than a light that comes on the moment the
   * aircraft does what it was built to do. */
  redline: 24,                 // Mach — sustained above this and the engine cooks
  overheatTime: 60,            // s above the redline before the engine explodes
  coolRate: 0.45,              // heat bled per second below the redline, relative
  get maxMs() { return this.msPerMach * this.max; },
  /** Simulated speed → Mach. */
  of(ms) { return ms / this.msPerMach; },
  /** Simulated speed → true airspeed in km/h. */
  kmhOf(ms) { return (ms / this.msPerMach) * this.kmh; },
};

export const PHYSICS = {
  gravity: 9.81,               // m/s² — used by the flight model and crash tumble
  // Speeds are stored in game units (m/s) internally; MACH converts for display.
  minSpeed: 74,                // Mach 2.1 — stall floor, engine holds you up
  cruiseSpeed: 320,            // Mach 9.1
  maxSpeed: 700,               // Mach 20 — dry thrust ceiling
  boostSpeed: 875,             // Mach 25 on nitrous alone
  /* ---- Turbo Speed (NUM 2) ----------------------------------------------
   * The power doubles the nitrous, and it does it in both places nitrous acts:
   * twice the shove out of the reheat stage, and twice the margin it adds on
   * top of the dry ceiling. Dry Mach 20 + 2 x the Mach 5 reheat margin is the
   * Mach 30 / 3000 km/h ceiling, so the top of the envelope is exactly what
   * this multiplier says it is rather than a separate number to keep in step. */
  turboBoost: 2.0,
  /* ---- acceleration -----------------------------------------------------
   * Thrust and drag are deliberately scaled DOWN TOGETHER by 5x. Cutting
   * thrust alone would also cut the terminal speed — the top of the envelope
   * is where thrust balances v² drag — so the aircraft would simply never
   * reach Mach 14 again. Scaling both leaves every equilibrium speed exactly
   * where it was and makes the approach to it five times slower, which is the
   * part that was wrong: the airframe used to be at its dry ceiling within a
   * few seconds of the countdown.
   * -------------------------------------------------------------------- */
  baseThrust: 29,              // m/s^2 at full throttle
  /* Drag, not thrust, is what was retuned to open the envelope up to Mach 30.
   * Terminal speed is sqrt(thrust / k), so lowering k raises the top of the
   * band while leaving low-speed acceleration — where drag is negligible —
   * exactly where it was. Raising thrust instead would have made the airframe
   * leap off the line, which is the thing the 5x scale-down above exists to
   * prevent. Speed is still something you fly toward over a distance. */
  dragCoefficient: 0.000064,
  /* Gravity for the ENERGY trade — climbing costs speed, diving buys it.
   * This is deliberately NOT `flightG`. That number is a scaled gravity tuned
   * to produce flyable turn rates inside a corridor, and at 46 m/s² it is now
   * larger than the entire thrust budget: sharing it here meant the faintest
   * climb cancelled every newton the engine made and the aircraft could not
   * accelerate at all. The energy exchange wants real gravity, and real
   * gravity is what it gets. */
  pathGravity: 9.81,
  /* Sustained-throttle build. Holding military power lets the intakes and the
   * core settle into their efficient range, and the last third of the speed
   * range only opens up once they have. This is what makes top speed something
   * you fly toward over a distance instead of something you switch on. */
  thrustBuildTime: 26,         // s of held throttle to full authority
  thrustBuildDecay: 5.5,       // s to bleed it back once the throttle comes off
  thrustBuildLow: 0.58,        // thrust multiplier from cold
  thrustBuildHigh: 1.10,       // thrust multiplier fully built
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
  leanSpeed: 130,              // m/s of sideways slip on a full lean
  leanYaw: 0.34,               // rad/s the nose swings into the slip
  leanBank: 0.46,              // rad the airframe visually leans with it
  leanAssistBank: 0.62,        // rad of bank the assist rolls in for you
  leanAssistTurn: 0.85,        // how much of a coordinated turn the assist adds
  rollRate: 3.35,              // rad/s — ~190°/s, a real fighter roll rate
  adverseYaw: 0.020,           // yaw induced by rolling — a cue, not a turn
  inducedDrag: 52,             // energy bled by pulling G
  spoolUp: 4.20,               // s — dry thrust lag
  spoolDown: 2.20,
  burnerLight: 0.55,           // s — afterburner light-off delay
  stallSink: 115,              // m/s of mush with no lift left
  boostAccel: 58,
  /* ---- how reheat actually accelerates -----------------------------------
   * The old model had none of this and it showed: nitrous was a switch that
   * put the aircraft at its ceiling in about three seconds, which reads as
   * teleporting rather than accelerating. Two things fix it.
   *
   * THE LAPSE. Reheat thrust falls off as the airframe approaches its own
   * ceiling — toward `reheatLapseFloor` of its sea-level value, on a curve of
   * power `reheatLapsePower`. That is what a real engine does at the top of
   * the envelope, and it is what turns a linear ramp into a wall into a long
   * asymptotic approach: the first half of the speed range arrives in a couple
   * of seconds, the last ten per cent takes as long again. The floor is set so
   * the advertised ceiling stays REACHABLE — at Mach 30 the lapsed thrust
   * still just exceeds drag — because a top speed you cannot touch is a lie.
   *
   * THE SPOOL. Turbo Speed used to be a step function: press NUM 2 and the
   * whole extra stage was there on that frame. It now lights over
   * `turboSpool` seconds like the reheat stage it is meant to be.
   *
   * Measured from cruise, with these numbers: nitrous reaches Mach 24 in about
   * 13 seconds and Turbo reaches the Mach 30 ceiling in about 13, against
   * roughly 3 before.
   * -------------------------------------------------------------------- */
  turboThrust: 1.2,            // turbo's extra thrust, as a multiple of boostAccel
  reheatLapsePower: 2.8,       // how sharply thrust falls toward the ceiling
  reheatLapseFloor: 0.34,      // fraction of reheat thrust left at the ceiling
  turboSpool: 2.6,             // s for the turbo stage to light fully
  /* Nitrous burn rate. Halved: the meter used to empty in under four seconds
   * of held Space, which made the boost a tap rather than something you fly
   * on. At 13/s a full 100-unit meter is a little under eight seconds of
   * continuous reheat, and Turbo Speed does NOT burn it faster — the power
   * doubles what the nitrous does, not what it costs. */
  boostDrain: 13,              // boost units per second (meter is 0..100)
  boostRegen: 11,
  boostRegenDelay: 0.85,
  turbulenceScale: 1.0,
  collisionBounce: 0.42,
  maxHealth: 100,
};

/* ===========================================================================
 * GRAPHICS QUALITY PRESETS
 * ------------------------------------------------------------------------
 * MEDIUM is the shipping default and must still look premium: it keeps bloom,
 * motion blur, reflections and volumetric-style clouds at full strength — it
 * trades draw distance, shadow resolution and particle counts instead. The
 * adaptive ladder moves between presets on its own once it has measured the
 * machine, so a fast GPU climbs above Medium without the player touching it.
 * ======================================================================== */

export const QUALITY_PRESETS = {
  low: {
    label: 'LOW', pixelRatio: 0.72, shadows: false, shadowMapSize: 1024, shadowDistance: 900,
    bloom: true, bloomStrength: 0.5, motionBlur: false, chromatic: false, grain: false, blurTaps: 8,
    reflections: false, envMapSize: 64, envUpdateInterval: 999,
    cloudQuality: 0.35, cloudLayers: 2, weatherParticles: 500, particleBudget: 400,
    viewDistance: 0.55, terrainLOD: 2, propDensity: 0.35, trafficDensity: 0.4,
    trailSegments: 22, anisotropy: 2, aircraftDetail: 0, ssaa: 1, glassTransmission: false,
  },
  medium: {
    label: 'MEDIUM', pixelRatio: 1.0, shadows: true, shadowMapSize: 2048, shadowDistance: 1800,
    bloom: true, bloomStrength: 0.72, motionBlur: true, chromatic: true, grain: true, blurTaps: 16,
    reflections: true, envMapSize: 192, envUpdateInterval: 5,
    cloudQuality: 0.85, cloudLayers: 4, weatherParticles: 1900, particleBudget: 1700,
    viewDistance: 0.88, terrainLOD: 3, propDensity: 0.85, trafficDensity: 0.85,
    trailSegments: 40, anisotropy: 8, aircraftDetail: 2, ssaa: 1, glassTransmission: true,
  },
  high: {
    label: 'HIGH', pixelRatio: 1.0, shadows: true, shadowMapSize: 2048, shadowDistance: 2200,
    bloom: true, bloomStrength: 0.74, motionBlur: true, chromatic: true, grain: true, blurTaps: 20,
    reflections: true, envMapSize: 256, envUpdateInterval: 4,
    cloudQuality: 1.0, cloudLayers: 4, weatherParticles: 2600, particleBudget: 2200,
    viewDistance: 1.0, terrainLOD: 3, propDensity: 1.0, trafficDensity: 1.0,
    trailSegments: 56, anisotropy: 8, aircraftDetail: 2, ssaa: 1, glassTransmission: true,
  },
  ultra: {
    label: 'ULTRA', pixelRatio: 1.25, shadows: true, shadowMapSize: 3072, shadowDistance: 3200,
    bloom: true, bloomStrength: 0.8, motionBlur: true, chromatic: true, grain: true, blurTaps: 26,
    reflections: true, envMapSize: 384, envUpdateInterval: 3,
    cloudQuality: 1.35, cloudLayers: 5, weatherParticles: 4200, particleBudget: 3600,
    viewDistance: 1.25, terrainLOD: 4, propDensity: 1.35, trafficDensity: 1.2,
    trailSegments: 72, anisotropy: 16, aircraftDetail: 2, ssaa: 1, glassTransmission: true,
  },
  extreme: {
    label: 'EXTREME', pixelRatio: 1.6, shadows: true, shadowMapSize: 4096, shadowDistance: 4200,
    bloom: true, bloomStrength: 0.86, motionBlur: true, chromatic: true, grain: true, blurTaps: 32,
    reflections: true, envMapSize: 512, envUpdateInterval: 2,
    cloudQuality: 1.7, cloudLayers: 6, weatherParticles: 6000, particleBudget: 5200,
    viewDistance: 1.5, terrainLOD: 4, propDensity: 1.7, trafficDensity: 1.4,
    trailSegments: 90, anisotropy: 16, aircraftDetail: 2, ssaa: 1, glassTransmission: true,
  },
};
export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra', 'extreme'];

/* ===========================================================================
 * RADAR
 * ------------------------------------------------------------------------
 * The radar is HEADING-UP: the player's nose always points at the top of the
 * disc and the world turns underneath it.
 *
 * It used to be north-up with a rotating arrow, which is defensible on paper —
 * the arrow really did point the way the aircraft was flying — and unreadable
 * in practice. At the identity attitude the airframe's nose is world -Z, which
 * plots at the BOTTOM of a north-up disc: so the arrow pointed down, and every
 * hostile in front of you appeared below your own marker. Every player reads
 * that as the arrow being backwards, and they are right to: a contact you can
 * see through the canopy should not be at the bottom of the map.
 *
 * Heading-up removes the question. What is ahead is up, what is on your left
 * is on the left, and the compass letters ride round the rim to their true
 * bearings — which is what makes them worth having rather than decoration.
 *
 * `range` is a radius in metres. Combat needs a far bigger one than racing:
 * hostiles are spread seven to ten kilometres apart and arrive from twenty
 * out, so a 3.2 km disc showed an empty circle in the one mode that is
 * entirely about knowing where they are.
 * ======================================================================== */
export const RADAR = {
  raceRange: 3200,             // m — corridor racing, where the route is the point
  combatRange: 26000,          // m — matches the distance hostiles are drawn at
  /** Contacts past the edge are pinned to the rim rather than dropped. */
  edgePin: true,
  maxContacts: 90,             // drawn per frame; nearest first
};

/**
 * Project a world-space offset onto the heading-up radar disc.
 *
 * @param dx        contact east of the player, in metres (world +X)
 * @param dz        contact north of the player, in metres (world +Z)
 * @param headingRad the player's heading, atan2(forward.x, forward.z)
 * @param range     disc radius in metres
 * @param R         disc radius in pixels
 * @param out       receives {x, y, clamped} relative to the disc centre
 */
export function radarProject(dx, dz, headingRad, range, R, out = {}) {
  /* Resolve the offset onto the aircraft's own axes, rather than rotating the
   * plot by an angle whose sign is easy to get backwards — which is exactly
   * how the old radar ended up mirrored.
   *
   * Heading is atan2(forward.x, forward.z), so the nose points along
   * (sin h, cos h) in world (east, north) and the right wing along
   * (cos h, -sin h). Project onto both and the answer is unambiguous: how far
   * AHEAD the contact is, and how far to the RIGHT. */
  const sh = Math.sin(headingRad), ch = Math.cos(headingRad);
  const ahead = dx * sh + dz * ch;
  const right = dx * ch - dz * sh;
  let px = (right / range) * R;
  let py = -(ahead / range) * R;      // screen +y is down, so ahead is -y
  const d = Math.hypot(px, py);
  out.clamped = d > R;
  if (out.clamped && d > 0.0001) { px = (px / d) * R; py = (py / d) * R; }
  out.x = px;
  out.y = py;
  out.dist = Math.hypot(dx, dz);
  return out;
}

/**
 * Where a compass bearing sits on the rim of a heading-up disc.
 * Returns the on-screen angle in radians, measured from straight up, positive
 * clockwise — which is what canvas rotation wants.
 */
export function radarBearing(bearingDeg, headingRad) {
  return (bearingDeg * Math.PI / 180) - headingRad;
}

/* ===========================================================================
 * THE FRAME BAND
 * ------------------------------------------------------------------------
 * On desktop the game runs between 60 and 120 FPS at every quality level,
 * including maximum, and it is the GOVERNOR that guarantees that rather than
 * the preset. `min` is the floor the adaptive quality ladder defends — and,
 * once the ladder has nothing left to shed, the floor the preset governor
 * steps whole presets down to protect. `max` is the presentation ceiling: past
 * it, frames are skipped rather than rendered, because a 240 Hz panel showing
 * a game designed around 60 is burning the headroom the floor needs.
 *
 * `desktopFloor` is how far down the governor is allowed to go. It stops at
 * Medium rather than Low: below that the world stops looking like this game,
 * and a desktop that cannot hold Medium is a desktop where the honest answer
 * is a lower resolution rather than a lower preset.
 * ======================================================================== */
export const FRAME_BAND = {
  min: 60,                     // FPS — the floor the governor defends
  max: 120,                    // FPS — the presentation ceiling
  desktopFloor: 'medium',      // the lowest preset the governor will hold at
};

/* ===========================================================================
 * AIRCRAFT ROSTER
 * ------------------------------------------------------------------------
 * FIVE airframes: two flyable from the first launch, three earned.
 *
 * A hangar of eleven aircraft is a list, not a choice — most of them differed
 * by a few points on one stat and a paint job, and the ones that mattered were
 * buried. Five airframes with genuinely different jobs is a decision the player
 * can actually hold in their head, and every locked one is a target rather than
 * a row to scroll past:
 *
 *   FR-22 RAPTOR   default      the obedient one — turns better than anything
 *   FA-19 FALCON   default      the all-rounder — no weakness, no speciality
 *   MK-29 WARHAWK  9 000 cr     the heavy — re-aims rather than turns, but flies
 *                               away from everything at the top of the range
 *   NX-3 WRAITH    22 000 cr    the prototype — faceted, phase-tuned, fragile
 *   OM-X OMEGA     achievement  the reward — no weak axis, absurd reheat
 *
 * The first three are modelled meshes loaded from `Assets/3d/aircraft/`, and
 * they are also the airframes hostiles fly, so the enemy squadron keeps its
 * full silhouette variety regardless of what the player has unlocked.
 *
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
    ability: 'Carrier Trim — the assisted turn banks 30% harder and settles faster.',
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
    ability: 'Ram Intakes — boost recharges 35% faster above Mach 16.',
    abilityKey: 'ramair',
    unlock: { type: 'credits', cost: 9000 },
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
    id: 'wraith', name: 'NX-3 WRAITH', class: 'Stealth Prototype',
    desc: 'Faceted, radar-dark and unnervingly quiet until the reheat lights. Built for pilots who prefer to be past you before you knew they were there.',
    stats: { speed: 0.80, accel: 0.78, handling: 0.76, boost: 0.74, durability: 0.58 },
    ability: 'Ghost Frame — Phase Shift lasts 50% longer.',
    abilityKey: 'ghost',
    unlock: { type: 'credits', cost: 22000 },
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
    id: 'omega', name: 'OM-X OMEGA', class: 'Legendary Prototype',
    desc: 'An experimental core wrapped in an airframe that should not be flyable. Reheat measured in the wrong units. Reserved for pilots who have proven everything else.',
    stats: { speed: 1.00, accel: 0.96, handling: 0.82, boost: 1.00, durability: 0.74 },
    ability: 'Overcharge — 35% more reheat thrust at the top of the envelope.',
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
];

export const AIRCRAFT_BY_ID = Object.fromEntries(AIRCRAFT.map((a) => [a.id, a]));

/* ===========================================================================
 * BIOMES / LOCATIONS
 * ------------------------------------------------------------------------
 * The roster lives in ./locations.js, which is the root of the graph. A
 * location is an *aerial* interpretation: the aircraft always races through
 * open sky, and the location decides what is underneath it, what is built on
 * it and what the air looks like.
 *
 * A LOCATION IS A WORLD TYPE, NOT A FIXED MAP — every field over there is a
 * constraint the seeded generators in world.js grow a fresh world inside.
 *
 * `BIOMES` is the historical name and stays as the alias every other module
 * already imports; here a biome and a location are the same record, so the
 * alias is honest rather than a shim.
 * ======================================================================== */

export {
  LOCATIONS, LOCATIONS_BY_ID, LOCATION_MENU, RANDOM_LOCATION,
  STRUCTURE_KINDS, VENUE_KINDS, VEHICLE_KINDS, TREE_SPECIES, FLOWER_KINDS,
} from './locations.js';

export const BIOMES = LOCATIONS;
export const BIOMES_BY_ID = LOCATIONS_BY_ID;

/* ===========================================================================
 * WEATHER + TIME OF DAY
 * ------------------------------------------------------------------------
 * Every state below is selectable from the main menu. A location publishes a
 * `weather` pool of the states that make sense for it — you cannot fly a dust
 * storm through a glacier — and the menu greys out anything outside that pool.
 * `Random` (the default) draws from the pool at launch using the run seed.
 *
 * `cloud`/`fog`/`vis` drive the sky shader and fog density, `precip` picks the
 * particle field, `wind`/`turb` feed the flight model, and `sat`/`exposure`
 * grade the final image. `time` pins the sun where a state implies one.
 * ======================================================================== */

export const WEATHER = {
  /* ---- clear family ---- */
  clear:        { name: 'Clear Sky',      cloud: 0.22, fog: 0.35, vis: 1.00, precip: null,  precipRate: 0,    wind: 0.25, turb: 0.20, lightning: 0,    sat: 1.05, exposure: 1.00 },
  brightSun:    { name: 'Bright Sunny',   cloud: 0.10, fog: 0.22, vis: 1.00, precip: null,  precipRate: 0,    wind: 0.18, turb: 0.14, lightning: 0,    sat: 1.12, exposure: 1.06 },
  partlyCloudy: { name: 'Partly Cloudy',  cloud: 0.42, fog: 0.42, vis: 0.94, precip: null,  precipRate: 0,    wind: 0.32, turb: 0.26, lightning: 0,    sat: 1.02, exposure: 0.98 },
  cloudy:       { name: 'Cloudy',         cloud: 0.68, fog: 0.55, vis: 0.86, precip: null,  precipRate: 0,    wind: 0.40, turb: 0.35, lightning: 0,    sat: 0.94, exposure: 0.94 },
  overcast:     { name: 'Overcast',       cloud: 0.88, fog: 0.62, vis: 0.80, precip: null,  precipRate: 0,    wind: 0.46, turb: 0.40, lightning: 0,    sat: 0.86, exposure: 0.88 },
  darkClouds:   { name: 'Dark Clouds',    cloud: 1.05, fog: 0.74, vis: 0.68, precip: null,  precipRate: 0,    wind: 0.62, turb: 0.56, lightning: 0.02, sat: 0.78, exposure: 0.80 },
  /* ---- cloud-structure states — the sky itself is the terrain ---- */
  floatingClouds:  { name: 'Floating Clouds',  cloud: 0.58, fog: 0.40, vis: 0.92, precip: null, precipRate: 0, wind: 0.28, turb: 0.30, lightning: 0, sat: 1.04, exposure: 1.00, banks: 1.3 },
  suspendedClouds: { name: 'Suspended Clouds', cloud: 0.75, fog: 0.50, vis: 0.88, precip: null, precipRate: 0, wind: 0.22, turb: 0.34, lightning: 0, sat: 1.02, exposure: 0.98, banks: 1.8 },
  denseCloud:   { name: 'Dense Cloud',    cloud: 1.20, fog: 0.85, vis: 0.46, precip: null,  precipRate: 0,    wind: 0.55, turb: 0.55, lightning: 0,    sat: 0.88, exposure: 0.90 },
  /* ---- obscuration ---- */
  fog:          { name: 'Fog',            cloud: 0.60, fog: 0.95, vis: 0.46, precip: null,  precipRate: 0,    wind: 0.18, turb: 0.24, lightning: 0,    sat: 0.86, exposure: 0.94 },
  fogBank:      { name: 'Fog Bank',       cloud: 0.72, fog: 1.20, vis: 0.34, precip: null,  precipRate: 0,    wind: 0.20, turb: 0.28, lightning: 0,    sat: 0.82, exposure: 0.92 },
  frozenFog:    { name: 'Frozen Fog',     cloud: 0.78, fog: 1.15, vis: 0.36, precip: 'snow', precipRate: 0.25, wind: 0.34, turb: 0.34, lightning: 0,    sat: 0.80, exposure: 1.00 },
  dustStorm:    { name: 'Dust Atmosphere',cloud: 0.55, fog: 1.10, vis: 0.38, precip: 'dust', precipRate: 0.9,  wind: 0.85, turb: 0.78, lightning: 0,    sat: 0.92, exposure: 0.94, tint: 0xd9a463 },
  /* ---- precipitation ---- */
  lightRain:    { name: 'Light Rain',     cloud: 0.78, fog: 0.70, vis: 0.72, precip: 'rain', precipRate: 0.35, wind: 0.50, turb: 0.45, lightning: 0,    sat: 0.90, exposure: 0.88, wet: 0.55 },
  heavyRain:    { name: 'Heavy Rain',     cloud: 0.92, fog: 0.88, vis: 0.54, precip: 'rain', precipRate: 1.00, wind: 0.72, turb: 0.68, lightning: 0.05, sat: 0.84, exposure: 0.80, wet: 1.00 },
  snow:         { name: 'Snow',           cloud: 0.80, fog: 0.78, vis: 0.66, precip: 'snow', precipRate: 0.45, wind: 0.45, turb: 0.42, lightning: 0,    sat: 0.86, exposure: 1.02 },
  heavySnow:    { name: 'Heavy Snow',     cloud: 0.95, fog: 0.95, vis: 0.40, precip: 'snow', precipRate: 1.10, wind: 0.80, turb: 0.72, lightning: 0,    sat: 0.78, exposure: 0.98 },
  storm:        { name: 'Storm',          cloud: 0.96, fog: 0.92, vis: 0.48, precip: 'rain', precipRate: 0.80, wind: 0.92, turb: 0.90, lightning: 0.25, sat: 0.80, exposure: 0.76, wet: 0.90 },
  thunderstorm: { name: 'Thunderstorm',   cloud: 1.00, fog: 0.95, vis: 0.42, precip: 'rain', precipRate: 1.15, wind: 1.00, turb: 1.00, lightning: 1.00, sat: 0.78, exposure: 0.72, wet: 1.00 },
  /* ---- times of day that carry their own light ---- */
  dawn:         { name: 'Dawn',           cloud: 0.44, fog: 0.78, vis: 0.84, precip: null,  precipRate: 0,    wind: 0.22, turb: 0.20, lightning: 0,    sat: 1.06, exposure: 1.04, time: 'dawn' },
  sunrise:      { name: 'Sunrise',        cloud: 0.50, fog: 0.72, vis: 0.86, precip: null,  precipRate: 0,    wind: 0.28, turb: 0.24, lightning: 0,    sat: 1.10, exposure: 1.00, time: 'sunrise' },
  goldenHour:   { name: 'Golden Hour',    cloud: 0.38, fog: 0.50, vis: 0.92, precip: null,  precipRate: 0,    wind: 0.26, turb: 0.22, lightning: 0,    sat: 1.18, exposure: 1.04, time: 'goldenHour' },
  sunset:       { name: 'Sunset',         cloud: 0.45, fog: 0.55, vis: 0.90, precip: null,  precipRate: 0,    wind: 0.30, turb: 0.25, lightning: 0,    sat: 1.14, exposure: 1.02, time: 'sunset' },
  dusk:         { name: 'Dusk',           cloud: 0.52, fog: 0.62, vis: 0.84, precip: null,  precipRate: 0,    wind: 0.30, turb: 0.28, lightning: 0,    sat: 1.02, exposure: 1.10, time: 'dusk' },
  night:        { name: 'Night',          cloud: 0.42, fog: 0.55, vis: 0.80, precip: null,  precipRate: 0,    wind: 0.32, turb: 0.30, lightning: 0,    sat: 0.94, exposure: 1.18, time: 'night' },
  neonNight:    { name: 'Neon Night',     cloud: 0.62, fog: 0.86, vis: 0.64, precip: null,   precipRate: 0,    wind: 0.40, turb: 0.38, lightning: 0,    sat: 1.22, exposure: 1.22, time: 'night', tint: 0x5a3aff, wet: 0, neon: 1 },
};
export const WEATHER_IDS = Object.keys(WEATHER);

/**
 * The order the WEATHER tab lists states in. `random` is not a weather state —
 * it is the instruction to draw one from the location's pool, and it is the
 * shipping default.
 */
export const WEATHER_MENU = [
  'random',
  'clear', 'brightSun', 'partlyCloudy', 'cloudy', 'overcast', 'darkClouds',
  'floatingClouds', 'suspendedClouds', 'fog', 'fogBank',
  'dawn', 'sunrise', 'goldenHour', 'sunset', 'dusk', 'night', 'neonNight',
  'lightRain', 'heavyRain', 'snow', 'heavySnow', 'storm', 'thunderstorm', 'dustStorm',
];

/** Sun elevation/azimuth + colour identity per time of day. */
export const TIME_OF_DAY = {
  dawn:      { name: 'Dawn',      elev: -2,  azim: 88,  sun: 0xff9a6a, ambient: 0x46557e, ground: 0x4a4438, intensity: 1.25, sky: 0.24, stars: 0.42 },
  sunrise:   { name: 'Sunrise',   elev: 5,   azim: 96,  sun: 0xffb072, ambient: 0x5a6b8c, ground: 0x6b5a48, intensity: 2.4, sky: 0.42, stars: 0.15 },
  morning:   { name: 'Morning',   elev: 32,  azim: 118, sun: 0xfff0d8, ambient: 0x8aa4c8, ground: 0x6b7264, intensity: 3.5, sky: 0.9,  stars: 0 },
  noon:      { name: 'Noon',      elev: 72,  azim: 176, sun: 0xffffff, ambient: 0x9dbbe0, ground: 0x76806f, intensity: 4.1, sky: 1.0,  stars: 0 },
  afternoon: { name: 'Afternoon', elev: 40,  azim: 232, sun: 0xffeccb, ambient: 0x8fabd0, ground: 0x726f5f, intensity: 3.3, sky: 0.86, stars: 0 },
  goldenHour:{ name: 'Golden Hour',elev: 12, azim: 256, sun: 0xffb466, ambient: 0x7a6f96, ground: 0x6a5a44, intensity: 2.9, sky: 0.56, stars: 0.04 },
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
    id: 'powerflight', slot: 1, name: 'POWER FLIGHT', short: 'PWR', icon: 'lift',
    desc: 'Floods the airframe with lift. Gravity stops pulling, hard turns stop costing energy and the route ahead lights up. The recovery button when a line has gone wrong.',
    cooldown: 20, duration: 7.0, color: 0x39f5ff,
  },
  {
    id: 'turbo', slot: 2, name: 'TURBO SPEED', short: 'TRB', icon: 'turbo',
    desc: 'Dumps the reserve into the reheat stage. Extreme acceleration and a raised speed ceiling, at the cost of turn authority.',
    cooldown: 25, duration: 6.0, color: 0xff8a3a,
  },
  {
    id: 'maneuver', slot: 3, name: 'COMBAT MANEUVERS', short: 'MNV', icon: 'maneuver',
    desc: 'Combat trim: near-instant control response, far higher roll and G limits, and the airspace around you seems to slow while you thread it.',
    cooldown: 30, duration: 5.0, color: 0x8fd6ff,
  },
  {
    id: 'shield', slot: 4, name: 'AERIAL SHIELD', short: 'SHD', icon: 'shield',
    desc: 'Projects a hardened collision envelope. Impacts are absorbed instead of damaging the hull.',
    cooldown: 40, duration: 8.0, color: 0x5fe4ff,
  },
  {
    id: 'phase', slot: 5, name: 'PHASE SHIFT', short: 'PHS', icon: 'phase',
    desc: 'Desynchronises the airframe so it passes cleanly through soft obstacles, debris and energy barriers.',
    cooldown: 45, duration: 5.0, color: 0xb478ff,
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
    id: 'endless', name: 'ENDLESS FLIGHT', tag: null,
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
  battle: {
    id: 'battle', name: 'ENDLESS BATTLE', tag: 'DEFAULT',
    desc: 'Open airspace, no gates and no rings — just hostile fighters. Guns, missiles, laser-guided rounds, grenades and RPGs, with unlimited ammunition. Enemy waves get faster, sharper and better organised the longer you last.',
    hasLaps: false, hasRivals: false, hasTimer: false, escalates: true, failOnDamage: true,
    combat: true, noRings: true, primary: 'kills',
    mandatory: ['kills'],
    objectives: [
      'Destroy hostile fighters — every kill escalates the next wave',
      'Hold a target lock before launching; guided rounds need it',
      'Stay alive: your hull does not regenerate between waves',
      'Waves grow in size, accuracy and formation discipline',
    ],
    gameOver: [
      'Hull destroyed by enemy fire',
      'Ground impact, or collision with a building or structure',
      'Engine overheat — 60 seconds above Mach 24',
      'Shot down while stalled below Mach 2',
      'Leaving the combat airspace for more than 20 seconds',
    ],
  },
  endlessrace: {
    id: 'endlessrace', name: 'ENDLESS RACE', tag: 'NEW',
    desc: 'A hostile top-speed run. The same full weapon set as Battle, but the clock is the enemy — hold Mach, fly the manoeuvres and out-run a squadron that tops out at Mach 30 alongside you.',
    hasLaps: false, hasRivals: true, hasTimer: false, escalates: true, failOnDamage: true,
    combat: true, speedFocus: true, primary: 'distance',
    // Aerobatics are not optional here — these are dealt before the random draw.
    mandatory: ['rolls', 'loops', 'turns', 'machhold'],
    objectives: [
      'Hold Mach 22 or above — speed is scored every second',
      'Complete the mandatory manoeuvre set: rolls, loops, flips and hard turns',
      'Stay ahead of the enemy squadron — they also reach Mach 30',
      'Shoot down pursuers that close inside gun range',
    ],
    gameOver: [
      'Hull destroyed by enemy fire',
      'Ground impact, or collision with a building or structure',
      'Engine overheat — 60 seconds above Mach 24',
      'Dropping below Mach 4 for more than 12 seconds',
      'Falling more than 6 km behind the lead enemy',
    ],
  },
  story: {
    id: 'story', name: 'STORY MODE', tag: 'NEW',
    desc: 'Fifteen missions in three acts, flown in order. Each one is a full sortie — a transit, a first contact, an escalation and a hold — of about half an hour, over a venue and a weather system chosen for the mission rather than drawn at random. Objectives are briefed before you launch and advance one phase at a time on the HUD.',
    hasLaps: false, hasRivals: false, hasTimer: false, escalates: true, failOnDamage: true,
    combat: true, noRings: true, story: true, primary: 'kills',
    mandatory: ['kills'],
    objectives: [
      'Fly the mission phases in order — each one unlocks the next',
      'The phase objective and its progress are always on the HUD',
      'Hold a target lock before launching; guided rounds need it',
      'Clearing the last phase clears the mission and unlocks the next',
    ],
    gameOver: [
      'Hull destroyed by enemy fire',
      'Ground impact, or collision with a building or structure',
      'Engine overheat — 60 seconds above Mach 24',
      'Shot down while stalled below Mach 2',
    ],
  },
  free: {
    id: 'free', name: 'FREE FLIGHT', tag: null,
    desc: 'No timer, no rivals, no failure state. Explore the generated venue, learn an airframe, practise the gate work.',
    hasLaps: false, hasRivals: false, hasTimer: false, escalates: false, failOnDamage: false, primary: 'distance',
  },
};
export const MODE_ORDER = ['battle', 'story', 'endless', 'endlessrace', 'quick', 'campaign', 'survival', 'timeattack', 'free'];

/* ===========================================================================
 * WEAPONS
 * ------------------------------------------------------------------------
 * Every airframe carries the full set with unlimited ammunition — the limit
 * is the reload timer, not a magazine. `guided` rounds need a target lock
 * before they will launch; unguided ones fly the pipper.
 * ======================================================================== */

export const WEAPONS = [
  /* ---- guns -------------------------------------------------------------
   * Four barrels with genuinely different characters rather than four names
   * for the same thing: a general-purpose autocannon, a fast weak minigun, a
   * slow heavy cannon that hurts, and a hitscan-fast plasma repeater. The
   * whole set cycles on one key, so switching mid-merge is a single press.
   *
   * REACH. Every gun now carries an explicit `range` — the distance the round
   * is credited to cross — and `life` is derived from it against the muzzle
   * velocity rather than being a separate number to keep in step. The ladder
   * is FIVE TIMES what it was: at Mach 30 closure a six-kilometre gun was one
   * second of firing window, which is why gunnery felt like it never
   * connected. Both muzzle velocity and time of flight carry part of the
   * increase, because range bought entirely with `life` gives you a slow round
   * that arrives after the target has gone.
   *
   * ACCURACY. Dispersion is halved across the board and the hit test is a
   * swept segment rather than a point sample, so a round travelling 90 m in a
   * frame can no longer step straight over the fighter it was aimed at. That
   * one fix is most of what "the guns do not hit anything" was.
   * -------------------------------------------------------------------- */
  {
    id: 'gun', name: 'Autocannon', short: 'GUN', icon: 'gun', heavy: false,
    damage: 20, speed: 3400, life: 8.4, cooldown: 0.075, spread: 0.005,
    guided: false, radius: 34, color: 0xfff0a8, tracer: true, barrels: 2,
    range: 28000,
    desc: '25 mm autocannon. 28 km. Balanced rate and punch.',
  },
  {
    id: 'minigun', name: 'Minigun', short: 'MIN', icon: 'gun', heavy: false,
    damage: 9, speed: 3000, life: 7.0, cooldown: 0.030, spread: 0.010,
    guided: false, radius: 30, color: 0xffd070, tracer: true, barrels: 2,
    range: 21000,
    desc: 'Rotary minigun. 21 km. Enormous rate, wide cone, low damage per round.',
  },
  {
    id: 'heavygun', name: 'Heavy Cannon', short: 'HVY', icon: 'gun', heavy: false,
    damage: 58, speed: 3900, life: 10.0, cooldown: 0.24, spread: 0.0022,
    guided: false, radius: 42, color: 0xffa03c, tracer: true, barrels: 1,
    range: 39000,
    desc: '40 mm cannon. 39 km. Slow, tight, and it hurts.',
  },
  {
    id: 'plasma', name: 'Plasma Repeater', short: 'PLS', icon: 'gun', heavy: false,
    damage: 34, speed: 5600, life: 6.0, cooldown: 0.13, spread: 0.0011,
    guided: false, radius: 38, color: 0x7ff0ff, tracer: true, barrels: 2,
    range: 33000,
    desc: 'Charged bolts. 33 km, and almost no lead required at this velocity.',
  },
  /* ---- heavy weapons ----------------------------------------------------
   * The four heavies are a RANGE LADDER, now SEVEN TIMES its old length:
   * 56 / 70 / 84 / 105 km. `range` is the launch authority — the furthest the
   * round is credited to reach — and it is what the lock gate in combat.js
   * measures against before it will let the weapon off the rail. `life` is
   * then derived to match: a round that claims 105 km must still be alive when
   * it gets there, so life >= range / speed with a margin for the manoeuvring a
   * lead-pursuit intercept actually costs. Motor velocities are raised with the
   * reach, or a 105 km shot is a round the target simply outruns.
   *
   * Damage and blast are also seven times what they were. A hit from any of
   * these is now decisive against any airframe in the game, which is the
   * point: at this reach a heavy is a committed, slow-reloading decision, not
   * chip damage. Hostile-launched rounds are scaled back by
   * `COMBAT.enemyWeaponScale` — see the note there.
   *
   * Guided rounds also carry `precision`, which tightens the terminal seeker.
   * The laser is the reference weapon: highest precision, longest reach, and
   * the tightest turn rate, at the cost of the longest reload on the ladder.
   * -------------------------------------------------------------------- */
  {
    id: 'missile', name: 'Missile', short: 'MSL', icon: 'missile', heavy: true,
    damage: 364, speed: 3400, life: 20.0, cooldown: 1.5, spread: 0,
    guided: true, turnRate: 3.4, radius: 90, blast: 1260, color: 0xff9a4a,
    range: 56000, precision: 0.80,
    desc: 'Heat-seeking missile. 56 km. Needs a lock.',
  },
  {
    id: 'laser', name: 'Laser-Guided Missile', short: 'LGM', icon: 'missile', heavy: true,
    damage: 532, speed: 4200, life: 30.0, cooldown: 2.6, spread: 0,
    guided: true, turnRate: 6.2, radius: 86, blast: 1155, color: 0x66e8ff, beam: true,
    range: 105000, precision: 1.00,
    desc: 'Beam-riding missile. 105 km, laser-guided precision.',
  },
  {
    id: 'grenade', name: 'Air Grenade', short: 'GRN', icon: 'missile', heavy: true,
    damage: 434, speed: 2600, life: 32.0, cooldown: 1.9, spread: 0.012,
    guided: true, turnRate: 2.2, radius: 130, blast: 2240, color: 0x9dff6a,
    range: 70000, precision: 0.62,
    desc: 'Guided cluster charge. 70 km, widest blast on the rail.',
  },
  {
    id: 'rpg', name: 'RPG', short: 'RPG', icon: 'missile', heavy: true,
    damage: 644, speed: 3600, life: 28.0, cooldown: 2.8, spread: 0.004,
    guided: true, turnRate: 2.8, radius: 106, blast: 1820, color: 0xff5a3c, smoke: true,
    range: 84000, precision: 0.72,
    desc: 'Heavy guided rocket. 84 km, enormous damage.',
  },
];
export const WEAPONS_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
/** The order the heavy-weapon selector cycles through. */
export const HEAVY_ORDER = ['missile', 'laser', 'grenade', 'rpg'];
/** The order the gun selector cycles through. */
export const GUN_ORDER = ['gun', 'minigun', 'heavygun', 'plasma'];

export const COMBAT = {
  /* ---- targeting --------------------------------------------------------
   * The seeker is deliberately generous. At Mach 22 a 26° cone and a 5 km
   * range means a target crosses the whole envelope in under a second, so a
   * lock could barely be acquired before it broke — and a lock you cannot hold
   * is a weapon you cannot use. The cone is wider, the range far longer, and
   * once acquired the lock is *sticky*: it keeps tracking through a much wider
   * cone than it needed to acquire, so a hard break turn no longer throws it.
   * -------------------------------------------------------------------- */
  lockConeDeg: 38,             // half-angle to ACQUIRE a lock
  lockHoldDeg: 62,             // half-angle to KEEP one — hysteresis
  /* The seeker has to see at least as far as the longest weapon can reach, or
   * the 105 km round could never be launched at its own rated range. */
  lockRange: 112000,           // m — furthest a lock will hold
  lockTime: 0.55,              // s of continuous tracking to acquire
  lockDecay: 0.8,              // how fast a broken lock bleeds away
  /* ---- gunnery ----------------------------------------------------------
   * A lead-pursuit assist on the cannons. Solving deflection by eye at Mach 22
   * closure is not a skill test, it is a lottery: the lead angle is tens of
   * degrees and changes faster than a human can track. The assist only bites
   * once the pipper is already near the target, so aiming still matters. */
  gunAssist: 0.94,             // how far the burst is bent toward the solution
  gunAssistDeg: 26,            // half-angle in which the assist applies at all
  /** Furthest the pipper will take a gun solution. Follows the belt's reach. */
  gunRange: 12000,
  enemyHealth: 100,
  playerHitFlash: 0.35,
  waveInterval: 26,            // s between reinforcement waves
  /* ---- hostile weapon scaling -------------------------------------------
   * The WEAPONS table is the PLAYER's arsenal, and it is now enormous: a
   * single missile carries 364 damage inside a 1.26 km blast. Hostiles fire
   * from the same table, and a squadron of a hundred aircraft each throwing
   * kilometre-wide warheads at a 100-hull airframe is not a fight, it is a
   * coin flip on the first merge. Rounds NOT launched by the player are scaled
   * by this on the way in, so the player's guns and missiles hit exactly as
   * hard as the table says while the return fire stays survivable.
   * -------------------------------------------------------------------- */
  enemyWeaponScale: 0.14,
  /** Hostile splash reach, as a fraction of the round's rated blast. */
  enemyBlastScale: 0.30,
  /* ---- squadron size ----------------------------------------------------
   * A HUNDRED hostiles minimum in every mode that fields them — five times the
   * old floor. `minEnemies` is a FLOOR the director tops back up to as kills
   * come in, not just an opening grid, so the fight never thins out into a
   * chase. `maxEnemies` is the hard cap on live airframes, and the two are
   * deliberately close: the pressure is meant to be constant rather than
   * arriving in lulls and spikes.
   *
   * A squadron this size only works because hostiles are cheap when they are
   * far away: they fly in path space either way, and `enemyDrawRange` decides
   * how many of them are actually MESHES on any given frame. See the note on
   * that value.
   * -------------------------------------------------------------------- */
  minEnemies: 100,
  maxEnemies: 130,
  /* Absolute ceiling on live hostile AIRFRAMES, whatever a Story mission's
   * pressure asks for. The per-frame cost of a hostile is bounded already —
   * only `enemyDrawBudget` of them are ever meshes — but each one still owns an
   * afterburner, a power shell and a trail ribbon at construction, and a late
   * mission at 2.35x pressure would ask for three hundred of those in a single
   * frame. This is where that stops. */
  hardCap: 180,
  /* ---- drawing a hundred aircraft ---------------------------------------
   * The simulation is cheap: an enemy is a few dozen scalars advanced in path
   * space. The MESH is not — six draw calls, a trail ribbon and an afterburner
   * each. With hostiles spread 7-10 km apart most of them are far outside the
   * distance at which a fighter is more than a pixel, so beyond this range the
   * visual is switched off entirely while the aircraft keeps flying, keeps
   * shooting and keeps showing on the radar. The count on the HUD is the real
   * count; the draw call budget is not.
   * -------------------------------------------------------------------- */
  enemyDrawRange: 26000,       // m — beyond this a hostile is simulated, not drawn
  enemyDrawBudget: 28,         // hard cap on hostile meshes drawn at once
  /* ---- keeping them apart -----------------------------------------------
   * Spawning a squadron seven kilometres apart is not the same as KEEPING it
   * seven kilometres apart: every hostile is pursuing the same aircraft, so
   * without a separation term the whole wing converges on the player's offsets
   * and arrives as one saturated blob — which is the thing the spread exists
   * to prevent. Each fighter therefore pushes off any neighbour closer than
   * `spreadMin` and stops caring past `spreadMax`, so the squadron settles
   * into the 7-10 km lattice the brief asks for while still hunting.
   *
   * The check is strided rather than exhaustive: a hundred aircraft each
   * testing ninety-nine neighbours every frame is ten thousand distance
   * computations for a force that changes slowly. `spreadSamples` peers per
   * frame, on a rotating offset, converges to the same lattice.
   * -------------------------------------------------------------------- */
  spreadMin: 7000,             // m — closer than this and they push apart
  spreadMax: 10000,            // m — past this a neighbour is not a neighbour
  spreadForce: 2.2,            // how hard the push is, in offset metres/second
  spreadSamples: 14,           // peers each fighter checks per frame
  /** Seconds after a kill before that slot is refilled. */
  respawnDelay: 3.5,
  /* ---- approach geometry ------------------------------------------------
   * Hostiles ALWAYS arrive ahead of the player, never behind, and always
   * between `spawnAheadMin` and `spawnAheadMax` along the route. Being bounced
   * from behind before you have built any speed is not a hard merge, it is a
   * coin flip you lose — and at Mach 25 closure a hostile that spawns behind
   * you is on your tail before the countdown banner has faded.
   *
   * Seven to ten kilometres is the window. Nearer and there is no time to
   * point the aircraft; further and the first minute of every sortie is spent
   * flying toward an empty horizon. The formation spread is a further seven to
   * ten kilometres ACROSS, so a wave arrives as a band in front of you rather
   * than a point, and the geometry below decides where in that band.
   * -------------------------------------------------------------------- */
  approach: { head: 0.34, side: 0.26, diagonal: 0.24, vertical: 0.16 },
  spawnAheadMin: 7000,         // m — closest a hostile may ever appear
  spawnAheadMax: 10000,        // m — furthest
  /* ---- the settle-in window ---------------------------------------------
   * Hostiles hold fire for this long at the start of a sortie. Spawning them
   * far enough away is not by itself enough time: they carry rounds rated for
   * fifty kilometres, so without this the first missile is off the rail while
   * the player is still at zero on the runway clock. For these seconds they
   * are visible, they manoeuvre, they close — and they do not shoot. It is the
   * difference between a fight starting and a fight ambushing you.
   * -------------------------------------------------------------------- */
  engageDelay: 22,             // s of held fire at the start of a run
  /** Pursuit is this fraction of normal while the hold is running. */
  engageHoldPursuit: 0.35,
  /** Enemy liveries — the recolours the same three airframes are issued in. */
  liveries: [
    0x2fd96b, 0x3aa0ff, 0xff5fb0, 0xffd63a, 0xff8a26, 0x1b1d22,
    0x9b5cff, 0x00d6c4, 0xd63a3a, 0xc9d2dc,
  ],
};


/* ===========================================================================
 * STORY MODE
 * ------------------------------------------------------------------------
 * Fifteen missions, in three acts, flown in order. This is the only mode with
 * a fixed shape: every other mode in the game is a generator with a scoreboard
 * attached, and none of them can build a sortie that ESCALATES — that opens
 * quietly, turns, and finishes somewhere you did not expect to be.
 *
 * HOW A MISSION IS BUILT
 *
 * A mission is a list of PHASES flown back to back without a loading screen.
 * Each phase is one measurable goal against the same `metrics` object every
 * other mode already fills in, so nothing here needs a bespoke tracker:
 *
 *   kills       hostiles destroyed          time      seconds survived
 *   distance    metres flown                machTime  seconds held above blur Mach
 *   manoeuvres  named manoeuvres flown      rolls     full-axis rolls
 *   turns       hard turns                  loops     loops and flips
 *   nearMisses  close passes on structures  topMach   highest Mach reached
 *
 * Phase goals are CUMULATIVE within a mission — a phase that asks for 40 kills
 * after one that asked for 25 wants 40 total, not 65 more — because that is
 * what the HUD can honestly show as one bar filling.
 *
 * LENGTH. The brief is 25-30 minutes per mission and the numbers below are
 * sized for it rather than guessed. At the tuning point the game ships with, a
 * competent pilot in the middle of a hundred-ship squadron kills roughly one
 * hostile every 12-16 seconds once the merge has developed, and covers about
 * 2 km/s at cruise. A five-phase mission asking for 90 kills is therefore
 * something like twenty minutes of fighting plus the transit and survival
 * phases around it. `estMinutes` records the intent so the menu can state it
 * and so anyone retuning the numbers can see what they were aimed at.
 *
 * DIFFICULTY comes from three places, and all three climb across the fifteen:
 * the difficulty preset (rival skill, damage, weather severity), the venue
 * (Emerald Delta is forgiving, Neon Megacity is not), and `pressure` — a
 * multiplier on the squadron floor, so late missions genuinely put more
 * airframes in the sky rather than the same fight with bigger numbers on it.
 * ======================================================================== */

/** One phase of a mission. `text` is what the HUD shows while it is live. */
const P = (id, text, metric, value, hint = '') => ({ id, text, metric, value, hint });

export const STORY = [
  /* ================= ACT I — THE DELTA ==================================
   * Learning the aircraft and the war, over the friendliest airspace on the
   * circuit. The threat is real from the first mission but the sky is wide,
   * the weather is clear and the ground is a long way down.
   * =================================================================== */
  {
    id: 1, act: 1, actName: 'THE DELTA', name: 'FIRST LIGHT',
    biome: 'forest', weather: 'sunrise', time: 'sunrise', diff: 'normal',
    pressure: 0.55, reward: 2400, estMinutes: 26,
    tagline: 'A patrol that stopped answering.',
    situation: 'Delta Control lost contact with the dawn patrol ninety minutes ago, somewhere over the eastern channel beds. You are the nearest airframe. Go and find out what happened to them.',
    intel: 'Expect nothing. That is what the last three sorties expected.',
    orders: 'Fly the channel, hold the airspace when it turns, and come home.',
    phases: [
      P(1, 'Fly the eastern channel and make contact', 'distance', 26000,
        'Hold the throttle up. The beds run east — follow them.'),
      P(2, 'Engage the hostiles that find you', 'kills', 18,
        'Left mouse is guns. Right mouse launches, and needs a lock first.'),
      P(3, 'Hold the airspace for four minutes', 'time', 600,
        'They will keep coming. Keep your hull.'),
      P(4, 'Break the first wing — 45 confirmed', 'kills', 45,
        'Use the missiles. At this reach you can kill before the merge.'),
      P(5, 'Clear the channel — 70 confirmed', 'kills', 70,
        'Finish it. Nothing hostile leaves the beds.'),
    ],
  },
  {
    id: 2, act: 1, actName: 'THE DELTA', name: 'THE TERRACES',
    biome: 'forest', weather: 'overcast', time: 'morning', diff: 'normal',
    pressure: 0.70, reward: 3000, estMinutes: 27,
    tagline: 'They are not raiding. They are surveying.',
    situation: 'The wreck you found was not shot down in a dogfight — it was shot down from behind, at range, by something that knew exactly where it would be. Somebody is mapping this valley.',
    intel: 'Hostile flights are working the terrace viaducts in spread pairs. They break the moment they are engaged.',
    orders: 'Work the terraces. Do not let a single flight finish its run.',
    phases: [
      P(1, 'Reach the terrace viaducts', 'distance', 22000,
        'The viaducts are the tall structures on the hill shoulders.'),
      P(2, 'Break up the survey flights — 30 confirmed', 'kills', 30,
        'Kill the leader and the rest scatter. Take them while they are scattered.'),
      P(3, 'Fly 12 hard manoeuvres while engaged', 'manoeuvres', 12,
        'Q and E roll the airframe. A and D bank it. Both count.'),
      P(4, 'Survive the response — six minutes', 'time', 900,
        'They know you are here now.'),
      P(5, 'Clear the terraces — 75 confirmed', 'kills', 75,
        'All of them.'),
    ],
  },
  {
    id: 3, act: 1, actName: 'THE DELTA', name: 'HOLLOW VALE',
    biome: 'village', weather: 'goldenHour', time: 'goldenHour', diff: 'normal',
    pressure: 0.85, reward: 3600, estMinutes: 28,
    tagline: 'Low, slow, and over somebody\'s house.',
    situation: 'The survey flights were mapping approach lanes into the Vale. Whatever is coming, it is coming through farmland, and there are people underneath it.',
    intel: 'You will be fighting low. The ground is close and it does not move.',
    orders: 'Hold the Vale. Stay off the ground while you do it.',
    phases: [
      P(1, 'Take up station over the Vale', 'distance', 18000,
        'The windmill ridge is the marker.'),
      P(2, 'Intercept the first push — 25 confirmed', 'kills', 25,
        'They are coming in low. Look down.'),
      P(3, 'Thread 20 close passes on the structures', 'nearMisses', 20,
        'Fly close to the buildings without touching them. Close is the point.'),
      P(4, 'Hold for six minutes', 'time', 900,
        'Do not chase them out of the valley. Hold.'),
      P(5, 'Break the push — 80 confirmed', 'kills', 80,
        'Send the rest home without an aircraft.'),
    ],
  },
  {
    id: 4, act: 1, actName: 'THE DELTA', name: 'THE LONG CHASE',
    biome: 'desert', weather: 'brightSun', time: 'noon', diff: 'hard',
    pressure: 0.95, reward: 4400, estMinutes: 29,
    tagline: 'One of them ran. Follow it.',
    situation: 'A single hostile broke off west across the Ashfall Flats at full reheat. It is going somewhere. Follow it, and try not to lose it in the dust.',
    intel: 'Nothing out there but mesa and wadi. Sightlines are enormous, and so are theirs.',
    orders: 'Stay with it. Whatever it leads you to, engage.',
    phases: [
      P(1, 'Run it down — 60 km across the flats', 'distance', 60000,
        'Nitrous is Space. Turbo Speed on NUM 2 doubles it.'),
      P(2, 'Hold Mach 22 or better for two minutes', 'machTime', 120,
        'Keep the throttle up. Watch the heat above Mach 24.'),
      P(3, 'Engage what it led you to — 35 confirmed', 'kills', 35,
        'That is a lot more than one aircraft.'),
      P(4, 'Survive the ambush — five minutes', 'time', 780,
        'They knew you were following. Of course they did.'),
      P(5, 'Fight clear — 85 confirmed', 'kills', 85,
        'Out the other side.'),
    ],
  },
  {
    id: 5, act: 1, actName: 'THE DELTA', name: 'ASHFALL',
    biome: 'desert', weather: 'dustStorm', time: 'afternoon', diff: 'hard',
    pressure: 1.10, reward: 5200, estMinutes: 30,
    tagline: 'A staging field, and a storm on top of it.',
    situation: 'The chase ended at a dispersal field under a rolling dust front. This is where the survey flights were coming from. Take it apart before the storm closes it to you as well.',
    intel: 'Visibility will be almost nothing. Your radar is not affected. Use it.',
    orders: 'Destroy the field\'s air cover. Act One ends here.',
    phases: [
      P(1, 'Penetrate the dust front', 'distance', 24000,
        'Fly the instruments. The radar is bottom left.'),
      P(2, 'Suppress the alert flight — 30 confirmed', 'kills', 30,
        'They are already airborne.'),
      P(3, 'Fly 18 manoeuvres inside the storm', 'manoeuvres', 18,
        'Turbulence is worse in here. Fly through it.'),
      P(4, 'Hold the field for eight minutes', 'time', 1140,
        'The whole base is scrambling now.'),
      P(5, 'Destroy the air cover — 95 confirmed', 'kills', 95,
        'Every airframe on this field.'),
    ],
  },

  /* ================= ACT II — THE HIGH GROUND ============================
   * The war stops being a mystery and becomes a campaign. Harder venues,
   * worse weather, and a squadron that has clearly been told about you.
   * =================================================================== */
  {
    id: 6, act: 2, actName: 'THE HIGH GROUND', name: 'THE CANOPY',
    biome: 'jungle', weather: 'fogBank', time: 'morning', diff: 'hard',
    pressure: 1.20, reward: 6000, estMinutes: 28,
    tagline: 'Karst towers, fog, and no horizon.',
    situation: 'The dispersal field was resupplied from the Verdant Canopy. The route runs between limestone towers a wingspan apart, under cloud that sits on the deck all morning.',
    intel: 'The towers are solid and they are taller than you think. The gaps between them are real.',
    orders: 'Follow the supply route through the karst and cut it.',
    phases: [
      P(1, 'Enter the karst field', 'distance', 20000,
        'Between the towers, not over them. Over them is where they are watching.'),
      P(2, 'Thread 30 close passes between the towers', 'nearMisses', 30,
        'Arches and gaps are flyable. Solid rock is not.'),
      P(3, 'Cut the supply flights — 40 confirmed', 'kills', 40,
        'They cannot manoeuvre in here either.'),
      P(4, 'Hold the route for seven minutes', 'time', 1020,
        'Nothing gets through.'),
      P(5, 'Close the route — 90 confirmed', 'kills', 90,
        'Permanently.'),
    ],
  },
  {
    id: 7, act: 2, actName: 'THE HIGH GROUND', name: 'SILT AND SALT',
    biome: 'mudwater', weather: 'clear', time: 'afternoon', diff: 'hard',
    pressure: 1.30, reward: 6800, estMinutes: 29,
    tagline: 'Nowhere to hide on a floor this flat.',
    situation: 'Their forward radar sits on the Silt Pans, strung along the old barrage walls. Flat ground, no relief, no cover, and a horizon that goes on forever in every direction.',
    intel: 'You will be visible from the moment you arrive. So will they.',
    orders: 'Break the radar picket and everything defending it.',
    phases: [
      P(1, 'Cross the pans to the barrage line', 'distance', 30000,
        'Stay low. It will not help, but stay low anyway.'),
      P(2, 'Break the picket — 35 confirmed', 'kills', 35,
        'Long-range work. The laser round reaches 105 km.'),
      P(3, 'Hold Mach 22 for three minutes under fire', 'machTime', 180,
        'Speed is the only cover out here.'),
      P(4, 'Survive the counter-sweep — eight minutes', 'time', 1140,
        'They have nothing else to do today.'),
      P(5, 'Clear the pans — 100 confirmed', 'kills', 100,
        'Leave nothing on this floor.'),
    ],
  },
  {
    id: 8, act: 2, actName: 'THE HIGH GROUND', name: 'WHITE SILENCE',
    biome: 'ice', weather: 'heavySnow', time: 'noon', diff: 'elite',
    pressure: 1.40, reward: 8000, estMinutes: 30,
    tagline: 'The only cold place on the circuit, and they chose it.',
    situation: 'Glacier Reach. A whiteout, a shelf wall a kilometre high, and a hostile wing that has been waiting up here since before any of this started.',
    intel: 'Whiteout means whiteout. You will see the ice when you are on it.',
    orders: 'Find the wing and destroy it. All of it.',
    phases: [
      P(1, 'Reach the shelf wall', 'distance', 26000,
        'The wall runs across your track. Do not fly into it.'),
      P(2, 'First contact — 30 confirmed', 'kills', 30,
        'They are above you. They are always above you up here.'),
      P(3, 'Fly 12 full-axis rolls in the engagement', 'rolls', 12,
        'Q and E. All the way round, both times.'),
      P(4, 'Hold the shelf for nine minutes', 'time', 1320,
        'Watch your hull. Nothing regenerates.'),
      P(5, 'Destroy the wing — 105 confirmed', 'kills', 105,
        'This is the one that has been killing patrols.'),
    ],
  },
  {
    id: 9, act: 2, actName: 'THE HIGH GROUND', name: 'TITAN PASS',
    biome: 'mountain', weather: 'fog', time: 'morning', diff: 'elite',
    pressure: 1.50, reward: 9200, estMinutes: 30,
    tagline: 'A pass barely wider than a wingspan.',
    situation: 'Their reinforcement route crosses the Titan Range through a single pass. Two and a half kilometres of vertical relief on both sides and fog filling the bottom of it.',
    intel: 'The pass is flyable. The mountain is not. There is no third option.',
    orders: 'Hold the pass. Nothing crosses it while you are alive.',
    phases: [
      P(1, 'Climb to the pass', 'distance', 24000,
        'Up. Then keep going up.'),
      P(2, 'Meet the first crossing — 35 confirmed', 'kills', 35,
        'They will come through in trail. Take the queue apart.'),
      P(3, 'Thread 35 close passes in the pass itself', 'nearMisses', 35,
        'The walls are the difficulty here, not the enemy.'),
      P(4, 'Hold the pass for nine minutes', 'time', 1320,
        'They cannot go round.'),
      P(5, 'Close the pass — 110 confirmed', 'kills', 110,
        'Close it.'),
    ],
  },
  {
    id: 10, act: 2, actName: 'THE HIGH GROUND', name: 'THE CITADEL',
    biome: 'fortress', weather: 'thunderstorm', time: 'dusk', diff: 'elite',
    pressure: 1.65, reward: 11000, estMinutes: 30,
    tagline: 'The oldest venue on the circuit, at its worst.',
    situation: 'Everything you have destroyed since the Delta was staged out of Citadel Siege. The curtain walls are eight hundred years old, the storm sitting on them is the only weather on this circuit that can hurt you, and the wing inside is their best.',
    intel: 'Lightning, wind shear and flying debris. The storm is a participant.',
    orders: 'Break the Citadel wing. Act Two ends here.',
    phases: [
      P(1, 'Fight into the storm cell', 'distance', 22000,
        'It gets worse the further in you go.'),
      P(2, 'Engage the curtain wall flights — 40 confirmed', 'kills', 40,
        'They know the gaps in the stonework. You do not, yet.'),
      P(3, 'Fly 25 manoeuvres inside the cell', 'manoeuvres', 25,
        'Rolls, loops, hard turns. All of them count.'),
      P(4, 'Hold inside the walls for ten minutes', 'time', 1500,
        'This is their ground and they are not leaving it.'),
      P(5, 'Break the wing — 120 confirmed', 'kills', 120,
        'Then get out before the storm closes.'),
    ],
  },

  /* ================= ACT III — TERMINAL VELOCITY =========================
   * The last five. Maximum difficulty, maximum pressure, and the fights
   * finally happen at the top of the envelope where the airframe was always
   * meant to live.
   * =================================================================== */
  {
    id: 11, act: 3, actName: 'TERMINAL VELOCITY', name: 'MERIDIAN',
    biome: 'city', weather: 'sunset', time: 'sunset', diff: 'master',
    pressure: 1.80, reward: 13000, estMinutes: 29,
    tagline: 'The line runs between the buildings, not above them.',
    situation: 'They have reached Meridian Sprawl. Twelve million people underneath a fight that is now happening at Mach 25 between glass towers.',
    intel: 'Twin-tower pairs have a plaza between them wide enough to fly through. Most other things do not.',
    orders: 'Clear the sprawl. Keep it between the towers.',
    phases: [
      P(1, 'Enter the downtown corridor', 'distance', 20000,
        'Down among them. Height is what they are watching for.'),
      P(2, 'Break the first sweep — 40 confirmed', 'kills', 40,
        'Use the buildings. They will not follow you through a gap.'),
      P(3, 'Thread 40 close passes between the towers', 'nearMisses', 40,
        'The gaps are real. The glass is not a suggestion.'),
      P(4, 'Hold the sprawl for ten minutes', 'time', 1500,
        'Every airframe they have left is coming here.'),
      P(5, 'Clear the sprawl — 125 confirmed', 'kills', 125,
        'Over the city. Do it cleanly.'),
    ],
  },
  {
    id: 12, act: 3, actName: 'TERMINAL VELOCITY', name: 'REDLINE',
    biome: 'desert', weather: 'goldenHour', time: 'goldenHour', diff: 'master',
    pressure: 1.90, reward: 14500, estMinutes: 28,
    tagline: 'Above Mach 24 the engine is on a clock.',
    situation: 'Their last transport wing is running for open airspace at the top of its envelope. You cannot catch it without going past the redline, and past the redline you have sixty seconds before the engine lets go.',
    intel: 'Mach 24 is the thermal limit. Backing off cools it — slowly. Budget it.',
    orders: 'Catch the wing. Spend the heat carefully.',
    phases: [
      P(1, 'Open the pursuit — 80 km', 'distance', 80000,
        'Turbo Speed doubles the nitrous. NUM 2.'),
      P(2, 'Hold Mach 22 or better for five minutes', 'machTime', 300,
        'This is the phase the engine hates.'),
      P(3, 'Reach Mach 29', 'topMach', 29,
        'The ceiling is Mach 30. Go and touch it.'),
      P(4, 'Destroy the escort — 60 confirmed', 'kills', 60,
        'They are as fast as you are. They cannot turn like you.'),
      P(5, 'Destroy the wing — 115 confirmed', 'kills', 115,
        'Nothing lands.'),
    ],
  },
  {
    id: 13, act: 3, actName: 'TERMINAL VELOCITY', name: 'NIGHT OVER NEON',
    biome: 'neon', weather: 'neonNight', time: 'night', diff: 'master',
    pressure: 2.00, reward: 16000, estMinutes: 30,
    tagline: 'Every surface is a light source and every reflection lies.',
    situation: 'Neon Megacity, at night, in the rain of light that passes for weather here. Their command element is somewhere in the middle of it and is not going to announce itself.',
    intel: 'You will not be able to trust your eyes. Trust the radar and the lock tone.',
    orders: 'Find the command element. Destroy everything around it first.',
    phases: [
      P(1, 'Enter the neon grid', 'distance', 22000,
        'Follow the arterials. They glow for a reason.'),
      P(2, 'Strip the escort — 45 confirmed', 'kills', 45,
        'The command element does not fly without one.'),
      P(3, 'Fly 20 full-axis rolls in the grid', 'rolls', 20,
        'Rolling is how you break a lock in here.'),
      P(4, 'Hold the grid for eleven minutes', 'time', 1620,
        'They will spend everything to protect this.'),
      P(5, 'Destroy the command element — 130 confirmed', 'kills', 130,
        'It is in there. Take the rest apart until it is not.'),
    ],
  },
  {
    id: 14, act: 3, actName: 'TERMINAL VELOCITY', name: 'THE LAST FIELD',
    biome: 'fortress', weather: 'storm', time: 'dawn', diff: 'legendary',
    pressure: 2.15, reward: 19000, estMinutes: 30,
    tagline: 'Everything they have left, in one place.',
    situation: 'What is left of their air arm has consolidated back at the Citadel. Every airframe that survived the Delta, the Canopy, the Pans, the Reach, the Pass, Meridian and Neon is on that field or above it.',
    intel: 'There is no clever way to do this one.',
    orders: 'Destroy it.',
    phases: [
      P(1, 'Fight your way in', 'distance', 24000,
        'They are expecting you this time.'),
      P(2, 'Break the outer screen — 45 confirmed', 'kills', 45,
        'The screen is thick. Go through it, not round.'),
      P(3, 'Fly 30 manoeuvres in the fight', 'manoeuvres', 30,
        'Everything you have learned.'),
      P(4, 'Hold over the field for twelve minutes', 'time', 1740,
        'The longest hold of the war.'),
      P(5, 'Destroy the air arm — 140 confirmed', 'kills', 140,
        'All of it.'),
    ],
  },
  {
    id: 15, act: 3, actName: 'TERMINAL VELOCITY', name: 'ALPHA',
    biome: 'neon', weather: 'darkClouds', time: 'night', diff: 'legendary',
    pressure: 2.35, reward: 30000, estMinutes: 30,
    tagline: 'The last one. Everything, at the top of the envelope.',
    situation: 'One airframe left on their side, and it is the same class as yours. Same ceiling, same reheat, same reach. It has been flying against you since the Delta and it has learned everything you did.',
    intel: 'It will reverse onto you. It will roll out of your gun solution. It will not make a mistake.',
    orders: 'End it.',
    phases: [
      P(1, 'Make the merge', 'distance', 18000,
        'It is coming to you. Do not turn early.'),
      P(2, 'Survive the first pass — 40 confirmed', 'kills', 40,
        'It did not come alone.'),
      P(3, 'Reach Mach 30', 'topMach', 30,
        'The ceiling. Nothing above this.'),
      P(4, 'Hold for twelve minutes', 'time', 1740,
        'It is waiting for your hull to run out.'),
      P(5, 'Finish it — 150 confirmed', 'kills', 150,
        'Everything, at the top of the envelope.'),
    ],
  },
];

export const STORY_BY_ID = Object.fromEntries(STORY.map((m) => [m.id, m]));
/** The three acts, for the menu's section headers. */
export const STORY_ACTS = [
  { act: 1, name: 'THE DELTA', desc: 'Learning the aircraft, and the war.' },
  { act: 2, name: 'THE HIGH GROUND', desc: 'It stops being a mystery and becomes a campaign.' },
  { act: 3, name: 'TERMINAL VELOCITY', desc: 'The last five, at the top of the envelope.' },
];

/* ===========================================================================
 * CAMPAIGN
 * ======================================================================== */

export const CAMPAIGN = [
  { id: 1, name: 'FIRST LIGHT',      biome: 'village',  weather: 'sunrise',      diff: 'normal', laps: 1, goal: { type: 'position', value: 3 }, reward: 1200, desc: 'A shakedown run over the vale. Finish on the podium.' },
  { id: 2, name: 'CHANNEL RUN',      biome: 'forest',   weather: 'overcast',     diff: 'normal', laps: 2, goal: { type: 'position', value: 2 }, reward: 1600, desc: 'Down the delta beds under a low ceiling. Second or better.' },
  { id: 3, name: 'GLASS CANYONS',    biome: 'city',     weather: 'sunset',       diff: 'hard',   laps: 2, goal: { type: 'position', value: 2 }, reward: 2200, desc: 'Between the towers at golden hour.' },
  { id: 4, name: 'DRY THUNDER',      biome: 'desert',   weather: 'dustStorm',    diff: 'hard',   laps: 2, goal: { type: 'position', value: 1 }, reward: 3000, desc: 'Zero visibility across the flats. Win it.' },
  { id: 5, name: 'WHITE SILENCE',    biome: 'ice',      weather: 'heavySnow',    diff: 'elite',  laps: 2, goal: { type: 'position', value: 2 }, reward: 3800, desc: 'Whiteout over the glacier shelf.' },
  { id: 6, name: 'THE CITADEL',      biome: 'fortress', weather: 'thunderstorm', diff: 'elite',  laps: 2, goal: { type: 'position', value: 1 }, reward: 5000, desc: 'Boss race. The circuit\'s oldest venue, at its worst.', boss: true },
  { id: 7, name: 'SALT LINE',        biome: 'mudwater', weather: 'goldenHour',   diff: 'master', laps: 2, goal: { type: 'position', value: 1 }, reward: 6400, desc: 'Barrage walls and pylon runs across the pans.' },
  { id: 8, name: 'SPIRE ASCENT',     biome: 'mountain', weather: 'fog',          diff: 'master', laps: 2, goal: { type: 'position', value: 1 }, reward: 8000, desc: 'Vertical racing through kilometre-deep passes.' },
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
  { id: 'topspeed',  text: (v) => `Reach Mach ${v}`,                              metric: 'topMach',    values: [12, 18, 23, 28],            reward: 1.1, modes: ['endless', 'survival', 'free', 'timeattack', 'quick', 'endlessrace'] },
  /* ---- combat (Endless Battle / Endless Race) ---- */
  { id: 'kills',     text: (v) => `Shoot down ${v} enemy fighters`,               metric: 'kills',      values: [4, 9, 16, 26],              reward: 1.5, modes: ['battle', 'endlessrace'] },
  { id: 'missiles',  text: (v) => `Land ${v} guided-weapon hits`,                 metric: 'missiles',   values: [3, 7, 12, 20],              reward: 1.4, modes: ['battle', 'endlessrace'] },
  { id: 'gunhits',   text: (v) => `Score ${v} cannon hits`,                       metric: 'hits',       values: [30, 70, 120, 200],          reward: 1.1, modes: ['battle', 'endlessrace'] },
  { id: 'nodamage',  text: (v) => `Destroy ${v} enemies without taking a hit`,    metric: 'cleanKills', values: [2, 4, 7, 11],               reward: 1.9, modes: ['battle'] },
  /* ---- manoeuvres (mandatory in Endless Race) ---- */
  { id: 'rolls',     text: (v) => `Complete ${v} full aileron rolls`,             metric: 'rolls',      values: [3, 6, 11, 18],              reward: 1.2, modes: ['endlessrace', 'battle', 'free'] },
  { id: 'loops',     text: (v) => `Fly ${v} complete loops`,                      metric: 'loops',      values: [2, 4, 7, 11],               reward: 1.4, modes: ['endlessrace', 'battle', 'free'] },
  { id: 'turns',     text: (v) => `Pull ${v} hard turns above 6 G`,               metric: 'turns',      values: [6, 12, 20, 32],             reward: 1.2, modes: ['endlessrace', 'battle'] },
  { id: 'machhold',  text: (v) => `Hold Mach 22+ for ${v} seconds`,               metric: 'machTime',   values: [20, 45, 80, 130],           reward: 1.5, modes: ['endlessrace'] },
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
  { id: 'sonic',       name: 'Sonic',              desc: 'Reach Mach 20.',                                 check: (s) => (s.bestMach || 0) >= 20,      reward: 1000 },
  { id: 'mach20',      name: 'Terminal Velocity',  desc: 'Touch the Mach 30 ceiling.',                     check: (s) => (s.bestMach || 0) >= 29.8,    reward: 3000 },
  { id: 'acesuit',     name: 'Ace',                desc: 'Shoot down 5 enemy fighters in one sortie.',     check: (s) => (s.bestKills || 0) >= 5,      reward: 1500 },
  { id: 'topgun',      name: 'Top Gun',            desc: 'Shoot down 100 enemy fighters in total.',        check: (s) => (s.totalKills || 0) >= 100,   reward: 4000 },
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
  { id: 'actone',      name: 'The Delta',          desc: 'Clear Act I of Story Mode.',                     check: (s, save) => (save.storyProgress || 0) >= 5,  reward: 4000 },
  { id: 'acttwo',      name: 'The High Ground',    desc: 'Clear Act II of Story Mode.',                    check: (s, save) => (save.storyProgress || 0) >= 10, reward: 9000 },
  { id: 'storydone',   name: 'Terminal Velocity',  desc: 'Clear all fifteen Story missions.',              check: (s, save) => (save.storyProgress || 0) >= STORY.length, reward: 25000 },
];

/* ===========================================================================
 * INPUT
 * ======================================================================== */

export const DEFAULT_BINDINGS = {
  pitchUp:    ['KeyW', 'ArrowUp'],
  pitchDown:  ['KeyS', 'ArrowDown'],
  leanLeft:   ['KeyA', 'ArrowLeft'],
  leanRight:  ['KeyD', 'ArrowRight'],
  rollLeft:   ['KeyQ'],
  rollRight:  ['KeyE'],
  throttleUp: ['ShiftLeft', 'ShiftRight'],
  brake:      ['ControlLeft', 'KeyH'],
  boost:      ['Space'],
  power1:     ['Numpad1', 'Digit1'],
  power2:     ['Numpad2', 'Digit2'],
  power3:     ['Numpad3', 'Digit3'],
  power4:     ['Numpad4', 'Digit4'],
  power5:     ['Numpad5', 'Digit5'],
  // Guns and missiles are on the mouse; the keys stay bound as an alternative.
  fireGun:      ['KeyG'],
  fireWeapon:   ['KeyR'],
  cycleGun:     ['Numpad8', 'Digit8'],
  cycleWeapon:  ['Numpad9', 'Digit9'],
  cycleTarget:  ['KeyT'],
  // One key per heavy weapon. Pressing it selects that weapon AND fires it, so
  // picking a missile and launching it is a single action rather than three.
  // R stays as "fire whatever is selected" for anyone who prefers that.
  weaponMissile: ['KeyZ'],
  weaponLaser:   ['KeyX'],
  weaponGrenade: ['KeyV'],
  weaponRpg:     ['KeyB'],
  pause:      ['Escape'],
  fullscreen: ['KeyF'],
  // One key, one press: C toggles between Chase and First Person.
  camera:     ['KeyC'],
  debug:      ['F8'],
};

export const BINDING_LABELS = {
  pitchUp: 'Pitch Up / Climb', pitchDown: 'Pitch Down / Dive',
  leanLeft: 'Lean / Turn Left', leanRight: 'Lean / Turn Right',
  rollLeft: 'Bank Left', rollRight: 'Bank Right',
  throttleUp: 'Throttle Up', brake: 'Air Brake', boost: 'Nitrous Boost',
  fireGun: 'Fire Guns (or Left Mouse)', fireWeapon: 'Launch Missile (or Right Mouse)',
  cycleGun: 'Next Gun Type', cycleWeapon: 'Next Missile Type',
  cycleTarget: 'Change Target',
  weaponMissile: 'Missile — select and fire',
  weaponLaser: 'Laser-Guided Missile — select and fire',
  weaponGrenade: 'Air Grenade — select and fire',
  weaponRpg: 'RPG — select and fire',
  power1: 'Power 1 — Power Flight', power2: 'Power 2 — Turbo Speed',
  power3: 'Power 3 — Combat Maneuvers', power4: 'Power 4 — Aerial Shield',
  power5: 'Power 5 — Phase Shift',
  pause: 'Pause', fullscreen: 'Fullscreen', camera: 'Camera View', debug: 'Debug Overlay',
};

/* ---------------------------------------------------------------------------
 * HUD CONTROL LEGEND
 * ------------------------------------------------------------------------
 * Three groups rather than one long strip: FLIGHT (green), COMBAT (red) and
 * SYSTEM (blue). Colour-coding by purpose is what makes a nineteen-key legend
 * scannable — the eye goes to the right box before it reads a single cap.
 * `icon` names resolve against the ICONS table in ui.js.
 * ------------------------------------------------------------------------ */
export const CONTROL_GROUPS = [
  {
    id: 'flight', name: 'FLIGHT', tone: 'green',
    items: [
      { action: 'pitchUp', short: 'Climb', icon: 'climb' },
      { action: 'pitchDown', short: 'Dive', icon: 'dive' },
      { action: 'leanLeft', short: 'Left', icon: 'leanL' },
      { action: 'leanRight', short: 'Right', icon: 'leanR' },
      { action: 'rollLeft', short: 'Roll L', icon: 'rollL' },
      { action: 'rollRight', short: 'Roll R', icon: 'rollR' },
      { action: 'throttleUp', short: 'Thrust', icon: 'throttle' },
      { action: 'brake', short: 'Brake', icon: 'brake' },
      { action: 'boost', short: 'Nitrous', icon: 'turbo' },
    ],
  },
  {
    id: 'combat', name: 'COMBAT', tone: 'red', combat: true,
    items: [
      { action: 'fireGun', short: 'Guns', icon: 'gun', keyOverride: 'LMB' },
      { action: 'fireWeapon', short: 'Launch', icon: 'launch', keyOverride: 'RMB' },
      { action: 'cycleGun', short: 'Gun', icon: 'gun' },
      { action: 'cycleWeapon', short: 'Missile', icon: 'missile' },
      { action: 'weaponMissile', short: 'MSL', icon: 'missile' },
      { action: 'weaponLaser', short: 'LGM', icon: 'laser' },
      { action: 'weaponGrenade', short: 'GRN', icon: 'grenade' },
      { action: 'weaponRpg', short: 'RPG', icon: 'rpg' },
      { action: 'cycleTarget', short: 'Target', icon: 'lock' },
    ],
  },
  {
    id: 'system', name: 'SYSTEM', tone: 'blue',
    items: [
      { action: 'power1', short: 'Powers', icon: 'lift', keyOverride: '1-5' },
      { action: 'camera', short: 'Camera', icon: 'camera' },
      { action: 'fullscreen', short: 'Full', icon: 'expand' },
      { action: 'pause', short: 'Pause', icon: 'pause' },
    ],
  },
];

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
  /* ---- combat ---- */
  gunHit: 25,
  weaponHit: 90,
  kill: 1400,
  killAssist: 300,
  manoeuvre: 260,             // a completed roll, loop or flip
  machHoldPerSec: 45,         // scored per second at Mach 22+
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
  unlocked: ['raptor', 'falcon'],
  selectedAircraft: 'raptor',
  selectedMode: 'battle',
  /** Highest story mission cleared. 0 means only mission 1 is available. */
  storyProgress: 0,
  selectedDifficulty: 'elite',
  selectedLocation: 'forest',
  /* `random` is not a weather state — it is the instruction to draw one from
   * the selected location's own pool at launch. It is the shipping default. */
  selectedWeather: 'sunset',
  campaignProgress: 0,
  achievements: [],
  dailyState: { date: null, completed: false, best: 0 },
  settings: {
    /* null means "never chosen". The opening preset is then resolved per device
       by DEFAULTS.graphicsFor() — Extreme on a landscape phone, Medium on a
       desktop. A stored string is an explicit choice and is never overridden. */
    graphics: null,
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
    guidance: true,
    reducedMotion: false,
    invertPitch: false,
    showDebug: false,
    hudScale: 1.0,
    /* Reference panels, both CLOSED out of the box on every device. The
     * control legend and the weapons/objective block are worth reading for the
     * first few runs and then permanently in front of the sky; each has its own
     * dial on the HUD, and this remembers what the pilot chose. */
    panelFlight: false,
    panelCombat: false,
    touchControls: true,
    cameraZoom: 1,
    bindings: null,
  },
  stats: {
    totalRuns: 0, totalDistance: 0, totalCheckpoints: 0, totalNearMisses: 0, totalOvertakes: 0,
    totalRings: 0, totalScore: 0, totalTime: 0, podiums: 0, wins: 0, legendaryWins: 0, crashes: 0,
    bestScore: 0, bestDistance: 0, bestSpeedKmh: 0, bestMach: 0, bestCombo: 0, bestCleanStreak: 0,
    bestSurvivalTime: 0, bestLapTime: 0, biomesVisited: {}, modeRuns: {},
    totalKills: 0, bestKills: 0, totalManoeuvres: 0,
  },
  records: {},
};

export const DEFAULTS = {
  mode: 'battle',
  difficulty: 'elite',
  /* Emerald Delta is the shipping venue: the widest corridors, the softest
   * terrain and the only weather pool with no state that takes the horizon
   * away, so a first launch shows the game at its most readable.
   *
   * These are the defaults for every mode that flies the menu loadout —
   * Battle, Endless, Endless Race, Quick, Survival, Time Attack, Free Flight.
   * Campaign chapters and Story missions carry their OWN venue and weather,
   * because a campaign where all nine chapters are the same place at the same
   * time of day is not a campaign. */
  location: 'forest',
  /* Sunset. Every venue can now fly it, so the default is honourable wherever
   * the player takes it, and it is the state that shows the world best: a low
   * sun rakes the terrain, throws long shadows off the structures, and lights
   * reheat plumes and tracer against a sky that is not flat blue. */
  weather: 'sunset',
  aircraft: 'raptor',
  /* ---- graphics ---------------------------------------------------------
   * The default quality is PLATFORM-DEPENDENT, so it is resolved rather than
   * fixed. A phone held in landscape is a deliberate, committed play session on
   * a panel with a high pixel density and a GPU that handles this scene well,
   * so it opens at EXTREME. Desktop opens at HIGH: the frame governor holds the
   * 60-120 FPS band by moving the ladder underneath the preset, so a desktop no
   * longer has to be defended against with a conservative default — if the
   * machine cannot hold High, the governor sheds detail rather than the player
   * having to. Portrait gets Extreme as well now: the game is landscape-only
   * and portrait shows a rotate prompt, so the preset chosen there is really
   * the one the first landscape frame will be drawn at. */
  graphics: 'high',
  graphicsMobileLandscape: 'extreme',
  graphicsMobilePortrait: 'extreme',
  graphicsDesktop: 'high',
  /**
   * Resolve the opening graphics preset for the device that is actually running
   * the game. Kept here beside the values it chooses between so there is one
   * place to reason about the policy.
   * @param {{mobile:boolean, landscape:boolean}} device
   * @returns {string} a key of GRAPHICS
   */
  graphicsFor({ mobile, landscape }) {
    if (!mobile) return this.graphicsDesktop;
    return landscape ? this.graphicsMobileLandscape : this.graphicsMobilePortrait;
  },
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
  'A and D bank the aircraft — that is how you turn. Q and E lean it sideways without changing heading.',
  'The chevrons ahead are the line. Green means you are on it; red means you are outside the corridor.',
  'You turn harder slow than fast. Braking into a tight gate chain is genuinely quicker than powering through.',
  'Power Flight (NUM 1) cancels gravity and the energy cost of turning. Use it to save a line, not to go faster.',
  'Combat Maneuvers (NUM 3) doubles your control authority for five seconds. Worth saving for a gate you cannot make.',
  'Aerial Shield (NUM 4) before a debris field is worth more than boosting through it.',
  'Boost rings top the meter back up. Chain them through the long sweepers.',
  'Near misses feed the combo multiplier. Risk pays, right up until it does not.',
  'Cutting a checkpoint dead-centre awards a precision bonus.',
  'C cycles the camera. First person is the fastest view once you trust the chevrons.',
  'High-risk shortcuts are always narrower than they look. Commit early or not at all.',
  'Damage does not regenerate mid-run. Trade paint sparingly.',
];
