import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arenaCap, arenaDelay, createArena, markSwing, updateArena } from '../src/arena.js';
import { isWalkable, packLevel, stackAt, unpackLevel } from '../src/terrain.js';
import { buildArena, packedArena } from './build-arena.js';

const source = JSON.parse(readFileSync(new URL('../src/levels/arena.json', import.meta.url)));
const gameSource = readFileSync(new URL('../src/game.js', import.meta.url), 'utf8');
assert.doesNotMatch(gameSource, /1\s*<<\s*enemy\.id/, 'Melee still aliases enemy IDs through a 32-bit mask');
const swing = { swing: 1 };
const lateEnemy = { id: 40, swing: -1 };
assert.ok(markSwing(swing, lateEnemy), 'First contact in a swing was suppressed');
assert.ok(!markSwing(swing, lateEnemy), 'One swing hit the same enemy twice');
swing.swing++;
assert.ok(markSwing(swing, lateEnemy), 'A later swing could not hit the enemy again');
const generated = packedArena();
assert.deepEqual(source, generated, 'arena.json is stale; run node scripts/build-arena.js');
assert.deepEqual(packLevel(buildArena()), generated, 'Arena recipe is not deterministic');
assert.ok(!source.wide && source.stacks.length <= 16, 'Arena escaped nibble tile IDs');

const level = unpackLevel(source);
assert.equal(level.width, 1920);
assert.equal(level.height, 1280);
assert.equal(level.spawners.length, 4);
const [north, east, south, west] = level.spawners;
assert.ok(north[0] === level.player[0] && north[1] < level.player[1]);
assert.ok(east[0] > level.player[0] && east[1] === level.player[1]);
assert.ok(south[0] === level.player[0] && south[1] > level.player[1]);
assert.ok(west[0] < level.player[0] && west[1] === level.player[1]);
assert.deepEqual(level.enemies, [], 'Arena should open with its spawn grace period');
assert.ok(source.stacks.some(stack => stack.includes('#')), 'Arena has no ruined Walls');
assert.ok(source.stacks.some(stack => stack.includes('^')), 'Arena has no Stairs');
for (const code of 'gdwfbs') assert.ok(source.stacks.some(stack => stack.includes(code)), `Arena never uses ${code}`);

for (const [label, point] of [['player', level.player], ...level.spawners.map((point, index) => [`gate ${index}`, point])]) {
  assert.ok(isWalkable(level, point[0], point[1], 12), `${label} is not radius-walkable`);
}
for (const gate of level.spawners) {
  for (let amount = 0; amount <= 1; amount += 0.05) {
    const x = gate[0] + (level.player[0] - gate[0]) * amount;
    const y = gate[1] + (level.player[1] - gate[1]) * amount;
    assert.ok(isWalkable(level, x, y, 12), `Gate route is blocked at ${x},${y}`);
  }
}
assert.ok(!isWalkable(level, 100, 100, 12), 'Outer water/bounds unexpectedly became playable');
assert.ok(stackAt(level, 30, 14).includes('^'), 'North gate lost its staircase');
assert.throws(() => unpackLevel({ ...source, spawners: 0 }), /spawner/i);
assert.throws(() => unpackLevel({ ...source, spawners: [[1, 2]] }), /spawner/i);
assert.throws(() => unpackLevel({ ...source, spawners: [[1, 2], [3, 4], [5, 6], [Infinity, 8]] }), /spawner/i);
assert.throws(() => unpackLevel({ ...source, spawners: [[1, 2], [3, 4], [5, 6], [7.5, 8]] }), /spawner/i);
assert.deepEqual(packLevel(unpackLevel(source)), source, 'Arena pack/unpack changed its metadata');
assert.equal(createArena([], 9), null, 'A map without gates created an arena director');
const offsetArena = createArena(level.spawners, 17);
assert.equal(offsetArena.nextId, 17);
assert.equal(offsetArena.clock, 2.4);
assert.deepEqual([...offsetArena.flash], [0, 0, 0, 0]);
updateArena(null, 99, 0, level.player, [], () => assert.fail('Null arena emitted an enemy'));
assert.equal(arenaCap(14), 6);
assert.equal(arenaCap(15), 7);
assert.equal(arenaCap(59), 9);
assert.equal(arenaCap(60), 10);
assert.equal(arenaDelay(0), 1.4);
assert.equal(arenaDelay(1), 1.39);
assert.equal(arenaDelay(60), 0.8);
assert.equal(arenaDelay(100), 0.8);

