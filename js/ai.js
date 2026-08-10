/**
 * ALPHA AIRCRAFT RACE 3D — ai.js
 * ---------------------------------------------------------------------------
 * Rival pilots, civilian traffic and the race director.
 *
 * Rivals fly in *path space* — (distance along, lateral offset, vertical
 * offset) — rather than free 6-DOF. That is what makes them read as competent
 * racing drivers instead of drunk autopilots: they always know where the route
 * goes, so all their intelligence goes into choosing a line, defending it,
 * avoiding obstacles and deciding when to spend boost. Their world transform
 * is reconstructed from the path frame every tick, so they can never clip
 * terrain or fly a route that does not exist.
 */

import * as THREE from 'three';
import { AircraftVisual } from './player.js';
import { mergeGeometriesSafe } from './renderer.js';
import {
  AIRCRAFT, AIRCRAFT_BY_ID, PHYSICS, RNG,
  clamp, clamp01, lerp, damp, smoothstep, TAU,
} from './config.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/* ===========================================================================
 * ARCHETYPES
 * ======================================================================== */

export const ARCHETYPES = [
  {
    id: 'balanced', name: 'Balanced Racer', tag: 'BAL',
    skill: 0.62, aggression: 0.45, risk: 0.45, speedBias: 1.00, agilityBias: 1.00,
    lineWander: 0.35, blockChance: 0.25, boostGreed: 0.5, mistakeBias: 1.0, drafting: 0.5,
    desc: 'Textbook lines, no drama.',
  },
  {
    id: 'aggressive', name: 'Aggressive Racer', tag: 'AGR',
    skill: 0.66, aggression: 0.95, risk: 0.85, speedBias: 1.03, agilityBias: 1.02,
    lineWander: 0.65, blockChance: 0.35, boostGreed: 0.85, mistakeBias: 1.5, drafting: 0.85,
    desc: 'Dives for gaps that are not there yet.',
  },
  {
    id: 'defensive', name: 'Defensive Racer', tag: 'DEF',
    skill: 0.70, aggression: 0.35, risk: 0.25, speedBias: 0.97, agilityBias: 1.05,
    lineWander: 0.20, blockChance: 0.95, boostGreed: 0.35, mistakeBias: 0.7, drafting: 0.3,
    desc: 'Owns the inside line and will not give it back.',
  },
  {
    id: 'speed', name: 'Speed Racer', tag: 'SPD',
    skill: 0.58, aggression: 0.55, risk: 0.60, speedBias: 1.12, agilityBias: 0.80,
    lineWander: 0.30, blockChance: 0.15, boostGreed: 1.0, mistakeBias: 1.35, drafting: 0.7,
    desc: 'Untouchable on the straights, ragged in the tight stuff.',
  },
  {
    id: 'agile', name: 'Agile Racer', tag: 'AGL',
    skill: 0.74, aggression: 0.50, risk: 0.55, speedBias: 0.95, agilityBias: 1.30,
    lineWander: 0.55, blockChance: 0.30, boostGreed: 0.55, mistakeBias: 0.75, drafting: 0.5,
    desc: 'Threads gate chains nobody else attempts at speed.',
  },
  {
    id: 'technical', name: 'Technical Racer', tag: 'TEC',
    skill: 0.80, aggression: 0.45, risk: 0.70, speedBias: 0.99, agilityBias: 1.12,
    lineWander: 0.45, blockChance: 0.35, boostGreed: 0.65, mistakeBias: 0.6, drafting: 0.75,
    desc: 'Takes every shortcut and makes them look easy.',
  },
  {
    id: 'elite', name: 'Elite Racer', tag: 'ELT',
    skill: 0.90, aggression: 0.70, risk: 0.65, speedBias: 1.05, agilityBias: 1.15,
    lineWander: 0.35, blockChance: 0.60, boostGreed: 0.80, mistakeBias: 0.35, drafting: 0.85,
    desc: 'Reads the route two segments ahead.',
  },
  {
    id: 'legendary', name: 'Legendary Racer', tag: 'LGD',
    skill: 0.99, aggression: 0.92, risk: 0.80, speedBias: 1.10, agilityBias: 1.25,
    lineWander: 0.30, blockChance: 0.80, boostGreed: 0.95, mistakeBias: 0.15, drafting: 0.95,
    desc: 'Closes the door before you have decided to go for it.',
  },
];
export const ARCHETYPES_BY_ID = Object.fromEntries(ARCHETYPES.map((a) => [a.id, a]));

const PILOT_NAMES = [
  'K. VOSS', 'R. AMARI', 'T. LINDQVIST', 'M. OKONKWO', 'J. RIVERA', 'S. NAKAMURA',
  'D. HALVORSEN', 'A. PETROVA', 'L. MBEKI', 'C. FONTAINE', 'N. ARSLAN', 'P. DESAI',
  'E. KOWALCZYK', 'B. TANAKA', 'V. SOLIS', 'H. ERIKSEN', 'Z. HADDAD', 'G. MORETTI',
];

