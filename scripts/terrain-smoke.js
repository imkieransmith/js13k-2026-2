import { readFile } from 'node:fs/promises';
import {
  AUTHOR_TILE,
  TERRAIN_KINDS,
  gridAt,
  isWalkable,
  maskAt,
  moveOnTerrain,
  noiseAt,
  normaliseGrid,
  packLevel,
  paintCircle,
  paintGridCell,
  paintGridRect,
  paintNoiseCell,
  paintNoiseRect,
  terrainHash,
  terrainMaterialAt,
  terrainSignature,
  unpackLevel,
  wallSouthAt,
} from '../src/terrain.js';

const source = JSON.parse(await readFile('src/levels/level1.json', 'utf8'));
const level = unpackLevel(source);
const rebuilt = unpackLevel(packLevel(level));

if (level.gridWidth !== 300 || level.gridHeight !== 200) throw Error('Unexpected terrain grid');
if (!source.masks.walls && level.masks.walls.some(Boolean)) throw Error('Legacy level decoded phantom walls');
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
if (noiseAt(blank, 0, 0) !== 1) throw Error('Legacy noise did not default to Low');
const masksBeforeNoise = Object.fromEntries(TERRAIN_KINDS.map(kind => [kind, blank.masks[kind].slice()]));
if (!paintNoiseCell(blank, 0, 0, 4) || noiseAt(blank, 0, 0) !== 4) throw Error('Noise pencil did not paint Extreme');
if (!paintNoiseRect(blank, 0, 1, 1, 1, 2) || noiseAt(blank, 1, 1) !== 2) throw Error('Noise rectangle did not paint Medium');
for (const kind of TERRAIN_KINDS) {
  if (masksBeforeNoise[kind].some((byte, index) => byte !== blank.masks[kind][index])) {
    throw Error(`Noise painting changed ${kind}`);
  }
}
const noiseRoundTrip = unpackLevel(packLevel(blank));
if (noiseAt(noiseRoundTrip, 0, 0) !== 4 || noiseAt(noiseRoundTrip, 1, 1) !== 2
  || packLevel(noiseRoundTrip).noise.length !== 3) {
  throw Error('Five-level noise values did not round-trip');
}
const oldHigh = unpackLevel({ ...blankSource, width: 32, height: 32, noise: ['', 'AAE='] });
const oldExtreme = unpackLevel({ ...blankSource, width: 32, height: 32, noise: ['AAE=', 'AAE='] });
if (noiseAt(oldHigh, 0, 0) !== 3 || noiseAt(oldExtreme, 0, 0) !== 4) {
  throw Error('Four-level noise data did not migrate around Medium');
}
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
const masksBeforeWall = Object.fromEntries(TERRAIN_KINDS
  .filter(kind => kind !== 'walls').map(kind => [kind, blank.masks[kind].slice()]));
const noiseBeforeWall = blank.noise.slice();
paintGridCell(blank, 'walls', 0, 0, 1);
paintGridCell(blank, 'walls', 0, 1, 1);
paintGridCell(blank, 'walls', 1, 1, 1);
if (wallSouthAt(blank, 0, 0) || !wallSouthAt(blank, 0, 1) || !wallSouthAt(blank, 1, 1)) {
  throw Error('Wall footprint did not expose only its southern boundary');
}
if (!isWalkable(blank, 48, 48)) throw Error('Wall footprint changed walkability without collision');
for (const kind of Object.keys(masksBeforeWall)) {
  if (masksBeforeWall[kind].some((byte, index) => byte !== blank.masks[kind][index])) {
    throw Error(`Wall painting changed ${kind}`);
  }
}
if (noiseBeforeWall.some((value, index) => value !== blank.noise[index])) throw Error('Wall painting changed noise');
const topology = unpackLevel({ width: 192, height: 128, cell: 8, seed: 3, player: [16, 16], enemies: [], masks: {} });
for (const [x, y] of [[0, 0], [0, 1], [1, 1], [3, 0], [4, 0], [4, 1], [5, 0]]) {
  paintGridCell(topology, 'walls', x, y, 1);
}
const facades = [];
for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) {
  if (wallSouthAt(topology, x, y)) facades.push(`${x},${y}`);
}
if (facades.join('|') !== '3,0|5,0|0,1|1,1|4,1') {
  throw Error(`Wall steps, gaps, or thick footprint emitted wrong facades: ${facades}`);
}
const overlap = unpackLevel(packLevel(blank));
if (!gridAt(overlap, 'ruins', 0, 0) || !gridAt(overlap, 'dirt', 1, 1)
  || !gridAt(overlap, 'walls', 1, 1) || !wallSouthAt(overlap, 1, 1)) {
  throw Error('Grid overlap or wall footprint did not round-trip');
}
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

