import levelSource from './levels/level1.json';
import {
  AUTHOR_TILE,
  TERRAIN_KINDS,
  buildTerrain,
  drawTerrain,
  gridAt,
  maskAt,
  noiseAt,
  packLevel,
  paintGridCell,
  paintGridRect,
  paintNoiseCell,
  paintNoiseRect,
  unpackLevel,
} from './terrain.js';

const canvas = document.querySelector('#editor-canvas');
const context = canvas.getContext('2d');
const sizeInput = document.querySelector('#editor-size');
const sizeValue = document.querySelector('#editor-size-value');
const gridToggle = document.querySelector('#editor-grid');
const collisionToggle = document.querySelector('#editor-collision');
const seedLabel = document.querySelector('#editor-seed');
const status = document.querySelector('#editor-status');
const inspectorCoordinates = document.querySelector('#editor-inspector-coordinates');
const inspectorEmpty = document.querySelector('#editor-inspector-empty');
const inspectorLayers = document.querySelector('#editor-inspector-layers');
const layerColours = {
  grass: '#68d48b', dirt: '#b98962', water: '#62b8ed', stones: '#dbe0ca',
  ruins: '#fff3a6', bushes: '#469a45', collision: '#ff315a', noise: '#f06cff',
};
const noiseColours = ['#718096', '#62b8ed', '#b8cc62', '#f5b642', '#ff5a87'];
const noiseLabels = ['None', 'Low', 'Medium', 'High', 'Extreme'];

let level = unpackLevel(levelSource);
let terrain = buildTerrain(level);
let selectedKind = 'grass';
let selectedMode = 'pencil';
let selectedNoise = 3;
let pointerWorld = null;
let activePointer = null;
let painting = false;
let panning = false;
let rendering = false;
let spaceHeld = false;
let eraseStroke = false;
let strokeBefore = '';
let startCell = null;
let lastCell = null;
let rectangleCell = null;
let inspectorCell = null;
let lastPan = null;
let buildVersion = 0;
let lastFrameTime = performance.now();
const pendingCells = new Map();
const undoStack = [];
const held = new Set();
const redoStack = [];
const camera = { x: level.width / 2, y: level.height / 2, zoom: 0.55 };

const snapshot = () => JSON.stringify(packLevel(level));
const setStatus = message => { status.textContent = message; };
const gridSize = () => selectedMode === 'inspect'
  ? AUTHOR_TILE
  : selectedKind === 'collision' ? level.cell : AUTHOR_TILE;
const gridWidth = size => Math.ceil(level.width / size);
const gridHeight = size => Math.ceil(level.height / size);

function updateControls() {
  document.querySelectorAll('[data-kind]').forEach(button => {
    button.classList.toggle('is-active', button.dataset.kind === selectedKind);
  });
  document.querySelectorAll('[data-mode]').forEach(button => {
    button.classList.toggle('is-active', button.dataset.mode === selectedMode);
  });
  document.querySelectorAll('[data-noise]').forEach(button => {
    button.classList.toggle('is-active', Number(button.dataset.noise) === selectedNoise);
  });
  sizeValue.value = sizeInput.value;
  seedLabel.textContent = level.seed;
  updateInspector();
}

const inspectOrder = ['noise', 'collision', 'water', 'stones', 'bushes', 'ruins', 'dirt', 'grass'];
const inspectLabels = { noise: 'Noise', collision: 'Collision', water: 'Water', stones: 'Stones', bushes: 'Bushes', ruins: 'Floor', dirt: 'Dirt', grass: 'Grass' };

function layerCellCount(kind) {
  if (!inspectorCell) return 0;
  if (kind === 'noise') return noiseAt(level, inspectorCell.x, inspectorCell.y);
  let count = 0;
  const startX = inspectorCell.x * AUTHOR_TILE;
  const startY = inspectorCell.y * AUTHOR_TILE;
  for (let y = 4; y < AUTHOR_TILE; y += level.cell) for (let x = 4; x < AUTHOR_TILE; x += level.cell) {
    count += maskAt(level, kind, startX + x, startY + y);
  }
  return count;
}

