// ============================================================================
// Sokoban solver — push-optimal per room.
//
// Strategy (see PLAN.md): a level is a hallway plus 1-4 rooms, each room
// opening onto the hallway through a door. Boxes never leave their room in an
// optimal solution, so each room is an independent push-optimal sub-problem:
// push-based A* per room with an admissible min-assignment heuristic, dead
// square / corner / 2x2 deadlock pruning and a transposition table. Walking
// is free (only pushes count), so rooms are solved in a fixed order and the
// walks between them are plain BFS. Fixed expansion budgets only — no clock,
// no randomness — so two runs are byte-identical.
//
// Pure Node 22, standard library only, single file. The driver runs only
// when this file is the program's entrypoint, so the tests can import the
// solver functions without side effects.
// ============================================================================

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Directions: 0 = up, 1 = down, 2 = left, 3 = right.
const DX: number[] = [0, 0, -1, 1];
const DY: number[] = [-1, 1, 0, 0];
const CH: string[] = ['u', 'd', 'l', 'r'];

// Expansion budgets (fixed work, never the clock). Tier 1 is the normal
// push-optimal pass; tier 2 retries it with a much larger budget; tier 3 is
// a greedy push search that returns any solution; tier 4 is a greedy
// move-based search, the last resort before an empty answer.
const TIER1_BUDGET = 300_000;
const TIER2_BUDGET = 3_000_000;
const TIER3_BUDGET = 1_000_000;
const TIER4_BUDGET = 500_000;

// ---------------------------------------------------------------------------
// Level parsing. This matches the checker's parse exactly: split on '\n',
// drop empty rows, width = longest row, a missing char is a wall.
// ---------------------------------------------------------------------------

export interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

export function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// ---------------------------------------------------------------------------
// Room decomposition. The hallway is the player's start row. A room is a
// connected component of floor squares outside that row; its doors are the
// component squares adjacent to a hallway floor square. Returns null when
// the level does not fit this shape (a box in the hallway, or a room with
// no door) — the caller then falls back to a whole-level search.
// ---------------------------------------------------------------------------

export interface Room {
  squares: number[];
  doors: number[];
  boxes: number[];
  goals: number[];
}

export function decompose(level: Level): { rooms: Room[]; hallwayRow: number } | null {
  const { w, h, wall, boxes, goals, player } = level;
  const hallwayRow = Math.floor(player / w);
  for (const b of boxes) {
    if (Math.floor(b / w) === hallwayRow) return null;
  }
  const inHallway = (i: number): boolean => Math.floor(i / w) === hallwayRow;
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] === 1 || inHallway(s) || seen[s] === 1) continue;
    const comp: number[] = [];
    const stack: number[] = [s];
    seen[s] = 1;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      comp.push(c);
      const x = c % w;
      const y = Math.floor(c / w);
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (wall[n] === 1 || inHallway(n) || seen[n] === 1) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    const compSet = new Set(comp);
    const doors: number[] = [];
    for (const c of comp) {
      const x = c % w;
      const y = Math.floor(c / w);
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (ny !== hallwayRow || nx < 0 || nx >= w) continue;
        const n = ny * w + nx;
        if (wall[n] === 0) {
          doors.push(c);
          break;
        }
      }
    }
    if (doors.length === 0) return null;
    const rboxes = boxes.filter((b) => compSet.has(b));
    const rgoals = goals.filter((g) => compSet.has(g));
    doors.sort((a, b) => a - b);
    rooms.push({ squares: comp, doors, boxes: rboxes, goals: rgoals });
  }
  rooms.sort((a, b) => a.doors[0] - b.doors[0]);
  return { rooms, hallwayRow };
}

// ---------------------------------------------------------------------------
// BFS helpers over a walkable set (Uint8Array over board squares).
// ---------------------------------------------------------------------------

