import levelSource from './levels/level1.json';
import { buildTerrain, drawTerrain, moveOnTerrain, terrainHash as hash, unpackLevel } from './terrain.js';

(() => {
'use strict';

const canvas = document.querySelector('#c');
const ctx = canvas.getContext('2d');
const hud = document.querySelector('#hud');
const level = unpackLevel(levelSource);

// World units are deliberately independent of screen pixels. Keeping the
// simulation in one coordinate system means camera zoom and device pixel ratio
// can change without changing how the character handles.
const WORLD = { width: level.width, height: level.height };
const PLAYER_HALF = 10;
const PLAYER_MAX_HEALTH = 5;
const MOVE_SPEED = 150;
const ACCELERATION = 1100;
const BRAKING = 1500;
const DASH_SPEED = 520;
const DASH_TIME = 0.18;
const DASH_COOLDOWN = 0.32;
const ATTACK_DURATION = 0.14;
const ATTACK_COOLDOWN = 0.2;
const ATTACK_REACH = 52;
const ATTACK_ARC = Math.PI / 2;
const LASER_MAX_CHARGE = 5;
const LASER_HIT_CHARGE = 0.5;
const LASER_WIDTH = 7;
// TODO: remove before shipping. Debug only, so the beam can be fired without
// grinding melee hits out of a Construct first. The shipping value is 0 — the
// laser is supposed to be something you earn during a fight, not something you
// arrive holding.
const DEBUG_START_CHARGE = LASER_MAX_CHARGE;
// Juice dials, deliberately set past the ceiling. Finding what is too much and
// coming down lands somewhere honest; creeping up from nothing always stops at
// the first value that is merely acceptable. Every one of these is expected to
// halve, roughly, once we have watched it.
const SHAKE_HIT = 8;
const SHAKE_KILL = 16;
const SHAKE_HURT = 14;
const SHAKE_LASER = 13;
// The rumble the beam settles into once the ignition has rung out. It has to
// stay well under SHAKE_HIT: the laser shakes the frame every time it lands a
// hit, and a floor anywhere near that amplitude would be the one thing capable
// of hiding the laser's own hits.
const SHAKE_LASER_HOLD = 3;
// Shake bleeds off at a fixed rate rather than a fixed duration, so an
// amplitude is a duration too: halving a number shortens its shake as well as
// narrowing it. Decay came down alongside the amplitudes to hold the ring times
// roughly where they were — a kill that is half as wide and half as long stops
// registering as a kill at all.
const SHAKE_DECAY = 26;
// Impacts are damped while the beam is up. The laser already owns the frame
// with its vignette, its zoom and its own rumble, and a full-strength kill
// spike on top of all that was the one combination that read as noise rather
// than as feedback. At this scale a kill under the beam lands about as hard as
// a melee hit does in silence, which is enough to be felt through the rumble.
const SHAKE_LASER_DAMP = 0.55;
// The laser's ignition flare: how long it runs, how far the view punches in,
// and how much fatter the beam is while it lasts.
const PUNCH_TIME = 0.22;
const PUNCH_ZOOM = 0.16;
const PUNCH_WIDTH = 4;
// Rainbow bands per second travelling out through the laser's vignette. Slow
// enough to read as a flow rather than a flicker at the edge of vision.
const VIGNETTE_SCROLL = 2.5;
// How far the beam takes to come up to full opacity. Without it the muzzle end
// is a cut edge — an obvious rectangle with an outline drawn round it, which is
// the one place the beam looks drawn rather than emitted.
const BEAM_FADE = 26;
const MELEE_WINDUP = 0.45;
const RANGED_WINDUP = 0.62;
const ENEMY_ATTACK_EFFECT = 0.16;
const ENEMY_HURT_FLASH = 0.45;
const CONSTRUCT_DEATH = 0.92;
const ENEMY_ATTACK_REACH = 52;
const ENEMY_ATTACK_ARC = Math.PI * 0.58;
const ENEMY_AGGRO = 210;
const ENEMY_LEASH = 250;
const ENEMY_ROAM = 235;
const AIM_DISTANCE = 144;
const AIM_MARGIN = 9;
const BASE_ZOOM = 2;
const FIXED_STEP = 1 / 120;
const SHAFT_SPACING = 232;
const MOTE_CELL = 72;
const SHAFT_SKEW = 0.55;

// One spectrum for every rainbow in the game — mane, tail, dash trail, horn
// sweep and laser. Sharing it is what makes them read as the same magic rather
// than as five effects that happen to be colourful.
const RAINBOW = ['#ff7ab0', '#ffc55c', '#fff3a6', '#8ce6a0', '#6fc8f5', '#b48cf0'];
const DARK_RAINBOW = ['#a34', '#a74', '#a97', '#497', '#378', '#647'];
// Two dark inks, one warm for the llamacorn and its magic and one cool for the
// stone Constructs. Every sprite and effect is built silhouette-first out of
// these, so a single pixel of ink shows around each shape: the reference art
// outlines everything at exactly one pixel, and a thicker border is the single
// thing that most makes a sprite look pasted onto the world rather than in it.
const INK = '#1b1a2c';
const STONE_INK = '#182129';
const WARNING = '#e0324f';
const HOT = '#fffdf2';
// Whatever is animating the rubble. Violet at rest, magenta once roused: it is
// the only saturated colour anywhere on a Construct, so aggro reads instantly.
const MAGIC_HOT = '#fdf';
// Floor-slab light, body, carving and wall shadow. Constructs look torn from
// the same temple tiles rather than assembled from generic grey machinery.
const STONE = ['#dbd8bf', '#cbc8b0', '#969584', '#687c74'];
// One tail band per landed hit in a full charge, so a hit always lights
// exactly one more band. A meter whose steps do not divide evenly into the
// thing filling it leaves hits that visibly do nothing.
const TAIL_SEGMENTS = LASER_MAX_CHARGE / LASER_HIT_CHARGE;
// The plume swells through its middle and tapers at the tip. A tail of even
// width is a progress bar with a horse attached; the taper is what lets it be
// large enough to read a ten-step gauge at 2x and still look like hair.
const TAIL_WIDTHS = [4, 6, 7, 8, 7, 7, 6, 5, 4, 4];
// The rainbow fleece, as offsets from the head: six strands stepping back and
// down the crest from behind the ears onto the back.
const MANE = [[1, -20, 5, 3], [0, -17, 5, 3], [-1, -14, 5, 3], [-2, -11, 6, 2], [-3, -9, 6, 2], [-4, -7, 6, 2]];

let screenWidth = 1;
let screenHeight = 1;
let zoom = BASE_ZOOM;
let viewWidth = 1;
let viewHeight = 1;
let lastTime = performance.now();
let accumulator = 0;
let renderScale = 1;
let renderOffsetX = 0;
let renderOffsetY = 0;
let grade = null;
let hurtVignette = null;

const player = {
  x: level.player[0],
  y: level.player[1],
  previousX: level.player[0],
  previousY: level.player[1],
  vx: 0,
  vy: 0,
  facingX: 0,
  facingY: 1,
  dashX: 0,
  dashY: 1,
  dashTime: 0,
  dashCooldown: 0,
  trailClock: 0,
  step: 0,
  health: PLAYER_MAX_HEALTH,
  invulnerability: 0,
  hitEffect: 0,
  hurtGlow: 0,
  tuck: 0,
  walk: 0,
};

const camera = { x: player.x, y: player.y, previousX: player.x, previousY: player.y };
const aim = {
  x: player.x,
  y: player.y + AIM_DISTANCE,
  previousX: player.x,
  previousY: player.y + AIM_DISTANCE,
};
const pointer = { x: 0, y: 0, seen: false };
const attack = { time: 0, cooldown: 0, directionX: 0, directionY: 1, hits: 0 };
const laser = { charge: DEBUG_START_CHARGE, held: false, active: false, directionX: 0, directionY: 1, reach: 0, punch: 0 };
const ENEMY_SPAWNS = level.enemies;
const makeEnemies = () => ENEMY_SPAWNS.map(([x, y, type], id) => ({
  id, type, x, y, previousX: x, previousY: y, homeX: x, homeY: y,
  targetX: x, targetY: y, mode: 0, health: type ? 2 : 3,
  think: id * 0.2, step: 0, cooldown: 0.4 + id * 0.13,
  windup: 0, attackEffect: 0,
  attackDirectionX: 0, attackDirectionY: 1,
  hurt: 0, hitEffect: 0, death: 0, laserCooldown: 0, knockX: 0, knockY: 0,
}));
let enemies = makeEnemies();
let projectiles = [];
const terrain = buildTerrain(level);
const held = new Set();
const trails = [];
let dashBuffer = 0;
let attackBuffer = 0;
let resetQueued = false;
let gameTime = 0;
let shake = 0;
let hudHealth = -1;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// Dynamic sprites are snapped after the camera transform. Rounding them in
// world space made diagonal fractional movement fight the smoother camera.
const pixelX = value =>
  (Math.round(value * renderScale + renderOffsetX) - renderOffsetX) / renderScale;
const pixelY = value =>
  (Math.round(value * renderScale + renderOffsetY) - renderOffsetY) / renderScale;
const moveToward = (value, target, amount) =>
  value < target ? Math.min(value + amount, target) : Math.max(value - amount, target);

/** Return a normalised movement vector so diagonals are not faster. */
function readMovement() {
  let x = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
  let y = (held.has('KeyS') ? 1 : 0) - (held.has('KeyW') ? 1 : 0);
  const length = Math.hypot(x, y);
  if (length) {
    x /= length;
    y /= length;
  }
  return { x, y, moving: length > 0 };
}

function cameraLimits() {
  return {
    minX: viewWidth / 2,
    maxX: WORLD.width - viewWidth / 2,
    minY: viewHeight / 2,
    maxY: WORLD.height - viewHeight / 2,
  };
}

/** Clamp the camera centre, which guarantees no off-map area can be exposed. */
function clampCamera() {
  const limits = cameraLimits();
  camera.x = clamp(camera.x, limits.minX, limits.maxX);
  camera.y = clamp(camera.y, limits.minY, limits.maxY);
}

function resize() {
  const dpr = devicePixelRatio || 1;
  screenWidth = canvas.clientWidth;
  screenHeight = canvas.clientHeight;
  canvas.width = Math.round(screenWidth * dpr);
  canvas.height = Math.round(screenHeight * dpr);

  // An integer zoom keeps later pixel art crisp. On an unusually large
  // display it increases until the world still covers the complete viewport.
  zoom = Math.max(BASE_ZOOM, Math.ceil(screenWidth / WORLD.width), Math.ceil(screenHeight / WORLD.height));
  viewWidth = screenWidth / zoom;
  viewHeight = screenHeight / zoom;
  ctx.imageSmoothingEnabled = false;
  buildGrade();
  clampCamera();
  // A resize is an instantaneous change of view, not simulation movement.
  // Syncing both samples prevents interpolation from the old camera limits.
  camera.previousX = camera.x;
  camera.previousY = camera.y;
}

function beginDash(input) {
  const hasInput = input.moving;
  player.dashX = hasInput ? input.x : player.facingX;
  player.dashY = hasInput ? input.y : player.facingY;
  player.vx = player.dashX * DASH_SPEED;
  player.vy = player.dashY * DASH_SPEED;
  player.dashTime = DASH_TIME;
  player.dashCooldown = DASH_COOLDOWN;
  player.trailClock = 0;
  dashBuffer = 0;
}

function updatePlayer(dt) {
  const input = readMovement();
  player.invulnerability = Math.max(0, player.invulnerability - dt);
  player.hitEffect = Math.max(0, player.hitEffect - dt);
  player.dashCooldown = Math.max(0, player.dashCooldown - dt);
  dashBuffer = Math.max(0, dashBuffer - dt);
  // Chased rather than switched, so the legs fold and unfold instead of
  // snapping between two poses. It has to converge inside DASH_TIME to be worth
  // drawing at all — at this rate the fold is most of the way there by the time
  // the dash is half over — and because it is only ever chasing the flag, the
  // unfold carries on after the dash has ended and reads as the landing.
  player.tuck += ((player.dashTime ? 1 : 0) - player.tuck) * Math.min(1, dt * 22);

  if (dashBuffer && !player.dashCooldown) beginDash(input);

  if (player.dashTime > 0) {
    player.dashTime = Math.max(0, player.dashTime - dt);
    player.vx = player.dashX * DASH_SPEED;
    player.vy = player.dashY * DASH_SPEED;
    player.trailClock -= dt;
    if (player.trailClock <= 0) {
      // Facing and colour belong to the captured pose. Deriving either while
      // drawing makes every surviving ghost flip or change hue together when
      // the aim turns or the oldest sample expires.
      trails.push({
        x: player.x, y: player.y, life: 0.16,
        flip: player.facingX < 0 ? -1 : 1,
        colour: RAINBOW[(gameTime * 40 | 0) % RAINBOW.length],
      });
      player.trailClock = 0.025;
    }
    // Returning to running speed avoids a sticky pause at the end of a dash.
    if (!player.dashTime) {
      player.vx = player.dashX * MOVE_SPEED;
      player.vy = player.dashY * MOVE_SPEED;
    }
  } else {
    const targetX = input.x * MOVE_SPEED;
    const targetY = input.y * MOVE_SPEED;
    const rate = input.moving ? ACCELERATION : BRAKING;
    player.vx = moveToward(player.vx, targetX, rate * dt);
    player.vy = moveToward(player.vy, targetY, rate * dt);
  }

  const blocked = moveOnTerrain(level, player, player.vx * dt, player.vy * dt, PLAYER_HALF);
  if (blocked & 1) player.vx = 0;
  if (blocked & 2) player.vy = 0;

  // The gait is driven by distance travelled, not by elapsed time, so the legs
  // stay in step with the ground at every speed instead of skating.
  player.step += Math.hypot(player.vx, player.vy) * dt;
  // How much of the walk cycle to apply, chased rather than switched. The phase
  // comes from distance and so stops dead when the animal does, but the
  // amplitude used to stop dead with it, which popped the body and all four
  // legs to neutral in a single frame the moment you let go of a key. Easing
  // this instead lets the cycle settle out of whatever pose it was caught in.
  const striding = Math.hypot(player.vx, player.vy) > 12 && !player.dashTime;
  player.walk += ((striding ? 1 : 0) - player.walk) * Math.min(1, dt * 12);

  for (const trail of trails) trail.life -= dt;
  while (trails[0] && trails[0].life <= 0) trails.shift();
}

function updateAttack(dt) {
  attack.time = Math.max(0, attack.time - dt);
  attack.cooldown = Math.max(0, attack.cooldown - dt);
  attackBuffer = Math.max(0, attackBuffer - dt);
  if (!attackBuffer || attack.cooldown) return;

  // Capture facing at the instant of the attack; moving the mouse afterwards
  // must not bend an already-committed horn sweep.
  attack.directionX = player.facingX;
  attack.directionY = player.facingY;
  attack.time = ATTACK_DURATION;
  attack.cooldown = ATTACK_COOLDOWN;
  attack.hits = 0;
  attackBuffer = 0;
}

function updateCamera() {
  // Lock directly to the player whenever the viewport has room to move. The
  // clamp alone creates the edge behaviour: the player crosses the screen
  // until reaching its centre, then camera and player move together exactly.
  const limits = cameraLimits();
  camera.x = clamp(player.x, limits.minX, limits.maxX);
  camera.y = clamp(player.y, limits.minY, limits.maxY);
}

/** Convert the mouse from screen space and cap its world-space reach. */
function viewportReach(dirX, dirY, margin) {
  const spanX = viewWidth / 2 - margin;
  const spanY = viewHeight / 2 - margin;
  return Math.max(0, Math.min(
    dirX ? ((dirX > 0 ? spanX : -spanX) + camera.x - player.x) / dirX : Infinity,
    dirY ? ((dirY > 0 ? spanY : -spanY) + camera.y - player.y) / dirY : Infinity,
  ));
}

function updateAim() {
  let dx = player.facingX * AIM_DISTANCE;
  let dy = player.facingY * AIM_DISTANCE;
  if (pointer.seen) {
    const pointerWorldX = camera.x + (pointer.x - screenWidth / 2) / zoom;
    const pointerWorldY = camera.y + (pointer.y - screenHeight / 2) / zoom;
    dx = pointerWorldX - player.x;
    dy = pointerWorldY - player.y;
  }

  const distance = Math.hypot(dx, dy);
  if (distance > 0.001) {
    player.facingX = dx / distance;
    player.facingY = dy / distance;
  }
  // Keep the complete marker inside the current viewport. This matters near
  // map edges and on small displays where the full aim radius cannot fit.
  const reach = Math.min(
    distance, AIM_DISTANCE,
    viewportReach(player.facingX, player.facingY, AIM_MARGIN),
  );
  aim.x = player.x + player.facingX * reach;
  aim.y = player.y + player.facingY * reach;
}

function moveEnemy(enemy, targetX, targetY, speed, dt) {
  const dx = targetX - enemy.x;
  const dy = targetY - enemy.y;
  const distance = Math.hypot(dx, dy) || 1;
  let moveX = (dx / distance * speed + enemy.knockX) * dt;
  let moveY = (dy / distance * speed + enemy.knockY) * dt;
  const damping = Math.max(0, 1 - dt * 8);
  enemy.knockX *= damping;
  enemy.knockY *= damping;

  // Clamp the intended destination to its authored home territory, then let
  // the same terrain collision used by the player slide it around obstacles.
  const homeX = enemy.x + moveX - enemy.homeX;
  const homeY = enemy.y + moveY - enemy.homeY;
  const homeDistance = Math.hypot(homeX, homeY);
  if (homeDistance > ENEMY_ROAM) {
    moveX = enemy.homeX + homeX / homeDistance * ENEMY_ROAM - enemy.x;
    moveY = enemy.homeY + homeY / homeDistance * ENEMY_ROAM - enemy.y;
  }
  moveOnTerrain(level, enemy, moveX, moveY, 12);
}

// Health only, and only when it changes. Charge moves continuously while the
// laser fires, and announcing that would talk over everything else.
function updateHud() {
  if (player.health === hudHealth) return;
  hudHealth = player.health;
  hud.textContent = `Health ${hudHealth} of ${PLAYER_MAX_HEALTH}`;
}

function damagePlayer(sourceX, sourceY) {
  if (player.invulnerability || player.dashTime || resetQueued) return;
  const dx = player.x - sourceX;
  const dy = player.y - sourceY;
  const distance = Math.hypot(dx, dy) || 1;
  player.vx = dx / distance * 180;
  player.vy = dy / distance * 180;
  player.health--;
  player.invulnerability = 0.7;
  player.hitEffect = 0.18;
  shake = Math.max(shake, SHAKE_HURT);
  player.hurtGlow = 1;
  updateHud();
  if (!player.health) resetQueued = true;
}

function spawnProjectile(enemy) {
  projectiles.push({
    x: enemy.x, y: enemy.y, previousX: enemy.x, previousY: enemy.y,
    vx: enemy.attackDirectionX * 190, vy: enemy.attackDirectionY * 190, life: 2.4,
  });
}

function hurtEnemy(enemy, knockX, knockY) {
  enemy.health--;
  enemy.hurt = ENEMY_HURT_FLASH;
  enemy.hitEffect = 0.16;
  enemy.knockX = knockX;
  enemy.knockY = knockY;
  shake = Math.max(shake, (enemy.health ? SHAKE_HIT : SHAKE_KILL) * (laser.active ? SHAKE_LASER_DAMP : 1));
  if (!enemy.health) {
    enemy.death = CONSTRUCT_DEATH;
    enemy.windup = enemy.attackEffect = 0;
    return;
  }

  // Retreating enemies do not chase beyond their territory, but a nearby
  // attacker still provokes one committed counterattack before they resume.
  const dx = player.x - enemy.x;
  const dy = player.y - enemy.y;
  const distance = Math.hypot(dx, dy);
  if (enemy.mode === 2 && distance < ENEMY_AGGRO
    && !enemy.windup && !enemy.attackEffect) {
    lockEnemyAim(enemy, dx, dy, distance);
    enemy.windup = enemy.type ? RANGED_WINDUP : MELEE_WINDUP;
    enemy.cooldown = enemy.type ? 1.65 : 1.05;
  }
}

function hitEnemies() {
  if (!attack.time) return;
  for (const enemy of enemies) {
    const bit = 1 << enemy.id;
    if (!enemy.health || attack.hits & bit) continue;
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const distance = Math.hypot(dx, dy);
    if (distance > ATTACK_REACH + 12) continue;
    const bodyAllowance = Math.asin(Math.min(1, 12 / Math.max(12, distance)));
    const dot = distance ? (dx * attack.directionX + dy * attack.directionY) / distance : 1;
    if (dot < Math.cos(ATTACK_ARC / 2 + bodyAllowance)) continue;

    attack.hits |= bit;
    hurtEnemy(enemy, attack.directionX * 165, attack.directionY * 165);
    laser.charge = Math.min(LASER_MAX_CHARGE, laser.charge + LASER_HIT_CHARGE);
  }
}

function updateLaser(dt) {
  for (const enemy of enemies) enemy.laserCooldown = Math.max(0, enemy.laserCooldown - dt);
  const wasActive = laser.active;
  laser.active = laser.held && laser.charge > 0;
  if (!laser.active) return;
  // A kick when it lights, then a floor it will not decay below for as long as
  // the trigger is held: the ignition rings out and lands in a rumble rather
  // than in silence. Clamping a floor rather than adding to the shake is what
  // keeps the two readable as one event — the kick decays into the hold instead
  // of stacking on top of it — and it leaves everything louder than the floor
  // still able to punch through, which is why the floor sits well under a hit.
  if (!wasActive) {
    shake = Math.max(shake, SHAKE_LASER);
    laser.punch = PUNCH_TIME;
  }
  shake = Math.max(shake, SHAKE_LASER_HOLD);

  laser.directionX = player.facingX;
  laser.directionY = player.facingY;
  laser.reach = viewportReach(laser.directionX, laser.directionY, -8);
  laser.charge = Math.max(0, laser.charge - dt);
  for (const enemy of enemies) {
    if (!enemy.health || enemy.laserCooldown) continue;
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const along = dx * laser.directionX + dy * laser.directionY;
    const across = Math.abs(dx * laser.directionY - dy * laser.directionX);
    if (along < 0 || along > laser.reach + 12 || across > LASER_WIDTH + 12) continue;
    hurtEnemy(enemy, laser.directionX * 55, laser.directionY * 55);
    enemy.laserCooldown = 0.38;
  }
}

function lockEnemyAim(enemy, dx, dy, distance) {
  enemy.attackDirectionX = dx / (distance || 1);
  enemy.attackDirectionY = dy / (distance || 1);
}

function enemyMeleeHitsPlayer(enemy) {
  const dx = player.x - enemy.x;
  const dy = player.y - enemy.y;
  const distance = Math.hypot(dx, dy);
  if (distance > ENEMY_ATTACK_REACH + PLAYER_HALF) return false;
  const bodyAllowance = Math.asin(Math.min(1, PLAYER_HALF / Math.max(PLAYER_HALF, distance)));
  const dot = distance
    ? (dx * enemy.attackDirectionX + dy * enemy.attackDirectionY) / distance
    : 1;
  return dot >= Math.cos(ENEMY_ATTACK_ARC / 2 + bodyAllowance);
}

function updateEnemies(dt) {
  hitEnemies();
  for (const enemy of enemies) {
    if (!enemy.health) {
      enemy.death -= dt;
      moveEnemy(enemy, enemy.x, enemy.y, 0, dt);
      continue;
    }
    enemy.hurt = Math.max(0, enemy.hurt - dt);
    enemy.hitEffect = Math.max(0, enemy.hitEffect - dt);
    enemy.cooldown = Math.max(0, enemy.cooldown - dt);
    enemy.think -= dt;
    const playerX = player.x - enemy.x;
    const playerY = player.y - enemy.y;
    const playerDistance = Math.hypot(playerX, playerY);
    const playerHomeDistance = Math.hypot(player.x - enemy.homeX, player.y - enemy.homeY);

    if (enemy.mode === 0
      && playerHomeDistance <= ENEMY_LEASH
      && playerDistance < ENEMY_AGGRO) enemy.mode = 1;
    // Close pursuit only re-aggros inside the home leash. Beyond it, the
    // Construct must keep returning instead of sticking to its roam boundary.
    if (enemy.mode === 2
      && playerHomeDistance <= ENEMY_LEASH
      && playerDistance < ENEMY_AGGRO) enemy.mode = 1;
    if (enemy.mode === 1 && playerHomeDistance > ENEMY_LEASH) {
      enemy.mode = 2;
      enemy.windup = enemy.attackEffect = 0;
    }

    // A counterattack started by hurtEnemy is allowed to finish while mode 2;
    // generic return movement resumes immediately afterward.
    if (enemy.attackEffect > 0) {
      enemy.attackEffect = Math.max(0, enemy.attackEffect - dt);
      moveEnemy(enemy, enemy.x, enemy.y, 0, dt);
      continue;
    }

    if (enemy.windup > 0) {
      enemy.windup -= dt;
      moveEnemy(enemy, enemy.x, enemy.y, 0, dt);
      if (enemy.windup <= 0) {
        enemy.attackEffect = ENEMY_ATTACK_EFFECT;
        if (enemy.type) spawnProjectile(enemy);
        else if (enemyMeleeHitsPlayer(enemy)) {
          damagePlayer(
            player.x - enemy.attackDirectionX,
            player.y - enemy.attackDirectionY,
          );
        }
      }
      continue;
    }

    if (enemy.mode === 2) {
      moveEnemy(enemy, enemy.homeX, enemy.homeY, 90, dt);
      if (Math.hypot(enemy.x - enemy.homeX, enemy.y - enemy.homeY) < 4) {
        enemy.x = enemy.homeX;
        enemy.y = enemy.homeY;
        enemy.mode = 0;
        enemy.think = 0;
      }
      continue;
    }

    if (enemy.mode === 0) {
      if (enemy.think <= 0) {
        const angle = hash(enemy.id, enemy.step++) / 4294967296 * Math.PI * 2;
        const radius = 25 + hash(enemy.step, enemy.id) % 55;
        enemy.targetX = enemy.homeX + Math.cos(angle) * radius;
        enemy.targetY = enemy.homeY + Math.sin(angle) * radius;
        enemy.think = 1.2 + hash(enemy.step, enemy.id + 9) % 180 / 100;
      }
      moveEnemy(enemy, enemy.targetX, enemy.targetY, 24, dt);
      continue;
    }

    if (!enemy.type) {
      if (playerDistance > 34) moveEnemy(enemy, player.x, player.y, 68, dt);
      else moveEnemy(enemy, enemy.x, enemy.y, 0, dt);
      if (playerDistance < 45 && !enemy.cooldown) {
        lockEnemyAim(enemy, playerX, playerY, playerDistance);
        enemy.windup = MELEE_WINDUP;
        enemy.cooldown = 1.05;
      }
    } else {
      if (playerDistance > 190) moveEnemy(enemy, player.x, player.y, 52, dt);
      else if (playerDistance < 120) moveEnemy(enemy, enemy.x - playerX, enemy.y - playerY, 62, dt);
      else {
        const side = enemy.id & 1 ? 1 : -1;
        moveEnemy(enemy, enemy.x - playerY * side, enemy.y + playerX * side, 28, dt);
      }
      if (playerDistance < 280 && !enemy.cooldown) {
        lockEnemyAim(enemy, playerX, playerY, playerDistance);
        enemy.windup = RANGED_WINDUP;
        enemy.cooldown = 1.65;
      }
    }
  }
  enemies = enemies.filter(enemy => enemy.health || enemy.death > 0);
}

function updateProjectiles(dt) {
  projectiles = projectiles.filter(projectile => {
    projectile.life -= dt;
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    if (Math.hypot(projectile.x - player.x, projectile.y - player.y) < PLAYER_HALF + 5) {
      damagePlayer(projectile.x - projectile.vx, projectile.y - projectile.vy);
      return false;
    }
    return projectile.life > 0 && projectile.x > 0 && projectile.x < WORLD.width
      && projectile.y > 0 && projectile.y < WORLD.height;
  });
}

function resetEncounter() {
  player.x = player.previousX = level.player[0];
  player.y = player.previousY = level.player[1];
  player.vx = player.vy = 0;
  player.health = PLAYER_MAX_HEALTH;
  player.invulnerability = 0.8;
  player.hitEffect = 0;
  player.dashTime = player.dashCooldown = player.tuck = player.walk = player.step = 0;
  player.trailClock = 0;
  attack.time = attack.cooldown = attack.hits = 0;
  laser.charge = DEBUG_START_CHARGE;
  laser.punch = player.hurtGlow = 0;
  laser.held = laser.active = false;
  trails.length = 0;
  enemies = makeEnemies();
  projectiles = [];
  camera.x = camera.previousX = player.x;
  camera.y = camera.previousY = player.y;
  resetQueued = false;
  updateAim();
  aim.previousX = aim.x;
  aim.previousY = aim.y;
  updateHud();
}

function update(dt) {
  // Rendering interpolates these fixed simulation samples. Without the older
  // sample, high-refresh displays alternate between still and double steps.
  gameTime += dt;
  shake = Math.max(0, shake - dt * SHAKE_DECAY);
  // Both flares decay here rather than where they are set, so they keep running
  // after the thing that caused them has stopped — the laser's ignition outlives
  // a tap on the trigger, and the hurt glow outlives the frame of the hit.
  laser.punch = Math.max(0, laser.punch - dt);
  player.hurtGlow = Math.max(0, player.hurtGlow - dt * 1.6);
  player.previousX = player.x;
  player.previousY = player.y;
  camera.previousX = camera.x;
  camera.previousY = camera.y;
  aim.previousX = aim.x;
  aim.previousY = aim.y;
  for (const enemy of enemies) {
    enemy.previousX = enemy.x;
    enemy.previousY = enemy.y;
  }
  for (const projectile of projectiles) {
    projectile.previousX = projectile.x;
    projectile.previousY = projectile.y;
  }
  // Refresh facing before actions so attacks and idle dashes use current aim.
  updateAim();
  updateAttack(dt);
  updatePlayer(dt);
  updateCamera();
  updateAim();
  updateLaser(dt);
  updateEnemies(dt);
  updateProjectiles(dt);
  if (resetQueued) resetEncounter();
}

function visibleBounds(cameraX, cameraY) {
  return {
    left: cameraX - viewWidth / 2,
    top: cameraY - viewHeight / 2,
    right: cameraX + viewWidth / 2,
    bottom: cameraY + viewHeight / 2,
  };
}

// Three translucent bands, each stepping down and to the right of the last.
// The light runs top-left to bottom-right — the shafts skew that way and every
// wall in the level throws its shadow that way — so an actor's shadow leans
// with it rather than sitting as a symmetrical puddle.
//
// Stepped, not merely offset. Sliding a round blob down-right leaves the actor
// looking like it is hovering over its own shadow; overlapping bands that walk
// outward keep the darkest part where the feet actually meet the ground and
// let the tail thin out as it stretches away, which is the shape a cast shadow
// has. The overlap is also where the density comes from: no gradient needed,
// and it stays translucent so one shadow works over grass, gold, stone and
// water alike.
function drawShadow(x, y, radius, alpha = 0.22) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#011';
  ctx.fillRect(x - radius, y - 3, radius * 2 - 6, 6);
  ctx.fillRect(x - radius + 4, y - 1, radius * 2 - 6, 6);
  ctx.fillRect(x - radius + 8, y + 1, radius * 2 - 6, 5);
  ctx.globalAlpha = 1;
}

/**
 * Pick a layer's paint, which is either one colour or a ramp sampled along the
 * effect. A ramp is how the rainbow runs *along* a beam or blade instead of
 * repeating per stamp, which was what made the old effects read as beads.
 */
function paintOf(paint, amount) {
  return typeof paint === 'string'
    ? paint
    : paint[(amount % paint.length + paint.length) % paint.length | 0];
}

/**
 * Stamp squares along a straight world-space ray. Every straight effect — the
 * rainbow laser, a Construct's sight line, a shot's tail, an impact spike — is
 * this shape. Stamps are spaced far closer than they are wide and each layer
 * runs the full length, so the beam gets one even outline down its whole edge
 * rather than an outline around every stamp.
 */
function drawBeam(x, y, dirX, dirY, from, to, layers, phase = 0, step = 2, fade = 0) {
  // Each layer runs the whole length before the next one starts. Drawing every
  // layer per stamp instead lets the next stamp's backing bury the previous
  // stamp's colour, which leaves a dark line with slivers of colour trapped in
  // it rather than a coloured beam with one dark edge.
  for (const [size, paint] of layers) {
    for (let distance = from; distance < to; distance += step) {
      // Stamps are far wider than their spacing, so a stamp lands on roughly
      // size/step of its neighbours. Painting them at the opacity we actually
      // want would compound to near-solid within a few pixels and turn the ramp
      // into a blotchy step. Taking that root gives each stamp the share that
      // composites up to the opacity we asked for.
      if (fade) {
        ctx.globalAlpha = 1 - (1 - Math.min(1, (distance - from) / fade)) ** (step / size);
      }
      ctx.fillStyle = paintOf(paint, distance / 4 + phase);
      ctx.fillRect(
        pixelX(x + dirX * distance) - (size >> 1),
        pixelY(y + dirY * distance) - (size >> 1),
        size, size,
      );
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Stamp a tapered crescent along an arc: the llamacorn's horn sweep and the
 * Constructs' melee telegraph are the same blade with different paint. The
 * taper puts the mass in the middle of the swing, which is what separates a
 * slash from a drawn circle segment, and `from`/`to` let the caller sweep the
 * blade round the arc so a still frame still reads as a swing in progress.
 */
function drawCrescent(x, y, radius, centre, arc, from, to, thickness, layers) {
  const steps = 22;
  // Layer at a time along the whole arc, for the same reason the beam does.
  for (const [grow, paint] of layers) {
    for (let step = 0; step <= steps; step++) {
      const amount = step / steps;
      const size = Math.round(Math.sin(Math.PI * amount) * thickness) + grow;
      if (size <= 0) continue;
      const angle = centre + arc * (from + (to - from) * amount - 0.5);
      ctx.fillStyle = paintOf(paint, amount * (paint.length - 0.01));
      ctx.fillRect(
        pixelX(x + Math.cos(angle) * radius) - (size >> 1),
        pixelY(y + Math.sin(angle) * radius) - (size >> 1),
        size, size,
      );
    }
  }
}

function drawEnemyTelegraph(enemy, x, y) {
  const striking = !enemy.type && enemy.attackEffect > 0;
  if (enemy.windup <= 0 && !striking) return;
  const duration = enemy.type ? RANGED_WINDUP : MELEE_WINDUP;
  const progress = striking ? 1 : clamp(1 - enemy.windup / duration, 0, 1);
  const centre = Math.atan2(enemy.attackDirectionY, enemy.attackDirectionX);

  if (enemy.type) {
    // A sight line one pixel thick, growing along the path it has committed to
    // and thickening only at the last moment. A thin line is legible without
    // covering the ground the player has to read to dodge across it.
    // Stepped by one so a one-pixel line comes out continuous, and left fully
    // opaque: translucent stamps compound wherever two overlap, which speckles
    // a line this thin. Intensity is carried by colour instead.
    drawBeam(
      x, y, enemy.attackDirectionX, enemy.attackDirectionY,
      14, 30 + progress * 270,
      [[progress > 0.86 ? 3 : 1,
        progress > 0.86 ? '#ffd0da' : progress > 0.5 ? '#e94863' : WARNING]],
      0, 1,
    );
    return;
  }

  // The melee arc opens outward from the direction of the strike, thickening
  // and heating as it goes, then fires as a bright blade. Growing from the
  // centre rather than wiping from one edge matters: a wipe spends its first
  // frames as a smear off to one side of where the blow will actually land.
  // Build-up is carried by size and colour rather than by fading in, which
  // keeps the warning opaque and so as legible as the reference floor decals.
  // It also reaches outward as it charges. A warning drawn straight out at
  // full reach is a sliver floating in open ground with nothing tying it to
  // the machine that threw it; one that grows out of the hull is unmistakably
  // that Construct's swing, and its travel is the count-in to the blow.
  const span = striking ? 1 : progress;
  ctx.globalAlpha = striking ? Math.min(1, enemy.attackEffect / 0.07) : 1;
  drawCrescent(
    x, y, 18 + span * (ENEMY_ATTACK_REACH - 27), centre, ENEMY_ATTACK_ARC,
    // The warning stays a slim bright arc and only the blow itself is a solid
    // blade. A telegraph as heavy as its strike leaves nothing for the strike
    // to do, and covers the ground the player is trying to read a way out of.
    0.5 - span / 2, 0.5 + span / 2, striking ? 9 : 2 + progress * 2,
    striking
      ? [[3, '#7d1b32'], [1, '#ff8fa6'], [-4, '#fff1f3']]
      : [[2, '#6d1329'], [0, progress > 0.72 ? '#ff5d78' : WARNING]],
  );
  ctx.globalAlpha = 1;
}

function drawEnemyAttack(enemy, x, y) {
  if (!enemy.type || enemy.attackEffect <= 0) return;
  const progress = 1 - enemy.attackEffect / ENEMY_ATTACK_EFFECT;
  // The projectile supplies the travel animation; this is its muzzle burst,
  // which collapses as it moves off so the shot looks pushed rather than lit.
  const distance = 12 + progress * 17;
  const flashX = pixelX(x + enemy.attackDirectionX * distance);
  const flashY = pixelY(y + enemy.attackDirectionY * distance);
  const size = 9 - (progress * 6 | 0);
  ctx.fillStyle = '#ffc55c';
  ctx.fillRect(flashX - (size >> 1), flashY - (size >> 1), size, size);
  ctx.fillStyle = HOT;
  ctx.fillRect(flashX - (size >> 2), flashY - (size >> 2), size >> 1, size >> 1);
}

/**
 * A hit is a white core with four spikes that stretch and thin as they travel
 * out. The core outliving the spikes by a frame is what gives the hit its
 * punch; spikes on their own read as a firework going off, not as contact.
 */
function drawImpact(x, y, time, duration, colour) {
  if (time <= 0) return;
  const progress = 1 - time / duration;
  const reach = 7 + progress * 24;
  const thickness = Math.max(1, 4 - (progress * 4 | 0));
  ctx.globalAlpha = 1 - progress * progress;
  for (let spoke = 0; spoke < 4; spoke++) {
    const angle = Math.PI / 4 + Math.PI / 2 * spoke;
    drawBeam(
      x, y, Math.cos(angle), Math.sin(angle),
      reach * 0.35, reach, [[thickness, colour]], 0, 1,
    );
  }
  const core = 9 - (progress * 13 | 0);
  if (core > 0) {
    ctx.fillStyle = HOT;
    ctx.fillRect(pixelX(x) - (core >> 1), pixelY(y) - (core >> 1), core, core);
  }
  ctx.globalAlpha = 1;
}

/**
 * Health as pips over an actor, and nothing at all while it is untouched.
 * Damage is the only moment the number matters, so a fight nobody has landed a
 * blow in carries no interface whatsoever.
 */
function drawPips(x, y, current, max, colour) {
  if (current >= max) return;
  const width = max * 4 - 1;
  const left = pixelX(x) - (width >> 1);
  const top = pixelY(y);
  ctx.fillStyle = INK;
  ctx.fillRect(left - 1, top - 1, width + 2, 5);
  for (let pip = 0; pip < max; pip++) {
    ctx.fillStyle = pip < current ? colour : '#455';
    ctx.fillRect(left + pip * 4, top, 3, 3);
  }
}

/**
 * Dark magic leaks through the carving as small backed sparks. The dark two-
 * pixel flecks stay readable over pale Floor while their violet cores connect
 * them to the eye; uneven climb speeds stop the halo moving as one sheet.
 */
function drawMagicMotes(x, y, seed, colour) {
  for (let mote = 0; mote < 6; mote++) {
    const noise = hash(seed, mote, 61);
    const climb = (noise % 997 / 997 + gameTime * (0.32 + (mote & 1) * 0.08)) % 1;
    const moteX = pixelX(x - 20 + (noise >>> 9) % 41 + Math.sin(gameTime * 2 + mote) * 2);
    const moteY = pixelY(y + 10 - climb * 29);
    const alpha = Math.sin(climb * Math.PI);
    ctx.globalAlpha = alpha * 0.55;
    ctx.fillStyle = '#213';
    ctx.fillRect(moteX - 1, moteY, 2, 2 + (mote & 1));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    ctx.fillRect(moteX, moteY, 1, 1 + (mote & 1));
  }
  ctx.globalAlpha = 1;
}

/**
 * No particle state is needed for the death poof: stable hashes give each
 * Construct its own expanding smoke lobes and ballistic stone chips, while the
 * death timer supplies their position and fade.
 */
function drawEnemyDeath(enemy, x, y) {
  const progress = 1 - enemy.death / CONSTRUCT_DEATH;
  ctx.globalAlpha = Math.sin(progress * Math.PI) * 0.82;
  for (let puff = 0; puff < 9; puff++) {
    const noise = hash(enemy.id, puff, 89);
    const angle = noise % 628 / 100;
    const distance = 4 + progress * (14 + (noise >>> 8) % 17);
    const size = 3 + (progress * 5 | 0);
    const width = 2 + (size >> 2);
    const puffX = Math.round(x + Math.cos(angle) * distance * 0.55);
    const puffY = Math.round(y - 4 + Math.sin(angle) * distance * 0.45 - progress * 27);
    ctx.fillStyle = puff & 1 ? '#528' : '#213';
    ctx.fillRect(puffX - (width >> 1), puffY - (size >> 1), width, size);
    ctx.fillRect(puffX - (width >> 1) + (puff & 1 ? 1 : -1), puffY + 1, width, Math.max(2, size - 3));
  }

  ctx.globalAlpha = Math.min(1, progress * 7, (1 - progress) * 1.8);
  for (let chip = 0; chip < 16; chip++) {
    const noise = hash(enemy.id, chip, 131);
    const size = 3 + (noise >>> 16 & 3);
    // Chips begin distributed across the shell, then peel away from those same
    // positions; the body therefore becomes rubble instead of swapping to it.
    const chipX = Math.round(x + (noise >>> 5) % 29 - 14 + (noise % 35 - 17) * progress * 2.6);
    const chipY = Math.round(y + (noise >>> 10) % 21 - 10 - (14 + (noise >>> 8) % 24) * progress + 48 * progress * progress);
    ctx.fillStyle = STONE_INK;
    ctx.fillRect(chipX - 1, chipY - 1, size + 2, size + 2);
    ctx.fillStyle = STONE[(noise >>> 18) % 3];
    ctx.fillRect(chipX, chipY, size, size);
  }
  ctx.globalAlpha = 1;
}

function drawEnemy(enemy, x, y) {
  x = pixelX(x);
  y = pixelY(y);
  const core = enemy.mode === 1 ? '#f4d' : '#84e';
  // The shadow drains with the death smoke instead of vanishing one frame
  // after it; living atmosphere remains visible while the body hurt-flashes.
  drawShadow(x, y + 12, enemy.type ? 13 : 16, enemy.health ? 0.22 : 0.22 * enemy.death / CONSTRUCT_DEATH);
  if (!enemy.health) ctx.globalAlpha = clamp(enemy.death / CONSTRUCT_DEATH * 2.5 - 1.5, 0, 1);
  else if (enemy.hurt && (enemy.hurt * 24 | 0) & 1) ctx.globalAlpha = 0.35;

  if (!enemy.type) {
    // A floor guardian: four broken feet carry one broad carved slab. The
    // single shell silhouette gives it the weight the old stack of chips lost,
    // while the temple-tile glyph makes its origin readable at game scale.
    const stagger = hash(enemy.id, 4, 23) % 3 - 1;
    ctx.fillStyle = STONE_INK;
    ctx.fillRect(x - 18, y - 7 + stagger, 7, 7);
    ctx.fillRect(x + 11, y - 7 - stagger, 7, 7);
    ctx.fillRect(x - 18, y + 5 - stagger, 7, 7);
    ctx.fillRect(x + 11, y + 5 + stagger, 7, 7);
    ctx.fillStyle = STONE[3];
    ctx.fillRect(x - 17, y - 6 + stagger, 5, 5);
    ctx.fillRect(x + 12, y - 6 - stagger, 5, 5);
    ctx.fillRect(x - 17, y + 6 - stagger, 5, 5);
    ctx.fillRect(x + 12, y + 6 + stagger, 5, 5);

    // Overlapping rectangles make a one-pixel outlined octagonal shell.
    ctx.fillStyle = STONE_INK;
    ctx.fillRect(x - 12, y - 12, 24, 24);
    ctx.fillRect(x - 15, y - 9, 30, 18);
    ctx.fillStyle = STONE[1];
    ctx.fillRect(x - 11, y - 11, 22, 22);
    ctx.fillRect(x - 14, y - 8, 28, 16);
    ctx.fillStyle = STONE[3];
    ctx.fillRect(x - 14, y + 3, 28, 5);
    ctx.fillRect(x - 11, y + 8, 22, 3);
    ctx.fillStyle = STONE[0];
    ctx.fillRect(x - 10, y - 10, 20, 2);

    // A miniature version of the floor's inset-square carving, split by the
    // violet force that lifted the tile out of the ruin.
    ctx.fillStyle = STONE[2];
    ctx.fillRect(x - 8, y - 6, 16, 1);
    ctx.fillRect(x - 8, y + 6, 16, 1);
    ctx.fillRect(x - 8, y - 5, 1, 11);
    ctx.fillRect(x + 7, y - 5, 1, 11);
    ctx.fillStyle = enemy.mode === 1 ? '#a28' : '#528';
    ctx.fillRect(x - 7, y, 4, 1);
    ctx.fillRect(x + 3, y, 5, 1);
    ctx.fillStyle = STONE_INK;
    ctx.fillRect(x - 3, y - 3, 7, 7);
    ctx.fillStyle = core;
    ctx.fillRect(x - 2, y - 2, 5, 5);
    ctx.fillStyle = MAGIC_HOT;
    ctx.fillRect(x, y - 1, 2, 2);
  } else {
    // A ranged shrine: an upright tile on a deep plinth, not the old paper-thin
    // diamond. It still floats, but now has a crown, front face and underside.
    y += Math.round(Math.sin(gameTime * 2.4 + enemy.id) * 2) - 5;
    ctx.fillStyle = STONE_INK;
    ctx.fillRect(x - 11, y - 12, 22, 22);
    ctx.fillRect(x - 14, y - 8, 28, 15);
    ctx.fillRect(x - 15, y + 6, 30, 8);
    ctx.fillStyle = STONE[1];
    ctx.fillRect(x - 10, y - 11, 20, 20);
    ctx.fillRect(x - 13, y - 7, 26, 13);
    ctx.fillStyle = STONE[3];
    ctx.fillRect(x - 13, y + 2, 26, 4);
    ctx.fillRect(x - 14, y + 7, 28, 6);
    ctx.fillStyle = STONE[0];
    ctx.fillRect(x - 9, y - 10, 18, 2);
    ctx.fillRect(x - 12, y - 7, 24, 1);
    ctx.fillRect(x - 10, y + 7, 20, 1);
    ctx.fillStyle = STONE[2];
    ctx.fillRect(x - 7, y - 5, 14, 1);
    ctx.fillRect(x - 7, y + 1, 14, 1);
    ctx.fillRect(x - 7, y - 4, 1, 5);
    ctx.fillRect(x + 6, y - 4, 1, 5);
    // The eye sits in the floor glyph's centre and is also the shot aperture.
    ctx.fillStyle = STONE_INK;
    ctx.fillRect(x - 4, y - 4, 9, 7);
    ctx.fillStyle = core;
    ctx.fillRect(x - 3, y - 3, 7, 5);
    ctx.fillStyle = MAGIC_HOT;
    ctx.fillRect(x - 1, y - 2, 3, 2);
  }

  ctx.globalAlpha = 1;
  if (enemy.health) {
    // Front motes remain visible against both pale Floor and the broad shell;
    // a few crossing the carving make the magic feel internal rather than fog.
    drawMagicMotes(x, y, enemy.id, core);
    drawPips(x, y - 23, enemy.health, enemy.type ? 2 : 3, core);
  } else drawEnemyDeath(enemy, x, y);
}

function drawProjectiles(alpha) {
  for (const projectile of projectiles) {
    const x = projectile.previousX + (projectile.x - projectile.previousX) * alpha;
    const y = projectile.previousY + (projectile.y - projectile.previousY) * alpha;
    const speed = Math.hypot(projectile.vx, projectile.vy) || 1;
    const backX = -projectile.vx / speed;
    const backY = -projectile.vy / speed;
    // A tail stepping down in width behind the head reads as a shot in flight.
    // The bordered square this replaced read as an object hanging in mid-air.
    drawBeam(x, y, backX, backY, 0, 8, [[5, INK], [3, '#ffc55c']]);
    drawBeam(x, y, backX, backY, 8, 16, [[3, INK], [1, '#ffc55c']]);
    ctx.fillStyle = '#fff3a6';
    ctx.fillRect(pixelX(x) - 2, pixelY(y) - 2, 5, 5);
    ctx.fillStyle = HOT;
    ctx.fillRect(pixelX(x) - 1, pixelY(y) - 1, 3, 3);
  }
}

/**
 * Every part of the llamacorn is authored facing right and mirrored here, so
 * one set of offsets draws both directions and they can never drift apart.
 * `ox` runs forward along the facing, which is why nothing below multiplies by
 * the flip itself: mirroring a rectangle moves its far edge, not its origin.
 */
function spriteRect(x, y, flip, ox, oy, width, height) {
  ctx.fillRect(flip > 0 ? x + ox : x - ox - width, y + oy, width, height);
}

/**
 * The tail is the rainbow meter. It fills from the dock outward as the horn
 * lands hits and drains back to grey as the laser burns the charge off, which
 * puts the one resource the player spends on the character they are already
 * watching instead of in a corner of the screen they are not.
 *
 * Because it is the entire HUD it is drawn as a heavy fleece plume: ten bands
 * have to stay countable at 2x zoom, in peripheral vision, while the player is
 * dodging. Spent bands are one flat grey rather than two alternating ones —
 * banding the empty half turned the tail into a ladder, and there is nothing
 * to count there anyway. The filled half is where the reading happens.
 *
 * It is broad at the dock and blunt at the tip. A plume that narrows at both
 * ends hangs off the rump on a stalk and tapers to a spike, which reads as a
 * separate object hooked onto the animal rather than as part of it.
 */
function drawTail(x, y, flip) {
  const filled = Math.ceil(laser.charge / LASER_MAX_CHARGE * TAIL_SEGMENTS);
  // One silhouette laid down for the whole plume before any band is filled,
  // exactly as the body is built. Giving each band its own outline instead
  // walls them off from each other and the meter reads as a stack of blocks
  // parked beside the llamacorn rather than as its tail.
  for (let pass = 0; pass < 2; pass++) {
    for (let segment = 0; segment < TAIL_SEGMENTS; segment++) {
      const width = TAIL_WIDTHS[segment];
      const grow = pass ? 0 : 1;
      // The dock runs two columns under the rump, so the top bands overlap the
      // barrel wherever its back edge happens to be on that row rather than
      // meeting it at one column and opening a gap either side. From there the
      // plume sweeps back a pixel every two bands, which is what keeps a
      // twenty-row meter from hanging to the ground like a rope.
      const back = -8 - (segment >> 1);
      // The spectrum is spread across the whole plume rather than repeated
      // every six bands, so it reads as one rainbow being poured in from the
      // dock instead of restarting partway down the tail.
      ctx.fillStyle = pass
        ? segment < filled ? RAINBOW[segment * RAINBOW.length / TAIL_SEGMENTS | 0] : '#889'
        : INK;
      spriteRect(
        x, y, flip, back - width - grow, -6 + segment * 2 - grow,
        width + grow * 2, 2 + grow * 2,
      );
    }
  }
}

/**
 * The player: a llamacorn, and deliberately so. The horse build kept reading as
 * a llama at this size anyway — a twenty-pixel barrel cannot be long enough to
 * be equine without eating the screen, and what is left is a short body under a
 * tall neck, which is a llama. Leaning in costs a few pixels of ear, keeps the
 * theme outright (it has a horn and it fires a rainbow), and gives the game a
 * silhouette nobody else in the jam will have. The ruins it walks through are
 * already pale terraced stone on green plateaus, so the setting needs nothing.
 *
 * Built silhouette-first like everything else in the world: the whole shape is
 * laid down in ink and every later rectangle insets one pixel into it, which
 * produces an even one-pixel outline without drawing one. Masses are stacks of
 * two or three overlapping rectangles, widest in the middle, so their corners
 * come off without a curve ever being drawn.
 *
 * The coat is a cool lavender white where the ruins are a warm bone white, so
 * the player never dissolves into the temple floor they spend the level on.
 */
function drawPlayer(playerX, playerY) {
  const flip = player.facingX < 0 ? -1 : 1;

  // The dash leaves the body's own silhouette behind it, tinted through the
  // spectrum. Matching the barrel and head rather than using a bigger block
  // keeps the trail reading as afterimages instead of dropped confetti.
  for (const trail of trails) {
    const ghostX = pixelX(trail.x);
    const ghostY = pixelY(trail.y);
    ctx.globalAlpha = trail.life / 0.16 * 0.7;
    ctx.fillStyle = trail.colour;
    spriteRect(ghostX, ghostY, trail.flip, -9, -6, 16, 15);
    spriteRect(
      ghostX + player.dashX * 4, ghostY + player.dashY * 4, trail.flip,
      2, -22, 12, 18,
    );
  }
  ctx.globalAlpha = 1;

  const x = pixelX(playerX);
  const y = pixelY(playerY);
  drawShadow(x - flip * 2, y + 15, 11);
  ctx.globalAlpha = player.invulnerability && (player.invulnerability * 24 | 0) & 1 ? 0.35 : 1;

  // A trot: the diagonal pairs swap, which is what a llama actually does and is
  // the only leg pattern still legible when a leg is six pixels wide. Driving
  // it from distance travelled rather than from the clock means it cannot
  // skate.
  const stride = player.step * 0.1;
  const gait = Math.sin(stride) * player.walk;
  const lift = Math.round(gait * 2);
  // A lifted leg is drawn higher, not shorter: its top slides up under the
  // belly where nothing can see it, and only the foot leaves the ground.
  const liftA = Math.max(0, lift);
  const liftB = Math.max(0, -lift);
  // Dashing lifts the whole animal clear of the ground instead of animating
  // it, so the dash reads as a glide and not as a very fast walk.
  // The barrel rises twice a stride, once for each diagonal pair taking the
  // weight. Its own cosine at double the leg frequency, rather than the size of
  // the leg swing: the swing's peak is the same height whichever pair is up, so
  // reading the bob off its magnitude puts a cusp at every zero crossing, and a
  // cusp one pixel tall is a flicker. Two pixels of travel rather than one is
  // the other half of it — a single pixel can only ever be up or down, which is
  // a square wave however smooth the number driving it, where three positions
  // read as an arc.
  const bob = (1 - Math.cos(stride * 2)) / 2 * player.walk;
  const bodyY = y + (player.dashTime ? -2 : -Math.round(bob * 2));

  // Where the head leans is the only facing cue there is, so it does the whole
  // job: reaching down and forward when the llamacorn faces the camera, drawn
  // up and back when it turns away. Turned away the eye and nostril are hidden
  // and the fleece swings across the face — the cheapest possible back-of-head
  // pose, and the one thing that stops "walking north" reading as "south".
  const away = player.facingY < -0.45;
  const toward = player.facingY > 0.45;
  const swing = away ? 3 : 0;
  // Where the ears sit relative to the horn, per pose. Looking up you are seeing
  // the back of the skull, so the ears crowd the horn and tuck a column under
  // it; looking down the skull has rotated far enough that the pair passes
  // behind the horn and comes out the other side, so the far ear is the one
  // against the horn and the near ear is outermost. Three positions is what
  // stops the ears reading as a decal stuck to a head that turns underneath
  // them.
  //
  // Side on sits between the two, and it has to, or sweeping the aim jumps the
  // pair two columns at once. There are no half pixels to split the difference
  // with — everything here is rounded to the device grid after the camera
  // transform, so a half unit is not a half step, it is a pixel that picks a
  // side depending on where the camera happens to be and twitches while you
  // walk. The half step that does exist is made of ink: at 4 the ear's outline
  // and the horn's meet, which reads as a seam between them, where at 3 a
  // column of open ground shows through and reads as a gap.
  const earX = away ? 5 : toward ? 3 : 4;
  const earFar = toward ? 6 : earX - 2;
  const leanX = away ? -2 : toward ? 1 : 0;
  const leanY = away ? -2 : toward ? 2 : 0;
  const rect = (ox, oy, width, height) => spriteRect(x, bodyY, flip, ox, oy, width, height);
  const head = (ox, oy, width, height) =>
    spriteRect(x, bodyY, flip, ox + leanX, oy + leanY, width, height);
  // Feet stay on the ground while the barrel bobs above them.
  // Dashing folds the legs up under the barrel. Every leg rectangle keeps its
  // top and loses height off the bottom, so they retract into the body rather
  // than shrink in place, and the pads come up with them. The animal's own
  // height is left alone — the barrel lifts by the same two pixels it always
  // did and the shadow stays where the ground is, so it reads as legs tucking
  // rather than as a llamacorn getting smaller.
  const tuck = Math.round(player.tuck * 5);
  const leg = (ox, oy, width, height) =>
    spriteRect(x, y, flip, ox, oy, width, height - tuck);
  // Facing the camera, the crest is seen end-on and its upper half is simply on
  // the far side of the neck. Narrowing the strands from the back — twice as
  // much at the poll, where the turn is sharpest — is what sells that; left at
  // full width the fleece reads as a stripe pasted across the front of a neck
  // that is plainly pointing at you. `grow` is the silhouette pass, which needs
  // the identical offsets a pixel larger.
  const mane = (strand, grow) => {
    const [ox, oy, width, height] = MANE[strand];
    const hidden = toward ? (strand < 2 ? 2 : 1) : 0;
    head(
      ox + swing + hidden - grow, oy - grow,
      width - hidden + grow * 2, height + grow * 2,
    );
  };

  drawTail(x, bodyY, flip);

  // The off-side pair, drawn before the body and in a darker tone. Each is
  // tucked behind its near neighbour so only its inner edge is ever seen: a far
  // leg clear of the near one on both sides sets two outlines side by side with
  // a sliver of coat trapped between them, which is what made the first attempt
  // read as a drawing mistake at 2x. The two of them share the single ink column
  // between the near pair for the same reason. They also stop a row short of the
  // ground, so the near pair keeps the weight.
  ctx.fillStyle = INK;
  leg(-6, 4 - liftA, 5, 11);
  leg(0, 3 - liftB, 5, 11);
  ctx.fillStyle = '#88b';
  leg(-5, 5 - liftA, 3, 9);
  leg(1, 4 - liftB, 3, 9);

  // Silhouette. Three overlapping rectangles per mass — each narrower and
  // taller than the last — take every corner off without drawing a curve. Two
  // was enough for a pony and still left a fridge; a llama is rounder than it
  // is long, so the barrel needs the third.
  ctx.fillStyle = INK;
  rect(-10, -4, 19, 11);
  rect(-8, -6, 14, 15);
  rect(-6, -7, 10, 17);
  // Legs are drawn as one plane, not two. An off-side pair peeking three
  // pixels out from behind the near pair put its own outline alongside theirs,
  // and two dark lines with a sliver of coat trapped between them read as a
  // drawing mistake at 2x. Their volume comes from a shaded back edge instead.
  leg(-10, 5 - liftB, 6, 11);
  leg(3, 5 - liftA, 6, 11);
  head(2, -14, 9, 14);
  head(4, -16, 7, 9);
  head(3, -20, 10, 8);
  head(4, -21, 8, 10);
  head(10, -17, 6, 7);
  // Two upright ears, one rectangle each. The far one is a single column of
  // colour rather than two: it is half behind its neighbour, so the near ear's
  // own outline is the line between them and the far ear is the sliver that
  // shows past it. A row shorter as well, which is what perspective does to it
  // and what keeps the pair from roofing over into one block. Both ink rects
  // run three rows below the colour, down into the skull — the mane is the only
  // part of the head that moves on its own, so anything standing on the crest
  // has to reach the bone itself or it is left hanging when the mane swings.
  head(earFar - 1, -24, 3, 7);
  head(earX - 1, -25, 4, 8);
  // The fleece is outlined with the rest of the silhouette rather than after
  // it, because ink laid over a finished coat leaves a dark seam wherever the
  // two meet.
  for (let strand = 0; strand < MANE.length; strand++) mane(strand, 1);

  const coat = player.dashTime ? '#feb' : '#eef';
  ctx.fillStyle = coat;
  rect(-9, -3, 17, 9);
  rect(-7, -5, 12, 13);
  rect(-5, -6, 8, 15);
  // Started level with the belly rather than below it, so the coat runs
  // unbroken from body into leg. Beginning it a pixel lower drew the leg its
  // own lid and hung four outlined boxes under the animal.
  leg(-9, 5 - liftB, 4, 10);
  leg(4, 5 - liftA, 4, 10);
  head(3, -13, 7, 12);
  head(5, -15, 5, 8);
  head(4, -19, 8, 6);
  head(5, -20, 6, 8);
  head(11, -16, 4, 5);
  head(earX, -24, 2, 5);

  // A shaded belly and a lit spine keep the coat from reading as a flat cut-out
  // and put the light on the llamacorn where it is on everything else. The
  // cheek, throat and leg shadows are what give each mass a near and a far
  // side; the far ear is shaded whole, which is all a second ear needs.
  ctx.fillStyle = '#bbd';
  rect(-9, 3, 17, 3);
  rect(-7, 6, 12, 2);
  rect(-5, 8, 8, 1);
  leg(-9, 5 - liftB, 1, 10);
  leg(4, 5 - liftA, 1, 10);
  head(6, -13, 8, 1);
  head(8, -8, 2, 7);
  head(earFar, -23, 1, 4);
  ctx.fillStyle = HOT;
  rect(-5, -6, 8, 1);
  rect(-7, -5, 12, 1);
  // Two padded toes rather than a hoof: llamas walk on pads, and the split is
  // the one place the species shows below the knee.
  ctx.fillStyle = '#669';
  leg(-9, 12 - tuck - liftB, 4, 3 + tuck);
  leg(4, 12 - tuck - liftA, 4, 3 + tuck);
  if (!away) {
    ctx.fillStyle = '#eab';
    head(12, -15, 2, 2);
  }

  // The fleece stays a full rainbow whatever the tail is doing. It is the
  // llamacorn's identity rather than a readout, and leaving it constant gives
  // the eye something to measure the tail's drained grey against. It falls from
  // behind the ears down the crest and onto the back, stepping back a pixel a
  // strand, which is what makes it hang rather than stripe. There is no
  // forelock: a fringe over the brow is a horse's, and it buried the ears.
  for (let strand = 0; strand < MANE.length; strand++) {
    ctx.fillStyle = RAINBOW[strand];
    mane(strand, 0);
  }

  // Horn last, so it crosses in front of the fleece. Its ink is re-laid here
  // rather than in the silhouette pass because the fleece is drawn over the top
  // of it; two rectangles is cheaper than reordering the whole head. Two
  // stacked segments, the upper stepped forward, give it a taper and a forward
  // rake without any diagonal drawing, and it out-tops the ears by a pixel so
  // it stays the first thing read.
  ctx.fillStyle = INK;
  head(7, -25, 4, 6);
  head(8, -28, 3, 5);
  ctx.fillStyle = '#fea';
  head(8, -24, 2, 7);
  head(9, -27, 1, 4);
  // One dark band is all a spiral needs at this size.
  ctx.fillStyle = '#ea5';
  head(8, -22, 2, 1);

  if (!away) {
    ctx.fillStyle = INK;
    head(8, -16, 2, 2);
    ctx.fillStyle = HOT;
    head(8, -16, 1, 1);
  }

  // Drawn past the invulnerability flicker: the frames just after a hit are
  // exactly when the player needs to be able to count what is left.
  ctx.globalAlpha = 1;
  drawPips(x, y - 37, player.health, PLAYER_MAX_HEALTH, '#5fd');
}

/**
 * One continuous beam, not a row of beads: a dark spectrum, then its bright twin
 * scrolling away down its length, then a white core hot enough to blow out.
 * The additive halo it used to carry is gone. Drawn as an outer layer it
 * thickened the edge to three pixels, which is the one thing nothing else in
 * this world does.
 *
 * The beam is one straight line from the horn, because anything else is two
 * beams. The hit test measures against a ray from the llamacorn's own position
 * — every sprite here is drawn standing above its world position, so a ray at
 * head height would burn Constructs the beam visibly cleared — but the horn is
 * two dozen units above that, and carrying the beam down onto that ray put a
 * corner in it. A corner is a join, and a join is what the eye reads as two
 * separate beams. So the drawn line starts on the horn and is aimed at the
 * point where the ray leaves the screen instead: it ends exactly where the
 * shot ends, and the horn offset is spent as two or three degrees of angle
 * that nobody can see rather than as a kink halfway down that everybody can.
 */
function drawLaser(playerX, playerY) {
  if (!laser.active) return;
  const hornX = playerX + (laser.directionX < 0 ? -10 : 10);
  const hornY = playerY - 22;
  // Floored so the endpoint stays far enough out to aim at. Standing against a
  // screen edge leaves the ray only a few units to run, and a target that close
  // sits behind the horn — which would fire the beam back at the llamacorn.
  const run = Math.max(laser.reach, 64);
  const endX = playerX + laser.directionX * run - hornX;
  const endY = playerY + laser.directionY * run - hornY;
  const length = Math.hypot(endX, endY);
  // A dark spectrum, then the same bright spectrum, then a white core. Both
  // ramps share phase and distance, so every edge band is a dark shade of the
  // colour inside it rather than a generic outline. The whole thing swells for
  // the length of the ignition flare, so the shot arrives rather than appearing.
  const grow = Math.round(laser.punch / PUNCH_TIME * PUNCH_WIDTH);
  drawBeam(
    hornX, hornY, endX / length, endY / length, 0, length,
    [[11 + grow, DARK_RAINBOW], [9 + grow, RAINBOW], [3 + grow, HOT]],
    gameTime * 26, 2, BEAM_FADE,
  );
}

/**
 * The horn sweep. A tail chasing the leading edge round the arc is what makes
 * a single stationary sprite read as a swing, and the blade is built up in
 * layers — one ink backing for the whole crescent, the spectrum across it, a
 * white core through its thickest part — rather than as separate outlined
 * stamps, which is the difference between a blade and a string of beads.
 */
function drawAttack(playerX, playerY) {
  if (!attack.time) return;
  const progress = 1 - attack.time / ATTACK_DURATION;
  const lead = Math.min(1, progress * 2.4);
  ctx.globalAlpha = Math.min(1, attack.time / 0.05);
  drawCrescent(
    playerX, playerY, ATTACK_REACH - 15 + progress * 11,
    Math.atan2(attack.directionY, attack.directionX), ATTACK_ARC,
    Math.max(0, lead - 0.75), lead, 7,
    [[3, INK], [1, RAINBOW], [-3, HOT]],
  );
  ctx.globalAlpha = 1;
}

/**
 * Four one-pixel ticks and a dot. A reticle competes with the scene for the
 * player's attention, so it is drawn as thin as it can be and still be found;
 * a dark copy offset by a pixel is cheaper than outlining every tick and is
 * enough contrast over both pale stone and dark water.
 */
function drawAimMarker(aimX, aimY) {
  const x = pixelX(aimX);
  const y = pixelY(aimY);
  // Closing in while firing, and warming once there is charge to spend, makes
  // the marker report the laser's state without adding anything to the HUD.
  // Its colour is the llamacorn's own magic rather than a neutral white, because
  // a pale marker vanishes into the pale stone that covers most of the ruins —
  // leaving only its dark backing behind, which reads as grit on the screen.
  const reach = laser.active ? 5 : 8;
  for (const [shift, colour] of [[1, INK], [0, laser.charge ? '#ffe08a' : RAINBOW[0]]]) {
    ctx.fillStyle = colour;
    ctx.fillRect(x + shift, y - reach - 2 + shift, 1, 3);
    ctx.fillRect(x + shift, y + reach + shift, 1, 3);
    ctx.fillRect(x - reach - 2 + shift, y + shift, 3, 1);
    ctx.fillRect(x + reach + shift, y + shift, 3, 1);
    ctx.fillRect(x + shift, y + shift, 1, 1);
  }
}

/**
 * Diagonal shafts of light, drawn in world space so they belong to the place
 * rather than sliding across the lens. Each shaft is stepped in 4-unit slices
 * instead of being a rotated rectangle, which keeps its edge on the pixel grid
 * and out of the antialiaser.
 */
function drawLightShafts(bounds) {
  const top = Math.floor(bounds.top);
  const bottom = Math.ceil(bounds.bottom);
  const first = Math.floor((bounds.left - bottom * SHAFT_SKEW) / SHAFT_SPACING) - 1;
  const last = Math.ceil((bounds.right - top * SHAFT_SKEW) / SHAFT_SPACING);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = '#fff0c8';
  for (let index = first; index <= last; index++) {
    // Evenly spaced shafts tile like wallpaper. Hashing the slot for width,
    // offset and the occasional skip keeps the sky feeling broken up.
    const variation = hash(index, 7, 31);
    if (variation % 4 === 0) continue;
    const width = 40 + variation % 84;
    const originX = index * SHAFT_SPACING + variation % 97;
    // A wide diffuse halo, then a brighter core inside it.
    for (const [span, inset, alpha] of [[width, 0, 0.03], [width / 2, width / 4, 0.04]]) {
      ctx.globalAlpha = alpha;
      for (let y = top; y < bottom; y += 4) ctx.fillRect(originX + inset + y * SHAFT_SKEW, y, span, 4);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Slow motes give the shafts something to catch and keep an empty field from
 * looking like a still image. One mote per world cell, drifting down through
 * its own cell and fading in and out across the trip, so it never pops when it
 * wraps and the count stays proportional to the viewport.
 */
function drawMotes(bounds) {
  ctx.fillStyle = '#fff6d8';
  for (let cellY = Math.floor(bounds.top / MOTE_CELL); cellY <= bounds.bottom / MOTE_CELL; cellY++) {
    for (let cellX = Math.floor(bounds.left / MOTE_CELL); cellX <= bounds.right / MOTE_CELL; cellX++) {
      const seed = hash(cellX, cellY, 13);
      const progress = (seed % 997 / 997 + gameTime * 0.04) % 1;
      ctx.globalAlpha = Math.sin(progress * Math.PI) * 0.4;
      ctx.fillRect(
        pixelX(cellX * MOTE_CELL + (seed >>> 10) % MOTE_CELL),
        pixelY((cellY + progress) * MOTE_CELL),
        1, 1,
      );
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * One multiply pass does both jobs the reference art leans on: it grades the
 * whole frame onto a single warm-centre/cool-corner ramp, and it sinks the
 * frame edges into shadow so the eye stays on the player.
 */
function vignetteGradient(inner) {
  const radius = Math.hypot(screenWidth, screenHeight) / 2;
  return ctx.createRadialGradient(
    screenWidth / 2, screenHeight / 2, radius * inner,
    screenWidth / 2, screenHeight / 2, radius,
  );
}

function buildGrade() {
  grade = vignetteGradient(0.3);
  // Near-neutral through the play area so materials keep their own colour,
  // then a hard fall into cool shadow only once it reaches the frame.
  grade.addColorStop(0, '#fffaec');
  grade.addColorStop(0.6, '#f0ecd6');
  grade.addColorStop(1, '#334b53');

  // Hurt is always the same paint, so it can stay cached. The rainbow wash
  // changes its stops as it flows and is rebuilt only while the laser is up.
  hurtVignette = vignetteGradient(0.4);
  hurtVignette.addColorStop(0, '#000');
  hurtVignette.addColorStop(1, '#e94863');
}

/**
 * A wash of light pulled in from the frame edges. This lives on the canvas
 * rather than in the DOM despite the HUD rule, because it is not a HUD element:
 * it is the same class of thing as the colour grade directly above it — a lens
 * effect over the whole scene — and it has to sit in a known place in that
 * order. A DOM overlay would always land on top of the grade, and could never
 * be seen in a headless preview, which is the only way we can look at any of
 * this.
 *
 * Added rather than blended, which is what lets the centre be a true no-op:
 * adding black changes nothing, so the play area is untouched no matter how
 * hard the edges burn, and the strength is honest `globalAlpha` rather than a
 * per-stop alpha ramp. `paint` is the cached hurt gradient, or the spectrum
 * itself for the moving laser wash.
 */
function drawVignette(paint, amount) {
  if (amount <= 0) return;
  let wash = paint;
  if (paint === RAINBOW) {
    wash = vignetteGradient(0.4);
    wash.addColorStop(0, '#000');
    const flow = gameTime * VIGNETTE_SCROLL;
    const slide = flow % 1;
    const stepped = Math.floor(flow) % paint.length;
    const bands = paint.length;
    for (let band = 0; band <= bands; band++) {
      wash.addColorStop(
        0.45 + 0.55 * clamp((band + slide) / bands, 0, 1),
        paint[(band - stepped + paint.length) % paint.length],
      );
    }
  }
  ctx.globalAlpha = Math.min(1, amount);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, screenWidth, screenHeight);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function draw() {
  const dpr = devicePixelRatio || 1;
  const alpha = accumulator / FIXED_STEP;
  const cameraX = camera.previousX + (camera.x - camera.previousX) * alpha;
  const cameraY = camera.previousY + (camera.y - camera.previousY) * alpha;
  // Render-only shake keeps collision and camera follow stable. Clamping the
  // shaken sample prevents impacts near a map edge exposing the canvas void.
  const limits = cameraLimits();
  // The ignition also drives the lens. Zoom is a channel nothing else in the
  // game touches, which is the whole point of spending it here: shake already
  // means four different things, and a fifth would have made it mean none.
  // Render-only again, and inward only — a wider view than `zoom` would put the
  // canvas void past the camera limits, which are sized for `zoom` exactly.
  const punch = laser.punch / PUNCH_TIME;
  const viewZoom = zoom * (1 + punch * PUNCH_ZOOM);
  const viewX = clamp(cameraX + Math.sin(gameTime * 137) * shake / viewZoom, limits.minX, limits.maxX);
  const viewY = clamp(cameraY + Math.sin(gameTime * 191) * shake / viewZoom, limits.minY, limits.maxY);
  const playerX = player.previousX + (player.x - player.previousX) * alpha;
  const playerY = player.previousY + (player.y - player.previousY) * alpha;
  const aimX = aim.previousX + (aim.x - aim.previousX) * alpha;
  const aimY = aim.previousY + (aim.y - aim.previousY) * alpha;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b161b';
  ctx.fillRect(0, 0, screenWidth, screenHeight);
  renderScale = dpr * viewZoom;
  renderOffsetX = Math.round((screenWidth / 2 - viewX * viewZoom) * dpr);
  renderOffsetY = Math.round((screenHeight / 2 - viewY * viewZoom) * dpr);
  ctx.setTransform(
    renderScale, 0, 0, renderScale,
    renderOffsetX, renderOffsetY,
  );

  const bounds = visibleBounds(viewX, viewY);
  drawTerrain(ctx, terrain, bounds);
  for (const enemy of enemies) {
    drawEnemyTelegraph(
      enemy,
      enemy.previousX + (enemy.x - enemy.previousX) * alpha,
      enemy.previousY + (enemy.y - enemy.previousY) * alpha,
    );
  }
  drawProjectiles(alpha);

  // Six actors are cheap to sort and proper feet-based ordering prevents a
  // lower character from disappearing behind one farther up the field.
  const actors = enemies.map(enemy => ({
    enemy,
    x: enemy.previousX + (enemy.x - enemy.previousX) * alpha,
    y: enemy.previousY + (enemy.y - enemy.previousY) * alpha,
  }));
  actors.push({ x: playerX, y: playerY });
  actors.sort((a, b) => a.y - b.y);
  for (const actor of actors) {
    if (actor.enemy) drawEnemy(actor.enemy, actor.x, actor.y);
    else drawPlayer(actor.x, actor.y);
  }
  for (const actor of actors) {
    if (actor.enemy) drawEnemyAttack(actor.enemy, actor.x, actor.y);
  }
  drawLaser(playerX, playerY);
  drawAttack(playerX, playerY);
  for (const actor of actors) {
    if (actor.enemy) drawImpact(actor.x, actor.y, actor.enemy.hitEffect, 0.16, '#fff3a6');
  }
  drawImpact(playerX, playerY, player.hitEffect, 0.18, '#e94863');
  drawLightShafts(bounds);
  drawMotes(bounds);
  drawAimMarker(aimX, aimY);

  // The grade is a lens effect, so it is applied in screen space after the
  // world transform is finished with. The HUD lives in the DOM and is spared.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = grade;
  ctx.fillRect(0, 0, screenWidth, screenHeight);
  ctx.globalCompositeOperation = 'source-over';
  // Over the grade, not under it: these are the frame reacting, and the grade
  // is the frame. Hurt last, because being hit outranks everything else on
  // screen — including your own laser going off.
  drawVignette(RAINBOW, (laser.active ? 0.5 : 0) + punch * 0.6);
  drawVignette(hurtVignette, player.hurtGlow * 0.9);
}

function frame(now) {
  accumulator = Math.min(accumulator + (now - lastTime) / 1000, 0.1);
  lastTime = now;
  while (accumulator >= FIXED_STEP) {
    update(FIXED_STEP);
    accumulator -= FIXED_STEP;
  }
  draw();
  requestAnimationFrame(frame);
}

const gameKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space']);
addEventListener('keydown', event => {
  if (!gameKeys.has(event.code)) return;
  event.preventDefault();
  held.add(event.code);
  if (event.code === 'Space' && !event.repeat) dashBuffer = 0.12;
});
addEventListener('keyup', event => held.delete(event.code));
function updatePointer(event) {
  const bounds = canvas.getBoundingClientRect();
  pointer.x = event.clientX - bounds.left;
  pointer.y = event.clientY - bounds.top;
  pointer.seen = true;
}
canvas.addEventListener('pointermove', updatePointer);
canvas.addEventListener('pointerdown', event => {
  updatePointer(event);
  if (event.button === 0) attackBuffer = 0.1;
  else if (event.button === 2) laser.held = true;
  else return;
  event.preventDefault();
});
addEventListener('pointerup', event => {
  if (event.button === 2) laser.held = false;
});
// Reserve right-click for the rainbow laser rather than opening browser UI.
canvas.addEventListener('contextmenu', event => event.preventDefault());
addEventListener('blur', () => {
  held.clear();
  laser.held = false;
});
addEventListener('resize', resize);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(canvas);

resize();
updateHud();
requestAnimationFrame(frame);
})();
