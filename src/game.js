import unicornUrl from './assets/unicorn.png';

(() => {
'use strict';

// ============================================================
// DOM references
// ============================================================

const canvas = document.querySelector('#c');
const screenCtx = canvas.getContext('2d');
const hud = document.querySelector('#hud');
const coinEdge = document.querySelector('#coin-edge');
const coinFace = document.querySelector('#coin-face');
const coinGlint = document.querySelector('#coin-glint');
const hudMoney = document.querySelector('#hud-money');
const hudDistance = document.querySelector('#hud-distance');
const hudUpgrade = document.querySelector('#hud-upgrade');
const hudUpgradeText = document.querySelector('#hud-upgrade-text');
const upgradeMenu = document.querySelector('#upgrade-menu');
const upgradeTitle = document.querySelector('#upgrade-title');
const upgradeBio = document.querySelector('#upgrade-bio');
const upgradeClose = document.querySelector('#upgrade-close');
const upgradeList = document.querySelector('#upgrade-list');
const upgradeMoney = document.querySelector('#upgrade-money');
const upgradeChase = document.querySelector('#upgrade-chase');

// The world is real pixel art: everything is drawn as whole pixels into
// this low-res buffer (1 unit = 1 chunky pixel), then blitted to the
// screen at an integer scale with smoothing off. No gradients, no
// antialiased curves, no glows — just palette colours on a grid, exactly
// like the unicorn sprite.
const worldBuffer = document.createElement('canvas');
const ctx = worldBuffer.getContext('2d');

// The ground never moves, so it's prerendered here once per resize.
const planetLayer = document.createElement('canvas');

// The rainbow is a fixed focal anchor. Its arch is prerendered with the foot
// at the layer's left edge and baseline at the bottom, then planted beside
// the safely positioned pot group.
const rainbowLayer = document.createElement('canvas');
let rbRadius = 0, rbBandW = 0, rbThickness = 0;

// The sky, the sun's disc and the cloud shapes are static too, so they're
// prerendered per resize — which makes dithered colour transitions (the
// pixel-art stand-in for gradients) affordable everywhere.
const skyLayer = document.createElement('canvas');
const sunLayer = document.createElement('canvas');
let sunR = 0;
let cloudLayers = [];
let hillLayers = [];

// ============================================================
// Tunables
// ============================================================

const FOCAL_INSET_MIN = 0.15;
const FOCAL_INSET_MAX = 0.25;
const FOCAL_INSET_MIN_WIDTH = 360;
const FOCAL_INSET_MAX_WIDTH = 1440;
const FOCAL_MARGIN = 2;          // safety margin in world pixels
const APPROACH_LEVELS = 20;      // balance tunable: upgrades needed for full approach
const APPROACH_GAP = 5;          // world pixels between unicorn and pot at 100%
const RAINBOW_CHASE = 204;       // abstract chase remaining before any approach upgrades
const MAX_STUBBORN = 10;

const UPGRADE_COSTS = {
  speed:    level => Math.floor(8  * Math.pow(1.55, level)),
  magnet:   level => Math.floor(10 * Math.pow(1.62, level)),
  luck:     level => Math.floor(14 * Math.pow(1.7,  level)),
  stubborn: level => Math.floor(20 * Math.pow(1.8,  level)),
};
const UNICORN_PROFILES = [
  ['Starlight', 'Collects wishes and shiny things.'],
  ['Moonbeam', 'Powered by moonlight and marshmallows.'],
  ['Sparklehoof', 'Leaves a little magic everywhere.'],
  ['Glitterbell', 'Never met a rainbow she could not chase.'],
  ['Princess Twinkle', 'Royal, radiant, and ready to gallop.'],
];
const unicornProfile = UNICORN_PROFILES[Math.random() * UNICORN_PROFILES.length | 0];
upgradeTitle.textContent = unicornProfile[0];
upgradeBio.textContent = unicornProfile[1];

const RAINBOW_COLOURS = ['#f66f93', '#f6a453', '#ffe477', '#73d584', '#59abea', '#8170df', '#bd72d9'];
const RAINBOW_SHADOWS = ['#dd5e82', '#df8d47', '#e7cb65', '#61bd73', '#4995d3', '#6f5fc8', '#a45fc2'];
const SUN_RAYS = [
  [[1, 0], [3, 1], [2, 1], [1, 1], [1, 2], [1, 3], [0, 1]],
  [[1, 0], [3, 1], [1, 1], [1, 3], [0, 1]],
  [[2, 0], [3, 1], [2, 1], [2, 2], [1, 2], [1, 3], [0, 2]],
];
const TREE_PALETTES = [
  ['#ffb8bd', '#ed8f99'], ['#ffd0a2', '#e8ac78'], ['#ffe99e', '#e2c66c'],
  ['#b6f0c8', '#93dcae'], ['#a9d7f2', '#84b9d9'], ['#bdc8fa', '#9ba8df'],
  ['#d9c8ff', '#bfa9ef'],
];
// The world is authored on a 3px grid. Landscape scenes use a 4× integer
// crop for a closer view; portrait and square scenes show the full 3× world.
const PIXEL_SIZE = 3;
const VIEW_PIXEL_SIZE = 4;
const CAMERA_X = 0.47;
const CAMERA_Y = 0.62;

// Unicorn spritesheet: 5 columns × 3 rows of 16×16 frames.
// Rows top to bottom: idle, move, fly.
const SPRITE_FRAME = 16;
const SPRITE_FRAMES = 5;
const SPRITE_ROW = { idle: 0, move: 1, fly: 2 };
const WALK_FPS = 10;

const unicornSprite = new Image();
unicornSprite.src = unicornUrl;

// Built from the sheet once it loads: each frame re-padded into an 18×18
// cell with a 1px dark outline baked around its silhouette, so the unicorn
// reads clearly against the pastel world.
let unicornSheet = null;
const SPRITE_CELL = SPRITE_FRAME + 2;
unicornSprite.onload = () => { unicornSheet = buildOutlinedSheet(unicornSprite); };

// Every offscreen surface in the game is a pixel canvas that gets sized and
// then drawn into, and setting either dimension is also how a layer is
// cleared before a re-render — so sizing and grabbing the context are one
// step. Pass an existing canvas to resize it in place.
function sized(w, h, canvas = document.createElement('canvas')) {
  canvas.width = w;
  canvas.height = h;
  return [canvas, canvas.getContext('2d')];
}

// A dark halo stamped around a sprite's silhouette so it reads against the
// pastel world. `pad` grows the canvas to make room for the halo; the unicorn
// sheet passes 0 because its frames are already padded into roomy cells and a
// larger canvas would shift every frame's origin.
function outlined(src, pad = 1) {
  const [silhouette, sg] = sized(src.width, src.height);
  sg.drawImage(src, 0, 0);
  sg.globalCompositeOperation = 'source-in';
  sg.fillStyle = '#7d5f94';
  sg.fillRect(0, 0, src.width, src.height);

  const [out, og] = sized(src.width + pad * 2, src.height + pad * 2);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
    og.drawImage(silhouette, pad + dx, pad + dy);
  og.drawImage(src, pad, pad);
  return out;
}

function buildOutlinedSheet(img) {
  const cols = SPRITE_FRAMES, rows = 3;

  // Copy each 16×16 frame into an 18×18 cell so outlines can't bleed
  // into neighbouring frames
  const [padded, pg] = sized(cols * SPRITE_CELL, rows * SPRITE_CELL);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      pg.drawImage(img, c * SPRITE_FRAME, r * SPRITE_FRAME, SPRITE_FRAME, SPRITE_FRAME,
                   c * SPRITE_CELL + 1, r * SPRITE_CELL + 1, SPRITE_FRAME, SPRITE_FRAME);
    }
  }
  return outlined(padded, 0);
}

// Build a tiny sprite from rows of palette characters ('.' = transparent).
// Hand-placed pixels as code — characters cost bytes of text, not assets.
function spriteFromMap(rows, palette) {
  const [c, g] = sized(rows[0].length, rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const colour = palette[row[x]];
      if (colour) {
        g.fillStyle = colour;
        g.fillRect(x, y, 1, 1);
      }
    }
  });
  return c;
}

