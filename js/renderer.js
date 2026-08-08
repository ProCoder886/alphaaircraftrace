/**
 * ALPHA AIRCRAFT RACE 3D — renderer.js
 * ---------------------------------------------------------------------------
 * All presentation: WebGL context, procedural texture/material library, sky and
 * atmosphere, lighting, post-processing stack, the chase-camera rig, the
 * procedural aircraft mesh factory and the VFX systems.
 *
 * Split into focused classes rather than one renderer god-object:
 *   TextureFactory · MaterialLibrary · SkySystem · LightingSystem · PostFX
 *   CameraRig · AircraftFactory · VFX · RenderSystem
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

import {
  WORLD, TIME_OF_DAY, WEATHER, clamp, clamp01, lerp, damp, smoothstep, RNG, TAU, DEG,
} from './config.js';

/* ===========================================================================
 * TEXTURE FACTORY — every texture in the game is drawn procedurally at boot.
 * No image downloads, no decode stalls, fully deterministic.
 * ======================================================================== */

export class TextureFactory {
  constructor() { this.cache = new Map(); }

  _canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  _finish(canvas, { repeat = 1, srgb = false, aniso = 4, mips = true } = {}) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    tex.anisotropy = aniso;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.generateMipmaps = mips;
    tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  cached(key, fn) {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key);
  }

  /* ---- generic noise ------------------------------------------------- */
  noise(size = 256, octaves = 4, seed = 1, contrast = 1) {
    return this.cached(`noise${size}_${octaves}_${seed}_${contrast}`, () => {
      const c = this._canvas(size, size);
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(size, size);
      const rng = new RNG(seed);
      // Build octaves of value noise on a wrapping lattice.
      const layers = [];
      for (let o = 0; o < octaves; o++) {
        const cells = 4 << o;
        const grid = new Float32Array(cells * cells);
        for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
        layers.push({ cells, grid });
      }
      const smooth = (t) => t * t * (3 - 2 * t);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let v = 0, amp = 1, norm = 0;
          for (const { cells, grid } of layers) {
            const fx = (x / size) * cells, fy = (y / size) * cells;
            const x0 = Math.floor(fx) % cells, y0 = Math.floor(fy) % cells;
            const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
            const tx = smooth(fx - Math.floor(fx)), ty = smooth(fy - Math.floor(fy));
            const a = lerp(grid[y0 * cells + x0], grid[y0 * cells + x1], tx);
            const b = lerp(grid[y1 * cells + x0], grid[y1 * cells + x1], tx);
            v += amp * lerp(a, b, ty);
            norm += amp; amp *= 0.5;
          }
          v /= norm;
          v = clamp01((v - 0.5) * contrast + 0.5);
          const i = (y * size + x) * 4;
          const b = v * 255;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = b;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return this._finish(c, { aniso: 4 });
    });
  }

  /* ---- soft radial sprite (particles, glows) -------------------------- */
  glow(size = 128, hardness = 0.25) {
    return this.cached(`glow${size}_${hardness}`, () => {
      const c = this._canvas(size, size);
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(hardness, 'rgba(255,255,255,0.72)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.18)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const t = this._finish(c, { mips: true, aniso: 2 });
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    });
  }

  /* ---- puffy cloud billboard ----------------------------------------- */
  cloudPuff(size = 256, seed = 7) {
    return this.cached(`puff${size}_${seed}`, () => {
      const c = this._canvas(size, size);
      const ctx = c.getContext('2d');
      const rng = new RNG(seed);
      ctx.clearRect(0, 0, size, size);
      // Stack soft lobes into an irregular, believable puff silhouette.
      const lobes = 22;
      for (let i = 0; i < lobes; i++) {
        const a = rng.float(0, TAU);
        const r = Math.pow(rng.next(), 0.65) * size * 0.28;
        const x = size / 2 + Math.cos(a) * r;
        const y = size / 2 + Math.sin(a) * r * 0.62;
        const rad = rng.float(size * 0.14, size * 0.30);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        const alpha = rng.float(0.16, 0.34);
        g.addColorStop(0, `rgba(255,255,255,${alpha})`);
        g.addColorStop(0.5, `rgba(255,255,255,${alpha * 0.5})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
      }
      // Feather the border so puffs never show a hard rectangle edge.
      const vg = ctx.createRadialGradient(size / 2, size / 2, size * 0.22, size / 2, size / 2, size * 0.5);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'source-over';
      const t = this._finish(c, { srgb: true, aniso: 4 });
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    });
  }

  /* ---- aircraft livery ------------------------------------------------ */
  /**
   * Body skin: base paint, livery pattern, panel lines, rivet noise, decals.
   * Returns { map, rough } — the roughness map reuses the panel work so the
   * paint reads as real panelled metal under the env map.
   */
  livery(spec, seed = 1) {
    const key = `livery_${spec.id}`;
    return this.cached(key, () => {
      const W = 1024, H = 512;
      const c = this._canvas(W, H);
      const ctx = c.getContext('2d');
      const rng = new RNG(`${spec.id}${seed}`);
      const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
      const prim = hex(spec.colors.primary);
      const sec = hex(spec.colors.secondary);
      const acc = hex(spec.colors.accent);

      ctx.fillStyle = sec; ctx.fillRect(0, 0, W, H);

      // --- livery pattern -------------------------------------------------
      const style = spec.shape.livery;
      ctx.save();
      if (style === 'stripe') {
        ctx.fillStyle = prim; ctx.fillRect(0, H * 0.16, W, H * 0.52);
        ctx.fillStyle = acc; ctx.fillRect(0, H * 0.62, W, H * 0.045);
      } else if (style === 'blade') {
        ctx.fillStyle = prim;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W, H * 0.26); ctx.lineTo(W, H); ctx.lineTo(0, H * 0.62); ctx.closePath(); ctx.fill();
        ctx.fillStyle = acc;
        ctx.beginPath(); ctx.moveTo(0, H * 0.60); ctx.lineTo(W, H * 0.24); ctx.lineTo(W, H * 0.30); ctx.lineTo(0, H * 0.66); ctx.closePath(); ctx.fill();
      } else if (style === 'splinter') {
        ctx.fillStyle = prim; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = sec;
        for (let i = 0; i < 34; i++) {
          const x = rng.float(-40, W), y = rng.float(-20, H), w = rng.float(50, 210), h = rng.float(24, 90);
          ctx.beginPath();
          ctx.moveTo(x, y); ctx.lineTo(x + w, y + rng.float(-30, 30));
          ctx.lineTo(x + w * 0.7, y + h); ctx.lineTo(x - rng.float(0, 40), y + h * 0.8);
          ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = acc;
        for (let i = 0; i < 8; i++) {
          const x = rng.float(0, W), y = rng.float(0, H);
          ctx.fillRect(x, y, rng.float(40, 130), rng.float(6, 14));
        }
      } else if (style === 'hazard') {
        ctx.fillStyle = prim; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = sec;
        ctx.save(); ctx.translate(0, 0); ctx.rotate(-0.5);
        for (let x = -H; x < W * 1.6; x += 96) ctx.fillRect(x, -H, 44, H * 3);
        ctx.restore();
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, H * 0.74, W, H * 0.26);
      } else if (style === 'facet') {
        ctx.fillStyle = prim; ctx.fillRect(0, 0, W, H);
        for (let i = 0; i < 70; i++) {
          const x = rng.float(0, W), y = rng.float(0, H), s = rng.float(30, 120);
          ctx.fillStyle = `rgba(255,255,255,${rng.float(0.015, 0.06)})`;
          ctx.beginPath();
          ctx.moveTo(x, y); ctx.lineTo(x + s, y + rng.float(-30, 30));
          ctx.lineTo(x + s * 0.5, y + s * 0.7); ctx.closePath(); ctx.fill();
        }
      } else if (style === 'circuit') {
        ctx.fillStyle = sec; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = prim; ctx.fillRect(0, H * 0.30, W, H * 0.44);
        ctx.strokeStyle = acc; ctx.lineWidth = 3;
        for (let i = 0; i < 26; i++) {
          let x = rng.float(0, W), y = rng.float(0, H);
          ctx.beginPath(); ctx.moveTo(x, y);
          for (let s = 0; s < 4; s++) {
            if (rng.bool()) x += rng.float(-90, 90); else y += rng.float(-60, 60);
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      } else if (style === 'chevron') {
        ctx.fillStyle = prim; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = sec;
        for (let i = 0; i < 7; i++) {
          const y = H * 0.1 + i * H * 0.13;
          ctx.beginPath();
          ctx.moveTo(0, y); ctx.lineTo(W * 0.5, y + 40); ctx.lineTo(W, y);
          ctx.lineTo(W, y + 16); ctx.lineTo(W * 0.5, y + 56); ctx.lineTo(0, y + 16);
          ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = acc; ctx.fillRect(0, H * 0.02, W, 10);
      } else if (style === 'ember') {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, sec); g.addColorStop(0.55, prim); g.addColorStop(1, '#000000');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        for (let i = 0; i < 160; i++) {
          const x = rng.float(0, W), y = rng.float(H * 0.4, H);
          ctx.fillStyle = `rgba(255,${Math.floor(rng.float(90, 180))},30,${rng.float(0.05, 0.3)})`;
          ctx.fillRect(x, y, rng.float(4, 26), rng.float(2, 6));
        }
      } else if (style === 'fang') {
        ctx.fillStyle = sec; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = prim;
        for (let i = 0; i < 10; i++) {
          const x = i * (W / 10);
          ctx.beginPath();
          ctx.moveTo(x, 0); ctx.lineTo(x + W / 10, 0);
          ctx.lineTo(x + W / 20, H * rng.float(0.5, 0.9)); ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = acc; ctx.fillRect(0, H * 0.90, W, 12);
      } else { // wave
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, prim); g.addColorStop(0.5, sec); g.addColorStop(1, prim);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = acc; ctx.lineWidth = 6;
        for (let i = 0; i < 5; i++) {
          ctx.beginPath();
          for (let x = 0; x <= W; x += 16) {
            const y = H * (0.2 + i * 0.15) + Math.sin(x * 0.012 + i) * 26;
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      ctx.restore();

      // --- panel lines + rivets ------------------------------------------
      ctx.strokeStyle = 'rgba(0,0,0,0.42)';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 26; i++) {
        const x = rng.float(0, W);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + rng.float(-24, 24), H); ctx.stroke();
      }
      for (let i = 0; i < 16; i++) {
        const y = rng.float(0, H);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y + rng.float(-12, 12)); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      for (let i = 0; i < 900; i++) ctx.fillRect(rng.float(0, W), rng.float(0, H), 2, 2);

      // --- decals ---------------------------------------------------------
      const num = String(10 + (Math.abs(spec.id.charCodeAt(0) * 7 + spec.id.length * 13) % 89)).padStart(3, '0');
      ctx.save();
      ctx.font = 'bold 92px "Arial Black", Arial, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 5;
      ctx.textAlign = 'center';
      ctx.strokeText(num, W * 0.30, H * 0.60); ctx.fillText(num, W * 0.30, H * 0.60);
      ctx.font = 'bold 34px Arial, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(spec.id.toUpperCase(), W * 0.72, H * 0.30);
      ctx.font = '20px Arial, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText('ALPHA CIRCUIT · NO STEP', W * 0.72, H * 0.86);
      ctx.restore();

      // --- weathering / grime ---------------------------------------------
      for (let i = 0; i < 90; i++) {
        const x = rng.float(0, W), y = rng.float(0, H);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rng.float(30, 140));
        g.addColorStop(0, `rgba(0,0,0,${rng.float(0.02, 0.10)})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(x - 140, y - 140, 280, 280);
      }

      const map = this._finish(c, { srgb: true, repeat: 1, aniso: 8 });
      map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;

      // Roughness map derived from luminance so paint and panel lines differ.
      const rc = this._canvas(512, 256);
      const rctx = rc.getContext('2d');
      rctx.drawImage(c, 0, 0, 512, 256);
      const im = rctx.getImageData(0, 0, 512, 256);
      for (let i = 0; i < im.data.length; i += 4) {
        const l = (im.data[i] * 0.3 + im.data[i + 1] * 0.6 + im.data[i + 2] * 0.1) / 255;
        const r = clamp01(0.20 + (1 - l) * 0.30);
        im.data[i] = im.data[i + 1] = im.data[i + 2] = r * 255;
      }
      rctx.putImageData(im, 0, 0);
      const rough = this._finish(rc, { aniso: 4 });
      rough.wrapS = rough.wrapT = THREE.ClampToEdgeWrapping;

      return { map, rough };
    });
  }

  /* ---- building facade with lit windows ------------------------------- */
  facade(seed = 3, night = true) {
    return this.cached(`facade${seed}_${night}`, () => {
      const W = 256, H = 512;
      const c = this._canvas(W, H);
      const ctx = c.getContext('2d');
      const rng = new RNG(seed);
      ctx.fillStyle = night ? '#0b0e14' : '#3a4048';
      ctx.fillRect(0, 0, W, H);
      const cols = 8, rows = 20;
      const cw = W / cols, ch = H / rows;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const on = rng.next();
          let col;
          if (night) {
            if (on < 0.42) col = `rgba(255,${Math.floor(rng.float(200, 245))},${Math.floor(rng.float(150, 215))},${rng.float(0.55, 1)})`;
            else if (on < 0.50) col = `rgba(${Math.floor(rng.float(120, 190))},${Math.floor(rng.float(210, 245))},255,${rng.float(0.4, 0.9)})`;
            else col = 'rgba(20,26,34,1)';
          } else {
            col = `rgba(${Math.floor(rng.float(70, 130))},${Math.floor(rng.float(90, 150))},${Math.floor(rng.float(110, 175))},1)`;
          }
          ctx.fillStyle = col;
          ctx.fillRect(x * cw + cw * 0.16, y * ch + ch * 0.18, cw * 0.68, ch * 0.58);
        }
      }
      ctx.fillStyle = night ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.25)';
      for (let y = 0; y < rows; y++) ctx.fillRect(0, y * ch + ch * 0.86, W, 2);
      return this._finish(c, { srgb: true, aniso: 4 });
    });
  }

  /* ---- terrain detail (breaks up flat vertex colour) ------------------- */
  terrainDetail() {
    return this.cached('terrainDetail', () => {
      const size = 512;
      const c = this._canvas(size, size);
      const ctx = c.getContext('2d');
      const rng = new RNG(99);
      ctx.fillStyle = '#8a8a8a'; ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 5200; i++) {
        const v = Math.floor(rng.float(96, 176));
        ctx.fillStyle = `rgba(${v},${v},${v},${rng.float(0.04, 0.18)})`;
        const s = rng.float(2, 22);
        ctx.fillRect(rng.float(0, size), rng.float(0, size), s, s * rng.float(0.4, 1.6));
      }
      // Tiled tightly across each terrain tile: at repeat 1 the pattern spans
      // kilometres and reads as dithering rather than ground detail.
      return this._finish(c, { repeat: 26, aniso: 8 });
    });
  }

  /** Normal map for water/ice — cheap ripple detail. */
  rippleNormal() {
    return this.cached('rippleNormal', () => {
      const size = 256;
      const c = this._canvas(size, size);
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(size, size);
      const rng = new RNG(31);
      const grid = 8;
      const h = new Float32Array(size * size);
      const pts = [];
      for (let i = 0; i < grid * grid; i++) pts.push({ x: rng.float(0, size), y: rng.float(0, size), r: rng.float(20, 70), p: rng.float(0, TAU) });
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        let v = 0;
        for (const p of pts) {
          const dx = Math.abs(x - p.x), dy = Math.abs(y - p.y);
          const ddx = Math.min(dx, size - dx), ddy = Math.min(dy, size - dy);
          const d = Math.hypot(ddx, ddy);
          v += Math.cos(d / p.r * TAU + p.p) * Math.exp(-d / (p.r * 2.5));
        }
        h[y * size + x] = v;
      }
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const l = h[y * size + ((x - 1 + size) % size)], r = h[y * size + ((x + 1) % size)];
        const u = h[((y - 1 + size) % size) * size + x], d = h[((y + 1) % size) * size + x];
        const nx = clamp01((l - r) * 0.25 + 0.5), ny = clamp01((u - d) * 0.25 + 0.5);
        const i = (y * size + x) * 4;
        img.data[i] = nx * 255; img.data[i + 1] = ny * 255; img.data[i + 2] = 255; img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return this._finish(c, { repeat: 1, aniso: 4 });
    });
  }

  /** Streak sprite for rain / speed particles. */
  streak() {
    return this.cached('streak', () => {
      const w = 16, h = 128;
      const c = this._canvas(w, h);
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.65, 'rgba(255,255,255,0.85)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(w * 0.34, 0, w * 0.32, h);
      const t = this._finish(c, { mips: true, aniso: 2 });
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    });
  }

  /** Hex-grid energy panel used by checkpoints and shields. */
  hexEnergy() {
    return this.cached('hexEnergy', () => {
      const size = 256;
      const c = this._canvas(size, size);
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2.5;
      const r = 26, hStep = r * 1.5, vStep = Math.sqrt(3) * r;
      for (let row = -1; row * hStep < size + r; row++) {
        for (let col = -1; col * vStep < size + r; col++) {
          const cx = row * hStep;
          const cy = col * vStep + (row % 2 ? vStep / 2 : 0);
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = i * Math.PI / 3;
            const px = cx + Math.cos(a) * r * 0.88, py = cy + Math.sin(a) * r * 0.88;
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          }
          ctx.closePath(); ctx.stroke();
        }
      }
      return this._finish(c, { repeat: 1, aniso: 4 });
    });
  }
}

