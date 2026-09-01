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

// Just enough Web Audio for the shipped sound engine to run against, and a log
// of every note it asks for. Deliberately starts suspended, because that is
// what a real browser does until the page has been interacted with, and half
// the value of this stub is proving the game stays silent until then.
const notes = [];
let audioGestured = false;
let audioState = 'suspended';
const audioParam = () => ({
  setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
  cancelScheduledValues() {},
});
globalThis.AudioContext = class {
  constructor() {
    this.destination = {};
    audioState = 'suspended';
  }

  get state() { return audioState; }
  get currentTime() { return now / 1000; }
  get sampleRate() { return 44100; }
  createGain() { return { gain: audioParam(), connect: target => target }; }
  createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
  createBiquadFilter() {
    return { type: '', frequency: audioParam(), Q: audioParam(), connect: target => target };
  }

  createBufferSource() {
    // Noise voices are real sounds and belong in the log beside the
    // oscillators, but the one-frame silent buffer that unlocks iOS is not
    // one. Looping is what separates them: only the noise buffer does.
    const voice = { frequency: 0, wave: 'noise', stopped: false, loop: false, at: now };
    return {
      buffer: null,
      set loop(value) { voice.loop = value; },
      connect: target => target,
      start() { if (voice.loop) notes.push(voice); },
      stop() { voice.stopped = true; },
    };
  }
  // Only a gesture unlocks it, as in a browser. Leaving it locked for the
  // rest of the suite is deliberate: sound then perturbs nothing else here.
  resume() { if (audioGestured) audioState = 'running'; return Promise.resolve(); }

  createOscillator() {
    // `stopped` is what separates a note from a held voice: a plucked sound
    // schedules its own end the moment it starts, and the beam does not.
    const note = { frequency: 0, wave: '', stopped: false, at: now };
    return {
      set type(value) { note.wave = value; },
      frequency: { ...audioParam(), setValueAtTime(value) { note.frequency = value; } },
      connect: target => target,
      start() { notes.push(note); },
      stop() { note.stopped = true; },
    };
  }
};

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
// the llamacorn's — its mane, its tail, its dash trail and its laser — so a
// bolt drawn in any of those bands reads at a glance as something the player
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

// The beam eats bolts it passes through, and only those. Both halves matter:
// a corridor that catches everything would make holding the trigger a shield,
// and one that catches nothing is a beam visibly crossing a bolt that then
// lands. Aimed west at a bolt closing from the west, with a second bolt on
// the same heading but well off the axis as the control.
isolate();
controls.player.invulnerability = 0;
controls.pointer.seen = false;
Object.assign(controls.player, {
  x: 960, y: 736, previousX: 960, previousY: 736, facingX: -1, facingY: 0,
});
// Three bolts on the same heading. The high one rides the beam itself, which
// is drawn from the horn well above the player's centre; the middle one comes
// in at chest height, under the beam near the muzzle; the low one is nowhere
// near the rainbow and has to survive, or holding the trigger is a shield.
const onBeam = { x: 820, y: 706, previousX: 820, previousY: 706, vx: 190, vy: 0, life: 3, burst: 0 };
const onAxis = { x: 820, y: 736, previousX: 820, previousY: 736, vx: 190, vy: 0, life: 3, burst: 0 };
const offAxis = { x: 820, y: 776, previousX: 820, previousY: 776, vx: 190, vy: 0, life: 3, burst: 0 };
controls.projectiles().push(onBeam, onAxis, offAxis);
controls.laser.charge = 5;
controls.laser.held = true;
step(4);
assert.ok(controls.laser.active, 'Laser did not fire');
assert.ok(onAxis.burst > 0, 'The beam passed through a bolt without stopping it');
assert.ok(onAxis.life > 0, 'A bolt stopped by the beam guttered rather than bursting on it');
assert.ok(onBeam.burst > 0, 'A bolt riding the drawn beam was not intercepted');
assert.equal(offAxis.burst, 0, 'The beam ate a bolt well outside its corridor');