function updateInspector() {
  inspectorLayers.replaceChildren();
  inspectorEmpty.hidden = !!inspectorCell;
  inspectorCoordinates.textContent = inspectorCell ? `${inspectorCell.x}, ${inspectorCell.y}` : '—';
  if (!inspectorCell) return;
  const counts = Object.fromEntries(inspectOrder.map(kind => [kind, layerCellCount(kind)]));
  const hasWater = counts.water > 0;
  const hasFloor = counts.ruins > 0;
  const hasDirt = counts.dirt > 0;
  const hasLand = hasFloor || hasDirt || counts.grass > 0;
  for (const kind of inspectOrder) {
    const count = counts[kind];
    let state = kind === 'noise' ? noiseLabels[count] : 'Empty';
    if (count || kind === 'noise') {
      if (kind === 'noise') state = noiseLabels[count];
      else if (kind === 'collision') state = `${count}/16 blocking`;
      else if (kind === 'water') state = 'Visible cutout';
      else if (kind === 'stones' || kind === 'bushes') state = hasWater ? 'Hidden by water' : hasLand ? 'Visible' : 'Needs land';
      else if (kind === 'ruins') state = hasWater ? 'Hidden by water' : 'Visible';
      else if (kind === 'dirt') state = hasWater ? 'Hidden by water' : hasFloor ? 'Hidden by floor' : 'Visible';
      else state = hasWater ? 'Hidden by water' : hasFloor ? 'Hidden by floor' : hasDirt ? 'Hidden by dirt' : 'Visible';
    }
    const row = document.createElement('div');
    row.className = `editor__inspector-layer${count || kind === 'noise' ? ' is-present' : ''}`;
    const select = document.createElement('button');
    select.className = 'editor__inspector-select';
    select.dataset.inspectAction = 'select';
    select.dataset.inspectKind = kind;
    select.textContent = inspectLabels[kind];
    const description = document.createElement('span');
    description.className = 'editor__inspector-state';
    description.textContent = state;
    const clear = document.createElement('button');
    clear.className = 'editor__inspector-clear';
    clear.dataset.inspectAction = 'clear';
    clear.dataset.inspectKind = kind;
    clear.textContent = '×';
    clear.title = `Clear ${inspectLabels[kind]} from this tile`;
    clear.disabled = kind === 'noise' ? count === 0 : !count;
    row.append(select, description, clear);
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
  // Two frames let the semantic overlay/status reach screen before the costly bake.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (version !== buildVersion) return;
    terrain = buildTerrain(level, terrain.scale, terrain.canvas);
    pendingCells.clear();
    rendering = false;
    setStatus(message);
  }));
}

function markPending(x, y, size, value, erasing = false) {
  pendingCells.set(`${size}:${x}:${y}`, { x, y, size, value, kind: selectedKind, erasing });
}

function paintCell(x, y, value, size = gridSize()) {
  const finalValue = selectedKind === 'noise' ? value ? selectedNoise : 0 : value;
  const changed = selectedKind === 'noise'
    ? paintNoiseCell(level, x, y, finalValue)
    : paintGridCell(level, selectedKind, x, y, finalValue, size);
  if (changed) markPending(x, y, size, finalValue, !value);
  return changed;
}

function paintDab(cell, value) {
  const brush = Number(sizeInput.value);
  const offset = Math.floor((brush - 1) / 2);
  let changed = false;
  for (let y = 0; y < brush; y++) for (let x = 0; x < brush; x++) {
    changed = paintCell(cell.x + x - offset, cell.y + y - offset, value) || changed;
  }
  return changed;
}

/** Integer cell traversal keeps fast pointer drags gap-free. */
function paintLine(from, to, value) {
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - x);
  const dy = -Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1;
  const sy = y < to.y ? 1 : -1;
  let error = dx + dy;
  while (true) {
    paintDab({ x, y }, value);
    if (x === to.x && y === to.y) break;
    const twice = error * 2;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
}

function flood(cell, value) {
  const size = gridSize();
  const width = gridWidth(size);
  const height = gridHeight(size);
  const target = selectedKind === 'noise'
    ? noiseAt(level, cell.x, cell.y)
    : gridAt(level, selectedKind, cell.x, cell.y, size);
  const finalValue = selectedKind === 'noise' && value ? selectedNoise : value;
  if (target === finalValue) return false;
  const visited = new Uint8Array(width * height);
  const stack = [cell.x, cell.y];
  let changed = false;
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const index = y * width + x;
    const current = selectedKind === 'noise'
      ? noiseAt(level, x, y)
      : gridAt(level, selectedKind, x, y, size);
    if (visited[index] || current !== target) continue;
    visited[index] = 1;
    changed = paintCell(x, y, value, size) || changed;
    stack.push(x - 1, y, x + 1, y, x, y - 1, x, y + 1);
  }
  return changed;
}

function pushUndo(before) {
  const after = snapshot();
  if (after === before) return false;
  undoStack.push(before);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  return true;
}

