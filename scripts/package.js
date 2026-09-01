import { readFile, writeFile } from 'node:fs/promises';
import { deflateAsync } from '@gfx/zopfli';

const limit = 13 * 1024;
const html = await readFile('dist/index.html');
const name = Buffer.from('index.html');

// Zopfli spends build time searching for a denser standard Deflate stream.
// Its default 15 iterations measured smaller than both native zlib and longer
// searches for this payload; none of this decoder/compressor code is shipped.
const compressed = Buffer.from(await deflateAsync(html, { numiterations: 15 }));

// ZIP uses CRC-32 of the uncompressed entry. Generating the small table here
// keeps the packaging script dependency-free and does not add shipped bytes.
const crcTable = new Uint32Array(256);
for (let value = 0; value < 256; value++) {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  crcTable[value] = crc;
}
let crc = 0xffffffff;
for (const byte of html) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
crc = (crc ^ 0xffffffff) >>> 0;

const writeEntryFields = (buffer, offset) => {
  buffer.writeUInt16LE(20, offset); // Deflate needs ZIP 2.0.
  buffer.writeUInt16LE(0, offset + 2);
  buffer.writeUInt16LE(8, offset + 4);
  buffer.writeUInt16LE(0, offset + 6); // Fixed 1980-01-01 timestamp.
  buffer.writeUInt16LE(33, offset + 8);
  buffer.writeUInt32LE(crc, offset + 10);
  buffer.writeUInt32LE(compressed.length, offset + 14);
  buffer.writeUInt32LE(html.length, offset + 18);
  buffer.writeUInt16LE(name.length, offset + 22);
  buffer.writeUInt16LE(0, offset + 24);
};

const local = Buffer.alloc(30 + name.length);
local.writeUInt32LE(0x04034b50);
writeEntryFields(local, 4);
name.copy(local, 30);

const central = Buffer.alloc(46 + name.length);
central.writeUInt32LE(0x02014b50);
central.writeUInt16LE(20, 4);
writeEntryFields(central, 6);
central.writeUInt16LE(0, 32);
central.writeUInt16LE(0, 34);
central.writeUInt16LE(0, 36);
central.writeUInt32LE(0, 38);
central.writeUInt32LE(0, 42);
name.copy(central, 46);

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(1, 8);
end.writeUInt16LE(1, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(local.length + compressed.length, 16);

const archive = Buffer.concat([local, compressed, central, end]);
await writeFile('dist/game.zip', archive);

const remaining = limit - archive.length;
console.log(`game.zip: ${archive.length.toLocaleString()} bytes (${remaining.toLocaleString()} remaining)`);
if (remaining < 0) process.exitCode = 1;
