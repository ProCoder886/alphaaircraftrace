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
  squadronSize, RNG, clamp, clamp01, lerp, damp, TAU,
} from './config.js';
import { AIRacer } from './ai.js';
import { mergeGeometriesSafe } from './renderer.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
/* Dedicated, NOT one of the shared three above: the shot broadphase holds this
 * across a loop whose body calls `_sweepHit`, which clobbers _v2 and _v3. */
const _mid = new THREE.Vector3();
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
/* ===========================================================================
 * FORMATIONS
 * ------------------------------------------------------------------------
 * Slot offsets as [lateral, vertical, along] in metres at FULL COMBAT SPREAD.
 * Nothing flies at these numbers directly: `COMBAT.formationScale` multiplies
 * every one of them at the point of use, and the table is written unscaled so
 * the shapes stay readable as geometry and the tightness stays one edit.
 *
 * The figures below are the honest ones — a real finger-four is kilometres
 * across. Flown at full scale, though, a wing is spread wider than the radar
 * has rings: each fighter is a lone dot nowhere near its own wingmen, the
 * shape is invisible, and there is nothing to read. Scaling the whole table
 * keeps the geometry — the stepped pairs, the wall with no way through the
 * middle, the ring that comes from every bearing — and brings the wing down to
 * something that arrives as a CLUSTER, which is the thing the player is
 * actually meant to see coming and then pick apart.
 *
 * Eight formations, not four, and they are drawn per wave, so a squadron
 * arrives with a shape you have to read rather than a wall you memorise.
 * ======================================================================== */
