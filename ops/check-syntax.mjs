// Syntax-check every *.js file in the repo root and under core/ with `node --check`.
// Dev tool only (npm run check) — not part of the site.
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function jsFiles(dir, recursive) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (recursive && name !== 'node_modules') out.push(...jsFiles(p, true));
    } else if (/\.(m?js)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const files = [...jsFiles(root, false), ...jsFiles(join(root, 'core'), true)];
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${relative(root, f)}\n${r.stderr}`);
  }
}
console.log(`checked ${files.length} file(s), ${failed} failed`);
process.exit(failed ? 1 : 0);