/* ===========================================================================
 * AI RACER
 * ======================================================================== */

export class AIRacer {
  constructor(render, world, spec, archetype, difficulty, index, seed) {
    this.render = render;
    this.world = world;
    this.spec = spec;
    this.arch = archetype;
    this.difficulty = difficulty;
    this.index = index;
    this.rng = new RNG(`${seed}:ai:${index}`);
    this.name = PILOT_NAMES[(index * 5 + (seed | 0)) % PILOT_NAMES.length];
    this.number = 10 + ((index * 7 + 3) % 89);

    // Skill blends the archetype with the difficulty setting.
    const D = difficulty;
    this.skill = clamp01(lerp(archetype.skill, D.aiSkill, 0.55));
    this.aggression = clamp01(lerp(archetype.aggression, D.aiAggression, 0.45));
    this.mistakeRate = D.aiMistake * archetype.mistakeBias;
    this.powerUse = D.aiPowerUse;

    const st = spec.stats;
    this.topSpeed = PHYSICS.maxSpeed * lerp(0.80, 1.14, st.speed)
      * archetype.speedBias * D.aiSpeed * lerp(0.94, 1.02, this.skill);
    this.accel = PHYSICS.baseThrust * lerp(0.70, 1.30, st.accel) * archetype.speedBias;
    this.agility = lerp(0.66, 1.32, st.handling) * archetype.agilityBias;
    this.maxHealth = PHYSICS.maxHealth * lerp(0.72, 1.40, st.durability);
    this.health = this.maxHealth;

    // Path-space state.
    this.distanceAlong = 0;
    this.lateral = 0;
    this.vertical = 0;
    this.targetLateral = 0;
    this.targetVertical = 0;
    this.lateralVel = 0;
    this.verticalVel = 0;
    this.speed = PHYSICS.cruiseSpeed * 0.8;
    this.boost = 100;
    this.boosting = false;
    this.alive = true;
    this.finished = false;
    this.lap = 0;
    this.position3 = new THREE.Vector3();
    this.prevPosition = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.bank = 0;
    this.pitchVis = 0;
    this.racePosition = index + 1;
    this.recovering = 0;
    this.stunned = 0;

    // Personality timers.
    this.lineTimer = this.rng.float(0, 3);
    this.lineSeed = this.rng.float(0, TAU);
    this.mistakeTimer = this.rng.float(6, 18);
    this.mistakePenalty = 0;
    this.blockTimer = 0;
    this.powerTimer = this.rng.float(4, 14);
    this.shieldTime = 0;
    this.turboTime = 0;

    this.visual = new AircraftVisual(render, spec, 1, { trails: true });
    this._sample = {};
    this.distanceToPlayer = 0;
    this.visible = true;
  }

  spawn(distance, lateral, vertical) {
    this.distanceAlong = distance;
    this.lateral = this.targetLateral = lateral;
    this.vertical = this.targetVertical = vertical;
    this.speed = PHYSICS.cruiseSpeed * 0.85;
    this.health = this.maxHealth;
    this.alive = true;
    this.finished = false;
    this.lap = 0;
    const s = this.world.path.sample(distance, this._sample);
    this.position3.copy(s.pos).addScaledVector(s.right, lateral).addScaledVector(s.up, vertical);
    this.prevPosition.copy(this.position3);
    this.visual.resetTrails();
    this.visual.setVisible(true);
  }

  /** Curvature of the route ahead — used to decide cornering speed. */
  _curvatureAhead(lookahead) {
    const p = this.world.path;
    const a = p.sample(this.distanceAlong + lookahead * 0.25, {});
    const b = p.sample(this.distanceAlong + lookahead, {});
    return 1 - clamp01(a.tangent.dot(b.tangent));
  }

