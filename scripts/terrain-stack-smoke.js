import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { minify } from 'terser';
import { strToU8, zipSync } from 'fflate';
import { build } from 'vite';

/**
 * Disposable contract and budget spike for the proposed tile-stack terrain.
 * Nothing in this file is imported by the game or production build.
 */
const TILE = 32;
const MAX_ENTRIES = 8;
const WALL = '#';
const MATERIALS = new Set(['g', 'd', 'w', 'f', 'b', 's']);
const SURFACES = new Set(['g', 'd', 'w', 'f']);
const COLOURS = {
  g: [74, 157, 72], d: [133, 96, 64], w: [45, 139, 184], f: [211, 216, 194],
};
const BACKDROP = [23, 45, 63];

const clone = stack => [...stack];
const wallIndex = stack => stack.indexOf(WALL);
const bandBounds = (stack, band) => {
  const wall = wallIndex(stack);
  if (band === 'upper') {
    if (wall < 0) throw Error('Elevated edits require Wall');
    return [wall + 1, stack.length];
  }
  return [0, wall < 0 ? stack.length : wall];
};
const automaticBand = stack => wallIndex(stack) < 0 ? 'ground' : 'upper';

/** Strict canonical validation: corrupt input is rejected, never guessed. */
function validateStack(stack) {
  if (!Array.isArray(stack)) throw Error('Stack must be an array');
  if (stack.filter(entry => entry !== WALL).length > MAX_ENTRIES) throw Error('Stack exceeds eight visual entries');
  if (stack.filter(entry => entry === WALL).length > 1) throw Error('Stack has multiple Walls');
  for (const entry of stack) if (entry !== WALL && !MATERIALS.has(entry)) throw Error(`Unknown material ${entry}`);
  const wall = wallIndex(stack);
  for (const [start, end] of [[0, wall < 0 ? stack.length : wall], [wall + 1, stack.length]]) {
    const seen = new Set();
    for (let i = Math.max(0, start); i < end; i++) {
      if (seen.has(stack[i])) throw Error('Duplicate material within one band');
      seen.add(stack[i]);
    }
  }
  return stack;
}

function addEntry(input, entry, target = 'auto') {
  validateStack(input);
  if (entry === WALL) {
    if (input.includes(WALL)) return clone(input);
    return validateStack([...input, WALL]);
  }
  if (!MATERIALS.has(entry)) throw Error(`Unknown material ${entry}`);
  const stack = clone(input);
  const band = target === 'auto' ? automaticBand(stack) : target;
  let [start, end] = bandBounds(stack, band);
  const found = stack.indexOf(entry, start);
  if (found >= 0 && found < end) {
    stack.splice(found, 1);
    [start, end] = bandBounds(stack, band);
  } else if (stack.filter(value => value !== WALL).length === MAX_ENTRIES) {
    throw Error('Stack is full');
  }
  stack.splice(end, 0, entry);
  return validateStack(stack);
}

function moveAcrossWall(input, index, targetBand) {
  validateStack(input);
  const stack = clone(input);
  const entry = stack[index];
  if (!MATERIALS.has(entry)) throw Error('Only visual entries move across Wall');
  const [start, end] = bandBounds(stack, targetBand);
  if (stack.indexOf(entry, start) >= 0 && stack.indexOf(entry, start) < end) throw Error('Target band already contains material');
  stack.splice(index, 1);
  const [, targetEnd] = bandBounds(stack, targetBand);
  stack.splice(targetEnd, 0, entry);
  return validateStack(stack);
}

function removeEntry(input, entry, target = 'auto') {
  validateStack(input);
  if (entry === WALL) {
    const wall = wallIndex(input);
    if (wall < 0) return clone(input);
    const merged = input.filter(value => value !== WALL);
    const seen = new Set();
    // Retain the visually topmost duplicate after concatenating both bands.
    return validateStack(merged.filter((value, index) => {
      if (merged.lastIndexOf(value) !== index || seen.has(value)) return false;
      seen.add(value);
      return true;
    }));
  }
  const band = target === 'auto' ? automaticBand(input) : target;
  const [start, end] = bandBounds(input, band);
  const index = input.indexOf(entry, start);
  if (index < 0 || index >= end) return clone(input);
  const stack = clone(input);
  stack.splice(index, 1);
  return validateStack(stack);
}

/** Preflight every target and commit none when any tile rejects the operation. */
function atomicEdit(stacks, indices, operation) {
  const replacements = indices.map(index => operation(stacks[index]));
  const result = stacks.map(clone);
  indices.forEach((index, offset) => { result[index] = replacements[offset]; });
  return result;
}

const keyOf = stack => validateStack(stack).join('');

/** Stable first-use palette compaction. */
function compactPalette(stacks) {
  const palette = [];
  const lookup = new Map();
  const ids = new Uint16Array(stacks.length);
  stacks.forEach((stack, index) => {
    const key = keyOf(stack);
    if (!lookup.has(key)) {
      lookup.set(key, palette.length);
      palette.push(key);
    }
    ids[index] = lookup.get(key);
  });
  return { palette, ids };
}

function writeVarint(bytes, value) {
  do {
    let byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
}

function readVarint(bytes, cursor) {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (cursor.index >= bytes.length || shift > 28) throw Error('Malformed varint');
    const byte = bytes[cursor.index++];
    value |= (byte & 127) << shift;
    if (!(byte & 128)) return value;
    shift += 7;
  }
}