// Frozen pre-noise sampler proves absent/default-Low data retains the accepted edge recipe.
const legacyRandom = (x, y, salt) => terrainHash(x, y, salt) / 4294967296;
function legacyField(x, y, salt) {
  const ix = Math.floor(x); const iy = Math.floor(y);
  let fx = x - ix; let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = legacyRandom(ix, iy, salt) * (1 - fx) + legacyRandom(ix + 1, iy, salt) * fx;
  const b = legacyRandom(ix, iy + 1, salt) * (1 - fx) + legacyRandom(ix + 1, iy + 1, salt) * fx;
  return a * (1 - fy) + b * fy;
}
function legacyCoverage(fixture, kind, worldX, worldY) {
  const gx = worldX / fixture.cell - 0.5; const gy = worldY / fixture.cell - 0.5;
  const x = Math.floor(gx); const y = Math.floor(gy); const tx = gx - x; const ty = gy - y;
  const at = (cx, cy) => maskAt(fixture, kind, (cx + 0.5) * fixture.cell, (cy + 0.5) * fixture.cell);
  const a = at(x, y); const b = at(x + 1, y); const c = at(x, y + 1); const d = at(x + 1, y + 1);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}
function legacyOrganic(fixture, kind, worldX, worldY, salt) {
  const value = legacyCoverage(fixture, kind, worldX, worldY);
  return value > 0.02 && value < 0.98
    ? value + (legacyField(worldX / 5, worldY / 5, fixture.seed + salt) - 0.5) * 0.42
    : value;
}
function legacySurface(fixture, x, y) {
  const land = Math.max(legacyOrganic(fixture, 'grass', x, y, 7),
    legacyOrganic(fixture, 'dirt', x, y, 11), legacyOrganic(fixture, 'ruins', x, y, 13));
  return Math.min(land, 1 - legacyOrganic(fixture, 'water', x, y, 17));
}
function legacyMaterial(fixture, x, y) {
  const surface = legacySurface(fixture, x, y);
  if (surface > 0.56) {
    if (legacyOrganic(fixture, 'ruins', x, y, 43) > 0.5) return 5;
    if (legacyOrganic(fixture, 'dirt', x, y, 29) > 0.5) return 4;
    return 3;
  }
  if (surface > 0.34) return 1;
  return legacySurface(fixture, x, y - 10) > 0.5 ? 2 : 0;
}
for (let y = 0; y < edgeLevel.height; y++) for (let x = 0; x < edgeLevel.width; x++) {
  if (terrainMaterialAt(edgeLevel, x + 0.5, y + 0.5) !== legacyMaterial(edgeLevel, x + 0.5, y + 0.5)) {
    throw Error(`Default Low differs from legacy renderer at ${x},${y}`);
  }
}

function boundaryFixture(strength, shoreline = false) {
  const fixture = unpackLevel({
    width: 128, height: 96, cell: 8, seed: 1, player: [16, 16], enemies: [], masks: {}, noise: ['', '', ''],
  });
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) {
    paintGridCell(fixture, x < 2 ? shoreline ? 'grass' : 'ruins' : shoreline ? 'water' : 'grass', x, y, 1);
    paintNoiseCell(fixture, x, y, strength);
  }
  return fixture;
}