/* ===========================================================================
 * MATERIAL LIBRARY
 * ======================================================================== */

export class MaterialLibrary {
  constructor(textures) {
    this.tex = textures;
    this.cache = new Map();
    this.envMap = null;
    this.tracked = [];    // materials that need envMap re-assignment
    this.energyMats = []; // materials with a uTime uniform
  }

  _track(m) { this.tracked.push(m); if (this.envMap) m.envMap = this.envMap; return m; }

  setEnvMap(env) {
    this.envMap = env;
    for (const m of this.tracked) { m.envMap = env; m.needsUpdate = false; }
  }

  aircraftBody(spec) {
    return this.cached(`body_${spec.id}`, () => {
      const { map, rough } = this.tex.livery(spec);
      return this._track(new THREE.MeshStandardMaterial({
        map, roughnessMap: rough, metalness: 0.72, roughness: 1.0,
        envMapIntensity: 1.35, color: 0xffffff,
      }));
    });
  }

  aircraftGlass(spec, transmission = false) {
    return this.cached(`glass_${spec.id}_${transmission}`, () => {
      if (transmission) {
        return this._track(new THREE.MeshPhysicalMaterial({
          color: 0x0a1420, metalness: 0.0, roughness: 0.04, transmission: 0.82,
          thickness: 0.4, ior: 1.45, envMapIntensity: 2.6, transparent: true, opacity: 1.0,
          clearcoat: 1.0, clearcoatRoughness: 0.02, side: THREE.DoubleSide,
        }));
      }
      return this._track(new THREE.MeshStandardMaterial({
        color: 0x101c2c, metalness: 0.15, roughness: 0.06, envMapIntensity: 3.2,
        transparent: true, opacity: 0.62, side: THREE.DoubleSide,
      }));
    });
  }

  aircraftMetal(spec) {
    return this.cached(`metal_${spec.id}`, () => this._track(new THREE.MeshStandardMaterial({
      color: 0x9aa0a8, metalness: 1.0, roughness: 0.34, envMapIntensity: 1.6,
    })));
  }

  aircraftDark() {
    return this.cached('dark', () => this._track(new THREE.MeshStandardMaterial({
      color: 0x14171c, metalness: 0.5, roughness: 0.72, envMapIntensity: 0.5,
    })));
  }

  aircraftEmissive(spec) {
    return this.cached(`emis_${spec.id}`, () => new THREE.MeshBasicMaterial({
      color: spec.colors.emissive, toneMapped: false,
    }));
  }

  navLight(color) {
    return this.cached(`nav_${color}`, () => new THREE.MeshBasicMaterial({ color, toneMapped: false }));
  }

  /** Additive energy material used by gates, rings and shields. */
  energy(color, opts = {}) {
    const key = `energy_${color}_${JSON.stringify(opts)}`;
    return this.cached(key, () => {
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: opts.side || THREE.DoubleSide,
        uniforms: {
          uColor: { value: new THREE.Color(color) },
          uTime: { value: 0 },
          uIntensity: { value: opts.intensity ?? 1.0 },
          uScroll: { value: opts.scroll ?? 1.0 },
          uHex: { value: this.tex.hexEnergy() },
          uHexScale: { value: opts.hexScale ?? 3.0 },
          uFresnel: { value: opts.fresnel ?? 1.6 },
          uPulse: { value: opts.pulse ?? 1.0 },
        },
        vertexShader: /* glsl */`
          varying vec2 vUv; varying vec3 vNormalW; varying vec3 vViewDir;
          void main() {
            vUv = uv;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vNormalW = normalize(mat3(modelMatrix) * normal);
            vViewDir = normalize(cameraPosition - wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uColor; uniform float uTime, uIntensity, uScroll, uHexScale, uFresnel, uPulse;
          uniform sampler2D uHex;
          varying vec2 vUv; varying vec3 vNormalW; varying vec3 vViewDir;
          void main() {
            float fres = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir))), uFresnel);
            vec2 huv = vUv * uHexScale + vec2(0.0, -uTime * 0.18 * uScroll);
            float hex = texture2D(uHex, huv).r;
            float band = sin((vUv.y * 10.0 - uTime * 2.2 * uScroll)) * 0.5 + 0.5;
            band = pow(band, 3.0);
            float pulse = 0.72 + 0.28 * sin(uTime * 3.1) * uPulse;
            float a = clamp((fres * 0.85 + hex * 0.35 + band * 0.5) * uIntensity * pulse, 0.0, 1.0);
            // Premultiplied: with additive blending an unweighted base colour
            // would add light across the entire silhouette, not just where the
            // field is actually bright.
            gl_FragColor = vec4(uColor * a * (0.55 + a * 1.1), a);
          }`,
      });
      this.energyMats.push(mat);
      return mat;
    });
  }

  terrain() {
    return this.cached('terrain', () => this._track(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0.02,
      map: this.tex.terrainDetail(), envMapIntensity: 0.95,
    })));
  }

  water(color) {
    return this.cached(`water_${color}`, () => this._track(new THREE.MeshStandardMaterial({
      color, roughness: 0.08, metalness: 0.35, envMapIntensity: 2.2,
      normalMap: this.tex.rippleNormal(), transparent: true, opacity: 0.92,
    })));
  }

  rock(color) {
    return this.cached(`rock_${color}`, () => this._track(new THREE.MeshStandardMaterial({
      color, roughness: 0.92, metalness: 0.03, flatShading: true, envMapIntensity: 0.5,
    })));
  }

  foliage(color) {
    return this.cached(`foliage_${color}`, () => this._track(new THREE.MeshStandardMaterial({
      color, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.4, flatShading: true,
    })));
  }

  building(night) {
    return this.cached(`building_${night}`, () => this._track(new THREE.MeshStandardMaterial({
      map: this.tex.facade(3, night), color: 0xffffff,
      roughness: 0.42, metalness: 0.55, envMapIntensity: 1.1,
      emissiveMap: night ? this.tex.facade(3, true) : null,
      emissive: night ? 0xffffff : 0x000000,
      emissiveIntensity: night ? 0.85 : 0,
    })));
  }

  structure(color, metal = 0.5, rough = 0.6) {
    return this.cached(`struct_${color}_${metal}_${rough}`, () => this._track(new THREE.MeshStandardMaterial({
      color, roughness: rough, metalness: metal, envMapIntensity: 0.9,
    })));
  }

  emissiveBasic(color) {
    return this.cached(`eb_${color}`, () => new THREE.MeshBasicMaterial({ color, toneMapped: false }));
  }

  cached(key, fn) { if (!this.cache.has(key)) this.cache.set(key, fn()); return this.cache.get(key); }

  update(time) { for (const m of this.energyMats) m.uniforms.uTime.value = time; }

  dispose() {
    for (const m of this.cache.values()) {
      if (m.dispose) m.dispose();
      else if (m.map) { m.map.dispose?.(); m.rough?.dispose?.(); }
    }
    this.cache.clear(); this.tracked.length = 0; this.energyMats.length = 0;
  }
}

/* ===========================================================================
 * SKY SYSTEM
 * ------------------------------------------------------------------------
 * A single analytic sky shader drives everything: gradient, sun/mie glow,
 * horizon haze, star field, moon, cloud band and weather tint. The same
 * material feeds a small off-screen sphere that the PMREM generator turns
 * into the scene environment map, so reflections always match the weather.
 * ======================================================================== */