  /** Choose the racing line: base wander + gates + obstacles + rivalry. */
  _chooseLine(dt, player, timeScale) {
    const arch = this.arch;
    const path = this.world.path;
    const look = 380 + this.speed * 1.5;
    const s = path.sample(this.distanceAlong + look, this._sample);
    const radius = s.radius;

    // 1. Base line — a slow sine wander, tighter for skilled pilots.
    this.lineTimer -= dt;
    if (this.lineTimer <= 0) {
      this.lineTimer = lerp(4.5, 1.6, arch.lineWander) * this.rng.float(0.7, 1.4);
      this.lineSeed = this.rng.float(0, TAU);
    }
    const wander = Math.sin(this.distanceAlong * 0.0016 + this.lineSeed);
    let tl = wander * radius * lerp(0.12, 0.46, arch.lineWander) * (1 - this.skill * 0.35);
    let tv = Math.sin(this.distanceAlong * 0.0011 + this.lineSeed * 1.7) * radius * 0.18;

    // 2. Aim for the next gate centre — good pilots line up early.
    const cp = this.world.checkpointList.find((c) => c.node.dist > this.distanceAlong - 60);
    if (cp) {
      const d = cp.node.dist - this.distanceAlong;
      if (d > 0 && d < 1600) {
        const w = smoothstep(1 - d / 1600) * this.skill;
        const proj = path.project(cp.pos, cp.node.index, 3);
        tl = lerp(tl, proj.lateral, w * 0.85);
        tv = lerp(tv, proj.vertical, w * 0.85);
      }
    }

    // 3. Grab nearby rings when it is cheap to do so.
    if (this.skill > 0.45) {
      const rings = this.world.ringsNear(this.position3, 520);
      let best = null, bestScore = -Infinity;
      for (const r of rings) {
        const proj = path.project(r.pos, this._nodeHint || 0, 8);
        const ahead = proj.along - this.distanceAlong;
        if (ahead < 60 || ahead > 900) continue;
        const cost = Math.abs(proj.lateral - tl) + Math.abs(proj.vertical - tv);
        const score = (r.kind === 'boost' ? 260 : 120) - cost;
        if (score > bestScore) { bestScore = score; best = proj; }
      }
      if (best && bestScore > 0) {
        tl = lerp(tl, best.lateral, 0.5 * this.skill);
        tv = lerp(tv, best.vertical, 0.5 * this.skill);
      }
    }

    // 4. Obstacle avoidance — sample what is in the way of the intended line.
    const predict = _v.copy(s.pos).addScaledVector(s.right, tl).addScaledVector(s.up, tv);
    const near = this.world.queryColliders(predict, 260);
    for (const c of near) {
      const proj = path.project(c.pos, s.index, 6);
      const ahead = proj.along - this.distanceAlong;
      if (ahead < -80 || ahead > look * 1.6) continue;
      const dl = tl - proj.lateral, dv = tv - proj.vertical;
      const dist = Math.hypot(dl, dv);
      const clearance = c.radius + this.visual.span * 0.9;
      if (dist < clearance) {
        const push = (clearance - dist + 30) * lerp(0.5, 1.15, this.skill);
        if (dist < 1) { tl += push; }
        else { tl += (dl / dist) * push; tv += (dv / dist) * push * 0.7; }
      }
    }

    // 5. Rivalry: block if defending, or pick the opposite side to overtake.
    if (player && player.alive) {
      const gap = player.distanceAlong - this.distanceAlong;
      this.blockTimer -= dt;
      if (gap < -40 && gap > -650 && this.rng.next() < arch.blockChance * 0.02) {
        this.blockTimer = 2.4;  // player is behind and closing — cover the line
      }
      if (this.blockTimer > 0) {
        tl = lerp(tl, player.pathOffsetLateral ?? tl, 0.55 * this.aggression);
      } else if (gap > 40 && gap < 900) {
        // Player is ahead — take the other side and commit.
        const side = Math.sign((player.pathOffsetLateral ?? 0) || 1);
        tl = lerp(tl, -side * radius * 0.45, 0.35 * this.aggression);
      }
      // Keep clear of the player's aircraft at close quarters (unless aggressive).
      const sep = this.position3.distanceTo(player.position);
      if (sep < 90) {
        const avoid = lerp(1.0, 0.25, this.aggression);
        _v2.subVectors(this.position3, player.position);
        const node = path.nodes[Math.min(path.nodes.length - 1, this._nodeHint || 0)];
        if (node) {
          tl += _v2.dot(node.right) * 0.6 * avoid;
          tv += _v2.dot(node.up) * 0.4 * avoid;
        }
      }
    }

    // 6. Avoid other rivals.
    if (this.peers) {
      for (const o of this.peers) {
        if (o === this || !o.alive) continue;
        const gap = o.distanceAlong - this.distanceAlong;
        if (gap < -30 || gap > 260) continue;
        const dl = this.lateral - o.lateral, dv = this.vertical - o.vertical;
        const d = Math.hypot(dl, dv);
        if (d < 70) {
          const push = (70 - d) * 0.8;
          tl += (d < 1 ? 1 : dl / d) * push;
          tv += (d < 1 ? 0 : dv / d) * push * 0.5;
        }
      }
    }

    // Clamp inside the corridor with a small margin.
    const maxOff = radius * 0.92;
    const mag = Math.hypot(tl, tv);
    if (mag > maxOff) { tl *= maxOff / mag; tv *= maxOff / mag; }
    // Backstop. This class is subclassed from another module, so an archetype
    // arriving without a field it reads would otherwise turn into a NaN target
    // — and a NaN here does not throw, it silently teleports the aircraft to
    // coordinates that fail every comparison it is ever tested against.
    this.targetLateral = Number.isFinite(tl) ? tl : 0;
    this.targetVertical = Number.isFinite(tv) ? tv : 0;
  }

