# ALPHA AIRCRAFT RACE 3D

A high-speed aerial racing game that runs entirely in the browser. Every route,
venue, airframe, cloud, texture, sound effect and piece of music is generated
procedurally at runtime — there are no downloaded art or audio assets.

```
Endless Flight · Elite · Random venue          ← the defaults
6 game modes · 17 venues · 10 airframes · 5 powers · 8-aircraft grids
```

---

## Running it

It is a static site with no build step. Serve the directory over HTTP:

```bash
# any static server works
python3 -m http.server 8080
# or
npx serve .
```

Then open `http://localhost:8080`.

`file://` will not work — the game uses ES modules and `fetch`, both of which
require an HTTP origin.

**Requirements:** any browser with WebGL (WebGL 2 preferred). Desktop or mobile.
Mobile play is landscape-only; portrait shows a rotate prompt.

---

## Controls

| Key | Action |
|---|---|
| `W` / `↑` | Pitch up — also feeds the throttle |
| `S` / `↓` | Pitch down — also bleeds the throttle |
| `A` / `D` | Roll left / right — **this is how you turn** |
| `Q` / `E` | Yaw left / right |
| `Shift` | Throttle up |
| `C` | Air brake (tightens your turn radius) |
| `Space` | Boost |
| `NUM 1–5` | Route Scan · Time Freeze · Phase Shift · Aerial Shield · Turbo Overdrive |
| `Esc` | Pause |
| `F` | Fullscreen |
| `V` | Cycle camera (chase / wide / close / cockpit) |
| `F8` | Debug overlay (FPS, seed, draw calls, world stats) |

Gamepads and touch are supported. Everything is rebindable in Settings.

Bank into the turn and pull — heading follows roll far faster than rudder alone.

---

## Modes

| Mode | Shape |
|---|---|
| **Endless Flight** *(default)* | Infinite streamed route that escalates for as long as you survive |
| Quick Race | One standalone race against a full grid over a fresh route |
| Campaign | Nine chapters, each with its own venue, grid and objective |
| Survival | Airspace closes in until the hull gives out |
| Time Attack | A countdown you extend by hitting checkpoints |
| Free Flight | No timer, no rivals, no failure state |

Difficulty (Normal → Legendary) changes *behaviour*, not just rival top speed:
route complexity, obstacle density, traffic, weather severity, rival mistake
rate and your own recovery window all move with it.

---

## How it is built

```
index.html                 app shell — canvas, screens, HUD markup
sw.js                      offline cache for the shell + engine
css/                       main · menu · hud · mobile · animations
js/                        exactly ten modules (see below)
vendor/three/              three.js r180, vendored (MIT)
Assets/3d/                 optional generated models + manifest.json
tools/tripo/               Tripo3D asset generation pipeline
```

### The ten modules

| Module | Responsibility |
|---|---|
| `main.js` | Bootstrap, environment checks, failure screen, service worker |
| `config.js` | Constants, tunables, content tables, seeded RNG and noise |
| `game.js` | Game state, modes, objectives, scoring, progression, save, frame loop |
| `renderer.js` | WebGL context, sky, lighting, post-FX, camera rig, aircraft factory, VFX |
| `player.js` | Input, flight model, boost, damage, collisions, the five powers |
| `world.js` | Terrain field, route generation, chunk streaming, content, weather |
| `ai.js` | Rival pilots, traffic, race director |
| `ui.js` | Menus, HUD, radar, onboarding, settings, results, touch controls |
| `audio.js` | Web Audio synthesis: engine, ambience, SFX, music, commentary |
| `performance.js` | Device profiling, frame timing, adaptive quality, pools, loader |

### Notable systems

**Procedural route.** A seeded spline grown segment by segment from a table of
22 modular segment types (sweepers, spirals, canyon runs, tower weaves,
shortcuts, storm cells…). The generator samples the terrain heightfield while
it builds, so the route is guaranteed flyable — it can never be generated
inside a mountain, and obstacle placement always reserves a clear corridor.

**Terrain.** A pure analytic heightfield: `height(x, z, lod)` is a function of
position and seed with no stored state, so the route generator, the mesh
builder and the AI all agree on where the ground is without sharing anything.
Rendered as a four-ring geo-clipmap that rebuilds one tile per frame.

**Streaming.** World content lives in chunks of ~5 km. Chunk construction is a
generator that yields between sub-steps; a cooperative scheduler runs them
against a per-frame time budget so building the world never causes a hitch.

**Rivals.** AI fly in path space — distance along, lateral offset, vertical
offset — rather than free 6-DOF. They always know where the route goes, so all
their intelligence goes into choosing a line, defending it, avoiding obstacles
and deciding when to spend boost. Eight archetypes with genuinely different
behaviour, blended with the difficulty setting.

**Airframes.** Ten aircraft are lofted at runtime from parametric shape data —
superellipse fuselage sections, NACA-profile lifting surfaces, canards, canted
tails, nacelles, flared nozzles, glass canopies — and merged down to about six
draw calls each. Liveries, panel lines and roughness maps are painted to a
canvas per airframe. Control surfaces are separate pivots that actuate with
your input.

**Audio.** Everything is synthesised. The engine is a stack of detuned
oscillators plus band-passed noise driven continuously by speed, throttle,
boost and hull damage — no sample crossfades. The score is a generative
sequencer whose intensity tracks how the run is going.

**Performance.** Adaptive quality is a ladder, not a switch: it sheds far
particles, then shadow cadence, then reflection cadence, then far prop density,
then cloud detail, then post intensity — in that order, easing between steps.
Player aircraft fidelity, core lighting, HUD and input responsiveness are never
touched.

---

## Generated 3D assets (optional)

`tools/tripo/` contains a pipeline that generates models with the Tripo3D API,
validates and optimises them, builds LODs and writes `Assets/3d/manifest.json`.
The game loads any asset the manifest marks `ready` and falls back to its
procedural airframes otherwise, so the build is always playable.

The API key is read from `TRIPO_API_KEY` at generation time. It is never stored
in this repository and never reaches the browser. See
[`tools/tripo/README.md`](tools/tripo/README.md).

```bash
export TRIPO_API_KEY="tsk_..."
node tools/tripo/generate-assets.mjs --dry-run   # show the plan
node tools/tripo/generate-assets.mjs             # generate
```

This build ships with an empty manifest and runs on its procedural airframes.

---

## Saving

Progress, unlocks, records, statistics and settings are kept in this browser's
`localStorage` under `alpha_aircraft_race_3d_save_v1`. Nothing is uploaded
anywhere. Statistics → *Reset All Progress* clears it.

---

## Licence and credits

Original game. Rendering uses [three.js](https://threejs.org) (MIT, © three.js
authors), vendored under `vendor/three/` with its licence intact. Everything
else — flight model, world generator, AI, audio synthesis, UI — is bespoke to
this project.
