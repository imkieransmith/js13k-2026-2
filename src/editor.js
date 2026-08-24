import levelSource from './levels/level1.json';
import {
  AUTHOR_TILE,
  addStackEntry,
  buildTerrain,
  collisionAt,
  drawTerrain,
  editStackCells,
  materialName,
  moveStackEntry,
  packLevel,
  paintCollisionCell,
  removeStackEntry,
  removeStackIndex,
  stackAt,
  stackKeyAt,
  unpackLevel,
} from './terrain.js';

const canvas = document.querySelector('#editor-canvas');
const context = canvas.getContext('2d');
const panel = document.querySelector('.editor__panel');
const sizeInput = document.querySelector('#editor-size');
const sizeValue = document.querySelector('#editor-size-value');
const gridToggle = document.querySelector('#editor-grid');
const collisionToggle = document.querySelector('#editor-collision');
const seedLabel = document.querySelector('#editor-seed');
const status = document.querySelector('#editor-status');
const inspectorCoordinates = document.querySelector('#editor-inspector-coordinates');
const inspectorEmpty = document.querySelector('#editor-inspector-empty');
const inspectorLayers = document.querySelector('#editor-inspector-layers');
const colours = {
  grass: '#68d48b', dirt: '#b98962', water: '#62b8ed', stones: '#dbe0ca',
  floor: '#fff3a6', bushes: '#469a45', wall: '#81998a', stairs: '#e7d6a5', collision: '#ff315a',
};
const labels = {
  grass: 'Grass', dirt: 'Dirt', water: 'Water', stones: 'Stones',
  floor: 'Floor', bushes: 'Bushes', wall: 'Wall', stairs: 'Stairs', collision: 'Collision',
};
const editorKinds = ['grass', 'dirt', 'water', 'stones', 'floor', 'bushes', 'wall', 'stairs', 'collision'];
const surfaceCodes = 'gdwf';

let level = unpackLevel(levelSource);
let terrain = buildTerrain(level);
let selectedKind = 'grass';
let selectedMode = 'pencil';
let targetBand = 'auto';
let pointerWorld = null;
let activePointer = null;
let painting = false;
let panning = false;
let rendering = false;
let spaceHeld = false;
let eraseStroke = false;
let gestureKind = null;
let gestureMode = null;
let gestureTarget = 'auto';
let gestureSize = AUTHOR_TILE;
let startCell = null;
let lastCell = null;
let rectangleCell = null;
let inspectorCell = null;
let lastPan = null;
let buildVersion = 0;
let lastFrameTime = performance.now();
const pendingCells = new Map();
const undoStack = [];
const redoStack = [];
const held = new Set();
const camera = { x: level.width / 2, y: level.height / 2, zoom: 0.55 };

const snapshot = () => JSON.stringify(packLevel(level));
const setStatus = message => { status.textContent = message; };
const gridSize = (kind = selectedKind) => kind === 'collision' ? level.cell : AUTHOR_TILE;
const gridWidth = size => size === level.cell ? level.collisionWidth : level.tileWidth;
const gridHeight = size => size === level.cell ? level.collisionHeight : level.tileHeight;
const structureIndex = stack => stack.findIndex(code => '#^'.includes(code));
const stackBand = (stack, index) => index > structureIndex(stack) && structureIndex(stack) >= 0 ? 'upper' : 'ground';
const bandEntries = (stack, band) => {
  const structure = structureIndex(stack);
  return band === 'upper' ? structure < 0 ? [] : stack.slice(structure + 1) : stack.slice(0, structure < 0 ? stack.length : structure);
};
const bandSupported = entries => entries.some(code => surfaceCodes.includes(code));

function updateControls() {
  document.querySelectorAll('[data-kind]').forEach(button => button.classList.toggle('is-active', button.dataset.kind === selectedKind));
  document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('is-active', button.dataset.mode === selectedMode));
  document.querySelectorAll('[data-target]').forEach(button => button.classList.toggle('is-active', button.dataset.target === targetBand));
  sizeValue.value = sizeInput.value;
  seedLabel.textContent = level.seed;
  updateInspector();
}

