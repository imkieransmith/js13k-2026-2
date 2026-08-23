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
const LASER_REACH = 360;
const LASER_WIDTH = 7;
const MELEE_WINDUP = 0.45;
const RANGED_WINDUP = 0.62;
const ENEMY_ATTACK_EFFECT = 0.16;
const ENEMY_HURT_FLASH = 0.45;
const ENEMY_ATTACK_REACH = 52;
const ENEMY_ATTACK_ARC = Math.PI * 0.58;
const ENEMY_AGGRO = 210;
const ENEMY_LEASH = 250;
const ENEMY_ROAM = 235;
const AIM_DISTANCE = 144;
const AIM_MARGIN = 9;
const BASE_ZOOM = 2;
const FIXED_STEP = 1 / 120;

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
  health: PLAYER_MAX_HEALTH,
  invulnerability: 0,
  hitEffect: 0,
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
const laser = { charge: 0, held: false, active: false, directionX: 0, directionY: 1 };
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
let hudSignature = '';

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

  if (dashBuffer && !player.dashCooldown) beginDash(input);

  if (player.dashTime > 0) {
    player.dashTime = Math.max(0, player.dashTime - dt);
    player.vx = player.dashX * DASH_SPEED;
    player.vy = player.dashY * DASH_SPEED;
    player.trailClock -= dt;
    if (player.trailClock <= 0) {
      trails.push({ x: player.x, y: player.y, life: 0.16 });
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
  let screenReach = AIM_DISTANCE;
  const left = camera.x - viewWidth / 2 + AIM_MARGIN;
  const right = camera.x + viewWidth / 2 - AIM_MARGIN;
  const top = camera.y - viewHeight / 2 + AIM_MARGIN;
  const bottom = camera.y + viewHeight / 2 - AIM_MARGIN;
  if (player.facingX > 0) screenReach = Math.min(screenReach, (right - player.x) / player.facingX);
  if (player.facingX < 0) screenReach = Math.min(screenReach, (left - player.x) / player.facingX);
  if (player.facingY > 0) screenReach = Math.min(screenReach, (bottom - player.y) / player.facingY);
  if (player.facingY < 0) screenReach = Math.min(screenReach, (top - player.y) / player.facingY);
  const reach = Math.min(distance, Math.max(0, screenReach));
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

function updateHud() {
  const health = String(player.health);
  const laserLevel = String(Math.ceil(laser.charge * 2));
  const signature = `${health},${laserLevel}`;
  if (signature === hudSignature) return;
  hudSignature = signature;
  hud.dataset.health = health;
  hud.dataset.laser = laserLevel;
  hud.setAttribute('aria-label', `Health ${health} of ${PLAYER_MAX_HEALTH}. Rainbow laser ${Number(laserLevel) / 2} seconds.`);
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
  if (!enemy.health) {
    enemy.death = 0.24;
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
    updateHud();
  }
}

function updateLaser(dt) {
  for (const enemy of enemies) enemy.laserCooldown = Math.max(0, enemy.laserCooldown - dt);
  laser.active = laser.held && laser.charge > 0;
  if (!laser.active) return;

  laser.directionX = player.facingX;
  laser.directionY = player.facingY;
  laser.charge = Math.max(0, laser.charge - dt);
  for (const enemy of enemies) {
    if (!enemy.health || enemy.laserCooldown) continue;
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const along = dx * laser.directionX + dy * laser.directionY;
    const across = Math.abs(dx * laser.directionY - dy * laser.directionX);
    if (along < 0 || along > LASER_REACH + 12 || across > LASER_WIDTH + 12) continue;
    hurtEnemy(enemy, laser.directionX * 55, laser.directionY * 55);
    enemy.laserCooldown = 0.38;
  }
  updateHud();
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
  player.dashTime = player.dashCooldown = 0;
  attack.time = attack.cooldown = attack.hits = 0;
  laser.charge = 0;
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
  hudSignature = '';
  updateHud();
}

function update(dt) {
  // Rendering interpolates these fixed simulation samples. Without the older
  // sample, high-refresh displays alternate between still and double steps.
  gameTime += dt;
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

function drawEnemyTelegraph(enemy, x, y) {
  const hitFlash = !enemy.type && enemy.attackEffect > 0;
  if (enemy.windup <= 0 && !hitFlash) return;
  const duration = enemy.type ? RANGED_WINDUP : MELEE_WINDUP;
  const progress = hitFlash
    ? 1
    : clamp((1 - enemy.windup / duration) * 1.08, 0, 1);
  // Cubic easing keeps the opening genuinely faint. On impact, a larger pale
  // red frame creates visible contrast with the fully opaque final warning.
  const freshHit = hitFlash && enemy.attackEffect > 0.1;
  ctx.globalAlpha = hitFlash
    ? freshHit ? 1 : enemy.attackEffect / 0.1
    : progress * progress * progress;
  ctx.fillStyle = freshHit ? '#ffd0da' : '#e94863';

  if (enemy.type) {
    // The warning is the projectile's committed path, not a live tracker.
    for (let distance = 14; distance < 300; distance += 6) {
      const lineX = pixelX(x + enemy.attackDirectionX * distance);
      const lineY = pixelY(y + enemy.attackDirectionY * distance);
      ctx.fillRect(lineX - 1, lineY - 1, 3, 3);
    }
  } else {
    // Reveal the exact damage sector as a low-resolution sweeping red field.
    const centre = Math.atan2(enemy.attackDirectionY, enemy.attackDirectionX);
    const start = centre - ENEMY_ATTACK_ARC / 2;
    const steps = 18;
    const count = Math.max(1, Math.ceil(steps * progress));
    for (let angleStep = 0; angleStep < count; angleStep++) {
      const angle = start + ENEMY_ATTACK_ARC * angleStep / (steps - 1);
      for (let distance = 20; distance <= ENEMY_ATTACK_REACH; distance += 8) {
        const sectorX = pixelX(x + Math.cos(angle) * distance);
        const sectorY = pixelY(y + Math.sin(angle) * distance);
        const stamp = freshHit ? 7 : 5;
        ctx.fillRect(
          sectorX - stamp / 2,
          sectorY - stamp / 2,
          stamp, stamp,
        );
      }
    }
  }
  ctx.globalAlpha = 1;
}

function drawEnemyAttack(enemy, x, y) {
  if (!enemy.type || enemy.attackEffect <= 0) return;
  const progress = 1 - enemy.attackEffect / ENEMY_ATTACK_EFFECT;
  // The projectile supplies the travel animation; this is its muzzle burst.
  const distance = 13 + progress * 18;
  const flashX = pixelX(x + enemy.attackDirectionX * distance);
  const flashY = pixelY(y + enemy.attackDirectionY * distance);
  ctx.fillStyle = progress < 0.5 ? '#ffc55c' : '#fff3a6';
  ctx.fillRect(flashX - 4, flashY - 4, 9, 9);
  ctx.fillStyle = '#fffaf0';
  ctx.fillRect(flashX - 2, flashY - 2, 5, 5);
}

function drawImpact(x, y, time, duration, colour) {
  if (time <= 0) return;
  const progress = 1 - time / duration;
  const radius = 5 + progress * 14;
  ctx.globalAlpha = time / duration;
  ctx.fillStyle = colour;
  for (let i = 0; i < 8; i++) {
    const angle = Math.PI / 4 * i;
    ctx.fillRect(
      pixelX(x + Math.cos(angle) * radius) - 2,
      pixelY(y + Math.sin(angle) * radius) - 2,
      4, 4,
    );
  }
  ctx.globalAlpha = 1;
}

function drawEnemy(enemy, x, y) {
  x = pixelX(x);
  y = pixelY(y);
  if (!enemy.health) ctx.globalAlpha = Math.max(0, enemy.death / 0.24);
  else if (enemy.hurt && (enemy.hurt * 24 | 0) & 1) ctx.globalAlpha = 0.35;
  const alert = enemy.mode === 1;
  ctx.fillStyle = '#38664e';
  ctx.fillRect(x - 9, y + 10, 18, 4);

  if (!enemy.type) {
    // A low stone cube on four dark legs reads as an ancient crab-like guard.
    ctx.fillStyle = '#423b55';
    ctx.fillRect(x - 12, y + 5, 5, 9);
    ctx.fillRect(x + 7, y + 5, 5, 9);
    ctx.fillRect(x - 11, y - 10, 22, 21);
    ctx.fillStyle = '#aeb7a7';
    ctx.fillRect(x - 8, y - 7, 16, 15);
    ctx.fillStyle = '#dbe0ca';
    ctx.fillRect(x - 7, y - 6, 13, 4);
    ctx.fillStyle = alert ? '#f16b9a' : '#62b8ed';
    ctx.fillRect(x - 3, y, 6, 4);
  } else {
    // Ranged Constructs float: a compact prism around a bright central lens.
    const bob = Math.round(Math.sin(gameTime * 3 + enemy.id) * 2) - 4;
    y += bob;
    ctx.fillStyle = '#423b55';
    ctx.fillRect(x - 10, y - 10, 20, 20);
    ctx.fillStyle = '#c7cfc1';
    ctx.fillRect(x - 7, y - 7, 14, 14);
    ctx.fillStyle = '#e5ead7';
    ctx.fillRect(x - 6, y - 6, 11, 4);
    ctx.fillStyle = alert ? '#ffc55c' : '#62b8ed';
    ctx.fillRect(x - 3, y - 3, 6, 6);
    ctx.fillStyle = '#342d4b';
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }

  ctx.globalAlpha = 1;
}

function drawProjectiles(alpha) {
  for (const projectile of projectiles) {
    const x = pixelX(projectile.previousX + (projectile.x - projectile.previousX) * alpha);
    const y = pixelY(projectile.previousY + (projectile.y - projectile.previousY) * alpha);
    ctx.fillStyle = '#423b55';
    ctx.fillRect(x - 4, y - 4, 9, 9);
    ctx.fillStyle = '#ffc55c';
    ctx.fillRect(x - 2, y - 2, 5, 5);
    ctx.fillStyle = '#fff3a6';
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }
}

function drawPlayer(playerX, playerY) {
  for (let i = 0; i < trails.length; i++) {
    const trail = trails[i];
    const colours = ['#f16b9a', '#ffc55c', '#68d48b', '#62b8ed', '#9c78df'];
    ctx.globalAlpha = trail.life / 0.16 * 0.82;
    ctx.fillStyle = colours[i % colours.length];
    ctx.fillRect(pixelX(trail.x) - 9, pixelY(trail.y) - 11, 18, 22);
  }
  ctx.globalAlpha = 1;

  const x = pixelX(playerX);
  const y = pixelY(playerY);
  ctx.globalAlpha = player.invulnerability && (player.invulnerability * 24 | 0) & 1 ? 0.35 : 1;
  ctx.fillStyle = '#38664e';
  ctx.fillRect(x - 8, y + 10, 16, 4);
  ctx.fillStyle = '#342d4b';
  ctx.fillRect(x - 11, y - 13, 22, 26);
  ctx.fillStyle = player.dashTime ? '#fff3a6' : '#fffaf0';
  ctx.fillRect(x - 8, y - 10, 16, 20);
  ctx.globalAlpha = 1;
}

// Four bracket segments make a crisp circular crosshair without introducing
// antialiased vector edges into the pixel-art scene.
function drawLaser(playerX, playerY) {
  if (!laser.active) return;
  const colours = ['#f16b9a', '#ffc55c', '#fff3a6', '#68d48b', '#62b8ed', '#9c78df'];
  ctx.globalAlpha = 0.9;
  for (let distance = 13, stripe = 0; distance < LASER_REACH; distance += 5, stripe++) {
    const x = pixelX(playerX + laser.directionX * distance);
    const y = pixelY(playerY + laser.directionY * distance);
    ctx.fillStyle = '#342d4b';
    ctx.fillRect(x - 3, y - 3, 7, 7);
    ctx.fillStyle = colours[stripe % colours.length];
    ctx.fillRect(x - 2, y - 2, 5, 5);
    ctx.fillStyle = '#fffaf0';
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.globalAlpha = 1;
}

function drawAttack(playerX, playerY) {
  if (!attack.time) return;
  const progress = 1 - attack.time / ATTACK_DURATION;
  const visible = Math.min(1, progress * 2.8);
  const segments = 20;
  const count = Math.max(1, Math.ceil(segments * visible));
  const centre = Math.atan2(attack.directionY, attack.directionX);
  const start = centre - ATTACK_ARC / 2;
  const radius = ATTACK_REACH - 12 + progress * 8;
  const colours = ['#f16b9a', '#ffc55c', '#fff3a6', '#68d48b', '#62b8ed', '#9c78df'];
  ctx.globalAlpha = Math.min(1, attack.time / 0.055);

  // Closely-spaced square stamps form a chunky crescent and communicate the
  // broad multi-target hit area without relying on an animated unicorn frame.
  for (let i = 0; i < count; i++) {
    const amount = i / (segments - 1);
    const angle = start + ATTACK_ARC * amount;
    const x = pixelX(playerX + Math.cos(angle) * radius);
    const y = pixelY(playerY + Math.sin(angle) * radius);
    ctx.fillStyle = '#342d4b';
    ctx.fillRect(x - 3, y - 3, 7, 7);
    ctx.fillStyle = colours[i % colours.length];
    ctx.fillRect(x - 2, y - 2, 5, 5);
  }
  ctx.globalAlpha = 1;
}

function drawAimMarker(aimX, aimY) {
  const x = pixelX(aimX);
  const y = pixelY(aimY);
  ctx.fillStyle = '#342d4b';
  ctx.fillRect(x - 4, y - 8, 8, 3);
  ctx.fillRect(x - 4, y + 5, 8, 3);
  ctx.fillRect(x - 8, y - 4, 3, 8);
  ctx.fillRect(x + 5, y - 4, 3, 8);
  ctx.fillStyle = '#f16b9a';
  ctx.fillRect(x - 3, y - 7, 6, 1);
  ctx.fillRect(x - 3, y + 6, 6, 1);
  ctx.fillRect(x - 7, y - 3, 1, 6);
  ctx.fillRect(x + 6, y - 3, 1, 6);
  ctx.fillStyle = '#fff3a6';
  ctx.fillRect(x - 1, y - 1, 3, 3);
}

function draw() {
  const dpr = devicePixelRatio || 1;
  const alpha = accumulator / FIXED_STEP;
  const cameraX = camera.previousX + (camera.x - camera.previousX) * alpha;
  const cameraY = camera.previousY + (camera.y - camera.previousY) * alpha;
  const playerX = player.previousX + (player.x - player.previousX) * alpha;
  const playerY = player.previousY + (player.y - player.previousY) * alpha;
  const aimX = aim.previousX + (aim.x - aim.previousX) * alpha;
  const aimY = aim.previousY + (aim.y - aim.previousY) * alpha;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#183b64';
  ctx.fillRect(0, 0, screenWidth, screenHeight);
  renderScale = dpr * zoom;
  renderOffsetX = Math.round((screenWidth / 2 - cameraX * zoom) * dpr);
  renderOffsetY = Math.round((screenHeight / 2 - cameraY * zoom) * dpr);
  ctx.setTransform(
    renderScale, 0, 0, renderScale,
    renderOffsetX, renderOffsetY,
  );

  const bounds = visibleBounds(cameraX, cameraY);
  drawTerrain(ctx, terrain, bounds, gameTime);
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
  drawAimMarker(aimX, aimY);
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
