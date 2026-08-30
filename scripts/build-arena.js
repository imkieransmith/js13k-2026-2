// Development-only source for the packed arena map. The geometric recipe is
// deliberately readable: arena.json stays tiny, while future tuning does not
// require hand-editing base64 tile IDs or Collision runs.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUTHOR_TILE, MASK_CELL, packLevel, terrainHash } from '../src/terrain.js';

export const ARENA_WIDTH = 1920;
export const ARENA_HEIGHT = 1280;
const TILE_WIDTH = ARENA_WIDTH / AUTHOR_TILE;
const TILE_HEIGHT = ARENA_HEIGHT / AUTHOR_TILE;
const CENTRE_X = ARENA_WIDTH / 2;
const CENTRE_Y = ARENA_HEIGHT / 2;

const superellipse = (x, y, radiusX, radiusY) =>
  (Math.abs(x) / radiusX) ** 4 + (Math.abs(y) / radiusY) ** 4;

function inGate(tileX, tileY) {
  return tileX >= 28 && tileX <= 31
    || tileY >= 19 && tileY <= 22;
}

/** Compose one authored tile from broad architecture down to sparse damage. */
function arenaStack(tileX, tileY) {
  const x = tileX - 29.5;
  const y = tileY - 19.5;
  const island = superellipse(x, y, 28, 18);
  const field = superellipse(x, y, 10.5, 6.2);
  const noise = terrainHash(tileX, tileY, 307);

  if (island > 1) return ['w'];
  if (island > 0.82) return noise % 4 ? ['g', 'w'] : ['g'];

  const northStand = tileY >= 10 && tileY <= 14 && tileX >= 16 && tileX <= 43;
  const southStand = tileY >= 25 && tileY <= 29 && tileX >= 16 && tileX <= 43;
  const westStand = tileX >= 14 && tileX <= 18 && tileY >= 14 && tileY <= 25;
  const eastStand = tileX >= 41 && tileX <= 45 && tileY >= 14 && tileY <= 25;
  const stand = northStand || southStand || westStand || eastStand;

  if (stand && !inGate(tileX, tileY)) {
    // Missing structure cells turn regular edges into collapsed seating rather
    // than four pristine rectangular platforms.
    const collapsed = noise % 17 === 0
      || northStand && tileY === 10 && noise % 5 === 0
      || southStand && tileY === 29 && noise % 4 === 0;
    if (collapsed) return noise & 1 ? ['g', 'f', 's'] : ['g', 'f', 'b'];
    return noise % 9 === 0 ? ['g', '#', 'f', 'g', 's'] : ['g', 'f', '#', 'f'];
  }

  // The northern entrance is the one orientation where the projected ruin
  // grammar can show a true stair from the raised gallery into the arena.
  if (tileX >= 28 && tileX <= 31 && tileY === 14) return ['g', '^', 'f'];

  if (field <= 1.08 || inGate(tileX, tileY)) {
    const distance = Math.hypot(x, y);
    const centreMark = Math.abs(x) < 1.4 && Math.abs(y) < 1.4
      || distance > 5.2 && distance < 6.5;
    if (centreMark && field < 0.82) return noise % 11 === 0 ? ['d', 'f', 'g'] : ['d', 'f'];
    if (field > 0.78) return noise % 8 === 0 ? ['d', 'f', 's'] : ['d', 'f'];
    if (noise % 31 === 0) return ['d', 'g'];
    if (noise % 23 === 0) return ['d', 's'];
    if (noise % 19 === 0) return ['d', 'g'];
    return ['d'];
  }

  // The low concourse between field and surviving galleries is pale stone,
  // broken often enough for grass and rubble to show the arena's age.
  if (island < 0.76) {
    if (noise % 13 === 0) return ['g', 'f', 's'];
    if (noise % 11 === 0) return ['g', 'f', 'b'];
    return noise % 5 ? ['g', 'f'] : ['g'];
  }
  return noise % 7 ? ['g'] : ['g', 'b'];
}

function playable(x, y) {
  const field = superellipse(x - CENTRE_X, y - CENTRE_Y, 350, 210);
  const verticalGate = Math.abs(x - CENTRE_X) < 72 && y > 285 && y < 995;
  const horizontalGate = Math.abs(y - CENTRE_Y) < 72 && x > 445 && x < 1475;
  return field < 1.04 || verticalGate || horizontalGate;
}

function setBit(mask, index) {
  mask[index >> 3] |= 1 << (index & 7);
}

export function buildArena() {
  const collisionWidth = ARENA_WIDTH / MASK_CELL;
  const collisionHeight = ARENA_HEIGHT / MASK_CELL;
  const collision = new Uint8Array(Math.ceil(collisionWidth * collisionHeight / 8));
  for (let gridY = 0; gridY < collisionHeight; gridY++) {
    for (let gridX = 0; gridX < collisionWidth; gridX++) {
      const x = gridX * MASK_CELL + MASK_CELL / 2;
      const y = gridY * MASK_CELL + MASK_CELL / 2;
      if (!playable(x, y)) setBit(collision, gridY * collisionWidth + gridX);
    }
  }

  return {
    width: ARENA_WIDTH,
    height: ARENA_HEIGHT,
    cell: MASK_CELL,
    seed: 73,
    player: [CENTRE_X, CENTRE_Y],
    enemies: [],
    // Clockwise from north. Runtime direction is derived from the arena centre,
    // so each point costs only two coordinates in the packed level.
    spawners: [[CENTRE_X, 480], [1280, CENTRE_Y], [CENTRE_X, 800], [640, CENTRE_Y]],
    tileWidth: TILE_WIDTH,
    tileHeight: TILE_HEIGHT,
    collisionWidth,
    collisionHeight,
    tileStacks: Array.from({ length: TILE_WIDTH * TILE_HEIGHT }, (_, index) =>
      arenaStack(index % TILE_WIDTH, Math.floor(index / TILE_WIDTH))),
    collision,
  };
}

export function packedArena() {
  return packLevel(buildArena());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = new URL('../src/levels/arena.json', import.meta.url);
  writeFileSync(output, `${JSON.stringify(packedArena())}\n`);
  console.log(`${fileURLToPath(output)}: ${ARENA_WIDTH}x${ARENA_HEIGHT}`);
}
