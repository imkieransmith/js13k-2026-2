// Shared terrain vocabulary for the game and the development-only editor.
// Authored masks say where a material belongs; these deterministic recipes add
// the variation. Cosmetic noise never participates in collision.
export const MASK_CELL = 8;
export const AUTHOR_TILE = 32;
export const NOISE_LEVELS = 5;
export const TERRAIN_KINDS = ['grass', 'dirt', 'water', 'stones', 'ruins', 'bushes', 'collision'];
const CACHE_SCALE = 1;

/** Stable integer hash. Coordinates and salts always produce the same detail. */
export function terrainHash(x, y, salt = 0) {
  let value = Math.imul(x ^ salt, 374761393) + Math.imul(y + salt, 668265263);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return (value ^ value >>> 16) >>> 0;
}

const random = (x, y, salt) => terrainHash(x, y, salt) / 4294967296;

// Masks are stored as varint [gap, run length] pairs. Painted maps contain
// long horizontal runs, so this is substantially smaller than six raw bitplanes.
function decodeMask(encoded, bytes) {
  const mask = new Uint8Array(bytes);
  const binary = atob(encoded || '');
  let offset = 0;
  let cursor = 0;
  const read = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = binary.charCodeAt(cursor++);
      value |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  while (cursor < binary.length) {
    offset += read();
    const end = offset + read();
    while (offset < end) setBit(mask, offset++, 1);
  }
  return mask;
}

function encodeMask(mask, bits) {
  const bytes = [];
  let cursor = 0;
  let previousEnd = 0;
  const write = value => {
    do {
      let byte = value & 127;
      value >>>= 7;
      if (value) byte |= 128;
      bytes.push(byte);
    } while (value);
  };
  while (cursor < bits) {
    while (cursor < bits && !bitAt(mask, cursor)) cursor++;
    if (cursor === bits) break;
    write(cursor - previousEnd);
    const start = cursor;
    while (cursor < bits && bitAt(mask, cursor)) cursor++;
    write(cursor - start);
    previousEnd = cursor;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.slice(i, i + 8192));
  }
  return btoa(binary);
}

/** Convert compact JSON data into mutable masks used by rendering and collision. */
export function unpackLevel(source) {
  const cell = source.cell || MASK_CELL;
  const gridWidth = Math.ceil(source.width / cell);
  const gridHeight = Math.ceil(source.height / cell);
  const bytes = Math.ceil(gridWidth * gridHeight / 8);
  const masks = {};
  for (const kind of TERRAIN_KINDS) masks[kind] = decodeMask(source.masks?.[kind], bytes);
  const noiseWidth = Math.ceil(source.width / AUTHOR_TILE);
  const noiseHeight = Math.ceil(source.height / AUTHOR_TILE);
  const noiseBits = noiseWidth * noiseHeight;
  const noiseBytes = Math.ceil(noiseBits / 8);
  const noise = new Uint8Array(noiseBits);
  if (source.noise) {
    const planes = [0, 1, 2].map(index => decodeMask(source.noise[index], noiseBytes));
    for (let i = 0; i < noiseBits; i++) {
      noise[i] = bitAt(planes[0], i) | bitAt(planes[1], i) << 1 | bitAt(planes[2], i) << 2;
      // Migrate the previous four-level High/Extreme values around new Medium.
      if (source.noise.length < 3 && noise[i] > 1) noise[i]++;
    }
  } else noise.fill(1);
  return {
    width: source.width,
    height: source.height,
    cell,
    seed: source.seed || 1,
    player: source.player,
    enemies: source.enemies,
    gridWidth,
    gridHeight,
    noiseWidth,
    noiseHeight,
    noise,
    variableNoise: noise.some(value => value !== 1),
    masks,
  };
}

/** Produce the small persistence/build representation used by level JSON. */
export function packLevel(level) {
  const masks = {};
  const bits = level.gridWidth * level.gridHeight;
  for (const kind of TERRAIN_KINDS) masks[kind] = encodeMask(level.masks[kind], bits);
  const noiseBits = level.noiseWidth * level.noiseHeight;
  const planes = Array.from({ length: 3 }, () => new Uint8Array(Math.ceil(noiseBits / 8)));
  for (let i = 0; i < noiseBits; i++) for (let bit = 0; bit < 3; bit++) {
    setBit(planes[bit], i, level.noise[i] >> bit & 1);
  }
  return {
    width: level.width,
    height: level.height,
    cell: level.cell,
    seed: level.seed,
    player: level.player,
    enemies: level.enemies,
    noise: planes.map(plane => encodeMask(plane, noiseBits)),
    masks,
  };
}

