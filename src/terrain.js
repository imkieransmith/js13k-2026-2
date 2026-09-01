// Shared terrain vocabulary for the game and development-only editor.
// Ordered tile stacks preserve the author's painter sequence; visual edge
// roughness is deterministic and therefore costs no bytes in level data.
export const MASK_CELL = 8;
export const AUTHOR_TILE = 32;
export const MAX_STACK_ENTRIES = 8;
export const MATERIALS = ['grass', 'dirt', 'water', 'floor', 'bushes', 'stones', 'wall', 'stairs'];

const CODE = { grass: 'g', dirt: 'd', water: 'w', floor: 'f', bushes: 'b', stones: 's', wall: '#', stairs: '^' };
const NAME = { g: 'grass', d: 'dirt', w: 'water', f: 'floor', b: 'bushes', s: 'stones', '#': 'wall', '^': 'stairs' };
const SURFACES = 'gdwf';
const VISUALS = 'gdwfbs';
const STRUCTURES = '#^';
const CACHE_SCALE = 1;

/** Stable integer hash used by every unstored terrain variation. */
export function terrainHash(x, y, salt = 0) {
  let value = Math.imul(x ^ salt, 374761393) + Math.imul(y + salt, 668265263);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return (value ^ value >>> 16) >>> 0;
}

const materialCode = material => CODE[material] || material;
export const materialName = code => NAME[code];
const structureIndex = stack => stack.findIndex(code => STRUCTURES.includes(code));
const hasSurface = entries => entries.some(code => SURFACES.includes(code));

/** Strict validation keeps corrupt level data from silently changing meaning. */
export function validateStack(input) {
  if (!Array.isArray(input)) throw Error('Terrain stack must be an array');
  if (input.filter(code => !STRUCTURES.includes(code)).length > MAX_STACK_ENTRIES) throw Error('Terrain stack exceeds eight visual entries');
  if (input.filter(code => STRUCTURES.includes(code)).length > 1) throw Error('Terrain stack contains multiple structures');
  for (const code of input) if (!STRUCTURES.includes(code) && !VISUALS.includes(code)) throw Error(`Unknown terrain material: ${code}`);
  const structure = structureIndex(input);
  const bands = [input.slice(0, structure < 0 ? input.length : structure), structure < 0 ? [] : input.slice(structure + 1)];
  for (const band of bands) if (new Set(band).size !== band.length) throw Error('Terrain band contains a duplicate material');
  return input;
}

function bandBounds(stack, target) {
  if (target !== 'ground' && target !== 'upper') throw Error(`Unknown terrain band: ${target}`);
  const structure = structureIndex(stack);
  if (target === 'upper') {
    if (structure < 0) throw Error('Elevated edits require a structure');
    return [structure + 1, stack.length];
  }
  return [0, structure < 0 ? stack.length : structure];
}

export const automaticBand = stack => structureIndex(stack) < 0 ? 'ground' : 'upper';

/** Return a canonical edited copy; the input stack is never mutated. */
export function addStackEntry(input, material, target = 'auto') {
  validateStack(input);
  const code = materialCode(material);
  if (STRUCTURES.includes(code)) {
    const index = structureIndex(input);
    if (index < 0) return validateStack([...input, code]);
    const stack = [...input];
    stack[index] = code;
    return validateStack(stack);
  }
  if (!VISUALS.includes(code)) throw Error(`Unknown terrain material: ${material}`);
  const stack = [...input];
  const band = target === 'auto' ? automaticBand(stack) : target;
  let [start, end] = bandBounds(stack, band);
  const existing = stack.indexOf(code, start);
  if (existing >= 0 && existing < end) {
    stack.splice(existing, 1);
    [start, end] = bandBounds(stack, band);
  } else if (stack.filter(entry => !STRUCTURES.includes(entry)).length === MAX_STACK_ENTRIES) throw Error('Terrain stack is full');
  stack.splice(end, 0, code);
  return validateStack(stack);
}

/** Structure removal demotes safely and retains the visually topmost duplicate. */
export function removeStackEntry(input, material, target = 'auto') {
  validateStack(input);
  const code = materialCode(material);
  if (STRUCTURES.includes(code)) {
    if (!input.includes(code)) return [...input];
    const merged = input.filter(entry => entry !== code);
    return validateStack(merged.filter((entry, index) => merged.lastIndexOf(entry) === index));
  }
  const band = target === 'auto' ? automaticBand(input) : target;
  const [start, end] = bandBounds(input, band);
  const index = input.indexOf(code, start);
  if (index < 0 || index >= end) return [...input];
  const stack = [...input];
  stack.splice(index, 1);
  return validateStack(stack);
}

/** Move one inspector row. Crossing a structure rejects duplicate target materials. */
export function moveStackEntry(input, index, direction) {
  validateStack(input);
  const target = index + direction;
  if (index < 0 || target < 0 || index >= input.length || target >= input.length) return [...input];
  const stack = [...input];
  [stack[index], stack[target]] = [stack[target], stack[index]];
  return validateStack(stack);
}

export function removeStackIndex(input, index) {
  if (index < 0 || index >= input.length) return [...input];
  if (STRUCTURES.includes(input[index])) return removeStackEntry(input, input[index]);
  const stack = [...input];
  stack.splice(index, 1);
  return validateStack(stack);
}

function writeVarint(bytes, value) {
  do {
    let byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
}

function readVarint(bytes, cursor, label) {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (cursor.index >= bytes.length || shift > 28) throw Error(`Malformed ${label}`);
    const byte = bytes[cursor.index++];
    value |= (byte & 127) << shift;
    if (!(byte & 128)) return value;
    shift += 7;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.slice(i, i + 8192));
  return btoa(binary);
}

const decodeBase64 = encoded => Uint8Array.from(atob(encoded), character => character.charCodeAt(0));

function base64ToBytes(encoded, label) {
  try { return decodeBase64(encoded || ''); } catch { throw Error(`Malformed ${label} base64`); }
}

function bitAt(mask, index) {
  return index < 0 ? 0 : mask[index >> 3] >> (index & 7) & 1;
}

function setBit(mask, index, value) {
  const byte = index >> 3;
  const flag = 1 << (index & 7);
  if (value) mask[byte] |= flag;
  else mask[byte] &= ~flag;
}

function encodeRuns(mask, bits) {
  const bytes = [];
  let cursor = 0;
  let previousEnd = 0;
  while (cursor < bits) {
    while (cursor < bits && !bitAt(mask, cursor)) cursor++;
    if (cursor === bits) break;
    writeVarint(bytes, cursor - previousEnd);
    const start = cursor;
    while (cursor < bits && bitAt(mask, cursor)) cursor++;
    writeVarint(bytes, cursor - start);
    previousEnd = cursor;
  }
  return bytesToBase64(bytes);
}

function decodeRuns(encoded, bits, label) {
  const bytes = base64ToBytes(encoded, label);
  const mask = new Uint8Array(Math.ceil(bits / 8));
  const cursor = { index: 0 };
  let output = 0;
  while (cursor.index < bytes.length) {
    output += readVarint(bytes, cursor, label);
    const run = readVarint(bytes, cursor, label);
    if (!run || output + run > bits) throw Error(`Malformed ${label} run`);
    for (const end = output + run; output < end; output++) setBit(mask, output, 1);
  }
  return mask;
}