const toBase64 = bytes => Buffer.from(bytes).toString('base64');
const fromBase64 = text => new Uint8Array(Buffer.from(text, 'base64'));

function encodeFixed(ids, paletteLength) {
  if (paletteLength > 65536) throw Error('Palette too large');
  if (paletteLength <= 256) return toBase64(Uint8Array.from(ids));
  const bytes = new Uint8Array(ids.length * 2);
  ids.forEach((value, index) => {
    bytes[index * 2] = value & 255;
    bytes[index * 2 + 1] = value >> 8;
  });
  return toBase64(bytes);
}

function decodeFixed(text, count, paletteLength) {
  const bytes = fromBase64(text);
  const width = paletteLength <= 256 ? 1 : 2;
  if (bytes.length !== count * width) throw Error('Wrong tile-index length');
  const ids = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    ids[i] = width === 1 ? bytes[i] : bytes[i * 2] | bytes[i * 2 + 1] << 8;
    if (ids[i] >= paletteLength) throw Error('Palette index out of range');
  }
  return ids;
}

function encodeNibbles(ids, paletteLength) {
  if (paletteLength > 16) throw Error('Nibble palette too large');
  const bytes = new Uint8Array(Math.ceil(ids.length / 2));
  ids.forEach((value, index) => { bytes[index >> 1] |= value << (index & 1) * 4; });
  return toBase64(bytes);
}

function decodeNibbles(text, count, paletteLength) {
  if (paletteLength > 16) throw Error('Nibble palette too large');
  const bytes = fromBase64(text);
  if (bytes.length !== Math.ceil(count / 2)) throw Error('Wrong tile-index length');
  const ids = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    ids[i] = bytes[i >> 1] >> (i & 1) * 4 & 15;
    if (ids[i] >= paletteLength) throw Error('Palette index out of range');
  }
  if (count & 1 && bytes.at(-1) >> 4) throw Error('Non-zero tile padding');
  return ids;
}

function encodeRle(ids) {
  const bytes = [];
  for (let start = 0; start < ids.length;) {
    let end = start + 1;
    while (end < ids.length && ids[end] === ids[start]) end++;
    writeVarint(bytes, end - start);
    writeVarint(bytes, ids[start]);
    start = end;
  }
  return toBase64(bytes);
}

function decodeRle(text, count, paletteLength) {
  const bytes = fromBase64(text);
  const cursor = { index: 0 };
  const ids = new Uint16Array(count);
  let output = 0;
  while (cursor.index < bytes.length) {
    const run = readVarint(bytes, cursor);
    const id = readVarint(bytes, cursor);
    if (!run || id >= paletteLength || output + run > count) throw Error('Malformed tile run');
    ids.fill(id, output, output + run);
    output += run;
  }
  if (output !== count) throw Error('Tile runs do not fill level');
  return ids;
}

function encodeCollision(mask) {
  const bytes = [];
  let cursor = 0;
  let previousEnd = 0;
  while (cursor < mask.length) {
    while (cursor < mask.length && !mask[cursor]) cursor++;
    if (cursor === mask.length) break;
    writeVarint(bytes, cursor - previousEnd);
    const start = cursor;
    while (cursor < mask.length && mask[cursor]) cursor++;
    writeVarint(bytes, cursor - start);
    previousEnd = cursor;
  }
  return toBase64(bytes);
}

function decodeCollision(text, count) {
  const bytes = fromBase64(text);
  const cursor = { index: 0 };
  const mask = new Uint8Array(count);
  let output = 0;
  while (cursor.index < bytes.length) {
    const gap = readVarint(bytes, cursor);
    const run = readVarint(bytes, cursor);
    output += gap;
    if (!run || output + run > count) throw Error('Malformed Collision run');
    mask.fill(1, output, output + run);
    output += run;
  }
  return mask;
}

function encodeLevel(level, strategy) {
  const { palette, ids } = compactPalette(level.stacks);
  const encoded = strategy === 'fixed' ? encodeFixed(ids, palette.length)
    : strategy === 'nibble' ? encodeNibbles(ids, palette.length) : encodeRle(ids);
  return {
    w: level.width,
    h: level.height,
    z: level.seed,
    p: palette,
    t: encoded,
    c: encodeCollision(level.collision),
    a: level.player,
    e: level.enemies,
  };
}

function decodeLevel(source, strategy) {
  if (!Number.isInteger(source.w) || !Number.isInteger(source.h) || source.w < 1 || source.h < 1) throw Error('Invalid level dimensions');
  if (!Array.isArray(source.p) || !source.p.length) throw Error('Invalid stack palette');
  const palette = source.p.map(key => validateStack([...key]));
  const count = source.w * source.h;
  const ids = strategy === 'fixed' ? decodeFixed(source.t, count, palette.length)
    : strategy === 'nibble' ? decodeNibbles(source.t, count, palette.length) : decodeRle(source.t, count, palette.length);
  const collision = decodeCollision(source.c, source.w * 4 * source.h * 4);
  return { width: source.w, height: source.h, seed: source.z, palette, ids, collision };
}