function cellIndex(level, x, y) {
  if (x < 0 || y < 0 || x >= level.gridWidth || y >= level.gridHeight) return -1;
  return y * level.gridWidth + x;
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

export function maskAt(level, kind, worldX, worldY) {
  const x = Math.floor(worldX / level.cell);
  const y = Math.floor(worldY / level.cell);
  return bitAt(level.masks[kind], cellIndex(level, x, y));
}

/** Rasterise a continuous circular brush into the hidden fine mask. */
export function paintCircle(level, kind, worldX, worldY, radius, value = 1) {
  const cell = level.cell;
  const x0 = Math.max(0, Math.floor((worldX - radius) / cell));
  const y0 = Math.max(0, Math.floor((worldY - radius) / cell));
  const x1 = Math.min(level.gridWidth - 1, Math.floor((worldX + radius) / cell));
  const y1 = Math.min(level.gridHeight - 1, Math.floor((worldY + radius) / cell));
  const mask = level.masks[kind];
  let changed = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5) * cell - worldX;
      const dy = (y + 0.5) * cell - worldY;
      if (dx * dx + dy * dy > radius * radius) continue;
      const index = y * level.gridWidth + x;
      if (bitAt(mask, index) === value) continue;
      setBit(mask, index, value);
      changed = true;
    }
  }
  return changed;
}

function gridBlock(level, gridX, gridY, size) {
  const span = size / level.cell;
  return { x: gridX * span, y: gridY * span, span };
}

/** Query the four-level cosmetic boundary strength of one authoring tile. */
export function noiseAt(level, gridX, gridY) {
  if (gridX < 0 || gridY < 0 || gridX >= level.noiseWidth || gridY >= level.noiseHeight) return 0;
  return level.noise[gridY * level.noiseWidth + gridX];
}

/** Paint cosmetic noise without touching any material or collision mask. */
export function paintNoiseCell(level, gridX, gridY, value) {
  if (gridX < 0 || gridY < 0 || gridX >= level.noiseWidth || gridY >= level.noiseHeight) return false;
  const index = gridY * level.noiseWidth + gridX;
  value = Math.max(0, Math.min(NOISE_LEVELS - 1, value | 0));
  if (level.noise[index] === value) return false;
  level.noise[index] = value;
  level.variableNoise = true;
  return true;
}

/** Majority occupancy lets old freehand masks migrate predictably to tiles. */
export function gridAt(level, kind, gridX, gridY, size = AUTHOR_TILE) {
  const block = gridBlock(level, gridX, gridY, size);
  if (block.x < 0 || block.y < 0 || block.x >= level.gridWidth || block.y >= level.gridHeight) return 0;
  let count = 0;
  let total = 0;
  for (let y = block.y; y < Math.min(level.gridHeight, block.y + block.span); y++) {
    for (let x = block.x; x < Math.min(level.gridWidth, block.x + block.span); x++) {
      count += bitAt(level.masks[kind], cellIndex(level, x, y));
      total++;
    }
  }
  return count * 2 >= total ? 1 : 0;
}

/** Set one whole authoring cell while preserving every other layer. */
export function paintGridCell(level, kind, gridX, gridY, value = 1, size = AUTHOR_TILE) {
  const block = gridBlock(level, gridX, gridY, size);
  if (block.x < 0 || block.y < 0 || block.x >= level.gridWidth || block.y >= level.gridHeight) return false;
  let changed = false;
  for (let y = block.y; y < Math.min(level.gridHeight, block.y + block.span); y++) {
    for (let x = block.x; x < Math.min(level.gridWidth, block.x + block.span); x++) {
      const index = cellIndex(level, x, y);
      if (bitAt(level.masks[kind], index) === value) continue;
      setBit(level.masks[kind], index, value);
      changed = true;
    }
  }
  return changed;
}

export function paintGridRect(level, kind, x0, y0, x1, y1, value = 1, size = AUTHOR_TILE) {
  let changed = false;
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      changed = paintGridCell(level, kind, x, y, value, size) || changed;
    }
  }
  return changed;
}

export function paintNoiseRect(level, x0, y0, x1, y1, value) {
  let changed = false;
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      changed = paintNoiseCell(level, x, y, value) || changed;
    }
  }
  return changed;
}