function decodeTiles(encoded, count, paletteLength, wide) {
  const bytes = base64ToBytes(encoded, 'terrain tiles');
  const ids = new Uint16Array(count);
  const expected = wide ? count : Math.ceil(count / 2);
  if (bytes.length !== expected) throw Error('Terrain tile data has the wrong length');
  for (let i = 0; i < count; i++) {
    ids[i] = wide ? bytes[i] : bytes[i >> 1] >> (i & 1) * 4 & 15;
    if (ids[i] >= paletteLength) throw Error('Terrain tile references an unknown stack');
  }
  if (!wide && count & 1 && bytes.at(-1) >> 4) throw Error('Terrain tile padding is not empty');
  return ids;
}

/**
 * Decode bundled, build-validated data without shipping the editor's defensive
 * schema errors. This supports the same narrow/wide packed representation; the
 * only difference is where invalid authored data is rejected.
 */
export function unpackGameLevel(source) {
  const tileWidth = source.width / AUTHOR_TILE;
  const tileHeight = source.height / AUTHOR_TILE;
  const count = tileWidth * tileHeight;
  const palette = source.stacks.map(key => [...key]);
  const tiles = atob(source.tiles);
  const tileStacks = Array.from({ length: count }, (_, index) => palette[
    source.wide ? tiles.charCodeAt(index) : tiles.charCodeAt(index >> 1) >> (index & 1) * 4 & 15
  ]);
  const collisionWidth = source.width / MASK_CELL;
  const collisionHeight = source.height / MASK_CELL;
  const packedCollision = atob(source.collision);
  const collision = new Uint8Array(Math.ceil(collisionWidth * collisionHeight / 8));
  let cursor = 0;
  let output = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = packedCollision.charCodeAt(cursor++);
      value |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  while (cursor < packedCollision.length) {
    output += varint();
    const end = output + varint();
    while (output < end) collision[output >> 3] |= 1 << (output++ & 7);
  }
  return {
    ...source,
    spawners: source.spawners || [],
    tileWidth,
    tileHeight,
    collisionWidth,
    collisionHeight,
    tileStacks,
    collision,
  };
}

/** Strictly decode the new stack-only level schema. */
export function unpackLevel(source) {
  if (!source || !Number.isInteger(source.width) || !Number.isInteger(source.height)
    || source.width < AUTHOR_TILE || source.height < AUTHOR_TILE
    || source.width % AUTHOR_TILE || source.height % AUTHOR_TILE) throw Error('Invalid terrain dimensions');
  if (source.cell !== MASK_CELL) throw Error('Invalid Collision cell size');
  if (!Array.isArray(source.stacks) || !source.stacks.length || source.stacks.length > 256) throw Error('Invalid terrain stack palette');
  const palette = source.stacks.map(key => {
    if (typeof key !== 'string') throw Error('Invalid terrain stack key');
    return validateStack([...key]);
  });
  if (new Set(source.stacks).size !== source.stacks.length) throw Error('Duplicate terrain stack palette entry');
  const tileWidth = source.width / AUTHOR_TILE;
  const tileHeight = source.height / AUTHOR_TILE;
  const count = tileWidth * tileHeight;
  const ids = decodeTiles(source.tiles, count, palette.length, !!source.wide);
  const tileStacks = Array.from(ids, id => [...palette[id]]);
  const collisionWidth = source.width / MASK_CELL;
  const collisionHeight = source.height / MASK_CELL;
  const collision = decodeRuns(source.collision, collisionWidth * collisionHeight, 'Collision');
  const validPoint = point => Array.isArray(point) && point.length === 2
    && point.every(Number.isInteger)
    && point[0] >= 0 && point[1] >= 0 && point[0] < source.width && point[1] < source.height;
  if (!Number.isInteger(source.seed) || !validPoint(source.player) || !Array.isArray(source.enemies)
    || source.enemies.some(enemy => !Array.isArray(enemy) || enemy.length !== 3
      || !validPoint(enemy.slice(0, 2)) || enemy[2] !== 0 && enemy[2] !== 1)) throw Error('Invalid level starts');
  if (source.wide !== undefined && source.wide !== 1) throw Error('Invalid wide terrain flag');
  const spawners = source.spawners === undefined ? [] : source.spawners;
  if (!Array.isArray(spawners) || spawners.length && spawners.length !== 4
    || spawners.some(point => !Array.isArray(point) || point.length !== 2
      || !point.every(Number.isInteger)
      || point[0] < 0 || point[1] < 0 || point[0] >= source.width || point[1] >= source.height)) {
    throw Error('Invalid arena spawners');
  }
  return {
    width: source.width,
    height: source.height,
    cell: MASK_CELL,
    seed: source.seed,
    player: [...source.player],
    enemies: source.enemies.map(enemy => [...enemy]),
    spawners: spawners.map(point => [...point]),
    tileWidth,
    tileHeight,
    collisionWidth,
    collisionHeight,
    tileStacks,
    collision,
  };
}

/** Stable first-use compaction prevents editor history from bloating a save. */
export function packLevel(level) {
  const palette = [];
  const lookup = new Map();
  const ids = new Uint16Array(level.tileStacks.length);
  level.tileStacks.forEach((stack, index) => {
    const key = validateStack(stack).join('');
    if (!lookup.has(key)) {
      if (palette.length === 256) throw Error('Terrain level uses more than 256 unique stacks');
      lookup.set(key, palette.length);
      palette.push(key);
    }
    ids[index] = lookup.get(key);
  });
  const wide = palette.length > 16;
  const bytes = new Uint8Array(wide ? ids.length : Math.ceil(ids.length / 2));
  ids.forEach((id, index) => {
    if (wide) bytes[index] = id;
    else bytes[index >> 1] |= id << (index & 1) * 4;
  });
  return {
    width: level.width,
    height: level.height,
    cell: MASK_CELL,
    seed: level.seed,
    player: level.player,
    enemies: level.enemies,
    ...(level.spawners?.length ? { spawners: level.spawners } : {}),
    stacks: palette,
    tiles: bytesToBase64(bytes),
    ...(wide ? { wide: 1 } : {}),
    collision: encodeRuns(level.collision, level.collisionWidth * level.collisionHeight),
  };
}

const tileIndex = (level, x, y) => x < 0 || y < 0 || x >= level.tileWidth || y >= level.tileHeight
  ? -1 : y * level.tileWidth + x;

export function stackAt(level, tileX, tileY) {
  const index = tileIndex(level, tileX, tileY);
  return index < 0 ? null : level.tileStacks[index];
}

export const stackKeyAt = (level, tileX, tileY) => stackAt(level, tileX, tileY)?.join('') ?? null;