export class SkySystem {
  constructor(scene) {
    this.scene = scene;
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0.3, 0.4, -0.86) },
      uSunColor: { value: new THREE.Color(0xfff0d8) },
      uZenith: { value: new THREE.Color(0x2a5fa8) },
      uHorizon: { value: new THREE.Color(0xbcd4e8) },
      uGround: { value: new THREE.Color(0x4a4f52) },
      uHaze: { value: new THREE.Color(0xd8e4ee) },
      uTime: { value: 0 },
      uStars: { value: 0 },
      uCloud: { value: 0.4 },
      uCloudColor: { value: new THREE.Color(0xffffff) },
      uCloudDark: { value: new THREE.Color(0x8a97a6) },
      uExposure: { value: 1 },
      uSunSize: { value: 1 },
      uTint: { value: new THREE.Color(0x000000) },
      uTintAmt: { value: 0 },
      uCeiling: { value: 0 },
    };

    const geo = new THREE.SphereGeometry(1, 40, 24);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_Position.z = gl_Position.w; // force to far plane
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        uniform vec3 uSunDir, uSunColor, uZenith, uHorizon, uGround, uHaze, uCloudColor, uCloudDark, uTint;
        uniform float uTime, uStars, uCloud, uExposure, uSunSize, uTintAmt, uCeiling;

        float hash(vec2 p){ p = fract(p*vec2(443.897,441.423)); p += dot(p,p+19.19); return fract(p.x*p.y); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          float a = hash(i), b = hash(i+vec2(1,0)), c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
          return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
        }
        float fbm(vec2 p){
          float v = 0.0, a = 0.5;
          for(int i=0;i<5;i++){ v += a*vnoise(p); p *= 2.07; a *= 0.5; }
          return v;
        }

        void main() {
          vec3 dir = normalize(vDir);
          float h = dir.y;
          float sunDot = dot(dir, normalize(uSunDir));

          // --- base gradient: zenith -> horizon -> below-horizon ground haze
          float up = clamp(h, 0.0, 1.0);
          vec3 sky = mix(uHorizon, uZenith, pow(up, 0.42));
          float belowT = clamp(-h * 3.2, 0.0, 1.0);
          sky = mix(sky, uGround, belowT * 0.88);

          // --- horizon haze band (aerial perspective)
          float hazeBand = exp(-abs(h) * 11.0);
          sky = mix(sky, uHaze, hazeBand * 0.42);

          // --- mie forward scattering around the sun
          float mie = pow(max(sunDot, 0.0), 8.0) * 0.55 + pow(max(sunDot, 0.0), 2.0) * 0.16;
          sky += uSunColor * mie * (0.6 + hazeBand * 0.9);

          // --- sun disc with soft limb
          float sunAng = acos(clamp(sunDot, -1.0, 1.0));
          float disc = 1.0 - smoothstep(0.010 * uSunSize, 0.028 * uSunSize, sunAng);
          float bloomRing = exp(-sunAng * 30.0 / uSunSize) * 0.38;
          sky += uSunColor * (disc * 5.5 + bloomRing);

          // --- moon when the sun is below the horizon
          if (uStars > 0.02) {
            vec3 moonDir = normalize(vec3(-uSunDir.x, abs(uSunDir.y) + 0.55, -uSunDir.z));
            float mAng = acos(clamp(dot(dir, moonDir), -1.0, 1.0));
            float moon = 1.0 - smoothstep(0.014, 0.020, mAng);
            float mGlow = exp(-mAng * 16.0) * 0.35;
            sky += vec3(0.85, 0.90, 1.0) * (moon * 4.0 + mGlow) * uStars;
          }

          // --- stars
          if (uStars > 0.02 && h > -0.05) {
            vec2 sp = dir.xz / max(abs(dir.y) + 0.28, 0.05) * 46.0;
            float s = hash(floor(sp));
            float tw = 0.6 + 0.4 * sin(uTime * (1.5 + s * 4.0) + s * 40.0);
            float star = step(0.9955, s) * tw;
            float star2 = step(0.9990, hash(floor(sp * 2.3) + 17.0)) * tw * 2.2;
            sky += vec3(0.85, 0.92, 1.0) * (star + star2) * uStars * clamp(h * 4.0, 0.0, 1.0);
          }

          // --- distant cloud deck (cheap analytic layer well above the horizon)
          // Deliberately not painted down onto the horizon line: the haze band
          // owns that, and overlapping the two produces a flat white veil.
          if (uCloud > 0.02 && h > 0.02) {
            vec2 cp = dir.xz / max(h + 0.12, 0.07);
            float n = fbm(cp * 0.50 + vec2(uTime * 0.006, uTime * 0.004));
            float n2 = fbm(cp * 1.5 - vec2(uTime * 0.011, 0.0));
            float cover = smoothstep(0.58 - uCloud * 0.26, 0.92 - uCloud * 0.16, n * 0.70 + n2 * 0.30);
            float fade = smoothstep(0.06, 0.34, h) * (1.0 - smoothstep(0.55, 1.0, h));
            float lit = clamp(dot(normalize(vec3(dir.x, 0.55, dir.z)), normalize(uSunDir)) * 0.5 + 0.45, 0.0, 1.2);
            vec3 cc = mix(uCloudDark, uCloudColor, lit);
            cc += uSunColor * pow(max(sunDot, 0.0), 8.0) * 0.35;
            sky = mix(sky, cc, cover * fade * clamp(uCloud, 0.0, 1.0) * 0.72);
          }

          // --- cavern ceiling (Undervault) darkens everything above
          if (uCeiling > 0.01) {
            float c = smoothstep(0.02, 0.45, h);
            sky = mix(sky, vec3(0.035, 0.030, 0.026), c * uCeiling);
          }

          sky = mix(sky, uTint, uTintAmt);
          gl_FragColor = vec4(sky * uExposure, 1.0);
        }`,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(1);
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);

    // Dedicated micro-scene for PMREM env capture (shares the material).
    this.envScene = new THREE.Scene();
    this.envMesh = new THREE.Mesh(new THREE.SphereGeometry(50, 24, 16), this.material);
    this.envScene.add(this.envMesh);

    this.sunDirection = new THREE.Vector3(0.3, 0.4, -0.86);
    this.fogColor = new THREE.Color(0xbcd4e8);
    this.sunColor = new THREE.Color(0xfff0d8);
    this.ambientColor = new THREE.Color(0x8aa4c8);
    this.groundColor = new THREE.Color(0x6b7264);
    this.sunIntensity = 3.5;
  }

  /** Apply a biome + weather + time-of-day combination. */
  configure(biome, weatherId, timeId) {
    const w = WEATHER[weatherId] || WEATHER.clear;
    const t = TIME_OF_DAY[timeId] || TIME_OF_DAY.noon;
    const u = this.uniforms;

    const elev = t.elev * DEG, azim = t.azim * DEG;
    this.sunDirection.set(
      Math.cos(elev) * Math.sin(azim),
      Math.sin(elev),
      Math.cos(elev) * Math.cos(azim),
    ).normalize();
    u.uSunDir.value.copy(this.sunDirection);

    const sunCol = new THREE.Color(t.sun);
    const dayFactor = clamp01((t.elev + 8) / 40);
    // Sky palette: deep blue high, warm haze low, weather desaturates it.
    const zen = new THREE.Color().setHSL(0.585, lerp(0.25, 0.72, dayFactor), lerp(0.05, 0.34, dayFactor));
    const hor = new THREE.Color(t.sun).lerp(new THREE.Color(0xcfe0ee), lerp(0.25, 0.78, dayFactor));
    const haze = hor.clone().lerp(new THREE.Color(biome.fogTint), 0.42);
    const grd = new THREE.Color(t.ground);

    const desat = (c, k) => { const hsl = {}; c.getHSL(hsl); c.setHSL(hsl.h, hsl.s * k, hsl.l); return c; };
    desat(zen, w.sat); desat(hor, w.sat); desat(haze, w.sat);

    // Overcast pulls the whole dome toward flat grey.
    const overcast = clamp01((w.cloud - 0.55) / 0.55);
    const grey = new THREE.Color(biome.fogTint).lerp(new THREE.Color(0x9aa5ad), 0.35);
    zen.lerp(grey, overcast * 0.65);
    hor.lerp(grey, overcast * 0.55);
    haze.lerp(grey, overcast * 0.5);

    u.uZenith.value.copy(zen);
    u.uHorizon.value.copy(hor);
    u.uHaze.value.copy(haze);
    u.uGround.value.copy(grd.lerp(new THREE.Color(biome.ground.base), 0.5));
    u.uSunColor.value.copy(sunCol);
    u.uStars.value = t.stars * (1 - overcast * 0.75);
    u.uCloud.value = clamp(w.cloud, 0, 1.4);
    u.uCloudColor.value.set(0xffffff).lerp(sunCol, 0.35).multiplyScalar(lerp(0.5, 1.05, dayFactor));
    u.uCloudDark.value.set(0x8a97a6).lerp(new THREE.Color(biome.fogTint), 0.4).multiplyScalar(lerp(0.28, 1.0, dayFactor));
    u.uExposure.value = w.exposure;
    u.uSunSize.value = lerp(1.0, 1.8, overcast);
    u.uCeiling.value = biome.ceiling ? 1 : 0;
    if (w.tint) { u.uTint.value.set(w.tint); u.uTintAmt.value = 0.12; }
    else { u.uTintAmt.value = 0; }

    // Values consumed by the lighting + fog systems.
    this.sunColor.copy(sunCol).lerp(new THREE.Color(0xffffff), overcast * 0.4);
    this.sunIntensity = t.intensity * lerp(1.0, 0.42, overcast) * (biome.ceiling ? 0.35 : 1);
    this.ambientColor.set(t.ambient).lerp(haze, 0.35);
    this.groundColor.set(t.ground).lerp(new THREE.Color(biome.ground.base), 0.55);
    this.fogColor.copy(haze).lerp(new THREE.Color(biome.fogTint), 0.30);
    if (biome.ceiling) this.fogColor.multiplyScalar(0.35);
    this.dayFactor = dayFactor;
    this.overcast = overcast;
    this.weather = w;
    this.time = t;
    return this;
  }

  update(dt, camera) {
    this.uniforms.uTime.value += dt;
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.92);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.envMesh.geometry.dispose();
    this.material.dispose();
  }
}

/* ===========================================================================
 * LIGHTING SYSTEM
 * ======================================================================== */

export class LightingSystem {
  constructor(scene) {
    this.scene = scene;
    this.sun = new THREE.DirectionalLight(0xffffff, 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 1.6;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 8000;
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sun, this.sunTarget);
    this.sun.target = this.sunTarget;

    this.hemi = new THREE.HemisphereLight(0x9dbbe0, 0x6b7264, 1.15);
    scene.add(this.hemi);

    // Cool rim from the opposite side gives the airframe a second read.
    this.rim = new THREE.DirectionalLight(0x9fc0ff, 0.55);
    scene.add(this.rim);

    this.shadowDistance = 1500;
    this._shadowTick = 0;
    this.lightningFlash = 0;
    this.baseSunIntensity = 3.4;
  }

  configure(sky, preset) {
    this.sun.color.copy(sky.sunColor);
    this.baseSunIntensity = sky.sunIntensity;
    this.sun.intensity = sky.sunIntensity;
    this.hemi.color.copy(sky.ambientColor);
    this.hemi.groundColor.copy(sky.groundColor);
    this.hemi.intensity = lerp(1.05, 2.1, sky.overcast) * lerp(0.42, 1.0, clamp01(sky.dayFactor + 0.25));
    this.rim.color.copy(sky.ambientColor).lerp(new THREE.Color(0x9fc0ff), 0.5);
    this.rim.intensity = lerp(0.25, 0.8, sky.overcast);
    this.rim.position.copy(sky.sunDirection).multiplyScalar(-1200).setY(600);
    this.setShadowQuality(preset);
  }

  setShadowQuality(preset) {
    this.sun.castShadow = !!preset.shadows;
    if (this.sun.shadow.map && this.sun.shadow.mapSize.x !== preset.shadowMapSize) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
    this.shadowDistance = preset.shadowDistance;
    const d = this.shadowDistance;
    const cam = this.sun.shadow.camera;
    cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d;
    cam.far = d * 6;
    cam.updateProjectionMatrix();
  }

  /** Keep the shadow volume glued to the player, snapped to texel steps. */
  update(dt, focus, sunDir, shadowInterval = 1) {
    this._shadowTick++;
    const texel = (this.shadowDistance * 2) / this.sun.shadow.mapSize.x;
    const snap = (v) => Math.round(v / texel) * texel;
    if (this._shadowTick % Math.max(1, Math.round(shadowInterval)) === 0) {
      this.sunTarget.position.set(snap(focus.x), snap(focus.y), snap(focus.z));
      this.sun.position.copy(this.sunTarget.position).addScaledVector(sunDir, this.shadowDistance * 2.4);
      this.sun.updateMatrixWorld();
      this.sunTarget.updateMatrixWorld();
    }
    this.rim.position.copy(focus).addScaledVector(sunDir, -this.shadowDistance * 2).setY(focus.y + 800);

    if (this.lightningFlash > 0) {
      this.lightningFlash = Math.max(0, this.lightningFlash - dt * 3.2);
      this.sun.intensity = this.baseSunIntensity + this.lightningFlash * 9;
      this.hemi.intensity = lerp(this.hemi.intensity, this.hemi.intensity + this.lightningFlash * 4, 0.5);
    } else {
      this.sun.intensity = damp(this.sun.intensity, this.baseSunIntensity, 6, dt);
    }
  }

  strike(power = 1) { this.lightningFlash = Math.max(this.lightningFlash, power); }
}

/* ===========================================================================
 * POST-PROCESSING
 * ------------------------------------------------------------------------
 * RenderPass → Bloom (HDR) → OutputPass (ACES + sRGB) → Composite.
 * The composite pass folds motion blur, chromatic aberration, grade, vignette,
 * grain, speed lines, damage and flash into a single fullscreen pass.
 * ======================================================================== */

const CompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uBlur: { value: 0 },
    uBlurCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uCamVel: { value: new THREE.Vector2(0, 0) },
    uBoost: { value: 0 },
    uChroma: { value: 0.0 },
    uVignette: { value: 0.5 },
    uGrain: { value: 0.04 },
    uSat: { value: 1.06 },
    uContrast: { value: 1.05 },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uDamage: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uSpeedLines: { value: 0 },
    uScan: { value: 0 },
    uScanColor: { value: new THREE.Color(0.2, 0.95, 1.0) },
    uPhase: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution, uBlurCenter, uCamVel;
    uniform float uTime, uBlur, uBoost, uChroma, uVignette, uGrain, uSat, uContrast;
    uniform float uDamage, uFlash, uSpeedLines, uScan, uPhase;
    uniform vec3 uLift, uGain, uFlashColor, uScanColor;
    varying vec2 vUv;

    #ifndef TAPS
      #define TAPS 10
    #endif

    float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

    void main(){
      vec2 uv = vUv;
      vec2 dir = uv - uBlurCenter;
      float dist = length(dir);

      /* --- motion blur -------------------------------------------------
       * Two components, summed per tap:
       *   radial — the world rushing past the focal point, which is what
       *            forward motion actually looks like;
       *   linear — how far a distant point slid across the screen since the
       *            last frame, so banking and pulling smear sideways too.
       * Reheat adds a third: a much longer radial stretch plus an outward
       * lens warp, so lighting the burner reads as a physical shove.
       * ---------------------------------------------------------------- */
      float mask = smoothstep(0.045, 0.60, dist);
      float boostRadial = uBoost * uBoost * 0.19;
      float amt = (uBlur + boostRadial) * mask;
      // Under reheat the frame stretches outward from the focus as well as
      // smearing — the barrel term is small but it is what sells the punch.
      vec2 warp = dir * dist * uBoost * 0.085;
      vec2 radialVec = -dir * amt - warp;
      // The player's own aircraft is rigidly attached to the camera, so it does
      // not slide when the camera swings — and it sits right at the focal
      // point. Fading the linear term to almost nothing there keeps the
      // airframe crisp while the sky around it still smears.
      vec2 linearVec = -uCamVel * (0.08 + 0.92 * mask);

      vec3 col = vec3(0.0);
      float wsum = 0.0;
      for (int i = 0; i < TAPS; i++){
        float t = float(i) / float(TAPS - 1);
        float w = 1.0 - t * 0.55;
        vec2 off = (radialVec + linearVec) * t;
        // Chroma is a lens artifact: it belongs at the edges. Keeping it near
        // zero at the focal point stops the player's own aircraft — which sits
        // right there — from picking up rainbow fringes under reheat.
        float ca = uChroma * (0.12 + dist * 1.55) * (0.35 + t) * (1.0 + uBoost * 1.5);
        vec2 cdir = normalize(dir + 1e-6) * ca;
        vec3 s;
        s.r = texture2D(tDiffuse, uv + off + cdir).r;
        s.g = texture2D(tDiffuse, uv + off).g;
        s.b = texture2D(tDiffuse, uv + off - cdir).b;
        col += s * w; wsum += w;
      }
      col /= wsum;

      // Speed lines: high-frequency streaks radiating from the focal point.
      if (uSpeedLines > 0.001) {
        float ang = atan(dir.y, dir.x);
        float lines = hash12(vec2(floor(ang * 58.0), floor(uTime * 26.0)));
        float streak = smoothstep(0.94, 1.0, lines) * smoothstep(0.30, 0.86, dist);
        col += vec3(0.65, 0.82, 1.0) * streak * uSpeedLines * 0.26;
      }

      // Reheat: a second, much finer streak layer plus a warm rim, both only
      // out at the edges so the route ahead stays readable.
      if (uBoost > 0.002) {
        float ang = atan(dir.y, dir.x);
        float fine = hash12(vec2(floor(ang * 190.0), floor(uTime * 62.0)));
        float streak = smoothstep(0.90, 1.0, fine) * smoothstep(0.16, 0.80, dist);
        col += vec3(1.0, 0.86, 0.66) * streak * uBoost * 0.40;
        col *= 1.0 - smoothstep(0.34, 0.95, dist) * uBoost * 0.22;
        col += vec3(0.30, 0.14, 0.05) * smoothstep(0.45, 1.0, dist) * uBoost * 0.30;
      }

      // Phase Shift — chromatic ghosting while the airframe is desynced.
      if (uPhase > 0.001) {
        vec2 o = vec2(0.006, 0.0) * uPhase;
        col = mix(col, vec3(texture2D(tDiffuse, uv + o).r, col.g, texture2D(tDiffuse, uv - o).b), 0.65);
        col += vec3(0.35, 0.15, 0.55) * uPhase * 0.18;
      }

      // Grade: lift/gain, contrast around mid grey, saturation.
      col = col * uGain + uLift;
      col = (col - 0.5) * uContrast + 0.5;
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, uSat);

      // Route Scan sweep — a thin travelling ring, not a wash.
      if (uScan > 0.001) {
        float ring = abs(dist - fract(uTime * 0.55) * 0.9);
        col += uScanColor * smoothstep(0.018, 0.0, ring) * uScan * 0.20;
      }

      // Damage: pulsing red edge.
      if (uDamage > 0.001) {
        float pulse = 0.55 + 0.45 * sin(uTime * 6.0);
        col = mix(col, vec3(0.75, 0.05, 0.06), smoothstep(0.30, 0.86, dist) * uDamage * pulse * 0.7);
      }

      // Vignette.
      float vig = 1.0 - uVignette * smoothstep(0.28, 0.92, dist * 1.18);
      col *= vig;

      // Flash (collisions / gate hits / lightning).
      col += uFlashColor * uFlash;

      // Film grain.
      if (uGrain > 0.0005) {
        float g = hash12(uv * uResolution + fract(uTime) * 431.0);
        col += (g - 0.5) * uGrain;
      }

      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class PostFX {
  constructor(renderer, scene, camera, preset) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rtOpts = {
      type: THREE.HalfFloatType,
      samples: 0,
      colorSpace: THREE.LinearSRGBColorSpace,
    };
    this.target = new THREE.WebGLRenderTarget(Math.max(2, size.x), Math.max(2, size.y), rtOpts);
    this.composer = new EffectComposer(renderer, this.target);
    this.composer.setPixelRatio(1); // we already scale the drawing buffer ourselves

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Threshold sits high on purpose: only genuine emitters (reheat, gate
    // energy, sun disc, nav lights) should bloom. A low threshold makes an
    // overcast sky or a snowfield glow, which reads as a blown-out frame
    // rather than a bright one.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), preset.bloomStrength, 0.48, 0.92);
    this.composer.addPass(this.bloom);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.composite = new ShaderPass(CompositeShader);
    this.composite.renderToScreen = true;
    this.composite.material.defines = { ...(this.composite.material.defines || {}), TAPS: 10 };
    this.composer.addPass(this.composite);

    this.u = this.composite.uniforms;
    // Screen-space camera motion, measured between frames.
    this._prevCamQuat = new THREE.Quaternion();
    this._camVel = new THREE.Vector2();
    this._velQ = new THREE.Quaternion();
    this._velV = new THREE.Vector3();
    this.applyPreset(preset);
  }

  applyPreset(preset) {
    this.preset = preset;
    this.bloom.enabled = !!preset.bloom;
    this.bloom.strength = preset.bloomStrength;
    this.u.uChroma.value = preset.chromatic ? 0.0016 : 0;
    this.u.uGrain.value = preset.grain ? 0.035 : 0;
    this.motionBlurEnabled = !!preset.motionBlur;
    // Tap count is the one part of the blur worth spending quality budget on:
    // too few and a long reheat smear bands into visible ghosts.
    const taps = !preset.motionBlur ? 6 : (preset.blurTaps || 10);
    if (this.composite.material.defines.TAPS !== taps) {
      this.composite.material.defines.TAPS = taps;
      this.composite.material.needsUpdate = true;
    }
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.u.uResolution.value.set(w, h);
  }

  /**
   * Forget the previous frame's camera orientation. Without this a camera cut
   * — a respawn, a mode change, a new run — looks to the blur like an enormous
   * one-frame slew and whips the whole frame sideways.
   */
  resetMotion() {
    this._prevCamQuat.copy(this.camera.quaternion);
    this._camVel.set(0, 0);
    this.u.uCamVel.value.set(0, 0);
  }

  /** Per-frame grade + effect drive. */
  update(dt, state) {
    const u = this.u;
    u.uTime.value += dt;
    const intensity = state.postIntensity ?? 1;

    const speed01 = clamp01(state.speed01 ?? 0);
    const boost = clamp01(state.boost ?? 0);
    const motion = state.reducedMotion ? 0.35 : 1;
    const target = this.motionBlurEnabled
      ? (Math.pow(speed01, 1.9) * 0.070 + boost * 0.030) * intensity * motion
      : 0;
    u.uBlur.value = damp(u.uBlur.value, target, 8, dt);
    // The nitrous blur is deliberately its own channel rather than more of the
    // cruise blur: it ramps sharply, holds, and drops away fast.
    u.uBoost.value = damp(u.uBoost.value,
      this.motionBlurEnabled ? Math.pow(boost, 0.75) * intensity * motion : 0,
      boost > u.uBoost.value ? 5.5 : 3.2, dt);

    /* --- how far the world slid across the screen since the last frame ----
     * Take the previous frame's forward axis into the current camera's space
     * and project it: that is exactly where a distant static point used to be,
     * so the difference is the screen-space smear direction for this frame. */
    const cam = this.camera;
    const pv = this._velV, pq = this._velQ;
    pq.copy(cam.quaternion).invert();
    pv.set(0, 0, -1).applyQuaternion(this._prevCamQuat).applyQuaternion(pq);
    const iz = 1 / Math.max(0.25, -pv.z);
    const tanHalf = Math.tan((cam.fov || 60) * 0.5 * Math.PI / 180);
    const vx = (pv.x * iz) / (tanHalf * (cam.aspect || 1.777)) * 0.5;
    const vy = (pv.y * iz) / tanHalf * 0.5;
    // Normalise to a 60 Hz exposure. Physically the smear should grow as the
    // frame time does, but a machine dropping to 20 fps would then bury the
    // route in mud exactly when the player most needs to see it.
    const shutter = Math.min(1, (1 / 60) / Math.max(1e-4, dt));
    const scale = this.motionBlurEnabled ? intensity * motion * shutter * (0.9 + boost * 1.0) : 0;
    // Clamp: a camera cut or a respawn would otherwise smear the whole frame.
    this._camVel.set(clamp(vx * scale, -0.055, 0.055), clamp(vy * scale, -0.055, 0.055));
    u.uCamVel.value.lerp(this._camVel, clamp01(dt * 26));
    this._prevCamQuat.copy(cam.quaternion);

    const sl = this.motionBlurEnabled
      ? clamp01((speed01 - 0.55) / 0.45) * (0.5 + boost * 0.7) * intensity * (state.reducedMotion ? 0.3 : 1)
      : 0;
    u.uSpeedLines.value = damp(u.uSpeedLines.value, sl, 6, dt);

    if (state.blurCenter) u.uBlurCenter.value.lerp(state.blurCenter, clamp01(dt * 6));

    u.uChroma.value = damp(u.uChroma.value,
      (this.preset.chromatic ? 0.0004 + speed01 * 0.0008 + boost * 0.0011 : 0) * intensity, 6, dt);

    u.uVignette.value = damp(u.uVignette.value, 0.42 + speed01 * 0.16 + (state.vignetteBoost || 0), 5, dt);
    u.uDamage.value = damp(u.uDamage.value, clamp01(state.damage ?? 0), 5, dt);
    u.uPhase.value = damp(u.uPhase.value, clamp01(state.phase ?? 0), 8, dt);
    u.uScan.value = damp(u.uScan.value, clamp01(state.scan ?? 0), 5, dt);
    u.uFlash.value = Math.max(0, u.uFlash.value - dt * 3.4);

    // Colour identity per venue/weather.
    const g = state.grade || {};
    u.uSat.value = damp(u.uSat.value, g.sat ?? 1.06, 3, dt);
    u.uContrast.value = damp(u.uContrast.value, g.contrast ?? 1.06, 3, dt);
    if (g.lift) u.uLift.value.lerp(g.lift, clamp01(dt * 3));
    if (g.gain) u.uGain.value.lerp(g.gain, clamp01(dt * 3));

    if (this.bloom.enabled) {
      this.bloom.strength = lerp(this.preset.bloomStrength, this.preset.bloomStrength * 1.5, boost) * intensity;
    }
  }

  flash(amount = 0.35, color = 0xffffff) {
    this.u.uFlash.value = Math.max(this.u.uFlash.value, amount);
    this.u.uFlashColor.value.set(color);
  }

  render(dt) {
    if (this.enabled) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() { this.composer.dispose(); this.target.dispose(); }
}

/* ===========================================================================
 * CAMERA RIG
 * ------------------------------------------------------------------------
 * Aircraft convention: nose = local -Z, up = +Y, right wing = +X.
 * ======================================================================== */

// Distances are tuned so the airframe stays a large, readable subject rather
// than a speck — the aircraft is the thing you are reading to fly.
const CAM_MODES = [
  { id: 'chase', name: 'Chase', dist: 17, height: 4.4, look: 46, fov: 66 },
  { id: 'far', name: 'Wide Chase', dist: 29, height: 7.4, look: 62, fov: 70 },
  { id: 'close', name: 'Close', dist: 11.5, height: 2.8, look: 32, fov: 62 },
  { id: 'cockpit', name: 'Cockpit', dist: -1.4, height: 1.35, look: 200, fov: 78, cockpit: true },
];

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.modeIndex = 0;
    this.mode = CAM_MODES[0];
    this.position = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.shake = 0;
    this.shakeFreq = 26;
    this.shakeTime = 0;
    this.rollBlend = 0;
    this.fov = 66;
    this.baseFov = 66;
    this.sensitivity = 1;
    this.reducedMotion = false;
    this.cinematic = null;
    this.cinematicT = 0;
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._offset = new THREE.Vector3();
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this._noiseSeed = Math.random() * 1000;
    this.initialised = false;
  }

  cycle() {
    this.modeIndex = (this.modeIndex + 1) % CAM_MODES.length;
    this.mode = CAM_MODES[this.modeIndex];
    this.initialised = false;
    return this.mode.name;
  }
  setMode(id) {
    const i = CAM_MODES.findIndex((m) => m.id === id);
    if (i >= 0) { this.modeIndex = i; this.mode = CAM_MODES[i]; this.initialised = false; }
  }
  get isCockpit() { return !!this.mode.cockpit; }

  addShake(amount, freq = 26) {
    this.shake = Math.min(1.6, this.shake + amount * (this.reducedMotion ? 0.35 : 1));
    this.shakeFreq = freq;
  }

  /** Snap instantly — used on race start / respawn so there is no fly-in. */
  reset() { this.initialised = false; this.onReset?.(); }

  update(dt, target, params = {}) {
    const m = this.mode;
    const speed01 = clamp01(params.speed01 ?? 0);
    const boost = clamp01(params.boost ?? 0);
    const q = target.quaternion;

    // --- desired camera position in aircraft space ------------------------
    const distance = m.dist * (1 + speed01 * 0.20 + boost * 0.10) * (params.distanceScale ?? 1);
    const height = m.height * (1 + speed01 * 0.10);
    this._offset.set(0, height, distance);
    // Trail slightly outside the turn so the airframe reads against the sky.
    this._offset.x += (params.lateral ?? 0) * -3.2;
    this._offset.applyQuaternion(q);

    const desired = this._tmpA.copy(target.position).add(this._offset);
    // Pull the camera up when diving so terrain never clips the near plane.
    if (!m.cockpit) desired.y += clamp(-(params.pitchRate ?? 0) * 8, -6, 10);

    const lag = m.cockpit ? 40 : lerp(5.5, 11.0, speed01) * (params.lagScale ?? 1);
    if (!this.initialised) { this.position.copy(desired); this.initialised = true; }
    else {
      this.position.x = damp(this.position.x, desired.x, lag, dt);
      this.position.y = damp(this.position.y, desired.y, lag * 0.92, dt);
      this.position.z = damp(this.position.z, desired.z, lag, dt);
    }

    // --- look target ------------------------------------------------------
    const fwd = this._tmpB.set(0, 0, -1).applyQuaternion(q);
    const lookDist = m.look * (1 + speed01 * 0.5);
    const desiredLook = this._tmpA.copy(target.position).addScaledVector(fwd, lookDist);
    desiredLook.y += m.cockpit ? 0 : 2.5;
    this.lookAt.x = damp(this.lookAt.x, desiredLook.x, lag * 1.4, dt);
    this.lookAt.y = damp(this.lookAt.y, desiredLook.y, lag * 1.4, dt);
    this.lookAt.z = damp(this.lookAt.z, desiredLook.z, lag * 1.4, dt);

    // --- camera banking follows the airframe roll -------------------------
    const upTarget = this._tmpB.set(0, 1, 0).applyQuaternion(q);
    const blend = m.cockpit ? 1.0 : (this.reducedMotion ? 0.35 : 0.72);
    this.up.lerpVectors(this._worldUp, upTarget, blend).normalize();

    this.camera.position.copy(this.position);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.lookAt);

    // --- shake ------------------------------------------------------------
    const buffet = (params.turbulence ?? 0) * 0.16 + Math.pow(speed01, 3) * 0.06;
    const totalShake = this.shake + buffet;
    if (totalShake > 0.0008) {
      this.shakeTime += dt * this.shakeFreq;
      const t = this.shakeTime, s = this._noiseSeed;
      const nx = Math.sin(t * 1.7 + s) * Math.sin(t * 0.53 + s * 2.1);
      const ny = Math.sin(t * 2.3 + s * 1.7) * Math.sin(t * 0.71 + s * 0.4);
      const nz = Math.sin(t * 1.1 + s * 3.3);
      const amp = totalShake * 0.9;
      this.camera.position.x += nx * amp;
      this.camera.position.y += ny * amp;
      this.camera.rotateZ(nz * totalShake * 0.014);
      this.shake = Math.max(0, this.shake - dt * 2.6);
    }

    // --- dynamic FOV ------------------------------------------------------
    const fovTarget = m.fov + speed01 * 12 + boost * 13 + (params.fovBoost ?? 0);
    this.fov = damp(this.fov, this.reducedMotion ? m.fov + speed01 * 4 : fovTarget, 4.5, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Orbit view used by the menu background and the hangar preview. */
  orbit(dt, center, radius, height, speed = 0.18, elapsed = 0) {
    const a = elapsed * speed;
    this.camera.position.set(
      center.x + Math.cos(a) * radius,
      center.y + height + Math.sin(a * 0.7) * height * 0.18,
      center.z + Math.sin(a) * radius,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(center);
  }
}

/* ===========================================================================
 * GEOMETRY HELPERS
 * ======================================================================== */

/**
 * Loft a closed tube through a list of cross-sections.
 * @param {Array<Array<[number,number,number]>>} sections equal-length point loops
 */
function loft3(sections, { capStart = true, capEnd = true } = {}) {
  const S = sections.length;
  const N = sections[0].length;
  const ring = N + 1;                       // duplicate seam vertex for clean UVs
  const vertCount = S * ring + (capStart ? 1 : 0) + (capEnd ? 1 : 0);
  const pos = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);
  const idx = [];

  let v = 0;
  for (let s = 0; s < S; s++) {
    const sec = sections[s];
    for (let i = 0; i <= N; i++) {
      const p = sec[i % N];
      pos[v * 3] = p[0]; pos[v * 3 + 1] = p[1]; pos[v * 3 + 2] = p[2];
      uv[v * 2] = i / N; uv[v * 2 + 1] = s / (S - 1);
      v++;
    }
  }
  for (let s = 0; s < S - 1; s++) {
    for (let i = 0; i < N; i++) {
      const a = s * ring + i, b = s * ring + i + 1;
      const c = (s + 1) * ring + i + 1, d = (s + 1) * ring + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  if (capStart) {
    const c = v;
    let cx = 0, cy = 0, cz = 0;
    for (const p of sections[0]) { cx += p[0]; cy += p[1]; cz += p[2]; }
    pos[v * 3] = cx / N; pos[v * 3 + 1] = cy / N; pos[v * 3 + 2] = cz / N;
    uv[v * 2] = 0.5; uv[v * 2 + 1] = 0; v++;
    for (let i = 0; i < N; i++) idx.push(c, i + 1, i);
  }
  if (capEnd) {
    const c = v;
    const last = sections[S - 1];
    let cx = 0, cy = 0, cz = 0;
    for (const p of last) { cx += p[0]; cy += p[1]; cz += p[2]; }
    pos[v * 3] = cx / N; pos[v * 3 + 1] = cy / N; pos[v * 3 + 2] = cz / N;
    uv[v * 2] = 0.5; uv[v * 2 + 1] = 1; v++;
    const base = (S - 1) * ring;
    for (let i = 0; i < N; i++) idx.push(c, base + i, base + i + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Superellipse cross-section in the XY plane at a given z, with optional chine. */
function superellipse(n, w, h, z, yOff = 0, ex = 2.4, ey = 2.4, chine = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    let x = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / ex) * w;
    let y = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / ey) * h;
    if (chine > 0) x += Math.sign(ca) * chine * w * Math.pow(1 - Math.abs(sa), 3);
    pts.push([x, y + yOff, z]);
  }
  return pts;
}

/** Symmetric NACA-00xx half-thickness. */
function naca(u, t) {
  u = clamp01(u);
  return 5 * t * (0.2969 * Math.sqrt(u) - 0.1260 * u - 0.3516 * u * u + 0.2843 * u * u * u - 0.1036 * u * u * u * u);
}

/** Closed airfoil loop in the (z,y) plane, chord running from z0 to z0+chord. */
function airfoilLoop(chord, thickRatio, z0, y0, n = 16) {
  const pts = [];
  const half = Math.max(2, Math.floor(n / 2));
  for (let i = 0; i <= half; i++) {
    const u = i / half;
    pts.push([0, y0 + naca(u, thickRatio) * chord, z0 + u * chord]);
  }
  for (let i = half - 1; i > 0; i--) {
    const u = i / half;
    pts.push([0, y0 - naca(u, thickRatio) * chord, z0 + u * chord]);
  }
  return pts;
}

/**
 * Swept/tapered lifting surface. Returns geometry in aircraft space.
 * `side` = +1 (right / up) or -1 (left / down); `vertical` rotates it into the
 * XY plane so the same builder produces fins and rudders.
 */
function buildSurface({
  span, rootChord, tipChord, sweep, dihedral, rootZ, rootY, side = 1,
  thickRoot = 0.075, thickTip = 0.05, vertical = false, cant = 0, segments = 3,
}) {
  const sections = [];
  for (let s = 0; s <= segments; s++) {
    const f = s / segments;
    const chord = lerp(rootChord, tipChord, Math.pow(f, 0.85));
    const thick = lerp(thickRoot, thickTip, f);
    const dist = (span) * f;
    const z0 = rootZ + sweep * dist;
    const loop = airfoilLoop(chord, thick, z0, 0, 14);
    for (const p of loop) {
      let x = dist * side;
      let y = rootY + p[1] + dihedral * dist;
      if (vertical) {
        // rotate the span axis from X into Y, then apply the cant angle
        const yy = dist;
        const xx = p[1];
        const c = Math.cos(cant * side), sn = Math.sin(cant * side);
        x = (xx * c - yy * sn) * 1 + 0;
        y = rootY + (xx * sn + yy * c);
      }
      p[0] = x; p[1] = y;
    }
    sections.push(loop);
  }
  return loft3(sections, { capStart: false, capEnd: true });
}

/** Re-project UVs planar so livery patterns read consistently on flat parts. */
function planarUV(geo, uAxis = 2, vAxis = 0) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const min = [bb.min.x, bb.min.y, bb.min.z];
  const size = [Math.max(1e-3, bb.max.x - bb.min.x), Math.max(1e-3, bb.max.y - bb.min.y), Math.max(1e-3, bb.max.z - bb.min.z)];
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const p = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    uv[i * 2] = (p[uAxis] - min[uAxis]) / size[uAxis];
    uv[i * 2 + 1] = (p[vAxis] - min[vAxis]) / size[vAxis];
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * Merge geometries safely.
 *
 * three's `mergeGeometries` refuses to mix indexed and non-indexed inputs, and
 * the built-in primitives disagree: Box/Cylinder/Cone/Sphere/Circle are
 * indexed while Icosahedron/Octahedron/Tetrahedron (PolyhedronGeometry) are
 * not. Mixing them silently returns null, which then surfaces as a null
 * geometry deep inside the renderer. Normalise to non-indexed when the list is
 * mixed, and only then merge.
 */
export function mergeGeometriesSafe(list, disposeSources = true) {
  const valid = list.filter((g) => g && g.attributes && g.attributes.position);
  if (!valid.length) return null;
  if (valid.length === 1) return disposeSources ? valid[0] : valid[0].clone();

  const indexed = valid.filter((g) => g.index);
  let prepared = valid;
  const temps = [];
  if (indexed.length && indexed.length !== valid.length) {
    prepared = valid.map((g) => {
      if (!g.index) return g;
      const nz = g.toNonIndexed();
      temps.push(nz);
      return nz;
    });
  }
  // Every source must carry the same attribute set.
  const keys = new Set();
  for (const g of prepared) for (const k of Object.keys(g.attributes)) keys.add(k);
  for (const g of prepared) {
    for (const k of keys) {
      if (g.attributes[k]) continue;
      const size = k === 'uv' || k === 'uv1' ? 2 : 3;
      g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * size), size));
    }
  }

  let merged = null;
  try {
    merged = BufferGeometryUtils.mergeGeometries(prepared, false);
  } catch (err) {
    console.warn('[Geometry] merge failed:', err.message);
  }
  for (const t of temps) t.dispose();
  if (disposeSources) for (const g of valid) g.dispose();
  if (merged && !merged.attributes.normal) merged.computeVertexNormals();
  return merged;
}

function mergeAll(list) { return mergeGeometriesSafe(list, true); }

/* ===========================================================================
 * AIRCRAFT FACTORY
 * ------------------------------------------------------------------------
 * Nose = -Z, up = +Y, right wing = +X. Everything is generated from the
 * `shape` block in config.js so each airframe has a genuinely distinct
 * silhouette, and everything merges down to ~6 draw calls.
 * ======================================================================== */

export class AircraftFactory {
  constructor(materials, quality) {
    this.mats = materials;
    this.quality = quality;
    this.cache = new Map();
    /** Externally generated models (Tripo3D pipeline), keyed by aircraft id. */
    this.external = new Map();
  }

  /**
   * Register a loaded GLB for an airframe. The model replaces the procedural
   * hull; nozzles, afterburners, trails and control surfaces are still derived
   * so the aircraft keeps every gameplay-visible behaviour.
   *
   * @param level 0 = hero mesh, 1 = reduced mesh used for mid/far detail.
   */
  registerExternal(id, object3D, level = 0) {
    if (!object3D) return false;
    const box = new THREE.Box3().setFromObject(object3D);
    const size = box.getSize(new THREE.Vector3());
    if (!isFinite(size.x) || size.length() < 1e-4) {
      console.warn(`[Aircraft] external model "${id}" has no usable geometry — keeping procedural airframe`);
      return false;
    }
    const entry = this.external.get(id) || { levels: [] };
    entry.levels[level] = object3D;
    this.external.set(id, entry);
    this.cache.delete(`${id}_0`);
    this.cache.delete(`${id}_1`);
    this.cache.delete(`${id}_2`);
    return true;
  }

  /**
   * Find the wingtips on the fitted mesh. Exactly half the span, wherever the
   * model actually puts it — so tip vapour trails from the real tip rather than
   * from a number borrowed off the procedural airframe.
   */
  _measureWingTips(root, spec, L) {
    root.updateMatrixWorld(true);
    const tip = { x: 0, y: 0, z: 0 };
    const v = new THREE.Vector3();
    root.traverse((n) => {
      if (!n.isMesh || !n.geometry?.attributes?.position) return;
      const pos = n.geometry.attributes.position;
      const m = n.matrixWorld;
      // A sample is plenty: the widest vertex is on a long span of wing, not a
      // lone spike, and this keeps the pass well inside one frame.
      const step = pos.count > 40000 ? 3 : 1;
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        if (v.x > tip.x) { tip.x = v.x; tip.y = v.y; tip.z = v.z; }
      }
    });
    if (tip.x < 1e-3) {
      const r = new THREE.Vector3(spec.shape.wingSpan * 0.48, 0, L * 0.1);
      return { span: spec.shape.wingSpan, wingTips: [r, r.clone().setX(-r.x)] };
    }
    const r = new THREE.Vector3(tip.x * 0.985, tip.y, tip.z);
    return { span: tip.x * 2, wingTips: [r, r.clone().setX(-r.x)] };
  }

  /**
   * Fit an external model into the airframe's canonical frame (nose = -Z, up =
   * +Y, right wing = +X) using the solved transform on `spec.model`. Note the
   * `true` on setFromObject: the cheap form expands by each mesh's *unrotated*
   * bounding-box corners, which for a rotated airframe over-reports the height
   * by 2-3x and would scale every model wrong.
   */
  _buildExternal(spec, entry, detail = 2) {
    // Prefer the hero mesh up close and the reduced one further out, but take
    // whichever actually loaded — either can be missing on its own.
    const src = (detail >= 2 ? entry.levels[0] : entry.levels[1])
      || entry.levels[0] || entry.levels[1];
    const cfg = spec.model || {};
    const group = new THREE.Group();
    group.name = `aircraft_${spec.id}_ext`;

    // pivot carries the authoring-frame correction; holder carries the fit.
    const pivot = new THREE.Group();
    pivot.add(src.clone(true));
    if (Array.isArray(cfg.quat)) pivot.quaternion.fromArray(cfg.quat);
    else if (Array.isArray(cfg.rotate)) pivot.rotation.set(cfg.rotate[0] || 0, cfg.rotate[1] || 0, cfg.rotate[2] || 0);
    pivot.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(pivot, true);
    const size = box.getSize(new THREE.Vector3());
    const L = cfg.length || spec.shape.length;
    const scale = size.z > 1e-6 ? L / size.z : 1;
    pivot.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-1);

    const holder = new THREE.Group();
    holder.scale.setScalar(scale);
    holder.add(pivot);
    group.add(holder);

    group.traverse((n) => {
      if (!n.isMesh) return;
      n.castShadow = true;
      n.receiveShadow = true;
      n.frustumCulled = false; // the group is small and always near the camera
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.envMapIntensity !== undefined) m.envMapIntensity = 1.0;
        m.side = THREE.FrontSide;
      }
    });

    const { span, wingTips } = this._measureWingTips(group, spec, L);
    const s = spec.shape;
    const nozzlePositions = Array.isArray(cfg.nozzles) && cfg.nozzles.length
      ? cfg.nozzles.map((n) => new THREE.Vector3(n[0], n[1], n[2]))
      : Array.from({ length: Math.max(1, s.engines) }, (_, e) => {
        const side = s.engines === 1 ? 0 : (e === 0 ? 1 : -1);
        return new THREE.Vector3(side * s.engineSep * 0.5, -s.bodyH * 0.08, L * 0.5);
      });

    return {
      group,
      surfaces: { ailerons: [], elevons: [], rudders: [] },
      nozzlePositions,
      wingTips,
      length: L,
      span,
      radius: Math.max(L, span) * 0.5,
      engineRadius: cfg.engineRadius || s.engineR,
      external: true,
    };
  }

  /** @param detail 2 = hero, 1 = mid, 0 = distant */
  build(spec, detail = 2) {
    const ext = this.external.get(spec.id);
    if (ext && ext.levels.some(Boolean)) return this._buildExternal(spec, ext, detail);
    const s = spec.shape;
    const L = s.length;
    const group = new THREE.Group();
    group.name = `aircraft_${spec.id}`;

    const bodyGeos = [];
    const darkGeos = [];
    const glowGeos = [];

    /* ---- fuselage --------------------------------------------------- */
    const stations = detail >= 2 ? 20 : detail === 1 ? 14 : 9;
    const ringN = detail >= 2 ? 14 : detail === 1 ? 10 : 8;
    const sections = [];
    for (let i = 0; i < stations; i++) {
      const t = i / (stations - 1);
      const z = -L * 0.5 + t * L;
      let w, h, yOff;
      if (t < s.noseLen) {
        const k = t / s.noseLen;
        const sharp = Math.pow(k, 1 / s.noseSharp);
        w = s.bodyW * sharp;
        h = s.bodyH * Math.pow(k, 1 / (s.noseSharp * 0.82)) * 0.94;
        yOff = -s.bodyH * 0.10 * (1 - k);
      } else {
        const k = (t - s.noseLen) / (1 - s.noseLen);
        const bulge = Math.sin(k * Math.PI * 0.9 + 0.12);
        w = s.bodyW * (0.80 + 0.28 * bulge - 0.30 * Math.pow(k, 2.8));
        h = s.bodyH * (0.84 + 0.24 * bulge - 0.26 * Math.pow(k, 2.2));
        yOff = s.bodyH * 0.05 * Math.sin(k * Math.PI);
      }
      const chine = t > s.noseLen * 0.5 ? 0.22 : 0.10;
      sections.push(superellipse(ringN, Math.max(0.02, w), Math.max(0.02, h), z, yOff, 2.9, 2.3, chine));
    }
    bodyGeos.push(loft3(sections, { capStart: true, capEnd: false }));

    /* ---- dorsal spine ----------------------------------------------- */
    if (detail >= 1) {
      const spine = [];
      const n = 6;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const z = -L * 0.10 + t * L * 0.52;
        const w = s.bodyW * 0.30 * (1 - t * 0.6);
        const h = s.bodyH * (0.30 + 0.18 * Math.sin(t * Math.PI)) * (1 - t * 0.35);
        spine.push(superellipse(8, w, h, z, s.bodyH * 0.62, 2.4, 2.0, 0));
      }
      bodyGeos.push(loft3(spine, { capStart: false, capEnd: true }));
    }

    /* ---- main wings -------------------------------------------------- */
    const halfSpan = s.wingSpan / 2 - s.bodyW * 0.6;
    const wingRootZ = L * (0.02 + s.wingPos);
    for (const side of [1, -1]) {
      const g = buildSurface({
        span: halfSpan, rootChord: s.wingRoot, tipChord: s.wingTip,
        sweep: s.wingSweep, dihedral: s.wingDihedral, rootZ: wingRootZ - s.wingRoot * 0.5,
        rootY: -s.bodyH * 0.12, side, segments: detail >= 2 ? 3 : 2,
      });
      // Shift outward so the root buries inside the fuselage.
      g.translate(side * s.bodyW * 0.55, 0, 0);
      bodyGeos.push(planarUV(g, 2, 0));
    }

    /* ---- leading-edge root extensions (strakes) ---------------------- */
    if (s.strakes > 0.01 && detail >= 1) {
      for (const side of [1, -1]) {
        const g = buildSurface({
          span: s.bodyW * 1.05 * s.strakes, rootChord: L * 0.30, tipChord: L * 0.05,
          sweep: 1.9, dihedral: 0, rootZ: -L * 0.20, rootY: -s.bodyH * 0.02,
          side, thickRoot: 0.035, thickTip: 0.02, segments: 2,
        });
        g.translate(side * s.bodyW * 0.5, 0, 0);
        bodyGeos.push(planarUV(g, 2, 0));
      }
    }

    /* ---- canards ----------------------------------------------------- */
    if (s.canard > 0.01) {
      for (const side of [1, -1]) {
        const g = buildSurface({
          span: s.canardSpan / 2 - s.bodyW * 0.5, rootChord: L * 0.13 * s.canard, tipChord: L * 0.05 * s.canard,
          sweep: 1.0, dihedral: 0.10, rootZ: -L * 0.30, rootY: s.bodyH * 0.12,
          side, thickRoot: 0.06, thickTip: 0.04, segments: 2,
        });
        g.translate(side * s.bodyW * 0.55, 0, 0);
        bodyGeos.push(planarUV(g, 2, 0));
      }
    }

    /* ---- tails -------------------------------------------------------- */
    const tailZ = L * 0.30;
    if (s.tail === 'twin' || s.tail === 'v') {
      for (const side of [1, -1]) {
        const g = buildSurface({
          span: L * 0.155 * s.tailSize, rootChord: L * 0.20 * s.tailSize, tipChord: L * 0.085 * s.tailSize,
          sweep: 1.15, dihedral: 0, rootZ: tailZ, rootY: s.bodyH * 0.24,
          side, vertical: true, cant: s.tailCant, thickRoot: 0.06, thickTip: 0.04, segments: 2,
        });
        g.translate(side * s.engineSep * 0.72, 0, 0);
        bodyGeos.push(planarUV(g, 2, 1));
      }
    } else {
      const g = buildSurface({
        span: L * 0.20 * s.tailSize, rootChord: L * 0.24 * s.tailSize, tipChord: L * 0.09 * s.tailSize,
        sweep: 1.1, dihedral: 0, rootZ: tailZ, rootY: s.bodyH * 0.3,
        side: 1, vertical: true, cant: 0, thickRoot: 0.06, thickTip: 0.04, segments: 2,
      });
      bodyGeos.push(planarUV(g, 2, 1));
    }

    /* ---- ventral fins ------------------------------------------------- */
    if (s.ventral > 0.05 && detail >= 1) {
      for (const side of [1, -1]) {
        const g = buildSurface({
          span: L * 0.07 * s.ventral, rootChord: L * 0.14, tipChord: L * 0.06,
          sweep: 1.3, dihedral: 0, rootZ: tailZ * 0.9, rootY: -s.bodyH * 0.42,
          side, vertical: true, cant: 0.7 * side, thickRoot: 0.05, thickTip: 0.035, segments: 1,
        });
        g.scale(1, -1, 1);
        g.translate(side * s.engineSep * 0.5, 0, 0);
        bodyGeos.push(planarUV(g, 2, 1));
      }
    }

    /* ---- engine nacelles + nozzles ------------------------------------ */
    const nozzlePositions = [];
    const engR = s.engineR;
    const engZ0 = L * 0.06, engZ1 = L * 0.5;
    for (let e = 0; e < s.engines; e++) {
      const side = s.engines === 1 ? 0 : (e === 0 ? 1 : -1);
      const ex = side * s.engineSep * 0.5;
      const nac = [];
      const steps = detail >= 2 ? 7 : 4;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const z = lerp(engZ0, engZ1, t);
        const r = engR * lerp(1.0, 0.86, t);
        nac.push(superellipse(detail >= 2 ? 12 : 8, r, r * 0.94, z, -s.bodyH * 0.08, 2.6, 2.6, 0)
          .map((p) => [p[0] + ex, p[1], p[2]]));
      }
      bodyGeos.push(loft3(nac, { capStart: false, capEnd: false }));

      // Flared nozzle petals (bare metal).
      const noz = [];
      const nSteps = 4;
      for (let i = 0; i <= nSteps; i++) {
        const t = i / nSteps;
        const z = lerp(engZ1, engZ1 + engR * 1.15, t);
        const r = engR * lerp(0.86, 0.86 * s.nozzleFlare, Math.pow(t, 0.7));
        noz.push(superellipse(detail >= 2 ? 12 : 8, r, r * 0.94, z, -s.bodyH * 0.08, 2.6, 2.6, 0)
          .map((p) => [p[0] + ex, p[1], p[2]]));
      }
      darkGeos.push(loft3(noz, { capStart: false, capEnd: false }));

      // Emissive core disc just inside the nozzle.
      const core = new THREE.CircleGeometry(engR * 0.74, detail >= 2 ? 14 : 8);
      core.rotateY(Math.PI);
      core.translate(ex, -s.bodyH * 0.08, engZ1 + engR * 0.55);
      glowGeos.push(core);

      nozzlePositions.push(new THREE.Vector3(ex, -s.bodyH * 0.08, engZ1 + engR * 1.05));
    }

    /* ---- intakes ------------------------------------------------------- */
    if (detail >= 1) {
      const iz = -L * 0.06;
      if (s.intake === 'side' || s.intake === 'dorsal') {
        for (const side of [1, -1]) {
          const secs = [];
          for (let i = 0; i <= 3; i++) {
            const t = i / 3;
            const z = iz + t * L * 0.20;
            const w = s.bodyW * 0.34 * (1 - t * 0.25);
            const h = s.bodyH * 0.42 * (1 - t * 0.2);
            const y = s.intake === 'dorsal' ? s.bodyH * 0.62 : -s.bodyH * 0.05;
            const x = s.intake === 'dorsal' ? side * s.bodyW * 0.30 : side * (s.bodyW * 0.92);
            secs.push(superellipse(8, w, h, z, 0, 2.2, 2.2, 0).map((p) => [p[0] + x, p[1] + y, p[2]]));
          }
          darkGeos.push(loft3(secs, { capStart: false, capEnd: true }));
        }
      } else { // chin
        const secs = [];
        for (let i = 0; i <= 3; i++) {
          const t = i / 3;
          const z = iz + t * L * 0.22;
          secs.push(superellipse(10, s.bodyW * 0.74 * (1 - t * 0.15), s.bodyH * 0.30 * (1 - t * 0.2),
            z, -s.bodyH * 0.55, 3.2, 2.0, 0));
        }
        darkGeos.push(loft3(secs, { capStart: false, capEnd: true }));
      }
    }

    /* ---- canopy --------------------------------------------------------- */
    const canopySecs = [];
    const cSteps = detail >= 2 ? 9 : 5;
    const cz0 = -L * (s.noseLen * 0.55 + 0.02), cz1 = -L * 0.02;
    for (let i = 0; i < cSteps; i++) {
      const t = i / (cSteps - 1);
      const z = lerp(cz0, cz1, t);
      const prof = Math.sin(Math.pow(t, 0.75) * Math.PI * 0.92);
      const w = s.bodyW * 0.52 * (0.35 + prof * 0.8);
      const h = s.bodyH * 0.46 * (0.25 + prof * 0.9);
      const pts = [];
      const n = detail >= 2 ? 10 : 7;
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * Math.PI;
        pts.push([Math.cos(a) * w, s.bodyH * 0.42 + Math.sin(a) * h, z]);
      }
      // close the loop flat along the fuselage deck
      for (let k = n - 1; k > 0; k--) {
        const a = (k / n) * Math.PI;
        pts.push([Math.cos(a) * w * 0.98, s.bodyH * 0.40, z]);
      }
      canopySecs.push(pts);
    }
    const canopyGeo = loft3(canopySecs, { capStart: true, capEnd: true });

    /* ---- nav lights + trim glow ----------------------------------------- */
    const wingTipR = new THREE.Vector3(s.wingSpan / 2 * 0.97, s.wingDihedral * halfSpan - s.bodyH * 0.12, wingRootZ + s.wingSweep * halfSpan);
    const wingTipL = wingTipR.clone(); wingTipL.x *= -1;
    if (detail >= 1) {
      const lightGeoR = new THREE.SphereGeometry(0.16, 6, 4).translate(wingTipR.x, wingTipR.y, wingTipR.z);
      const lightGeoL = new THREE.SphereGeometry(0.16, 6, 4).translate(wingTipL.x, wingTipL.y, wingTipL.z);
      glowGeos.push(lightGeoR, lightGeoL);
      // Trim strips along the chine.
      for (const side of [1, -1]) {
        const strip = new THREE.BoxGeometry(0.07, 0.07, L * 0.44);
        strip.translate(side * s.bodyW * 1.02, -s.bodyH * 0.04, L * 0.02);
        glowGeos.push(strip);
      }
    }

    /* ---- assemble ------------------------------------------------------- */
    const bodyMat = this.mats.aircraftBody(spec);
    const darkMat = this.mats.aircraftDark();
    const glowMat = this.mats.aircraftEmissive(spec);
    const glassMat = this.mats.aircraftGlass(spec, this.quality.glassTransmission && detail >= 2);

    const bodyGeo = mergeAll(bodyGeos);
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.castShadow = true; bodyMesh.receiveShadow = true;
    group.add(bodyMesh);

    const darkGeo = mergeAll(darkGeos);
    if (darkGeo) {
      const m = new THREE.Mesh(darkGeo, darkMat);
      m.castShadow = detail >= 2;
      group.add(m);
    }
    const glowGeo = mergeAll(glowGeos);
    if (glowGeo) group.add(new THREE.Mesh(glowGeo, glowMat));

    const canopy = new THREE.Mesh(canopyGeo, glassMat);
    canopy.renderOrder = 2;
    group.add(canopy);

    /* ---- moving control surfaces ---------------------------------------- */
    const surfaces = { ailerons: [], elevons: [], rudders: [] };
    if (detail >= 1) {
      const mkFlap = (w, d, x, y, z, parentList) => {
        const pivot = new THREE.Object3D();
        pivot.position.set(x, y, z);
        const geo = new THREE.BoxGeometry(w, 0.09, d);
        geo.translate(0, 0, d * 0.5);
        const mesh = new THREE.Mesh(planarUV(geo, 2, 0), bodyMat);
        mesh.castShadow = detail >= 2;
        pivot.add(mesh);
        group.add(pivot);
        parentList.push(pivot);
        return pivot;
      };
      const teZ = wingRootZ + s.wingSweep * halfSpan * 0.7 + s.wingTip * 0.5;
      const aW = halfSpan * 0.34, aD = s.wingTip * 0.85;
      for (const side of [1, -1]) {
        mkFlap(aW, aD, side * (halfSpan * 0.68 + s.bodyW * 0.55),
          s.wingDihedral * halfSpan * 0.7 - s.bodyH * 0.12, teZ, surfaces.ailerons);
      }
      const eW = halfSpan * 0.30, eD = s.wingRoot * 0.24;
      for (const side of [1, -1]) {
        mkFlap(eW, eD, side * (halfSpan * 0.28 + s.bodyW * 0.55),
          -s.bodyH * 0.12, wingRootZ + s.wingRoot * 0.42, surfaces.elevons);
      }
      if (s.tail !== 'single') {
        for (const side of [1, -1]) {
          const pivot = new THREE.Object3D();
          pivot.position.set(side * s.engineSep * 0.72, s.bodyH * 0.24 + L * 0.10, tailZ + L * 0.16);
          pivot.rotation.z = -s.tailCant * side;
          const geo = new THREE.BoxGeometry(0.09, L * 0.11, L * 0.055);
          geo.translate(0, 0, L * 0.028);
          const mesh = new THREE.Mesh(planarUV(geo, 2, 1), bodyMat);
          pivot.add(mesh);
          group.add(pivot);
          surfaces.rudders.push(pivot);
        }
      }
    }

    let radius = 0;
    bodyGeo.computeBoundingSphere();
    radius = Math.max(bodyGeo.boundingSphere.radius, s.wingSpan * 0.5);

    return {
      group, surfaces, nozzlePositions,
      wingTips: [wingTipR, wingTipL],
      length: L, span: s.wingSpan, radius,
      canopy, bodyMesh,
      engineRadius: engR,
    };
  }

  /** Cached template so identical airframes share geometry across AI racers. */
  template(spec, detail) {
    const key = `${spec.id}_${detail}`;
    if (!this.cache.has(key)) this.cache.set(key, this.build(spec, detail));
    return this.cache.get(key);
  }

  /** Clone a cached template (shares geometry + materials, new transforms). */
  instance(spec, detail = 1) {
    const tpl = this.template(spec, detail);
    const group = tpl.group.clone(true);
    // Re-map the control-surface pivots onto the cloned hierarchy.
    const map = (list) => list.map((p) => {
      const idx = tpl.group.children.indexOf(p);
      return idx >= 0 ? group.children[idx] : null;
    }).filter(Boolean);
    return {
      group,
      surfaces: {
        ailerons: map(tpl.surfaces.ailerons),
        elevons: map(tpl.surfaces.elevons),
        rudders: map(tpl.surfaces.rudders),
      },
      nozzlePositions: tpl.nozzlePositions.map((v) => v.clone()),
      wingTips: tpl.wingTips.map((v) => v.clone()),
      length: tpl.length, span: tpl.span, radius: tpl.radius,
      engineRadius: tpl.engineRadius,
    };
  }

  dispose() {
    for (const t of this.cache.values()) {
      // External templates share geometry with the loaded GLB — disposing here
      // would blank every later build of the same airframe.
      if (t.external) continue;
      t.group.traverse((n) => { if (n.geometry) n.geometry.dispose(); });
    }
    this.cache.clear();
  }
}

/* ===========================================================================
 * VFX — trails, afterburners, particles, weather, explosions
 * ======================================================================== */

/** Camera-facing ribbon trail. All widening happens in the vertex shader. */
export class Trail {
  constructor(maxPoints, width, color, opts = {}) {
    this.max = maxPoints;
    this.width = width;
    this.points = new Float32Array(maxPoints * 3);
    this.count = 0;
    this.head = 0;
    this.minDist = opts.minDist ?? 1.6;
    this.fade = opts.fade ?? 1;
    this.last = new THREE.Vector3(Infinity, Infinity, Infinity);

    const verts = maxPoints * 2;
    this.aPos = new Float32Array(verts * 3);
    this.aTan = new Float32Array(verts * 3);
    this.aSide = new Float32Array(verts);
    this.aT = new Float32Array(verts);
    const idx = [];
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      idx.push(a, b, c, b, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.aPos, 3));
    geo.setAttribute('aTan', new THREE.BufferAttribute(this.aTan, 3));
    geo.setAttribute('aSide', new THREE.BufferAttribute(this.aSide, 1));
    geo.setAttribute('aT', new THREE.BufferAttribute(this.aT, 1));
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: opts.blending ?? THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uWidth: { value: width },
        uOpacity: { value: opts.opacity ?? 1 },
        uTaper: { value: opts.taper ?? 1 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aTan; attribute float aSide; attribute float aT;
        uniform float uWidth, uTaper;
        varying float vT;
        void main(){
          vT = aT;
          vec3 wp = position;
          vec3 toCam = normalize(cameraPosition - wp);
          vec3 right = normalize(cross(normalize(aTan), toCam));
          // Tight at the nozzle (aT = 1), spreading as it ages — the shape a
          // real exhaust plume or contrail actually makes.
          float w = uWidth * (0.35 + pow(1.0 - aT, 0.75) * uTaper);
          wp += right * aSide * w;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uOpacity;
        varying float vT;
        void main(){
          float a = pow(vT, 2.2) * uOpacity;
          gl_FragColor = vec4(uColor * (0.5 + a), a);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  reset() { this.count = 0; this.head = 0; this.last.set(Infinity, Infinity, Infinity); this.geometry.setDrawRange(0, 0); }

  push(p) {
    if (this.last.distanceToSquared(p) < this.minDist * this.minDist) {
      // Still update the newest point so the ribbon stays glued to the nozzle.
      if (this.count > 0) {
        const i = ((this.head - 1 + this.max) % this.max) * 3;
        this.points[i] = p.x; this.points[i + 1] = p.y; this.points[i + 2] = p.z;
      }
      return;
    }
    const i = this.head * 3;
    this.points[i] = p.x; this.points[i + 1] = p.y; this.points[i + 2] = p.z;
    this.head = (this.head + 1) % this.max;
    this.count = Math.min(this.count + 1, this.max);
    this.last.copy(p);
  }

  /** Rebuilds the ribbon vertex data from the ring buffer. */
  build() {
    const n = this.count;
    if (n < 2) { this.geometry.setDrawRange(0, 0); return; }
    const start = (this.head - n + this.max) % this.max;
    for (let k = 0; k < n; k++) {
      const src = ((start + k) % this.max) * 3;
      const px = this.points[src], py = this.points[src + 1], pz = this.points[src + 2];
      // tangent from neighbours
      const kp = Math.max(0, k - 1), kn = Math.min(n - 1, k + 1);
      const s0 = ((start + kp) % this.max) * 3, s1 = ((start + kn) % this.max) * 3;
      let tx = this.points[s1] - this.points[s0];
      let ty = this.points[s1 + 1] - this.points[s0 + 1];
      let tz = this.points[s1 + 2] - this.points[s0 + 2];
      const len = Math.hypot(tx, ty, tz) || 1;
      tx /= len; ty /= len; tz /= len;
      const t = k / (n - 1);
      for (let s = 0; s < 2; s++) {
        const v = (k * 2 + s);
        this.aPos[v * 3] = px; this.aPos[v * 3 + 1] = py; this.aPos[v * 3 + 2] = pz;
        this.aTan[v * 3] = tx; this.aTan[v * 3 + 1] = ty; this.aTan[v * 3 + 2] = tz;
        this.aSide[v] = s === 0 ? 1 : -1;
        this.aT[v] = t;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aTan.needsUpdate = true;
    this.geometry.attributes.aSide.needsUpdate = true;
    this.geometry.attributes.aT.needsUpdate = true;
    this.geometry.setDrawRange(0, (n - 1) * 6);
  }

  setOpacity(v) { this.material.uniforms.uOpacity.value = v; }
  setWidth(v) { this.material.uniforms.uWidth.value = v; }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

/** Afterburner plume: layered additive cones with shock diamonds. */
export class Afterburner {
  constructor(radius, color = 0xff8a3a) {
    this.group = new THREE.Group();
    this.uniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uBoost: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uCore: { value: new THREE.Color(0x86c8ff) },
    };
    const mkCone = (r, len, scaleU) => {
      const g = new THREE.ConeGeometry(r, len, 12, 3, true);
      g.rotateX(-Math.PI / 2);      // axis along +Z
      g.translate(0, 0, len * 0.5); // base at origin, apex trailing behind
      const m = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        // Back faces only: you see through the near wall to the far one, which
        // reads as a hollow glowing volume instead of a solid painted cone.
        side: THREE.BackSide,
        vertexShader: /* glsl */`
          varying vec2 vUv; varying vec3 vN; varying vec3 vV;
          uniform float uIntensity, uBoost;
          void main(){
            vUv = uv;
            vec3 p = position;
            p.z *= (0.35 + uIntensity * 0.85 + uBoost * 0.9);
            p.xy *= (0.72 + uIntensity * 0.34 + uBoost * 0.16);
            vec4 wp = modelMatrix * vec4(p, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vV = normalize(cameraPosition - wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */`
          uniform float uTime, uIntensity, uBoost; uniform vec3 uColor, uCore;
          varying vec2 vUv; varying vec3 vN; varying vec3 vV;
          float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
          void main(){
            float t = vUv.y;                       // 0 at nozzle, 1 at plume tip
            float edge = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.4);
            float flicker = 0.86 + 0.14 * hash(vec2(floor(uTime*45.0), floor(vUv.x*9.0)));
            float diamonds = 0.5 + 0.5 * sin(t * 28.0 - uTime * 26.0);
            diamonds = mix(1.0, pow(diamonds, 3.0) * 1.2 + 0.4, uBoost * 0.85);
            // Hot core only right at the nozzle, dropping to orange then soot.
            vec3 col = mix(uCore, uColor, pow(t, 0.35));
            col = mix(col, vec3(0.28,0.07,0.02), pow(t, 1.7) * 0.85);
            float a = pow(1.0 - t, 1.6) * (0.16 + edge * 0.55) * uIntensity * flicker * diamonds;
            gl_FragColor = vec4(col * (0.85 + uBoost * 0.9), clamp(a, 0.0, 0.9));
          }`,
      });
      return new THREE.Mesh(g, m);
    };
    this.outer = mkCone(radius * 0.88, radius * 7.0);
    this.inner = mkCone(radius * 0.44, radius * 3.6);
    this.group.add(this.outer, this.inner);
    this.group.renderOrder = 6;
  }
  update(dt, intensity, boost) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uIntensity.value = damp(this.uniforms.uIntensity.value, intensity, 12, dt);
    this.uniforms.uBoost.value = damp(this.uniforms.uBoost.value, boost, 8, dt);
    this.group.visible = this.uniforms.uIntensity.value > 0.02;
  }
  dispose() {
    this.group.traverse((n) => { n.geometry?.dispose(); n.material?.dispose(); });
  }
}

