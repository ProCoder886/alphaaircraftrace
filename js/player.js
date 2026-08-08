/**
 * ALPHA AIRCRAFT RACE 3D — player.js
 * ---------------------------------------------------------------------------
 * The player aircraft: input (keyboard / touch / gamepad), the arcade flight
 * model, boost, damage, collision + near-miss detection, and the five special
 * powers.
 *
 * Aircraft frame convention (shared with renderer.js):
 *   nose = local -Z · up = local +Y · right wing = local +X
 *   +rotation about local +X  = pitch up
 *   +rotation about local +Y  = yaw left
 *   +rotation about local -Z  = roll right
 */

import * as THREE from 'three';
import { Afterburner } from './renderer.js';
import {
  PHYSICS, POWERS, WORLD, DEFAULT_BINDINGS, SCORE,
  clamp, clamp01, lerp, damp, shapeAxis,
} from './config.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/* ===========================================================================
 * INPUT
 * ======================================================================== */

export class InputManager {
  constructor(bindings = null) {
    this.bindings = bindings ? { ...DEFAULT_BINDINGS, ...bindings } : { ...DEFAULT_BINDINGS };
    this.keys = new Set();
    this.pressed = new Set();     // edge-triggered this frame
    this.released = new Set();
    this.enabled = true;
    this.captureNext = null;      // rebinding callback

    this.touch = { x: 0, y: 0, active: false, buttons: new Set(), pressedButtons: new Set() };
    this.gamepadIndex = null;
    this.gamepadDeadzone = 0.14;
    this.sensitivity = 1;
    this.invertPitch = false;
    this.lastSource = 'keyboard';

    this._onKeyDown = (e) => {
      if (this.captureNext) {
        e.preventDefault();
        const cb = this.captureNext; this.captureNext = null;
        cb(e.code);
        return;
      }
      if (!this.enabled) return;
      // Never swallow browser-level shortcuts the user may need.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.lastSource = 'keyboard';
      if (this._isBound(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    };
    this._onBlur = () => { this.keys.clear(); this.touch.buttons.clear(); this.touch.active = false; this.touch.x = this.touch.y = 0; };
    this._onGamepad = (e) => { this.gamepadIndex = e.gamepad.index; this.lastSource = 'gamepad'; };
    this._onGamepadOut = () => { this.gamepadIndex = null; };

    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', this._onGamepad);
    window.addEventListener('gamepaddisconnected', this._onGamepadOut);
  }

  _isBound(code) {
    for (const list of Object.values(this.bindings)) if (list.includes(code)) return true;
    return false;
  }

  setBindings(b) { this.bindings = { ...DEFAULT_BINDINGS, ...(b || {}) }; }
  rebind(action, code) {
    // A key can only drive one action — strip it from anywhere else first.
    for (const [k, list] of Object.entries(this.bindings)) {
      if (k === action) continue;
      const i = list.indexOf(code);
      if (i >= 0) this.bindings[k] = list.filter((c) => c !== code);
    }
    this.bindings[action] = [code];
  }
  resetBindings() { this.bindings = { ...DEFAULT_BINDINGS }; }
  captureKey(cb) { this.captureNext = cb; }

  isDown(action) {
    const list = this.bindings[action];
    if (!list) return false;
    for (const c of list) if (this.keys.has(c)) return true;
    return false;
  }
  justPressed(action) {
    const list = this.bindings[action];
    if (!list) return false;
    for (const c of list) if (this.pressed.has(c)) return true;
    return false;
  }

  /* ---- touch surface (driven by ui.js) --------------------------------- */
  setTouchAxis(x, y) { this.touch.x = clamp(x, -1, 1); this.touch.y = clamp(y, -1, 1); this.touch.active = true; this.lastSource = 'touch'; }
  clearTouchAxis() { this.touch.x = 0; this.touch.y = 0; this.touch.active = false; }
  setTouchButton(name, down) {
    if (down) {
      if (!this.touch.buttons.has(name)) this.touch.pressedButtons.add(name);
      this.touch.buttons.add(name);
      this.lastSource = 'touch';
    } else this.touch.buttons.delete(name);
  }

  /* ---- gamepad --------------------------------------------------------- */
  _gamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.gamepadIndex != null && pads[this.gamepadIndex]) return pads[this.gamepadIndex];
    for (const p of pads) if (p && p.connected) { this.gamepadIndex = p.index; return p; }
    return null;
  }