// With no kills, the director fills its initial cap and remains bounded.
let arena = createArena(level.spawners);
const held = [];
for (let frame = 0; frame < 60 * 30; frame++) {
  updateArena(arena, 1 / 60, held.length, { x: 960, y: 640 }, level.spawners, arrival => held.push(arrival));
}
assert.equal(held.length, 6, 'Initial living-enemy cap was not enforced');
assert.equal(arenaCap(0), 6);

// A full cap polls at a short interval, then resumes without changing the
// schedule or consuming an ID once a living slot opens.
const capped = createArena(level.spawners, 12);
capped.clock = 0;
updateArena(capped, 1, 6, { x: level.player[0], y: level.player[1] }, level.spawners, () => assert.fail('Director emitted above its cap'));
assert.equal(capped.clock, 0.2);
assert.equal(capped.count, 0);
assert.equal(capped.nextId, 12);
const resumed = [];
updateArena(capped, 0.2, 5, { x: level.player[0], y: level.player[1] }, level.spawners, arrival => resumed.push(arrival));
assert.deepEqual(resumed, [{ id: 12, gate: 0, type: 0 }]);

// Flash state decays independently of whether the director is still in grace.
capped.flash[2] = 1;
capped.clock = 10;
updateArena(capped, 0.25, 0, { x: level.player[0], y: level.player[1] }, level.spawners, () => {});
assert.ok(Math.abs(capped.flash[2] - 0.55) < 1e-6);
updateArena(capped, 1, 0, { x: level.player[0], y: level.player[1] }, level.spawners, () => {});
assert.equal(capped.flash[2], 0);

// A camped gate is skipped rather than creating contact damage, and even a
// tab-sized timestep emits at most one enemy rather than a catch-up burst.
arena = createArena(level.spawners);
const skipped = [];
updateArena(arena, 99, 0, { x: level.spawners[0][0], y: level.spawners[0][1] }, level.spawners, arrival => skipped.push(arrival));
assert.equal(skipped.length, 1);
assert.equal(skipped[0].gate, 1);
updateArena(arena, 99, 0, { x: 960, y: 640 }, level.spawners, arrival => skipped.push(arrival));
assert.equal(skipped.length, 2, 'Large timestep emitted a catch-up burst');
assert.equal(skipped[1].gate, 2, 'Skipped gate broke stable rotation');

// If every gate is camped, polling waits without mutating gate/count/IDs.
const surrounded = createArena(level.spawners, 4);
surrounded.clock = 0;
const closeSpawners = [[0, 0], [5, 0], [0, 5], [5, 5]];
updateArena(surrounded, 1, 0, { x: 2, y: 2 }, closeSpawners, () => assert.fail('Camped gates emitted'));
assert.equal(surrounded.clock, 0.2);
assert.equal(surrounded.gate, 0);
assert.equal(surrounded.count, 0);
assert.equal(surrounded.nextId, 4);

// Fast kills force a long run through IDs beyond the old 32-bit hit-mask limit.
arena = createArena(level.spawners);
const arrivals = [];
for (let frame = 0; frame < 60 * 90 && arrivals.length < 45; frame++) {
  updateArena(arena, 1 / 60, 0, { x: 960, y: 640 }, level.spawners, arrival => arrivals.push(arrival));
}
assert.equal(arrivals.length, 45);
assert.deepEqual(arrivals.slice(0, 8).map(arrival => arrival.gate), [0, 1, 2, 3, 0, 1, 2, 3]);
assert.deepEqual(arrivals.slice(0, 9).map(arrival => arrival.type), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
assert.equal(arrivals[44].id, 44);
assert.equal(new Set(arrivals.map(arrival => arrival.id)).size, arrivals.length);

const replay = [];
arena = createArena(level.spawners);
for (let frame = 0; frame < 60 * 12; frame++) {
  updateArena(arena, 1 / 60, 0, { x: 960, y: 640 }, level.spawners, arrival => replay.push(arrival));
}
assert.deepEqual(replay, arrivals.slice(0, replay.length), 'Arena reset did not reproduce its opening');

console.log(`arena smoke passed (${source.stacks.length} stacks, ${source.tiles.length} tile chars, ${arrivals.length} long-run arrivals)`);