/** Preflight all replacements so one bad tile rejects the entire gesture. */
export function editStackCells(level, cells, operation) {
  const unique = new Map();
  for (const cell of cells) {
    const x = Array.isArray(cell) ? cell[0] : cell.x;
    const y = Array.isArray(cell) ? cell[1] : cell.y;
    const index = tileIndex(level, x, y);
    if (index >= 0) unique.set(index, { index, x, y });
  }
  const replacements = [];
  for (const cell of unique.values()) replacements.push({
    index: cell.index,
    stack: validateStack(operation([...level.tileStacks[cell.index]], cell.x, cell.y)),
  });
  let changed = false;
  for (const replacement of replacements) {
    if (replacement.stack.join('') === level.tileStacks[replacement.index].join('')) continue;
    level.tileStacks[replacement.index] = replacement.stack;
    changed = true;
  }
  return changed;
}

export function collisionAt(level, gridX, gridY) {
  if (gridX < 0 || gridY < 0 || gridX >= level.collisionWidth || gridY >= level.collisionHeight) return 0;
  return bitAt(level.collision, gridY * level.collisionWidth + gridX);
}

export function paintCollisionCell(level, gridX, gridY, value = 1) {
  if (gridX < 0 || gridY < 0 || gridX >= level.collisionWidth || gridY >= level.collisionHeight) return false;
  const index = gridY * level.collisionWidth + gridX;
  if (bitAt(level.collision, index) === value) return false;
  setBit(level.collision, index, value);
  return true;
}

export function paintCollisionRect(level, x0, y0, x1, y1, value = 1) {
  let changed = false;
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) changed = paintCollisionCell(level, x, y, value) || changed;
  }
  return changed;
}

function splitBands(stack) {
  const structure = structureIndex(stack);
  return {
    ground: stack.slice(0, structure < 0 ? stack.length : structure),
    upper: structure < 0 ? [] : stack.slice(structure + 1),
  };
}

function pointWalkable(level, x, y) {
  if (x < 0 || y < 0 || x >= level.width || y >= level.height) return false;
  const stack = stackAt(level, Math.floor(x / AUTHOR_TILE), Math.floor(y / AUTHOR_TILE));
  const bands = splitBands(stack);
  const active = hasSurface(bands.upper) ? bands.upper : bands.ground;
  return hasSurface(active) && !collisionAt(level, Math.floor(x / MASK_CELL), Math.floor(y / MASK_CELL));
}

export function isWalkable(level, x, y, radius = 0) {
  if (!pointWalkable(level, x, y)) return false;
  for (let i = 0; i < 8 && radius; i++) {
    const angle = i * Math.PI / 4;
    if (!pointWalkable(level, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)) return false;
  }
  return true;
}

/** Axis-separated substeps prevent dashes and knockback tunnelling. */
export function moveOnTerrain(level, body, dx, dy, radius) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (MASK_CELL / 2)));
  const stepX = dx / steps;
  const stepY = dy / steps;
  let blocked = 0;
  for (let i = 0; i < steps; i++) {
    if (isWalkable(level, body.x + stepX, body.y, radius)) body.x += stepX;
    else blocked |= 1;
    if (isWalkable(level, body.x, body.y + stepY, radius)) body.y += stepY;
    else blocked |= 2;
  }
  return blocked;
}

// One deliberately narrow ramp: a near-black teal void, olive-leaning greens
// and warm cream stone. Keeping every material on the same warm/cool axis is
// what makes the scene read as a single lit place rather than coloured shapes.
//
// Dirt is the one entry pulled a long way, from wet brown to a dry ochre. It is
// what carries the southern-American read: a saturated gold shelf is the single
// loudest signal the setting has, and it costs nothing but a different number.
// Grass follows it only a little, yellow-shifted enough to look sun-struck
// rather than watered. Void, water and the stone ramp are untouched on purpose
// — they are what keeps the scene reading as Hyper Light Drifter first.
export const RGB = [
  [11, 22, 27],
  [96, 138, 55],
  [196, 147, 52],
  [46, 146, 183],
  [203, 200, 176],
];
const NUMBER = { g: 1, d: 2, w: 3, f: 4, b: 5, s: 6 };
// Elevated ground catches more light than the field it sits above.
export const RAISED_LIFT = 13;

/**
 * Cut stone follows the floor's warm limestone axis, shifted greener and much
 * darker down the wall so tiers remain distinct. A pale lip, mid face and body
 * near the void give the ruins weight; named values keep every bevel coherent.
 */
export const STONE = {
  lip: [238, 233, 205],
  side: [198, 199, 174],
  crown: [174, 179, 157],
  face: [121, 132, 120],
  mass: [65, 81, 79],
  base: [29, 45, 47],
  tread: [198, 198, 173],
  riser: [119, 130, 117],
};

/**
 * Shading is a single signed step applied along the palette's own axis, so a
 * lit or shadowed material stays recognisably the same material.
 */
function setPixel(image, x, y, colour, lift = 0) {
  const index = (y * image.width + x) * 4;
  image.data[index] = colour[0] + lift;
  image.data[index + 1] = colour[1] + lift * 1.15;
  image.data[index + 2] = colour[2] + lift * 0.7;
  image.data[index + 3] = 255;
}

function fillRect(image, x, y, width, height, colour, lift) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(image.width, x + width);
  const y1 = Math.min(image.height, y + height);
  for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) setPixel(image, px, py, colour, lift);
}

/**
 * Blend a cool shadow into materials already baked beneath the structure. Red
 * is cut hardest and blue least, so shade drifts toward the void's teal rather
 * than simply going grey - the strongest single cue that one light source lit
 * the whole scene.
 */
function shadeRect(image, x, y, width, height) {
  for (let py = Math.max(0, y); py < Math.min(image.height, y + height); py++) for (let px = Math.max(0, x); px < Math.min(image.width, x + width); px++) {
    const index = (py * image.width + px) * 4;
    image.data[index] = image.data[index] * 0.58;
    image.data[index + 1] = image.data[index + 1] * 0.64;
    image.data[index + 2] = image.data[index + 2] * 0.76;
  }
}

// Boundary treatments: sunlit shallows, and the shaded lip where loose ground
// laps over a slab. Dry earth drifts over cut stone exactly as turf does, so
// it gets the same contact line in its own hue; without it the rule looked
// arbitrary, applied at one material boundary in the level and no other.
const WATER_RIM = [126, 205, 214];
const GRASS_CONTACT = [52, 84, 40];
const DIRT_CONTACT = [128, 90, 32];

// Amplitude per material: ground cover weathers hard, cut stone barely at all.
const TONE_RANGE = [0, 15, 12, 12, 8];

/**
 * Value noise at three scales, each sampled through a jittered coordinate so
 * the quantised cells never line up as a grid. Straight-sampled noise reads as
 * a checkerboard; ragged patches read as weathering. Same displacement trick
 * the material edges already use, reused here for surface tone.
 *
 * The widest octave is what stops a large field reading as a lawn: it drifts
 * whole regions lighter or darker, so light and shade look like they belong to
 * the landscape rather than to a texture laid over it. Its displacement has to
 * be proportionally larger or its region borders show up as straight seams.
 */
