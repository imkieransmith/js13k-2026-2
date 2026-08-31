import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { collisionAt, packLevel, stackKeyAt, unpackLevel } from '../src/terrain.js';

/** Minimal DOM/event harness that executes the shipped editor module through Vite. */
class FakeClassList {
  values = new Set();
  toggle(name, enabled) { enabled ? this.values.add(name) : this.values.delete(name); }
  add(name) { this.values.add(name); }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.children = [];
    this.style = {};
    this.value = '';
    this.checked = true;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  async dispatch(type, fields = {}) {
    const event = {
      target: this,
      button: 0,
      pointerId: 1,
      clientX: 400,
      clientY: 300,
      preventDefault() {},
      ...fields,
    };
    for (const handler of this.listeners.get(type) || []) await handler(event);
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  closest(selector) { return selector === 'button' && this.tagName === 'BUTTON' ? this : null; }
  matches(selector) { return selector === 'input' ? this.tagName === 'INPUT' : false; }
  click() {}
}

let terrainPuts = 0;
const transforms = [];
const drawingContext = {
  createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
  putImageData() { terrainPuts++; },
  setTransform(...args) { transforms.push(args); }, fillRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {},
  fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1, imageSmoothingEnabled: false,
};

class FakeCanvas extends FakeElement {
  constructor() {
    super('canvas');
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.width = 800;
    this.height = 600;
    this.captured = new Set();
  }
  getContext() { return drawingContext; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
}

const canvas = new FakeCanvas();
const panel = new FakeElement('aside');
const size = new FakeElement('input');
size.value = '1';
const sizeValue = new FakeElement('output');
const grid = new FakeElement('input');
const collisionToggle = new FakeElement('input');
const seed = new FakeElement('span');
const status = new FakeElement('p');
const coordinates = new FakeElement('span');
const inspectorEmpty = new FakeElement('p');
const inspectorLayers = new FakeElement('div');
const kinds = ['grass', 'dirt', 'water', 'stones', 'floor', 'bushes', 'wall', 'stairs', 'collision'].map(kind => {
  const button = new FakeElement('button');
  button.dataset.kind = kind;
  return button;
});
const modes = ['pencil', 'rectangle', 'fill', 'erase', 'inspect'].map(mode => {
  const button = new FakeElement('button');
  button.dataset.mode = mode;
  return button;
});
const targets = ['auto', 'ground', 'upper'].map(target => {
  const button = new FakeElement('button');
  button.dataset.target = target;
  return button;
});
const actions = ['undo', 'redo', 'regen', 'load', 'save', 'download'].map(action => {
  const button = new FakeElement('button');
  button.dataset.action = action;
  return button;
});
const selectors = new Map([
  ['#editor-canvas', canvas], ['.editor__panel', panel], ['#editor-size', size], ['#editor-size-value', sizeValue],
  ['#editor-grid', grid], ['#editor-collision', collisionToggle], ['#editor-seed', seed], ['#editor-status', status],
  ['#editor-inspector-coordinates', coordinates], ['#editor-inspector-empty', inspectorEmpty], ['#editor-inspector-layers', inspectorLayers],
]);

const documentListeners = new Map();
globalThis.document = {
  querySelector: selector => selectors.get(selector),
  querySelectorAll: selector => selector === '[data-kind]' ? kinds : selector === '[data-mode]' ? modes : selector === '[data-target]' ? targets : [],
  createElement: tag => {
    if (tag === 'canvas') return new FakeCanvas();
    const element = new FakeElement(tag);
    if (tag === 'a') element.click = () => { downloads++; };
    return element;
  },
  addEventListener(type, handler) { documentListeners.set(type, handler); },
};
const windowElement = new FakeElement('window');
globalThis.window = windowElement;
globalThis.devicePixelRatio = 1;
const raf = [];
let animationTime = performance.now();
globalThis.requestAnimationFrame = callback => { raf.push(callback); return raf.length; };

let savedBody = '';
let reloadBody = '';
let lastFetchUrl = '';
let failSave = false;
let failLoad = false;
let malformedLoad = false;
let downloads = 0;
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};
globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
globalThis.fetch = async (url, options = {}) => {
  lastFetchUrl = String(url);
  if (options.method === 'POST') {
    if (failSave) return { ok: false, status: 500 };
    savedBody = options.body;
    reloadBody = savedBody;
    return { ok: true, status: 204 };
  }
  if (failLoad) return { ok: false, status: 500 };
  return { ok: true, json: async () => malformedLoad ? { broken: true } : JSON.parse(reloadBody) };
};

async function flushRaf(rounds = 3) {
  for (let round = 0; round < rounds; round++) {
    const callbacks = raf.splice(0);
    for (const callback of callbacks) callback(animationTime += 1000 / 60);
    await Promise.resolve();
  }
}
const click = button => panel.dispatch('click', { target: button });
const buttonFor = (list, key, value) => list.find(button => button.dataset[key] === value);
const pointForTile = (x, y, fine = false) => {
  const cell = fine ? 8 : 32;
  const worldX = x * cell + cell / 2;
  const worldY = y * cell + cell / 2;
  return { clientX: 400 + (worldX - 960) * 0.55, clientY: 300 + (worldY - 640) * 0.55 };
};
async function saveLevel() {
  await click(buttonFor(actions, 'action', 'save'));
  return unpackLevel(JSON.parse(savedBody));
}

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const arenaSource = (await import('../src/levels/arena.json', { with: { type: 'json' } })).default;
  reloadBody = JSON.stringify(arenaSource);
  await server.ssrLoadModule('/src/editor.js');
  assert.equal(terrainPuts, 1, 'Editor did not perform one initial terrain build');
  assert.equal((await saveLevel()).spawners.length, 4, 'Editor save discarded arena spawners');

