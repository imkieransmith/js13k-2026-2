import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { build, createServer } from 'vite';
import { encodePng } from './png.js';
import { saveLevel } from '../vite.config.js';

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  return (crc ^ -1) >>> 0;
}

/** Parse the deliberately small RGB/filter-0 PNG contract emitted by png.js. */
function decodePng(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [];
  for (let cursor = 8; cursor < bytes.length;) {
    const length = bytes.readUInt32BE(cursor);
    const typeBytes = bytes.subarray(cursor + 4, cursor + 8);
    const type = typeBytes.toString('ascii');
    const data = bytes.subarray(cursor + 8, cursor + 8 + length);
    assert.equal(bytes.readUInt32BE(cursor + 8 + length), crc32(Buffer.concat([typeBytes, data])), `${type} CRC mismatch`);
    chunks.push({ type, data });
    cursor += length + 12;
  }
  assert.deepEqual(chunks.map(chunk => chunk.type), ['IHDR', 'IDAT', 'IEND']);
  const width = chunks[0].data.readUInt32BE(0);
  const height = chunks[0].data.readUInt32BE(4);
  assert.equal(chunks[0].data[8], 8);
  assert.equal(chunks[0].data[9], 2);
  const raw = inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data)));
  const rgb = [];
  const stride = width * 3 + 1;
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, 'PNG row did not use the promised filter-0 encoding');
    rgb.push(...raw.subarray(y * stride + 1, (y + 1) * stride));
  }
  return { width, height, rgb };
}