/** Squares reachable from `start` over walkable squares, avoiding blocked ones. */
export function flood(start: number, walkable: Uint8Array, blocked: Uint8Array, w: number): Uint8Array {
  const seen = new Uint8Array(walkable.length);
  if (walkable[start] === 0 || blocked[start] === 1) return seen;
  const stack: number[] = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const c = stack.pop() as number;
    const x = c % w;
    const y = Math.floor(c / w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0) continue;
      const n = ny * w + nx;
      if (n >= walkable.length || walkable[n] === 0 || blocked[n] === 1 || seen[n] === 1) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return seen;
}

/**
 * Shortest walk from `from` to `to` over walkable squares, avoiding blocked
 * ones. Returns the move string, '' when already there, null when unreachable.
 * Deterministic: directions are explored in u, d, l, r order.
 */
export function bfsPath(
  from: number,
  to: number,
  walkable: Uint8Array,
  blocked: Uint8Array,
  w: number,
): string | null {
  if (from === to) return '';
  const size = walkable.length;
  const prev = new Int32Array(size).fill(-1);
  const prevDir = new Int8Array(size).fill(-1);
  const q: number[] = [from];
  prev[from] = from;
  let head = 0;
  while (head < q.length) {
    const c = q[head] as number;
    head++;
    const x = c % w;
    const y = Math.floor(c / w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0) continue;
      const n = ny * w + nx;
      if (n >= size || walkable[n] === 0 || blocked[n] === 1 || prev[n] !== -1) continue;
      prev[n] = c;
      prevDir[n] = d;
      if (n === to) {
        let s = '';
        let cur = n;
        while (cur !== from) {
          s = CH[prevDir[cur] as number] + s;
          cur = prev[cur] as number;
        }
        return s;
      }
      q.push(n);
    }
  }
  return null;
}

/**
 * All-pairs shortest walk distances over the walkable set, ignoring boxes.
 * dist[a * size + b] is the distance from a to b, or -1 when unreachable.
 */
export function allDistances(walkable: Uint8Array, w: number): Int32Array {
  const size = walkable.length;
  const dist = new Int32Array(size * size).fill(-1);
  for (let s = 0; s < size; s++) {
    if (walkable[s] === 0) continue;
    const q: number[] = [s];
    dist[s * size + s] = 0;
    let head = 0;
    while (head < q.length) {
      const c = q[head] as number;
      head++;
      const d0 = dist[s * size + c];
      const x = c % w;
      const y = Math.floor(c / w);
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0) continue;
        const n = ny * w + nx;
        if (n >= size || walkable[n] === 0 || dist[s * size + n] !== -1) continue;
        dist[s * size + n] = d0 + 1;
        q.push(n);
      }
    }
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Heuristic: min-cost assignment of boxes to goals over the walk distances.
// Admissible — each box must be pushed at least its distance to its goal,
// and each push moves exactly one box one square. For more than 6 boxes the
// exact assignment is too big, so it falls back to the sum of each box's
// nearest-goal distance, which is still an admissible lower bound.
// ---------------------------------------------------------------------------

export function assignmentHeuristic(
  boxes: number[],
  goals: number[],
  dist: Int32Array,
  size: number,
): number {
  const n = boxes.length;
  const m = goals.length;
  if (n === 0) return 0;
  if (n > m) return Infinity;
  if (n > 6) {
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (const g of goals) {
        const d = dist[b * size + g];
        if (d >= 0 && d < best) best = d;
      }
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  }
  let best = Infinity;
  const used = new Uint8Array(m);
  const rec = (i: number, cost: number): void => {
    if (cost >= best) return;
    if (i === n) {
      best = cost;
      return;
    }
    const b = boxes[i] as number;
    for (let j = 0; j < m; j++) {
      if (used[j] === 1) continue;
      const d = dist[b * size + (goals[j] as number)];
      if (d < 0) continue;
      used[j] = 1;
      rec(i + 1, cost + d);
      used[j] = 0;
    }
  };
  rec(0, 0);
  return best;
}

// ---------------------------------------------------------------------------
// Deadlock tests. A box is dead when it can never reach a goal: it sits on
// a square from which no goal is reachable (canReachGoal), on a square the
// caller marks dead (extraDead — the hallway, from which a box can never be
// pushed back), in a corner (walls on two perpendicular sides), or inside a
// 2x2 block of boxes/walls holding no goal. A box on a goal is never dead.
// ---------------------------------------------------------------------------

