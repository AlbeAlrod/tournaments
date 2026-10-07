import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeStandings, matchesFromScores } from '../core/standings.js';
import { validateResult } from '../core/scoring.js';
import { PRESETS, legacyMatchFormat } from '../core/presets.js';
import * as L from '../core/legacy.js';

const PTS21 = { type: 'points', to: 15, winBy: 2, cap: null };
const m = (a, b, sa, sb, fmt = PTS21) => ({ a, b, result: validateResult({ a: sa, b: sb }, fmt) });
const S = (entries, matches, cfg) => computeStandings(entries, matches, cfg);
const names = rows => rows.map(r => r.id);

describe('computeStandings basics', () => {
  test('counts wins/losses/points/units and keeps input order on full ties', () => {
    const rows = S(['W', 'X', 'Y'], [m('W', 'X', 15, 10)], { points: { win: 2, draw: 0, loss: 1 }, tiebreakers: ['points'] });
    assert.deepEqual(rows[0], { id: 'W', name: 'W', played: 1, wins: 1, draws: 0, losses: 0, points: 2,
      setsFor: 1, setsAgainst: 0, unitsFor: 15, unitsAgainst: 10, unitDiff: 5, rank: 1, tied: false });
    assert.deepEqual(rows.map(r => [r.id, r.points, r.rank, r.tied]), [['W', 2, 1, false], ['X', 1, 2, false], ['Y', 0, 3, false]]);
  });
  test('invalid / pending results are ignored', () => {
    const rows = S(['W', 'X'], [m('W', 'X', 15, 14), { a: 'W', b: 'X' }, null], {});
    assert.ok(rows.every(r => r.played === 0));
    assert.ok(rows.every(r => r.tied && r.rank === 1));
  });
  test('entry objects with names', () => {
    const rows = S([{ id: 'p1', name: 'Ann' }, { id: 'p2' }], [m('p2', 'p1', 15, 3)], {});
    assert.deepEqual(rows.map(r => [r.id, r.name]), [['p2', 'p2'], ['p1', 'Ann']]);
  });
  test('draws (generic-free 3/1/0)', () => {
    const F = PRESETS['generic-free'];
    const rows = S(['A', 'B', 'C'], [m('A', 'B', 1, 1, F.matchFormat), m('C', 'A', 0, 2, F.matchFormat)], F.standings);
    assert.deepEqual(rows.map(r => [r.id, r.points, r.draws]), [['A', 4, 1], ['B', 1, 1], ['C', 0, 0]]);
  });
  test('unknown tiebreaker throws', () => assert.throws(() => S(['A', 'B'], [], { tiebreakers: ['points', 'zzz'] })));
});

