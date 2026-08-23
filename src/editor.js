import levelSource from './levels/level1.json';
import {
  TERRAIN_KINDS,
  buildTerrain,
  drawTerrain,
  maskAt,
  packLevel,
  paintCircle,
  unpackLevel,
} from './terrain.js';

const canvas = document.querySelector('#editor-canvas');
const context = canvas.getContext('2d');
const radiusInput = document.querySelector('#editor-radius');
const radiusValue = document.querySelector('#editor-radius-value');
const collisionToggle = document.querySelector('#editor-collision');
const seedLabel = document.querySelector('#editor-seed');
const status = document.querySelector('#editor-status');

let level = unpackLevel(levelSource);
let terrain = buildTerrain(level);
let selectedKind = 'grass';
let eraseSelected = false;
let pointerWorld = null;
let activePointer = null;
let painting = false;
let panning = false;
let spaceHeld = false;
let strokeBefore = '';
let lastPaint = null;
let lastPan = null;
let dirtyTerrain = false;
let lastBuild = performance.now();
const undoStack = [];
const redoStack = [];
const camera = { x: level.width / 2, y: level.height / 2, zoom: 0.55 };

const snapshot = () => JSON.stringify(packLevel(level));
const setStatus = message => { status.textContent = message; };

function updateControls() {
  document.querySelectorAll('[data-kind]').forEach(button => {
    button.classList.toggle('is-active', !eraseSelected && button.dataset.kind === selectedKind);
  });
  document.querySelector('[data-action="erase"]').classList.toggle('is-active', eraseSelected);
  radiusValue.value = radiusInput.value;
  seedLabel.textContent = level.seed;
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

function scheduleBuild() {
  dirtyTerrain = true;
}

function rebuildTerrain() {
  terrain = buildTerrain(level);
  dirtyTerrain = false;
  lastBuild = performance.now();
}

function paintDab(x, y, erase) {
  const radius = Number(radiusInput.value);
  let changed = paintCircle(level, selectedKind, x, y, radius, erase ? 0 : 1);
  // Scatter brushes describe decoration, not ground. Supplying grass beneath a
  // fresh stroke keeps their output visible and walkable without another tool pass.
  if (!erase && (selectedKind === 'stones' || selectedKind === 'ruins')) {
    changed = paintCircle(level, 'grass', x, y, radius, 1) || changed;
  }
  if (changed && selectedKind !== 'collision') scheduleBuild();
  return changed;
}

function paintTo(point, erase) {
  if (!lastPaint) {
    paintDab(point.x, point.y, erase);
    lastPaint = point;
    return;
  }
  const dx = point.x - lastPaint.x;
  const dy = point.y - lastPaint.y;
  const distance = Math.hypot(dx, dy);
  const spacing = Math.max(level.cell / 2, Number(radiusInput.value) * 0.28);
  const steps = Math.max(1, Math.ceil(distance / spacing));
  for (let i = 1; i <= steps; i++) {
    paintDab(lastPaint.x + dx * i / steps, lastPaint.y + dy * i / steps, erase);
  }
  lastPaint = point;
}

function restore(json) {
  level = unpackLevel(JSON.parse(json));
  rebuildTerrain();
  updateControls();
}

function undo() {
  const before = undoStack.pop();
  if (!before) return;
  redoStack.push(snapshot());
  restore(before);
  setStatus('Undid stroke');
}

function redo() {
  const after = redoStack.pop();
  if (!after) return;
  undoStack.push(snapshot());
  restore(after);
  setStatus('Redid stroke');
}

function endPointer(event) {
  if (activePointer !== event.pointerId) return;
  if (painting) {
    const after = snapshot();
    if (after !== strokeBefore) {
      undoStack.push(strokeBefore);
      if (undoStack.length > 100) undoStack.shift();
      redoStack.length = 0;
    }
  }
  painting = panning = false;
  activePointer = null;
  lastPaint = lastPan = null;
  if (dirtyTerrain) rebuildTerrain();
}

canvas.addEventListener('pointerdown', event => {
  activePointer = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  pointerWorld = eventWorld(event);
  if (event.button === 1 || spaceHeld) {
    panning = true;
    lastPan = { x: event.clientX, y: event.clientY };
    return;
  }
  if (event.button !== 0 && event.button !== 2) return;
  painting = true;
  strokeBefore = snapshot();
  lastPaint = null;
  paintTo(pointerWorld, event.button === 2 || eraseSelected);
});

canvas.addEventListener('pointermove', event => {
  pointerWorld = eventWorld(event);
  if (panning && lastPan) {
    camera.x -= (event.clientX - lastPan.x) / camera.zoom;
    camera.y -= (event.clientY - lastPan.y) / camera.zoom;
    lastPan = { x: event.clientX, y: event.clientY };
  } else if (painting) {
    paintTo(pointerWorld, event.buttons === 2 || eraseSelected);
  }
});
canvas.addEventListener('pointerleave', () => { if (!painting && !panning) pointerWorld = null; });
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', event => event.preventDefault());

canvas.addEventListener('wheel', event => {
  event.preventDefault();
  const before = eventWorld(event);
  camera.zoom = Math.max(0.25, Math.min(3, camera.zoom * Math.exp(-event.deltaY * 0.001)));
  const after = eventWorld(event);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
  pointerWorld = eventWorld(event);
}, { passive: false });

radiusInput.addEventListener('input', updateControls);

document.querySelector('.editor__panel').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.kind) {
    selectedKind = button.dataset.kind;
    eraseSelected = false;
  }
  const action = button.dataset.action;
  if (action === 'erase') eraseSelected = !eraseSelected;
  if (action === 'undo') undo();
  if (action === 'redo') redo();
  if (action === 'regen') {
    const before = snapshot();
    level.seed++;
    undoStack.push(before);
    redoStack.length = 0;
    rebuildTerrain();
    setStatus(`Regenerated seed ${level.seed}`);
  }
  if (action === 'load') {
    try {
      const response = await fetch(`/src/levels/level1.json?t=${Date.now()}`);
      restore(JSON.stringify(await response.json()));
      undoStack.length = redoStack.length = 0;
      setStatus('Reloaded level1.json');
    } catch {
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
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
  }
  if ('123456'.includes(event.key)) {
    selectedKind = TERRAIN_KINDS[Number(event.key) - 1];
    eraseSelected = false;
  }
  if (event.key.toLowerCase() === 'e') eraseSelected = !eraseSelected;
  if (event.key === '[' || event.key === ']') {
    radiusInput.value = String(Math.max(8, Math.min(160,
      Number(radiusInput.value) + (event.key === '[' ? -4 : 4))));
  }
  updateControls();
});
window.addEventListener('keyup', event => { if (event.code === 'Space') spaceHeld = false; });
window.addEventListener('resize', resize);