  /** Consolidated control state for this frame. */
  sample() {
    const s = {
      pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, boost: false,
      powers: [false, false, false, false, false],
    };
    if (!this.enabled) return s;

    // Keyboard
    if (this.isDown('pitchUp')) s.pitch += 1;
    if (this.isDown('pitchDown')) s.pitch -= 1;
    if (this.isDown('rollRight')) s.roll += 1;
    if (this.isDown('rollLeft')) s.roll -= 1;
    if (this.isDown('yawRight')) s.yaw -= 1;
    if (this.isDown('yawLeft')) s.yaw += 1;
    if (this.isDown('throttleUp')) s.throttle += 1;
    if (this.isDown('brake')) s.brake += 1;
    if (this.isDown('boost')) s.boost = true;
    for (let i = 0; i < 5; i++) if (this.justPressed(`power${i + 1}`)) s.powers[i] = true;

    // Touch
    if (this.touch.active) {
      s.pitch += -this.touch.y;
      s.roll += this.touch.x;
    }
    const tb = this.touch.buttons;
    if (tb.has('boost')) s.boost = true;
    if (tb.has('brake')) s.brake += 1;
    if (tb.has('throttle')) s.throttle += 1;
    if (tb.has('yawLeft')) s.yaw += 1;
    if (tb.has('yawRight')) s.yaw -= 1;
    for (let i = 0; i < 5; i++) if (this.touch.pressedButtons.has(`power${i + 1}`)) s.powers[i] = true;

    // Gamepad
    const gp = this._gamepad();
    if (gp) {
      const ax = (i) => shapeAxis(gp.axes[i] || 0, this.gamepadDeadzone, 0.4);
      const lx = ax(0), ly = ax(1), rx = ax(2);
      if (lx || ly) this.lastSource = 'gamepad';
      s.roll += lx;
      s.pitch += -ly;
      s.yaw += -rx * 0.7;
      const btn = (i) => gp.buttons[i]?.pressed;
      const val = (i) => gp.buttons[i]?.value || 0;
      if (btn(0)) s.boost = true;
      s.throttle += val(7);
      s.brake += val(6);
      for (let i = 0; i < 4; i++) if (btn(12 + i) && !this._gpPrev?.[12 + i]) s.powers[i] = true;
      if (btn(1) && !this._gpPrev?.[1]) s.powers[4] = true;
      this._gpPrev = gp.buttons.map((b) => b.pressed);
    }

    if (this.invertPitch) s.pitch = -s.pitch;
    s.pitch = clamp(s.pitch, -1, 1) * this.sensitivity;
    s.roll = clamp(s.roll, -1, 1) * this.sensitivity;
    s.yaw = clamp(s.yaw, -1, 1) * this.sensitivity;
    s.throttle = clamp01(s.throttle);
    s.brake = clamp01(s.brake);
    return s;
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.touch.pressedButtons.clear();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('gamepadconnected', this._onGamepad);
    window.removeEventListener('gamepaddisconnected', this._onGamepadOut);
  }
}

/* ===========================================================================
 * AIRCRAFT VISUAL — mesh + trails + afterburners (shared by player and AI)
 * ======================================================================== */

export class AircraftVisual {
  constructor(render, spec, detail = 2, opts = {}) {
    this.render = render;
    this.spec = spec;
    this.detail = detail;
    const inst = render.aircraftFactory.instance(spec, detail);
    this.group = inst.group;
    this.surfaces = inst.surfaces;
    this.nozzles = inst.nozzlePositions;
    this.wingTips = inst.wingTips;
    this.length = inst.length;
    this.span = inst.span;
    this.radius = inst.radius;
    this.engineRadius = inst.engineRadius;

    this.root = new THREE.Group();
    this.root.add(this.group);
    render.scene.add(this.root);

    // Afterburners at every nozzle.
    this.burners = [];
    for (const n of this.nozzles) {
      const ab = new Afterburner(this.engineRadius, spec.colors.emissive);
      ab.group.position.copy(n);
      this.group.add(ab.group);
      this.burners.push(ab);
    }

    // Power effect shell (shield / phase / turbo). Rendered back-face only with
    // a sharp fresnel so it reads as a thin envelope around the airframe rather
    // than a solid ball obscuring the route.
    this._shellMats = {
      shield: render.materials.energy(0x5fe4ff, { intensity: 0.34, hexScale: 2.6, fresnel: 4.5, side: THREE.BackSide, pulse: 0.6 }),
      phase: render.materials.energy(0xb478ff, { intensity: 0.42, hexScale: 1.6, fresnel: 3.4, scroll: 2.6, side: THREE.BackSide }),
      turbo: render.materials.energy(0xff8a3a, { intensity: 0.32, hexScale: 3.4, fresnel: 5.0, side: THREE.BackSide, pulse: 0.4 }),
    };
    this.shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(Math.max(this.span, this.length) * 0.40, 2),
      this._shellMats.shield,
    );
    this.shell.visible = false;
    this.shell.renderOrder = 7;
    this.root.add(this.shell);

    // Engine trails + wingtip vapour.
    this.engineTrails = [];
    this.tipTrails = [];
    if (opts.trails !== false) {
      const segs = Math.max(12, Math.round(render.quality.preset.trailSegments * (detail >= 2 ? 1 : 0.5)));
      for (const n of this.nozzles) {
        const t = render.vfx.createTrail(spec.colors.trail, this.engineRadius * 1.3, segs,
          { minDist: 2.5, opacity: 0, taper: 1.5 });
        t.anchor = n.clone();
        this.engineTrails.push(t);
      }
      if (detail >= 2) {
        for (const w of this.wingTips) {
          const t = render.vfx.createTrail(0xffffff, 1.5, Math.round(segs * 0.8),
            { minDist: 4, opacity: 0, taper: 2.2, blending: THREE.NormalBlending });
          t.anchor = w.clone();
          this.tipTrails.push(t);
        }
      }
    }

