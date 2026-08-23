// Shared terrain vocabulary for the game and development-only editor.
// Ordered tile stacks preserve the author's painter sequence; visual edge
// roughness is deterministic and therefore costs no bytes in level data.
export const MASK_CELL = 8;
export const AUTHOR_TILE = 32;
export const MAX_STACK_ENTRIES = 8;
export const MATERIALS = ['grass', 'dirt', 'water', 'floor', 'bushes', 'stones', 'wall'];

const CODE = { grass: 'g', dirt: 'd', water: 'w', floor: 'f', bushes: 'b', stones: 's', wall: '#' };
const NAME = { g: 'grass', d: 'dirt', w: 'water', f: 'floor', b: 'bushes', s: 'stones', '#': 'wall' };
const SURFACES = 'gdwf';
const VISUALS = 'gdwfbs';
const CACHE_SCALE = 1;

/** Stable integer hash used by every unstored terrain variation. */
export function terrainHash(x, y, salt = 0) {
  let value = Math.imul(x ^ salt, 374761393) + Math.imul(y + salt, 668265263);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return (value ^ value >>> 16) >>> 0;
}

const materialCode = material => CODE[material] || material;
export const materialName = code => NAME[code];
const wallIndex = stack => stack.indexOf('#');
const hasSurface = entries => entries.some(code => SURFACES.includes(code));

/** Strict validation keeps corrupt level data from silently changing meaning. */
export function validateStack(input) {
  if (!Array.isArray(input)) throw Error('Terrain stack must be an array');
  if (input.filter(code => code !== '#').length > MAX_STACK_ENTRIES) throw Error('Terrain stack exceeds eight visual entries');
  if (input.filter(code => code === '#').length > 1) throw Error('Terrain stack contains multiple Walls');
  for (const code of input) if (code !== '#' && !VISUALS.includes(code)) throw Error(`Unknown terrain material: ${code}`);
  const wall = wallIndex(input);
  const bands = [input.slice(0, wall < 0 ? input.length : wall), wall < 0 ? [] : input.slice(wall + 1)];
  for (const band of bands) if (new Set(band).size !== band.length) throw Error('Terrain band contains a duplicate material');
  return input;
}

function bandBounds(stack, target) {
  const wall = wallIndex(stack);
  if (target === 'upper') {
    if (wall < 0) throw Error('Elevated edits require Wall');
    return [wall + 1, stack.length];
  }
  return [0, wall < 0 ? stack.length : wall];
}

export const automaticBand = stack => wallIndex(stack) < 0 ? 'ground' : 'upper';

/** Return a canonical edited copy; the input stack is never mutated. */
export function addStackEntry(input, material, target = 'auto') {
  validateStack(input);
  const code = materialCode(material);
  if (code === '#') return input.includes('#') ? [...input] : validateStack([...input, '#']);
  if (!VISUALS.includes(code)) throw Error(`Unknown terrain material: ${material}`);
  const stack = [...input];
  const band = target === 'auto' ? automaticBand(stack) : target;
  let [start, end] = bandBounds(stack, band);
  const existing = stack.indexOf(code, start);
  if (existing >= 0 && existing < end) {
    stack.splice(existing, 1);
    [start, end] = bandBounds(stack, band);
  } else if (stack.filter(entry => entry !== '#').length === MAX_STACK_ENTRIES) throw Error('Terrain stack is full');
  stack.splice(end, 0, code);
  return validateStack(stack);
}

