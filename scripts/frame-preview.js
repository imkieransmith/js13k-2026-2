// Development-only. Renders a real frame of the game to a PNG by giving the
// module a rasterising 2D context instead of a recording one, so sprites,
// light shafts, motes and the colour grade can be judged together. There is no
// browser in this toolchain; without this the only visual feedback is the
// terrain bake, which never shows an actor.
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { encodePng } from './png.js';

const options = Object.fromEntries(process.argv.slice(2).map(argument => argument.split('=')));
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${readFileSync(new URL(url), 'utf8')}`,
    };
    // `dead=id` starts one Construct's real removal timer, making every phase
    // of a death effect inspectable without a debug branch in the shipped game.
    if (url.endsWith('/game.js') && options.dead !== undefined) return {
      format: 'module',
      shortCircuit: true,
      source: readFileSync(new URL(url), 'utf8').replace(
        'let enemies = makeEnemies();',
        `let enemies = makeEnemies(); enemies[${Number(options.dead)}].health = 0; enemies[${Number(options.dead)}].death = CONSTRUCT_DEATH;`,
      ),
    };
    return nextLoad(url, context);
  },
});

const WIDTH = 1280;
const HEIGHT = 720;

const parseColour = value => {
  const hex = value.slice(1);
  const full = hex.length < 6 ? [...hex].map(c => c + c).join('') : hex;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
};

/** Stops are evaluated per pixel, which is all the multiply grade needs. */
class Gradient {
  constructor(x0, y0, r0, x1, y1, r1) {
    Object.assign(this, { x0, y0, r0, r1 });
    this.stops = [];
  }

  addColorStop(offset, colour) { this.stops.push([offset, parseColour(colour)]); }

  at(x, y) {
    const distance = Math.hypot(x - this.x0, y - this.y0);
    const amount = Math.min(1, Math.max(0, (distance - this.r0) / (this.r1 - this.r0)));
    let previous = this.stops[0];
    for (const stop of this.stops) {
      if (stop[0] >= amount) {
        const span = stop[0] - previous[0] || 1;
        const blend = (amount - previous[0]) / span;
        return stop[1].map((value, i) => previous[1][i] + (value - previous[1][i]) * blend);
      }
      previous = stop;
    }
    return previous[1];
  }
}

function rasteriser(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;

  const blend = (x, y, rgb, alpha, mode) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      const source = rgb[channel];
      const target = pixels[index + channel];
      const mixed = mode === 'lighter' ? target + source * alpha
        : mode === 'multiply' ? target * (source / 255)
          : target + (source - target) * alpha;
      pixels[index + channel] = mixed;
    }
  };

  const context = {
    fillStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
    createRadialGradient: (...args) => new Gradient(...args),
    setTransform(a, b, c, d, e, f) {
      scale = a;
      offsetX = e;
      offsetY = f;
    },
    fillRect(x, y, w, h) {
      const x0 = Math.round(x * scale + offsetX);
      const y0 = Math.round(y * scale + offsetY);
      const x1 = Math.round((x + w) * scale + offsetX);
      const y1 = Math.round((y + h) * scale + offsetY);
      const gradient = this.fillStyle instanceof Gradient ? this.fillStyle : null;
      const rgb = gradient ? null : parseColour(this.fillStyle);
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
        blend(px, py, gradient ? gradient.at(px, py) : rgb, this.globalAlpha, this.globalCompositeOperation);
      }
    },
    drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
      const image = source.image();
      for (let row = 0; row < sh; row++) for (let column = 0; column < sw; column++) {
        const from = ((sy + row) * image.width + sx + column) * 4;
        const px0 = Math.round((dx + column * (dw / sw)) * scale + offsetX);
        const py0 = Math.round((dy + row * (dh / sh)) * scale + offsetY);
        const rgb = [image.data[from], image.data[from + 1], image.data[from + 2]];
        for (let py = py0; py < py0 + scale; py++) for (let px = px0; px < px0 + scale; px++) {
          blend(px, py, rgb, 1, 'source-over');
        }
      }
    },
  };
  return { context, pixels };
}

const surface = rasteriser(WIDTH, HEIGHT);

function bakeCanvas() {
  let image;
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData(input) { image = input; },
    }),
    image: () => image,
  };
}

// Pointer-driven actions live on the canvas rather than the window, so the
// preview has to record its listeners too or attacks and the laser — the two
// effects most in need of looking at — can never be made to fire.
const canvasListeners = {};
const canvas = {
  width: WIDTH,
  height: HEIGHT,
  clientWidth: WIDTH,
  clientHeight: HEIGHT,
  getContext: () => surface.context,
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
  addEventListener: (type, handler) => { (canvasListeners[type] ||= []).push(handler); },
};
const hud = { dataset: {}, setAttribute() {}, addEventListener() {} };

let scheduled = null;
let now = 0;
globalThis.document = {
  querySelector: selector => selector === '#c' ? canvas : hud,
  createElement: bakeCanvas,
};
globalThis.devicePixelRatio = 1;
globalThis.performance = { now: () => now };
// Real listeners are kept so the preview can drive the player with synthetic
// key events; a still frame of a game whose camera never moves can only ever
// show one corner of the level.
const listeners = {};
globalThis.addEventListener = (type, handler) => { (listeners[type] ||= []).push(handler); };
globalThis.requestAnimationFrame = callback => { scheduled = callback; };
globalThis.ResizeObserver = class { observe() {} };
globalThis.btoa = value => Buffer.from(value, 'binary').toString('base64');
globalThis.atob = value => Buffer.from(value, 'base64').toString('binary');

await import('../src/game.js');

const outPath = options.out || 'dist/frame.png';
const cropArgs = options.crop;
for (const code of (options.hold || '').split(',').filter(Boolean)) {
  for (const handler of listeners.keydown || []) handler({ code, repeat: false, preventDefault() {} });
}

const [aimX = WIDTH / 2, aimY = HEIGHT / 2 + 120] = (options.aim || '').split(',').map(Number);
const pointerEvent = button => ({ button, clientX: aimX, clientY: aimY, preventDefault() {} });
const firePointer = (type, button) => {
  for (const handler of (canvasListeners[type] || listeners[type] || [])) handler(pointerEvent(button));
};
// Aim is a pointer position, so it must be set even for frames that never
// click; without it the unicorn faces its last movement direction instead.
if (options.aim) firePointer('pointermove', 0);

// Let the encounter run long enough for enemies to leave their spawn pose.
// A list, because the laser only fires once melee hits have charged it: there
// is no way to preview the beam without landing several attacks first.
// Filtered before Number, because ''.split(',') yields [''] and Number('') is
// 0 — which silently fired an attack on frame 0 of every preview.
const attackAt = new Set((options.attack || '').split(',').filter(Boolean).map(Number));
const totalFrames = Number(options.frames || 150);
for (let frame = 0; frame < totalFrames; frame++) {
  if (attackAt.has(frame)) firePointer('pointerdown', 0);
  if (options.laser && frame === totalFrames - Number(options.laser)) firePointer('pointerdown', 2);
  const next = scheduled;
  scheduled = null;
  now += 1000 / 60;
  next(now);
}
let width = WIDTH;
let height = HEIGHT;
let pixels = surface.pixels;
if (cropArgs) {
  // Sprites are 20-odd pixels in a 1280-wide frame, so a crop with an integer
  // magnification is the only way to actually judge one.
  const [x0, y0, w, h, zoom = 1] = cropArgs.split(',').map(Number);
  width = w * zoom;
  height = h * zoom;
  pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = ((y0 + (y / zoom | 0)) * WIDTH + x0 + (x / zoom | 0)) * 4;
    pixels.set(surface.pixels.subarray(from, from + 4), (y * width + x) * 4);
  }
}
writeFileSync(outPath, encodePng(width, height, pixels));
console.log(`${outPath}: ${width}x${height}`);