// The leprechaun, facing the player: hat with buckle, two eyes, orange
// beard framing the face, green coat and buckled belt. Lit from the
// top-left like everything else — each material has a shade tone along
// its right/under edge, just inside the outline.
//
// His arms are set on his hips and never move — that rigid upper body over
// bouncing feet is the whole silhouette of Irish dancing, so the arms live
// in the sprite rather than being animated. The shoulders stay narrow so
// the elbow row is the widest part of him and reads as akimbo, with the
// hands tucked onto the belt. Only the legs below are procedural.
const leprechaunSprite = outlined(spriteFromMap([
  '...hhhhi...',
  '..hhhhhhi..',
  '..hhhhhhi..',
  '..HHyHHHH..',
  '.hhhhhhhhi.',
  '...sssss...',
  '..bsesesb..',
  '..bssssfb..',
  '..bbbbbcc..',
  '...bbbbc...',
  '.gggbbcggd.',
  'gggggggggdd',
  '.sHHyHHHdf.',
  '..gggggd...',
  '..pp...pp..',
  '..kk...kk..',
], {
  h: '#4fc06a',  // hat
  i: '#3d9c55',  // hat shade
  H: '#2c7a44',  // hat band + belt
  y: '#ffd54a',  // buckles
  s: '#ffcf9e',  // face
  f: '#f0b183',  // face shade
  e: '#54385f',  // eyes
  b: '#ff9b4a',  // beard
  c: '#e07f35',  // beard shade
  g: '#3aa057',  // coat
  d: '#2f8749',  // coat shade
  p: '#7a4a2e',  // legs
  k: '#3b3547',  // shoes
}));

// ============================================================
// Game state
// ============================================================

const state = {
  money: 0,
  distance: 0,       // lifetime metres walked
  caught: 0,         // reserved for the future leprechaun/prestige loop
  totalCaught: 0,
  // upgrade levels (reset on prestige)
  speed: 0,
  magnet: 0,
  luck: 0,
  stubborn: 0,
  // permanent prestige bonuses
  metaSpeed: 0,
  metaCoin: 0,
  coinClock: 0,
};

let W = 0, H = 0, dpr = 1;       // screen-space size (CSS pixels)
let bW = 0, bH = 0;              // authored world buffer size
let viewScale = PIXEL_SIZE;      // integer CSS pixels per visible world pixel
let viewX = 0, viewY = 0;        // visible source origin in world pixels
let viewW = 0, viewH = 0;        // visible source size in world pixels
let t = 0;                       // elapsed animation time (s)
let last = performance.now();
let animClock = 0;               // drives the automatic walking frames
let coins = [];
let sparkles = [];

// ============================================================
// Canvas sizing + world geometry
// ============================================================

// The ground is the top of a huge circle (the "planet"), so the world reads
// as a small curved globe. The apex of the hill sits at a fixed fraction of
// the height and the ground drops a bounded amount from the centre to the
// screen edge; the radius is derived from those two constraints, so no
// screen shape lets the hill swallow the viewport.
let planet = { cx: 0, cy: 0, r: 0 };

function updateGeometry() {
  const apexY = H * 0.62;
  const halfW = W / 2;
  const edgeDrop = Math.max(24, Math.min(H * 0.18, W * 0.12));
  // Circle through the apex with the requested drop at the screen edges:
  // r² - halfW² = (r - drop)²  =>  r = (halfW² + drop²) / (2·drop)
  const r = (halfW * halfW + edgeDrop * edgeDrop) / (2 * edgeDrop);
  planet = { cx: W / 2, cy: apexY + r, r };
}

// Ground height in CSS pixels / in world-buffer pixels
function worldY(x) {
  const dx = x - planet.cx;
  return planet.cy - Math.sqrt(Math.max(1, planet.r * planet.r - dx * dx));
}
const toB = v => v / PIXEL_SIZE;
const wyB = x => worldY(x * PIXEL_SIZE) / PIXEL_SIZE;

// View geometry is calculated once per resize and shared by drawing,
// placement and effects. Orientation is the only zoom decision.
function updateView() {
  viewScale = W > H ? VIEW_PIXEL_SIZE : PIXEL_SIZE;
  viewW = Math.min(bW, Math.ceil(W / viewScale));
  viewH = Math.min(bH, Math.ceil(H / viewScale));
  viewX = Math.max(0, Math.min(bW - viewW, Math.round(bW * CAMERA_X - viewW / 2)));
  viewY = Math.max(0, Math.min(bH - viewH, Math.round(bH * CAMERA_Y - viewH * CAMERA_Y)));
}

const visibleXCss = fraction => (viewX + viewW * fraction) * PIXEL_SIZE;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function focalInset() {
  const progress = clamp(
    (W - FOCAL_INSET_MIN_WIDTH) / (FOCAL_INSET_MAX_WIDTH - FOCAL_INSET_MIN_WIDTH),
    0, 1
  );
  return FOCAL_INSET_MIN + (FOCAL_INSET_MAX - FOCAL_INSET_MIN) * progress;
}

function approachProgress() {
  const levels = state.speed + state.magnet + state.luck + state.stubborn;
  return Math.min(1, levels / APPROACH_LEVELS);
}
function chaseRemaining() {
  return Math.max(1, Math.ceil(RAINBOW_CHASE * (1 - approachProgress())));
}

// The complete pot/leprechaun pair is the right-hand anchor. Its actual
// bounds are used so even an extremely narrow pane retains a safety margin.
const POT_GROUP_LEFT = -7;
const POT_GROUP_RIGHT = 3 + leprechaunSprite.width;
function potXCss() {
  const margin = FOCAL_MARGIN * PIXEL_SIZE;
  const visibleLeft = viewX * PIXEL_SIZE + margin;
  const visibleRight = (viewX + viewW) * PIXEL_SIZE - margin;
  const groupCentre = visibleXCss(1 - focalInset());
  const centreOffset = (POT_GROUP_LEFT + POT_GROUP_RIGHT) * PIXEL_SIZE / 2;
  const x = clamp(
    groupCentre - centreOffset,
    visibleLeft - POT_GROUP_LEFT * PIXEL_SIZE,
    visibleRight - POT_GROUP_RIGHT * PIXEL_SIZE
  );
  return Math.round(x / PIXEL_SIZE) * PIXEL_SIZE;
}

// The arch is derived from the fixed pot, never from travel or time.
function rainbowFootCss() {
  return potXCss() - (rbThickness * PIXEL_SIZE) / 2 + PIXEL_SIZE;
}

function unicornStartCss() {
  const halfSprite = SPRITE_CELL / 2;
  const visibleLeft = (viewX + FOCAL_MARGIN + halfSprite) * PIXEL_SIZE;
  const visibleRight = (viewX + viewW - FOCAL_MARGIN - halfSprite) * PIXEL_SIZE;
  return clamp(visibleXCss(focalInset()), visibleLeft, visibleRight);
}

// Upgrade purchases move only the unicorn. At 100% it stops with a small
// deliberate gap; the future leprechaun/prestige event will hook in here.
function unicornXCss() {
  const start = unicornStartCss();
  const target = Math.max(
    start,
    potXCss() - (7 + APPROACH_GAP + SPRITE_CELL / 2) * PIXEL_SIZE
  );
  return start + (target - start) * approachProgress();
}