/** Execute the final inlined module, not source, against a strict hot-path canvas. */
async function runBuiltGame(moduleSource) {
  let scheduled = null;
  let now = 0;
  let draws = 0;
  let terrainDigest = '';
  const finite = (name, values) => {
    for (const value of values) assert.ok(Number.isFinite(value), `Built ${name} received ${value}`);
  };
  const context = {
    fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true,
    createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData(image) { terrainDigest = createHash('sha256').update(image.data).digest('hex'); },
    setTransform(...args) { finite('setTransform', args); },
    drawImage(_source, ...args) { finite('drawImage', args); draws++; },
    fillRect(...args) { finite('fillRect', args); draws++; },
    createRadialGradient(...args) {
      finite('createRadialGradient', args);
      return { addColorStop(offset) { finite('addColorStop', [offset]); } };
    },
  };
  const canvas = {
    width: 0, height: 0, clientWidth: 960, clientHeight: 540,
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
    addEventListener() {}, setAttribute() {},
  };
  const hud = { textContent: '', setAttribute() {}, addEventListener() {} };
  globalThis.document = {
    querySelector: selector => selector === '#c' ? canvas : hud,
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
  globalThis.devicePixelRatio = 1;
  globalThis.performance = { now: () => now };
  globalThis.addEventListener = () => {};
  globalThis.requestAnimationFrame = callback => { scheduled = callback; };
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.btoa = value => Buffer.from(value, 'binary').toString('base64');
  globalThis.atob = value => Buffer.from(value, 'base64').toString('binary');
  await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
  for (let frame = 0; frame < 5; frame++) {
    const next = scheduled;
    scheduled = null;
    assert.ok(next, 'Minified production game stopped scheduling frames');
    now += 1000 / 60;
    next(now);
  }
  assert.ok(draws > 500, 'Minified production game issued suspiciously little rendering work');
  assert.equal(context.globalAlpha, 1);
  assert.equal(context.globalCompositeOperation, 'source-over');
  assert.ok(terrainDigest, 'Minified production terrain never reached the canvas');
  return { draws, terrainDigest };
}

const sample = Uint8ClampedArray.from([
  255, 0, 0, 1, 0, 255, 0, 99,
  0, 0, 255, 255, 12, 34, 56, 0,
]);
const encoded = encodePng(2, 2, sample);
assert.deepEqual(encodePng(2, 2, sample), encoded, 'PNG encoding is not deterministic');
assert.deepEqual(decodePng(encoded), {
  width: 2,
  height: 2,
  rgb: [255, 0, 0, 0, 255, 0, 0, 0, 255, 12, 34, 56],
});

const temporaryRoot = await mkdtemp(join(tmpdir(), 'js13k-tooling-'));
try {
  // Exercise the real Vite middleware against a temporary target so a test can
  // never rewrite the checked-in arena fixture.
  const savedPath = join(temporaryRoot, 'arena.json');
  const savedUrl = pathToFileURL(savedPath);
  const original = `${await readFile(new URL('../src/levels/arena.json', import.meta.url), 'utf8')}`;
  await writeFile(savedPath, original);
  const server = await createServer({
    configFile: false,
    logLevel: 'silent',
    plugins: [saveLevel(savedUrl)],
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}/__save-level`;
    assert.equal((await fetch(origin)).status, 405);
    assert.notEqual((await fetch(new URL('/not-the-save-route', origin), { method: 'POST', body: original })).status, 204);
    assert.equal(await readFile(savedPath, 'utf8'), original, 'A different route reached the save middleware');
    assert.equal((await fetch(origin, { method: 'POST', body: '{' })).status, 400);
    assert.equal(await readFile(savedPath, 'utf8'), original, 'Invalid JSON changed the saved level');
    assert.equal((await fetch(origin, { method: 'POST', body: JSON.stringify({ width: 32 }) })).status, 400);
    assert.equal(await readFile(savedPath, 'utf8'), original, 'Invalid schema changed the saved level');
    const canonical = JSON.stringify(JSON.parse(original));
    assert.equal((await fetch(origin, { method: 'POST', body: canonical })).status, 204);
    assert.equal(await readFile(savedPath, 'utf8'), canonical);
    assert.equal((await fetch(origin, { method: 'POST', body: 'é'.repeat(100001) })).status, 413);
    assert.equal(await readFile(savedPath, 'utf8'), canonical, 'Oversized save changed the level');
    assert.ok(!(await readdir(temporaryRoot)).some(name => name.endsWith('.tmp')), 'Atomic save left a temporary file behind');
  } finally {
    await server.close();
  }

  // A filesystem failure must preserve the existing target, clean its staged
  // bytes, and be reported as a server error rather than malformed client data.
  const blockedPath = join(temporaryRoot, 'blocked');
  await mkdir(blockedPath);
  const failureServer = await createServer({
    configFile: false,
    logLevel: 'silent',
    plugins: [saveLevel(pathToFileURL(blockedPath))],
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await failureServer.listen();
    const address = failureServer.httpServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/__save-level`, { method: 'POST', body: original });
    assert.equal(response.status, 500);
    assert.deepEqual(await readdir(blockedPath), [], 'Failed atomic save replaced the existing target directory');
    assert.ok(!(await readdir(temporaryRoot)).includes('blocked.tmp'), 'Failed atomic save retained staged bytes');
  } finally {
    await failureServer.close();
  }

  // The two supported headless visual feedback commands must produce valid,
  // non-empty images at their requested crop dimensions.
  const terrainPath = join(temporaryRoot, 'terrain.png');
  // Centred on the arena, so the fixture keeps framing the fighting floor
  // rather than whatever the old centre's coordinates now happen to land on.
  execFileSync(process.execPath, ['scripts/terrain-preview.js', terrainPath, '800,616,320,240'], { stdio: 'pipe' });
  const terrainPng = decodePng(await readFile(terrainPath));
  assert.deepEqual([terrainPng.width, terrainPng.height], [320, 240]);
  assert.ok(new Set(terrainPng.rgb).size > 3, 'Terrain preview crop is visually empty');
  assert.equal(
    createHash('sha256').update(Uint8Array.from(terrainPng.rgb)).digest('hex'),
    '91da14465e18c465b09ecfad3314620ed9df5fc49830f76ca7cd87c82cf99815',
    'Terrain preview pixels changed; inspect intentional art/atmosphere changes before updating this digest',
  );

  const framePath = join(temporaryRoot, 'frame.png');
  execFileSync(process.execPath, [
    'scripts/frame-preview.js', `out=${framePath}`, 'frames=3', 'crop=580,300,160,120,1',
    'aim=700,360', 'attack=1', 'laser=1',
  ], { stdio: 'pipe' });
  const framePng = decodePng(await readFile(framePath));
  assert.deepEqual([framePng.width, framePng.height], [160, 120]);
  assert.ok(new Set(framePng.rgb).size > 8, 'Action frame preview is visually empty');
  const actionFrameDigest = createHash('sha256').update(Uint8Array.from(framePng.rgb)).digest('hex');
  assert.equal(
    actionFrameDigest,
    '46b1f0e5406ab2cd7836283cbcd9c39c19dd853a3ca9530c0a25caed17f1391d',
    'Action frame pixels changed; inspect intentional game art changes before updating this digest',
  );
  const idleFramePath = join(temporaryRoot, 'frame-idle.png');
  execFileSync(process.execPath, [
    'scripts/frame-preview.js', `out=${idleFramePath}`, 'frames=3', 'crop=580,300,160,120,1', 'aim=700,360',
  ], { stdio: 'pipe' });
  const idleFrame = decodePng(await readFile(idleFramePath));
  const idleFrameDigest = createHash('sha256').update(Uint8Array.from(idleFrame.rgb)).digest('hex');
  assert.notEqual(actionFrameDigest, idleFrameDigest, 'Action preview digest does not observe attack/laser rendering');

  // Build twice: emitted HTML must be deterministic and contain every runtime
  // asset inline, while development-only harness/middleware strings stay out.
  const configFile = resolve('vite.config.js');
  await build({ configFile, logLevel: 'silent' });
  const firstHtml = await readFile('dist/index.html');
  assert.deepEqual(await readdir('dist'), ['index.html'], 'Vite emitted production assets outside the inlined HTML');
  await build({ configFile, logLevel: 'silent' });
  const secondHtml = await readFile('dist/index.html');
  assert.deepEqual(secondHtml, firstHtml, 'Repeated production builds changed index.html bytes');
  const htmlText = secondHtml.toString();
  assert.doesNotMatch(htmlText, /<script[^>]+src=|<link[^>]+href=/i, 'Production HTML retained an external runtime asset');
  for (const forbidden of ['__gameSmoke', '__save-level', 'editor-canvas', 'terrain-stack-fixture', 'gesture smoke checks']) {
    assert.ok(!htmlText.includes(forbidden), `Production HTML leaked development-only string: ${forbidden}`);
  }
  const moduleMatch = htmlText.match(/<script type=module>([\s\S]*?)<\/script>/);
  assert.ok(moduleMatch, 'Could not locate the final inlined production module');
  const builtRun = await runBuiltGame(moduleMatch[1]);
  assert.equal(
    builtRun.terrainDigest,
    '0e5618d2a85b56797610cbf00cb6ab415459eed99eb0c51e75be71f3e4f1b5fb',
    'Minified production terrain pixels changed; inspect renderer/data changes before updating this digest',
  );

  // package.js owns the hard competition limit. It must always write exactly
  // one top-level entry and return failure if and only if that archive is over.
  const packaged = spawnSync(process.execPath, ['scripts/package.js'], { encoding: 'utf8' });
  const archive = await readFile('dist/game.zip');
  const files = unzipSync(archive);
  assert.deepEqual(Object.keys(files), ['index.html']);
  assert.deepEqual(Buffer.from(files['index.html']), secondHtml);
  const overBudget = archive.length > 13 * 1024;
  assert.equal(packaged.status, overBudget ? 1 : 0, `Package exit did not match its ${archive.length}-byte result`);
  assert.match(packaged.stdout, /game\.zip: [\d,]+ bytes \(-?[\d,]+ remaining\)/);

  console.log(`tooling smoke passed (${builtRun.draws} minified draws, HTML ${secondHtml.length} bytes, ZIP ${archive.length} bytes${overBudget ? ', over limit as expected' : ''})`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
