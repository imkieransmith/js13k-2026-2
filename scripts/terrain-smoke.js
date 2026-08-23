import { readFile } from 'node:fs/promises';
import {
  AUTHOR_TILE,
  TERRAIN_KINDS,
  gridAt,
  isWalkable,
  maskAt,
  moveOnTerrain,
  normaliseGrid,
  packLevel,
  paintCircle,
  paintGridCell,
  paintGridRect,
  terrainMaterialAt,
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

const blankSource = {
  width: 64, height: 64, cell: 8, seed: 1, player: [16, 16], enemies: [], masks: {},
};
const blank = unpackLevel(blankSource);
if (!paintGridCell(blank, 'grass', 0, 0)) throw Error('Grid pencil did not paint');
if (!gridAt(blank, 'grass', 0, 0) || gridAt(blank, 'grass', 1, 0)) throw Error('Grid occupancy escaped its tile');
let paintedFineCells = 0;
for (let y = 4; y < 32; y += 8) for (let x = 4; x < 32; x += 8) {
  paintedFineCells += maskAt(blank, 'grass', x, y);
}
if (paintedFineCells !== 16 || AUTHOR_TILE !== 32) throw Error('Author tile is not exactly 4x4 mask cells');
const grassBeforeOtherLayer = blank.masks.grass.slice();
paintGridRect(blank, 'dirt', 0, 0, 1, 1);
if (grassBeforeOtherLayer.some((byte, i) => byte !== blank.masks.grass[i])) throw Error('Layer painting changed grass');
if (!isWalkable(blank, 16, 16)) throw Error('Grid-painted land is not walkable');
paintGridCell(blank, 'grass', 0, 0, 0);
paintGridCell(blank, 'dirt', 0, 0, 0);
paintGridCell(blank, 'ruins', 0, 0, 1);
if (!isWalkable(blank, 16, 16)) throw Error('Floor is not independently walkable');
paintGridCell(blank, 'collision', 2, 2, 1, 8);
if (isWalkable(blank, 20, 20)) throw Error('Fine collision brush did not block floor');
const overlap = unpackLevel(packLevel(blank));
if (!gridAt(overlap, 'ruins', 0, 0) || !gridAt(overlap, 'dirt', 1, 1)) throw Error('Grid overlap did not round-trip');
const partial = unpackLevel(blankSource);
for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) paintGridCell(partial, 'grass', x, y, 1, 8);
normaliseGrid(partial, ['grass']);
if (!gridAt(partial, 'grass', 0, 0)) throw Error('Half-full legacy tile did not normalise as painted');
for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
  if (!maskAt(partial, 'grass', x * 8 + 4, y * 8 + 4)) throw Error('Normalised tile retained partial cells');
}
const edgeLevel = unpackLevel(blankSource);
paintGridCell(edgeLevel, 'ruins', 0, 0, 1);
paintGridCell(edgeLevel, 'grass', 1, 0, 1);
if (terrainMaterialAt(edgeLevel, 12, 16) !== 5 || terrainMaterialAt(edgeLevel, 52, 16) !== 3) {
  throw Error('Complete author tile interiors were eroded');
}
const boundaryMaterials = new Set();
for (let y = 2; y < 30; y += 2) for (let x = 27; x < 38; x++) {
  boundaryMaterials.add(terrainMaterialAt(edgeLevel, x, y));
}
if (!boundaryMaterials.has(3) || !boundaryMaterials.has(5)) throw Error('Floor/grass boundary has no partial variation');
if (terrainSignature(edgeLevel) !== terrainSignature(unpackLevel(packLevel(edgeLevel)))) {
  throw Error('Grid-edge rendering changed after save/load');
}

const before = rebuilt.masks.grass.slice();
if (!paintCircle(rebuilt, 'grass', 80, 80, 24, 1)) throw Error('Brush did not paint');
if (!paintCircle(rebuilt, 'grass', 80, 80, 24, 0)) throw Error('Brush did not erase');
if (before.every((byte, i) => byte === rebuilt.masks.grass[i])) {
  // The original map is empty here; paint+erase returning to the original is expected.
} else throw Error('Paint and erase did not restore the mask');

console.log(`terrain smoke checks passed (signature ${signature}, packed JSON ${JSON.stringify(source).length} bytes)`);
