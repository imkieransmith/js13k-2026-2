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
let paints = null;
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
      // Colour is only collected while a case has opened a bucket for it.
      // Half a million rects go through here across a full run, and almost no
      // assertion cares what any of them were painted with.
      if (paints) paints.push([this.fillStyle, args[0] + args[2] / 2, args[1] + args[3] / 2]);
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
// Contact consumes the bolt, but it is no longer removed on the frame it
// lands: it stops where it hit and spends its burst there. What has to be
// true is that it can never damage anything again, and that it does leave.
assert.equal(state.projectiles.length, 1, 'A spent projectile did not stay to burst');
assert.ok(state.projectiles[0].burst > 0, 'A projectile survived player contact still live');
controls.player.invulnerability = 0;
step(60);
assert.equal(smoke.state().player.health, 4, 'A bursting projectile damaged the player a second time');
assert.equal(smoke.state().projectiles.length, 0, 'A burst never expired');
checkpoint('enemy-attacks');

// Cover. The column drums on the sand are opaque to both sides: the geometry
// that stops a body has to stop a sight line, a shot, and the rainbow laser
// too, or the arena's only cover is decoration. The north-west drum blocks
// world x 672..736 and — because a Wall's front face is drawn on the tile
// below it — down to y 640, so a straight line from 704,500 to 704,690 runs
// through it while both ends stand on open sand.
const COVER_X = 704;
const placeAcrossCover = (type, arenaEnemy = false) => {
  isolate();
  controls.player.invulnerability = 0;
  Object.assign(controls.player, { x: COVER_X, y: 690, previousX: COVER_X, previousY: 690 });
  const spawned = controls.spawnEnemies([[COVER_X, 500, type]], arenaEnemy);
  return Object.assign(spawned[0], { mode: 1, birth: 0, cooldown: 0 });
};

// A shrine with no line does not commit to a wind-up, and closes rather than
// standing off — the answer to a blocked shot is to go and find an angle.
let covered = placeAcrossCover(1, true);
step(60);
assert.equal(covered.windup, 0, 'A shrine started a wind-up through a column drum');
assert.equal(smoke.state().projectiles.length, 0, 'A shrine fired through a column drum');
const coveredStart = Math.hypot(covered.x - COVER_X, covered.y - 690);
step(360);
assert.ok(
  Math.hypot(covered.x - COVER_X, covered.y - 690) < coveredStart,
  'A blocked shrine held its distance instead of looking for an angle',
);

// The same shrine in the open does commit, which is what proves the check
// above is reading the level rather than simply never firing.
isolate();
controls.player.invulnerability = 0;
Object.assign(controls.player, { x: COVER_X, y: 690, previousX: COVER_X, previousY: 690 });
const clear = Object.assign(
  controls.spawnEnemies([[COVER_X, 500 + 190, 1]], true)[0],
  { mode: 1, birth: 0, cooldown: 0 },
);
step(60);
assert.ok(clear.windup > 0, 'A shrine with a clear line never committed');

// A shot already in flight is eaten by the stone, so ducking behind cover
// during a telegraph is a real dodge rather than a cosmetic one.
covered = placeAcrossCover(1, true);
Object.assign(covered, { windup: 0.001, attackDirectionX: 0, attackDirectionY: 1 });
smoke.update(0.01);
assert.equal(smoke.state().projectiles.length, 1, 'Committed ranged wind-up emitted no projectile');
// It comes apart on the stone rather than blinking out, which means it stays
// in the list — pinned, harmless, and still carrying the heading its spray is
// thrown back along — until the burst is over.
step(32);
const spent = smoke.state().projectiles[0];
assert.ok(spent && spent.burst > 0, 'A projectile vanished on impact instead of bursting');
assert.ok(spent.y < 544, `A burst settled at y ${spent.y}, inside the stone rather than against its face`);
assert.ok(spent.vy > 0, 'A burst discarded the heading its spray is thrown along');
assert.ok(spent.life > 0, 'A bolt stopped by stone is indistinguishable from one that ran out');
step(120);
assert.equal(smoke.state().projectiles.length, 0, 'A projectile passed through a column drum');
assert.equal(controls.player.health, 5, 'A projectile damaged the player through a column drum');

// The rainbow laser stops at the stone as well, and one clamp covers both the
// beam that is drawn and the sweep that deals its damage.
covered = placeAcrossCover(0, true);
// Aim is re-derived from the pointer every step when the mouse has been seen,
// so facing has to be set through the pointer rather than written directly.
controls.pointer.seen = false;
Object.assign(controls.player, { facingX: 0, facingY: -1 });
controls.laser.held = true;
controls.laser.charge = 5;
smoke.update(1 / 120);
assert.ok(controls.laser.active, 'Laser did not fire');
assert.ok(controls.laser.reach < 60, `Laser ran ${controls.laser.reach} units into a column drum`);
step(120);
assert.equal(covered.health, 3, 'The laser killed a Construct through a column drum');
controls.laser.held = false;