function octave(x, y, shift, seed) {
  // Displacement is sampled at a sixteenth of the cell and swings up to half of
  // it, so every octave's grid dissolves at its own scale. A fixed jitter only
  // ever hides the finest one and leaves the wider ones showing as squares.
  //
  // The block the drift is sampled in is what the torn border is actually made
  // of, so it has to stay small against the tile: at an eighth of the cell the
  // widest octave tore in 32-unit steps - a whole tile per step - and at any
  // real contrast the border read as a staircase of rectangles rather than as
  // a ragged edge. Halving the block halves the step and the same border
  // reads as erosion. The displacement stays where it was, well under the
  // cell, or neighbouring blocks land in unrelated cells and the region breaks
  // up at the drift scale instead of gaining a border at all.
  const cell = 1 << shift;
  const swing = cell >> 1;
  const drift = terrainHash(x >> shift - 4, y >> shift - 4, seed);
  return terrainHash(
    x + drift % swing - (swing >> 1) >> shift,
    y + (drift >>> 9) % swing - (swing >> 1) >> shift,
    seed + 5,
  ) % 3 - 1;
}

function tone(x, y, code, seed) {
  // Weighted toward the widest octave on purpose: broad light and shade across
  // the landscape is what a large field needs, not surface fizz. Amplitude
  // stays low because quantised cells read as rectangles as soon as the
  // contrast is high enough to notice - the drama belongs to the lighting.
  // Two wide grids offset by half a cell, summed. A single grid of quantised
  // cells always reads as a grid however far its borders are displaced; two
  // whose borders rarely coincide produce intermediate steps between regions,
  // which is what reads as light falling across a landscape.
  const region = octave(x, y, 8, seed + 3) + octave(x + 128, y + 128, 8, seed + 37);
  const broad = octave(x, y, 6, seed + code);
  // Weight sits on the wide pair rather than on a wider octave still. A grid
  // lazier than these has drift blocks big enough to be seen as blocks -
  // its displacement scales with its cell, so at sixteen tiles the jitter that
  // dissolves the eight-tile grid is itself two tiles across and the field
  // breaks into rectangles at the drift scale. Deepening a scale that already
  // renders cleanly buys the same broad light and shade with none of that.
  return (region * 3 + broad) * TONE_RANGE[code] / 5;
}

/** Cut stone weathers too, and a crown spanning many tiles is far too large a
 * surface to leave as one dead fill. Borrows the Floor tone band, which is the
 * shallowest, so the stone stays obviously cut rather than looking overgrown. */
function fillStone(image, level, x, y, width, height, colour) {
  for (let py = Math.max(0, y); py < Math.min(image.height, y + height); py++) {
    for (let px = Math.max(0, x); px < Math.min(image.width, x + width); px++) {
      setPixel(image, px, py, colour, tone(px, py, 4, level.seed));
    }
  }
}

function prepareLayers(level) {
  const count = level.tileStacks.length;
  const ground = new Uint8Array(count * MAX_STACK_ENTRIES);
  const upper = new Uint8Array(count * MAX_STACK_ENTRIES);
  const groundSupport = new Uint8Array(count);
  const upperSupport = new Uint8Array(count);
  const walls = new Uint8Array(count);
  const stairs = new Uint8Array(count);
  level.tileStacks.forEach((stack, index) => {
    const bands = splitBands(stack);
    bands.ground.forEach((code, slot) => { ground[index * MAX_STACK_ENTRIES + slot] = NUMBER[code]; });
    bands.upper.forEach((code, slot) => { upper[index * MAX_STACK_ENTRIES + slot] = NUMBER[code]; });
    groundSupport[index] = hasSurface(bands.ground);
    upperSupport[index] = hasSurface(bands.upper);
    walls[index] = stack.includes('#');
    stairs[index] = stack.includes('^');
  });
  return { ground, upper, groundSupport, upperSupport, walls, stairs };
}

function supportAt(level, support, x, y) {
  const index = tileIndex(level, x, y);
  return index < 0 ? 0 : support[index];
}

function drawFloorDetails(image, level, slots, slot, tileX, tileY, lift) {
  const index = tileIndex(level, tileX, tileY);
  if (slots[index * MAX_STACK_ENTRIES + slot] !== 4) return;
  const x = tileX * AUTHOR_TILE;
  const y = tileY * AUTHOR_TILE;
  // A recessed grout line plus a catch of light on its far side gives the slab
  // a carved edge instead of a drawn-on grid.
  fillRect(image, x + 3, y, AUTHOR_TILE - 6, 1, [150, 149, 132], lift);
  fillRect(image, x, y + 3, 1, AUTHOR_TILE - 6, [150, 149, 132], lift);
  fillRect(image, x + 3, y + 1, AUTHOR_TILE - 6, 1, [219, 216, 191], lift);
  fillRect(image, x + 1, y + 3, 1, AUTHOR_TILE - 6, [219, 216, 191], lift);

  // A carved medallion on the occasional slab. The reference plazas are never
  // an unbroken grid: a sparse repeated motif is what makes cut stone read as
  // built by someone rather than tiled by a renderer.
  if (terrainHash(tileX, tileY, level.seed + 211) % 11) return;
  for (const inset of [6, 11]) {
    const size = AUTHOR_TILE - inset * 2;
    fillRect(image, x + inset, y + inset, size, 1, [165, 163, 145], lift);
    fillRect(image, x + inset, y + inset + size, size, 1, [165, 163, 145], lift);
    fillRect(image, x + inset, y + inset, 1, size, [165, 163, 145], lift);
    fillRect(image, x + inset + size, y + inset, 1, size + 1, [165, 163, 145], lift);
  }
  fillRect(image, x + 15, y + 15, 3, 3, [165, 163, 145], lift);
}

/**
 * Props are silhouette-first: ink lumps carry the shape and the fill sits a
 * pixel inside them, so every prop keeps a hard dark rim.
 *
 * Their shadows are cast down and to the right, the same direction the walls
 * throw theirs and the same direction the light shafts travel. Everything in
 * the level that stands up off the ground is lit from one place and shadows to
 * one place; the old contact shelf under each prop obeyed neither, because it
 * was the silhouette's own base drawn twice rather than a shadow at all. Terrain materials
 * deliberately do not get that rim - two ground materials meet on one plane
 * and an outline between them would read as a trench - but anything standing
 * up off the ground occludes what is behind it, and the rim is what says so.
 *
 * Every ink lump has to be laid before any fill. Interleaving them lets a
 * later lump's outline print a dark line across an earlier lump's interior,
 * which is the one arrangement of these rects that cannot be seen coming.
 */