/** One-time/editor migration of legacy partial material cells. */
export function normaliseGrid(level, kinds = TERRAIN_KINDS.slice(0, -1), size = AUTHOR_TILE) {
  const width = Math.ceil(level.width / size);
  const height = Math.ceil(level.height / size);
  for (const kind of kinds) {
    const values = Array.from({ length: width * height }, (_, index) =>
      gridAt(level, kind, index % width, index / width | 0, size));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      paintGridCell(level, kind, x, y, values[y * width + x], size);
    }
  }
  return level;
}

function pointWalkable(level, x, y) {
  if (x < 0 || y < 0 || x >= level.width || y >= level.height) return false;
  const land = maskAt(level, 'grass', x, y)
    || maskAt(level, 'dirt', x, y)
    || maskAt(level, 'ruins', x, y);
  return !!land && !maskAt(level, 'water', x, y) && !maskAt(level, 'collision', x, y);
}

/** Radius-aware authoritative collision; rendered shoreline noise is cosmetic. */
export function isWalkable(level, x, y, radius = 0) {
  if (!pointWalkable(level, x, y)) return false;
  if (!radius) return true;
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4;
    if (!pointWalkable(level, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)) return false;
  }
  return true;
}

/** Axis-separated, substepped movement shared by player and Constructs. */
export function moveOnTerrain(level, body, dx, dy, radius) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (level.cell / 2)));
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

function coverage(level, mask, worldX, worldY) {
  const gx = worldX / level.cell - 0.5;
  const gy = worldY / level.cell - 0.5;
  const x = Math.floor(gx);
  const y = Math.floor(gy);
  const tx = gx - x;
  const ty = gy - y;
  const a = bitAt(mask, cellIndex(level, x, y));
  const b = bitAt(mask, cellIndex(level, x + 1, y));
  const c = bitAt(mask, cellIndex(level, x, y + 1));
  const d = bitAt(mask, cellIndex(level, x + 1, y + 1));
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function fieldNoise(x, y, salt) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = random(ix, iy, salt) * (1 - fx) + random(ix + 1, iy, salt) * fx;
  const b = random(ix, iy + 1, salt) * (1 - fx) + random(ix + 1, iy + 1, salt) * fx;
  return a * (1 - fy) + b * fy;
}

// Crisp material blocks at the same world-pixel resolution as moving actors:
// water, shore light, cliff depth, grass, dirt, and stone floor.
const PALETTE = [
  [38, 88, 126], [219, 231, 199], [62, 78, 83], [78, 157, 66],
  [128, 91, 60], [207, 211, 188],
];

const NOISE_REACH = [0, 4, 7, 12, 20];

function effectiveNoise(level, worldX, worldY) {
  if (!level.variableNoise) return 1;
  const x = Math.floor(worldX / AUTHOR_TILE);
  const y = Math.floor(worldY / AUTHOR_TILE);
  const localX = worldX - x * AUTHOR_TILE;
  const localY = worldY - y * AUTHOR_TILE;
  let strength = noiseAt(level, x, y);
  let neighbour = noiseAt(level, x - 1, y);
  if (localX < NOISE_REACH[neighbour]) strength = Math.max(strength, neighbour);
  neighbour = noiseAt(level, x + 1, y);
  if (AUTHOR_TILE - localX < NOISE_REACH[neighbour]) strength = Math.max(strength, neighbour);
  neighbour = noiseAt(level, x, y - 1);
  if (localY < NOISE_REACH[neighbour]) strength = Math.max(strength, neighbour);
  neighbour = noiseAt(level, x, y + 1);
  if (AUTHOR_TILE - localY < NOISE_REACH[neighbour]) strength = Math.max(strength, neighbour);
  return strength;
}

const samplePoint = { x: 0, y: 0, strength: 1 };

/** One displaced coordinate pair is shared by every material so edges still meet. */
function terrainSample(level, worldX, worldY) {
  const strength = effectiveNoise(level, worldX, worldY);
  const amount = [0, 0, 7, 14, 24][strength];
  samplePoint.x = worldX;
  samplePoint.y = worldY;
  samplePoint.strength = strength;
  if (amount) {
    samplePoint.x += Math.round((fieldNoise(worldX / 11, worldY / 11, level.seed + 331) - 0.5) * amount * 2);
    samplePoint.y += Math.round((fieldNoise(worldX / 11, worldY / 11, level.seed + 337) - 0.5) * amount * 2);
  }
  return samplePoint;
}

function organicCoverage(level, mask, sample, salt) {
  const value = coverage(level, mask, sample.x, sample.y);
  if (!sample.strength) return value;
  // Low retains the accepted narrow edge. High levels first displace the shared
  // sample above, then make the remaining transition progressively rougher.
  const erosion = [0, 0.42, 0.46, 0.5, 0.55][sample.strength];
  return value > 0.02 && value < 0.98
    ? value + (fieldNoise(sample.x / 5, sample.y / 5, level.seed + salt) - 0.5) * erosion
    : value;
}