function resize() {
  // Full device resolution — a capped/fractional backing store makes the
  // browser rescale with smoothing, which shimmers on dithered pixels
  const newDpr = devicePixelRatio || 1;
  const newW = canvas.clientWidth;
  const newH = canvas.clientHeight;
  // ResizeObserver can fire without a real change — skip the rebuild
  if (newW === W && newH === H && newDpr === dpr && worldBuffer.width > 1) return;

  // Preserve in-flight objects in visible space across resize and
  // orientation changes.
  const oldLeft = viewX * PIXEL_SIZE;
  const oldTop = viewY * PIXEL_SIZE;
  const oldWidth = viewW * PIXEL_SIZE;
  const oldHeight = viewH * PIXEL_SIZE;

  dpr = newDpr;
  W = newW;
  H = newH;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  screenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  screenCtx.imageSmoothingEnabled = false; // chunky upscale, not blurry

  bW = Math.max(1, Math.ceil(W / PIXEL_SIZE));
  bH = Math.max(1, Math.ceil(H / PIXEL_SIZE));
  worldBuffer.width = bW;
  worldBuffer.height = bH;
  ctx.imageSmoothingEnabled = false;

  updateView();
  if (oldWidth > 0 && oldHeight > 0) {
    const left = viewX * PIXEL_SIZE;
    const top = viewY * PIXEL_SIZE;
    const fx = viewW * PIXEL_SIZE / oldWidth;
    const fy = viewH * PIXEL_SIZE / oldHeight;
    for (const c of coins) {
      c.x = left + (c.x - oldLeft) * fx;
      c.vx *= fx;
    }
    for (const s of sparkles) {
      s.x = left + (s.x - oldLeft) * fx;
      s.y = top + (s.y - oldTop) * fy;
      s.vx *= fx;
      s.vy *= fy;
    }
  }

  updateGeometry();
  renderSkyLayer();
  renderSunLayer();
  renderCloudLayers();
  renderHillLayers();
  renderPlanetLayer();
  renderRainbowLayer();
}

// One random world per page load, then stable pseudo-random results so
// scrolling scenery never changes colour or shape while it is on screen.
const worldSeed = Math.random() * 9999;
function hash(n) {
  const s = Math.sin((n + worldSeed) * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

// ============================================================
// Entities
// ============================================================

// Coins spill out of the pot: launched up and toward the player, they arc
// under gravity, bounce, then settle at restH above the ground and scroll
// along with the world. `vigour` scales the launch for future burst events.
function spawnCoin(vigour = 1) {
  const potX = potXCss();
  coins.push({
    x: potX + (Math.random() - 0.5) * 10,
    h: 36,                                        // the pot's mouth height
    vx: -(30 + Math.random() * 130) * vigour,
    vh: (130 + Math.random() * 170) * Math.min(vigour, 1.4),
    restH: 6 + Math.random() * 50,
    settled: false,
    phase: Math.random() * Math.PI * 2,
    value: 1 + Math.floor(state.luck / 5),
  });

  // Loose gold chips spray from the rim with each full-sized coin.
  burst(potX, worldY(potX) - 30, 6,
    ['#ffec8a', '#ffd54a', '#e6a817'], 1.15, true);
}

function burst(x, y, count, colours, power = 1, fountain = false) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (70 + Math.random() * (fountain ? 90 : 170)) * power;
    sparkles.push({
      x, y,
      vx: fountain ? (Math.random() - 0.5) * speed : Math.cos(angle) * speed,
      vy: fountain ? -60 - Math.random() * speed : Math.sin(angle) * speed * 0.5 - 110 * power,
      life: 0.65 + Math.random() * 0.75,
      r: fountain ? 2 + Math.random() * 3 : 3 + Math.random() * 6,
      colour: colours[i % colours.length],
      gold: fountain,
    });
  }
}

// ============================================================
// Update
// ============================================================

function update(dt) {
  t += dt;
  animClock += dt * WALK_FPS;

  // --- Automatic incremental movement ---
  const speed = 18 + state.speed * 4.5 + state.metaSpeed * 2;
  const travel = speed * dt;
  state.distance += travel;

  // --- Coin spawning ---
  state.coinClock -= dt;
  if (state.coinClock <= 0) {
    spawnCoin();
    state.coinClock = Math.max(0.16, 0.75 - state.luck * 0.035);
  }

  // --- Coin scrolling, magnetism and collection ---
  const ux = unicornXCss();
  // The pickup point is the unicorn's forward shoulder/muzzle, not a large
  // invisible radius in front of the sprite.
  const collectX = ux + 5 * PIXEL_SIZE;
  const collectY = worldY(ux) - 8 * PIXEL_SIZE;
  const collectRange = 3 * PIXEL_SIZE;
  const magnetRange = 38 + state.magnet * 17;

  for (const c of coins) {
    c.x -= travel * 1.6;
    if (!c.settled) {
      c.x += c.vx * dt;
      c.vh -= 520 * dt;                          // gravity
      c.h += c.vh * dt;
      if (c.vh < 0 && c.h <= c.restH) {          // bounce, then settle
        c.h = c.restH;
        c.vh = -c.vh * 0.45;
        c.vx *= 0.6;
        if (c.vh < 40) c.settled = true;
      }
    }
  }

  coins = coins.filter(c => {
    const cy = worldY(c.x) - c.h;
    const dx = c.x - collectX;
    const dy = cy - collectY;
    const d = Math.hypot(dx, dy);
    if (d < collectRange) {
      state.money += c.value * (1 + state.metaCoin * 0.25);
      burst(collectX, collectY, 14,
        ['#fffbe8', '#ffe05b', '#ff8acb', '#8fd7ff', '#a986ff'], 0.9);
      return false;
    }
    if (d < magnetRange * 3) {
      // Pull all the way into the sprite and damp the coin's ballistic motion.
      const pull = Math.min(1, dt * 4.2);
      c.x += (collectX - c.x) * pull;
      c.h += (worldY(c.x) - collectY - c.h) * pull;
      c.vx *= 1 - pull;
      c.vh *= 1 - pull;
    }
    return c.x > -30;
  });

  // The rainbow and pot are fixed focal anchors. Upgrade purchases affect
  // unicornXCss(); travel only scrolls the world and coin field.

  // --- Sparkles ---
  for (const s of sparkles) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy += 260 * dt;
    s.life -= dt;
  }
  sparkles = sparkles.filter(s => s.life > 0);
}

// ============================================================
// Pixel-art helpers
// All coordinates below are in WORLD-BUFFER pixels (the chunky grid).
// ============================================================

function pset(x, y, colour) {
  ctx.fillStyle = colour;
  ctx.fillRect(x | 0, y | 0, 1, 1);
}

// 4×4 Bayer ordered dither: 16 blend levels, used by the sky, sun, turf
// and hills so every gradient in the world dissolves the same way
const BAYER = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
];
const dither4 = (x, y) => (BAYER[y & 3][x & 3] + 0.5) / 16;

// Pick a tone index for value v (in 0..n-1), dithering only a narrow
// fraction of each band edge. Strength stays adjustable for materials such
// as the sun that benefit from a slightly softer transition.
function shadeIndex(v, n, x, y, strength = 0.25) {
  const idx = Math.floor(v + 0.5 + (dither4(x, y) - 0.5) * strength);
  return Math.max(0, Math.min(n - 1, idx));
}

function rectB(x, y, w, h, colour) {
  ctx.fillStyle = colour;
  ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}

// Filled circle built from horizontal runs of whole pixels. Given a coverage,
// it instead paints only that fraction of its pixels, chosen by the Bayer
// pattern — stacked between two solid tones, that dissolves the seam.
function disc(cx, cy, r, colour, g = ctx, coverage = 0) {
  g.fillStyle = colour;
  cx = Math.round(cx);
  cy = Math.round(cy);
  const ri = Math.floor(r);
  for (let dy = -ri; dy <= ri; dy++) {
    const half = Math.floor(Math.sqrt(r * r - dy * dy));
    if (coverage) {
      for (let x = cx - half; x <= cx + half; x++) {
        if (dither4(x, cy + dy) < coverage) g.fillRect(x, cy + dy, 1, 1);
      }
    } else {
      g.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
    }
  }
}

// ============================================================
// Drawing
// ============================================================

