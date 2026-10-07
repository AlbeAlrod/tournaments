// Drift guard: every function in core/legacy.js must stay token-identical to its
// app.js original (ignoring comments, whitespace, `export`, and the single injected
// `const { ... } = ctx;` line). If Lane D changes app.js logic, this fails on purpose:
// update core/legacy.js (and flip the matching KNOWN BUG test) in the same wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as L from '../core/legacy.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appPath = path.join(root, 'app.js');
const hasApp = fs.existsSync(appPath);
const appSrc = hasApp ? fs.readFileSync(appPath, 'utf8') : '';

// Extract `function name(...) {...}` from source by brace matching (skips strings/templates/comments roughly).
function extractFn(src, name) {
  const re = new RegExp(`(^|\\n)\\s*(export\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index + m[0].length - 1);
  // skip param list: find the '{' after the matching ')'
  let p = m.index + m[0].length, depth = 1;
  while (depth && p < src.length) { const c = src[p++]; if (c === '(') depth++; else if (c === ')') depth--; }
  i = src.indexOf('{', p);
  depth = 0; let j = i, q = null;
  for (; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, j + 1);
}
// Remove `// ...` comments outside string/template literals.
function stripComments(s) {
  let out = '', q = null;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (q) { out += c; if (c === '\\') { out += s[++j]; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; out += c; continue; }
    if (c === '/' && s[j + 1] === '/') { const nl = s.indexOf('\n', j); j = nl < 0 ? s.length : nl - 1; continue; }
    out += c;
  }
  return out;
}
const norm = s => stripComments(s)
  .replace(/^\s*const\s*\{[^}]*\}\s*=\s*ctx;\s*$/m, '')
  .replace(/\bexport\s+/g, '')
  .replace(/\s+/g, '');

const legacySrc = fs.readFileSync(path.join(root, 'core', 'legacy.js'), 'utf8');
const NAMES = ['koToFB','koFromFB','catStateToFB','catStateFromFB','t2m','m2t','addM','rr',
  'distributeGroups','snakeDistribute','cmpScore','roundName','getRuleForGame','coordCfg',
  'buildCoordinatedGroups','generateCoordinatedSchedule','getKORoundName','assignSlotTimes',
  'genPoolSched','generateScheduleForCat','buildQueenKO','isValidScore','scoreError',
  'getStandings','resolvePoolSeed','getKOLoser','getKOWinner','updateKOForCat','koGameLabel'];

test('legacy.js functions are token-identical to app.js', { skip: !hasApp && 'app.js not present' }, () => {
  for (const n of NAMES) {
    const a = extractFn(appSrc, n), b = extractFn(legacySrc, n);
    assert.ok(a, `app.js: ${n} not found`);
    assert.ok(b, `legacy.js: ${n} not found`);
    assert.equal(norm(b), norm(a), `drift in ${n}`);
  }
});

test('legacy constants match app.js', { skip: !hasApp && 'app.js not present' }, () => {
  const grab = name => {
    const m = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`).exec(appSrc);
    return m && Function(`return (${m[1]})`)();
  };
  assert.deepEqual(L.DEF_KO_RULES, grab('DEF_KO_RULES'));
  assert.deepEqual(L.DEF_CAT_CFG, grab('DEF_CAT_CFG'));
  const nn = /const normName = (.*);\n/.exec(appSrc)[1];
  assert.equal(norm(L.normName.toString()), norm(nn));
  const dnSrc = /const dn = (s => \{[\s\S]*?\n\});/.exec(appSrc)[1];
  assert.equal(norm(L.dn.toString()), norm(dnSrc));
});