function surfaceFromSample(level, sample) {
  const land = Math.max(
    organicCoverage(level, level.masks.grass, sample, 7),
    organicCoverage(level, level.masks.dirt, sample, 11),
    organicCoverage(level, level.masks.ruins, sample, 13),
  );
  const pool = organicCoverage(level, level.masks.water, sample, 17);
  return Math.min(land, 1 - pool);
}

function surfaceField(level, worldX, worldY) {
  return surfaceFromSample(level, terrainSample(level, worldX, worldY));
}

/** Material index at a world point after cosmetic coverage/noise. */
function materialAt(level, worldX, worldY) {
  const sample = terrainSample(level, worldX, worldY);
  const surface = surfaceFromSample(level, sample);
  if (surface > 0.56) {
    if (organicCoverage(level, level.masks.ruins, sample, 43) > 0.5) return 5;
    if (organicCoverage(level, level.masks.dirt, sample, 29) > 0.5) return 4;
    return 3;
  }
  if (surface > 0.34) return 1;
  // Only lower/southern edges receive a deep shelf in the 3/4 projection.
  if (surfaceField(level, worldX, worldY - 10) > 0.5) return 2;
  return 0;
}

/** Shared tuple-driven detail scatter: [count, keep, width, height, colourA, colourB, shadow]. */
function scatter(context, level, kind, recipe) {
  const [count, keep, width, height, colourA, colourB, shadow] = recipe;
  const mask = level.masks[kind];
  for (let y = 0; y < level.gridHeight; y++) {
    for (let x = 0; x < level.gridWidth; x++) {
      if (!bitAt(mask, y * level.gridWidth + x)) continue;
      for (let i = 0; i < count; i++) {
        // A low-frequency field still clusters debris, but the non-zero floor
        // ensures a painted stone tile reliably produces visible fragments.
        const density = 0.35
          + fieldNoise(x / 10, y / 10, level.seed + kind.length * 31) * 0.65;
        if (random(x, y, level.seed + i * 19 + kind.length) > keep * density) continue;
        const worldX = Math.round(x * level.cell + random(x, y, level.seed + i * 31) * level.cell);
        const worldY = Math.round(y * level.cell + random(x, y, level.seed + i * 47) * level.cell);
        const dirt = maskAt(level, 'dirt', worldX, worldY);
        if (maskAt(level, 'water', worldX, worldY)
          || !(maskAt(level, 'grass', worldX, worldY) || dirt || maskAt(level, 'ruins', worldX, worldY))
          || kind === 'grass' && dirt && random(x, y, i + 59) > 0.14) continue;
        const w = Math.max(2, Math.round(width * (0.7 + random(x, y, i + 71) * 0.6)));
        const h = Math.max(2, Math.round(height * (0.7 + random(x, y, i + 89) * 0.6)));
        if (shadow) {
          context.fillStyle = shadow;
          context.fillRect(worldX + 1, worldY + 2, w, h);
        }
        context.fillStyle = random(x, y, i + 103) < 0.5 ? colourA : colourB;
        context.fillRect(worldX, worldY, w, h);
      }
    }
  }
}

const stoneAt = (level, x, y) => materialAt(level, x, y) > 4;

/** Turn ruin coverage into a connected floor grammar and sparse wall remains. */
function drawRuins(context, level) {
  // Broken tile seams communicate one architectural platform rather than a
  // collection of independently scattered props.
  const tile = AUTHOR_TILE;
  const last = tile - 4;
  context.fillStyle = '#aab3a7';
  for (let y = 0; y < level.height; y += tile) for (let x = 0; x < level.width; x += tile) {
    if (!stoneAt(level, x + tile / 2, y + tile / 2)) continue;
    const complete = stoneAt(level, x + 3, y + 3) && stoneAt(level, x + last, y + last);
    if (complete && random(x / tile, y / tile, level.seed + 207) > 0.78) {
      context.fillStyle = '#c0c8b5';
      context.fillRect(x + 2, y + 2, tile - 4, tile - 4);
      context.fillStyle = '#aab3a7';
    }
    if (stoneAt(level, x + 3, y + 2) && stoneAt(level, x + last, y + 2)) {
      context.fillRect(x + 3, y + 1, tile - 7, 1);
    }
    if (stoneAt(level, x + 2, y + 3) && stoneAt(level, x + 2, y + last)) {
      context.fillRect(x + 1, y + 3, 1, tile - 7);
    }
  }
}