function drawDecoration(image, level, code, tileX, tileY, slot, lift) {
  const variant = terrainHash(tileX, tileY, level.seed + slot * 43);
  // Folded into the origin rather than added at every call: a prop is thirty
  // rectangles now and the jitter belongs to the whole object anyway.
  const x = tileX * AUTHOR_TILE + variant % 5 - 2;
  const y = tileY * AUTHOR_TILE;
  const at = (left, top, width, height, colour) => fillRect(image, x + left, y + top, width, height, colour, lift);
  // Which ground this prop is standing on decides two things: what it is, and
  // what colour it is rimmed in.
  const dry = stackAt(level, tileX, tileY).includes('d');
  // Props are rimmed and shadowed in a deep shade of the ground they stand on,
  // not in ink. Ink is right for the units - they move across every material
  // in the level and have to stay legible over all of them - but a prop only
  // ever sits on one, and a near-black ring is an enormous value step against
  // gold. Every cactus on the dry shelf read as a sticker. The rim only has to
  // be dark enough to say the object is in front of the ground behind it, and
  // borrowing the ground's own hue is what makes it look planted in the place
  // rather than pasted onto it - the same reasoning the contact lines between
  // materials already follow.
  const rim = dry ? [104, 72, 26] : [31, 56, 32];
  // Props cast the same shadow the structures do, in two bands stepping down
  // and right. shadeRect multiplies what is already baked instead of painting
  // a colour, which is why one call serves over grass, gold and cut slab alike
  // and why it needs no per-material tint the way the rim does.
  //
  // Laid before the prop, never after. Half of a cast shadow falls underneath
  // its own object, and the body has to be the thing that covers that half -
  // drawn over the top instead, the bands darken the prop's own shaded flank
  // and it reads as a smudge on the object rather than a shadow beside it.
  // Four short bands, not two long ones. Reach and smoothness pull against
  // each other here: two five-pixel steps read as a pair of blocks dropped
  // beside the object, and widening the steps to reach further only made the
  // blocks bigger. Adding a band instead buys the same reach out of steps
  // small enough to read as a taper, and the taper is what makes it a shadow
  // rather than a shape.
  //
  // The width is the caller's, because a shadow shared between a wide shrub, a
  // round cactus and a squat boulder belongs to none of them. It has to start
  // as wide as the thing standing in the light, and it has to run far enough
  // that the crescent clearing the far side is a shadow's length rather than a
  // sliver - most of these bands are hidden under their own object, so a
  // shadow sized to look right on its own looks far too small once drawn.
  const cast = (left, top, width) => {
    for (let band = 0; band < 4; band++) {
      shadeRect(image, x + left + band * 5, y + top + band * 3, width - band * 3, band ? 4 : 5);
    }
  };
  if (code === 5) {
    // Ground cover on dry earth is a barrel cactus rather than a shrub. It is
    // the cheapest possible way to say which continent this is: the material
    // already decides where scrub grows, so the plant can simply read the
    // ground it is standing on and no level data, editor material or palette
    // entry has to be added for it.
    if (dry) {
      const flesh = [116, 154, 78];
      // The barrel turns away to the south-east. Without it the plant was a
      // flat green disc with a rim drawn round it, which read as a badge next
      // to a rock and a shrub that both carry a lit plane and a shaded one.
      const turn = [80, 112, 56];
      // Three stacked lumps rather than a circle: a barrel is wide in the
      // middle and the steps are the plant's own shoulders at this size.
      cast(6, 20, 21);
      at(10, 5, 12, 23, rim);
      at(7, 8, 18, 18, rim);
      at(5, 11, 22, 12, rim);
      at(11, 6, 10, 21, flesh);
      at(8, 9, 16, 16, flesh);
      at(6, 12, 20, 10, flesh);
      // The far flank and the underside fall away, following the same light
      // the rock's facets and the shrub's crown are lit by. They have to meet:
      // a flank down one side and a separate block across the base read as two
      // rectangles rather than as one surface turning.
      at(19, 9, 5, 15, turn);
      at(13, 23, 8, 3, turn);
      // The crown is lit on the near side only now that the far side turns.
      at(11, 6, 8, 3, [156, 188, 100]);
      // A tan bloom on the crown. One warm accent per plant is what stops a
      // field of these reading as green lumps.
      at(14, 6, 4, 1, [214, 176, 138]);
      // Speckled ribs, jittered a row per plant so no two are the same.
      for (let dot = 0; dot < 12; dot++) {
        at(
          10 + dot % 3 * 6, 9 + (dot / 3 | 0) * 4 + (variant >> dot & 1), 1, 1,
          // The far column of ribs sits in the shaded flank. Full-brightness
          // specks there punch straight back through the shading and flatten
          // the barrel again, which is the whole thing this was added to fix.
          dot % 3 === 2 ? [178, 194, 146] : [236, 240, 214],
        );
      }
      return;
    }
    const bark = rim;
    const leaf = [44, 84, 50];
    // A round mass with bites taken out of its crown, not a stack of bands and
    // not a row of towers - both of those were tried and both read as
    // architecture. The silhouette does the work here: a dome says shrub, and
    // two notches in it are all that is needed to stop the dome reading as one
    // smooth object.
    //
    // The fill sits further above the ink than the old bush did. Silhouette
    // props were drawn barely a shade above the void on purpose, but at that
    // separation there is nowhere to put interior detail, and beside a cactus
    // with speckled ribs the shrub looked unfinished rather than restrained.
    cast(5, 17, 23);
    at(8, 6, 16, 19, bark);
    at(5, 9, 22, 15, bark);
    at(3, 12, 26, 10, bark);
    at(9, 7, 14, 17, leaf);
    at(6, 10, 20, 13, leaf);
    at(4, 13, 24, 8, leaf);
    // Lit on the north-west, where the walls take their own highlight and
    // where the shafts fall from.
    at(9, 7, 9, 3, [86, 132, 66]);
    at(6, 10, 6, 2, [86, 132, 66]);
    // One wide bite out of the crown, wandering four pixels off the hash. Two
    // narrow bites left three teeth of roughly equal width between them, which
    // is battlements again - the notch has to be wider than what it leaves.
    at(13 + (variant >> 7 & 3), 6, 4, 3, bark);
    // Foliage, alternating lit and shaded. Dark marks alone read as damage;
    // it is the light ones that say leaves, and they are the shrub's answer to
    // the speckled ribs on the cactus.
    for (let sprig = 0; sprig < 6; sprig++) {
      at(
        7 + sprig * 3 + (variant >> sprig + 3 & 1),
        11 + (variant >> sprig & 3) * 3, 2, 1,
        sprig & 1 ? bark : [86, 132, 66],
      );
    }
  } else if (code === 6) {
    const grit = rim;
    const face = [96, 106, 100];
    const shade = [58, 72, 72];
    // Three lumps widening as they fall and pushed off-centre, not stacked
    // square. A boulder is faceted and bottom-heavy; a symmetrical stack of
    // rects is a plinth, which is exactly what this was - a bright slab
    // balanced on a grey box. Widest in the middle was the first attempt and
    // gave it feet, so the base carries the width and the taper runs upward.
    cast(5, 14, 21);
    at(8, 8, 12, 6, grit);
    at(6, 11, 19, 8, grit);
    at(4, 15, 22, 8, grit);
    at(9, 9, 10, 4, face);
    at(7, 12, 17, 6, face);
    at(5, 16, 20, 6, face);
    // One lit plane running north-west across the top, the same direction
    // every wall in the level takes its own highlight from.
    at(9, 9, 10, 4, [176, 180, 160]);
    at(7, 12, 8, 3, [176, 180, 160]);
    // The south-east faces fall away. Without them the body is one flat grey
    // and the rock reads as a decal lying on the ground rather than a solid
    // standing on it.
    at(15, 14, 9, 4, shade);
    at(13, 18, 11, 4, shade);
    at(8 + (variant >> 3 & 3), 15, 5, 1, shade);
  }
}

/**
 * Hash-placed micro detail. The reference art is dense at every scale, but a
 * 32px authoring tile cannot express that without exploding the level data, so
 * the surface earns its detail deterministically instead of storing it.
 */