/** Wall removal demotes safely and retains the visually topmost duplicate. */
export function removeStackEntry(input, material, target = 'auto') {
  validateStack(input);
  const code = materialCode(material);
  if (code === '#') {
    if (!input.includes('#')) return [...input];
    const merged = input.filter(entry => entry !== '#');
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

/** Move one inspector row. Crossing Wall rejects duplicate target materials. */
export function moveStackEntry(input, index, direction) {
  validateStack(input);
  const target = index + direction;
  if (index < 0 || target < 0 || index >= input.length || target >= input.length) return [...input];
  const stack = [...input];
  [stack[index], stack[target]] = [stack[target], stack[index]];
  return validateStack(stack);
}

export function removeStackIndex(input, index) {
  if (input[index] === '#') return removeStackEntry(input, '#');
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
  const wall = wallIndex(stack);
  return {
    ground: stack.slice(0, wall < 0 ? stack.length : wall),
    upper: wall < 0 ? [] : stack.slice(wall + 1),
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

const RGB = [
  [23, 45, 63],
  [73, 157, 72],
  [133, 96, 64],
  [45, 139, 184],
  [211, 216, 194],
];
const NUMBER = { g: 1, d: 2, w: 3, f: 4, b: 5, s: 6 };

function setPixel(image, x, y, colour) {
  const index = (y * image.width + x) * 4;
  image.data[index] = colour[0];
  image.data[index + 1] = colour[1];
  image.data[index + 2] = colour[2];
  image.data[index + 3] = 255;
}

function fillRect(image, x, y, width, height, colour) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(image.width, x + width);
  const y1 = Math.min(image.height, y + height);
  for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) setPixel(image, px, py, colour);
}

function prepareLayers(level) {
  const count = level.tileStacks.length;
  const ground = new Uint8Array(count * MAX_STACK_ENTRIES);
  const upper = new Uint8Array(count * MAX_STACK_ENTRIES);
  const groundSupport = new Uint8Array(count);
  const upperSupport = new Uint8Array(count);
  const walls = new Uint8Array(count);
  level.tileStacks.forEach((stack, index) => {
    const bands = splitBands(stack);
    bands.ground.forEach((code, slot) => { ground[index * MAX_STACK_ENTRIES + slot] = NUMBER[code]; });
    bands.upper.forEach((code, slot) => { upper[index * MAX_STACK_ENTRIES + slot] = NUMBER[code]; });
    groundSupport[index] = hasSurface(bands.ground);
    upperSupport[index] = hasSurface(bands.upper);
    walls[index] = stack.includes('#');
  });
  return { ground, upper, groundSupport, upperSupport, walls };
}

function supportAt(level, support, x, y) {
  const index = tileIndex(level, x, y);
  return index < 0 ? 0 : support[index];
}

function drawFloorDetails(image, level, slots, slot, tileX, tileY) {
  const index = tileIndex(level, tileX, tileY);
  if (slots[index * MAX_STACK_ENTRIES + slot] !== 4) return;
  const x = tileX * AUTHOR_TILE;
  const y = tileY * AUTHOR_TILE;
  const colour = [170, 179, 167];
  fillRect(image, x + 3, y + 1, AUTHOR_TILE - 7, 1, colour);
  fillRect(image, x + 1, y + 3, 1, AUTHOR_TILE - 7, colour);
}

function drawDecoration(image, level, code, tileX, tileY, slot) {
  const x = tileX * AUTHOR_TILE;
  const y = tileY * AUTHOR_TILE;
  const variant = terrainHash(tileX, tileY, level.seed + slot * 43);
  if (code === 5) {
    const offset = variant % 5 - 2;
    fillRect(image, x + 5 + offset, y + 18, 22, 6, [35, 103, 50]);
    fillRect(image, x + 9 + offset, y + 13, 14, 12, [53, 137, 60]);
  } else if (code === 6) {
    const offset = variant % 7 - 3;
    fillRect(image, x + 10 + offset, y + 16, 13, 7, [126, 143, 137]);
    fillRect(image, x + 13 + offset, y + 13, 8, 4, [190, 199, 181]);
  }
}

function drawBand(image, level, slots, support, upper = false) {
  for (let slot = 0; slot < MAX_STACK_ENTRIES; slot++) {
    for (let tileY = 0; tileY < level.tileHeight; tileY++) for (let tileX = 0; tileX < level.tileWidth; tileX++) {
      const index = tileY * level.tileWidth + tileX;
      if (!support[index]) continue;
      const strict = upper && (!supportAt(level, support, tileX - 1, tileY)
        || !supportAt(level, support, tileX + 1, tileY)
        || !supportAt(level, support, tileX, tileY - 1)
        || !supportAt(level, support, tileX, tileY + 1));
      const x0 = tileX * AUTHOR_TILE;
      const y0 = tileY * AUTHOR_TILE;
      const ownCode = slots[index * MAX_STACK_ENTRIES + slot];
      const spread = ownCode === 4 ? 2 : ownCode === 3 ? 4 : 6;
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
        if (code > 0 && code < 5) setPixel(image, x, y, RGB[code]);
      }
      if (ownCode === 4) drawFloorDetails(image, level, slots, slot, tileX, tileY);
      else if (ownCode > 4) drawDecoration(image, level, ownCode, tileX, tileY, slot);
    }
  }
}

function drawWalls(image, level, walls) {
  const wallAt = (x, y) => {
    const index = tileIndex(level, x, y);
    return index < 0 ? 0 : walls[index];
  };
  // A stack tile anchors the top half of a two-tile-high wall. Every row emits
  // its own sprite in painter order; neighbours only join horizontal seams.
  for (let y = 0; y < level.tileHeight; y++) for (let x = 0; x < level.tileWidth; x++) {
    if (!wallAt(x, y)) continue;
    const worldX = x * AUTHOR_TILE;
    const worldY = y * AUTHOR_TILE;
    fillRect(image, worldX, worldY, AUTHOR_TILE, 32, [123, 146, 137]);
    fillRect(image, worldX, worldY + 32, AUTHOR_TILE, 31, [77, 102, 99]);
    fillRect(image, worldX, worldY, AUTHOR_TILE, 3, [231, 232, 203]);
    fillRect(image, worldX, worldY + 63, AUTHOR_TILE, 2, [46, 68, 70]);
    if (!wallAt(x - 1, y)) fillRect(image, worldX, worldY, 3, 63, [190, 201, 180]);
    if (!wallAt(x + 1, y)) fillRect(image, worldX + AUTHOR_TILE - 3, worldY, 3, 63, [190, 201, 180]);
  }
}

function drawUpperEdges(image, level, support) {
  for (let y = 0; y < level.tileHeight; y++) for (let x = 0; x < level.tileWidth; x++) {
    if (!supportAt(level, support, x, y)) continue;
    const worldX = x * AUTHOR_TILE;
    const worldY = y * AUTHOR_TILE;
    if (!supportAt(level, support, x, y - 1)) fillRect(image, worldX, worldY, AUTHOR_TILE, 2, [238, 240, 207]);
    if (!supportAt(level, support, x, y + 1)) {
      fillRect(image, worldX, worldY + AUTHOR_TILE - 3, AUTHOR_TILE, 3, [238, 240, 207]);
      fillRect(image, worldX, worldY + AUTHOR_TILE, AUTHOR_TILE, 3, [77, 101, 98]);
    }
    // Full-height returns join across tile corners, so identical upper/lower
    // materials can never visually bleed through a dashed structural edge.
    if (!supportAt(level, support, x - 1, y)) fillRect(image, worldX, worldY, 2, AUTHOR_TILE, [168, 187, 160]);
    if (!supportAt(level, support, x + 1, y)) fillRect(image, worldX + AUTHOR_TILE - 2, worldY, 2, AUTHOR_TILE, [168, 187, 160]);
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
  drawBand(image, level, layers.ground, layers.groundSupport);
  drawWalls(image, level, layers.walls);
  drawBand(image, level, layers.upper, layers.upperSupport, true);
  drawUpperEdges(image, level, layers.upperSupport);
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