function updateInspector() {
  inspectorLayers.replaceChildren();
  inspectorEmpty.hidden = !!inspectorCell;
  inspectorCoordinates.textContent = inspectorCell ? `${inspectorCell.x}, ${inspectorCell.y}` : '—';
  if (!inspectorCell) return;
  const stack = stackAt(level, inspectorCell.x, inspectorCell.y);
  if (!stack.length) {
    const empty = document.createElement('div');
    empty.className = 'editor__stack-empty';
    empty.textContent = 'Empty stack — paint a surface to create support.';
    inspectorLayers.append(empty);
    return;
  }
  const groundSupport = bandSupported(bandEntries(stack, 'ground'));
  const upperSupport = bandSupported(bandEntries(stack, 'upper'));
  for (let index = stack.length - 1; index >= 0; index--) {
    const code = stack[index];
    const kind = materialName(code);
    const structural = '#^'.includes(code);
    const band = structural ? 'structure' : stackBand(stack, index);
    const unsupported = (code === 'b' || code === 's') && !(band === 'upper' ? upperSupport : groundSupport);
    const row = document.createElement('div');
    row.className = `editor__stack-entry${structural ? ' editor__stack-entry--structure' : ''}${unsupported ? ' is-unsupported' : ''}`;
    if (kind === selectedKind && (targetBand === band || targetBand === 'auto')) row.classList.add('is-active');
    const select = document.createElement('button');
    select.className = 'editor__stack-select';
    select.dataset.stackAction = 'select';
    select.dataset.stackIndex = index;
    select.textContent = `${labels[kind]} · ${band === 'upper' ? 'Elevated' : band === 'ground' ? 'Ground' : 'Structure'}${unsupported ? ' · needs surface' : ''}`;
    const up = document.createElement('button');
    up.className = 'editor__stack-action';
    up.dataset.stackAction = 'up';
    up.dataset.stackIndex = index;
    up.textContent = '↑';
    up.title = 'Move visually up';
    up.disabled = index === stack.length - 1;
    const down = document.createElement('button');
    down.className = 'editor__stack-action';
    down.dataset.stackAction = 'down';
    down.dataset.stackIndex = index;
    down.textContent = '↓';
    down.title = 'Move visually down';
    down.disabled = index === 0;
    const remove = document.createElement('button');
    remove.className = 'editor__stack-action editor__stack-action--remove';
    remove.dataset.stackAction = 'remove';
    remove.dataset.stackIndex = index;
    remove.textContent = '×';
    remove.title = structural ? `Remove ${labels[kind]} and demote elevated entries` : `Remove ${labels[kind]}`;
    row.append(select, up, down, remove);
    inspectorLayers.append(row);
  }
}

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}

function viewBounds() {
  const width = canvas.clientWidth / camera.zoom;
  const height = canvas.clientHeight / camera.zoom;
  return {
    left: camera.x - width / 2,
    top: camera.y - height / 2,
    right: camera.x + width / 2,
    bottom: camera.y + height / 2,
  };
}

function eventWorld(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: camera.x + (event.clientX - rect.left - rect.width / 2) / camera.zoom,
    y: camera.y + (event.clientY - rect.top - rect.height / 2) / camera.zoom,
  };
}

function cellAt(point, size = gridSize()) {
  const x = Math.floor(point.x / size);
  const y = Math.floor(point.y / size);
  return x < 0 || y < 0 || x >= gridWidth(size) || y >= gridHeight(size) ? null : { x, y };
}

function queueBuild(message = 'Ready') {
  const version = ++buildVersion;
  rendering = true;
  setStatus('Rendering…');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (version !== buildVersion) return;
    terrain = buildTerrain(level, terrain.scale, terrain.canvas);
    pendingCells.clear();
    rendering = false;
    setStatus(message);
  }));
}

