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
  PHYSICS, POWERS, WORLD, DEFAULT_BINDINGS, SCORE, MACH,
  clamp, clamp01, lerp, damp, shapeAxis,
} from './config.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
/** Nitrous burns green — the trail colour the reheat washes the exhaust to. */
const NITROUS_GREEN = new THREE.Color(0x2bff86);

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
    /** Mouse firing is only live in flight, never in the menus. */
    this.mouseEnabled = false;
    this.captureNext = null;      // rebinding callback

    this.touch = { x: 0, y: 0, active: false, buttons: new Set(), pressedButtons: new Set() };
    /* Mouse buttons. Left is the trigger, right launches the selected missile.
     * Held state and edge state are tracked separately for the same reason the
     * keyboard tracks both: the guns repeat while held, the launcher does not. */
    this.mouse = { down: new Set(), pressed: new Set() };
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
    this._onBlur = () => {
      this.keys.clear(); this.mouse.down.clear();
      this.touch.buttons.clear(); this.touch.active = false; this.touch.x = this.touch.y = 0;
    };
    this._onGamepad = (e) => { this.gamepadIndex = e.gamepad.index; this.lastSource = 'gamepad'; };
    this._onGamepadOut = () => { this.gamepadIndex = null; };

    /* ---- mouse ------------------------------------------------------------
     * Bound on the whole window rather than the canvas so a click anywhere in
     * the viewport fires, and only while the game owns the input — otherwise
     * clicking a menu button would also squeeze the trigger. The context menu
     * is suppressed for the same reason: right-click is a weapon, and a native
     * menu popping up mid-merge would be the end of the run. */
    this._onMouseDown = (e) => {
      if (!this.enabled || !this.mouseEnabled) return;
      if (e.button !== 0 && e.button !== 2) return;
      // Never steal a click that is landing on a real control.
      if (e.target && e.target.closest && e.target.closest('button, input, select, a, .screen.active')) return;
      if (!this.mouse.down.has(e.button)) this.mouse.pressed.add(e.button);
      this.mouse.down.add(e.button);
      this.lastSource = 'mouse';
      e.preventDefault();
    };
    this._onMouseUp = (e) => { this.mouse.down.delete(e.button); };
    this._onContextMenu = (e) => { if (this.enabled && this.mouseEnabled) e.preventDefault(); };
    this._onMouseLeave = () => { this.mouse.down.clear(); };

    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('mouseleave', this._onMouseLeave);
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
      pitch: 0, roll: 0, lean: 0, throttle: 0, brake: 0, boost: false,
      gun: false, heavy: false, cycleGun: false, cycleWeapon: false, cycleTarget: false,
      /** Weapon id to select-and-fire this frame, from its dedicated key. */
      weapon: null,
      powers: [false, false, false, false, false],
    };
    if (!this.enabled) return s;

    // Keyboard
    if (this.isDown('pitchUp')) s.pitch += 1;
    if (this.isDown('pitchDown')) s.pitch -= 1;
    if (this.isDown('rollRight')) s.roll += 1;
    if (this.isDown('rollLeft')) s.roll -= 1;
    if (this.isDown('leanRight')) s.lean += 1;
    if (this.isDown('leanLeft')) s.lean -= 1;
    if (this.isDown('throttleUp')) s.throttle += 1;
    if (this.isDown('brake')) s.brake += 1;
    if (this.isDown('boost')) s.boost = true;
    // Guns are held; everything else is a discrete press.
    if (this.isDown('fireGun')) s.gun = true;
    if (this.justPressed('fireWeapon')) s.heavy = true;
    if (this.justPressed('cycleGun')) s.cycleGun = true;
    if (this.justPressed('cycleWeapon')) s.cycleWeapon = true;
    if (this.justPressed('cycleTarget')) s.cycleTarget = true;
    // One key per weapon: select it and fire it in the same press.
    if (this.justPressed('weaponMissile')) s.weapon = 'missile';
    else if (this.justPressed('weaponLaser')) s.weapon = 'laser';
    else if (this.justPressed('weaponGrenade')) s.weapon = 'grenade';
    else if (this.justPressed('weaponRpg')) s.weapon = 'rpg';
    for (let i = 0; i < 5; i++) if (this.justPressed(`power${i + 1}`)) s.powers[i] = true;

    // Mouse: left is the trigger, right launches. Left is a HELD state so the
    // guns keep firing; right is edge-triggered so one click is one missile.
    if (this.mouseEnabled) {
      if (this.mouse.down.has(0)) s.gun = true;
      if (this.mouse.pressed.has(2)) s.heavy = true;
    }

    // Touch. The stick's horizontal axis is the assisted LEAN turn — the same
    // thing A and D do — not the raw bank axis: on a phone the stick is the
    // one control you are always holding, and it should be the one that
    // actually turns the aircraft. Bank is on its own pair of buttons.
    if (this.touch.active) {
      s.pitch += -this.touch.y;
      s.lean += this.touch.x;
    }
    const tb = this.touch.buttons;
    if (tb.has('boost')) s.boost = true;
    if (tb.has('brake')) s.brake += 1;
    if (tb.has('throttle')) s.throttle += 1;
    if (tb.has('leanLeft')) s.lean -= 1;
    if (tb.has('leanRight')) s.lean += 1;
    if (tb.has('rollLeft')) s.roll -= 1;
    if (tb.has('rollRight')) s.roll += 1;
    if (tb.has('gun')) s.gun = true;
    if (this.touch.pressedButtons.has('heavy')) s.heavy = true;
    if (this.touch.pressedButtons.has('cycleWeapon')) s.cycleWeapon = true;
    for (let i = 0; i < 5; i++) if (this.touch.pressedButtons.has(`power${i + 1}`)) s.powers[i] = true;

    // Gamepad
    const gp = this._gamepad();
    if (gp) {
      const ax = (i) => shapeAxis(gp.axes[i] || 0, this.gamepadDeadzone, 0.4);
      const lx = ax(0), ly = ax(1), rx = ax(2);
      if (lx || ly) this.lastSource = 'gamepad';
      s.roll += lx;
      s.pitch += -ly;
      s.lean += rx * 0.85;
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
    s.lean = clamp(s.lean, -1, 1) * this.sensitivity;
    s.throttle = clamp01(s.throttle);
    s.brake = clamp01(s.brake);
    return s;
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouse.pressed.clear();
    this.touch.pressedButtons.clear();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('mouseleave', this._onMouseLeave);
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
      shield: render.materials.energy(0x5fe4ff, { intensity: 0.22, hexScale: 2.6, fresnel: 5.5, side: THREE.BackSide, pulse: 0.6 }),
      phase: render.materials.energy(0xb478ff, { intensity: 0.26, hexScale: 1.6, fresnel: 4.2, scroll: 2.6, side: THREE.BackSide }),
      turbo: render.materials.energy(0xff8a3a, { intensity: 0.20, hexScale: 3.4, fresnel: 5.8, side: THREE.BackSide, pulse: 0.4 }),
      lift: render.materials.energy(0x39f5ff, { intensity: 0.20, hexScale: 2.0, fresnel: 5.0, scroll: 1.8, side: THREE.BackSide, pulse: 0.8 }),
    };
    this.shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(Math.max(this.span, this.length) * 0.30, 2),
      this._shellMats.shield,
    );
    this.shell.visible = false;
    this.shell.renderOrder = 7;
    this.root.add(this.shell);

    // Engine trails + wingtip vapour.
    this.engineTrails = [];
    this.tipTrails = [];
    if (opts.trails !== false) {
      // Short and tight: an exhaust plume, not a ribbon streamer. The old
      // lengths buried the airframe under two enormous stripes.
      const segs = Math.max(8, Math.round(render.quality.preset.trailSegments * (detail >= 2 ? 0.5 : 0.28)));
      for (const n of this.nozzles) {
        const t = render.vfx.createTrail(spec.colors.trail, this.engineRadius * 0.95, segs,
          { minDist: 2.2, opacity: 0, taper: 2.4 });
        t.anchor = n.clone();
        t.baseColor = new THREE.Color(spec.colors.trail);
        this.engineTrails.push(t);
      }
      if (detail >= 2) {
        for (const w of this.wingTips) {
          const t = render.vfx.createTrail(0xffffff, 1.0, Math.round(segs * 0.6),
            { minDist: 5, opacity: 0, taper: 3.0, blending: THREE.NormalBlending });
          t.anchor = w.clone();
          this.tipTrails.push(t);
        }
      }
    }

    this.controlBlend = { pitch: 0, roll: 0, yaw: 0, lean: 0, aoa: 0 };
    this._wp = new THREE.Vector3();
    this.visible = true;
    this.airframeVisible = true;
    this.damageSmokeTimer = 0;
  }

  setVisible(v) {
    this.visible = v;
    this._applyVisibility();
    for (const t of this.engineTrails) t.mesh.visible = v;
    for (const t of this.tipTrails) t.mesh.visible = v;
  }

  /**
   * Issue this airframe in a different livery. Instances share their template's
   * materials, so each one has to own a copy before it can be tinted — without
   * the clone, recolouring one enemy would recolour every aircraft built from
   * the same airframe, the player's included.
   */
  recolour(hex) {
    const tint = new THREE.Color(hex);
    const seen = new Map();
    this.group.traverse((n) => {
      if (!n.isMesh || !n.material) return;
      const src = n.material;
      const one = (mat) => {
        let copy = seen.get(mat);
        if (!copy) {
          copy = mat.clone();
          // Multiply rather than replace: the panel work, weathering and
          // markings in the texture survive, only the hue changes.
          if (copy.color) copy.color.copy(tint);
          if (copy.emissive) copy.emissive.copy(tint).multiplyScalar(0.16);
          seen.set(mat, copy);
        }
        return copy;
      };
      n.material = Array.isArray(src) ? src.map(one) : one(src);
    });
    this._ownMaterials = Array.from(seen.values());
    // The plume and ribbon carry the livery too, so a wave reads as a wave.
    for (const t of this.engineTrails) { t.baseColor = tint.clone(); t.material.uniforms.uColor.value.copy(tint); }
    for (const b of this.burners) b.uniforms.uColor.value.copy(tint);
  }

  /**
   * Hide the airframe without touching the trails — that is what makes the
   * first-person camera first-person. Trails stream out behind the eye point
   * so they stay correct and stay visible.
   */
  setAirframeVisible(v) {
    if (this.airframeVisible === v) return;
    this.airframeVisible = v;
    this._applyVisibility();
  }

  _applyVisibility() { this.root.visible = this.visible && this.airframeVisible; }

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
    // Leaning is a slip, and a slipping airframe visibly drops the into-wind
    // wing. Rotating about +Z lifts the right wing, so lean right is negative.
    cb.lean = damp(cb.lean ?? 0, state.lean || 0, 9, dt);

    /* --- attitude relative to the flight path --------------------------
     * The physics flies the aircraft exactly along its nose, which is what
     * makes a model look like it is being carried through the air rather
     * than flying through it. A real wing needs an angle of attack to make
     * lift, and needs more of it the slower it goes and the harder it pulls,
     * so the nose rides above the flight path by a visible amount. Adding
     * that angle back on the visual — plus the settle as the airframe takes
     * up a G change — is the single strongest cue that it is flying.
     * ------------------------------------------------------------------ */
    const n = state.gLoad ?? 1;
    const v01 = clamp01(state.speed01 ?? 0.5);
    const aoa = clamp(n * lerp(0.075, 0.016, v01), -0.06, 0.19);
    this._gLag = damp(this._gLag ?? 1, n, 3.2, dt);
    const settle = clamp((n - this._gLag) * 0.016, -0.035, 0.035);
    cb.aoa = damp(cb.aoa ?? 0, aoa + settle, 7, dt);

    this.group.rotation.x = cb.aoa;
    this.group.rotation.z = -PHYSICS.leanBank * cb.lean;
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

    // Trails. Length and weight follow Mach, so the ribbons grow with real
    // speed rather than sitting at one size the whole run — and they turn
    // nitrous green the moment the burner lights.
    const boost01 = clamp01(state.boost || 0);
    const mach01 = clamp01(state.mach01 ?? state.speed01 ?? 0);
    const trailOpacity = state.alive
      ? clamp01((state.speed01 - 0.22) * 1.5) * (0.055 + mach01 * 0.075 + boost01 * 0.26) : 0;
    for (const t of this.engineTrails) {
      this._wp.copy(t.anchor).applyQuaternion(state.quaternion).add(state.position);
      t.push(this._wp);
      t.setOpacity(damp(t.material.uniforms.uOpacity.value, trailOpacity, 6, dt));
      t.setWidth(this.engineRadius * (0.24 + mach01 * 0.16 + boost01 * 0.34));
      // Nitrous burns green. The blend is smoothed by the burner spool, so the
      // ribbon washes from exhaust colour to green as the reheat lights.
      t.material.uniforms.uColor.value.lerpColors(t.baseColor, NITROUS_GREEN, boost01);
    }
    // Wingtip vapour appears under load or at altitude — the physical cue that
    // the airframe is actually working.
    // Tip vapour is a high-G phenomenon, so it should be rare and brief —
    // it was previously on almost permanently.
    const vapour = clamp01((Math.abs(state.gLoad || 0) - 3.4) * 0.42)
      * clamp01((state.speed01 - 0.40) * 2);
    for (const t of this.tipTrails) {
      this._wp.copy(t.anchor).applyQuaternion(state.quaternion).add(state.position);
      t.push(this._wp);
      t.setOpacity(damp(t.material.uniforms.uOpacity.value, state.alive ? clamp01(vapour) * 0.34 : 0, 5, dt));
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
    const shellKind = state.shield ? 'shield' : state.phase ? 'phase'
      : state.turbo ? 'turbo' : state.powerFlight ? 'lift' : null;
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
    // Only materials this instance cloned for its livery — the template's are
    // shared and outlive it.
    if (this._ownMaterials) for (const m of this._ownMaterials) m.dispose();
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
    /** Marks rounds fired from this airframe as friendly to the combat system. */
    this.isPlayerSide = true;

    this.speed = PHYSICS.cruiseSpeed * 0.55;
    this.thrustBuild = 0;
    this.overheat = 0;           // seconds of accumulated time above the redline
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
    this.controls = { pitch: 0, roll: 0, lean: 0, throttle: 0, brake: 0, boost: false };
    this.smoothControls = { pitch: 0, roll: 0, lean: 0 };
    this.slipVel = 0;            // m/s of sideways slip from the lean control

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
    this.damageScale = ab === 'ablative' ? 0.6 : 1;
    this.nearMissBonus = ab === 'predator' ? 1.4 : 1;
    this.scanRangeScale = ab === 'deepscan' ? 1.6 : 1;
    this.turboBonus = ab === 'overcharge' ? 1.12 : 1;
    this.vectorTurn = ab === 'vector' ? 1.25 : 1;
    // Carrier trim: a stronger, faster-settling assisted turn.
    this.leanAssistScale = ab === 'trim' ? 1.3 : 1;
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
    this.speed = PHYSICS.cruiseSpeed * 0.55;
    this.thrustBuild = 0;
    this.overheat = 0;
    this.throttle = this.throttleTarget = 0.85;
    this.burner = 0;
    this.loadFactor = 1;
    this.rollRateActual = 0;
    this.slipVel = 0;
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
    if (!this.alive) { this._updateDead(); return; }
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
    const powerFlight = this.powers.isActive('powerflight');
    const maneuver = this.powers.isActive('maneuver');

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
    sc.lean = damp(sc.lean, c.lean, responsiveness * 0.9, dt);

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
    // Combat Maneuvers is a straight authority multiplier — the airframe does
    // what you ask almost before you finish asking.
    if (maneuver) authority *= 1.85;
    if (powerFlight) authority *= 1.25;

    // Pitch: the stick asks for a load factor. The wing can only deliver it if
    // it is going fast enough — lift goes with V², so the same pull that snaps
    // the nose round at 300 km/h barely bends it at 2000.
    const gLimit = PHYSICS.gLimit * this.gStrength * (turbo ? 0.92 : 1)
      * (maneuver ? 1.7 : 1) * (powerFlight ? 1.4 : 1);
    const nAvailable = gLimit * clamp01((V / PHYSICS.cornerSpeed) ** 2);
    // Bank alone barely turns a real aircraft — you have to pull, and a pilot
    // holding a level turn pulls exactly n = 1/cos(bank). Trimming that in
    // automatically is what makes banking read as "turn left/right" instead of
    // "lean over and keep going straight", and it is the real relationship
    // rather than a fudge.
    // Bank angle only — not the aircraft's vertical up, which also drops in a
    // dive and would auto-recover the nose out of one.
    const cosBank = Math.cos(this.bankAngle || 0);
    const levelTurnN = cosBank > 0.2 ? clamp(1 / cosBank, 1, gLimit * 0.8) : 1;
    const nCommand = sc.pitch >= 0
      ? Math.max(levelTurnN, 1 + sc.pitch * (gLimit - 1))
      : 1 + sc.pitch * (1 + PHYSICS.gLimitNeg);
    this.loadFactor = damp(this.loadFactor,
      clamp(nCommand, -PHYSICS.gLimitNeg, Math.min(gLimit, nAvailable)),
      1 / (PHYSICS.pitchTau * (maneuver ? 0.42 : 1)), dt);
    // q = G(n − upY)/V. With the stick centred in level flight n = 1 and
    // upY = 1, so the nose holds; roll away from level and it starts to fall.
    const pitchRate = PHYSICS.flightG * (this.loadFactor - this.upVec.y) / V * authority;
    // Published so the manoeuvre tracker can integrate a loop from what the
    // airframe actually did rather than from how long a key was held.
    this.pitchRateActual = pitchRate;

    // Roll: ailerons bite hardest in the middle of the band — mushy when slow,
    // stiff against the airflow when very fast — and a loaded wing rolls slower.
    const rollAuth = authority * lerp(0.5, 1, clamp01(V / 175)) * lerp(1, 0.66, q01 ** 1.6)
      * lerp(1, 0.72, clamp01(Math.abs(this.loadFactor) / gLimit));

    /* --- lean assist ------------------------------------------------------
     * While A or D is held the assist flies bank as a target ANGLE rather than
     * a rate, so it settles where you asked instead of rolling forever.
     *
     * It does nothing at all once you let go. That matters: an assist that
     * keeps running with the stick centred is an auto-leveller by another
     * name, quietly rolling the wings back to horizontal behind the pilot's
     * back. The airframe holds whatever bank it is left in — come out of a
     * barrel roll inverted and you stay inverted until Q or E rolls you out.
     *
     * Sign: bankAngle = atan2(right.y, up.y), so banked-right is NEGATIVE,
     * while a positive roll rate rolls the right wing down and therefore
     * *decreases* bankAngle. The error term is (current − target), not the
     * other way round — inverted, the assist accelerates away from the angle
     * it is meant to hold and ends up flying the aircraft onto its back.
     * -------------------------------------------------------------------- */
    const manual = clamp01(Math.abs(sc.roll) * 2.2);
    const leanHeld = clamp01((Math.abs(sc.lean) - 0.04) * 8);
    const bankTarget = -PHYSICS.leanAssistBank * sc.lean * this.leanAssistScale;
    const assistRoll = clamp(((this.bankAngle || 0) - bankTarget) * 2.6 * this.leanAssistScale,
      -PHYSICS.rollRate, PHYSICS.rollRate) * rollAuth * (1 - manual) * leanHeld;

    this.rollRateActual = damp(this.rollRateActual,
      PHYSICS.rollRate * rollAuth * sc.roll + assistRoll,
      1 / (PHYSICS.rollTau * (maneuver ? 0.5 : 1)), dt);
    const rollRate = this.rollRateActual;

    // Lean (A/D) is the assisted turn. Holding it rolls the airframe into a
    // bank for you, holds that bank, and lets the level-turn trim above do the
    // pulling — so a clean turn is one key rather than bank-then-pull-then-
    // catch-it. It also slips slightly, which is what lets you shift across a
    // gate you are already lined up on. Q/E remain the raw bank axis for
    // anyone who would rather fly it themselves; the assist steps aside the
    // moment they are touched.
    const leanAuth = authority * lerp(1, 0.42, q01 ** 1.2);
    const yawRate = -PHYSICS.leanYaw * leanAuth * sc.lean * (1 + PHYSICS.leanAssistTurn)
      + rollRate * PHYSICS.adverseYaw * (1 - clamp01(Math.abs(sc.lean)));
    this.slipVel = damp(this.slipVel, PHYSICS.leanSpeed * leanAuth * sc.lean, 3.4, dt);

    // Positive rotation about the nose axis rolls the right wing down, so D
    // (roll = +1) must apply a positive angle. This was negated.
    _q.setFromAxisAngle(this.rightVec, pitchRate * dt);
    this.quaternion.premultiply(_q);
    _q.setFromAxisAngle(this.forward, rollRate * dt);
    this.quaternion.premultiply(_q);
    _q.setFromAxisAngle(this.upVec, yawRate * dt);
    this.quaternion.premultiply(_q);

    /* --- no auto-level ----------------------------------------------------
     * The airframe holds whatever attitude it is left in. There is no assist
     * quietly rolling the wings back to horizontal behind the pilot's back:
     * bank into a turn and it stays banked, come out of a barrel roll inverted
     * and it stays inverted until Q or E is used to roll out. The lean assist
     * (A/D) still flies a bank angle for you while you hold it, and unwinds
     * that same bank when you release — but that is a control you are asking
     * for, not a correction happening to you. */
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

    /* --- sustained-throttle build ----------------------------------------
     * Holding military power charges the build; easing off bleeds it away
     * much faster than it charged. The effect is that speed is something the
     * aircraft works up to over distance rather than something the throttle
     * switches on, and that backing off in a turn genuinely costs you. */
    const holding = this.throttle > 0.86 && !c.brake ? 1 : 0;
    this.thrustBuild = clamp01(this.thrustBuild + (holding
      ? dt / PHYSICS.thrustBuildTime
      : -dt / PHYSICS.thrustBuildDecay));
    const build = lerp(PHYSICS.thrustBuildLow, PHYSICS.thrustBuildHigh, this.thrustBuild);

    let thrust = this.accelPower * this.throttle * build;
    thrust += PHYSICS.boostAccel * this.boostPower * this.burner * build;
    if (turbo) thrust += PHYSICS.boostAccel * 1.35 * this.boostPower;
    // Gravity along the flight path: a dive is free speed, a climb costs it.
    // Power Flight all but cancels it, which is what makes it a save button.
    thrust += -this.forward.y * PHYSICS.pathGravity * (powerFlight ? 0.15 : 1);
    // Parasitic drag goes with V², induced drag with n²/V. Holding a hard turn
    // therefore costs energy exactly where a real one does — and the harder you
    // pull the more it costs, which is what makes the racing line matter.
    const parasitic = PHYSICS.dragCoefficient * this.speed * this.speed
      * (1 + c.brake * 3.2 + Math.abs(sc.roll) * 0.14);
    // Power Flight is exactly that: the wing stops charging you for lift.
    const induced = powerFlight ? 0 : PHYSICS.inducedDrag * this.loadFactor * this.loadFactor / V;
    this.speed += (thrust - parasitic - induced) * dt;
    if (this.speed > cap) this.speed = damp(this.speed, cap, 2.4, dt);
    // Mach 20 is the hard ceiling for every airframe in the game.
    this.speed = clamp(this.speed, PHYSICS.minSpeed * 0.55, MACH.maxMs);

    /* --- integrate ------------------------------------------------------ */
    // Below the speed at which the wing can hold 1 g the airframe simply mushes.
    this.sink = damp(this.sink, powerFlight ? 0 : clamp01(1 - nAvailable) * PHYSICS.stallSink, 2.0, dt);
    this.velocity.copy(this.forward).multiplyScalar(this.speed);
    this.velocity.addScaledVector(this.rightVec, this.slipVel);
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
      mach01: this.mach01,
      pitch: sc.pitch, roll: sc.roll, yaw: sc.lean, lean: sc.lean, alive: true,
      gLoad: this.gLoad, altitude: this.altitude,
      damage01: 1 - this.health / this.maxHealth,
      phase, shield, turbo, powerFlight,
    });

    this.powerFlightActive = powerFlight;
    this.shieldActive = shield;
    this.phaseActive = phase;
    this.maneuverActive = maneuver;
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
    this.slipVel = 0;
    this.smoothControls.pitch = this.smoothControls.roll = this.smoothControls.lean = 0;
    return true;
  }

  _updateDead() {
    // Nothing to simulate — the aircraft is already gone and the results
    // screen is up. The position is kept so the results camera has a subject.
    this.speed = 0;
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

    /* --- flying into a building ------------------------------------------
     * A tower block is not an obstacle to bounce off. Above about Mach 5 the
     * airframe is gone, full stop, and the run ends there — anything softer
     * makes the whole ground structure layer read as scenery you can shrug
     * through, which is exactly the problem it was added to fix. Slower than
     * that, it is survivable but very expensive. */
    if (cbox.kind === 'structure' && this.mach > 5) {
      this.render.vfx.explode(point, 26, 0xffb063);
      this.render.postfx.flash(0.9, 0xffd0a0);
      this.render.rig.addShake(1.7, 18);
      this.events.push({
        type: 'collision', damage: this.maxHealth, soft: false,
        fatal: true, structure: cbox.type, position: point.clone(),
      });
      this.applyDamage(this.maxHealth, cbox.type || 'structure');
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

  /**
   * Incoming fire. Separate from applyDamage so a hit reads differently from a
   * collision: the shield eats it outright, and what gets through shakes the
   * camera and flashes the frame from the direction it arrived.
   */
  applyCombatDamage(amount, from) {
    if (!this.alive) return;
    if (this.shieldActive) {
      this.render.vfx.explode(from || this.position, 5, 0x5fe4ff);
      this.render.postfx.flash(0.16, 0x5fe4ff);
      this.events.push({ type: 'shielded', position: (from || this.position).clone() });
      return;
    }
    this.applyDamage(amount, 'enemyFire');
    this.render.vfx.sparkBurst(from || this.position, null, 14, 0xffcc66);
    this.render.postfx.flash(clamp01(amount / 60) * 0.32, 0xff8a6a);
    this.render.rig.addShake(clamp01(amount / 50) * 0.7, 28);
    this.events.push({ type: 'tookFire', amount });
  }

  /**
   * The run is over the instant the airframe is destroyed. There is no tumble
   * to sit through: it used to spin all the way down to the terrain before the
   * results screen appeared, which from cruise altitude is many seconds of
   * watching a dead aircraft rotate.
   */
  destroy(reason = 'collision') {
    if (!this.alive) return;
    this.alive = false;
    this.impacted = true;
    this.velocity.set(0, 0, 0);
    this.slipVel = 0;
    this.render.vfx.explode(this.position, 30, 0xffa040);
    this.render.postfx.flash(0.66, 0xffb063);
    this.render.rig.addShake(1.35, 22);
    this.visual.setVisible(false);
    this.events.push({ type: 'destroyed', reason });
  }

  /**
   * Thermal state, 0..1. Charges in real time above the redline and bleeds off
   * slowly below it, so the pilot cannot dip under Mach 18 for a second and
   * reset the clock. At 1 the engine is gone.
   */
  updateHeat(dt) {
    const over = this.mach > MACH.redline;
    this.overheat = clamp(this.overheat
      + (over ? dt : -dt * MACH.coolRate), 0, MACH.overheatTime);
    return this.overheat / MACH.overheatTime;
  }
  get heat01() { return this.overheat / MACH.overheatTime; }
  /** Seconds left before the engine lets go, or Infinity below the redline. */
  get heatSecondsLeft() {
    return this.mach > MACH.redline ? Math.max(0, MACH.overheatTime - this.overheat) : Infinity;
  }

  get damage01() { return 1 - this.health / this.maxHealth; }
  get mach() { return MACH.of(this.speed); }
  get speedKmh() { return MACH.kmhOf(this.speed); }
  /** 0..1 across the blur ramp — Mach 1 is nothing, Mach 15 is saturated. */
  get mach01() { return clamp01((this.mach - 1) / (MACH.blurMach - 1)); }
  get boost01() { return this.boostMeter / this.boostCapacity; }

  drainEvents() {
    const e = this.events.slice();
    this.events.length = 0;
    return e;
  }

  dispose() { this.visual.dispose(); }
}