/** GPU-integrated burst particles (sparks, smoke, debris, dust). */
export class BurstParticles {
  constructor(capacity, texture, opts = {}) {
    this.capacity = capacity;
    this.cursor = 0;
    this.dirty = false;
    this.time = 0;

    const pos = new Float32Array(capacity * 3);
    const vel = new Float32Array(capacity * 3);
    const col = new Float32Array(capacity * 3);
    const spawn = new Float32Array(capacity).fill(-1e6);
    const life = new Float32Array(capacity).fill(1);
    const size = new Float32Array(capacity).fill(1);
    const drag = new Float32Array(capacity).fill(0.6);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSpawn', new THREE.BufferAttribute(spawn, 1));
    geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aDrag', new THREE.BufferAttribute(drag, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;
    this.attrs = { pos, vel, col, spawn, life, size, drag };

    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      blending: opts.blending ?? THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: texture },
        uGravity: { value: opts.gravity ?? 6 },
        uScale: { value: opts.scale ?? 620 },
        uFadeIn: { value: opts.fadeIn ?? 0.08 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aVel; attribute vec3 aColor;
        attribute float aSpawn, aLife, aSize, aDrag;
        uniform float uTime, uGravity, uScale;
        varying vec3 vColor; varying float vAlpha;
        void main(){
          float age = uTime - aSpawn;
          float t = age / aLife;
          if (age < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
          // integrated velocity with exponential drag + gravity
          float k = aDrag;
          float decay = (1.0 - exp(-k * age)) / max(k, 0.0001);
          vec3 p = position + aVel * decay + vec3(0.0, -uGravity, 0.0) * 0.5 * age * age;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.0, aSize * uScale * (1.0 - t * 0.55) / max(0.001, -mv.z));
          vColor = aColor;
          vAlpha = (1.0 - t) * smoothstep(0.0, 0.10, t);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying vec3 vColor; varying float vAlpha;
        void main(){
          if (vAlpha <= 0.001) discard;
          vec4 tx = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(vColor, tx.a * vAlpha);
        }`,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
  }

  emit(origin, count, {
    speed = 20, spread = 1, color = new THREE.Color(1, 0.7, 0.3), life = 1,
    size = 1, drag = 1.2, dir = null, sizeVar = 0.5, speedVar = 0.6, colorVar = 0,
  } = {}) {
    const a = this.attrs;
    for (let i = 0; i < count; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      a.pos[idx * 3] = origin.x; a.pos[idx * 3 + 1] = origin.y; a.pos[idx * 3 + 2] = origin.z;
      let vx, vy, vz;
      if (dir) {
        vx = dir.x + (Math.random() - 0.5) * spread;
        vy = dir.y + (Math.random() - 0.5) * spread;
        vz = dir.z + (Math.random() - 0.5) * spread;
      } else {
        const th = Math.random() * TAU, ph = Math.acos(Math.random() * 2 - 1);
        vx = Math.sin(ph) * Math.cos(th); vy = Math.cos(ph); vz = Math.sin(ph) * Math.sin(th);
      }
      const sp = speed * (1 - speedVar + Math.random() * speedVar * 2);
      const l = Math.hypot(vx, vy, vz) || 1;
      a.vel[idx * 3] = vx / l * sp; a.vel[idx * 3 + 1] = vy / l * sp; a.vel[idx * 3 + 2] = vz / l * sp;
      const cv = colorVar ? 1 + (Math.random() - 0.5) * colorVar : 1;
      a.col[idx * 3] = color.r * cv; a.col[idx * 3 + 1] = color.g * cv; a.col[idx * 3 + 2] = color.b * cv;
      a.spawn[idx] = this.time;
      a.life[idx] = life * (0.7 + Math.random() * 0.6);
      a.size[idx] = size * (1 - sizeVar + Math.random() * sizeVar * 2);
      a.drag[idx] = drag;
    }
    this.dirty = true;
  }

  update(dt) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    if (this.dirty) {
      for (const k of ['position', 'aVel', 'aColor', 'aSpawn', 'aLife', 'aSize', 'aDrag']) {
        this.geometry.attributes[k].needsUpdate = true;
      }
      this.dirty = false;
    }
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

/**
 * Camera-anchored streak field — rain, snow, dust and speed particles.
 * Fully GPU driven: positions wrap around the camera in the vertex shader so
 * there is zero per-frame CPU cost regardless of particle count.
 */
export class StreakField {
  constructor(count, texture, opts = {}) {
    this.count = count;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    const off = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      off[i * 3] = Math.random(); off[i * 3 + 1] = Math.random(); off[i * 3 + 2] = Math.random();
      seed[i] = Math.random();
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;
    // `base`'s attributes are now owned by `geo` — disposing it would pull the
    // buffers out from under the instanced geometry.

    this.uniforms = {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(opts.box ?? 260, opts.boxY ?? 200, opts.box ?? 260) },
      uVel: { value: new THREE.Vector3(0, -(opts.fallSpeed ?? 60), 0) },
      uSize: { value: new THREE.Vector2(opts.width ?? 0.16, opts.length ?? 5.5) },
      uColor: { value: new THREE.Color(opts.color ?? 0xbfd8ee) },
      uOpacity: { value: opts.opacity ?? 0.55 },
      uMap: { value: texture },
      uStretch: { value: opts.stretch ?? 1 },
      uSway: { value: opts.sway ?? 0 },
      uFadeNear: { value: opts.fadeNear ?? 4 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false,
      blending: opts.blending ?? THREE.NormalBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        attribute vec3 aOffset; attribute float aSeed;
        uniform float uTime, uStretch, uSway, uFadeNear;
        uniform vec3 uCam, uBox, uVel; uniform vec2 uSize;
        varying vec2 vUv; varying float vFade;
        void main(){
          vUv = uv;
          vec3 world = aOffset * uBox + uVel * uTime;
          world.x += sin(uTime * (0.6 + aSeed) + aSeed * 24.0) * uSway;
          // wrap the field around the camera so it is always populated
          vec3 rel = world - uCam + uBox * 0.5;
          rel = mod(mod(rel, uBox) + uBox, uBox) - uBox * 0.5;
          vec3 center = uCam + rel;

          vec3 vdir = normalize(uVel + vec3(0.0001));
          vec3 toCam = normalize(cameraPosition - center);
          vec3 right = normalize(cross(vdir, toCam));
          float len = uSize.y * uStretch;
          vec3 p = center + right * position.x * uSize.x + vdir * position.y * len;

          float d = length(center - cameraPosition);
          vFade = smoothstep(uFadeNear, uFadeNear * 3.0, d) * (1.0 - smoothstep(uBox.x * 0.35, uBox.x * 0.52, d));
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform vec3 uColor; uniform float uOpacity;
        varying vec2 vUv; varying float vFade;
        void main(){
          vec4 t = texture2D(uMap, vUv);
          float a = t.a * uOpacity * vFade;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
  }

  setCount(n) {
    this.geometry.instanceCount = clamp(Math.floor(n), 0, this.count);
    this.mesh.visible = this.geometry.instanceCount > 0;
  }
  update(dt, camPos, windVec) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uCam.value.copy(camPos);
    if (windVec) {
      this.uniforms.uVel.value.x = windVec.x;
      this.uniforms.uVel.value.z = windVec.z;
    }
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

/** Expanding shell + ring + sparks. Pooled by VFX. */
class Explosion {
  constructor(mats) {
    this.group = new THREE.Group();
    this.life = 0; this.maxLife = 1;
    this.uniforms = {
      uT: { value: 0 },
      uColor: { value: new THREE.Color(0xffa040) },
    };
    const shellMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `varying vec3 vN; varying vec3 vV; uniform float uT;
        void main(){ vec3 p = position * (0.35 + uT * 1.5);
          vec4 wp = modelMatrix * vec4(p,1.0);
          vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vV; uniform float uT; uniform vec3 uColor;
        void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.8);
          float a = f * (1.0 - uT) * 1.4;
          vec3 c = mix(vec3(1.0,0.95,0.8), uColor, uT);
          gl_FragColor = vec4(c * (1.0 + (1.0-uT)*2.0), clamp(a,0.0,1.0)); }`,
    });
    this.shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), shellMat);

    const ringMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vUv; uniform float uT;
        void main(){ vUv = uv; vec3 p = position * (0.4 + uT * 5.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform float uT; uniform vec3 uColor;
        void main(){ float r = abs(vUv.x - 0.5) * 2.0;
          float band = smoothstep(1.0, 0.55, r) * smoothstep(0.0, 0.35, r);
          float a = band * (1.0 - uT) * 0.9;
          gl_FragColor = vec4(mix(vec3(1.0), uColor, uT) * 2.0, clamp(a,0.0,1.0)); }`,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.0, 40), ringMat);
    this.group.add(this.shell, this.ring);
    this.group.visible = false;
    this.group.renderOrder = 9;
  }
  fire(pos, scale, color, normal) {
    this.group.position.copy(pos);
    this.group.scale.setScalar(scale);
    this.uniforms.uColor.value.set(color);
    this.uniforms.uT.value = 0;
    this.life = 0; this.maxLife = 0.85 + scale * 0.02;
    if (normal) this.ring.lookAt(normal.clone().add(pos));
    else this.ring.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    this.group.visible = true;
  }
  update(dt) {
    if (!this.group.visible) return false;
    this.life += dt;
    const t = this.life / this.maxLife;
    this.uniforms.uT.value = clamp01(t);
    if (t >= 1) { this.group.visible = false; return false; }
    return true;
  }
  dispose() { this.group.traverse((n) => { n.geometry?.dispose(); n.material?.dispose(); }); }
}

