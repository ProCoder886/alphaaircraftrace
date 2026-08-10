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
  if (kind === 'conifer' || kind === 'pine') {
    // Pine is the taller, sparser cousin: fewer, narrower tiers on a longer bole.
    const pine = kind === 'pine';
    const trunk = new THREE.CylinderGeometry(0.8, 1.3, pine ? 12 : 8, 5);
    trunk.translate(0, pine ? 6 : 4, 0);
    parts.push(trunk);
    const tiers = pine ? 3 : 3;
    for (let i = 0; i < tiers; i++) {
      const r = (pine ? 4.2 : 5.2) - i * (pine ? 1.1 : 1.4);
      const h = (pine ? 8 : 9) - i * 1.6;
      const c = new THREE.ConeGeometry(r, h, 7);
      c.translate(0, (pine ? 11 : 8) + i * (pine ? 4.4 : 5.2), 0);
      parts.push(c);
    }
  } else if (kind === 'broadleaf' || kind === 'rosewood' || kind === 'gulmohar') {
    // Rosewood is tall with a high narrow crown; gulmohar is the flame tree —
    // low, very wide and flat-topped. Same two primitives, different proportions,
    // and the species colour does the rest.
    const tall = kind === 'rosewood';
    const wide = kind === 'gulmohar';
    const th = tall ? 11 : wide ? 5 : 7;
    const trunk = new THREE.CylinderGeometry(tall ? 0.8 : 1.1, tall ? 1.3 : 1.8, th, 5);
    trunk.translate(0, th / 2, 0);
    parts.push(trunk);
    const crown = new THREE.IcosahedronGeometry(wide ? 8 : 6, 0);
    crown.scale(wide ? 1.25 : 1, wide ? 0.45 : tall ? 0.95 : 0.82, wide ? 1.25 : 1);
    crown.translate(0, th + (wide ? 2.4 : 4), 0);
    parts.push(crown);
    if (wide) {
      // A second, offset canopy layer so the flame tree reads as a spreading
      // umbrella rather than a squashed ball.
      const c2 = new THREE.IcosahedronGeometry(6, 0);
      c2.scale(1.1, 0.36, 1.1);
      c2.translate(1.4, th + 4.4, -1.1);
      parts.push(c2);
    }
  } else if (kind === 'dead') {
    // No canopy at all — bare forks. What is left after a burn or a flood.
    const trunk = new THREE.CylinderGeometry(0.35, 1.4, 13, 5);
    trunk.translate(0, 6.5, 0);
    parts.push(trunk);
    for (let i = 0; i < 4; i++) {
      const b = new THREE.CylinderGeometry(0.14, 0.45, 5.5, 4);
      b.translate(0, 2.75, 0);
      b.rotateZ(0.7 + (i % 2) * 0.25);
      b.rotateY((i / 4) * TAU);
      b.translate(0, 8 + i * 1.1, 0);
      parts.push(b);
    }
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

/**
 * Per-species foliage tint, derived from the location's base ground colour so a
 * pine in Emerald Basin and a pine in Titan Range are the same species in two
 * different lights rather than the same swatch pasted twice.
 */
const TREE_TINT = {
  pine:      { h: -0.02, s: 0.10, l: -0.14 },
  conifer:   { h: 0.00,  s: 0.08, l: -0.06 },
  broadleaf: { h: 0.03,  s: 0.14, l: 0.04 },
  rosewood:  { h: -0.05, s: 0.16, l: -0.02 },
  gulmohar:  { h: -0.32, s: 0.55, l: 0.16 },  // flame tree — red-orange canopy
  palm:      { h: 0.05,  s: 0.20, l: 0.02 },
  karst:     { h: 0.02,  s: 0.06, l: -0.10 },
  dead:      { h: 0.06,  s: -0.45, l: -0.04 },
};

/** Flower bed colours, by kind. */
const FLOWER_TINT = { daffodil: 0xf2d24b, whiteLily: 0xf3f1e6, wild: 0xc06fb4 };


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
 * STRUCTURE LIBRARY — the built environment
 * ------------------------------------------------------------------------
 * `locations.js` names 45 structure kinds. Modelling 45 bespoke buildings would
 * be 45 things to keep in tune for very little gain at the altitude this game is
 * flown at, so each kind instead resolves to one of 17 archetype builders plus a
 * size and a colour. A church and a bank share no geometry; a bank and a
 * government office share a builder but differ in footprint, height and tone,
 * which is the whole of the difference you can see from 400 m up.
 *
 * Dimensions are metres, base sitting on y = 0, centred in XZ — so a placement
 * pass can scale by a jitter factor and derive a collider from w/h/d without
 * measuring the mesh.
 * ======================================================================== */

const S = (arch, w, h, d, color, opt = null) => ({ arch, w, h, d, color, ...(opt || {}) });

export const STRUCTURE_SPECS = {
  /* --- domestic + small commercial ----------------------------------- */
  house:         S('house',  17,  11,  15, 0xbfae94),
  neighbourhood: S('row',    52,  10,  16, 0xc3b39a),
  stiltHouse:    S('stilt',  16,  13,  14, 0xa89478),
  lodge:         S('house',  23,  14,  19, 0x8d7355),
  restaurant:    S('house',  21,   9,  19, 0xc9a26a),
  market:        S('hall',   38,  10,  28, 0xd0c3a4),
  gasStation:    S('hall',   30,   8,  22, 0xd9d2c4),
  truckStop:     S('hall',   40,   9,  27, 0xcfc8ba),
  well:          S('tank',    7,   6,   7, 0x7a7469),

  /* --- civic + institutional ----------------------------------------- */
  apartment:     S('block',  34,  46,  26, 0xb0a693),
  hotel:         S('block',  40,  62,  28, 0xcbbfa8),
  office:        S('block',  38,  54,  30, 0x9aa3ab),
  government:    S('block',  56,  34,  38, 0xd6d0c2),
  bank:          S('block',  36,  40,  30, 0xc4bda9),
  school:        S('block',  54,  18,  30, 0xd2c2a2),
  hospital:      S('block',  46,  34,  34, 0xe0ddd4),
  policeStation: S('block',  30,  16,  24, 0x8f9aa6),
  fireStation:   S('hall',   32,  14,  24, 0x9c3b33),
  cinema:        S('hall',   40,  16,  32, 0x7a5e72),
  mall:          S('hall',   66,  18,  48, 0xb8b2a6),

  /* --- industrial ----------------------------------------------------- */
  warehouse:     S('hall',   58,  15,  36, 0xa8a49a),
  industrial:    S('hall',   64,  20,  42, 0x8e8a82),
  factory:       S('hall',   70,  22,  46, 0x7d7a74),
  construction:  S('frame',  34,  44,  28, 0xb08a3e),
  powerStation:  S('tank',   26,  34,  26, 0x9a9690),
  waterTreatment:S('tank',   30,  14,  30, 0x8fa0a4),
  floodStation:  S('tank',   22,  18,  22, 0x7f8c94),
  miningRig:     S('frame',  26,  38,  22, 0x7a6a56),
  solarFarm:     S('panels', 70,   6,  50, 0x2c3648),
  waterTower:    S('tank',   14,  30,  14, 0xa2a8a4),
  dock:          S('dock',   46,   8,  20, 0x7d6a52),

  /* --- rural ---------------------------------------------------------- */
  farm:          S('farm',   40,  16,  26, 0x9c5f42),
  barn:          S('hall',   28,  15,  19, 0x8f4a3a),
  windmill:      S('windmill', 12, 30, 12, 0xd8d2c4),

  /* --- tall ----------------------------------------------------------- */
  skyscraper:    S('tower',  40, 190,  40, 0x8d939b),
  glassTower:    S('glass',  38, 240,  38, 0x4a6f86, { glass: true }),
  twinTowers:    S('twin',   86, 210,  36, 0x7f858d, { glass: true }),
  commsTower:    S('lattice',18,  96,  18, 0x9b6f5c),
  observatory:   S('dome',   30,  26,  30, 0xdcdcdc),
  researchStation:S('dome',  26,  18,  26, 0xc8ccd0),
  rescueStation: S('block',  26,  15,  20, 0xc2662f),
  skiResort:     S('house',  44,  20,  26, 0x7d6a58),

  /* --- monumental + sacred -------------------------------------------- */
  church:        S('spire',  26,  46,  38, 0xcfc7b4),
  statue:        S('statue', 14,  34,  14, 0x8a8f86),
  monument:      S('statue', 18,  54,  18, 0xb9b4a6),
};

/** Fallback so a typo in a location's `styles` list degrades to a building. */
const DEFAULT_SPEC = STRUCTURE_SPECS.house;

/**
 * Build one structure archetype as a merged geometry, normalised to a 1×1×1 box
 * centred in XZ with its base on y = 0. Placement then scales by the spec's
 * w/h/d, so every archetype shares one instanced draw call per (kind, material)
 * pair and a collider can be derived from the spec alone.
 */
function makeStructureGeometry(arch) {
  const parts = [];
  const box = (w, h, d, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y + h / 2, z);
    parts.push(g);
    return g;
  };
  switch (arch) {
    case 'house': {
      box(1, 0.62, 1, 0, 0, 0);
      // Pitched roof: a 4-sided cone reads as a hip roof and costs 6 triangles.
      const roof = new THREE.ConeGeometry(0.78, 0.42, 4);
      roof.rotateY(Math.PI / 4);
      roof.translate(0, 0.83, 0);
      parts.push(roof);
      break;
    }
    case 'row': {
      // A terrace: four narrow houses sharing party walls.
      for (let i = 0; i < 4; i++) {
        const x = -0.375 + i * 0.25;
        box(0.24, 0.55 + (i % 2) * 0.12, 1, x, 0, 0);
        const roof = new THREE.ConeGeometry(0.19, 0.3, 4);
        roof.rotateY(Math.PI / 4);
        roof.translate(x, 0.55 + (i % 2) * 0.12 + 0.15, 0);
        parts.push(roof);
      }
      break;
    }
    case 'stilt': {
      // Raised deck on piles — the delta and floodplain vernacular.
      for (const [sx, sz] of [[-0.36, -0.36], [0.36, -0.36], [-0.36, 0.36], [0.36, 0.36]]) {
        box(0.08, 0.4, 0.08, sx, 0, sz);
      }
      box(1, 0.42, 1, 0, 0.4, 0);
      const roof = new THREE.ConeGeometry(0.8, 0.3, 4);
      roof.rotateY(Math.PI / 4);
      roof.translate(0, 0.97, 0);
      parts.push(roof);
      break;
    }
    case 'block': {
      // Slab with a plinth and a set-back crown — the generic mid-rise.
      box(1, 0.06, 1, 0, 0, 0);
      box(0.92, 0.82, 0.92, 0, 0.06, 0);
      box(0.6, 0.12, 0.6, 0, 0.88, 0);
      break;
    }
    case 'hall': {
      // Wide shed with a shallow barrel roof and a service block on the end.
      box(1, 0.72, 1, 0, 0, 0);
      const roof = new THREE.CylinderGeometry(0.52, 0.52, 1, 9, 1, false, 0, Math.PI);
      roof.rotateZ(Math.PI / 2);
      roof.rotateY(Math.PI / 2);
      roof.scale(1, 1, 0.5);
      roof.translate(0, 0.72, 0);
      parts.push(roof);
      box(0.22, 0.34, 0.3, 0.5, 0.72, -0.28);
      break;
    }
    case 'tower': {
      // Stepped shaft: three set-backs so a skyline has silhouette variety.
      box(1, 0.5, 1, 0, 0, 0);
      box(0.78, 0.32, 0.78, 0, 0.5, 0);
      box(0.54, 0.16, 0.54, 0, 0.82, 0);
      box(0.1, 0.08, 0.1, 0, 0.98, 0);
      break;
    }
    case 'glass': {
      // Single clean prism, slightly tapered — reads as curtain wall.
      const g = new THREE.CylinderGeometry(0.62, 0.72, 1, 4, 1);
      g.rotateY(Math.PI / 4);
      g.translate(0, 0.5, 0);
      parts.push(g);
      box(0.1, 0.1, 0.1, 0, 1, 0);
      break;
    }
    case 'twin': {
      // Two shafts on a shared podium, joined by a sky bridge.
      box(1, 0.08, 0.9, 0, 0, 0);
      box(0.36, 0.92, 0.9, -0.32, 0.08, 0);
      box(0.36, 0.92, 0.9, 0.32, 0.08, 0);
      box(0.28, 0.05, 0.4, 0, 0.62, 0);
      break;
    }
    case 'spire': {
      // Nave, transept and steeple.
      box(0.5, 0.42, 1, 0, 0, 0);
      box(1, 0.34, 0.42, 0, 0, 0);
      box(0.3, 0.7, 0.3, 0, 0, -0.36);
      const steeple = new THREE.ConeGeometry(0.22, 0.34, 4);
      steeple.rotateY(Math.PI / 4);
      steeple.translate(0, 0.85, -0.36);
      parts.push(steeple);
      break;
    }
    case 'dome': {
      box(1, 0.42, 1, 0, 0, 0);
      const d = new THREE.SphereGeometry(0.44, 12, 7, 0, TAU, 0, Math.PI / 2);
      d.translate(0, 0.42, 0);
      parts.push(d);
      break;
    }
    case 'tank': {
      // Cylinder on legs — silo, water tower, digester, wellhead.
      for (const [sx, sz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
        box(0.07, 0.62, 0.07, sx, 0, sz);
      }
      const t = new THREE.CylinderGeometry(0.5, 0.5, 0.34, 10);
      t.translate(0, 0.79, 0);
      parts.push(t);
      const cap = new THREE.ConeGeometry(0.5, 0.16, 10);
      cap.translate(0, 1.04, 0);
      parts.push(cap);
      break;
    }
    case 'frame': {
      // Open steelwork: crane mast, rig derrick, half-built floorplate.
      box(0.9, 0.05, 0.9, 0, 0, 0);
      for (const [sx, sz] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) {
        box(0.07, 1, 0.07, sx, 0, sz);
      }
      for (let i = 1; i <= 4; i++) box(0.9, 0.03, 0.9, 0, i * 0.2, 0);
      box(0.06, 0.4, 0.06, 0.4, 1, 0.4);   // crane mast
      box(0.7, 0.05, 0.06, 0.1, 1.36, 0.4); // jib
      break;
    }
    case 'lattice': {
      // Guyed comms mast: tapered lattice with dish arms.
      const shaft = new THREE.CylinderGeometry(0.06, 0.18, 1, 5);
      shaft.translate(0, 0.5, 0);
      parts.push(shaft);
      for (const y of [0.5, 0.7, 0.86]) box(0.7, 0.03, 0.03, 0, y, 0);
      for (const y of [0.5, 0.7, 0.86]) box(0.03, 0.03, 0.7, 0, y, 0);
      const dish = new THREE.SphereGeometry(0.12, 8, 5, 0, TAU, 0, Math.PI / 2);
      dish.rotateX(-Math.PI / 2.4);
      dish.translate(0.2, 0.76, 0);
      parts.push(dish);
      const cap = new THREE.ConeGeometry(0.05, 0.14, 5);
      cap.translate(0, 1.05, 0);
      parts.push(cap);
      break;
    }
    case 'panels': {
      // Solar array: rows of tilted planes over a low frame.
      for (let r = 0; r < 5; r++) {
        const p = new THREE.BoxGeometry(0.94, 0.02, 0.13);
        p.rotateX(-0.5);
        p.translate(0, 0.16, -0.4 + r * 0.2);
        parts.push(p);
        box(0.9, 0.09, 0.02, 0, 0, -0.4 + r * 0.2);
      }
      break;
    }
    case 'dock': {
      // Jetty and a shed — placed at the waterline.
      box(1, 0.14, 0.5, 0, 0, 0.2);
      for (let i = 0; i < 5; i++) box(0.05, 0.4, 0.05, -0.4 + i * 0.2, -0.3, 0.2);
      box(0.36, 0.6, 0.34, -0.26, 0.14, -0.2);
      const roof = new THREE.ConeGeometry(0.3, 0.26, 4);
      roof.rotateY(Math.PI / 4);
      roof.translate(-0.26, 0.83, -0.2);
      parts.push(roof);
      break;
    }
    case 'farm': {
      // Farmhouse plus a long open barn — the rural pair, one placement.
      box(0.42, 0.55, 0.6, -0.28, 0, 0);
      const roof = new THREE.ConeGeometry(0.36, 0.3, 4);
      roof.rotateY(Math.PI / 4);
      roof.translate(-0.28, 0.55, 0);
      parts.push(roof);
      box(0.46, 0.4, 0.9, 0.27, 0, 0);
      const barnRoof = new THREE.CylinderGeometry(0.26, 0.26, 0.9, 7, 1, false, 0, Math.PI);
      barnRoof.rotateZ(Math.PI / 2);
      barnRoof.rotateY(Math.PI / 2);
      barnRoof.translate(0.27, 0.4, 0);
      parts.push(barnRoof);
      break;
    }
    case 'windmill': {
      const body = new THREE.CylinderGeometry(0.28, 0.42, 0.82, 8);
      body.translate(0, 0.41, 0);
      parts.push(body);
      const cap = new THREE.ConeGeometry(0.3, 0.2, 8);
      cap.translate(0, 0.92, 0);
      parts.push(cap);
      // Sails are baked in rather than animated: this is an instanced kind, and
      // per-instance rotation would cost a draw call each. `windmillRidge` in the
      // landmark builder is the one that actually turns.
      for (let i = 0; i < 4; i++) {
        const s = new THREE.BoxGeometry(0.7, 0.11, 0.03);
        s.translate(0.35, 0, 0);
        s.rotateZ((i / 4) * TAU);
        s.translate(0, 0.78, 0.34);
        parts.push(s);
      }
      break;
    }
    case 'statue': {
      box(0.9, 0.16, 0.9, 0, 0, 0);
      box(0.6, 0.3, 0.6, 0, 0.16, 0);
      const figure = new THREE.CylinderGeometry(0.14, 0.22, 0.4, 7);
      figure.translate(0, 0.66, 0);
      parts.push(figure);
      const head = new THREE.SphereGeometry(0.12, 8, 6);
      head.translate(0, 0.92, 0);
      parts.push(head);
      box(0.5, 0.07, 0.07, 0, 0.78, 0);
      break;
    }
    default:
      box(1, 1, 1, 0, 0, 0);
  }
  return mergeGeometriesSafe(parts);
}

/**
 * Ground vehicle silhouettes. Tiny geometry — traffic is only ever read from the
 * air — but the proportions differ enough that a bus is not a car and a fuel
 * truck is not a van. Built 1 unit long, base on y = 0, nose toward +Z.
 */
function makeVehicleGeometry(kind) {
  const parts = [];
  const box = (w, h, d, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y + h / 2, z);
    parts.push(g);
  };
  switch (kind) {
    case 'bus':
      box(2.5, 3.0, 12, 0, 0.5, 0);
      box(2.4, 0.4, 11, 0, 3.4, 0);
      break;
    case 'truck':
    case 'construction':
      box(2.6, 2.6, 4, 0, 0.6, 3.4);
      box(2.8, 3.2, 8, 0, 0.6, -2.2);
      break;
    case 'fuelTruck':
      box(2.6, 2.6, 4, 0, 0.6, 3.4);
      {
        const tank = new THREE.CylinderGeometry(1.5, 1.5, 8, 8);
        tank.rotateX(Math.PI / 2);
        tank.translate(0, 2.2, -2.2);
        parts.push(tank);
      }
      break;
    case 'fireTruck':
      box(2.6, 2.8, 4, 0, 0.6, 3.2);
      box(2.6, 2.2, 8, 0, 0.6, -2.4);
      box(0.5, 0.5, 9, 0, 2.9, -2);
      break;
    case 'ambulance':
    case 'van':
      box(2.3, 1.9, 2.6, 0, 0.5, 2.4);
      box(2.4, 2.8, 5, 0, 0.5, -1.2);
      break;
    case 'tractor':
      box(2.0, 2.2, 3.2, 0, 1.0, 0.4);
      {
        const w1 = new THREE.CylinderGeometry(1.5, 1.5, 0.6, 8);
        w1.rotateZ(Math.PI / 2);
        w1.translate(0, 1.5, -1.4);
        parts.push(w1);
      }
      break;
    default: // car / taxi / police — a saloon
      box(2.1, 1.1, 5.2, 0, 0.4, 0);
      box(1.9, 1.0, 2.6, 0, 1.5, -0.2);
      break;
  }
  // Wheels: one merged band per side rather than four cylinders.
  box(2.4, 0.7, kind === 'bus' ? 11 : 6, 0, 0, kind === 'bus' ? 0 : 0);
  return mergeGeometriesSafe(parts);
}

