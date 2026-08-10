/**
 * ALPHA AIRCRAFT RACE 3D — combat.js
 * ---------------------------------------------------------------------------
 * Air-to-air combat: weapons, projectiles, target locking and hostile fighter
 * squadrons. Used by Endless Battle and Endless Race.
 *
 * Design notes
 * ------------
 * · Ammunition is unlimited by design — the only limit is the reload timer, so
 *   the fight is about position and lock discipline, not counting rounds.
 * · Cannon rounds are drawn from one InstancedMesh (hundreds can be alive at
 *   once). Heavy rounds are far fewer and get real meshes plus ribbon trails.
 * · Enemies extend the existing AIRacer, which already flies the corridor in
 *   path space with archetypes, mistakes and rubber-banding. Combat behaviour
 *   is layered on top of that rather than replacing it, so hostiles stay in
 *   the playable airspace and inherit the difficulty tuning already in place.
 *
 * Aircraft frame convention (shared with renderer.js / player.js):
 *   nose = local -Z · up = local +Y · right wing = local +X
 */

import * as THREE from 'three';
import {
  WEAPONS_BY_ID, HEAVY_ORDER, GUN_ORDER, COMBAT, SCORE, PHYSICS, MACH, AIRCRAFT_BY_ID,
  RNG, clamp, clamp01, lerp, damp, TAU,
} from './config.js';
import { AIRacer } from './ai.js';
import { mergeGeometriesSafe } from './renderer.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _col = new THREE.Color();
const _scale = new THREE.Vector3();

const TRACER_CAP = 640;
const HEAVY_CAP = 40;

/* ===========================================================================
 * PROJECTILE RENDERING
 * ======================================================================== */

/**
 * Cannon tracers. One InstancedMesh, one draw call, per-instance colour so the
 * player's rounds and each enemy's rounds stay visually distinct.
 */
