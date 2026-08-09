/**
 * ALPHA AIRCRAFT RACE 3D — game.js
 * ---------------------------------------------------------------------------
 * Game state, the six modes, objectives, scoring, progression, the daily
 * challenge, the save system and the frame loop that drives every other
 * subsystem.
 */

import * as THREE from 'three';
import {
  AIRCRAFT, AIRCRAFT_BY_ID, BIOMES, BIOMES_BY_ID, MODES, DIFFICULTIES, WEATHER, TIME_OF_DAY,
  CAMPAIGN, OBJECTIVE_POOL, ACHIEVEMENTS, SCORE, CREDITS, POWERS, WORLD,
  DEFAULT_SAVE, STORAGE_KEY, LOADING_STAGES, DEFAULTS, MACH, COMBAT, WEAPONS_BY_ID,
  HEAVY_ORDER, GUN_ORDER, DEFAULT_BINDINGS,
  RNG, hashSeed, clamp, clamp01, lerp, damp, TAU,
} from './config.js';
import { DeviceProfile, PerfMonitor, AdaptiveQuality, Scheduler, LoadPipeline, nextFrame } from './performance.js';
import { RenderSystem, CAM_ZOOM_MIN, CAM_ZOOM_MAX, CAM_ZOOM_STEP } from './renderer.js';
import { World } from './world.js';
import { Player, InputManager } from './player.js';
import { RaceDirector } from './ai.js';
import { CombatSystem } from './combat.js';
import { AudioSystem } from './audio.js';
import { UI, formatTime, formatDistance } from './ui.js';

/** How the collision warning names what is about to be hit. */
const HAZARD_LABEL = {
  building: 'BUILDING', mast: 'MAST', rock: 'ROCK', terrain: 'TERRAIN',
  landmark: 'STRUCTURE', structure: 'STRUCTURE', obstacle: 'OBSTACLE',
  slab: 'SLAB', pylon: 'PYLON', container: 'CONTAINER', rotor: 'ROTOR',
  barrier: 'BARRIER', debris: 'DEBRIS', island: 'ISLAND', turbine: 'TURBINE',
  spire: 'SPIRE',
};

/** Which binding arms each heavy weapon, for the HUD rack. */
const HEAVY_KEY_ACTION = {
  missile: 'weaponMissile', laser: 'weaponLaser',
  grenade: 'weaponGrenade', rpg: 'weaponRpg',
};
/** Compact key cap for the HUD (the settings screen has its own prettifier). */
const prettyKeyCap = (code) => (code || '—')
  .replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'N')
  .replace(/^Arrow/, '').toUpperCase();

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _upVec = new THREE.Vector3(0, 1, 0);
const _m4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _screen = { x: 0, y: 0, visible: false, behind: false, dist: 0 };

/* ===========================================================================
 * SAVE
 * ======================================================================== */

export class SaveManager {
  constructor() { this.data = this.load(); }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_SAVE);
      const parsed = JSON.parse(raw);
      // Deep-merge so a save written by an older build keeps working.
      const merged = structuredClone(DEFAULT_SAVE);
      const merge = (dst, src) => {
        for (const [k, v] of Object.entries(src || {})) {
          if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') merge(dst[k], v);
          else if (v !== undefined) dst[k] = v;
        }
      };
      merge(merged, parsed);
      return merged;
    } catch (e) {
      console.warn('[Save] unreadable, starting fresh:', e.message);
      return structuredClone(DEFAULT_SAVE);
    }
  }

  persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); }
    catch (e) { console.warn('[Save] could not persist:', e.message); }
  }

  set(key, value) { this.data[key] = value; this.persist(); }
  setSetting(key, value) { this.data.settings[key] = value; this.persist(); }
  addCredits(n) { this.data.credits = Math.max(0, Math.round(this.data.credits + n)); this.persist(); }
  reset() { this.data = structuredClone(DEFAULT_SAVE); this.persist(); }
}

/* ===========================================================================
 * OBJECTIVES
 * ======================================================================== */

function rollObjectives(rng, mode, difficulty, count = 3) {
  const pool = OBJECTIVE_POOL.filter((o) => o.modes.includes(mode.id));
  const picked = [];
  const used = new Set();
  const tier = clamp(Math.round(difficulty.order * 0.8), 0, 3);

  // Some modes have objectives that are not optional. Endless Race is scored
  // on aerobatics as much as on speed, so the manoeuvre set is always dealt
  // first rather than left to the draw.
  for (const id of mode.mandatory || []) {
    const def = pool.find((o) => o.id === id);
    if (!def || used.has(id)) continue;
    used.add(id);
    const value = def.values[Math.min(def.values.length - 1, tier)] ?? def.values[0];
    picked.push({
      id, def, value, text: def.text(value), mandatory: true,
      metric: def.metric, complete: false, reward: def.reward,
    });
  }

  for (let i = picked.length; i < count && pool.length; i++) {
    let def = null, guard = 0;
    do { def = rng.pick(pool); } while (used.has(def.id) && guard++ < 24);
    if (used.has(def.id)) break;
    used.add(def.id);
    const values = def.values;
    const value = values[Math.min(values.length - 1, tier + (i === 0 ? 0 : i === 1 ? 1 : 0))] ?? values[0];
    picked.push({
      id: def.id, def, value, text: def.text(value),
      metric: def.metric, complete: false, reward: def.reward,
    });
  }
  return picked;
}

function objectiveProgress(obj, metrics) {
  if (obj.metric === 'positionInv') {
    return metrics.position <= obj.value ? 1 : 0;
  }
  const v = metrics[obj.metric] || 0;
  return clamp01(v / obj.value);
}

/* ===========================================================================
 * DAILY CHALLENGE
 * ======================================================================== */

const DAILY_MODIFIERS = [
  { id: 'noshield', name: 'NO SHIELD', apply: (g) => { g.blockedPowers.add('shield'); } },
  { id: 'nomaneuver', name: 'NO COMBAT TRIM', apply: (g) => { g.blockedPowers.add('maneuver'); } },
  { id: 'halfboost', name: 'HALF BOOST', apply: (g) => { g.player.boostCapacity *= 0.5; g.player.boostMeter *= 0.5; } },
  { id: 'traffic', name: 'HEAVY TRAFFIC', apply: (g) => { g.director?.traffic.setDensity(2.2); } },
  { id: 'glass', name: 'GLASS HULL', apply: (g) => { g.player.maxHealth *= 0.5; g.player.health = g.player.maxHealth; } },
  { id: 'nopowers', name: 'NO POWERS', apply: (g) => { for (const p of POWERS) g.blockedPowers.add(p.id); } },
  { id: 'turbo', name: 'PERMANENT OVERDRIVE', apply: (g) => { g.player.topSpeed *= 1.15; g.player.accelPower *= 1.2; } },
];

export function getDailyChallenge() {
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const rng = new RNG(`alpha-daily-${dateKey}`);
  const biome = rng.pick(BIOMES);
  const weather = rng.pick(biome.weather);
  const mode = rng.pick(['endless', 'survival', 'timeattack']);
  const difficulty = rng.pick(['elite', 'master', 'legendary']);
  const modifier = rng.pick(DAILY_MODIFIERS);
  const modeDef = MODES[mode];
  const objPool = OBJECTIVE_POOL.filter((o) => o.modes.includes(mode) && o.metric !== 'positionInv');
  const def = rng.pick(objPool);
  const value = def.values[rng.int(1, 3)];
  return {
    dateKey, seed: hashSeed(`alpha-daily-${dateKey}`),
    biome, weather, mode, difficulty, modifier, modeDef,
    objective: { id: def.id, def, value, label: def.text(value), metric: def.metric },
    scoreMultiplier: 2 + (DIFFICULTIES[difficulty].order - 2) * 0.5,
  };
}

