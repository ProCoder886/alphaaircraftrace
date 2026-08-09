/**
 * ALPHA AIRCRAFT RACE 3D — world.js
 * ---------------------------------------------------------------------------
 * The procedural aerial world.
 *
 *   TerrainField — analytic heightfield (a pure function of x,z + seed) so the
 *                  route generator, the mesh builder and the AI all agree on
 *                  where the ground is without sharing state.
 *   RacePath     — the seeded spline route, grown segment by segment from the
 *                  modular segment table, guaranteed flyable.
 *   TerrainMesh  — geo-clipmap tiles around the player (4 LOD rings).
 *   WorldChunk   — one streamed slice of route content: checkpoints, rings,
 *                  obstacles, clouds, landmarks, colliders.
 *   World        — orchestration, streaming, weather, events, queries.
 */

import * as THREE from 'three';
import { mergeGeometriesSafe } from './renderer.js';
import {
  WORLD, SEGMENTS, SEGMENTS_BY_ID, WEATHER, BIOMES_BY_ID, RNG, clamp, clamp01, lerp,
  smoothstep, fbm2, ridged2, hash2, TAU, damp,
} from './config.js';
import { disposeObject } from './performance.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _c1 = new THREE.Color();

/* ===========================================================================
 * TERRAIN FIELD
 * ======================================================================== */

export class TerrainField {
  constructor(seed, biome) {
    this.seed = seed >>> 0;
    this.biome = biome;
    const r = biome.relief;
    this.scale = r.scale;
    this.maxHeight = r.height;
    this.ridgeAmt = r.ridge;
    this.roughness = r.roughness;
    this.plateau = r.plateau;
    this.waterLevel = r.water * r.height * 0.55;
    this.snowLine = biome.ground.snowLine;
    this.colors = {
      base: new THREE.Color(biome.ground.base),
      high: new THREE.Color(biome.ground.high),
      low: new THREE.Color(biome.ground.low),
      rock: new THREE.Color(biome.ground.rock),
      water: new THREE.Color(biome.ground.water),
    };
  }

  /**
   * Analytic terrain elevation in metres. Deterministic and side-effect free.
   * `lod` drops octaves for distant work — detail below a few metres is
   * invisible from 20 km away but costs the same to evaluate.
   */
  height(x, z, lod = 0) {
    const s = this.scale;
    const sx = x * s, sz = z * s;
    const oBase = lod >= 3 ? 3 : lod >= 2 ? 4 : 6;
    const oRidge = lod >= 3 ? 2 : lod >= 2 ? 3 : 5;
    const base = fbm2(sx, sz, this.seed, oBase, 2.03, 0.5);
    const ridge = this.ridgeAmt > 0.02 ? ridged2(sx * 0.72, sz * 0.72, this.seed + 7717, oRidge, 2.07, 0.52) : 0;
    let h = lerp(base, ridge, this.ridgeAmt);
    h = h * 0.5 + 0.5;                              // 0..1
    // Plateau/mesa shaping: push mid values toward flats and cliffs.
    const p = this.plateau;
    if (p > 0.01) h = lerp(h, smoothstep(clamp01((h - 0.22) / 0.34)) * 0.82 + h * 0.18, p);
    // Continental mask so the venue has genuine large-scale variety.
    const mask = fbm2(sx * 0.18, sz * 0.18, this.seed + 4241, lod >= 2 ? 2 : 3) * 0.5 + 0.5;
    h *= lerp(0.45, 1.25, mask);
    let out = Math.pow(clamp01(h), 1.35) * this.maxHeight;
    if (lod < 2) out += fbm2(sx * 5.3, sz * 5.3, this.seed + 313, 3) * this.maxHeight * 0.045 * this.roughness;
    if (lod < 1) out += fbm2(sx * 17.0, sz * 17.0, this.seed + 919, 2) * this.maxHeight * 0.012 * this.roughness;
    return out;
  }

  /** Height clamped at the water surface — what an aircraft actually hits. */
  surface(x, z, lod = 0) {
    const h = this.height(x, z, lod);
    return h < this.waterLevel ? this.waterLevel : h;
  }

  slope(x, z, d = 40, lod = 2) {
    const hl = this.height(x - d, z, lod), hr = this.height(x + d, z, lod);
    const hd = this.height(x, z - d, lod), hu = this.height(x, z + d, lod);
    return Math.min(1, Math.hypot(hr - hl, hu - hd) / (d * 2.2));
  }

  /** Vertex colour: altitude ramp + slope rock + snow line + shoreline. */
  colorAt(h, slope, out = _c1) {
    const c = this.colors;
    const t = clamp01(h / (this.maxHeight * 0.95));
    out.copy(c.low).lerp(c.base, smoothstep(clamp01(t / 0.42)));
    out.lerp(c.high, smoothstep(clamp01((t - 0.42) / 0.5)));
    out.lerp(c.rock, clamp01((slope - 0.32) * 1.9));
    if (h > this.snowLine) {
      const snow = clamp01((h - this.snowLine) / Math.max(160, this.maxHeight * 0.20));
      out.r = lerp(out.r, 0.95, snow * (1 - slope * 0.55));
      out.g = lerp(out.g, 0.97, snow * (1 - slope * 0.55));
      out.b = lerp(out.b, 1.00, snow * (1 - slope * 0.55));
    }
    if (h < this.waterLevel + 26) {
      out.lerp(c.water, clamp01((this.waterLevel + 26 - h) / 60) * 0.75);
    }
    return out;
  }
}

/* ===========================================================================
 * RACE PATH
 * ------------------------------------------------------------------------
 * Grown lazily: `ensure(distance)` extends the node list by whole segments.
 * Every node carries its own corridor radius, roll and risk so downstream
 * systems (content placement, AI, HUD) never need to re-derive them.
 * ======================================================================== */

export class RacePath {
  constructor(seed, terrain, difficulty, opts = {}) {
    this.seed = seed;
    this.rng = new RNG(seed);
    this.terrain = terrain;
    this.difficulty = difficulty;
    this.biome = terrain.biome;
    this.nodes = [];
    this.segments = [];
    this.spacing = WORLD.pathNodeSpacing;
    this.complexity = difficulty.routeComplexity;
    this.lastTypeId = null;
    this.repeatGuard = [];
    this.loop = opts.loop || false;

    // Generator cursor.
    this.cursor = {
      pos: new THREE.Vector3(0, 0, 0),
      heading: this.rng.float(0, TAU),
      pitch: 0,
      roll: 0,
      radius: WORLD.corridorRadius,
      agl: 700,
    };
    const startH = terrain.surface(0, 0);
    this.cursor.pos.set(0, startH + 700, 0);
    this._pushNode(this.cursor, SEGMENTS_BY_ID.straight, 0);
    this.extendSegments(4);
  }

  _pushNode(cur, seg, risk) {
    const prev = this.nodes[this.nodes.length - 1];
    const tangent = new THREE.Vector3(
      Math.cos(cur.pitch) * Math.sin(cur.heading),
      Math.sin(cur.pitch),
      Math.cos(cur.pitch) * Math.cos(cur.heading),
    ).normalize();
    // Up/right derived from the tangent and the accumulated roll.
    // right = tangent × worldUp (horizontal component), so that
    // up = right × tangent comes out pointing *up*. Getting this sign wrong
    // inverts the whole route frame and spawns everything upside down.
    const right = _v1.set(-tangent.z, 0, tangent.x).normalize();
    if (!isFinite(right.x) || right.lengthSq() < 1e-6) right.set(1, 0, 0);
    const up = _v2.crossVectors(right, tangent).normalize();
    if (up.y < 0) up.negate();      // belt and braces near-vertical tangents
    const cr = Math.cos(cur.roll), sr = Math.sin(cur.roll);
    const rRight = new THREE.Vector3().copy(right).multiplyScalar(cr).addScaledVector(up, sr).normalize();
    const rUp = new THREE.Vector3().copy(up).multiplyScalar(cr).addScaledVector(right, -sr).normalize();

    const node = {
      pos: cur.pos.clone(),
      tangent,
      right: rRight,
      up: rUp,
      radius: cur.radius,
      roll: cur.roll,
      dist: prev ? prev.dist + prev.pos.distanceTo(cur.pos) : 0,
      seg,
      risk,
      index: this.nodes.length,
      terrainY: this.terrain.surface(cur.pos.x, cur.pos.z),
    };
    this.nodes.push(node);
    return node;
  }

  /** Choose the next segment type, weighted by difficulty, biome and variety. */
  _pickSegment() {
    const c = this.complexity;
    const biome = this.biome;
    const pool = SEGMENTS.filter((s) => {
      if (s.risk > 0.6 + c * 0.9) return false;                  // too spicy for this difficulty
      if (s.urban && (biome.props.buildings < 0.4)) return false; // no city corridors over forest
      if (s.islands && biome.ceiling) return false;
      if (s.tunnel && c < 0.35) return false;
      if (s.shortcut && c < 0.5) return false;
      return true;
    });
    const recent = this.repeatGuard;
    const seg = this.rng.weighted(pool, (s) => {
      let w = s.w;
      if (recent.includes(s.id)) w *= 0.12;                       // strong anti-repetition
      if (s.id === this.lastTypeId) w *= 0.05;
      w *= lerp(1.4, 0.55, c) ** (s.risk);                        // risk gated by difficulty
      w *= lerp(0.5, 1.5, clamp01(s.risk * 0.8 + 0.2)) ** (c * 1.4);
      if (s.urban) w *= 0.6 + biome.props.buildings;
      if (s.storm && (biome.id === 'storm' || biome.id === 'fortress')) w *= 2.4;
      if (s.cloudDense && biome.props.trees > 0.6) w *= 1.3;
      if (s.lowAlt && biome.relief.height < 500) w *= 1.5;
      return Math.max(0.02, w);
    });
    this.lastTypeId = seg.id;
    recent.push(seg.id);
    if (recent.length > 4) recent.shift();
    return seg;
  }

  /** Target height above ground for a given segment. */
  _targetAGL(seg, rng) {
    if (seg.forceLow || seg.lowAlt) return rng.float(110, 300);
    if (seg.forceHigh) return rng.float(2100, 3600);
    if (seg.tunnel) return rng.float(240, 520);
    if (seg.id === 'climb') return rng.float(1200, 2400);
    if (seg.id === 'dive') return rng.float(220, 620);
    return rng.float(420, 1250);
  }

  extendSegments(count = 1) {
    for (let n = 0; n < count; n++) this._buildSegment();
  }