function pushUndo(before) {
  const after = snapshot();
  if (after === before) return false;
  undoStack.push(before);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  return true;
}

function restore(json, message) {
  level = unpackLevel(JSON.parse(json));
  pendingCells.clear();
  updateControls();
  queueBuild(message);
}

function undo() {
  if (rendering || painting) return;
  const before = undoStack.pop();
  if (!before) return;
  redoStack.push(snapshot());
  restore(before, 'Undid gesture');
}

function redo() {
  if (rendering || painting) return;
  const after = redoStack.pop();
  if (!after) return;
  undoStack.push(snapshot());
  restore(after, 'Redid gesture');
}

/** Resolve the visible face/base and collapse accidental vertical Stair duplicates. */
function stairResolution(cell, erasing) {
  let stairs = null;
  for (let y = cell.y; y >= 0 && y >= cell.y - 2; y--) {
    const stack = stackAt(level, cell.x, y);
    if (stack?.includes('^')) {
      const found = { x: cell.x, y };
      if (erasing) return { anchor: found, cleanup: [] };
      if (stairs) return { anchor: found, cleanup: [stairs] };
      stairs = found;
    } else if (stack?.includes('#') && !erasing) return { anchor: stairs || { x: cell.x, y }, cleanup: [] };
  }
  return { anchor: stairs || cell, cleanup: [] };
}

function markCell(cell) {
  const size = gestureSize;
  const source = cell;
  if (gestureKind === 'stairs') cell = stairResolution(cell, eraseStroke).anchor;
  if (cell.x < 0 || cell.y < 0 || cell.x >= gridWidth(size) || cell.y >= gridHeight(size)) return;
  const key = `${cell.x}:${cell.y}`;
  const previous = pendingCells.get(key);
  if (!previous || source.y > previous.sourceY) pendingCells.set(key, {
    ...cell, sourceX: source.x, sourceY: source.y, size, kind: gestureKind, erasing: eraseStroke,
  });
}

function markDab(cell) {
  const brush = Number(sizeInput.value);
  const offset = Math.floor((brush - 1) / 2);
  for (let y = 0; y < brush; y++) for (let x = 0; x < brush; x++) markCell({ x: cell.x + x - offset, y: cell.y + y - offset });
}

/** Integer traversal makes a fast pointer drag select every crossed tile. */
function markLine(from, to) {
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - x);
  const dy = -Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1;
  const sy = y < to.y ? 1 : -1;
  let error = dx + dy;
  while (true) {
    markDab({ x, y });
    if (x === to.x && y === to.y) break;
    const twice = error * 2;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
}

function rectangleCells() {
  const cells = [];
  if (!startCell || !rectangleCell) return cells;
  for (let y = Math.min(startCell.y, rectangleCell.y); y <= Math.max(startCell.y, rectangleCell.y); y++) {
    for (let x = Math.min(startCell.x, rectangleCell.x); x <= Math.max(startCell.x, rectangleCell.x); x++) cells.push({ x, y });
  }
  return cells;
}

function floodCells(start) {
  const size = gridSize();
  const width = gridWidth(size);
  const height = gridHeight(size);
  const target = selectedKind === 'collision'
    ? collisionAt(level, start.x, start.y) : stackKeyAt(level, start.x, start.y);
  const visited = new Uint8Array(width * height);
  const queue = [start];
  const cells = [];
  while (queue.length) {
    const { x, y } = queue.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const index = y * width + x;
    if (visited[index]) continue;
    visited[index] = 1;
    const value = selectedKind === 'collision' ? collisionAt(level, x, y) : stackKeyAt(level, x, y);
    if (value !== target) continue;
    cells.push({ x, y });
    queue.push({ x: x - 1, y }, { x: x + 1, y }, { x, y: y - 1 }, { x, y: y + 1 });
  }
  return cells;
}

