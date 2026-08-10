/**
 * ALPHA AIRCRAFT RACE 3D — locations.js
 * ---------------------------------------------------------------------------
 * The venue roster: ten authored locations plus RANDOM.
 *
 * A LOCATION IS A WORLD TYPE, NOT A FIXED MAP. Nothing here describes a place —
 * it describes the *rules* a place is grown from. Picking Emerald Basin twice
 * gives two different valleys, two different road networks, two different towns
 * and two different skies, both unmistakably Emerald Basin. The run seed does
 * the varying; this file constrains it.
 *
 * Every field is a knob the generators in world.js read:
 *
 *   relief      terrain noise — scale, height, ridge/plateau character
 *   hydrology   rivers, lakes, basins, waterfalls, flooding, freezing
 *   civil       what gets built, how densely, how tall, and lit or not
 *   flora       which species grow, which flowers bed, where the tree line is
 *   roads       main corridors, dirt tracks, flyovers, bridges, traffic volume
 *   venues      sports and entertainment structures eligible here
 *   landmark    the one-per-chunk hero structures
 *   weather     the states the menu will let you fly here
 *
 * `props` is the older per-chunk density block and is still read directly by
 * the instanced scatter, so it stays. Nothing in this module imports anything —
 * it is the root of the dependency graph.
 */

/* ---------------------------------------------------------------------------
 * VOCABULARIES
 * ------------------------------------------------------------------------
 * The generators switch on these strings, so a typo in a location's list is a
 * silently missing building rather than a crash. Keep the lists authoritative.
 * ------------------------------------------------------------------------ */

/** Civilian structure kinds the structure library can build. */
export const STRUCTURE_KINDS = [
  'house', 'neighbourhood', 'apartment', 'hotel', 'office', 'bank', 'government',
  'church', 'school', 'hospital', 'fireStation', 'policeStation', 'gasStation',
  'market', 'mall', 'cinema', 'restaurant', 'warehouse', 'industrial', 'factory',
  'construction', 'powerStation', 'waterTreatment', 'commsTower',
  'skyscraper', 'glassTower', 'twinTowers', 'statue', 'monument',
  'barn', 'farm', 'windmill', 'waterTower', 'well', 'dock', 'lodge',
  'researchStation', 'rescueStation', 'observatory', 'skiResort',
  'miningRig', 'solarFarm', 'truckStop', 'floodStation', 'stiltHouse',
];

/** Sports and entertainment venue kinds. */
export const VENUE_KINDS = [
  'footballStadium', 'cricketStadium', 'sportsComplex', 'golfCourse',
  'racingArena', 'sportsGround', 'concertGround', 'amusementPark',
  'ferrisWheel', 'circus', 'themePark',
];

/** Ground vehicle kinds the traffic system can spawn. */
export const VEHICLE_KINDS = [
  'car', 'taxi', 'bus', 'truck', 'van', 'ambulance', 'police',
  'fireTruck', 'construction', 'fuelTruck', 'tractor',
];

/** Tree species. `pine`/`conifer` are the cold set, the rest are warm. */
export const TREE_SPECIES = [
  'pine', 'conifer', 'rosewood', 'gulmohar', 'broadleaf', 'palm', 'karst', 'dead',
];

/** Flower bed kinds. */
export const FLOWER_KINDS = ['daffodil', 'whiteLily', 'wild'];

/* Shorthand so the tables below stay readable. */
const L = (o) => o;

/* ---------------------------------------------------------------------------
 * THE ROSTER
 * ------------------------------------------------------------------------ */

