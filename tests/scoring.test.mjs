import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateResult } from '../core/scoring.js';
import { PRESETS, PRESET_IDS, getPreset, legacyMatchFormat, legacyStage } from '../core/presets.js';
import * as L from '../core/legacy.js';

const V = (r, f) => validateResult(r, f);
const ok = (r, f) => V(r, f).ok;
const sets = (...s) => ({ sets: s });
const errOf = (r, f) => V(r, f).error;

describe('points format', () => {
  const F = { type: 'points', to: 21, winBy: 2, cap: null };
  const table = [
    [21, 19, true], [21, 0, true], [19, 21, true], [21, 20, false], [22, 21, false],
    [23, 21, true], [22, 20, true], [40, 38, true], [25, 21, false], [20, 18, false], [21, 21, false],
  ];
  for (const [a, b, want] of table) test(`${a}-${b} → ${want}`, () => assert.equal(ok({ a, b }, F), want));

  test('result fields', () => {
    assert.deepEqual(V({ a: '21', b: '17' }, F),
      { ok: true, error: null, winner: 'a', score: { a: 21, b: 17 }, sets: { a: 1, b: 0 }, units: { a: 21, b: 17 } });
    assert.equal(V({ a: 15, b: 21 }, F).winner, 'b');
  });
  test('error keys + params', () => {
    assert.deepEqual(errOf({ a: '', b: 3 }, F), { key: 'score.empty', params: {} });
    assert.deepEqual(errOf({ a: 'x', b: 3 }, F), { key: 'score.notInteger', params: {} });
    assert.deepEqual(errOf({ a: 2.5, b: 3 }, F), { key: 'score.notInteger', params: {} });
    assert.deepEqual(errOf({ a: -1, b: 21 }, F), { key: 'score.negative', params: {} });
    assert.deepEqual(errOf({ a: 21, b: 21 }, F), { key: 'score.equal', params: {} });
    assert.deepEqual(errOf({ a: 20, b: 18 }, F), { key: 'score.mustReach', params: { n: 21, lo: 18 } });
    assert.deepEqual(errOf({ a: 21, b: 20 }, F), { key: 'score.needLead', params: { n: 2 } });
    assert.deepEqual(errOf({ a: 22, b: 21 }, F), { key: 'score.exactLead', params: { to: 21, n: 2 } });
  });
  test('cap (footvolley 18/cap 25)', () => {
    const C = { type: 'points', to: 18, winBy: 2, cap: 25 };
    assert.equal(ok({ a: 18, b: 16 }, C), true);
    assert.equal(ok({ a: 24, b: 22 }, C), true);
    assert.equal(ok({ a: 25, b: 24 }, C), true);
    assert.equal(ok({ a: 25, b: 23 }, C), true);
    assert.equal(ok({ a: 25, b: 22 }, C), false); // game would have ended at 24-22
    assert.deepEqual(errOf({ a: 25, b: 22 }, C), { key: 'score.capRange', params: { cap: 25, min: 23 } });
    assert.deepEqual(errOf({ a: 26, b: 24 }, C), { key: 'score.overCap', params: { cap: 25 } });
  });
  test('winBy 1 (generic-points)', () => {
    const G = getPreset('generic-points').matchFormat;
    assert.equal(ok({ a: 21, b: 20 }, G), true);
    assert.equal(ok({ a: 22, b: 20 }, G), false);
    assert.equal(ok({ a: 20, b: 19 }, G), false);
  });
});