/**
 * A flower bed. Deliberately not individual flowers — a bed is one small patch
 * of crossed coloured quads over a darker base, scattered in the hundreds so the
 * grassland has colour breaking it up when you are down low.
 */
function makeFlowerGeometry() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const p = new THREE.PlaneGeometry(1.6, 0.9);
    p.translate(0, 0.45, 0);
    p.rotateY((i / 4) * Math.PI);
    parts.push(p);
  }
  const cap = new THREE.PlaneGeometry(1.7, 1.7);
  cap.rotateX(-Math.PI / 2);
  cap.translate(0, 0.86, 0);
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
    // Road, river and lake sample lists are rebuilt from scratch on every build,
    // so a recycled chunk must not inherit the previous one's geography — the
    // traffic pass would otherwise drive along roads that are no longer here.
    this.roadPaths = null;
    this.riverPaths = null;
    this.lakes = null;
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
    this._initStructureGeometries();
    this._initFloraGeometries();
  }

  /* ---------------------------------------------------------------------
   * SHARED LIBRARIES
   * ------------------------------------------------------------------
   * Structures, vehicles and flora are all instanced, so their geometry and
   * materials are built once per world and reused by every chunk. They are
   * marked `shared` on the instanced meshes so chunk disposal never frees them.
   * ------------------------------------------------------------------ */

  /**
   * Resolve this location's `civil.styles` list to the archetypes it actually
   * needs. Building all 17 archetypes for a village that only has houses and a
   * church would be 15 wasted geometries per race.
   */
  _initStructureGeometries() {
    const civil = this.biome.civil || {};
    const styles = civil.styles && civil.styles.length ? civil.styles : ['house', 'barn'];
    const night = this.isNight;
    const neon = (civil.neon || 0) > 0;

    this._structGeos = new Map();   // archetype -> geometry
    this._structMats = new Map();   // colour key -> material
    this._structKinds = [];         // resolved, de-duplicated build list

    for (const kind of styles) {
      const spec = STRUCTURE_SPECS[kind] || DEFAULT_SPEC;
      if (!this._structGeos.has(spec.arch)) {
        this._structGeos.set(spec.arch, makeStructureGeometry(spec.arch));
      }
      this._structKinds.push({ kind, spec });
    }

    // Materials. Facade-mapped for anything with occupied floors so windows light
    // up at night; flat structural for infrastructure that has no windows to lose.
    this._matFacade = this.materials.building(night);
    this._matGlass = this.materials.structure(neon ? 0x123044 : 0x2c4a5e, 0.9, 0.14);
    this._matConcrete = this.materials.structure(0x9a968e, 0.15, 0.78);
    this._matSteel = this.materials.structure(0x767b82, 0.72, 0.42);
    this._matNeon = this.materials.emissiveBasic(this.biome.accent);
    this._matRoad = this.materials.structure(
      { ice: 0xdfe9ef, wet: 0x2b2f33, flooded: 0x33383a, country: 0x6f6350,
        stone: 0x736c62, mountain: 0x4a4a4c, urban: 0x33363b, neon: 0x1b1f2a,
      }[this.biome.roads?.style] || 0x3a3d41, 0.05, 0.92);
    this._matDirt = this.materials.structure(
      new THREE.Color(this.biome.ground.low).offsetHSL(0.01, -0.14, 0.16).getHex(), 0.02, 0.95);
    this._matMarking = this.materials.emissiveBasic(neon ? this.biome.accent : 0xd8d2be);
  }

  /**
   * Species-resolved flora. `flora.trees` names between two and five species per
   * location; each gets its own geometry and its own tint, which is what stops
   * two green locations reading as the same forest.
   */
  _initFloraGeometries() {
    const flora = this.biome.flora || {};
    const species = flora.trees && flora.trees.length ? flora.trees : ['broadleaf'];
    const base = new THREE.Color(this.biome.ground.base);

    this._floraGeos = new Map();
    this._floraMats = new Map();
    this._floraSpecies = [];
    for (const sp of species) {
      if (!this._floraGeos.has(sp)) this._floraGeos.set(sp, makeTreeGeometry(sp));
      if (!this._floraMats.has(sp)) {
        const t = TREE_TINT[sp] || TREE_TINT.broadleaf;
        this._floraMats.set(sp, this.materials.foliage(
          base.clone().offsetHSL(t.h, t.s, t.l).getHex()));
      }
      this._floraSpecies.push(sp);
    }

    const flowers = flora.flowers || [];
    this._flowerGeo = flowers.length ? makeFlowerGeometry() : null;
    this._flowerMats = flowers.map((f) => this.materials.foliage(FLOWER_TINT[f] || 0xd0c060));

    this._vehicleGeos = new Map();
    this._vehicleMats = new Map();
  }

  /** Lazily build a vehicle silhouette + livery. Traffic mixes ~5 kinds a race. */
  _vehicle(kind) {
    if (!this._vehicleGeos.has(kind)) {
      this._vehicleGeos.set(kind, makeVehicleGeometry(kind));
    }
    if (!this._vehicleMats.has(kind)) {
      const colours = {
        car: 0xb8bcc2, taxi: 0xe0b32a, bus: 0x3f6fb0, truck: 0x8d9299, van: 0xd8d8d4,
        ambulance: 0xf0f0ee, police: 0x2b3a52, fireTruck: 0xa8302a,
        construction: 0xd39a2c, fuelTruck: 0x9aa2a8, tractor: 0x4e7a3a,
      };
      this._vehicleMats.set(kind, this.materials.structure(colours[kind] || 0xa0a4a8, 0.5, 0.5));
    }
    return { geo: this._vehicleGeos.get(kind), mat: this._vehicleMats.get(kind) };
  }

  /**
   * Shared instancing helper. Chunk content is placed in chunk-local space and
   * the mesh is offset to (centerX, centerZ), so `place` works in small numbers
   * and float precision holds out at the far end of a long route.
   *
   * `place(i, matrix)` returns false to reject a candidate — every generator
   * rejects against water, slope and altitude, so the requested count is an
   * upper bound and the surviving count is what actually gets drawn.
   */
  _addInstanced(chunk, centerX, centerZ, geo, mat, count, place) {
    if (!geo || !mat || count <= 0) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.userData.shared = true;
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    let n = 0;
    for (let i = 0; i < count; i++) {
      if (place(i, _m1)) mesh.setMatrixAt(n++, _m1);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (n <= 0) { mesh.dispose(); return null; }
    mesh.position.set(centerX, 0, centerZ);
    chunk.group.add(mesh);
    return mesh;
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

    // Resolve the new per-location landmark ids to the original branches.
    const resolve = {
      /* Emerald Basin */ giantRiverBridge: 'archBridge', mountainWaterfall: 'mesaArch',
      riversideStadium: 'generic', botanicalGarden: 'generic', hilltopMonument: 'generic',
      /* Glacier Reach */ glacierObservatory: 'beaconTower', iceArch: 'iceArch',
      iceTunnel: 'generic', frozenWaterfall: 'mesaArch', shelfWall: 'citadel',
      /* Ashfall Flats */ desertStatue: 'generic', abandonedMine: 'bunkerComplex',
      oasis: 'generic', canyonBridge: 'skyBridge', desertPark: 'generic', mesaArch: 'mesaArch',
      /* Verdant Delta */ karstSpire: 'megaSpire', deltaWaterfall: 'mesaArch',
      ruinTemple: 'generic', boatDocks: 'generic', archBridge: 'archBridge',
      /* Hollow Vale */ villageWindmill: 'windmillRidge', hilltopChurch: 'generic',
      countrysideStatue: 'generic', fairground: 'generic', ruralStadium: 'generic',
      golfClubhouse: 'generic',
      /* Drowned Flats */ floodBarrier: 'bunkerComplex', temporaryBridge: 'archBridge',
      submergedTown: 'generic', pumpingStation: 'radarArray',
      /* Meridian Sprawl */ cityStatue: 'generic', centralBankTower: 'ridgeTower',
      twinTowerComplex: 'generic', giantStadium: 'generic', flyoverExchange: 'generic',
      skybridgeNetwork: 'skyBridge',
      /* Titan Range */ mountainStatue: 'generic', suspensionBridge: 'archBridge',
      observatoryDome: 'beaconTower', valleyDam: 'bunkerComplex',
      /* Citadel Siege */ giantCastle: 'citadel', curtainWall: 'citadel',
      gatehouse: 'bunkerComplex', siegeTower: 'megaSpire', fortifiedBridge: 'archBridge',
      battlements: 'generic',
      /* Neon Megacity */ futuristicStatue: 'generic', megaAmusementPark: 'generic',
      observationTower: 'ridgeTower', twinTowerDistrict: 'generic',
      neonSkyway: 'skyBridge', holoArcade: 'generic',
    };
    const resolved = resolve[kind] || 'generic';

    /* Some landmarks are venues at hero scale — a stadium landmark should be a
     * stadium, not a box cluster. Route those straight into the venue builder
     * and let it do the work rather than re-modelling a bowl here. */
    const asVenue = {
      riversideStadium: 'footballStadium', ruralStadium: 'footballStadium',
      giantStadium: 'cricketStadium', mountainStadium: 'footballStadium',
      fairground: 'amusementPark', megaAmusementPark: 'themePark',
      golfClubhouse: 'golfCourse', desertPark: 'sportsGround',
      botanicalGarden: 'golfCourse', holoArcade: 'concertGround',
    }[kind];
    if (asVenue) {
      const v = this._buildVenue(asVenue, pos.x, pos.z, rng);
      if (v) return v;
    }

    if (resolved === 'megaSpire' || resolved === 'ridgeTower' || resolved === 'beaconTower') {
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
    } else if (resolved === 'archBridge' || resolved === 'skyBridge') {
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
    } else if (resolved === 'citadel' || resolved === 'bunkerComplex') {
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
    } else if (resolved === 'mesaArch' || resolved === 'iceArch') {
      const R = rng.float(420, 900);
      const arch = new THREE.Mesh(new THREE.TorusGeometry(R, R * 0.20, 7, 18, Math.PI),
        resolved === 'iceArch' ? this.materials.rock(0xcfe3f2) : this._propMats.rock);
      arch.position.y = ground; g.add(arch);
    } else if (resolved === 'windmillRidge' || resolved === 'solarField') {
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
    } else if (resolved === 'radarArray') {
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
    } else { // generic cluster: the fallback for any unrecognised id
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

  /* ---------------------------------------------------------------------
   * PROCEDURAL WORLD PASSES
   * ------------------------------------------------------------------
   * Each pass is a generator that yields between sub-passes so the chunk
   * scheduler can time-slice a chunk build across several frames instead of
   * dropping one. They run in dependency order from `buildChunk`:
   *
   *   hydrology -> roads -> civil -> venues -> traffic -> scatter
   *
   * Water is placed first because roads bridge it, roads are placed before
   * buildings because settlement follows the road, and scatter runs last so
   * vegetation can be rejected against everything already standing.
   *
   * All of them are seeded from the chunk RNG, so a new race seed relays the
   * whole thing while the location's rule block holds its identity.
   * ------------------------------------------------------------------ */

  /**
   * The settlement mask. One low-frequency noise field per world decides where
   * civilisation is; every civil pass reads it, so towns, roads and traffic all
   * agree about where the town is instead of each scattering independently.
   *
   * ENHANCED: Multi-octave clustering for neighborhood effect.
   * Creates dense urban clusters with gradual falloff for realistic cities.
   * Returns 0..1. `civil.coverage` is the fraction of suitable land that ends up
   * settled — the 50–70% figure in the brief — implemented as a threshold on
   * this field rather than a per-object dice roll, which is what makes a town a
   * town and not a uniform sprinkle of houses.
   */
  _settlement(wx, wz) {
    // Primary settlement field - large neighborhoods
    const n1 = fbm2(wx * 0.00028, wz * 0.00028, this.seed + 917, 4);
    // Secondary clustering - creates district boundaries
    const n2 = fbm2(wx * 0.00055, wz * 0.00055, this.seed + 523, 3);
    // Tertiary detail - adds variety within neighborhoods
    const n3 = fbm2(wx * 0.0012, wz * 0.0012, this.seed + 741, 2);
    
    // Blend for dense clustering effect (75% coverage target)
    const base = n1 * 0.5 + 0.5;
    const cluster = n2 * 0.3 + 0.5;
    const detail = n3 * 0.2 + 0.5;
    
    return clamp01((base * 0.6 + cluster * 0.25 + detail * 0.15) * 1.15);
  }

  /** True where the settlement field clears this location's coverage threshold. */
  _isSettled(wx, wz) {
    const cov = this.biome.civil?.coverage ?? 0.4;
    // ENHANCED: Target 75% architecture coverage for dense cities
    // Boosted coverage threshold to make maps predominantly urban
    const targetCoverage = Math.max(cov, 0.75);  // Minimum 75% coverage
    // coverage 0.75 -> threshold 0.25: the top 75% of the field is architecture
    return this._settlement(wx, wz) > (1 - targetCoverage) * 0.70;
  }

  /**
   * Signed distance-ish field for the river network, in the range -1..1.
   * Zero is the channel centre. Built from ridged noise so the rivers braid and
   * fork the way a real drainage network does rather than running as one line.
   */
  _riverField(wx, wz) {
    const h = this.biome.hydrology || {};
    const s = 0.00019 / Math.max(0.3, h.rivers || 1);
    // ridged2 peaks along ridges; inverting gives valleys to put water in.
    return 1 - ridged2(wx * s, wz * s, this.seed + 4409, 3);
  }

  /**
   * Rivers, lakes, basins, waterfalls, flood plane and ice.
   *
   * Water is drawn as flat discs and ribbons sitting slightly above the terrain
   * surface rather than as a carved heightfield: `TerrainField` is a pure
   * function shared with the AI and the route builder, so carving into it here
   * would desynchronise every other system from the mesh. Placing water on top
   * costs one transparent plane and stays consistent everywhere.
   */
  *_buildHydrology(chunk, cx, cz, extent, rng) {
    const hyd = this.biome.hydrology || {};
    const d = this.quality.propDensity;
    const frozen = !!hyd.frozen;
    const dry = !!hyd.dry;

    const waterMat = frozen
      ? this.materials.structure(0xcfe3ee, 0.1, 0.22)
      : this.materials.water(this.biome.ground.water);
    const bedMat = this.materials.rock(
      new THREE.Color(this.biome.ground.rock).offsetHSL(0, -0.06, dry ? 0.12 : -0.10).getHex());

    /* --- river ribbons ---------------------------------------------------
     * Walk the river field looking for channel crossings and lay a quad strip
     * along each. A dry location gets the bed material and no water, which is
     * exactly what a wadi looks like from the air. */
    const riverCount = Math.round(6 * (hyd.rivers || 0) * clamp01(d + 0.35));
    for (let i = 0; i < riverCount; i++) {
      const startX = rng.float(-extent, extent);
      const startZ = rng.float(-extent, extent);
      const pts = [];
      let px = startX, pz = startZ;
      let dir = rng.float(0, TAU);
      const step = 140;
      for (let k = 0; k < 26; k++) {
        // Follow the downhill gradient, softened by the river field so the
        // channel meanders instead of running straight down the fall line.
        const wx = cx + px, wz = cz + pz;
        const h0 = this.terrain.height(wx, wz);
        if (h0 < this.terrain.waterLevel - 30) break;
        let best = dir, bestH = Infinity;
        for (let a = -1; a <= 1; a++) {
          const t = dir + a * 0.55;
          const hh = this.terrain.height(wx + Math.sin(t) * step, wz + Math.cos(t) * step)
            + this._riverField(wx + Math.sin(t) * step, wz + Math.cos(t) * step) * 120;
          if (hh < bestH) { bestH = hh; best = t; }
        }
        dir = lerp(dir, best, 0.7) + rng.gauss(0, 0.12);
        px += Math.sin(dir) * step;
        pz += Math.cos(dir) * step;
        if (Math.abs(px) > extent * 1.2 || Math.abs(pz) > extent * 1.2) break;
        pts.push({ x: px, z: pz, h: this.terrain.height(cx + px, cz + pz) });
      }
      if (pts.length < 4) continue;
      const width = rng.float(34, 110) * (0.6 + (hyd.rivers || 1) * 0.5);
      const ribbon = this._ribbonGeometry(pts, width, 4);
      if (!ribbon) continue;
      const mesh = new THREE.Mesh(ribbon, dry ? bedMat : waterMat);
      mesh.position.set(cx, 0, cz);
      mesh.renderOrder = -1;
      chunk.group.add(mesh);
      chunk.disposables.push(ribbon);
      chunk.riverPaths = chunk.riverPaths || [];
      chunk.riverPaths.push({ pts, width });

      /* Waterfalls: where the channel drops hard between two samples, hang a
       * vertical sheet down the step. Only where the location has them. */
      if (!dry && (hyd.waterfalls || 0) > 0) {
        for (let k = 1; k < pts.length; k++) {
          const drop = pts[k - 1].h - pts[k].h;
          if (drop < 90 || rng.next() > (hyd.waterfalls || 0) * 0.5) continue;
          const fall = new THREE.PlaneGeometry(width * 0.9, drop);
          const fm = new THREE.Mesh(fall, waterMat);
          const ang = Math.atan2(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
          fm.rotation.y = ang + Math.PI / 2;
          fm.position.set(cx + pts[k].x, pts[k].h + drop / 2, cz + pts[k].z);
          chunk.group.add(fm);
          chunk.disposables.push(fall);
          break; // one hero fall per river reads better than a staircase
        }
      }
      if (i % 2 === 1) yield;
    }
    yield;

    /* --- lakes, ponds and basins ----------------------------------------
     * ENHANCED 5X: More water bodies for varied terrain.
     * Placed in terrain depressions found by sampling: a candidate is a lake if
     * the ground around it is higher than the centre in every direction. */
    const lakeCount = Math.round(25 * ((hyd.lakes || 0) + (hyd.basins || 0) * 0.6) * clamp01(d + 0.3));
    for (let i = 0; i < lakeCount; i++) {
      const x = rng.float(-extent, extent), z = rng.float(-extent, extent);
      const wx = cx + x, wz = cz + z;
      const h = this.terrain.height(wx, wz);
      if (h < this.terrain.waterLevel) continue;
      if (this.terrain.slope(wx, wz, 120) > 0.14) continue;
      const r = rng.float(120, 480) * (0.7 + (hyd.lakes || 0.5));
      // Depression test: the rim has to sit above the centre on all four sides.
      let rim = 0;
      for (let a = 0; a < 4; a++) {
        const t = (a / 4) * TAU;
        if (this.terrain.height(wx + Math.sin(t) * r, wz + Math.cos(t) * r) > h + 4) rim++;
      }
      if (rim < 3) continue;
      const geo = new THREE.CircleGeometry(r, 22);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, dry ? bedMat : waterMat);
      mesh.position.set(wx, h + 3, wz);
      chunk.group.add(mesh);
      chunk.disposables.push(geo);
      chunk.lakes = chunk.lakes || [];
      chunk.lakes.push({ x: wx, z: wz, r, y: h + 3 });
    }
    yield;

    /* --- standing flood water -------------------------------------------
     * Drowned Flats. One large plane a few metres above the low ground, so the
     * landscape reads as a lowland under water rather than a lake next to it. */
    if ((hyd.flood || 0) > 0.5) {
      const size = extent * 2.4;
      const geo = new THREE.PlaneGeometry(size, size, 1, 1);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, waterMat);
      mesh.position.set(cx, this.terrain.waterLevel + 34 * (hyd.flood || 1), cz);
      mesh.renderOrder = -2;
      chunk.group.add(mesh);
      chunk.disposables.push(geo);
    }
  }

  /**
   * Build a flat quad strip through a list of {x, z, h} samples, draped `lift`
   * metres above the terrain. Used for both rivers and roads — the only
   * difference between them is the material and the width.
   */
  _ribbonGeometry(pts, width, lift = 1.5) {
    if (!pts || pts.length < 2) return null;
    const verts = [];
    const idx = [];
    const uvs = [];
    const hw = width * 0.5;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len; tz /= len;
      // Left normal in the ground plane.
      const nx = -tz, nz = tx;
      const p = pts[i];
      verts.push(p.x + nx * hw, p.h + lift, p.z + nz * hw);
      verts.push(p.x - nx * hw, p.h + lift, p.z - nz * hw);
      const v = i / (pts.length - 1);
      uvs.push(0, v, 1, v);
      if (i < pts.length - 1) {
        const o = i * 2;
        idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /**
   * Road network. Main corridors, dirt service tracks, bridges over water and
   * elevated flyovers where the location calls for them.
   *
   * The samples for every road built here are recorded on `chunk.roadPaths` so
   * the traffic pass can drive along the roads that actually exist rather than
   * inventing its own routes and floating vehicles over open ground.
   */
  *_buildRoads(chunk, cx, cz, extent, rng) {
    const r = this.biome.roads || {};
    const d = this.quality.propDensity;
    chunk.roadPaths = [];

    const layRoad = (opts) => {
      const { width, mat, dirt, elevated } = opts;
      // Roads run roughly straight with a slow drift; a road that meanders like
      // a river reads as a footpath, and a perfectly straight one reads as a
      // runway. The drift term is the difference.
      let px = rng.float(-extent, extent), pz = -extent * 1.05;
      let dir = rng.float(-0.5, 0.5);
      const step = 190;
      const pts = [];
      const n = Math.ceil((extent * 2.2) / step);
      for (let k = 0; k <= n; k++) {
        const wx = cx + px, wz = cz + pz;
        const h = this.terrain.height(wx, wz);
        pts.push({ x: px, z: pz, h, wx, wz });
        dir += rng.gauss(0, 0.09);
        dir = clamp(dir, -0.9, 0.9);
        px += Math.sin(dir) * step;
        pz += Math.cos(dir) * step;
      }
      if (pts.length < 3) return;

      /* Grade the road. Real roads cut and fill; letting the ribbon follow the
       * raw heightfield produces a rollercoaster. A three-tap smoothing pass
       * over the sample heights is enough to read as engineered. */
      for (let pass = 0; pass < 3; pass++) {
        for (let k = 1; k < pts.length - 1; k++) {
          pts[k].h = pts[k].h * 0.4 + (pts[k - 1].h + pts[k + 1].h) * 0.3;
        }
      }

      // Deck height: elevated sections and water crossings ride above grade.
      let bridged = 0;
      for (const p of pts) {
        const ground = this.terrain.height(p.wx, p.wz);
        const overWater = ground < this.terrain.waterLevel + 6;
        if (overWater) { p.h = Math.max(p.h, this.terrain.waterLevel + 28); bridged++; }
        if (elevated) p.h = Math.max(p.h, ground + 42);
      }

      const geo = this._ribbonGeometry(pts, width, dirt ? 1.2 : 2.2);
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, 0, cz);
      mesh.receiveShadow = false;
      chunk.group.add(mesh);
      chunk.disposables.push(geo);

      /* Centre line. Skipped on dirt, which has no markings, and emissive in a
       * neon location so the road grid glows from altitude at night. */
      if (!dirt && width > 16) {
        const line = this._ribbonGeometry(pts, 1.6, (dirt ? 1.2 : 2.2) + 0.4);
        if (line) {
          const lm = new THREE.Mesh(line, this._matMarking);
          lm.position.set(cx, 0, cz);
          chunk.group.add(lm);
          chunk.disposables.push(line);
        }
      }

      /* Piers under any raised deck, so a bridge or a flyover has something
       * holding it up and a solid column to fly into. */
      if (bridged > 0 || elevated) {
        for (let k = 2; k < pts.length - 2; k += 3) {
          const p = pts[k];
          const ground = this.terrain.height(p.wx, p.wz);
          const clearance = p.h - ground;
          if (clearance < 16) continue;
          const pier = new THREE.CylinderGeometry(width * 0.14, width * 0.2, clearance, 7);
          const pm = new THREE.Mesh(pier, this._matConcrete);
          pm.position.set(p.wx, ground + clearance / 2, p.wz);
          chunk.group.add(pm);
          chunk.disposables.push(pier);
          chunk.addCollider({
            pos: new THREE.Vector3(p.wx, ground + clearance / 2, p.wz),
            radius: Math.max(12, width * 0.3), damage: 48, type: 'bridge',
            kind: 'structure', soft: false, object: null, spin: 0, hub: null,
          });
        }
      }

      chunk.roadPaths.push({ pts, width, dirt, cx, cz });
    };

    const mainCount = Math.round(3 * (r.main || 0) * clamp01(d + 0.4));
    for (let i = 0; i < mainCount; i++) {
      layRoad({
        width: rng.float(26, 44) * (0.8 + (r.main || 0.5) * 0.5),
        mat: this._matRoad, dirt: false,
        elevated: rng.next() < (r.elevated || 0) * 0.6,
      });
    }
    yield;

    const dirtCount = Math.round(4 * (r.dirt || 0) * clamp01(d + 0.3));
    for (let i = 0; i < dirtCount; i++) {
      layRoad({ width: rng.float(9, 16), mat: this._matDirt, dirt: true, elevated: false });
    }
  }

  /**
   * Civilisation. Towns, districts and skylines, placed against the settlement
   * mask so buildings cluster into places rather than dusting the map.
   *
   * The per-kind instanced meshes are the reason this is affordable: a town of
   * 900 buildings drawn from twelve kinds is twelve draw calls, not 900.
   */
  *_buildCivilDistrict(chunk, cx, cz, extent, rng) {
    const civil = this.biome.civil;
    if (!civil || !this._structKinds.length) return;
    const d = this.quality.propDensity;

    /* INCREASED DENSITY 5X: Base population for the location's settlement scale.
     * Buildings are now 5x more dense with clustering in neighborhoods.
     * Maps are now 75% architecture / 25% free land for denser cities. */
    const scaleCount = {
      village: 650,      // 5x from 130
      town: 1500,        // 5x from 300
      city: 3100,        // 5x from 620
      metropolis: 4500,  // 5x from 900
      megacity: 5500,    // 5x from 1100
    }[civil.scale] || 1300;  // 5x from 260
    
    // Enhanced density multiplier for clustering effect
    const densityMult = (civil.density || 0.5) * 1.3;  // Extra boost for clustering
    const total = Math.round(scaleCount * densityMult * clamp01(d + 0.35));
    if (total <= 0) return;

    const skyline = civil.skyline || 0;
    const night = this.isNight;
    const neon = (civil.neon || 0) > 0;

    // Split the population across the location's kinds. Common kinds get more:
    // ENHANCED: More variety - stadiums, sports complexes, amusement parks
    // a town is mostly houses with one hospital, not equal parts of each.
    const weightFor = (kind) => {
      if (kind === 'house' || kind === 'neighbourhood' || kind === 'stiltHouse') return 6;
      if (kind === 'apartment' || kind === 'office' || kind === 'warehouse') return 3.5;
      // MASSIVE BOOST for skyscrapers and towers (dense urban skylines)
      if (kind === 'skyscraper' || kind === 'glassTower') return 3.5 + skyline * 6;
      if (kind === 'twinTowers' || kind === 'monument' || kind === 'observatory') return 0.8;
      // BOOST for stadiums, malls, and large complexes (amusement parks effect)
      if (kind === 'stadium' || kind === 'mall' || kind === 'powerStation') return 1.5;
      if (kind === 'hospital' || kind === 'government' || kind === 'church') return 0.9;
      return 1.8;
    };
    const weights = this._structKinds.map((k) => weightFor(k.kind));
    const wSum = weights.reduce((a, b) => a + b, 0);

    for (let ki = 0; ki < this._structKinds.length; ki++) {
      const { kind, spec } = this._structKinds[ki];
      const count = Math.max(1, Math.round(total * (weights[ki] / wSum)));
      const geo = this._structGeos.get(spec.arch);

      /* Material choice reads the spec and the location: glass towers get the
       * glass material, infrastructure gets concrete or steel, and anything with
       * floors gets the window-mapped facade so a city lights up after dark. */
      let mat;
      if (spec.glass) mat = this._matGlass;
      else if (['tank', 'frame', 'lattice', 'panels', 'dock'].includes(spec.arch)) mat = this._matSteel;
      else if (['statue', 'spire', 'dome'].includes(spec.arch)) mat = this._matConcrete;
      else mat = this._matFacade;

      const tall = ['tower', 'glass', 'twin'].includes(spec.arch);
      // Water-edge kinds want the shoreline; everything else wants dry, flat land.
      const wantsWater = kind === 'dock' || kind === 'stiltHouse';

      this._addInstanced(chunk, cx, cz, geo, mat, count, (i, m) => {
        const x = rng.float(-extent, extent), z = rng.float(-extent, extent);
        const wx = cx + x, wz = cz + z;
        const h = this.terrain.height(wx, wz);

        if (wantsWater) {
          // Within a few metres of the waterline, either side of it.
          if (Math.abs(h - this.terrain.waterLevel) > 26) return false;
        } else {
          if (h < this.terrain.waterLevel + 5) return false;
          if (h > this.terrain.snowLine * 1.05) return false;
        }
        // Buildings need buildable ground. Tall ones need flatter ground still.
        if (this.terrain.slope(wx, wz, 90) > (tall ? 0.16 : 0.30)) return false;
        if (!wantsWater && !this._isSettled(wx, wz)) return false;

        /* Height. The settlement field doubles as a downtown gradient: the
         * denser the mask, the taller the building, so a skyline peaks at the
         * centre of a district and falls away at the edges the way a real one
         * does. Without this every tower is the same height and the city reads
         * as a barcode. */
        const core = clamp01((this._settlement(wx, wz) - 0.45) * 2.4);
        const hScale = tall
          ? rng.float(0.55, 1.0) * (0.35 + core * 1.5) * (0.5 + skyline)
          : rng.float(0.72, 1.35);
        const wScale = rng.float(0.82, 1.25);

        const bw = spec.w * wScale;
        const bh = Math.max(6, spec.h * hScale);
        const bd = spec.d * wScale * rng.float(0.9, 1.12);

        m.makeRotationY(Math.round(rng.float(0, 8)) * (Math.PI / 4));
        m.scale(_v1.set(bw, bh, bd));
        m.setPosition(x, h - 1, z);

        /* Colliders. Derived from the spec, not from the mesh, because these are
         * instances — there is no per-instance object to walk. Tall shafts get a
         * stack up the height so the whole building is solid rather than one
         * ball of air near the roof. */
        const cr = Math.max(bw, bd) * 0.52;
        const spans = clamp(Math.round(bh / (cr * 1.8)), 1, 5);
        for (let k = 0; k < spans; k++) {
          chunk.addCollider({
            pos: new THREE.Vector3(wx, h + bh * ((k + 0.5) / spans), wz),
            radius: cr, damage: 48, type: 'building', kind: 'structure',
            soft: false, object: null, spin: 0, hub: null,
          });
        }
        return true;
      });

      /* Neon crowns. A megacity at night needs light coming off the buildings,
       * not just window maps: one emissive cap per tall tower, instanced, so the
       * skyline glows for one extra draw call. */
      if (neon && tall && night) {
        const capGeo = this._structGeos.get('glass');
        this._addInstanced(chunk, cx, cz, capGeo, this._matNeon, Math.round(count * 0.5), (i, m) => {
          const x = rng.float(-extent, extent), z = rng.float(-extent, extent);
          const wx = cx + x, wz = cz + z;
          const h = this.terrain.height(wx, wz);
          if (h < this.terrain.waterLevel + 5) return false;
          if (this.terrain.slope(wx, wz, 90) > 0.16) return false;
          if (!this._isSettled(wx, wz)) return false;
          const core = clamp01((this._settlement(wx, wz) - 0.45) * 2.4);
          const bh = Math.max(6, spec.h * rng.float(0.55, 1.0) * (0.35 + core * 1.5) * (0.5 + skyline));
          const s = spec.w * 0.3;
          m.makeRotationY(rng.float(0, TAU));
          m.scale(_v1.set(s, s * 0.5, s));
          m.setPosition(x, h - 1 + bh, z);
          return true;
        });
      }
      if (ki % 3 === 2) yield;
    }
  }

  /**
   * Sports and entertainment venues. One or two per chunk, built as real groups
   * rather than instances: there are only a handful, they are large, and a
   * stadium needs a bowl and a ferris wheel needs to turn.
   * ENHANCED 5X: More venues including stadiums, sports complexes, amusement parks.
   */
  *_buildVenues(chunk, cx, cz, extent, rng) {
    const list = this.biome.venues;
    if (!list || !list.length) return;
    const d = this.quality.propDensity;
    // ENHANCED: 5x more venues for sports complexes and amusement parks
    const count = Math.round(rng.float(3, 12) * clamp01(d + 0.4));

    for (let i = 0; i < count; i++) {
      const kind = rng.pick(list);
      // Venues need a lot of flat ground, so search a few candidates rather
      // than taking the first point and building a stadium on a cliff.
      let px = 0, pz = 0, ok = false;
      for (let t = 0; t < 8; t++) {
        const x = rng.float(-extent * 0.85, extent * 0.85);
        const z = rng.float(-extent * 0.85, extent * 0.85);
        const wx = cx + x, wz = cz + z;
        const h = this.terrain.height(wx, wz);
        if (h < this.terrain.waterLevel + 8) continue;
        if (this.terrain.slope(wx, wz, 200) > 0.12) continue;
        px = x; pz = z; ok = true; break;
      }
      if (!ok) continue;

      const g = this._buildVenue(kind, cx + px, cz + pz, rng);
      if (!g) continue;
      chunk.group.add(g);
      this._registerStructureColliders(chunk, g, 22, 40, 'venue');
      if (g.userData.spinners) chunk.animated.push({ spinners: g.userData.spinners });
      for (const geo of g.userData.geos || []) chunk.disposables.push(geo);
      yield;
    }
  }

  /** One venue as a group at world (wx, wz). */
  _buildVenue(kind, wx, wz, rng) {
    const g = new THREE.Group();
    const geos = [];
    const ground = this.terrain.surface(wx, wz);
    const concrete = this._matConcrete;
    const steel = this._matSteel;
    const accent = this._matNeon;
    const turf = this.materials.foliage(0x2f6b2c);

    const add = (geo, mat, x, y, z, ry = 0) => {
      geos.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      g.add(m);
      return m;
    };

    /** Stadium bowl: an elliptical ring of raked stand plus a pitch. */
    const bowl = (rx, rz, height, pitchMat) => {
      const ring = new THREE.CylinderGeometry(1, 1, height, 30, 1, true);
      ring.scale(rx, 1, rz);
      add(ring, concrete, 0, height / 2, 0);
      const outer = new THREE.CylinderGeometry(1.22, 1.28, height * 0.72, 30, 1, true);
      outer.scale(rx, 1, rz);
      add(outer, concrete, 0, height * 0.36, 0);
      const roof = new THREE.RingGeometry(1, 1.3, 30);
      roof.rotateX(-Math.PI / 2);
      roof.scale(rx, 1, rz);
      add(roof, steel, 0, height, 0);
      const pitch = new THREE.CircleGeometry(1, 26);
      pitch.rotateX(-Math.PI / 2);
      pitch.scale(rx * 0.82, 1, rz * 0.82);
      add(pitch, pitchMat, 0, 2, 0);
      // Floodlight pylons.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4;
        const mast = new THREE.CylinderGeometry(1.4, 2.4, height * 1.7, 6);
        add(mast, steel, Math.sin(a) * rx * 1.15, height * 0.85, Math.cos(a) * rz * 1.15);
        const lamp = new THREE.BoxGeometry(14, 5, 3);
        add(lamp, accent, Math.sin(a) * rx * 1.15, height * 1.7, Math.cos(a) * rz * 1.15,
          a + Math.PI);
      }
    };

    switch (kind) {
      case 'footballStadium':
        bowl(rng.float(130, 175), rng.float(105, 140), rng.float(38, 56), turf);
        break;
      case 'cricketStadium': {
        const r = rng.float(150, 195);
        bowl(r, r, rng.float(34, 48), turf);
        const strip = new THREE.BoxGeometry(9, 0.6, 44);
        add(strip, this.materials.rock(0xb8a882), 0, 2.4, 0);
        break;
      }
      case 'racingArena': {
        bowl(rng.float(170, 220), rng.float(120, 160), rng.float(26, 38),
          this.materials.structure(0x3a3d41, 0.05, 0.9));
        // Track oval inside the bowl.
        const track = new THREE.RingGeometry(0.6, 0.92, 28);
        track.rotateX(-Math.PI / 2);
        track.scale(150, 1, 110);
        add(track, this._matRoad, 0, 3, 0);
        break;
      }
      case 'sportsComplex': {
        for (let i = 0; i < 3; i++) {
          const hall = new THREE.CylinderGeometry(30, 30, 90, 10, 1, false, 0, Math.PI);
          hall.rotateZ(Math.PI / 2);
          hall.rotateY(Math.PI / 2);
          add(hall, steel, (i - 1) * 78, 0, rng.float(-20, 20));
        }
        const pad = new THREE.BoxGeometry(280, 2, 150);
        add(pad, concrete, 0, 1, 0);
        break;
      }
      case 'sportsGround': {
        const pad = new THREE.CircleGeometry(rng.float(90, 140), 20);
        pad.rotateX(-Math.PI / 2);
        add(pad, turf, 0, 1.5, 0);
        for (let i = 0; i < 2; i++) {
          const stand = new THREE.BoxGeometry(120, 14, 22);
          add(stand, concrete, 0, 7, (i ? 1 : -1) * 95);
        }
        break;
      }
      case 'golfCourse': {
        // Greens and bunkers rather than buildings — the read from the air is
        // the mown shapes, not a clubhouse.
        for (let i = 0; i < 7; i++) {
          const green = new THREE.CircleGeometry(rng.float(38, 78), 14);
          green.rotateX(-Math.PI / 2);
          const gx = rng.float(-420, 420), gz = rng.float(-420, 420);
          add(green, turf, gx, this.terrain.height(wx + gx, wz + gz) - ground + 1.5, gz);
          if (rng.bool(0.6)) {
            const sand = new THREE.CircleGeometry(rng.float(12, 26), 10);
            sand.rotateX(-Math.PI / 2);
            add(sand, this.materials.rock(0xd8caa2),
              gx + rng.float(-60, 60),
              this.terrain.height(wx + gx, wz + gz) - ground + 1.8, gz + rng.float(-60, 60));
          }
        }
        const club = new THREE.BoxGeometry(46, 12, 28);
        add(club, this._matFacade, 0, 6, -300);
        break;
      }
      case 'concertGround': {
        // A shell stage facing an open field.
        const shell = new THREE.SphereGeometry(52, 14, 8, 0, Math.PI, 0, Math.PI / 2);
        shell.rotateY(Math.PI / 2);
        add(shell, concrete, 0, 0, -110);
        const stage = new THREE.BoxGeometry(96, 6, 44);
        add(stage, steel, 0, 4, -110);
        const field = new THREE.CircleGeometry(190, 20);
        field.rotateX(-Math.PI / 2);
        add(field, turf, 0, 1.2, 60);
        for (let i = 0; i < 6; i++) {
          const tower = new THREE.BoxGeometry(5, 40, 5);
          add(tower, steel, rng.float(-170, 170), 20, rng.float(-40, 160));
        }
        break;
      }
      case 'ferrisWheel':
      case 'amusementPark':
      case 'themePark':
      case 'circus': {
        const spinners = [];
        if (kind !== 'circus') {
          // Ferris wheel: a rim, spokes and a hub on an A-frame. This is the one
          // piece of venue geometry that has to turn, so the wheel group goes
          // into userData.spinners and the world update rotates it.
          const R = rng.float(60, 100);
          const wheel = new THREE.Group();
          const rim = new THREE.TorusGeometry(R, 2.4, 6, 30);
          geos.push(rim);
          wheel.add(new THREE.Mesh(rim, steel));
          for (let i = 0; i < 12; i++) {
            const spoke = new THREE.BoxGeometry(1.6, R * 2, 1.6);
            spoke.rotateZ((i / 12) * Math.PI);
            geos.push(spoke);
            wheel.add(new THREE.Mesh(spoke, steel));
            const carA = (i / 12) * TAU;
            const car = new THREE.BoxGeometry(9, 9, 9);
            car.translate(Math.cos(carA) * R, Math.sin(carA) * R, 0);
            geos.push(car);
            wheel.add(new THREE.Mesh(car, accent));
          }
          wheel.position.set(0, R + 14, 0);
          wheel.userData.spin = rng.float(0.10, 0.24) * rng.sign();
          g.add(wheel);
          spinners.push(wheel);
          for (const s of [-1, 1]) {
            const leg = new THREE.CylinderGeometry(2, 4, R + 16, 6);
            add(leg, steel, s * R * 0.42, (R + 16) / 2, 0);
          }
        }
        if (kind !== 'ferrisWheel') {
          // Big top and side stalls.
          const tent = new THREE.ConeGeometry(46, 40, 12);
          add(tent, accent, rng.float(-190, -120), 20, rng.float(-60, 60));
          for (let i = 0; i < 9; i++) {
            const stall = new THREE.BoxGeometry(14, 7, 14);
            add(stall, this._matFacade, rng.float(-220, 220), 3.5, rng.float(-220, 220));
          }
          if (kind === 'themePark' || kind === 'amusementPark') {
            // A coaster read as a looping ribbon of track.
            const pts = [];
            for (let i = 0; i <= 30; i++) {
              const t = (i / 30) * TAU;
              pts.push({ x: Math.sin(t) * 140, z: Math.cos(t * 2) * 90,
                h: 22 + Math.sin(t * 3) * 20 });
            }
            const track = this._ribbonGeometry(pts, 6, 0);
            if (track) add(track, steel, 0, 0, 0);
          }
        }
        if (spinners.length) g.userData.spinners = spinners;
        break;
      }
      default:
        return null;
    }

    g.position.set(wx, ground, wz);
    g.userData.geos = geos;
    return g;
  }

  /**
   * Ground traffic. Vehicles are instanced per kind and advanced along the road
   * samples recorded by `_buildRoads`, so they stay on the tarmac and disappear
   * with the chunk that owns their road.
   *
   * The whole fleet for one kind is one instanced mesh whose matrices are
   * rewritten each frame from `chunk.animated`. That keeps a city's worth of
   * moving traffic at one draw call per vehicle type.
   */
  *_buildTraffic(chunk, cx, cz, extent, rng) {
    const roads = chunk.roadPaths;
    const volume = this.biome.roads?.traffic || 0;
    if (!roads || !roads.length || volume <= 0) return;
    const d = this.quality.propDensity;

    // Thin the fleet hard on low presets: traffic is the most per-frame-expensive
    // thing in the world build, because unlike everything else it moves.
    const perRoad = Math.round(rng.float(4, 11) * volume * clamp01(d + 0.15));
    if (perRoad <= 0) return;

    const pool = ['car', 'car', 'taxi', 'van', 'truck', 'bus'];
    if (volume > 1.0) pool.push('taxi', 'car', 'police');
    if (this.biome.civil?.scale === 'village') pool.push('tractor', 'truck');
    if ((this.biome.props?.buildings || 0) > 0.6) pool.push('construction', 'fuelTruck');
    pool.push('ambulance', 'fireTruck');

    // Group the fleet by kind so each kind is a single instanced mesh.
    const byKind = new Map();
    for (const road of roads) {
      if (road.pts.length < 4) continue;
      for (let i = 0; i < perRoad; i++) {
        const kind = rng.pick(pool);
        if (!byKind.has(kind)) byKind.set(kind, []);
        byKind.get(kind).push({
          road,
          t: rng.next(),                                   // 0..1 along the road
          speed: rng.float(0.006, 0.020) / (road.dirt ? 2.2 : 1),
          dir: rng.bool(0.5) ? 1 : -1,
          lane: rng.float(0.18, 0.38) * (rng.bool(0.5) ? 1 : -1),
          scale: rng.float(0.9, 1.15),
        });
      }
    }

    for (const [kind, agents] of byKind) {
      const { geo, mat } = this._vehicle(kind);
      const mesh = new THREE.InstancedMesh(geo, mat, agents.length);
      mesh.userData.shared = true;
      mesh.frustumCulled = false;   // matrices move every frame; the bound is stale
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.position.set(cx, 0, cz);
      chunk.group.add(mesh);
      chunk.animated.push({ traffic: { mesh, agents } });
      // Seed the first frame so nothing pops in at the origin.
      this._advanceTraffic({ mesh, agents }, 0);
      yield;
    }
  }

  /**
   * Step one traffic fleet. Called from `World.update` every frame for every
   * live chunk, so it is deliberately allocation-free — the scratch matrix and
   * vectors are module-level and reused.
   */
  _advanceTraffic(fleet, dt) {
    const { mesh, agents } = fleet;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      a.t += a.speed * a.dir * dt;
      // Wrap rather than turn around: a vehicle that reverses on the spot at the
      // end of the road is far more noticeable than one that reappears.
      if (a.t > 1) a.t -= 1;
      if (a.t < 0) a.t += 1;

      const pts = a.road.pts;
      const f = a.t * (pts.length - 1);
      const i0 = Math.min(pts.length - 2, Math.floor(f));
      const frac = f - i0;
      const p0 = pts[i0], p1 = pts[i0 + 1];

      const x = lerp(p0.x, p1.x, frac);
      const z = lerp(p0.z, p1.z, frac);
      const y = lerp(p0.h, p1.h, frac);

      let tx = p1.x - p0.x, tz = p1.z - p0.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len; tz /= len;
      const nx = -tz * a.road.width * a.lane;
      const nz = tx * a.road.width * a.lane;

      _m1.makeRotationY(Math.atan2(tx * a.dir, tz * a.dir));
      _m1.scale(_v1.set(a.scale, a.scale, a.scale));
      _m1.setPosition(x + nx, y + 2.4, z + nz);
      mesh.setMatrixAt(i, _m1);
    }
    mesh.instanceMatrix.needsUpdate = true;
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

    const addInstanced = (geo, mat, count, place) =>
      this._addInstanced(chunk, centerX, centerZ, geo, mat, count, place);

    const rand = () => rng.float(-extent, extent);

    /* --- forest -----------------------------------------------------------
     * One instanced mesh per species the location actually grows, placed against
     * a low-frequency stand mask rather than uniformly: real woodland is dense in
     * patches and open in between, and that contrast is what makes it read as
     * terrain instead of noise.
     *
     * Species share the mask but not the phase, so a mixed forest sorts itself
     * into stands — pine on the high ground, broadleaf in the valley — instead of
     * being every species evenly shuffled everywhere. */
    const flora = this.biome.flora || {};
    const treeLine = flora.treeLine ?? this.terrain.snowLine * 0.95;
    const species = this._floraSpecies;
    const floraDensity = flora.density ?? 1;

    const placeTree = (sp, si, scaleLo, scaleHi) => (i, m) => {
      const x = rand(), z = rand();
      const wx = centerX + x, wz = centerZ + z;
      const h = this.terrain.height(wx, wz);
      if (h < this.terrain.waterLevel + 8) return false;
      if (h > treeLine) return false;
      if (this.terrain.slope(wx, wz, 60) > 0.55) return false;
      // Stand mask: thin the canopy where the mask is low so clearings appear.
      if (fbm2(wx * 0.00055, wz * 0.00055, this.seed + 211, 3) + 0.35 < rng.next() * 0.9) return false;
      // Per-species mask, offset by index, so species segregate into stands.
      if (species.length > 1) {
        const own = fbm2(wx * 0.00042, wz * 0.00042, this.seed + 3300 + si * 700, 2);
        if (own + 0.55 < rng.next()) return false;
      }
      // Palms want the waterline; dead wood wants the marginal ground nothing
      // else will grow on. Both look wrong scattered evenly through a forest.
      if (sp === 'palm' && h > this.terrain.waterLevel + 220) return false;
      if (sp === 'dead' && h < this.terrain.waterLevel + 40 && rng.bool(0.7)) return false;
      const s = rng.float(scaleLo, scaleHi);
      m.makeRotationY(rng.float(0, TAU));
      m.scale(_v1.set(s, s * rng.float(0.8, 1.4), s));
      m.setPosition(x, h, z);
      return true;
    };

    const treeBudget = Math.round(1650 * p.trees * floraDensity * d);
    const perSpecies = Math.max(1, Math.round(treeBudget / Math.max(1, species.length)));
    for (let si = 0; si < species.length; si++) {
      const sp = species[si];
      // Pines and rosewoods are big trees; palms and dead wood are not.
      const big = sp === 'pine' || sp === 'rosewood' || sp === 'conifer';
      addInstanced(this._floraGeos.get(sp), this._floraMats.get(sp), perSpecies,
        placeTree(sp, si, big ? 1.6 : 1.1, big ? 4.2 : 3.0));
      yield;
    }

    /* --- flower beds -----------------------------------------------------
     * Daffodils, white lilies and wildflower. Low, dense and colourful — the
     * thing that stops a green location being a single flat green. Placed only
     * on gentle, low, unforested ground, which is where meadow actually is. */
    if (this._flowerGeo && this._flowerMats.length) {
      const bedCount = Math.round(700 * clamp01(flora.grass ?? 1) * floraDensity * d
        / this._flowerMats.length);
      for (let fi = 0; fi < this._flowerMats.length; fi++) {
        addInstanced(this._flowerGeo, this._flowerMats[fi], bedCount, (i, m) => {
          const x = rand(), z = rand();
          const wx = centerX + x, wz = centerZ + z;
          const h = this.terrain.height(wx, wz);
          if (h < this.terrain.waterLevel + 4) return false;
          if (h > treeLine * 0.8) return false;
          if (this.terrain.slope(wx, wz, 40) > 0.30) return false;
          // Beds clump: flowers grow where flowers already are.
          if (fbm2(wx * 0.0016, wz * 0.0016, this.seed + 5100 + fi * 311, 2) + 0.18 < rng.next()) return false;
          const s = rng.float(2.4, 7.0);
          m.makeRotationY(rng.float(0, TAU));
          m.scale(_v1.set(s, s * rng.float(0.6, 1.1), s));
          m.setPosition(x, h, z);
          return true;
        });
      }
      yield;
    }

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

    /* --- outskirts --------------------------------------------------------
     * Generic massing *outside* the settled areas. `_buildCivilDistrict` owns
     * everything inside the settlement mask and builds it from real structure
     * kinds; this pass only fills the fringe — the isolated blocks and sheds on
     * the edge of town — so the two never stack on the same ground. */
    const bCount = Math.round(240 * p.buildings * d);
    addInstanced(this._propGeos.building, this._propMats.building, bCount, (i, m) => {
      const x = rand(), z = rand();
      const wx = centerX + x, wz = centerZ + z;
      const h = this.terrain.height(wx, wz);
      if (h < this.terrain.waterLevel + 4) return false;
      if (this.terrain.slope(wx, wz, 80) > 0.34) return false;
      // Leave the town centre to the civil pass.
      if (this._isSettled(wx, wz)) return false;
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
      // A landmark that resolved to a venue owns per-instance geometry that
      // nothing else will free, because it is not flagged `shared`.
      for (const geo of lm.userData.geos || []) chunk.disposables.push(geo);
    }
    yield;

    const mid = this.path.nodes[Math.min(chunk.startNode + this.nodesPerChunk / 2 | 0, this.path.nodes.length - 1)];
    const extent = this.nodesPerChunk * this.path.spacing * 0.55;

    /* --- the procedural world ----------------------------------------
     * Order matters: water first, then the roads that bridge it, then the
     * settlement that follows the roads, then the venues and the traffic that
     * belong to that settlement, and finally the vegetation, which fills
     * whatever is left. Each pass yields internally. */
    yield* this._buildHydrology(chunk, mid.pos.x, mid.pos.z, extent, rng);
    yield;
    yield* this._buildRoads(chunk, mid.pos.x, mid.pos.z, extent, rng);
    yield;
    yield* this._buildCivilDistrict(chunk, mid.pos.x, mid.pos.z, extent, rng);
    yield;
    yield* this._buildVenues(chunk, mid.pos.x, mid.pos.z, extent, rng);
    yield;
    yield* this._buildTraffic(chunk, mid.pos.x, mid.pos.z, extent, rng);
    yield;
    yield* this._buildScatter(chunk, mid.pos.x, mid.pos.z, extent, rng);

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
        if (a.traffic) { this._advanceTraffic(a.traffic, dt); continue; }
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
    // The shared libraries are per-world, not per-chunk, so nothing else frees
    // them: chunk disposal deliberately skips anything flagged `shared`.
    for (const g of (this._structGeos?.values() || [])) g?.dispose?.();
    for (const g of (this._floraGeos?.values() || [])) g?.dispose?.();
    for (const g of (this._vehicleGeos?.values() || [])) g?.dispose?.();
    this._flowerGeo?.dispose?.();
    this._structGeos?.clear(); this._floraGeos?.clear(); this._vehicleGeos?.clear();
    this._cloudMat?.dispose();
    this.checkpointList.length = 0;
    this.dynamicColliders = [];
  }
}
