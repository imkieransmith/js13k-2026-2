// Development-only source for the packed arena map. The geometric recipe is
// deliberately readable: arena.json stays tiny, while future tuning does not
// require hand-editing base64 tile IDs or Collision runs.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUTHOR_TILE, MASK_CELL, packLevel, terrainHash } from '../src/terrain.js';

export const ARENA_WIDTH = 1920;
export const ARENA_HEIGHT = 1472;
const TILE_WIDTH = ARENA_WIDTH / AUTHOR_TILE;
const TILE_HEIGHT = ARENA_HEIGHT / AUTHOR_TILE;
const CENTRE_X = ARENA_WIDTH / 2;
const CENTRE_Y = ARENA_HEIGHT / 2;

// The whole ruin is one ellipse, measured in authored tiles from the centre.
// An amphitheatre is elliptical rather than round, and committing to that here
// is what lets a single number decide both what a tile is made of and whether
// the player can stand on it.
const FLOOR_RADIUS_X = 17;
const FLOOR_RADIUS_Y = 10;
// Just past a true ellipse. A plain ellipse gives its corners up to water on a
// rectangular map; squaring it slightly buys that fighting floor back without
// the stadium look a fourth-power curve has.
const FLOOR_POWER = 2.6;

// Every band outside the floor is a depth in authored tiles measured outward
// from its edge, never a scaled copy of the ellipse. Scaled rings pinch at the
// ends of the long axis, so the barrier would have been twice as thick behind
// the north gate as behind the east one; a depth keeps masonry an even
// thickness the whole way round, which is what makes it read as built.
// The section, read outward from the sand. Masonry and gap alternate on
// purpose: this renderer only draws a front face where a Wall's southern
// neighbour is not one, so a solid block of stone four tiles deep emits a
// single step no matter how tall it is meant to be. Three thin rings separated
// by open gangways emit three, which is what makes the seating look tiered
// instead of looking like one shelf with a pattern on it.
const PODIUM_DEPTH = 2;      // pale rim slabs — still ground the fight uses
const BARRIER_DEPTH = 4;     // the wall the crowd sat safely behind
const LOWER_WALK_DEPTH = 5;  // the gangway along its back
const CAVEA_DEPTH = 7;       // the surviving tier of seating
const UPPER_WALK_DEPTH = 8;  // the gangway behind that
const ARCADE_DEPTH = 9.5;    // the outer facade, mostly fallen
const VERGE_DEPTH = 11;      // grass the ruin is sinking into
const SHORE_DEPTH = 12;      // shallows, then open water

// Four tunnels on the cardinal axes, four tiles wide, running from the sand
// out to the back of the seating.
const GATE_HALF = 2;
const GATE_DEPTH = UPPER_WALK_DEPTH;
// Constructs step out of the dark of a tunnel rather than appearing on the
// sand, so the gate is somewhere the player learns to watch.
const SPAWN_DEPTH = 5;

// Four toppled column bases, one to each diagonal. A completely open ellipse
// plays as a shooting gallery: these are the only cover on the sand, and
// keeping them off the cardinal axes leaves every gate's approach clear.
const PILLARS = [[-8, -5], [8, -5], [-8, 5], [8, 5]];

/** Normalised radius on the arena ellipse: exactly 1 on the floor's edge. */
const ellipse = (x, y) =>
  ((Math.abs(x) / FLOOR_RADIUS_X) ** FLOOR_POWER + (Math.abs(y) / FLOOR_RADIUS_Y) ** FLOOR_POWER) ** (1 / FLOOR_POWER);

/**
 * How far outside the fighting floor a point lies, in authored tiles, measured
 * along its own ray from the centre. This is the map's only geometry: the tile
 * recipe and the Collision mask are both written in terms of it, which is what
 * stops the barrier you can see and the barrier you stop at from drifting
 * apart the way two independently tuned curves always eventually do.
 */