const FORMATIONS = {
  /* Finger-four at combat spread: two pairs stepped back and out. */
  finger: [
    [0, 0, 0], [7400, 900, -3200], [-7800, -700, -3600], [15200, 1600, -7400],
    [-15600, -1400, -7800], [22000, 500, -11000],
  ],
  /* Line abreast — a wall eight kilometres wide, no way through the middle. */
  line: [
    [0, 0, 0], [8000, 0, -600], [-8000, 0, -600], [16000, 400, -1200],
    [-16000, -400, -1200], [24000, 0, -1800],
  ],
  /* Trail — a queue, each covering the one ahead, strung down the route. */
  trail: [
    [0, 0, 0], [900, -1100, -8000], [-900, 1200, -16000], [1200, -1500, -24000],
    [-1200, 1400, -32000], [0, 0, -40000],
  ],
  /* Pincer — split high and low, converging on the merge. */
  pincer: [
    [0, 4200, -3000], [0, -4200, -3000], [8600, 2600, -7000], [-8600, -2600, -7000],
    [17000, 3400, -12000], [-17000, -3400, -12000],
  ],
  /* Box — four corners of a ten-kilometre cube, and you are inside it. */
  box: [
    [7500, 3600, 4000], [-7500, 3600, 4000], [7500, -3600, -4000], [-7500, -3600, -4000],
    [9500, 0, 0], [-9500, 0, 0],
  ],
  /* Wall — a vertical curtain: same ground track, stacked through the block. */
  wall: [
    [0, 0, 0], [1800, 5200, -900], [-1800, -5200, -900], [3600, 10000, -1800],
    [-3600, -10000, -1800], [0, 15000, -2600],
  ],
  /* Echelon — a diagonal stair, so the whole wing has a shot down the line. */
  echelon: [
    [0, 0, 0], [7200, 1800, -5400], [14400, 3600, -10800], [21600, 5400, -16200],
    [28800, 7200, -21600], [36000, 9000, -27000],
  ],
  /* Encirclement — six bearings on a nine-kilometre ring, every direction at
   * once. The one the brief calls the hardest merge in the game. */
  ring: [
    [9000, 0, 0], [4500, 3000, -7800], [-4500, 3000, -7800],
    [-9000, 0, 0], [-4500, -3000, 7800], [4500, -3000, 7800],
  ],
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
    /* The engagement envelope follows the weapons and the spacing. Hostiles
     * now sit seven to ten kilometres apart and carry rounds rated for fifty,
     * so a thirteen-kilometre engage range meant most of the squadron was
     * outside its own firing window for the whole sortie — which reads as a
     * squadron that will not fight. */
    this.engageRange = lerp(24000, 48000, D.aiSkill) * (1 + tier * 0.2);
    this.gunOpenRange = lerp(5000, 9000, D.aiSkill);
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
    /* --- the reversal ------------------------------------------------------
     * `uTurn` counts down a committed 180. Nothing else may interrupt it: a
     * half-finished reversal is an aircraft flying sideways. `uTurnCooldown`
     * stops a hostile that is merely holding station from flip-flopping. */
    this.uTurn = 0;
    this.uTurnCooldown = this.rng.float(1.5, 5.0);
    this.uTurnFlipped = false;
    this.formationSlot = opts.slot || 0;
    this.formationId = opts.formation || 'finger';
    this.tier = opts.tier || 0;

    // Top speed for a hostile is the same envelope the player flies. In the
    // speed-focused mode they are allowed all the way to the Mach 30 ceiling.
    /* Endless Race: the pack is capped at the player's nitrous ceiling rather
     * than given half again its own top speed. At 1.42x every hostile ran
     * Mach 28-30 against an airframe that does Mach 22 dry, so the gap opened
     * whatever the player flew and the race was unwinnable on a long enough
     * timescale. Capped here, the speed ladder becomes the mode: dry loses
     * ground, nitrous holds station, nitrous and Turbo together close. */
    this.topSpeed = opts.speedFocus
      ? Math.min(MACH.msPerMach * COMBAT.paceMach, this.topSpeed * 1.42)
      : Math.min(MACH.maxMs, this.topSpeed);

    /* A hostile is not a racer and does not belong in the corridor. The
     * corridor cap would pull a formation spread over seven kilometres back
     * onto the centre line within a second of spawning, which is exactly the
     * saturated blob the spread exists to prevent. */
    this.offsetCap = 90000;
    this.drawRange = COMBAT.enemyDrawRange;
    /* The slot this fighter holds, in path space. Written by `spawn` and read
     * every frame by `_station` below. */
    this.stationLateral = 0;
    this.stationVertical = 0;
    this._stationOut = { lateral: 0, vertical: 0 };
  }

  /** Slot offset for this fighter inside its formation. */
  /**
   * Slot offset for this fighter inside its formation.
   *
   * The table is written at full combat spread and flown at
   * `COMBAT.formationScale` of it, so every shape keeps its geometry while a
   * wing arrives as a cluster you can read on the radar instead of a scatter
   * of unrelated dots several rings apart.
   */
  formationOffset() {
    const f = FORMATIONS[this.formationId] || FORMATIONS.finger;
    const base = f[this.formationSlot % f.length];
    const wing = Math.floor(this.formationSlot / f.length);
    const k = COMBAT.formationScale;
    if (!wing) return [base[0] * k, base[1] * k, base[2] * k];
    /* Wings past the first repeat the shape one element further out and one
     * further back, alternating sides — a squadron of thirty does not fit in a
     * six-slot table. The repeat steps are scaled by the same factor as the
     * table itself, or the second wing would sit ten kilometres off a shape
     * that is now one and a half across, and the cluster would be a cluster
     * plus a scattering of strays. */
    const side = wing % 2 ? 1 : -1;
    const step = Math.ceil(wing / 2);
    return [
      (base[0] + side * step * 4200) * k,
      (base[1] + side * step * 900) * k,
      (base[2] - step * 3600) * k,
    ];
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

    /* --- the U-turn --------------------------------------------------------
     * A hostile flies the route in path space, and path space only ran one
     * way: distance-along could increase and nothing else. A fighter that
     * overshot the player on the merge therefore flew off down the route
     * forever and the fight decayed into a tail chase against whatever had not
     * yet passed you. That is the single biggest thing wrong with the old
     * squadron, and the fix is that a hostile can now reverse.
     *
     * The reversal is a COMMITTED manoeuvre, not a sign flip: it takes a
     * couple of seconds, it rolls the airframe most of the way inverted, it
     * pulls the nose through the vertical, and the direction actually changes
     * halfway through — so what the player sees is a fighter pulling round
     * onto them, not a model that suddenly faces the other way. */
    this.uTurnCooldown = Math.max(0, this.uTurnCooldown - dt);
    if (this.uTurn > 0) {
      this.uTurn -= dt;
      const s = this._uTurnSign;
      // Hard roll and a big pull: this is the most visible thing a hostile does.
      this.rollBias = s * 6.4;
      this.targetLateral += s * 900 * dt;
      this.targetVertical += (this.uTurn > this._uTurnHalf ? 420 : -300) * dt;
      // The flip lands at the top of the pull, where a real reversal happens.
      if (!this.uTurnFlipped && this.uTurn <= this._uTurnHalf) {
        this.uTurnFlipped = true;
        this.pathDir = -this.pathDir;
      }
      if (this.uTurn <= 0) {
        this.uTurn = 0;
        this.uTurnCooldown = this.rng.float(5, 11);
      }
    } else if (this.uTurnCooldown <= 0 && player.alive) {
      /* Turn back when the player is a long way behind you on the route and
       * you are still flying away from them — or, flying backwards, when they
       * have got a long way ahead again. The threshold is generous because a
       * hostile at Mach 25 covers a kilometre in a second and a hair trigger
       * would have the whole squadron pirouetting on the spot. */
      const gap = (player.distanceAlong - this.distanceAlong) * this.pathDir;
      if (gap < -this._uTurnGap()) {
        this.uTurn = this.rng.float(1.9, 2.8);
        this._uTurnHalf = this.uTurn * 0.5;
        this.uTurnFlipped = false;
        this._uTurnSign = this.rng.next() < 0.5 ? -1 : 1;
        this.manoeuvre = 0;                  // a reversal outranks everything
        this.manoeuvreTimer = this.rng.float(1.5, 3.5);
      }
    }

    /* --- manoeuvres --------------------------------------------------------
     * Hostiles do not fly straight lines. They break, barrel-roll and yo-yo,
     * and the better the pilot the more often and the more committed. */
    if (this.uTurn > 0) return this._fireControl(dt, player, combat, toPlayer, range);
    this.manoeuvreTimer -= dt;
    if (this.manoeuvre > 0) {
      this.manoeuvre -= dt;
    } else if (this.manoeuvreTimer <= 0) {
      this.manoeuvreTimer = lerp(7, 2.2, this.evasion) * this.rng.float(0.7, 1.5);
      /* The move is chosen for the geometry it is actually in. Knife-fight
       * range gets defensive and rolling moves; the merge gets a break turn or
       * a high-G barrel roll; long range gets repositioning. */
      /* The menu is chosen for the geometry the fighter is actually in.
       * Knife-fight range gets defensive and rolling moves, the merge gets a
       * break turn or a high-G barrel roll, and long range gets repositioning
       * — plus, at every range, the full-axis rolls the PLAYER flies on Q and
       * E, so a hostile rotating right through 360 degrees is something you
       * see them do rather than something only you can do. */
      const kinds = range < 2500
        ? ['break', 'barrel', 'scissors', 'aileronLeft', 'aileronRight', 'splitS',
           'rollLeft', 'rollRight', 'defensiveSpiral', 'jink']
        : range < 9000
          ? ['barrel', 'yoyo', 'rollLeft', 'rollRight', 'highYoyo', 'break',
             'aileronLeft', 'aileronRight', 'lowYoyo', 'jink']
          : ['yoyo', 'climb', 'barrel', 'immelmann', 'aileronLeft', 'aileronRight',
             'chandelle', 'dive'];
      this.manoeuvreKind = kinds[this.rng.int(0, kinds.length - 1)];
      this.manoeuvre = this.rng.float(1.1, 2.4);
      this._manoeuvreSign = this.rng.next() < 0.5 ? -1 : 1;
      // A roll is a visible, committed thing — the airframe actually rotates.
      if (this.manoeuvreKind === 'rollLeft' || this.manoeuvreKind === 'aileronLeft') this._manoeuvreSign = -1;
      if (this.manoeuvreKind === 'rollRight' || this.manoeuvreKind === 'aileronRight') this._manoeuvreSign = 1;
      // A full-axis roll is timed to complete a whole revolution.
      if (this.manoeuvreKind === 'aileronLeft' || this.manoeuvreKind === 'aileronRight') {
        this.manoeuvre = this.rng.float(1.4, 2.0);
        this._rollTotal = this.manoeuvre;
      }
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
        /* --- full-axis rolls -------------------------------------------
         * The Q and E roll the player flies: the airframe rotates all the way
         * round its own nose. `rollBias` is fed a continuously advancing angle
         * rather than a constant, so the model actually revolves through 360
         * degrees over the manoeuvre instead of holding a steep bank. */
        case 'aileronLeft':
        case 'aileronRight': {
          const done = 1 - clamp01(this.manoeuvre / Math.max(0.01, this._rollTotal || 1));
          this.rollBias = s * done * TAU;
          this.targetLateral += s * 60 * dt;
          break;
        }
        case 'lowYoyo':                      // unload, dive, cut the corner
          this.targetVertical -= 260 * dt;
          this.targetLateral += s * 210 * dt;
          this.rollBias = s * 2.2;
          break;
        case 'chandelle':                    // climbing reversal, bleeding speed
          this.rollBias = s * 3.6;
          this.targetVertical += 300 * dt;
          this.targetLateral += s * 240 * dt;
          break;
        case 'defensiveSpiral':              // corkscrew down and away
          this.rollBias = s * 5.0;
          this.targetVertical -= 200 * dt;
          this.targetLateral = Math.sin(phase * 1.3) * 260 * s;
          break;
        case 'jink':                         // hard random displacement
          this.targetLateral += s * 520 * dt;
          this.targetVertical += (this.rng.next() - 0.5) * 460 * dt;
          this.rollBias = s * 3.0;
          break;
        case 'dive':                          // trade height for closure
          this.targetVertical -= 340 * dt;
          break;
        default: break;
      }
    } else {
      // Bleed the roll back off once the move is finished.
      this.rollBias = (this.rollBias || 0) * Math.max(0, 1 - dt * 3);
    }

    return this._fireControl(dt, player, combat, toPlayer, range);
  }

  /** Remember where this fighter was placed — that offset is its station. */
  spawn(distance, lateral, vertical) {
    super.spawn(distance, lateral, vertical);
    this.stationLateral = lateral;
    this.stationVertical = vertical;
  }

  /**
   * Where this fighter wants to be, in path-space offsets.
   *
   * Returning a station is what tells the racing brain in ai.js that this
   * aircraft is NOT racing: it skips the gate line, the ring grabbing and the
   * blocking, and it clamps to the fighter's own `offsetCap` instead of the
   * corridor. What is left is the part a hostile still wants — obstacle
   * avoidance and terrain clearance — with a pursuit line on top.
   *
   * The line itself is the formation slot, drifting slowly so a squadron is
   * not a rigid lattice, blended toward the player as the merge develops. Far
   * out it holds the spread; close in it is on you.
   */
  _station(dt, player) {
    this._wander = (this._wander || 0) + dt;
    let tl = this.stationLateral + Math.sin(this._wander * 0.19 + this.lineSeed) * 640;
    let tv = this.stationVertical + Math.cos(this._wander * 0.15 + this.lineSeed * 1.7) * 380;

    if (player && player.alive) {
      /* Pursuit. Nothing at forty kilometres, everything inside a couple —
       * so the formation reads as a formation on the approach and as a
       * dogfight once it arrives. A reversing fighter pulls harder still: it
       * has just spent two seconds turning round to do exactly this. */
      const r = this.rangeToPlayer ?? this.distanceToPlayer ?? 1e9;
      let pull = clamp01(1 - r / Math.max(1, this.engageRange * 0.55));
      pull = Math.pow(pull, 1.6) * lerp(0.55, 0.98, this.aggression);
      if (this.uTurn > 0 || this.uTurnFlipped) pull = Math.min(1, pull * 1.35);
      /* Held fire is only half the settle-in window. A squadron that converges
       * on the player at full pursuit while forbidden to shoot simply arrives
       * on top of them the moment it is cleared, which is the same ambush with
       * a delay on it. They hold their spread instead. */
      if (this._holdPursuit) pull *= COMBAT.engageHoldPursuit;
      tl = lerp(tl, player.pathOffsetLateral ?? tl, pull);
      tv = lerp(tv, player.pathOffsetVertical ?? tv, pull);
    }

    /* --- separation --------------------------------------------------------
     * Everything above pulls every hostile toward the same aircraft, so
     * without this the squadron converges into one point and the whole spread
     * is decorative. Push off anyone inside `spreadMin`, ignore anyone past
     * `spreadMax`, and check a rotating handful of peers per frame rather than
     * all of them — the force changes far more slowly than the frame rate. */
    const peers = this.peers;
    if (peers && peers.length > 1) {
      const n = peers.length;
      const step = Math.max(1, Math.ceil(n / COMBAT.spreadSamples));
      let i = (this._spreadCursor = ((this._spreadCursor || 0) + 1) % step);
      let pushL = 0, pushV = 0;
      for (; i < n; i += step) {
        const o = peers[i];
        if (o === this || !o.alive) continue;
        const dl = this.lateral - o.lateral;
        const dv = this.vertical - o.vertical;
        const da = this.distanceAlong - o.distanceAlong;
        // Horizontal separation is what the brief is about; along-track
        // distance already separates them without any help from here.
        const d = Math.hypot(dl, da);
        if (d > COMBAT.spreadMax) continue;
        const want = COMBAT.spreadMin;
        if (d >= want) continue;
        const force = (want - d) * COMBAT.spreadForce;
        if (d < 1) { pushL += force; continue; }
        pushL += (dl / d) * force;
        pushV += Math.sign(dv || 1) * force * 0.10;
      }
      tl += pushL * dt;
      tv += pushV * dt;
    }

    const out = this._stationOut;
    out.lateral = tl;
    out.vertical = tv;
    return out;
  }

  /**
   * How far the player has to get behind before this fighter turns back.
   *
   * Scaled off the engagement envelope rather than a fixed number: a hostile
   * that can shoot at forty kilometres has no reason to reverse at five, and
   * one that cannot has every reason to. The aggressive difficulties turn
   * sooner, which is most of what makes them feel like they are hunting you.
   */
  _uTurnGap() {
    return lerp(9000, 4200, this.difficulty.aiAggression) + this.engageRange * 0.22;
  }

  /**
   * Lock, guns and heavy weapons. Split out of `combatUpdate` so a fighter
   * pulling through a reversal is still a fighter that shoots at you — a
   * hostile that goes quiet for the two seconds of its most visible manoeuvre
   * is a hostile the player learns to ignore during it.
   */
  _fireControl(dt, player, combat, toPlayer, range) {
    /* Weapons tight until the settle-in window expires. The seeker keeps
     * running — a hostile that has to re-acquire from cold the instant it is
     * cleared to fire would give the player a second free window it was never
     * meant to have — but nothing leaves the rail. */
    const held = combat.armTimer > 0;

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
    if (!held && this.gunTimer <= 0 && inCone && range < this.gunOpenRange && cosAng > this.gunDisciplineCos) {
      this.gunTimer = lerp(1.5, 0.30, this.accuracy) * this.rng.float(0.8, 1.3);
      const burst = 3 + Math.round(this.accuracy * 7);
      combat.enemyBurst(this, player, burst);
    }

    /* --- heavy weapons -----------------------------------------------------
     * A hostile picks a weapon it can actually reach with: the round has to be
     * rated for the current range, exactly as the player's launch gate demands.
     * Without that filter they fire 56 km missiles from 80 km and every shot is
     * a guaranteed miss, which is indistinguishable from not shooting at all. */
    this.heavyTimer -= dt;
    if (!held && this.heavyTimer <= 0 && this.lockProgress >= 1 && range < this.engageRange
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
    /* Squadron pressure. Story missions set this so a late one genuinely puts
     * more airframes in the sky than an early one, rather than being the same
     * fight with a bigger number on the objective. Everything else runs at 1. */
    this.pressure = opts.pressure ?? 1;
    /* --- the settle-in window ----------------------------------------------
     * Hostiles hold fire until this reaches zero. Spawning them seven to ten
     * kilometres out is not by itself enough time to do anything with: they
     * carry rounds rated for fifty kilometres, so without this the first
     * missile is off the rail while the player is still stationary on the
     * countdown. For these seconds they are visible, they manoeuvre and they
     * close — they simply do not shoot. It is the difference between a fight
     * starting and a fight ambushing you. */
    this.armTimer = COMBAT.engageDelay;
    /* --- how many airframes are up there -----------------------------------
     * The floor comes from the DIFFICULTY the player chose — thirty on Hard,
     * climbing with the setting — rather than from one flat number that made
     * every rung of the ladder the same wall of aircraft. Story pressure moves
     * it on top of that, but at half strength: a 2.35x mission multiplying the
     * count outright is how a Legendary late mission ends up back at two
     * hundred airframes, which is the thing the ladder exists to avoid. */
    const squadron = squadronSize(difficulty, this.pressure);
    this.minEnemies = squadron.min;
    this.maxEnemies = squadron.max;

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
   * The squadron is held at the difficulty's own floor rather than grown from
   * two: this is a battle, and a battle that opens with a pair and thins out
   * as you kill them is a chase. Each wave tops the airspace back up to that
   * floor and pushes a little past it as the fight escalates.
   *
   * Approach geometry is drawn per fighter from `COMBAT.approach`, so a wave
   * arrives from in front, behind, either side, the diagonals and above/below
   * at once — being bounced from three directions is the point.
   */
  spawnWave(playerDistance, specs) {
    this.wave++;
    const D = this.difficulty;
    /* Formation discipline arrives with experience: the first waves fly the
     * loose shapes, and the demanding ones — the box you are inside, the ring
     * that comes from every bearing — unlock as the fight escalates. Within
     * whatever is unlocked the draw is random, so a wave is a shape you have
     * to read on arrival rather than a rota you memorise. */
    const unlocked = Math.min(FORMATION_IDS.length, 3 + Math.floor(this.wave / 2));
    const formation = FORMATION_IDS[this.rng.int(0, unlocked - 1)];
    const live = this.enemies.filter((e) => e.alive).length;
    // Top back up to the floor, plus a slow climb above it as waves stack.
    const target = Math.min(this.maxEnemies,
      this.minEnemies + Math.floor(this.wave * 0.5) + Math.round(D.aiSkill * 2));
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
      e.peers = this.enemies;
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
    /* Jitter is measured against the SPACING, not against the old hundreds of
     * metres: a formation eight kilometres wide with 90 m of scatter on it is
     * a formation with no scatter on it. */
    const jitterL = () => this.rng.float(-1400, 1400);
    const jitterV = () => this.rng.float(-900, 900);

    /* ALWAYS AHEAD, always seven to ten kilometres out along the route.
     *
     * The formation slot's own along-track offset is applied on top and can
     * run tens of kilometres back down the route for the later wings, so the
     * result is clamped: whatever the shape asks for, no hostile is ever
     * placed behind the player or nearer than the floor. Being bounced from
     * behind before you have any speed is not a hard merge, it is a coin flip
     * you lose. */
    const ahead = (extra = 0) => clamp(
      this.rng.float(COMBAT.spawnAheadMin, COMBAT.spawnAheadMax) + extra + off[2],
      COMBAT.spawnAheadMin, COMBAT.spawnAheadCeil,
    );

    // The pack being chased is always in front of you.
    if (this.speedFocus) {
      return {
        kind: 'lead',
        along: ahead(), lateral: off[0] + jitterL(), vertical: off[1] + jitterV(),
      };
    }

    const t = COMBAT.approach;
    let r = this.rng.next() * (t.head + t.side + t.diagonal + t.vertical);

    // HEAD-ON: dead ahead and closing, the hardest merge in the game.
    if ((r -= t.head) < 0) {
      return {
        kind: 'head',
        along: ahead(1800),
        lateral: off[0] + this.rng.float(-3200, 3200),
        vertical: off[1] + this.rng.float(-1800, 1800),
      };
    }

    // SIDE: ahead and out on a beam, so the merge develops across your nose.
    if ((r -= t.side) < 0) {
      const s = this.rng.next() < 0.5 ? -1 : 1;
      return {
        kind: 'side',
        along: ahead(),
        lateral: off[0] + s * this.rng.float(7000, 10000),
        vertical: off[1] + jitterV(),
      };
    }

    // DIAGONAL: ahead and offset, the classic cut-off geometry.
    if ((r -= t.diagonal) < 0) {
      const s = this.rng.next() < 0.5 ? -1 : 1;
      return {
        kind: 'diagonal',
        along: ahead(900),
        lateral: off[0] + s * this.rng.float(4000, 8000),
        vertical: off[1] + this.rng.float(-2600, 2600),
      };
    }

    // VERTICAL: ahead and stacked above or below.
    const s = this.rng.next() < 0.5 ? -1 : 1;
    return {
      kind: 'vertical',
      along: ahead(),
      lateral: off[0] + jitterL(),
      vertical: off[1] + s * this.rng.float(3500, 7000),
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
    if (live >= this.minEnemies) { this._respawnTimer = COMBAT.respawnDelay; return 0; }

    this._respawnTimer -= dt;
    if (this._respawnTimer > 0) return 0;
    this._respawnTimer = COMBAT.respawnDelay;

    // Replace a couple at a time — a whole squadron appearing at once reads as
    // a spawn, a trickle of reinforcements reads as a fight that keeps going.
    const D = this.difficulty;
    const join = Math.min(3, this.minEnemies - live);
    for (let i = 0; i < join; i++) {
      const spec = specs[this.rng.int(0, specs.length - 1)];
      const arch = ENEMY_ARCHETYPES[this.rng.int(0, ENEMY_ARCHETYPES.length - 1)];
      const livery = COMBAT.liveries[this.rng.int(0, COMBAT.liveries.length - 1)];
      const e = new EnemyFighter(this.render, this.world, spec, arch, D,
        this._nextIndex++, this.world.seed, {
          livery, slot: this._nextIndex, formation: FORMATION_IDS[this.rng.int(0, FORMATION_IDS.length - 1)],
          tier: this.wave, speedFocus: this.speedFocus,
        });
      const a = this._approach(e.formationOffset());
      e.approach = a.kind;
      e.spawn(playerDistance + a.along, a.lateral, a.vertical);
      e.peers = this.enemies;
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
     * The rail release is its own event, and it is a DIRECTIONAL one: a motor
     * lighting throws a hard jet backward down the rail and leaves a wall of
     * efflux smoke hanging where the aircraft was. It used to be an
     * omnidirectional bloom at the pylon, which is the one shape a rocket
     * launch never has. `missileLaunch` owns the whole sequence including the
     * motor burning out a beat later; here we add only what belongs to the
     * AIRCRAFT rather than to the round — the flash on the canopy and the
     * shove as several hundred kilos leaves the wing. */
    _v.set(0, 0, -1).applyQuaternion(player.quaternion);
    this.render.vfx.missileLaunch(_v3, _v, w.color);
    this.render.postfx.flash(0.26, w.color);
    this.render.rig.addShake(0.58, 18);

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
    /* The same ceiling `spawn` enforces, which this used to bypass by pushing
     * straight onto the list. With a hundred hostiles in the air that is not a
     * theoretical hole: a squadron firing ten-round bursts every half second
     * will fill the tracer batch, and every round past the cap is one that is
     * simulated and never drawn. */
    const room = TRACER_CAP + HEAVY_CAP - this.shots.length;
    if (room <= 0) return;
    rounds = Math.min(rounds, room);
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
    // The player's weapons are live from the first frame; only the hostiles wait.
    if (this.armTimer > 0) {
      this.armTimer = Math.max(0, this.armTimer - dt);
      if (this.armTimer === 0) this.events.push({ type: 'weaponsFree' });
    }

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
    /* --- mesh budget -------------------------------------------------------
     * A hundred hostiles is a hundred flight models, which is nothing, and a
     * hundred AIRCRAFT, which is not: six draw calls, a trail ribbon and an
     * afterburner each. Decide up front which ones are worth drawing —
     * nearest first, capped — and let the rest fly, shoot and paint on the
     * radar without geometry. The player cannot tell, because at 26 km a
     * fighter is a pixel; the frame rate can. */
    if (player) {
      const live = this._drawScratch || (this._drawScratch = []);
      live.length = 0;
      for (const e of this.enemies) {
        if (!e.alive) { e.drawAllowed = true; continue; }
        e._drawKey = e.position3.distanceToSquared(player.position);
        live.push(e);
      }
      live.sort((a, b) => a._drawKey - b._drawKey);
      for (let i = 0; i < live.length; i++) live[i].drawAllowed = i < COMBAT.enemyDrawBudget;
    }

    const holding = this.armTimer > 0;
    for (const e of this.enemies) {
      e._holdPursuit = holding;
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

      _v.copy(s.pos);                       // where the round was before this step
      s.pos.addScaledVector(s.vel, dt);
      if (!w.guided && !w.gravity) s.dir.copy(s.vel).normalize();
      s.life -= dt;

      /* --- hits ------------------------------------------------------------
       * Swept, not sampled. A plasma bolt covers 93 m in a 60 Hz frame and a
       * fighter is a 30 m sphere, so a point test at the round's new position
       * steps clean over two thirds of the shots that should have connected —
       * which is exactly what "the guns do not hit anything" was. The test
       * below is the round's whole path this frame against the target sphere,
       * so a hit is a hit at any frame rate and any muzzle velocity. */
      let hit = null;
      if (s.fromPlayer) {
        /* Broadphase first. A hundred hostiles times several hundred rounds in
         * the air is tens of thousands of pairs a frame, and the swept test is
         * an order more work than a distance compare — so reject on a sphere
         * around this frame's travel before doing any of it. */
        _mid.addVectors(_v, s.pos).multiplyScalar(0.5);
        const reach = _v.distanceTo(s.pos) * 0.5 + w.radius;
        const reach2 = reach * reach;
        for (const e of this.enemies) {
          if (!e.alive) continue;
          if (e.position3.distanceToSquared(_mid) > reach2) continue;
          if (this._sweepHit(_v, s.pos, e.position3, w.radius)) { hit = e; break; }
        }
      } else if (player && player.alive) {
        if (this._sweepHit(_v, s.pos, player.position, w.radius)) hit = player;
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
        /* Motor burn. A real rocket motor has a BOOST phase and then it is
         * out: a hard bright burn for the first second or so, then a round
         * coasting on a cold smoke trail for the rest of its flight. Modelling
         * that is most of the difference between a missile and a glowing dart
         * — the flare tells you the round has just left, and the cold trail
         * tells you it is still coming. */
        const age = w.life - s.life;
        const burn = clamp01(1 - (age - 0.35) / 0.9);      // 1 while lit, 0 once out
        const boostFlare = 1 + Math.max(0, 0.55 - age) * 1.6;
        this.heavies.push(s.pos, s.dir,
          (w.id === 'grenade' ? 2.4 : 3.6) * boostFlare, s.color);
        /* Emission rate is capped rather than per-frame: a plume this dense
         * costs a few hundred live particles per round, and four rounds in the
         * air must not be able to drain the whole budget. It also THINS as the
         * motor dies, which is what makes the burnout visible. */
        s.smokeT = (s.smokeT || 0) - dt;
        if (s.smokeT <= 0) {
          s.smokeT = burn > 0.05 ? 0.045 : 0.085;
          _v3.copy(s.pos).addScaledVector(s.dir, -6);
          // Hot exhaust while the motor is lit; plain grey smoke once it is out.
          const smoke = w.beam ? 0x9fe8ff : (burn > 0.05 ? 0xd8dce0 : 0xa8adb3);
          this.render.vfx.smokePuff(_v3, w.beam ? 2 : (burn > 0.05 ? 4 : 2),
            w.beam ? 2.4 : 4.2 + burn * 3.2, smoke);
          if (burn > 0.05) {
            // The flame itself, straight out of the nozzle and straight back.
            _v.copy(s.dir).negate();
            this.render.vfx.sparkBurst(_v3, _v, Math.round(3 + burn * 7),
              w.beam ? 0x9fe8ff : 0xffc470);
          }
        }
      }
    }

    this.tracers.end();
    this.heavies.end();
  }

  /**
   * Did a round travelling `from` -> `to` this frame pass within `r` of `at`?
   *
   * Closest approach of a point to a segment, which is the correct question
   * for a projectile: "was it ever inside the target" rather than "is it
   * inside the target right now, on this particular frame boundary".
   */
  _sweepHit(from, to, at, r) {
    _v2.subVectors(to, from);
    const len2 = _v2.lengthSq();
    if (len2 < 1e-6) return from.distanceToSquared(at) < r * r;
    _v3.subVectors(at, from);
    const t = clamp(_v3.dot(_v2) / len2, 0, 1);
    _v3.copy(from).addScaledVector(_v2, t);
    return _v3.distanceToSquared(at) < r * r;
  }

  _hitGround(s) {
    const g = this.world.terrainHeight(s.pos.x, s.pos.z);
    return s.pos.y <= g + 2;
  }

  _detonate(s, hit, player, ground = false) {
    const w = s.weapon;
    /* The WEAPONS table is the player's arsenal and it is enormous. Hostiles
     * fire from the same table, so their rounds are scaled on the way in —
     * see COMBAT.enemyWeaponScale. Everything else about the round, including
     * the fireball, is identical: the hit looks the same, it just does not end
     * the run on the first merge. */
    const mine = !!s.fromPlayer;
    const dmg = w.damage * (mine ? 1 : COMBAT.enemyWeaponScale);
    const blast = (w.blast || 0) * (mine ? 1 : COMBAT.enemyBlastScale);
    if (w.tracer) {
      // A cannon strike is a spark shower, not a fireball.
      this.render.vfx.sparkBurst(s.pos, s.dir, 14, 0xffd27a);
      if (hit) this.render.vfx.explode(s.pos, 2.5, 0xffb063);
    } else {
      /* A warhead going off is a SEQUENCE, and the sequence is most of what
       * makes it legible: the charge flashes, the fireball grows into the
       * space the flash lit, the shockwave leaves, burning fuel falls out of
       * it, the column rises, and the casing cooks off a beat later. All of
       * that used to happen on one frame — which is exactly why a warhead
       * clearing a kilometre still read as a puff. `warheadBlast` owns the
       * timing; the victim's velocity goes in so the debris carries the motion
       * of whatever was just destroyed. */
      const scale = clamp(blast * 0.22, 26, 96);
      this.render.vfx.warheadBlast(s.pos, scale, s.color, null, hit?.velocity || null);

      /* A ground or structure strike throws debris and dust OUTWARD along the
       * surface instead of spherically, which is what distinguishes hitting a
       * building from killing an aircraft. Staggered too — the dust rolls out
       * after the fireball, not with it. */
      if (ground || !hit) {
        const at = s.pos.clone();
        const dust = ground ? 0x6b5f4e : 0x50505a;
        this.render.vfx.after(0.12, () => {
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2 + this.rng.next() * 0.4;
            _v.set(Math.cos(a), 0.30 + this.rng.next() * 0.4, Math.sin(a));
            _v2.copy(at).addScaledVector(_v, scale * 0.7);
            this.render.vfx.sparkBurst(_v2, _v, 12, 0xffbf6a);
            this.render.vfx.smokePuff(_v2, 10, scale * 0.75, dust);
          }
        });
      }

      /* Felt from the cockpit if it went off anywhere near you — and the
       * SOUND arrives when sound arrives. A blast a kilometre and a half away
       * is a flash you see and then a bang you hear a beat later, and that lag
       * is worth more for scale than any amount of extra bass. */
      const dist = player ? s.pos.distanceTo(player.position) : 0;
      const near = player ? clamp01(1 - dist / 2200) : 0;
      if (near > 0.02) {
        this.render.postfx.flash(0.62 * near, 0xffb570);
        this.render.vfx.after(0.05, () => this.render.rig.addShake(2.2 * near, 14));
      }
      const vol = clamp01(0.6 + dmg / 400);
      const lag = Math.min(1.1, dist / 3400);
      if (lag < 0.02) this.audio?.play('explosion', { volume: vol });
      else this.render.vfx.after(lag, () => this.audio?.play('explosion', { volume: vol * (1 - lag * 0.45) }));
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

    if (hit) apply(hit, dmg);
    /* Splash: everything inside the blast radius takes falloff damage.
     * The falloff is QUADRATIC, not linear. These warheads now clear a
     * kilometre and a linear ramp over that distance leaves half of it still
     * doing lethal damage — the whole airspace becomes one kill zone and
     * position stops meaning anything. Squaring it keeps the core devastating
     * and lets the edge of the blast be the edge of the blast. */
    if (blast > 0) {
      const victims = mine ? this.enemies : (player ? [player] : []);
      for (const v of victims) {
        if (v === hit) continue;
        if (v.alive === false) continue;
        const p = v.position3 || v.position;
        const d = s.pos.distanceTo(p);
        if (d > blast) continue;
        const falloff = 1 - d / blast;
        apply(v, dmg * falloff * falloff * 0.6);
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