function applyCells(cells, erasing, kind = selectedKind, target = targetBand) {
  if (!cells.length) return false;
  if (kind === 'collision') {
    let changed = false;
    for (const cell of cells) changed = paintCollisionCell(level, cell.x, cell.y, erasing ? 0 : 1) || changed;
    return changed;
  }
  if (kind === 'stairs') {
    const actions = new Map();
    for (const cell of cells) {
      const source = { x: cell.sourceX ?? cell.x, y: cell.sourceY ?? cell.y };
      const resolution = stairResolution(source, erasing);
      if (!erasing) for (const stale of resolution.cleanup) actions.set(`${stale.x}:${stale.y}`, { ...stale, action: 'remove' });
      actions.set(`${resolution.anchor.x}:${resolution.anchor.y}`, { ...resolution.anchor, action: erasing ? 'remove' : 'add' });
    }
    cells = [...actions.values()];
    return editStackCells(level, cells, (stack, x, y) => actions.get(`${x}:${y}`).action === 'remove'
      ? removeStackEntry(stack, kind, target) : addStackEntry(stack, kind, target));
  }
  return editStackCells(level, cells, stack => erasing
    ? removeStackEntry(stack, kind, target)
    : addStackEntry(stack, kind, target));
}

function commitCells(cells, erasing, message = 'Ready', kind = selectedKind, target = targetBand) {
  const before = snapshot();
  try {
    const changed = applyCells(cells, erasing, kind, target);
    if (changed && pushUndo(before)) {
      updateInspector();
      queueBuild(message);
    } else pendingCells.clear();
    return changed;
  } catch (error) {
    pendingCells.clear();
    setStatus(error.message);
    return false;
  }
}

function finishGesture(commit = true) {
  if (panning) panning = false;
  else if (painting) {
    if (commit) commitCells(gestureMode === 'rectangle' ? rectangleCells() : [...pendingCells.values()], eraseStroke, 'Ready', gestureKind, gestureTarget);
    else pendingCells.clear();
    painting = false;
  }
  const pointer = activePointer;
  activePointer = null;
  if (pointer !== null && canvas.hasPointerCapture?.(pointer)) canvas.releasePointerCapture(pointer);
  gestureKind = gestureMode = null;
  startCell = lastCell = rectangleCell = lastPan = null;
}

canvas.addEventListener('pointerdown', event => {
  if (rendering || activePointer !== null) return;
  pointerWorld = eventWorld(event);
  if (event.button === 1 || spaceHeld) {
    activePointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    panning = true;
    lastPan = { x: event.clientX, y: event.clientY };
    return;
  }
  if (event.button !== 0 && event.button !== 2) return;
  const cell = cellAt(pointerWorld, selectedMode === 'inspect' ? AUTHOR_TILE : gridSize());
  if (!cell) return;
  event.preventDefault();
  if (selectedMode === 'inspect') {
    if (event.button === 0) {
      inspectorCell = cell;
      updateInspector();
    }
    return;
  }
  eraseStroke = event.button === 2 || selectedMode === 'erase';
  if (selectedMode === 'fill') {
    const resolution = selectedKind === 'stairs' ? stairResolution(cell, eraseStroke) : { anchor: cell };
    const cells = floodCells(resolution.anchor);
    if (resolution.anchor.x !== cell.x || resolution.anchor.y !== cell.y) cells.push(cell);
    commitCells(cells, eraseStroke, 'Filled region');
    return;
  }
  activePointer = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  painting = true;
  gestureKind = selectedKind;
  gestureMode = selectedMode;
  gestureTarget = targetBand;
  gestureSize = gridSize(gestureKind);
  pendingCells.clear();
  startCell = lastCell = rectangleCell = cell;
  if (gestureMode !== 'rectangle') markDab(cell);
});