describe('sets format — padel', () => {
  const P = PRESETS.padel.matchFormat;
  const cases = [
    [sets([6, 4], [7, 6]), true, 'a'],
    [sets([6, 4], [6, 6]), false],
    [sets([6, 4], [4, 6], [10, 8]), true, 'a'],
    [sets([6, 4], [4, 6], [8, 10]), true, 'b'],
    [sets([6, 4], [4, 6], [12, 10]), true, 'a'],
    [sets([6, 4], [4, 6], [10, 9]), false],
    [sets([6, 4], [4, 6], [11, 8]), false],
    [sets([6, 4], [4, 6], [6, 3]), false], // decider is a super tiebreak
    [sets([7, 5], [6, 0]), true, 'a'],
    [sets([6, 5], [6, 0]), false],
    [sets([8, 6], [6, 0]), false],
    [sets([7, 7], [6, 0]), false],
    [sets([6, 4]), false],
    [sets([6, 4], [6, 2], [6, 1]), false],
    [sets([0, 6], [1, 6]), true, 'b'],
  ];
  cases.forEach(([r, want, w], i) => test(`case ${i}: ${JSON.stringify(r.sets)} → ${want}`, () => {
    const v = V(r, P);
    assert.equal(v.ok, want, JSON.stringify(v.error));
    if (w) assert.equal(v.winner, w);
  }));
  test('errors carry the set number', () => {
    assert.deepEqual(errOf(sets([6, 4], [6, 6]), P), { key: 'score.equal', params: { set: 2 } });
    assert.deepEqual(errOf(sets([6, 4], [8, 6]), P), { key: 'score.overCap', params: { cap: 7, set: 2 } });
    assert.deepEqual(errOf(sets([6, 4]), P), { key: 'sets.incomplete', params: { need: 2 } });
    assert.deepEqual(errOf(sets([6, 4], [6, 2], [6, 1]), P), { key: 'sets.afterDecided', params: { set: 3 } });
    assert.deepEqual(errOf(sets(['', 4]), P), { key: 'score.empty', params: { set: 1 } });
    assert.deepEqual(errOf({ sets: [] }, P), { key: 'score.empty', params: {} });
  });
  test('trailing empty set rows are ignored; {a,b} set items accepted', () => {
    assert.equal(ok(sets([6, 4], [6, 3], ['', '']), P), true);
    assert.equal(ok({ sets: [{ a: 6, b: 4 }, { a: 6, b: 3 }] }, P), true);
  });
  test('summary fields', () => {
    const v = V(sets([6, 4], [3, 6], [10, 7]), P);
    assert.deepEqual([v.score, v.sets, v.units], [{ a: 2, b: 1 }, { a: 2, b: 1 }, { a: 19, b: 17 }]);
  });
});

describe('sets format — tennis / beach volleyball', () => {
  test('tennis full third set', () => {
    const T = PRESETS.tennis.matchFormat;
    assert.equal(ok(sets([6, 4], [4, 6], [7, 6]), T), true);
    assert.equal(ok(sets([6, 4], [4, 6], [10, 8]), T), false);
  });
  test('beach volleyball 21/21/15', () => {
    const B = PRESETS['beach-volleyball'].matchFormat;
    assert.equal(ok(sets([21, 19], [21, 17]), B), true);
    assert.equal(ok(sets([21, 19], [19, 21], [15, 13]), B), true);
    assert.equal(ok(sets([21, 19], [19, 21], [16, 14]), B), true);
    assert.equal(ok(sets([21, 19], [19, 21], [21, 19]), B), true);  // deuce from 14-14 is legal
    assert.equal(ok(sets([21, 19], [19, 21], [21, 10]), B), false); // decider ended at 15-10
    assert.equal(ok(sets([21, 20], [21, 17]), B), false);
    assert.equal(ok(sets([30, 28], [21, 17]), B), true);
  });
  test('entry:"count" (sets won only)', () => {
    const C = { type: 'sets', bestOf: 3, entry: 'count' };
    assert.equal(ok({ a: 2, b: 1 }, C), true);
    assert.equal(ok({ a: 0, b: 2 }, C), true);
    assert.deepEqual(errOf({ a: 3, b: 1 }, C), { key: 'sets.countRange', params: { need: 2, maxLose: 1 } });
    assert.deepEqual(errOf({ a: 1, b: 0 }, C), { key: 'sets.needWins', params: { n: 2 } });
    assert.deepEqual(errOf({ a: 2, b: 2 }, C), { key: 'sets.countRange', params: { need: 2, maxLose: 1 } });
    assert.equal(ok({ a: 3, b: 2 }, { ...C, bestOf: 5 }), true);
  });
});

describe('timed & free formats', () => {
  test('timed allows draws', () => {
    const T = { type: 'timed', minutes: 20 };
    assert.equal(V({ a: 2, b: 2 }, T).winner, 'draw');
    assert.equal(V({ a: 0, b: 3 }, T).winner, 'b');
    assert.equal(ok({ a: 0, b: 0 }, { ...T, allowDraw: false }), false);
    assert.equal(ok({ a: '', b: 0 }, T), false);
  });
  test('free never fails', () => {
    const F = PRESETS['generic-free'].matchFormat;
    for (const r of [{}, { a: '', b: '' }, { a: 'x', b: 1 }, { a: -3, b: 2.5 }, { a: 5, b: 5 }]) assert.equal(ok(r, F), true);
    assert.equal(V({ a: 5, b: 5 }, F).winner, 'draw');
    assert.equal(V({ a: 'x', b: 1 }, F).winner, null);
    assert.equal(V({ a: 7, b: 3 }, F).winner, 'a');
  });
  test('unknown type throws', () => assert.throws(() => V({ a: 1, b: 0 }, { type: 'nope' })));
});