  update(dt, player, timeScale = 1) {
    if (!this.alive) { this._updateDead(dt); return; }
    const sdt = dt * timeScale;
    this.prevPosition.copy(this.position3);
    const path = this.world.path;
    const D = this.difficulty;

    this.stunned = Math.max(0, this.stunned - dt);
    this.recovering = Math.max(0, this.recovering - dt);
    this._chooseLine(sdt, player, timeScale);

    /* --- speed decision ------------------------------------------------ */
    const curvature = this._curvatureAhead(520 + this.speed * 1.2);
    // Skilled pilots carry more speed through curvature; weak ones over-slow.
    const cornerFactor = lerp(
      lerp(0.55, 0.86, this.skill),
      1.0,
      1 - clamp01(curvature * lerp(4.5, 2.6, this.skill)),
    );

    // Rubber-banding — subtle, and always weaker on higher difficulties.
    let band = 1;
    if (player && player.alive) {
      const gap = player.distanceAlong - this.distanceAlong;
      band = 1 + clamp(gap / 3000, -0.5, 0.5) * D.aiRubberband;
    }

    this.mistakeTimer -= sdt;
    if (this.mistakeTimer <= 0) {
      this.mistakeTimer = lerp(22, 7, this.mistakeRate) * this.rng.float(0.6, 1.6);
      if (this.rng.next() < this.mistakeRate) {
        // A real mistake: overshoot the line and bleed speed for a moment.
        this.mistakePenalty = this.rng.float(0.7, 2.2);
        this.targetLateral += this.rng.gauss(0, 90);
      }
    }
    this.mistakePenalty = Math.max(0, this.mistakePenalty - sdt);
    const mistakeScale = this.mistakePenalty > 0 ? 0.74 : 1;

    // Boost usage: on straights, when behind, or when the archetype is greedy.
    const straight = 1 - clamp01(curvature * 5);
    const wantBoost = this.boost > 22
      && (straight > 0.55 || (player && player.distanceAlong - this.distanceAlong > 260))
      && this.rng.next() < 0.03 + this.arch.boostGreed * 0.06;
    if (wantBoost) this.boosting = true;
    if (this.boosting) {
      this.boost -= PHYSICS.boostDrain * 0.85 * sdt;
      if (this.boost <= 4) this.boosting = false;
    } else {
      this.boost = Math.min(100, this.boost + PHYSICS.boostRegen * sdt);
    }

    // Powers: rivals use Turbo and Shield, gated by difficulty.
    this.powerTimer -= sdt;
    if (this.powerTimer <= 0 && this.rng.next() < this.powerUse) {
      this.powerTimer = lerp(26, 12, this.powerUse) * this.rng.float(0.7, 1.5);
      if (this.health < this.maxHealth * 0.55 || this.rng.bool(0.4)) this.shieldTime = 6;
      else this.turboTime = 4.5;
    } else if (this.powerTimer <= 0) {
      this.powerTimer = 6;
    }
    this.shieldTime = Math.max(0, this.shieldTime - sdt);
    this.turboTime = Math.max(0, this.turboTime - sdt);

    let cap = this.topSpeed * cornerFactor * band * mistakeScale;
    if (this.boosting) cap *= 1.22;
    if (this.turboTime > 0) cap *= 1.32;
    if (this.stunned > 0) cap *= 0.45;
    cap = clamp(cap, PHYSICS.minSpeed, PHYSICS.boostSpeed);
    // Approach the target speed at a rate set by the airframe's acceleration —
    // heavy frames visibly take longer to wind back up out of a corner.
    const rate = this.speed < cap ? (this.accel / 165) : 1.7;
    this.speed = clamp(damp(this.speed, cap, rate, sdt), PHYSICS.minSpeed * 0.6, PHYSICS.boostSpeed * 1.05);

    /* --- integrate along the route ------------------------------------- */
    this.distanceAlong += this.speed * sdt;
    path.ensure(this.distanceAlong + 3000);

    // Lateral/vertical tracking with a rate limit — this is what produces
    // believable weight instead of instant sidestepping.
    const maxRate = 140 * this.agility * lerp(0.7, 1.25, this.skill);
    const dl = this.targetLateral - this.lateral;
    const dv = this.targetVertical - this.vertical;
    this.lateralVel = damp(this.lateralVel, clamp(dl * 1.8, -maxRate, maxRate), 4.5, sdt);
    this.verticalVel = damp(this.verticalVel, clamp(dv * 1.6, -maxRate * 0.7, maxRate * 0.7), 4.0, sdt);
    this.lateral += this.lateralVel * sdt;
    this.vertical += this.verticalVel * sdt;

    // Keep the path-space offsets bounded. Without this the terrain correction
    // below can ratchet `vertical` upward every frame until it overflows, and
    // an infinite offset multiplied by a zero basis component yields NaN.
    const s0 = path.sample(this.distanceAlong, this._sample);
    const offCap = s0.radius * 2.5;
    this.lateral = clamp(this.lateral, -offCap, offCap);
    this.vertical = clamp(this.vertical, -offCap, offCap * 1.6);

    const s = s0;
    this._nodeHint = s.index;
    this.position3.copy(s.pos).addScaledVector(s.right, this.lateral).addScaledVector(s.up, this.vertical);

    // Never let a rival end up inside terrain even after avoidance pushes.
    const ground = this.world.terrainHeight(this.position3.x, this.position3.z);
    const clearance = ground + 55;
    if (this.position3.y < clearance) {
      const lift = clearance - this.position3.y;
      this.position3.y = clearance;
      this.vertical = clamp(this.vertical + lift, -offCap, offCap * 1.6);
      // Aim upward too, so it climbs out instead of grinding along the ground.
      this.targetVertical = clamp(Math.max(this.targetVertical, this.vertical + 60), -offCap, offCap);
    }

    /* --- orientation ---------------------------------------------------- */
    this.velocity.subVectors(this.position3, this.prevPosition).divideScalar(Math.max(1e-4, sdt));
    _v.copy(this.velocity);
    if (_v.lengthSq() < 1) _v.copy(s.tangent).multiplyScalar(this.speed);
    _v.normalize();
    // Bank into the lateral movement.
    const bankTarget = clamp(-this.lateralVel / maxRate, -1, 1) * 0.95
      + clamp(this._curvatureAhead(400) * 3, 0, 1) * Math.sign(-this.lateralVel) * 0.35;
    this.bank = damp(this.bank, bankTarget, 4, sdt);
    /* A hostile flying a named manoeuvre commands roll directly on top of the
     * bank the line already asks for — that is what makes an aileron roll or a
     * split-S read as a deliberate move rather than a wide sidestep. Combat
     * sets `rollBias`; a racer never has one, so this is inert off the fight. */
    const roll = this.bank + (this.rollBias || 0);
    _v2.copy(s.up).applyAxisAngle(_v, roll);
    _m.lookAt(_v3.set(0, 0, 0), _v, _v2);
    _q.setFromRotationMatrix(_m);
    this.quaternion.slerp(_q, clamp01(sdt * 9));

    this.pitchVis = damp(this.pitchVis, clamp(_v.y * 2, -1, 1), 4, sdt);
    this.distanceToPlayer = player ? this.position3.distanceTo(player.position) : 1e9;

    /* --- visual + LOD ---------------------------------------------------- */
    const show = this.distanceToPlayer < 9000;
    if (show !== this.visible) { this.visible = show; this.visual.setVisible(show); }
    if (show) {
      this.visual.update(sdt, {
        position: this.position3, quaternion: this.quaternion,
        throttle: 0.85, boost: (this.boosting ? 0.8 : 0) + (this.turboTime > 0 ? 0.5 : 0),
        speed01: clamp01(this.speed / PHYSICS.maxSpeed),
        pitch: this.pitchVis, roll: -roll, yaw: 0, alive: true,
        gLoad: 1 + Math.abs(this.lateralVel) / 60,
        altitude: this.position3.y,
        damage01: 1 - this.health / this.maxHealth,
        shield: this.shieldTime > 0, phase: false, turbo: this.turboTime > 0,
      });
    }
  }

