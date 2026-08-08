# ALPHA AIRCRAFT RACE 3D

A high-speed aerial racing game that runs entirely in the browser. Every route,
venue, cloud, texture, sound effect and piece of music is generated
procedurally at runtime. Three of the thirteen airframes are modelled fighter
jets loaded from `Assets/3d/aircraft/`; the other ten are lofted at runtime
from parametric shape data, and every modelled jet keeps that procedural hull
as its fallback.

```
Endless Flight · Elite · Random venue          ← the defaults
6 game modes · 17 venues · 13 airframes · 5 powers · 8-aircraft grids
Four cameras including a true first-person view · route guidance chevrons
Medium graphics by default, with an adaptive detail ladder underneath
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
| `W` / `↑` | Pull — commands G, and feeds the throttle |
| `S` / `↓` | Push — unloads the wing, and bleeds the throttle |
| `A` / `D` | Bank left / right — **this is how you turn** |
| `Q` / `E` | Lean left / right — slide sideways without changing heading |
| `Shift` | Throttle up |
| `X` | Air brake — slower means a harder turn, so this is a cornering tool |
| `Space` | Boost |
| `NUM 1–5` | Power Flight · Turbo Speed · Combat Maneuvers · Aerial Shield · Phase Shift |
| `Esc` | Pause |
| `F` | Fullscreen |
| `C` / `V` | Cycle camera (chase / close / wide / first person) |
| `F8` | Debug overlay (FPS, seed, draw calls, world stats) |

Gamepads and touch are supported. Everything is rebindable in Settings.

Bank into the turn and pull. The rudder alone will not get you round anything,
and the harder you pull the more speed it costs — braking into a tight gate
chain is genuinely faster than powering through it.

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
Assets/3d/aircraft/        the three modelled fighter jets (.glb, LOD0 + LOD1)
Assets/3d/manifest.json    asset index, also written by the Tripo3D pipeline
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
| `audio.js` | Web Audio synthesis: engine, ambience, SFX, adaptive music |
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

Three more — FR-22 Raptor, FA-19 Falcon, MK-29 Warhawk — are modelled meshes,
decimated to ~115k triangles with a ~29k LOD for rivals and Draco-compressed.
None of the three arrived axis-aligned, so each carries a solved quaternion in
`config.js`: the direction an aircraft is thinnest is its "up", the mirror
plane gives the span axis, the blunter end is the tail, and the fins point up.
Nozzle and wingtip anchors are in that corrected frame, so afterburners and tip
vapour come off the real geometry.

**Flight model.** The stick commands a load factor, not a turn rate, and the
body pitch rate falls out of the standard turn equation `q = G·(n − upY)/V`.
The visual airframe carries an angle of attack on top of that — the nose rides
above the flight path, more so slow and under G — because a model that flies
exactly along its own nose looks like it is being carried rather than flying.
Everything that makes a jet feel like a jet follows from that single line: you
turn far harder slow than fast, the nose falls when you stop pulling, banking
curves the flight path with no special case, and holding G bleeds energy
through an induced-drag term. Roll is rate-commanded and loses authority at
both ends of the speed band; the rudder is a low-speed control; rolling drags
the nose the wrong way until you catch it. The engine spools and reheat lights
a beat late, so the boost button is worth timing. Gravity is scaled — real g
gives about 14°/s at racing speed, which is unflyable in a corridor — but every
relationship above it is the real one, and the G-meter reads the true load
factor.

**Route guidance.** A ladder of translucent chevrons laid down the middle of
the corridor ahead, in a single instanced draw call. Green while you are on the
line, amber as you drift, red once you are outside the corridor, with a pulse
of brightness travelling away from you that crosses the bloom threshold — so
the route glows rather than just being drawn.

**Cameras.** Chase, close and wide are all chase rigs with speed-scaled
distance and lag; first person is a rigid eye point in the airframe with the
aircraft itself not drawn, which is the only way a first-person view works when
the airframe is a single merged mesh. `C` cycles them and the live camera is
named bottom-right.

**Engine audio.** A turbofan, not an engine block: inharmonic blade-passing
partials from the fan and compressor through a resonant bandpass, a broadband
core roar carrying most of the level, exhaust hiss, airframe noise scaled with
V², and a reheat layer whose amplitude is deliberately unstable. N1 lags the
throttle by seconds, and the run opens with a cold start — starter, light-off,
settle. A sawtooth stack is what a piston engine sounds like; this is not one.

**Motion blur.** Two components per tap: a radial smear from the focal point
for forward motion, and a linear smear along however far a distant point slid
across the screen since the last frame, so banking and pulling smear sideways
too. The linear term is normalised to a 60 Hz exposure — physically the smear
should grow with frame time, but a machine dropping frames would then bury the
route exactly when the player needs to see it. Reheat drives a separate channel
with a much longer radial stretch, an outward lens warp, fine streaks and a
warm rim, all masked away from the centre of the frame.

**Audio.** Everything is synthesised. The engine is a stack of detuned
oscillators plus band-passed noise driven continuously by speed, throttle,
boost and hull damage — no sample crossfades. The score is a generative
sequencer whose intensity tracks how the run is going.

**Performance.** Adaptive quality is a ladder, not a switch: it sheds far
particles, then shadow cadence, then reflection cadence, then far prop density,
then cloud detail, then post intensity — in that order, easing between steps.
Player aircraft fidelity, core lighting, HUD and input responsiveness are never
touched.

Frame pacing matters as much as frame rate. `requestAnimationFrame` deltas
jitter either side of the true refresh interval even on a machine comfortably
hitting its target, and feeding that jitter into the simulation makes a smooth
60 fps *look* like it is stuttering. Deltas within 0.9 ms of a common refresh
interval are snapped onto it and the remainder carried forward, so no time is
invented or lost. World streaming then gets whatever is left of the frame after
rendering rather than a fixed slice — a fixed budget is what turns a tight
frame into a dropped one.

The context is requested as WebGL 2 with a high-performance GPU hint and a
desynchronized swap chain, and tone mapping is AgX, which holds saturated
highlights — reheat plumes, gate energy, sun discs — where ACES desaturates
them towards grey.

---

## 3D assets

The three modelled jets live in `Assets/3d/aircraft/` and are listed both on
their aircraft entries in `config.js` and in `Assets/3d/manifest.json`. They are
optional in the strict sense: if a `.glb` fails to load, that airframe falls
back to its procedural hull and the game boots normally.

`tools/tripo/` contains a pipeline that generates further models with the
Tripo3D API, validates and optimises them, builds LODs and appends them to
`Assets/3d/manifest.json`. The game loads any asset the manifest marks `ready`
and falls back to its procedural airframes otherwise, so the build is always
playable.

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