canvas.addEventListener('pointermove', event => {
  pointerWorld = eventWorld(event);
  if (panning && lastPan) {
    camera.x -= (event.clientX - lastPan.x) / camera.zoom;
    camera.y -= (event.clientY - lastPan.y) / camera.zoom;
    lastPan = { x: event.clientX, y: event.clientY };
    return;
  }
  if (!painting) return;
  const cell = cellAt(pointerWorld, gestureSize);
  if (!cell) return;
  if (gestureMode === 'rectangle') rectangleCell = cell;
  else if (cell.x !== lastCell.x || cell.y !== lastCell.y) {
    markLine(lastCell, cell);
    lastCell = cell;
  }
});
canvas.addEventListener('pointerleave', () => { if (!painting && !panning) pointerWorld = null; });
canvas.addEventListener('pointerup', event => { if (activePointer === event.pointerId) finishGesture(true); });
canvas.addEventListener('pointercancel', event => { if (activePointer === event.pointerId) finishGesture(true); });
canvas.addEventListener('lostpointercapture', event => { if (activePointer === event.pointerId) finishGesture(true); });
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  const before = eventWorld(event);
  camera.zoom = Math.max(0.25, Math.min(4, camera.zoom * Math.exp(-event.deltaY * 0.001)));
  const after = eventWorld(event);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
  pointerWorld = eventWorld(event);
}, { passive: false });

sizeInput.addEventListener('input', updateControls);

function changeInspectedStack(operation, message) {
  if (!inspectorCell) return;
  const before = snapshot();
  try {
    if (!editStackCells(level, [inspectorCell], operation)) return;
    pushUndo(before);
    updateInspector();
    queueBuild(message);
  } catch (error) { setStatus(error.message); }
}

panel.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || rendering) return;
  if (button.dataset.kind) selectedKind = button.dataset.kind;
  if (button.dataset.mode) selectedMode = button.dataset.mode;
  if (button.dataset.target) targetBand = button.dataset.target;
  const stackAction = button.dataset.stackAction;
  if (stackAction && inspectorCell) {
    const index = Number(button.dataset.stackIndex);
    const inspected = stackAt(level, inspectorCell.x, inspectorCell.y);
    if (stackAction === 'select') {
      selectedKind = materialName(inspected[index]);
      targetBand = '#^'.includes(inspected[index]) ? 'auto' : stackBand(inspected, index);
      selectedMode = 'pencil';
    } else if (stackAction === 'remove') {
      changeInspectedStack(stack => removeStackIndex(stack, index), 'Removed stack entry');
    } else {
      changeInspectedStack(stack => moveStackEntry(stack, index, stackAction === 'up' ? 1 : -1), 'Reordered stack');
    }
  }
  const action = button.dataset.action;
  if (action === 'undo') undo();
  if (action === 'redo') redo();
  if (action === 'regen') {
    const before = snapshot();
    level.seed++;
    pushUndo(before);
    queueBuild(`Regenerated seed ${level.seed}`);
  }
  if (action === 'load') {
    rendering = true;
    setStatus('Loading…');
    try {
      const response = await fetch(`/src/levels/level1.json?t=${Date.now()}`);
      if (!response.ok) throw Error();
      restore(JSON.stringify(await response.json()), 'Reloaded level1.json');
      undoStack.length = redoStack.length = 0;
    } catch {
      rendering = false;
      setStatus('Reload failed');
    }
  }
  if (action === 'save') {
    const body = JSON.stringify(packLevel(level), null, 2) + '\n';
    try {
      const response = await fetch('/__save-level', { method: 'POST', body });
      if (!response.ok) throw Error();
      setStatus('Saved src/levels/level1.json');
    } catch {
      download(body);
      setStatus('Save endpoint unavailable — downloaded JSON');
    }
  }
  if (action === 'download') download(JSON.stringify(packLevel(level), null, 2) + '\n');
  updateControls();
});

function download(body) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  link.download = 'level1.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