function renderSkyLayer() {
  const [, g] = sized(bW, bH, skyLayer);

  // Tone by ALTITUDE — distance above the planet's surface — so the sky's
  // bands curve with the world, and Bayer dithering dissolves every
  // transition the way the sun's do. Deep blue up high, pale at the horizon.
  const tones = ['#54b9f6', '#75cdfb', '#93deff', '#b0e9ff', '#c9f1fd', '#dcf6fe'];
  const rgb = tones.map(c => [
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16),
  ]);
  const pcx = toB(planet.cx);
  const pcy = toB(planet.cy);
  const pr = toB(planet.r);
  const maxAlt = Math.max(1, Math.hypot(pcx, pcy) - pr, Math.hypot(bW - pcx, pcy) - pr);

  const img = g.createImageData(bW, bH);
  const data = img.data;
  for (let y = 0; y < bH; y++) {
    for (let x = 0; x < bW; x++) {
      const alt = Math.max(0, Math.hypot(x - pcx, y - pcy) - pr);
      const v = (1 - Math.min(1, alt / maxAlt)) * (tones.length - 1);
      const c = rgb[shadeIndex(v, tones.length, x, y, 0.2)];
      const o = (y * bW + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

function drawSky() {
  ctx.drawImage(skyLayer, 0, 0);
}

function renderSunLayer() {
  // Width cap protects narrow portraits. Counter the 4× landscape camera
  // scale so zooming enlarges the action without also enlarging the sun.
  sunR = Math.round(Math.min(bH * 0.26, bW * 0.18, 40) * PIXEL_SIZE / viewScale);
  const size = sunR * 2 + 1;
  const [, g] = sized(size, size, sunLayer);

  // Five tones from warm rim to white-hot core, ring boundaries dissolved
  // by the same Bayer dither as the sky
  const tones = ['#ffd042', '#ffe164', '#ffef92', '#fff8c6', '#ffffff'];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - sunR, y - sunR) / sunR;
      if (d > 1) continue;
      const v = (1 - d) * (tones.length - 1);
      g.fillStyle = tones[shadeIndex(v, tones.length, x, y, 0.28)];
      g.fillRect(x, y, 1, 1);
    }
  }
}

function drawSun(sourceX, sourceY) {
  // Anchor to the visible top-left so the sun keeps the same partial-corner
  // composition at every aspect ratio.
  const sx = sourceX + Math.round(sunR * 0.55);
  const sy = sourceY + Math.round(sunR * 0.35);

  // The sun alternates between a full fan, long sparse beams and a beaded
  // burst. Each holds for five seconds while its lengths continue to pulse.
  const pattern = Math.floor(t / 5) % SUN_RAYS.length;
  const dirs = SUN_RAYS[pattern];
  const pulse = Math.round((Math.sin(t * 1.6) + 1) * 2);
  const reach = [1.7, 2.15, 1.5][pattern];
  for (let n = 0; n < dirs.length; n++) {
    const [dx, dy] = dirs[n];
    const mag = Math.hypot(dx, dy);
    const start = Math.ceil((sunR + 4) / mag);
    const len = Math.round((sunR * reach + pulse * 3) / mag);
    for (let i = 0; i < len; i++) {
      const x = sx + dx * (start + i);
      const y = sy + dy * (start + i);
      if (i < len * 0.55 || (i + n) % (pattern === 2 ? 3 : 2) === 0)
        pset(x, y, '#ffe98c');
    }
  }

  ctx.drawImage(sunLayer, sx - sunR, sy - sunR);
}

const CLOUD_DEFS = [
  { fx: 0.15, fy: 0.30, s: 18, wind: 2.4 },
  { fx: 0.45, fy: 0.12, s: 26, wind: 3.4 },
  { fx: 0.70, fy: 0.24, s: 15, wind: 4.4 },
  { fx: 0.95, fy: 0.09, s: 12, wind: 5.4 },
];

function renderCloudLayers() {
  cloudLayers = CLOUD_DEFS.map(def => {
    const s = def.s;
    const [cvs, g] = sized(Math.ceil(s * 3.3) + 8, Math.ceil(s * 2.1) + 8);
    const ox = Math.ceil(s * 1.4) + 4;   // cloud origin within the canvas
    const oy = Math.ceil(s * 1.2) + 4;

    const puffs = [
      [-s * 0.7,  0,        s * 0.55],
      [ 0,       -s * 0.35, s * 0.7 ],
      [ s * 0.7, -s * 0.1,  s * 0.55],
      [ s * 1.3,  s * 0.15, s * 0.4 ],
    ];
    // Shade passes back to front, with a Bayer half-tone pass dissolving
    // each seam — deep→shade, shade→body, and a halo around the highlight
    for (const [px, py, pr] of puffs) disc(ox + px, oy + py + 2, pr, '#b9d9f4', g);
    for (const [px, py, pr] of puffs) disc(ox + px, oy + py + 2, pr, '#d7ebfc', g, 0.35);
    for (const [px, py, pr] of puffs) disc(ox + px, oy + py + 1, pr, '#d7ebfc', g);
    for (const [px, py, pr] of puffs) disc(ox + px, oy + py + 1, pr, '#f2f9ff', g, 0.35);
    for (const [px, py, pr] of puffs) disc(ox + px, oy + py, pr, '#f2f9ff', g);
    for (const [px, py, pr] of puffs) disc(ox + px - pr * 0.25, oy + py - pr * 0.3, pr * 0.78, '#ffffff', g, 0.35);
    for (const [px, py, pr] of puffs) disc(ox + px - pr * 0.25, oy + py - pr * 0.3, pr * 0.6, '#ffffff', g);

    return { cvs, ox, oy };
  });
}

function drawClouds() {
  const span = bW + 160;
  for (let i = 0; i < CLOUD_DEFS.length; i++) {
    const def = CLOUD_DEFS[i];
    const layer = cloudLayers[i];
    const raw = def.fx * span - t * def.wind - toB(state.distance) * 0.15;
    const x = ((raw % span) + span) % span - 80;
    ctx.drawImage(layer.cvs, Math.round(x) - layer.ox, Math.round(bH * def.fy) - layer.oy);
  }
}

// Rolling hill bands, prerendered as seamlessly-tiling strips (their sine
// waves complete whole cycles across the width) with a 1px sunlit crest
// and a Bayer-dithered fade from crest-light into the body colour
const HILL_DEFS = [
  { base: 0.60, amp: 5,   k1: 3, k2: 8,  phase: 0.7, top: '#d5f5e8', light: '#c4eedd', body: '#b2e6d2', scroll: 0.04 },
  { base: 0.65, amp: 6.5, k1: 5, k2: 13, phase: 2.3, top: '#b6ecd0', light: '#a4e4c2', body: '#8fdbb5', scroll: 0.09 },
];

function renderHillLayers() {
  hillLayers = HILL_DEFS.map(def => {
    const [cvs, g] = sized(Math.max(1, bW), bH);
    const FADE = 20;
    for (let x = 0; x < bW; x++) {
      const a = (x / bW) * Math.PI * 2;
      const y = Math.round(
        bH * def.base
        + Math.sin(a * def.k1 + def.phase) * def.amp
        + Math.sin(a * def.k2 + def.phase * 2) * def.amp * 0.4
      );
      g.fillStyle = def.top;
      g.fillRect(x, y, 1, 1);
      for (let i = 1; i <= FADE; i++) {
        g.fillStyle = shadeIndex(i / FADE, 2, x, y + i) ? def.body : def.light;
        g.fillRect(x, y + i, 1, 1);
      }
      g.fillStyle = def.body;
      g.fillRect(x, y + FADE + 1, 1, Math.max(1, bH - y - FADE - 1));
    }
    return { cvs, scroll: def.scroll };
  });
}

function drawFarHills() {
  // Two blits per band, wrapping the tile as it parallax-scrolls
  for (const h of hillLayers) {
    const off = Math.floor(state.distance * h.scroll) % bW;
    ctx.drawImage(h.cvs, -off, 0);
    ctx.drawImage(h.cvs, bW - off, 0);
  }
}