// A walker with a drum square between it and the player gets round it. The
// old straight-line slide deadlocked here: both axes refused at once and the
// machine ground at the stone for as long as the player stood still.
covered = placeAcrossCover(0, true);
step(720);
assert.ok(
  Math.hypot(covered.x - COVER_X, covered.y - 690) < 60,
  `A walker stalled ${Math.round(Math.hypot(covered.x - COVER_X, covered.y - 690))} units short of the player`,
);
checkpoint('cover');

// A Construct's shot has to be visibly the Constructs' magic. The rainbow is
// the llamacorn's — it is her mane, her tail, her dash trail and her laser —
// so a bolt drawn in any of those bands reads at a glance as something she
// fired, which is the one thing a projectile the player has to dodge must
// never do. The bolt was gold and white before the arena had any violet
// vocabulary to belong to; this is what stops it drifting back.
isolate();
controls.player.invulnerability = 0;
Object.assign(controls.player, { x: 960, y: 736, previousX: 960, previousY: 736 });
Object.assign(
  controls.spawnEnemies([[660, 736, 1]], true)[0],
  { mode: 1, birth: 0, windup: 0.001, attackDirectionX: 1, attackDirectionY: 0 },
);
smoke.update(0.01);
const bolt = smoke.state().projectiles[0];
assert.ok(bolt, 'Ranged wind-up emitted no projectile to inspect');
// Fly it clear of the shrine that fired it, so a window round the bolt holds
// the bolt and nothing else. It stays hundreds of units short of the player.
step(60);
const flown = smoke.state().projectiles[0];
assert.ok(flown && flown.x - bolt.x > 60, 'Projectile did not travel clear of its shrine');
paints = [];
smoke.draw();
const boltPaints = new Set(paints
  .filter(([, x, y]) => Math.hypot(x - flown.x, y - flown.y) < 16)
  .map(([paint]) => paint));
paints = null;
assert.ok(boltPaints.size, 'Nothing at all was drawn where the projectile is');
// Ink and the Constructs' violets only. Listed rather than pattern-matched:
// the point is that this set is small and deliberate.
const CONSTRUCT_PAINT = new Set(['#1b1a2c', '#182129', '#213', '#528', '#84e', '#fdf']);
for (const paint of boltPaints) {
  assert.ok(CONSTRUCT_PAINT.has(paint), `A Construct's shot is painted ${paint}, which is not its magic`);
}
assert.ok(boltPaints.has('#84e'), 'A shot never lit a core, so it cannot read against dark ground');

// Draw one frame while the muzzle burst is still live, which is the only pass
// that puts `drawEnemyAttack` into the ordered render trace at all.
const burst = Object.assign(
  controls.spawnEnemies([[900, 736, 1]], true)[0],
  { mode: 1, birth: 0, attackEffect: 0.16, attackDirectionX: 1, attackDirectionY: 0 },
);
smoke.draw();
assert.ok(burst.attackEffect > 0, 'Muzzle burst expired before it could be drawn');
checkpoint('shot-palette');

// The other way a bolt can end. Most find masonry — the arena is enclosed and
// a shrine only fires from inside 280 units — but one that misses in the open
// used to blink out of existence mid-flight, which is the single moment the
// shot stopped being an object. It gutters instead, and the burst tells the
// two deaths apart by the clock the bolt died with: no field is spent on it,
// because a bursting bolt is never stepped again.
isolate();
Object.assign(controls.player, { x: 960, y: 736, previousX: 960, previousY: 736 });
// Aimed north, away from the player, into open sand well inside the podium.
controls.projectiles().push({
  x: 960, y: 640, previousX: 960, previousY: 640, vx: 0, vy: -190, life: 0.05, burst: 0,
});
step(8);
const guttered = smoke.state().projectiles[0];
assert.ok(guttered && guttered.burst > 0, 'A bolt that ran out of range vanished instead of guttering');
assert.ok(guttered.life <= 0, 'A guttering bolt is indistinguishable from one that hit something');
step(40);
assert.equal(smoke.state().projectiles.length, 0, 'A guttering bolt never expired');
checkpoint('shot-fizzle');

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
assert.equal(stateDigest, 'b2be6973b772e51d8ff108d1f6e81d889d7a6445240fd2fd6d9a76d45c7b9a46', 'Gameplay characterisation changed; inspect mechanics before updating this digest');
assert.equal(renderDigest, 'a03689fda94f3d3754059f81112ed9adbdb7b3e37b2c95d11b5399670513e982', 'Ordered render commands changed; inspect intentional visuals before updating this digest');

console.log(`game smoke passed (${frameCount} frames, ${calls.length} draw calls, terrain bake ${bakeMs}ms)`);
