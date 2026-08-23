import { readFile } from 'node:fs/promises';
import {
  TERRAIN_KINDS,
  isWalkable,
  moveOnTerrain,
  packLevel,
  paintCircle,
  terrainSignature,
  unpackLevel,
} from '../src/terrain.js';

const source = JSON.parse(await readFile('src/levels/level1.json', 'utf8'));
const level = unpackLevel(source);
const rebuilt = unpackLevel(packLevel(level));

if (level.gridWidth !== 300 || level.gridHeight !== 200) throw Error('Unexpected terrain grid');
for (const kind of TERRAIN_KINDS) {
  if (level.masks[kind].length !== rebuilt.masks[kind].length) throw Error(`${kind} length changed`);
  for (let i = 0; i < level.masks[kind].length; i++) {
    if (level.masks[kind][i] !== rebuilt.masks[kind][i]) throw Error(`${kind} mask did not round-trip`);
  }
}

const signature = terrainSignature(level);
if (signature !== terrainSignature(rebuilt)) throw Error('Terrain generation is not deterministic');
if (!isWalkable(level, level.player[0], level.player[1], 10)) throw Error('Player start is blocked');
for (const [x, y] of level.enemies) {
  if (!isWalkable(level, x, y, 12)) throw Error(`Enemy start ${x},${y} is blocked`);
}
if (isWalkable(level, 1730, 470, 10)) throw Error('Painted water is walkable');
if (isWalkable(level, 890, 425, 10)) throw Error('Painted ruin collision is walkable');
if (isWalkable(level, -1, 800)) throw Error('Outside the world is walkable');
const runner = { x: 1580, y: 470 };
const blocked = moveOnTerrain(level, runner, 300, 0, 10);
if (!(blocked & 1) || isWalkable(level, 1730, 470, 10) || runner.x >= 1700) {
  throw Error('Substepped movement crossed painted water');
}

const before = rebuilt.masks.grass.slice();
if (!paintCircle(rebuilt, 'grass', 80, 80, 24, 1)) throw Error('Brush did not paint');
if (!paintCircle(rebuilt, 'grass', 80, 80, 24, 0)) throw Error('Brush did not erase');
if (before.every((byte, i) => byte === rebuilt.masks.grass[i])) {
  // The original map is empty here; paint+erase returning to the original is expected.
} else throw Error('Paint and erase did not restore the mask');

console.log(`terrain smoke checks passed (signature ${signature}, packed JSON ${JSON.stringify(source).length} bytes)`);