  _updateDead(dt) {
    this.velocity.y -= PHYSICS.gravity * 2 * dt;
    // Air resistance on a wreck with no thrust: it slows as it falls.
    this.velocity.multiplyScalar(Math.max(0, 1 - dt * 0.55));
    this.position3.addScaledVector(this.velocity, dt);
    _q.setFromAxisAngle(this._deathAxis || new THREE.Vector3(0, 1, 0), (this._tumble ?? 3) * dt);
    this.quaternion.premultiply(_q);

    // Burning all the way down, at a fixed rate rather than per frame so the
    // trail is the same density however fast the machine is running.
    if (!this._impacted) {
      this._wreckT = (this._wreckT || 0) - dt;
      if (this._wreckT <= 0) {
        this._wreckT = 0.05;
        this.render.vfx.wreckTrail(this.position3, clamp(this.visual.span / 13, 0.6, 1.5));
      }
    }

    const ground = this.world.terrainHeight(this.position3.x, this.position3.z);
    if (this.position3.y <= ground + 6 && !this._impacted) {
      this._impacted = true;
      // Ground impact: a second, bigger detonation with a flat shockwave.
      this.render.vfx.explode(this.position3, 30, 0xffb063, _v.set(0, 1, 0));
      this.render.vfx.aircraftKill(this.position3, null, 0xff8a2a, 1.3);
      this.visual.setVisible(false);
    }
    if (this.visible) {
      this.visual.update(dt, {
        position: this.position3, quaternion: this.quaternion,
        throttle: 0, boost: 0, speed01: 0, pitch: 0, roll: 0, yaw: 0, alive: false,
        gLoad: 0, altitude: this.position3.y, damage01: 1,
      });
    }
  }

  damage(amount) {
    if (!this.alive) return;
    if (this.shieldTime > 0) { this.render.vfx.explode(this.position3, 5, 0x5fe4ff); return; }
    this.health -= amount;
    this.stunned = 0.5;
    this.render.vfx.sparkBurst(this.position3, null, 18, 0xffcc66);
    if (this.health <= 0) this.destroy();
  }

