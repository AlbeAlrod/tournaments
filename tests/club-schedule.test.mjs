// Club (secure) tournaments: one category-order choice, per-category start time, per-stage minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../core/legacy.js';

const m = t => +t.slice(0, 2) * 60 + +t.slice(3);
function build(catOrder, cfgs, n = 8) {
  const roster = (p) => Array.from({ length: n }, (_, i) => `${p}${i} / ${p}${i}x`);
  const ids = cfgs.map((_, i) => 'c' + i);
  const ctx = {
    categories: cfgs.map((c, i) => ({ id: ids[i], cfg: { ...structuredClone(L.DEF_CAT_CFG), numGroups: 2, ...c } })),
    state: Object.fromEntries(ids.map(id => [id, { roster: roster(id), groups: [], sched: [], ko: [] }])),
    meta: { coordinated: true, catOrder }, registrations: [], secure: true,
  };
  const api = L.createLegacy(ctx);
  api.buildCoordinatedGroups(); api.generateCoordinatedSchedule();
  return Object.fromEntries(ids.map(id => [id, [...ctx.state[id].sched, ...ctx.state[id].ko.flat().filter(g => g && !g.isBye)]]));
}

test('byTime: no game of a category before its start time, courts never collide', () => {
  const g = build('byTime', [{ startTime: '08:00' }, { startTime: '11:00' }]);
  assert.equal(Math.min(...g.c0.map(x => m(x.time))), m('08:00'));
  assert.ok(Math.min(...g.c1.map(x => m(x.time))) >= m('11:00'));
  const slots = [...g.c0, ...g.c1].map(x => `${x.time}/${x.court}`);
  assert.equal(new Set(slots).size, slots.length);
});

test('per-stage minutes: a round lasts as long as its longest game', () => {
  const koRules = Object.fromEntries(['pool', 'r16', 'qf', 'sf', 'third', 'final'].map(k => [k, { pts: 21, change: 7, dur: k === 'pool' ? 15 : 30 }]));
  const g = build('parallel', [{ koRules, startTime: '08:00' }]);
  const times = [...new Set(g.c0.map(x => m(x.time)))].sort((a, b) => a - b);
  const pools = new Set(g.c0.filter(x => x.gi >= 0).map(x => m(x.time)));
  assert.equal(times[1] - times[0], 15);                     // pool rounds: 15 min
  const firstKO = times.find(t => !pools.has(t));
  const after = times[times.indexOf(firstKO) + 1];
  assert.equal(after - firstKO, 30);                          // knockout rounds: 30 min
});

test('sequential: the second category starts after the first one ends', () => {
  const g = build('sequential', [{}, {}]);
  assert.ok(Math.min(...g.c1.map(x => m(x.time))) > Math.max(...g.c0.map(x => m(x.time))));
});