// A burst caused by the beam has to be drawn over it. The beam is eleven
// pixels of opaque rainbow laid on top of the world, so underneath it the
// effect is swallowed in exactly the case it most needs to be seen. Compared
// by index into one frame's fills: the burst's own violets at the bolt, and
// the beam sampled further along its length where only the beam can be.
paints = [];
smoke.draw();
const beamBeyond = paints.findLastIndex(([, px, py]) =>
  Math.hypot(px - (onAxis.x - 60), py - onAxis.y) < 18);
// Violets only, never the inks: the aim marker is drawn after the beam and
// sits at exactly this distance in front of the player, and it is outlined in
// the same INK the burst is. Matching on that made this pass whichever order
// the two were drawn in, which is no assertion at all.
const burstOver = paints.findLastIndex(([paint, px, py]) =>
  ['#213', '#528', '#84e', '#fdf'].includes(paint)
  && Math.hypot(px - onAxis.x, py - onAxis.y) < 24);
paints = null;
assert.ok(beamBeyond >= 0, 'Found no beam to compare the burst against');
assert.ok(burstOver > beamBeyond, 'A burst the beam caused was drawn underneath it');
controls.laser.held = false;
step(120);
// The eaten bolt never arrives; the one that passed beside the beam carries on
// unharmed, which is what keeps holding the trigger from being a shield.
assert.equal(controls.player.health, 5, 'A bolt the beam ate still reached the player');
assert.ok(offAxis.x > 1000, `The off-axis bolt stopped at ${offAxis.x} instead of carrying on`);
assert.ok(!controls.projectiles().includes(onBeam), 'The bolt riding the beam never left');
// Identity has to come off the live array: `state()` hands back copies, so an
// identity check against it can never fail and would assert nothing at all.
assert.ok(!controls.projectiles().includes(onAxis), 'The intercepted bolt never left');
checkpoint('laser-intercept');

// Sound. The engine is a handful of oscillators with no samples behind them,
// so what is worth pinning is the wiring rather than the tuning: nothing heard
// before the browser has allowed it, every event actually reaching the mixer,
// and a burst of identical events collapsing into one sound instead of a stack
// of them. Frequencies are left alone on purpose — those exist to be retuned
// by ear, and a test that breaks every time someone does is one that gets
// deleted rather than maintained.
isolate();
aimRight();
// Clear of the throttle window before checking for silence, or the throttle
// is what proves silent and the browser-permission guard is never exercised.
now += 500;
notes.length = 0;
canvas.dispatch('pointerdown', { button: 0, clientX: 900, clientY: 270 });
step(4);
assert.equal(notes.length, 0, 'The game made noise before the browser allowed audio to start');

// Any gesture unlocks it; the game retries from all of them.
audioGestured = true;
dispatchGlobal('keydown', { code: 'KeyW' });
controls.held.clear();

// The throttle is measured against the audio clock, which only moves inside
// runFrames — so a case wanting two of the same sound has to move it by hand.
const swingFor = enemyHealth => {
  isolate();
  aimRight();
  if (enemyHealth) {
    Object.assign(
      controls.spawnEnemies([[controls.player.x + 40, controls.player.y, 0]])[0],
      { mode: 1, birth: 0, health: enemyHealth },
    );
  }
  now += 500;
  notes.length = 0;
  canvas.dispatch('pointerdown', { button: 0, clientX: 900, clientY: 270 });
  step(4);
  // Texture as well as pitch: several of these are noise rather than a note,
  // and two effects built from different materials should not compare equal.
  return notes.map(note => [note.wave, note.frequency]);
};

const swingOnly = swingFor(0);
assert.ok(swingOnly.length, 'A horn swing was silent');
// Most of these effects are noise rather than pitch, because a horn cutting
// air and stone breaking are both tuneless. That path has its own wiring — a
// shared buffer, a band-pass, a looping source — and none of it is exercised
// by the oscillators, so it is asserted rather than assumed.
assert.ok(swingOnly.some(([wave]) => wave === 'noise'), 'The horn swing moves no air');
const glancing = swingFor(3);
assert.ok(glancing.length > swingOnly.length, 'Landing a hit added no sound of its own');
const fatal = swingFor(1);
assert.notDeepEqual(fatal, glancing, 'A Construct breaking apart sounds exactly like a glancing hit');