  destroy() {
    this.alive = false;
    this._impacted = false;
    this._deathAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();

    /* The kill sequence. The wreck keeps the velocity it died with — a fighter
     * hit at Mach 12 does not stop and fall straight down, it carries on and
     * comes apart while it goes — plus a hard tumble it can no longer arrest. */
    this.velocity.copy(this.quaternion ? _v.set(0, 0, -1).applyQuaternion(this.quaternion) : _v.set(0, 0, -1))
      .multiplyScalar(this.speed * 0.72);
    this.velocity.y += 12;
    this.render.vfx.aircraftKill(this.position3, this.velocity,
      this.livery ?? 0xffa040, clamp(this.visual.span / 13, 0.7, 1.6));
    this._tumble = 3.4 + Math.random() * 4.5;
    this._wreckT = 0;
    // Rivals rejoin after a short recovery so the grid never empties out.
    this.respawnTimer = 6;
  }

  tryRespawn(dt, playerDistance) {
    if (this.alive) return;
    this.respawnTimer -= dt;
    if (this.respawnTimer > 0) return;
    this.spawn(Math.max(0, playerDistance - 900 + Math.random() * 400),
      (Math.random() - 0.5) * 200, (Math.random() - 0.5) * 90);
    this._impacted = false;
  }

  dispose() { this.visual.dispose(); }
}

/* ===========================================================================
 * TRAFFIC — civilian / cargo / drone aircraft sharing the airspace
 * ======================================================================== */

function buildTrafficGeometry(kind) {
  const parts = [];
  if (kind === 'airliner') {
    const body = new THREE.CylinderGeometry(3.2, 2.6, 44, 10);
    body.rotateX(Math.PI / 2); parts.push(body);
    const nose = new THREE.ConeGeometry(3.2, 9, 10);
    nose.rotateX(-Math.PI / 2); nose.translate(0, 0, -26); parts.push(nose);
    const wing = new THREE.BoxGeometry(46, 1.2, 9);
    wing.translate(0, -1, 2); parts.push(wing);
    const tail = new THREE.BoxGeometry(16, 1.0, 5);
    tail.translate(0, 1, 19); parts.push(tail);
    const fin = new THREE.BoxGeometry(1.0, 10, 7);
    fin.translate(0, 6, 20); parts.push(fin);
    for (const x of [-11, 11]) {
      const e = new THREE.CylinderGeometry(2.4, 2.2, 9, 8);
      e.rotateX(Math.PI / 2); e.translate(x, -3.5, 1); parts.push(e);
    }
  } else if (kind === 'cargo') {
    const body = new THREE.BoxGeometry(9, 9, 52);
    parts.push(body);
    const nose = new THREE.ConeGeometry(6, 12, 6);
    nose.rotateX(-Math.PI / 2); nose.translate(0, 0, -31); parts.push(nose);
    const wing = new THREE.BoxGeometry(58, 2, 13);
    wing.translate(0, 4, 0); parts.push(wing);
    for (const x of [-16, -8, 8, 16]) {
      const e = new THREE.CylinderGeometry(2.6, 2.4, 8, 6);
      e.rotateX(Math.PI / 2); e.translate(x, 3, -4); parts.push(e);
    }
    const fin = new THREE.BoxGeometry(1.4, 13, 9);
    fin.translate(0, 10, 22); parts.push(fin);
  } else { // drone
    const body = new THREE.OctahedronGeometry(4.5, 0);
    body.scale(1, 0.6, 1.6); parts.push(body);
    for (const [x, z] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) {
      const arm = new THREE.BoxGeometry(1.4, 0.8, 1.4);
      arm.translate(x * 0.6, 0, z * 0.6); parts.push(arm);
      const rotor = new THREE.CylinderGeometry(3.6, 3.6, 0.4, 8);
      rotor.translate(x, 1.2, z); parts.push(rotor);
    }
  }
  const merged = mergeGeometriesSafe(parts);
  merged?.computeBoundingSphere();
  return merged;
}

class TrafficAircraft {
  constructor(mesh, kind, radius) {
    this.mesh = mesh;
    this.kind = kind;
    this.radius = radius;
    this.pos = mesh.position;
    this.vel = new THREE.Vector3();
    this.active = false;
    this.life = 0;
    this.damage = 22;
    this.soft = false;
    this.type = 'traffic';
  }
}

