import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const visual = blank(192, 160, 19);
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
// Every adjacent row must emit its own two-tile-high Wall sprite.
for (let y = 0; y < 3; y++) visual.tileStacks[y * visual.tileWidth + 5] = ['f', '#'];
const canvas = fakeCanvas();
buildTerrain(visual, 1, canvas);
const firstPixels = canvas.pixels();
assert.ok(firstPixels.every((value, index) => index % 4 !== 3 || value === 255), 'Terrain cache contains transparent gaps');
const pixelAt = (pixels, x, y) => [...pixels.slice((y * visual.width + x) * 4, (y * visual.width + x) * 4 + 3)];
assert.deepEqual(pixelAt(firstPixels, 5 * 32 + 16, 16), [77, 102, 99], 'Joined Wall row did not render as dark solid mass');
assert.deepEqual(pixelAt(firstPixels, 5 * 32 + 16, 1), [231, 232, 203], 'Wall mass is missing its back perimeter lip');
assert.deepEqual(pixelAt(firstPixels, 5 * 32 + 16, 33), [77, 102, 99], 'Middle Wall row emitted a repeated lip');
assert.deepEqual(pixelAt(firstPixels, 5 * 32 + 16, 65), [231, 232, 203], 'Exposed southern Wall row is missing its facade lip');
assert.deepEqual(pixelAt(firstPixels, 5 * 32 + 1, 16), [190, 201, 180], 'Wall run is missing its exposed side return');
assert.deepEqual(pixelAt(firstPixels, 1 * 32 + 16, 2 * 32 + 16), [73, 157, 72], 'Elevated Grass did not cover the Wall top');
assert.deepEqual(pixelAt(firstPixels, 1 * 32 + 16, 2 * 32), [238, 240, 207], 'Elevated Grass merged with Ground across its north edge');
assert.deepEqual(pixelAt(firstPixels, 1 * 32, 2 * 32 + 16), [168, 187, 160], 'Elevated Grass merged with Ground across its side edge');
assert.deepEqual(pixelAt(firstPixels, 1 * 32 + 16, 2 * 32 + 30), [238, 240, 207], 'Elevated Grass hid the structural edge');
assert.deepEqual(pixelAt(firstPixels, 1 * 32 + 16, 3 * 32 + 16), [77, 102, 99], 'Elevated Grass covered the lower Wall face');
assert.deepEqual(pixelAt(firstPixels, 2 * 32 + 16, 2 * 32 + 16), [211, 216, 194], 'Elevated Floor ordered above Wall did not cover Wall');
assert.deepEqual(pixelAt(firstPixels, 3 * 32 + 16, 2 * 32), [238, 240, 207], 'Stairs are missing their top tread');
assert.deepEqual(pixelAt(firstPixels, 3 * 32 + 16, 2 * 32 + 6), [123, 146, 137], 'Stairs are missing their riser');
assert.deepEqual(pixelAt(firstPixels, 4 * 32, 2 * 32 + 4), [190, 201, 180], 'Joined Stairs emitted an internal rail');
assert.deepEqual(pixelAt(firstPixels, 4 * 32 + 30, 2 * 32 + 20), [190, 201, 180], 'Stairs duplicated a rail beside Wall');
assert.deepEqual(pixelAt(firstPixels, 16, 3 * 32 + 16), [77, 102, 99], 'Wall behind Stairs emitted a pushed-back facade');
assert.deepEqual(pixelAt(firstPixels, 1, 4 * 32 + 16), [231, 232, 203], 'Stairs are missing their outer rail');
assert.deepEqual(pixelAt(firstPixels, 1 * 32 + 30, 4 * 32 + 16), [77, 102, 99], 'Stairs are missing their opposite outer rail');
assert.deepEqual(pixelAt(firstPixels, 3 * 32 + 16, 3 * 32 + 30), [123, 146, 137], 'Vertically touching Stairs emitted an internal baseline');
assert.deepEqual(pixelAt(firstPixels, 4 * 32 + 16, 3 * 32 + 30), [46, 68, 70], 'Exposed Stairs are missing their bottom baseline');
buildTerrain(unpackLevel(packLevel(visual)), 1, canvas);
assert.deepEqual(canvas.pixels(), firstPixels, 'Render changed after save/load or canvas reuse');

// Removing upper layers and rebuilding the same canvas must restore lower pixels.
const changedPixels = firstPixels.slice();
visual.tileStacks[1 * visual.tileWidth + 2] = ['f', 'g', '#', 'f'];
buildTerrain(visual, 1, canvas);
assert.notDeepEqual(canvas.pixels(), changedPixels, 'Erasing a top entry left stale cache pixels');
const freshCanvas = fakeCanvas();
buildTerrain(unpackLevel(packLevel(visual)), 1, freshCanvas);
assert.deepEqual(canvas.pixels(), freshCanvas.pixels(), 'Reused canvas differs from fresh rebuild');

console.log(`terrain stack smoke checks passed (signature ${terrainSignature(level)}, packed JSON ${JSON.stringify(packed).length} bytes)`);
