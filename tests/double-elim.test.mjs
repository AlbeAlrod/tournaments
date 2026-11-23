// Double elimination (club tournaments): losers' bracket joins at crossed semifinals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../core/legacy.js';
import { buildDE } from '../core/de.js';

function run(n, pick = g => 'a') {
  const roster = Array.from({ length: n }, (_, i) => `P${i} / Q${i}`);
  const ctx = {
    categories: [{ id: 'c', cfg: { ...structuredClone(L.DEF_CAT_CFG), format: 'de' } }],
    state: { c: { roster, groups: [], sched: [], ko: [] } },
    meta: { coordinated: true, catOrder: 'parallel' }, registrations: [], secure: true,
  };
  const api = L.createLegacy(ctx);
  api.buildCoordinatedGroups(); api.generateCoordinatedSchedule();
  const cs = ctx.state.c;
  const games = [...cs.ko.flat(), ...cs.sched].sort((x, y) => x.si - y.si);
  const losses = {};
  for (const g of games) {               // play in schedule order: every game's pairs must be known by then
    api.updateKOForCat('c');
    assert.ok(roster.includes(g.a) && roster.includes(g.b), `${g.de?.code || '3P'} not resolved: ${g.a} / ${g.b}`);
    const aWins = pick(g) === 'a';
    Object.assign(g, aWins ? { sa: '21', sb: '15' } : { sa: '15', sb: '21' });
    const loser = aWins ? g.b : g.a;
    if (g.de && !/^SF|^Final/.test(g.de.code)) losses[loser] = (losses[loser] || 0) + 1;
  }
  return { cs, games, losses, roster };
}

for (const n of [4, 6, 8, 11, 16]) {
  test(`double elimination, ${n} pairs: every game resolvable in schedule order, out only after 2 losses`, () => {
    const { cs, games, losses, roster } = run(n);
    const slots = games.map(g => `${g.time}/${g.court}`);
    assert.equal(new Set(slots).size, slots.length, 'court collision');
    const sf = cs.ko[cs.ko.length - 2];
    const inSF = sf.flatMap(g => [g.a, g.b]);
    assert.equal(new Set(inSF).size, Math.min(4, inSF.length));
    for (const p of roster) if (!inSF.includes(p)) assert.equal(losses[p], 2, `${p} out with ${losses[p]} loss(es)`);
    for (const p of inSF) assert.ok((losses[p] || 0) <= 1, `${p} reached the semis with ${losses[p]} losses`);
  });
}

test('semifinals are crossed: upper-bracket winner meets the second of the lower bracket', () => {
  const r = buildDE(Array.from({ length: 8 }, (_, i) => 'p' + i), 'c');
  const sf = r[r.length - 2];
  assert.deepEqual(sf.map(g => [g.de.A.w[0], g.de.B.w[0]]), [[1, 3], [1, 3]]);
  assert.deepEqual(sf.map(g => g.de.B.w[1]), [1, 0]);
});

test('double elimination with mixed results (lower seeds winning) still resolves and stays fair', () => {
  let k = 0;
  const { cs, losses, roster } = run(12, () => (k++ % 3 ? 'a' : 'b'));
  const sf = cs.ko[cs.ko.length - 2];
  const inSF = sf.flatMap(g => [g.a, g.b]);
  for (const p of roster) if (!inSF.includes(p)) assert.equal(losses[p], 2);
});