function encodeFixedSlots(level) {
  const bytes = new Uint8Array(level.stacks.length * 9);
  const code = { g: 1, d: 2, w: 3, f: 4, b: 5, s: 6, '#': 7 };
  level.stacks.forEach((stack, index) => stack.forEach((entry, slot) => { bytes[index * 9 + slot] = code[entry]; }));
  return {
    w: level.width, h: level.height, z: level.seed, t: toBase64(bytes),
    c: encodeCollision(level.collision), a: level.player, e: level.enemies,
  };
}

const hash = (x, y, salt = 0) => {
  let value = Math.imul(x ^ salt, 374761393) + Math.imul(y + salt, 668265263);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return (value ^ value >>> 16) >>> 0;
};

const splitBands = stack => {
  const wall = wallIndex(stack);
  return {
    ground: stack.slice(0, wall < 0 ? stack.length : wall),
    upper: wall < 0 ? [] : stack.slice(wall + 1),
  };
};
const supports = band => band.some(entry => SURFACES.has(entry));

function makeRaster(width, height) {
  const data = new Uint8Array(width * height * 3);
  const fill = colour => {
    for (let i = 0; i < data.length; i += 3) data.set(colour, i);
  };
  const pixel = (x, y, colour) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    data.set(colour, (y * width + x) * 3);
  };
  const rect = (x, y, w, h, colour) => {
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) pixel(px, py, colour);
  };
  return { width, height, data, fill, pixel, rect };
}

const tileStack = (level, tileX, tileY) => tileX < 0 || tileY < 0 || tileX >= level.width || tileY >= level.height
  ? [] : level.stacks[tileY * level.width + tileX];
const bandAt = (level, tileX, tileY, band) => splitBands(tileStack(level, tileX, tileY))[band];
const supportAt = (level, tileX, tileY, band) => supports(bandAt(level, tileX, tileY, band));

function walkableAt(level, tileX, tileY) {
  if (tileX < 0 || tileY < 0 || tileX >= level.width || tileY >= level.height) return false;
  const bands = splitBands(tileStack(level, tileX, tileY));
  const active = supports(bands.upper) ? bands.upper : bands.ground;
  const fineWidth = level.width * 4;
  const collision = level.collision[(tileY * 4 + 2) * fineWidth + tileX * 4 + 2];
  return supports(active) && !collision;
}

function wallSouthCells(level) {
  const cells = [];
  const wall = (x, y) => tileStack(level, x, y).includes(WALL);
  for (let y = 0; y < level.height; y++) for (let x = 0; x < level.width; x++) {
    if (wall(x, y) && !wall(x, y + 1)) cells.push(`${x},${y}`);
  }
  return cells;
}

function floodIndices(stacks, width, height, start) {
  const target = keyOf(stacks[start]);
  const found = [];
  const seen = new Uint8Array(stacks.length);
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const index = queue.shift();
    if (keyOf(stacks[index]) !== target) continue;
    found.push(index);
    const x = index % width;
    const y = Math.floor(index / width);
    for (const next of [x ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y ? index - width : -1, y + 1 < height ? index + width : -1]) {
      if (next >= 0 && !seen[next]) { seen[next] = 1; queue.push(next); }
    }
  }
  return found;
}

function displacedEntry(level, band, ordinal, x, y, strict = false) {
  const originalX = Math.floor(x / TILE);
  const originalY = Math.floor(y / TILE);
  if (!supportAt(level, originalX, originalY, band)) return null;
  let sampleX = x;
  let sampleY = y;
  if (!strict) {
    const blockX = Math.floor(x / 8);
    const blockY = Math.floor(y / 8);
    sampleX += (hash(blockX, blockY, level.seed + ordinal * 17) % 13) - 6;
    sampleY += (hash(blockX, blockY, level.seed + ordinal * 29) % 13) - 6;
  }
  return bandAt(level, Math.floor(sampleX / TILE), Math.floor(sampleY / TILE), band)[ordinal] || null;
}

function drawBand(raster, level, band) {
  for (let ordinal = 0; ordinal < MAX_ENTRIES; ordinal++) {
    for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
      const tileX = Math.floor(x / TILE);
      const tileY = Math.floor(y / TILE);
      const strict = band === 'upper' && (!supportAt(level, tileX - 1, tileY, band)
        || !supportAt(level, tileX + 1, tileY, band)
        || !supportAt(level, tileX, tileY - 1, band)
        || !supportAt(level, tileX, tileY + 1, band));
      const entry = displacedEntry(level, band, ordinal, x, y, strict);
      if (SURFACES.has(entry)) raster.pixel(x, y, COLOURS[entry]);
    }
    // Ordered props are geometry in their ordinal and may be covered later.
    for (let tileY = 0; tileY < level.height; tileY++) for (let tileX = 0; tileX < level.width; tileX++) {
      const entries = bandAt(level, tileX, tileY, band);
      if (!supports(entries)) continue;
      const entry = entries[ordinal];
      const x = tileX * TILE;
      const y = tileY * TILE;
      if (entry === 'b') {
        raster.rect(x + 7, y + 17, 18, 7, [39, 109, 53]);
        raster.rect(x + 11, y + 12, 10, 13, [55, 139, 61]);
      } else if (entry === 's') {
        raster.rect(x + 10, y + 15, 12, 7, [137, 151, 143]);
        raster.rect(x + 13, y + 12, 7, 4, [195, 202, 182]);
      }
    }
  }
}