function renderPlanetLayer() {
  const [, g] = sized(bW, bH, planetLayer);

  // Turf as a Bayer-dithered fade from sunlit rim to deep grass — fewer
  // tones spread over more rows, so each grass band gets real breathing room
  const tones = ['#daf7a6', '#a8e892', '#84d980', '#69cb72', '#5abf68'];
  const FADE = 48;
  for (let x = 0; x < bW; x++) {
    const top = Math.floor(wyB(x));
    for (let i = 0; i < FADE; i++) {
      const v = (i / (FADE - 1)) * (tones.length - 1);
      g.fillStyle = tones[shadeIndex(v, tones.length, x, top + i)];
      g.fillRect(x, top + i, 1, 1);
    }
    g.fillStyle = tones[tones.length - 1];
    g.fillRect(x, top + FADE, 1, Math.max(1, bH - top - FADE));
  }
}

function drawPlanet() {
  ctx.drawImage(planetLayer, 0, 0);
}

function renderRainbowLayer() {
  // Sized so the arch is enormous: it always exits the right edge of the
  // screen before its far foot comes back down.
  rbBandW = Math.max(4, Math.round(Math.min(bH * 0.03, viewW * 0.06)));
  rbThickness = rbBandW * RAINBOW_COLOURS.length;
  rbRadius = Math.round(Math.max(bH * 0.72, bW * 0.24));

  const lw = Math.max(1, Math.min(bW, rbRadius * 2));
  const lh = Math.max(1, rbRadius);
  const [, g] = sized(lw, lh, rainbowLayer);

  // Arc centre sits at (rbRadius, lh) so the near foot lands at x = 0.
  // Drawn column by column, outermost band first: each band paints from
  // its outer curve down to the baseline and the next band overdraws
  // below its own curve, which leaves clean concentric pixel rings and a
  // solid planted foot.
  for (let x = 0; x < lw; x++) {
    const dx = x - rbRadius;
    const ad = Math.abs(dx);
    for (let i = 0; i < RAINBOW_COLOURS.length; i++) {
      const ro = rbRadius - i * rbBandW;
      const ri = ro - rbBandW;
      if (ad >= ro) continue;
      const yo = lh - Math.floor(Math.sqrt(ro * ro - dx * dx));
      const yi = ad >= ri ? lh : lh - Math.floor(Math.sqrt(ri * ri - dx * dx));
      g.fillStyle = RAINBOW_COLOURS[i];
      g.fillRect(x, yo, 1, Math.max(1, yi - yo));
    }
  }

  // A narrow dithered shade follows every band's inner radius. Because it
  // is radial rather than a horizontal strip, the same treatment naturally
  // turns down the planted foot instead of stopping at the crown.
  const shadowWidth = Math.max(1, Math.round(rbBandW * 0.18));
  for (let x = 0; x < lw; x++) {
    const dx = x - rbRadius;
    const top = lh - Math.floor(Math.sqrt(Math.max(0, rbRadius * rbRadius - dx * dx)));
    for (let y = top; y < lh; y++) {
      const depth = rbRadius - Math.hypot(dx, lh - y);
      const band = Math.floor(depth / rbBandW);
      if (band < 0 || band >= RAINBOW_COLOURS.length) continue;
      const edge = depth - band * rbBandW;
      const shade = (edge - rbBandW + shadowWidth) / shadowWidth;
      if (shade > 0 && dither4(x, y) < shade * 0.65) {
        g.fillStyle = RAINBOW_SHADOWS[band];
        g.fillRect(x, y, 1, 1);
      }
    }
  }
}

function drawFlower(x, y, seed) {
  const petal = ['#ff9dce', '#a78cff', '#ffd6e8', '#8fd7ff'][Math.floor(seed * 4)];
  const sway = Math.round(Math.sin(t * 1.6 + seed * 9));
  rectB(x, y - 3, 1, 3, '#4ca85e');
  pset(x + (seed > 0.5 ? 1 : -1), y - 2, '#65c576');
  const fx = x + sway, fy = y - 5;
  pset(fx, fy - 1, petal);
  pset(fx, fy + 1, petal);
  pset(fx - 1, fy, petal);
  pset(fx + 1, fy, petal);
  pset(fx, fy, '#ffe76d');
}

function drawGrassTuft(x, y, seed) {
  const c = seed > 0.5 ? '#5cbf6f' : '#48ab5c';
  const sway = Math.round(Math.sin(t * 2 + seed * 12));
  pset(x - 2, y - 1, c);
  pset(x - 2 + sway, y - 2, c);
  rectB(x, y - 3, 1, 3, c);
  pset(x + sway, y - 4, c);
  pset(x + 2, y - 1, c);
  pset(x + 2 + sway, y - 2, c);
}

function drawBush(x, y, seed) {
  const idx = Math.floor(seed * 3);
  const leaf = ['#76d27b', '#62c781', '#8ad79b'][idx];
  const shade = ['#56b866', '#48ad70', '#68c17e'][idx];
  rectB(x - 5, y, 10, 1, '#4dad5e');
  disc(x - 3, y - 3, 3, shade);
  disc(x + 3, y - 3, 3, shade);
  disc(x, y - 4, 3, shade);
  disc(x - 3, y - 4, 2, leaf);
  disc(x + 3, y - 4, 2, leaf);
  disc(x, y - 5, 3, leaf);
  if (hash(seed * 31) > 0.45) {
    pset(x - 3, y - 5, '#ff91c7');
    pset(x + 2, y - 4, '#ffe477');
  }
}

// Both tree kinds stand on the same trunk: a shadow on the grass, a lit stem
// with a shaded right edge, one branch, and roots flaring at the base. Only
// the branch differs, so its position and length come from the caller.
function drawTrunk(x, y, trunkH, shadowW, branchX, branchY, branchW) {
  rectB(x - (shadowW >> 1), y, shadowW, 1, '#4dad5e');
  rectB(x - 1, y - trunkH, 3, trunkH, '#b98a5e');
  rectB(x + 1, y - trunkH, 1, trunkH, '#9c704e');
  rectB(branchX, branchY, branchW, 1, '#9c704e');
  pset(x - 2, y - 1, '#9c704e');
  pset(x + 2, y - 1, '#9c704e');
}

function drawTree(x, y, seed, palette) {
  const [canopy, shade] = TREE_PALETTES[palette];
  const trunkH = 12 + Math.round(hash(seed * 17) * 5);
  const r = 5 + Math.round(hash(seed * 23) * 2);
  const lean = hash(seed * 29) > 0.5 ? 2 : -2;
  const cy = y - trunkH - r + 2;

  drawTrunk(x, y, trunkH, 9, x + (lean < 0 ? -3 : 1), y - trunkH + 3, 3);

  // Several offset crowns give each tree an irregular candy-cloud silhouette.
  disc(x + lean, cy + 2, r + 1, shade);
  disc(x - lean - 3, cy + 3, r - 1, shade);
  disc(x + lean + 4, cy + 3, r - 2, shade);
  disc(x + lean, cy, r, canopy);
  disc(x - lean - 3, cy + 1, r - 1, canopy);
  disc(x + lean + 4, cy + 1, r - 2, canopy);
  pset(x + lean - 2, cy - r + 2, '#fff4ff');
  pset(x + lean - 1, cy - r + 2, '#fff4ff');
}

function drawRibbonWillow(x, y, seed, palette) {
  const [leaf, shade] = TREE_PALETTES[palette];
  const trunkH = 14 + Math.round(hash(seed * 19) * 4);
  const cy = y - trunkH - 3;

  drawTrunk(x, y, trunkH, 10, x - 5, cy + 3, 11);

  // A wide cloud crown trails narrow leaf ribbons instead of forming a ball.
  rectB(x - 8, cy + 2, 1, 7, shade);
  rectB(x + 7, cy + 2, 1, 6, shade);
  rectB(x - 4, cy + 4, 1, 7, shade);
  rectB(x + 4, cy + 4, 1, 8, shade);
  disc(x, cy, 6, shade);
  disc(x - 6, cy + 2, 4, shade);
  disc(x + 6, cy + 2, 4, shade);
  disc(x, cy - 2, 5, leaf);
  disc(x - 5, cy, 4, leaf);
  disc(x + 5, cy, 4, leaf);
  rectB(x - 6, cy + 3, 1, 5, leaf);
  rectB(x + 5, cy + 3, 1, 6, leaf);
  pset(x - 9, cy + 6, shade);
  pset(x - 7, cy + 9, shade);
  pset(x - 5, cy + 8, leaf);
  pset(x + 3, cy + 9, leaf);
  pset(x + 6, cy + 7, shade);
  pset(x + 8, cy + 6, shade);
  pset(x - 2, cy - 6, '#fff4ff');
  pset(x - 1, cy - 6, '#fff4ff');
}

