# ALPHA AIRCRAFT RACE 3D

A high-speed aerial combat and racing game that runs entirely in the browser.
Every route, venue, cloud, texture, sound effect and piece of music is
generated procedurally at runtime. Three of the five airframes are modelled
fighter jets loaded from `Assets/3d/aircraft/`; all five carry a procedural
hull built from parametric shape data as their fallback.

```
Endless Battle · Elite · Emerald Delta         ← the defaults
9 game modes incl. 15-mission Story Mode · 10 venues · 5 airframes · 5 powers
Mach 30 / 3000 km/h envelope · 100-strong hostile squadrons
Chase and first-person cameras · route guidance chevrons
High graphics on desktop, held between 60 and 120 FPS by the frame governor
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
| `Space` | Nitrous boost — half the old burn rate, so it lasts |
| `NUM 1–5` | Power Flight · **Turbo Speed (doubles nitrous)** · Combat Maneuvers · Aerial Shield · Phase Shift |
| `LMB` / `RMB` | Guns / launch the armed heavy (needs a lock) |
| `NUM 8` / `NUM 9` | Cycle gun · cycle heavy weapon |
| `Esc` | Pause |
| `F` | Fullscreen |
| `C` | Toggle camera (chase / first person) |
| `F8` | Debug overlay (FPS, seed, draw calls, world stats) |

Gamepads and touch are supported. Everything is rebindable in Settings.

Bank into the turn and pull. The rudder alone will not get you round anything,
and the harder you pull the more speed it costs — braking into a tight gate
chain is genuinely faster than powering through it.

---

## Modes

| Mode | Shape |
|---|---|
| **Endless Battle** *(default)* | Open airspace, no gates — a hundred hostile fighters, escalating waves |
| **Story Mode** | Fifteen missions in three acts, ~30 minutes each, flown in order |
| Endless Flight | Infinite streamed route that escalates for as long as you survive |
| Endless Race | A hostile top-speed run — hold Mach and outrun the squadron |
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

**Story Mode.** Fifteen missions in three acts, flown in order, each a full
half-hour sortie rather than a lap. A mission is a *sequence* of five phases —
a transit, a first contact, a skill phase, a hold, and a final clear — flown
back to back without a loading screen, where the live phase is the only one
that counts and clearing the last one clears the mission. Phase goals are
cumulative against the same `metrics` object every other mode already fills in,
so nothing needed a bespoke tracker and the HUD can show one honest bar. Every
mission opens on a full-screen briefing: situation, intelligence, orders, all
five phases with their how-to lines, and the venue, weather, difficulty, length
and squadron pressure it will be flown at. `pressure` scales the squadron floor
per mission, so mission 15 puts more airframes in the sky than mission 1 rather
than being the same fight with a bigger number on the objective.

**Venues.** Ten world *types*, not ten maps: each is a set of rules a fresh
world is grown from, so the same venue twice is two different valleys. There is
no water anywhere — what used to be hydrology is now `drainage`, and it
describes the landform water would have cut (braided channels, scoured basins,
the flats a delta leaves behind) laid down in dry bed material. Weather is
rationed: exactly one cold venue and exactly one wet one, so a weather state
says something about *where you are* rather than being reshuffled every launch.

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

**Hostiles.** A combat squadron is a hundred airframes, held at that floor as
kills come in, arriving in eight formations at seven-to-ten-kilometre spacing.
Keeping them there needs a separation term as well as a spread: every hostile
is pursuing the same aircraft, so without one the whole wing converges into the
saturated blob the spacing exists to prevent. Path space runs both ways for
them — `pathDir` is the mechanism behind a committed two-second U-turn that
rolls, pulls the nose through and reverses at the top — so a fighter that
overshoots you comes back rather than disappearing down the route forever.
Fourteen named manoeuvres including the full-axis rolls the player flies on Q
and E. A hundred aircraft is a hundred cheap flight models and at most 28
meshes: past 26 km a hostile is simulated, shoots and paints on the radar
without being drawn.

**Weapons.** Four guns on a 21-39 km ladder and four heavies on a 56-105 km
one. The gun hit test is a swept segment rather than a point sample — a plasma
bolt covers 93 m in a 60 Hz frame against a 30 m target, so testing only the
round's new position stepped over most of the shots that should have connected.
Heavy splash falls off quadratically, because a linear ramp over a kilometre of
blast leaves half of it lethal and turns the whole airspace into one kill zone.
Rounds the player did not launch are damage-scaled on the way in: the table is
the player's arsenal, and a hundred aircraft firing it back is a coin flip
rather than a fight.

**Collision.** Colliders carry a shape, not just a radius. Boxes get oriented
half-extents; anything genuinely a ring — a torus arch, an open-ended cylinder
— is decomposed at build time into a chain of small boxes following the
material, so the hole in an arch is a hole and you can fly through it. The
narrow phase is a slab test against the box expanded by the aircraft's own
radius: exact along the flight vector, no sampling, and therefore no tunnelling
through a thin wall at Mach 30.

**Airframes.** Five, not eleven: two flyable from the first launch and three
earned. A hangar of eleven was a list rather than a choice — most of them
differed by a few points on one stat and a paint job, and the ones that
mattered were buried. Each is lofted at runtime from parametric shape data —
superellipse fuselage sections, NACA-profile lifting surfaces, canards, canted
tails, nacelles, flared nozzles, glass canopies — and merged down to about six
draw calls each. Liveries, panel lines and roughness maps are painted to a
canvas per airframe. Control surfaces are separate pivots that actuate with
your input.

Three of the five — FR-22 Raptor, FA-19 Falcon, MK-29 Warhawk — are modelled meshes,
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

**The envelope.** Dry Mach 20, nitrous Mach 25, and Turbo Speed (`NUM 2`)
doubles the nitrous — twice the shove and twice the margin it adds on top of
the dry ceiling, which is what puts the Mach 30 / 3000 km/h ceiling at the end
of one key instead of in a constant to keep in step by hand. Drag, not thrust,
was tuned to open the band, so low-speed acceleration is untouched and top
speed is still something you fly toward over a distance. The thermal redline is
Mach 24, six Mach below the ceiling: cross it and the engine is on a one-minute
clock, so the top of the envelope is somewhere you can live rather than a
warning light. Nitrous burns at 13 units/second — a full meter is 7.7 seconds
of reheat.

**HUD.** The control legend and the weapons/objective block are *reference*,
not instruments: worth reading for the first few runs and then permanently in
front of the thing you are actually looking at. Both are closed by default on
desktop and mobile, each behind its own big circular dial — green for controls,
blue for weapons — with each panel framed in its dial's colour, so "blue dial,
blue panel" is learned once and never read again. The choice is remembered.
Target lock range has its own readout under the reticle, independent of the
panel above it: green when the armed round can reach, red with the distance
when it cannot, because that is the one combat number that must never be behind
a toggle.

**Route guidance.** A ladder of translucent chevrons laid down the middle of
the corridor ahead, in a single instanced draw call. Green while you are on the
line, amber as you drift, red once you are outside the corridor, with a pulse
of brightness travelling away from you that crosses the bloom threshold — so
the route glows rather than just being drawn.

**Cameras.** Chase and first person, on one toggle. Chase is a speed-scaled rig
that dollies in as the jet accelerates; first person is a rigid eye point in the
airframe with the aircraft itself not drawn, which is the only way a first-person
view works when the airframe is a single merged mesh. `C` toggles them and the
live camera is named bottom-right. The pre-race framing sits back further than
the flight framing and eases forward once you are moving, so a stationary jet is
a jet you can see rather than one filling the screen.

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

**Performance.** On desktop the game holds **60-120 FPS at every quality
level, including maximum**, and the two halves of that are different problems.

*The floor is quality.* Adaptive quality is a ladder, not a switch: it sheds
far particles, then shadow cadence, then reflection cadence, then far prop
density, then cloud detail, then post intensity, then resolution — in that
order, easing between steps. Player aircraft fidelity, core lighting, HUD and
input responsiveness are never touched. But the ladder only moves *within* the
chosen preset, and Extreme at the bottom rung can still be more than a machine
has. So when the ladder bottoms out and the frame rate is still short, the
governor steps the **effective preset** down a rung — Extreme becomes Ultra,
Ultra becomes High, down to a Medium floor. The player's choice is never
overwritten; it stays as the ceiling the governor climbs back toward the moment
there is headroom, so a machine that can hold Extreme does, and one that cannot
gets a game that runs rather than a slideshow with the right label on it. The
debug overlay (`F8`) names the running preset and what was asked for.

*The ceiling is pacing.* On a 144 or 240 Hz panel there is nothing to gain from
rendering four times as many frames as the game is designed around — it burns
the GPU headroom the floor needs. Whole ticks that arrive early are skipped
rather than just their draw, so simulation and render stay in step. Presentation
is locked to the display, so the achievable rates are the panel's refresh over
an integer: 240 Hz paces to 120, 144 Hz to 72, and 120/90/75/60 Hz pass through
untouched. Every one of those is inside the band, and an evenly-paced 72 is a
better frame than an uneven 120 out of 144 would be. Mobile is left unpaced —
the panel is 60 Hz anyway and the browser's own throttling serves the battery
better than ours would.

Frame pacing matters as much as frame rate. `requestAnimationFrame` deltas
jitter either side of the true refresh interval even on a machine comfortably
hitting its target, and feeding that jitter into the simulation makes a smooth
60 fps *look* like it is stuttering. Deltas within 0.9 ms of a common refresh
interval are snapped onto it and the remainder carried forward, so no time is
invented or lost. World streaming then gets whatever is left of the frame after
rendering rather than a fixed slice — a fixed budget is what turns a tight
frame into a dropped one.

The context is requested as WebGL 2 with a high-performance GPU hint (which is
what moves it onto the discrete GPU on a laptop) and a desynchronized swap
chain. The canvas and the HUD sit on separate compositor layers with CSS
containment between them, so a HUD repaint — and the HUD repaints every frame —
never invalidates the layer the world is drawn into. Tone mapping is AgX, which
holds saturated highlights — reheat plumes, gate energy, sun discs — where ACES
desaturates them towards grey.

---

## 3D assets

The three modelled jets live in `Assets/3d/aircraft/` and are listed both on
their aircraft entries in `config.js` and in `Assets/3d/manifest.json`. They are
also the airframes hostiles fly, so the enemy squadron keeps its full silhouette
variety whatever the player has unlocked. They are
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

A save that names content this build no longer has — an airframe that was cut,
a venue that was renamed — is repaired once on load rather than defended against
at every lookup, so an old save opens on the current roster instead of on
`undefined`.

---

## Licence and credits

Original game. Rendering uses [three.js](https://threejs.org) (MIT, © three.js
authors), vendored under `vendor/three/` with its licence intact. Everything
else — flight model, world generator, AI, audio synthesis, UI — is bespoke to
this project.