function depthAt(x, y) {
  const radius = ellipse(x, y);
  return radius ? Math.hypot(x, y) * (1 - 1 / radius) : -FLOOR_RADIUS_Y;
}

/** Inside one of the four tunnels, whichever axis it runs along. */
const inGate = (x, y) => Math.abs(x) < GATE_HALF || Math.abs(y) < GATE_HALF;

const isPillar = (x, y) => PILLARS.some(([pillarX, pillarY]) =>
  Math.abs(x - pillarX) < 1 && Math.abs(y - pillarY) < 1);

/**
 * Compose one authored tile: which band it belongs to, then that band's own
 * damage. Wear is rolled once and shared, so a collapse in the seating lines
 * up with the rubble that spilled out of it rather than every band eroding on
 * its own private pattern.
 *
 * Damage is deliberately absent from the barrier ring and from the tunnel
 * jambs. Everywhere else the player cannot reach, so a visible breach costs
 * nothing; there, a breach would be a hole the map draws and the Collision
 * mask refuses to open, which is the one kind of ruin that reads as a bug.
 */
function arenaStack(tileX, tileY) {
  const x = tileX - (TILE_WIDTH / 2 - 0.5);
  const y = tileY - (TILE_HEIGHT / 2 - 0.5);
  const depth = depthAt(x, y);
  const wear = terrainHash(tileX, tileY, 307) % 100;

  // A toppled column base, standing straight out of the sand rather than on a
  // grass footing: it fell here, it was not built here.
  if (isPillar(x, y)) return ['d', '#', 'f'];

  // A tunnel carries the fighting floor's own sand out through the seating,
  // rather than the pale slab everything else out here is made of. This
  // renderer only draws a front face southward, so the east and west tunnels
  // get no lit jambs at all and were indistinguishable from the terraces they
  // cut through; material is the one cue that reads on every bearing, and sand
  // says "this is the arena" before the player has worked out the geometry.
  // The northern tunnel is additionally the one orientation the projection can
  // draw a true staircase in, so it alone shows the drop onto the sand.
  if (depth > 0 && depth <= GATE_DEPTH && inGate(x, y)) {
    if (y < 0 && Math.abs(x) < GATE_HALF && depth > PODIUM_DEPTH && depth <= BARRIER_DEPTH) return ['g', '^', 'f'];
    if (wear < 10) return ['d', 's'];
    return wear < 30 ? ['d', 'f'] : ['d'];
  }

  if (depth > SHORE_DEPTH) return ['w'];
  if (depth > VERGE_DEPTH) return wear < 58 ? ['g', 'w'] : ['g'];
  if (depth > ARCADE_DEPTH) return wear < 16 ? ['g', 'b'] : wear < 28 ? ['g', 's'] : ['g'];

  // The outer facade, breached often enough that the seating behind it shows
  // through from outside rather than presenting one unbroken pale ring.
  if (depth > UPPER_WALK_DEPTH) return wear < 22 ? ['g', 's'] : wear < 34 ? ['g', 'b'] : ['g', '#', 'f'];

  // Gangways are the gaps that let the rings either side of them emit a step
  // face, and they are green rather than pale on purpose: banding stone with
  // turf is what separates three cream rings that are otherwise one shape, and
  // it is where the overgrowth in "overgrown ruin" actually has to show.
  if (depth > CAVEA_DEPTH) return wear < 18 ? ['g', 'f'] : wear < 30 ? ['g', 'b'] : ['g'];

  // The surviving tier of seating, reclaimed and collapsed in bays.
  if (depth > LOWER_WALK_DEPTH) {
    if (wear < 10) return ['g', 's'];
    if (wear < 24) return ['g', '#', 'f', 's'];
    return wear < 60 ? ['g', '#', 'f', 'g'] : ['g', '#', 'f'];
  }

  if (depth > BARRIER_DEPTH) return wear < 16 ? ['g', 'f'] : wear < 26 ? ['g', 'b'] : ['g'];

  // The barrier itself stays whole. Everything else outside the sand is out of
  // the player's reach, so a breach there costs nothing; a breach here would be
  // a hole the map draws and the Collision mask refuses to open, which is the
  // one kind of ruin that reads as a bug rather than as age.
  if (depth > PODIUM_DEPTH) return wear < 34 ? ['g', '#', 'f', 'g'] : ['g', '#', 'f'];

  // The podium rim: cut slab at the fight's own level, worn through to the
  // grass growing under it. None of this blocks, so it is free to break up.
  if (depth > 0) return wear < 14 ? ['g', 'f', 's'] : wear < 24 ? ['g'] : ['g', 'f'];

  // The fighting floor is sand over the old temple pavement, and the arena's
  // markings are that pavement showing through rather than paint: a centre
  // medallion, and one ring at the distance the fight naturally orbits.
  const radius = ellipse(x, y);
  if (Math.hypot(x / 1.7, y) < 1.9 || radius > 0.62 && radius < 0.7 && wear < 78) {
    return wear < 14 ? ['d', 'g'] : ['d', 'f'];
  }
  // Sand loses to slab as it approaches the podium, so the rim is a worn join
  // rather than a drawn line.
  if (depth > -1 && wear < 36) return ['d', 'f'];
  if (wear < 4) return ['d', 's'];
  return wear < 9 ? ['d', 'g'] : ['d'];
}

