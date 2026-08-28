// Development-only visual feedback loop. The terrain baker only needs
// createImageData/putImageData, so it can run headless in Node and the result
// can be written straight out as a PNG for eyeballing art changes.
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildTerrain, terrainHash, unpackLevel } from '../src/terrain.js';

function crcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const TABLE = crcTable();

function crc32(bytes) {
  let c = -1;
  for (const byte of bytes) c = TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, tail]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    raw[cursor++] = 0;
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      raw[cursor++] = rgba[index];
      raw[cursor++] = rgba[index + 1];
      raw[cursor++] = rgba[index + 2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function fakeCanvas() {
  let image;
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      putImageData(input) { image = input; },
    }),
    image: () => image,
  };
}

/** Crop so a preview reads at gameplay zoom rather than as a distant map. */
function crop(image, x0, y0, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = ((y0 + y) * image.width + x0 + x) * 4;
    const to = (y * width + x) * 4;
    out.set(image.data.subarray(from, from + 4), to);
  }
  return out;
}

// Mirrors the runtime atmosphere pass in game.js closely enough to tune it.
// This is a dev tool, not a second renderer: the numbers here are copied from
// the SHAFT_* and buildGrade values and must be kept in step by hand.
const SHAFT_SPACING = 232;
const SHAFT_SKIP = 4;
const SHAFT_SKEW = 0.55;
const GRADE_STOPS = [[0, [255, 250, 236]], [0.6, [240, 236, 214]], [1, [30, 57, 68]]];
const GRADE_INNER = 0.3;

function gradeAt(distance) {
  for (let i = 1; i < GRADE_STOPS.length; i++) {
    const [stop, colour] = GRADE_STOPS[i];
    const [previousStop, previousColour] = GRADE_STOPS[i - 1];
    if (distance > stop && i < GRADE_STOPS.length - 1) continue;
    const amount = Math.min(1, Math.max(0, (distance - previousStop) / (stop - previousStop)));
    return colour.map((value, channel) => previousColour[channel] + (value - previousColour[channel]) * amount);
  }
  return GRADE_STOPS.at(-1)[1];
}

/** Additive shafts, then a multiply grade — the same order the game uses. */
function atmosphere(pixels, width, height, worldX, worldY) {
  const inner = GRADE_INNER;
  const radius = Math.hypot(width, height) / 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    const shaftX = worldX + x - (worldY + y) * SHAFT_SKEW;
    const slot = Math.floor(shaftX / SHAFT_SPACING);
    let light = 0;
    for (const slotIndex of [slot - 1, slot]) {
      const variation = terrainHash(slotIndex, 7, 31);
      if (variation % SHAFT_SKIP === 0) continue;
      const span = 30 + variation % 74;
      const phase = shaftX - (slotIndex * SHAFT_SPACING + variation % 97);
      if (phase < 0 || phase >= span) continue;
      light += 0.03;
      if (phase >= span / 4 && phase < span * 0.75) light += 0.04;
    }
    const distance = Math.hypot(x - width / 2, y - height / 2) / radius;
    const tint = gradeAt(Math.min(1, Math.max(0, (distance - inner) / (1 - inner))));
    for (let channel = 0; channel < 3; channel++) {
      const lit = pixels[index + channel] + [255, 240, 200][channel] * light;
      pixels[index + channel] = Math.min(255, lit * tint[channel] / 255);
    }
  }
}

const [, , outPath = 'dist/preview.png', cropArgs] = process.argv;
const source = JSON.parse(readFileSync(new URL('../src/levels/level1.json', import.meta.url)));
const level = unpackLevel(source);
const canvas = fakeCanvas();
buildTerrain(level, 1, canvas);
const image = canvas.image();

let width = image.width;
let height = image.height;
let pixels = image.data;
if (cropArgs) {
  const [x0, y0, w, h] = cropArgs.split(',').map(Number);
  width = w;
  height = h;
  pixels = crop(image, x0, y0, w, h);
  // Only a crop stands in for a viewport, so only a crop gets the lens pass.
  atmosphere(pixels, width, height, x0, y0);
}
writeFileSync(outPath, encodePng(width, height, pixels));
console.log(`${outPath}: ${width}x${height}`);