export class TrafficManager {
  constructor(render, world, quality, difficulty) {
    this.render = render;
    this.world = world;
    this.quality = quality;
    this.difficulty = difficulty;
    this.rng = new RNG(world.seed + 991);
    this.pool = [];
    this.active = [];
    this.spawnTimer = 2;
    this.densityScale = 1;

    const night = world.isNight;
    this.geos = {
      airliner: buildTrafficGeometry('airliner'),
      cargo: buildTrafficGeometry('cargo'),
      drone: buildTrafficGeometry('drone'),
    };
    this.mats = {
      airliner: render.materials.structure(0xe8ecef, 0.35, 0.42),
      cargo: render.materials.structure(0x6f7a63, 0.4, 0.62),
      drone: render.materials.structure(0x2c3138, 0.75, 0.4),
    };
    this.lightMat = render.materials.emissiveBasic(0xff3b30);

    const cap = Math.round(16 * quality.preset.trafficDensity * difficulty.trafficDensity);
    for (let i = 0; i < cap; i++) {
      const kind = ['airliner', 'cargo', 'drone'][i % 3];
      const g = new THREE.Group();
      const body = new THREE.Mesh(this.geos[kind], this.mats[kind]);
      g.add(body);
      const light = new THREE.Mesh(new THREE.SphereGeometry(1.4, 5, 4), this.lightMat);
      light.position.set(0, kind === 'drone' ? 3 : -4, 0);
      g.add(light);
      g.visible = false;
      render.scene.add(g);
      this.pool.push(new TrafficAircraft(g, kind, kind === 'drone' ? 12 : kind === 'cargo' ? 34 : 28));
    }
  }

  spawn(playerDistance) {
    const t = this.pool.find((x) => !x.active);
    if (!t) return;
    const path = this.world.path;
    const ahead = this.rng.float(2200, 6000);
    const s = path.sample(playerDistance + ahead, {});
    const lateral = this.rng.gauss(0, s.radius * 1.6);
    const vertical = this.rng.gauss(0, s.radius * 0.7);
    t.pos.copy(s.pos).addScaledVector(s.right, lateral).addScaledVector(s.up, vertical);
    const ground = this.world.terrainHeight(t.pos.x, t.pos.z);
    if (t.pos.y < ground + 120) t.pos.y = ground + 120 + this.rng.float(0, 300);

    // Cross the corridor at an angle so it reads as other traffic, not scenery.
    const cross = this.rng.float(0.5, 1.5) * this.rng.sign();
    _v.copy(s.tangent).multiplyScalar(this.rng.float(-1, 0.4))
      .addScaledVector(s.right, cross)
      .addScaledVector(s.up, this.rng.float(-0.12, 0.12))
      .normalize();
    const speed = t.kind === 'drone' ? this.rng.float(12, 40) : this.rng.float(90, 175);
    t.vel.copy(_v).multiplyScalar(speed);
    _m.lookAt(_v3.set(0, 0, 0), _v, s.up);
    t.mesh.quaternion.setFromRotationMatrix(_m);
    t.mesh.visible = true;
    t.active = true;
    t.life = 46;
    this.active.push(t);
  }

  update(dt, playerDistance, playerPos, timeScale = 1) {
    const density = this.quality.preset.trafficDensity * this.difficulty.trafficDensity * this.densityScale;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = lerp(3.2, 0.75, clamp01(density)) * this.rng.float(0.6, 1.4);
      this.spawn(playerDistance);
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const t = this.active[i];
      t.pos.addScaledVector(t.vel, dt * timeScale);
      t.life -= dt;
      if (t.kind === 'drone') t.mesh.rotation.y += dt * 1.4;
      if (t.life <= 0 || t.pos.distanceToSquared(playerPos) > 4.2e7) {
        t.active = false; t.mesh.visible = false;
        this.active.splice(i, 1);
      }
    }
  }

  /** Exposed to the collision system as dynamic colliders. */
  colliders() { return this.active; }

  setDensity(v) { this.densityScale = v; }

  dispose() {
    for (const t of this.pool) this.render.scene.remove(t.mesh);
    for (const g of Object.values(this.geos)) g.dispose();
    this.pool.length = 0; this.active.length = 0;
  }
}

/* ===========================================================================
 * RACE DIRECTOR — grid, standings, overtakes
 * ======================================================================== */

export class RaceDirector {
  constructor(render, world, quality, difficulty, opts = {}) {
    this.render = render;
    this.world = world;
    this.difficulty = difficulty;
    this.quality = quality;
    this.racers = [];
    this.events = [];
    this.playerPosition = 1;
    this.gridSize = 1;
    this.rng = new RNG(world.seed + 4242);
    this.enabled = opts.rivals !== false;
    this.traffic = new TrafficManager(render, world, quality, difficulty);
    // Traffic is collidable by the player and by rivals — register it with the
    // world so there is a single place collision queries have to look.
    world.dynamicColliders = this.traffic.active;
    this._prevPlayerPos = 1;
    this._standings = [];
  }