function drawWalls(raster, level) {
  const hasWall = (x, y) => tileStack(level, x, y).includes(WALL);
  for (let y = 0; y < level.height; y++) for (let x = 0; x < level.width; x++) {
    if (!hasWall(x, y)) continue;
    const worldX = x * TILE;
    const baseline = (y + 2) * TILE;
    raster.rect(worldX, baseline - 64, TILE, 32, [123, 146, 137]);
    raster.rect(worldX, baseline - 32, TILE, 32, [77, 102, 99]);
    raster.rect(worldX, baseline - 64, TILE, 3, [231, 232, 203]);
    raster.rect(worldX, baseline - 1, TILE, 2, [46, 68, 70]);
  }
}

function drawUpperEdges(raster, level) {
  for (let y = 0; y < level.height; y++) for (let x = 0; x < level.width; x++) {
    if (!supportAt(level, x, y, 'upper')) continue;
    const worldX = x * TILE;
    const worldY = y * TILE;
    if (!supportAt(level, x, y - 1, 'upper')) raster.rect(worldX, worldY, TILE, 2, [238, 240, 207]);
    if (!supportAt(level, x, y + 1, 'upper')) {
      raster.rect(worldX, worldY + TILE - 3, TILE, 3, [238, 240, 207]);
      raster.rect(worldX, worldY + TILE, TILE, 3, [77, 101, 98]);
    }
    if (!supportAt(level, x - 1, y, 'upper')) raster.rect(worldX, worldY, 2, TILE, [168, 187, 160]);
    if (!supportAt(level, x + 1, y, 'upper')) raster.rect(worldX + TILE - 2, worldY, 2, TILE, [168, 187, 160]);
  }
}

function renderLevel(level) {
  const raster = makeRaster(level.width * TILE, level.height * TILE);
  raster.fill(BACKDROP);
  drawBand(raster, level, 'ground');
  drawWalls(raster, level);
  drawBand(raster, level, 'upper');
  drawUpperEdges(raster, level);
  return raster;
}

async function writePpm(path, raster) {
  const header = Buffer.from(`P6\n${raster.width} ${raster.height}\n255\n`);
  await writeFile(path, Buffer.concat([header, Buffer.from(raster.data)]));
}

function makeLevel(width, height, seed, initial = []) {
  return {
    width, height, seed,
    stacks: Array.from({ length: width * height }, () => clone(initial)),
    collision: new Uint8Array(width * 4 * height * 4),
    player: [TILE * 2, TILE * 2],
    enemies: [[TILE * 4, TILE * 4, 0]],
  };
}
const setStack = (level, x, y, stack) => { level.stacks[y * level.width + x] = validateStack(clone(stack)); };

function fixtureLevel() {
  const level = makeLevel(15, 10, 37);
  for (let y = 1; y < 9; y++) for (let x = 1; x < 14; x++) setStack(level, x, y, ['f']);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 13; x++) setStack(level, x, y, ['f', 'g']);
  for (let x = 3; x < 12; x++) setStack(level, x, 5, ['f', 'g', WALL, 'f']);
  setStack(level, 4, 4, ['f', 'g', WALL, 'f']);
  setStack(level, 5, 4, ['f', 'g', WALL, 'f', 'g']);
  setStack(level, 6, 4, ['f', 'g', WALL, 'f', 'g', 'w']);
  setStack(level, 7, 4, ['f', 'b', 'g', WALL, 'f', 's', 'g']);
  setStack(level, 8, 4, ['f', 'g', WALL, 'f', 'g', 'b']);
  setStack(level, 9, 4, ['f', 's', 'g', WALL, 'f', 'w']);
  setStack(level, 10, 4, ['f', 'g', WALL, 'f']);
  return level;
}

const pseudo = (x, y, seed) => hash(x, y, seed) / 4294967296;
function representativeLevels() {
  const repetitive = makeLevel(75, 50, 11, ['g']);
  for (let y = 8; y < 42; y++) for (let x = 10; x < 65; x++) {
    if (x > 28 && x < 48 && y > 17 && y < 32) setStack(repetitive, x, y, ['f', 'g']);
    if (y === 32 && x > 22 && x < 54) setStack(repetitive, x, y, ['f', 'g', WALL, 'f']);
  }
  const organic = makeLevel(75, 50, 23);
  for (let y = 0; y < 50; y++) for (let x = 0; x < 75; x++) {
    const dx = (x - 37) / 31;
    const dy = (y - 25) / 20;
    if (dx * dx + dy * dy > 1 + (pseudo(x >> 1, y >> 1, 3) - 0.5) * 0.2) continue;
    let stack = ['g'];
    if (Math.abs(y - 25 - Math.sin(x / 8) * 5) < 3) stack = ['g', 'd'];
    if (x > 25 && x < 50 && y > 16 && y < 34 && pseudo(x, y, 8) > 0.28) stack = ['f', 'g'];
    if (y === 33 && x > 24 && x < 51) stack = ['f', 'g', WALL, 'f', 'g'];
    if (pseudo(x, y, 12) > 0.96) stack = [...stack, pseudo(x, y, 13) > 0.5 ? 'b' : 's'];
    setStack(organic, x, y, stack);
  }
  const fragmented = makeLevel(75, 50, 41);
  const variants = [
    ['g'], ['f'], ['d'], ['w'], ['f', 'g'], ['g', 'd'], ['f', 'w'], ['g', 'b'], ['f', 's'],
    ['f', WALL, 'f'], ['g', WALL, 'f', 'g'], ['d', WALL, 'f', 'w'], ['f', 'g', 'w'],
    ['g', 's', 'd'], ['f', 'b', WALL, 'f', 'g', 'w'],
  ];
  for (let y = 0; y < 50; y++) for (let x = 0; x < 75; x++) {
    setStack(fragmented, x, y, variants[hash(x, y, 91) % variants.length]);
  }
  for (const level of [repetitive, organic, fragmented]) {
    const fineWidth = level.width * 4;
    const fineHeight = level.height * 4;
    for (let y = 0; y < fineHeight; y++) for (let x = 0; x < fineWidth; x++) {
      if (x < 4 || y < 4 || x >= fineWidth - 4 || y >= fineHeight - 4) level.collision[y * fineWidth + x] = 1;
    }
  }
  return { repetitive, organic, fragmented };
}

