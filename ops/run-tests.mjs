// Run every tests/**/*.test.mjs with the built-in `node --test` runner.
// Exits 0 when there are no test files yet. Dev tool only (npm test).
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = fileURLToPath(new URL('../tests', import.meta.url));

function find(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...find(p));
    else if (name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}

const files = find(testsDir).sort();
if (!files.length) {
  console.log('no tests/**/*.test.mjs files found — nothing to run');
  process.exit(0);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