    this.controlBlend = { pitch: 0, roll: 0, yaw: 0 };
    this._wp = new THREE.Vector3();
    this.visible = true;
    this.damageSmokeTimer = 0;
  }

  setVisible(v) {
    this.visible = v;
    this.root.visible = v;
    for (const t of this.engineTrails) t.mesh.visible = v;
    for (const t of this.tipTrails) t.mesh.visible = v;
  }

  resetTrails() {
    for (const t of this.engineTrails) t.reset();
    for (const t of this.tipTrails) t.reset();
  }

  /**
   * @param state {throttle, boost, speed01, pitch, roll, yaw, alive, gLoad,
   *               altitude, damage01, phase}
   */
  update(dt, state) {
    this.root.position.copy(state.position);
    this.root.quaternion.copy(state.quaternion);

    // Control surfaces lag the input slightly — reads as real actuation.
    const cb = this.controlBlend;
    cb.pitch = damp(cb.pitch, state.pitch || 0, 11, dt);
    cb.roll = damp(cb.roll, state.roll || 0, 11, dt);
    cb.yaw = damp(cb.yaw, state.yaw || 0, 11, dt);
    const a = this.surfaces;
    if (a.ailerons.length === 2) {
      a.ailerons[0].rotation.x = (-cb.roll * 0.45) + cb.pitch * 0.12;
      a.ailerons[1].rotation.x = (cb.roll * 0.45) + cb.pitch * 0.12;
    }
    for (const e of a.elevons) e.rotation.x = -cb.pitch * 0.40;
    for (const r of a.rudders) r.rotation.y = cb.yaw * 0.36;

    // Afterburners.
    const burn = state.alive ? clamp01(state.throttle * 0.75 + (state.boost || 0) * 0.6) : 0;
    for (const b of this.burners) b.update(dt, burn, state.boost || 0);

    // Trails.
    const trailOpacity = state.alive
      ? clamp01((state.speed01 - 0.12) * 1.6) * (0.18 + (state.boost || 0) * 0.34) : 0;
    for (const t of this.engineTrails) {
      this._wp.copy(t.anchor).applyQuaternion(state.quaternion).add(state.position);
      t.push(this._wp);
      t.setOpacity(damp(t.material.uniforms.uOpacity.value, trailOpacity, 6, dt));
      t.setWidth(this.engineRadius * (0.34 + (state.boost || 0) * 0.40));
    }
    // Wingtip vapour appears under load or at altitude — the physical cue that
    // the airframe is actually working.
    const vapour = clamp01((Math.abs(state.gLoad || 0) - 1.6) * 0.5)
      * clamp01((state.speed01 - 0.35) * 2)
      + clamp01(((state.altitude || 0) - 3000) / 2500) * clamp01(state.speed01 * 1.4) * 0.6;
    for (const t of this.tipTrails) {
      this._wp.copy(t.anchor).applyQuaternion(state.quaternion).add(state.position);
      t.push(this._wp);
      t.setOpacity(damp(t.material.uniforms.uOpacity.value, state.alive ? clamp01(vapour) * 0.7 : 0, 5, dt));
    }

    // Damage smoke.
    if (state.alive && (state.damage01 || 0) > 0.55) {
      this.damageSmokeTimer -= dt;
      if (this.damageSmokeTimer <= 0) {
        this.damageSmokeTimer = lerp(0.16, 0.04, (state.damage01 - 0.55) / 0.45);
        this._wp.set(0, 0, this.length * 0.3).applyQuaternion(state.quaternion).add(state.position);
        this.render.vfx.smokePuff(this._wp, 2, 3.2, state.damage01 > 0.85 ? 0x2a2a2a : 0x6a6a6a);
        if (state.damage01 > 0.85) this.render.vfx.sparkBurst(this._wp, null, 3, 0xff7a2a);
      }
    }

    // Power shell: shield > phase > turbo, whichever is live.
    const shellKind = state.shield ? 'shield' : state.phase ? 'phase' : state.turbo ? 'turbo' : null;
    if (shellKind) {
      this.shell.visible = true;
      this.shell.material = this._shellMats[shellKind];
      const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.03;
      this.shell.scale.setScalar(pulse);
    } else {
      this.shell.visible = false;
    }
  }

  dispose() {
    for (const b of this.burners) b.dispose();
    for (const t of this.engineTrails) this.render.vfx.removeTrail(t);
    for (const t of this.tipTrails) this.render.vfx.removeTrail(t);
    this.shell.geometry.dispose();
    this.render.scene.remove(this.root);
    // Geometry/materials belong to the cached factory template — not ours to free.
  }
}

/* ===========================================================================
 * POWER SYSTEM
 * ======================================================================== */

export class PowerSystem {
  constructor(owner) {
    this.owner = owner;
    this.slots = POWERS.map((p) => ({
      def: p, cooldown: 0, active: 0, uses: 0, ready: true,
    }));
    this.cooldownScale = 1;
    this.durationScale = { phase: 1 };
  }

  reset() {
    for (const s of this.slots) { s.cooldown = 0; s.active = 0; s.uses = 0; s.ready = true; }
  }

  get(id) { return this.slots.find((s) => s.def.id === id); }
  isActive(id) { return (this.get(id)?.active || 0) > 0; }

  activate(index) {
    const s = this.slots[index];
    if (!s || s.cooldown > 0 || s.active > 0) return null;
    let dur = s.def.duration;
    if (s.def.id === 'phase') dur *= this.durationScale.phase || 1;
    s.active = dur;
    s.cooldown = s.def.cooldown * this.cooldownScale + dur;
    s.uses++;
    s.ready = false;
    return s;
  }

  update(dt) {
    for (const s of this.slots) {
      if (s.active > 0) {
        s.active = Math.max(0, s.active - dt);
        if (s.active === 0) this.onExpire?.(s);
      }
      if (s.cooldown > 0) {
        s.cooldown = Math.max(0, s.cooldown - dt);
        if (s.cooldown === 0 && !s.ready) { s.ready = true; this.onReady?.(s); }
      }
    }
  }
}

/* ===========================================================================
 * PLAYER
 * ======================================================================== */

export class Player {
  constructor(render, world, spec, settings = {}) {
    this.render = render;
    this.world = world;
    this.spec = spec;
    this.settings = settings;

    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.prevPosition = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.upVec = new THREE.Vector3(0, 1, 0);
    this.rightVec = new THREE.Vector3(1, 0, 0);

    this.applySpec(spec);

    this.speed = PHYSICS.cruiseSpeed * 0.75;
    this.throttle = 0.85;
    this.throttleTarget = 0.85;
    this.boostMeter = 100;
    this.boosting = false;
    this.boostBlend = 0;
    this.boostCooldown = 0;
    this.burner = 0;             // reheat spool state, 0..1
    this.health = this.maxHealth;
    this.alive = true;
    this.sink = 0;
    this.gLoad = 1;
    this.loadFactor = 1;         // n — what the wing is actually pulling
    this.rollRateActual = 0;     // rad/s, lagged behind the aileron command
    this.aoa01 = 0;              // how close the wing is to its lift limit
    this.stunned = 0;
    this.invulnerable = 1.5;

    this.powers = new PowerSystem(this);
    this.visual = new AircraftVisual(render, spec, 2);

    this.pathHint = 0;
    this.distanceAlong = 0;
    this.distanceTravelled = 0;
    this.lastCheckpointId = -1;
    this.nearMissCache = new Map();
    this.events = [];
    this.controls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, boost: false };
    this.smoothControls = { pitch: 0, roll: 0, yaw: 0 };