function drawScatter(image, level, slots, support, lift) {
  for (let tileY = 0; tileY < level.tileHeight; tileY++) for (let tileX = 0; tileX < level.tileWidth; tileX++) {
    const index = tileY * level.tileWidth + tileX;
    if (!support[index]) continue;
    let code = 0;
    let prop = false;
    for (let slot = 0; slot < MAX_STACK_ENTRIES; slot++) {
      const entry = slots[index * MAX_STACK_ENTRIES + slot];
      if (entry > 4) prop = true;
      else if (entry > 0) code = entry;
    }
    // Tiles carrying a prop are left alone; scatter runs after the slot loop
    // and would otherwise stipple tufts across the bush it grows beside.
    if (prop || !code || code > 4) continue;
    const count = terrainHash(tileX, tileY, level.seed + 311) % 4;
    for (let i = 0; i < count; i++) {
      const spot = terrainHash(tileX * 7 + i, tileY * 13 + i * 3, level.seed + 57);
      const x = tileX * AUTHOR_TILE + spot % 27 + 2;
      const y = tileY * AUTHOR_TILE + (spot >> 5) % 27 + 2;
      if (code === 1) {
        // Grass tufts: a dark blade cluster with one lit tip above it.
        fillRect(image, x, y + 1, 3, 2, [45, 76, 38], lift);
        fillRect(image, x + 1, y, 1, 2, [128, 170, 74], lift);
      } else if (code === 2) {
        // Dry earth cracks and sheds grit rather than sprouting: a short dark
        // fissure with one grain catching the light on its upper edge.
        fillRect(image, x, y + 1, 2 + spot % 3, 1, [138, 96, 36], lift);
        if (spot & 2048) fillRect(image, x + 1, y, 1, 1, [230, 194, 116], lift);
      } else if (code === 3) {
        // Water gets flat horizontal glints. Reflections lie along the surface,
        // so a streak reads as water where a speck would read as debris.
        fillRect(image, x, y, 5 + spot % 7, 1, [104, 190, 208], lift);
      } else {
        // Slabs chip and craze rather than sprout; single-pixel marks only.
        fillRect(image, x, y, 1 + (spot >> 11 & 1), 1, [166, 163, 143], lift);
        if (spot & 4096) fillRect(image, x + 1, y + 1, 1, 1, [225, 222, 198], lift);
      }
    }
  }
}

/**
 * Edge jitter reaches at most one tile, so a slot with nothing in the local
 * neighbourhood cannot contribute a single pixel. Skipping those tiles is what
 * keeps the bake affordable: a stack rarely fills more than two of its eight
 * slots, but every slot used to cost a full pass over every supported tile.
 */
function slotUsedNear(level, slots, slot, tileX, tileY) {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const index = tileIndex(level, tileX + dx, tileY + dy);
    if (index >= 0 && slots[index * MAX_STACK_ENTRIES + slot]) return true;
  }
  return false;
}

/**
 * Rim lighting along material boundaries. Flat regions meeting at a hard edge
 * read as cut paper; a bright shoreline on the water and a shaded contact line
 * where ground cover laps over stone are what make the same two regions read
 * as one surface lying on another. Needs the per-pixel material map, because
 * the edges are jittered and no longer follow tile boundaries.
 */
function drawMaterialEdges(image, field, lift) {
  const { width, height } = image;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    const code = field[index];
    if (!code || code === 4) continue;
    const north = y ? field[index - width] : 0;
    const south = y < height - 1 ? field[index + width] : 0;
    const west = x ? field[index - 1] : 0;
    const east = x < width - 1 ? field[index + 1] : 0;
    if (code === 3) {
      // Shallows catch the light all the way around the pool.
      if (north !== 3 || south !== 3 || west !== 3 || east !== 3) setPixel(image, x, y, WATER_RIM, lift);
    } else if (north === 4 || south === 4 || west === 4 || east === 4) {
      setPixel(image, x, y, code === 1 ? GRASS_CONTACT : DIRT_CONTACT, lift);
    }
  }
}

function drawBand(image, level, slots, support, upper = false, field = null) {
  if (field) field.fill(0);
  for (let slot = 0; slot < MAX_STACK_ENTRIES; slot++) {
    for (let tileY = 0; tileY < level.tileHeight; tileY++) for (let tileX = 0; tileX < level.tileWidth; tileX++) {
      const index = tileY * level.tileWidth + tileX;
      if (!support[index] || !slotUsedNear(level, slots, slot, tileX, tileY)) continue;
      const x0 = tileX * AUTHOR_TILE;
      const y0 = tileY * AUTHOR_TILE;
      const ownCode = slots[index * MAX_STACK_ENTRIES + slot];
      const spread = ownCode === 4 ? 2 : ownCode === 3 ? 4 : 6;
      const base = upper ? RAISED_LIFT : 0;
      for (let y = y0; y < y0 + AUTHOR_TILE; y++) for (let x = x0; x < x0 + AUTHOR_TILE; x++) {
        const sampleX = x + terrainHash(x >> 3, y >> 3, level.seed + slot * 17) % (spread * 2 + 1) - spread;
        const sampleY = y + terrainHash(x >> 3, y >> 3, level.seed + slot * 29) % (spread * 2 + 1) - spread;
        let sampled = tileIndex(level, Math.floor(sampleX / AUTHOR_TILE), Math.floor(sampleY / AUTHOR_TILE));
        // Only the destination is confined to this tile; the sample is free to
        // wander, which is what roughens a material edge. On the Elevated band
        // a sample that wanders off the platform would leave the pixel unpainted
        // and let the structure below show through, so it falls back to this
        // tile's own material. That keeps the structural edge crisp while still
        // letting neighbouring Elevated materials mix - without the fallback a
        // narrow platform had to disable jitter entirely and rendered as a grid
        // of hard tile-sized squares.
        if (upper && (sampled < 0 || !support[sampled])) sampled = index;
        if (sampled < 0) continue;
        const code = slots[sampled * MAX_STACK_ENTRIES + slot];
        if (code > 0 && code < 5) {
          setPixel(image, x, y, RGB[code], base + tone(x, y, code, level.seed));
          if (field) field[y * image.width + x] = code;
        }
      }
      if (ownCode === 4) drawFloorDetails(image, level, slots, slot, tileX, tileY, base);
      else if (ownCode > 4) drawDecoration(image, level, ownCode, tileX, tileY, slot, base);
    }
  }
  // Scatter rides above every material slot but below props, so a tuft never
  // erases the bush it grows beside.
  const lift = upper ? RAISED_LIFT : 0;
  if (field) drawMaterialEdges(image, field, lift);
  drawScatter(image, level, slots, support, lift);
}

/**
 * Every structure throws its shadow six pixels south and six east, which is
 * the direction the light shafts travel and the direction every lit bevel and
 * prop highlight in the level faces away from. The two depths differ on
 * purpose: a wall's southern shadow falls from a two-tile facade and its
 * eastern one from the crown alone.
 */