  _buildSegment() {
    const seg = this._pickSegment();
    const rng = this.rng;
    const cur = this.cursor;
    const nodes = Math.max(4, Math.round(seg.nodes * lerp(1.25, 0.85, this.complexity)));

    const turnMag = lerp(seg.turn[0], seg.turn[1], rng.next()) * rng.sign() * lerp(0.7, 1.15, this.complexity);
    const pitchTarget = lerp(seg.pitch[0], seg.pitch[1], rng.next());
    const radiusTarget = WORLD.corridorRadius * lerp(seg.radius[0], seg.radius[1], rng.next())
      * lerp(1.15, 0.82, this.complexity);
    const rollTarget = (seg.roll || 0) * rng.sign() * lerp(0.6, 1.2, rng.next());
    const aglTarget = this._targetAGL(seg, rng);
    const startIndex = this.nodes.length;

    for (let i = 0; i < nodes; i++) {
      const f = i / (nodes - 1);
      const ease = Math.sin(f * Math.PI);          // ramp the turn in and out

      cur.heading += (turnMag / nodes) * ease * 2.2;
      cur.pitch = damp(cur.pitch, pitchTarget * ease, 3.2, 1 / nodes * 4);
      cur.pitch = clamp(cur.pitch, -0.52, 0.52);
      cur.roll = damp(cur.roll, rollTarget * ease * TAU * 0.25, 2.4, 1 / nodes * 4);
      cur.radius = damp(cur.radius, radiusTarget, 2.6, 1 / nodes * 4);
      cur.radius = clamp(cur.radius, WORLD.corridorRadiusMin, WORLD.corridorRadiusMax);

      // Step forward along the current heading/pitch.
      const step = this.spacing;
      cur.pos.x += Math.cos(cur.pitch) * Math.sin(cur.heading) * step;
      cur.pos.z += Math.cos(cur.pitch) * Math.cos(cur.heading) * step;
      cur.pos.y += Math.sin(cur.pitch) * step;

      // --- flyability guarantee -----------------------------------------
      // Blend toward the target AGL and hard-clamp so the route can never be
      // generated inside terrain or above the service ceiling.
      const ground = this.terrain.surface(cur.pos.x, cur.pos.z);
      const desiredY = ground + aglTarget;
      cur.pos.y = lerp(cur.pos.y, desiredY, 0.28);
      const minY = ground + Math.max(WORLD.minAltitude * 2.2, cur.radius * 0.72);
      if (cur.pos.y < minY) { cur.pos.y = minY; cur.pitch = Math.max(cur.pitch, 0.02); }
      if (cur.pos.y > WORLD.softCeiling) { cur.pos.y = WORLD.softCeiling; cur.pitch = Math.min(cur.pitch, -0.01); }
      // Also check a short distance ahead so climbing terrain is anticipated.
      const aheadX = cur.pos.x + Math.sin(cur.heading) * step * 3;
      const aheadZ = cur.pos.z + Math.cos(cur.heading) * step * 3;
      const aheadGround = this.terrain.surface(aheadX, aheadZ);
      if (cur.pos.y < aheadGround + cur.radius * 0.8) {
        cur.pos.y = aheadGround + cur.radius * 0.8;
        cur.pitch = Math.max(cur.pitch, 0.06);
      }

      this._pushNode(cur, seg, seg.risk);
    }

    this.segments.push({
      seg, startIndex, endIndex: this.nodes.length - 1,
      startDist: this.nodes[startIndex].dist,
      endDist: this.nodes[this.nodes.length - 1].dist,
      shortcut: !!seg.shortcut, split: !!seg.split, risk: seg.risk,
      rngSeed: rng.int(0, 1e9),
    });
  }

  get length() { return this.nodes.length ? this.nodes[this.nodes.length - 1].dist : 0; }

  /** Grow the path so at least `distance` metres exist. */
  ensure(distance) {
    let guard = 0;
    while (this.length < distance && guard++ < 400) this._buildSegment();
  }

  nodeAtDistance(d) {
    const nodes = this.nodes;
    if (!nodes.length) return 0;
    // Nodes are roughly uniformly spaced — start from an estimate, then walk.
    let i = clamp(Math.floor(d / this.spacing), 0, nodes.length - 1);
    if (!Number.isFinite(i)) i = 0;
    while (i > 0 && nodes[i].dist > d) i--;
    while (i < nodes.length - 2 && nodes[i + 1].dist <= d) i++;
    return i;
  }

  /**
   * Interpolated frame at a distance along the route.
   * A non-finite distance is clamped to the start rather than allowed to index
   * the node array with NaN — one bad number upstream must never be able to
   * take down the whole frame loop.
   */
  sample(d, out = {}) {
    if (!Number.isFinite(d)) d = 0;
    else if (d < 0) d = 0;
    this.ensure(d + this.spacing * 2);
    const i = clamp(this.nodeAtDistance(d), 0, this.nodes.length - 1);
    const a = this.nodes[i];
    const b = this.nodes[Math.min(i + 1, this.nodes.length - 1)];
    const span = Math.max(1e-3, b.dist - a.dist);
    const t = clamp01((d - a.dist) / span);
    out.pos = (out.pos || new THREE.Vector3()).lerpVectors(a.pos, b.pos, t);
    out.tangent = (out.tangent || new THREE.Vector3()).lerpVectors(a.tangent, b.tangent, t).normalize();
    out.right = (out.right || new THREE.Vector3()).lerpVectors(a.right, b.right, t).normalize();
    out.up = (out.up || new THREE.Vector3()).lerpVectors(a.up, b.up, t).normalize();
    out.radius = lerp(a.radius, b.radius, t);
    out.risk = lerp(a.risk, b.risk, t);
    out.node = a;
    out.index = i;
    return out;
  }

  /**
   * Project a world position onto the route.
   * `hint` is the last known node index — searching outward from it keeps this
   * O(1) for objects that move continuously along the path.
   */
  project(pos, hint = 0, window = 26) {
    const nodes = this.nodes;
    const lo = clamp(hint - window, 0, nodes.length - 1);
    const hi = clamp(hint + window, 0, nodes.length - 1);
    let best = lo, bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const d = nodes[i].pos.distanceToSquared(pos);
      if (d < bestD) { bestD = d; best = i; }
    }
    const n = nodes[best];
    // Refine using the segment toward the better neighbour.
    const prev = nodes[Math.max(0, best - 1)];
    const next = nodes[Math.min(nodes.length - 1, best + 1)];
    const useNext = next.pos.distanceToSquared(pos) < prev.pos.distanceToSquared(pos);
    const a = useNext ? n : prev;
    const b = useNext ? next : n;
    _v1.subVectors(b.pos, a.pos);
    const len2 = Math.max(1e-4, _v1.lengthSq());
    const t = clamp01(_v2.subVectors(pos, a.pos).dot(_v1) / len2);
    _v3.copy(a.pos).addScaledVector(_v1, t);
    const along = lerp(a.dist, b.dist, t);
    const offset = _v2.subVectors(pos, _v3);
    const lateral = offset.dot(n.right);
    const vertical = offset.dot(n.up);
    return {
      nodeIndex: best, node: n, along,
      lateral, vertical,
      offset: Math.hypot(lateral, vertical),
      radius: n.radius,
      outside: Math.hypot(lateral, vertical) > n.radius,
      point: _v3.clone(),
    };
  }
}

/* ===========================================================================
 * TERRAIN MESH — geo-clipmap rings
 * ======================================================================== */

class TerrainTile {
  constructor(level, size, res) {
    this.level = level; this.size = size; this.res = res;
    this.key = null;
    const geo = new THREE.PlaneGeometry(size, size, res, res);
    geo.rotateX(-Math.PI / 2);
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, null);
    this.mesh.frustumCulled = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }
  dispose() { this.geometry.dispose(); }
}

export class TerrainMesh {
  constructor(scene, field, materials, quality) {
    this.scene = scene;
    this.field = field;
    this.materials = materials;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);

    this.levels = Math.max(2, Math.min(4, quality.preset.terrainLOD));
    this.baseSize = WORLD.terrainChunkSize;
    // Vertex density per LOD ring. Level 0 is what you actually fly over.
    this.resForLevel = (L) => {
      const scale = clamp(quality.preset.viewDistance, 0.6, 1.4);
      return Math.max(10, Math.round((L === 0 ? 34 : L === 1 ? 24 : 16) * scale));
    };
    this.material = materials.terrain();
    this.tiles = [];
    this.pool = [];
    this.active = new Map();
    this.buildQueue = [];

    /* --- water ------------------------------------------------------------
     * One plane centred on the camera, but the surface detail is analytic in
     * the shader rather than a tiled texture, so it stays sharp at every
     * distance and never blocks up into squares. The grid is only there so the
     * plane has enough vertices to interpolate world position accurately
     * across a hundred kilometres; the waves themselves are per-pixel. */
    this.waterEnabled = field.biome.relief.water > 0.1;
    if (this.waterEnabled) {
      const g = new THREE.PlaneGeometry(1, 1, 24, 24).rotateX(-Math.PI / 2);
      const deep = new THREE.Color(field.biome.ground.water);
      // Shallows are the same water lifted and pushed toward green — the
      // colour you get when there is a bottom close enough to scatter light.
      const shallow = deep.clone().offsetHSL(-0.03, 0.06, 0.16);
      this.water = new THREE.Mesh(g, materials.waterSurface(deep.getHex(), shallow.getHex()));
      this.water.frustumCulled = false;
      this.water.renderOrder = -5;
      this.group.add(this.water);
    }