  /** Build the rival grid. Archetype spread widens with difficulty. */
  createGrid(playerSpec, count, startDistance = 0) {
    this.dispose(false);
    if (!this.enabled) { this.gridSize = 1; return; }
    const D = this.difficulty;
    // Pick archetypes weighted toward the harder end as difficulty rises.
    const pool = ARCHETYPES.slice();
    const chosen = [];
    for (let i = 0; i < count; i++) {
      const bias = clamp01(D.aiSkill + this.rng.float(-0.25, 0.25));
      pool.sort((a, b) => Math.abs(a.skill - bias) - Math.abs(b.skill - bias));
      const pick = pool[Math.min(pool.length - 1, Math.floor(Math.abs(this.rng.gauss(0, 1.6))))];
      chosen.push(pick);
    }
    const specs = AIRCRAFT.filter((a) => a.id !== playerSpec.id);
    for (let i = 0; i < count; i++) {
      const arch = chosen[i];
      // Match airframe to personality so the grid reads correctly at a glance.
      const wanted = {
        speed: 'talon', agile: 'falcon', defensive: 'bastion', aggressive: 'vipera',
        technical: 'phantom', elite: 'zephyr', legendary: 'omega', balanced: 'aurora',
      }[arch.id];
      const spec = AIRCRAFT_BY_ID[wanted] && wanted !== playerSpec.id
        ? AIRCRAFT_BY_ID[wanted]
        : specs[i % specs.length];
      const r = new AIRacer(this.render, this.world, spec, arch, D, i, this.world.seed);
      const lane = i - (count - 1) / 2;
      r.spawn(
        startDistance + this.rng.float(-40, 40) + lane * 8,
        lane * 46 + this.rng.float(-14, 14),
        this.rng.float(-26, 26),
      );
      this.racers.push(r);
    }
    for (const r of this.racers) r.peers = this.racers;
    this.gridSize = this.racers.length + 1;
  }

  update(dt, player, timeScale = 1) {
    if (this.enabled) {
      for (const r of this.racers) {
        if (r.alive) r.update(dt, player, timeScale);
        else { r.update(dt, player, timeScale); r.tryRespawn(dt, player.distanceAlong); }
      }
      this._resolveContacts(dt, player);
      this._updateStandings(player);
    }
    this.traffic.update(dt, player.distanceAlong, player.position, timeScale);
  }

  /** Player↔rival contact and rival↔obstacle contact. */
  _resolveContacts(dt, player) {
    const pr = player.visual.span * 0.42;
    for (const r of this.racers) {
      if (!r.alive) continue;
      // Rival vs world obstacles.
      const near = this.world.queryColliders(r.position3, 160);
      for (const c of near) {
        const rr = c.radius + r.visual.span * 0.42;
        if (r.position3.distanceToSquared(c.pos) < rr * rr) {
          r.damage(c.soft ? 6 : 16);
          r.speed *= 0.72;
          r.targetLateral += (r.lateral > 0 ? 1 : -1) * 80;
          break;
        }
      }
      if (!player.alive) continue;
      // Player vs rival.
      const rr = pr + r.visual.span * 0.42;
      const d = r.position3.distanceTo(player.position);
      if (d < rr) {
        if (player.collisionCooldown <= 0 && player.invulnerable <= 0) {
          player.collisionCooldown = 0.4;
          _v.subVectors(player.position, r.position3).normalize();
          if (!isFinite(_v.x)) _v.set(0, 1, 0);
          player.position.addScaledVector(_v, rr - d + 2);
          player.velocity.addScaledVector(_v, player.speed * 0.35);
          if (!player.shieldActive) {
            player.applyDamage(14 * this.difficulty.damageScale, 'rival');
            player.speed *= 0.82;
          }
          r.damage(10);
          r.targetLateral -= _v.dot(this.world.path.nodes[r._nodeHint || 0]?.right || _v) * 70;
          this.render.vfx.sparkBurst(r.position3, _v, 22, 0xffcc66);
          this.render.rig.addShake(0.6, 24);
          this.events.push({ type: 'rivalContact', racer: r });
        }
      } else if (d < rr + 46) {
        // Close pass — counts as a near miss against another aircraft.
        if (!r._nearMissCooldown || r._nearMissCooldown <= 0) {
          r._nearMissCooldown = 1.2;
          this.events.push({ type: 'nearMiss', closeness: 1 - (d - rr) / 46, racer: r });
          this.render.rig.addShake(0.18, 30);
        }
      }
      if (r._nearMissCooldown > 0) r._nearMissCooldown -= dt;
    }
  }

  _updateStandings(player) {
    const list = this._standings;
    list.length = 0;
    list.push({ isPlayer: true, dist: player.distanceAlong, ref: player });
    for (const r of this.racers) list.push({ isPlayer: false, dist: r.distanceAlong, ref: r });
    list.sort((a, b) => b.dist - a.dist);
    for (let i = 0; i < list.length; i++) {
      if (list[i].isPlayer) this.playerPosition = i + 1;
      else list[i].ref.racePosition = i + 1;
    }
    if (this.playerPosition !== this._prevPlayerPos) {
      const gained = this.playerPosition < this._prevPlayerPos;
      this.events.push({
        type: gained ? 'overtake' : 'overtaken',
        position: this.playerPosition,
        from: this._prevPlayerPos,
      });
      this._prevPlayerPos = this.playerPosition;
    }
  }

  get standings() { return this._standings; }

  drainEvents() { const e = this.events.slice(); this.events.length = 0; return e; }

  dispose(full = true) {
    for (const r of this.racers) r.dispose();
    this.racers.length = 0;
    this._prevPlayerPos = 1;
    if (full) this.traffic.dispose();
  }
}
