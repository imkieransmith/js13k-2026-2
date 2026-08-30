// Compact deterministic director for maps with four arena gates. Keeping the
// schedule pure makes long survival runs testable without a browser or canvas.
const SPAWN_GRACE = 2.4;
const SPAWN_DISTANCE = 110;

export const arenaCap = count => Math.min(10, 6 + Math.floor(count / 15));
export const arenaDelay = count => Math.max(0.8, 1.4 - count * 0.01);

/** Mark one enemy once for the current horn swing, independent of enemy ID. */
export function markSwing(attack, enemy) {
  if (enemy.swing === attack.swing) return false;
  enemy.swing = attack.swing;
  return true;
}

export function createArena(spawners, firstId = 0) {
  return spawners.length ? {
    clock: SPAWN_GRACE,
    count: 0,
    nextId: firstId,
    gate: 0,
    flash: new Float32Array(spawners.length),
  } : null;
}

/** Advance the director and emit at most one arrival per simulation step. */
export function updateArena(arena, dt, living, player, spawners, emit) {
  if (!arena) return;
  for (let gate = 0; gate < arena.flash.length; gate++) {
    arena.flash[gate] = Math.max(0, arena.flash[gate] - dt * 1.8);
  }
  arena.clock -= dt;
  if (arena.clock > 0) return;
  if (living >= arenaCap(arena.count)) {
    arena.clock = 0.2;
    return;
  }

  let chosen = -1;
  for (let offset = 0; offset < spawners.length; offset++) {
    const gate = (arena.gate + offset) % spawners.length;
    if (Math.hypot(player.x - spawners[gate][0], player.y - spawners[gate][1]) >= SPAWN_DISTANCE) {
      chosen = gate;
      break;
    }
  }
  if (chosen < 0) {
    arena.clock = 0.2;
    return;
  }

  const sequence = arena.count++;
  emit({
    id: arena.nextId++,
    gate: chosen,
    // Two walkers for every ranged machine keeps the pressure close and lets
    // the occasional sight line complicate the otherwise readable scrum.
    type: sequence % 3 === 2 ? 1 : 0,
  });
  arena.flash[chosen] = 1;
  arena.gate = (chosen + 1) % spawners.length;
  arena.clock = arenaDelay(arena.count);
}