/** Bush paint scatters crisp multi-lobed growth independently of floor paint. */
function drawBushes(context, level) {
  const pixelRect = (x, y, width, height) => context.fillRect(
    Math.round(x), Math.round(y), Math.max(1, Math.round(width)), Math.max(1, Math.round(height)),
  );
  const width = level.width / AUTHOR_TILE;
  const height = level.height / AUTHOR_TILE;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!gridAt(level, 'bushes', x, y)) continue;
    for (let i = 0; i < 2; i++) {
      if (random(x, y, level.seed + i * 17 + 277) > 0.75) continue;
      const worldX = Math.round((x + random(x, y, i * 23 + 281)) * AUTHOR_TILE);
      const worldY = Math.round((y + random(x, y, i * 29 + 283)) * AUTHOR_TILE);
      if (maskAt(level, 'water', worldX, worldY)
        || !(maskAt(level, 'grass', worldX, worldY)
          || maskAt(level, 'dirt', worldX, worldY)
          || maskAt(level, 'ruins', worldX, worldY))) continue;
      const size = Math.round(7 + random(x, y, i * 31 + 287) * 6);
      context.fillStyle = '#286d3d';
      pixelRect(worldX - size, worldY, size * 1.8, size * 0.65);
      context.fillStyle = '#469a45';
      pixelRect(worldX - size * 0.8, worldY - size * 0.55, size * 0.8, size);
      pixelRect(worldX - size * 0.15, worldY - size * 0.85, size * 0.75, size * 1.15);
      pixelRect(worldX + size * 0.35, worldY - size * 0.4, size * 0.6, size * 0.75);
      context.fillStyle = '#91c857';
      pixelRect(worldX - size * 0.45, worldY - size * 0.45, size * 0.55, 3);
      pixelRect(worldX + size * 0.15, worldY - size * 0.7, 3, size * 0.45);
    }
  }
}

/** Bake static terrain once at one canvas pixel per world pixel. */
export function buildTerrain(level, scale = CACHE_SCALE, canvas = document.createElement('canvas')) {
  level.variableNoise = level.noise.some(value => value !== 1);
  canvas.width = Math.ceil(level.width / scale);
  canvas.height = Math.ceil(level.height / scale);
  const context = canvas.getContext('2d');
  const image = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const worldX = (x + 0.5) * scale;
      const worldY = (y + 0.5) * scale;
      const material = materialAt(level, worldX, worldY);
      const colour = PALETTE[material];
      const index = (y * canvas.width + x) * 4;
      image.data[index] = colour[0];
      image.data[index + 1] = colour[1];
      image.data[index + 2] = colour[2];
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  context.setTransform(1 / scale, 0, 0, 1 / scale, 0, 0);
  drawRuins(context, level);
  drawBushes(context, level);
  scatter(context, level, 'stones', [1, 0.18, 3, 2, '#b9c2b7', '#87948e', '#56656a']);
  return { canvas, level, scale };
}

/** Draw only the visible part of the static terrain cache. */
export function drawTerrain(context, terrain, bounds) {
  const { canvas, scale } = terrain;
  const sx = Math.max(0, Math.floor(bounds.left / scale));
  const sy = Math.max(0, Math.floor(bounds.top / scale));
  const ex = Math.min(canvas.width, Math.ceil(bounds.right / scale));
  const ey = Math.min(canvas.height, Math.ceil(bounds.bottom / scale));
  context.imageSmoothingEnabled = false;
  context.drawImage(canvas, sx, sy, ex - sx, ey - sy, sx * scale, sy * scale, (ex - sx) * scale, (ey - sy) * scale);
}

/** Material sampling is exported for deterministic editor/runtime smoke checks. */
export const terrainMaterialAt = materialAt;

/** Pure deterministic signature used by the Node smoke test. */
export function terrainSignature(level) {
  let signature = 2166136261;
  for (let y = 0; y < level.height; y += CACHE_SCALE) {
    for (let x = 0; x < level.width; x += CACHE_SCALE) {
      signature = Math.imul(signature ^ materialAt(level, x + 1, y + 1), 16777619);
    }
  }
  for (const kind of TERRAIN_KINDS) {
    for (const byte of level.masks[kind]) signature = Math.imul(signature ^ byte, 16777619);
  }
  for (const value of level.noise) signature = Math.imul(signature ^ value, 16777619);
  return signature >>> 0;
}
