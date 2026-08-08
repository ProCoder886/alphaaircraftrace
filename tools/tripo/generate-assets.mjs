#!/usr/bin/env node
/**
 * ALPHA AIRCRAFT RACE 3D — Tripo3D asset generation utility
 * ---------------------------------------------------------------------------
 * Development-side only. Reads asset definitions, submits Tripo3D text-to-model
 * jobs, polls them to completion, downloads and validates the GLBs, optimises
 * them, generates LODs where a tool is available, files them under
 * /Assets/3d/<category>/ and writes /Assets/3d/manifest.json.
 *
 * SECURITY
 *   The API key is read from the TRIPO_API_KEY environment variable and is
 *   never written to disk, never logged, and never reaches the browser. The
 *   browser only ever fetches the finished GLBs and the manifest.
 *
 * USAGE
 *   export TRIPO_API_KEY="tsk_..."
 *   node tools/tripo/generate-assets.mjs                # generate what is missing
 *   node tools/tripo/generate-assets.mjs --only vector  # a single asset
 *   node tools/tripo/generate-assets.mjs --force        # regenerate everything
 *   node tools/tripo/generate-assets.mjs --dry-run      # show the plan, call nothing
 *   node tools/tripo/generate-assets.mjs --concurrency 2
 *
 * Assets are generated ONCE and cached in the repository. The game never calls
 * this API at runtime — if the manifest is empty it uses its procedural
 * airframes, which is the shipped default.
 */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const ASSET_DIR = path.join(ROOT, 'Assets', '3d');
const MANIFEST = path.join(ASSET_DIR, 'manifest.json');
const DEFS = path.join(__dirname, 'assets.json');

const API_BASE = 'https://openapi.tripo3d.ai/v3';
const CREATE_URL = `${API_BASE}/generation/text-to-model`;
const TASK_URL = (id) => `${API_BASE}/tasks/${id}`;

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RETRIES = 3;

/* ---- tiny CLI ----------------------------------------------------------- */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OPTIONS = {
  force: flag('force'),
  dryRun: flag('dry-run'),
  only: opt('only', null),
  concurrency: Math.max(1, Math.min(4, parseInt(opt('concurrency', '2'), 10) || 2)),
  keepRaw: flag('keep-raw'),
};

/* ---- logging ------------------------------------------------------------- */
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (...a) => console.log(...a);
const step = (id, msg) => log(`${c.cyan(`[${id}]`)} ${msg}`);
const warn = (id, msg) => log(`${c.yellow(`[${id}]`)} ${msg}`);
const fail = (id, msg) => log(`${c.red(`[${id}]`)} ${msg}`);

/** Never let the key leak into output, even inside an error message. */
function redact(text, key) {
  if (!key) return String(text);
  return String(text).split(key).join('***REDACTED***');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===========================================================================
 * API
 * ======================================================================== */

async function apiFetch(url, apiKey, init = {}, attempt = 1) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) {
      const msg = body?.message || body?.raw || res.statusText;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        const backoff = 2000 * Math.pow(2, attempt);
        warn('api', `HTTP ${res.status} — retrying in ${backoff / 1000}s (${attempt}/${MAX_RETRIES})`);
        await sleep(backoff);
        return apiFetch(url, apiKey, init, attempt + 1);
      }
      const err = new Error(`HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      err.code = body?.code;
      throw err;
    }
    return body;
  } catch (err) {
    if (err.status === undefined && attempt < MAX_RETRIES) {
      const backoff = 2000 * Math.pow(2, attempt);
      warn('api', `network error (${err.message}) — retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      return apiFetch(url, apiKey, init, attempt + 1);
    }
    throw err;
  }
}

