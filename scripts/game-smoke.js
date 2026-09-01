// Development-only headless run of the real game module. There is no browser
// in this toolchain, so this is the only automatic check that a render or
// update change did not introduce a runtime error on the hot path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
          update,
          draw,
          damagePlayer,
          state: () => ({
            time: gameTime,
            player: { ...player },
            attack: { ...attack },
            laser: { ...laser },
            camera: { ...camera },
            aim: { ...aim },
            held: [...held],
            trails: trails.length,
            enemies: enemies.map(enemy => ({ ...enemy })),
            projectiles: projectiles.map(projectile => ({ ...projectile })),
            count: arena?.count || 0,
            clock: arena?.clock || 0,
            flash: arena ? [...arena.flash] : [],
          }),
          controls: {
            player, attack, laser, camera, aim, pointer, held, trails,
            enemies: () => enemies,
            projectiles: () => projectiles,
            spawnEnemies: (spawns, arenaEnemy = false) => {
              enemies = spawns.map((spawn, index) => makeEnemy(spawn, 100 + index, arenaEnemy));
              return enemies;
            },
            setArena: value => { arena = value; },
          },
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
const renderTrace = createHash('sha256');
const traceValue = value => typeof value === 'number' ? Number(value.toFixed(6))
  : typeof value === 'string' ? value
    : value?.traceName || `${value?.width ?? ''}x${value?.height ?? ''}`;
const trace = (name, args, state = []) => {
  renderTrace.update(`${JSON.stringify([name, ...args.map(traceValue), ...state.map(traceValue)])}\n`);
};
const record = name => (...args) => {
  calls.push([name, ...args]);
  trace(name, args);
};

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
    createRadialGradient: (...args) => {
      gradientCount++;
      trace('createRadialGradient', args, [gradientCount]);
      return {
        traceName: `gradient:${gradientCount}`,
        addColorStop(...stop) {
          calls.push(['addColorStop', ...stop]);
          trace('addColorStop', stop, [gradientCount]);
        },
      };
    },
    fillRect(...args) {
      for (const value of args) assert.ok(Number.isFinite(value), `fillRect received ${value}`);
      calls.push(['fillRect', ...args]);
      trace('fillRect', args, [this.fillStyle, this.globalAlpha, this.globalCompositeOperation]);
    },
  };
  return context;
}

function fakeCanvas() {
  const context = fakeContext();
  const listeners = new Map();
  return {
    width: 0,
    height: 0,
    clientWidth: 960,
    clientHeight: 540,
    dataset: {},
    textContent: '',
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, fields = {}) {
      let prevented = false;
      const event = { button: 0, clientX: 480, clientY: 270, code: '', repeat: false,
        preventDefault() { prevented = true; }, ...fields };
      for (const handler of listeners.get(type) || []) handler(event);
      return prevented;
    },
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
const globalListeners = new Map();
globalThis.addEventListener = (type, handler) => {
  if (!globalListeners.has(type)) globalListeners.set(type, []);
  globalListeners.get(type).push(handler);
};
const dispatchGlobal = (type, fields = {}) => {
  let prevented = false;
  const event = { button: 0, code: '', key: '', repeat: false,
    preventDefault() { prevented = true; }, ...fields };
  for (const handler of globalListeners.get(type) || []) handler(event);
  return prevented;
};
globalThis.requestAnimationFrame = callback => { scheduled = callback; };
globalThis.ResizeObserver = class { observe() {} };
globalThis.btoa = value => Buffer.from(value, 'binary').toString('base64');
globalThis.atob = value => Buffer.from(value, 'base64').toString('binary');

const started = Date.now();
await import('../src/game.js');
const bakeMs = Date.now() - started;

const smoke = globalThis.__gameSmoke;
const controls = smoke.controls;
const runFrames = (count, milliseconds = 1000 / 60) => {
  for (let frame = 0; frame < count; frame++) {
    const next = scheduled;
    scheduled = null;
    assert.ok(next, 'Game stopped requesting frames');
    now += milliseconds;
    next(now);
    frameCount++;
  }
};
const step = (count, dt = 1 / 120) => {
  for (let index = 0; index < count; index++) smoke.update(dt);
};
const isolate = () => {
  smoke.reset();
  controls.setArena(null);
  controls.held.clear();
};
const aimRight = () => {
  canvas.dispatch('pointermove', { clientX: 900, clientY: 270 });
  smoke.update(1 / 120);
};
const stateTrace = [];
const canonicalState = value => typeof value === 'number' ? Number(value.toFixed(6))
  : Array.isArray(value) ? value.map(canonicalState)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalState(entry)]))
      : value;