function drawShadows(image, level, walls, stairs) {
  const at = (field, x, y) => {
    const index = tileIndex(level, x, y);
    return index < 0 ? 0 : field[index];
  };
  for (let y = 0; y < level.tileHeight; y++) for (let x = 0; x < level.tileWidth; x++) {
    const wall = at(walls, x, y);
    const stair = at(stairs, x, y);
    if (!wall && !stair) continue;
    const worldX = x * AUTHOR_TILE;
    const worldY = y * AUTHOR_TILE;
    if (wall) {
      const facade = !at(walls, x, y + 1) && !at(stairs, x, y + 1);
      if (facade) shadeRect(image, worldX + 6, worldY + 64, AUTHOR_TILE, 12);
      if (!at(walls, x + 1, y) && !at(stairs, x + 1, y)) shadeRect(image, worldX + 32, worldY + 6, 6, facade ? 64 : 32);
    } else if (!at(stairs, x, y + 2)) shadeRect(image, worldX + 6, worldY + 64, AUTHOR_TILE, 6);
  }
}

function drawWalls(image, level, walls, stairs) {
  const at = (field, x, y) => {
    const index = tileIndex(level, x, y);
    return index < 0 ? 0 : field[index];
  };
  const wallAt = (x, y) => at(walls, x, y);
  // Joined rows are solid mass; only each exposed southern row emits the
  // two-tile facade and its pale lip, avoiding repeated horizontal stripes.
  for (let y = 0; y < level.tileHeight; y++) for (let x = 0; x < level.tileWidth; x++) {
    if (!wallAt(x, y)) continue;
    const worldX = x * AUTHOR_TILE;
    const worldY = y * AUTHOR_TILE;
    // Stairs directly south continue the raised mass instead of exposing a
    // second Wall facade behind the staircase and pushing the platform back.
    const facade = !wallAt(x, y + 1) && !at(stairs, x, y + 1);
    // The mass is seen from above, so its own tile is a sunlit crown. Rendering
    // it darker than the surrounding field made a solid block read as a hole.
    fillStone(image, level, worldX, worldY, AUTHOR_TILE, 32, STONE.crown);
    // Chips keep a crown spanning many tiles from reading as one flat shape.
    const wear = terrainHash(x, y, level.seed + 77);
    const chipX = worldX + wear % 22 + 4;
    if (wear % 3) {
      const chipY = worldY + (wear >>> 6) % 22 + 4;
      fillRect(image, chipX, chipY, 3 + (wear >>> 12 & 3), 1, STONE.face);
      fillRect(image, chipX + 1, chipY + 1, 2, 1, STONE.side);
    }
    if (facade) {
      // Only the exposed southern row projects a front face onto the tile
      // below: lit under the crown, falling into shadow at the ground line.
      fillStone(image, level, worldX, worldY + 32, AUTHOR_TILE, 20, STONE.face);
      fillStone(image, level, worldX, worldY + 52, AUTHOR_TILE, 11, STONE.mass);
      // Three tones retain the old readable thickness without one chunky band.
      fillRect(image, worldX, worldY + 29, AUTHOR_TILE, 1, STONE.side);
      fillRect(image, worldX, worldY + 30, AUTHOR_TILE, 1, STONE.lip);
      fillRect(image, worldX, worldY + 31, AUTHOR_TILE, 1, STONE.face);
      if (wear & 2) fillRect(image, chipX, worldY + 30, 3 + (wear >>> 10 & 3), 1, STONE.crown);
      fillRect(image, worldX, worldY + 63, AUTHOR_TILE, 2, STONE.base);
    }
    // Directional two-tone bevels join at corners. Tiny nicks interrupt the
    // ruler-straight highlight but never break the darker structural return.
    if (!wallAt(x, y - 1)) {
      fillRect(image, worldX, worldY, AUTHOR_TILE, 1, STONE.side);
      fillRect(image, worldX, worldY + 1, AUTHOR_TILE, 1, STONE.lip);
      fillRect(image, worldX, worldY + 2, AUTHOR_TILE, 1, STONE.crown);
      if (wear & 4) fillRect(image, chipX, worldY + 1, 2 + (wear >>> 11 & 3), 1, STONE.crown);
    }
    const height = facade ? 63 : 32;
    if (!wallAt(x - 1, y)) {
      fillRect(image, worldX, worldY, 1, height, STONE.lip);
      fillRect(image, worldX + 1, worldY, 2, height, STONE.side);
    }
    if (!wallAt(x + 1, y)) {
      fillRect(image, worldX + AUTHOR_TILE - 3, worldY, 2, height, STONE.side);
      fillRect(image, worldX + AUTHOR_TILE - 1, worldY, 1, height, STONE.face);
    }
  }
}

function drawUpperEdges(image, level, support) {
  for (let y = 0; y < level.tileHeight; y++) for (let x = 0; x < level.tileWidth; x++) {
    if (!supportAt(level, support, x, y)) continue;
    const worldX = x * AUTHOR_TILE;
    const worldY = y * AUTHOR_TILE;
    const wear = terrainHash(x, y, level.seed + 151);
    const chip = 4 + wear % 22;
    const chipSize = 2 + (wear >>> 8 & 3);
    if (!supportAt(level, support, x, y - 1)) {
      fillRect(image, worldX, worldY, AUTHOR_TILE, 1, STONE.lip);
      fillRect(image, worldX, worldY + 1, AUTHOR_TILE, 1, STONE.side);
      if (wear & 1) fillRect(image, worldX + chip, worldY, chipSize, 1, STONE.side);
    }
    if (!supportAt(level, support, x, y + 1)) {
      fillRect(image, worldX, worldY + AUTHOR_TILE - 3, AUTHOR_TILE, 1, STONE.side);
      fillRect(image, worldX, worldY + AUTHOR_TILE - 2, AUTHOR_TILE, 1, STONE.lip);
      fillRect(image, worldX, worldY + AUTHOR_TILE - 1, AUTHOR_TILE, 1, STONE.face);
      fillRect(image, worldX, worldY + AUTHOR_TILE, AUTHOR_TILE, 2, STONE.mass);
      fillRect(image, worldX, worldY + AUTHOR_TILE + 2, AUTHOR_TILE, 1, STONE.base);
      if (wear & 2) fillRect(image, worldX + chip, worldY + AUTHOR_TILE - 2, chipSize, 1, STONE.face);
    }
    // Light and shadow split each full-height return rather than widening one
    // flat colour. The edge remains continuous over identical materials.
    if (!supportAt(level, support, x - 1, y)) {
      fillRect(image, worldX, worldY, 1, AUTHOR_TILE, STONE.side);
      fillRect(image, worldX + 1, worldY, 1, AUTHOR_TILE, STONE.lip);
      if (wear & 4) fillRect(image, worldX + 1, worldY + chip, 1, chipSize, STONE.face);
    }
    if (!supportAt(level, support, x + 1, y)) {
      fillRect(image, worldX + AUTHOR_TILE - 2, worldY, 1, AUTHOR_TILE, STONE.side);
      fillRect(image, worldX + AUTHOR_TILE - 1, worldY, 1, AUTHOR_TILE, STONE.face);
      if (wear & 8) fillRect(image, worldX + AUTHOR_TILE - 2, worldY + chip, 1, chipSize, STONE.mass);
    }
  }
}