/** 1–3: submit the job and receive a task id. */
async function submitJob(asset, defs, apiKey) {
  const payload = {
    type: 'text_to_model',
    model_version: defs.modelVersion,
    prompt: asset.prompt,
    negative_prompt: asset.negativePrompt
      || 'low quality, blurry, deformed, asymmetric, floating parts, text, watermark, human figure',
  };
  if (asset.style) payload.style = asset.style;
  if (asset.seed != null) payload.model_seed = asset.seed;

  const body = await apiFetch(CREATE_URL, apiKey, { method: 'POST', body: JSON.stringify(payload) });
  const taskId = body?.data?.task_id || body?.task_id;
  if (!taskId) throw new Error(`no task_id in response: ${JSON.stringify(body).slice(0, 220)}`);
  return taskId;
}

/** 4–5: poll until the task succeeds (or fails / times out). */
async function pollJob(taskId, apiKey, id) {
  const start = Date.now();
  let lastProgress = -1;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const body = await apiFetch(TASK_URL(taskId), apiKey);
    const data = body?.data || body;
    const status = data?.status;
    const progress = data?.progress ?? 0;
    if (progress !== lastProgress) {
      lastProgress = progress;
      step(id, `${status} ${progress}% ${c.dim(`(${Math.round((Date.now() - start) / 1000)}s)`)}`);
    }
    if (status === 'success') {
      const url = data?.output?.pbr_model || data?.output?.model || data?.output?.model_url;
      if (!url) throw new Error('task succeeded but returned no model_url');
      return { url, data };
    }
    if (status === 'failed' || status === 'cancelled' || status === 'banned' || status === 'expired') {
      throw new Error(`task ${status}${data?.message ? `: ${data.message}` : ''}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out after ${POLL_TIMEOUT_MS / 60000} minutes`);
}

/** 6: download the GLB. */
async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(res.body, createWriteStream(dest));
  const stat = await fs.stat(dest);
  return stat.size;
}

/* ===========================================================================
 * VALIDATE / OPTIMISE
 * ======================================================================== */

