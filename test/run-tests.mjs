// Tests for the Sokoban solver (main.ts). Run: node test/run-tests.mjs
// Unit tests import the solver directly. Integration tests run main.ts as a
// subprocess on the kit's practice set and replay every solution, checking
// the push count against the manifest's P*. The kit directory is taken from
// KIT_DIR, or the path this entry was built against; integration tests are
// skipped with a note when the kit is not there.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  parseLevel,
  decompose,
  pushSearch,
  pushesToMoves,
  replayMoves,
  simulateMoves,
  solveLevel,
  flood,
  bfsPath,
  assignmentHeuristic,
  allDistances,
  isDeadState,
  reachableToGoal,
  blockedOf,
} from '../main.ts';

const KIT =
  process.env.KIT_DIR ??
  '/home/hatch/workspace/makefun/sokoban-solver-01-run-20261121/sokoban-solver-01-run-20261121-kit';
const ENTRY = new URL('..', import.meta.url).pathname;

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const levelText = (id) => readFileSync(join(KIT, 'practice', 'input', id, 'level.txt'), 'utf8');
const manifest = () => JSON.parse(readFileSync(join(KIT, 'practice', 'reference', 'manifest.json'), 'utf8'));

// --- parsing ---------------------------------------------------------------

test('parse: XSB symbols (* box on goal, + player on goal)', () => {
  const l = parseLevel('#####\n#*+ #\n# $ #\n#####\n');
  assert.equal(l.w, 5);
  assert.equal(l.h, 4);
  assert.deepEqual(l.goals, [6, 7]);
  assert.deepEqual(l.boxes, [6, 12]);
  assert.equal(l.player, 7);
});

test('parse: ragged rows pad missing chars with walls', () => {
  const l = parseLevel('####\n# .#\n# $#\n#@\n####\n');
  assert.equal(l.w, 4);
  assert.equal(l.h, 5);
  // row 3 "#@" is short: squares (2,3) and (3,3) are walls.
  assert.equal(l.wall[3 * 4 + 2], 1);
  assert.equal(l.wall[3 * 4 + 3], 1);
  assert.equal(l.player, 3 * 4 + 1);
});

test('parse: trailing newline and empty lines are ignored', () => {
  const a = parseLevel('#####\n# @ #\n#####\n');
  const b = parseLevel('#####\n# @ #\n#####');
  assert.equal(a.w, b.w);
  assert.equal(a.player, b.player);
});

// --- decomposition ---------------------------------------------------------

test('decompose: i001 is one room of 3 boxes, one door', () => {
  const d = decompose(parseLevel(levelText('i001')));
  assert.notEqual(d, null);
  assert.equal(d.rooms.length, 1);
  assert.deepEqual(d.rooms[0].boxes, [27, 43, 60]);
  assert.equal(d.rooms[0].goals.length, 3);
  assert.equal(d.rooms[0].doors.length, 1);
  assert.equal(d.hallwayRow, 8);
});

test('decompose: i003 is two rooms, i005 is four rooms', () => {
  assert.equal(decompose(parseLevel(levelText('i003'))).rooms.length, 2);
  assert.equal(decompose(parseLevel(levelText('i005'))).rooms.length, 4);
  const r = decompose(parseLevel(levelText('i005'))).rooms;
  assert.deepEqual(
    r.map((x) => x.boxes.length),
    [4, 4, 4, 4],
  );
});

test('decompose: a box in the hallway row returns null (global fallback)', () => {
  const l = parseLevel('#####\n#   #\n# $@#\n#####\n');
  assert.equal(decompose(l), null);
});

test('decompose: a room with no door returns null', () => {
  // A sealed room (floor pocket) with no square next to the hallway.
  const l = parseLevel('#######\n# ### #\n# # # #\n# ### #\n#  @  #\n#######\n');
  assert.equal(decompose(l), null);
});

// --- deadlock detection ----------------------------------------------------

test('deadlock: a box in a corner (not on a goal) is dead', () => {
  const l = parseLevel('#####\n#   #\n#   #\n# @ #\n#####\n');
  const size = l.w * l.h;
  const goalSet = new Uint8Array(size);
  goalSet[2 * 5 + 3] = 1;
  const can = reachableToGoal([2 * 5 + 3], new Uint8Array(size).fill(1), l.w, l.h);
  const extra = new Uint8Array(size);
  // box at (1,1): walls above and to the left.
  assert.equal(isDeadState([1 * 5 + 1], l.wall, l.w, l.h, goalSet, can, extra), true);
  // box at (2,2): open floor, can reach the goal.
  assert.equal(isDeadState([2 * 5 + 2], l.wall, l.w, l.h, goalSet, can, extra), false);
});