describe('presets', () => {
  test('all required presets exist with the documented shape', () => {
    assert.deepEqual(PRESET_IDS, ['legacy-beach', 'beach-volleyball', 'footvolley', 'padel', 'tennis', 'generic-points', 'generic-free']);
    for (const id of PRESET_IDS) {
      const p = getPreset(id);
      assert.equal(p.id, id);
      for (const lang of ['he', 'en']) for (const k of ['entry', 'entries', 'court']) assert.equal(typeof p.terms[lang][k], 'string');
      assert.ok(p.entrySize.min >= 1 && p.entrySize.max >= p.entrySize.min);
      assert.equal(typeof p.allowDraw, 'boolean');
      assert.ok(['points', 'sets', 'timed', 'free'].includes(p.matchFormat.type));
      assert.ok(['win', 'draw', 'loss'].every(k => typeof p.standings.points[k] === 'number'));
      assert.ok(Array.isArray(p.standings.tiebreakers) && p.standings.tiebreakers.length);
      assert.ok(p.timing.estMinutes > 0);
    }
    assert.equal(getPreset('nope'), null);
  });
  test('presets are frozen', () => {
    assert.throws(() => { 'use strict'; PRESETS.padel.matchFormat.bestOf = 5; });
  });
  test('legacyStage mirrors getRuleForGame stage selection', () => {
    assert.equal(legacyStage(false, { gi: 0 }), 'pool');
    assert.equal(legacyStage(false, { gi: -1 }), 'third');
    assert.equal(legacyStage(true, { ri: 3, koRounds: 4 }), 'final');
    assert.equal(legacyStage(true, { ri: 2, koRounds: 4 }), 'sf');
    assert.equal(legacyStage(true, { ri: 1, koRounds: 4 }), 'qf');
    assert.equal(legacyStage(true, { ri: 0, koRounds: 4 }), 'r16');
    assert.equal(legacyStage(true, { ri: 0, koRounds: 0 }), 'pool');
  });
  test('legacy-beach stageFormats equal legacyMatchFormat for default cfg', () => {
    const p = getPreset('legacy-beach');
    for (const s of ['pool', 'r16', 'qf', 'sf', 'final', 'third'])
      assert.deepEqual({ ...p.stageFormats[s] }, legacyMatchFormat(L.DEF_CAT_CFG, s));
  });
});

// ---------------------------------------------------------------------------
// legacy-beach validateResult must agree with legacy isValidScore everywhere.
describe('legacy-beach agrees with legacy isValidScore', () => {
  const cfgs = [
    ['default', { ...L.DEF_CAT_CFG }],
    ['sets3', { ...L.DEF_CAT_CFG, sets: 3 }],
    ['koRules', { ...L.DEF_CAT_CFG, koRules: { pool: { pts: 11, change: 4 }, final: { pts: 25, change: 8 } } }],
    ['queen', { ...L.DEF_CAT_CFG, pointsToWin: 21, koRules: { pool: { pts: 15 }, r16: { pts: 18 }, qf: { pts: 18 }, sf: { pts: 18 }, third: { pts: 15 }, final: { pts: 21 } } }],
  ];
  const stages = [
    ['pool', { gi: 0 }, false], ['third', { gi: -1 }, false],
    ['r16', { ri: 0 }, true], ['qf', { ri: 1 }, true], ['sf', { ri: 2 }, true], ['final', { ri: 3 }, true],
  ];
  for (const [name, cfg] of cfgs) test(name, () => {
    const ctx = { categories: [{ id: 'c', cfg }], state: { c: { roster: [], groups: [], sched: [], ko: [[], [], [], []] } }, meta: {}, registrations: [] };
    const api = L.createLegacy(ctx);
    let n = 0;
    for (const [stage, g, isKO] of stages) {
      const ptw = api.getRuleForGame('c', g, isKO).pts;
      const fmt = legacyMatchFormat(cfg, stage);
      for (let a = 0; a <= 32; a++) for (let b = 0; b <= 32; b++) {
        // app.js always calls isValidScore(parseInt(sa), parseInt(sb), …)
        const legacy = api.isValidScore(a, b, 'c', ptw);
        const v = validateResult({ a: String(a), b: String(b) }, fmt);
        assert.equal(v.ok, legacy, `${name}/${stage} ${a}-${b}`);
        if (legacy) assert.equal(v.winner, a > b ? 'a' : 'b');
        // and the error message agrees on whether there is an error (except the 2:2 quirk)
        const le = api.scoreError(String(a), String(b), 'c', ptw);
        if (!(cfg.sets === 3 && a === 2 && b === 2)) assert.equal(le === null, v.ok, `scoreError ${name}/${stage} ${a}-${b}`);
        n++;
      }
      // blanks / garbage
      for (const [a, b] of [['', '5'], ['x', '3'], ['-1', '21']]) {
        assert.equal(api.isValidScore(parseInt(a), parseInt(b), 'c', ptw), false);
        assert.equal(validateResult({ a, b }, fmt).ok, false);
      }
    }
    assert.equal(n, 6 * 33 * 33);
  });
});