export class VFX {
  constructor(scene, textures, materials, quality) {
    this.scene = scene;
    this.tex = textures;
    this.mats = materials;
    this.quality = quality;
    this.time = 0;

    const glow = textures.glow(128, 0.22);
    const streak = textures.streak();

    this.sparks = new BurstParticles(Math.max(400, quality.particleBudget), glow,
      { gravity: 14, scale: 380, blending: THREE.AdditiveBlending });
    this.smoke = new BurstParticles(Math.max(200, Math.floor(quality.particleBudget * 0.5)), textures.cloudPuff(128, 3),
      { gravity: -1.5, scale: 900, blending: THREE.NormalBlending });
    scene.add(this.sparks.points, this.smoke.points);

    this.rain = new StreakField(Math.max(64, quality.weatherParticles), streak,
      { box: 220, boxY: 190, fallSpeed: 105, width: 0.10, length: 7.0, color: 0xbfd8ee, opacity: 0.42, fadeNear: 3 });
    this.snow = new StreakField(Math.max(64, Math.floor(quality.weatherParticles * 0.8)), glow,
      { box: 190, boxY: 170, fallSpeed: 11, width: 0.5, length: 0.5, color: 0xffffff, opacity: 0.85, sway: 3.5, fadeNear: 2 });
    this.dust = new StreakField(Math.max(64, Math.floor(quality.weatherParticles * 0.7)), glow,
      { box: 320, boxY: 220, fallSpeed: 5, width: 5.5, length: 5.5, color: 0xd9a463, opacity: 0.16, sway: 8, fadeNear: 6 });
    this.speedField = new StreakField(Math.max(64, Math.floor(quality.particleBudget * 0.6)), streak,
      { box: 300, boxY: 220, fallSpeed: 0.01, width: 0.13, length: 26, color: 0xdfefff, opacity: 0.0, fadeNear: 8, blending: THREE.AdditiveBlending });
    scene.add(this.rain.mesh, this.snow.mesh, this.dust.mesh, this.speedField.mesh);

    this.explosions = [];
    this.explosionPool = [];
    for (let i = 0; i < 8; i++) {
      const e = new Explosion(materials);
      scene.add(e.group);
      this.explosionPool.push(e);
    }

    this.trails = [];
    this.weatherId = 'clear';
    this.windVec = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._col = new THREE.Color();
  }

