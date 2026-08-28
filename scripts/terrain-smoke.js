import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  AUTHOR_TILE,
  MAX_STACK_ENTRIES,
  addStackEntry,
  collisionAt,
  editStackCells,
  isWalkable,
  moveOnTerrain,
  moveStackEntry,
  packLevel,
  paintCollisionCell,
  paintCollisionRect,
  removeStackEntry,
  removeStackIndex,
  stackAt,
  stackKeyAt,
  terrainSignature,
  unpackLevel,
  validateStack,
  buildTerrain,
  RGB,
  STONE,
  RAISED_LIFT,
} from '../src/terrain.js';

const source = JSON.parse(readFileSync(new URL('../src/levels/level1.json', import.meta.url)));
const level = unpackLevel(source);
assert.equal(level.width, 2400);
assert.equal(level.height, 1600);
assert.equal(level.tileWidth, 75);
assert.equal(level.tileHeight, 50);
assert.ok(!('masks' in source) && !('noise' in source), 'Legacy terrain schema survived replacement');

const key = stack => stack.join('');
let stack = [];
stack = addStackEntry(stack, 'floor');
stack = addStackEntry(stack, 'grass');
stack = addStackEntry(stack, 'wall');
stack = addStackEntry(stack, 'floor');
stack = addStackEntry(stack, 'grass');
stack = addStackEntry(stack, 'water');
assert.equal(key(stack), 'fg#fgw');
assert.equal(key(addStackEntry(['#', 'f', 'g'], 'floor')), '#gf');
assert.equal(key(addStackEntry(['f', '#', 'g'], 'dirt', 'ground')), 'fd#g');
assert.equal(key(addStackEntry(['f', '#', 'g'], 'stairs')), 'f^g');
assert.equal(key(addStackEntry(['f', '^', 'g'], 'wall')), 'f#g');
assert.deepEqual(removeStackEntry(['g', '#', 'f', 'g'], 'wall'), ['f', 'g']);
assert.deepEqual(removeStackEntry(['g', '^', 'f', 'g'], 'stairs'), ['f', 'g']);
assert.deepEqual(removeStackIndex(['g', '#', 'f'], 1), ['g', 'f']);
assert.deepEqual(moveStackEntry(['f', 'g'], 0, 1), ['g', 'f']);
assert.throws(() => moveStackEntry(['g', '#', 'g'], 1, 1), /duplicate/i);
assert.throws(() => addStackEntry(['g'], 'floor', 'upper'), /require.*structure/i);
assert.throws(() => addStackEntry(['g', 'd', 'w', 'f', 'b', 's', '#', 'g', 'f'], 'dirt'), /full/);
assert.throws(() => validateStack(['g', 'g']), /duplicate/i);
assert.throws(() => validateStack(['g', '#', '^', 'f']), /multiple structures/i);
assert.throws(() => validateStack(Array(MAX_STACK_ENTRIES + 1).fill('g')), /exceeds|duplicate/i);

function blank(width = 160, height = 128, seed = 3) {
  const tileWidth = width / AUTHOR_TILE;
  const tileHeight = height / AUTHOR_TILE;
  return {
    width,
    height,
    cell: 8,
    seed,
    player: [48, 48],
    enemies: [],
    tileWidth,
    tileHeight,
    collisionWidth: width / 8,
    collisionHeight: height / 8,
    tileStacks: Array.from({ length: tileWidth * tileHeight }, () => []),
    collision: new Uint8Array(Math.ceil(width / 8 * height / 8 / 8)),
  };
}

const edited = blank();
assert.ok(editStackCells(edited, [[1, 1], [2, 1]], value => addStackEntry(value, 'floor')));
assert.equal(stackKeyAt(edited, 1, 1), 'f');
assert.equal(stackKeyAt(edited, 2, 1), 'f');
const beforeAtomic = edited.tileStacks.map(key).join('|');
assert.throws(() => editStackCells(edited, [[1, 1], [2, 1]], (value, x) => {
  if (x === 2) throw Error('reject gesture');
  return addStackEntry(value, 'grass');
}));
assert.equal(edited.tileStacks.map(key).join('|'), beforeAtomic, 'Rejected gesture partially committed');
assert.equal(stackAt(edited, -1, 0), null);

