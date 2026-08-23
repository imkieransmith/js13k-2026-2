// Shared terrain vocabulary for the game and the development-only editor.
// Authored masks say where a material belongs; these deterministic recipes add
// the variation. Cosmetic noise never participates in collision.
export const MASK_CELL = 8;
export const TERRAIN_KINDS = ['grass', 'dirt', 'water', 'stones', 'ruins', 'collision'];
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
  return {
    width: source.width,
    height: source.height,
    cell,
    seed: source.seed || 1,
    player: source.player,
    enemies: source.enemies,
    gridWidth,
    gridHeight,
    masks,
  };
}

/** Produce the small persistence/build representation used by level JSON. */
export function packLevel(level) {
  const masks = {};
  const bits = level.gridWidth * level.gridHeight;
  for (const kind of TERRAIN_KINDS) masks[kind] = encodeMask(level.masks[kind], bits);
  return {
    width: level.width,
    height: level.height,
    cell: level.cell,
    seed: level.seed,
    player: level.player,
    enemies: level.enemies,
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

function pointWalkable(level, x, y) {
  if (x < 0 || y < 0 || x >= level.width || y >= level.height) return false;
  const land = maskAt(level, 'grass', x, y) || maskAt(level, 'dirt', x, y);
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

function surfaceField(level, worldX, worldY) {
  const noise = (fieldNoise(worldX / 42, worldY / 42, level.seed) - 0.5) * 0.27;
  const land = Math.max(
    coverage(level, level.masks.grass, worldX, worldY),
    coverage(level, level.masks.dirt, worldX, worldY),
  ) + noise;
  const pool = coverage(level, level.masks.water, worldX, worldY)
    + (fieldNoise(worldX / 34, worldY / 34, level.seed + 17) - 0.5) * 0.2;
  return Math.min(land, 1 - pool);
}

/** Material index at a world point after cosmetic coverage/noise. */
function materialAt(level, worldX, worldY) {
  const surface = surfaceField(level, worldX, worldY);
  if (surface > 0.56) {
    // Ruin paint describes a connected floor mass. Higher-frequency field
    // variation chips its edge without breaking the authored coverage apart.
    const ruin = coverage(level, level.masks.ruins, worldX, worldY)
      + (fieldNoise(worldX / 18, worldY / 18, level.seed + 43) - 0.5) * 0.28;
    if (ruin > 0.5) return 5;
    const dirt = coverage(level, level.masks.dirt, worldX, worldY)
      + (fieldNoise(worldX / 22, worldY / 22, level.seed + 29) - 0.5) * 0.34;
    return dirt > 0.52 ? 4 : 3;
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
        // One low-frequency field creates clumps and, importantly, broad quiet
        // patches. Uniform random detail made every material equally noisy.
        const density = Math.max(0, Math.min(1,
          (fieldNoise(x / 10, y / 10, level.seed + kind.length * 31) - 0.32) * 2));
        if (random(x, y, level.seed + i * 19 + kind.length) > keep * density) continue;
        const worldX = x * level.cell + random(x, y, level.seed + i * 31) * level.cell;
        const worldY = y * level.cell + random(x, y, level.seed + i * 47) * level.cell;
        const dirt = maskAt(level, 'dirt', worldX, worldY);
        if (maskAt(level, 'water', worldX, worldY)
          || !(maskAt(level, 'grass', worldX, worldY) || dirt)
          || kind === 'grass' && dirt && random(x, y, i + 59) > 0.14) continue;
        const w = width * (0.7 + random(x, y, i + 71) * 0.6);
        const h = height * (0.7 + random(x, y, i + 89) * 0.6);
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
  const tile = 24;
  context.fillStyle = '#aab3a7';
  for (let y = 0; y < level.height; y += tile) for (let x = 0; x < level.width; x += tile) {
    if (!stoneAt(level, x + 12, y + 12)) continue;
    const complete = stoneAt(level, x + 3, y + 3) && stoneAt(level, x + 20, y + 20);
    if (complete && random(x / tile, y / tile, level.seed + 207) > 0.78) {
      context.fillStyle = '#c0c8b5';
      context.fillRect(x + 2, y + 2, 20, 20);
      context.fillStyle = '#aab3a7';
    }
    if (stoneAt(level, x + 3, y + 2) && stoneAt(level, x + 20, y + 2)) {
      context.fillRect(x + 3, y + 1, 17, 1);
    }
    if (stoneAt(level, x + 2, y + 3) && stoneAt(level, x + 2, y + 20)) {
      context.fillRect(x + 1, y + 3, 1, 17);
    }
    if (random(x / tile, y / tile, level.seed + 211) > 0.82) {
      context.fillStyle = '#efebc6';
      context.fillRect(x + 7, y + 7, 7, 2);
      context.fillStyle = '#aab3a7';
    }
  }

  // Rare low remnants sit on the same lattice and share the floor material.
  const block = 4;
  for (let y = 0; y < level.gridHeight; y += block) for (let x = 0; x < level.gridWidth; x += block) {
    const centreX = (x + block / 2) * level.cell;
    const centreY = (y + block / 2) * level.cell;
    if (!stoneAt(level, centreX, centreY) || random(x, y, level.seed + 223) > 0.14) continue;
    let width = 20 + random(x, y, 227) * 14;
    let height = 5 + random(x, y, 229) * 4;
    if (fieldNoise(x / 12, y / 12, level.seed + 233) < 0.5) [width, height] = [height, width];
    if (!stoneAt(level, centreX - width * 0.4, centreY - height * 0.4)
      || !stoneAt(level, centreX + width * 0.4, centreY + height * 0.4)) continue;
    const left = centreX - width / 2;
    const top = centreY - height / 2;
    context.fillStyle = '#4b5960';
    context.fillRect(left + 2, top + 4, width, height);
    context.fillStyle = '#d8d8bd';
    context.fillRect(left, top, width, height - 1);
    context.fillStyle = '#efebc6';
    context.fillRect(left + 2, top + 1, Math.max(2, width - 5), 2);
    context.fillStyle = '#84918c';
    if (width > height) context.fillRect(left + width * 0.6, top + 2, 1, height - 3);
    else context.fillRect(left + 2, top + height * 0.6, width - 3, 1);
  }
}

/** Large growth clumps sit at architecture edges instead of noisy field-wide blades. */
function drawGrowth(context, level) {
  for (let y = 2; y < level.gridHeight - 2; y += 2) for (let x = 2; x < level.gridWidth - 2; x += 2) {
    if (!bitAt(level.masks.ruins, cellIndex(level, x, y))) continue;
    const edge = !bitAt(level.masks.ruins, cellIndex(level, x - 2, y))
      || !bitAt(level.masks.ruins, cellIndex(level, x + 2, y))
      || !bitAt(level.masks.ruins, cellIndex(level, x, y - 2))
      || !bitAt(level.masks.ruins, cellIndex(level, x, y + 2));
    if (!edge || random(x, y, level.seed + 277) > 0.16) continue;
    const worldX = x * level.cell;
    const worldY = y * level.cell;
    if (maskAt(level, 'water', worldX, worldY)) continue;
    const size = 8 + random(x, y, 281) * 8;
    context.fillStyle = '#286d3d';
    context.fillRect(worldX - size, worldY, size * 1.8, size * 0.65);
    context.fillStyle = '#469a45';
    context.fillRect(worldX - size * 0.8, worldY - size * 0.55, size * 0.8, size);
    context.fillRect(worldX - size * 0.15, worldY - size * 0.85, size * 0.75, size * 1.15);
    context.fillRect(worldX + size * 0.35, worldY - size * 0.4, size * 0.6, size * 0.75);
    context.fillStyle = '#91c857';
    context.fillRect(worldX - size * 0.45, worldY - size * 0.45, size * 0.55, 3);
    context.fillRect(worldX + size * 0.15, worldY - size * 0.7, 3, size * 0.45);
  }
}

/** Bake static terrain once at one canvas pixel per world pixel. */
export function buildTerrain(level, scale = CACHE_SCALE) {
  const canvas = document.createElement('canvas');
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
  drawGrowth(context, level);
  scatter(context, level, 'stones', [1, 0.08, 3, 2, '#b9c2b7', '#87948e', '#56656a']);
  return { canvas, level, scale };
}

/** Draw only the visible part of the static cache, then cheap animated water streaks. */
export function drawTerrain(context, terrain, bounds, time = 0) {
  const { canvas, level, scale } = terrain;
  const sx = Math.max(0, Math.floor(bounds.left / scale));
  const sy = Math.max(0, Math.floor(bounds.top / scale));
  const ex = Math.min(canvas.width, Math.ceil(bounds.right / scale));
  const ey = Math.min(canvas.height, Math.ceil(bounds.bottom / scale));
  context.imageSmoothingEnabled = false;
  context.drawImage(canvas, sx, sy, ex - sx, ey - sy, sx * scale, sy * scale, (ex - sx) * scale, (ey - sy) * scale);

  context.fillStyle = '#58a7c0';
  const firstY = Math.floor(bounds.top / 46) * 46;
  const shift = time * 4 % 74;
  for (let y = firstY; y < bounds.bottom; y += 46) {
    const firstX = Math.floor((bounds.left - shift) / 74) * 74 + shift;
    for (let x = firstX; x < bounds.right; x += 74) {
      const cellX = x / 74 | 0;
      const cellY = y / 46 | 0;
      if (random(cellX, cellY, level.seed + 307) > 0.5) continue;
      const waveX = x + random(cellX, cellY, 311) * 18;
      const waveY = y + random(cellX, cellY, 313) * 12;
      if (!materialAt(level, waveX, waveY)) {
        context.fillRect(waveX, waveY, 8 + random(cellX, cellY, 317) * 10, 1);
      }
    }
  }
}

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
  return signature >>> 0;
}