function assertContract() {
  let stack = [];
  stack = addEntry(stack, 'f');
  stack = addEntry(stack, 'g');
  stack = addEntry(stack, WALL);
  stack = addEntry(stack, 'f');
  stack = addEntry(stack, 'g');
  stack = addEntry(stack, 'w');
  assert.equal(keyOf(stack), 'fg#fgw');
  assert.equal(keyOf(addEntry(['#', 'f', 'g'], 'f')), '#gf');
  assert.equal(keyOf(addEntry(['f', WALL, 'g'], 'd', 'ground')), 'fd#g');
  assert.throws(() => moveAcrossWall(['g', WALL, 'g'], 2, 'ground'), /already contains/);
  assert.deepEqual(removeEntry(['g', WALL, 'f', 'g'], WALL), ['f', 'g']);
  assert.deepEqual(addEntry([], 'b'), ['b']);
  assert.equal(supports(['b']), false);
  assert.throws(() => addEntry(['g', 'd', 'w', 'f', 'b', 's', WALL, 'g', 'f'], 'd'), /full/);
  assert.throws(() => addEntry(['g'], 'f', 'upper'), /require Wall/);
  assert.throws(() => validateStack(['g', 'g']), /Duplicate/);
  assert.throws(() => validateStack(['#', '#']), /multiple/);
  assert.throws(() => validateStack(['?']), /Unknown/);

  const before = [['g'], ['g', 'd']];
  assert.throws(() => atomicEdit(before, [0, 1], stackValue => {
    if (stackValue.includes('d')) throw Error('deliberate rejection');
    return addEntry(stackValue, 'f');
  }));
  assert.deepEqual(before, [['g'], ['g', 'd']]);
  assert.deepEqual(floodIndices([['g'], ['g'], ['f'], ['g']], 2, 2, 0).sort(), [0, 1, 3]);

  const edited = [['g'], ['f', 'g'], ['g']];
  const original = JSON.stringify(compactPalette(edited).palette);
  const changed = edited.map(clone);
  changed[0] = addEntry(changed[0], 'w');
  changed[0] = clone(edited[0]);
  assert.equal(JSON.stringify(compactPalette(changed).palette), original);
}

function assertPersistence(levels) {
  for (const strategy of ['fixed', 'nibble', 'rle']) for (const level of Object.values(levels)) {
    const encoded = encodeLevel(level, strategy);
    const decoded = decodeLevel(encoded, strategy);
    assert.equal(decoded.ids.length, level.stacks.length);
    decoded.ids.forEach((id, index) => assert.equal(keyOf(decoded.palette[id]), keyOf(level.stacks[index])));
    assert.deepEqual(decoded.collision, level.collision);
    assert.throws(() => decodeLevel({ ...encoded, w: 0 }, strategy), /dimensions/);
    assert.throws(() => decodeLevel({ ...encoded, p: ['gg'] }, strategy), /Duplicate|range|length|run/);
  }
  const encoded = encodeLevel(levels.repetitive, 'rle');
  assert.throws(() => decodeLevel({ ...encoded, t: toBase64([0, 0]) }, 'rle'), /Malformed/);
  assert.throws(() => decodeLevel({ ...encoded, c: toBase64([0, 0]) }, 'rle'), /Collision/);
}