/** South-facing stairs replace the raised lip and join into broad runs. */
function drawStairs(image, level, stairs, walls) {
  const at = (field, x, y) => {
    const index = tileIndex(level, x, y);
    return index < 0 ? 0 : field[index];
  };
  for (let y = 0; y < level.tileHeight; y++) for (let x = 0; x < level.tileWidth; x++) {
    if (!at(stairs, x, y)) continue;
    const worldX = x * AUTHOR_TILE;
    const worldY = y * AUTHOR_TILE;
    for (let step = 0; step < 64; step += 8) {
      fillRect(image, worldX, worldY + step, AUTHOR_TILE, 6, STONE.tread);
      fillRect(image, worldX, worldY + step, AUTHOR_TILE, 1, STONE.lip);
      fillRect(image, worldX, worldY + step + 6, AUTHOR_TILE, 2, STONE.riser);
    }
    if (!at(stairs, x - 1, y) && !at(walls, x - 1, y)) {
      fillRect(image, worldX, worldY, 1, 64, STONE.side);
      fillRect(image, worldX + 1, worldY, 1, 64, STONE.lip);
      fillRect(image, worldX + 2, worldY, 2, 64, STONE.side);
    }
    if (!at(stairs, x + 1, y) && !at(walls, x + 1, y)) {
      fillRect(image, worldX + AUTHOR_TILE - 4, worldY, 1, 64, STONE.side);
      fillRect(image, worldX + AUTHOR_TILE - 3, worldY, 1, 64, STONE.face);
      fillRect(image, worldX + AUTHOR_TILE - 2, worldY, 2, 64, STONE.mass);
    }
    if (!at(stairs, x, y + 2)) fillRect(image, worldX, worldY + 62, AUTHOR_TILE, 2, STONE.base);
  }
}

const FALLOFF_REACH = 4;

/**
 * Sink the outermost ground into the void. Without this the world ends at a
 * cut line, which is the one thing that most gives away a tilemap; the
 * reference art always frames its play area in darkness so the edge reads as
 * distance rather than as the end of the data.
 *
 * The distance field is per tile, but it is sampled bilinearly per pixel -
 * a tile-resolution ramp would just replace one visible grid with another.
 */
function drawEdgeFalloff(image, level, support) {
  const { tileWidth, tileHeight } = level;
  const distance = new Uint8Array(tileWidth * tileHeight).fill(FALLOFF_REACH);
  for (let i = 0; i < distance.length; i++) if (!support[i]) distance[i] = 0;
  // Only painted void seeds the falloff, never the array bounds. The camera is
  // clamped to the world, so ground that runs to the world edge is never seen
  // past and needs no framing - it is the authored void that has to recede.
  const distanceAt = (x, y) => x < 0 || y < 0 || x >= tileWidth || y >= tileHeight
    ? FALLOFF_REACH : distance[y * tileWidth + x];
  for (let pass = 1; pass < FALLOFF_REACH; pass++) {
    for (let y = 0; y < tileHeight; y++) for (let x = 0; x < tileWidth; x++) {
      const index = y * tileWidth + x;
      if (!distance[index]) continue;
      distance[index] = Math.min(distance[index], 1 + Math.min(
        distanceAt(x - 1, y), distanceAt(x + 1, y),
        distanceAt(x, y - 1), distanceAt(x, y + 1),
      ));
    }
  }

  for (let tileY = 0; tileY < tileHeight; tileY++) for (let tileX = 0; tileX < tileWidth; tileX++) {
    if (distance[tileY * tileWidth + tileX] >= FALLOFF_REACH) continue;
    for (let py = 0; py < AUTHOR_TILE; py++) for (let px = 0; px < AUTHOR_TILE; px++) {
      const sampleX = tileX + (px + 0.5) / AUTHOR_TILE - 0.5;
      const sampleY = tileY + (py + 0.5) / AUTHOR_TILE - 0.5;
      const x0 = Math.floor(sampleX);
      const y0 = Math.floor(sampleY);
      const alongX = sampleX - x0;
      const alongY = sampleY - y0;
      const top = distanceAt(x0, y0) + (distanceAt(x0 + 1, y0) - distanceAt(x0, y0)) * alongX;
      const bottom = distanceAt(x0, y0 + 1) + (distanceAt(x0 + 1, y0 + 1) - distanceAt(x0, y0 + 1)) * alongX;
      const fade = 1 - Math.min(1, (top + (bottom - top) * alongY) / FALLOFF_REACH);
      if (fade <= 0) continue;
      const index = ((tileY * AUTHOR_TILE + py) * image.width + tileX * AUTHOR_TILE + px) * 4;
      for (let channel = 0; channel < 3; channel++) {
        image.data[index + channel] += (RGB[0][channel] - image.data[index + channel]) * fade * 0.9;
      }
    }
  }
}

/** Bake the ordered stack once; gameplay only crops this static canvas. */
export function buildTerrain(level, scale = CACHE_SCALE, canvas = document.createElement('canvas')) {
  canvas.width = Math.ceil(level.width / scale);
  canvas.height = Math.ceil(level.height / scale);
  const context = canvas.getContext('2d', { alpha: false });
  const image = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) setPixel(image, x, y, RGB[0]);
  const layers = prepareLayers(level);
  // One scratch material map, cleared per band. Reusing it keeps the edge pass
  // from ever seeing ground pixels that a Wall has since painted over.
  const field = new Uint8Array(image.width * image.height);
  drawBand(image, level, layers.ground, layers.groundSupport, false, field);
  drawShadows(image, level, layers.walls, layers.stairs);
  drawWalls(image, level, layers.walls, layers.stairs);
  drawBand(image, level, layers.upper, layers.upperSupport, true, field);
  drawUpperEdges(image, level, layers.upperSupport);
  drawStairs(image, level, layers.stairs, layers.walls);
  // Last, so structures near the boundary recede with the ground they stand on.
  drawEdgeFalloff(image, level, layers.groundSupport.map(
    (value, index) => value || layers.upperSupport[index] || layers.walls[index],
  ));
  context.putImageData(image, 0, 0);
  return { canvas, level, scale };
}

export function drawTerrain(context, terrain, bounds) {
  const { canvas, scale } = terrain;
  const sx = Math.max(0, Math.floor(bounds.left / scale));
  const sy = Math.max(0, Math.floor(bounds.top / scale));
  const ex = Math.min(canvas.width, Math.ceil(bounds.right / scale));
  const ey = Math.min(canvas.height, Math.ceil(bounds.bottom / scale));
  context.imageSmoothingEnabled = false;
  if (ex <= sx || ey <= sy) return;
  context.drawImage(canvas, sx, sy, ex - sx, ey - sy, sx * scale, sy * scale, (ex - sx) * scale, (ey - sy) * scale);
}

export function terrainSignature(level) {
  let signature = 2166136261;
  for (let i = 0; i < level.tileStacks.length; i++) {
    for (const code of level.tileStacks[i]) signature = Math.imul(signature ^ code.charCodeAt(0) ^ terrainHash(i, code.charCodeAt(0), level.seed), 16777619);
    signature = Math.imul(signature ^ 255, 16777619);
  }
  for (const byte of level.collision) signature = Math.imul(signature ^ byte, 16777619);
  return signature >>> 0;
}