  createTrail(color, width, maxPoints, opts) {
    const t = new Trail(maxPoints ?? this.quality.trailSegments, width, color,
      { taper: 1.6, ...opts });
    this.scene.add(t.mesh);
    this.trails.push(t);
    return t;
  }
  removeTrail(t) {
    const i = this.trails.indexOf(t);
    if (i >= 0) this.trails.splice(i, 1);
    this.scene.remove(t.mesh);
    t.dispose();
  }

  setWeather(weatherId, severity = 1) {
    this.weatherId = weatherId;
    const w = WEATHER[weatherId] || WEATHER.clear;
    const budget = this.quality.weatherParticles * severity;
    const rate = w.precipRate;
    this.rain.setCount(w.precip === 'rain' ? budget * rate : 0);
    this.snow.setCount(w.precip === 'snow' ? budget * 0.85 * rate : 0);
    this.dust.setCount(w.precip === 'dust' ? budget * 0.6 * rate : 0);
    this.rain.uniforms.uOpacity.value = 0.30 + rate * 0.30;
    this.snow.uniforms.uOpacity.value = 0.55 + rate * 0.35;
    this.dust.uniforms.uOpacity.value = 0.10 + rate * 0.14;
  }

  explode(pos, scale = 12, color = 0xffa040, normal = null) {
    const e = this.explosionPool.find((x) => !x.group.visible);
    if (e) e.fire(pos, scale, color, normal);
    this._col.set(color);
    this.sparks.emit(pos, Math.min(90, Math.round(scale * 3)), {
      speed: scale * 3.2, life: 0.8, size: 1.4, drag: 1.4, color: this._col, colorVar: 0.35, spread: 2,
    });
    this.smoke.emit(pos, Math.min(26, Math.round(scale)), {
      speed: scale * 0.9, life: 2.6, size: scale * 0.55, drag: 2.2,
      color: this._col.clone().multiplyScalar(0.25), spread: 2, sizeVar: 0.7,
    });
  }

