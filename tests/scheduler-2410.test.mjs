// S9: coordinated scheduler under the 24.10 config (DEF_CAT_CFG), two parallel categories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../core/legacy.js';

function build(n1, n2, extra = {}) {
  const roster = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i} / ${p}${i}x`);
  const ctx = {
    categories: [{ id: 'a', cfg: structuredClone(L.DEF_CAT_CFG) }, { id: 'b', cfg: structuredClone(L.DEF_CAT_CFG) }],
    state: { a: { roster: roster('A', n1), groups: [], sched: [], ko: [] },
             b: { roster: roster('B', n2), groups: [], sched: [], ko: [] } },
    meta: { coordinated: true, parallelCategories: true, allPoolsBeforeKO: true, ...extra }, registrations: [],
  };
  const api = L.createLegacy(ctx);
  api.buildCoordinatedGroups(); api.generateCoordinatedSchedule();
  return ctx;
}

for (const [n1, n2] of [[12, 12], [16, 16], [15, 13], [13, 13]]) {
  test(`24.10 config ${n1}×${n2}`, () => {
    const ctx = build(n1, n2);
    const games = Object.values(ctx.state).flatMap(cs => [...cs.sched, ...cs.ko.flat().filter(g => !g.isBye)]);
    const slots = games.map(g => `${g.time}/${g.court}`);
    assert.equal(new Set(slots).size, slots.length, 'court collision');
    assert.equal(ctx.state.a.sched[0].time, '07:00');

    const seen = new Set();
    for (const g of games) for (const t of [g.a, g.b].filter(Boolean)) {
      const k = `${g.si}|${g.catId}|${t}`;
      assert.ok(!seen.has(k), `${t} twice in round ${g.si}`);
      seen.add(k);
    }

    const pool = games.filter(g => g.gi >= 0);
    assert.equal(Math.max(...pool.map(g => g.si)) + 1, Math.ceil(pool.length / 4), 'pool rounds');

    const by = {};
    pool.forEach(g => [g.a, g.b].forEach(t => (by[t] ||= []).push(g.si)));
    for (const [t, sis] of Object.entries(by)) {
      sis.sort((x, y) => x - y);
      let run = 1, maxRun = 1;
      for (let i = 1; i < sis.length; i++) { run = sis[i] === sis[i - 1] + 1 ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
      assert.ok(maxRun <= 2, `${t}: ${maxRun} games in a row`);
      assert.equal(maxRun, 1, `${t}: back-to-back at rounds ${sis}`);
    }
  });
}

test('sequentialCategories: all of category a, then all of category b', () => {
  const ctx = build(12, 12, { sequentialCategories: true });
  const all = cs => [...cs.sched, ...cs.ko.flat().filter(g => !g.isBye)];
  const a = all(ctx.state.a), b = all(ctx.state.b);
  const slots = [...a, ...b].map(g => `${g.time}/${g.court}`);
  assert.equal(new Set(slots).size, slots.length, 'court collision');
  assert.ok(a.every(g => g.time), 'a fully scheduled');
  assert.ok(b.every(g => g.time), 'b fully scheduled');
  assert.ok(Math.max(...a.map(g => g.si)) < Math.min(...b.map(g => g.si)), 'b starts after a ends');
});
