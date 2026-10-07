// Entry point so `node --test tests/` works on Node 22+, which resolves a directory
// argument as a module (tests/index.js) instead of expanding it. Loads every
// *.test.mjs in this folder. `node --test tests/*.test.mjs` runs the same tests.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.mjs')).sort();
  for (const f of files) await import(pathToFileURL(path.join(__dirname, f)).href);
})();