const checkpoint = label => stateTrace.push([label, canonicalState(smoke.state())]);

// The real fixed-step frame loop exercises the active arena, camera,
// atmosphere and terrain blit together long enough to spawn both enemy types.
runFrames(480);
const kinds = new Set(calls.map(call => call[0]));
for (const expected of ['drawImage', 'fillRect', 'setTransform', 'addColorStop']) {
  assert.ok(kinds.has(expected), `Render never issued ${expected}`);
}
assert.ok(calls.length > 10000, 'Render issued suspiciously little work');
const arenaState = smoke.state();
assert.ok(arenaState.count >= 3, 'Active arena did not emit several enemies');
assert.ok(arenaState.enemies.some(enemy => enemy.type === 1), 'Arena never emitted its ranged type');
assert.equal(new Set(arenaState.enemies.map(enemy => enemy.id)).size, arenaState.enemies.length, 'Runtime enemy IDs collided');
assert.ok(arenaState.enemies.every(enemy => enemy.arena), 'Arena emitted an authored/leashed enemy');
checkpoint('arena-opening');

// Input is driven through the shipped listeners. Camera and aim stay inside
// their map/viewport bounds, diagonal movement is normalised, key release
// brakes, and unsupported keys remain browser-owned.
isolate();
controls.player.x = controls.player.y = 0;
smoke.update(1 / 120);
assert.deepEqual(
  [smoke.state().camera.x, smoke.state().camera.y],
  [240, 135],
  'Camera exposed off-map space at the north-west corner',
);
isolate();
assert.ok(dispatchGlobal('keydown', { code: 'KeyD' }), 'Game movement did not prevent browser handling');
assert.ok(dispatchGlobal('keydown', { code: 'KeyS' }));
assert.ok(!dispatchGlobal('keydown', { code: 'KeyQ' }));
const movementStart = smoke.state().player;
runFrames(20);
let state = smoke.state();
const travelledX = state.player.x - movementStart.x;
const travelledY = state.player.y - movementStart.y;
assert.ok(travelledX > 5 && travelledY > 5, 'Held movement did not move the player');
assert.ok(Math.abs(travelledX - travelledY) < 0.5, 'Diagonal movement was not normalised evenly');
assert.ok(Math.hypot(state.player.vx, state.player.vy) <= 150.01, 'Diagonal movement exceeded run speed');
dispatchGlobal('keyup', { code: 'KeyD' });
dispatchGlobal('keyup', { code: 'KeyS' });
runFrames(16);
assert.ok(Math.hypot(smoke.state().player.vx, smoke.state().player.vy) < 1, 'Released movement did not brake');
checkpoint('move-and-brake');

// Dash uses current aim when idle, emits trails, grants contact immunity and
// honours the non-repeating Space buffer.
aimRight();
state = smoke.state();
assert.ok(state.aim.x > state.player.x, 'Pointer did not turn aim toward the cursor');
assert.ok(Math.hypot(state.aim.x - state.player.x, state.aim.y - state.player.y) <= 144.001, 'Aim marker escaped its maximum reach');
controls.player.invulnerability = 0;
assert.ok(dispatchGlobal('keydown', { code: 'Space', repeat: false }));
runFrames(2);
state = smoke.state();
assert.ok(state.player.dashTime > 0 && state.player.vx > 500, 'Space did not start an aimed dash');
assert.ok(state.trails > 0, 'Dash did not emit an afterimage trail');
smoke.damagePlayer(state.player.x - 1, state.player.y);
assert.equal(smoke.state().player.health, 5, 'Dash did not protect the player from damage');
checkpoint('dash-immunity');
dispatchGlobal('keyup', { code: 'Space' });