  sparkBurst(pos, dir, amount = 18, color = 0xffcc66) {
    this._col.set(color);
    this.sparks.emit(pos, amount, {
      speed: 34, life: 0.5, size: 0.7, drag: 3.5, color: this._col, dir, spread: 1.4, colorVar: 0.3,
    });
  }

  smokePuff(pos, amount = 4, size = 3, color = 0x777777) {
    this._col.set(color);
    this.smoke.emit(pos, amount, { speed: 5, life: 2.2, size, drag: 2.5, color: this._col, spread: 1.6 });
  }

  setSpeedStreaks(intensity, velocity) {
    const u = this.speedField.uniforms;
    u.uOpacity.value = damp(u.uOpacity.value, clamp01(intensity) * 0.20, 6, 0.016);
    const n = Math.floor(this.speedField.count * clamp01(intensity));
    this.speedField.setCount(intensity > 0.02 ? n : 0);
    if (velocity && velocity.lengthSq() > 1) {
      u.uVel.value.copy(velocity).multiplyScalar(-0.22);
      u.uSize.value.y = 10 + Math.min(90, velocity.length() * 0.14);
    }
  }

  update(dt, camera, windVec) {
    this.time += dt;
    this.sparks.update(dt);
    this.smoke.update(dt);
    const cp = camera.position;
    this.rain.update(dt, cp, windVec);
    this.snow.update(dt, cp, windVec);
    this.dust.update(dt, cp, windVec);
    this.speedField.update(dt, cp, null);
    for (const t of this.trails) t.build();
    for (const e of this.explosionPool) e.update(dt);
  }

