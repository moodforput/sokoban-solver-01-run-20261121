# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/moodforput/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/moodforput/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver. One run answers all 5 instances of a set in
exactly P* pushes — the practice set scores 1,000,000, and so do 9 freshly
drawn sets (45/45 instances at P*).

Entered in the [make.fun bounty "Build the best Sokoban solver, 21 November 2026"](https://make.fun/bounty/sokoban-solver-01-run-20261121).

## How it works

A level is a hallway plus 1–4 rooms off it, each room opening onto the
hallway through a door. A box pushed into the hallway can never be pushed
back, so every box stays in its room — and a level's push-optimal count P*
is the sum of its rooms' optima. The solver exploits that:

- **Decomposition.** The hallway is the player's start row; each room is a
  connected component of floor outside that row, with its door squares, boxes
  and goals. Rooms are solved in a fixed order; walking between them is free
  (only pushes count).
- **Per-room push-optimal A\*.** States are (sorted boxes, player); actions
  are pushes only, with a flood fill for where the player can walk. The
  heuristic is the min-cost assignment of boxes to goals over walk distances
  (admissible, so A* returns push-optimal). Dead-square, corner and 2×2
  deadlock pruning, plus a transposition table, keep the search small. The
  goal test also requires the player to be able to walk back to a door, so
  the next room stays reachable (except for the last room, where the level
  simply ends).
- **Fallbacks.** A larger-budget retry, then a greedy push search, then a
  greedy move search; a level that does not decompose at all is solved
  whole. An instance is never left unanswered.
- **Determinism.** Fixed expansion budgets only — no clock, no randomness —
  so two runs write byte-identical outputs.

## Run it

Node 22 or later, no dependencies, no build step:

```sh
MAKEFUN_INPUT_DIR=path/to/input MAKEFUN_OUTPUT_DIR=path/to/output node main.ts
```

It reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) for each instance
and writes `/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`) — the
player's moves in `u d l r`, one line. A full set solves in under a second
on one CPU, far inside the 60 s wall.

## Test it

```sh
node test/run-tests.mjs
```

22 tests: parsing (ragged rows, `*`, `+`), room decomposition, deadlock
detection, heuristic admissibility, push search and move reconstruction with
replay, whole-level solving at exactly P* on the practice set, determinism,
and the global fallback. The generated-set check draws fresh sets with the
kit generator and verifies every instance hits P*:

```sh
node test/gen-test.mjs [count] [firstSeed]
```

## Layout

- `main.ts` — the whole solver (single file, standard library only)
- `test/run-tests.mjs` — unit + practice-set integration tests
- `test/gen-test.mjs` — fresh-set generalization check
- `LICENSE` — MIT
- `.makefun/owner.json` — payout wallet claim file