class TracerBatch {
  constructor(scene) {
    // A capsule scaled along -Z. Rounded rather than a box because a tracer is
    // a glowing bolt, not a plank, and the extra segments cost nothing at this
    // instance count. It is drawn deliberately fat: a physically-scaled 20 mm
    // round is a couple of pixels at combat range, which is invisible, and
    // invisible tracers make gunnery unreadable.
    const g = new THREE.CapsuleGeometry(1, 1.6, 3, 7);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, -0.5);
    const m = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(g, m, TRACER_CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TRACER_CAP * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.n = 0;
  }
  begin() { this.n = 0; }
  /** @param p world position · @param dir unit heading · @param len streak length */
  push(p, dir, len, width, color) {
    if (this.n >= TRACER_CAP) return;
    _q.setFromUnitVectors(_v3.set(0, 0, -1), dir);
    _scale.set(width, width, len);
    _m.compose(p, _q, _scale);
    this.mesh.setMatrixAt(this.n, _m);
    _col.set(color);
    this.mesh.setColorAt(this.n, _col);
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** Heavy rounds — missiles, laser-guided rounds, grenades and RPGs. */
class HeavyBatch {
  constructor(scene) {
    // A real missile silhouette — ogive nose, body tube and tail fins — at a
    // size that reads from the chase camera. Assembled by hand rather than
    // merged from three geometries so the whole thing stays one instanced
    // draw call.
    const parts = [];
    const nose = new THREE.ConeGeometry(1.15, 3.2, 10);
    nose.translate(0, 3.4, 0);
    parts.push(nose);
    const body = new THREE.CylinderGeometry(1.15, 1.15, 5.4, 10);
    body.translate(0, 1.1, 0);
    parts.push(body);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.BoxGeometry(0.25, 1.8, 2.2);
      fin.translate(0, -1.0, 1.5);
      fin.rotateY((i / 4) * Math.PI * 2);
      parts.push(fin);
    }
    const g = mergeGeometriesSafe(parts);
    g.rotateX(-Math.PI / 2);                    // nose along -Z
    const m = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mesh = new THREE.InstancedMesh(g, m, HEAVY_CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(HEAVY_CAP * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.n = 0;
  }
  begin() { this.n = 0; }
  push(p, dir, scale, color) {
    if (this.n >= HEAVY_CAP) return;
    _q.setFromUnitVectors(_v3.set(0, 0, -1), dir);
    _scale.setScalar(scale);
    _m.compose(p, _q, _scale);
    this.mesh.setMatrixAt(this.n, _m);
    _col.set(color);
    this.mesh.setColorAt(this.n, _col);
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/* ===========================================================================
 * MISSILE GUIDE PATH
 * ------------------------------------------------------------------------
 * The line the next guided round will fly, drawn before you commit to the
 * launch: a dotted lead-pursuit arc from the rail to where the target will be
 * when the weapon gets there. Green when the lock is solid, amber while it is
 * still acquiring.
 * ======================================================================== */

const GUIDE_DOTS = 26;

export class WeaponGuide {
  constructor(scene) {
    const g = new THREE.PlaneGeometry(5.5, 5.5);
    const m = new THREE.MeshBasicMaterial({
      color: 0x2fff8a, transparent: true, opacity: 0.85, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(g, m, GUIDE_DOTS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.visible = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.material = m;
    this._t = 0;
  }

  hide() { this.mesh.visible = false; this.mesh.count = 0; }

  /**
   * @param from   launch point (world)
   * @param toPos  target position (world)
   * @param toVel  target velocity, for the lead solution
   * @param weapon the weapon def about to be launched
   * @param locked true once the lock is solid
   */
  update(dt, from, toPos, toVel, weapon, locked, camera) {
    this._t += dt;
    // Lead: where the target will be when the round arrives.
    const range = from.distanceTo(toPos);
    const tof = range / Math.max(1, weapon.speed);
    _v.copy(toPos).addScaledVector(toVel, tof);
    // A guided round pulls a curve, not a straight line — bow the path toward
    // the aim point so the drawn guide matches what the weapon will actually do.
    _v2.copy(from).lerp(_v, 0.5);
    if (weapon.gravity) _v2.y -= weapon.gravity * tof * tof * 0.25;
    else _v2.addScaledVector(_v3.copy(toPos).sub(from).normalize(), range * 0.06);

    const n = GUIDE_DOTS;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      // Quadratic Bezier through the bowed mid-point.
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      _v3.set(
        from.x * a + _v2.x * b + _v.x * c,
        from.y * a + _v2.y * b + _v.y * c,
        from.z * a + _v2.z * b + _v.z * c,
      );
      // Dots march along the path so the direction of travel is unmistakable.
      const march = (t * 3.0 - this._t * 1.6) % 1;
      const pulse = 0.55 + 0.45 * Math.sin((march < 0 ? march + 1 : march) * TAU);
      const s = lerp(0.5, 2.6, t) * pulse * (locked ? 1 : 0.7);
      _q.setFromRotationMatrix(_m.lookAt(_v3, camera.position, camera.up));
      _scale.setScalar(s);
      _m.compose(_v3, _q, _scale);
      this.mesh.setMatrixAt(i, _m);
    }
    this.material.color.setHex(locked ? 0x2fff8a : 0xffc24a);
    this.material.opacity = locked ? 0.85 : 0.45;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = true;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/* ===========================================================================
 * ENEMY FIGHTER
 * ------------------------------------------------------------------------
 * An AIRacer that shoots back. It keeps the racer's path-space flight so it
 * stays inside the playable corridor, and layers on:
 *   · a livery recolour drawn from COMBAT.liveries
 *   · gun and heavy-weapon engagement with its own lock timer
 *   · formation slots, so a wave flies as a unit rather than a swarm
 *   · evasive and offensive manoeuvres scaled by difficulty
 * ======================================================================== */

/** Formation offsets in (lateral, vertical, distance) path space. */
const FORMATIONS = {
  // Classic finger-four: two pairs stepped back and out.
  finger: [[0, 0, 0], [90, 25, -110], [-95, -20, -120], [185, 45, -240]],
  // Line abreast — a wall the player has to break through.
  line: [[0, 0, 0], [150, 0, -20], [-150, 0, -20], [300, 10, -40]],
  // Trail — a queue, each covering the one ahead.
  trail: [[0, 0, 0], [20, -30, -180], [-20, 30, -360], [30, -50, -540]],
  // Pincer — split high and low, converging.
  pincer: [[0, 120, -60], [0, -120, -60], [200, 60, -140], [-200, -60, -140]],
};
const FORMATION_IDS = Object.keys(FORMATIONS);

export class EnemyFighter extends AIRacer {
  constructor(render, world, spec, archetype, difficulty, index, seed, opts = {}) {
    super(render, world, spec, archetype, difficulty, index, seed);
    const D = difficulty;

    this.isEnemy = true;
    this.livery = opts.livery ?? COMBAT.liveries[index % COMBAT.liveries.length];
    this.visual.recolour(this.livery);

    /* Callsign. Numbered from one in spawn order and stable for the life of the
     * sortie, so "Enemy 7" always means the same aircraft on the HUD, on the
     * radar and in the kill feed. */
    this.enemyNumber = index + 1;
    this.callsign = `ENEMY ${this.enemyNumber}`;

    /* Trail colour. The livery is deliberately saturated so the airframe reads
     * against terrain, but a trail in that colour disappears against a dark
     * world. This washes the livery most of the way to white: a pale ribbon
     * that holds up against sky, ground and city alike, and lets the player
     * read where a fighter has been from across the map. */
    this.trailColor = new THREE.Color(this.livery).lerp(new THREE.Color(0xffffff), 0.62).getHex();
    this.visual.setTrailColor?.(this.trailColor);

    this.maxHealth = COMBAT.enemyHealth * lerp(0.8, 1.5, spec.stats.durability) * lerp(0.8, 1.6, D.aiSkill);
    this.health = this.maxHealth;

    // Combat skill. Everything a hostile is good at scales off difficulty and
    // off the wave number, so wave 8 is a genuinely different opponent to wave 1.
    /* Engagement envelope. The old numbers were the reason hostiles read as
     * passive: a 1.5-2.6 km engage range is under two seconds of closure at
     * Mach 15, so a fighter was almost never inside its own firing window long
     * enough to shoot. Hostiles now engage at missile range and every term below
     * is driven by the difficulty the *user* picked, so Rookie is survivable and
     * Legend genuinely hunts. */
    const tier = clamp01((opts.tier || 0) / 10);
    this.accuracy = clamp01(lerp(0.40, 0.95, D.aiSkill) + tier * 0.22);
    this.fireRate = lerp(0.85, 2.30, D.aiAggression) * (1 + tier * 0.6);
    this.heavyChance = clamp01(lerp(0.40, 0.95, D.aiAggression) + tier * 0.25);
    this.engageRange = lerp(7000, 13000, D.aiSkill) * (1 + tier * 0.2);
    this.gunOpenRange = lerp(1500, 2400, D.aiSkill);
    this.evasion = clamp01(lerp(0.25, 0.85, D.aiSkill) + tier * 0.2);
    // Gun discipline: a poor pilot needs the pipper almost on the target, a good
    // one will take a deflection shot. This is the cone, in cosine.
    this.gunDisciplineCos = lerp(0.965, 0.86, D.aiSkill);

    this.gunTimer = this.rng.float(0.4, 2.4);
    this.heavyTimer = this.rng.float(2.5, 7.0);
    this.lockProgress = 0;
    this.manoeuvre = 0;              // seconds left in the current manoeuvre
    this.manoeuvreKind = null;
    this.manoeuvreTimer = this.rng.float(3, 10);
    this.formationSlot = opts.slot || 0;
    this.formationId = opts.formation || 'finger';
    this.tier = opts.tier || 0;

    // Top speed for a hostile is the same envelope the player flies. In the
    // speed-focused mode they are allowed all the way to the Mach 20 ceiling.
    this.topSpeed = Math.min(MACH.maxMs, this.topSpeed * (opts.speedFocus ? 1.42 : 1.0));
  }

  /** Slot offset for this fighter inside its formation. */
  formationOffset() {
    const f = FORMATIONS[this.formationId] || FORMATIONS.finger;
    return f[this.formationSlot % f.length];
  }

  /**
   * Combat overlay. Runs after the racing brain so it can bias the line
   * toward the player and decide when to shoot.
   * @returns {Array} shot requests for the CombatSystem to spawn
   */
  combatUpdate(dt, player, combat) {
    if (!this.alive || !player || !player.alive) return;
    const toPlayer = _v.copy(player.position).sub(this.position3);
    const range = toPlayer.length();
    this.rangeToPlayer = range;

    /* --- manoeuvres --------------------------------------------------------
     * Hostiles do not fly straight lines. They break, barrel-roll and yo-yo,
     * and the better the pilot the more often and the more committed. */
    this.manoeuvreTimer -= dt;
    if (this.manoeuvre > 0) {
      this.manoeuvre -= dt;
    } else if (this.manoeuvreTimer <= 0) {
      this.manoeuvreTimer = lerp(7, 2.2, this.evasion) * this.rng.float(0.7, 1.5);
      /* The move is chosen for the geometry it is actually in. Knife-fight
       * range gets defensive and rolling moves; the merge gets a break turn or
       * a high-G barrel roll; long range gets repositioning. */
      const kinds = range < 1200
        ? ['break', 'barrel', 'scissors', 'rollLeft', 'rollRight', 'splitS']
        : range < 4000
          ? ['barrel', 'yoyo', 'rollLeft', 'rollRight', 'highYoyo', 'break']
          : ['yoyo', 'climb', 'barrel', 'immelmann'];
      this.manoeuvreKind = kinds[this.rng.int(0, kinds.length - 1)];
      this.manoeuvre = this.rng.float(1.1, 2.4);
      this._manoeuvreSign = this.rng.next() < 0.5 ? -1 : 1;
      // A roll is a visible, committed thing — the airframe actually rotates.
      if (this.manoeuvreKind === 'rollLeft') this._manoeuvreSign = -1;
      if (this.manoeuvreKind === 'rollRight') this._manoeuvreSign = 1;
    }
    if (this.manoeuvre > 0) {
      const s = this._manoeuvreSign;
      const phase = this.manoeuvre * 4.0;
      switch (this.manoeuvreKind) {
        case 'break':                        // hard turn away, out of the gun line
          this.targetLateral += s * 340 * dt;
          this.targetVertical -= 90 * dt;
          break;
        case 'barrel':                       // rolling scissors around the axis
          this.targetLateral = Math.sin(phase) * 190 * s;
          this.targetVertical = Math.cos(phase) * 120 * s;
          break;
        case 'scissors':                     // flat weave to force an overshoot
          this.targetLateral = Math.sin(phase * 0.7) * 250 * s;
          break;
        case 'yoyo':                         // trade height for turn rate
          this.targetVertical += (phase > 4 ? 150 : -170) * dt;
          break;
        case 'highYoyo':                     // pull up and over to kill closure
          this.targetVertical += 210 * dt;
          this.targetLateral += s * 180 * dt;
          break;
        case 'climb':
          this.targetVertical += 180 * dt;
          break;
        /* Aileron rolls. `rollBias` is read by the visual so the model rotates
         * about its own axis rather than merely sliding sideways — a roll the
         * player cannot see is not a roll. */
        case 'rollLeft':
        case 'rollRight':
          this.rollBias = s * 5.2;
          this.targetLateral += s * 120 * dt;
          break;
        case 'splitS':                       // roll inverted and pull down and away
          this.rollBias = s * 4.4;
          this.targetVertical -= 260 * dt;
          this.targetLateral += s * 150 * dt;
          break;
        case 'immelmann':                    // climb, half roll, reverse
          this.rollBias = s * 3.2;
          this.targetVertical += 240 * dt;
          this.targetLateral -= s * 160 * dt;
          break;
        default: break;
      }
    } else {
      // Bleed the roll back off once the move is finished.
      this.rollBias = (this.rollBias || 0) * Math.max(0, 1 - dt * 3);
    }

    /* --- lock --------------------------------------------------------------
     * A hostile needs to hold the player in its seeker cone, exactly as the
     * player does, before a guided round will leave the rail. */
    _v2.set(0, 0, -1).applyQuaternion(this.quaternion);
    const cosAng = range > 1 ? toPlayer.dot(_v2) / range : 1;
    const inCone = cosAng > Math.cos((COMBAT.lockConeDeg * 1.4) * Math.PI / 180);
    if (inCone && range < this.engageRange * 1.8) {
      this.lockProgress = clamp01(this.lockProgress + dt / (COMBAT.lockTime * lerp(2.0, 0.7, this.accuracy)));
    } else {
      this.lockProgress = Math.max(0, this.lockProgress - dt * COMBAT.lockDecay);
    }

    /* --- guns --------------------------------------------------------------
     * Fired in bursts, and only when the pipper is genuinely near the target —
     * a hostile that hoses the sky continuously is noise, not pressure. The
     * cone it will take a shot through is its own gun discipline, so a better
     * pilot opens up on a deflection angle a poor one would not attempt. */
    this.gunTimer -= dt * this.fireRate;
    if (this.gunTimer <= 0 && inCone && range < this.gunOpenRange && cosAng > this.gunDisciplineCos) {
      this.gunTimer = lerp(1.5, 0.30, this.accuracy) * this.rng.float(0.8, 1.3);
      const burst = 3 + Math.round(this.accuracy * 7);
      combat.enemyBurst(this, player, burst);
    }

    /* --- heavy weapons -----------------------------------------------------
     * A hostile picks a weapon it can actually reach with: the round has to be
     * rated for the current range, exactly as the player's launch gate demands.
     * Without that filter they fire 8 km missiles from 12 km and every shot is
     * a guaranteed miss, which is indistinguishable from not shooting at all. */
    this.heavyTimer -= dt;
    if (this.heavyTimer <= 0 && this.lockProgress >= 1 && range < this.engageRange
        && this.rng.next() < this.heavyChance) {
      const usable = HEAVY_ORDER.filter((id) => (WEAPONS_BY_ID[id].range ?? 0) >= range);
      if (usable.length) {
        this.heavyTimer = lerp(7.5, 2.2, clamp01(this.fireRate / 2)) * this.rng.float(0.8, 1.4);
        const pick = usable[this.rng.int(0, usable.length - 1)];
        const w = WEAPONS_BY_ID[pick];
        combat.spawn(w, this.position3, this.quaternion, this, player, this.livery);
        combat.onEnemyLaunch?.(this, w);
      } else {
        this.heavyTimer = 0.8;             // too far for anything — try again soon
      }
    } else if (this.heavyTimer <= 0) {
      this.heavyTimer = 1.2;
    }
  }
}

/* ===========================================================================
 * COMBAT SYSTEM
 * ======================================================================== */

export class CombatSystem {
  constructor(render, world, audio, difficulty, opts = {}) {
    this.render = render;
    this.world = world;
    this.audio = audio;
    this.difficulty = difficulty;
    this.rng = new RNG(`${world.seed}:combat`);
    this.speedFocus = !!opts.speedFocus;

    this.tracers = new TracerBatch(render.scene);
    this.heavies = new HeavyBatch(render.scene);
    this.guide = new WeaponGuide(render.scene);

    /** @type {Array<Object>} live projectiles, both cannon and heavy */
    this.shots = [];
    this.enemies = [];
    this.events = [];

    // Player weapon state.
    this.gunIndex = 0;
    this.heavyIndex = 0;
    this.gunCooldown = 0;
    this.heavyCooldown = 0;
    this.lockProgress = 0;
    this.lockTarget = null;
    this.targetIndex = 0;

    this.wave = 0;
    this.waveTimer = 3;
    this.kills = 0;
    /* Hostiles are numbered for the life of the sortie, not per wave, so the
     * label over a fighter is stable and "Enemy 14" is always the same
     * aircraft. Killed slots are never reissued. */
    this._nextIndex = 0;
    /** Seconds until the director tops the squadron back up to the floor. */
    this._respawnTimer = 0;
    this._aimQ = new THREE.Quaternion();
  }

  get gunWeapon() { return WEAPONS_BY_ID[GUN_ORDER[this.gunIndex % GUN_ORDER.length]]; }
  get heavyWeapon() { return WEAPONS_BY_ID[HEAVY_ORDER[this.heavyIndex % HEAVY_ORDER.length]]; }
  get locked() { return this.lockProgress >= 1 && !!this.lockTarget; }

  cycleWeapon() {
    this.heavyIndex = (this.heavyIndex + 1) % HEAVY_ORDER.length;
    this.heavyCooldown = Math.max(this.heavyCooldown, 0.25);
    return this.heavyWeapon;
  }

  /** Step to the next gun. Cheap — swapping barrels is not a reload. */
  cycleGun() {
    this.gunIndex = (this.gunIndex + 1) % GUN_ORDER.length;
    this.gunCooldown = Math.max(this.gunCooldown, 0.12);
    return this.gunWeapon;
  }

  /**
   * Select a weapon by id. Unlike cycling, this does NOT stamp a cooldown —
   * the whole point of the per-weapon keys is that pressing one selects and
   * launches in a single action, and a switching penalty would make that
   * strictly worse than cycling to it.
   */
  selectWeapon(id) {
    const i = HEAVY_ORDER.indexOf(id);
    if (i < 0) return null;
    this.heavyIndex = i;
    return this.heavyWeapon;
  }

  /** Manual target step — cycles through everything currently in the cone. */
  cycleTarget(player) {
    const cands = this._candidates(player);
    if (!cands.length) return null;
    this.targetIndex = (this.targetIndex + 1) % cands.length;
    this.lockTarget = cands[this.targetIndex];
    this.lockProgress = Math.min(this.lockProgress, 0.35);
    return this.lockTarget;
  }

  /**
   * Hostiles the seeker can see.
   *
   * `hold` widens the cone: a target that is already locked stays locked
   * through a much harder angle than it took to acquire. Without that
   * hysteresis a lock breaks the instant either aircraft starts manoeuvring,
   * which at these speeds is always.
   */
  _candidates(player, hold = false) {
    const out = [];
    _v2.set(0, 0, -1).applyQuaternion(player.quaternion);
    const deg = hold ? COMBAT.lockHoldDeg : COMBAT.lockConeDeg;
    const cosLimit = Math.cos(deg * Math.PI / 180);
    const range = COMBAT.lockRange * (hold ? 1.35 : 1);
    for (const e of this.enemies) {
      if (!e.alive) continue;
      _v.copy(e.position3).sub(player.position);
      const d = _v.length();
      if (d > range || d < 1) continue;
      if (_v.dot(_v2) / d < cosLimit) continue;
      out.push(e);
    }
    // Nearest first, so a fresh lock always grabs the immediate threat.
    out.sort((a, b) => a.position3.distanceToSquared(player.position)
      - b.position3.distanceToSquared(player.position));
    return out;
  }

  /* =====================================================================
   * SQUADRON
   * ================================================================== */

  /**
   * Put a wave of hostiles in the air around the player.
   *
   * The squadron is held at `COMBAT.minEnemies` (20) rather than grown from
   * two: this is a battle, and a battle that opens with a pair and thins out
   * as you kill them is a chase. Each wave tops the airspace back up to the
   * floor and pushes a little past it as the fight escalates.
   *
   * Approach geometry is drawn per fighter from `COMBAT.approach`, so a wave
   * arrives from in front, behind, either side, the diagonals and above/below
   * at once — being bounced from three directions is the point.
   */
  spawnWave(playerDistance, specs) {
    this.wave++;
    const D = this.difficulty;
    // Formation discipline arrives with experience: early waves fly loose
    // pairs, later ones fly a proper four-ship.
    const formation = FORMATION_IDS[Math.min(FORMATION_IDS.length - 1,
      Math.floor(this.wave / 2)) % FORMATION_IDS.length];
    const live = this.enemies.filter((e) => e.alive).length;
    // Top back up to the floor, plus a slow climb above it as waves stack.
    const target = Math.min(COMBAT.maxEnemies,
      COMBAT.minEnemies + Math.floor(this.wave * 0.5) + Math.round(D.aiSkill * 2));
    const count = Math.max(0, target - live);

    for (let i = 0; i < count; i++) {
      const spec = specs[this.rng.int(0, specs.length - 1)];
      const arch = ENEMY_ARCHETYPES[this.rng.int(0, ENEMY_ARCHETYPES.length - 1)];
      const livery = COMBAT.liveries[this.rng.int(0, COMBAT.liveries.length - 1)];
      const e = new EnemyFighter(this.render, this.world, spec, arch, D,
        this._nextIndex++, this.world.seed, {
          livery, slot: i, formation, tier: this.wave, speedFocus: this.speedFocus,
        });
      const off = e.formationOffset();
      const a = this._approach(off);
      e.approach = a.kind;
      e.spawn(playerDistance + a.along, a.lateral, a.vertical);
      this.enemies.push(e);
    }
    this.events.push({ type: 'wave', wave: this.wave, count, formation });
    return count;
  }

  /**
   * Draw one approach geometry from the weighted table.
   *
   * Everything is expressed in the path space the AI already flies — distance
   * along the route, lateral offset, vertical offset — so a head-on merge is
   * simply a hostile placed well *ahead* of the player, closing. `speedFocus`
   * overrides the draw: in that mode they are the pack being chased, so they
   * are always in front.
   *
   * IMPROVED: In combat modes, enemies now ALWAYS spawn ahead of the player
   * to prevent immediate rear attacks at game start.
   *
   * @param {number[]} off the fighter's formation slot offset
   * @returns {{kind:string, along:number, lateral:number, vertical:number}}
   */
  _approach(off) {
    const jitterL = () => this.rng.float(-90, 90);
    const jitterV = () => this.rng.float(-60, 60);
    
    // ALWAYS spawn ahead in combat modes - no rear attacks at start
    if (this.speedFocus) {
      return {
        kind: 'lead',
        along: 1400 + off[2], lateral: off[0] + jitterL(), vertical: off[1] + jitterV(),
      };
    }
    
    const t = COMBAT.approach;
    let r = this.rng.next() * (t.head + t.side + t.diagonal + t.vertical);
    
    // HEAD-ON: Far ahead, random lateral/vertical spread
    if ((r -= t.head) < 0) {
      return {
        kind: 'head',
        along: this.rng.float(4200, 7000) + off[2],
        lateral: off[0] + this.rng.float(-260, 260), 
        vertical: off[1] + this.rng.float(-180, 180),
      };
    }
    
    // SIDE: Ahead and to the side, random direction
    if ((r -= t.side) < 0) {
      const s = this.rng.next() < 0.5 ? -1 : 1;
      return {
        kind: 'side',
        along: this.rng.float(800, 1600) + off[2],  // Always ahead
        lateral: off[0] + s * this.rng.float(900, 1800), 
        vertical: off[1] + jitterV(),
      };
    }
    
    // DIAGONAL: Ahead and diagonal approach
    if ((r -= t.diagonal) < 0) {
      const s = this.rng.next() < 0.5 ? -1 : 1;
      return {
        kind: 'diagonal',
        along: this.rng.float(1800, 3600) + off[2],
        lateral: off[0] + s * this.rng.float(700, 1500),
        vertical: off[1] + this.rng.float(-320, 320),
      };
    }
    
    // VERTICAL: Ahead and above/below
    const s = this.rng.next() < 0.5 ? -1 : 1;
    return {
      kind: 'vertical',
      along: this.rng.float(600, 1800) + off[2],  // Always ahead
      lateral: off[0] + jitterL(), 
      vertical: off[1] + s * this.rng.float(600, 1200),
    };
  }

  /**
   * Keep the airspace at strength between waves.
   *
   * A wave is a scripted arrival; this is the steady state. As kills come in
   * the squadron drops below `COMBAT.minEnemies`, and after a short delay
   * replacements join from a fresh approach direction. Without this the fight
   * decays into a chase after the first competent minute.
   *
   * @param {number} dt
   * @param {number} playerDistance the player's distance along the route
   * @param {Array}  specs airframe specs replacements may be issued
   * @returns {number} how many joined this frame
   */
  topUp(dt, playerDistance, specs) {
    if (!specs || !specs.length) return 0;
    const live = this.enemies.filter((e) => e.alive).length;
    if (live >= COMBAT.minEnemies) { this._respawnTimer = COMBAT.respawnDelay; return 0; }

    this._respawnTimer -= dt;
    if (this._respawnTimer > 0) return 0;
    this._respawnTimer = COMBAT.respawnDelay;

    // Replace a couple at a time — a whole squadron appearing at once reads as
    // a spawn, a trickle of reinforcements reads as a fight that keeps going.
    const D = this.difficulty;
    const join = Math.min(3, COMBAT.minEnemies - live);
    for (let i = 0; i < join; i++) {
      const spec = specs[this.rng.int(0, specs.length - 1)];
      const arch = ENEMY_ARCHETYPES[this.rng.int(0, ENEMY_ARCHETYPES.length - 1)];
      const livery = COMBAT.liveries[this.rng.int(0, COMBAT.liveries.length - 1)];
      const e = new EnemyFighter(this.render, this.world, spec, arch, D,
        this._nextIndex++, this.world.seed, {
          livery, slot: i, formation: 'finger', tier: this.wave, speedFocus: this.speedFocus,
        });
      const a = this._approach(e.formationOffset());
      e.approach = a.kind;
      e.spawn(playerDistance + a.along, a.lateral, a.vertical);
      this.enemies.push(e);
    }
    this.events.push({ type: 'reinforce', count: join });
    return join;
  }

  /* =====================================================================
   * FIRING
   * ================================================================== */

  /** Spawn one round. Shared by the player and every hostile. */
  spawn(weapon, position, quaternion, owner, target, color) {
    if (this.shots.length > TRACER_CAP + HEAVY_CAP) return null;
    const dir = _v.set(0, 0, -1).applyQuaternion(quaternion).clone();
    if (weapon.spread) {
      dir.x += (this.rng.next() - 0.5) * weapon.spread * 2;
      dir.y += (this.rng.next() - 0.5) * weapon.spread * 2;
      dir.normalize();
    }
    const shot = {
      weapon,
      pos: position.clone(),
      vel: dir.clone().multiplyScalar(weapon.speed),
      dir,
      life: weapon.life,
      owner,
      fromPlayer: !owner || owner.isPlayerSide === true,
      target: weapon.guided ? target : null,
      color: color ?? weapon.color,
      fuse: weapon.fuse || 0,
    };
    // A launched round inherits the launcher's own velocity, which is what
    // keeps it lined up with the pipper at Mach 15.
    if (owner && owner.velocity) shot.vel.addScaledVector(owner.velocity, 0.6);
    this.shots.push(shot);
    return shot;
  }

  /**
   * Player pulls the trigger. The rate of fire is 13 rounds/s and has to stay
   * 13 rounds/s: firing at most once per frame would tie the cannon to the
   * frame rate, so a machine running at 30 fps would do half the damage of one
   * running at 60. The cooldown therefore accumulates and the frame catches up
   * on whatever it owes, bounded so a long stall cannot dump a whole belt at
   * once.
   */
  playerFireGun(player, dt = 0) {
    if (this.gunCooldown > 0) return null;
    const w = this.gunWeapon;
    let fired = 0;
    const owed = Math.min(6, 1 + Math.floor(dt / w.cooldown));
    // Aim the burst at the locked target rather than straight down the nose:
    // at these closing speeds the lead angle is large, and expecting the pilot
    // to compute it by eye at Mach 15 is not a skill test, it is a lottery.
    const aim = this._gunAim(player, w);
    while (fired < owed) {
      const barrels = w.barrels === 1 ? [0] : [-1, 1];
      for (const side of barrels) {
        _v3.set(side * 1.5, -0.5, -4).applyQuaternion(player.quaternion).add(player.position);
        // Spread successive rounds down the flight path rather than stacking
        // them all on this frame's muzzle point.
        _v3.addScaledVector(player.velocity, -fired * w.cooldown);
        const s = this.spawn(w, _v3, aim, player, null, w.color);
        if (s) s.fromPlayer = true;
      }
      fired++;
      this.gunCooldown += w.cooldown;
    }
    // Muzzle flash: a short spray of sparks off each barrel plus a light
    // punch on the frame, so the guns register on screen and not only in the
    // tracer stream leaving it.
    _v.set(0, 0, -1).applyQuaternion(player.quaternion);
    for (const side of [-1, 1]) {
      _v3.set(side * 1.5, -0.5, -5).applyQuaternion(player.quaternion).add(player.position);
      this.render.vfx.sparkBurst(_v3, _v, 9, 0xfff2b0);
    }
    this.render.postfx.flash(0.055, 0xffe9a8);
    this.render.rig.addShake(w.id === 'heavygun' ? 0.16 : 0.06, 42);
    this.audio?.play(w.id === 'heavygun' ? 'heavyGunFire' : 'gunFire', { volume: 1 });
    return w;
  }

  /** Player launches the selected heavy weapon. */
  playerFireHeavy(player) {
    const w = this.heavyWeapon;
    if (this.heavyCooldown > 0) return null;
    // Guided rounds will not leave the rail without a lock — that is the whole
    // point of the lock, and telling the player why is better than a dead key.
    if (w.guided && !this.locked) {
      this.audio?.play('powerBlocked', { volume: 0.7 });
      this.events.push({ type: 'noLock', weapon: w });
      return null;
    }
    /* --- range gate --------------------------------------------------------
     * The distance is solved BEFORE the round is committed. Every heavy has a
     * rated reach (8/10/12/15 km) and firing beyond it would launch a weapon
     * that provably cannot arrive — the motor burns out short of the target.
     * Refusing the shot and saying why is better than a guaranteed miss. */
    const range = this.targetRange(player);
    if (w.guided && w.range && range != null && range > w.range) {
      this.audio?.play('powerBlocked', { volume: 0.7 });
      this.events.push({ type: 'outOfRange', weapon: w, distance: range, max: w.range });
      return null;
    }

    this.heavyCooldown = w.cooldown;
    _v3.set(0, -1.2, -3).applyQuaternion(player.quaternion).add(player.position);
    const s = this.spawn(w, _v3, player.quaternion, player, this.lockTarget, w.color);
    if (s) s.fromPlayer = true;

    /* --- launch ----------------------------------------------------------
     * The rail release is its own event: a bloom of motor exhaust at the
     * pylon, a wash of smoke dropping away under the aircraft, a flash tinted
     * to the weapon, and a shove on the camera. Without it the round simply
     * appears in front of you and the launch reads as nothing happening. */
    _v.set(0, 0, -1).applyQuaternion(player.quaternion);
    this.render.vfx.explode(_v3, 5, w.color);
    this.render.vfx.sparkBurst(_v3, _v.clone().negate(), 26, w.color);
    for (let i = 1; i <= 4; i++) {
      _v2.copy(_v3).addScaledVector(_v, -i * 7);
      this.render.vfx.smokePuff(_v2, 7, 5.5, 0xd2d7dc);
    }
    this.render.postfx.flash(0.20, w.color);
    this.render.rig.addShake(0.42, 20);

    this.audio?.play(w.id === 'grenade' ? 'grenadeThrow' : 'missileLaunch', { volume: 1 });
    this.events.push({ type: 'launch', weapon: w });
    return w;
  }

  /**
   * Firing solution for the guns.
   *
   * Returns a quaternion to spawn rounds along. With no lock this is simply
   * the nose. With a lock it is a *lead* solution — solved iteratively, because
   * the flight time depends on the range and the range depends on where the
   * target will be — blended in by how close the pipper already is to the
   * answer. That blend is what keeps it an assist rather than an aimbot: point
   * roughly at the target and the rounds converge, point somewhere else and
   * they go where you pointed.
   */
  _gunAim(player, weapon) {
    const t = this.lockTarget;
    if (!t || !t.alive) return player.quaternion;
    const tp = t.position3 || t.position;

    // Two iterations is plenty: the first gets the range right, the second
    // gets the lead right at that range.
    let tof = tp.distanceTo(player.position) / Math.max(1, weapon.speed);
    for (let i = 0; i < 2; i++) {
      _v.copy(tp).addScaledVector(t.velocity, tof).sub(player.position);
      tof = _v.length() / Math.max(1, weapon.speed);
    }
    if (weapon.gravity) _v.y += 0.5 * weapon.gravity * tof * tof;
    if (_v.lengthSq() < 1) return player.quaternion;
    _v.normalize();

    // How close is the nose already? Full assist when the target is inside the
    // pipper, none once it is well outside.
    _v2.set(0, 0, -1).applyQuaternion(player.quaternion);
    const align = clamp01((_v2.dot(_v) - Math.cos(COMBAT.gunAssistDeg * Math.PI / 180))
      / (1 - Math.cos(COMBAT.gunAssistDeg * Math.PI / 180)));
    if (align <= 0) return player.quaternion;

    _q.setFromUnitVectors(_v3.set(0, 0, -1), _v);
    return this._aimQ.copy(player.quaternion).slerp(_q, align * COMBAT.gunAssist);
  }

  /** A hostile squeezes off a burst at the player. */
  enemyBurst(enemy, player, rounds) {
    const w = WEAPONS_BY_ID.gun;
    // Aim error shrinks with accuracy: a poor pilot sprays, an ace leads you.
    const err = (1 - enemy.accuracy) * 0.055;
    for (let i = 0; i < rounds; i++) {
      _v3.copy(enemy.position3);
      // Lead the player rather than shooting where they are now.
      _v2.copy(player.position).addScaledVector(player.velocity,
        enemy.position3.distanceTo(player.position) / w.speed * enemy.accuracy);
      _v.copy(_v2).sub(_v3).normalize();
      _v.x += (this.rng.next() - 0.5) * err * 2;
      _v.y += (this.rng.next() - 0.5) * err * 2;
      _v.z += (this.rng.next() - 0.5) * err * 2;
      _v.normalize();
      this.shots.push({
        weapon: w, pos: _v3.clone(), vel: _v.clone().multiplyScalar(w.speed * 0.85),
        dir: _v.clone(), life: w.life, owner: enemy, fromPlayer: false,
        target: null, color: enemy.livery, fuse: 0,
        delay: i * 0.055,
      });
    }
    if (enemy.rangeToPlayer < 3000) {
      this.audio?.play('gunFireDistant', { volume: clamp01(1 - enemy.rangeToPlayer / 3000) * 0.5 });
    }
  }

  /* =====================================================================
   * FRAME
   * ================================================================== */

  /**
   * @param player the Player instance
   * @param input  {gun:boolean, heavy:boolean}
   */
  update(dt, player, input = {}) {
    this.gunCooldown = Math.max(0, this.gunCooldown - dt);
    this.heavyCooldown = Math.max(0, this.heavyCooldown - dt);

    if (player && player.alive) {
      this._updateLock(dt, player);
      if (input.gun) this.playerFireGun(player, dt);
      if (input.heavy) this.playerFireHeavy(player);
    }

    this._updateEnemies(dt, player);
    this._updateShots(dt, player);
    this._updateGuide(dt, player);
  }

  _updateLock(dt, player) {
    if (this.lockTarget && !this.lockTarget.alive) this.lockTarget = null;

    // AUTOMATIC TARGET LOCK: Always acquire the nearest enemy automatically
    // Continuously update to the nearest target, even at ultra-high speeds
    const allCandidates = this._candidates(player, false);
    const nearest = allCandidates[0] || null;

    // Switch to nearest if we have no target or if a closer threat appears
    if (nearest && (!this.lockTarget || nearest !== this.lockTarget)) {
      const wasLocked = this.lockProgress >= 1;
      this.lockTarget = nearest;
      
      // Fast acquisition for new targets - improved for high-speed precision
      if (!wasLocked) {
        this.lockProgress = Math.min(0.35, this.lockProgress);
      }
      
      // Fire "TARGET ACQUIRED" event when locking a new target
      if (this.lockProgress < 1) {
        this.events.push({ type: 'targetAcquired', target: this.lockTarget });
      }
    }

    // An existing lock is tested against the WIDE cone for stability
    const held = this.lockTarget && this._candidates(player, true).includes(this.lockTarget);
    if (!held) {
      this.lockTarget = null;
      this.lockProgress = Math.max(0, this.lockProgress - dt * COMBAT.lockDecay);
    }

    if (this.lockTarget) {
      const was = this.lockProgress;
      // Faster lock time at high speeds - improved accuracy and precision
      const speedBonus = player.mach > 10 ? 1.5 : 1.0;
      this.lockProgress = clamp01(this.lockProgress + dt / (COMBAT.lockTime / speedBonus));
      
      if (was < 1 && this.lockProgress >= 1) {
        this.audio?.play('lockTone', { volume: 0.8 });
        this.events.push({ type: 'lock', target: this.lockTarget });
      }
    } else {
      this.lockProgress = Math.max(0, this.lockProgress - dt * COMBAT.lockDecay);
    }
  }

  _updateEnemies(dt, player) {
    for (const e of this.enemies) {
      e.update(dt, player);
      if (e.alive) e.combatUpdate(dt, player, this);
    }
    // Sweep the dead once their wreck has hit the ground, so a long sortie
    // does not accumulate hundreds of inert objects.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.alive) {
        e.deadFor = (e.deadFor || 0) + dt;
        if (e.deadFor > 7) { e.dispose(); this.enemies.splice(i, 1); }
      }
    }
  }

  _updateShots(dt, player) {
    this.tracers.begin();
    this.heavies.begin();

    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      if (s.delay > 0) { s.delay -= dt; continue; }
      const w = s.weapon;

      /* --- guidance ------------------------------------------------------
       * The seeker flies at where the target WILL be, not where it is. Pure
       * pursuit — steering at the current position — makes a missile chase its
       * target's tail and lose the tail chase whenever the target is faster
       * than the closing margin, which at Mach 15 is most of the time. Solving
       * the intercept instead is the difference between a weapon and a firework.
       * The turn-rate cap still applies, so an impossible geometry still misses. */
      if (w.guided && s.target && s.target.alive) {
        const tp = s.target.position3 || s.target.position;
        const speed = s.vel.length();
        _v.copy(tp).sub(s.pos);
        let tof = _v.length() / Math.max(1, speed);
        for (let k = 0; k < 2; k++) {
          _v.copy(tp).addScaledVector(s.target.velocity, tof).sub(s.pos);
          tof = _v.length() / Math.max(1, speed);
        }
        const d = _v.length();
        s.range = d;             // live miss distance, read by the HUD readout
        if (d < (s.closest ?? Infinity)) s.closest = d;
        if (d > 1) {
          _v.divideScalar(d);
          _v2.copy(s.vel).divideScalar(speed || 1);
          /* Terminal homing: the seeker gets sharper as it closes, which is what
           * stops a near-miss at the last hundred metres. `precision` scales
           * both how hard it can pull and how early the terminal phase starts,
           * so the laser round (1.0) converges from much further out than the
           * cluster charge (0.62) and effectively cannot be out-turned. */
          const p = w.precision ?? 0.8;
          const terminal = 1 + clamp01(1 - d / (700 + p * 1800)) * (1.6 + p * 3.4);
          const maxTurn = w.turnRate * terminal * dt;
          const cosA = clamp(_v2.dot(_v), -1, 1);
          const ang = Math.acos(cosA);
          const t = ang > 1e-4 ? Math.min(1, maxTurn / ang) : 1;
          _v2.lerp(_v, t).normalize();
          s.vel.copy(_v2).multiplyScalar(speed);
          s.dir.copy(_v2);
        }
      } else if (w.guided && (!s.target || !s.target.alive)) {
        s.target = null;                  // seeker went blind; it flies straight
      }
      if (w.gravity) s.vel.y -= w.gravity * dt;

      s.pos.addScaledVector(s.vel, dt);
      if (!w.guided && !w.gravity) s.dir.copy(s.vel).normalize();
      s.life -= dt;

      /* --- hits ---------------------------------------------------------- */
      let hit = null;
      if (s.fromPlayer) {
        for (const e of this.enemies) {
          if (!e.alive) continue;
          if (s.pos.distanceToSquared(e.position3) < w.radius * w.radius) { hit = e; break; }
        }
      } else if (player && player.alive) {
        if (s.pos.distanceToSquared(player.position) < w.radius * w.radius) hit = player;
      }

      // A fused round (the grenade) goes off on its timer even if it misses.
      const fused = w.fuse && (w.life - s.life) >= w.fuse;
      const ground = this._hitGround(s);
      if (hit || fused || s.life <= 0 || ground) {
        /* A heavy round always detonates somewhere: on the target, on the
         * ground, on a building, or when the motor burns out. Only tracers are
         * allowed to simply stop existing. Terrain and structure impacts get
         * the full fireball too — that is the point of "explodes on buildings,
         * ground and other obstacles". */
        if (hit || fused || !w.tracer) this._detonate(s, hit, player, ground);
        /* --- outcome report ----------------------------------------------
         * Every heavy the *player* launched resolves to exactly one verdict, so
         * the HUD can say Target Hit or Target Missed and never both or
         * neither. A splash kill still counts as a hit: the round did its job.
         * `closest` is how near it got, which is the honest thing to show on a
         * miss. */
        if (s.fromPlayer && !w.tracer && !s.reported) {
          s.reported = true;
          const splashed = !hit && s.target && s.target.alive !== false
            && (w.blast || 0) > 0 && (s.closest ?? Infinity) <= w.blast;
          this.events.push({
            type: (hit || splashed) ? 'targetHit' : 'targetMissed',
            weapon: w,
            target: s.target || hit || null,
            distance: s.closest ?? null,
            cause: hit ? 'direct' : splashed ? 'splash' : ground ? 'ground' : 'expired',
          });
        }
        this.shots.splice(i, 1);
        continue;
      }

      /* --- draw ---------------------------------------------------------- */
      if (w.tracer) {
        // Streak length scales with how far the round moved this frame, which
        // is what makes a tracer look like a tracer at any frame rate. Both
        // length and width are far larger than a real 20 mm round: at these
        // closing speeds a physically-scaled tracer is sub-pixel, and gunnery
        // you cannot see is gunnery you cannot aim.
        const len = clamp(s.vel.length() * dt * 1.8, 34, 150);
        this.tracers.push(s.pos, s.dir, len, s.fromPlayer ? 2.6 : 2.0, s.color);
      } else {
        // Motor burn: the round grows briefly as it lights, then settles.
        const age = w.life - s.life;
        const boostFlare = 1 + Math.max(0, 0.55 - age) * 1.6;
        this.heavies.push(s.pos, s.dir,
          (w.id === 'grenade' ? 2.4 : 3.6) * boostFlare, s.color);
        // Guided and rocket rounds leave a burning motor plume: a bright core
        // right at the nozzle and cooling smoke behind it.
        // Emission rate is capped rather than per-frame: a plume this dense
        // costs a few hundred live particles per round, and four rounds in the
        // air must not be able to drain the whole budget.
        s.smokeT = (s.smokeT || 0) - dt;
        if (s.smokeT <= 0) {
          s.smokeT = 0.055;
          _v3.copy(s.pos).addScaledVector(s.dir, -6);
          this.render.vfx.smokePuff(_v3, w.beam ? 2 : 3, w.beam ? 2.4 : 5.0,
            w.beam ? 0x9fe8ff : 0xc2c8cf);
          if (age < 1.2) {
            this.render.vfx.sparkBurst(_v3, s.dir.clone().negate(), 4,
              w.beam ? 0x9fe8ff : 0xffb057);
          }
        }
      }
    }

    this.tracers.end();
    this.heavies.end();
  }

  _hitGround(s) {
    const g = this.world.terrainHeight(s.pos.x, s.pos.z);
    return s.pos.y <= g + 2;
  }

  _detonate(s, hit, player, ground = false) {
    const w = s.weapon;
    const blast = w.blast || 0;
    if (w.tracer) {
      // A cannon strike is a spark shower, not a fireball.
      this.render.vfx.sparkBurst(s.pos, s.dir, 14, 0xffd27a);
      if (hit) this.render.vfx.explode(s.pos, 2.5, 0xffb063);
    } else {
      /* A warhead going off is layered: the white-hot flash of the charge, the
       * fireball expanding behind it, a ring of secondary fireballs that give
       * the blast real width, and the smoke column that hangs there afterwards.
       * Doing all of it is what makes it read as a detonation rather than a
       * puff — and these are big warheads, so the scale is generous. */
      const scale = clamp(blast * 0.22, 26, 96);
      this.render.vfx.explode(s.pos, scale * 1.15, 0xffffff);
      this.render.vfx.explode(s.pos, scale, 0xfff0c0);
      this.render.vfx.explode(s.pos, scale * 0.72, s.color);
      this.render.vfx.sparkBurst(s.pos, null, 96, 0xffc06a);
      this.render.vfx.sparkBurst(s.pos, null, 44, 0xffffff);

      // Secondary fireballs around the core, so the blast has a footprint.
      for (let i = 0; i < 6; i++) {
        _v2.set(this.rng.next() - 0.5, this.rng.next() * 0.4, this.rng.next() - 0.5)
          .normalize().multiplyScalar(scale * (0.5 + this.rng.next() * 0.7)).add(s.pos);
        this.render.vfx.explode(_v2, scale * (0.28 + this.rng.next() * 0.3), s.color);
      }
      // Smoke column: rises, because a fireball this size draws air up with it.
      for (let i = 0; i < 14; i++) {
        _v2.set((this.rng.next() - 0.5) * 1.4, this.rng.next() * 1.5, (this.rng.next() - 0.5) * 1.4)
          .multiplyScalar(scale * 1.5).add(s.pos);
        this.render.vfx.smokePuff(_v2, 11, scale * 0.8, 0x45454a);
      }
      /* A ground or structure strike throws debris and dust outward along the
       * surface instead of spherically, which is what distinguishes hitting a
       * building from killing an aircraft. */
      if (ground || !hit) {
        for (let i = 0; i < 10; i++) {
          const a = this.rng.next() * Math.PI * 2;
          _v.set(Math.cos(a), 0.35 + this.rng.next() * 0.5, Math.sin(a));
          _v2.copy(s.pos).addScaledVector(_v, scale * 0.7);
          this.render.vfx.sparkBurst(_v2, _v, 12, 0xffbf6a);
          this.render.vfx.smokePuff(_v2, 10, scale * 0.7, ground ? 0x6b5f4e : 0x50505a);
        }
      }

      // Felt from the cockpit if it went off anywhere near you.
      const near = player ? clamp01(1 - s.pos.distanceTo(player.position) / 2200) : 0;
      if (near > 0.02) {
        this.render.postfx.flash(0.62 * near, 0xffb570);
        this.render.rig.addShake(1.9 * near, 16);
      }
      this.audio?.play('explosion', { volume: clamp01(0.6 + w.damage / 110) });
    }

    const apply = (victim, amount) => {
      if (!victim || amount <= 0) return;
      if (victim === player) {
        player.applyCombatDamage?.(amount, s.pos);
        this.events.push({ type: 'playerHit', amount, weapon: w });
      } else {
        const before = victim.alive;
        victim.damage(amount);
        this.events.push({ type: 'hit', weapon: w, amount, target: victim, fromPlayer: s.fromPlayer });
        if (before && !victim.alive && s.fromPlayer) {
          this.kills++;
          this.events.push({ type: 'kill', target: victim, weapon: w });
        }
      }
    };

    if (hit) apply(hit, w.damage);
    // Splash: everything inside the blast radius takes falloff damage.
    if (blast > 0) {
      const victims = s.fromPlayer ? this.enemies : (player ? [player] : []);
      for (const v of victims) {
        if (v === hit) continue;
        if (v.alive === false) continue;
        const p = v.position3 || v.position;
        const d = s.pos.distanceTo(p);
        if (d > blast) continue;
        apply(v, w.damage * (1 - d / blast) * 0.6);
      }
    }
  }

  _updateGuide(dt, player) {
    // The guide draws the path the *next* heavy round will fly, so the player
    // can see whether the shot is on before committing to it.
    const w = this.heavyWeapon;
    if (!player || !player.alive || !this.lockTarget || !this.lockTarget.alive) {
      this.guide.hide();
      return;
    }
    _v3.set(0, -1.2, -3).applyQuaternion(player.quaternion).add(player.position);
    this.guide.update(dt, _v3, this.lockTarget.position3, this.lockTarget.velocity,
      w, this.locked, this.render.camera);
  }

  drainEvents() { const e = this.events.slice(); this.events.length = 0; return e; }

  /**
   * Metres to the locked target, or null with no lock. This is the number the
   * launch gate tests and the HUD shows beside the lock reticle, so both agree
   * on the range by construction.
   * @param {object} player
   * @returns {number|null}
   */
  targetRange(player) {
    const t = this.lockTarget;
    if (!player || !t || t.alive === false) return null;
    return player.position.distanceTo(t.position3 || t.position);
  }

  /** True when the locked target is inside the selected heavy's rated reach. */
  targetInRange(player) {
    const w = this.heavyWeapon;
    const d = this.targetRange(player);
    if (d == null || !w?.range) return false;
    return d <= w.range;
  }

  /**
   * Every heavy round the player currently has in the air, with how far it
   * still has to fly. The HUD draws one distance label per round, above the
   * missile, so the player can watch the gap close.
   * @returns {Array<{pos:object, range:number|null, color:number, weapon:object}>}
   */
  liveMissiles() {
    const out = [];
    for (const s of this.shots) {
      if (s.weapon.tracer || !s.fromPlayer) continue;
      out.push({ pos: s.pos, range: s.range ?? null, color: s.color, weapon: s.weapon });
    }
    return out;
  }

  /** Live enemies, for the HUD target boxes and speed labels. */
  liveEnemies() { return this.enemies.filter((e) => e.alive); }

  dispose() {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    this.shots.length = 0;
    this.tracers.dispose();
    this.heavies.dispose();
    this.guide.dispose();
  }
}

/* Enemy personalities. Deliberately more aggressive than the racing set — a
 * hostile that flies a clean racing line is not a threat.
 *
 * These MUST carry the full archetype field set, not just the combat-relevant
 * ones. The flight brain they inherit reads `lineWander`, `blockChance`,
 * `risk`, `boostGreed` and `drafting`, and a missing field does not read as
 * zero — it reads as `lerp(a, b, undefined)`, which is NaN. That NaN went
 * straight into `targetLateral`, from there into every enemy's world position,
 * and from there into locking, hit tests, target boxes and the kill effects.
 * Hostiles were flying at coordinates that do not exist. */
const ENEMY_ARCHETYPES = [
  {
    id: 'hunter', name: 'Hunter', skill: 0.78, aggression: 0.90, risk: 0.75,
    speedBias: 1.02, agilityBias: 1.06,
    lineWander: 0.55, blockChance: 0.40, boostGreed: 0.75, mistakeBias: 0.7, drafting: 0.7,
  },
  {
    id: 'ace', name: 'Ace', skill: 0.94, aggression: 0.78, risk: 0.62,
    speedBias: 1.05, agilityBias: 1.12,
    lineWander: 0.30, blockChance: 0.30, boostGreed: 0.80, mistakeBias: 0.35, drafting: 0.85,
  },
  {
    id: 'brawler', name: 'Brawler', skill: 0.62, aggression: 1.00, risk: 0.90,
    speedBias: 0.98, agilityBias: 0.94,
    lineWander: 0.75, blockChance: 0.55, boostGreed: 0.90, mistakeBias: 1.1, drafting: 0.4,
  },
  {
    id: 'sniper', name: 'Sniper', skill: 0.86, aggression: 0.55, risk: 0.40,
    speedBias: 1.08, agilityBias: 0.90,
    lineWander: 0.22, blockChance: 0.15, boostGreed: 0.55, mistakeBias: 0.5, drafting: 0.6,
  },
  {
    id: 'wingman', name: 'Wingman', skill: 0.70, aggression: 0.66, risk: 0.55,
    speedBias: 1.00, agilityBias: 1.00,
    lineWander: 0.42, blockChance: 0.28, boostGreed: 0.6, mistakeBias: 0.8, drafting: 0.75,
  },
];