  dispose() {
    this.sparks.dispose(); this.smoke.dispose();
    this.rain.dispose(); this.snow.dispose(); this.dust.dispose(); this.speedField.dispose();
    for (const e of this.explosionPool) e.dispose();
    for (const t of this.trails) t.dispose();
    this.trails.length = 0;
  }
}

/* ===========================================================================
 * RENDER SYSTEM — top-level façade
 * ======================================================================== */

export class RenderSystem {
  constructor(canvas, quality, device) {
    this.canvas = canvas;
    this.quality = quality;
    this.device = device;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !device.isMobile && quality.preset.pixelRatio >= 1,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
      depth: true,
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.setClearColor(0x0a0e14, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(66, 16 / 9, 1.6, 42000);
    this.scene.add(this.camera);

    this.textures = new TextureFactory();
    this.materials = new MaterialLibrary(this.textures);
    this.sky = new SkySystem(this.scene);
    this.lighting = new LightingSystem(this.scene);
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, quality.preset);
    this.rig = new CameraRig(this.camera);
    // A camera cut is not motion — clear the blur's frame history with it.
    this.rig.onReset = () => this.postfx.resetMotion();
    this.aircraftFactory = new AircraftFactory(this.materials, quality.preset);
    this.vfx = new VFX(this.scene, this.textures, this.materials, quality.preset);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    this.envTarget = null;
    this.envTimer = 0;

    this.scene.fog = new THREE.FogExp2(0xbcd4e8, 0.00012);
    this.viewRange = 20000;
    this.grade = {
      sat: 1.06, contrast: 1.06,
      lift: new THREE.Vector3(0, 0, 0),
      gain: new THREE.Vector3(1, 1, 1),
    };
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector2();
    this.resize();
  }

  /* ---- sizing --------------------------------------------------------- */
  resize() {
    const w = Math.max(2, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(2, this.canvas.clientHeight || window.innerHeight);
    const pr = this.quality.effectivePixelRatio;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(Math.round(w * pr), Math.round(h * pr), false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.postfx.setSize(Math.round(w * pr), Math.round(h * pr));
    this.displaySize = { w, h };
  }

  /* ---- quality -------------------------------------------------------- */
  applyQuality() {
    const p = this.quality.preset;
    this.renderer.shadowMap.enabled = !!p.shadows;
    this.lighting.setShadowQuality(p);
    this.postfx.applyPreset(p);
    this.resize();
  }

  /* ---- environment ---------------------------------------------------- */
  setVenue(biome, weatherId, timeId) {
    this.biome = biome;
    this.weatherId = weatherId;
    this.timeId = timeId;
    this.sky.configure(biome, weatherId, timeId);
    this.lighting.configure(this.sky, this.quality.preset);
    const w = WEATHER[weatherId] || WEATHER.clear;

    this.viewRange = 26000 * this.quality.viewDistance * lerp(0.35, 1.15, w.vis) * (biome.ceiling ? 0.35 : 1);
    this.scene.fog.color.copy(this.sky.fogColor);
    // Aerial perspective should read as depth, not as a white sheet over the
    // mid-distance — keep terrain colour alive well past the near field.
    this.scene.fog.density = 2.35 / this.viewRange;
    this.camera.far = clamp(this.viewRange * 1.5, 6000, WORLD.farPlane);
    this.camera.updateProjectionMatrix();
    this.renderer.setClearColor(this.sky.fogColor, 1);

    // Per-venue colour grade.
    const acc = new THREE.Color(biome.accent);
    this.grade.sat = w.sat * 1.16;
    this.grade.contrast = lerp(1.08, 1.18, 1 - w.vis);
    this.grade.lift.set(acc.r * 0.012, acc.g * 0.012, acc.b * 0.016);
    this.grade.gain.set(
      lerp(1, 1.03, acc.r), lerp(1, 1.01, acc.g), lerp(1, 1.05, acc.b),
    );
    // Bright, high-visibility conditions need to be pulled down or snowfields
    // and clear skies clip to white under ACES.
    this.renderer.toneMappingExposure = w.exposure * lerp(1.0, 0.86, clamp01(w.vis))
      * (biome.ceiling ? 1.55 : 1);

    this.vfx.setWeather(weatherId, 1);
    this.updateEnvMap(true);
  }

  updateEnvMap(force = false) {
    if (!this.quality.preset.reflections && !force) return;
    const size = this.quality.preset.envMapSize;
    try {
      const prev = this.envTarget;
      this.envTarget = this.pmrem.fromScene(this.sky.envScene, 0.02, 1, 200);
      this.scene.environment = this.envTarget.texture;
      this.materials.setEnvMap(this.envTarget.texture);
      if (prev) prev.dispose();
    } catch (err) {
      console.warn('[Render] env map generation failed:', err);
    }
  }

  /* ---- per-frame ------------------------------------------------------ */
  update(dt, state) {
    this.sky.update(dt, this.camera);
    this.materials.update(this.sky.uniforms.uTime.value);
    this.lighting.update(dt, state.focus || this.camera.position, this.sky.sunDirection,
      this.quality.scalars.shadowInterval);
    this.postfx.update(dt, {
      ...state,
      grade: this.grade,
      postIntensity: this.quality.postIntensity,
    });
    this.vfx.update(dt, this.camera, state.wind);

    if (this.quality.preset.reflections) {
      this.envTimer += dt;
      if (this.envTimer >= this.quality.envUpdateInterval) { this.envTimer = 0; this.updateEnvMap(); }
    }
  }

  render(dt) { this.postfx.render(dt); }

  /** Project a world point to normalised screen coords, with a behind flag. */
  projectToScreen(worldPos, out = { x: 0, y: 0, visible: false, behind: false, dist: 0 }) {
    this._v.copy(worldPos);
    const dist = this._v.distanceTo(this.camera.position);
    this._v.project(this.camera);
    out.behind = this._v.z > 1;
    out.dist = dist;
    out.x = (this._v.x * 0.5 + 0.5);
    out.y = (-this._v.y * 0.5 + 0.5);
    out.visible = !out.behind && out.x > -0.2 && out.x < 1.2 && out.y > -0.2 && out.y < 1.2;
    return out;
  }

  dispose() {
    this.vfx.dispose();
    this.aircraftFactory.dispose();
    this.postfx.dispose();
    this.sky.dispose();
    this.materials.dispose();
    this.pmrem.dispose();
    this.envTarget?.dispose();
    this.renderer.dispose();
  }
}