  // Run the gesture contract against the established grass test pad; the
  // editor itself still boots and saves the active arena above.
  reloadBody = JSON.stringify((await import('../src/levels/level1.json', { with: { type: 'json' } })).default);
  await click(buttonFor(actions, 'action', 'load'));
  await flushRaf();
  assert.match(lastFetchUrl, /\/src\/levels\/arena\.json\?t=/, 'Reload targeted a different level than Save');
  assert.equal(status.textContent, 'Reloaded arena.json');
  terrainPuts = 1;

  // A tool change during a captured gesture must not change that gesture's material.
  await click(buttonFor(kinds, 'kind', 'dirt'));
  const target = pointForTile(30, 10);
  await canvas.dispatch('pointerdown', { ...target, pointerId: 11 });
  await click(buttonFor(kinds, 'kind', 'water'));
  await canvas.dispatch('pointerup', { ...target, pointerId: 11 });
  await flushRaf();
  assert.equal(terrainPuts, 2, 'Pencil gesture rebuilt more or less than once');
  let saved = await saveLevel();
  assert.equal(stackKeyAt(saved, 30, 10), 'gd', 'Gesture used a mid-stroke material change');

  // One drag is one undo transaction, even when pointer release occurs outside.
  await click(buttonFor(actions, 'action', 'undo'));
  await flushRaf();
  saved = await saveLevel();
  assert.equal(stackKeyAt(saved, 30, 10), 'g');
  await click(buttonFor(actions, 'action', 'undo'));
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 30, 10), 'g', 'One gesture created multiple undo entries');

  await click(buttonFor(kinds, 'kind', 'water'));
  const outsideStart = pointForTile(31, 10);
  await canvas.dispatch('pointerdown', { ...outsideStart, pointerId: 12 });
  await canvas.dispatch('pointermove', { clientX: -5000, clientY: -5000, pointerId: 12 });
  await canvas.dispatch('pointerup', { clientX: -5000, clientY: -5000, pointerId: 12 });
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 31, 10), 'gw', 'Captured outside release lost the gesture');
  await click(buttonFor(actions, 'action', 'redo'));
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 30, 10), 'g', 'A new gesture did not invalidate stale redo history');

  // Cancellation and lost capture intentionally commit the selected cells once.
  for (const [x, event, pointerId] of [[32, 'pointercancel', 13], [33, 'lostpointercapture', 14]]) {
    const point = pointForTile(x, 10);
    await canvas.dispatch('pointerdown', { ...point, pointerId });
    await canvas.dispatch(event, { ...point, pointerId });
    await flushRaf();
  }
  saved = await saveLevel();
  assert.equal(stackKeyAt(saved, 32, 10), 'gw');
  assert.equal(stackKeyAt(saved, 33, 10), 'gw');

  // A large brush plus a fast drag interpolates every crossed tile. Right
  // click erases the selected material through the same captured gesture path.
  size.value = '3';
  await size.dispatch('input');
  assert.equal(sizeValue.value, '3');
  await click(buttonFor(kinds, 'kind', 'dirt'));
  const dragStart = pointForTile(40, 10);
  const dragEnd = pointForTile(42, 10);
  await canvas.dispatch('pointerdown', { ...dragStart, pointerId: 141 });
  await canvas.dispatch('pointermove', { ...dragEnd, pointerId: 141 });
  await canvas.dispatch('pointerup', { ...dragEnd, pointerId: 141 });
  await flushRaf();
  saved = await saveLevel();
  for (let y = 9; y <= 11; y++) for (let x = 39; x <= 43; x++) {
    assert.ok(stackKeyAt(saved, x, y).includes('d'), `Brush drag skipped ${x},${y}`);
  }
  size.value = '1';
  await size.dispatch('input');
  await canvas.dispatch('pointerdown', { ...pointForTile(40, 10), button: 2, pointerId: 142 });
  await canvas.dispatch('pointerup', { ...pointForTile(40, 10), button: 2, pointerId: 142 });
  await flushRaf();
  assert.ok(!stackKeyAt(await saveLevel(), 40, 10).includes('d'), 'Right-click did not erase the selected material');

  // Rectangle uses real handlers and commits one canonical operation to every cell.
  await click(buttonFor(kinds, 'kind', 'floor'));
  await click(buttonFor(modes, 'mode', 'rectangle'));
  const rectangleStart = pointForTile(30, 11);
  const rectangleEnd = pointForTile(31, 12);
  await canvas.dispatch('pointerdown', { ...rectangleStart, pointerId: 15 });
  await canvas.dispatch('pointermove', { ...rectangleEnd, pointerId: 15 });
  await canvas.dispatch('pointerup', { ...rectangleEnd, pointerId: 15 });
  await flushRaf();
  saved = await saveLevel();
  for (let y = 11; y <= 12; y++) for (let x = 30; x <= 31; x++) assert.equal(stackKeyAt(saved, x, y), 'gf');

  // Fill compares canonical stack values and updates the complete 2x2 region.
  await click(buttonFor(kinds, 'kind', 'dirt'));
  await click(buttonFor(modes, 'mode', 'fill'));
  await canvas.dispatch('pointerdown', { ...pointForTile(30, 11), pointerId: 16 });
  await flushRaf();
  saved = await saveLevel();
  for (let y = 11; y <= 12; y++) for (let x = 30; x <= 31; x++) assert.equal(stackKeyAt(saved, x, y), 'gfd');

  // Pinned Elevated edits on Wall-less tiles reject atomically and report why.
  await click(buttonFor(targets, 'target', 'upper'));
  await click(buttonFor(kinds, 'kind', 'grass'));
  await click(buttonFor(modes, 'mode', 'pencil'));
  const rejectedBefore = savedBody;
  await canvas.dispatch('pointerdown', { ...pointForTile(34, 10), pointerId: 17 });
  await canvas.dispatch('pointerup', { ...pointForTile(34, 10), pointerId: 17 });
  assert.match(status.textContent, /require.*structure/i);
  await saveLevel();
  assert.equal(savedBody, rejectedBefore, 'Rejected elevated gesture changed saved state or palette');

  // Stairs replace Wall atomically, preserve both bands, and demote safely.
  await click(buttonFor(targets, 'target', 'auto'));
  await click(buttonFor(kinds, 'kind', 'wall'));
  const structurePoint = pointForTile(35, 10);
  await canvas.dispatch('pointerdown', { ...structurePoint, pointerId: 18 });
  await canvas.dispatch('pointerup', { ...structurePoint, pointerId: 18 });
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 35, 10), 'g#');
  await click(buttonFor(kinds, 'kind', 'stairs'));
  await canvas.dispatch('pointerdown', { ...structurePoint, pointerId: 19 });
  await canvas.dispatch('pointerup', { ...structurePoint, pointerId: 19 });
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 35, 10), 'g^', 'Stairs did not replace Wall in place');
  await click(buttonFor(actions, 'action', 'undo'));
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 35, 10), 'g#', 'Structure replacement was not one undo step');
  await click(buttonFor(actions, 'action', 'redo'));
  await flushRaf();
  await click(buttonFor(kinds, 'kind', 'floor'));
  await canvas.dispatch('pointerdown', { ...structurePoint, pointerId: 20 });
  await canvas.dispatch('pointerup', { ...structurePoint, pointerId: 20 });
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 35, 10), 'g^f');
  await click(buttonFor(kinds, 'kind', 'stairs'));
  await click(buttonFor(modes, 'mode', 'erase'));
  await canvas.dispatch('pointerdown', { ...structurePoint, pointerId: 21 });
  await canvas.dispatch('pointerup', { ...structurePoint, pointerId: 21 });
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 35, 10), 'gf', 'Erasing Stairs did not demote Elevated entries');
  await click(buttonFor(actions, 'action', 'undo'));
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 35, 10), 'g^f');

  // Inspect displays the true top-to-bottom stack, pins the selected row's
  // band, and makes reorder/removal one undoable canonical edit.
  await click(buttonFor(modes, 'mode', 'inspect'));
  await canvas.dispatch('pointerdown', { ...structurePoint, pointerId: 211 });
  assert.equal(inspectorLayers.children.length, 3);
  assert.match(inspectorLayers.children[0].children[0].textContent, /Floor · Elevated/);
  assert.match(inspectorLayers.children[1].children[0].textContent, /Stairs · Structure/);
  assert.match(inspectorLayers.children[2].children[0].textContent, /Grass · Ground/);
  await click(inspectorLayers.children[2].children[0]);
  assert.ok(buttonFor(kinds, 'kind', 'grass').classList.values.has('is-active'));
  assert.ok(buttonFor(targets, 'target', 'ground').classList.values.has('is-active'));
  await click(inspectorLayers.children[0].children[2]);
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 35, 10), 'gf^', 'Inspector did not move an entry across the structure');
  await click(buttonFor(actions, 'action', 'undo'));
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 35, 10), 'g^f');
  await click(inspectorLayers.children[0].children[3]);
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 35, 10), 'g^', 'Inspector remove did not delete the selected row');
  await click(buttonFor(actions, 'action', 'undo'));
  await flushRaf();

  // Clicking the visible lower half of a Wall redirects Stairs to its anchor.
  await click(buttonFor(modes, 'mode', 'pencil'));
  await click(buttonFor(kinds, 'kind', 'wall'));
  const projectedAnchor = pointForTile(36, 10);
  await canvas.dispatch('pointerdown', { ...projectedAnchor, pointerId: 22 });
  await canvas.dispatch('pointerup', { ...projectedAnchor, pointerId: 22 });
  await flushRaf();
  await click(buttonFor(kinds, 'kind', 'stairs'));
  const projectedFace = pointForTile(36, 11);
  await canvas.dispatch('pointerdown', { ...projectedFace, pointerId: 23 });
  await canvas.dispatch('pointerup', { ...projectedFace, pointerId: 23 });
  await flushRaf();
  saved = await saveLevel();
  assert.equal(stackKeyAt(saved, 36, 10), 'g^', 'Projected Wall face did not target its structural anchor');
  assert.equal(stackKeyAt(saved, 36, 11), 'g', 'Projected Stairs created a second structure row');

  // Clicking the ground cell at the foot of the two-tile projection also targets the Wall.
  await click(buttonFor(kinds, 'kind', 'wall'));
  const baseAnchor = pointForTile(37, 10);
  await canvas.dispatch('pointerdown', { ...baseAnchor, pointerId: 24 });
  await canvas.dispatch('pointerup', { ...baseAnchor, pointerId: 24 });
  await flushRaf();
  await click(buttonFor(kinds, 'kind', 'stairs'));
  const projectedBase = pointForTile(37, 12);
  await canvas.dispatch('pointerdown', { ...projectedBase, pointerId: 25 });
  await canvas.dispatch('pointerup', { ...projectedBase, pointerId: 25 });
  await flushRaf();
  saved = await saveLevel();
  assert.equal(stackKeyAt(saved, 37, 10), 'g^', 'Wall base click did not target the anchor two rows north');
  assert.equal(stackKeyAt(saved, 37, 12), 'g', 'Wall base click created another Stair row');
  await canvas.dispatch('pointerdown', { ...projectedBase, pointerId: 26 });
  await canvas.dispatch('pointerup', { ...projectedBase, pointerId: 26 });
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 37, 12), 'g', 'Repeated base click extended the staircase');

  // One repaint repairs stair rows created two tiles apart by the old editor.
  saved = await saveLevel();
  saved.tileStacks[10 * saved.tileWidth + 38] = ['g', '^'];
  saved.tileStacks[12 * saved.tileWidth + 38] = ['g', '^'];
  reloadBody = JSON.stringify(packLevel(saved));
  await click(buttonFor(actions, 'action', 'load'));
  await flushRaf();
  const duplicateStairs = pointForTile(38, 12);
  await canvas.dispatch('pointerdown', { ...duplicateStairs, pointerId: 27 });
  await canvas.dispatch('pointerup', { ...duplicateStairs, pointerId: 27 });
  await flushRaf();
  saved = await saveLevel();
  assert.equal(stackKeyAt(saved, 38, 10), 'g^');
  assert.equal(stackKeyAt(saved, 38, 12), 'g', 'Repaint did not collapse the old duplicate Stair row');
  await click(buttonFor(actions, 'action', 'undo'));
  await flushRaf();
  assert.equal(stackKeyAt(await saveLevel(), 38, 12), 'g^', 'Duplicate repair was not one undo step');
  await click(buttonFor(actions, 'action', 'redo'));
  await flushRaf();

  // Inspector communicates unsupported decorations and rejects a reorder that
  // would create a duplicate material across the structure.
  saved = await saveLevel();
  saved.tileStacks[10 * saved.tileWidth + 44] = ['b'];
  saved.tileStacks[10 * saved.tileWidth + 45] = ['g', '^', 'g'];
  reloadBody = JSON.stringify(packLevel(saved));
  await click(buttonFor(actions, 'action', 'load'));
  await flushRaf();
  await click(buttonFor(modes, 'mode', 'inspect'));
  await canvas.dispatch('pointerdown', { ...pointForTile(44, 10), pointerId: 271 });
  assert.match(inspectorLayers.children[0].children[0].textContent, /needs surface/);
  await canvas.dispatch('pointerdown', { ...pointForTile(45, 10), pointerId: 272 });
  await click(inspectorLayers.children[0].children[2]);
  assert.match(status.textContent, /duplicate/i);
  assert.equal(stackKeyAt(await saveLevel(), 45, 10), 'g^g', 'Rejected inspector reorder changed the stack');

  // Fine Collision remains independent and survives save/reload.
  await click(buttonFor(targets, 'target', 'auto'));
  await click(buttonFor(modes, 'mode', 'pencil'));
  await click(buttonFor(kinds, 'kind', 'collision'));
  const collisionPoint = pointForTile(150, 100, true);
  await canvas.dispatch('pointerdown', { ...collisionPoint, pointerId: 28 });
  await canvas.dispatch('pointerup', { ...collisionPoint, pointerId: 28 });
  await flushRaf();
  saved = await saveLevel();
  assert.equal(collisionAt(saved, 150, 100), 1);
  await click(buttonFor(modes, 'mode', 'rectangle'));
  await canvas.dispatch('pointerdown', { ...pointForTile(150, 100, true), pointerId: 281 });
  await canvas.dispatch('pointermove', { ...pointForTile(151, 101, true), pointerId: 281 });
  await canvas.dispatch('pointerup', { ...pointForTile(151, 101, true), pointerId: 281 });
  await flushRaf();
  saved = await saveLevel();
  for (let y = 100; y <= 101; y++) for (let x = 150; x <= 151; x++) assert.equal(collisionAt(saved, x, y), 1);
  await click(buttonFor(modes, 'mode', 'fill'));
  await canvas.dispatch('pointerdown', { ...pointForTile(150, 100, true), button: 2, pointerId: 282 });
  await flushRaf();
  saved = await saveLevel();
  for (let y = 100; y <= 101; y++) for (let x = 150; x <= 151; x++) assert.equal(collisionAt(saved, x, y), 0);

  const stable = savedBody;
  await click(buttonFor(actions, 'action', 'load'));
  await flushRaf();
  await saveLevel();
  assert.equal(savedBody, stable, 'Save/reload changed canonical stack or Collision data');

  // Regeneration is one undoable seed edit. Representative keyboard bindings
  // select tools/materials and Escape clears a pinned band.
  const seedBefore = Number(seed.textContent);
  await click(buttonFor(actions, 'action', 'regen'));
  await flushRaf();
  assert.equal(Number(seed.textContent), seedBefore + 1);
  await click(buttonFor(actions, 'action', 'undo'));
  await flushRaf();
  assert.equal(Number(seed.textContent), seedBefore);
  await windowElement.dispatch('keydown', { key: '3', code: 'Digit3', target: new FakeElement('div') });
  assert.ok(buttonFor(kinds, 'kind', 'water').classList.values.has('is-active'));
  await windowElement.dispatch('keydown', { key: 'r', code: 'KeyR', target: new FakeElement('div') });
  assert.ok(buttonFor(modes, 'mode', 'rectangle').classList.values.has('is-active'));
  const scaleBeforeWheel = transforms.at(-1)[0];
  await canvas.dispatch('wheel', { ...pointForTile(30, 10), deltaY: -1000 });
  await flushRaf(1);
  assert.ok(transforms.at(-1)[0] > scaleBeforeWheel, 'Wheel zoom did not change the world transform');
  const offsetBeforePan = transforms.at(-1)[4];
  await windowElement.dispatch('keydown', { key: 'd', code: 'KeyD', target: new FakeElement('div') });
  await flushRaf(2);
  await windowElement.dispatch('keyup', { key: 'd', code: 'KeyD' });
  assert.notEqual(transforms.at(-1)[4], offsetBeforePan, 'Held keyboard pan did not move the camera');
  await click(buttonFor(targets, 'target', 'ground'));
  await windowElement.dispatch('keydown', { key: 'Escape', code: 'Escape', target: new FakeElement('div') });
  assert.ok(buttonFor(targets, 'target', 'auto').classList.values.has('is-active'));

  // HTTP failures are visible and Save falls back to a download without
  // changing the in-memory canonical level.
  failLoad = true;
  await click(buttonFor(actions, 'action', 'load'));
  assert.equal(status.textContent, 'Reload failed');
  failLoad = false;
  malformedLoad = true;
  await click(buttonFor(actions, 'action', 'load'));
  assert.equal(status.textContent, 'Reload failed');
  malformedLoad = false;
  failSave = true;
  const downloadsBefore = downloads;
  await click(buttonFor(actions, 'action', 'save'));
  assert.equal(downloads, downloadsBefore + 1, 'Failed save did not download a fallback');
  assert.match(status.textContent, /downloaded JSON/);
  failSave = false;
  await click(buttonFor(actions, 'action', 'download'));
  assert.equal(downloads, downloadsBefore + 2, 'Explicit Download did not create a file');

  console.log('editor stack gesture smoke checks passed');
} finally {
  await server.close();
}