const displacedCounts = [];
for (let strength = 0; strength < 5; strength++) {
  const fixture = boundaryFixture(strength);
  let displaced = 0;
  for (let y = 0; y < 96; y++) for (let x = 0; x < 128; x++) {
    displaced += terrainMaterialAt(fixture, x + 0.5, y + 0.5) !== (x < 64 ? 5 : 3);
  }
  displacedCounts.push(displaced);
}
if (!(displacedCounts[0] < displacedCounts[1]
  && displacedCounts[1] < displacedCounts[2]
  && displacedCounts[2] < displacedCounts[3]
  && displacedCounts[3] < displacedCounts[4])) {
  throw Error(`Noise levels did not progressively broaden boundaries: ${displacedCounts}`);
}

function leakageFixture(extremeX = -1) {
  const fixture = unpackLevel({
    width: 128, height: 64, cell: 8, seed: 9, player: [16, 16], enemies: [], masks: {},
  });
  for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) {
    paintGridCell(fixture, x % 2 ? 'grass' : 'ruins', x, y, 1);
    if (x === extremeX) paintNoiseCell(fixture, x, y, 4);
  }
  return fixture;
}
const leakageLow = leakageFixture();
for (const extremeX of [0, 3]) {
  const leakageExtreme = leakageFixture(extremeX);
  for (let y = 0; y < 64; y++) for (let x = 60; x < 68; x++) {
    if (terrainMaterialAt(leakageExtreme, x + 0.5, y + 0.5)
      !== terrainMaterialAt(leakageLow, x + 0.5, y + 0.5)) {
      throw Error(`Extreme tile ${extremeX} leaked into an unrelated boundary at ${x},${y}`);
    }
  }
}

const isolated = unpackLevel({
  width: 96, height: 96, cell: 8, seed: 4, player: [16, 16], enemies: [], masks: {}, noise: ['', '', ''],
});
for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
  paintGridCell(isolated, 'grass', x, y, 1);
  paintNoiseCell(isolated, x, y, 4);
}
paintGridCell(isolated, 'ruins', 1, 1, 1);
let visibleFloor = 0;
for (let y = 32; y < 64; y++) for (let x = 32; x < 64; x++) {
  visibleFloor += terrainMaterialAt(isolated, x + 0.5, y + 0.5) === 5;
}
if (visibleFloor >= AUTHOR_TILE * AUTHOR_TILE / 2) throw Error('Extreme noise did not erode half an exposed tile');

const surrounded = unpackLevel({
  width: 96, height: 96, cell: 8, seed: 8, player: [16, 16], enemies: [], masks: {}, noise: ['', '', ''],
});
for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
  paintGridCell(surrounded, 'ruins', x, y, 1);
  paintNoiseCell(surrounded, x, y, 4);
}
for (let y = 36; y < 60; y += 4) for (let x = 36; x < 60; x += 4) {
  if (terrainMaterialAt(surrounded, x, y) !== 5) throw Error('Extreme noise eroded a surrounded interior');
}
const extremeShore = boundaryFixture(4, true);
if (!isWalkable(extremeShore, 60, 48) || isWalkable(extremeShore, 68, 48)) {
  throw Error('Cosmetic shoreline noise changed authoritative walkability');
}
if (terrainSignature(extremeShore) !== terrainSignature(unpackLevel(packLevel(extremeShore)))) {
  throw Error('Noisy shoreline changed after save/load');
}

const before = rebuilt.masks.grass.slice();
if (!paintCircle(rebuilt, 'grass', 80, 80, 24, 1)) throw Error('Brush did not paint');
if (!paintCircle(rebuilt, 'grass', 80, 80, 24, 0)) throw Error('Brush did not erase');
if (before.every((byte, i) => byte === rebuilt.masks.grass[i])) {
  // The original map is empty here; paint+erase returning to the original is expected.
} else throw Error('Paint and erase did not restore the mask');

console.log(`terrain smoke checks passed (signature ${signature}, packed JSON ${JSON.stringify(source).length} bytes)`);