describe('tiebreakers', () => {
  // Cycle: X beats W, W beats Y, Y beats X — all 1-1 inside the trio; Z loses everything.
  const cyc = [m('X', 'W', 15, 13), m('W', 'Y', 15, 5), m('Y', 'X', 15, 10),
               m('W', 'Z', 15, 0), m('X', 'Z', 15, 0), m('Y', 'Z', 15, 0)];
  test('unitDiff after points', () => {
    const rows = S(['W', 'X', 'Y', 'Z'], cyc, { points: { win: 2, loss: 1 }, tiebreakers: ['points', 'unitDiff'] });
    // diffs: W -2+10+15=23, X +2-5+15=12, Y -10+5+15=10
    assert.deepEqual(names(rows), ['W', 'X', 'Y', 'Z']);
  });
  test('h2h mini-league among the tied trio (points then diff inside)', () => {
    const rows = S(['W', 'X', 'Y', 'Z'], cyc, { points: { win: 2, loss: 1 }, tiebreakers: ['points', 'h2h'] });
    // mini-league diffs: W -2+10=8, X 2-5=-3, Y -10+5=-5
    assert.deepEqual(names(rows), ['W', 'X', 'Y', 'Z']);
    assert.ok(rows.every(r => !r.tied));
  });
  test('h2h two-way tie = direct match result (overrides overall diff)', () => {
    const two =[m('A', 'B', 15, 13), m('B', 'C', 15, 0), m('A', 'C', 13, 15), m('B', 'D', 15, 0), m('A', 'D', 15, 0), m('C', 'D', 13, 15)];
    const rows = S(['B', 'A', 'C', 'D'], two, { points: { win: 2, loss: 1 }, tiebreakers: ['points', 'h2h', 'unitDiff'] });
    // A and B both 2-1 (5 pts); B has better diff, but A won the meeting.
    assert.deepEqual(names(rows).slice(0, 2), ['A', 'B']);
  });
  test('h2h recursion: after splitting, the sub-tie is re-evaluated on its own matches', () => {
    // Mini-league of all 4: A 2W diff +28, D 2W diff +2, B 1W diff -15, C 1W diff -15.
    // B and C stay tied → recursion on their own match: B beat C.
    const ms = [
      m('A', 'B', 15, 0), m('A', 'C', 15, 0), m('D', 'A', 15, 13),
      m('B', 'C', 15, 13), m('C', 'D', 15, 13), m('D', 'B', 15, 13),
    ];
    const rows = S(['A', 'B', 'C', 'D'], ms, { points: { win: 1, loss: 0 }, tiebreakers: ['h2h'] });
    assert.deepEqual(names(rows), ['A', 'D', 'B', 'C']);
  });
  test('setRatio and unitRatio (beach volleyball)', () => {
    const B = PRESETS['beach-volleyball'];
    const s = (a, b, ...sets) => ({ a, b, result: validateResult({ sets }, B.matchFormat) });
    const ms = [s('A', 'B', [21, 19], [19, 21], [15, 13]), s('B', 'C', [21, 10], [21, 10]), s('C', 'A', [21, 19], [21, 19])];
    const rows = S(['A', 'B', 'C'], ms, { points: B.standings.points, tiebreakers: ['points', 'setRatio', 'unitRatio'] });
    // sets: A 2-3 (0.67) B 3-2 (1.5) C 2-2 (1.0)
    assert.deepEqual(names(rows), ['B', 'C', 'A']);
    assert.deepEqual(rows.map(r => [r.setsFor, r.setsAgainst]), [[3, 2], [2, 2], [2, 3]]);
  });
  test('wins and unitsFor', () => {
    const ms = [m('A', 'B', 15, 10), m('C', 'D', 20, 18)];
    const rows = S(['A', 'B', 'C', 'D'], ms, { points: { win: 1, loss: 0 }, tiebreakers: ['wins', 'unitsFor'] });
    assert.deepEqual(names(rows), ['C', 'A', 'D', 'B']);
  });
  test('unresolved tie shares rank', () => {
    const rows = S(['A', 'B', 'C'], [], { tiebreakers: ['points', 'h2h', 'unitDiff'] });
    assert.deepEqual(rows.map(r => [r.rank, r.tied]), [[1, true], [1, true], [1, true]]);
  });
});

describe('legacy-beach standings agree with legacy getStandings', () => {
  const P = PRESETS['legacy-beach'];
  function check(groupTeams, results, seed) {
    const ctx = { categories: [{ id: 'c', cfg: { ...L.DEF_CAT_CFG } }],
      state: { c: { roster: [], groups: [{ name: 'A', teams: groupTeams }], sched: [], ko: [] } }, meta: {}, registrations: [] };
    ctx.state.c.sched = results.map(([a, b, sa, sb]) => ({ gi: 0, a, b, sa: String(sa), sb: String(sb) }));
    const legacy = L.createLegacy(ctx).getStandings('c', 0);
    const ms = matchesFromScores(ctx.state.c.sched, () => legacyMatchFormat(L.DEF_CAT_CFG, 'pool'), validateResult);
    const rows = computeStandings(groupTeams, ms, P.standings);
    assert.deepEqual(rows.map(r => r.id), legacy.map(r => r.name), `seed ${seed}`);
    assert.deepEqual(rows.map(r => [r.wins, r.losses, r.points, r.unitsFor, r.unitsAgainst, r.unitDiff]),
      legacy.map(r => [r.w, r.l, r.pts, r.scored, r.against, r.diff]), `seed ${seed}`);
  }
  test('randomized groups of 3..6 with valid, invalid and missing scores', () => {
    let s = 12345;
    const rnd = n => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
    const scores = [[15, 0], [15, 13], [17, 15], [13, 15], [0, 15], [15, 14], ['', ''], [21, 19], [16, 14], [5, 15], [15, 10]];
    for (let seed = 0; seed < 300; seed++) {
      const n = 3 + rnd(4);
      const ts = Array.from({ length: n }, (_, i) => `P${i}`);
      const res = L.rr(ts).map(([a, b]) => [a, b, ...scores[rnd(scores.length)]]);
      check(ts, res, seed);
    }
  });
});