function assertRendering() {
  const movement = makeLevel(5, 1, 5);
  setStack(movement, 0, 0, ['w']);
  setStack(movement, 1, 0, ['b']);
  setStack(movement, 2, 0, ['f', WALL]);
  setStack(movement, 3, 0, ['f', WALL, 'w']);
  setStack(movement, 4, 0, ['f', 's']);
  assert.equal(walkableAt(movement, 0, 0), true, 'Visual Water should be walkable');
  assert.equal(walkableAt(movement, 1, 0), false, 'Decoration must not create support');
  assert.equal(walkableAt(movement, 2, 0), true, 'Wall must not imply Collision');
  assert.equal(walkableAt(movement, 3, 0), true, 'Elevated Water should be walkable');
  movement.collision[2 * movement.width * 4 + 2] = 1;
  assert.equal(walkableAt(movement, 0, 0), false, 'Collision must block Water');

  const topology = makeLevel(6, 3, 6);
  for (const [x, y] of [[0, 0], [0, 1], [1, 1], [3, 0], [4, 0], [4, 1]]) setStack(topology, x, y, ['f', WALL]);
  assert.deepEqual(wallSouthCells(topology), ['3,0', '0,1', '1,1', '4,1']);

  const level = makeLevel(4, 3, 7);
  setStack(level, 0, 1, ['f']);
  setStack(level, 1, 1, ['f', 'g']);
  setStack(level, 2, 1, ['f', 'g']);
  setStack(level, 3, 1, ['f']);
  const raster = renderLevel(level);
  let floor = 0;
  let grass = 0;
  let transparent = 0;
  for (let y = TILE; y < TILE * 2; y++) for (let x = TILE; x < TILE * 3; x++) {
    const index = (y * raster.width + x) * 3;
    const colour = raster.data.subarray(index, index + 3);
    if (colour.every((value, offset) => value === COLOURS.f[offset])) floor++;
    if (colour.every((value, offset) => value === COLOURS.g[offset])) grass++;
    if (colour.every(value => value === 0)) transparent++;
  }
  assert.ok(floor > 0, 'Rough Grass edge did not reveal Floor');
  assert.ok(grass > 0, 'Grass overlay disappeared');
  assert.equal(transparent, 0, 'Renderer left transparent/uninitialised gaps');
  assert.deepEqual(renderLevel(level).data, raster.data, 'Renderer was not deterministic');

  const propsBelow = makeLevel(1, 1, 9);
  setStack(propsBelow, 0, 0, ['f', 'b', 'g']);
  const propsAbove = makeLevel(1, 1, 9);
  setStack(propsAbove, 0, 0, ['f', 'g', 'b']);
  const unsupported = makeLevel(1, 1, 9);
  setStack(unsupported, 0, 0, ['b']);
  const bush = [39, 109, 53];
  const countColour = (image, expected) => {
    let count = 0;
    for (let i = 0; i < image.data.length; i += 3) {
      if (expected.every((value, offset) => image.data[i + offset] === value)) count++;
    }
    return count;
  };
  assert.equal(countColour(renderLevel(propsBelow), bush), 0, 'Later surface did not cover earlier Bushes');
  assert.ok(countColour(renderLevel(propsAbove), bush) > 0, 'Top Bushes did not remain visible');
  assert.equal(countColour(renderLevel(unsupported), bush), 0, 'Unsupported decoration rendered without a surface');

  const strictUpper = makeLevel(1, 1, 12);
  setStack(strictUpper, 0, 0, ['f', WALL, 'd']);
  const upperImage = renderLevel(strictUpper);
  for (let y = 3; y < TILE - 3; y++) for (let x = 2; x < TILE - 2; x++) {
    const index = (y * upperImage.width + x) * 3;
    assert.deepEqual([...upperImage.data.subarray(index, index + 3)], COLOURS.d, 'Raised perimeter noise cut into strict support');
  }
}