function drawSpiralFern(x, y, seed) {
  const dark = seed > 0.66 ? '#3fa85b' : '#52b96a';
  const light = '#72cf7e';
  const accent = TREE_PALETTES[Math.floor(seed * 7)][0];
  rectB(x - 4, y, 9, 1, '#4dad5e');
  rectB(x - 1, y - 6, 1, 6, dark);
  rectB(x + 1, y - 8, 1, 8, dark);
  for (const [dx, dy] of [[-2, -3], [-3, -4], [0, -2], [2, -4], [3, -5], [0, -5]])
    pset(x + dx, y + dy, light);
  for (const [dx, dy] of [[-1, -7], [-2, -8], [-3, -8], [-3, -7], [-2, -7],
    [1, -9], [2, -10], [3, -10], [3, -9], [2, -9]]) pset(x + dx, y + dy, dark);
  pset(x - 2, y - 7, accent);
  pset(x + 2, y - 9, accent);
}

// Every scattered lane is laid out the same way: evenly spaced slots, each
// nudged by a seeded jitter so the rhythm doesn't read as a grid, scrolling at
// its own parallax rate and wrapping through a span that runs past both screen
// edges so nothing pops into existence at the margins. `place` is handed the
// wrapped x and the slot index, which is the seed for everything else.
function scatter(spacing, margin, jitter, seedMul, seedAdd, parallax, place) {
  const span = bW + margin * 2;
  const offset = toB(state.distance * parallax);
  const count = Math.ceil(span / spacing);
  for (let i = 0; i < count; i++) {
    const raw = i * spacing + hash(i * seedMul + seedAdd) * jitter - offset;
    place(Math.round(((raw % span) + span) % span - margin), i, count);
  }
}

// Tiny marks move with the surface, filling the field without adding more
// large silhouettes that compete with the unicorn and rainbow.
function drawGroundDetail() {
  scatter(7, 10, 5, 2.9, 60, 1.6, (x, i) => {
    const depth = 5 + Math.floor(hash(i * 5.7 + 63) * 40);
    const y = Math.floor(wyB(x) + depth);
    if (y >= bH) return;
    const c = depth < 17 ? '#8ddd82' : depth < 31 ? '#67c773' : '#50b662';
    pset(x, y, c);
    if (hash(i * 8.3 + 2) > 0.45) pset(x + 1, y, c);
  });
}

function drawScenery() {
  // The ridge is the unicorn's plane. Trees have their own broad rhythm so
  // a random run of tiny plants cannot leave the skyline completely bare.
  let firstPalette = -1, lastPalette = -1, repeats = 0;
  scatter(68, 45, 35, 4.7, 30, 1.6, (x, i, treeCount) => {
    const seed = hash(i * 8.3 + 33);
    // Seeded randomness keeps each tree stable while this guard prevents a
    // third matching colour, including where the scrolling strip wraps.
    let palette = Math.floor(hash(i * 6.1 + 41) * 7);
    while ((palette === lastPalette && repeats === 2)
      || (i === treeCount - 1 && palette === firstPalette)) palette = (palette + 1) % 7;
    if (i === 0) firstPalette = palette;
    repeats = palette === lastPalette ? repeats + 1 : 1;
    lastPalette = palette;
    if (hash(i * 5.1 + 38) < 0.34) drawRibbonWillow(x, Math.floor(wyB(x)) + 1, seed, palette);
    else drawTree(x, Math.floor(wyB(x)) + 1, seed, palette);
  });

  // Tiny communities share the ridge but retain plenty of open path.
  scatter(24, 34, 15, 1, 0, 1.6, (x, i) => {
    const kind = hash(i * 3.7 + 11);
    const seed = hash(i * 7.3 + 5);
    if (kind < 0.3) {
      const amount = 2 + Math.round(seed * 2);
      for (let j = 0; j < amount; j++) {
        const px = x + (j - amount / 2) * 4 + Math.round(hash(i * 13 + j) * 2);
        drawGrassTuft(px, Math.floor(wyB(px)) + 1, hash(i * 17 + j));
      }
    } else if (kind < 0.55) {
      const amount = seed > 0.55 ? 3 : 2;
      for (let j = 0; j < amount; j++) {
        const px = x + (j - 1) * 4;
        drawFlower(px, Math.floor(wyB(px)) + 1, hash(i * 11 + j + 2));
      }
    }
  });
}

// Bushes occupy a separate lane down the slope and scroll between the ridge
// and foreground speeds. This missing middle scale makes the depth readable.
function drawMidground() {
  scatter(48, 40, 22, 1.9, 80, 1.9, (x, i) => {
    const depth = 10 + Math.floor(hash(i * 3.1 + 83) * 20);
    const y = Math.floor(wyB(x) + depth);
    if (y > bH + 7) return;
    const seed = hash(i * 6.7 + 89);
    const kind = hash(i * 4.3 + 87);
    if (kind < 0.58) {
      drawBush(x, y, seed);
      if (seed > 0.62) drawFlower(x + 7, y, seed);
    } else if (kind < 0.84) drawSpiralFern(x, y, seed);
    else {
      drawGrassTuft(x - 2, y, seed);
      drawFlower(x + 3, y, hash(i * 9.1 + 4));
    }
  });
}

// Drawn BEFORE the planet: the baseline is sunk well below the ground line,
// and the ground painted on top clips the arch, so the rainbow meets the
// hill along the hill's own curve instead of stopping on a flat edge.
function drawRainbowArch() {
  const footCss = rainbowFootCss();
  const foot = Math.round(toB(footCss));
  const gy = Math.floor(toB(worldY(footCss)));
  ctx.drawImage(rainbowLayer, foot, gy + 26 - rainbowLayer.height);
}

// Let the turf break into the lowest edge of the rainbow rather than making
// a perfectly clean cut. This is deliberately only two rows: the foot stays
// solid and readable, but now shares the ground's transition language.
function blendRainbowFoot() {
  const foot = Math.round(toB(rainbowFootCss()));
  for (let x = foot; x < foot + rbThickness; x++) {
    const ground = Math.floor(wyB(x));
    if (dither4(x, ground - 1) < 0.5) pset(x, ground - 1, '#daf7a6');
    if (dither4(x, ground - 2) < 0.18) pset(x, ground - 2, '#daf7a6');
  }
}

function drawJigLimb(points, colour) {
  for (const [x, y] of points)
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) pset(x + dx, y + dy, '#7d5f94');
  for (const [x, y] of points) pset(x, y, colour);
}

// A jig is compound time: two groups of three, where a march is an even
// 1-2-1-2. One bar per second — hop, land, flick, hop, land, flick — with
// the accent on each hop, which is what gives the step its lilt. How far
// the body leaves the grass on each of the six eighth-notes:
const JIG_HOP = [3, 0, 1, 3, 0, 1];