    if (field.biome.ceiling) {
      const g = new THREE.PlaneGeometry(1, 1, 24, 24).rotateX(Math.PI / 2);
      this.ceiling = new THREE.Mesh(g, materials.rock(0x2a2520));
      this.ceiling.frustumCulled = false;
      this.group.add(this.ceiling);
    }
  }

  _acquire(level, size, res) {
    const idx = this.pool.findIndex((t) => t.level === level);
    if (idx >= 0) return this.pool.splice(idx, 1)[0];
    const t = new TerrainTile(level, size, res);
    t.mesh.material = this.material;
    t.mesh.receiveShadow = level === 0;
    this.group.add(t.mesh);
    this.tiles.push(t);
    return t;
  }

  /**
   * Fill a tile's vertex positions + colours from the analytic field.
   * Heights are sampled once into a scratch grid; slope comes from the grid's
   * own neighbours rather than four extra field evaluations per vertex, which
   * is the difference between a ~2 ms tile and a ~25 ms hitch.
   */
  _buildTile(tile, cx, cz) {
    const g = tile.geometry;
    const pos = g.attributes.position;
    const col = g.attributes.color;
    const f = this.field;
    const half = tile.size / 2;
    const step = tile.size / tile.res;
    const n = tile.res + 1;
    const lod = Math.min(3, tile.level);

    if (!this._scratch || this._scratch.length < n * n) this._scratch = new Float32Array(n * n);
    const H = this._scratch;
    for (let j = 0; j < n; j++) {
      const z = cz - half + j * step;
      for (let i = 0; i < n; i++) {
        H[j * n + i] = f.height(cx - half + i * step, z, lod);
      }
    }
    const inv = 1 / (step * 2.2);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const vi = j * n + i;
        const h = H[vi];
        pos.setY(vi, h);
        const l = H[j * n + Math.max(0, i - 1)], r = H[j * n + Math.min(n - 1, i + 1)];
        const d = H[Math.max(0, j - 1) * n + i], u = H[Math.min(n - 1, j + 1) * n + i];
        const slope = Math.min(1, Math.hypot(r - l, u - d) * inv);
        f.colorAt(h, slope, _c1);
        col.setXYZ(vi, _c1.r, _c1.g, _c1.b);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
    tile.mesh.position.set(cx, 0, cz);
    tile.mesh.updateMatrix();
    tile.mesh.visible = true;
  }

  /** Clipmap update: 4×4 ring per level, inner 2×2 skipped (finer level covers it). */
  update(focus, budgetTiles = 2) {
    const wanted = new Set();
    for (let L = 0; L < this.levels; L++) {
      const size = this.baseSize * Math.pow(2, L);
      const cx = Math.floor(focus.x / size);
      const cz = Math.floor(focus.z / size);
      for (let dz = -2; dz <= 1; dz++) {
        for (let dx = -2; dx <= 1; dx++) {
          if (L > 0 && dx >= -1 && dx <= 0 && dz >= -1 && dz <= 0) continue;
          const tx = cx + dx, tz = cz + dz;
          wanted.add(`${L}:${tx}:${tz}`);
        }
      }
    }

    // Retire tiles that fell out of the wanted set.
    for (const [key, tile] of this.active) {
      if (!wanted.has(key)) {
        tile.mesh.visible = false;
        tile.key = null;
        this.active.delete(key);
        this.pool.push(tile);
      }
    }

    // Build missing tiles, at most `budgetTiles` per frame to avoid hitches.
    let built = 0;
    for (const key of wanted) {
      if (this.active.has(key)) continue;
      if (built >= budgetTiles) break;
      const [Ls, txs, tzs] = key.split(':');
      const L = +Ls, tx = +txs, tz = +tzs;
      const size = this.baseSize * Math.pow(2, L);
      const res = this.resForLevel(L);
      const tile = this._acquire(L, size, res);
      if (tile.size !== size || tile.res !== res) {
        // Pool entry was created for another level — rebuild its geometry.
        tile.geometry.dispose();
        const geo = new THREE.PlaneGeometry(size, size, res, res);
        geo.rotateX(-Math.PI / 2);
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
        tile.geometry = geo;
        tile.mesh.geometry = geo;
        tile.size = size; tile.res = res;
      }
      this._buildTile(tile, (tx + 0.5) * size, (tz + 0.5) * size);
      tile.key = key;
      this.active.set(key, tile);
      built++;
    }

    if (this.water) {
      const s = this.baseSize * Math.pow(2, this.levels) * 3;
      this.water.scale.set(s, 1, s);
      this.water.position.set(focus.x, this.field.waterLevel, focus.z);
    }
    if (this.ceiling) {
      const s = this.baseSize * 6;
      this.ceiling.scale.set(s, 1, s);
      this.ceiling.position.set(focus.x, focus.y + 1200, focus.z);
    }
  }

  dispose() {
    for (const t of this.tiles) t.dispose();
    this.tiles.length = 0; this.pool.length = 0; this.active.clear();
    this.water?.geometry.dispose();
    this.ceiling?.geometry.dispose();
    this.scene.remove(this.group);
  }
}

/* ===========================================================================
 * PROP LIBRARY — reusable instanced geometry for scatter content
 * ======================================================================== */

function makeTreeGeometry(kind) {
  const parts = [];
  if (kind === 'conifer') {
    const trunk = new THREE.CylinderGeometry(0.8, 1.3, 8, 5);
    trunk.translate(0, 4, 0);
    parts.push(trunk);
    for (let i = 0; i < 3; i++) {
      const r = 5.2 - i * 1.4, h = 9 - i * 1.6;
      const c = new THREE.ConeGeometry(r, h, 7);
      c.translate(0, 8 + i * 5.2, 0);
      parts.push(c);
    }
  } else if (kind === 'broadleaf') {
    const trunk = new THREE.CylinderGeometry(0.9, 1.5, 7, 5);
    trunk.translate(0, 3.5, 0);
    parts.push(trunk);
    const crown = new THREE.IcosahedronGeometry(6, 0);
    crown.scale(1, 0.82, 1); crown.translate(0, 11, 0);
    parts.push(crown);
  } else { // palm / karst
    const trunk = new THREE.CylinderGeometry(0.6, 1.1, 14, 5);
    trunk.translate(0, 7, 0);
    parts.push(trunk);
    for (let i = 0; i < 5; i++) {
      const f = new THREE.ConeGeometry(1.2, 8, 4);
      f.rotateZ(Math.PI * 0.42);
      f.rotateY((i / 5) * TAU);
      f.translate(0, 14, 0);
      parts.push(f);
    }
  }
  return mergeGeometriesSafe(parts);
}

function makeRockGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.attributes.position;
  const rng = new RNG(seed);
  for (let i = 0; i < pos.count; i++) {
    const s = 0.62 + rng.next() * 0.7;
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s * 0.8, pos.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Low ground cover. Deliberately cheap — a handful of crossed, tilted quads —
 * because it is scattered in the thousands. Its job is to break up the bare
 * shaded terrain when the aircraft is down in the weeds, which is where the
 * ground reads as flat geometry rather than landscape.
 */
function makeShrubGeometry() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const p = new THREE.PlaneGeometry(2.4, 1.9);
    p.translate(0, 0.95, 0);
    p.rotateY((i / 3) * Math.PI);
    p.rotateX(-0.12);
    parts.push(p);
  }
  return mergeGeometriesSafe(parts);
}

/** Masts, pylons and chimneys — vertical detail that gives scale from the air. */
function makeMastGeometry() {
  const parts = [];
  const shaft = new THREE.CylinderGeometry(0.5, 1.5, 26, 5);
  shaft.translate(0, 13, 0);
  parts.push(shaft);
  for (const y of [14, 20]) {
    const arm = new THREE.BoxGeometry(9, 0.8, 0.8);
    arm.translate(0, y, 0);
    parts.push(arm);
  }
  const cap = new THREE.ConeGeometry(1.1, 3, 5);
  cap.translate(0, 27.5, 0);
  parts.push(cap);
  return mergeGeometriesSafe(parts);
}

/* ===========================================================================
 * WORLD CHUNK — one streamed slice of route content
 * ======================================================================== */

let CHUNK_UID = 0;

class WorldChunk {
  constructor(world, index) {
    this.world = world;
    this.index = index;
    this.uid = ++CHUNK_UID;
    this.group = new THREE.Group();
    this.group.name = `chunk_${index}`;
    this.colliders = [];
    this.checkpoints = [];
    this.rings = [];
    this.animated = [];
    this.disposables = [];
    this.startNode = 0;
    this.endNode = 0;
    this.built = false;
    // Bounding sphere over this chunk's colliders, maintained as they are
    // added. Ground structures push the collider count into the thousands per
    // chunk, and a chunk-level reject turns the broadphase from "test every
    // collider in the world" into "test the two or three chunks the aircraft
    // is actually inside".
    this.bMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.bMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  }

  addCollider(c) {
    this.colliders.push(c);
    this.bMin.set(Math.min(this.bMin.x, c.pos.x - c.radius),
      Math.min(this.bMin.y, c.pos.y - c.radius), Math.min(this.bMin.z, c.pos.z - c.radius));
    this.bMax.set(Math.max(this.bMax.x, c.pos.x + c.radius),
      Math.max(this.bMax.y, c.pos.y + c.radius), Math.max(this.bMax.z, c.pos.z + c.radius));
    return c;
  }

  /** Cheap AABB reject for a query sphere. */
  mayContain(pos, radius) {
    return pos.x + radius >= this.bMin.x && pos.x - radius <= this.bMax.x
      && pos.y + radius >= this.bMin.y && pos.y - radius <= this.bMax.y
      && pos.z + radius >= this.bMin.z && pos.z - radius <= this.bMax.z;
  }

  dispose(scene) {
    scene.remove(this.group);
    for (const g of this.disposables) g.dispose?.();
    this.group.traverse((n) => {
      if (n.geometry && !n.userData.shared) n.geometry.dispose();
    });
    this.group.clear();
    this.colliders.length = 0;
    this.bMin.set(Infinity, Infinity, Infinity);
    this.bMax.set(-Infinity, -Infinity, -Infinity);
    this.checkpoints.length = 0;
    this.rings.length = 0;
    this.animated.length = 0;
    this.disposables.length = 0;
    this.built = false;
  }
}

/* ===========================================================================
 * WORLD
 * ======================================================================== */

export class World {
  constructor(render, quality, opts = {}) {
    this.render = render;
    this.scene = render.scene;
    this.materials = render.materials;
    this.textures = render.textures;
    this.quality = quality;
    this.vfx = render.vfx;

    this.seed = opts.seed ?? (Math.random() * 1e9) | 0;
    this.rng = new RNG(this.seed);
    this.biome = opts.biome;
    this.weatherId = opts.weather;
    this.timeId = opts.time;
    this.difficulty = opts.difficulty;
    this.mode = opts.mode;

    this.terrain = new TerrainField(this.seed ^ 0x9e37, this.biome);
    this.path = new RacePath(this.seed, this.terrain, this.difficulty, { });
    this.terrainMesh = new TerrainMesh(this.scene, this.terrain, this.materials, quality);

    this.nodesPerChunk = 24;
    this.chunks = new Map();
    this.chunkPool = [];
    this._queued = new Set();
    this.currentChunk = 0;
    this.checkpointList = [];
    this.ringCounter = 0;

    this.time = 0;
    this.windVec = new THREE.Vector3();
    this.turbulence = 0;
    this.lightningTimer = this.rng.float(3, 12);
    this.events = [];
    this.activeEvent = null;
    this.eventTimer = this.rng.float(28, 55);
    this.weatherTransition = null;

    this._propGeos = null;
    this._sample = {};
    this._focus = new THREE.Vector3();
    this._colliderScratch = [];
    /** Moving colliders owned by other systems (traffic). Assigned by ai.js. */
    this.dynamicColliders = [];
    this.stats = { chunks: 0, colliders: 0, objects: 0 };

    this._initPropGeometries();
  }