function finishGesture(commit = true) {
  if (panning) {
    panning = false;
  } else if (painting) {
    if (selectedMode === 'rectangle' && commit && startCell && rectangleCell) {
      const size = gridSize();
      const value = eraseStroke ? 0 : 1;
      const finalValue = selectedKind === 'noise' && value ? selectedNoise : value;
      const changed = selectedKind === 'noise'
        ? paintNoiseRect(level, startCell.x, startCell.y, rectangleCell.x, rectangleCell.y, finalValue)
        : paintGridRect(level, selectedKind, startCell.x, startCell.y,
          rectangleCell.x, rectangleCell.y, finalValue, size);
      if (changed) for (let y = Math.min(startCell.y, rectangleCell.y); y <= Math.max(startCell.y, rectangleCell.y); y++) {
        for (let x = Math.min(startCell.x, rectangleCell.x); x <= Math.max(startCell.x, rectangleCell.x); x++) {
          markPending(x, y, size, finalValue, !value);
        }
      }
    }
    if (!commit) {
      level = unpackLevel(JSON.parse(strokeBefore));
      pendingCells.clear();
    } else if (pushUndo(strokeBefore)) {
      updateInspector();
      queueBuild('Ready');
    } else pendingCells.clear();
    painting = false;
  }
  const pointer = activePointer;
  activePointer = null;
  if (pointer !== null && canvas.hasPointerCapture?.(pointer)) canvas.releasePointerCapture(pointer);
  startCell = lastCell = rectangleCell = lastPan = null;
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
  const cell = cellAt(pointerWorld);
  if (!cell) return;
  event.preventDefault();
  if (selectedMode === 'inspect') {
    if (event.button === 0) {
      inspectorCell = cell;
      updateInspector();
    }
    return;
  }
  activePointer = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  painting = true;
  eraseStroke = event.button === 2 || selectedMode === 'erase';
  strokeBefore = snapshot();
  startCell = lastCell = rectangleCell = cell;
  if (selectedMode === 'fill') {
    flood(cell, eraseStroke ? 0 : 1);
    finishGesture(true);
  } else if (selectedMode !== 'rectangle') {
    paintDab(cell, eraseStroke ? 0 : 1);
  }
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
  const cell = cellAt(pointerWorld);
  if (!cell) return;
  if (selectedMode === 'rectangle') rectangleCell = cell;
  else if (selectedMode !== 'fill' && (cell.x !== lastCell.x || cell.y !== lastCell.y)) {
    paintLine(lastCell, cell, eraseStroke ? 0 : 1);
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

document.querySelector('.editor__panel').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || rendering) return;
  const inspectAction = button.dataset.inspectAction;
  if (inspectAction === 'select') {
    selectedKind = button.dataset.inspectKind;
    selectedMode = 'pencil';
    updateControls();
    return;
  }
  if (inspectAction === 'clear' && inspectorCell) {
    const before = snapshot();
    const kind = button.dataset.inspectKind;
    const changed = kind === 'noise'
      ? paintNoiseCell(level, inspectorCell.x, inspectorCell.y, 0)
      : paintGridCell(level, kind, inspectorCell.x, inspectorCell.y, 0, AUTHOR_TILE);
    if (changed) {
      pushUndo(before);
      updateInspector();
      queueBuild(`Cleared ${inspectLabels[kind]}`);
    }
    return;
  }
  if (button.dataset.kind) selectedKind = button.dataset.kind;
  if (button.dataset.mode) selectedMode = button.dataset.mode;
  if (button.dataset.noise !== undefined) {
    selectedNoise = Number(button.dataset.noise);
    selectedKind = 'noise';
    if (selectedMode === 'inspect' && inspectorCell) {
      const before = snapshot();
      if (paintNoiseCell(level, inspectorCell.x, inspectorCell.y, selectedNoise)) {
        pushUndo(before);
        updateInspector();
        queueBuild(`Set noise to ${noiseLabels[selectedNoise]}`);
      }
    }
  }
  const action = button.dataset.action;
  if (action === 'undo') undo();
  if (action === 'redo') redo();
  if (action === 'regen') {
    const before = snapshot();
    level.seed++;
    undoStack.push(before);
    redoStack.length = 0;
    queueBuild(`Regenerated seed ${level.seed}`);
  }
  if (action === 'load') {
    rendering = true;
    setStatus('Loading…');
    try {
      const response = await fetch(`/src/levels/level1.json?t=${Date.now()}`);
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
  if ('12345678'.includes(event.key)) {
    selectedKind = Number(event.key) === 8 ? 'noise' : TERRAIN_KINDS[Number(event.key) - 1];
  }
  const modeKey = { p: 'pencil', r: 'rectangle', f: 'fill', e: 'erase', i: 'inspect' }[event.key.toLowerCase()];
  if (modeKey) selectedMode = modeKey;
  if (event.key === '[' || event.key === ']') {
    sizeInput.value = String(Math.max(1, Math.min(5,
      Number(sizeInput.value) + (event.key === '[' ? -1 : 1))));
  }
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
  const cell = level.cell;
  const x0 = Math.max(0, Math.floor(bounds.left / cell));
  const y0 = Math.max(0, Math.floor(bounds.top / cell));
  const x1 = Math.min(level.gridWidth, Math.ceil(bounds.right / cell));
  const y1 = Math.min(level.gridHeight, Math.ceil(bounds.bottom / cell));
  context.globalAlpha = 0.38;
  context.fillStyle = '#ff315a';
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (maskAt(level, 'collision', (x + 0.5) * cell, (y + 0.5) * cell)) {
      context.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  context.globalAlpha = 1;
}

function drawSelectedLayer(bounds) {
  if (selectedKind === 'collision') return;
  const size = AUTHOR_TILE;
  const x0 = Math.max(0, Math.floor(bounds.left / size));
  const y0 = Math.max(0, Math.floor(bounds.top / size));
  const x1 = Math.min(gridWidth(size), Math.ceil(bounds.right / size));
  const y1 = Math.min(gridHeight(size), Math.ceil(bounds.bottom / size));
  if (selectedKind === 'noise') {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const value = noiseAt(level, x, y);
      context.globalAlpha = [0.16, 0.04, 0.12, 0.17, 0.22][value];
      context.fillStyle = noiseColours[value];
      context.fillRect(x * size, y * size, size, size);
    }
  } else {
    context.globalAlpha = 0.07;
    context.fillStyle = layerColours[selectedKind];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (gridAt(level, selectedKind, x, y, size)) context.fillRect(x * size, y * size, size, size);
    }
  }
  context.globalAlpha = 1;
}

function drawPending() {
  for (const cell of pendingCells.values()) {
    context.globalAlpha = cell.kind === 'noise' ? 0.4 : cell.value ? 0.34 : 0.5;
    context.fillStyle = cell.kind === 'noise'
      ? noiseColours[cell.value]
      : cell.erasing ? '#ff315a' : layerColours[cell.kind];
    context.fillRect(cell.x * cell.size, cell.y * cell.size, cell.size, cell.size);
  }
  context.globalAlpha = 1;
}

function drawGrid(bounds, dpr) {
  if (!gridToggle.checked) return;
  const size = gridSize();
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
  const size = gridSize();
  const cell = cellAt(pointerWorld, size);
  if (!cell) return;
  let x0 = cell.x;
  let y0 = cell.y;
  let x1 = cell.x;
  let y1 = cell.y;
  if (painting && selectedMode === 'rectangle' && startCell && rectangleCell) {
    x0 = Math.min(startCell.x, rectangleCell.x);
    y0 = Math.min(startCell.y, rectangleCell.y);
    x1 = Math.max(startCell.x, rectangleCell.x);
    y1 = Math.max(startCell.y, rectangleCell.y);
  } else {
    const brush = selectedMode === 'fill' || selectedMode === 'inspect' ? 1 : Number(sizeInput.value);
    const offset = Math.floor((brush - 1) / 2);
    x0 -= offset;
    y0 -= offset;
    x1 = x0 + brush - 1;
    y1 = y0 + brush - 1;
  }
  context.globalAlpha = 0.18;
  context.fillStyle = selectedMode === 'inspect'
    ? '#62b8ed'
    : selectedMode === 'erase' || painting && eraseStroke ? '#ff315a'
      : selectedKind === 'noise' ? noiseColours[selectedNoise] : layerColours[selectedKind];
  context.fillRect(x0 * size, y0 * size, (x1 - x0 + 1) * size, (y1 - y0 + 1) * size);
  context.globalAlpha = 0.9;
  context.strokeStyle = selectedMode === 'inspect'
    ? '#62b8ed'
    : selectedMode === 'erase' || painting && eraseStroke ? '#ff315a' : '#fff3a6';
  context.lineWidth = 2 / camera.zoom;
  context.strokeRect(x0 * size, y0 * size, (x1 - x0 + 1) * size, (y1 - y0 + 1) * size);
  context.globalAlpha = 1;
}

function frame(time) {
  const dt = Math.min((time - lastFrameTime) / 1000, 0.05);
  lastFrameTime = time;
  const panX = (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0)
    - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
  const panY = (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0)
    - (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0);
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
  drawSelectedLayer(bounds);
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
