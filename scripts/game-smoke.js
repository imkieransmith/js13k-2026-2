// Development-only headless run of the real game module. There is no browser
// in this toolchain, so this is the only automatic check that a render or
// update change did not introduce a runtime error on the hot path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// The game imports its level as a bare JSON module, which is Vite's resolution
// rather than Node's. Teaching the loader that one trick is what lets the smoke
// test import the shipped module unmodified instead of a copy of it.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/game.js')) {
      const source = readFileSync(new URL(url), 'utf8').replace(
        'updateHud();\nrequestAnimationFrame(frame);',
        `updateHud();
        globalThis.__gameSmoke = {
          reset: resetEncounter,
          state: () => ({
            health: player.health,
            swing: attack.swing,
            enemies: enemies.map(({ id, type, birth, health, arena }) => ({ id, type, birth, health, arena })),
            projectiles: projectiles.length,
            count: arena?.count || 0,
            clock: arena?.clock || 0,
            flash: arena ? [...arena.flash] : [],
          }),
        };
        requestAnimationFrame(frame);`,
      );
      return { format: 'module', shortCircuit: true, source };
    }
    if (!url.endsWith('.json')) return nextLoad(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${readFileSync(new URL(url), 'utf8')}`,
    };
  },
});

const calls = [];
let gradientCount = 0;
const record = name => (...args) => { calls.push([name, ...args]); };

/**
 * A permissive 2D context: every drawing call is recorded rather than
 * validated, so the test fails on missing identifiers and bad arithmetic, not
 * on pixel output. Numeric arguments are checked, because a NaN coordinate
 * silently draws nothing in a real browser and is exactly the kind of
 * regression this catches.
 */
function fakeContext() {
  const context = {
    canvas: null,
    fillStyle: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    setTransform: record('setTransform'),
    drawImage: record('drawImage'),
    createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: record('putImageData'),
    createRadialGradient: () => {
      gradientCount++;
      return { addColorStop: record('addColorStop') };
    },
    fillRect(...args) {
      for (const value of args) assert.ok(Number.isFinite(value), `fillRect received ${value}`);
      calls.push(['fillRect', ...args]);
    },
  };
  return context;
}

function fakeCanvas() {
  const context = fakeContext();
  return {
    width: 0,
    height: 0,
    clientWidth: 960,
    clientHeight: 540,
    dataset: {},
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
    addEventListener() {},
    setAttribute() {},
    context,
  };
}

const canvas = fakeCanvas();
const hud = fakeCanvas();
let frameCount = 0;
let now = 0;
let scheduled = null;

globalThis.document = {
  querySelector: selector => selector === '#c' ? canvas : hud,
  createElement: fakeCanvas,
};
globalThis.devicePixelRatio = 2;
globalThis.performance = { now: () => now };
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = callback => { scheduled = callback; };
globalThis.ResizeObserver = class { observe() {} };
globalThis.btoa = value => Buffer.from(value, 'binary').toString('base64');
globalThis.atob = value => Buffer.from(value, 'base64').toString('binary');

const started = Date.now();
await import('../src/game.js');
const bakeMs = Date.now() - started;

// Advance real frames, which exercises the fixed-step update loop, the camera,
// enemy AI, the atmosphere pass and the terrain blit together.
while (frameCount < 480) {
  const next = scheduled;
  scheduled = null;
  assert.ok(next, 'Game stopped requesting frames');
  now += 1000 / 60;
  next(now);
  frameCount++;
}

const kinds = new Set(calls.map(call => call[0]));
for (const expected of ['drawImage', 'fillRect', 'setTransform', 'addColorStop']) {
  assert.ok(kinds.has(expected), `Render never issued ${expected}`);
}
assert.ok(calls.length > 10000, 'Render issued suspiciously little work');
const arenaState = globalThis.__gameSmoke.state();
assert.ok(arenaState.count >= 3, 'Active arena did not emit several enemies');
assert.ok(arenaState.enemies.some(enemy => enemy.type === 1), 'Arena never emitted its ranged type');
assert.equal(new Set(arenaState.enemies.map(enemy => enemy.id)).size, arenaState.enemies.length, 'Runtime enemy IDs collided');
assert.ok(arenaState.enemies.every(enemy => enemy.arena), 'Arena emitted an authored/leashed enemy');
globalThis.__gameSmoke.reset();
const resetState = globalThis.__gameSmoke.state();
assert.deepEqual(resetState.enemies, [], 'Reset retained arena enemies');
assert.equal(resetState.projectiles, 0, 'Reset retained projectiles');
assert.equal(resetState.count, 0, 'Reset retained arena escalation');
assert.equal(resetState.swing, 0, 'Reset retained the melee swing serial');
assert.equal(resetState.health, 5, 'Reset did not restore health');
assert.ok(resetState.clock > 2, 'Reset did not restore the opening grace period');
assert.ok(resetState.flash.every(value => value === 0), 'Reset retained a gate flash');
// Grade and hurt wash are viewport resources. The rainbow wash is deliberately
// dynamic, but an idle render must not rebuild either static gradient.
assert.equal(gradientCount, 2, 'Render loop rebuilt a cached screen gradient');
assert.equal(canvas.context.globalAlpha, 1, 'A draw pass leaked a globalAlpha');
assert.equal(canvas.context.globalCompositeOperation, 'source-over', 'A draw pass leaked a composite mode');

console.log(`game smoke passed (${frameCount} frames, ${calls.length} draw calls, terrain bake ${bakeMs}ms)`);