  _initPropGeometries() {
    const b = this.biome;
    const treeKind = b.id === 'jungle' ? 'palm' : (b.props.trees > 0.8 || b.id === 'ice' || b.id === 'mountain') ? 'conifer' : 'broadleaf';
    this._propGeos = {
      tree: makeTreeGeometry(treeKind),
      // A second, visually different tree so a forest is not one silhouette
      // repeated ten thousand times.
      tree2: makeTreeGeometry(treeKind === 'conifer' ? 'broadleaf' : 'conifer'),
      rock: makeRockGeometry(this.seed + 5),
      rock2: makeRockGeometry(this.seed + 137),
      building: new THREE.BoxGeometry(1, 1, 1),
      // Ground cover: low scrub that fills the space between the big props and
      // stops the terrain reading as bare shaded geometry from low altitude.
      shrub: makeShrubGeometry(),
      // Vertical punctuation — masts, pylons and chimneys.
      mast: makeMastGeometry(),
    };
    const night = ['night', 'neonNight'].includes(this.weatherId) || this.timeId === 'night' || this.timeId === 'dusk';
    this._propMats = {
      tree: this.materials.foliage(new THREE.Color(b.ground.base).offsetHSL(0, 0.08, -0.06).getHex()),
      // A second foliage tone so mixed stands read as a real canopy.
      tree2: this.materials.foliage(new THREE.Color(b.ground.base).offsetHSL(0.03, 0.14, 0.04).getHex()),
      rock: this.materials.rock(b.ground.rock),
      rock2: this.materials.rock(new THREE.Color(b.ground.rock).offsetHSL(0, -0.05, -0.08).getHex()),
      shrub: this.materials.foliage(new THREE.Color(b.ground.base).offsetHSL(-0.02, 0.10, -0.12).getHex()),
      building: this.materials.building(night),
    };
    this.isNight = night;
  }

  /* ---------------------------------------------------------------------
   * CONTENT BUILDERS
   * ------------------------------------------------------------------ */

  /** Big aerial checkpoint gate. */
  _buildCheckpoint(node, idx, rng, kind) {
    const R = clamp(node.radius * 0.52, 70, 220);
    const g = new THREE.Group();
    const color = this.biome.accent;
    const energy = this.materials.energy(color, { intensity: 0.75, hexScale: 4.0 });

    // Solid structural ring first — the gate should read as built hardware,
    // with the energy field as trim rather than the whole object.
    const torus = new THREE.TorusGeometry(R, R * 0.075, 8, 40);
    const ring = new THREE.Mesh(torus, this.materials.structure(0x39424e, 0.9, 0.34));
    g.add(ring);

    // Membrane across the aperture: a grazing-angle shimmer, not a bright disc
    // you cannot see the route through.
    const inner = new THREE.Mesh(new THREE.CircleGeometry(R * 0.95, 40),
      this.materials.energy(color, { intensity: 0.26, hexScale: 6.0, fresnel: 3.2, pulse: 0.5 }));
    inner.renderOrder = 3;
    g.add(inner);

    const glowRing = new THREE.Mesh(new THREE.TorusGeometry(R * 1.03, R * 0.022, 6, 40), energy);
    glowRing.renderOrder = 4;
    g.add(glowRing);

    // Structural struts so the gate reads as a built object, not a decal.
    // Struts and beacons are each merged into one mesh — four gates in view
    // should not cost forty draw calls.
    const strutGeos = [], beaconGeos = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      const sg = new THREE.BoxGeometry(R * 0.09, R * 0.30, R * 0.09);
      sg.rotateZ(a);
      sg.translate(Math.cos(a) * R * 1.06, Math.sin(a) * R * 1.06, 0);
      strutGeos.push(sg);
      const bg = new THREE.SphereGeometry(R * 0.035, 6, 5);
      bg.translate(Math.cos(a) * R * 1.19, Math.sin(a) * R * 1.19, 0);
      beaconGeos.push(bg);
    }
    g.add(new THREE.Mesh(mergeGeometriesSafe(strutGeos, false),
      this.materials.structure(0x3a424c, 0.8, 0.45)));
    g.add(new THREE.Mesh(mergeGeometriesSafe(beaconGeos, false),
      this.materials.emissiveBasic(color)));
    for (const x of strutGeos) x.dispose();
    for (const x of beaconGeos) x.dispose();

    if (kind === 'multi') {
      const extra = [];
      for (let i = 1; i <= 2; i++) {
        const t2 = new THREE.TorusGeometry(R * (1 - i * 0.16), R * 0.028, 6, 28);
        t2.translate(0, 0, i * R * 0.34);
        extra.push(t2);
      }
      g.add(new THREE.Mesh(mergeGeometriesSafe(extra, false), energy));
      for (const x of extra) x.dispose();
    }

    g.position.copy(node.pos);
    // Local +Z aligned with the route tangent so gates face down-track.
    _m1.lookAt(node.tangent, _v1.set(0, 0, 0), node.up);
    g.quaternion.setFromRotationMatrix(_m1);