    this.bankAngle = 0;
    this.pitchAngle = 0;
    this.headingDeg = 0;
    this.altitude = 0;
    this.agl = 0;
    this.terrainWarning = 0;
    this.collisionCooldown = 0;
    this.damageFlashTimer = 0;
    this.speed01 = 0.5;
    this.corridorOut = 0;
    this.pathOffset = 0;
    this.pathRadius = WORLD.corridorRadius;
  }

  applySpec(spec) {
    const st = spec.stats;
    this.topSpeed = PHYSICS.maxSpeed * lerp(0.80, 1.14, st.speed);
    this.accelPower = PHYSICS.baseThrust * lerp(0.70, 1.30, st.accel);
    this.agility = lerp(0.66, 1.32, st.handling);
    this.boostPower = lerp(0.78, 1.24, st.boost);
    this.maxHealth = PHYSICS.maxHealth * lerp(0.72, 1.40, st.durability);
    this.mass = lerp(0.8, 1.35, st.durability);
    // A stronger airframe carries a higher structural G limit; a nimble one
    // reaches it sooner. Both feed the same turn equation.
    this.gStrength = lerp(0.86, 1.16, st.durability * 0.45 + st.handling * 0.55);

    // Airframe abilities.
    const ab = spec.abilityKey;
    this.ability = ab;
    this.boostCapacity = ab === 'reserves' ? 130 : 100;
    this.autoLevelScale = ab === 'trim' ? 1.3 : 1;
    this.damageScale = ab === 'ablative' ? 0.6 : 1;
    this.nearMissBonus = ab === 'predator' ? 1.4 : 1;
    this.scanRangeScale = ab === 'deepscan' ? 1.6 : 1;
    this.turboBonus = ab === 'overcharge' ? 1.12 : 1;
    this.vectorTurn = ab === 'vector' ? 1.25 : 1;
    this.ramAir = ab === 'ramair';
    if (this.powers) {
      this.powers.cooldownScale = ab === 'tuning' ? 0.85 : 1;
      this.powers.durationScale.phase = ab === 'ghost' ? 1.5 : 1;
    }
  }

  /** Place the aircraft at a distance along the route. */
  placeOnPath(distance, lateralOffset = 0, verticalOffset = 0) {
    const s = this.world.path.sample(distance, {});
    this.position.copy(s.pos)
      .addScaledVector(s.right, lateralOffset)
      .addScaledVector(s.up, verticalOffset);
    this.prevPosition.copy(this.position);
    const m = new THREE.Matrix4().lookAt(_v.set(0, 0, 0), s.tangent, s.up);
    this.quaternion.setFromRotationMatrix(m);
    this.velocity.copy(s.tangent).multiplyScalar(this.speed);
    this.distanceAlong = distance;
    this.pathHint = s.index;
    this.visual.resetTrails();
    this.render.rig.reset();
  }

  reset(spec, distance = 0) {
    if (spec && spec !== this.spec) {
      this.visual.dispose();
      this.spec = spec;
      this.applySpec(spec);
      this.visual = new AircraftVisual(this.render, spec, 2);
    }
    // Match the rival grid's launch speed so the start is fair.
    this.speed = PHYSICS.cruiseSpeed * 0.85;
    this.throttle = this.throttleTarget = 0.85;
    this.burner = 0;
    this.loadFactor = 1;
    this.rollRateActual = 0;
    this.boostMeter = this.boostCapacity;
    this.health = this.maxHealth;
    this.alive = true;
    this.sink = 0;
    this.stunned = 0;
    this.invulnerable = 1.5;
    this.distanceTravelled = 0;
    this.lastCheckpointId = -1;
    this.nearMissCache.clear();
    this.events.length = 0;
    this.powers.reset();
    this.visual.setVisible(true);
    this.placeOnPath(distance);
  }

  /* ---------------------------------------------------------------------
   * FLIGHT MODEL
   * ------------------------------------------------------------------ */

  update(dt, input, world, difficulty) {
    if (!this.alive) { this._updateDead(dt); return; }
    this.prevPosition.copy(this.position);
    const c = this.controls;
    Object.assign(c, input);

    /* --- powers ------------------------------------------------------ */
    for (let i = 0; i < 5; i++) {
      if (input.powers?.[i]) {
        const s = this.powers.activate(i);
        if (s) this.events.push({ type: 'power', power: s.def, index: i });
        else this.events.push({ type: 'powerBlocked', index: i });
      }
    }
    this.powers.update(dt);
    const turbo = this.powers.isActive('turbo');
    const shield = this.powers.isActive('shield');
    const phase = this.powers.isActive('phase');
    const scan = this.powers.isActive('scan');

    /* --- orientation ---------------------------------------------------
     * A fighter is a G-command machine in pitch and a rate-command machine in
     * roll, and both are limited by how fast it is going. That is the whole
     * model: everything below is those two facts plus the drag they cost.
     * ------------------------------------------------------------------ */
    const stunScale = this.stunned > 0 ? 0.25 : 1;
    const sc = this.smoothControls;
    const responsiveness = 14 * stunScale;
    sc.pitch = damp(sc.pitch, c.pitch, responsiveness, dt);
    sc.roll = damp(sc.roll, c.roll, responsiveness * 1.15, dt);
    sc.yaw = damp(sc.yaw, c.yaw, responsiveness * 0.8, dt);

    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.upVec.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.rightVec.set(1, 0, 0).applyQuaternion(this.quaternion);

    const V = Math.max(45, this.speed);
    const q01 = clamp01(V / PHYSICS.maxSpeed);          // dynamic pressure, roughly
    // Thin air above the soft ceiling costs you control.
    const thin = clamp01((this.position.y - WORLD.softCeiling) / 1600);
    let authority = this.agility * stunScale * lerp(1, 0.55, thin);
    if (turbo) authority *= 0.86 * this.vectorTurn;
    else if (this.boosting) authority *= this.vectorTurn;

    // Pitch: the stick asks for a load factor. The wing can only deliver it if
    // it is going fast enough — lift goes with V², so the same pull that snaps
    // the nose round at 300 km/h barely bends it at 2000.
    const gLimit = PHYSICS.gLimit * this.gStrength * (turbo ? 0.92 : 1);
    const nAvailable = gLimit * clamp01((V / PHYSICS.cornerSpeed) ** 2);
    const nCommand = sc.pitch >= 0
      ? 1 + sc.pitch * (gLimit - 1)
      : 1 + sc.pitch * (1 + PHYSICS.gLimitNeg);
    this.loadFactor = damp(this.loadFactor,
      clamp(nCommand, -PHYSICS.gLimitNeg, Math.min(gLimit, nAvailable)), 1 / PHYSICS.pitchTau, dt);
    // q = G(n − upY)/V. With the stick centred in level flight n = 1 and
    // upY = 1, so the nose holds; roll away from level and it starts to fall.
    const pitchRate = PHYSICS.flightG * (this.loadFactor - this.upVec.y) / V * authority;

    // Roll: ailerons bite hardest in the middle of the band — mushy when slow,
    // stiff against the airflow when very fast — and a loaded wing rolls slower.
    const rollAuth = authority * lerp(0.5, 1, clamp01(V / 175)) * lerp(1, 0.66, q01 ** 1.6)
      * lerp(1, 0.72, clamp01(Math.abs(this.loadFactor) / gLimit));
    this.rollRateActual = damp(this.rollRateActual, PHYSICS.rollRate * rollAuth * sc.roll,
      1 / PHYSICS.rollTau, dt);
    const rollRate = this.rollRateActual;

    // Yaw: the rudder is a low-speed control, and rolling drags the nose the
    // wrong way until you catch it.
    const yawRate = PHYSICS.yawRate * authority * lerp(1, 0.34, q01 ** 1.3) * sc.yaw
      + rollRate * PHYSICS.adverseYaw * (1 - clamp01(Math.abs(sc.yaw)));

    _q.setFromAxisAngle(this.rightVec, pitchRate * dt);
    this.quaternion.premultiply(_q);
    _q.setFromAxisAngle(this.forward, -rollRate * dt);
    this.quaternion.premultiply(_q);
    _q.setFromAxisAngle(this.upVec, yawRate * dt);
    this.quaternion.premultiply(_q);

    // Auto-level assist: with the stick centred the airframe rolls upright.
    const levelStrength = PHYSICS.autoLevel * this.autoLevelScale
      * (1 - Math.min(1, Math.abs(c.roll) * 2.2)) * (1 - Math.min(1, Math.abs(c.pitch) * 1.1));
    if (levelStrength > 0.01) {
      this.upVec.set(0, 1, 0).applyQuaternion(this.quaternion);
      this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
      // Target up = world up projected perpendicular to the current heading.
      _v.copy(_up).addScaledVector(this.forward, -_up.dot(this.forward)).normalize();
      if (_v.lengthSq() > 0.1) {
        const dot = clamp(this.upVec.dot(_v), -1, 1);
        const ang = Math.acos(dot);
        if (ang > 0.002) {
          _v2.crossVectors(this.upVec, _v);
          // Exactly inverted: the cross product degenerates to zero and the
          // assist would silently do nothing, leaving the aircraft stuck on
          // its back. Roll about the nose instead so it can right itself.
          if (_v2.lengthSq() < 1e-9) _v2.copy(this.forward);
          _v2.normalize();
          _q.setFromAxisAngle(_v2, Math.min(ang, levelStrength * dt * 1.6));
          this.quaternion.premultiply(_q);
        }
      }
    }
    this.quaternion.normalize();

    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.upVec.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.rightVec.set(1, 0, 0).applyQuaternion(this.quaternion);

    /* --- engine and energy ----------------------------------------------
     * Thrust does not appear the instant you ask for it: the core spools, and
     * reheat lights a beat later. That lag is most of why a real jet feels
     * heavy, and it is what makes the boost button worth timing.
     * ------------------------------------------------------------------ */
    this.throttleTarget = clamp01(0.82 + c.throttle * 0.18 + Math.max(0, c.pitch) * 0.10
      - Math.max(0, -c.pitch) * 0.22 - c.brake * 0.75);
    this.throttle = damp(this.throttle, this.throttleTarget,
      1 / (this.throttleTarget > this.throttle ? PHYSICS.spoolUp : PHYSICS.spoolDown), dt);

    this.boostCooldown = Math.max(0, this.boostCooldown - dt);
    const wantBoost = c.boost && this.boostMeter > 1 && !this.stunned;
    this.boosting = wantBoost;
    if (wantBoost) {
      this.boostMeter = Math.max(0, this.boostMeter - PHYSICS.boostDrain * dt);
      this.boostCooldown = PHYSICS.boostRegenDelay;
    } else if (this.boostCooldown <= 0) {
      const regenBonus = (this.ramAir && this.speed > PHYSICS.maxSpeed * 0.78) ? 1.35 : 1;
      this.boostMeter = Math.min(this.boostCapacity, this.boostMeter + PHYSICS.boostRegen * regenBonus * dt);
    }
    // Reheat lights fast and dies fast, but never instantly.
    this.burner = damp(this.burner, wantBoost ? 1 : 0, wantBoost ? 1 / PHYSICS.burnerLight : 4.5, dt);
    this.boostBlend = damp(this.boostBlend, this.burner * 0.7 + (turbo ? 1 : 0) * 0.3, 5, dt);

    let cap = this.topSpeed;
    if (this.boosting) cap = PHYSICS.boostSpeed * (this.topSpeed / PHYSICS.maxSpeed) * 0.94;
    if (turbo) cap = PHYSICS.boostSpeed * this.turboBonus * (this.topSpeed / PHYSICS.maxSpeed);
    cap *= lerp(1, 0.88, thin);

    let thrust = this.accelPower * this.throttle;
    thrust += PHYSICS.boostAccel * this.boostPower * this.burner;
    if (turbo) thrust += PHYSICS.boostAccel * 1.35 * this.boostPower;
    // Gravity along the flight path: a dive is free speed, a climb costs it.
    thrust += -this.forward.y * PHYSICS.flightG;
    // Parasitic drag goes with V², induced drag with n²/V. Holding a hard turn
    // therefore costs energy exactly where a real one does — and the harder you
    // pull the more it costs, which is what makes the racing line matter.
    const parasitic = PHYSICS.dragCoefficient * this.speed * this.speed
      * (1 + c.brake * 3.2 + Math.abs(sc.roll) * 0.14);
    const induced = PHYSICS.inducedDrag * this.loadFactor * this.loadFactor / V;
    this.speed += (thrust - parasitic - induced) * dt;
    if (this.speed > cap) this.speed = damp(this.speed, cap, 2.4, dt);
    this.speed = clamp(this.speed, PHYSICS.minSpeed * 0.55, PHYSICS.boostSpeed * 1.1);

    /* --- integrate ------------------------------------------------------ */
    // Below the speed at which the wing can hold 1 g the airframe simply mushes.
    this.sink = damp(this.sink, clamp01(1 - nAvailable) * PHYSICS.stallSink, 2.0, dt);
    this.velocity.copy(this.forward).multiplyScalar(this.speed);
    this.velocity.y -= this.sink;

    // Wind + turbulence (world.turbulence already folds in difficulty).
    const turb = world.turbulence;
    if (world.windVec) this.velocity.addScaledVector(world.windVec, 0.22);
    if (turb > 0.01 && !this.stunned) {
      const t = performance.now() * 0.001;
      const jx = Math.sin(t * 7.3) * Math.sin(t * 2.1);
      const jy = Math.sin(t * 5.7 + 1.3) * Math.sin(t * 3.3);
      _q.setFromAxisAngle(this.rightVec, jy * turb * 0.30 * dt);
      this.quaternion.premultiply(_q);
      _q.setFromAxisAngle(this.forward, jx * turb * 0.55 * dt);
      this.quaternion.premultiply(_q);
      this.velocity.y += jy * turb * 12;
    }

    this.position.addScaledVector(this.velocity, dt);
    this.distanceTravelled += this.velocity.length() * dt;

    /* --- world coupling -------------------------------------------------- */
    const proj = world.path.project(this.position, this.pathHint, 30);
    this.pathHint = proj.nodeIndex;
    this.distanceAlong = proj.along;
    this.pathOffset = proj.offset;
    this.pathOffsetLateral = proj.lateral;
    this.pathOffsetVertical = proj.vertical;
    this.pathRadius = proj.radius;
    this.corridorOut = proj.offset / Math.max(1, proj.radius);

    const ground = world.terrainHeight(this.position.x, this.position.z);
    this.altitude = this.position.y;
    this.agl = this.position.y - ground;
    this.terrainWarning = clamp01(1 - this.agl / 220);

    // Ceiling / floor handling.
    if (this.position.y > WORLD.maxAltitude) {
      this.position.y = WORLD.maxAltitude;
      this.velocity.y = Math.min(0, this.velocity.y);
    }
    if (this.agl < 6) this._groundStrike(ground);

    /* --- orientation readouts -------------------------------------------- */
    this.bankAngle = Math.atan2(this.rightVec.y, this.upVec.y);
    this.pitchAngle = Math.asin(clamp(this.forward.y, -1, 1));
    this.headingDeg = (Math.atan2(this.forward.x, this.forward.z) * 180 / Math.PI + 360) % 360;
    // The G-meter shows the real, unitless load factor the wing is pulling.
    this.gLoad = this.loadFactor;
    this.aoa01 = clamp01(Math.abs(this.loadFactor) / Math.max(1e-3, nAvailable));

    /* --- collisions, rings, checkpoints ----------------------------------- */
    this.collisionCooldown = Math.max(0, this.collisionCooldown - dt);
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.stunned = Math.max(0, this.stunned - dt);
    this._checkColliders(dt, world, phase, shield, difficulty);
    this._checkRings(world);
    this._checkCheckpoints(world);

    /* --- visual ----------------------------------------------------------- */
    this.speed01 = clamp01((this.speed - PHYSICS.minSpeed) / (this.topSpeed - PHYSICS.minSpeed));
    this.visual.update(dt, {
      position: this.position, quaternion: this.quaternion,
      throttle: this.throttle, boost: this.boostBlend, speed01: this.speed01,
      pitch: sc.pitch, roll: sc.roll, yaw: sc.yaw, alive: true,
      gLoad: this.gLoad, altitude: this.altitude,
      damage01: 1 - this.health / this.maxHealth,
      phase, shield, turbo,
    });

    this.scanActive = scan;
    this.shieldActive = shield;
    this.phaseActive = phase;
    this.freezeActive = this.powers.isActive('freeze');
    this.turboActive = turbo;

    this._sanitise();
  }

  /**
   * Last line of defence for the flight state.
   *
   * A single non-finite number anywhere in the physics would otherwise
   * propagate into the route projection, the AI (which reads the player's
   * distance for rubber-banding) and the renderer, turning one bad frame into
   * a dead run. Keep a rolling snapshot of the last good transform and roll
   * back to it instead, reporting once so the cause is still visible.
   */
  _sanitise() {
    const p = this.position, q = this.quaternion, v = this.velocity;
    const ok = Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
      && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w)
      && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
      && Number.isFinite(this.speed) && Number.isFinite(this.distanceAlong);

    if (ok) {
      if (!this._safe) this._safe = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
      this._safe.pos.copy(p);
      this._safe.quat.copy(q);
      this._safe.speed = this.speed;
      this._safe.distance = this.distanceAlong;
      return false;
    }

    if (!this._nanReported) {
      this._nanReported = true;
      console.warn('[Player] non-finite flight state recovered', {
        position: [p.x, p.y, p.z],
        quaternion: [q.x, q.y, q.z, q.w],
        velocity: [v.x, v.y, v.z],
        speed: this.speed, sink: this.sink, throttle: this.throttle,
        distanceAlong: this.distanceAlong, pathHint: this.pathHint,
        controls: { ...this.smoothControls },
        agl: this.agl, altitude: this.altitude, health: this.health,
      });
    }
    if (this._safe) {
      p.copy(this._safe.pos);
      q.copy(this._safe.quat);
      this.speed = this._safe.speed;
      this.distanceAlong = this._safe.distance;
    } else {
      p.set(0, 1000, 0);
      q.identity();
      this.speed = PHYSICS.cruiseSpeed;
      this.distanceAlong = 0;
    }
    this.prevPosition.copy(p);
    this.velocity.set(0, 0, -1).applyQuaternion(q).multiplyScalar(this.speed);
    this.sink = 0;
    this.loadFactor = 1;
    this.rollRateActual = 0;
    this.smoothControls.pitch = this.smoothControls.roll = this.smoothControls.yaw = 0;
    return true;
  }

  _updateDead(dt) {
    // Tumble to the ground so the crash reads as a real event.
    this.velocity.y -= PHYSICS.gravity * 2.4 * dt;
    this.velocity.multiplyScalar(1 - dt * 0.32);
    this.position.addScaledVector(this.velocity, dt);
    _q.setFromAxisAngle(this.deathSpinAxis || _up, (this.deathSpin || 2) * dt);
    this.quaternion.premultiply(_q);
    const ground = this.world.terrainHeight(this.position.x, this.position.z);
    if (this.position.y <= ground + 4 && !this.impacted) {
      this.impacted = true;
      this.position.y = ground + 4;
      this.render.vfx.explode(this.position, 26, 0xffa040);
      this.render.postfx.flash(0.5, 0xffcc88);
      this.render.rig.addShake(0.9, 20);
      this.visual.setVisible(false);
      this.events.push({ type: 'impact' });
    }
    this.visual.update(dt, {
      position: this.position, quaternion: this.quaternion,
      throttle: 0, boost: 0, speed01: 0, pitch: 0, roll: 0, yaw: 0, alive: false,
      gLoad: 0, altitude: this.position.y, damage01: 1,
    });
  }

  _groundStrike(ground) {
    if (this.invulnerable > 0 || this.shieldActive) {
      this.position.y = ground + 18;
      this.velocity.y = Math.abs(this.velocity.y) * 0.5 + 30;
      return;
    }
    const impactSpeed = Math.max(0, -this.velocity.y) + this.speed * 0.35;
    const dmg = clamp(impactSpeed * 0.45, 18, 200);
    this.position.y = ground + 12;
    this.velocity.y = Math.abs(this.velocity.y) * 0.35 + 24;
    this.speed *= 0.62;
    this.applyDamage(dmg, 'terrain');
    this.render.vfx.explode(this.position, 9, 0xffb060);
    this.render.rig.addShake(0.8, 30);
    this.stunned = 0.6;
  }

  _checkColliders(dt, world, phase, shield, difficulty) {
    const near = world.queryColliders(this.position, 420);
    const myR = this.visual.span * 0.42;
    const segStart = this._segStart || (this._segStart = new THREE.Vector3());
    const segDir = this._segDir || (this._segDir = new THREE.Vector3());
    segStart.copy(this.prevPosition);
    // Dedicated vectors, not the shared module scratch: _impact() moves the
    // aircraft and reuses _v, which would corrupt the sweep for every
    // remaining collider in this frame's list.
    segDir.subVectors(this.position, segStart);
    const segLen = segDir.length();
    if (segLen > 0.0001) segDir.divideScalar(segLen);

    for (const cbox of near) {
      const hitR = cbox.radius + myR;
      // Swept sphere vs sphere along this frame's travel.
      _v2.subVectors(cbox.pos, segStart);
      const t = clamp(_v2.dot(segDir), 0, segLen);
      _v3.copy(segStart).addScaledVector(segDir, t);
      const dist = _v3.distanceTo(cbox.pos);

      if (dist < hitR) {
        if (phase && cbox.soft) continue;
        if (this.collisionCooldown > 0) continue;
        this._impact(cbox, _v3, shield, difficulty);
        continue;
      }
      // Near miss — scored once per obstacle, and only when genuinely close.
      const missR = hitR + 52;
      if (dist < missR) {
        if (this.nearMissCache.has(cbox)) continue;
        this.nearMissCache.set(cbox, true);
        const closeness = 1 - (dist - hitR) / 52;
        this.events.push({
          type: 'nearMiss',
          closeness,
          score: (closeness > 0.6 ? SCORE.nearMissClose : SCORE.nearMiss) * this.nearMissBonus,
          position: _v3.clone(),
        });
        this.render.rig.addShake(0.10 + closeness * 0.16, 34);
      }
    }
    // Forget obstacles we have left well behind so they can score again if the
    // route loops back past them.
    if (this.nearMissCache.size > 220) {
      for (const [k] of this.nearMissCache) {
        if (k.pos.distanceToSquared(this.position) > 1.2e6) this.nearMissCache.delete(k);
      }
    }
  }

  _impact(cbox, point, shield, difficulty) {
    this.collisionCooldown = 0.35;
    const dmgScale = (difficulty?.damageScale ?? 1) * this.damageScale;
    const damage = cbox.damage * dmgScale * (0.6 + this.speed / PHYSICS.maxSpeed * 0.9);

    // Push out of the obstacle and bleed speed.
    _v.subVectors(this.position, cbox.pos).normalize();
    if (!isFinite(_v.x)) _v.set(0, 1, 0);
    this.position.addScaledVector(_v, (cbox.radius + this.visual.span * 0.42) - this.position.distanceTo(cbox.pos) + 2);
    this.velocity.addScaledVector(_v, this.speed * PHYSICS.collisionBounce);
    this.speed *= cbox.soft ? 0.88 : 0.62;

    if (shield) {
      this.render.vfx.explode(point, 6, 0x5fe4ff);
      this.render.postfx.flash(0.22, 0x5fe4ff);
      this.render.rig.addShake(0.3, 26);
      this.events.push({ type: 'shielded', position: point.clone() });
      return;
    }
    this.applyDamage(damage, cbox.type);
    this.stunned = Math.max(this.stunned, cbox.soft ? 0.18 : (difficulty?.recoveryWindow ?? 1.5) * 0.28);
    this.render.vfx.explode(point, cbox.soft ? 5 : 11, 0xffa040);
    this.render.vfx.sparkBurst(point, _v, 26, 0xffcc66);
    this.render.postfx.flash(cbox.soft ? 0.18 : 0.34, 0xffd0a0);
    this.render.rig.addShake(cbox.soft ? 0.4 : 0.85, 22);
    this.events.push({ type: 'collision', damage, soft: cbox.soft, position: point.clone() });
  }

  _checkRings(world) {
    const rings = world.ringsNear(this.position, 260);
    for (const r of rings) {
      const d0 = _v.subVectors(this.prevPosition, r.pos).dot(r.normal);
      const d1 = _v2.subVectors(this.position, r.pos).dot(r.normal);
      if (d0 > 0 || d1 < 0) continue;                    // not crossing forward
      const denom = d0 - d1;
      const t = Math.abs(denom) < 1e-6 ? 0 : clamp01(d0 / denom);
      _v3.lerpVectors(this.prevPosition, this.position, t);
      // Radial distance at the crossing point.
      _v.copy(_v3).sub(r.pos);
      const radial = _v.length();
      if (radial > r.radius * 1.05) continue;
      r.collected = true;
      r.object.visible = false;
      this.events.push({ type: 'ring', ring: r, precision: 1 - radial / r.radius });
      if (r.kind === 'boost') this.boostMeter = Math.min(this.boostCapacity, this.boostMeter + 28);
      if (r.kind === 'bonus') this.boostMeter = Math.min(this.boostCapacity, this.boostMeter + 14);
      this.render.vfx.sparkBurst(r.pos, this.forward, 14, r.color);
      this.render.postfx.flash(0.10, r.color);
    }
  }

  _checkCheckpoints(world) {
    for (const cp of world.checkpointList) {
      if (cp.passed || cp.missed) continue;
      if (cp.id < this.lastCheckpointId) continue;
      // Flown past it entirely (wide of the gate, or off the route) — that is
      // a miss even though we never crossed its plane near the centre.
      if (this.distanceAlong > cp.node.dist + 420) {
        cp.missed = true;
        this.lastCheckpointId = cp.id;
        this.events.push({ type: 'checkpointMissed', checkpoint: cp });
        continue;
      }
      const n = cp.normal;
      const d0 = _v.subVectors(this.prevPosition, cp.pos).dot(n);
      const d1 = _v2.subVectors(this.position, cp.pos).dot(n);
      if (d0 > 0 || d1 < 0) continue;
      const denom = d0 - d1;
      const t = Math.abs(denom) < 1e-6 ? 0 : clamp01(d0 / denom);
      _v3.lerpVectors(this.prevPosition, this.position, t);
      _v.copy(_v3).sub(cp.pos);
      const radial = _v.length();
      if (radial <= cp.radius) {
        cp.passed = true;
        this.lastCheckpointId = cp.id;
        const precision = 1 - radial / cp.radius;
        cp.object.visible = false;
        this.events.push({ type: 'checkpoint', checkpoint: cp, precision });
        this.render.postfx.flash(0.14, world.biome.accent);
      } else if (radial < cp.radius * 3.2) {
        cp.missed = true;
        this.lastCheckpointId = cp.id;
        this.events.push({ type: 'checkpointMissed', checkpoint: cp });
      }
    }
  }

  applyDamage(amount, source) {
    if (this.invulnerable > 0 || !this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.damageFlashTimer = 0.4;
    if (this.health <= 0) this.destroy(source);
  }

  heal(amount) { this.health = Math.min(this.maxHealth, this.health + amount); }

  destroy(reason = 'collision') {
    if (!this.alive) return;
    this.alive = false;
    this.impacted = false;
    this.deathSpin = 3 + Math.random() * 3;
    this.deathSpinAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.velocity.multiplyScalar(0.6);
    this.render.vfx.explode(this.position, 16, 0xffa040);
    this.render.postfx.flash(0.55, 0xff9a4d);
    this.render.rig.addShake(1.2, 18);
    this.events.push({ type: 'destroyed', reason });
  }

  get damage01() { return 1 - this.health / this.maxHealth; }
  get speedKmh() { return this.speed * 3.6; }
  get boost01() { return this.boostMeter / this.boostCapacity; }

  drainEvents() {
    const e = this.events.slice();
    this.events.length = 0;
    return e;
  }

  dispose() { this.visual.dispose(); }
}