test('deadlock: a 2x2 block of boxes with no goal is dead', () => {
  const l = parseLevel('######\n#    #\n#    #\n#    #\n#  @ #\n######\n');
  const size = l.w * l.h;
  const goalSet = new Uint8Array(size);
  goalSet[4 * 6 + 4] = 1;
  const walk = new Uint8Array(size).fill(1);
  const can = reachableToGoal([4 * 6 + 4], walk, l.w, l.h);
  const extra = new Uint8Array(size);
  // Four boxes in the middle of the floor, forming a 2x2 with no goal.
  const boxes = [2 * 6 + 2, 2 * 6 + 3, 3 * 6 + 2, 3 * 6 + 3];
  assert.equal(isDeadState(boxes, l.wall, l.w, l.h, goalSet, can, extra), true);
  // One of the four on a goal: not dead by the 2x2 rule.
  goalSet[2 * 6 + 2] = 1;
  assert.equal(isDeadState(boxes, l.wall, l.w, l.h, goalSet, can, extra), false);
});

test('deadlock: a box on a square that cannot reach any goal is dead', () => {
  // A pocket sealed from the goal by walls (reachable only through a wall).
  const l = parseLevel('#######\n#  #  #\n#  # .#\n#  #  #\n# $# @#\n#######\n');
  const size = l.w * l.h;
  const walk = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (l.wall[i] === 0) walk[i] = 1;
  const goalSet = new Uint8Array(size);
  goalSet[2 * 7 + 5] = 1;
  const can = reachableToGoal([2 * 7 + 5], walk, l.w, l.h);
  const extra = new Uint8Array(size);
  assert.equal(can[4 * 7 + 2], 0);
  assert.equal(isDeadState([4 * 7 + 2], l.wall, l.w, l.h, goalSet, can, extra), true);
});

// --- heuristic -------------------------------------------------------------

test('heuristic: admissible on the i001 room (h <= P* = 13)', () => {
  const level = parseLevel(levelText('i001'));
  const d = decompose(level);
  const room = d.rooms[0];
  const size = level.w * level.h;
  const walkable = new Uint8Array(size);
  for (const s of room.squares) walkable[s] = 1;
  for (let x = 0; x < level.w; x++) {
    const s = d.hallwayRow * level.w + x;
    if (level.wall[s] === 0) walkable[s] = 1;
  }
  const dist = allDistances(walkable, level.w);
  const h = assignmentHeuristic(room.boxes, room.goals, dist, size);
  assert.ok(h > 0 && h <= 13, `h=${h}`);
});

// --- push search and reconstruction ----------------------------------------

test('pushSearch: i001 room solves in exactly 13 pushes', () => {
  const level = parseLevel(levelText('i001'));
  const d = decompose(level);
  const room = d.rooms[0];
  const size = level.w * level.h;
  const walkable = new Uint8Array(size);
  for (const s of room.squares) walkable[s] = 1;
  for (let x = 0; x < level.w; x++) {
    const s = d.hallwayRow * level.w + x;
    if (level.wall[s] === 0) walkable[s] = 1;
  }
  const extraDead = new Uint8Array(size);
  for (let x = 0; x < level.w; x++) {
    const s = d.hallwayRow * level.w + x;
    if (level.wall[s] === 0) extraDead[s] = 1;
  }
  const res = pushSearch({
    w: level.w,
    h: level.h,
    wall: level.wall,
    walkable,
    boxes0: room.boxes,
    goals: room.goals,
    player0: 68,
    doors: room.doors,
    extraDead,
    budget: 300000,
    greedy: false,
  });
  assert.notEqual(res, null);
  assert.equal(res.pushes.length, 13);
  const conv = pushesToMoves(res.pushes, 68, room.boxes, walkable, level.w);
  assert.notEqual(conv, null);
  // The room moves start from the approach square (68), not the level's
  // player start (70), so replay them from that explicit state.
  const sim = simulateMoves(68, level.boxes, conv.moves, level.wall, level.w);
  assert.equal(sim.illegal, false);
  assert.equal(sim.pushes, 13);
  assert.ok(sim.boxes.every((b) => level.goals.includes(b)));
});

test('pushSearch: a room with a box already on a goal still solves', () => {
  // i003's upper room has a box on its door square; the search must cope.
  const level = parseLevel(levelText('i003'));
  const d = decompose(level);
  const room = d.rooms[0];
  assert.ok(room.boxes.includes(61), 'door square holds a box');
  const size = level.w * level.h;
  const walkable = new Uint8Array(size);
  for (const s of room.squares) walkable[s] = 1;
  for (let x = 0; x < level.w; x++) {
    const s = d.hallwayRow * level.w + x;
    if (level.wall[s] === 0) walkable[s] = 1;
  }
  const extraDead = new Uint8Array(size);
  for (let x = 0; x < level.w; x++) {
    const s = d.hallwayRow * level.w + x;
    if (level.wall[s] === 0) extraDead[s] = 1;
  }
  const res = pushSearch({
    w: level.w,
    h: level.h,
    wall: level.wall,
    walkable,
    boxes0: room.boxes,
    goals: room.goals,
    player0: 69,
    doors: room.doors,
    extraDead,
    budget: 300000,
    greedy: false,
  });
  assert.notEqual(res, null);
  assert.equal(res.pushes.length, 15);
});