// Pointer aim and horn combat: a swing captures direction, hits once, charges
// exactly once, then a later swing may hit the same enemy again.
isolate();
aimRight();
controls.laser.charge = 0;
let enemy = controls.spawnEnemies([[controls.player.x + 40, controls.player.y, 0]])[0];
assert.ok(canvas.dispatch('pointerdown', { button: 0, clientX: 900, clientY: 270 }));
smoke.update(1 / 120);
assert.equal(enemy.health, 2, 'Horn swing did not hit an enemy in range and arc');
assert.equal(controls.laser.charge, 0.5, 'Horn hit did not add one charge step');
step(10);
assert.equal(enemy.health, 2, 'One horn swing damaged the same enemy repeatedly');
step(20);
canvas.dispatch('pointerdown', { button: 0, clientX: 900, clientY: 270 });
smoke.update(1 / 120);
assert.equal(enemy.health, 1, 'A later horn swing could not hit the enemy again');
checkpoint('two-horn-swings');

isolate();
aimRight();
enemy = controls.spawnEnemies([[controls.player.x - 35, controls.player.y, 0]])[0];
canvas.dispatch('pointerdown', { button: 0, clientX: 900, clientY: 270 });
smoke.update(1 / 120);
assert.equal(enemy.health, 3, 'Horn swing hit an enemy behind its captured arc');

// The laser drains charge, respects per-enemy re-hit cooldown, kills, and
// releases on the global pointerup/blur paths.
isolate();
aimRight();
controls.laser.charge = 1;
enemy = controls.spawnEnemies([[controls.player.x + 60, controls.player.y, 1]])[0];
assert.ok(canvas.dispatch('pointerdown', { button: 2, clientX: 900, clientY: 270 }));
smoke.update(1 / 120);
assert.ok(controls.laser.active && controls.laser.charge < 1, 'Held laser did not activate and drain charge');
assert.equal(enemy.health, 1, 'Laser did not hit an enemy on its ray');
step(20);
assert.equal(enemy.health, 1, 'Laser ignored its enemy re-hit cooldown');
step(30);
assert.equal(enemy.health, 0, 'Sustained laser did not kill after cooldown');
const gradientsBeforeLaserDraw = gradientCount;
smoke.draw();
assert.ok(gradientCount > gradientsBeforeLaserDraw, 'Active laser did not render its dynamic rainbow wash');
checkpoint('laser-kill');
dispatchGlobal('pointerup', { button: 2 });
smoke.update(1 / 120);
assert.equal(controls.laser.active, false, 'Right-button release did not stop the laser');
assert.ok(canvas.dispatch('contextmenu'), 'Canvas context menu was not reserved for the laser');

// Melee and ranged enemy attacks execute their committed windups. Damage
// grants invulnerability, projectiles are consumed on contact, and HUD text
// follows health rather than rendering a panel.
isolate();
controls.player.invulnerability = 0;
enemy = controls.spawnEnemies([[controls.player.x - 30, controls.player.y, 0]])[0];
Object.assign(enemy, { mode: 1, birth: 0, windup: 0.001, attackDirectionX: 1, attackDirectionY: 0 });
smoke.update(0.01);
assert.equal(controls.player.health, 4, 'Committed melee windup did not damage the player');
assert.equal(hud.textContent, 'Health 4 of 5');
smoke.damagePlayer(enemy.x, enemy.y);
assert.equal(controls.player.health, 4, 'Post-hit invulnerability allowed immediate repeat damage');

isolate();
controls.player.invulnerability = 0;
enemy = controls.spawnEnemies([[controls.player.x - 40, controls.player.y, 1]])[0];
Object.assign(enemy, { mode: 1, birth: 0, windup: 0.001, attackDirectionX: 1, attackDirectionY: 0 });
smoke.update(0.01);
assert.equal(smoke.state().projectiles.length, 1, 'Ranged windup did not emit a projectile');
step(40);
state = smoke.state();
assert.equal(state.player.health, 4, 'Projectile did not damage the player');
assert.equal(state.projectiles.length, 0, 'Projectile survived player contact');
checkpoint('enemy-attacks');