const movement = blank();
movement.tileStacks[1] = ['w'];
movement.tileStacks[2] = ['b'];
movement.tileStacks[3] = ['f', '#'];
movement.tileStacks[4] = ['f', '#', 'w'];
movement.tileStacks[5] = ['f', '^', 'w'];
assert.ok(isWalkable(movement, 48, 16), 'Visual Water should be walkable');
assert.ok(!isWalkable(movement, 80, 16), 'Decoration created support');
assert.ok(isWalkable(movement, 112, 16), 'Wall implied Collision');
assert.ok(isWalkable(movement, 144, 16), 'Elevated Water should be walkable');
assert.ok(isWalkable(movement, 16, 48), 'Stairs with an Elevated surface should be walkable');
paintCollisionCell(movement, 6, 2, 1);
assert.ok(!isWalkable(movement, 48, 16), 'Collision did not block Water');
paintCollisionRect(movement, 6, 2, 7, 3, 0);
assert.equal(collisionAt(movement, 6, 2), 0);
const body = { x: 48, y: 16 };
moveOnTerrain(movement, body, 200, 0, 2);
assert.ok(body.x < 80, 'Substepped movement crossed unsupported terrain');

const packed = packLevel(level);
const roundTrip = unpackLevel(packed);
assert.equal(terrainSignature(roundTrip), terrainSignature(level));
assert.deepEqual(packLevel(roundTrip), packed);
assert.ok(!packed.wide, 'Current test level unexpectedly exceeded the nibble palette');

// Force more than sixteen unique canonical stacks and verify byte-ID fallback.
const wide = blank(32 * 17, 32);
const variants = [
  '', 'g', 'd', 'w', 'f', 'b', 's', 'gd', 'gw', 'gf', 'gb', 'gs', 'dw', 'df', 'db', 'ds', 'wf',
];
variants.forEach((variant, index) => { wide.tileStacks[index] = [...variant]; });
const widePacked = packLevel(wide);
assert.equal(widePacked.wide, 1);
assert.equal(terrainSignature(unpackLevel(widePacked)), terrainSignature(wide));

for (const broken of [
  { ...packed, width: 31 },
  { ...packed, stacks: ['gg'] },
  { ...packed, stacks: ['#', '^'] },
  { ...packed, tiles: '' },
  { ...packed, collision: 'AAA=' },
]) assert.throws(() => unpackLevel(broken));

for (const [x, y] of [level.player, ...level.enemies.map(enemy => enemy.slice(0, 2))]) {
  assert.ok(isWalkable(level, x, y, 12), `Start/home is blocked at ${x},${y}`);
}
for (let x = 37; x <= 39; x++) {
  assert.ok(stackAt(level, x, 16).includes('^'), `Test staircase is missing tile ${x},16`);
  assert.equal(collisionAt(level, x * 4 + 2, 16 * 4 + 2), 0, 'Stairs unexpectedly edited/retained Collision');
  assert.ok(isWalkable(level, (x + 0.5) * 32, 16.5 * 32), 'Stair top is not walkable');
  assert.ok(isWalkable(level, (x + 0.5) * 32, 17.5 * 32), 'Stair approach is not walkable');
}

function fakeCanvas() {
  let pixels;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      createImageData(width, height) {
        return { width, height, data: new Uint8ClampedArray(width * height * 4) };
      },
      putImageData(image) { pixels = image.data.slice(); },
    }),
    pixels: () => pixels,
  };
  return canvas;
}