// --- replay / simulation ---------------------------------------------------

test('replayMoves: flags an illegal step into a wall', () => {
  const level = parseLevel(levelText('i001'));
  const rep = replayMoves(level, 'uuuuuuuu');
  assert.equal(rep.illegal, true);
  assert.equal(rep.solved, false);
});

test('replayMoves: an unsolved end is not solved', () => {
  const level = parseLevel(levelText('i001'));
  const rep = replayMoves(level, 'l');
  assert.equal(rep.illegal, false);
  assert.equal(rep.solved, false);
  assert.equal(rep.pushes, 0);
});

test('simulateMoves: applies a move string from an explicit state', () => {
  const level = parseLevel(levelText('i001'));
  const sim = simulateMoves(level.player, level.boxes, 'l', level.wall, level.w);
  assert.equal(sim.illegal, false);
  assert.equal(sim.player, level.player - 1);
  assert.equal(sim.pushes, 0);
});

// --- whole-level solving ---------------------------------------------------

test('solveLevel: an already-solved level needs no moves', () => {
  const moves = solveLevel('#######\n#     #\n# * * #\n#     #\n#  @  #\n#######\n');
  assert.equal(moves, '');
});

test('solveLevel: every practice level replays solved at exactly P*', () => {
  const man = manifest();
  for (const inst of man.instances) {
    const level = parseLevel(levelText(inst.id));
    const moves = solveLevel(levelText(inst.id));
    const rep = replayMoves(level, moves);
    assert.equal(rep.illegal, false, `${inst.id}: illegal step`);
    assert.equal(rep.solved, true, `${inst.id}: not solved`);
    assert.equal(rep.pushes, inst.key.pushes, `${inst.id}: ${rep.pushes} != P* ${inst.key.pushes}`);
    assert.ok(moves.length <= 65536, `${inst.id}: solution too long`);
    assert.match(moves, /^[udlr]*$/, `${inst.id}: bad characters`);
  }
});

test('solveLevel: deterministic (same input, same output)', () => {
  const a = solveLevel(levelText('i005'));
  const b = solveLevel(levelText('i005'));
  assert.equal(a, b);
});

test('solveLevel: a one-box one-goal room solves in 2 pushes', () => {
  const moves = solveLevel('#######\n#     #\n# $ . #\n#  @  #\n#######\n');
  const level = parseLevel('#######\n#     #\n# $ . #\n#  @  #\n#######\n');
  const rep = replayMoves(level, moves);
  assert.equal(rep.illegal, false);
  assert.equal(rep.solved, true);
  assert.equal(rep.pushes, 2);
});

test('solveLevel: a box in the hallway row solves via the global fallback', () => {
  const moves = solveLevel('#######\n#     #\n#     #\n# $@. #\n#######\n');
  const level = parseLevel('#######\n#     #\n#     #\n# $@. #\n#######\n');
  const rep = replayMoves(level, moves);
  assert.equal(rep.illegal, false);
  assert.equal(rep.solved, true);
  assert.equal(rep.pushes, 2);
});

// --- integration: run main.ts as a subprocess on the practice set ----------

if (existsSync(join(KIT, 'practice', 'input'))) {
  test('integration: main.ts on the practice set, replayed at P*, twice identical', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'sok-test-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'sok-test-b-'));
    try {
      const env = {
        ...process.env,
        MAKEFUN_INPUT_DIR: join(KIT, 'practice', 'input'),
      };
      execFileSync('node', [join(ENTRY, 'main.ts')], {
        env: { ...env, MAKEFUN_OUTPUT_DIR: dirA },
        stdio: 'pipe',
      });
      execFileSync('node', [join(ENTRY, 'main.ts')], {
        env: { ...env, MAKEFUN_OUTPUT_DIR: dirB },
        stdio: 'pipe',
      });
      const man = manifest();
      for (const inst of man.instances) {
        const a = readFileSync(join(dirA, inst.id, 'solution.txt'), 'utf8');
        const b = readFileSync(join(dirB, inst.id, 'solution.txt'), 'utf8');
        assert.equal(a, b, `${inst.id}: two runs differ`);
        const level = parseLevel(levelText(inst.id));
        const rep = replayMoves(level, a);
        assert.equal(rep.illegal, false, `${inst.id}: illegal step`);
        assert.equal(rep.solved, true, `${inst.id}: not solved`);
        assert.equal(rep.pushes, inst.key.pushes, `${inst.id}: ${rep.pushes} != P* ${inst.key.pushes}`);
      }
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
} else {
  console.log('note  integration tests skipped: kit not found at ' + KIT);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('failed tests: ' + failures.join(', '));
  process.exit(1);
}