window.addEventListener('keydown', event => {
  if (event.code === 'Space') {
    spaceHeld = true;
    event.preventDefault();
  }
  const panKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'];
  if (panKeys.includes(event.code) && !event.target.matches?.('input')) {
    held.add(event.code);
    event.preventDefault();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
  }
  if ('123456789'.includes(event.key)) selectedKind = editorKinds[Number(event.key) - 1];
  const modeKey = { p: 'pencil', r: 'rectangle', f: 'fill', e: 'erase', i: 'inspect' }[event.key.toLowerCase()];
  if (modeKey) selectedMode = modeKey;
  if (event.key === 'Escape') targetBand = 'auto';
  if (event.key === '[' || event.key === ']') sizeInput.value = String(Math.max(1, Math.min(5,
    Number(sizeInput.value) + (event.key === '[' ? -1 : 1))));
  updateControls();
});
window.addEventListener('keyup', event => {
  if (event.code === 'Space') spaceHeld = false;
  held.delete(event.code);
});
window.addEventListener('blur', () => {
  spaceHeld = false;
  held.clear();
  if (activePointer !== null) finishGesture(true);
});
window.addEventListener('resize', resize);

function drawCollision(bounds) {
  if (!collisionToggle.checked) return;
  const size = level.cell;
  const x0 = Math.max(0, Math.floor(bounds.left / size));
  const y0 = Math.max(0, Math.floor(bounds.top / size));
  const x1 = Math.min(level.collisionWidth, Math.ceil(bounds.right / size));
  const y1 = Math.min(level.collisionHeight, Math.ceil(bounds.bottom / size));
  context.globalAlpha = 0.38;
  context.fillStyle = colours.collision;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (collisionAt(level, x, y)) {
    context.fillRect(x * size, y * size, size, size);
  }
  context.globalAlpha = 1;
}

function selectedInStack(stack) {
  if (selectedKind === 'wall' || selectedKind === 'stairs') return stack.includes(selectedKind === 'wall' ? '#' : '^');
  const code = { grass: 'g', dirt: 'd', water: 'w', floor: 'f', bushes: 'b', stones: 's' }[selectedKind];
  const band = targetBand === 'auto' ? (structureIndex(stack) < 0 ? 'ground' : 'upper') : targetBand;
  return bandEntries(stack, band).includes(code);
}

function drawSelectedMaterial(bounds) {
  if (selectedKind === 'collision') return;
  const x0 = Math.max(0, Math.floor(bounds.left / AUTHOR_TILE));
  const y0 = Math.max(0, Math.floor(bounds.top / AUTHOR_TILE));
  const x1 = Math.min(level.tileWidth, Math.ceil(bounds.right / AUTHOR_TILE));
  const y1 = Math.min(level.tileHeight, Math.ceil(bounds.bottom / AUTHOR_TILE));
  context.globalAlpha = 0.09;
  context.fillStyle = colours[selectedKind];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (selectedInStack(stackAt(level, x, y))) {
    context.fillRect(x * AUTHOR_TILE, y * AUTHOR_TILE, AUTHOR_TILE, AUTHOR_TILE);
  }
  context.globalAlpha = 1;
}

function drawPending() {
  for (const cell of pendingCells.values()) {
    context.globalAlpha = cell.erasing ? 0.48 : 0.32;
    context.fillStyle = cell.erasing ? '#ff315a' : colours[cell.kind];
    context.fillRect(cell.x * cell.size, cell.y * cell.size, cell.size, cell.size);
  }
  context.globalAlpha = 1;
}

function drawGrid(bounds, dpr) {
  if (!gridToggle.checked) return;
  const size = painting ? gestureSize : gridSize();
  const fine = size === level.cell;
  if (fine && camera.zoom < 0.45) return;
  const x0 = Math.max(0, Math.floor(bounds.left / size) * size);
  const y0 = Math.max(0, Math.floor(bounds.top / size) * size);
  const x1 = Math.min(level.width, Math.ceil(bounds.right / size) * size);
  const y1 = Math.min(level.height, Math.ceil(bounds.bottom / size) * size);
  context.beginPath();
  for (let x = x0; x <= x1; x += size) { context.moveTo(x, y0); context.lineTo(x, y1); }
  for (let y = y0; y <= y1; y += size) { context.moveTo(x0, y); context.lineTo(x1, y); }
  context.globalAlpha = fine ? 0.34 : 0.22;
  context.strokeStyle = fine ? '#ff6a82' : '#fff3d2';
  context.lineWidth = 1 / (dpr * camera.zoom);
  context.stroke();
  context.globalAlpha = 1;
}