// Leg poses for one bar, as backing-pixel offsets from the leprechaun's
// top-left. The last three points of each leg are its shoe.
function jigLegs(step, x, y) {
  const p = (dx, dy) => [x + dx, y + dy];
  // A planted foot stays on the grass, so it grows `e` extra shin rows to
  // make up whatever the body has been lifted by.
  const plantL = (e) => [p(4, 14), p(3, 15), p(4, 15), p(3, 16), p(4, 16),
    ...(e ? [p(3, 17), p(4, 17)] : []), p(2, 17 + e), p(3, 17 + e), p(4, 17 + e)];
  const plantR = (e) => [p(8, 14), p(8, 15), p(9, 15), p(8, 16), p(9, 16),
    ...(e ? [p(8, 17), p(9, 17)] : []), p(8, 17 + e), p(9, 17 + e), p(10, 17 + e)];
  // Knee up, toe turned out: half the length of a planted leg, and that
  // contrast is what reads as "lifted" at thirteen pixels tall.
  const upL = [p(3, 14), p(4, 14), p(2, 15), p(3, 15), p(4, 15)];
  const upR = [p(8, 14), p(9, 14), p(8, 15), p(9, 15), p(10, 15)];
  // The quick flick between steps: foot just clear of the grass.
  const midL = [p(4, 14), p(3, 15), p(4, 15), p(2, 16), p(3, 16), p(4, 16)];
  const midR = [p(8, 14), p(8, 15), p(9, 15), p(8, 16), p(9, 16), p(10, 16)];
  // Toe pointed out to the side, weight on the other foot. The pot hides
  // his left leg, so the point goes on the right where it can be seen.
  const pointR = [p(8, 14), p(8, 15), p(9, 15), p(9, 16), p(10, 16),
    p(10, 17), p(11, 17), p(12, 17)];
  // A leg that keeps its planted shape while the body is airborne simply
  // dangles, so the hop poses reuse it as the trailing leg.
  return [
    [upL, plantR(0)],
    [plantL(0), plantR(0)],
    [midL, plantR(1)],
    [plantL(0), upR],
    [plantL(0), pointR],
    [plantL(1), midR],
  ][step];
}

// Drawn AFTER the planet: the pot sits on the grass under the middle of
// the arch's foot, coins twinkling above it.
function drawRainbowPot() {
  const potX = Math.round(toB(potXCss()));
  const potGy = Math.floor(wyB(potX));

  // The leprechaun stands behind the pot, overlapping its rim by three
  // pixels so the pair reads as a single group rather than adjacent sprites.
  const lepGy = Math.floor(wyB(potX + 10));
  const step = Math.floor(t * 6) % 6;
  const hop = JIG_HOP[step];
  const lepX = potX + 3, lepY = lepGy - 17 - hop;
  // The shadow tightens as he leaves the grass, so the hop reads as height
  // rather than the whole sprite sliding upwards.
  rectB(potX + 6 + (hop >> 1), lepGy, 8 - hop, 1, '#4da05b');

  const legs = jigLegs(step, lepX, lepY);
  // Only the shins are haloed. The shoes are dark enough to hold their own
  // edge against the grass, and outlining a three-pixel foot fattened it
  // into a block — so they go down last, plain, over the shin's outline.
  for (const leg of legs) drawJigLimb(leg.slice(0, -3), '#7a4a2e');
  for (const leg of legs) for (const shoe of leg.slice(-3)) pset(...shoe, '#3b3547');

  // The upper body stays intact — arms included — while the legs dance.
  ctx.drawImage(leprechaunSprite, 0, 0, 13, 15, lepX, lepY, 13, 15);

  drawPot(potX, potGy);
}

function drawPot(x, b) {
  // b = the ground row the pot rests on. Built bottom-up in pixel rows.
  rectB(x - 6, b, 12, 1, '#4da05b');          // shadow on the grass
  pset(x - 4, b - 1, '#2c2735');              // feet
  pset(x + 3, b - 1, '#2c2735');
  rectB(x - 4, b - 2, 8, 1, '#3b3547');       // base
  rectB(x - 6, b - 5, 12, 3, '#3b3547');      // belly
  rectB(x - 5, b - 6, 10, 1, '#3b3547');      // shoulder
  rectB(x - 4, b - 5, 1, 3, '#6b6284');       // sheen
  rectB(x - 7, b - 8, 14, 2, '#524b63');      // rim
  rectB(x - 3, b - 11, 6, 1, '#c1843c');      // soft amber gold outline
  rectB(x - 5, b - 10, 10, 1, '#c1843c');
  rectB(x - 6, b - 9, 12, 1, '#c1843c');
  rectB(x - 5, b - 9, 10, 1, '#ffd54a');      // gold heap
  rectB(x - 3, b - 10, 6, 1, '#ffd54a');
  pset(x - 2, b - 10, '#ffec8a');             // glints
  pset(x + 1, b - 10, '#ffec8a');
  pset(x, b - 9, '#ffec8a');
}

function drawCoins() {
  for (const c of coins) {
    const bob = c.settled ? Math.round(Math.sin(t * 3 + c.phase)) : 0; // bobs once landed
    const x = Math.round(toB(c.x));
    const y = Math.round(toB(worldY(c.x) - c.h)) + bob;
    const spin = Math.abs(Math.cos(t * 2.5 + c.phase));
    const w = 2 + Math.round(spin * 3);                      // 2..5 px wide as it spins
    rectB(x - 1, Math.floor(wyB(x)), 3, 1, '#4da05b');       // anchor shadow on the grass
    rectB(x - w / 2, y - 3, w, 6, '#e6a817');
    if (w > 2) rectB(x - w / 2 + 1, y - 2, w - 2, 4, '#ffd54a');
    if (spin > 0.6) pset(x - 1, y - 2, '#ffec8a');
  }
}

const upgradeButtons = [...upgradeList.querySelectorAll('[data-up]')];

let upgradeSignature = '';
function updateUpgradeMenu() {
  const money = Math.floor(state.money);
  const signature = `${money},${state.speed},${state.magnet},${state.luck},${state.stubborn}`;
  if (signature === upgradeSignature) return;
  upgradeSignature = signature;
  upgradeMoney.textContent = money.toLocaleString();
  upgradeChase.textContent = chaseRemaining();
  for (const button of upgradeButtons) {
    const key = button.dataset.up;
    const level = state[key];
    const cost = UPGRADE_COSTS[key](level);
    const maxed = key === 'stubborn' && level >= MAX_STUBBORN;
    const unavailable = maxed || state.money < cost;
    const row = button.closest('.upgrade__row');
    const title = row.querySelector('.upgrade__name').textContent;
    row.classList.toggle('upgrade__row--unavailable', unavailable);
    row.querySelector('.upgrade__level b').textContent = level;
    row.querySelector('.upgrade__cost').textContent = maxed ? 'Maximum' : `${cost.toLocaleString()} coins`;
    button.textContent = maxed ? 'Maxed' : 'Upgrade';
    button.setAttribute('aria-disabled', unavailable);
    button.setAttribute('aria-label', maxed ? `${title}, maximum level` : `Upgrade ${title} for ${cost} coins`);
  }
}

hudUpgrade.onclick = () => {
  if (upgradeMenu.open) return upgradeMenu.close();
  updateUpgradeMenu();
  upgradeMenu.showModal();
  hudUpgrade.setAttribute('aria-expanded', 'true');
  upgradeClose.focus();
};
upgradeClose.onclick = () => upgradeMenu.close();
upgradeMenu.onclose = () => {
  hudUpgrade.setAttribute('aria-expanded', 'false');
  hudUpgrade.focus();
};
upgradeList.onclick = event => {
  const button = event.target.closest('[data-up]');
  if (!button) return;
  const key = button.dataset.up;
  const cost = UPGRADE_COSTS[key](state[key]);
  if (state.money < cost || key === 'stubborn' && state.stubborn >= MAX_STUBBORN) return;
  state.money -= cost;
  state[key]++;
  upgradeSignature = '';
  updateUpgradeMenu();
};