/** Masonry, in the same terms the tiles are composed from. */
function solid(x, y) {
  if (isPillar(x, y)) return true;
  const depth = depthAt(x, y);
  if (depth <= PODIUM_DEPTH) return false;
  return !(depth <= GATE_DEPTH && inGate(x, y));
}

/**
 * A Wall's front face is drawn onto the tile below it, so the ground under any
 * masonry is masonry too however open its own materials look. Without this the
 * player stands inside the northern barrier's face — which is also why the
 * arena is a tile shallower at the north than at the south, exactly where the
 * wall is the one you can see the front of.
 */
const playable = (x, y) => !solid(x, y) && !solid(x, y - 1);

function setBit(mask, index) {
  mask[index >> 3] |= 1 << (index & 7);
}

/** A gate mouth on one cardinal axis, at the depth Constructs step out from. */
const gateAt = (dirX, dirY) => [
  CENTRE_X + Math.round(dirX * (FLOOR_RADIUS_X + SPAWN_DEPTH) * AUTHOR_TILE),
  CENTRE_Y + Math.round(dirY * (FLOOR_RADIUS_Y + SPAWN_DEPTH) * AUTHOR_TILE),
];

export function buildArena() {
  const collisionWidth = ARENA_WIDTH / MASK_CELL;
  const collisionHeight = ARENA_HEIGHT / MASK_CELL;
  const collision = new Uint8Array(Math.ceil(collisionWidth * collisionHeight / 8));
  // Decided once per authored tile and stamped across that tile's Collision
  // cells, rather than sampled per cell. The mask is finer than the art, so
  // sampling the curve at its own resolution puts a smooth ellipse through
  // masonry that is drawn in 32-unit blocks: the player then stands a third of
  // a tile inside the barrier on one bearing and stops a third of a tile short
  // of it on the next. A blocky boundary is the honest one here, because the
  // wall it belongs to is blocky.
  const span = AUTHOR_TILE / MASK_CELL;
  for (let tileY = 0; tileY < TILE_HEIGHT; tileY++) {
    for (let tileX = 0; tileX < TILE_WIDTH; tileX++) {
      if (playable(tileX - (TILE_WIDTH / 2 - 0.5), tileY - (TILE_HEIGHT / 2 - 0.5))) continue;
      for (let cellY = tileY * span; cellY < (tileY + 1) * span; cellY++) {
        for (let cellX = tileX * span; cellX < (tileX + 1) * span; cellX++) {
          setBit(collision, cellY * collisionWidth + cellX);
        }
      }
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
    spawners: [gateAt(0, -1), gateAt(1, 0), gateAt(0, 1), gateAt(-1, 0)],
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