export function isDeadState(
  boxes: number[],
  wall: Uint8Array,
  w: number,
  h: number,
  goalSet: Uint8Array,
  canReachGoal: Uint8Array,
  extraDead: Uint8Array,
): boolean {
  for (const b of boxes) {
    if (goalSet[b] === 1) continue;
    if (canReachGoal[b] === 0 || extraDead[b] === 1) return true;
    const x = b % w;
    const y = Math.floor(b / w);
    const up = y === 0 || wall[b - w] === 1;
    const down = y === h - 1 || wall[b + w] === 1;
    const left = x === 0 || wall[b - 1] === 1;
    const right = x === w - 1 || wall[b + 1] === 1;
    if ((up && left) || (up && right) || (down && left) || (down && right)) return true;
    const filled = (s: number): boolean => wall[s] === 1 || boxes.includes(s);
    for (const [ox, oy] of [
      [-1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ] as const) {
      const bx = x + ox;
      const by = y + oy;
      if (bx < 0 || by < 0 || bx + 1 >= w || by + 1 >= h) continue;
      const s0 = by * w + bx;
      const s1 = s0 + 1;
      const s2 = s0 + w;
      const s3 = s0 + w + 1;
      if (goalSet[s0] === 1 || goalSet[s1] === 1 || goalSet[s2] === 1 || goalSet[s3] === 1) continue;
      if (filled(s0) && filled(s1) && filled(s2) && filled(s3)) return true;
    }
  }
  return false;
}

/** Squares from which a goal is reachable over the walkable set, ignoring boxes. */
export function reachableToGoal(goals: number[], walkable: Uint8Array, w: number, h: number): Uint8Array {
  const size = w * h;
  const can = new Uint8Array(size);
  const stack: number[] = [];
  for (const g of goals) {
    if (walkable[g] === 1 && can[g] === 0) {
      can[g] = 1;
      stack.push(g);
    }
  }
  while (stack.length > 0) {
    const c = stack.pop() as number;
    const x = c % w;
    const y = Math.floor(c / w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (walkable[n] === 0 || can[n] === 1) continue;
      can[n] = 1;
      stack.push(n);
    }
  }
  return can;
}

/** A Uint8Array with 1 at every box position. */
export function blockedOf(boxes: number[], size: number): Uint8Array {
  const blocked = new Uint8Array(size);
  for (const b of boxes) blocked[b] = 1;
  return blocked;
}

// ---------------------------------------------------------------------------
// Push-based search. A state is the sorted box positions plus the player's
// square; actions are PUSHES only (a push is legal when the player can walk
// to the square behind the box and the square beyond is free floor). The
// transposition table keys on (boxes, player); the heap orders by (f, deeper
// first, insertion order), so two runs expand in exactly the same order.
// The goal is every box on a goal, and — when doors are given — the player
// able to walk back to a door square (to leave the room). Returns the push
// sequence, or null when the budget runs out.
// ---------------------------------------------------------------------------

export interface PushStep {
  box: number;
  dir: number;
}

export interface SearchOpts {
  w: number;
  h: number;
  wall: Uint8Array;
  walkable: Uint8Array;
  boxes0: number[];
  goals: number[];
  player0: number;
  doors: number[];
  extraDead: Uint8Array;
  budget: number;
  greedy: boolean;
}

export interface SearchResult {
  pushes: PushStep[];
  expansions: number;
  generated: number;
}

export function pushSearch(o: SearchOpts): SearchResult | null {
  const size = o.w * o.h;
  const goalSet = new Uint8Array(size);
  for (const g of o.goals) goalSet[g] = 1;
  const canReachGoal = reachableToGoal(o.goals, o.walkable, o.w, o.h);
  const dist = allDistances(o.walkable, o.w);
  const heuristic = (boxes: number[]): number => assignmentHeuristic(boxes, o.goals, dist, size);

  const sorted0 = [...o.boxes0].sort((a, b) => a - b);
  const h0 = heuristic(sorted0);
  if (h0 === Infinity) return null;
  if (isDeadState(sorted0, o.wall, o.w, o.h, goalSet, canReachGoal, o.extraDead)) return null;

  const boxesArr: number[][] = [sorted0];
  const playerArr: number[] = [o.player0];
  const gArr: number[] = [0];
  const parentArr: number[] = [-1];
  const pushBoxArr: number[] = [-1];
  const pushDirArr: number[] = [-1];
  const fArr: number[] = [o.greedy ? h0 : h0];
  const keyArr: string[] = [];
  const keyOf = (boxes: number[], player: number): string => boxes.join(',') + '|' + player;
  keyArr.push(keyOf(sorted0, o.player0));

  const heap: number[] = [0];
  const less = (a: number, b: number): boolean => {
    if (fArr[a] !== fArr[b]) return (fArr[a] as number) < (fArr[b] as number);
    if (gArr[a] !== gArr[b]) return (gArr[a] as number) > (gArr[b] as number);
    return a < b;
  };
  const heapPush = (id: number): void => {
    let i = heap.length;
    heap.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i] as number, heap[p] as number)) break;
      const t = heap[i] as number;
      heap[i] = heap[p] as number;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0] as number;
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1] as number, heap[c] as number)) c++;
        if (!less(heap[c] as number, heap[i] as number)) break;
        const t = heap[i] as number;
        heap[i] = heap[c] as number;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  const closed = new Map<string, number>();
  closed.set(keyArr[0] as string, 0);
  const blocked = new Uint8Array(size);
  let expansions = 0;
  let generated = 1;

  const reconstruct = (s: number): PushStep[] => {
    const seq: PushStep[] = [];
    for (let t = s; t > 0; t = parentArr[t] as number) {
      seq.push({ box: pushBoxArr[t] as number, dir: pushDirArr[t] as number });
    }
    seq.reverse();
    return seq;
  };

  while (heap.length > 0) {
    const s = heapPop();
    if (closed.get(keyArr[s] as string) !== s) continue;
    const boxes = boxesArr[s] as number[];
    const player = playerArr[s] as number;
    if (boxes.every((b) => goalSet[b] === 1)) {
      if (o.doors.length === 0) return { pushes: reconstruct(s), expansions, generated };
      for (const b of boxes) blocked[b] = 1;
      const reach = flood(player, o.walkable, blocked, o.w);
      for (const b of boxes) blocked[b] = 0;
      if (o.doors.some((d) => reach[d] === 1)) return { pushes: reconstruct(s), expansions, generated };
    }
    if (expansions >= o.budget) return null;
    expansions++;
    for (const b of boxes) blocked[b] = 1;
    const reach = flood(player, o.walkable, blocked, o.w);
    for (const b of boxes) blocked[b] = 0;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi] as number;
      const bx = b % o.w;
      const by = Math.floor(b / o.w);
      for (let d = 0; d < 4; d++) {
        const hx = bx - (DX[d] as number);
        const hy = by - (DY[d] as number);
        const tx = bx + (DX[d] as number);
        const ty = by + (DY[d] as number);
        if (hx < 0 || hy < 0 || hx >= o.w || hy >= o.h) continue;
        if (tx < 0 || ty < 0 || tx >= o.w || ty >= o.h) continue;
        const behind = hy * o.w + hx;
        const beyond = ty * o.w + tx;
        if (reach[behind] === 0) continue;
        if (o.walkable[beyond] === 0 || o.wall[beyond] === 1) continue;
        if (boxes.includes(beyond)) continue;
        const nb = boxes.slice();
        nb[bi] = beyond;
        nb.sort((a, b2) => a - b2);
        if (isDeadState(nb, o.wall, o.w, o.h, goalSet, canReachGoal, o.extraDead)) continue;
        const hh = heuristic(nb);
        if (hh === Infinity) continue;
        const g2 = (gArr[s] as number) + 1;
        const key = keyOf(nb, b);
        const prev = closed.get(key);
        if (prev !== undefined && (gArr[prev] as number) <= g2) continue;
        const id = boxesArr.length;
        boxesArr.push(nb);
        playerArr.push(b);
        gArr.push(g2);
        parentArr.push(s);
        pushBoxArr.push(b);
        pushDirArr.push(d);
        fArr.push(o.greedy ? hh : g2 + hh);
        keyArr.push(key);
        closed.set(key, id);
        heapPush(id);
        generated++;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Move-based greedy search (last-resort tier). States are (player, boxes),
// actions are single steps; the priority is the push heuristic alone, so it
// dives for any solution instead of proving optimality. Returns the move
// string, or null when the budget runs out.
// ---------------------------------------------------------------------------

export interface MoveSearchOpts {
  w: number;
  h: number;
  wall: Uint8Array;
  walkable: Uint8Array;
  boxes0: number[];
  goals: number[];
  player0: number;
  doors: number[];
  extraDead: Uint8Array;
  budget: number;
}

export function moveSearch(o: MoveSearchOpts): string | null {
  const size = o.w * o.h;
  const goalSet = new Uint8Array(size);
  for (const g of o.goals) goalSet[g] = 1;
  const canReachGoal = reachableToGoal(o.goals, o.walkable, o.w, o.h);
  const dist = allDistances(o.walkable, o.w);
  const heuristic = (boxes: number[]): number => assignmentHeuristic(boxes, o.goals, dist, size);

  const sorted0 = [...o.boxes0].sort((a, b) => a - b);
  if (heuristic(sorted0) === Infinity) return null;
  if (isDeadState(sorted0, o.wall, o.w, o.h, goalSet, canReachGoal, o.extraDead)) return null;

  const boxesArr: number[][] = [sorted0];
  const playerArr: number[] = [o.player0];
  const parentArr: number[] = [-1];
  const stepArr: string[] = [''];
  const hArr: number[] = [heuristic(sorted0)];
  const keyArr: string[] = [];
  const keyOf = (boxes: number[], player: number): string => boxes.join(',') + '|' + player;
  keyArr.push(keyOf(sorted0, o.player0));

  const heap: number[] = [0];
  const less = (a: number, b: number): boolean => {
    if (hArr[a] !== hArr[b]) return (hArr[a] as number) < (hArr[b] as number);
    return a < b;
  };
  const heapPush = (id: number): void => {
    let i = heap.length;
    heap.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i] as number, heap[p] as number)) break;
      const t = heap[i] as number;
      heap[i] = heap[p] as number;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0] as number;
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1] as number, heap[c] as number)) c++;
        if (!less(heap[c] as number, heap[i] as number)) break;
        const t = heap[i] as number;
        heap[i] = heap[c] as number;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  const closed = new Set<string>([keyArr[0] as string]);
  let expansions = 0;
  while (heap.length > 0) {
    const s = heapPop();
    const boxes = boxesArr[s] as number[];
    const player = playerArr[s] as number;
    if (boxes.every((b) => goalSet[b] === 1)) {
      if (o.doors.length === 0) {
        let moves = '';
        for (let t = s; t > 0; t = parentArr[t] as number) moves = (stepArr[t] as string) + moves;
        return moves;
      }
      const blocked = blockedOf(boxes, size);
      const reach = flood(player, o.walkable, blocked, o.w);
      if (o.doors.some((d) => reach[d] === 1)) {
        let moves = '';
        for (let t = s; t > 0; t = parentArr[t] as number) moves = (stepArr[t] as string) + moves;
        return moves;
      }
    }
    if (expansions >= o.budget) return null;
    expansions++;
    const px = player % o.w;
    const py = Math.floor(player / o.w);
    for (let d = 0; d < 4; d++) {
      const nx = px + (DX[d] as number);
      const ny = py + (DY[d] as number);
      if (nx < 0 || ny < 0 || nx >= o.w || ny >= o.h) continue;
      const q = ny * o.w + nx;
      if (o.walkable[q] === 0 || o.wall[q] === 1) continue;
      let nb = boxes;
      const at = boxes.indexOf(q);
      if (at >= 0) {
        const tx = nx + (DX[d] as number);
        const ty = ny + (DY[d] as number);
        if (tx < 0 || ty < 0 || tx >= o.w || ty >= o.h) continue;
        const beyond = ty * o.w + tx;
        if (o.walkable[beyond] === 0 || o.wall[beyond] === 1) continue;
        if (boxes.includes(beyond)) continue;
        nb = boxes.slice();
        nb[at] = beyond;
        nb.sort((a, b2) => a - b2);
        if (isDeadState(nb, o.wall, o.w, o.h, goalSet, canReachGoal, o.extraDead)) continue;
      }
      const key = keyOf(nb, q);
      if (closed.has(key)) continue;
      const hh = heuristic(nb);
      if (hh === Infinity) continue;
      const id = boxesArr.length;
      boxesArr.push(nb);
      playerArr.push(q);
      parentArr.push(s);
      stepArr.push(CH[d] as string);
      hArr.push(hh);
      keyArr.push(key);
      closed.add(key);
      heapPush(id);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turning a push sequence into the player's moves: walk (BFS) to the square
// behind each box, then step into the box. Returns the moves plus the final
// player square and box positions, or null when a walk fails (never in a
// correct search — the pushes were generated from reachable squares).
// ---------------------------------------------------------------------------

export interface PushesToMoves {
  moves: string;
  player: number;
  boxes: number[];
}

export function pushesToMoves(
  pushes: PushStep[],
  player0: number,
  boxes0: number[],
  walkable: Uint8Array,
  w: number,
): PushesToMoves | null {
  const size = walkable.length;
  let player = player0;
  let boxes = [...boxes0].sort((a, b) => a - b);
  let moves = '';
  for (const p of pushes) {
    const behind = p.box - (DY[p.dir] as number) * w - (DX[p.dir] as number);
    const walk = bfsPath(player, behind, walkable, blockedOf(boxes, size), w);
    if (walk === null) return null;
    moves += walk;
    moves += CH[p.dir] as string;
    const beyond = p.box + (DY[p.dir] as number) * w + (DX[p.dir] as number);
    const nb = boxes.slice();
    const at = nb.indexOf(p.box);
    nb[at] = beyond;
    nb.sort((a, b) => a - b);
    boxes = nb;
    player = p.box;
  }
  return { moves, player, boxes };
}

/**
 * Replay a move string on a level: the same rules as the checker. Returns
 * the final player and boxes, whether every box ends on a goal, how many
 * pushes the replay made, and whether any step was illegal.
 */
export function replayMoves(
  level: Level,
  moves: string,
): { player: number; boxes: number[]; solved: boolean; pushes: number; illegal: boolean } {
  // The checker ignores whitespace, so this does too.
  const clean = moves.replace(/\s+/g, '');
  const boxes = [...level.boxes].sort((a, b) => a - b);
  let player = level.player;
  let pushes = 0;
  let illegal = false;
  const goalSet = new Set(level.goals);
  for (const ch of clean) {
    const d = CH.indexOf(ch.toLowerCase());
    if (d < 0) {
      illegal = true;
      break;
    }
    const next = player + (DY[d] as number) * level.w + (DX[d] as number);
    if (level.wall[next] === 1) {
      illegal = true;
      break;
    }
    const at = boxes.indexOf(next);
    if (at >= 0) {
      const beyond = next + (DY[d] as number) * level.w + (DX[d] as number);
      if (level.wall[beyond] === 1 || boxes.includes(beyond)) {
        illegal = true;
        break;
      }
      boxes[at] = beyond;
      boxes.sort((a, b) => a - b);
      pushes++;
    }
    player = next;
  }
  return { player, boxes, solved: !illegal && boxes.every((b) => goalSet.has(b)), pushes, illegal };
}

// ---------------------------------------------------------------------------
// Simulating a move string from an explicit start state (used by the
// move-search tier and by the tests).
// ---------------------------------------------------------------------------

export interface SimResult {
  player: number;
  boxes: number[];
  pushes: number;
  illegal: boolean;
}

export function simulateMoves(
  player0: number,
  boxes0: number[],
  moves: string,
  wall: Uint8Array,
  w: number,
): SimResult {
  const boxes = [...boxes0].sort((a, b) => a - b);
  let player = player0;
  let pushes = 0;
  let illegal = false;
  for (const ch of moves) {
    const d = CH.indexOf(ch.toLowerCase());
    if (d < 0) {
      illegal = true;
      break;
    }
    const next = player + (DY[d] as number) * w + (DX[d] as number);
    if (wall[next] === 1) {
      illegal = true;
      break;
    }
    const at = boxes.indexOf(next);
    if (at >= 0) {
      const beyond = next + (DY[d] as number) * w + (DX[d] as number);
      if (wall[beyond] === 1 || boxes.includes(beyond)) {
        illegal = true;
        break;
      }
      boxes[at] = beyond;
      boxes.sort((a, b) => a - b);
      pushes++;
    }
    player = next;
  }
  return { player, boxes, pushes, illegal };
}

// ---------------------------------------------------------------------------
// Per-room tier chain: push-optimal A*, then a larger-budget retry, then a
// greedy push search. Returns the push sequence or null.
// ---------------------------------------------------------------------------

function solveRoomTiers(opts: Omit<SearchOpts, 'budget' | 'greedy'>): SearchResult | null {
  const r1 = pushSearch({ ...opts, budget: TIER1_BUDGET, greedy: false });
  if (r1 !== null) return r1;
  const r2 = pushSearch({ ...opts, budget: TIER2_BUDGET, greedy: false });
  if (r2 !== null) return r2;
  return pushSearch({ ...opts, budget: TIER3_BUDGET, greedy: true });
}

// ---------------------------------------------------------------------------
// Whole-level fallback for levels that do not decompose (a box in the
// hallway, a room with no door). Same tier chain over the whole board, then
// the move search, then an empty answer.
// ---------------------------------------------------------------------------

function solveGlobal(level: Level): string {
  const size = level.w * level.h;
  const walkable = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (level.wall[i] === 0) walkable[i] = 1;
  const zero = new Uint8Array(size);
  const base = {
    w: level.w,
    h: level.h,
    wall: level.wall,
    walkable,
    boxes0: level.boxes,
    goals: level.goals,
    player0: level.player,
    doors: [] as number[],
    extraDead: zero,
  };
  const r = solveRoomTiers(base);
  if (r !== null) {
    const conv = pushesToMoves(r.pushes, level.player, level.boxes, walkable, level.w);
    if (conv !== null) return conv.moves;
  }
  const mv = moveSearch({ ...base, budget: TIER4_BUDGET });
  return mv ?? '';
}

// ---------------------------------------------------------------------------
// Solve one level: decompose into rooms, solve each room push-optimally in
// a fixed order, concatenate the walks and pushes. A room whose boxes are
// already on goals needs no work. The last room needs no exit (the level
// ends as soon as every box is on a goal); every earlier room must leave
// the player able to walk back to a door. Returns '' when the level cannot
// be solved (a valid, empty answer — 0 points, but answered).
// ---------------------------------------------------------------------------

export function solveLevel(text: string): string {
  const level = parseLevel(text);
  const dec = decompose(level);
  if (dec === null) return solveGlobal(level);
  const { rooms, hallwayRow } = dec;
  const size = level.w * level.h;
  const goalSet = new Set(level.goals);
  for (const r of rooms) {
    if (r.boxes.length > r.goals.length) return '';
  }
  const boardWalk = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (level.wall[i] === 0) boardWalk[i] = 1;
  let moves = '';
  let player = level.player;
  let boxes = [...level.boxes].sort((a, b) => a - b);
  const liveRooms = rooms.filter((r) => r.boxes.length > 0);
  for (let ri = 0; ri < liveRooms.length; ri++) {
    const room = liveRooms[ri] as Room;
    const isLast = ri === liveRooms.length - 1;
    if (room.boxes.every((b) => goalSet.has(b))) continue;
    const walkable = new Uint8Array(size);
    for (const s of room.squares) walkable[s] = 1;
    for (let x = 0; x < level.w; x++) {
      const s = hallwayRow * level.w + x;
      if (level.wall[s] === 0) walkable[s] = 1;
    }
    const extraDead = new Uint8Array(size);
    for (let x = 0; x < level.w; x++) {
      const s = hallwayRow * level.w + x;
      if (level.wall[s] === 0) extraDead[s] = 1;
    }
    const roomBoxesNow = boxes.filter((b) => room.squares.includes(b));
    // Find a door the player can actually reach from where they stand.
    // The hallway is one connected row, so the reachable region — and with
    // it the push search — is the same from any approach square; only the
    // walk to the first push differs, and the reconstruction starts from
    // the player's real position.
    let player0 = -1;
    for (const door of room.doors) {
      const dx = door % level.w;
      const dy = Math.floor(door / level.w);
      for (let d = 0; d < 4; d++) {
        const nx = dx + (DX[d] as number);
        const ny = dy + (DY[d] as number);
        if (ny !== hallwayRow || nx < 0 || nx >= level.w) continue;
        const n = ny * level.w + nx;
        if (level.wall[n] !== 0) continue;
        const reach = flood(player, boardWalk, blockedOf(boxes, size), level.w);
        if (reach[n] === 1) {
          player0 = n;
          break;
        }
      }
      if (player0 >= 0) break;
    }
    if (player0 < 0) return '';
    const base = {
      w: level.w,
      h: level.h,
      wall: level.wall,
      walkable,
      boxes0: roomBoxesNow,
      goals: room.goals,
      player0,
      doors: isLast ? ([] as number[]) : room.doors,
      extraDead,
    };
    const res = solveRoomTiers(base);
    if (res !== null) {
      // Walk into the room first: the player may be standing inside the
      // previous room, which is outside this room's walkable set, so the
      // entry walk runs over the whole board. Inside the room, every walk
      // stays in the room's walkable set (the pushes were generated from
      // the approach square, so the first behind-square is reachable from it).
      const walkIn = bfsPath(player, player0, boardWalk, blockedOf(boxes, size), level.w);
      if (walkIn === null) return '';
      const conv = pushesToMoves(res.pushes, player0, roomBoxesNow, walkable, level.w);
      if (conv === null) return '';
      moves += walkIn + conv.moves;
      player = conv.player;
      const roomBoxSet = new Set(roomBoxesNow);
      boxes = boxes.filter((b) => !roomBoxSet.has(b)).concat(conv.boxes).sort((a, b) => a - b);
      continue;
    }
    // Tier 4: greedy move search for this room, starting at the door.
    const mv = moveSearch({ ...base, budget: TIER4_BUDGET });
    if (mv === null) return '';
    const walkIn = bfsPath(player, player0, boardWalk, blockedOf(boxes, size), level.w);
    if (walkIn === null) return '';
    const sim = simulateMoves(player, boxes, walkIn + mv, level.wall, level.w);
    if (sim.illegal) return '';
    moves += walkIn + mv;
    player = sim.player;
    boxes = sim.boxes;
  }
  return moves;
}

// ---------------------------------------------------------------------------
// Driver: one run answers every instance under the input directory.
// ---------------------------------------------------------------------------

function run(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  let ids: string[];
  try {
    ids = readdirSync(inputDir).sort();
  } catch {
    return;
  }
  for (const id of ids) {
    let moves = '';
    try {
      const text = readFileSync(join(inputDir, id, 'level.txt'), 'utf8');
      moves = solveLevel(text);
    } catch {
      moves = '';
    }
    try {
      mkdirSync(join(outputDir, id), { recursive: true });
      writeFileSync(join(outputDir, id, 'solution.txt'), moves + '\n');
    } catch {
      // Nothing more can be done for this instance; the others still run.
    }
  }
}

// Run the driver only when this file is the program's entrypoint, so the
// tests can import the solver without side effects.
if (process.argv[1] !== undefined && process.argv[1].endsWith('main.ts')) {
  run();
}