function updateHud() {
  const unicornX = Math.round(toB(unicornXCss()));
  const groundY = Math.floor(wyB(unicornX));
  const screenX = (unicornX - viewX) * viewScale;
  const groundScreenY = (groundY - viewY) * viewScale;
  const anchorY = groundScreenY - (SPRITE_FRAME + 3) * viewScale;
  const coinText = Math.floor(state.money).toLocaleString();
  const chase = chaseRemaining();
  const chaseText = `${chase}m`;

  hud.style.left = `${screenX}px`;
  hud.style.top = `${anchorY}px`;
  hudUpgrade.style.left = `${clamp(screenX, 42, W - 42)}px`;
  hudUpgrade.style.top = `${groundScreenY}px`;
  const label = `${coinText} coins, rainbow chase ${chase}`;
  if (hud.getAttribute('aria-label') !== label) hud.setAttribute('aria-label', label);
  if (hudMoney.textContent !== coinText) hudMoney.textContent = coinText;
  if (hudDistance.textContent !== chaseText) hudDistance.textContent = chaseText;
  const menuOpen = upgradeMenu.open;
  const buttonText = menuOpen ? 'Close' : 'Upgrade';
  const buttonLabel = menuOpen ? 'Close upgrades' : 'Open upgrades';
  if (hudUpgradeText.textContent !== buttonText) hudUpgradeText.textContent = buttonText;
  if (hudUpgrade.getAttribute('aria-label') !== buttonLabel) hudUpgrade.setAttribute('aria-label', buttonLabel);
  if (menuOpen) updateUpgradeMenu();

  // Animate the coin inside the UI's fixed icon box.
  const spin = Math.abs(Math.cos(t * 2.5));
  const coinUnits = 2 + Math.round(spin * 3);
  const coinX = (5 - coinUnits) / 2;
  coinEdge.setAttribute('x', coinX);
  coinEdge.setAttribute('width', coinUnits);
  coinFace.setAttribute('x', coinX + 1);
  coinFace.setAttribute('width', Math.max(0, coinUnits - 2));
  coinFace.toggleAttribute('hidden', coinUnits <= 2);
  coinGlint.toggleAttribute('hidden', spin <= 0.6);
}

function drawUnicorn() {
  const ux = Math.round(toB(unicornXCss()));
  const gy = Math.floor(wyB(ux));
  // Hops in whole pixels — pixel art doesn't glide
  const bob = Math.round(Math.abs(Math.sin(t * 5)) * 2);

  // Ground shadow, narrowing as it rises
  rectB(ux - 5 + bob, gy, 10 - bob * 2, 1, '#4da05b');

  if (unicornSheet) {
    const frame = Math.floor(animClock) % SPRITE_FRAMES;
    // 1:1 into the buffer — pixel-perfect by construction. Cells are 18×18
    // (frame + baked outline), so the dest shifts 1px up-left to compensate;
    // feet in the sheet sit ~1px above the cell bottom, hence the net offset.
    ctx.drawImage(
      unicornSheet,
      frame * SPRITE_CELL, SPRITE_ROW.move * SPRITE_CELL, SPRITE_CELL, SPRITE_CELL,
      ux - 9, gy - SPRITE_FRAME - bob, SPRITE_CELL, SPRITE_CELL
    );
    return;
  }

  // Fallback while the sheet loads: white square + horn
  rectB(ux - 5, gy - 10 - bob, 10, 10, '#fff');
  rectB(ux + 2, gy - 14 - bob, 1, 4, '#ffe56f');
}

// The nearest lane is low and patchy, framing the bottom of the field rather
// than leaving isolated comb-like blades floating near the action.
function drawForeground() {
  // Shallow landscape crops have no genuine near slope; forcing one in would
  // place dark grass beside the actors, so omit it until there is depth room.
  if (viewY + viewH - wyB(viewX + viewW / 2) < 32) return;
  scatter(62, 60, 40, 1.7, 40, 2.4, (x, i) => {
    // Anchor this nearest lane to the camera's lower edge, not the ridge.
    const y = Math.floor(viewY + viewH - 2 - hash(i * 2.3 + 7) * 13);
    const kind = hash(i * 4.1 + 13);
    const seed = hash(i * 6.7 + 21);
    if (kind < 0.8) {
      drawTallGrass(x - 4, y, seed);
      drawTallGrass(x + 4, y + 1, hash(i * 8.7 + 3));
      if (seed > 0.62) drawTallGrass(x + 11, y, hash(i * 5.3 + 8));
    } else {
      drawTallGrass(x - 6, y + 1, seed);
      drawBigFlower(x, y, seed);
      drawTallGrass(x + 6, y + 1, hash(i * 7.1 + 5));
    }
  });
}

function drawTallGrass(x, y, seed) {
  const greens = ['#4bb162', '#3aa057', '#2f8749'];
  const sway = Math.round(Math.sin(t * 1.8 + seed * 10));
  const h = 5 + Math.round(seed * 2);
  rectB(x, y - h, 1, h, greens[2]);
  pset(x + sway, y - h - 1, greens[2]);
  rectB(x - 2, y - 3, 1, 3, greens[0]);
  pset(x - 3 + sway, y - 4, greens[0]);
  pset(x - 3, y - 1, greens[0]);
  rectB(x + 2, y - 4, 1, 4, greens[1]);
  pset(x + 3 + sway, y - 5, greens[1]);
  pset(x + 4, y - 1, greens[1]);
}

function drawBigFlower(x, y, seed) {
  const petal = ['#ff8ac2', '#9678ff', '#ffc2dd', '#6cc4ff'][Math.floor(seed * 4)];
  const sway = Math.round(Math.sin(t * 1.5 + seed * 8));
  rectB(x, y - 7, 1, 7, '#3f9c53');
  pset(x - 1, y - 4, '#4fb363');
  pset(x + 1, y - 3, '#4fb363');
  const fx = x + sway, fy = y - 8;
  disc(fx - 2, fy, 1, petal);
  disc(fx + 2, fy, 1, petal);
  disc(fx, fy - 2, 1, petal);
  disc(fx, fy + 2, 1, petal);
  disc(fx, fy, 1, '#ffe06a');
}

function drawSparkles() {
  for (const s of sparkles) {
    ctx.globalAlpha = Math.max(0, Math.min(1, s.life * 1.6));
    ctx.fillStyle = s.colour;
    const x = Math.round(toB(s.x));
    const y = Math.round(toB(s.y));
    if (s.gold) {
      // Tiny tumbling bars read as loose pieces from the heap, not magic.
      const wide = Math.sin(t * 14 + s.r) > 0;
      ctx.fillRect(x, y, wide ? 2 : 1, wide ? 1 : 2);
      if (s.r > 4) pset(x, y, '#ffec8a');
    } else if (s.r > 6) {
      // Big particles flash as chunky four-point stars with a moving tail.
      ctx.fillRect(x - 2, y, 5, 1);
      ctx.fillRect(x, y - 2, 1, 5);
      ctx.fillRect(x - Math.sign(s.vx), y - Math.sign(s.vy), 1, 1);
      pset(x, y, '#fff');
    } else {
      ctx.fillRect(x, y, s.r > 4 ? 2 : 1, s.r > 4 ? 2 : 1);
    }
  }
  ctx.globalAlpha = 1;
}

function draw() {
  drawSky();
  drawSun(viewX, viewY);
  drawFarHills();
  drawRainbowArch();   // behind the clouds and the ground
  drawClouds();
  drawPlanet();        // clips the arch to the hill's curve
  blendRainbowFoot();
  drawGroundDetail();
  drawScenery();
  drawRainbowPot();
  drawCoins();
  drawUnicorn();
  drawMidground();     // lower slope passes in front of the ridge actors
  drawForeground();
  drawSparkles();

  // Blit at an exact integer scale. The final block may overhang the canvas
  // edge by a couple of CSS pixels rather than creating fractional pixels.
  screenCtx.drawImage(
    worldBuffer,
    viewX, viewY, viewW, viewH,
    0, 0, viewW * viewScale, viewH * viewScale
  );
  updateHud();
}

// ============================================================
// Main loop
// ============================================================

function loop(now) {
  const dt = Math.max(0, Math.min(0.033, (now - last) / 1000));
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

resize();
addEventListener('resize', resize);
// Catches every way the canvas can change size (dev-tools emulation,
// mobile browser bars collapsing, orientation) — not just window resizes
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(canvas);
requestAnimationFrame(loop);
})();