function drawCollision(bounds) {
  if (!collisionToggle.checked) return;
  const cell = level.cell;
  const x0 = Math.max(0, Math.floor(bounds.left / cell));
  const y0 = Math.max(0, Math.floor(bounds.top / cell));
  const x1 = Math.min(level.gridWidth, Math.ceil(bounds.right / cell));
  const y1 = Math.min(level.gridHeight, Math.ceil(bounds.bottom / cell));
  context.globalAlpha = 0.42;
  context.fillStyle = '#ff315a';
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (maskAt(level, 'collision', (x + 0.5) * cell, (y + 0.5) * cell)) {
      context.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  context.globalAlpha = 1;
}

function frame(time) {
  if (dirtyTerrain && (!painting || time - lastBuild > 180)) rebuildTerrain();
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
  drawTerrain(context, terrain, bounds, time / 1000);
  drawCollision(bounds);
  if (pointerWorld) {
    context.strokeStyle = eraseSelected ? '#ff315a' : '#fff3a6';
    context.lineWidth = 2 / camera.zoom;
    context.beginPath();
    context.arc(pointerWorld.x, pointerWorld.y, Number(radiusInput.value), 0, Math.PI * 2);
    context.stroke();
  }
  requestAnimationFrame(frame);
}

resize();
updateControls();
requestAnimationFrame(frame);
