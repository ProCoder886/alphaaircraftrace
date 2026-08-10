const fs = require('fs');
const p = 'js/config.js';
let s = fs.readFileSync(p, 'utf8');

const startMark = '/* ===========================================================================\n * BIOMES / LOCATIONS';
const endMark = 'export const BIOMES_BY_ID = Object.fromEntries(BIOMES.map((b) => [b.id, b]));';
const i = s.indexOf(startMark), j = s.indexOf(endMark);
if (i < 0 || j < 0) { console.error('markers not found', i, j); process.exit(1); }

const replacement = [
  '/* ===========================================================================',
  ' * BIOMES / LOCATIONS',
  ' * ------------------------------------------------------------------------',
  ' * The roster lives in ./locations.js, which is now the root of the graph.',
  ' * A location is an *aerial* interpretation: the aircraft always races through',
  ' * open sky, and the location decides what is underneath, what is built on it',
  ' * and what the air looks like.',
  ' *',
  ' * `BIOMES` is the historical name and stays as the alias every other module',
  ' * already imports — in this codebase a biome and a location are the same',
  ' * record, so aliasing is honest rather than a shim.',
  ' * ======================================================================== */',
  '',
  'export {',
  '  LOCATIONS, LOCATIONS_BY_ID, LOCATION_MENU, RANDOM_LOCATION,',
  '  STRUCTURE_KINDS, VENUE_KINDS, VEHICLE_KINDS, TREE_SPECIES, FLOWER_KINDS,',
  "} from './locations.js';",
  '',
  'export const BIOMES = LOCATIONS;',
  '',
].join('\n');

s = s.slice(0, i) + replacement + s.slice(j);
s = s.replace(endMark, 'export const BIOMES_BY_ID = LOCATIONS_BY_ID;');

s = s.replace(
  ' * Nothing in this module imports anything else — it is the root of the graph.',
  ' * The only import is the venue roster in ./locations.js, which imports nothing\n * itself and is therefore the true root of the graph.',
);
s = s.replace(
  "export const VERSION = '1.0.0';",
  "import { LOCATIONS, LOCATIONS_BY_ID } from './locations.js';\n\nexport const VERSION = '1.1.0';",
);

fs.writeFileSync(p, s);
console.log('spliced ok');
