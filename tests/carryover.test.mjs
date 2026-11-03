// Rebuild score carry-over (core/legacy.js gameIndex + carryOver = app.js buildTournament).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../core/legacy.js';

const teams = n => Array.from({ length: n }, (_, i) => `T${i + 1}`);
const num = s => parseInt(String(s).replace(/\D/g, ''), 10);
const winScore = (g, to) => (num(g.a) < num(g.b) ? [to, to - 5] : [to - 5, to]).map(String);
const CFG = { ...L.DEF_CAT_CFG, numGroups: 2, advPerGroup: 2, courts: 2 };
const QUEEN = { ...L.DEF_CAT_CFG, numGroups: 4, advPerGroup: 3, courts: 4, seeding: 'snake', koFormat: 'queen' };

function setup(cfg, roster) {
  const ctx = { categories: [{ id: 'c', name: 'C', cfg }],
    state: { c: { roster, groups: [], sched: [], ko: [] } }, meta: {}, registrations: [] };
  const api = L.createLegacy(ctx);
  api.buildCategory('c');
  return { ctx, api, cs: () => ctx.state.c };
}
const pool = cs => cs.sched.filter(g => g.gi >= 0);
function playPools(api, cs) { pool(cs).forEach(g => { [g.sa, g.sb] = winScore(g, 21); }); api.updateKOForCat('c'); }
function playRound(api, cs, ri) { cs.ko[ri].forEach(g => { if (!g.isBye) [g.sa, g.sb] = winScore(g, 21); }); api.updateKOForCat('c'); }
// Rebuild like buildTournament: index old games, build fresh, (optional tweak), carry over.
function rebuild(t, tweak) {
  const old = t.api.gameIndex(['c']);
  t.api.buildCategory('c');
  tweak?.(t.cs());
  t.api.carryOver(['c'], old);
  return t.cs();
}

describe('pool carry-over', () => {
  test('unchanged pair keeps sa/sb', () => {
    const t = setup(CFG, teams(8));
    const g0 = t.cs().sched[0]; [g0.sa, g0.sb] = ['21', '15'];
    const n = rebuild(t).sched[0];
    assert.deepEqual([n.a, n.b, n.sa, n.sb], [g0.a, g0.b, '21', '15']);
  });
  test('a/b swapped → sa/sb swapped', () => {
    const t = setup(CFG, teams(8));
    const g0 = t.cs().sched[0]; [g0.sa, g0.sb] = ['21', '15'];
    const n = rebuild(t, cs => { const g = cs.sched[0]; [g.a, g.b] = [g.b, g.a]; }).sched[0];
    assert.deepEqual([n.a, n.b, n.sa, n.sb], [g0.b, g0.a, '15', '21']);
  });
  test('name match ignores " / " and case', () => {
    const t = setup(CFG, teams(8));
    const g0 = t.cs().sched[0]; [g0.sa, g0.sb] = ['21', '15'];
    const n = rebuild(t, cs => { cs.sched[0].a = cs.sched[0].a.toLowerCase(); }).sched[0];
    assert.deepEqual([n.sa, n.sb], ['21', '15']);
  });
  test('wo and forced carry over; unscored game carries nothing', () => {
    const t = setup(CFG, teams(8));
    const [g0, g1, g2] = t.cs().sched;
    Object.assign(g0, { sa: '21', sb: '0', wo: true });
    Object.assign(g1, { sa: '21', sb: '19', forced: true });
    g2.wo = true; // flag without a score is not carried
    const [n0, n1, n2] = rebuild(t).sched;
    assert.deepEqual([n0.sa, n0.sb, n0.wo, n0.forced], ['21', '0', true, undefined]);
    assert.deepEqual([n1.sa, n1.sb, n1.wo, n1.forced], ['21', '19', undefined, true]);
    assert.deepEqual([n2.sa, n2.sb, n2.wo], ['', '', undefined]);
  });
  test('court/time are not carried', () => {
    const t = setup(CFG, teams(8));
    const g0 = t.cs().sched[0]; Object.assign(g0, { sa: '21', sb: '15', court: 9, time: '23:00' });
    const n = rebuild(t).sched[0];
    assert.deepEqual([n.court, n.time], [1, '07:00']);
  });
});

describe('KO carry-over', () => {
  function played() {
    const t = setup(CFG, teams(8));
    playPools(t.api, t.cs()); playRound(t.api, t.cs(), 0);
    return t;
  }
  test('same shape + same pairs: SF scores kept, final resolves', () => {
    const t = played();
    const before = t.cs().ko.map(r => r.map(g => [g.a, g.b, g.sa, g.sb]));
    const cs = rebuild(t);
    assert.deepEqual(cs.ko.map(r => r.map(g => [g.a, g.b, g.sa, g.sb])), before);
    assert.ok(!cs.ko[1][0].a.startsWith('Winner'));
  });
  test('bracket shape changed → KO scores dropped', () => {
    const t = played();
    t.ctx.categories[0].cfg = { ...CFG, advPerGroup: 3 };
    const cs = rebuild(t);
    assert.notEqual(cs.ko.length, 2);
    assert.ok(cs.ko.flat().every(g => g.sa === '' && g.sb === ''));
  });
  test('same shape, different pair → that game dropped', () => {
    const t = played();
    const sf = t.cs().ko[0].map(g => [g.a, g.b]);
    t.cs().roster = t.cs().roster.map(x => (x === sf[0][0] ? 'T0' : x));
    const cs = rebuild(t, c => { pool(c).forEach(g => { if (g.a === 'T0' || g.b === 'T0') [g.sa, g.sb] = winScore(g, 21); }); });
    assert.equal(cs.ko.length, 2);
    assert.equal(cs.ko[0][0].a, 'T0');
    assert.deepEqual([cs.ko[0][0].sa, cs.ko[0][0].sb], ['', '']);
    assert.deepEqual([cs.ko[0][1].a, cs.ko[0][1].b], sf[1]);
    assert.notEqual(cs.ko[0][1].sa, '', 'unchanged SF2 is kept');
  });
});

describe('3rd-place carry-over (queen)', () => {
  test('3rd-place score kept when SF losers are the same', () => {
    const t = setup(QUEEN, teams(16));
    playPools(t.api, t.cs());
    [0, 1, 2].forEach(ri => playRound(t.api, t.cs(), ri));
    const g3 = t.cs().sched.find(g => g.gi < 0);
    [g3.sa, g3.sb] = ['15', '21'];
    const n3 = rebuild(t).sched.find(g => g.gi < 0);
    assert.deepEqual([n3.a, n3.b, n3.sa, n3.sb], [g3.a, g3.b, '15', '21']);
  });
});
