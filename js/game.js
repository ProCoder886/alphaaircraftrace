/**
 * ALPHA AIRCRAFT RACE 3D — game.js
 * ---------------------------------------------------------------------------
 * Game state, the six modes, objectives, scoring, progression, the daily
 * challenge, the save system and the frame loop that drives every other
 * subsystem.
 */

import * as THREE from 'three';
import {
  AIRCRAFT_BY_ID, BIOMES, BIOMES_BY_ID, MODES, DIFFICULTIES, WEATHER, TIME_OF_DAY,
  CAMPAIGN, OBJECTIVE_POOL, ACHIEVEMENTS, SCORE, CREDITS, POWERS, WORLD,
  DEFAULT_SAVE, STORAGE_KEY, LOADING_STAGES, DEFAULTS,
  RNG, hashSeed, clamp, clamp01, lerp, damp, TAU,
} from './config.js';
import { DeviceProfile, PerfMonitor, AdaptiveQuality, Scheduler, LoadPipeline, nextFrame } from './performance.js';
import { RenderSystem } from './renderer.js';
import { World } from './world.js';
import { Player, InputManager } from './player.js';
import { RaceDirector } from './ai.js';
import { AudioSystem } from './audio.js';
import { UI, formatTime, formatDistance } from './ui.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
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
  for (let i = 0; i < count && pool.length; i++) {
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
  { id: 'nofreeze', name: 'NO TIME FREEZE', apply: (g) => { g.blockedPowers.add('freeze'); } },
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
      topSpeedKmh: 0, time: 0, maxCombo: 1, cleanStreak: 0, powerUses: 0,
      shortcuts: 0, highAltTime: 0, lowAltTime: 0, position: 1, collisions: 0,
      missedCheckpoints: 0, perfectCheckpoints: 0, boostTime: 0,
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

    pipeline.stage('Assembling airframes', 3, async () => {
      // Build every airframe template up front — a few ms each now beats a
      // hitch when a rival first comes into view.
      for (const id of Object.keys(AIRCRAFT_BY_ID)) {
        this.render.aircraftFactory.template(AIRCRAFT_BY_ID[id], 1);
        await nextFrame();
      }
      this.render.aircraftFactory.template(AIRCRAFT_BY_ID[this.save.data.selectedAircraft], 2);
    });

    pipeline.stage('Loading generated assets', 1, async () => {
      await this._loadAssetManifest();
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
   * Optional Tripo3D-generated models. If /Assets/3d/manifest.json lists any
   * GLBs they are loaded and registered; if it is missing or empty the game
   * runs on its procedural airframes, which is the shipped default.
   */
  async _loadAssetManifest() {
    this.generatedAssets = { count: 0, entries: [] };
    try {
      const res = await fetch('Assets/3d/manifest.json', { cache: 'no-cache' });
      if (!res.ok) return;
      const manifest = await res.json();
      const entries = (manifest.assets || []).filter((a) => a.status === 'ready' && a.file);
      if (!entries.length) return;
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      try {
        const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
        const draco = new DRACOLoader();
        draco.setDecoderPath('vendor/three/addons/libs/draco/gltf/');
        loader.setDRACOLoader(draco);
      } catch (e) { /* Draco optional */ }
      for (const entry of entries.filter((e) => e.priority === 'critical')) {
        try {
          const gltf = await loader.loadAsync(entry.file);
          this.render.aircraftFactory.registerExternal?.(entry.id, gltf.scene);
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
    this.ui.showScreen('menu');
    this.ui.refreshLoadout();
    this.render.rig.setMode('far');
    this.audio.setMusic('menu');
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
    const prev = _v.copy(this.player.position);
    this.player.position.copy(s.pos).addScaledVector(s.right, lat).addScaledVector(s.up, vert);
    _v2.subVectors(this.player.position, prev);
    if (_v2.lengthSq() > 0.01) {
      const mtx = new THREE.Matrix4().lookAt(_v2.clone().normalize(), new THREE.Vector3(), s.up);
      this.player.quaternion.slerp(new THREE.Quaternion().setFromRotationMatrix(mtx), clamp01(dt * 4));
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
      const r = this.player.visual.length * 1.75;
      // Framed to the right of centre so the detail panel does not cover it.
      cam.position.copy(this.player.position)
        .add(_v.set(Math.cos(this.hangarSpin) * r, r * 0.30 + Math.sin(m.t * 0.4) * 1.2, Math.sin(this.hangarSpin) * r));
      cam.up.set(0, 1, 0);
      cam.lookAt(this.player.position);
      if (cam.fov !== 42) { cam.fov = 42; cam.updateProjectionMatrix(); }
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
    this._startCountdown();
  }

  _beginRun() {
    const cfg = this.runConfig;
    this.metrics = this._blankMetrics();
    this.objectives = cfg.daily
      ? [{ ...cfg.daily.objective, def: cfg.daily.objective.def, complete: false, reward: 2, text: cfg.daily.objective.label }]
      : rollObjectives(cfg.rng, cfg.mode, cfg.difficulty, 3);
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
    this.render.rig.reset();

    this.audio.startEngine();
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
      if (now === 3) { this.ui.countdown('3'); this.audio.play('countdown'); this.audio.say('countdown3', true); }
      else if (now === 2) { this.ui.countdown('2'); this.audio.play('countdown'); }
      else if (now === 1) { this.ui.countdown('1'); this.audio.play('countdown'); }
      else if (now <= 0) {
        this.ui.countdown('GO', true);
        this.audio.play('go');
        this.audio.say('raceStart', true);
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
    const timeScale = player.freezeActive ? 0.34 : 1;
    if (this.director) this.director.update(dt, player, timeScale);
    world.update(dt * timeScale, player.position, this.elapsed);
    world.stream(this.scheduler, player.distanceAlong);

    /* --- events -------------------------------------------------------- */
    this._processEvents(player.drainEvents(), dt);
    if (this.director) this._processEvents(this.director.drainEvents(), dt);

    /* --- combo --------------------------------------------------------- */
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) { this.combo = 1; this.comboSteps = 0; }
    }

    /* --- passive scoring ------------------------------------------------ */
    this.metrics.distance = player.distanceTravelled;
    this.metrics.topSpeedKmh = Math.max(this.metrics.topSpeedKmh, player.speedKmh);
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
        this.audio.say('objective');
        this.ui.notify('OBJECTIVE COMPLETE', 'good');
        this.ui.banner('OBJECTIVE COMPLETE', o.text);
      }
    }

    /* --- failure conditions ---------------------------------------------- */
    if (!player.alive && player.impacted) {
      if (cfg.mode.failOnDamage === false) {
        // Free Flight has no failure state — put the aircraft back in the air.
        this._respawnTimer = (this._respawnTimer || 0) + dt;
        if (this._respawnTimer > 2.2) {
          this._respawnTimer = 0;
          player.reset(null, Math.max(0, player.distanceAlong - 400));
          this.ui.notify('AIRFRAME RESTORED', 'good');
        }
      } else { this.endRun('AIRCRAFT DESTROYED', false); return; }
    }
    if (cfg.mode.hasLaps && this.metrics.checkpoints >= this.targetCheckpoints && !this.finished) {
      this.finished = true;
      this.endRun('RACE COMPLETE', true);
      return;
    }

    /* --- camera + audio --------------------------------------------------- */
    this.render.rig.sensitivity = this.save.data.settings.cameraSensitivity ?? 1;
    this.render.rig.update(dt, player, {
      speed01: player.speed01,
      boost: player.boostBlend,
      turbulence: world.turbulence,
      lateral: clamp(player.smoothControls.roll, -1, 1),
      pitchRate: player.smoothControls.pitch,
      lagScale: 1 / clamp(this.save.data.settings.cameraSensitivity ?? 1, 0.5, 1.8),
    });

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

    /* --- commentary triggers ---------------------------------------------- */
    if (player.speedKmh > 1900) this.audio.say('highSpeed');
    if (this.combo > 2.4) this.audio.say('bigCombo');
    if (player.damage01 > 0.8) this.audio.say('criticalDamage');
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
              if (lap === this.runConfig.laps - 1) this.audio.say('lastLap', true);
              this.ui.banner(`LAP ${lap + 1} / ${this.runConfig.laps}`, formatTime(lapTime));
            }
          }
          if (this.metrics.checkpoints > 0 && this.targetCheckpoints
            && this.metrics.checkpoints === this.targetCheckpoints - 1) this.audio.say('checkpointFinal', true);
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
          if (e.closeness > 0.7) { this.audio.say('nearMiss'); this.ui.notify('NEAR MISS', 'gold', `+${Math.round(gain)}`); }
          break;
        }
        case 'collision':
          this.metrics.collisions++;
          this.metrics.cleanStreak = 0;
          this.score = Math.max(0, this.score + SCORE.collisionPenalty);
          this.combo = 1; this.comboSteps = 0;
          this.audio.play('collision');
          this.ui.vibrate(90);
          if (!e.soft) this.audio.say('crash');
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
          if (e.power.id === 'turbo') this.audio.say('boost');
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
          this.audio.say(e.position === 1 ? 'takeLead' : 'overtake');
          break;
        }
        case 'overtaken':
          this.audio.say(e.from === 1 ? 'loseLead' : 'overtaken');
          this.ui.notify(`POSITION ${e.position}`, 'bad');
          break;
        case 'destroyed':
          this.metrics.cleanStreak = 0;
          this.audio.play('explosion');
          this.ui.vibrate(220);
          this.audio.say('crash', true);
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
    if (ev.weather) this.audio.say('weather');
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
    this.audio.say(success ? 'victory' : 'defeat', true);
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
      { label: 'Top Speed', value: `${Math.round(m.topSpeedKmh)} km/h`, record: !!records.speed },
      { label: 'Checkpoints', value: nfmt(m.checkpoints) },
      { label: 'Rings', value: nfmt(m.rings) },
      { label: 'Near Misses', value: nfmt(m.nearMisses) },
      { label: 'Overtakes', value: nfmt(m.overtakes) },
      { label: 'Best Combo', value: `×${m.maxCombo.toFixed(1)}`, record: !!records.combo },
      { label: 'Clean Streak', value: nfmt(m.cleanStreak), record: !!records.clean },
      { label: 'Collisions', value: nfmt(m.collisions) },
    ];
    if (cfg.mode.hasLaps) tiles.push({ label: 'Best Lap', value: formatTime(this.bestLap) });

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
      this.input.enabled = false;
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
      this.input.enabled = true;
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
        this._frameErrors = (this._frameErrors || 0) + 1;
        if (this._frameErrors > 120) {
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
      this.ui.toast(`CAMERA · ${this.render.rig.cycle()}`);
      this.audio.ui('click');
    }
    if (this.input.justPressed('debug')) {
      const v = !this.save.data.settings.showDebug;
      this.save.setSetting('showDebug', v);
      this.ui.setDebug('', v);
    }

    if (this.state !== 'paused') {
      this.render.update(dt, this._renderState());
      this.scheduler.run(this.state === 'racing' ? 4.5 : 8);
    }
    this.render.render(dt);
    this.perf.readRenderer(this.render.renderer);

    if (this.state === 'racing') this._pushHud();
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
      boost: p.boostBlend || 0,
      damage: this.state === 'racing' ? clamp01((p.damage01 - 0.55) / 0.45) : 0,
      phase: p.phaseActive ? 1 : 0,
      scan: p.scanActive ? 1 : 0,
      wind: this.world?.windVec,
      reducedMotion: !!this.save.data.settings.reducedMotion,
      vignetteBoost: p.freezeActive ? 0.18 : 0,
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
      speedKmh: p.speedKmh,
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
    this.input.enabled = true;
    if (this.director) { this.director.dispose(); this.director = null; }
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
      case 'masterVolume': case 'musicVolume': case 'sfxVolume':
      case 'commentaryVolume': case 'environmentVolume':
        this.audio.applySettings(s);
        break;
      case 'reducedMotion':
        this.render.rig.reducedMotion = !!value;
        this.ui.applySettings();
        break;
      case 'hudScale': case 'subtitles': case 'vibration':
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

    // Commentary subtitles.
    const bindSub = () => {
      if (this.audio.commentary) this.audio.commentary.onSubtitle = (t) => this.ui.subtitle(t);
      else setTimeout(bindSub, 400);
    };
    bindSub();
  }

  handleResize() {
    if (!this.render) return;
    this.render.resize();
    this.ui.applySettings();
  }
}

function nfmt(n) { return Math.round(n).toLocaleString('en-US'); }
