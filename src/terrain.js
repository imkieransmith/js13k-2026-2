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

function base64ToBytes(encoded, label) {
  let binary;
  try { binary = atob(encoded || ''); } catch { throw Error(`Malformed ${label} base64`); }
  return Uint8Array.from(binary, character => character.charCodeAt(0));
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
  if (!Array.isArray(source.player) || source.player.length !== 2 || !Array.isArray(source.enemies)) throw Error('Invalid level starts');
  return {
    width: source.width,
    height: source.height,
    cell: MASK_CELL,
    seed: source.seed || 1,
    player: [...source.player],
    enemies: source.enemies.map(enemy => [...enemy]),
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
export const RGB = [
  [11, 22, 27],
  [82, 137, 62],
  [124, 88, 58],
  [46, 146, 183],
  [203, 200, 176],
];
const NUMBER = { g: 1, d: 2, w: 3, f: 4, b: 5, s: 6 };
// Elevated ground catches more light than the field it sits above.
export const RAISED_LIFT = 13;

/**
 * Cut stone reads as a single carved mass lit from the north: a blown-out top
 * lip, a face a full step down, and a body that falls almost to the void. The
 * wide gap between lip and body is what gives the ruins their weight, so these
 * are named rather than inlined and the smoke test asserts against the names.
 */
export const STONE = {
  lip: [238, 236, 208],
  side: [178, 190, 166],
  crown: [150, 165, 144],
  face: [104, 124, 116],
  mass: [59, 84, 83],
  base: [26, 46, 49],
  tread: [188, 197, 173],
  riser: [101, 124, 118],
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

// Boundary treatments: sunlit shallows, and the shaded lip where ground cover
// laps over a slab.
const WATER_RIM = [126, 205, 214];
const GRASS_CONTACT = [46, 88, 46];

// Amplitude per material: ground cover weathers hard, cut stone barely at all.
const TONE_RANGE = [0, 15, 10, 12, 5];

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
  // Displacement is sampled at an eighth of the cell and swings up to half of
  // it, so every octave's grid dissolves at its own scale. A fixed jitter only
  // ever hides the finest one and leaves the wider ones showing as squares.
  // The displacement has to stay well under the cell, or neighbouring drift
  // blocks land in unrelated cells and the region breaks into squares at the
  // drift scale instead of gaining a ragged border. An eighth-cell block
  // displaced by up to a quarter cell is the balance that reads as organic.
  const cell = 1 << shift;
  const swing = cell >> 1;
  const drift = terrainHash(x >> shift - 3, y >> shift - 3, seed);
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
  return (region * 2 + broad) * TONE_RANGE[code] / 5;
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
 * Props are silhouette-first: a dark contact blob anchors the object, a body
 * only a shade above the void carries the shape, and one narrow rim of colour
 * on top catches the same light as the raised ground.
 */
function drawDecoration(image, level, code, tileX, tileY, slot, lift) {
  const x = tileX * AUTHOR_TILE;
  const y = tileY * AUTHOR_TILE;
  const variant = terrainHash(tileX, tileY, level.seed + slot * 43);
  if (code === 5) {
    const offset = variant % 5 - 2;
    const wide = variant >> 4 & 3;
    fillRect(image, x + 4 + offset, y + 22, 24 + wide, 4, [17, 33, 30], lift);
    fillRect(image, x + 5 + offset, y + 16, 22 + wide, 8, [23, 48, 40], lift);
    fillRect(image, x + 8 + offset, y + 11, 15 + wide, 10, [30, 62, 46], lift);
    fillRect(image, x + 10 + offset, y + 10, 10 + wide, 3, [58, 104, 60], lift);
  } else if (code === 6) {
    const offset = variant % 7 - 3;
    fillRect(image, x + 9 + offset, y + 21, 16, 3, [24, 40, 40], lift);
    fillRect(image, x + 10 + offset, y + 15, 14, 7, [118, 124, 111], lift);
    fillRect(image, x + 12 + offset, y + 12, 9, 4, [196, 197, 172], lift);
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
    if (prop || (code !== 1 && code !== 3 && code !== 4)) continue;
    const count = terrainHash(tileX, tileY, level.seed + 311) % 4;
    for (let i = 0; i < count; i++) {
      const spot = terrainHash(tileX * 7 + i, tileY * 13 + i * 3, level.seed + 57);
      const x = tileX * AUTHOR_TILE + spot % 27 + 2;
      const y = tileY * AUTHOR_TILE + (spot >> 5) % 27 + 2;
      if (code === 1) {
        // Grass tufts: a dark blade cluster with one lit tip above it.
        fillRect(image, x, y + 1, 3, 2, [40, 79, 43], lift);
        fillRect(image, x + 1, y, 1, 2, [117, 172, 82], lift);
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
    if (code !== 1 && code !== 3) continue;
    const north = y ? field[index - width] : 0;
    const south = y < height - 1 ? field[index + width] : 0;
    const west = x ? field[index - 1] : 0;
    const east = x < width - 1 ? field[index + 1] : 0;
    if (code === 3) {
      // Shallows catch the light all the way around the pool.
      if (north !== 3 || south !== 3 || west !== 3 || east !== 3) setPixel(image, x, y, WATER_RIM, lift);
    } else if (north === 4 || south === 4 || west === 4 || east === 4) {
      setPixel(image, x, y, GRASS_CONTACT, lift);
    }
  }
}

function drawBand(image, level, slots, support, upper = false, field = null) {
  if (field) field.fill(0);
  for (let slot = 0; slot < MAX_STACK_ENTRIES; slot++) {
    for (let tileY = 0; tileY < level.tileHeight; tileY++) for (let tileX = 0; tileX < level.tileWidth; tileX++) {
      const index = tileY * level.tileWidth + tileX;
      if (!support[index] || !slotUsedNear(level, slots, slot, tileX, tileY)) continue;
      const strict = upper && (!supportAt(level, support, tileX - 1, tileY)
        || !supportAt(level, support, tileX + 1, tileY)
        || !supportAt(level, support, tileX, tileY - 1)
        || !supportAt(level, support, tileX, tileY + 1));
      const x0 = tileX * AUTHOR_TILE;
      const y0 = tileY * AUTHOR_TILE;
      const ownCode = slots[index * MAX_STACK_ENTRIES + slot];
      const spread = ownCode === 4 ? 2 : ownCode === 3 ? 4 : 6;
      const base = upper ? RAISED_LIFT : 0;
      for (let y = y0; y < y0 + AUTHOR_TILE; y++) for (let x = x0; x < x0 + AUTHOR_TILE; x++) {
        let sampleX = x;
        let sampleY = y;
        if (!strict) {
          sampleX += terrainHash(x >> 3, y >> 3, level.seed + slot * 17) % (spread * 2 + 1) - spread;
          sampleY += terrainHash(x >> 3, y >> 3, level.seed + slot * 29) % (spread * 2 + 1) - spread;
        }
        const sampledTile = tileIndex(level, Math.floor(sampleX / AUTHOR_TILE), Math.floor(sampleY / AUTHOR_TILE));
        if (sampledTile < 0) continue;
        const code = slots[sampledTile * MAX_STACK_ENTRIES + slot];
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
    } else if (!at(stairs, x, y + 2)) shadeRect(image, worldX + 5, worldY + 64, AUTHOR_TILE, 6);
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
    if (wear % 3) {
      const chipX = worldX + wear % 22 + 4;
      const chipY = worldY + (wear >>> 6) % 22 + 4;
      fillRect(image, chipX, chipY, 3 + (wear >>> 12 & 3), 1, STONE.face);
      fillRect(image, chipX + 1, chipY + 1, 2, 1, STONE.side);
    }
    if (facade) {
      // Only the exposed southern row projects a front face onto the tile
      // below: lit under the crown, falling into shadow at the ground line.
      fillStone(image, level, worldX, worldY + 32, AUTHOR_TILE, 20, STONE.face);
      fillStone(image, level, worldX, worldY + 52, AUTHOR_TILE, 11, STONE.mass);
      fillRect(image, worldX, worldY + 29, AUTHOR_TILE, 3, STONE.lip);
      fillRect(image, worldX, worldY + 63, AUTHOR_TILE, 2, STONE.base);
    }
    // The back edge completes the raised perimeter; facade and side edges
    // below join it through convex and concave corners.
    if (!wallAt(x, y - 1)) fillRect(image, worldX, worldY, AUTHOR_TILE, 3, STONE.lip);
    const height = facade ? 63 : 32;
    if (!wallAt(x - 1, y)) fillRect(image, worldX, worldY, 3, height, STONE.side);
    if (!wallAt(x + 1, y)) fillRect(image, worldX + AUTHOR_TILE - 3, worldY, 3, height, STONE.side);
  }
}

function drawUpperEdges(image, level, support) {
  for (let y = 0; y < level.tileHeight; y++) for (let x = 0; x < level.tileWidth; x++) {
    if (!supportAt(level, support, x, y)) continue;
    const worldX = x * AUTHOR_TILE;
    const worldY = y * AUTHOR_TILE;
    if (!supportAt(level, support, x, y - 1)) fillRect(image, worldX, worldY, AUTHOR_TILE, 2, STONE.lip);
    if (!supportAt(level, support, x, y + 1)) {
      fillRect(image, worldX, worldY + AUTHOR_TILE - 3, AUTHOR_TILE, 3, STONE.lip);
      fillRect(image, worldX, worldY + AUTHOR_TILE, AUTHOR_TILE, 3, STONE.mass);
    }
    // Full-height returns join across tile corners, so identical upper/lower
    // materials can never visually bleed through a dashed structural edge.
    if (!supportAt(level, support, x - 1, y)) fillRect(image, worldX, worldY, 2, AUTHOR_TILE, STONE.side);
    if (!supportAt(level, support, x + 1, y)) fillRect(image, worldX + AUTHOR_TILE - 2, worldY, 2, AUTHOR_TILE, STONE.side);
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
    if (!at(stairs, x - 1, y) && !at(walls, x - 1, y)) fillRect(image, worldX, worldY, 4, 64, STONE.lip);
    if (!at(stairs, x + 1, y) && !at(walls, x + 1, y)) fillRect(image, worldX + AUTHOR_TILE - 4, worldY, 4, 64, STONE.mass);
    if (!at(stairs, x, y + 2)) fillRect(image, worldX, worldY + 62, AUTHOR_TILE, 2, STONE.base);
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
