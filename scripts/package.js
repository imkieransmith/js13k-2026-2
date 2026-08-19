import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const limit = 13 * 1024;
const html = await readFile('dist/index.html');
const archive = zipSync({ 'index.html': html }, { level: 9 });
await writeFile('dist/game.zip', archive);

const remaining = limit - archive.length;
console.log(`game.zip: ${archive.length.toLocaleString()} bytes (${remaining.toLocaleString()} remaining)`);
if (remaining < 0) process.exitCode = 1;
