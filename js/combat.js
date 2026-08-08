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
  WEAPONS_BY_ID, HEAVY_ORDER, COMBAT, SCORE, PHYSICS, MACH, AIRCRAFT_BY_ID,
  RNG, clamp, clamp01, lerp, damp, TAU,
} from './config.js';
import { AIRacer } from './ai.js';

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
    // A long thin box scaled along -Z: cheap, and it reads as a tracer streak
    // rather than a dot at any speed.
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.translate(0, 0, -0.5);
    const m = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
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
    const g = new THREE.ConeGeometry(0.55, 3.4, 7);
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

    this.maxHealth = COMBAT.enemyHealth * lerp(0.8, 1.5, spec.stats.durability) * lerp(0.8, 1.6, D.aiSkill);
    this.health = this.maxHealth;

    // Combat skill. Everything a hostile is good at scales off difficulty and
    // off the wave number, so wave 8 is a genuinely different opponent to wave 1.
    const tier = clamp01((opts.tier || 0) / 10);
    this.accuracy = clamp01(lerp(0.34, 0.88, D.aiSkill) + tier * 0.24);
    this.fireRate = lerp(0.55, 1.45, D.aiAggression) * (1 + tier * 0.6);
    this.heavyChance = clamp01(lerp(0.18, 0.62, D.aiAggression) + tier * 0.28);
    this.engageRange = lerp(1500, 2600, D.aiSkill) * (1 + tier * 0.25);
    this.evasion = clamp01(lerp(0.25, 0.85, D.aiSkill) + tier * 0.2);

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
      this.manoeuvreTimer = lerp(9, 3.2, this.evasion) * this.rng.float(0.7, 1.5);
      const kinds = range < 1200 ? ['break', 'barrel', 'scissors'] : ['yoyo', 'barrel', 'climb'];
      this.manoeuvreKind = kinds[this.rng.int(0, kinds.length - 1)];
      this.manoeuvre = this.rng.float(1.1, 2.4);
      this._manoeuvreSign = this.rng.next() < 0.5 ? -1 : 1;
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
        case 'climb':
          this.targetVertical += 180 * dt;
          break;
        default: break;
      }
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
     * a hostile that hoses the sky continuously is noise, not pressure. */
    this.gunTimer -= dt * this.fireRate;
    if (this.gunTimer <= 0 && inCone && range < COMBAT.gunRange && cosAng > 0.965) {
      this.gunTimer = lerp(1.5, 0.42, this.accuracy) * this.rng.float(0.8, 1.3);
      const burst = 3 + Math.round(this.accuracy * 5);
      combat.enemyBurst(this, player, burst);
    }

    /* --- heavy weapons ---------------------------------------------------- */
    this.heavyTimer -= dt;
    if (this.heavyTimer <= 0 && this.lockProgress >= 1 && range < this.engageRange
        && this.rng.next() < this.heavyChance) {
      this.heavyTimer = lerp(9, 3.0, this.fireRate / 2) * this.rng.float(0.8, 1.4);
      const pick = HEAVY_ORDER[this.rng.int(0, HEAVY_ORDER.length - 1)];
      combat.spawn(WEAPONS_BY_ID[pick], this.position3, this.quaternion, this, player, this.livery);
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
    this.heavyIndex = 0;
    this.gunCooldown = 0;
    this.heavyCooldown = 0;
    this.lockProgress = 0;
    this.lockTarget = null;
    this.targetIndex = 0;

    this.wave = 0;
    this.waveTimer = 3;
    this.kills = 0;
  }

  get heavyWeapon() { return WEAPONS_BY_ID[HEAVY_ORDER[this.heavyIndex % HEAVY_ORDER.length]]; }
  get locked() { return this.lockProgress >= 1 && !!this.lockTarget; }

  cycleWeapon() {
    this.heavyIndex = (this.heavyIndex + 1) % HEAVY_ORDER.length;
    this.heavyCooldown = Math.max(this.heavyCooldown, 0.25);
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

  _candidates(player) {
    const out = [];
    _v2.set(0, 0, -1).applyQuaternion(player.quaternion);
    const cosLimit = Math.cos(COMBAT.lockConeDeg * Math.PI / 180);
    for (const e of this.enemies) {
      if (!e.alive) continue;
      _v.copy(e.position3).sub(player.position);
      const d = _v.length();
      if (d > COMBAT.lockRange || d < 1) continue;
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
   * Size, skill and formation discipline all climb with the wave number.
   */
  spawnWave(playerDistance, specs) {
    this.wave++;
    const D = this.difficulty;
    // Formation discipline arrives with experience: early waves fly loose
    // pairs, later ones fly a proper four-ship.
    const formation = FORMATION_IDS[Math.min(FORMATION_IDS.length - 1,
      Math.floor(this.wave / 2)) % FORMATION_IDS.length];
    const want = Math.min(COMBAT.maxEnemies,
      2 + Math.floor(this.wave * 0.75) + Math.round(D.aiSkill * 2));
    const room = COMBAT.maxEnemies - this.enemies.filter((e) => e.alive).length;
    const count = Math.max(0, Math.min(want, room));

    for (let i = 0; i < count; i++) {
      const spec = specs[this.rng.int(0, specs.length - 1)];
      const arch = ENEMY_ARCHETYPES[this.rng.int(0, ENEMY_ARCHETYPES.length - 1)];
      const livery = COMBAT.liveries[this.rng.int(0, COMBAT.liveries.length - 1)];
      const e = new EnemyFighter(this.render, this.world, spec, arch, D,
        this.enemies.length + i, this.world.seed, {
          livery, slot: i, formation, tier: this.wave, speedFocus: this.speedFocus,
        });
      const off = e.formationOffset();
      // Ahead of the player in the speed mode (they are being chased down),
      // spread around them in the battle mode.
      const lead = this.speedFocus ? 1400 : this.rng.float(-600, 1600);
      e.spawn(playerDistance + lead + off[2], off[0] + this.rng.float(-60, 60),
        off[1] + this.rng.float(-40, 40));
      this.enemies.push(e);
    }
    this.events.push({ type: 'wave', wave: this.wave, count, formation });
    return count;
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
    const w = WEAPONS_BY_ID.gun;
    let fired = 0;
    const owed = Math.min(4, 1 + Math.floor(dt / w.cooldown));
    while (fired < owed) {
      // Two barrels, offset either side of the nose.
      for (const side of [-1, 1]) {
        _v3.set(side * 1.5, -0.5, -4).applyQuaternion(player.quaternion).add(player.position);
        // Spread successive rounds down the flight path rather than stacking
        // them all on this frame's muzzle point.
        _v3.addScaledVector(player.velocity, -fired * w.cooldown);
        const s = this.spawn(w, _v3, player.quaternion, player, null, 0xfff0a8);
        if (s) s.fromPlayer = true;
      }
      fired++;
      this.gunCooldown += w.cooldown;
    }
    this.audio?.play('gunFire', { volume: 0.5 });
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
    this.heavyCooldown = w.cooldown;
    _v3.set(0, -1.2, -3).applyQuaternion(player.quaternion).add(player.position);
    const s = this.spawn(w, _v3, player.quaternion, player, this.lockTarget, w.color);
    if (s) s.fromPlayer = true;
    this.audio?.play(w.id === 'grenade' ? 'grenadeThrow' : 'missileLaunch', { volume: 0.9 });
    this.events.push({ type: 'launch', weapon: w });
    return w;
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
    // Drop a target that died, left the cone or ran out of range.
    if (this.lockTarget && !this.lockTarget.alive) this.lockTarget = null;
    const cands = this._candidates(player);
    if (!this.lockTarget || !cands.includes(this.lockTarget)) {
      this.lockTarget = cands[0] || null;
      if (!this.lockTarget) this.lockProgress = Math.max(0, this.lockProgress - dt * COMBAT.lockDecay);
    }
    if (this.lockTarget) {
      const was = this.lockProgress;
      this.lockProgress = clamp01(this.lockProgress + dt / COMBAT.lockTime);
      if (was < 1 && this.lockProgress >= 1) {
        this.audio?.play('lockTone', { volume: 0.8 });
        this.events.push({ type: 'lock', target: this.lockTarget });
      }
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

      /* --- guidance ------------------------------------------------------ */
      if (w.guided && s.target && s.target.alive) {
        const tp = s.target.position3 || s.target.position;
        _v.copy(tp).sub(s.pos);
        const d = _v.length();
        if (d > 1) {
          _v.divideScalar(d);
          // Proportional steering, capped by the seeker's turn rate.
          const speed = s.vel.length();
          _v2.copy(s.vel).divideScalar(speed || 1);
          const maxTurn = w.turnRate * dt;
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
      if (hit || fused || s.life <= 0 || this._hitGround(s)) {
        if (hit || fused) this._detonate(s, hit, player);
        this.shots.splice(i, 1);
        continue;
      }

      /* --- draw ---------------------------------------------------------- */
      if (w.tracer) {
        // Streak length scales with how far the round moved this frame, which
        // is what makes a tracer look like a tracer at any frame rate.
        const len = clamp(s.vel.length() * dt * 1.6, 12, 70);
        this.tracers.push(s.pos, s.dir, len, s.fromPlayer ? 0.7 : 0.55, s.color);
      } else {
        this.heavies.push(s.pos, s.dir, w.id === 'grenade' ? 0.8 : 1.25, s.color);
        // Guided and rocket rounds leave smoke.
        s.smokeT = (s.smokeT || 0) - dt;
        if (s.smokeT <= 0) {
          s.smokeT = 0.045;
          this.render.vfx.smokePuff(s.pos, w.beam ? 1.0 : 1.8, w.beam ? 0.5 : 1.1,
            w.beam ? 0x9fe8ff : 0xb0b6bd);
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

  _detonate(s, hit, player) {
    const w = s.weapon;
    const blast = w.blast || 0;
    this.render.vfx.explode(s.pos, w.tracer ? 3 : clamp(blast * 0.08, 8, 26), s.color);
    if (!w.tracer) this.audio?.play('explosion', { volume: clamp01(w.damage / 80) * 0.8 });

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
 * hostile that flies a clean racing line is not a threat. */
const ENEMY_ARCHETYPES = [
  { id: 'hunter', name: 'Hunter', skill: 0.78, aggression: 0.90, mistakeBias: 0.7, speedBias: 1.02, agilityBias: 1.06 },
  { id: 'ace', name: 'Ace', skill: 0.94, aggression: 0.78, mistakeBias: 0.35, speedBias: 1.05, agilityBias: 1.12 },
  { id: 'brawler', name: 'Brawler', skill: 0.62, aggression: 1.00, mistakeBias: 1.1, speedBias: 0.98, agilityBias: 0.94 },
  { id: 'sniper', name: 'Sniper', skill: 0.86, aggression: 0.55, mistakeBias: 0.5, speedBias: 1.08, agilityBias: 0.90 },
  { id: 'wingman', name: 'Wingman', skill: 0.70, aggression: 0.66, mistakeBias: 0.8, speedBias: 1.00, agilityBias: 1.00 },
];