export const LOCATIONS = [
  /* =======================================================================
   * 2 · EMERALD BASIN — green forested river basin · EASY · ×0.75
   * A huge green valley ringed by rolling hills and mountain forest, with an
   * interconnected river network running the length of it. The most generous
   * airspace on the circuit: wide corridors, soft terrain, long sightlines.
   * ==================================================================== */
  L({
    id: 'forest', name: 'EMERALD BASIN', short: 'Basin', order: 0, difficulty: 0.75,
    desc: 'A vast green river basin under fast-moving weather. Braided rivers, waterfalls off the hill shoulders and riverside towns. Wide, flowing racing lines.',
    racing: 'Wide, flowing lines with fast sweeping corners and long runs alongside the rivers.',
    ground: { base: 0x2f4a2a, high: 0x6f7f5a, low: 0x1e3320, rock: 0x5a5b52, snowLine: 2600, water: 0x1d3b4a },
    relief: { scale: 0.00042, height: 900, ridge: 0.45, roughness: 0.55, plateau: 0.20, water: 0.22 },
    props: { trees: 1.0, buildings: 0.34, rocks: 0.40, towers: 0.20, farms: 0.35 },
    hydrology: { rivers: 1.35, lakes: 0.75, basins: 0.80, waterfalls: 0.70, flood: 0, frozen: false },
    civil: {
      coverage: 0.58, scale: 'town', density: 0.62, skyline: 0.22, night: false,
      styles: ['house', 'neighbourhood', 'church', 'school', 'hospital', 'bank', 'market',
        'fireStation', 'gasStation', 'hotel', 'restaurant', 'well', 'barn', 'dock', 'waterTower'],
    },
    flora: {
      trees: ['pine', 'conifer', 'rosewood', 'gulmohar', 'broadleaf'],
      flowers: ['daffodil', 'whiteLily', 'wild'], grass: 1.0, density: 1.15, treeLine: 2300,
    },
    roads: { main: 0.85, dirt: 0.70, elevated: 0.10, bridges: 0.90, style: 'asphalt', traffic: 0.75 },
    venues: ['footballStadium', 'sportsGround', 'golfCourse', 'concertGround'],
    landmark: ['giantRiverBridge', 'mountainWaterfall', 'riversideStadium', 'botanicalGarden', 'hilltopMonument'],
    hazards: ['lowCloud', 'birdStrike'],
    weather: ['clear', 'brightSun', 'partlyCloudy', 'floatingClouds', 'suspendedClouds',
      'goldenHour', 'sunrise', 'dawn', 'overcast', 'cloudy'],
    times: ['morning', 'noon', 'afternoon', 'goldenHour', 'sunrise'],
    accent: 0x7fdc6a, fogTint: 0xa9c4b4,
  }),

  /* =======================================================================
   * 3 · GLACIER REACH — heavy snow glacier world · HARD · ×1.20
   * Frozen mountains, calving shelves and ice rivers. Water here is ice, so
   * `hydrology.frozen` swaps every river and lake surface for a solid sheet.
   * ==================================================================== */
  L({
    id: 'ice', name: 'GLACIER REACH', short: 'Glacier', order: 1, difficulty: 1.20,
    desc: 'A frozen mountain world of enormous glaciers, snow-loaded peaks and frozen valleys. Whiteout squalls, ice pillars and almost no warning.',
    racing: 'Reduced visibility, slick surfaces, narrow mountain passes and sudden ice formations.',
    ground: { base: 0xd8e6ef, high: 0xffffff, low: 0x9fb9cc, rock: 0x6d7c8a, snowLine: 200, water: 0x2b5c78 },
    relief: { scale: 0.00036, height: 1500, ridge: 0.75, roughness: 0.60, plateau: 0.28, water: 0.30 },
    props: { trees: 0.28, buildings: 0.24, rocks: 0.90, towers: 0.22, farms: 0 },
    hydrology: { rivers: 0.85, lakes: 0.70, basins: 0.55, waterfalls: 0.45, flood: 0, frozen: true },
    civil: {
      coverage: 0.30, scale: 'village', density: 0.34, skyline: 0.16, night: true,
      styles: ['researchStation', 'rescueStation', 'lodge', 'observatory', 'skiResort',
        'hospital', 'gasStation', 'house', 'church', 'waterTower', 'commsTower'],
    },
    flora: {
      trees: ['pine', 'conifer', 'dead'], flowers: [], grass: 0.12, density: 0.40, treeLine: 1250,
    },
    roads: { main: 0.55, dirt: 0.45, elevated: 0.05, bridges: 0.55, style: 'ice', traffic: 0.35 },
    venues: ['sportsGround'],
    landmark: ['glacierObservatory', 'iceArch', 'iceTunnel', 'frozenWaterfall', 'shelfWall'],
    hazards: ['iceSheet', 'whiteout', 'crosswind'],
    weather: ['snow', 'heavySnow', 'frozenFog', 'brightSun', 'overcast', 'darkClouds',
      'fogBank', 'partlyCloudy', 'clear'],
    times: ['morning', 'noon', 'dusk', 'afternoon'],
    accent: 0x9fe8ff, fogTint: 0xcfe3f2,
  }),

  /* =======================================================================
   * 4 · ASHFALL FLATS — desert · MEDIUM · ×0.95
   * Dunes, mesa fields and dry riverbeds. `hydrology.rivers` is high but the
   * channels are DRY — the generator carves them and leaves them empty, which
   * is what gives the flats their braided-wadi look from altitude.
   * ==================================================================== */
  L({
    id: 'desert', name: 'ASHFALL FLATS', short: 'Desert', order: 2, difficulty: 0.95,
    desc: 'Endless dunes broken by mesa fields and dry riverbeds. Thermals throw the airframe around and dust erases the horizon without notice.',
    racing: 'Extremely long sightlines, fast terrain and wide-open high-speed desert corridors.',
    ground: { base: 0xc9a06a, high: 0xe6cfa2, low: 0x8f6b42, rock: 0xa5703f, snowLine: 9999, water: 0x3c6b6b },
    relief: { scale: 0.00030, height: 700, ridge: 0.35, roughness: 0.40, plateau: 0.55, water: 0.06 },
    props: { trees: 0.10, buildings: 0.30, rocks: 0.70, towers: 0.30, farms: 0.08 },
    hydrology: { rivers: 0.90, lakes: 0.15, basins: 0.65, waterfalls: 0, flood: 0, frozen: false, dry: true },
    civil: {
      coverage: 0.42, scale: 'town', density: 0.48, skyline: 0.34, night: true,
      styles: ['house', 'neighbourhood', 'gasStation', 'truckStop', 'warehouse', 'hotel',
        'miningRig', 'solarFarm', 'industrial', 'factory', 'market', 'waterTower', 'commsTower'],
    },
    flora: {
      trees: ['palm', 'dead'], flowers: ['wild'], grass: 0.10, density: 0.22, treeLine: 9999,
    },
    roads: { main: 0.90, dirt: 0.95, elevated: 0.12, bridges: 0.45, style: 'asphalt', traffic: 0.70 },
    venues: ['racingArena', 'amusementPark', 'footballStadium', 'sportsGround'],
    landmark: ['desertStatue', 'abandonedMine', 'oasis', 'canyonBridge', 'desertPark', 'mesaArch'],
    hazards: ['thermal', 'dust', 'sandDrift'],
    weather: ['brightSun', 'clear', 'floatingClouds', 'goldenHour', 'sunrise', 'sunset',
      'dawn', 'dustStorm', 'partlyCloudy', 'cloudy'],
    times: ['noon', 'afternoon', 'sunset', 'sunrise', 'goldenHour'],
    accent: 0xffb35c, fogTint: 0xd9b183,
  }),
  /* =======================================================================
   * 5 · VERDANT DELTA — tropical river delta · HARD · ×1.10
   * Karst spires over braided waterways under permanent rain. The wettest
   * venue on the circuit and the one where visibility costs you most.
   * ==================================================================== */
  L({
    id: 'jungle', name: 'VERDANT DELTA', short: 'Delta', order: 3, difficulty: 1.10,
    desc: 'Steaming canopy, karst spires and braided waterways. Low visibility, wet surfaces and cloud suspended between the towers of rock.',
    racing: 'Wet surfaces, low visibility and narrow passages between the karst make this technical throughout.',
    ground: { base: 0x1f4a26, high: 0x3f6b32, low: 0x123219, rock: 0x4c5340, snowLine: 9999, water: 0x14494a },
    relief: { scale: 0.00050, height: 820, ridge: 0.68, roughness: 0.70, plateau: 0.14, water: 0.34 },
    props: { trees: 1.35, buildings: 0.28, rocks: 0.55, towers: 0.18, farms: 0.16 },
    hydrology: { rivers: 1.60, lakes: 0.95, basins: 1.00, waterfalls: 1.10, flood: 0.35, frozen: false, marsh: 0.8 },
    civil: {
      coverage: 0.50, scale: 'town', density: 0.55, skyline: 0.20, night: true,
      styles: ['house', 'stiltHouse', 'neighbourhood', 'school', 'hospital', 'market',
        'church', 'bank', 'fireStation', 'hotel', 'dock', 'warehouse', 'well'],
    },
    flora: {
      trees: ['broadleaf', 'palm', 'karst', 'rosewood', 'gulmohar', 'pine', 'conifer'],
      flowers: ['whiteLily', 'daffodil', 'wild'], grass: 1.20, density: 1.45, treeLine: 2000,
    },
    roads: { main: 0.60, dirt: 0.85, elevated: 0.15, bridges: 1.20, style: 'wet', traffic: 0.55 },
    venues: ['sportsGround', 'concertGround', 'footballStadium'],
    landmark: ['karstSpire', 'deltaWaterfall', 'ruinTemple', 'boatDocks', 'archBridge'],
    hazards: ['lowCloud', 'rainSquall', 'mist'],
    weather: ['heavyRain', 'lightRain', 'darkClouds', 'fog', 'fogBank', 'cloudy',
      'overcast', 'dawn', 'suspendedClouds', 'storm'],
    times: ['sunrise', 'morning', 'noon', 'dawn'],
    accent: 0x54e08a, fogTint: 0xa8c7ae,
  }),

  /* =======================================================================
   * 6 · HOLLOW VALE — green countryside village · EASY · ×0.65
   * The gentlest terrain on the circuit and the fastest lap times. Farmland,
   * hamlets, windmill ridges and hedgerow at first light.
   * ==================================================================== */
  L({
    id: 'village', name: 'HOLLOW VALE', short: 'Vale', order: 4, difficulty: 0.65,
    desc: 'Patchwork farmland, hamlets and windmill ridges at first light. Wheat, flower fields and pasture over the softest terrain anywhere on the circuit.',
    racing: 'Fast, open and forgiving countryside racing with long straights and sweeping turns.',
    ground: { base: 0x5c7a3e, high: 0x8ea45e, low: 0x3d5430, rock: 0x6a6552, snowLine: 3000, water: 0x2f5a68 },
    relief: { scale: 0.00030, height: 480, ridge: 0.25, roughness: 0.40, plateau: 0.50, water: 0.20 },
    props: { trees: 0.70, buildings: 0.55, rocks: 0.20, towers: 0.35, farms: 1.30 },
    hydrology: { rivers: 0.95, lakes: 0.85, basins: 0.60, waterfalls: 0.20, flood: 0, frozen: false },
    civil: {
      coverage: 0.66, scale: 'village', density: 0.70, skyline: 0.10, night: false,
      styles: ['house', 'neighbourhood', 'barn', 'farm', 'school', 'church', 'market',
        'hospital', 'fireStation', 'gasStation', 'windmill', 'waterTower', 'well', 'restaurant'],
    },
    flora: {
      trees: ['broadleaf', 'pine', 'conifer', 'rosewood', 'gulmohar'],
      flowers: ['daffodil', 'whiteLily', 'wild'], grass: 1.30, density: 0.95, treeLine: 2600,
      crops: 1.4,
    },
    roads: { main: 0.75, dirt: 1.20, elevated: 0.04, bridges: 0.70, style: 'country', traffic: 0.60 },
    venues: ['footballStadium', 'golfCourse', 'sportsGround', 'circus', 'concertGround'],
    landmark: ['villageWindmill', 'hilltopChurch', 'countrysideStatue', 'fairground', 'ruralStadium', 'golfClubhouse'],
    hazards: ['birdStrike', 'lowCloud'],
    weather: ['clear', 'brightSun', 'sunrise', 'dawn', 'goldenHour', 'sunset',
      'partlyCloudy', 'floatingClouds', 'suspendedClouds', 'overcast'],
    times: ['sunrise', 'morning', 'noon', 'goldenHour', 'dawn'],
    accent: 0xffd98a, fogTint: 0xcfd6b8,
  }),
  /* =======================================================================
   * 7 · DROWNED FLATS — flooded muddy lowlands · MEDIUM · ×1.00
   * A low-lying delta where the water has come up over the roads and fields.
   * `flood` raises standing water above the terrain rather than cutting into
   * it, which is what puts buildings ankle-deep instead of on a riverbank.
   * ==================================================================== */
  L({
    id: 'mudwater', name: 'DROWNED FLATS', short: 'Flats', order: 5, difficulty: 1.00,
    desc: 'A flooded delta of silt banks and standing water. Mirror-flat reflections, permanent rain and almost no altitude to play with.',
    racing: 'Low altitude, muddy terrain, standing water and unpredictable wet-road conditions.',
    ground: { base: 0x4a4030, high: 0x6b5c44, low: 0x2a2620, rock: 0x54503f, snowLine: 9999, water: 0x2c3f3a },
    relief: { scale: 0.00028, height: 260, ridge: 0.20, roughness: 0.35, plateau: 0.50, water: 0.62 },
    props: { trees: 0.50, buildings: 0.40, rocks: 0.30, towers: 0.30, farms: 0.40 },
    hydrology: { rivers: 1.40, lakes: 1.20, basins: 1.10, waterfalls: 0, flood: 1.0, frozen: false, marsh: 1.2 },
    civil: {
      coverage: 0.52, scale: 'town', density: 0.56, skyline: 0.18, night: true,
      styles: ['house', 'stiltHouse', 'neighbourhood', 'hospital', 'school', 'fireStation',
        'bank', 'market', 'gasStation', 'warehouse', 'floodStation', 'waterTreatment', 'dock'],
    },
    flora: {
      trees: ['pine', 'conifer', 'rosewood', 'gulmohar', 'broadleaf', 'dead'],
      flowers: ['daffodil', 'whiteLily', 'wild'], grass: 0.85, density: 0.70, treeLine: 9999,
    },
    roads: { main: 0.70, dirt: 0.80, elevated: 0.35, bridges: 1.10, style: 'flooded', traffic: 0.50 },
    venues: ['sportsGround', 'footballStadium'],
    landmark: ['floodBarrier', 'temporaryBridge', 'submergedTown', 'pumpingStation', 'archBridge'],
    hazards: ['standingWater', 'mist', 'debris'],
    weather: ['lightRain', 'heavyRain', 'fog', 'fogBank', 'cloudy', 'overcast',
      'darkClouds', 'dawn', 'sunset', 'storm'],
    times: ['morning', 'afternoon', 'sunset', 'dusk', 'dawn'],
    accent: 0x8fd8c0, fogTint: 0x9aa79c,
  }),

  /* =======================================================================
   * 8 · MERIDIAN SPRAWL — modern metropolis · MEDIUM · ×1.10
   * The line runs BETWEEN the buildings, not above them. Highest `skyline` and
   * `roads.elevated` outside Neon, and the densest daytime traffic anywhere.
   * ==================================================================== */
  L({
    id: 'city', name: 'MERIDIAN SPRAWL', short: 'City', order: 6, difficulty: 1.10,
    desc: 'A living megacity of glass towers, elevated arterials and tunnel sections. Dense districts, heavy traffic and a skyline that closes in around the route.',
    racing: 'High-speed urban racing between buildings, under bridges and through elevated road networks.',
    ground: { base: 0x3c4149, high: 0x596069, low: 0x24282e, rock: 0x454a52, snowLine: 9999, water: 0x1c3040 },
    relief: { scale: 0.00026, height: 340, ridge: 0.20, roughness: 0.30, plateau: 0.75, water: 0.18 },
    props: { trees: 0.35, buildings: 1.60, rocks: 0.10, towers: 1.10, farms: 0 },
    hydrology: { rivers: 0.70, lakes: 0.35, basins: 0.30, waterfalls: 0, flood: 0, frozen: false },
    civil: {
      coverage: 0.70, scale: 'metropolis', density: 1.00, skyline: 0.95, night: true,
      styles: ['skyscraper', 'glassTower', 'twinTowers', 'office', 'bank', 'government',
        'apartment', 'hotel', 'mall', 'cinema', 'restaurant', 'market', 'hospital', 'school',
        'fireStation', 'policeStation', 'gasStation', 'neighbourhood', 'statue', 'commsTower',
        'powerStation', 'waterTreatment', 'construction', 'warehouse'],
    },
    flora: {
      trees: ['broadleaf', 'pine', 'rosewood', 'gulmohar'],
      flowers: ['daffodil', 'whiteLily'], grass: 0.45, density: 0.35, treeLine: 9999, parks: 0.8,
    },
    roads: { main: 1.00, dirt: 0.10, elevated: 0.90, bridges: 0.85, style: 'urban', traffic: 1.40, tunnels: 0.5 },
    venues: ['footballStadium', 'cricketStadium', 'sportsComplex', 'golfCourse',
      'amusementPark', 'ferrisWheel', 'racingArena', 'concertGround'],
    landmark: ['cityStatue', 'centralBankTower', 'twinTowerComplex', 'giantStadium',
      'metroStation', 'majorBridge', 'megaSpire'],
    hazards: ['towerWake', 'lowCloud'],
    weather: ['clear', 'brightSun', 'cloudy', 'floatingClouds', 'suspendedClouds',
      'goldenHour', 'sunrise', 'sunset', 'dawn', 'overcast', 'darkClouds', 'lightRain', 'night'],
    times: ['morning', 'noon', 'afternoon', 'goldenHour', 'sunset', 'night'],
    accent: 0x64c8ff, fogTint: 0xb9c6d2,
  }),
  /* =======================================================================
   * 9 · TITAN RANGE — green high mountains · HARD · ×1.25
   * The tallest relief on the roster by a wide margin. Vertical racing: the
   * route threads passes barely wider than a wingspan, and the tree line is
   * low enough that most of the terrain you fly past is bare rock and snow.
   * ==================================================================== */
  L({
    id: 'mountain', name: 'TITAN RANGE', short: 'Range', order: 7, difficulty: 1.25,
    desc: 'Serrated peaks over forested hills, mountain lakes and waterfalls off the shoulders. High-altitude corridors and passes barely wider than a wingspan.',
    racing: 'Extreme elevation changes, narrow mountain passes and dramatic vertical racing.',
    ground: { base: 0x565f5a, high: 0xe8eef2, low: 0x33403c, rock: 0x6a716d, snowLine: 1800, water: 0x24444f },
    relief: { scale: 0.00030, height: 2100, ridge: 0.90, roughness: 0.70, plateau: 0.12, water: 0.14 },
    props: { trees: 0.60, buildings: 0.26, rocks: 1.00, towers: 0.22, farms: 0.10 },
    hydrology: { rivers: 1.15, lakes: 0.80, basins: 0.90, waterfalls: 1.35, flood: 0, frozen: false },
    civil: {
      coverage: 0.34, scale: 'village', density: 0.38, skyline: 0.14, night: true,
      styles: ['house', 'neighbourhood', 'hotel', 'hospital', 'school', 'church',
        'rescueStation', 'gasStation', 'market', 'skiResort', 'lodge', 'observatory', 'commsTower'],
    },
    flora: {
      trees: ['pine', 'conifer', 'rosewood', 'gulmohar', 'broadleaf'],
      flowers: ['daffodil', 'whiteLily', 'wild'], grass: 0.75, density: 0.85, treeLine: 1700,
    },
    roads: { main: 0.60, dirt: 0.90, elevated: 0.20, bridges: 1.05, style: 'mountain', traffic: 0.45 },
    venues: ['sportsGround', 'footballStadium', 'amusementPark'],
    landmark: ['mountainStatue', 'suspensionBridge', 'mountainStadium', 'hilltopChurch',
      'mountainPark', 'largeObservatory', 'summitGate'],
    hazards: ['crosswind', 'lowCloud', 'rockfall'],
    weather: ['clear', 'brightSun', 'floatingClouds', 'suspendedClouds', 'cloudy',
      'goldenHour', 'sunrise', 'dawn', 'sunset', 'overcast', 'snow', 'fog'],
    times: ['sunrise', 'morning', 'afternoon', 'goldenHour', 'sunset'],
    accent: 0xbfe6ff, fogTint: 0xb8c8d6,
  }),

  /* =======================================================================
   * 10 · CITADEL SIEGE — green highland fortress · VERY HARD · ×1.30
   * Medieval-scale stonework on a storm-lashed highland. The fortress is the
   * landmark set, and the modern town sits outside the curtain walls.
   * ==================================================================== */
  L({
    id: 'fortress', name: 'CITADEL SIEGE', short: 'Citadel', order: 8, difficulty: 1.30,
    desc: 'A walled highland citadel of curtain walls, keeps and siege towers, ringed by storm cells. Green mountains, forest and rivers outside the stonework.',
    racing: 'High-risk low passes between fortress structures and mountain walls, inside a live storm system.',
    ground: { base: 0x4f4a41, high: 0x736c5e, low: 0x2b2a27, rock: 0x605a4f, snowLine: 3000, water: 0x2b4450 },
    relief: { scale: 0.00040, height: 1050, ridge: 0.62, roughness: 0.58, plateau: 0.42, water: 0.28 },
    props: { trees: 0.45, buildings: 0.95, rocks: 0.60, towers: 0.90, farms: 0.22 },
    hydrology: { rivers: 1.05, lakes: 0.65, basins: 0.85, waterfalls: 0.80, flood: 0, frozen: false },
    civil: {
      coverage: 0.60, scale: 'town', density: 0.72, skyline: 0.30, night: true,
      fortress: 1.0,
      styles: ['house', 'neighbourhood', 'bank', 'school', 'hospital', 'market',
        'fireStation', 'gasStation', 'hotel', 'church', 'statue', 'monument', 'well'],
    },
    flora: {
      trees: ['pine', 'conifer', 'rosewood', 'gulmohar', 'broadleaf'],
      flowers: ['daffodil', 'whiteLily', 'wild'], grass: 1.0, density: 0.80, treeLine: 2400,
    },
    roads: { main: 0.55, dirt: 0.75, elevated: 0.10, bridges: 1.00, style: 'stone', traffic: 0.45 },
    venues: ['sportsComplex', 'sportsGround', 'footballStadium', 'concertGround'],
    landmark: ['giantCastle', 'curtainWall', 'gatehouse', 'siegeTower', 'fortifiedBridge',
      'keep', 'courtyardStatue'],
    hazards: ['lightning', 'windShear', 'flyingDebris'],
    weather: ['thunderstorm', 'storm', 'darkClouds', 'overcast', 'heavyRain',
      'cloudy', 'sunset', 'dawn', 'fogBank'],
    times: ['afternoon', 'dusk', 'sunset', 'dawn'],
    accent: 0xffb648, fogTint: 0x8e9299,
  }),
  /* =======================================================================
   * 11 · NEON MEGACITY — futuristic green megacity · VERY HARD · ×1.40
   * The hardest venue, and the only one with the full urban stack AND real
   * green space: parks, botanical gardens, rivers and hills wrapped around a
   * skyline of glass. `night: true` plus `neon` lights every façade.
   * ==================================================================== */
  L({
    id: 'neon', name: 'NEON MEGACITY', short: 'Neon', order: 9, difficulty: 1.40,
    desc: 'A futuristic megacity of glass towers and neon arterials, ringed by green hills, forest parks and rivers. Every surface is a light source and every reflection lies about the distance.',
    racing: 'Extremely fast urban racing through skyscraper corridors, elevated highways, tunnels and dense infrastructure.',
    ground: { base: 0x191d29, high: 0x2a3145, low: 0x0d1018, rock: 0x212636, snowLine: 9999, water: 0x0d1622 },
    relief: { scale: 0.00026, height: 380, ridge: 0.24, roughness: 0.32, plateau: 0.78, water: 0.20 },
    props: { trees: 0.45, buildings: 1.80, rocks: 0.10, towers: 1.40, farms: 0 },
    hydrology: { rivers: 0.85, lakes: 0.55, basins: 0.45, waterfalls: 0.15, frozen: false, flood: 0 },
    civil: {
      coverage: 0.70, scale: 'megacity', density: 1.15, skyline: 1.00, night: true, neon: 1.0,
      styles: ['glassTower', 'skyscraper', 'twinTowers', 'office', 'bank', 'government',
        'apartment', 'hotel', 'mall', 'cinema', 'restaurant', 'market', 'hospital', 'school',
        'fireStation', 'policeStation', 'neighbourhood', 'statue', 'monument', 'commsTower',
        'powerStation', 'construction'],
    },
    flora: {
      trees: ['pine', 'conifer', 'rosewood', 'gulmohar', 'broadleaf'],
      flowers: ['daffodil', 'whiteLily'], grass: 0.70, density: 0.55, treeLine: 9999, parks: 1.3,
    },
    roads: { main: 1.00, dirt: 0.05, elevated: 1.00, bridges: 0.90, style: 'neon', traffic: 1.50, tunnels: 0.8 },
    venues: ['footballStadium', 'cricketStadium', 'sportsComplex', 'golfCourse',
      'amusementPark', 'ferrisWheel', 'themePark', 'concertGround', 'racingArena'],
    landmark: ['futuristicStatue', 'megaAmusementPark', 'observationTower', 'twinTowerDistrict',
      'concertComplex', 'megaSpire', 'skyBridge', 'holoArray'],
    hazards: ['towerWake', 'holoGlare', 'lowCloud'],
    weather: ['neonNight', 'night', 'clear', 'brightSun', 'goldenHour', 'sunset', 'dawn',
      'darkClouds', 'floatingClouds', 'suspendedClouds', 'fog', 'overcast'],
    times: ['night', 'sunset', 'goldenHour', 'dawn', 'noon'],
    accent: 0xff2fd0, fogTint: 0x2a2140,
  }),
];

/* ---------------------------------------------------------------------------
 * RANDOM
 * ------------------------------------------------------------------------
 * Not a location — an instruction. The menu card carries this metadata so the
 * panel can describe it without a special case, and `pickVenue` in game.js
 * treats the id 'random' as "draw one from LOCATIONS with the run seed".
 * ------------------------------------------------------------------------ */
export const RANDOM_LOCATION = {
  id: 'random', name: 'RANDOM', short: 'Random', order: -1, difficulty: 1.0,
  desc: 'A different venue every launch, drawn from the full roster with the run seed. Terrain, civilisation, weather and time of day are all decided at the countdown.',
  racing: 'Variable — you find out what you are flying when the world loads.',
  accent: 0xffffff, random: true,
};


export const LOCATIONS_BY_ID = Object.fromEntries(LOCATIONS.map((l) => [l.id, l]));

/** Menu order: RANDOM first, then the ten authored venues by `order`. */
export const LOCATION_MENU = ['random', ...LOCATIONS.slice().sort((a, b) => a.order - b.order).map((l) => l.id)];
