# Tripo3D asset pipeline

Development-side utility that generates the optional 3D assets for
**Alpha Aircraft Race 3D** and files them under `/Assets/3d/`.

The game **does not need this step**. Every airframe, prop, gate, cloud and
terrain surface it ships with is generated procedurally in the browser at
runtime. This pipeline exists so higher-fidelity sculpted models can be dropped
in without touching game code: if `Assets/3d/manifest.json` lists an asset with
`"status": "ready"`, the game loads that GLB; if it does not, the procedural
version is used. Either way the build is playable.

---

## Security

**The API key is never stored in this repository and never reaches the
browser.** It is read from the `TRIPO_API_KEY` environment variable at
generation time only. The browser fetches nothing but the finished `.glb` files
and `manifest.json`.

If the key is ever pasted into a chat, an issue, a commit or any other shared
surface, treat it as compromised and rotate it in the Tripo3D dashboard.

```bash
export TRIPO_API_KEY="tsk_..."      # never commit this
```

---

## Usage

```bash
node tools/tripo/generate-assets.mjs                  # generate anything missing
node tools/tripo/generate-assets.mjs --only vector    # one asset (comma-separated for several)
node tools/tripo/generate-assets.mjs --force          # regenerate everything
node tools/tripo/generate-assets.mjs --dry-run        # print the plan, call nothing
node tools/tripo/generate-assets.mjs --concurrency 3  # parallel jobs (1–4)
node tools/tripo/generate-assets.mjs --keep-raw       # keep the pre-optimisation download
```

Assets are generated **once** and cached in the repo. Nothing regenerates on a
browser load.

---

## What it does

| Step | Action |
|-----:|--------|
| 1 | Reads asset definitions from `tools/tripo/assets.json` |
| 2 | `POST https://openapi.tripo3d.ai/v3/generation/text-to-model` with `model_version: v3.1-20260211` |
| 3 | Receives the `task_id` |
| 4 | Polls `GET https://openapi.tripo3d.ai/v3/tasks/{task_id}` every 5 s |
| 5 | Waits for `status = success` (15 min ceiling, then it gives up cleanly) |
| 6 | Downloads `output.model_url` |
| 7 | Validates the GLB — magic number, glTF version, chunk table, JSON chunk, mesh and triangle counts |
| 8 | Optimises: prune, dedupe, texture resize, Draco geometry compression |
| 9 | Generates LOD1/LOD2 by mesh simplification |
| 10 | Files the result under `/Assets/3d/<category>/` |
| 11 | Writes/updates `/Assets/3d/manifest.json` |

Rate limits (429) and server errors (5xx) are retried with exponential backoff.
Failures are recorded per asset with `"status": "failed"` and the reason — one
bad asset never blocks the rest, and the game ignores anything that is not
`ready`.

### Optional dependency

Steps 8–9 use [`gltf-transform`](https://gltf-transform.dev):

```bash
npm install -g @gltf-transform/cli
```

If it is not installed the raw GLB is filed as-is and the manifest records
`"optimised": false`. The pipeline never fails because an optional tool is
missing.

---

## Asset definitions

`assets.json` drives everything:

```json
{
  "id": "vector",           // aircraft id from js/config.js, or any prop name
  "category": "aircraft",   // → /Assets/3d/aircraft/
  "priority": "critical",   // critical assets are loaded during boot; optional ones lazily
  "prompt": "…",
  "targetTriangles": 20000,
  "textureSize": 1024,
  "lods": [1.0, 0.45, 0.18]
}
```

Aircraft ids must match `AIRCRAFT[].id` in `js/config.js`. When a matching model
is registered, the game fits it to that airframe's canonical frame (nose along
local −Z, scaled to the design length) and keeps the procedural afterburners,
engine trails and effect shells attached, so gameplay behaviour is unchanged.

---

## Manifest

```json
{
  "schema": 1,
  "modelVersion": "v3.1-20260211",
  "generatedAt": "…",
  "assets": [
    {
      "id": "vector", "category": "aircraft", "priority": "critical",
      "status": "ready", "file": "Assets/3d/aircraft/vector.glb",
      "lods": [{ "level": 0, "ratio": 1, "file": "…" }],
      "bytes": 1234567, "triangles": 18420,
      "compression": "draco", "optimised": true
    }
  ]
}
```

An empty `assets` array is the shipped default.

---

## Current state of this build

The pipeline is implemented, wired into the game and verified against the live
API: it authenticates, submits, polls, and reports errors correctly. It has
**not** produced models for this build, because the Tripo3D account behind the
supplied key returns:

```
HTTP 403  {"code":2010,"message":"You don't have enough credit to create this task"}
```

That is an account balance issue, not a code one. Top the account up and re-run
the command above; the models will be generated, optimised, filed and picked up
by the game on the next load with no code changes.
