// Generated-set test: draws fresh sets with the kit generator (fixed seeds),
// runs main.ts on each, scores with the kit scorer, and reports how many
// instances hit P* exactly. Run: node test/gen-test.mjs [count] [firstSeed]
// The kit directory is taken from KIT_DIR, or the path this entry was built
// against. Exits 1 when any instance misses P*.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KIT =
  process.env.KIT_DIR ??
  '/home/hatch/workspace/makefun/sokoban-solver-01-run-20261121/sokoban-solver-01-run-20261121-kit';
const ENTRY = new URL('..', import.meta.url).pathname;
const COUNT = Number(process.argv[2] ?? 3);
const FIRST = Number(process.argv[3] ?? 1);

const seedOf = (n) => createHash('sha256').update(`sokoban-gen-test-${n}`).digest('hex');

let total = 0;
let hits = 0;
let worstMs = 0;
for (let n = FIRST; n < FIRST + COUNT; n++) {
  const base = join(tmpdir(), `sok-gen-test-${n}-${process.pid}`);
  const seedDir = join(base, 'seed');
  const drawnDir = join(base, 'drawn');
  const outDir = join(base, 'out');
  const scoresDir = join(base, 'scores');
  mkdirSync(seedDir, { recursive: true });
  mkdirSync(drawnDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(scoresDir, { recursive: true });
  try {
    writeFileSync(
      join(seedDir, 'seed.json'),
      JSON.stringify({ schema: 'agent-fun/instance-seed/v1', seed: seedOf(n) }),
    );
    execFileSync('node', [join(KIT, 'program', 'generator', 'draw.ts')], {
      env: { ...process.env, MAKEFUN_INPUT_DIR: seedDir, MAKEFUN_OUTPUT_DIR: drawnDir },
      stdio: 'pipe',
    });
    const t0 = Date.now();
    execFileSync('node', [join(ENTRY, 'main.ts')], {
      env: { ...process.env, MAKEFUN_INPUT_DIR: join(drawnDir, 'input'), MAKEFUN_OUTPUT_DIR: outDir },
      stdio: 'pipe',
    });
    const ms = Date.now() - t0;
    worstMs = Math.max(worstMs, ms);
    execFileSync('node', [join(KIT, 'program', 'scorer', 'score.ts')], {
      env: {
        ...process.env,
        MAKEFUN_OUTPUT_DIR: outDir,
        MAKEFUN_REFERENCE_DIR: join(drawnDir, 'reference'),
        MAKEFUN_SCORES_DIR: scoresDir,
      },
      stdio: 'pipe',
    });
    const man = JSON.parse(readFileSync(join(drawnDir, 'reference', 'manifest.json'), 'utf8'));
    const checks = JSON.parse(readFileSync(join(scoresDir, 'checks.json'), 'utf8'));
    const score = JSON.parse(readFileSync(join(scoresDir, 'scores.json'), 'utf8')).score;
    console.log(`set ${n}: score ${score} in ${ms}ms`);
    for (let k = 0; k < man.instances.length; k++) {
      total++;
      const inst = man.instances[k];
      const detail = checks[k].detail;
      const ok = detail === `solved in ${inst.key.pushes} pushes (P* ${inst.key.pushes})`;
      if (ok) hits++;
      console.log(`  ${inst.id} P*=${inst.key.pushes} rooms=[${inst.key.rooms}] -> ${detail}${ok ? '' : '  <-- MISS'}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
console.log(`\nP* hits: ${hits}/${total} instances, worst set time ${worstMs}ms`);
if (hits !== total) process.exit(1);
if (!existsSync(join(KIT, 'program', 'generator', 'draw.ts'))) {
  console.log('kit not found at ' + KIT);
  process.exit(1);
}