// Authored enemies disengage outside their home leash, unlike arena enemies.
isolate();
enemy = controls.spawnEnemies([[controls.player.x, controls.player.y, 0]])[0];
enemy.mode = 1;
enemy.x = enemy.homeX + 80;
controls.player.x = enemy.homeX + 300;
smoke.update(1 / 120);
assert.equal(enemy.mode, 2, 'Authored enemy did not enter return mode beyond its leash');
enemy.x = enemy.homeX;
enemy.y = enemy.homeY;
smoke.update(1 / 120);
assert.equal(enemy.mode, 0, 'Authored enemy did not settle back into idle at home');
isolate();
enemy = controls.spawnEnemies([[controls.player.x + 80, controls.player.y, 0]], true)[0];
const arenaBirthX = enemy.x;
smoke.update(0.1);
assert.equal(enemy.mode, 1, 'Arena enemy inherited authored idle/leash behaviour');
assert.equal(enemy.x, arenaBirthX, 'Materialising arena enemy moved before birth completed');
assert.ok(enemy.birth < 0.45 && enemy.birth > 0, 'Arena birth timer did not advance');
checkpoint('leash-and-arena-birth');

// Death queues one deterministic full encounter reset, including transient
// combat state. The fixed-step frame also caps a tab-sized elapsed time.
isolate();
controls.player.health = 1;
controls.player.invulnerability = 0;
controls.attack.swing = 9;
controls.trails.push({ life: 1 });
smoke.damagePlayer(controls.player.x - 1, controls.player.y);
assert.equal(smoke.state().player.health, 0, 'Lethal damage did not queue death');
smoke.update(1 / 120);
const resetState = smoke.state();
assert.deepEqual(resetState.enemies, [], 'Reset retained arena enemies');
assert.equal(resetState.projectiles.length, 0, 'Reset retained projectiles');
assert.equal(resetState.count, 0, 'Reset retained arena escalation');
assert.equal(resetState.attack.swing, 0, 'Reset retained the melee swing serial');
assert.equal(resetState.player.health, 5, 'Reset did not restore health');
assert.equal(resetState.trails, 0, 'Reset retained dash trails');
assert.ok(resetState.clock > 2, 'Reset did not restore the opening grace period');
assert.ok(resetState.flash.every(value => value === 0), 'Reset retained a gate flash');
const beforeTab = resetState.time;
runFrames(1, 1000);
assert.ok(smoke.state().time - beforeTab <= 0.101, 'Frame loop simulated an uncapped tab-sized delta');
checkpoint('death-reset-and-tab-clamp');

// Blur releases all continuous input, and resize rebuilds only the two cached
// viewport gradients. Every draw path must restore shared canvas state.
dispatchGlobal('keydown', { code: 'KeyW' });
controls.laser.held = true;
dispatchGlobal('blur');
assert.deepEqual(smoke.state().held, []);
assert.equal(controls.laser.held, false);
const gradientsBeforeResize = gradientCount;
canvas.clientWidth = 800;
canvas.clientHeight = 600;
dispatchGlobal('resize');
assert.equal(canvas.width, 1600);
assert.equal(canvas.height, 1200);
assert.equal(gradientCount, gradientsBeforeResize + 2, 'Resize did not rebuild exactly the cached viewport gradients');
assert.equal(canvas.context.globalAlpha, 1, 'A draw pass leaked a globalAlpha');
assert.equal(canvas.context.globalCompositeOperation, 'source-over', 'A draw pass leaked a composite mode');
for (const [name, ...args] of calls) for (const value of args) if (typeof value === 'number') {
  assert.ok(Number.isFinite(value), `${name} received non-finite ${value}`);
}
const stateDigest = createHash('sha256').update(JSON.stringify(stateTrace)).digest('hex');
const renderDigest = renderTrace.copy().digest('hex');
assert.equal(stateDigest, 'd64594b6b3a7da707079f613c44556e0dcd82728d6d6583401e3d29eb78e4eec', 'Gameplay characterisation changed; inspect mechanics before updating this digest');
assert.equal(renderDigest, 'c502ea44f5a63ccd5b27ed4589e2254f3e6420f5416f072e62153f8d01333a44', 'Ordered render commands changed; inspect intentional visuals before updating this digest');

console.log(`game smoke passed (${frameCount} frames, ${calls.length} draw calls, terrain bake ${bakeMs}ms)`);