const visual = blank(320, 224, 19);
for (let y = 0; y < visual.tileHeight; y++) for (let x = 0; x < visual.tileWidth; x++) {
  visual.tileStacks[y * visual.tileWidth + x] = ['f'];
}
visual.tileStacks[1 * visual.tileWidth + 1] = ['f', 'g'];
visual.tileStacks[1 * visual.tileWidth + 2] = ['f', 'g', '#', 'f', 'g', 'w'];
visual.tileStacks[2 * visual.tileWidth + 1] = ['f', '#', 'g'];
visual.tileStacks[2 * visual.tileWidth + 2] = ['f', '#', 'f'];
visual.tileStacks[2 * visual.tileWidth + 3] = ['f', '^', 'f'];
visual.tileStacks[2 * visual.tileWidth + 4] = ['f', '^', 'f'];
visual.tileStacks[3 * visual.tileWidth] = ['f', '#'];
visual.tileStacks[4 * visual.tileWidth] = ['f', '^', 'f'];
visual.tileStacks[4 * visual.tileWidth + 1] = ['f', '^', 'f'];
visual.tileStacks[4 * visual.tileWidth + 3] = ['f', '^', 'f'];
visual.tileStacks[1 * visual.tileWidth + 3] = ['f', 'b', 'g'];
visual.tileStacks[1 * visual.tileWidth + 4] = ['f', 'g', 'b'];
visual.tileStacks[3 * visual.tileWidth + 6] = ['f', '#', 'g', 'b'];
// Every adjacent row must emit its own two-tile-high Wall sprite.
for (let y = 0; y < 3; y++) visual.tileStacks[y * visual.tileWidth + 5] = ['f', '#'];
// Isolated horizontal run exposes south/east shadow boundaries.
visual.tileStacks[1 * visual.tileWidth + 7] = ['f', '#'];
visual.tileStacks[1 * visual.tileWidth + 8] = ['f', '#'];
const canvas = fakeCanvas();
buildTerrain(visual, 1, canvas);
const firstPixels = canvas.pixels();
assert.ok(firstPixels.every((value, index) => index % 4 !== 3 || value === 255), 'Terrain cache contains transparent gaps');
const pixelAt = (pixels, x, y) => [...pixels.slice((y * visual.width + x) * 4, (y * visual.width + x) * 4 + 3)];
// Structural stone is flat, so it is asserted against the palette by name;
// ground materials now carry tonal noise, so those are asserted as a shade of
// the material within the noise band rather than as one exact value.
const shade = (colour, lift) => colour.map((value, index) => value + lift * [1, 1.15, 0.7][index]);
const near = (actual, expected, message, tolerance = 12) => assert.ok(
  actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance),
  `${message} (got ${actual}, expected within ${tolerance} of ${expected.map(Math.round)})`,
);
const luma = colour => colour[0] * 0.3 + colour[1] * 0.6 + colour[2] * 0.1;