isolate();
controls.player.invulnerability = 0;
now += 500;
notes.length = 0;
smoke.damagePlayer(controls.player.x - 1, controls.player.y);
const oneHurt = notes.length;
assert.ok(oneHurt, 'Taking damage was silent');

// Constructs land on the same frame and the beam kills several at once, so
// two of one sound inside the window have to collapse to one. The clock is
// deliberately not advanced here — that is what puts them inside it.
controls.player.invulnerability = 0;
smoke.damagePlayer(controls.player.x - 1, controls.player.y);
assert.equal(notes.length, oneHurt, 'Two hits inside the throttle window stacked two sounds');

// The beam is the one sound that is held rather than struck, so it has its own
// failure mode: started once per frame instead of once per trigger pull, it
// stacks a new set of oscillators sixty times a second and turns into a wall
// of noise that never stops. What matters is that holding the trigger adds
// nothing after the first frame, and that letting go actually releases it.
isolate();
aimRight();
now += 500;
notes.length = 0;
controls.laser.charge = 5;
canvas.dispatch('pointerdown', { button: 2, clientX: 900, clientY: 270 });
smoke.update(1 / 120);
const ignition = notes.length;
assert.ok(ignition, 'Firing the laser was silent');
const held = notes.filter(note => !note.stopped);
assert.ok(held.length, 'The beam scheduled its own end instead of sustaining');
step(90);
assert.equal(notes.length, ignition, 'Holding the beam started a fresh set of oscillators every frame');

controls.laser.held = false;
smoke.update(1 / 120);
assert.ok(held.every(note => note.stopped), 'Releasing the trigger left the beam running');

checkpoint('sound');


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
assert.equal(stateDigest, '34dda25380806623719a9bee255ab28423eead5bc43d55ee95e012a13181479c', 'Gameplay characterisation changed; inspect mechanics before updating this digest');
assert.equal(renderDigest, '4cc1c5d940b66f543420265d4d63e03da91f76b5068958dec0c013f0f8957b39', 'Ordered render commands changed; inspect intentional visuals before updating this digest');

// Footfalls hang off the gait, and the gait is driven by distance travelled
// rather than by the clock — which is what keeps the sound on the animation
// at every speed. Read off the wrong thing it has two failure modes and both
// are bad: firing once a frame, which is a machine rather than an animal, or
// never firing at all. Every row of one effect starts on the same frame, so
// counting distinct start times counts triggers however many rows a recipe
// grows. This has to run the real frame loop rather than `step`, which does
// not advance the clock — with a frozen clock the throttle swallows every
// footfall after the first and the count is always one.
isolate();
now += 500;
notes.length = 0;
controls.held.add('KeyD');
runFrames(72);
const footfalls = new Set(notes.map(note => note.at)).size;
assert.ok(footfalls > 2 && footfalls < 9, `1.2s of trotting made ${footfalls} footfalls`);

// And a llamacorn standing still is silent. Two separate things already
// guarantee that — the gate on striding, and a phase that only advances with
// the ground — so this catches nothing on its own today and is a guard
// against both being loosened at once, not a proof that either works.
controls.held.clear();
runFrames(30);
notes.length = 0;
runFrames(72);
assert.equal(notes.length, 0, 'A llamacorn standing still went on making footsteps');

// A dash is its own sound, and it is the one movement effect that is not the
// ground: it has to fire on the launch itself rather than on anything the
// gait does, so a dash from a standstill still makes it.
notes.length = 0;
assert.ok(dispatchGlobal('keydown', { code: 'Space', repeat: false }));
runFrames(2);
dispatchGlobal('keyup', { code: 'Space' });
assert.ok(notes.length, 'Dashing was silent');

console.log(`game smoke passed (${frameCount} frames, ${calls.length} draw calls, terrain bake ${bakeMs}ms)`);