/** Candidate runtime text stays reachable so minification retains all maps and renderer work. */
function budgetSource(encodedLevels, strategy, slots = false) {
  const decode = slots
    ? "if(b.length!=n*9)throw Error('length');return b"
    : strategy === 'fixed'
      ? "if(b.length!=n)throw Error('length');for(;j<n;j++){o[j]=b[j];if(o[j]>=p)throw Error('index')}return o"
      : strategy === 'nibble'
        ? "if(b.length!=Math.ceil(n/2))throw Error('length');for(;j<n;j++){o[j]=b[j>>1]>>(j&1)*4&15;if(o[j]>=p)throw Error('index')}return o"
        : "while(i<b.length){let r=q(),v=q();if(!r||v>=p||j+r>n)throw Error('run');o.fill(v,j,j+=r)}if(j!=n)throw Error('length');return o";
  const stack = slots
    ? "let s='',C=' gdwfbs#';for(let q=0;q<9&&t[i*9+q];q++)s+=C[t[i*9+q]];return V(s)"
    : 'return V(p[t[i]])';
  return `const L=${JSON.stringify(encodedLevels)},A=atob,M={g:'#4a9d48',d:'#856040',w:'#2d8bb8',f:'#d3d8c2'},U='gdwf',T=32;function V(s){let w=0,m=0,d=[new Set];for(const c of s){if(c=='#'){if(w++)throw Error('wall');d.push(new Set)}else{if(!'gdwfbs'.includes(c)||d.at(-1).has(c)||++m>8)throw Error('stack');d.at(-1).add(c)}}return s}function D(x,n,p){let b=Uint8Array.from(A(x),c=>c.charCodeAt()),o=new Uint16Array(n),i=0,j=0,q=()=>{let v=0,s=0,c;do{if(i>=b.length)throw Error('data');c=b[i++];v|=(c&127)<<s;s+=7}while(c&128);return v};${decode}}function H(x,y,z){let v=Math.imul(x^z,374761393)+Math.imul(y+z,668265263);v=Math.imul(v^v>>>13,1274126177);return(v^v>>>16)>>>0}function R(l,c=document.createElement('canvas')){let n=l.w*l.h,p=l.p||[],t=D(l.t,n,p.length),K=i=>{if(i<0||i>=n)return'';${stack}},B=(i,u)=>{let s=K(i),w=s.indexOf('#');return u&&w<0?[]:[...s.slice(u?w+1:0,u?s.length:w<0?s.length:w)]},O=(x,y,u)=>{if(x<0||y<0||x>=l.w||y>=l.h)return[];return B(y*l.w+x,u)},P=a=>a.some(x=>U.includes(x)),x,y,q,a,e,i,k,z=c.getContext('2d');c.width=l.w*T;c.height=l.h*T;z.fillStyle='#172d3f';z.fillRect(0,0,c.width,c.height);function G(u){for(q=0;q<8;q++){for(y=0;y<c.height;y++)for(x=0;x<c.width;x++){let X=x/T|0,Y=y/T|0,b=O(X,Y,u);if(!P(b))continue;let strict=u&&(!P(O(X-1,Y,u))||!P(O(X+1,Y,u))||!P(O(X,Y-1,u))||!P(O(X,Y+1,u))),dx=strict?0:H(x>>3,y>>3,l.z+17*q)%13-6,dy=strict?0:H(x>>3,y>>3,l.z+29*q)%13-6,m=O((x+dx)/T|0,(y+dy)/T|0,u)[q];if(U.includes(m)){z.fillStyle=M[m];z.fillRect(x,y,1,1)}}for(i=0;i<n;i++){a=B(i,u);if(!P(a))continue;e=a[q];x=i%l.w*T;y=(i/l.w|0)*T;if(e=='b'){z.fillStyle='#276d35';z.fillRect(x+7,y+15,18,9)}else if(e=='s'){z.fillStyle='#89978f';z.fillRect(x+10,y+13,12,8)}}}}G(0);for(i=0;i<n;i++)if(K(i).includes('#')&&!K(i+l.w).includes('#')){x=i%l.w*T;y=((i/l.w|0)+1)*T;z.fillStyle='#7b9289';z.fillRect(x,y-64,T,32);z.fillStyle='#4d6663';z.fillRect(x,y-32,T,32);z.fillStyle='#e7e8cb';z.fillRect(x,y-64,T,3)}G(1);for(i=0;i<n;i++){x=i%l.w;y=i/l.w|0;if(!P(O(x,y,1)))continue;if(!P(O(x,y+1,1))){z.fillStyle='#eef0cf';z.fillRect(x*T,y*T+T-3,T,3);z.fillStyle='#4d6562';z.fillRect(x*T,y*T+T,T,3)}}return c}globalThis.__STACK_BUDGET__=[L,R,L.map(l=>[l.w,l.h,l.z])];`;
}

const zipBytes = (name, text) => zipSync({ [name]: strToU8(text) }, { level: 9 }).length;

function shadowTerrainSource(encodedLevels) {
  return `${budgetSource(encodedLevels, 'nibble')}function C(x,n){let b=Uint8Array.from(atob(x),c=>c.charCodeAt()),m=new Uint8Array(n),i=0,o=0,q=()=>{let v=0,s=0,c;do{if(i>=b.length)throw Error('collision');c=b[i++];v|=(c&127)<<s;s+=7}while(c&128);return v};while(i<b.length){o+=q();let r=q();if(!r||o+r>n)throw Error('collision');m.fill(1,o,o+=r)}return m}export function unpackLevel(){let s=L[0],p=s.p.map(V),t=D(s.t,s.w*s.h,p.length);return{width:s.w*T,height:s.h*T,cell:8,seed:s.z,player:s.a,enemies:s.e,_source:s,_palette:p,_tiles:t,_collision:C(s.c,s.w*4*s.h*4),_tileWidth:s.w}}export{H as terrainHash};function W(l,x,y,r=0){let ok=(X,Y)=>{if(X<0||Y<0||X>=l.width||Y>=l.height)return false;let tx=X/T|0,ty=Y/T|0,s=l._palette[l._tiles[ty*l._tileWidth+tx]],w=s.indexOf('#'),g=s.slice(0,w<0?s.length:w),u=w<0?'':s.slice(w+1),a=[...u].some(c=>U.includes(c))?u:g;if(![...a].some(c=>U.includes(c)))return false;let cx=X/8|0,cy=Y/8|0;return!l._collision[cy*l._tileWidth*4+cx]};if(!ok(x,y))return false;for(let i=0;i<8&&r;i++){let a=i*Math.PI/4;if(!ok(x+Math.cos(a)*r,y+Math.sin(a)*r))return false}return true}export function moveOnTerrain(l,b,dx,dy,r){let n=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/4)),x=dx/n,y=dy/n,k=0;for(let i=0;i<n;i++){if(W(l,b.x+x,b.y,r))b.x+=x;else k|=1;if(W(l,b.x,b.y+y,r))b.y+=y;else k|=2}return k}export function buildTerrain(l){return{canvas:R(l._source),scale:1}}export function drawTerrain(x,t,b){let c=t.canvas,s=Math.max(0,b.left|0),y=Math.max(0,b.top|0),r=Math.min(c.width,Math.ceil(b.right)),o=Math.min(c.height,Math.ceil(b.bottom));x.imageSmoothingEnabled=false;x.drawImage(c,s,y,r-s,o-y,s,y,r-s,o-y)}`;
}