near(pixelAt(firstPixels, 5 * 32 + 16, 16), STONE.crown, 'Joined Wall row did not render as a lit crown', 8);
assert.deepEqual(pixelAt(firstPixels, 5 * 32 + 16, 1), STONE.lip, 'Wall mass is missing its back perimeter lip');
near(pixelAt(firstPixels, 5 * 32 + 16, 33), STONE.crown, 'Middle Wall row emitted a repeated lip', 8);
assert.deepEqual(pixelAt(firstPixels, 5 * 32 + 16, 2 * 32 + 30), STONE.lip, 'Exposed southern Wall row is missing the lip along its crown edge');
assert.deepEqual(pixelAt(firstPixels, 5 * 32 + 1, 16), STONE.side, 'Wall run is missing its exposed side return');
near(pixelAt(firstPixels, 1 * 32 + 16, 2 * 32 + 16), shade(RGB[1], RAISED_LIFT), 'Elevated Grass did not receive the height grade');
assert.deepEqual(pixelAt(firstPixels, 1 * 32 + 16, 2 * 32), STONE.lip, 'Elevated Grass merged with Ground across its north edge');
assert.deepEqual(pixelAt(firstPixels, 1 * 32, 2 * 32 + 16), STONE.side, 'Elevated Grass merged with Ground across its side edge');
assert.deepEqual(pixelAt(firstPixels, 1 * 32 + 16, 2 * 32 + 30), STONE.lip, 'Elevated Grass hid the structural edge');
near(pixelAt(firstPixels, 1 * 32 + 16, 3 * 32 + 16), STONE.face, 'Elevated Grass covered the lower Wall face', 8);
near(pixelAt(firstPixels, 2 * 32 + 16, 2 * 32 + 16), shade(RGB[4], RAISED_LIFT), 'Elevated Floor did not receive the height grade');
near(pixelAt(firstPixels, 2 * 32 + 16, 1 * 32 + 16), shade(RGB[3], RAISED_LIFT), 'Elevated Water did not receive the height grade');
// Props are flat fills, so the grade is checked as an exact relationship
// between the same decoration drawn on both bands.
const groundDecoration = pixelAt(firstPixels, 4 * 32 + 16, 1 * 32 + 20);
assert.deepEqual(
  pixelAt(firstPixels, 6 * 32 + 16, 3 * 32 + 20),
  shade(groundDecoration, RAISED_LIFT).map(Math.round),
  'Elevated decoration did not receive the height grade',
);
assert.ok(luma(groundDecoration) < luma(RGB[1]), 'Ground decoration is not a silhouette against the Grass it sits on');
assert.deepEqual(pixelAt(firstPixels, 3 * 32 + 16, 2 * 32), STONE.lip, 'Stairs are missing their top tread');
assert.deepEqual(pixelAt(firstPixels, 3 * 32 + 16, 2 * 32 + 6), STONE.riser, 'Stairs are missing their riser');
assert.deepEqual(pixelAt(firstPixels, 4 * 32, 2 * 32 + 4), STONE.tread, 'Joined Stairs emitted an internal rail');
assert.deepEqual(pixelAt(firstPixels, 4 * 32 + 30, 2 * 32 + 20), STONE.tread, 'Stairs duplicated a rail beside Wall');
near(pixelAt(firstPixels, 16, 3 * 32 + 16), STONE.crown, 'Wall behind Stairs emitted a pushed-back facade', 8);
assert.deepEqual(pixelAt(firstPixels, 1, 4 * 32 + 16), STONE.lip, 'Stairs are missing their outer rail');
assert.deepEqual(pixelAt(firstPixels, 1 * 32 + 30, 4 * 32 + 16), STONE.mass, 'Stairs are missing their opposite outer rail');
assert.deepEqual(pixelAt(firstPixels, 3 * 32 + 16, 3 * 32 + 30), STONE.riser, 'Vertically touching Stairs emitted an internal baseline');
assert.deepEqual(pixelAt(firstPixels, 4 * 32 + 16, 3 * 32 + 30), STONE.base, 'Exposed Stairs are missing their bottom baseline');
// Shadows multiply whatever was baked underneath, so they are asserted as a
// darkening of the lit Floor rather than as a colour of their own.
const litFloor = pixelAt(firstPixels, 7 * 32 - 1, 2 * 32 + 16);
near(litFloor, RGB[4], 'Wall cast a shadow against the light direction', 8);
near(pixelAt(firstPixels, 7 * 32 + 16, 3 * 32 + 13), RGB[4], 'Wall shadow exceeded its agreed depth', 8);
for (const [x, y, message] of [
  [7 * 32 + 16, 3 * 32 + 4, 'Wall run is missing its continuous southern shadow'],
  [8 * 32 + 6, 3 * 32 + 4, 'Joined Wall shadow has a tile seam'],
  [9 * 32 + 2, 2 * 32 + 16, 'Wall run is missing its exposed eastern shadow'],
  [16, 6 * 32 + 2, 'Stairs are missing their restrained foot shadow'],
]) {
  const shadowed = pixelAt(firstPixels, x, y);
  assert.ok(luma(shadowed) < luma(litFloor) * 0.8, message);
  assert.ok(
    shadowed[2] / litFloor[2] > shadowed[0] / litFloor[0],
    `${message}: shadow is not cooler than the surface it falls on`,
  );
}
const fixtureRgb = Buffer.alloc(visual.width * visual.height * 3);
for (let source = 0, target = 0; source < firstPixels.length; source += 4) {
  fixtureRgb[target++] = firstPixels[source];
  fixtureRgb[target++] = firstPixels[source + 1];
  fixtureRgb[target++] = firstPixels[source + 2];
}
writeFileSync('/tmp/terrain-lighting-fixture.ppm', Buffer.concat([
  Buffer.from(`P6\n${visual.width} ${visual.height}\n255\n`), fixtureRgb,
]));
buildTerrain(unpackLevel(packLevel(visual)), 1, canvas);
assert.deepEqual(canvas.pixels(), firstPixels, 'Render changed after save/load or canvas reuse');

const maskedShadow = blank(96, 160, 21);
maskedShadow.tileStacks.fill(['f']);
maskedShadow.tileStacks[1] = ['f', '#'];
maskedShadow.tileStacks[2 * maskedShadow.tileWidth + 1] = ['f', '#', 'g'];
const maskedCanvas = fakeCanvas();
buildTerrain(maskedShadow, 1, maskedCanvas);
const maskedIndex = (68 * maskedShadow.width + 48) * 4;
near([...maskedCanvas.pixels().slice(maskedIndex, maskedIndex + 3)], shade(RGB[1], RAISED_LIFT), 'Wall shadow leaked onto later Elevated terrain');

// Removing upper layers and rebuilding the same canvas must restore lower pixels.
const changedPixels = firstPixels.slice();
visual.tileStacks[1 * visual.tileWidth + 2] = ['f', 'g', '#', 'f'];
buildTerrain(visual, 1, canvas);
assert.notDeepEqual(canvas.pixels(), changedPixels, 'Erasing a top entry left stale cache pixels');
const freshCanvas = fakeCanvas();
buildTerrain(unpackLevel(packLevel(visual)), 1, freshCanvas);
assert.deepEqual(canvas.pixels(), freshCanvas.pixels(), 'Reused canvas differs from fresh rebuild');

console.log(`terrain stack smoke checks passed (signature ${terrainSignature(level)}, packed JSON ${JSON.stringify(packed).length} bytes)`);
