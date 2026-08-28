// Development-only minimal PNG writer, shared by the preview scripts. Node has
// no canvas, so an image has to be encoded by hand to be looked at.
import { deflateSync } from 'node:zlib';

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

export function encodePng(width, height, rgba) {
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