function inlineShadowBuild() {
  return {
    name: 'inline-shadow-build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(file => file.fileName.endsWith('.html'));
      if (!html) throw Error('Shadow build emitted no HTML');
      let source = html.source;
      for (const file of Object.values(bundle)) {
        if (file === html) continue;
        const escaped = file.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const body = file.type === 'chunk' ? file.code : file.source;
        const pattern = file.fileName.endsWith('.js')
          ? new RegExp(`<script[^>]*src="[^"]*${escaped}"[^>]*></script>`)
          : new RegExp(`<link[^>]*href="[^"]*${escaped}"[^>]*>`);
        const replacement = file.fileName.endsWith('.js')
          ? `<script type=module>${body}</script>` : `<style>${body}</style>`;
        const inlined = source.replace(pattern, () => replacement);
        if (inlined === source) throw Error(`Could not inline ${file.fileName}`);
        source = inlined;
        delete bundle[file.fileName];
      }
      html.source = source;
    },
  };
}

async function buildShadowGame(encodedLevels) {
  const temporaryRoot = '/tmp/js13k-stack-shadow';
  await rm(temporaryRoot, { recursive: true, force: true });
  await mkdir(`${temporaryRoot}/src/levels`, { recursive: true });
  // macOS aliases /tmp to /private/tmp; Vite requires the canonical root so
  // its HTML entry never becomes an invalid relative emitted filename.
  const root = await realpath(temporaryRoot);
  await Promise.all([
    cp('index.html', `${root}/index.html`),
    cp('src/game.js', `${root}/src/game.js`),
    cp('src/style.css', `${root}/src/style.css`),
    writeFile(`${root}/src/levels/level1.json`, '{}\n'),
    writeFile(`${root}/src/terrain.js`, shadowTerrainSource(encodedLevels)),
  ]);
  await build({
    root,
    configFile: false,
    base: './',
    publicDir: false,
    logLevel: 'error',
    plugins: [inlineShadowBuild(), {
      name: 'assert-shadow-root',
      configResolved(config) {
        if (config.root !== root || config.build.rollupOptions.input != null) throw Error('Unexpected shadow build root/input');
      },
    }],
    build: {
      target: 'esnext',
      modulePreload: { polyfill: false },
      cssCodeSplit: false,
      assetsInlineLimit: Infinity,
      reportCompressedSize: false,
      outDir: `${root}/dist`,
      emptyOutDir: true,
      minify: 'terser',
      terserOptions: {
        compress: { passes: 3, drop_console: true },
        mangle: { toplevel: true },
        format: { comments: false },
      },
    },
  });
  const html = await readFile(`${root}/dist/index.html`, 'utf8');
  if (!html.includes('__STACK_BUDGET__')) throw Error('Shadow build dropped representative maps');
  const archive = zipSync({ 'index.html': strToU8(html) }, { level: 9 });
  await writeFile('/tmp/terrain-stack-shadow-game.zip', archive);
  return { html: html.length, zip: archive.length };
}

async function measureBudgets(levels) {
  const strategies = ['fixed', 'nibble', 'rle', 'slots'];
  const results = {};
  const baselineHtml = await readFile('dist/index.html', 'utf8').catch(() => '');
  for (const strategy of strategies) {
    const encoded = Object.values(levels).map(level => strategy === 'slots' ? encodeFixedSlots(level) : encodeLevel(level, strategy));
    const source = budgetSource(encoded, strategy, strategy === 'slots');
    const minified = await minify(source, { compress: true, mangle: true });
    if (!minified.code.includes('__STACK_BUDGET__')) throw Error('Budget payload was tree-shaken');
    const html = `<canvas></canvas><script>${minified.code}</script>`;
    const standalone = zipBytes('index.html', html);
    const appended = baselineHtml ? zipBytes('index.html', baselineHtml.replace('</body>', `<script>${minified.code}</script></body>`)) : 0;
    results[strategy] = {
      maps: encoded.map(level => Buffer.byteLength(JSON.stringify(level))),
      minified: minified.code.length,
      standaloneZip: standalone,
      appendedToCurrentZip: appended,
      sentinel: encoded.map(level => hash(level.w, level.h, level.z)),
    };
    await writeFile(`/tmp/terrain-stack-budget-${strategy}.html`, html);
  }
  const nibbleLevels = Object.values(levels).map(level => encodeLevel(level, 'nibble'));
  results.integratedShadow = await buildShadowGame(nibbleLevels);
  await writeFile('/tmp/terrain-stack-budget.json', `${JSON.stringify(results, null, 2)}\n`);
  return results;
}

assertContract();
const representatives = representativeLevels();
assertPersistence(representatives);
assertRendering();
const fixture = fixtureLevel();
const fixtureRaster = renderLevel(fixture);
await writePpm('/tmp/terrain-stack-fixture.ppm', fixtureRaster);
const budgets = await measureBudgets(representatives);

console.log('tile-stack prototype checks passed');
for (const [strategy, result] of Object.entries(budgets)) {
  if (result.maps) console.log(`${strategy}: map JSON ${result.maps.join('/')} bytes; minified ${result.minified}; standalone ZIP ${result.standaloneZip}; appended current ZIP ${result.appendedToCurrentZip}`);
}
console.log(`integrated shadow game: HTML ${budgets.integratedShadow.html}; ZIP ${budgets.integratedShadow.zip}`);
console.log('fixture: /tmp/terrain-stack-fixture.ppm');
console.log('budget details: /tmp/terrain-stack-budget.json');