/** 7: structural GLB validation — magic, version, chunk table, JSON sanity. */
async function validateGLB(file) {
  const buf = await fs.readFile(file);
  if (buf.length < 20) throw new Error('file too small to be a GLB');
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new Error(`unsupported glTF binary version ${version}`);
  const declared = buf.readUInt32LE(8);
  if (declared !== buf.length) {
    throw new Error(`length mismatch: header says ${declared}, file is ${buf.length}`);
  }
  // First chunk must be JSON.
  const chunkLen = buf.readUInt32LE(12);
  const chunkType = buf.readUInt32LE(16);
  if (chunkType !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  let json;
  try {
    json = JSON.parse(buf.subarray(20, 20 + chunkLen).toString('utf8'));
  } catch (e) {
    throw new Error(`unreadable JSON chunk: ${e.message}`);
  }
  const meshes = json.meshes?.length || 0;
  const nodes = json.nodes?.length || 0;
  if (!meshes) throw new Error('model contains no meshes');
  let triangles = 0;
  for (const m of json.meshes || []) {
    for (const p of m.primitives || []) {
      const acc = json.accessors?.[p.indices];
      if (acc?.count) triangles += acc.count / 3;
      else {
        const pos = json.accessors?.[p.attributes?.POSITION];
        if (pos?.count) triangles += pos.count / 3;
      }
    }
  }
  return {
    bytes: buf.length, meshes, nodes,
    triangles: Math.round(triangles),
    materials: json.materials?.length || 0,
    images: json.images?.length || 0,
    animations: json.animations?.length || 0,
    skins: json.skins?.length || 0,
  };
}

/** Is a CLI available on PATH? */
function have(cmd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', () => resolve({ ok: false, out: 'spawn failed' }));
    p.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

/**
 * 8–9: optimise and build LODs.
 *
 * Uses gltf-transform if it is installed (`npm i -g @gltf-transform/cli`).
 * When it is not available the raw GLB is used as-is and the manifest records
 * `optimised: false` — the pipeline never fails just because an optional tool
 * is missing.
 */
async function optimise(id, src, outDir, asset, defaults) {
  const hasGltfTransform = await have('gltf-transform');
  const targetTex = asset.textureSize || defaults.textureSize || 1024;
  const lodRatios = asset.lods || defaults.lods || [1.0];
  const results = { optimised: false, lods: [], compression: 'none' };

  await fs.mkdir(outDir, { recursive: true });
  const base = path.join(outDir, `${id}.glb`);

  if (!hasGltfTransform) {
    await fs.copyFile(src, base);
    results.lods.push({ level: 0, ratio: 1, file: path.relative(ROOT, base) });
    return results;
  }

  // LOD0: prune, dedupe, resize textures, Draco-compress geometry.
  const tmp = path.join(outDir, `${id}.tmp.glb`);
  let r = await run('gltf-transform', ['optimize', src, tmp,
    '--texture-size', String(targetTex),
    '--compress', 'draco',
    '--simplify', 'false',
  ]);
  if (!r.ok) {
    warn(id, `gltf-transform optimize failed, shipping the raw model\n${c.dim(r.out.trim().slice(0, 300))}`);
    await fs.copyFile(src, base);
    results.lods.push({ level: 0, ratio: 1, file: path.relative(ROOT, base) });
    return results;
  }
  await fs.rename(tmp, base);
  results.optimised = true;
  results.compression = 'draco';
  results.lods.push({ level: 0, ratio: 1, file: path.relative(ROOT, base) });

  // Lower LODs via mesh simplification.
  for (let i = 1; i < lodRatios.length; i++) {
    const ratio = lodRatios[i];
    const out = path.join(outDir, `${id}.lod${i}.glb`);
    const s = await run('gltf-transform', ['simplify', base, out,
      '--ratio', String(ratio), '--error', '0.0015']);
    if (s.ok) results.lods.push({ level: i, ratio, file: path.relative(ROOT, out) });
    else warn(id, `LOD${i} simplification skipped`);
  }
  return results;
}

/* ===========================================================================
 * MANIFEST
 * ======================================================================== */

async function readManifest() {
  try { return JSON.parse(await fs.readFile(MANIFEST, 'utf8')); }
  catch { return { schema: 1, generator: 'tools/tripo/generate-assets.mjs', assets: [] }; }
}

async function writeManifest(manifest) {
  manifest.generatedAt = new Date().toISOString();
  manifest.assets.sort((a, b) => (a.priority === b.priority ? a.id.localeCompare(b.id) : (a.priority === 'critical' ? -1 : 1)));
  await fs.mkdir(ASSET_DIR, { recursive: true });
  await fs.writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

/* ===========================================================================
 * MAIN
 * ======================================================================== */

async function generateOne(asset, defs, apiKey, manifest) {
  const id = asset.id;
  const category = asset.category || 'props';
  const outDir = path.join(ASSET_DIR, category);
  const rawDir = path.join(__dirname, '.raw');
  const rawFile = path.join(rawDir, `${id}.raw.glb`);

  const entry = {
    id, category,
    priority: asset.priority || defs.defaults.priority || 'optional',
    type: category === 'aircraft' ? 'aircraft' : 'prop',
    prompt: asset.prompt,
    modelVersion: defs.modelVersion,
    status: 'pending',
    file: null, lods: [], bytes: 0, triangles: 0,
    compression: 'none', optimised: false,
    generatedAt: null, error: null,
  };

  try {
    step(id, 'submitting generation job');
    const taskId = await submitJob(asset, defs, apiKey);
    entry.taskId = taskId;
    step(id, `task ${c.dim(taskId)}`);

    const { url } = await pollJob(taskId, apiKey, id);
    step(id, 'downloading model');
    await fs.mkdir(rawDir, { recursive: true });
    const bytes = await download(url, rawFile);
    step(id, `downloaded ${(bytes / 1048576).toFixed(2)} MB`);

    step(id, 'validating');
    const info = await validateGLB(rawFile);
    step(id, `${info.meshes} mesh(es), ${info.triangles.toLocaleString()} tris, ${info.materials} material(s)`);
    if (info.triangles === 0) throw new Error('validated model has zero triangles');

    step(id, 'optimising');
    const opt = await optimise(id, rawFile, outDir, asset, defs.defaults);

    const finalStat = await fs.stat(path.join(ROOT, opt.lods[0].file));
    Object.assign(entry, {
      status: 'ready',
      file: opt.lods[0].file.split(path.sep).join('/'),
      lods: opt.lods.map((l) => ({ ...l, file: l.file.split(path.sep).join('/') })),
      bytes: finalStat.size,
      triangles: info.triangles,
      meshes: info.meshes,
      materials: info.materials,
      compression: opt.compression,
      optimised: opt.optimised,
      generatedAt: new Date().toISOString(),
    });
    if (!OPTIONS.keepRaw) await fs.rm(rawFile, { force: true });
    log(`${c.green(`[${id}]`)} ready → ${entry.file} (${(entry.bytes / 1048576).toFixed(2)} MB)`);
  } catch (err) {
    entry.status = 'failed';
    entry.error = redact(err.message, apiKey);
    fail(id, entry.error);
  }

  const i = manifest.assets.findIndex((a) => a.id === id);
  if (i >= 0) manifest.assets[i] = entry; else manifest.assets.push(entry);
  await writeManifest(manifest);
  return entry;
}

async function main() {
  log(c.bold('\nALPHA AIRCRAFT RACE 3D — Tripo3D asset pipeline\n'));

  const defs = JSON.parse(await fs.readFile(DEFS, 'utf8'));
  const manifest = await readManifest();
  manifest.modelVersion = defs.modelVersion;

  let queue = defs.assets;
  if (OPTIONS.only) {
    const wanted = OPTIONS.only.split(',').map((s) => s.trim());
    queue = queue.filter((a) => wanted.includes(a.id));
  }
  if (!OPTIONS.force) {
    queue = queue.filter((a) => {
      const existing = manifest.assets.find((x) => x.id === a.id);
      if (existing?.status === 'ready') { log(c.dim(`[${a.id}] already generated — skipping (use --force to regenerate)`)); return false; }
      return true;
    });
  }

  if (!queue.length) { log(c.green('\nNothing to generate. Manifest is up to date.\n')); return; }

  log(`Planned: ${queue.map((a) => a.id).join(', ')}`);
  log(`Concurrency: ${OPTIONS.concurrency}   Model: ${defs.modelVersion}\n`);

  if (OPTIONS.dryRun) {
    log(c.yellow('--dry-run: no API calls made.\n'));
    for (const a of queue) log(`  ${a.id.padEnd(16)} ${a.category.padEnd(12)} ${a.prompt.slice(0, 84)}…`);
    log('');
    return;
  }

  const apiKey = process.env.TRIPO_API_KEY;
  if (!apiKey) {
    fail('setup', 'TRIPO_API_KEY is not set.');
    log(`
  The key must come from the environment — it is never stored in this repo.

    export TRIPO_API_KEY="tsk_..."
    node tools/tripo/generate-assets.mjs

  The game does not need this step: with an empty manifest it builds every
  airframe and prop procedurally at runtime.
`);
    process.exitCode = 1;
    return;
  }

  // Bounded worker pool.
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: OPTIONS.concurrency }, async () => {
    while (cursor < queue.length) {
      const asset = queue[cursor++];
      results.push(await generateOne(asset, defs, apiKey, manifest));
    }
  });
  await Promise.all(workers);

  const ready = results.filter((r) => r.status === 'ready');
  const failed = results.filter((r) => r.status !== 'ready');
  log('');
  log(c.bold('Summary'));
  log(`  ${c.green(`${ready.length} ready`)}${failed.length ? `   ${c.red(`${failed.length} failed`)}` : ''}`);
  for (const f of failed) log(`    ${c.red('✗')} ${f.id}: ${f.error}`);
  log(`\nManifest: ${path.relative(ROOT, MANIFEST)}`);
  log(failed.length
    ? c.yellow('\nFailed assets fall back to the procedural airframes at runtime — the game stays playable.\n')
    : '');
}

main().catch((err) => {
  fail('fatal', redact(err.stack || err.message, process.env.TRIPO_API_KEY));
  process.exitCode = 1;
});