function drawInspectedTile() {
  if (!inspectorCell) return;
  context.strokeStyle = '#62b8ed';
  context.lineWidth = 3 / camera.zoom;
  context.strokeRect(inspectorCell.x * AUTHOR_TILE, inspectorCell.y * AUTHOR_TILE, AUTHOR_TILE, AUTHOR_TILE);
}

function drawCursor() {
  if (!pointerWorld || panning || rendering) return;
  const mode = painting ? gestureMode : selectedMode;
  const kind = painting ? gestureKind : selectedKind;
  const size = mode === 'inspect' ? AUTHOR_TILE : painting ? gestureSize : gridSize();
  const cell = cellAt(pointerWorld, size);
  if (!cell) return;
  let x0 = cell.x;
  let y0 = cell.y;
  let x1 = cell.x;
  let y1 = cell.y;
  if (painting && mode === 'rectangle' && startCell && rectangleCell) {
    x0 = Math.min(startCell.x, rectangleCell.x);
    y0 = Math.min(startCell.y, rectangleCell.y);
    x1 = Math.max(startCell.x, rectangleCell.x);
    y1 = Math.max(startCell.y, rectangleCell.y);
  } else {
    const brush = mode === 'fill' || mode === 'inspect' ? 1 : Number(sizeInput.value);
    const offset = Math.floor((brush - 1) / 2);
    x0 -= offset;
    y0 -= offset;
    x1 = x0 + brush - 1;
    y1 = y0 + brush - 1;
  }
  const erasing = mode === 'erase' || painting && eraseStroke;
  context.globalAlpha = 0.18;
  context.fillStyle = mode === 'inspect' ? '#62b8ed' : erasing ? '#ff315a' : colours[kind];
  context.fillRect(x0 * size, y0 * size, (x1 - x0 + 1) * size, (y1 - y0 + 1) * size);
  context.globalAlpha = 0.9;
  context.strokeStyle = mode === 'inspect' ? '#62b8ed' : erasing ? '#ff315a' : '#fff3a6';
  context.lineWidth = 2 / camera.zoom;
  context.strokeRect(x0 * size, y0 * size, (x1 - x0 + 1) * size, (y1 - y0 + 1) * size);
  context.globalAlpha = 1;
}

function frame(time) {
  const dt = Math.min((time - lastFrameTime) / 1000, 0.05);
  lastFrameTime = time;
  const panX = (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
  const panY = (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0) - (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0);
  if (panX || panY) {
    const length = Math.hypot(panX, panY);
    const distance = 560 * dt / camera.zoom;
    camera.x = Math.max(0, Math.min(level.width, camera.x + panX / length * distance));
    camera.y = Math.max(0, Math.min(level.height, camera.y + panY / length * distance));
    pointerWorld = null;
  }
  const dpr = devicePixelRatio || 1;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = '#101a2c';
  context.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  context.setTransform(
    dpr * camera.zoom, 0, 0, dpr * camera.zoom,
    Math.round((canvas.clientWidth / 2 - camera.x * camera.zoom) * dpr),
    Math.round((canvas.clientHeight / 2 - camera.y * camera.zoom) * dpr),
  );
  const bounds = viewBounds();
  drawTerrain(context, terrain, bounds);
  drawSelectedMaterial(bounds);
  drawCollision(bounds);
  drawPending();
  drawGrid(bounds, dpr);
  drawInspectedTile();
  drawCursor();
  requestAnimationFrame(frame);
}

resize();
updateControls();
requestAnimationFrame(frame);