    const cp = {
      id: idx, isCheckpoint: true,
      object: g, node, radius: R, kind,
      pos: node.pos.clone(),
      normal: node.tangent.clone(),
      passed: false, missed: false,
      moving: kind === 'moving',
      phase: rng.float(0, TAU),
      amp: kind === 'moving' ? node.radius * 0.35 : 0,
      basePos: node.pos.clone(),
      energy, glowRing, inner,
      index: idx,
    };
    return cp;
  }

  /** Small race ring — boost, precision or bonus. */
  _buildRing(pos, normal, up, kind, rng) {
    const spec = {
      standard: { r: 34, color: 0x7fd6ff, score: 'ring' },
      boost: { r: 40, color: 0x39ffb0, score: 'ringBoost' },
      precision: { r: 20, color: 0xffcf4d, score: 'ringPrecision' },
      risk: { r: 26, color: 0xff5a5a, score: 'ringPrecision' },
      bonus: { r: 32, color: 0xc79bff, score: 'ringBoost' },
    }[kind] || { r: 34, color: 0x7fd6ff, score: 'ring' };

    const mat = this.materials.energy(spec.color, { intensity: 1.5, hexScale: 2.2, scroll: 1.8 });
    // One mesh per ring: the torus plus a thin inner hoop merged together.
    const parts = [
      new THREE.TorusGeometry(spec.r, spec.r * 0.10, 6, 20),
      new THREE.TorusGeometry(spec.r * 0.86, spec.r * 0.035, 5, 18),
    ];
    const geo = mergeGeometriesSafe(parts, false);
    for (const p of parts) p.dispose();
    const g = new THREE.Mesh(geo, mat);
    g.position.copy(pos);
    _m1.lookAt(normal, _v1.set(0, 0, 0), up);
    g.quaternion.setFromRotationMatrix(_m1);

    return {
      id: this.ringCounter++, isRing: true, object: g, kind, radius: spec.r, score: spec.score,
      pos: pos.clone(), basePos: pos.clone(), normal: normal.clone(),
      collected: false, color: spec.color, spin: rng.float(-1.2, 1.2),
      phase: rng.float(0, TAU),
    };
  }

  /** Obstacle mesh + collider. Types are picked to suit the biome. */
  _buildObstacle(pos, rng, node, difficultyScale) {
    const types = [
      { id: 'slab', w: 3 },
      { id: 'pylon', w: 2.5 },
      { id: 'container', w: 2 },
      { id: 'rotor', w: 2 },
      { id: 'barrier', w: 2.5 },
      { id: 'debris', w: 2 },
      { id: 'island', w: 1.6 },
      { id: 'turbine', w: this.biome.props.buildings > 0.3 ? 1.4 : 0.6 },
      { id: 'spire', w: this.biome.props.rocks > 0.6 ? 2.2 : 0.8 },
    ];
    const t = rng.weighted(types).id;
    const g = new THREE.Group();
    let radius = 40;
    let soft = false;
    const structMat = this.materials.structure(0x555c66, 0.7, 0.5);
    const darkMat = this.materials.structure(0x2b3038, 0.5, 0.7);
    const accent = this.materials.emissiveBasic(this.biome.accent);

    if (t === 'slab') {
      const w = rng.float(90, 210), h = rng.float(40, 120), d = rng.float(10, 22);
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), structMat);
      g.add(m);
      for (let i = 0; i < 3; i++) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 2.5, d * 1.1), accent);
        strip.position.y = -h / 2 + h * (i + 1) / 4;
        g.add(strip);
      }
      radius = Math.max(w, h) * 0.5;
    } else if (t === 'pylon') {
      const h = rng.float(180, 420), r = rng.float(7, 14);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r, h, 8), structMat);
      g.add(m);
      for (let i = 0; i < 3; i++) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(rng.float(60, 130), 5, 8), darkMat);
        arm.position.y = h * (0.16 + i * 0.16);
        arm.rotation.y = rng.float(0, TAU);
        g.add(arm);
      }
      const light = new THREE.Mesh(new THREE.SphereGeometry(r * 0.9, 6, 5), this.materials.emissiveBasic(0xff3b30));
      light.position.y = h / 2;
      g.add(light);
      radius = Math.max(h * 0.5, 70);
    } else if (t === 'container') {
      const n = rng.int(2, 6);
      for (let i = 0; i < n; i++) {
        const w = rng.float(26, 46);
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, w * 0.5, w * 2.2),
          this.materials.structure(rng.pick([0xc4552f, 0x2f6ac4, 0x3ba05a, 0xb8a13a]), 0.35, 0.7));
        m.position.set(rng.float(-40, 40), rng.float(-30, 30), rng.float(-40, 40));
        m.rotation.set(rng.float(0, TAU), rng.float(0, TAU), rng.float(0, TAU));
        g.add(m);
      }
      radius = 70; soft = true;
    } else if (t === 'rotor') {
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 16, 10), structMat);
      hub.rotation.x = Math.PI / 2;
      g.add(hub);
      const arms = rng.int(3, 5);
      const len = rng.float(70, 160);
      for (let i = 0; i < arms; i++) {
        const a = new THREE.Mesh(new THREE.BoxGeometry(len, 12, 5), structMat);
        a.position.x = len / 2;
        const pivot = new THREE.Object3D();
        pivot.rotation.z = (i / arms) * TAU;
        pivot.add(a);
        const tip = new THREE.Mesh(new THREE.BoxGeometry(14, 14, 7), accent);
        tip.position.x = len;
        pivot.add(tip);
        g.add(pivot);
      }
      g.userData.spin = rng.float(0.35, 1.1) * rng.sign();
      radius = len + 20;
    } else if (t === 'barrier') {
      const w = rng.float(120, 260), h = rng.float(60, 140);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w, 6, 6), structMat);
      frame.position.y = h / 2; g.add(frame);
      const frame2 = frame.clone(); frame2.position.y = -h / 2; g.add(frame2);
      const field = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        this.materials.energy(0xff4a2a, { intensity: 1.0, hexScale: 5, scroll: 2.4 }));
      field.renderOrder = 3;
      g.add(field);
      radius = Math.max(w, h) * 0.5; soft = true;
    } else if (t === 'debris') {
      const n = rng.int(6, 14);
      for (let i = 0; i < n; i++) {
        const s = rng.float(6, 26);
        const m = new THREE.Mesh(this._propGeos.rock, this._propMats.rock);
        m.userData.shared = true;
        m.scale.setScalar(s);
        m.position.set(rng.float(-90, 90), rng.float(-60, 60), rng.float(-90, 90));
        m.rotation.set(rng.float(0, TAU), rng.float(0, TAU), rng.float(0, TAU));
        g.add(m);
      }
      radius = 100; soft = true;
    } else if (t === 'island') {
      const s = rng.float(60, 190);
      const m = new THREE.Mesh(this._propGeos.rock, this._propMats.rock);
      m.userData.shared = true;
      m.scale.set(s, s * rng.float(0.4, 0.8), s * rng.float(0.7, 1.3));
      g.add(m);
      if (this.biome.props.trees > 0.4) {
        const trees = new THREE.InstancedMesh(this._propGeos.tree, this._propMats.tree, 12);
        trees.userData.shared = true;
        for (let i = 0; i < 12; i++) {
          _m1.makeTranslation(rng.float(-s * 0.6, s * 0.6), s * 0.35, rng.float(-s * 0.6, s * 0.6));
          _m1.scale(_v1.setScalar(rng.float(1.4, 3.2)));
          trees.setMatrixAt(i, _m1);
        }
        trees.instanceMatrix.needsUpdate = true;
        g.add(trees);
      }
      radius = s * 0.9;
    } else if (t === 'turbine') {
      const h = rng.float(120, 260);
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(4, 8, h, 8), this.materials.structure(0xdde3e8, 0.3, 0.5));
      g.add(tower);
      const hub = new THREE.Object3D();
      hub.position.y = h / 2;
      for (let i = 0; i < 3; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(4, h * 0.42, 12), this.materials.structure(0xf0f4f7, 0.2, 0.5));
        blade.position.y = h * 0.21;
        const p = new THREE.Object3D();
        p.rotation.z = (i / 3) * TAU;
        p.add(blade);
        hub.add(p);
      }
      hub.userData.spin = rng.float(0.6, 1.6);
      g.add(hub);
      g.userData.hub = hub;
      radius = h * 0.5;
    } else { // spire
      const h = rng.float(200, 520), r = rng.float(20, 60);
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), this._propMats.rock);
      m.userData.shared = false;
      g.add(m);
      radius = Math.max(h * 0.45, r * 1.6);
    }

    g.position.copy(pos);
    g.rotation.y = rng.float(0, TAU);
    g.traverse((n) => { if (n.isMesh) { n.castShadow = false; n.receiveShadow = false; } });

    return {
      object: g, pos: pos.clone(), radius: radius * 0.82, type: t, soft,
      kind: 'obstacle',
      spin: g.userData.spin || 0,
      hub: g.userData.hub || null,
      damage: soft ? 9 : 26,
    };
  }

  /** Volumetric-style cloud cluster (instanced billboard puffs). */
  _buildCloudCluster(center, rng, scale = 1) {
    const count = Math.max(6, Math.round(rng.float(16, 34) * this.quality.cloudQuality * scale));
    const geo = new THREE.InstancedBufferGeometry();
    // Note: the source plane's attributes are handed to the instanced geometry
    // by reference, so it must NOT be disposed — it is now shared, not garbage.
    const base = new THREE.PlaneGeometry(1, 1);
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;

    const off = new Float32Array(count * 3);
    const scl = new Float32Array(count);
    const rot = new Float32Array(count);
    const shade = new Float32Array(count);
    const spread = rng.float(180, 460) * scale;
    for (let i = 0; i < count; i++) {
      const a = rng.float(0, TAU), r = Math.pow(rng.next(), 0.6) * spread;
      off[i * 3] = Math.cos(a) * r;
      off[i * 3 + 1] = rng.gauss(0, spread * 0.20);
      off[i * 3 + 2] = Math.sin(a) * r * rng.float(0.6, 1.2);
      scl[i] = rng.float(0.55, 1.5) * spread * 0.62;
      rot[i] = rng.float(0, TAU);
      shade[i] = clamp01(0.5 + off[i * 3 + 1] / (spread * 0.5));
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scl, 1));
    geo.setAttribute('aRot', new THREE.InstancedBufferAttribute(rot, 1));
    geo.setAttribute('aShade', new THREE.InstancedBufferAttribute(shade, 1));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), spread * 2.2);

    const mat = this._cloudMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(center);
    mesh.renderOrder = 1;
    mesh.frustumCulled = true;
    return { mesh, geo };
  }

  _cloudMaterial() {
    if (this._cloudMat) return this._cloudMat;
    const sky = this.render.sky;
    this._cloudMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uMap: { value: this.textures.cloudPuff(256, 11) },
        uSun: sky.uniforms.uSunDir,
        uLight: { value: new THREE.Color(0xffffff) },
        uDark: { value: new THREE.Color(0x7d8a99) },
        uOpacity: { value: 0.58 },
        uTime: { value: 0 },
        uFogColor: { value: new THREE.Color(0xbcd4e8) },
        uFogDensity: { value: 0.00012 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aOffset; attribute float aScale; attribute float aRot; attribute float aShade;
        uniform float uTime;
        varying vec2 vUv; varying float vShade; varying float vNear; varying float vDist;
        void main(){
          vUv = uv; vShade = aShade;
          vec3 center = (modelMatrix * vec4(aOffset, 1.0)).xyz;
          center.x += sin(uTime * 0.08 + aRot) * 6.0;
          vec3 toCam = cameraPosition - center;
          float camDist = length(toCam);
          toCam /= max(camDist, 0.001);
          vec3 right = normalize(cross(vec3(0.0,1.0,0.0), toCam));
          vec3 up = cross(toCam, right);
          float c = cos(aRot), s = sin(aRot);
          vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * aScale;
          vec3 world = center + right * p.x + up * p.y;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          vDist = -mv.z;
          // Soft-particle fade: a puff whose centre is nearly on the camera
          // would otherwise fill the screen with a flat white card.
          vNear = smoothstep(max(aScale * 0.5, 150.0), max(aScale * 2.4, 560.0), camDist);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform vec3 uSun, uLight, uDark, uFogColor;
        uniform float uOpacity, uFogDensity;
        varying vec2 vUv; varying float vShade; varying float vNear; varying float vDist;
        void main(){
          vec4 t = texture2D(uMap, vUv);
          float a = t.a * uOpacity * vNear;
          if (a < 0.006) discard;
          // Lit top, shadowed base — the read that makes billboards look volumetric.
          float lit = clamp(vShade * 0.85 + 0.15 + uSun.y * 0.30, 0.0, 1.0);
          vec3 col = mix(uDark, uLight, lit);
          float f = 1.0 - exp(-pow(vDist * uFogDensity, 2.0));
          col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
          gl_FragColor = vec4(col, a);
        }`,
    });
    return this._cloudMat;
  }

  /** Landmark megastructures that give each venue its silhouette. */
  _buildLandmark(kind, pos, rng) {
    const g = new THREE.Group();
    const mat = this.materials.structure(0x6a7078, 0.55, 0.6);
    const dark = this.materials.structure(0x33383f, 0.4, 0.75);
    const accent = this.materials.emissiveBasic(this.biome.accent);
    const ground = this.terrain.surface(pos.x, pos.z);

    if (kind === 'megaSpire' || kind === 'ridgeTower' || kind === 'beaconTower') {
      const h = rng.float(900, 2200);
      const seg = 7;
      for (let i = 0; i < seg; i++) {
        const t = i / seg;
        const r = lerp(70, 16, t) * rng.float(0.9, 1.1);
        const sh = h / seg;
        const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r, sh, 8), i % 2 ? dark : mat);
        m.position.y = ground + sh * (i + 0.5);
        g.add(m);
        if (i % 2 === 0) {
          const band = new THREE.Mesh(new THREE.TorusGeometry(r * 1.08, 3.5, 4, 12), accent);
          band.rotation.x = Math.PI / 2;
          band.position.y = ground + sh * (i + 1);
          g.add(band);
        }
      }
      const tip = new THREE.Mesh(new THREE.ConeGeometry(14, 220, 6), mat);
      tip.position.y = ground + h + 110; g.add(tip);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(16, 8, 6), this.materials.emissiveBasic(0xff3b30));
      beacon.position.y = ground + h + 230; g.add(beacon);
    } else if (kind === 'archBridge' || kind === 'skyBridge') {
      const span = rng.float(1200, 2600);
      const y = ground + rng.float(180, 900);
      const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 26, 120), mat);
      deck.position.y = y; g.add(deck);
      for (let i = -1; i <= 1; i += 2) {
        const tower = new THREE.Mesh(new THREE.BoxGeometry(60, y - ground + 320, 90), dark);
        tower.position.set(i * span * 0.30, ground + (y - ground + 320) / 2, 0);
        g.add(tower);
      }
      const arch = new THREE.Mesh(new THREE.TorusGeometry(span * 0.34, 20, 6, 24, Math.PI), mat);
      arch.position.y = y - 20; g.add(arch);
      for (let i = 0; i < 10; i++) {
        const l = new THREE.Mesh(new THREE.SphereGeometry(7, 6, 5), accent);
        l.position.set(lerp(-span / 2, span / 2, i / 9), y + 22, 0);
        g.add(l);
      }
    } else if (kind === 'citadel' || kind === 'bunkerComplex') {
      const R = rng.float(700, 1400);
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.06, 190, 12, 1, true), mat);
      wall.position.y = ground + 95; g.add(wall);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const th = rng.float(240, 420);
        const t = new THREE.Mesh(new THREE.CylinderGeometry(52, 62, th, 8), dark);
        t.position.set(Math.cos(a) * R, ground + th / 2, Math.sin(a) * R);
        g.add(t);
        const roof = new THREE.Mesh(new THREE.ConeGeometry(72, 110, 8), mat);
        roof.position.set(Math.cos(a) * R, ground + th + 55, Math.sin(a) * R);
        g.add(roof);
        const fire = new THREE.Mesh(new THREE.SphereGeometry(9, 6, 5), this.materials.emissiveBasic(0xff8a3a));
        fire.position.set(Math.cos(a) * R, ground + th + 118, Math.sin(a) * R);
        g.add(fire);
      }
      const keep = new THREE.Mesh(new THREE.BoxGeometry(R * 0.55, 520, R * 0.55), mat);
      keep.position.y = ground + 260; g.add(keep);
    } else if (kind === 'mesaArch' || kind === 'iceArch') {
      const R = rng.float(420, 900);
      const arch = new THREE.Mesh(new THREE.TorusGeometry(R, R * 0.20, 7, 18, Math.PI),
        kind === 'iceArch' ? this.materials.rock(0xcfe3f2) : this._propMats.rock);
      arch.position.y = ground; g.add(arch);
    } else if (kind === 'windmillRidge' || kind === 'solarField') {
      for (let i = 0; i < 9; i++) {
        const x = rng.float(-900, 900), z = rng.float(-900, 900);
        const gy = this.terrain.surface(pos.x + x, pos.z + z);
        const h = rng.float(90, 160);
        const t = new THREE.Mesh(new THREE.CylinderGeometry(3, 6, h, 6), this.materials.structure(0xdde3e8, 0.3, 0.5));
        t.position.set(x, gy + h / 2, z); g.add(t);
        const hub = new THREE.Object3D();
        hub.position.set(x, gy + h, z);
        for (let k = 0; k < 3; k++) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(3, h * 0.5, 8), this.materials.structure(0xf0f4f7, 0.2, 0.5));
          blade.position.y = h * 0.25;
          const p = new THREE.Object3D(); p.rotation.z = (k / 3) * TAU; p.add(blade);
          hub.add(p);
        }
        hub.userData.spin = rng.float(0.5, 1.4);
        g.add(hub);
        g.userData.spinners = g.userData.spinners || [];
        g.userData.spinners.push(hub);
      }
    } else if (kind === 'conduitPylon' || kind === 'stormPylon' || kind === 'radarArray') {
      for (let i = 0; i < 5; i++) {
        const x = rng.float(-800, 800), z = rng.float(-800, 800);
        const gy = this.terrain.surface(pos.x + x, pos.z + z);
        const h = rng.float(240, 520);
        const t = new THREE.Mesh(new THREE.CylinderGeometry(8, 16, h, 6), dark);
        t.position.set(x, gy + h / 2, z); g.add(t);
        for (let k = 0; k < 3; k++) {
          const arm = new THREE.Mesh(new THREE.BoxGeometry(120, 6, 6), mat);
          arm.position.set(x, gy + h * (0.5 + k * 0.16), z);
          arm.rotation.y = rng.float(0, TAU);
          g.add(arm);
        }
        const glow = new THREE.Mesh(new THREE.SphereGeometry(12, 6, 5), accent);
        glow.position.set(x, gy + h, z); g.add(glow);
      }
    } else { // generic cluster: stadium / ruins / refinery / pipeworks / karst
      const n = rng.int(4, 9);
      for (let i = 0; i < n; i++) {
        const x = rng.float(-600, 600), z = rng.float(-600, 600);
        const gy = this.terrain.surface(pos.x + x, pos.z + z);
        const h = rng.float(120, 460);
        const w = rng.float(80, 260);
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * rng.float(0.6, 1.4)), i % 2 ? mat : dark);
        m.position.set(x, gy + h / 2, z);
        m.rotation.y = rng.float(0, TAU);
        g.add(m);
      }
    }

    g.position.set(pos.x, 0, pos.z);
    return g;
  }

  /**
   * Make an already-built structure solid by deriving colliders from its own
   * meshes rather than from a hand-written table.
   *
   * Landmarks are assembled branch by branch out of dozens of primitives, and a
   * per-kind collider list would drift out of step with the geometry the first
   * time one of them was retuned. Walking the finished group instead means a
   * spire is solid because it *is* a spire — every mesh above the size floor
   * contributes a sphere, and the whole silhouette ends up hittable.
   *
   * @param minR  smallest mesh worth colliding with, in metres
   * @param maxN  cap on colliders taken from this structure (largest first)
   */
  _registerStructureColliders(chunk, root, minR = 20, maxN = 40, type = 'structure') {
    root.updateMatrixWorld(true);
    const found = [];
    root.traverse((n) => {
      if (!n.isMesh || !n.geometry) return;
      if (!n.geometry.boundingSphere) n.geometry.computeBoundingSphere();
      const bs = n.geometry.boundingSphere;
      if (!bs) return;
      const c = bs.center.clone().applyMatrix4(n.matrixWorld);
      // Uniform-ish scale is the norm here; take the largest axis so a stretched
      // slab is never under-covered.
      const sc = _v1.setFromMatrixScale(n.matrixWorld);
      const r = bs.radius * Math.max(sc.x, sc.y, sc.z) * 0.72;
      if (r < minR) return;
      found.push({ c, r });
    });
    found.sort((a, b) => b.r - a.r);
    for (const f of found.slice(0, maxN)) {
      chunk.addCollider({
        pos: f.c, radius: f.r, damage: 52, type, kind: 'structure', soft: false,
        object: null, spin: 0, hub: null,
      });
    }
  }

  /** Ground scatter for one chunk footprint (trees / buildings / rocks). */
  *_buildScatter(chunk, centerX, centerZ, extent, rng) {
    const d = this.quality.propDensity;
    const p = this.biome.props;

    /**
     * Register a scatter prop as something the aircraft can hit.
     *
     * Structures are placed in chunk-local space but collide in world space,
     * so the offset has to be applied here. Only things tall or solid enough to
     * matter get a collider: a tower block or a mast is a wall, a shrub is not,
     * and putting 20,000 pieces of ground cover into the broadphase would cost
     * far more than it could ever add.
     */
    const solid = (lx, y, lz, radius, damage, type) => {
      chunk.addCollider({
        pos: new THREE.Vector3(centerX + lx, y, centerZ + lz),
        radius, damage, type, kind: 'structure', soft: false,
        object: null, spin: 0, hub: null,
      });
    };

    const addInstanced = (geo, mat, count, place) => {
      if (count <= 0) return;
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.userData.shared = true;
      mesh.frustumCulled = true;
      mesh.castShadow = false;
      let n = 0;
      for (let i = 0; i < count; i++) {
        if (place(i, _m1)) { mesh.setMatrixAt(n++, _m1); }
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (n > 0) { mesh.position.set(centerX, 0, centerZ); chunk.group.add(mesh); }
      return mesh;
    };

    const rand = () => rng.float(-extent, extent);

    /* --- forest -----------------------------------------------------------
     * Two species, placed against a low-frequency stand mask rather than
     * uniformly: real woodland is dense in patches and open in between, and
     * that contrast is what makes it read as terrain instead of noise. */
    const placeTree = (scaleLo, scaleHi) => (i, m) => {
      const x = rand(), z = rand();
      const wx = centerX + x, wz = centerZ + z;
      const h = this.terrain.height(wx, wz);
      if (h < this.terrain.waterLevel + 8) return false;
      if (h > this.terrain.snowLine * 0.95) return false;
      if (this.terrain.slope(wx, wz, 60) > 0.55) return false;
      // Stand mask: thin the canopy where the mask is low so clearings appear.
      if (fbm2(wx * 0.00055, wz * 0.00055, this.seed + 211, 3) + 0.35 < rng.next() * 0.9) return false;
      const s = rng.float(scaleLo, scaleHi);
      m.makeRotationY(rng.float(0, TAU));
      m.scale(_v1.set(s, s * rng.float(0.8, 1.4), s));
      m.setPosition(x, h, z);
      return true;
    };
    const treeCount = Math.round(1150 * p.trees * d);
    addInstanced(this._propGeos.tree, this._propMats.tree, treeCount, placeTree(1.5, 4.2));
    yield;
    addInstanced(this._propGeos.tree2, this._propMats.tree2,
      Math.round(treeCount * 0.45), placeTree(1.1, 3.0));
    yield;

    /* --- ground cover ---------------------------------------------------
     * Scrub between the trees. Very cheap geometry, very high count — this is
     * what removes the bare-shaded-mesh look at low altitude. */
    const shrubCount = Math.round(1500 * clamp01(p.trees + 0.35) * d);
    addInstanced(this._propGeos.shrub, this._propMats.shrub, shrubCount, (i, m) => {
      const x = rand(), z = rand();
      const wx = centerX + x, wz = centerZ + z;
      const h = this.terrain.height(wx, wz);
      if (h < this.terrain.waterLevel + 2) return false;
      if (h > this.terrain.snowLine) return false;
      if (this.terrain.slope(wx, wz, 40) > 0.7) return false;
      const s = rng.float(1.4, 4.6);
      m.makeRotationY(rng.float(0, TAU));
      m.scale(_v1.set(s, s * rng.float(0.7, 1.5), s));
      m.setPosition(x, h, z);
      return true;
    });
    yield;

    // Buildings
    const bCount = Math.round(620 * p.buildings * d);
    addInstanced(this._propGeos.building, this._propMats.building, bCount, (i, m) => {
      const x = rand(), z = rand();
      const wx = centerX + x, wz = centerZ + z;
      const h = this.terrain.height(wx, wz);
      if (h < this.terrain.waterLevel + 4) return false;
      if (this.terrain.slope(wx, wz, 80) > 0.34) return false;
      // Cluster into districts so cities do not look like uniform noise.
      const cluster = fbm2(wx * 0.00035, wz * 0.00035, this.seed + 61, 3);
      if (cluster < 0.02) return false;
      const tall = clamp01(cluster * 1.6) * (p.buildings > 1 ? 1 : 0.45);
      const bh = rng.float(30, 90) + Math.pow(rng.next(), 3) * 620 * tall;
      const bw = rng.float(24, 62) * (1 + tall * 0.5);
      const bd = bw * rng.float(0.7, 1.4);
      m.makeRotationY(Math.round(rng.float(0, 4)) * Math.PI / 2);
      m.scale(_v1.set(bw, bh, bd));
      m.setPosition(x, h + bh / 2, z);
      // A building is a wall. The collider is a sphere around the upper half of
      // the tower — where an aircraft actually meets it — sized from the
      // footprint rather than the height, so a 600 m spire is not a 300 m ball
      // of empty air you die inside.
      const r = Math.max(bw, bd) * 0.55;
      // Tall towers get a stack of colliders up the shaft so the whole height
      // is solid, not just one point on it.
      const spans = Math.min(6, Math.max(1, Math.round(bh / (r * 2))));
      for (let k = 0; k < spans; k++) {
        const y = h + bh * ((k + 0.5) / spans);
        solid(x, y, z, r, 46, 'building');
      }
      return true;
    });
    yield;

    /* --- rock field ------------------------------------------------------
     * Two size bands from two silhouettes: boulders that read from altitude,
     * and a much denser scatter of small stone that fills the ground. */
    const placeRock = (lo, hi, steepOnly) => (i, m) => {
      const x = rand(), z = rand();
      const wx = centerX + x, wz = centerZ + z;
      const h = this.terrain.height(wx, wz);
      if (h < this.terrain.waterLevel) return false;
      // Scree collects on steep ground; boulders sit anywhere.
      if (steepOnly && this.terrain.slope(wx, wz, 50) < 0.22) return false;
      const s = rng.float(lo, hi);
      m.makeRotationY(rng.float(0, TAU));
      m.scale(_v1.set(s, s * rng.float(0.5, 1.1), s * rng.float(0.7, 1.3)));
      m.setPosition(x, h + s * 0.2, z);
      // Boulders are solid; scree is not — you can belly-scrape gravel, you
      // cannot fly through a house-sized rock.
      if (s > 14) solid(x, h + s * 0.5, z, s * 0.85, 34, 'rock');
      return true;
    };
    const rCount = Math.round(420 * p.rocks * d);
    addInstanced(this._propGeos.rock, this._propMats.rock, rCount, placeRock(9, 44, false));
    yield;
    addInstanced(this._propGeos.rock2, this._propMats.rock2,
      Math.round(760 * clamp01(p.rocks + 0.3) * d), placeRock(2.0, 9.0, true));
    yield;

    /* --- masts ------------------------------------------------------------
     * Only where there is settlement to justify them, and only on flat ground,
     * so they read as infrastructure rather than as scattered props. */
    const mCount = Math.round(90 * p.buildings * d);
    addInstanced(this._propGeos.mast, this._propMats.rock, mCount, (i, m) => {
      const x = rand(), z = rand();
      const wx = centerX + x, wz = centerZ + z;
      const h = this.terrain.height(wx, wz);
      if (h < this.terrain.waterLevel + 6) return false;
      if (this.terrain.slope(wx, wz, 90) > 0.22) return false;
      const s = rng.float(1.0, 3.4);
      const vs = s * rng.float(0.8, 2.2);
      m.makeRotationY(rng.float(0, TAU));
      m.scale(_v1.set(s, vs, s));
      m.setPosition(x, h, z);
      // The mast geometry is 28 units tall before scaling.
      solid(x, h + 28 * vs * 0.6, z, Math.max(9, 28 * vs * 0.35), 40, 'mast');
      return true;
    });
  }

  /* ---------------------------------------------------------------------
   * CHUNK BUILD (generator — time-sliced by the scheduler)
   * ------------------------------------------------------------------ */

  *buildChunk(index) {
    const chunk = this.chunkPool.pop() || new WorldChunk(this, index);
    chunk.index = index;
    chunk.startNode = index * this.nodesPerChunk;
    chunk.endNode = chunk.startNode + this.nodesPerChunk;
    this.path.ensure((chunk.endNode + 6) * this.path.spacing);
    const rng = new RNG(`${this.seed}:chunk:${index}`);
    const D = this.difficulty;

    const first = this.path.nodes[chunk.startNode];
    if (!first) return;
    chunk.group.position.set(0, 0, 0);
    this.scene.add(chunk.group);

    /* --- checkpoints ----------------------------------------------
     * Battle mode is a dogfight in open sky: no gates to fly, and therefore no
     * missed-gate penalties for chasing a target off the route. */
    for (let n = chunk.startNode; !this.mode?.noRings && n < chunk.endNode; n++) {
      const node = this.path.nodes[n];
      if (!node) break;
      if (n % WORLD.checkpointEvery !== 0) continue;
      const cpIndex = Math.floor(n / WORLD.checkpointEvery);
      const kind = rng.weighted([
        { id: 'standard', w: 6 }, { id: 'multi', w: 2 },
        { id: 'moving', w: D.routeComplexity > 0.6 ? 1.4 : 0.4 },
      ]).id;
      const cp = this._buildCheckpoint(node, cpIndex, rng, kind);
      chunk.group.add(cp.object);
      chunk.checkpoints.push(cp);
      if (!this.checkpointList.some((c) => c.id === cp.id)) this.checkpointList.push(cp);
      if (cp.moving) chunk.animated.push(cp);
    }
    yield;

    /* --- race rings ------------------------------------------------- */
    // Battle mode is fought in open airspace: no gate chains to fly through,
    // nothing between you and the hostiles.
    for (let n = chunk.startNode; !this.mode?.noRings && n < chunk.endNode; n++) {
      const node = this.path.nodes[n];
      if (!node) break;
      // One chain every few nodes, not every node — ring chains should be
      // punctuation along the route, not a tunnel of overlapping hoops.
      if (n % 3 !== 0) continue;
      const seg = node.seg;
      const density = (seg.rings || 1) * 1.0;
      if (rng.next() > density * 0.62) continue;
      const chain = rng.int(2, 4);
      const lateralPhase = rng.float(0, TAU);
      const amp = node.radius * rng.float(0.15, 0.55);
      for (let k = 0; k < chain; k++) {
        const d = node.dist + k * (this.path.spacing / chain);
        const s = this.path.sample(d, this._sample);
        const ph = lateralPhase + k * 0.9;
        const pos = s.pos.clone()
          .addScaledVector(s.right, Math.cos(ph) * amp)
          .addScaledVector(s.up, Math.sin(ph) * amp * 0.6);
        const kind = rng.weighted([
          { id: 'standard', w: 6 }, { id: 'boost', w: 2.2 },
          { id: 'precision', w: 1.4 }, { id: 'bonus', w: 0.8 },
          { id: 'risk', w: seg.risk > 0.8 ? 1.2 : 0.3 },
        ]).id;
        const ring = this._buildRing(pos, s.tangent, s.up, kind, rng);
        chunk.group.add(ring.object);
        chunk.rings.push(ring);
        chunk.animated.push(ring);
      }
    }
    yield;

    /* --- obstacles -------------------------------------------------- */
    // Combat needs room to manoeuvre, so the floating obstacle field thins out
    // to a fraction of its racing density rather than disappearing entirely —
    // the airspace still has features to fight around.
    const obsScale = D.obstacleDensity * (this.mode?.escalates ? 1 + Math.min(1.2, index * 0.028) : 1)
      * (this.mode?.noRings ? 0.28 : 1);
    for (let n = chunk.startNode; n < chunk.endNode; n++) {
      const node = this.path.nodes[n];
      if (!node) break;
      const seg = node.seg;
      const count = Math.round((seg.obst || 1) * obsScale * rng.float(0.22, 0.85));
      if (count <= 0) continue;
      // Reserve a free sector so a flyable line always exists through the node.
      const freeAngle = rng.float(0, TAU);
      for (let k = 0; k < count; k++) {
        let a = rng.float(0, TAU);
        // Push obstacles at least 62° away from the reserved corridor.
        const delta = Math.atan2(Math.sin(a - freeAngle), Math.cos(a - freeAngle));
        if (Math.abs(delta) < 1.08) a = freeAngle + Math.sign(delta || 1) * (1.08 + rng.float(0, 1.6));
        // Hug the corridor wall rather than the centre line: obstacles should
        // frame the route and threaten the edges, not sit on the ideal line.
        const r = node.radius * rng.float(0.78, 1.5);
        const along = rng.float(0, this.path.spacing);
        const s = this.path.sample(node.dist + along, this._sample);
        const pos = s.pos.clone()
          .addScaledVector(s.right, Math.cos(a) * r)
          .addScaledVector(s.up, Math.sin(a) * r);
        // Never place an obstacle underground.
        const ground = this.terrain.surface(pos.x, pos.z);
        if (pos.y < ground + 30) pos.y = ground + 30 + rng.float(0, 60);
        const obs = this._buildObstacle(pos, rng, node, obsScale);
        // Final safety: reject anything that ended up inside the reserved line.
        const proj = this.path.project(obs.pos, n, 4);
        if (proj.offset < obs.radius + 55) { disposeObject(obs.object); continue; }
        chunk.group.add(obs.object);
        chunk.addCollider(obs);
        if (obs.spin || obs.hub) chunk.animated.push(obs);
      }
      if (n % 4 === 0) yield;
    }
    yield;

    /* --- clouds ------------------------------------------------------ */
    const w = WEATHER[this.weatherId] || WEATHER.clear;
    const cloudCount = Math.round(lerp(3, 11, clamp01(w.cloud)) * this.quality.cloudQuality);
    for (let i = 0; i < cloudCount; i++) {
      const d = lerp(first.dist, first.dist + this.nodesPerChunk * this.path.spacing, rng.next());
      const s = this.path.sample(d, this._sample);
      const dense = s.node.seg.cloudDense;
      // Clouds are scenery, not fog. Normal segments push clusters clear of the
      // flight corridor so the camera never ends up inside a billboard; only a
      // Cloud Tunnel segment deliberately puts you inside the weather.
      const off = s.pos.clone();
      if (dense) {
        off.addScaledVector(s.right, rng.gauss(0, s.radius * 0.9))
          .addScaledVector(s.up, rng.gauss(0, s.radius * 0.7));
      } else {
        const side = rng.sign();
        const lateral = side * (s.radius * 2.2 + Math.abs(rng.gauss(0, 1500)));
        const vertical = rng.bool(0.62)
          ? s.radius * 1.9 + Math.abs(rng.gauss(0, 900))     // deck above the route
          : -(s.radius * 1.9 + Math.abs(rng.gauss(0, 700))); // deck below it
        off.addScaledVector(s.right, lateral).addScaledVector(s.up, vertical);
      }
      const { mesh, geo } = this._buildCloudCluster(off, rng, dense ? 0.55 : 1.15);
      chunk.group.add(mesh);
      chunk.disposables.push(geo);
    }
    yield;

    /* --- landmarks + ground scatter ---------------------------------- */
    if (rng.next() < 0.55) {
      const d = lerp(first.dist, first.dist + this.nodesPerChunk * this.path.spacing, rng.next());
      const s = this.path.sample(d, this._sample);
      const side = rng.sign();
      const lm = this._buildLandmark(rng.pick(this.biome.landmark),
        s.pos.clone().addScaledVector(s.right, side * rng.float(900, 2600)), rng);
      chunk.group.add(lm);
      this._registerStructureColliders(chunk, lm, 26, 52, 'landmark');
      if (lm.userData.spinners) chunk.animated.push({ spinners: lm.userData.spinners });
    }
    yield;

    const mid = this.path.nodes[Math.min(chunk.startNode + this.nodesPerChunk / 2 | 0, this.path.nodes.length - 1)];
    yield* this._buildScatter(chunk, mid.pos.x, mid.pos.z, this.nodesPerChunk * this.path.spacing * 0.55, rng);

    chunk.built = true;
    this.chunks.set(index, chunk);
  }

  /* ---------------------------------------------------------------------
   * STREAMING + UPDATE
   * ------------------------------------------------------------------ */

  /** Queue chunk builds so the player always has content ahead. */
  stream(scheduler, playerDistance) {
    const chunkLen = this.nodesPerChunk * this.path.spacing;
    const current = Math.max(0, Math.floor(playerDistance / chunkLen));
    this.currentChunk = current;
    const from = Math.max(0, current - WORLD.streamBehind);
    const to = current + WORLD.streamAhead;

    for (let i = from; i <= to; i++) {
      if (this.chunks.has(i) || this._queued.has(i)) continue;
      this._queued.add(i);
      const gen = this.buildChunk(i);
      const wrapper = (function* (self, idx, g) {
        try { yield* g; } finally { self._queued.delete(idx); }
      })(this, i, gen);
      scheduler.add(wrapper, to - i, `chunk${i}`);
    }

    // Recycle chunks that fell behind.
    let recycled = false;
    for (const [idx, chunk] of this.chunks) {
      if (idx < from - 1 || idx > to + 2) {
        chunk.dispose(this.scene);
        this.chunks.delete(idx);
        this.chunkPool.push(chunk);
        recycled = true;
      }
    }
    if (recycled) {
      const minNode = (from - 1) * this.nodesPerChunk;
      this.checkpointList = this.checkpointList.filter((cp) => cp.node.index >= minNode);
    }
    this.stats.chunks = this.chunks.size;
  }

  update(dt, focus, elapsed) {
    this.time += dt;
    this._focus.copy(focus);
    this.terrainMesh.update(focus, this.quality.scalars.propDensity > 0.6 ? 2 : 1);

    if (this._cloudMat) {
      this._cloudMat.uniforms.uTime.value = this.time;
      this._cloudMat.uniforms.uFogColor.value.copy(this.render.sky.fogColor);
      this._cloudMat.uniforms.uFogDensity.value = this.scene.fog.density;
      this._cloudMat.uniforms.uLight.value.copy(this.render.sky.sunColor).lerp(_c1.set(0xffffff), 0.4);
    }

    // Wind + turbulence.
    const w = WEATHER[this.weatherId] || WEATHER.clear;
    const gust = fbm2(this.time * 0.09, 0, this.seed, 3);
    const dir = fbm2(0, this.time * 0.05, this.seed + 3, 2) * Math.PI;
    const speed = w.wind * (16 + gust * 22) * this.difficulty.turbulence;
    this.windVec.set(Math.sin(dir) * speed, gust * speed * 0.28, Math.cos(dir) * speed);
    this.turbulence = clamp01(w.turb * this.difficulty.turbulence * (0.55 + gust * 0.5));

    // Lightning.
    if (w.lightning > 0.01) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = lerp(9, 1.6, w.lightning) * (0.5 + Math.random());
        this.render.lighting.strike(0.6 + Math.random() * 0.7 * w.lightning);
        this.onLightning?.();
      }
    }

    // Animated content.
    let colliderCount = 0;
    for (const chunk of this.chunks.values()) {
      colliderCount += chunk.colliders.length;
      for (const a of chunk.animated) {
        if (a.spinners) { for (const s of a.spinners) s.rotation.z += dt * (s.userData.spin || 1); continue; }
        if (a.hub) { a.hub.rotation.z += dt * (a.hub.userData.spin || 1); continue; }
        if (a.isRing) { a.object.rotateZ(dt * a.spin); continue; }
        if (a.isCheckpoint && a.moving) {
          a.phase += dt * 0.6;
          a.pos.copy(a.basePos)
            .addScaledVector(a.node.right, Math.sin(a.phase) * a.amp)
            .addScaledVector(a.node.up, Math.cos(a.phase * 0.7) * a.amp * 0.45);
          a.object.position.copy(a.pos);
          continue;
        }
        if (a.spin) a.object.rotation.z += dt * a.spin;
      }
    }
    this.stats.colliders = colliderCount;

    // Procedural events.
    this.eventTimer -= dt;
    if (this.eventTimer <= 0 && this.mode?.escalates !== false) {
      this.eventTimer = lerp(46, 20, this.difficulty.routeComplexity) * (0.6 + Math.random() * 0.9);
      this._triggerEvent();
    }
    if (this.activeEvent) {
      this.activeEvent.time -= dt;
      if (this.activeEvent.time <= 0) {
        this.onEventEnd?.(this.activeEvent);
        this.activeEvent = null;
      }
    }
  }

  _triggerEvent() {
    const pool = [
      { id: 'storm', name: 'STORM FRONT', desc: 'Weather closing in', dur: 26, weather: 'storm' },
      { id: 'turbulence', name: 'SEVERE TURBULENCE', desc: 'Hold the line', dur: 18, turb: 2.2 },
      { id: 'debris', name: 'DEBRIS FIELD', desc: 'Obstacles ahead', dur: 20 },
      { id: 'traffic', name: 'TRAFFIC SURGE', desc: 'Civilian aircraft in the corridor', dur: 22, traffic: 2.2 },
      { id: 'blackout', name: 'CLOUD BLACKOUT', desc: 'Visibility dropping', dur: 16, weather: 'denseCloud' },
      { id: 'lowpass', name: 'LOW ALTITUDE ALERT', desc: 'Terrain rising fast', dur: 20 },
      { id: 'speed', name: 'HIGH SPEED SECTION', desc: 'Clear air — push it', dur: 20, bonus: true },
      { id: 'gates', name: 'GATE CHALLENGE', desc: 'Bonus rings ahead', dur: 24, bonus: true },
    ];
    const ev = pool[Math.floor(Math.random() * pool.length)];
    this.activeEvent = { ...ev, time: ev.dur };
    if (ev.weather && ev.weather !== this.weatherId) this.transitionWeather(ev.weather, 6, ev.dur);
    this.onEvent?.(this.activeEvent);
  }

  transitionWeather(newWeather, fade = 5, revertAfter = 0) {
    if (!WEATHER[newWeather]) return;
    this._prevWeather = revertAfter ? this.weatherId : null;
    this.weatherId = newWeather;
    this.render.setVenue(this.biome, newWeather, this.timeId);
    this.render.vfx.setWeather(newWeather, 1);
    if (revertAfter) {
      clearTimeout(this._revertTimer);
      this._revertTimer = setTimeout(() => {
        if (this._prevWeather) {
          this.weatherId = this._prevWeather;
          this.render.setVenue(this.biome, this._prevWeather, this.timeId);
          this.render.vfx.setWeather(this._prevWeather, 1);
          this._prevWeather = null;
        }
      }, revertAfter * 1000);
    }
  }

  /* ---------------------------------------------------------------------
   * QUERIES
   * ------------------------------------------------------------------ */

  /**
   * Collect colliders within `radius` of a point. Covers both static chunk
   * content and dynamic colliders (traffic), which the AI layer registers here.
   */
  /**
   * Nearest thing the aircraft will hit if it holds this heading.
   *
   * Sweeps a capsule of `clearance` metres down the flight vector and returns
   * the closest collider it would strike, with the distance to impact. Used by
   * the HUD collision warning, so it deliberately looks a long way ahead —
   * at Mach 15 the airframe covers 5 km a second and a warning that only fires
   * at 500 m is a warning that arrives after the crash.
   *
   * @returns {{collider:Object, distance:number}|null}
   */
  forwardHazard(from, dir, maxDist, clearance = 90) {
    let best = null, bestT = maxDist;
    const scan = (c) => {
      _v2.subVectors(c.pos, from);
      const t = _v2.dot(dir);                       // distance along the heading
      if (t < 0 || t > bestT) return;
      // Perpendicular miss distance from the flight line.
      const perp2 = _v2.lengthSq() - t * t;
      const hit = c.radius + clearance;
      if (perp2 > hit * hit) return;
      bestT = t; best = c;
    };
    for (const chunk of this.chunks.values()) {
      // Reject a chunk unless the swept segment could reach it at all.
      _v3.copy(from).addScaledVector(dir, maxDist * 0.5);
      if (!chunk.mayContain(_v3, maxDist * 0.5 + clearance)) continue;
      for (const c of chunk.colliders) scan(c);
    }
    for (const c of this.dynamicColliders) if (c.active) scan(c);
    return best ? { collider: best, distance: bestT } : null;
  }

  queryColliders(pos, radius, out = this._colliderScratch) {
    out.length = 0;
    for (const chunk of this.chunks.values()) {
      if (!chunk.mayContain(pos, radius)) continue;
      for (const c of chunk.colliders) {
        const rr = radius + c.radius;
        if (c.pos.distanceToSquared(pos) < rr * rr) out.push(c);
      }
    }
    for (const c of this.dynamicColliders) {
      if (!c.active) continue;
      const rr = radius + c.radius;
      if (c.pos.distanceToSquared(pos) < rr * rr) out.push(c);
    }
    return out;
  }

  nearbyCheckpoints(nodeIndex, span = 2) {
    return this.checkpointList.filter((cp) => Math.abs(cp.node.index - nodeIndex) < span * WORLD.checkpointEvery);
  }

  nextCheckpoint(fromId) {
    let best = null;
    for (const cp of this.checkpointList) {
      if (cp.id < fromId || cp.passed) continue;
      if (!best || cp.id < best.id) best = cp;
    }
    return best;
  }

  ringsNear(pos, radius) {
    const out = [];
    for (const chunk of this.chunks.values()) {
      for (const r of chunk.rings) {
        if (r.collected) continue;
        if (r.pos.distanceToSquared(pos) < radius * radius) out.push(r);
      }
    }
    return out;
  }

  terrainHeight(x, z) { return this.terrain.surface(x, z); }

  dispose() {
    clearTimeout(this._revertTimer);
    for (const chunk of this.chunks.values()) chunk.dispose(this.scene);
    for (const chunk of this.chunkPool) chunk.dispose(this.scene);
    this.chunks.clear(); this.chunkPool.length = 0;
    this.terrainMesh.dispose();
    for (const g of Object.values(this._propGeos || {})) g?.dispose?.();
    this._cloudMat?.dispose();
    this.checkpointList.length = 0;
    this.dynamicColliders = [];
  }
}