/* ===========================================================================
 * GAME
 * ======================================================================== */

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = 'boot';           // boot|menu|loading|countdown|racing|paused|results
    this.device = new DeviceProfile();
    this.perf = new PerfMonitor();
    this.save = new SaveManager();
    this.audio = new AudioSystem();
    this.scheduler = new Scheduler(5.0);

    const presetName = this.save.data.settings.graphics || this.device.suggestedPreset || DEFAULTS.graphics;
    this.quality = new AdaptiveQuality(this.perf, presetName);
    this.quality.applyOverrides(this.save.data.settings);

    this.input = new InputManager(this.save.data.settings.bindings);
    this.ui = new UI({ audio: this.audio, save: this.save, input: this.input, device: this.device });

    this.render = null;
    this.world = null;
    this.player = null;
    this.director = null;

    this.elapsed = 0;
    this.runTime = 0;
    this.blockedPowers = new Set();
    this.metrics = this._blankMetrics();
    this.objectives = [];
    this.objectiveIndex = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.comboSteps = 0;
    this.score = 0;
    this.escalation = 0;
    this.timeRemaining = 0;
    this.countdownValue = 0;
    this.lapCount = 0;
    this.targetCheckpoints = 0;
    this.finished = false;
    this.runConfig = null;
    this.pendingDaily = null;
    this.pendingCampaign = null;
    this.freezeTimer = 0;
    this.lastAutoSave = 0;
    this._radarBuf = { path: [], cps: [], rivals: [], traffic: [], obstacles: [] };
    this._accum = 0;
    this._rafId = 0;
    this._lastNotify = 0;
    this.paused = false;

    this._wireUI();
    this._wireWindow();
  }

  _blankMetrics() {
    return {
      distance: 0, checkpoints: 0, rings: 0, nearMisses: 0, overtakes: 0,
      topSpeedKmh: 0, topMach: 0, time: 0, maxCombo: 1, cleanStreak: 0, powerUses: 0,
      shortcuts: 0, highAltTime: 0, lowAltTime: 0, position: 1, collisions: 0,
      missedCheckpoints: 0, perfectCheckpoints: 0, boostTime: 0,
      // Combat + manoeuvre metrics, used by Battle and Race modes.
      kills: 0, hits: 0, shotsFired: 0, missiles: 0, damageTaken: 0,
      manoeuvres: 0, rolls: 0, loops: 0, flips: 0, turns: 0, machTime: 0,
    };
  }

  /* =====================================================================
   * BOOT
   * ================================================================== */
  async boot() {
    const ui = this.ui;
    ui.showScreen('loading');

    const pipeline = new LoadPipeline((p, stage) => ui.setLoadProgress(p, stage));

    pipeline.stage(LOADING_STAGES[0], 1, async () => {
      this.render = new RenderSystem(this.canvas, this.quality, this.device);
      this.render.rig.reducedMotion = !!this.save.data.settings.reducedMotion;
      window.addEventListener('resize', () => this.handleResize());
      this.handleResize();
    });

    pipeline.stage('Generating textures', 2, async () => {
      // Warm the procedural texture cache so the first race never stutters.
      const t = this.render.textures;
      t.glow(128, 0.22); t.streak(); t.cloudPuff(256, 11); t.hexEnergy();
      t.terrainDetail(); t.rippleNormal(); t.facade(3, true); t.facade(3, false);
      await nextFrame();
    });

    // Models first: an airframe with a GLB must not be built procedurally and
    // then thrown away a stage later.
    pipeline.stage('Loading aircraft models', 3, async (report) => {
      await this._loadAssetManifest(report);
    });

    pipeline.stage('Assembling airframes', 3, async () => {
      // Build every airframe template up front — a few ms each now beats a
      // hitch when a rival first comes into view.
      for (const id of Object.keys(AIRCRAFT_BY_ID)) {
        this.render.aircraftFactory.template(AIRCRAFT_BY_ID[id], 1);
        await nextFrame();
      }
      this.render.aircraftFactory.template(AIRCRAFT_BY_ID[this.save.data.selectedAircraft], 2);
    });

    pipeline.stage('Preparing menu venue', 3, async (report) => {
      await this._buildMenuVenue(report);
    });

    pipeline.stage('Ready', 1, async () => {
      this.audio.applySettings(this.save.data.settings);
      await nextFrame();
    });

    const seconds = await pipeline.run();
    console.info(`[Boot] ready in ${seconds.toFixed(2)}s · ${this.device.describe()} · preset ${this.quality.presetName}`);
    this.bootSeconds = seconds;

    this.start();
    if (!this.save.data.onboarded) this.ui.showScreen('onboarding');
    else this.enterMenu();
  }

  /**
   * Real modelled airframes from /Assets/3d/aircraft/ (declared on the aircraft
   * spec) plus anything the Tripo3D pipeline has written into
   * /Assets/3d/manifest.json. Every one of them is optional: a model that fails
   * to load leaves that airframe on its procedural hull, which still flies and
   * still races, so a bad asset can never stop the game booting.
   */
  async _loadAssetManifest(report) {
    this.generatedAssets = { count: 0, entries: [] };
    let loader = null;
    const getLoader = async () => {
      if (loader) return loader;
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      loader = new GLTFLoader();
      try {
        const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
        const draco = new DRACOLoader();
        draco.setDecoderPath('vendor/three/addons/libs/draco/gltf/');
        loader.setDRACOLoader(draco);
      } catch (e) { /* Draco optional */ }
      return loader;
    };

    /* ---- modelled fighter jets shipped with the game ------------------- */
    const modelled = AIRCRAFT.filter((a) => a.model?.file);
    if (modelled.length) {
      const gl = await getLoader();
      let done = 0;
      for (const spec of modelled) {
        try {
          const gltf = await gl.loadAsync(spec.model.file);
          this.render.aircraftFactory.registerExternal(spec.id, gltf.scene, 0);
          // The reduced mesh is what rivals and distant traffic use. It is an
          // optimisation, not a requirement — fall back to the hero mesh.
          if (spec.model.lod1) {
            try {
              const lod = await gl.loadAsync(spec.model.lod1);
              this.render.aircraftFactory.registerExternal(spec.id, lod.scene, 1);
            } catch (e) { /* hero mesh covers every detail level */ }
          }
          this.generatedAssets.entries.push(spec.id);
          this.generatedAssets.count++;
        } catch (err) {
          console.warn(`[Assets] aircraft "${spec.id}" failed to load, using procedural airframe:`, err.message);
        }
        report?.(++done / (modelled.length + 1));
        await nextFrame();
      }
    }

    /* ---- optional Tripo3D output -------------------------------------- */
    try {
      const res = await fetch('Assets/3d/manifest.json', { cache: 'no-cache' });
      if (!res.ok) return;
      const manifest = await res.json();
      const entries = (manifest.assets || []).filter(
        (a) => a.status === 'ready' && a.file && a.priority === 'critical'
          && !this.generatedAssets.entries.includes(a.id),
      );
      if (!entries.length) return;
      const gl = await getLoader();
      for (const entry of entries) {
        try {
          const gltf = await gl.loadAsync(entry.file);
          this.render.aircraftFactory.registerExternal(entry.id, gltf.scene, 0);
          this.generatedAssets.entries.push(entry.id);
          this.generatedAssets.count++;
        } catch (err) {
          console.warn(`[Assets] "${entry.id}" failed to load, using procedural fallback:`, err.message);
        }
      }
    } catch (e) {
      // No manifest is the normal case — say nothing and use procedural assets.
    }
  }

  /* =====================================================================
   * VENUE / WORLD SETUP
   * ================================================================== */
  pickVenue(rng, locationId, weatherId = null, timeId = null) {
    const biome = locationId && locationId !== 'random'
      ? (BIOMES_BY_ID[locationId] || rng.pick(BIOMES))
      : rng.pick(BIOMES);
    const weather = weatherId || rng.pick(biome.weather);
    const w = WEATHER[weather];
    const time = timeId || w.time || rng.pick(biome.times);
    return { biome, weather, time };
  }

  async _prepareWorld(cfg, report = () => {}) {
    if (this.world) { this.world.dispose(); this.world = null; }
    this.scheduler.clear();

    this.render.setVenue(cfg.biome, cfg.weather, cfg.time);
    report(0.15);
    await nextFrame();

    this.world = new World(this.render, this.quality, {
      seed: cfg.seed,
      biome: cfg.biome,
      weather: cfg.weather,
      time: cfg.time,
      difficulty: cfg.difficulty,
      mode: cfg.mode,
    });
    this.world.onEvent = (ev) => this._onWorldEvent(ev);
    this.world.onLightning = () => {
      this.audio.play('thunder', { delay: 0.35 + Math.random() * 1.6, volume: 0.8 });
      this.render.postfx.flash(0.20, 0xdce9ff);
    };
    report(0.4);

    // Grow enough route and stream the opening chunks before the race starts.
    this.world.path.ensure(30000);
    report(0.55);
    await nextFrame();

    this.world.stream(this.scheduler, 0);
    let guard = 0;
    while (this.scheduler.pending && guard++ < 400) {
      this.scheduler.run(9);
      report(0.55 + 0.4 * (1 - this.scheduler.pending / Math.max(1, WORLD.streamAhead + 2)));
      if (guard % 3 === 0) await nextFrame();
    }
    this.world.terrainMesh.update(this.world.path.nodes[0].pos, 64);
    report(1);
  }

  async _buildMenuVenue(report = () => {}) {
    const rng = new RNG(Date.now() & 0xffffff);
    const v = this.pickVenue(rng, this.save.data.selectedLocation);
    this.menuVenue = v;
    this.ui.setLoadVenue(`${v.biome.name} · ${WEATHER[v.weather].name}`);
    await this._prepareWorld({
      ...v, seed: rng.int(0, 1e9),
      difficulty: DIFFICULTIES.elite, mode: MODES.free,
    }, report);

    // A showcase aircraft flies the route while the menu is up.
    const spec = AIRCRAFT_BY_ID[this.save.data.selectedAircraft];
    this.player = new Player(this.render, this.world, spec, this.save.data.settings);
    this.player.placeOnPath(600);
    this.menuFlight = { distance: 600, lateral: 0, vertical: 0, t: 0 };
  }

  /* =====================================================================
   * MENU
   * ================================================================== */
  enterMenu() {
    this.state = 'menu';
    this.finished = false;
    this.ui.setHudVisible(false);
    this.render.guide.setEnabled(false);
    this.ui.showScreen('menu');
    this.ui.refreshLoadout();
    this.render.rig.setMode('chase');
    if (this.combat) { this.combat.dispose(); this.combat = null; }
    this.ui.clearCombatHud();
    this.audio.setMenuMusic();
    this.audio.stopEngine();
    if (this.director) { this.director.dispose(); this.director = null; }
  }

  /** Swap the aircraft on show behind the menu (hangar preview). */
  setShowcaseAircraft(id) {
    const spec = AIRCRAFT_BY_ID[id];
    if (!spec || !this.player || this.player.spec === spec) return;
    this.render.aircraftFactory.template(spec, 2);
    this.player.reset(spec, this.menuFlight?.distance ?? 600);
  }

  setHangarMode(active) {
    this.hangarMode = !!active;
    if (active && this.hangarSpin === undefined) { this.hangarSpin = -0.9; this.hangarSpinVel = 0; }
  }

  spinHangar(delta) {
    this.hangarSpinVel = clamp((this.hangarSpinVel || 0) + delta * 6, -9, 9);
  }

  _updateMenu(dt) {
    if (!this.player || !this.world) return;
    // Fly the showcase aircraft along the route on autopilot.
    const m = this.menuFlight;
    m.t += dt;
    m.distance += 210 * dt;
    const s = this.world.path.sample(m.distance, {});
    const lat = Math.sin(m.t * 0.24) * s.radius * 0.35;
    const vert = Math.cos(m.t * 0.19) * s.radius * 0.18;
    // Hangar inspection climbs clear of the route so gates, rings, obstacles
    // and cloud puffs cannot crowd the aircraft you are trying to look at.
    m.lift = damp(m.lift || 0, this.hangarMode ? 1100 : 0, 1.4, dt);
    const prev = _v.copy(this.player.position);
    this.player.position.copy(s.pos)
      .addScaledVector(s.right, lat)
      .addScaledVector(s.up, vert + m.lift);
    // Cinematic mode banks with the flight path; hangar mode holds a level,
    // slightly nose-up presentation attitude so the airframe reads cleanly.
    _v2.subVectors(this.player.position, prev);
    const heading = this.hangarMode
      ? _v2.copy(s.tangent).setY(0.05).normalize()
      : (_v2.lengthSq() > 0.01 ? _v2.normalize() : null);
    if (heading) {
      _m4.lookAt(heading, _zero, this.hangarMode ? _upVec : s.up);
      _quat.setFromRotationMatrix(_m4);
      this.player.quaternion.slerp(_quat, clamp01(dt * (this.hangarMode ? 2.5 : 4)));
    }
    this.player.speed = 210;
    this.player.visual.update(dt, {
      position: this.player.position, quaternion: this.player.quaternion,
      throttle: 0.75, boost: 0.15, speed01: 0.45,
      pitch: 0, roll: Math.sin(m.t * 0.24) * -0.4, yaw: 0, alive: true,
      gLoad: 1.2, altitude: this.player.position.y, damage01: 0,
    });

    const cam = this.render.camera;
    if (this.hangarMode) {
      // Hangar inspection: close orbit the player can drag, still flying so the
      // reheat, trails and environment stay live behind it.
      this.hangarSpinVel = damp(this.hangarSpinVel || 0, 0, 2.6, dt);
      this.hangarSpin = (this.hangarSpin || 0) + (this.hangarSpinVel + 0.22) * dt;
      const r = this.player.visual.length * 2.25;
      // Orbit in the aircraft's own frame, not world space, so the presentation
      // angle stays constant as the route beneath it turns.
      const q = this.player.quaternion;
      const fwd = _v.set(0, 0, -1).applyQuaternion(q);
      const rgt = _v2.set(1, 0, 0).applyQuaternion(q);
      cam.position.copy(this.player.position)
        .addScaledVector(fwd, -Math.cos(this.hangarSpin) * r)
        .addScaledVector(rgt, Math.sin(this.hangarSpin) * r)
        .addScaledVector(_upVec, r * 0.24 + Math.sin(m.t * 0.4) * 0.8);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.player.position);
      // A long lens keeps the airframe's proportions honest.
      if (cam.fov !== 34) { cam.fov = 34; cam.updateProjectionMatrix(); }
    } else {
      if (cam.fov !== 66) { cam.fov = 66; cam.updateProjectionMatrix(); }
      // Slow cinematic orbit around the showcase aircraft.
      const a = m.t * 0.16;
      const dist = 46 + Math.sin(m.t * 0.11) * 10;
      cam.position.copy(this.player.position)
        .add(_v.set(Math.cos(a) * dist, 9 + Math.sin(m.t * 0.23) * 4, Math.sin(a) * dist));
      cam.up.set(0, 1, 0);
      cam.lookAt(this.player.position);
    }

    this.world.update(dt, this.player.position, this.elapsed);
    this.world.stream(this.scheduler, m.distance);
    this.audio.setEnvironment(WEATHER[this.world.weatherId], 0.3, this.world.biome.ceiling ? 1 : 0);
  }

  /* =====================================================================
   * RUN LIFECYCLE
   * ================================================================== */
  async launchRun(overrides = {}) {
    // Loading is asynchronous and yields frames. If a second launch starts
    // while the first is still building (restart spam, or a scripted call),
    // the older one must abandon rather than finish and re-enter 'racing'
    // against a world the newer launch has already torn down.
    const token = (this._launchToken = (this._launchToken || 0) + 1);
    const superseded = () => token !== this._launchToken;
    const s = this.save.data;
    const modeId = overrides.mode || s.selectedMode || DEFAULTS.mode;
    const diffId = overrides.difficulty || s.selectedDifficulty || DEFAULTS.difficulty;
    const locId = overrides.location || s.selectedLocation || DEFAULTS.location;
    const craftId = overrides.aircraft || s.selectedAircraft || DEFAULTS.aircraft;
    const seed = overrides.seed ?? ((Math.random() * 1e9) | 0);

    const rng = new RNG(seed);
    const venue = this.pickVenue(rng, locId, overrides.weather, overrides.time);
    const mode = MODES[modeId] || MODES.endless;
    const difficulty = DIFFICULTIES[diffId] || DIFFICULTIES.elite;
    const spec = AIRCRAFT_BY_ID[craftId] || AIRCRAFT_BY_ID.vector;

    this.runConfig = {
      ...venue, seed, mode, difficulty, spec, rng,
      daily: overrides.daily || null,
      campaign: overrides.campaign || null,
      laps: overrides.laps || mode.laps || 1,
    };

    this.state = 'loading';
    this.ui.setHudVisible(false);
    this.ui.showScreen('loading');
    this.ui.setTip();
    this.ui.setLoadVenue(`${venue.biome.name} · ${WEATHER[venue.weather].name} · ${TIME_OF_DAY[venue.time].name}`);
    this.ui.setLoadProgress(0, LOADING_STAGES[1]);
    await nextFrame();

    const pipe = new LoadPipeline((p, stage) => { if (!superseded()) this.ui.setLoadProgress(p, stage); });
    pipe.stage(LOADING_STAGES[1], 5, async (report) => {
      if (superseded()) return;
      await this._prepareWorld(this.runConfig, report);
    });
    pipe.stage(LOADING_STAGES[5], 2, async () => {
      if (superseded()) return;
      this.render.aircraftFactory.template(spec, 2);
      if (this.player) { this.player.dispose(); this.player = null; }
      this.player = new Player(this.render, this.world, spec, this.save.data.settings);
      this.player.reset(spec, 300);
      await nextFrame();
    });
    pipe.stage(LOADING_STAGES[6], 2, async () => {
      if (superseded()) return;
      if (this.director) this.director.dispose();
      this.director = new RaceDirector(this.render, this.world, this.quality, difficulty, {
        rivals: mode.hasRivals,
      });
      // Grid forms around the player's start distance, not ahead of it.
      if (mode.hasRivals) this.director.createGrid(spec, difficulty.aiCount, 300);
      // Hostiles fly the same three airframes the player can, in other liveries.
      if (this.combat) { this.combat.dispose(); this.combat = null; }
      if (mode.combat) {
        this.combat = new CombatSystem(this.render, this.world, this.audio, difficulty,
          { speedFocus: !!mode.speedFocus });
        this._enemySpecs = AIRCRAFT.filter((a) => a.model);
        this.combat.spawnWave(300, this._enemySpecs);
      }
      await nextFrame();
    });
    pipe.stage(LOADING_STAGES[8], 1, async () => {
      if (superseded()) return;
      this._beginRun();
      await nextFrame();
    });
    pipe.stage(LOADING_STAGES[10], 1, async () => {
      if (superseded()) return;
      // Compile shaders before the first visible frame so nothing hitches.
      try { this.render.renderer.compile(this.render.scene, this.render.camera); } catch (e) { /* noop */ }
      await nextFrame();
    });

    await pipe.run();
    if (superseded()) return;
    this.ui.showScreen('none');
    this.ui.setHudVisible(true);
    // Battle mode has no route to follow, so the corridor chevrons would be
    // pointing at nothing; the racing variant still wants them.
    this.render.guide.setEnabled(this.save.data.settings.guidance !== false && !mode.noRings);
    this.ui.buildControlLegend(!!mode.combat);
    this.ui.setModeBrief(mode);
    if (!mode.combat) this.ui.clearCombatHud();
    this.ui.setCamera(this.render.rig.mode.name);
    this._startCountdown();
  }

  _beginRun() {
    const cfg = this.runConfig;
    this.metrics = this._blankMetrics();
    this.objectives = cfg.daily
      ? [{ ...cfg.daily.objective, def: cfg.daily.objective.def, complete: false, reward: 2, text: cfg.daily.objective.label }]
      : rollObjectives(cfg.rng, cfg.mode, cfg.difficulty, cfg.mode.combat ? 4 : 3);
    this.objectiveIndex = 0;
    this.score = 0;
    this.combo = 1;
    this.comboSteps = 0;
    this.comboTimer = 0;
    this.runTime = 0;
    this.escalation = 0;
    this.lapCount = 0;
    this.finished = false;
    this.penalty = 0;
    this.bestLap = 0;
    this.lapStart = 0;
    this.blockedPowers.clear();
    this.freezeTimer = 0;
    this.scoreMultiplier = cfg.daily ? cfg.daily.scoreMultiplier : 1;

    // Mode-specific setup.
    const m = cfg.mode;
    this.timeRemaining = m.hasTimer ? m.startTime : 0;
    this.targetCheckpoints = (m.hasLaps ? cfg.laps : 0) * 18;

    if (cfg.daily) cfg.daily.modifier.apply(this);

    this.player.settings = this.save.data.settings;
    this.player.powers.cooldownScale = this.player.ability === 'tuning' ? 0.85 : 1;
    this.render.rig.setMode('chase');
    this.render.rig.reducedMotion = !!this.save.data.settings.reducedMotion;
    this.render.rig.setUserZoom(this.save.data.settings.cameraZoom ?? 1);
    this.ui.setZoom(this.render.rig.zoomPercent, CAM_ZOOM_MIN * 100, CAM_ZOOM_MAX * 100);
    this.render.rig.reset();

    this.audio.igniteEngine();
    this.audio.setMusic(
      cfg.campaign?.boss ? 'boss' : (m.id === 'survival' ? 'survival' : m.id === 'timeattack' ? 'timeattack' : m.id === 'free' ? 'free' : 'race'),
      0.4,
    );

    const st = this.save.data.stats;
    st.biomesVisited[cfg.biome.id] = (st.biomesVisited[cfg.biome.id] || 0) + 1;
    st.modeRuns[m.id] = (st.modeRuns[m.id] || 0) + 1;
    this.save.persist();
  }

  _startCountdown() {
    const m = this.runConfig.mode;
    if (m.id === 'free') { this.state = 'racing'; this.ui.banner('FREE FLIGHT', this.runConfig.biome.name); return; }
    this.state = 'countdown';
    this.countdownValue = 3.99;
    const cfg = this.runConfig;
    this.ui.banner(cfg.biome.name,
      `${WEATHER[cfg.weather].name} · ${TIME_OF_DAY[cfg.time].name} · ${cfg.difficulty.name}`);
  }

  _updateCountdown(dt) {
    if (!this.world || !this.player) return;
    const prev = Math.ceil(this.countdownValue);
    this.countdownValue -= dt;
    const now = Math.ceil(this.countdownValue);
    if (now !== prev) {
      if (now === 3) { this.ui.countdown('3'); this.audio.play('countdown'); }
      else if (now === 2) { this.ui.countdown('2'); this.audio.play('countdown'); }
      else if (now === 1) { this.ui.countdown('1'); this.audio.play('countdown'); }
      else if (now <= 0) {
        this.ui.countdown('GO', true);
        this.audio.play('go');
        this.state = 'racing';
        this.lapStart = 0;
      }
    }
    // The world keeps living during the countdown; the player is held.
    this.world.update(dt, this.player.position, this.elapsed);
    this.player.visual.update(dt, {
      position: this.player.position, quaternion: this.player.quaternion,
      throttle: 0.5 + Math.sin(this.elapsed * 9) * 0.3, boost: 0, speed01: 0.1,
      pitch: 0, roll: 0, yaw: 0, alive: true, gLoad: 1, altitude: this.player.position.y, damage01: 0,
    });
    this.render.rig.update(dt, { position: this.player.position, quaternion: this.player.quaternion }, {
      speed01: 0, boost: 0, turbulence: 0,
    });
  }

  /* =====================================================================
   * RACE TICK
   * ================================================================== */
  _updateRace(dt) {
    const cfg = this.runConfig;
    const player = this.player;
    const world = this.world;
    // Backstop: a torn-down world must never reach the simulation.
    if (!cfg || !player || !world) return;
    this.runTime += dt;
    this.metrics.time = this.runTime;

    /* --- escalation ------------------------------------------------- */
    if (cfg.mode.escalates) {
      const rate = cfg.mode.id === 'survival' ? 1 / 45 : 1 / 75;
      this.escalation = this.runTime * rate;
      this.director?.traffic.setDensity(1 + Math.min(1.6, this.escalation * 0.35));
    }

    /* --- input -------------------------------------------------------- */
    this.input.sensitivity = this.save.data.settings.flightSensitivity ?? 1;
    this.input.invertPitch = !!this.save.data.settings.invertPitch;
    const raw = this.input.sample();
    // Kept for the combat pass, which runs after the flight model.
    this._rawInput = raw;
    // Blocked powers (daily modifiers) are filtered before the player sees them.
    if (this.blockedPowers.size) {
      for (let i = 0; i < 5; i++) if (raw.powers[i] && this.blockedPowers.has(POWERS[i].id)) {
        raw.powers[i] = false;
        this.audio.play('powerBlocked');
        this.ui.notify('POWER LOCKED', 'bad');
      }
    }

    /* --- simulation ---------------------------------------------------- */
    player.update(dt, raw, world, cfg.difficulty);
    // Combat Maneuvers reads as the world slowing down around you.
    const timeScale = player.maneuverActive ? 0.42 : 1;
    if (this.director) this.director.update(dt, player, timeScale);
    world.update(dt * timeScale, player.position, this.elapsed);
    world.stream(this.scheduler, player.distanceAlong);

    /* --- hazards -------------------------------------------------------- */
    this._updateHazard(dt, player, world);
    if (this._updateOverheat(dt, player)) return;

    /* --- combat --------------------------------------------------------- */
    if (this.combat) this._updateCombat(dt, player, cfg);

    /* --- events -------------------------------------------------------- */
    this._processEvents(player.drainEvents(), dt);
    if (this.director) this._processEvents(this.director.drainEvents(), dt);
    if (this.combat) this._processCombatEvents(this.combat.drainEvents());

    /* --- combo --------------------------------------------------------- */
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) { this.combo = 1; this.comboSteps = 0; }
    }

    /* --- passive scoring ------------------------------------------------ */
    this.metrics.distance = player.distanceTravelled;
    this.metrics.topSpeedKmh = Math.max(this.metrics.topSpeedKmh, player.speedKmh);
    this.metrics.topMach = Math.max(this.metrics.topMach, player.mach);
    if (player.speed > player.topSpeed * 0.9) this.score += SCORE.speedBonusPerSec * dt * this.combo;
    if (player.boosting) this.metrics.boostTime += dt;
    if (player.altitude > 3000) this.metrics.highAltTime += dt;
    if (player.agl < 250) this.metrics.lowAltTime += dt;
    this._distanceScoreAcc = (this._distanceScoreAcc || 0) + player.speed * dt;
    while (this._distanceScoreAcc > 1000) {
      this._distanceScoreAcc -= 1000;
      this.score += SCORE.distancePerKm * this.combo;
    }

    /* --- timers --------------------------------------------------------- */
    if (cfg.mode.hasTimer) {
      this.timeRemaining -= dt;
      if (this.timeRemaining <= 0) { this.endRun('TIME EXPIRED', false); return; }
    }

    /* --- objectives ------------------------------------------------------ */
    this.metrics.position = this.director?.playerPosition ?? 1;
    for (const o of this.objectives) {
      if (o.complete) continue;
      if (objectiveProgress(o, this.metrics) >= 1) {
        o.complete = true;
        this.score += 1200 * o.reward * this.combo;
        this.audio.play('objective');
        this.ui.notify('OBJECTIVE COMPLETE', 'good');
        this.ui.banner('OBJECTIVE COMPLETE', o.text);
      }
    }

    /* --- failure conditions ---------------------------------------------- */
    if (!player.alive) {
      if (cfg.mode.failOnDamage === false) {
        // Free Flight has no failure state — put the aircraft back in the air.
        this._respawnTimer = (this._respawnTimer || 0) + dt;
        if (this._respawnTimer > 1.1) {
          this._respawnTimer = 0;
          player.reset(null, Math.max(0, player.distanceAlong - 400));
          player.visual.setVisible(true);
          this.ui.notify('AIRFRAME RESTORED', 'good');
        }
      } else {
        // Straight to the results screen — the crash has already played.
        this.endRun('AIRCRAFT DESTROYED', false);
        return;
      }
    }
    if (cfg.mode.hasLaps && this.metrics.checkpoints >= this.targetCheckpoints && !this.finished) {
      this.finished = true;
      this.endRun('RACE COMPLETE', true);
      return;
    }
    if (cfg.mode.combat && this._checkCombatFailure(dt, player, cfg)) return;

    /* --- camera + audio --------------------------------------------------- */
    // Guidance chevrons down the corridor ahead.
    this.render.guide.update(dt, world.path, player.distanceAlong, player.corridorOut);
    this.render.rig.sensitivity = this.save.data.settings.cameraSensitivity ?? 1;
    // First person means exactly that: the airframe is not drawn.
    player.visual.setAirframeVisible(!this.render.rig.hidesAircraft);
    // Pushed every frame rather than only on the key, so the chip is right
    // however the camera changed — key, touch button or code.
    this.ui.setCamera(this.render.rig.mode.name);
    this.render.rig.update(dt, player, {
      speed01: player.speed01,
      boost: player.boostBlend,
      turbulence: world.turbulence,
      lateral: clamp(player.smoothControls.roll, -1, 1),
      pitchRate: player.smoothControls.pitch,
      machZoom: player.mach01,
      lagScale: 1 / clamp(this.save.data.settings.cameraSensitivity ?? 1, 0.5, 1.8),
    });

    // Reheat has an audible light and an audible cut: the burner lighting is a
    // fire-and-gear event, not just a volume change.
    const burnerOn = player.boosting || player.turboActive;
    if (burnerOn !== this._burnerWas) {
      if (burnerOn) {
        this.audio.play('boost', { volume: 0.85 });
        this.audio.play('burnerLight', { volume: 1.0 });   // ignition fire
        this.audio.play('gearShift', { volume: 0.95 });    // jet gear change
      } else this.audio.play('boostOut', { volume: 0.9 });
      this._burnerWas = burnerOn;
    }
    if (player.mach > 16) this.audio.play('sonicBoom', { volume: 0.7 });
    if (player.aoa01 > 0.97 && player.mach < 3) this.audio.play('stallWarn', { volume: 0.8 });

    this.audio.updateEngine({
      speed01: player.speed01,
      throttle: player.throttle,
      boost: player.boostBlend,
      damage01: player.damage01,
      altitude01: clamp01((player.altitude - 3500) / 3500),
    });
    this.audio.setEnvironment(WEATHER[world.weatherId], player.speed01, world.biome.ceiling ? 1 : 0);
    const intensity = clamp01(0.30 + player.speed01 * 0.42 + (1 - player.health / player.maxHealth) * 0.30
      + this.escalation * 0.2 + (this.metrics.position <= 2 ? 0.1 : 0));
    this.audio.setMusicIntensity(intensity);

    // Speed streaks in 3D as well as in post.
    this.render.vfx.setSpeedStreaks(
      clamp01((player.speed01 - 0.45) * 1.8) * (this.save.data.settings.motionBlur ? 1 : 0.4),
      player.velocity,
    );
  }

  /* =====================================================================
   * COLLISION WARNING
   * ------------------------------------------------------------------
   * Two hazards, one warning: solid structures on the flight vector, and
   * terrain the aircraft will fly into if it holds its current attitude.
   * Both are reported with the distance to impact, because "there is
   * something ahead" is not actionable and "something ahead in 1.4 km" is.
   *
   * The scan is throttled rather than run every frame: it is a broadphase
   * sweep over thousands of colliders, the answer barely changes in 80 ms,
   * and the reported distance is extrapolated between scans from the
   * aircraft's own speed so the readout still counts down smoothly.
   * ================================================================== */
  _updateHazard(dt, player, world) {
    this._hazardScan = (this._hazardScan || 0) - dt;
    // Six seconds of flight, with a floor generous enough that the warning is
    // still useful at low speed. At Mach 15 this is a 30 km scan, which sounds
    // absurd until you notice the airframe crosses it in six seconds.
    const look = clamp(player.speed * 6, 3000, 22000);

    if (this._hazardScan <= 0) {
      this._hazardScan = 0.08;
      const hit = world.forwardHazard(player.position, player.forward, look,
        player.visual.span * 0.6 + 40);
      let dist = hit ? hit.distance : Infinity;
      let kind = hit ? (hit.collider.type || 'obstacle') : null;

      // Terrain: walk forward along the current velocity and find the first
      // point where the ground is above where the aircraft will be.
      const STEPS = 14;
      for (let i = 1; i <= STEPS; i++) {
        const t = (i / STEPS) * look;
        _v.copy(player.position).addScaledVector(player.forward, t);
        const g = world.terrainHeight(_v.x, _v.z);
        if (_v.y > g + 55) continue;
        if (t < dist) { dist = t; kind = 'terrain'; }
        break;
      }
      this._hazardDist = dist;
      this._hazardKind = kind;
    } else if (this._hazardDist < Infinity) {
      // Close the gap between scans at the rate we are actually approaching.
      this._hazardDist -= player.speed * dt;
    }

    const d = this._hazardDist ?? Infinity;
    const active = d < look && d > 0;
    // Severity is time-to-impact, not distance: 2 km is nothing at Mach 3 and
    // is half a second at Mach 18.
    const tti = active ? d / Math.max(1, player.speed) : Infinity;
    this._hazardTTI = tti;

    if (active) {
      const label = HAZARD_LABEL[this._hazardKind] || 'OBSTACLE';
      this._hazardText = `COLLISION AHEAD · ${label} · ${(d / 1000).toFixed(2)} KM`;
      this._hazardLevel = tti < 1.2 ? 2 : tti < 2.6 ? 1 : 0;
      // The tone tightens as the impact closes, which is the part that makes it
      // register as urgent without anyone having to read the number.
      this._hazardBeep = (this._hazardBeep || 0) - dt;
      if (this._hazardBeep <= 0) {
        this._hazardBeep = clamp(tti * 0.32, 0.11, 0.85);
        this.audio.play('collisionWarn', {
          volume: this._hazardLevel === 2 ? 1 : this._hazardLevel === 1 ? 0.8 : 0.55,
          pitch: this._hazardLevel,
        });
      }
    } else {
      this._hazardText = '';
      this._hazardLevel = 0;
      this._hazardBeep = 0;
    }
  }

  /**
   * Thermal limit. Above Mach 18 the engine is on a one-minute clock: warn,
   * count it down, and when it runs out take the aircraft apart. Backing off
   * cools it, but at less than half the rate it heated, so the redline is a
   * budget spent across the whole run rather than a line you can hop over.
   *
   * @returns true once the run has ended, so the caller stops the frame.
   */
  _updateOverheat(dt, player) {
    const heat = player.updateHeat(dt);
    const over = player.mach > MACH.redline;
    const left = player.heatSecondsLeft;

    if (heat >= 1) {
      // The engine lets go: a real explosion, then the run is over.
      this.render.vfx.explode(player.position, 30, 0xffb063);
      this.render.postfx.flash(0.85, 0xffc890);
      this.render.rig.addShake(1.6, 20);
      this.audio.play('explosion', { volume: 1 });
      player.destroy('overheat');
      this._overheatText = '';
      this.endRun('ENGINE OVERHEAT', false);
      return true;
    }

    if (over) {
      this._overheatText = `ENGINE OVERHEAT · MACH ${player.mach.toFixed(1)} · ${Math.ceil(left)}s`;
      this._overheatLevel = left < 15 ? 2 : 1;
      // Two alert tiers: the standard overheat two-tone, and a faster,
      // higher one for the last fifteen seconds.
      this.audio.play(left < 15 ? 'overheatCritical' : 'overheat', { volume: 0.9 });
      if (!this._overheatWas) {
        this.ui.banner('ENGINE OVERHEAT', `REDUCE BELOW MACH ${MACH.redline}`);
        this._overheatWas = true;
      }
    } else {
      // Still shows while the engine is cooling, so the pilot can see the
      // budget coming back rather than guessing.
      this._overheatText = heat > 0.02
        ? `ENGINE COOLING · ${Math.round((1 - heat) * 100)}%` : '';
      this._overheatLevel = 0;
      this._overheatWas = false;
    }
    this._heat01 = heat;
    return false;
  }

  /* =====================================================================
   * COMBAT
   * ================================================================== */

  /**
   * One combat frame: weapon input, the squadron, reinforcement waves and the
   * manoeuvre tracker that Endless Race scores its mandatory objectives from.
   */
  _updateCombat(dt, player, cfg) {
    const c = this.combat;
    const raw = this._rawInput || {};

    if (raw.cycleGun) {
      const w = c.cycleGun();
      this.audio.ui('click');
      this.ui.notify(`${w.name.toUpperCase()}`);
    }
    if (raw.cycleWeapon) {
      const w = c.cycleWeapon();
      this.audio.ui('click');
      this.ui.notify(`${w.name.toUpperCase()} SELECTED`);
    }
    // A dedicated weapon key selects AND launches in one press.
    if (raw.weapon) {
      const w = c.selectWeapon(raw.weapon);
      if (w) { this.ui.notify(`${w.name.toUpperCase()}`); raw.heavy = true; }
    }
    if (raw.cycleTarget) {
      const t = c.cycleTarget(player);
      this.audio.ui(t ? 'select' : 'error');
    }

    c.update(dt, player, { gun: raw.gun, heavy: raw.heavy });

    /* --- reinforcements --------------------------------------------------
     * A wave arrives on a timer, and immediately if the sky has been cleared —
     * the mode is endless, so it must never go quiet. */
    c.waveTimer -= dt;
    const live = c.enemies.filter((e) => e.alive).length;
    if (c.waveTimer <= 0 || live === 0) {
      // The interval tightens as the fight escalates.
      c.waveTimer = Math.max(9, COMBAT.waveInterval - this.runTime / 22);
      c.spawnWave(player.distanceAlong, this._enemySpecs);
      this.ui.banner(`WAVE ${c.wave}`, `${live === 0 ? 'AIRSPACE CLEAR — ' : ''}HOSTILES INBOUND`);
      this.audio.play('alert', { volume: 0.8 });
      // Reinforcements arriving means you are in the fight again.
      this._disengageT = 0;
      this._combatWarn = '';
    }

    this._trackManoeuvres(dt, player);
    this._updateCombatHud(player);
  }

  /**
   * Watch the airframe's attitude and count completed aerobatics. Rolls are
   * counted by integrating bank angle through a full turn; loops by
   * integrating pitch. Both are mandatory objectives in Endless Race, so they
   * have to be counted from what the aircraft actually did, not from key
   * presses — holding the key against a wall is not a roll.
   */
  _trackManoeuvres(dt, player) {
    const m = this.metrics;
    // --- roll: integrate the roll rate, count a turn every 2π ---------------
    this._rollAcc = (this._rollAcc || 0) + (player.rollRateActual || 0) * dt;
    while (Math.abs(this._rollAcc) >= TAU) {
      this._rollAcc -= Math.sign(this._rollAcc) * TAU;
      m.rolls++; m.manoeuvres++;
      this.score += SCORE.manoeuvre * this.combo;
      this.audio.play('overtake', { volume: 0.5 });
      this.ui.notify('AILERON ROLL', 'good');
    }
    // --- loop: integrate pitch rate the same way ---------------------------
    this._pitchAcc = (this._pitchAcc || 0) + (player.pitchRateActual || 0) * dt;
    while (Math.abs(this._pitchAcc) >= TAU) {
      this._pitchAcc -= Math.sign(this._pitchAcc) * TAU;
      m.loops++; m.flips++; m.manoeuvres++;
      this.score += SCORE.manoeuvre * 1.6 * this.combo;
      this.ui.notify('LOOP COMPLETE', 'good');
    }
    // --- hard turn: a sustained pull above 6 G counts once ------------------
    if (Math.abs(player.gLoad || 0) > 6) {
      this._hardTurnT = (this._hardTurnT || 0) + dt;
      if (this._hardTurnT > 0.8 && !this._hardTurnCounted) {
        this._hardTurnCounted = true;
        m.turns++; m.manoeuvres++;
        this.score += SCORE.manoeuvre * 0.5 * this.combo;
      }
    } else { this._hardTurnT = 0; this._hardTurnCounted = false; }

    // Speed scoring for the racing variant.
    if (player.mach >= MACH.blurMach) {
      m.machTime += dt;
      this.score += SCORE.machHoldPerSec * dt * this.combo;
    }
  }

  /** Target boxes, lock state and enemy speed labels. */
  _updateCombatHud(player) {
    const c = this.combat;
    const cam = this.render.camera;
    const boxes = [];
    for (const e of c.liveEnemies()) {
      _v.copy(e.position3);
      const dist = _v.distanceTo(player.position);
      if (dist > 7000) continue;
      _v.project(cam);
      // Off-screen targets must be dropped, not clamped: projecting a point
      // behind or beside the camera still yields coordinates, and drawing them
      // piles every out-of-view hostile into the corners of the HUD.
      if (_v.z > 1) continue;
      // Kept a little inside the frame so a bracket never lands on top of the
      // HUD furniture in the corners.
      if (_v.x < -0.93 || _v.x > 0.93 || _v.y < -0.90 || _v.y > 0.90) continue;
      const mach = MACH.of(e.speed);
      boxes.push({
        x: (_v.x * 0.5 + 0.5) * 100,
        y: (-_v.y * 0.5 + 0.5) * 100,
        dist,
        locked: e === c.lockTarget && c.locked,
        tracking: e === c.lockTarget && !c.locked,
        health: clamp01(e.health / e.maxHealth),
        mach: mach.toFixed(1),
        kmh: Math.round(mach * MACH.kmh),
        color: e.livery,
      });
    }
    // Which weapon each key arms, and which one is live right now.
    const binds = this.save.data.settings.bindings || {};
    const rack = HEAVY_ORDER.map((id) => {
      const w = WEAPONS_BY_ID[id];
      const action = HEAVY_KEY_ACTION[id];
      const code = (binds[action] || DEFAULT_BINDINGS[action] || [])[0];
      return { id, name: w.name, short: w.short, key: prettyKeyCap(code), armed: c.heavyWeapon.id === id };
    });
    // The gun rack has no per-weapon keys — the whole set cycles on one — so
    // the armed one is marked and the rest just show what is in the belt.
    const gunRack = GUN_ORDER.map((id) => {
      const w = WEAPONS_BY_ID[id];
      return { id, name: w.name, short: w.short, armed: c.gunWeapon.id === id };
    });

    this.ui.updateCombatHud({
      boxes,
      rack,
      gunRack,
      gun: c.gunWeapon,
      weapon: c.heavyWeapon,
      ready: c.heavyCooldown <= 0,
      reload: c.heavyWeapon.cooldown > 0 ? 1 - clamp01(c.heavyCooldown / c.heavyWeapon.cooldown) : 1,
      lock: c.lockProgress,
      locked: c.locked,
      targetName: c.lockTarget?.name || '',
      hostiles: c.enemies.filter((e) => e.alive).length,
      wave: c.wave,
      kills: this.metrics.kills,
    });
  }

  /**
   * The mode-specific ways a combat sortie ends, matching the game-over list
   * shown on the main menu and the HUD. Returns true once the run is over.
   */
  _checkCombatFailure(dt, player, cfg) {
    if (cfg.mode.speedFocus) {
      // Endless Race: you have to keep the speed up, and stay with the pack.
      if (player.mach < 4) {
        this._slowT = (this._slowT || 0) + dt;
        this._combatWarn = `SPEED CRITICAL · ${Math.max(0, 12 - this._slowT).toFixed(0)}s`;
        if (this._slowT > 12) { this.endRun('SPEED LOST', false); return true; }
      } else { this._slowT = 0; this._combatWarn = ''; }

      const lead = this.combat?.liveEnemies()
        .reduce((m, e) => Math.max(m, e.distanceAlong), -Infinity) ?? -Infinity;
      if (isFinite(lead) && lead - player.distanceAlong > 6000) {
        this.endRun('OUT-RUN BY THE SQUADRON', false);
        return true;
      }
    } else {
      /* Endless Battle: leaving the fight is the same as losing it.
       *
       * Hysteresis is essential here, not a nicety. At Mach 18 the airframe
       * covers 12 km in the time this check runs a few hundred times, so a
       * single threshold has hostiles crossing it back and forth every second
       * and the warning strobes on and off. The timer therefore starts at
       * 16 km and only clears once the fight is back inside 11 km. */
      let nearest = Infinity;
      for (const e of this.combat?.liveEnemies() || []) {
        nearest = Math.min(nearest, e.position3.distanceTo(player.position));
      }
      const running = (this._disengageT || 0) > 0;
      const away = nearest > (running ? 11000 : 16000);
      if (away && this.combat?.enemies.length) {
        this._disengageT = (this._disengageT || 0) + dt;
        this._combatWarn = `RETURN TO COMBAT AIRSPACE · ${Math.max(0, 20 - this._disengageT).toFixed(0)}s`;
        if (this._disengageT > 20) { this.endRun('LEFT THE ENGAGEMENT', false); return true; }
      } else { this._disengageT = 0; this._combatWarn = ''; }

      // A stalled airframe under fire is a dead airframe.
      if (player.mach < 2 && player.damage01 > 0.75) {
        this.endRun('SHOT DOWN WHILE STALLED', false);
        return true;
      }
    }
    return false;
  }

  _processCombatEvents(events) {
    for (const ev of events) {
      switch (ev.type) {
        case 'hit':
          if (!ev.fromPlayer) break;
          this.metrics.hits++;
          if (!ev.weapon.tracer) this.metrics.missiles++;
          this.score += (ev.weapon.tracer ? SCORE.gunHit : SCORE.weaponHit) * this.combo;
          this._bumpCombo();
          break;
        case 'kill':
          this.metrics.kills++;
          // A kill taken without being hit since the last one is worth more.
          if (!this._hitSinceKill) this.metrics.cleanKills = (this.metrics.cleanKills || 0) + 1;
          this._hitSinceKill = false;
          this.score += SCORE.kill * this.combo;
          this._bumpCombo();
          this.audio.play('explosion', { volume: 0.9 });
          this.ui.notify('TARGET DESTROYED', 'good');
          break;
        case 'playerHit':
          this.metrics.damageTaken += ev.amount;
          this._hitSinceKill = true;
          break;
        case 'noLock':
          this.ui.notify('NO LOCK', 'bad');
          break;
        case 'launch':
          this.metrics.shotsFired++;
          break;
        default: break;
      }
    }
  }

  _processEvents(events, dt) {
    for (const e of events) {
      switch (e.type) {
        case 'checkpoint': {
          this.metrics.checkpoints++;
          this.metrics.cleanStreak++;
          const perfect = e.precision > 0.72;
          if (perfect) this.metrics.perfectCheckpoints++;
          const gain = (SCORE.checkpoint + (perfect ? SCORE.perfectCheckpoint : 0)) * this.combo;
          this.score += gain;
          this._bumpCombo();
          this.audio.play('checkpoint');
          this.ui.notify(perfect ? 'PERFECT GATE' : 'CHECKPOINT', perfect ? 'gold' : 'good', `+${Math.round(gain)}`);
          this.ui.vibrate(18);
          if (this.runConfig.mode.hasTimer) {
            const bonus = 5.5 * this.runConfig.difficulty.timeBonus * (perfect ? 1.3 : 1);
            this.timeRemaining += bonus;
            this.ui.notify('TIME BONUS', 'good', `+${bonus.toFixed(1)}s`);
          }
          if (this.runConfig.mode.hasLaps) {
            const perLap = 18;
            const lap = Math.floor(this.metrics.checkpoints / perLap);
            if (lap > this.lapCount) {
              const lapTime = this.runTime - this.lapStart;
              this.lapStart = this.runTime;
              if (!this.bestLap || lapTime < this.bestLap) this.bestLap = lapTime;
              this.lapCount = lap;
              this.ui.banner(`LAP ${lap + 1} / ${this.runConfig.laps}`, formatTime(lapTime));
            }
          }
          break;
        }
        case 'checkpointMissed':
          this.metrics.missedCheckpoints++;
          this.metrics.cleanStreak = 0;
          this.score = Math.max(0, this.score + SCORE.missedCheckpoint);
          this.penalty = (this.penalty || 0) + 2;
          this.combo = 1; this.comboSteps = 0;
          this.audio.play('error');
          this.ui.notify('CHECKPOINT MISSED', 'bad', `${SCORE.missedCheckpoint}`);
          if (this.runConfig.mode.hasTimer) this.timeRemaining -= 3;
          break;
        case 'ring': {
          this.metrics.rings++;
          const gain = SCORE[e.ring.score] * this.combo * (1 + e.precision * 0.5);
          this.score += gain;
          this._bumpCombo(0.5);
          this.audio.play(e.ring.kind === 'boost' ? 'ringBoost' : 'ring', { pitch: e.precision });
          break;
        }
        case 'nearMiss': {
          this.metrics.nearMisses++;
          const gain = (e.score ?? SCORE.nearMiss) * this.combo;
          this.score += gain;
          this._bumpCombo(0.7);
          this.audio.play('nearMiss', { closeness: e.closeness });
          if (e.closeness > 0.7) { this.ui.notify('NEAR MISS', 'gold', `+${Math.round(gain)}`); }
          break;
        }
        case 'collision':
          this.metrics.collisions++;
          this.metrics.cleanStreak = 0;
          this.score = Math.max(0, this.score + SCORE.collisionPenalty);
          this.combo = 1; this.comboSteps = 0;
          if (e.fatal) {
            // Structure strike: loud, and named, so it is obvious what killed you.
            this.audio.play('explosion', { volume: 1 });
            this.ui.banner('IMPACT', (HAZARD_LABEL[e.structure] || 'STRUCTURE') + ' STRIKE');
            this.ui.vibrate(220);
          } else {
            this.audio.play('collision');
            this.ui.vibrate(90);
          }
          break;
        case 'shielded':
          this.audio.play('shield');
          this.ui.notify('IMPACT ABSORBED', 'good');
          break;
        case 'rivalContact':
          this.audio.play('collision', { volume: 0.7 });
          this.ui.vibrate(60);
          break;
        case 'power': {
          this.metrics.powerUses++;
          this.audio.play('power');
          this.ui.notify(e.power.name, 'good');
          break;
        }
        case 'powerBlocked':
          this.audio.play('powerBlocked');
          break;
        case 'overtake': {
          this.metrics.overtakes++;
          const gain = SCORE.overtake * this.combo;
          this.score += gain;
          this._bumpCombo();
          this.audio.play('overtake');
          this.ui.notify(`POSITION ${e.position}`, 'gold', `+${Math.round(gain)}`);
          break;
        }
        case 'overtaken':
          this.ui.notify(`POSITION ${e.position}`, 'bad');
          break;
        case 'destroyed':
          this.metrics.cleanStreak = 0;
          this.audio.play('explosion');
          this.ui.vibrate(220);
          break;
        case 'impact':
          this.audio.play('explosion', { volume: 0.8 });
          break;
        default: break;
      }
    }
    this.metrics.maxCombo = Math.max(this.metrics.maxCombo, this.combo);
  }

  _bumpCombo(weight = 1) {
    this.comboSteps += weight;
    this.combo = clamp(1 + this.comboSteps * SCORE.comboStep, 1, SCORE.comboMax);
    this.comboTimer = SCORE.comboDecay;
  }

  _onWorldEvent(ev) {
    this.ui.banner(ev.name, ev.desc);
    if (ev.turb) this.world.turbulence = Math.min(1.4, this.world.turbulence * ev.turb);
    this.audio.play('alert');
  }

  /* =====================================================================
   * END OF RUN
   * ================================================================== */
  endRun(reason, success) {
    if (this.state === 'results') return;
    this.state = 'results';
    this.ui.setHudVisible(false);
    this.audio.stopEngine();
    this.audio.play(success ? 'victory' : 'defeat');
    this.audio.setMusic(success ? 'victory' : 'gameover', 0.5);

    const cfg = this.runConfig;
    const m = this.metrics;
    const st = this.save.data.stats;
    const position = this.director?.playerPosition ?? 1;
    const gridSize = this.director?.gridSize ?? 1;
    const finalScore = Math.round(this.score * this.scoreMultiplier * cfg.difficulty.rewardMult);

    // --- records -----------------------------------------------------------
    const records = {};
    const rec = (key, value, statKey) => {
      if (value > (st[statKey] || 0)) { st[statKey] = value; records[key] = true; }
    };
    rec('score', finalScore, 'bestScore');
    rec('distance', m.distance, 'bestDistance');
    rec('speed', Math.round(m.topSpeedKmh), 'bestSpeedKmh');
    rec('mach', Math.round(m.topMach * 10) / 10, 'bestMach');
    rec('kills', m.kills, 'bestKills');
    rec('combo', Math.round(m.maxCombo * 10) / 10, 'bestCombo');
    rec('clean', m.cleanStreak, 'bestCleanStreak');
    if (cfg.mode.id === 'survival' || cfg.mode.id === 'endless') rec('survival', m.time, 'bestSurvivalTime');

    st.totalRuns++;
    st.totalDistance += m.distance;
    st.totalCheckpoints += m.checkpoints;
    st.totalNearMisses += m.nearMisses;
    st.totalOvertakes += m.overtakes;
    st.totalRings += m.rings;
    st.totalScore += finalScore;
    st.totalTime += m.time;
    st.totalKills = (st.totalKills || 0) + m.kills;
    st.totalManoeuvres = (st.totalManoeuvres || 0) + m.manoeuvres;
    if (!success) st.crashes++;
    if (cfg.mode.hasRivals && this.finished) {
      if (position === 1) { st.wins++; if (cfg.difficulty.order === 4) st.legendaryWins++; }
      if (position <= 3) st.podiums++;
    }

    // --- rewards ------------------------------------------------------------
    const objDone = this.objectives.filter((o) => o.complete);
    let credits = Math.round(finalScore * CREDITS.perScore);
    credits += objDone.length * CREDITS.perObjective;
    if (cfg.daily) credits += CREDITS.dailyBonus;
    if (cfg.mode.hasRivals && this.finished && position <= 3) credits += CREDITS.podium[position - 1];
    if (cfg.campaign && success) credits += cfg.campaign.reward;
    credits = Math.round(credits * cfg.difficulty.rewardMult);
    this.save.addCredits(credits);

    // --- campaign + daily ---------------------------------------------------
    if (cfg.campaign && success && position <= cfg.campaign.goal.value) {
      if (this.save.data.campaignProgress < cfg.campaign.id) {
        this.save.set('campaignProgress', cfg.campaign.id);
        this.ui.toast(`CHAPTER ${cfg.campaign.id} CLEARED`);
      }
    }
    if (cfg.daily) {
      const ds = this.save.data.dailyState;
      if (ds.date !== cfg.daily.dateKey) { ds.date = cfg.daily.dateKey; ds.best = 0; ds.completed = false; }
      ds.best = Math.max(ds.best, finalScore);
      if (objDone.length) ds.completed = true;
      this.save.persist();
    }

    // --- achievements --------------------------------------------------------
    const newAch = [];
    for (const a of ACHIEVEMENTS) {
      if (this.save.data.achievements.includes(a.id)) continue;
      let ok = false;
      try { ok = a.check(st, this.save.data); } catch (e) { ok = false; }
      if (ok) {
        this.save.data.achievements.push(a.id);
        this.save.addCredits(a.reward);
        newAch.push(a);
      }
    }
    this.save.persist();
    if (newAch.length) {
      this.audio.play('unlock');
      newAch.forEach((a, i) => setTimeout(() => this.ui.toast(`ACHIEVEMENT · ${a.name}`), 400 + i * 900));
    }

    // --- results screen -------------------------------------------------------
    const win = success && (!cfg.mode.hasRivals || position === 1);
    const tiles = [
      { label: 'Score', value: nfmt(finalScore), record: !!records.score },
      { label: 'Distance', value: `${(m.distance / 1000).toFixed(2)} km`, record: !!records.distance },
      { label: 'Time', value: formatTime(m.time, false) },
      { label: 'Position', value: cfg.mode.hasRivals ? `${position} / ${gridSize}` : '—' },
      { label: 'Top Speed', value: `${nfmt(Math.round(m.topSpeedKmh))} km/h`, record: !!records.speed },
      { label: 'Top Mach', value: `M ${m.topMach.toFixed(1)}`, record: !!records.mach },
      { label: 'Checkpoints', value: nfmt(m.checkpoints) },
      { label: 'Rings', value: nfmt(m.rings) },
      { label: 'Near Misses', value: nfmt(m.nearMisses) },
      { label: 'Overtakes', value: nfmt(m.overtakes) },
      { label: 'Best Combo', value: `×${m.maxCombo.toFixed(1)}`, record: !!records.combo },
      { label: 'Clean Streak', value: nfmt(m.cleanStreak), record: !!records.clean },
      { label: 'Collisions', value: nfmt(m.collisions) },
    ];
    if (cfg.mode.hasLaps) tiles.push({ label: 'Best Lap', value: formatTime(this.bestLap) });
    // Combat modes are scored on the fight, so those numbers lead rather than
    // being buried among the racing ones.
    if (cfg.mode.combat) {
      tiles.splice(1, 0,
        { label: 'Kills', value: nfmt(m.kills), record: !!records.kills },
        { label: 'Weapon Hits', value: nfmt(m.hits) },
        { label: 'Manoeuvres', value: nfmt(m.manoeuvres) });
    }

    const rewards = [`+${nfmt(credits)} ◈ CREDITS`];
    if (objDone.length) rewards.push(`${objDone.length} / ${this.objectives.length} OBJECTIVES`);
    if (cfg.daily) rewards.push(`DAILY ×${cfg.daily.scoreMultiplier.toFixed(1)}`);
    if (cfg.campaign && success) rewards.push(`CHAPTER ${cfg.campaign.id} CLEARED`);

    this.ui.showResults({
      verdict: win ? 'VICTORY' : success ? 'RUN COMPLETE' : 'RUN ENDED',
      win, lose: !success,
      reason,
      tiles,
      objectives: this.objectives.map((o) => ({
        text: o.text, complete: o.complete,
        detail: o.metric === 'positionInv' ? `P${position}` : `${Math.round(this.metrics[o.metric] || 0)} / ${o.value}`,
      })),
      rewards,
    });
    this.ui.refreshLoadout();
  }

  /* =====================================================================
   * PAUSE
   * ================================================================== */
  togglePause(force = null) {
    const canPause = this.state === 'racing' || this.state === 'countdown' || this.state === 'paused';
    if (!canPause) return;
    const want = force !== null ? force : this.state !== 'paused';
    if (want && this.state !== 'paused') {
      this.prePauseState = this.state;
      this.state = 'paused';
      this.audio.stopEngine();
      this.audio.setMusicIntensity(0.15);
      const cfg = this.runConfig;
      this.ui.showPause(
        `${cfg.mode.name} · ${cfg.difficulty.name} · ${cfg.biome.name}`,
        [
          ['Score', nfmt(Math.round(this.score))],
          ['Distance', `${(this.metrics.distance / 1000).toFixed(2)} km`],
          ['Position', cfg.mode.hasRivals ? `${this.director?.playerPosition ?? 1}` : '—'],
          ['Checkpoints', nfmt(this.metrics.checkpoints)],
          ['Time', formatTime(this.runTime, false)],
          ['Hull', `${Math.round((this.player.health / this.player.maxHealth) * 100)}%`],
        ],
      );
      this.ui.setHudVisible(false);
    } else if (!want && this.state === 'paused') {
      this.state = this.prePauseState || 'racing';
      this.audio.startEngine();
      this.ui.showScreen('none');
      this.ui.setHudVisible(true);
      this.perf.lastTime = 0;              // avoid a giant first delta
    }
  }

  /* =====================================================================
   * FRAME LOOP
   * ================================================================== */
  start() {
    if (this._rafId) return;
    const loop = (now) => {
      this._rafId = requestAnimationFrame(loop);
      try { this.tick(now); }
      catch (err) {
        console.error('[Loop] frame failed:', err);
        // Errors decay: only a sustained storm should stop the loop, not a
        // hundred isolated hiccups spread across a long session.
        const t = performance.now();
        if (t - (this._lastFrameError || 0) > 4000) this._frameErrors = 0;
        this._lastFrameError = t;
        this._frameErrors = (this._frameErrors || 0) + 1;
        if (this._frameErrors > 240) {
          cancelAnimationFrame(this._rafId);
          this._rafId = 0;
          this.ui.toast('A rendering error stopped the loop — reload to continue', 'bad');
        }
      }
    };
    this._rafId = requestAnimationFrame(loop);
  }

  tick(now) {
    const dt = this.perf.begin(now);
    // Derived, never assigned from the individual transitions: pausing used to
    // disable input and only resuming re-enabled it, so Restart from the pause
    // menu left the whole keyboard dead until the page was reloaded.
    this.input.enabled = this.state !== 'paused';
    // The trigger is only under the mouse in flight — in the menus a click is
    // a click, and right-click must give back the browser's context menu.
    this.input.mouseEnabled = this.state === 'racing' && !!this.runConfig?.mode?.combat;
    this.elapsed += dt;
    this.quality.update(dt);

    switch (this.state) {
      case 'menu': this._updateMenu(dt); break;
      case 'countdown': this._updateCountdown(dt); break;
      case 'racing': this._updateRace(dt); break;
      case 'results': if (this.world && this.player) this._updateResultsCam(dt); break;
      case 'paused': break;
      default: break;
    }

    // Global hotkeys.
    if (this.input.justPressed('pause')) {
      if (this.state === 'paused') this.togglePause(false);
      else if (this.state === 'racing' || this.state === 'countdown') this.togglePause(true);
      else if (this.ui.dom.overlay.classList.contains('active')) this.ui.closeOverlay();
    }
    if (this.input.justPressed('fullscreen')) this.ui.toggleFullscreen();
    if (this.input.justPressed('camera') && this.state === 'racing') {
      this.render.rig.cycle();
      this.audio.ui('click');
    }
    if (this.input.justPressed('debug')) {
      const v = !this.save.data.settings.showDebug;
      this.save.setSetting('showDebug', v);
      this.ui.setDebug('', v);
    }

    if (this.state !== 'paused') {
      this.render.update(dt, this._renderState());
      // Chunk building gets whatever is left of the frame after rendering,
      // never a fixed slice: on a machine that is already missing its target
      // a fixed 4.5 ms budget is what turns a tight frame into a dropped one.
      const target = this.state === 'racing' ? 4.5 : 8;
      const headroom = 16.7 - this.perf.avgMs;
      this.scheduler.run(clamp(Math.min(target, headroom * 0.55), 0.8, target));
    }
    this.render.render(dt);
    this.perf.readRenderer(this.render.renderer);

    // The world and player are torn down a frame before the state leaves
    // 'racing' when a run is relaunched, and the HUD has nothing to draw
    // without them.
    if (this.state === 'racing' && this.player && this.world) this._pushHud();
    if (this.save.data.settings.showDebug) this._pushDebug();

    this.input.endFrame();
  }

  _renderState() {
    const p = this.player;
    if (!p || this.state === 'menu' || this.state === 'loading') {
      return { focus: this.render.camera.position, speed01: 0, boost: 0, damage: 0, wind: this.world?.windVec };
    }
    return {
      focus: p.position,
      speed01: p.speed01 || 0,
      mach01: p.mach01 || 0,
      boost: p.boostBlend || 0,
      damage: this.state === 'racing' ? clamp01((p.damage01 - 0.55) / 0.45) : 0,
      phase: p.phaseActive ? 1 : 0,
      scan: p.powerFlightActive ? 1 : 0,
      wind: this.world?.windVec,
      reducedMotion: !!this.save.data.settings.reducedMotion,
      vignetteBoost: p.maneuverActive ? 0.18 : 0,
    };
  }

  _updateResultsCam(dt) {
    this.world.update(dt * 0.4, this.player.position, this.elapsed);
    this.render.rig.update(dt, this.player, { speed01: 0.2, boost: 0, distanceScale: 1.8, lagScale: 0.4 });
  }

  /* =====================================================================
   * HUD FEED
   * ================================================================== */
  _pushHud() {
    const p = this.player;
    const cfg = this.runConfig;
    const w = this.world;

    // Next checkpoint marker.
    const cp = w.nextCheckpoint(p.lastCheckpointId + 1);
    let marker = null;
    if (cp) {
      this.render.projectToScreen(cp.pos, _screen);
      const dist = cp.pos.distanceTo(p.position);
      if (_screen.visible) {
        marker = { onScreen: true, x: _screen.x, y: _screen.y, distance: dist, label: cp.kind === 'multi' ? 'MULTI GATE' : 'CHECKPOINT' };
      } else {
        // Behind or off-screen: point the arrow toward it from screen centre.
        let dx = _screen.x - 0.5, dy = _screen.y - 0.5;
        if (_screen.behind) { dx = -dx; dy = -dy; }
        marker = { onScreen: false, angle: Math.atan2(dy, dx), distance: dist };
      }
    }

    // Radar payload — everything relative to the player, north-up.
    const buf = this._radarBuf;
    const range = 3200;
    buf.path.length = 0;
    for (let i = 0; i < 14; i++) {
      const s = w.path.sample(p.distanceAlong + i * 240, {});
      buf.path.push([s.pos.x - p.position.x, s.pos.z - p.position.z]);
    }
    buf.cps.length = 0;
    for (const c of w.checkpointList) {
      if (c.passed || c.missed) continue;
      const dx = c.pos.x - p.position.x, dz = c.pos.z - p.position.z;
      if (Math.abs(dx) > range || Math.abs(dz) > range) continue;
      buf.cps.push([dx, dz]);
      if (buf.cps.length >= 4) break;
    }
    buf.rivals.length = 0;
    if (this.director) {
      for (const r of this.director.racers) {
        if (!r.alive) continue;
        const dx = r.position3.x - p.position.x, dz = r.position3.z - p.position.z;
        if (Math.abs(dx) > range || Math.abs(dz) > range) continue;
        buf.rivals.push([dx, dz, r.distanceAlong - p.distanceAlong, r.position3.y - p.position.y]);
      }
      buf.traffic.length = 0;
      for (const t of this.director.traffic.active) {
        const dx = t.pos.x - p.position.x, dz = t.pos.z - p.position.z;
        if (Math.abs(dx) > range || Math.abs(dz) > range) continue;
        buf.traffic.push([dx, dz]);
      }
    }
    buf.obstacles.length = 0;
    const near = w.queryColliders(p.position, 1600);
    for (let i = 0; i < near.length && buf.obstacles.length < 40; i++) {
      buf.obstacles.push([near[i].pos.x - p.position.x, near[i].pos.z - p.position.z]);
    }

    // Active objective (rotate to the first incomplete one).
    let obj = this.objectives.find((o) => !o.complete) || this.objectives[0];
    const objView = obj ? {
      text: obj.text, complete: obj.complete,
      progress: objectiveProgress(obj, this.metrics),
    } : null;

    const timerText = cfg.mode.hasTimer ? formatTime(Math.max(0, this.timeRemaining))
      : cfg.mode.hasLaps ? formatTime(this.runTime - this.lapStart)
        : formatTime(this.runTime);
    const timerLabel = cfg.mode.hasTimer ? 'TIME LEFT'
      : cfg.mode.hasLaps ? `LAP ${Math.min(this.lapCount + 1, cfg.laps)}/${cfg.laps}` : 'RUN TIME';

    this.ui.updateHUD({
      position: this.director?.playerPosition ?? 1,
      gridSize: this.director?.gridSize ?? 1,
      score: Math.round(this.score * this.scoreMultiplier),
      combo: this.combo,
      distance: this.metrics.distance,
      checkpoints: this.metrics.checkpoints,
      // Battle has no gates, so the slot that normally counts them counts the
      // thing that actually matters instead.
      soloLabel: cfg.mode.noRings ? 'KILLS' : 'CHECKPOINTS',
      soloValue: cfg.mode.noRings ? this.metrics.kills : this.metrics.checkpoints,
      soloUnit: cfg.mode.noRings ? 'DOWNED' : 'GATES',
      // There is no route to be off in an open-airspace fight.
      hasRoute: !cfg.mode.noRings,
      speedKmh: p.speedKmh,
      mach: p.mach,
      mach01: p.mach01,
      altitude: p.altitude,
      agl: p.agl,
      aglNorm: clamp01(p.agl / 3000),
      heading: p.headingDeg,
      timerText, timerLabel,
      bestText: cfg.mode.hasLaps
        ? (this.bestLap ? formatTime(this.bestLap) : '--:--.---')
        : (this.save.data.stats.bestSurvivalTime ? formatTime(this.save.data.stats.bestSurvivalTime, false) : '--:--'),
      penaltyText: formatTime(this.penalty || 0),
      boost: p.boost01,
      hull: p.health / p.maxHealth,
      corridorOut: p.corridorOut,
      warn: this._combatWarn || '',
      hazardText: this._hazardText || '',
      hazardLevel: this._hazardLevel || 0,
      overheatText: this._overheatText || '',
      overheatLevel: this._overheatLevel || 0,
      heat: this._heat01 || 0,
      redline: p.mach > MACH.redline,
      modeName: cfg.mode.name,
      objective: objView,
      powers: p.powers.slots.map((s) => ({
        cooldown: s.cooldown, active: s.active,
        total: s.def.cooldown * p.powers.cooldownScale + s.def.duration,
      })),
      checkpointMarker: marker,
      radarRange: range,
      radarPath: buf.path,
      radarCheckpoints: buf.cps,
      radarRivals: buf.rivals,
      radarTraffic: buf.traffic,
      radarObstacles: buf.obstacles,
    });
  }

  _pushDebug() {
    const p = this.perf;
    const pl = this.player;
    const w = this.world;
    const lines = [
      `FPS        ${p.smoothFps.toFixed(1)} (p95 ${p.p95.toFixed(1)}ms)`,
      `Frame      ${p.frameTime.toFixed(2)}ms avg ${p.avgMs.toFixed(2)}`,
      `Quality    ${this.quality.statusLabel}`,
      `Pixel      ${this.quality.effectivePixelRatio.toFixed(2)}`,
      `Draw calls ${p.info.drawCalls}`,
      `Triangles  ${(p.info.triangles / 1000).toFixed(1)}k`,
      `Geometries ${p.info.geometries}  Tex ${p.info.textures}`,
      `Programs   ${p.info.programs}`,
      `Memory     ${p.memoryMB ? `${p.memoryMB.toFixed(0)} MB` : 'n/a'}`,
      `State      ${this.state}`,
      `Seed       ${this.runConfig?.seed ?? this.world?.seed ?? '—'}`,
      `Biome      ${w?.biome.id ?? '—'} / ${w?.weatherId ?? '—'} / ${w?.timeId ?? '—'}`,
      `Chunks     ${w?.stats.chunks ?? 0} (queue ${this.scheduler.pending})`,
      `Colliders  ${w?.stats.colliders ?? 0}`,
      `Path nodes ${w?.path.nodes.length ?? 0}`,
      `Segment    ${pl ? w?.path.nodes[pl.pathHint]?.seg.id : '—'}`,
      `Chunk      ${w?.currentChunk ?? 0}`,
      `Speed      ${pl ? `${pl.speed.toFixed(1)} m/s (${Math.round(pl.speedKmh)} km/h)` : '—'}`,
      `Altitude   ${pl ? `${pl.altitude.toFixed(0)} m (AGL ${pl.agl.toFixed(0)})` : '—'}`,
      `Along      ${pl ? pl.distanceAlong.toFixed(0) : '—'} m`,
      `Corridor   ${pl ? `${pl.pathOffset.toFixed(0)} / ${pl.pathRadius.toFixed(0)}` : '—'}`,
      `Load       ${pl ? `${pl.loadFactor.toFixed(2)} G  (wing at ${Math.round(pl.aoa01 * 100)}% of lift limit)` : '—'}`,
      `Engine     ${pl ? `throttle ${pl.throttle.toFixed(2)}  reheat ${pl.burner.toFixed(2)}` : '—'}`,
      `AI         ${this.director?.racers.length ?? 0}  Traffic ${this.director?.traffic.active.length ?? 0}`,
      `Weather    ${w ? `turb ${w.turbulence.toFixed(2)} wind ${w.windVec.length().toFixed(1)}` : '—'}`,
      `Event      ${w?.activeEvent?.name ?? 'none'}`,
      `Boot       ${this.bootSeconds ? `${this.bootSeconds.toFixed(2)}s` : '—'}`,
    ];
    this.ui.setDebug(lines.join('\n'), true);
  }

  /* =====================================================================
   * WIRING
   * ================================================================== */
  _wireUI() {
    this.ui.on({
      onOnboardingDone: () => {
        this.save.set('onboarded', true);
        this.audio.unlock();
        this.enterMenu();
      },
      onLaunch: () => { this.audio.unlock(); this.launchRun(); },
      onLaunchDaily: () => {
        const d = getDailyChallenge();
        this.audio.unlock();
        this.launchRun({
          mode: d.mode, difficulty: d.difficulty, location: d.biome.id,
          weather: d.weather, seed: d.seed, daily: d,
        });
      },
      onLaunchCampaign: (id) => {
        const c = CAMPAIGN.find((x) => x.id === id);
        if (!c) return;
        if (c.id > (this.save.data.campaignProgress || 0) + 1) { this.ui.toast('Chapter locked', 'warn'); return; }
        this.audio.unlock();
        this.launchRun({
          mode: 'campaign', difficulty: c.diff, location: c.biome, weather: c.weather,
          laps: c.laps, campaign: c, seed: hashSeed(`campaign-${c.id}`),
        });
      },
      getDaily: () => getDailyChallenge(),
      onBuyAircraft: (id) => {
        const a = AIRCRAFT_BY_ID[id];
        if (!a || a.unlock.type !== 'credits') return false;
        if (this.save.data.credits < a.unlock.cost) { this.ui.toast('Not enough credits', 'warn'); return false; }
        this.save.addCredits(-a.unlock.cost);
        this.save.data.unlocked.push(id);
        this.save.set('selectedAircraft', id);
        this.ui.toast(`${a.name} UNLOCKED`);
        return true;
      },
      onAircraftChange: () => { this.ui.refreshLoadout(); },
      onCamera: () => { if (this.state === 'racing') this.ui.setCamera(this.render.rig.cycle()); },
      onZoom: (dir) => {
        const pct = this.render.rig.stepUserZoom(dir * CAM_ZOOM_STEP);
        this.ui.setZoom(Math.round(pct * 100), CAM_ZOOM_MIN * 100, CAM_ZOOM_MAX * 100);
        // Remembered across runs: framing is a preference, not a per-run choice.
        this.save.setSetting('cameraZoom', pct);
      },
      onHangarMode: (active) => this.setHangarMode(active),
      onHangarPreview: (id) => this.setShowcaseAircraft(id),
      onHangarSpin: (delta) => this.spinHangar(delta),
      onResetProgress: () => {
        this.save.reset();
        this.input.resetBindings();
        this.ui.toast('Progress reset');
        location.reload();
      },
      onPauseAction: (a) => {
        if (a === 'toggle') { this.togglePause(); return; }
        if (a === 'resume') this.togglePause(false);
        else if (a === 'restart') { this.ui.showScreen('none'); this.launchRun({ seed: (Math.random() * 1e9) | 0 }); }
        else if (a === 'menu') this._returnToMenu();
      },
      onResultAction: (a) => {
        if (a === 'retry') this.launchRun({ seed: this.runConfig?.seed });
        else if (a === 'newseed') this.launchRun({ seed: (Math.random() * 1e9) | 0 });
        else if (a === 'mode') { this._returnToMenu(); this.ui.setSection('mode'); }
        else if (a === 'location') { this._returnToMenu(); this.ui.setSection('location'); }
        else this._returnToMenu();
      },
      onSettingsChange: (key, value) => this._onSettingChange(key, value),
      onResize: () => this.handleResize(),
    });
  }

  async _returnToMenu() {
    if (this.director) { this.director.dispose(); this.director = null; }
    if (this.combat) { this.combat.dispose(); this.combat = null; this.ui.clearCombatHud(); }
    this.ui.showScreen('loading');
    this.ui.setLoadProgress(0, 'Returning to hangar');
    await nextFrame();
    await this._buildMenuVenue((p) => this.ui.setLoadProgress(p, 'Preparing hangar'));
    this.enterMenu();
  }

  _onSettingChange(key, value) {
    const s = this.save.data.settings;
    switch (key) {
      case 'graphics':
        this.quality.setPreset(value);
        this.quality.applyOverrides(s);
        this.render.applyQuality();
        if (this.world) this.render.setVenue(this.world.biome, this.world.weatherId, this.world.timeId);
        this.ui.toast(`Graphics: ${value.toUpperCase()}`);
        break;
      case 'resolutionScale': case 'particles': case 'viewDistance':
      case 'cloudQuality': case 'weatherQuality': case 'shadows':
      case 'reflections': case 'bloom': case 'motionBlur': case 'effects':
        this.quality.applyOverrides(s);
        this.render.applyQuality();
        if (this.world && (key === 'viewDistance' || key === 'weatherQuality')) {
          this.render.setVenue(this.world.biome, this.world.weatherId, this.world.timeId);
        }
        break;
      case 'masterVolume': case 'musicVolume': case 'sfxVolume': case 'environmentVolume':
        this.audio.applySettings(s);
        break;
      case 'reducedMotion':
        this.render.rig.reducedMotion = !!value;
        this.ui.applySettings();
        break;
      case 'guidance':
        this.render.guide.setEnabled(!!value && this.state === 'racing');
        break;
      case 'hudScale': case 'vibration':
        this.ui.applySettings();
        break;
      case 'touchControls':
        this.ui.setHudVisible(this.ui.hudVisible);
        break;
      case 'flightSensitivity':
        this.input.sensitivity = value;
        break;
      case 'invertPitch':
        this.input.invertPitch = !!value;
        break;
      case 'showDebug':
        this.ui.setDebug('', !!value);
        break;
      default: break;
    }
  }

  _wireWindow() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.state === 'racing' || this.state === 'countdown') this.togglePause(true);
        this.audio.suspend();
      } else {
        this.audio.resume();
        this.perf.lastTime = 0;
      }
    });
    // Any first gesture unlocks audio (browsers require it).
    const unlock = () => { this.audio.unlock(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('touchstart', unlock, { once: true });
  }

  handleResize() {
    if (!this.render) return;
    this.render.resize();
    this.ui.applySettings();
  }
}

function nfmt(n) { return Math.round(n).toLocaleString('en-US'); }
